/**
 * A SEPA payout sends the memo stored when its transfer was built, and settles
 * when Monerium echoes that memo back.
 *
 * The gap this closes (board #167): execution recomputed the memo, so a
 * transfer built under an older paymentMemo format (the full transfer id, for
 * an empty reference or one that folds to nothing like "€€€") was refused by
 * redeemToIban before any order and sat in MANUAL_REVIEW with 0 orders, on the
 * daily cap. Rows here are written as such a build left them, then reloaded
 * from disk as a restart would.
 *
 * The real executor, redeemToIban and pollRedeemOrdersOnce on a temp store.
 * Stubbed: Monerium's POST /orders and GET /orders/:id (no network), and the
 * authorizer bytecode read (no chain). Fee 0, so no Safe UserOperation.
 * NOT PROVEN HERE: what Monerium or the payee's bank shows for the memo.
 *
 *   npm run sepa-memo:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
process.env.SEPA_FEE_EUR = "0";
// A live deployment: without it the executor refuses before the fee debit.
process.env.MONERIUM_CLIENT_ID = "sepa-memo-client";
process.env.MONERIUM_CLIENT_SECRET = "sepa-memo-secret";

const { initStore, store } = await import("../services/api/src/store.js");
const { executeSepaTransfer } = await import("../services/api/src/orchestrator.js");
const { MoneriumClient } = await import("../services/api/src/adapters/monerium-client.js");
const { pollRedeemOrdersOnce } = await import("../services/api/src/adapters/monerium-sandbox.js");
const { MONERIUM } = await import("../services/api/src/config.js");
const { moneriumRedeemMessage, paymentMemo } = await import("../services/api/src/sepa.js");
const chain = await import("../services/api/src/chain.js");

initStore();
(chain.publicClient as any).getBytecode = async () => undefined;

const device = privateKeyToAccount(generatePrivateKey());
const SAFE = "0x00000000000000000000000000000000000000b1";
const TO = "0x0000000000000000000000000000000000000002";
const IBAN = "DE89370400440532013000";
const stamp = new Date().toISOString();
store.addUser({
  id: "u-memo",
  name: "Memo Test",
  country: "DE",
  kycStatus: "approved",
  iban: "",
  address: SAFE,
  authorizerAddress: device.address,
  passkeySafe: { status: "active", address: SAFE },
  createdAt: stamp,
} as any);

/** Monerium's side: what each order carried, and the memo its read echoes. */
const placed = new Map<string, any>();
let echo: (body: any) => string | undefined = (body) => body.memo;
(MoneriumClient.prototype as any).placeOrder = async (body: any) => {
  const id = `ord-${placed.size + 1}`;
  placed.set(id, body);
  return { id, state: "placed" };
};
(MoneriumClient.prototype as any).getOrder = async (id: string) => {
  const body = placed.get(id);
  return {
    id,
    kind: "redeem",
    currency: "eur",
    amount: body.amount,
    address: body.address,
    chain: MONERIUM.chain,
    counterpart: body.counterpart,
    memo: echo(body),
    state: "processed",
    meta: { state: "processed" },
  };
};

const deadline = () => Math.floor(Date.now() / 1000) + 120;

/** A transfer as the builder left it, with `memo` as the memo it stored. */
function built(id: string, reference: string | undefined, memo: string) {
  const d = deadline();
  store.addTransfer({
    id,
    userId: "u-memo",
    quoteId: `q-${id}`,
    rail: "sepa",
    recipientName: "Recipient Name",
    recipientIban: IBAN,
    ...(reference !== undefined ? { reference } : {}),
    state: "CREATED",
    sendEur: 40,
    receiveEur: 40,
    receiveKes: 0,
    fundingSource: "safe",
    txs: [],
    moneriumRedeem: { ...moneriumRedeemMessage(40, IBAN, stamp), memo, signature: "0x1234" },
    auth: {
      to: TO,
      amountWei: chain.eur.toWei(40).toString(),
      destination: chain.destinationCommitment("sepa", { iban: IBAN, name: "Recipient Name" }),
      deadline: d,
      authorizedAt: stamp,
    },
    createdAt: stamp,
    updatedAt: stamp,
  } as any);
  return d;
}

