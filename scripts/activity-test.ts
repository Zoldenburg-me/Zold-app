/**
 * The personal activity feed: transfers out, crypto deposits, and bank
 * transfers in (Monerium issue orders). A Monerium deposit is also seen on
 * chain as an EURe mint into the Safe, and must be listed once, as a bank
 * transfer. Pure rules in services/api/src/transfers/activity.ts.
 */
import assert from "node:assert/strict";
import { buildActivity } from "../services/api/src/transfers/activity.js";
import type { CryptoDeposit, MoneriumIssueRecord, Transfer } from "../services/api/src/store/types.js";

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const MINT = "0x0000000000000000000000000000000000000000" as const;
const WALLET = "0x1111111111111111111111111111111111111111" as const;

const issue = (over: Partial<MoneriumIssueRecord> = {}): MoneriumIssueRecord => ({
  orderId: "ord-1",
  userId: "u1",
  amountEur: 120,
  counterpartyName: "Anna Payer",
  counterpartyIban: "DE89370400440532013000",
  memo: "Rent October",
  processedAt: "2026-10-01T10:00:00.000Z",
  recordedAt: "2026-10-01T10:01:00.000Z",
  ...over,
});

const deposit = (over: Partial<CryptoDeposit> = {}): CryptoDeposit => ({
  id: "dep-1",
  userId: "u1",
  chainId: 84532,
  token: "EURE",
  txHash: "0xabc",
  logIndex: 0,
  amountUnits: "120000000000000000000",
  from: MINT,
  arrivedAt: "2026-10-01T10:00:30.000Z",
  amountEur: 120,
  creditedEur: 120,
  state: "CREDITED",
  settlementAsset: "EURE",
  detectedAt: "2026-10-01T10:01:00.000Z",
  updatedAt: "2026-10-01T10:01:00.000Z",
  ...over,
} as CryptoDeposit);

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: "t1",
  userId: "u1",
  rail: "sepa",
  state: "PAID",
  sendEur: 50,
  recipientName: "Landlord",
  createdAt: "2026-10-02T09:00:00.000Z",
  ...over,
} as Transfer);

check("a bank transfer in is listed with the payer, memo and amount", () => {
  const rows = buildActivity({ transfers: [], deposits: [], issues: [issue()] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: "bank_in",
    id: "ord-1",
    at: "2026-10-01T10:00:00.000Z",
    amountEur: 120,
    counterpartyName: "Anna Payer",
    memo: "Rent October",
  });
});

check("the payer's IBAN is never in the feed", () => {
  const rows = buildActivity({ transfers: [], deposits: [], issues: [issue()] });
  assert.ok(!JSON.stringify(rows).includes("DE89"), "counterparty IBAN leaked");
});

check("the EURe mint of a Monerium deposit is not listed a second time", () => {
  const rows = buildActivity({ transfers: [], deposits: [deposit()], issues: [issue()] });
  assert.deepEqual(rows.map((r) => r.kind), ["bank_in"]);
});

check("one mint is absorbed by one order: two equal deposits stay two rows", () => {
  const rows = buildActivity({
    transfers: [],
    deposits: [deposit({ id: "dep-1", txHash: "0xa" }), deposit({ id: "dep-2", txHash: "0xb" })],
    issues: [issue({ orderId: "ord-1" }), issue({ orderId: "ord-2" })],
  });
  assert.deepEqual(rows.map((r) => r.kind), ["bank_in", "bank_in"]);
});

check("a mint with no recorded order is still a bank transfer, without a payer", () => {
  const rows = buildActivity({ transfers: [], deposits: [deposit()], issues: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "bank_in");
  assert.equal(rows[0].id, "dep-1");
  assert.equal((rows[0] as any).amountEur, 120);
  assert.equal((rows[0] as any).counterpartyName, undefined);
});

check("a mint of a different amount or more than a day apart is not merged", () => {
  const rows = buildActivity({
    transfers: [],
    deposits: [deposit({ id: "far", arrivedAt: "2026-10-03T10:00:00.000Z" }), deposit({ id: "other", amountEur: 99 })],
    issues: [issue()],
  });
  assert.equal(rows.length, 3);
});

check("EURe from a wallet and any USDC stay crypto deposits", () => {
  const rows = buildActivity({
    transfers: [],
    deposits: [
      deposit({ id: "w", from: WALLET }),
      deposit({ id: "usdc", token: "USDC", from: MINT, amountEur: undefined, amountUsdc: 10 }),
    ],
    issues: [issue()],
  });
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["bank_in", "funding", "funding"]);
});

check("a mint the watcher refused is not relabelled", () => {
  const rows = buildActivity({ transfers: [], deposits: [deposit({ state: "REFUSED" } as any)], issues: [] });
  assert.equal(rows[0].kind, "funding");
});

check("everything is newest first", () => {
  const rows = buildActivity({
    transfers: [transfer()],
    deposits: [deposit({ id: "w", from: WALLET, detectedAt: "2026-09-30T00:00:00.000Z" })],
    issues: [issue()],
  });
  assert.deepEqual(rows.map((r) => r.kind), ["transfer", "bank_in", "funding"]);
});

check("a transfer keeps its operator-only fields out", () => {
  const rows = buildActivity({ transfers: [transfer({ reviewResolution: { note: "x" } } as any)], deposits: [], issues: [] });
  assert.equal((rows[0] as any).reviewResolution, undefined);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nactivity: all ok");
