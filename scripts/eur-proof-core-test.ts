/**
 * The checks eur:proof makes against Monerium's orders and the chain, run on
 * fixed orders: the live script itself needs the sandbox and a person.
 *
 *   npm run eur-proof-core:test
 */
import assert from "node:assert/strict";
import { ledgerGap, memoChecks, ordersOn, proofExit } from "./eur-proof-core.js";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}

const issue = (id: string, amount: string) => ({ id, kind: "issue", amount, meta: { state: "processed" } });
const redeem = (id: string, amount: string, memo?: string) => ({ id, kind: "redeem", amount, memo, meta: { state: "processed" } });

check("before any payout the Safe holds what Monerium issued", () => {
  assert.equal(ledgerGap([issue("i1", "10")], [], 10), undefined);
  assert.match(ledgerGap([issue("i1", "10")], [], 0)!, /did not land/);
  assert.match(ledgerGap([issue("i1", "10")], [], 9)!, /less/);
});

check("a partial payout: EUR 10 in, EUR 1 out leaves EUR 9 and is consistent", () => {
  assert.equal(ledgerGap([issue("i1", "10")], [redeem("r1", "1")], 9), undefined);
});

check("a full payout empties the Safe and is consistent", () => {
  assert.equal(ledgerGap([issue("i1", "10")], [redeem("r1", "10")], 0), undefined);
});

check("a processed redeem that burned nothing on chain is refused", () => {
  assert.match(ledgerGap([issue("i1", "10")], [redeem("r1", "1")], 10)!, /more/);
});

check("an amount Monerium sends that is not a plain decimal is refused", () => {
  assert.match(ledgerGap([issue("i1", "0x10")], [], 16)!, /amount/);
  assert.match(ledgerGap([issue("i1", "10")], [redeem("r1", "Infinity")], 9)!, /amount/);
});

const signed = new Map<string, string | undefined>([["r1", "Zold ab12"], ["r2", "Zold cd34"], ["r3", "Zold ef56"], ["r4", "Zold 7890"], ["r5", ""]]);
const lookup = (id: string) => (signed.has(id) ? { memo: signed.get(id) } : undefined);

check("every processed redeem with a local transfer is compared, not only the last three", () => {
  const r = memoChecks([redeem("r1", "1", "Other"), redeem("r2", "1", "Zold cd34"), redeem("r3", "1", "Zold ef56"), redeem("r4", "1", "Zold 7890")], lookup);
  assert.deepEqual(r.matched.map((m) => [m.id, m.differs]), [["r1", "payment memo"], ["r2", undefined], ["r3", undefined], ["r4", undefined]]);
  assert.deepEqual(r.unmatched, []);
});

check("a redeem with no local transfer is listed as unmatched, never as compared", () => {
  const r = memoChecks([redeem("x9", "1", "Zold ab12"), redeem("r2", "1", "Zold cd34")], lookup);
  assert.deepEqual(r.unmatched, ["x9"]);
  assert.deepEqual(r.matched.map((m) => m.id), ["r2"]);
});

check("an empty stored memo with no memo on the order is a mismatch, as in the poller", () => {
  const r = memoChecks([redeem("r5", "1")], lookup);
  assert.equal(r.matched.length, 1);
  assert.ok(r.matched[0].differs);
});

const SAFE = "0x1111111111111111111111111111111111111111";
const on = (o: any, chain: string, address = SAFE) => ({ ...o, chain, address });

check("only this Safe's orders on the configured chain are counted", () => {
  const orders = [
    on(issue("i1", "10"), "base"),
    on(redeem("r1", "1"), "base"),
    on(redeem("r2", "4"), "gnosis"), // same Safe address, same profile, another chain
    on(issue("i2", "5"), "base", "0x2222222222222222222222222222222222222222"),
    { ...issue("i3", "7"), address: SAFE }, // names no chain
  ];
  const mine = ordersOn(orders, SAFE, "base");
  assert.deepEqual(mine.map((o) => o.id), ["i1", "r1"]);
  const done = mine.filter((o) => o.kind === "redeem");
  // EUR 10 in, EUR 1 out on base leaves 9; the gnosis redeem no longer fails it.
  assert.equal(ledgerGap(mine.filter((o) => o.kind === "issue"), done, 9), undefined);
  assert.match(ledgerGap([orders[0]], orders.filter((o) => o.kind === "redeem"), 9)!, /more/);
});

check("a failed leg exits 1 even with no redeem yet; only not-done-yet exits 2", () => {
  // A processed EUR 10 deposit, an empty Safe, no redeems: the mint did not land.
  const gap = ledgerGap([issue("i1", "10")], [], 0);
  assert.match(gap!, /did not land/);
  assert.equal(proofExit(gap ? 1 : 0, 0), 1);
  assert.equal(proofExit(1, 2), 1);
  assert.equal(proofExit(0, 0), 2);
  assert.equal(proofExit(0, 1), 0);
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\neur-proof core: all checks passed");
