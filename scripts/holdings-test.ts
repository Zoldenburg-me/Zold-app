/**
 * Holdings and disposals of the tokens in imported wallets, offline.
 *
 * What arrives opens a lot at its EUR value on arrival; what leaves is a
 * disposal at its EUR value when it left, and its gain or loss is that value
 * minus the FIFO cost of the lots it used. Where a figure is missing the gain
 * is absent, not zero: no value on the row, a lot with no known cost, or more
 * sold than was ever booked (a shortfall, which is shown). EURe is money and
 * opens no lot; a token on no list is a quantity with no value; a transfer
 * between the organisation's own wallets realises nothing.
 *
 * A receipt booked without a value gets one only by the same price lookup
 * sync uses, retried for the row's block time, never from a typed price.
 *
 * Ledger rows are seeded as wallet sync writes them; everything else goes
 * through the routes.
 *
 * Run: npm run holdings:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-holdings-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// Config refuses hardhat's public key on a remote RPC; nothing here dials it.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.25, INR: 109.87, KES: 147.53 });
process.env.WALLET_SYNC_ENABLED = "0";

// The price feed, stubbed: what it answers is set per check.
let feed: { status: number; body: unknown } = { status: 200, body: { coins: {} } };
let feedCalls = 0;
const feedApp = express();
feedApp.get("/prices/historical/:ts/:coin", (req, res) => {
  feedCalls++;
  res.status(feed.status).json(typeof feed.body === "function" ? (feed.body as any)(req) : feed.body);
});
const feedServer = feedApp.listen(0, "127.0.0.1");
await new Promise<void>((r) => feedServer.once("listening", () => r()));
process.env.WALLET_SYNC_PRICE_URL = `http://127.0.0.1:${(feedServer.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
type LedgerEntry = import("../services/api/src/domain/types.js").LedgerEntry;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

initStore();
const NOW = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
const addOrg = (id: string, plan: string) =>
  store.addOrganisation({
    id, type: "business", name: "Zoldenburg", legalName: "Zoldenburg UG (haftungsbeschränkt)", plan, reporting,
    address: { line1: "Hauptstraße 1", postalCode: "93047", city: "Regensburg", country: "DE" },
    invoicing: { vatId: "DE123456789" }, verifications: {}, createdAt: NOW, updatedAt: NOW,
  } as any);
addOrg("org_1", "business");
addOrg("org_free", "starter");
for (const id of ["u_owner", "u_viewer", "u_outsider"]) {
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: NOW } as any);
}
const member = (id: string, orgId: string, userId: string, role: string) =>
  store.addMember({ id, orgId, userId, email: "", role, status: "active", invitedAt: NOW, acceptedAt: NOW } as any);
member("m_owner", "org_1", "u_owner", "owner");
member("m_viewer", "org_1", "u_viewer", "viewer");
member("m_free", "org_free", "u_owner", "owner");

const ARBITRUM = 42161;
const WALLET_A = `0x${"aa".repeat(20)}` as `0x${string}`;
const WALLET_B = `0x${"bb".repeat(20)}` as `0x${string}`;
const ZOLD_ACCOUNT = `0x${"ac".repeat(20)}` as `0x${string}`;
const DAO = `0x${"da".repeat(20)}` as `0x${string}`;
const DEX = `0x${"de".repeat(20)}` as `0x${string}`;
const ARB = "0x912ce59144191c1204e64559fe8253a0e49e6548" as `0x${string}`;
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as `0x${string}`;
const OP = `0x${"0f".repeat(20)}` as `0x${string}`;
const WETH = `0x${"e7".repeat(20)}` as `0x${string}`;
const EURE = "0x0c06ccf38114ddfc35e07427b9424adcca9f44f8" as `0x${string}`;
const AIR = `0x${"a1".repeat(20)}` as `0x${string}`;
const APP_USDC = `0x${"5c".repeat(20)}` as `0x${string}`;
// A token another chain also calls ARB: a different contract, a different holding.
const OTHER_ARB = `0x${"9a".repeat(20)}` as `0x${string}`;
const GOV = `0x${"60".repeat(20)}` as `0x${string}`;
const COLD = `0x${"c1".repeat(20)}` as `0x${string}`;
const LOSS = `0x${"10".repeat(20)}` as `0x${string}`;
const FX = `0x${"f0".repeat(20)}` as `0x${string}`;

const wallet = (id: string, address: `0x${string}`, proven: boolean) =>
  store.addImportedWallet({
    id, orgId: "org_1", address, chainId: ARBITRUM, label: id, kind: "safe", custody: "external",
    sync: { status: "synced" }, createdAt: NOW,
    ...(proven ? { ownership: { status: "proven", method: "eip1271", message: "m", signature: "0x", provenAt: NOW, checkedAt: NOW } } : {}),
  } as any);
wallet("iw_a", WALLET_A, true);
wallet("iw_b", WALLET_B, false);
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", address: ZOLD_ACCOUNT, createdAt: NOW, updatedAt: NOW } as any);

let n = 0;
/** A row as wallet sync writes it. `value` undefined books it unvalued. */
const row = (id: string, o: {
  wallet?: "iw_a" | "iw_b"; dir: "in" | "out"; token: `0x${string}`; symbol: string; amount: string; value?: string;
  at: string; tx?: number; to?: string; internal?: boolean; unlisted?: boolean; emoney?: boolean; chainId?: number;
}): LedgerEntry => {
  n++;
  const chainId = o.chainId ?? ARBITRUM;
  const unvalued = o.value === undefined;
  return {
    id, orgId: "org_1", source: { kind: "wallet", walletId: o.wallet ?? "iw_a" }, chainId,
    txHash: `0x${(o.tx ?? n).toString(16).padStart(64, "0")}`, logIndex: n,
    direction: o.dir, asset: unvalued ? `${o.symbol}@${chainId}:${o.token}` : o.symbol, token: o.token, amount: o.amount,
    ...(unvalued ? {} : { fiatValue: o.value, fiatCurrency: "EUR", fiatRate: "1" }),
    counterparty: { address: o.to ?? DAO },
    tags: ["wallet", ...(o.internal ? ["internal"] : []), ...(o.emoney ? ["e-money"] : []), ...(o.unlisted ? ["unlisted"] : unvalued ? ["needs-valuation"] : [])],
    note: unvalued && !o.unlisted ? "Not valued: the price feed has no price for this token." : undefined,
    txType: o.internal ? "internal_transfer" : o.unlisted ? "unlisted_token" : o.dir === "in" ? "transfer_in" : "transfer_out",
    at: o.at, createdAt: NOW,
  };
};

