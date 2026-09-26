/**
 * Shareable receipts — redaction, route derivation and slug entropy.
 *
 * Pure functions; no chain, no API, no store. The load-bearing test is the
 * leak sweep: the public payload is unauthenticated, so a withheld value that
 * survives anywhere in the JSON is readable by anyone holding the link, no
 * matter what the page chooses to draw. Serialising the whole payload and
 * searching it for the secrets is the only check that actually proves the
 * design's "redaction is enforced at link generation, not CSS".
 *
 * Run: npm run receipt:test
 */
import assert from "node:assert/strict";
import {
  buildReceipt,
  DEFAULT_SHARE_FIELDS,
  parseShareFields,
  receiptRoute,
  receiptSlug,
  receiptStatus,
  type ReceiptPayload,
} from "../services/api/src/receipt.js";
import type { Quote, ReceiptShareFields, Transfer, User } from "../services/api/src/store.js";

let n = 0;
const check = (label: string, fn: () => void) => {
  fn();
  console.log(`  ${++n}. ${label}`);
};

// --------------------------------------------------------------------------
// fixtures — every secret is a distinctive string so a leak sweep can find it

const IBAN = "DE89370400440532013000";
const SAFE_HASH = "0x7f3a91c4aaaabbbbccccddddeeeeffff000011112222333344445555666677c21d";
const ORDER = "ord_8842117";
const MEMO = "Zold t1 rent";

const sender: User = {
  id: "u1",
  name: "Amina Kamau",
  email: "amina@example.com",
  country: "DE",
  kycStatus: "approved",
  iban: "DE00SENDEROWNACCOUNT",
  address: "0x1111111111111111111111111111111111111111",
  createdAt: "2026-08-01T09:00:00.000Z",
} as any;

const quote: Quote = {
  id: "q1",
  userId: "u1",
  rail: "sepa",
  status: "CONSUMED",
  sendEur: 850,
  fixedFeeEur: 2.9,
  fxRate: 1,
  receiveEur: 847.1,
  midRate: 1,
  marginBps: 0,
  effectiveRate: 0.9966,
  expiresAt: "2026-08-05T14:30:00.000Z",
  createdAt: "2026-08-05T14:20:00.000Z",
};

const sepaTransfer: Transfer = {
  id: "t1",
  userId: "u1",
  quoteId: "q1",
  rail: "sepa",
  recipientName: "Joseph Otieno",
  recipientIban: IBAN,
  reference: "Family support",
  state: "PAID",
  sendEur: 850,
  receiveEur: 847.1,
  fundingSource: "safe",
  txs: [{ step: "safe.transfer(fee)", hash: SAFE_HASH }],
  sepa: { mode: "sandbox", orderId: ORDER, state: "processed" },
  moneriumRedeem: { amount: "847.1", iban: IBAN, issuedAt: "x", message: "m", memo: MEMO },
  createdAt: "2026-08-05T14:22:00.000Z",
  updatedAt: "2026-08-05T15:07:00.000Z",
} as any;

const build = (t: Transfer, f: Partial<ReceiptShareFields>): ReceiptPayload =>
  buildReceipt({
    slug: "aaaaa-bbbbb-ccccc",
    transfer: t,
    sender,
    quote,
    fields: { ...DEFAULT_SHARE_FIELDS, ...f },
    expiresAt: "2026-09-04T14:22:00.000Z",
  });

/** Everything a sender can withhold, as literal strings to hunt for. */
const leakSweep = (payload: ReceiptPayload, secrets: string[]) => {
  const json = JSON.stringify(payload);
  for (const s of secrets) {
    assert.ok(!json.includes(s), `withheld value "${s}" leaked into the public payload`);
  }
};

// --------------------------------------------------------------------------

console.log("\nReceipt share");

check("the default share is the conservative one the handoff specifies", () => {
  assert.equal(DEFAULT_SHARE_FIELDS.sender, "last");
  assert.equal(DEFAULT_SHARE_FIELDS.recipient, "full");
  assert.equal(DEFAULT_SHARE_FIELDS.account, "short");
  assert.equal(DEFAULT_SHARE_FIELDS.route, false, "the full route is off until the sender opts in");
});