async function send(id: string, d: number) {
  const t = store.findTransfer(id)!;
  const signature = await device.signTypedData(
    chain.paymentAuthorizationTypedData({
      account: SAFE,
      amountWei: chain.eur.toWei(40),
      to: TO,
      transferId: chain.transferIdHash(id),
      destination: t.auth!.destination as `0x${string}`,
      deadline: d,
    }) as any,
  );
  return executeSepaTransfer(t, store.findUser("u-memo")!, { deadline: d, signature });
}

let n = 0;
const ok = (label: string) => console.log(`  ok  ${++n}. ${label}`);

// (a) and (b): built under the full-id format, reference empty or folding to nothing.
const cases: Array<[string, string | undefined]> = [
  ["11111111-2222-4333-8444-555555555555", undefined],
  ["22222222-3333-4444-8555-666666666666", ""],
  ["33333333-4444-4555-8666-777777777777", "€€€"],
];
const deadlines = cases.map(([id, ref]) => built(id, ref, `Powered by Zold ${id}`));
// A crash after the build: the next process reads the rows back from disk.
initStore();
for (const [i, [id, ref]] of cases.entries()) {
  assert.notEqual(paymentMemo(id, ref), `Powered by Zold ${id}`, "the stored memo is not what paymentMemo makes today");
  const after = await send(id, deadlines[i]);
  assert.equal(after.state, "PAYOUT_SUBMITTED", `${JSON.stringify(ref)}: ${after.error}`);
  const order = placed.get(after.sepa!.orderId!);
  assert.equal(order.memo, `Powered by Zold ${id}`, "the order carries the stored memo");
  ok(`reference ${JSON.stringify(ref)} built under the old format: one order, carrying the stored memo, after a restart`);
}
await pollRedeemOrdersOnce();
for (const [id] of cases) assert.equal(store.findTransfer(id)!.state, "PAID", "Monerium's echo matches the stored memo");
ok("each settles PAID when Monerium echoes the stored memo");

// (c) A normal reference: built and sent today, the memo is unchanged.
const NORMAL = "44444444-5555-4666-8777-888888888888";
const memoNow = paymentMemo(NORMAL, "INV-2026/0042");
assert.equal(memoNow, "INV-2026/0042 Powered by Zold 44444444");
const dNormal = built(NORMAL, "INV-2026/0042", memoNow);
const normal = await send(NORMAL, dNormal);
assert.equal(normal.state, "PAYOUT_SUBMITTED", normal.error);
assert.equal(placed.get(normal.sepa!.orderId!).memo, memoNow);
await pollRedeemOrdersOnce();
assert.equal(store.findTransfer(NORMAL)!.state, "PAID");
ok("a normal reference sends and settles on the same memo as before");

// Fail closed: an echo that is not the stored memo is never PAID.
for (const [label, wrong] of [
  ["a different memo", () => "Powered by Zold 55555555"],
  ["no memo", () => undefined],
] as const) {
  const id = label === "no memo" ? "66666666-7777-4888-8999-000000000000" : "55555555-6666-4777-8888-999999999999";
  echo = wrong;
  const after = await send(id, built(id, "", `Powered by Zold ${id}`));
  assert.equal(after.state, "PAYOUT_SUBMITTED", after.error);
  await pollRedeemOrdersOnce();
  const end = store.findTransfer(id)!;
  assert.equal(end.state, "MANUAL_REVIEW", `Monerium echoing ${label}`);
  assert.match(end.error ?? "", /does not match this transfer \(payment memo/);
  ok(`Monerium echoing ${label} holds the transfer in review, never PAID`);
}

// A row with no stored memo still refuses before any order, as before.
const NONE = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const dNone = built(NONE, "", "");
store.updateTransfer(NONE, { moneriumRedeem: { ...store.findTransfer(NONE)!.moneriumRedeem!, memo: undefined } as any });
const before = placed.size;
const none = await send(NONE, dNone);
assert.equal(placed.size, before, "no order without a stored memo");
assert.equal(none.state, "MANUAL_REVIEW");
ok("a transfer that stored no memo places no order");

console.log(`\nSEPA STORED MEMO TEST PASSED — ${n} checks`);
process.exit(0);