store.addLedgerEntries([
  row("a1", { dir: "in", token: ARB, symbol: "ARB", amount: "100", value: "50.00", at: "2026-01-10T10:00:00.000Z" }),
  row("a2", { dir: "in", token: ARB, symbol: "ARB", amount: "100", value: "80.00", at: "2026-02-10T10:00:00.000Z" }),
  row("d1", { dir: "out", token: ARB, symbol: "ARB", amount: "150", value: "150.00", at: "2026-03-05T10:00:00.000Z", to: DEX }),
  // Between the organisation's own wallets: both sides booked, neither realises anything.
  row("i_out", { dir: "out", token: ARB, symbol: "ARB", amount: "30", value: "36.00", at: "2026-03-06T10:00:00.000Z", tx: 900, to: WALLET_B, internal: true }),
  row("i_in", { wallet: "iw_b", dir: "in", token: ARB, symbol: "ARB", amount: "30", value: "36.00", at: "2026-03-06T10:00:00.000Z", tx: 900, to: WALLET_A, internal: true }),
  // 23:30 in Berlin on 31 March is 1 April: an April disposal.
  row("d2", { wallet: "iw_b", dir: "out", token: ARB, symbol: "ARB", amount: "20", value: "30.00", at: "2026-03-31T22:30:00.000Z", to: DEX }),
  // A swap: ARB out, USDC in, one transaction.
  row("s_out", { dir: "out", token: ARB, symbol: "ARB", amount: "10", value: "12.00", at: "2026-05-01T10:00:00.000Z", tx: 901, to: DEX }),
  row("s_in", { dir: "in", token: USDC, symbol: "USDC", amount: "15", value: "11.90", at: "2026-05-01T10:00:00.000Z", tx: 901, to: DEX }),
  // More sold than was ever booked.
  row("short", { dir: "out", token: ARB, symbol: "ARB", amount: "50", value: "60.00", at: "2026-06-01T10:00:00.000Z", to: DEX }),
  // A receipt the feed could not price, then a sale of part of it.
  row("op_in", { dir: "in", token: OP, symbol: "OP", amount: "40", at: "2026-07-01T10:00:00.000Z" }),
  row("op_out", { dir: "out", token: OP, symbol: "OP", amount: "10", value: "20.00", at: "2026-07-02T10:00:00.000Z", to: DEX }),
  // A sale the feed could not price.
  row("usdc_out", { dir: "out", token: USDC, symbol: "USDC", amount: "5", at: "2026-07-03T10:00:00.000Z", to: DEX }),
  // Sent to the organisation's own Zold account, which is on the app chain:
  // it leaves the wallets at cost.
  row("app_in", { dir: "in", token: APP_USDC, symbol: "USDC", amount: "10", value: "8.00", at: "2026-07-03T12:00:00.000Z", chainId: 31337 }),
  row("to_acc", { dir: "out", token: APP_USDC, symbol: "USDC", amount: "2", value: "1.60", at: "2026-07-04T10:00:00.000Z", to: ZOLD_ACCOUNT, internal: true, chainId: 31337 }),
  row("eure_in", { dir: "in", token: EURE, symbol: "EURe", amount: "100", value: "100.00", at: "2026-07-05T10:00:00.000Z", emoney: true }),
  row("eure_out", { dir: "out", token: EURE, symbol: "EURe", amount: "40", value: "40.00", at: "2026-07-06T10:00:00.000Z", emoney: true, to: DEX }),
  row("air_in", { dir: "in", token: AIR, symbol: "AIR", amount: "1000", at: "2026-07-07T10:00:00.000Z", unlisted: true }),
  row("air_out", { dir: "out", token: AIR, symbol: "AIR", amount: "100", at: "2026-07-08T10:00:00.000Z", unlisted: true, to: DEX }),
  // Eighteen decimals, exactly.
  row("w_in", { dir: "in", token: WETH, symbol: "WETH", amount: "1.000000000000000001", value: "2000.00", at: "2026-07-09T10:00:00.000Z" }),
  row("w_out", { dir: "out", token: WETH, symbol: "WETH", amount: "0.000000000000000001", value: "0.00", at: "2026-07-10T10:00:00.000Z", to: DEX }),
  row("arb_l1", { dir: "in", token: OTHER_ARB, symbol: "ARB", amount: "7", value: "3.00", at: "2026-07-11T10:00:00.000Z", chainId: 1 }),
  // Synced from A before B was imported, so not tagged internal; B's side,
  // synced after, is. Both are between the organisation's own wallets now.
  row("g_in", { dir: "in", token: GOV, symbol: "GOV", amount: "10", value: "10.00", at: "2026-08-01T10:00:00.000Z" }),
  row("g_out", { dir: "out", token: GOV, symbol: "GOV", amount: "4", value: "6.00", at: "2026-08-02T10:00:00.000Z", tx: 902, to: WALLET_B }),
  row("g_in_b", { wallet: "iw_b", dir: "in", token: GOV, symbol: "GOV", amount: "4", value: "6.00", at: "2026-08-02T10:00:00.000Z", tx: 902, to: WALLET_A, internal: true }),
  // Marked internal by hand: to an address of the organisation's that is not imported.
  row("g_cold", { dir: "out", token: GOV, symbol: "GOV", amount: "1", value: "1.50", at: "2026-08-03T10:00:00.000Z", to: COLD, internal: true }),
  // A loss, in October.
  row("l_in", { dir: "in", token: LOSS, symbol: "LOSS", amount: "10", value: "20.00", at: "2026-10-01T10:00:00.000Z" }),
  row("l_out", { dir: "out", token: LOSS, symbol: "LOSS", amount: "10", value: "5.00", at: "2026-10-02T10:00:00.000Z", to: DEX }),
  // Values in another currency than EUR are no EUR cost and no EUR proceeds.
  { ...row("fx_in", { dir: "in", token: FX, symbol: "FX", amount: "4", value: "100.00", at: "2026-10-03T10:00:00.000Z" }), fiatCurrency: "USD" },
  { ...row("fx_out", { dir: "out", token: FX, symbol: "FX", amount: "1", value: "30.00", at: "2026-10-04T10:00:00.000Z", to: DEX }), fiatCurrency: "USD" },
  // To the Zold account without the internal tag (synced before the account
  // existed), and back from it: a move, not a sale or a purchase.
  row("acc_out", { dir: "out", token: APP_USDC, symbol: "USDC", amount: "1", value: "0.80", at: "2026-10-05T10:00:00.000Z", to: ZOLD_ACCOUNT, chainId: 31337 }),
  row("acc_in", { dir: "in", token: APP_USDC, symbol: "USDC", amount: "3", value: "2.40", at: "2026-10-06T10:00:00.000Z", to: ZOLD_ACCOUNT, chainId: 31337 }),
  { ...row("bad_time", { dir: "in", token: GOV, symbol: "GOV", amount: "1", value: "1.00", at: "2026-08-04T10:00:00.000Z" }), at: "not a time" },
  // The euro account's own statement line: money, not a holding.
  { id: "stmt", orgId: "org_1", source: { kind: "account", accountId: "acc_1" }, direction: "in", asset: "EUR", amount: "100", fiatValue: "100", tags: [], at: "2026-07-12T10:00:00.000Z", createdAt: NOW },
]);

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user") as string | undefined;
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_owner") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};
const assets = async () => (await call("GET", "/org_1/assets")).body;
const gains = async () => (await call("GET", "/org_1/reports/realised-gains")).body;
const position = (a: any, key: string) => a.positions.find((p: any) => p.key === key);
const disposal = (a: any, id: string) => a.disposals.find((d: any) => d.entryId === id);
const ARB_KEY = `${ARBITRUM}:${ARB}`;
const USDC_KEY = `${ARBITRUM}:${USDC}`;
const OP_KEY = `${ARBITRUM}:${OP}`;

