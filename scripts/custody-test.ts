/**
 * Custody posture: does the orchestrator ever hold the sender's funds?
 *
 * A SEPA send is non-custodial by construction: Monerium burns the payout
 * from the Safe and only the fee moves. USDC deposit conversion is
 * non-custodial only where the user's Safe can execute the venue; a default of
 * LIQUIDITY_PROVIDER=fx-swapper could not, and would refuse every conversion.
 *
 * These check:
 *   1. the default venue is one a Safe can execute,
 *   2. every venue is correctly classified as Safe-executable or not,
 *   3. the local chain opts into the custodial venue explicitly, so production
 *      does not inherit it,
 *   4. the transfer builder records the custody mode on every transfer.
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
const { LIQUIDITY } = await import("../services/api/src/config.js");

/** The venues whose swaps can be executed BY THE USER'S SAFE — the ones that
 *  implement safeSwapPlan, so the batch swaps inside the Safe and the
 *  orchestrator never holds the input. */
const SAFE_EXECUTABLE = ["dex", "lifi", "rfq", "best"];

check("the default liquidity provider is one a user's Safe can execute", () => {
  assert.ok(
    SAFE_EXECUTABLE.includes(LIQUIDITY.PROVIDER),
    `default LIQUIDITY_PROVIDER is ${LIQUIDITY.PROVIDER}, which cannot serve a Safe — ` +
      "the default deployment could not convert a single USDC deposit without custody",
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
      `default venue ${v} cannot serve a Safe; best would pick a venue the Safe cannot execute whenever it won`,
    );
  }
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
      `${id} lost safeSwapPlan — deposits on it can no longer be converted by the Safe`,
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
  assert.match(src, /transfer\.custody = \{ mode: "non-custodial"/, "custody is never persisted");
  assert.doesNotMatch(src, /mode: "orchestrator"/, "no current rail routes the principal through the orchestrator");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`custody: ${n}/${n} checks passed`);
