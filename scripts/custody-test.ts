/**
 * Custody posture: does the orchestrator ever hold the sender's funds?
 *
 * Non-custody depends on three settings: the configured liquidity venue,
 * whether Bridge is live, and whether a venue call succeeds. A default of
 * LIQUIDITY_PROVIDER=fx-swapper cannot be executed by a user's Safe, so it
 * debits every cash-rail transfer to the orchestrator's address, and the
 * fallback only logs a console.error.
 *
 * These check:
 *   1. the default venue is one a Safe can execute,
 *   2. every venue is correctly classified as Safe-executable or not,
 *   3. the local chain opts into the custodial venue explicitly, so production
 *      does not inherit it.
 *
 * The recording and refusal paths that ride on this are exercised end to end
 * by draft:test, which drives a real API.
 *
 * No chain, no network.
 *
 * Run: npm run custody:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);
const failures: string[] = [];
const check = (label: string, fn: () => void) => {
  try {
    fn();
    ok(label);
  } catch (err: any) {
    failures.push(`${label}: ${err?.message ?? err}`);
    console.log(`${++n}. FAILED — ${label}: ${err?.message ?? err}`);
  }
};

// --- 1. The default venue ---------------------------------------------------
// Read config with a clean environment: the point is what an operator who sets
// nothing gets, so an inherited LIQUIDITY_PROVIDER would test the wrong thing.
delete process.env.LIQUIDITY_PROVIDER;
delete process.env.LIQUIDITY_VENUES;
const { LIQUIDITY, CUSTODY } = await import("../services/api/src/config.js");

/** The venues whose swaps can be executed BY THE USER'S SAFE — the ones that
 *  implement safeSwapPlan, so the batch delivers straight to the payout
 *  destination and the orchestrator never holds the input. */
const SAFE_EXECUTABLE = ["dex", "lifi", "rfq", "best"];

check("the default liquidity provider is one a user's Safe can execute", () => {
  assert.ok(
    SAFE_EXECUTABLE.includes(LIQUIDITY.PROVIDER),
    `default LIQUIDITY_PROVIDER is ${LIQUIDITY.PROVIDER}, which cannot serve a Safe — ` +
      "the default deployment would take custody of every cash-rail transfer",
  );
});

check("the default is best execution, so the venue is chosen on price too", () => {
  assert.equal(LIQUIDITY.PROVIDER, "best");
});

check("the default venue list is entirely Safe-executable", () => {
  assert.ok(LIQUIDITY.VENUES.length > 0, "no default venues");
  for (const v of LIQUIDITY.VENUES) {
    assert.ok(
      SAFE_EXECUTABLE.includes(v),
      `default venue ${v} cannot serve a Safe; best would fall back to a custodial debit whenever it won`,
    );
  }
});

check("the non-custodial GUARANTEE is opt-in, not silently assumed", () => {
  // Refusing by default would break every dry-run and testnet deployment,
  // which has no external address to deliver into. The non-custodial path is
  // the default; the refusal is an operator setting.
  assert.equal(CUSTODY.requireNonCustodial, false);
});

// --- 2. Venue classification ------------------------------------------------
// The boot note and the refusal both key on safeSwapPlan being present. If a
// venue gains or loses it, this is where that shows up rather than in a live
// transfer that quietly changed custody mode.
const { providerById } = await import("../services/api/src/liquidity.js");

for (const id of ["dex", "lifi", "rfq"]) {
  check(`${id} implements safeSwapPlan (the non-custodial path)`, () => {
    assert.ok(
      typeof (providerById as any)(id).safeSwapPlan === "function",
      `${id} lost safeSwapPlan — transfers on it now route through the orchestrator`,
    );
  });
}

for (const id of ["fx-swapper", "cow"]) {
  check(`${id} does NOT implement safeSwapPlan, so it is correctly custodial`, () => {
    assert.equal(
      typeof (providerById as any)(id).safeSwapPlan,
      "undefined",
      `${id} appears Safe-executable; if that is real, add it to SAFE_EXECUTABLE here and in server.ts`,
    );
  });
}

// --- 3. The local chain opts in, production does not -------------------------
check("_local-chain.ts pins fx-swapper with ??=, so a harness can still override", () => {
  const src = readFileSync("scripts/_local-chain.ts", "utf8");
  assert.match(
    src,
    /process\.env\.LIQUIDITY_PROVIDER \?\?= "fx-swapper"/,
    "local hardhat must opt INTO the custodial venue explicitly — it has neither LI.FI nor a seeded pool",
  );
});

check("the transfer builder records custody rather than inferring it later", () => {
  // transfers/build.ts is the ONE path that creates a transfer — the direct
  // route and draft execution both go through it — so the custody record has
  // one place to be written and one place to check for.
  const src = readFileSync("services/api/src/transfers/build.ts", "utf8");
  assert.match(src, /transfer\.custody = custody;/, "custody is never persisted");
  assert.match(src, /CUSTODY\.requireNonCustodial && custody\.mode === "orchestrator"/, "no refusal path");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`custody: ${n}/${n} checks passed`);