console.log("\nWho may read and revalue");

await check("the three checks: no membership is 404, a plan without cost basis is 402, a viewer may read but not revalue", async () => {
  assert.equal((await call("GET", "/org_1/assets", undefined, "u_outsider")).status, 404);
  assert.equal((await call("GET", "/org_free/assets")).status, 402);
  assert.equal((await call("GET", "/org_free/reports/realised-gains")).status, 402);
  assert.equal((await call("GET", "/org_1/assets", undefined, "u_viewer")).status, 200);
  assert.equal((await call("GET", "/org_1/reports/realised-gains", undefined, "u_viewer")).status, 200);
  assert.equal((await call("POST", "/org_1/ledger/op_in/revalue", {}, "u_viewer")).status, 403);
  assert.equal((await call("POST", "/org_1/ledger/op_in/revalue", {}, "u_outsider")).status, 404);
  assert.equal((await call("POST", "/org_free/ledger/op_in/revalue", {})).status, 402);
  assert.equal((await call("POST", "/org_1/ledger/revalue", {}, "u_viewer")).status, 403);
});

console.log("\nLots and disposals");

let a: any;
await check("a disposal uses the oldest lots first, and its gain is its EUR value minus their cost", async () => {
  a = await assets();
  const d = disposal(a, "d1");
  assert.equal(d.key, ARB_KEY);
  assert.equal(d.asset, "ARB");
  assert.equal(d.quantity, "150");
  assert.equal(d.proceedsCents, 15000);
  assert.equal(d.costBasisCents, 9000, "100 at 50.00, then 50 of the 100 at 80.00");
  assert.equal(d.realisedCents, 6000);
  assert.deepEqual(d.consumed.map((c: any) => [c.lotId, c.quantity, c.costCents]), [["lot_a1", "100", 5000], ["lot_a2", "50", 4000]]);
});