check("an unknown selection falls back to the current setting, never wider", () => {
  const base: ReceiptShareFields = { ...DEFAULT_SHARE_FIELDS, sender: "hidden", account: "hidden" };
  const parsed = parseShareFields({ sender: "everything", account: 42, showRate: "yes" }, base);
  assert.equal(parsed.sender, "hidden");
  assert.equal(parsed.account, "hidden");
  assert.equal(parsed.showRate, base.showRate);
});

check("hiding both names puts neither name anywhere in the payload", () => {
  const p = build(sepaTransfer, { sender: "hidden", recipient: "hidden" });
  assert.deepEqual(p.parties.from, { withheld: true });
  assert.deepEqual(p.parties.to, { withheld: true });
  leakSweep(p, ["Amina", "Kamau", "Joseph", "Otieno"]);
});

check("a half-name publishes one half and carries nothing of the other", () => {
  const first = build(sepaTransfer, { sender: "first" });
  assert.deepEqual(first.parties.from, { first: "Amina", redact: "last" });
  leakSweep(first, ["Kamau"]);

  const last = build(sepaTransfer, { sender: "last" });
  assert.deepEqual(last.parties.from, { last: "Kamau", redact: "first" });
  leakSweep(last, ["Amina"]);
});

check("a single-word name redacts rather than over-sharing the whole of it", () => {
  const mononym = { ...sender, name: "Prince" };
  const p = buildReceipt({
    slug: "s",
    transfer: sepaTransfer,
    sender: mononym,
    quote,
    fields: { ...DEFAULT_SHARE_FIELDS, sender: "last" },
    expiresAt: "x",
  });
  assert.deepEqual(p.parties.from, { withheld: true });
  leakSweep(p, ["Prince"]);
});

check("hiding the payout account keeps the whole IBAN out of the payload", () => {
  const p = build(sepaTransfer, { account: "hidden" });
  assert.ok(p.rows.find((r) => r.key === "Payout account")?.withheld);
  leakSweep(p, [IBAN, "0532013000"]);
});

check("the short account shows enough to recognise, not enough to pay into", () => {
  const p = build(sepaTransfer, { account: "short" });
  const v = p.rows.find((r) => r.key === "Payout account")?.value ?? "";
  assert.equal(v, "DE89 ···· 3000");
  assert.ok(!v.includes("0532"), "the middle of the account is not published");
  assert.ok(!JSON.stringify(p).includes(IBAN));
});

check("the full account is published only when the sender asks for it", () => {
  const p = build(sepaTransfer, { account: "full" });
  assert.equal(p.rows.find((r) => r.key === "Payout account")?.value, "DE89 3704 0044 0532 0130 00");
});

check("turning off rate and reference removes both rows entirely", () => {
  const p = build(sepaTransfer, { showRate: false, showRef: false });
  assert.ok(!p.rows.some((r) => r.key === "Your rate" || r.key === "Zold fee" || r.key === "Reference"));
  leakSweep(p, ["2.90", "Family support"]);
  assert.ok(p.anyWithheld, "the page still admits something was withheld");
});

check("the currency picker decides the hero figure", () => {
  assert.equal(build(sepaTransfer, { fx: "sender" }).hero.amount, "€850.00");
  assert.equal(build(sepaTransfer, { fx: "recipient" }).hero.amount, "€847.10");
  const both = build(sepaTransfer, { fx: "both" });
  assert.ok(both.rows.some((r) => r.key === "Sent") && both.rows.some((r) => r.key === "Received"));
});

check("the status is read from the transfer, not from having been shared", () => {
  assert.equal(receiptStatus({ ...sepaTransfer, state: "PAID" } as Transfer).label, "Delivered");
  assert.equal(receiptStatus({ ...sepaTransfer, state: "FAILED" } as Transfer).tone, "red");
  assert.equal(receiptStatus({ ...sepaTransfer, state: "DEBITED" } as Transfer).settled, false);
  assert.equal(receiptStatus({ ...sepaTransfer, state: "REFUNDED" } as Transfer).label, "Refunded to sender");
});

