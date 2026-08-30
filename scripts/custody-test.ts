/**
 * Custody posture — is the orchestrator ever holding the sender's funds?
 *
 * THE PROBLEM THIS COVERS. "We are non-custodial" was an emergent property of
 * three unrelated settings: which liquidity venue was configured, whether
 * Bridge was live, and whether a venue call happened to succeed. The shipped
 * default (LIQUIDITY_PROVIDER=fx-swapper) could not be executed by a user's
 * Safe at all, so the default deployment debited every cash-rail transfer to
 * the orchestrator's own address — and the fallback that got it there was a
 * console.error nobody read. A property nobody asserts and nothing records is
 * not a property.
 *
 * So these check the three things that make the claim real:
 *   1. the DEFAULT venue is one a Safe can execute (the config-level fix),
 *   2. every venue is correctly classified as Safe-executable or not,
 *   3. the local chain opts INTO the custodial venue explicitly, rather than
 *      production inheriting it.
 *
 * The recording and refusal paths that ride on this are exercised end to end
 * by draft:test and e2e, which drive a real API.
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
  // Defaulting the refusal on would brick every dry-run and testnet deployment,
  // where there is genuinely no external address to deliver into. The PATH is
  // the default; the REFUSAL is a deliberate operator choice.
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

check("server.ts records custody on the transfer rather than inferring it later", () => {
  const src = readFileSync("services/api/src/server.ts", "utf8");
  assert.match(src, /transfer\.custody = custody;/, "custody is never persisted");
  assert.match(src, /CUSTODY\.requireNonCustodial && custody\.mode === "orchestrator"/, "no refusal path");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`custody: ${n}/${n} checks passed`);