await check("a transfer between the organisation's own wallets moves no lot and realises nothing", async () => {
  assert.equal(disposal(a, "i_out"), undefined);
  assert.ok(!a.positions.flatMap((p: any) => p.lots).some((l: any) => l.sourceEntryId === "i_in"));
  const d2 = disposal(a, "d2");
  assert.equal(d2.costBasisCents, 1600, "the second wallet's sale draws on the pooled lots");
  assert.equal(d2.realisedCents, 1400);
});

await check("a swap is a disposal and an acquisition, each at its own value, and the disposal names the other row of its transaction", async () => {
  const d = disposal(a, "s_out");
  assert.equal(d.proceedsCents, 1200);
  assert.equal(d.costBasisCents, 800);
  assert.equal(d.realisedCents, 400);
  assert.deepEqual(d.sameTransaction, ["s_in"]);
  const lot = position(a, USDC_KEY).lots.find((l: any) => l.sourceEntryId === "s_in");
  assert.equal(lot.costCents, 1190);
});

await check("selling more than was booked is a shortfall: shown with the quantity, and the gain is not measured", async () => {
  const d = disposal(a, "short");
  assert.equal(d.shortfall, "30");
  assert.equal(d.realisedCents, undefined, "absent, not zero");
  assert.equal(d.costBasisCents, undefined, "the cost of what was never booked is not known");
  assert.match(d.notMeasurable, /more than/i);
  assert.equal(d.proceedsCents, 6000, "what is known is still shown");
  assert.deepEqual(a.shortfalls.map((s: any) => [s.entryId, s.quantity]), [["short", "30"]]);
});