check("an in-flight transfer never renders as delivered", () => {
  const p = build({ ...sepaTransfer, state: "PAYOUT_SUBMITTED" } as Transfer, {});
  assert.equal(p.status.settled, false);
  assert.notEqual(p.status.label, "Delivered");
  assert.ok(p.steps.some((s) => !s.done), "unfinished steps stay unfinished");
});

check("the route is absent until the sender enables it", () => {
  assert.equal(build(sepaTransfer, { route: false }).route, undefined);
  assert.ok((build(sepaTransfer, { route: true }).route ?? []).length > 0);
});

check("route hops come from the transfer's own steps", () => {
  const rails = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true }).map((h) => h.rail);
  assert.deepEqual(rails, ["Zold Safe", "Monerium EMI", "SEPA credit transfer"]);

  const undebited = receiptRoute({ ...sepaTransfer, txs: [] } as Transfer, { ...DEFAULT_SHARE_FIELDS, route: true });
  assert.ok(!undebited.some((h) => h.rail === "Zold Safe"), "a leg that did not run is not drawn");
});

check("a leg that did not settle is marked simulated rather than drawn as real", () => {
  const mock = { ...sepaTransfer, sepa: { mode: "mock", state: "processed" } } as Transfer;
  const hops = receiptRoute(mock, { ...DEFAULT_SHARE_FIELDS, route: true });
  const issuer = hops.find((h) => h.rail === "Monerium EMI");
  assert.ok(issuer?.simulated, "a redemption with no issuer order is not a settlement");
  assert.match(issuer!.via, /no issuer order was placed/);
});

check("the safe hop says only the fee left the safe", () => {
  const hops = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true });
  assert.match(hops.find((h) => h.rail === "Zold Safe")!.via, /fee moved out/);
});

check("route references mirror the same selections as the rows", () => {
  const hidden = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true, sender: "hidden" });
  const safe = hidden.find((h) => h.rail === "Zold Safe")!;
  assert.ok(safe.withheld && !safe.ref, "hiding the sender withholds their safe's transaction hash");
  assert.ok(!JSON.stringify(hidden).includes(SAFE_HASH));

  const publicRoute = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true });
  assert.ok(!JSON.stringify(publicRoute).includes(SAFE_HASH), "route tx hashes are not published as searchable refs");

  const noAccount = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true, account: "hidden" });
  assert.ok(noAccount.find((h) => h.rail === "Monerium EMI")!.withheld, "the account toggle also governs the order ref");
  assert.ok(!JSON.stringify(noAccount).includes(ORDER));

  const noRef = receiptRoute(sepaTransfer, { ...DEFAULT_SHARE_FIELDS, route: true, showRef: false });
  assert.ok(noRef.find((h) => h.rail === "SEPA credit transfer")!.withheld, "the reference toggle also governs the memo");
  assert.ok(!JSON.stringify(noRef).includes(MEMO));
});

check("the tightest possible share leaks nothing at all", () => {
  const p = build(sepaTransfer, {
    sender: "hidden",
    recipient: "hidden",
    account: "hidden",
    showRate: false,
    showRef: false,
    route: true,
  });
  leakSweep(p, ["Amina", "Kamau", "Joseph", "Otieno", IBAN, SAFE_HASH, "2.90", "Family support", ORDER, MEMO]);
  assert.ok(p.anyWithheld);
});

check("the slug is unguessable and keeps the design's grouped shape", () => {
  const slugs = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const s = receiptSlug((len) => crypto.getRandomValues(new Uint8Array(len)));
    assert.match(s, /^[0-9abcdefghjkmnpqrstvwxyz]{5}-[0-9abcdefghjkmnpqrstvwxyz]{5}-[0-9abcdefghjkmnpqrstvwxyz]{5}$/);
    // Glyphs that survive being read aloud or copied off a screenshot.
    assert.ok(!/[ilou]/.test(s), "ambiguous characters are excluded");
    slugs.add(s);
  }
  assert.equal(slugs.size, 500, "no collisions in 500 slugs");
  // 15 chars of a 32-glyph alphabet is 75 bits — not enumerable, unlike the
  // eight decimal digits the design mock prints.
  assert.ok(15 * Math.log2(32) > 64);
});

console.log(`\nRECEIPT SHARE TEST PASSED — ${n} checks`);
