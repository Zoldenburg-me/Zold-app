/**
 * Authorization claim test.
 *
 * The window this closes: POST /api/transfers/:id/authorize checked
 * `state === "CREATED"` and then awaited the chain. Everything before that await
 * runs synchronously, so two submissions of the SAME device signature both
 * cleared the check and both submitted `debit`. The vault rejected the second as
 * a duplicate transferId — and that revert took the FP3 compensation path, which
 * saw the winner's `vault.debit` in the shared tx list and re-credited the
 * sender while the payout it was refunding went through.
 *
 * So the claim has to be atomic against a concurrent handler, which in Node
 * means: no `await` between reading the state and writing it. That is what
 * store.claimAuthorization is, and this test pins it.
 *
 * Store-only by design — no chain, no API. Run: npm run authorize:test
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
rmSync(path.join(ROOT, "data/db.json"), { force: true });

const { initStore, store } = await import("../services/api/src/store.js");

initStore();

const now = new Date().toISOString();
const terms = {
  to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
  amountWei: "100000000000000000000",
  destination: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
  deadline: Math.floor(Date.now() / 1000) + 900,
};
const transfer = {
  userId: "u-claim",
  quoteId: "q-claim",
  rail: "cash" as const,
  recipientName: "Recipient",
  recipientPhone: "+254700000000",
  state: "CREATED" as const,
  sendEur: 100,
  receiveKes: 12950,
  txs: [],
  createdAt: now,
  updatedAt: now,
};

store.addTransfer({ ...transfer, id: "t-claim", auth: { ...terms } });

// 1. The race: both callers arrive before either has awaited anything.
const first = store.claimAuthorization("t-claim");
const second = store.claimAuthorization("t-claim");
assert.equal(first, true, "the first submission claims the transfer");
assert.equal(second, false, "a concurrent submission of the same signature is refused");
assert.ok(store.findTransfer("t-claim")!.auth!.authorizedAt, "the claim is recorded");
console.log("1. concurrent authorize submissions: one claims, the other is refused");

// 2. Replay after the transfer has moved on is refused too.
store.addTransfer({ ...transfer, id: "t-debited", state: "DEBITED", auth: { ...terms } });
assert.equal(store.claimAuthorization("t-debited"), false, "only a CREATED transfer can be claimed");
console.log("2. a transfer past CREATED cannot be authorized again");

// 3. Nothing to claim without terms, or without a transfer.
store.addTransfer({ ...transfer, id: "t-no-terms" });
assert.equal(store.claimAuthorization("t-no-terms"), false, "no terms means nothing was authorized");
assert.equal(store.claimAuthorization("t-missing"), false, "unknown transfer");
console.log("3. missing terms / unknown transfer are refused rather than thrown");

// 4. The claim survives a restart — it lives in the store, not in memory.
initStore();
assert.equal(store.claimAuthorization("t-claim"), false, "a claim persisted across a reload");
console.log("4. the claim is persisted, so a restart cannot re-open the window");

console.log("\nAUTHORIZE CLAIM TEST PASSED — 4/4");