await check("a lot with no known cost makes the gain of what it is sold from not measurable", async () => {
  const d = disposal(a, "op_out");
  assert.equal(d.realisedCents, undefined);
  assert.equal(d.costBasisCents, undefined);
  assert.match(d.notMeasurable, /cost/i);
  const p = position(a, OP_KEY);
  assert.equal(p.quantity, "30");
  assert.equal(p.uncostedQuantity, "30");
  assert.equal(p.costBasisCents, undefined, "no known cost is not a cost of zero");
  assert.equal(p.realisedCents, undefined, "its only sale was not measurable");
});

await check("a sale with no value has no gain: absent, not zero", async () => {
  const d = disposal(a, "usdc_out");
  assert.equal(d.proceedsCents, undefined);
  assert.equal(d.realisedCents, undefined);
  assert.match(d.notMeasurable, /value/i);
  assert.equal(d.costBasisCents, 397, "the cost it used is still known: 5 of 15 at 11.90");
});

await check("a send to the organisation's own Zold account leaves the wallets at cost and realises nothing", async () => {
  assert.equal(disposal(a, "to_acc"), undefined);
  const m = a.moved.find((x: any) => x.entryId === "to_acc");
  assert.equal(m.quantity, "2");
  assert.equal(m.costBasisCents, 160, "2 of 10 at 8.00");
  assert.deepEqual(m.consumed.map((c: any) => c.lotId), ["lot_app_in"]);
  const p = position(a, `31337:${APP_USDC}`);
  // 10 in, 2 here and 1 later to the account, 3 back from it with no known cost.
  assert.equal(p.quantity, "10");
  assert.equal(p.costBasisCents, 560, "7 left of the lot at 8.00 for 10");
  assert.equal(p.uncostedQuantity, "3");
  assert.equal(position(a, USDC_KEY).costBasisCents, 793, "the other chain's USDC is untouched");
});

await check("whether a transfer is between own wallets is decided from the wallets imported now, not from the tag sync wrote", async () => {
  assert.equal(disposal(a, "g_out"), undefined, "A's untagged send to B is no sale once B is imported");
  const p = position(a, `${ARBITRUM}:${GOV}`);
  assert.ok(!p.lots.some((l: any) => l.sourceEntryId === "g_in_b"), "B's side opens no second lot");
  assert.equal(p.quantity, "9", "10 in, 1 to an own address not imported; the move between wallets changes nothing");
});

await check("a send marked internal to an address that is not imported leaves the holdings at cost, with no gain", async () => {
  assert.equal(disposal(a, "g_cold"), undefined);
  const m = a.moved.find((x: any) => x.entryId === "g_cold");
  assert.equal(m.to, "own-address");
  assert.equal(m.costBasisCents, 100);
});

await check("a row whose time cannot be read is named, not dropped silently", async () => {
  assert.ok(a.unreadable.includes("bad_time"));
  assert.ok(!a.positions.flatMap((p: any) => p.lots).some((l: any) => l.sourceEntryId === "bad_time"));
  assert.ok((await gains()).unreadable.includes("bad_time"));
});

await check("a value in another currency is no EUR value: no cost, no proceeds, no gain", async () => {
  const lot = position(a, `${ARBITRUM}:${FX}`).lots.find((l: any) => l.sourceEntryId === "fx_in");
  assert.equal(lot.costCents, undefined);
  const d = disposal(a, "fx_out");
  assert.equal(d.proceedsCents, undefined);
  assert.equal(d.realisedCents, undefined);
});

await check("the Zold account is recognised by address, tag or no tag, both ways: a move, not a sale or a purchase", async () => {
  assert.equal(a.moved.find((x: any) => x.entryId === "to_acc").to, "zold-account");
  const out = a.moved.find((x: any) => x.entryId === "acc_out");
  assert.equal(out?.to, "zold-account");
  assert.equal(disposal(a, "acc_out"), undefined);
  const lot = position(a, `31337:${APP_USDC}`).lots.find((l: any) => l.sourceEntryId === "acc_in");
  assert.equal(lot.costCents, undefined, "its cost is in the account's books, not its value now");
});

await check("EURe is money: no lot, no disposal", async () => {
  assert.ok(!a.positions.some((p: any) => p.asset === "EURe"));
  assert.ok(!a.disposals.some((d: any) => d.entryId.startsWith("eure")));
});

await check("the euro account's statement lines are money, not a holding", async () => {
  assert.ok(!a.positions.some((p: any) => p.asset === "EUR"));
  assert.ok(!a.disposals.some((d: any) => d.entryId === "stmt"));
});

await check("a token on no list is a quantity only: no lot, no cost, no disposal, no gain", async () => {
  const q = a.quantityOnly.find((x: any) => x.token === AIR);
  assert.equal(q.quantity, "900");
  assert.deepEqual(q.entryIds.sort(), ["air_in", "air_out"]);
  assert.ok(!a.positions.some((p: any) => p.token === AIR));
  assert.ok(!a.disposals.some((d: any) => d.entryId.startsWith("air")));
});

await check("quantities are exact to the last of eighteen decimals", async () => {
  const p = position(a, `${ARBITRUM}:${WETH}`);
  assert.equal(p.quantity, "1");
  assert.equal(disposal(a, "w_out").quantity, "0.000000000000000001");
});

await check("two contracts that both call themselves ARB are two holdings", async () => {
  assert.equal(position(a, `1:${OTHER_ARB}`).quantity, "7");
  assert.equal(position(a, ARB_KEY).quantity, "0");
});

await check("every lot names the row and wallet it came from, and a lot from an unproven wallet says so", async () => {
  for (const p of a.positions) for (const l of p.lots) assert.ok(l.sourceEntryId && l.walletId, JSON.stringify(l));
  const lot = position(a, USDC_KEY).lots[0];
  assert.equal(lot.walletProofState, "proven");
  const wallets = Object.fromEntries(a.wallets.map((w: any) => [w.id, w.proofState]));
  assert.deepEqual(wallets, { iw_a: "proven", iw_b: "unproven" });
});

await check("the cost-basis method is the organisation's setting, and the answer asserts no tax treatment", async () => {
  assert.equal(a.costBasisMethod, "FIFO");
  assert.match(a.notes.join(" "), /tax adviser|Steuerberater/i);
});

console.log("\nRealised gains per month");

await check("measured gains are summed per month in the organisation's time zone, and each names its rows", async () => {
  const g = await gains();
  const m = Object.fromEntries(g.months.map((x: any) => [x.month, x]));
  assert.equal(m["2026-03"].realisedCents, 6000);
  assert.deepEqual(m["2026-03"].disposals, ["d1"]);
  assert.equal(m["2026-04"].realisedCents, 1400, "d2 is April in Berlin");
  assert.equal(m["2026-05"].realisedCents, 400);
  assert.equal(m["2026-06"].realisedCents, undefined, "a month with no measurable sale has no sum, not zero");
  assert.equal(m["2026-06"].gainsCents, undefined);
  assert.equal(m["2026-06"].unmeasured, 1);
  assert.equal(m["2026-07"].unmeasured, 2);
  assert.equal(m["2026-07"].gainsCents, 0);
  assert.deepEqual(m["2026-07"].disposals.sort(), ["op_out", "usdc_out", "w_out"]);
  assert.equal(g.timeZone, "Europe/Berlin");
  assert.equal(m["2026-10"].realisedCents, -1500);
  assert.equal(m["2026-10"].lossesCents, 1500);
  assert.equal(m["2026-10"].gainsCents, 0);
});

console.log("\nRevaluing a receipt booked without a value");

const opPrice = (price: number, confidence = 0.99) => (req: any) => ({
  coins: { [`arbitrum:${OP}`]: { price, symbol: "OP", timestamp: Number(req.params.ts), confidence } },
});

await check("when the feed still has no price, the row stays unvalued and the answer says why (422)", async () => {
  feed = { status: 200, body: { coins: {} } };
  const r = await call("POST", "/org_1/ledger/op_in/revalue", {});
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /no price/);
  const e = store.ledgerOf("org_1").find((x) => x.id === "op_in")!;
  assert.equal(e.fiatValue, undefined);
  assert.ok(e.tags.includes("needs-valuation"));
});

await check("a feed outage is a 503 and changes nothing", async () => {
  feed = { status: 503, body: {} };
  const r = await call("POST", "/org_1/ledger/op_in/revalue", {});
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(store.ledgerOf("org_1").find((x) => x.id === "op_in")!.fiatValue, undefined);
});

await check("a retry asks the feed again for the row's block time, and records the value with its source; a price in the request is ignored", async () => {
  feed = { status: 200, body: opPrice(2.5) };
  const before = feedCalls;
  const r = await call("POST", "/org_1/ledger/op_in/revalue", { fiatValue: "999.00", price: 99 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(feedCalls > before, "a refusal cached earlier is not the answer to a retry");
  const e = store.ledgerOf("org_1").find((x) => x.id === "op_in")!;
  assert.equal(e.fiatValue, "80.00", "40 OP at 2.5 USD, at 1.25 USD per EUR");
  assert.equal(e.fiatCurrency, "EUR");
  assert.equal(e.asset, "OP");
  assert.ok(!e.tags.includes("needs-valuation"));
  assert.ok(e.tags.includes("revalued"));
  assert.match(e.valuation!.source, /DefiLlama/);
  assert.match(e.valuation!.source, /ECB/);
  assert.equal(e.valuation!.previousAsset, `OP@${ARBITRUM}:${OP}`);
  assert.ok(e.valuation!.revaluedAt);
  assert.match(e.note!, /DefiLlama/);
});

await check("the revalued lot gives its sale a measurable gain", async () => {
  const d = disposal(await assets(), "op_out");
  assert.equal(d.costBasisCents, 2000);
  assert.equal(d.realisedCents, 0);
  assert.equal(d.notMeasurable, undefined);
});

await check("only an unvalued wallet row of a listed token can be revalued", async () => {
  feed = { status: 200, body: opPrice(2.5) };
  assert.equal((await call("POST", "/org_1/ledger/op_in/revalue", {})).status, 409, "already valued");
  assert.equal((await call("POST", "/org_1/ledger/air_in/revalue", {})).status, 409, "on no token list");
  assert.equal((await call("POST", "/org_1/ledger/stmt/revalue", {})).status, 409, "not a wallet row");
  assert.equal((await call("POST", "/org_1/ledger/nope/revalue", {})).status, 404);
});

await check("a row an issued invoice holds is never revalued", async () => {
  store.addLedgerEntries([row("held", { dir: "in", token: OP, symbol: "OP", amount: "1", at: "2026-07-20T10:00:00.000Z" })]);
  store.addInvoice({
    id: "inv_held", direction: "outgoing", orgId: "org_1", linkTokenHash: "x", state: "SUBMITTED", lines: [], currency: "EUR", total: "0.00",
    createdAt: NOW, updatedAt: NOW,
    settlements: [{ method: "wallet-receipt", ref: "ledger:held", ledgerEntryId: "held", txHash: "0x1", asset: "OP", receivedAmount: "1", amountEur: 1, at: NOW }],
  } as any);
  const r = await call("POST", "/org_1/ledger/held/revalue", {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /invoice/i);
  assert.equal(store.ledgerOf("org_1").find((x) => x.id === "held")!.fiatValue, undefined);
});

await check("a row on an issued invoice's lines, not yet settled, is not revalued either", async () => {
  store.addLedgerEntries([row("held2", { dir: "in", token: OP, symbol: "OP", amount: "1", at: "2026-07-22T10:00:00.000Z" })]);
  store.addInvoice({
    id: "inv_held2", direction: "outgoing", orgId: "org_1", linkTokenHash: "y", state: "SUBMITTED", currency: "EUR", total: "0.00",
    createdAt: NOW, updatedAt: NOW, settlements: [],
    lines: [{ description: "x", quantity: "1", unitPrice: "0.00", amount: "0.00", receipt: { ledgerEntryId: "held2", at: NOW, asset: "OP", amount: "1", txHash: "0x2", eurCents: 0 } }],
  } as any);
  feed = { status: 200, body: opPrice(2.5) };
  const r = await call("POST", "/org_1/ledger/held2/revalue", {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(store.ledgerOf("org_1").find((x) => x.id === "held2")!.fiatValue, undefined);
});

await check("retrying every unvalued row reports each one, valued or not", async () => {
  feed = { status: 200, body: { coins: {} } };
  const r = await call("POST", "/org_1/ledger/revalue", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = Object.fromEntries(r.body.results.map((x: any) => [x.entryId, x]));
  assert.equal(byId.usdc_out.status, "valued", "USDC by address is 1 USD without the feed");
  assert.equal(byId.held.status, "skipped");
  assert.equal(byId.held2.status, "skipped");
  assert.ok(!("op_in" in byId), "a valued row is not retried");
  assert.equal(store.ledgerOf("org_1").find((x) => x.id === "usdc_out")!.fiatValue, "4.00");
});

await check("after the retry the unvalued sale has a measured gain", async () => {
  const d = disposal(await assets(), "usdc_out");
  assert.equal(d.proceedsCents, 400);
  assert.equal(d.realisedCents, 3);
});

await check("a note a person wrote on the row survives its revaluation; sync's own note is replaced", async () => {
  store.addLedgerEntries([row("noted", { dir: "in", token: OP, symbol: "OP", amount: "2", at: "2026-07-21T10:00:00.000Z" })]);
  store.updateLedgerEntry("noted", { note: "March retainer, see contract" });
  feed = { status: 200, body: opPrice(2.5) };
  assert.equal((await call("POST", "/org_1/ledger/noted/revalue", {})).status, 200);
  const e = store.ledgerOf("org_1").find((x) => x.id === "noted")!;
  assert.equal(e.note, "March retainer, see contract");
  assert.match(e.valuation!.source, /DefiLlama/);
});

await check("a tag edit cannot send a valued row back to the feed", async () => {
  const valued = store.ledgerOf("org_1").find((x) => x.id === "a1")!;
  store.updateLedgerEntry("a1", { tags: [...valued.tags, "needs-valuation"] });
  assert.equal((await call("POST", "/org_1/ledger/a1/revalue", {})).status, 409);
  assert.equal(store.ledgerOf("org_1").find((x) => x.id === "a1")!.fiatValue, "50.00");
});

await check("retrying every row pages in order: rows the feed cannot price do not hold back the rest", async () => {
  feed = { status: 200, body: { coins: {} } };
  store.addLedgerEntries(Array.from({ length: 12 }, (_, i) =>
    row(`page_${String(i).padStart(2, "0")}`, { dir: "in", token: OP, symbol: "OP", amount: "1", at: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` })));
  const first = await call("POST", "/org_1/ledger/revalue", {});
  assert.equal(first.body.results.length, 10);
  assert.ok(first.body.next, "more remain");
  const second = await call("POST", "/org_1/ledger/revalue", { after: first.body.next });
  const tried = [...first.body.results, ...second.body.results].map((x: any) => x.entryId);
  assert.equal(new Set(tried).size, tried.length, "no row is asked twice");
  for (let i = 0; i < 12; i++) assert.ok(tried.includes(`page_${String(i).padStart(2, "0")}`));
  assert.equal(second.body.next, undefined);
  assert.ok(second.body.results.every((x: any) => x.status !== "valued"));
});

server.close();
feedServer.close();
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
