/**
 * Imported-wallet sync, offline.
 *
 * Three layers, each against fixtures: the pure transfer -> ledger row
 * mapping (direction, counterparty contact, asset identity, skips), the
 * valuation (a known stablecoin at the ECB rate, a governance token through
 * the price feed, and every way a price is refused), and the sync loop over a
 * fake chain reader (cursor, windows, idempotent re-runs, backfill start,
 * wrong chain, a token with no decimals).
 *
 * Run: npm run wallet-sync:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-wallet-sync-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// Config refuses hardhat's public key on a remote RPC; nothing here dials it.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.25, INR: 109.87, KES: 147.53 });
process.env.WALLET_SYNC_CONFIRMATIONS = "2";
process.env.WALLET_SYNC_MAX_BLOCK_SPAN = "100";
process.env.WALLET_SYNC_WINDOWS_PER_TICK = "3";
process.env.WALLET_SYNC_PRICE_URL = "http://prices.test";

const { toWalletEntry, walletEntryKey, walletEntryId } = await import("../services/api/src/domain/wallet-transfers.js");
const { valueTransfer, USD_STABLECOINS, clearPriceCache } = await import("../services/api/src/wallet-sync/valuation.js");
const { syncWallet, firstBlockAtOrAfter } = await import("../services/api/src/wallet-sync/sync.js");
const { classifyToken, EMONEY_TOKENS } = await import("../services/api/src/wallet-sync/token-class.js");
const { loadTokenLists, clearTokenLists } = await import("../services/api/src/wallet-sync/token-lists.js");
/** Every token is listed, for loop tests about other things. */
const listedAll = async () => ({ ok: true as const, lists: { has: () => true, size: 0 } });
const { store } = await import("../services/api/src/store.js");
type ChainReader = import("../services/api/src/wallet-sync/sync.js").ChainReader;
type RawTransfer = import("../services/api/src/domain/wallet-transfers.js").RawTransfer;
type ImportedWallet = import("../services/api/src/domain/types.js").ImportedWallet;
type Contact = import("../services/api/src/domain/types.js").Contact;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

const SAFE = `0x${"aa".repeat(20)}` as `0x${string}`;
const DAO = `0x${"da".repeat(20)}` as `0x${string}`;
const STREAM = `0x${"5e".repeat(20)}` as `0x${string}`;
const STRANGER = `0x${"99".repeat(20)}` as `0x${string}`;
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const ARB_MAINNET = "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1" as `0x${string}`;
const FAKE_USDC = `0x${"fa".repeat(20)}` as `0x${string}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = "2026-10-03T12:00:00.000Z";

const wallet = (over: Partial<ImportedWallet> = {}): ImportedWallet => ({
  id: "iw_1", orgId: "org_1", address: SAFE.toLowerCase() as `0x${string}`, chainId: 1, label: "Treasury",
  kind: "safe", custody: "external", sync: { status: "pending" }, createdAt: "2026-09-01T00:00:00.000Z", ...over,
});
const contact = (id: string, name: string, address: string, chainId = 1): Contact => ({
  id, orgId: "org_1", name, wallets: [{ id: `w_${id}`, chainId, address: address as `0x${string}` }],
  bankAccounts: [], createdAt: NOW, updatedAt: NOW,
});
const transfer = (over: Partial<RawTransfer> = {}): RawTransfer => ({
  chainId: 1, token: USDC_MAINNET, from: DAO, to: SAFE, valueUnits: 4_000_000_000n,
  txHash: H(1), logIndex: 3, blockNumber: 100n, blockTime: "2026-09-30T10:00:00.000Z", ...over,
});
const usdcInfo = { address: USDC_MAINNET, symbol: "USDC", decimals: 6 };
const valued = { eurPerUnit: 0.8, eurValue: 3200, source: "USDC at 1 USD; ECB 1.25 USD per EUR", asOf: "2026-09-30", symbol: "USDC" };

console.log("\nTransfer -> ledger row");

await check("an inbound transfer from a contact's address is an `in` row naming the contact, valued in EUR", () => {
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer(), token: usdcInfo, valuation: valued, contacts: [contact("c_dao", "Example DAO", DAO)], now: NOW });
  assert.ok("entry" in r, JSON.stringify(r));
  const e = r.entry;
  assert.equal(e.direction, "in");
  assert.equal(e.amount, "4000");
  assert.equal(e.asset, "USDC");
  assert.equal(e.token, USDC_MAINNET.toLowerCase());
  assert.equal(e.fiatValue, "3200.00");
  assert.equal(e.fiatCurrency, "EUR");
  assert.equal(e.fiatRate, "0.8");
  assert.deepEqual(e.source, { kind: "wallet", walletId: "iw_1" });
  assert.equal(e.counterparty?.contactId, "c_dao");
  assert.equal(e.counterparty?.name, "Example DAO");
  assert.equal(e.counterparty?.address, DAO.toLowerCase());
  assert.equal(e.txType, "transfer_in");
  assert.equal(e.at, "2026-09-30T10:00:00.000Z");
  assert.equal(e.chainId, 1);
  assert.equal(e.logIndex, 3);
  assert.ok(!e.tags.includes("needs-valuation"));
});

await check("an outbound transfer is an `out` row with the receiver as counterparty", () => {
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: SAFE, to: STRANGER }), token: usdcInfo, valuation: valued, contacts: [], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.direction, "out");
  assert.equal(r.entry.txType, "transfer_out");
  assert.equal(r.entry.counterparty?.address, STRANGER.toLowerCase());
  assert.equal(r.entry.counterparty?.contactId, undefined);
});

await check("address matching ignores case, and a contact wallet on another chain does not match", () => {
  const upper = transfer({ from: DAO.toUpperCase().replace("0X", "0x") as `0x${string}`, to: SAFE.toUpperCase().replace("0X", "0x") as `0x${string}` });
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: upper, token: usdcInfo, valuation: valued, contacts: [contact("c_dao", "Example DAO", DAO, 42161)], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.direction, "in");
  assert.equal(r.entry.counterparty?.contactId, undefined);
});

await check("two contacts on one address name neither: a guess would book the money to the wrong payer", () => {
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer(), token: usdcInfo, valuation: valued, contacts: [contact("c_a", "A", DAO), contact("c_b", "B", DAO)], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.counterparty?.contactId, undefined);
});

await check("a stream contract registered on the contact matches a claim paid out by it", () => {
  const c = contact("c_dao", "Example DAO", DAO);
  c.wallets.push({ id: "w_stream", chainId: 1, address: STREAM, label: "Sablier stream" });
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: STREAM }), token: usdcInfo, valuation: valued, contacts: [c], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.counterparty?.contactId, "c_dao");
});

await check("no valuation: the row is still booked, without a value and tagged needs-valuation, under an address-qualified asset", () => {
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ token: FAKE_USDC, valueUnits: 10n ** 18n }), token: { address: FAKE_USDC, symbol: "USDC", decimals: 18 }, valuation: undefined, valuationFailure: "no price", contacts: [], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.fiatValue, undefined);
  assert.ok(r.entry.tags.includes("needs-valuation"));
  assert.equal(r.entry.asset, `USDC@1:${FAKE_USDC.toLowerCase()}`, "an unpriced token must not merge into real USDC lots");
  assert.match(r.entry.note ?? "", /no price/);
});

await check("decimals outside 0..77 are unusable (a contract may answer 2^28, and formatUnits would pad that long); a symbol is letters, digits, dot, dash, underscore", () => {
  const big = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ token: FAKE_USDC }), token: { address: FAKE_USDC, symbol: "X", decimals: 2 ** 28 }, valuation: undefined, contacts: [], now: NOW });
  assert.ok("skip" in big && /decimals/.test(big.skip));
  const neg = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ token: FAKE_USDC }), token: { address: FAKE_USDC, decimals: -1 }, valuation: undefined, contacts: [], now: NOW });
  assert.ok("skip" in neg);
  const spoof = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ token: FAKE_USDC }), token: { address: FAKE_USDC, symbol: "US\u202eDC <b>", decimals: 18 }, valuation: undefined, valuationFailure: "no price", contacts: [], now: NOW });
  assert.ok("entry" in spoof);
  assert.match(spoof.entry.asset, /^USDCb@1:0x/);
});

await check("a token on no list is booked as a quantity: no value, `unlisted_token` (no income rule), tagged unlisted", () => {
  const r = toWalletEntry({ tokenClass: "unlisted", wallet: wallet(), transfer: transfer({ token: FAKE_USDC, valueUnits: 10n ** 18n }), token: { address: FAKE_USDC, symbol: "USDC", decimals: 18 }, valuation: undefined, contacts: [], now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.txType, "unlisted_token");
  assert.equal(r.entry.fiatValue, undefined);
  assert.ok(r.entry.tags.includes("unlisted") && !r.entry.tags.includes("needs-valuation"));
  assert.match(r.entry.note ?? "", /Not on a token list/);
  assert.match(r.entry.asset, /^USDC@1:0x/, "qualified by contract, so it cannot merge into real USDC");
  const internal = toWalletEntry({ tokenClass: "unlisted", wallet: wallet(), transfer: transfer({ token: FAKE_USDC, from: STRANGER, valueUnits: 10n ** 18n }), token: { address: FAKE_USDC, decimals: 18 }, valuation: undefined, contacts: [], ownAddresses: [{ chainId: 1, address: STRANGER }], now: NOW });
  assert.ok("entry" in internal && internal.entry.txType === "internal_transfer", "between own wallets wins");
  const em = toWalletEntry({ tokenClass: "emoney", wallet: wallet(), transfer: transfer(), token: usdcInfo, valuation: { ...valued, symbol: "EURe", eurPerUnit: 1, eurValue: 4000 }, contacts: [], now: NOW });
  assert.ok("entry" in em && em.entry.tags.includes("e-money") && em.entry.asset === "EURe");
});

await check("a self-transfer and a zero transfer are skipped with a reason", () => {
  const self = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: SAFE, to: SAFE }), token: usdcInfo, valuation: valued, contacts: [], now: NOW });
  assert.ok("skip" in self);
  const zero = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ valueUnits: 0n }), token: usdcInfo, valuation: valued, contacts: [], now: NOW });
  assert.ok("skip" in zero);
  const notOurs = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: DAO, to: STRANGER }), token: usdcInfo, valuation: valued, contacts: [], now: NOW });
  assert.ok("skip" in notOurs);
});

await check("the row id is the org, address and log: a re-scan, or the same address removed and imported again, books nothing twice", () => {
  const a = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer(), token: usdcInfo, valuation: valued, contacts: [], now: NOW });
  const b = toWalletEntry({ tokenClass: "listed", wallet: wallet({ id: "iw_reimported" }), transfer: transfer(), token: usdcInfo, valuation: valued, contacts: [], now: "2027-01-01T00:00:00.000Z" });
  assert.ok("entry" in a && "entry" in b);
  assert.equal(a.entry.id, b.entry.id);
  assert.equal(a.entry.id, walletEntryId("org_1", SAFE, 1, H(1), 3));
  assert.equal(walletEntryKey(SAFE.toUpperCase().replace("0X", "0x"), 1, H(1), 3), `wallet:1:${SAFE.toLowerCase()}:${H(1)}:3`);
});

await check("a transfer to or from another of the org's own wallets is internal: no income, no expense code", () => {
  const OTHER = `0x${"bb".repeat(20)}`;
  const own = [{ chainId: 1, address: OTHER }];
  const r = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: OTHER as `0x${string}` }), token: usdcInfo, valuation: valued, contacts: [], ownAddresses: own, now: NOW });
  assert.ok("entry" in r);
  assert.equal(r.entry.txType, "internal_transfer");
  assert.ok(r.entry.tags.includes("internal"));
  const otherChain = toWalletEntry({ tokenClass: "listed", wallet: wallet(), transfer: transfer({ from: OTHER as `0x${string}` }), token: usdcInfo, valuation: valued, contacts: [], ownAddresses: [{ chainId: 8453, address: OTHER }], now: NOW });
  assert.ok("entry" in otherChain);
  assert.equal(otherChain.entry.txType, "transfer_in", "the same address on another chain is not the org's");
});

console.log("\nValuation");

const realFetch = globalThis.fetch;
const priceCalls: string[] = [];
const stubPrices = (coins: Record<string, unknown> | "fail" | number) => {
  clearPriceCache();
  globalThis.fetch = (async (url: any) => {
    priceCalls.push(String(url));
    if (coins === "fail") return new Response("upstream down", { status: 502 });
    if (typeof coins === "number") return new Response("no", { status: coins });
    return new Response(JSON.stringify({ coins }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
};

await check("USDC on mainnet is valued at 1 USD through the ECB rate, with no price-feed call", async () => {
  priceCalls.length = 0;
  stubPrices({});
  const v = await valueTransfer({ chainId: 1, token: USDC_MAINNET, amount: 4000, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.valuation.eurValue, 3200);
  assert.equal(v.valuation.eurPerUnit, 0.8);
  assert.equal(v.valuation.symbol, "USDC");
  assert.match(v.valuation.source, /1\.25/);
  assert.equal(priceCalls.length, 0);
  assert.ok(USD_STABLECOINS[1][USDC_MAINNET.toLowerCase()]);
});

await check("a token calling itself USDC at another address is not a stablecoin: it goes to the price feed", async () => {
  priceCalls.length = 0;
  stubPrices({});
  const v = await valueTransfer({ chainId: 1, token: FAKE_USDC, amount: 4000, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(v.ok, false);
  assert.equal(priceCalls.length, 1);
});

await check("ARB is priced by contract address at the block time and converted at the ECB rate", async () => {
  priceCalls.length = 0;
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 0.5, symbol: "ARB", timestamp: ts - 60, confidence: 0.99, decimals: 18 } });
  const v = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1000, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.valuation.eurValue, 400);
  assert.equal(v.valuation.eurPerUnit, 0.4);
  assert.equal(v.valuation.symbol, "ARB");
  assert.match(priceCalls[0], new RegExp(`^http://prices\\.test/prices/historical/${ts}/ethereum:${ARB_MAINNET.toLowerCase()}`));
  assert.match(v.valuation.source, /0\.5 USD/);
});

await check("a price below the confidence floor, too far from the block, or not positive is refused", async () => {
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  const key = `ethereum:${ARB_MAINNET.toLowerCase()}`;
  for (const [coin, why] of [
    [{ price: 0.5, symbol: "ARB", timestamp: ts, confidence: 0.5 }, "confidence"],
    [{ price: 0.5, symbol: "ARB", timestamp: ts - 5 * 3600, confidence: 0.99 }, "from the block"],
    [{ price: 0, symbol: "ARB", timestamp: ts, confidence: 0.99 }, "price"],
  ] as const) {
    stubPrices({ [key]: coin });
    const v = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1000, blockTime: "2026-09-30T10:00:00.000Z" });
    assert.equal(v.ok, false, why);
    assert.match((v as any).reason, new RegExp(why), (v as any).reason);
  }
});

await check("a feed outage is a transient refusal (retry); a chain the feed has no name for is a lasting one", async () => {
  stubPrices("fail");
  const down = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(down.ok, false);
  assert.equal((down as any).transient, true);
  const unknownChain = await valueTransfer({ chainId: 999_999, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(unknownChain.ok, false);
  assert.equal((unknownChain as any).transient, false);
  assert.match((unknownChain as any).reason, /999999/);
  stubPrices({});
  const none = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal((none as any).transient, false, "no price for a token is an answer, not an outage");
});

await check("a price with no confidence score is refused; the feed's key is matched regardless of case", async () => {
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 0.5, symbol: "ARB", timestamp: ts } });
  const noConf = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(noConf.ok, false);
  assert.match((noConf as any).reason, /confidence/);
  stubPrices({ [`ethereum:${ARB_MAINNET}`]: { price: 0.5, symbol: "ARB", timestamp: ts, confidence: 0.99 } });
  const mixed = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.ok(mixed.ok, JSON.stringify(mixed));
});

await check("a 4xx from the feed is its answer (lasting); only 408, 429 and 5xx hold the window", async () => {
  stubPrices(404);
  const gone = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(gone.ok, false);
  assert.equal((gone as any).transient, false, "a wallet behind one 404 token must not freeze");
  stubPrices(429);
  const slow = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal((slow as any).transient, true);
});

await check("the feed's text never reaches the wallet row raw: a string confidence, a symbol with a bidi override", async () => {
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 0.5, symbol: "ARB", timestamp: ts, confidence: "<img src=x>" } });
  const str = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(str.ok, false);
  assert.doesNotMatch((str as any).reason, /img/);
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 0.5, symbol: "US\u202eDC\n", timestamp: ts, confidence: 0.99 } });
  const bidi = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.ok(bidi.ok, JSON.stringify(bidi));
  assert.equal(bidi.valuation.symbol, "USDC".replace("", ""), "letters only");
});

await check("a value that does not fit a number is refused, not booked as Infinity", async () => {
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 1e308, symbol: "ARB", timestamp: ts, confidence: 0.99 } });
  const huge = await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1e10, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(huge.ok, false);
  assert.equal((huge as any).transient, false);
});

await check("the feed is asked once per token and hour: a second transfer in the same hour makes no call", async () => {
  const ts = Date.parse("2026-09-30T10:00:00.000Z") / 1000;
  stubPrices({ [`ethereum:${ARB_MAINNET.toLowerCase()}`]: { price: 0.5, symbol: "ARB", timestamp: ts, confidence: 0.99 } });
  const before = priceCalls.length;
  await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 7, blockTime: "2026-09-30T10:40:00.000Z" });
  assert.equal(priceCalls.length - before, 1);
  stubPrices("fail");
  await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  await valueTransfer({ chainId: 1, token: ARB_MAINNET, amount: 1, blockTime: "2026-09-30T10:00:00.000Z" });
  assert.equal(priceCalls.length - before, 3, "an outage is not cached");
});

console.log("\nToken class and lists");

await check("EURe is e-money by the issuer's address; USDC and a listed token are virtual assets; the rest is unlisted", () => {
  const eureMainnet = Object.keys(EMONEY_TOKENS[1])[0];
  const onList = (c: number, a: string) => c === 1 && a === ARB_MAINNET.toLowerCase();
  assert.equal(classifyToken(1, eureMainnet.toUpperCase(), onList), "emoney");
  assert.equal(classifyToken(1, USDC_MAINNET, () => false), "listed", "USDC by address needs no list");
  assert.equal(classifyToken(1, ARB_MAINNET, onList), "listed");
  assert.equal(classifyToken(1, FAKE_USDC, onList), "unlisted", "a token calling itself USDC at another address");
  assert.equal(classifyToken(8453, ARB_MAINNET, onList), "unlisted", "the same address on another chain is another token");
  assert.equal(classifyToken(31337, "0x5fbdb2315678afecb367f032d93f642f64180aa3", () => false, { 31337: { "0x5fbdb2315678afecb367f032d93f642f64180aa3": "EURe" } }), "emoney", "the app chain's own deployment");
});

await check("token lists: loaded once per day, a stale copy is kept through an outage, a list that never loaded holds", async () => {
  clearTokenLists();
  const calls: string[] = [];
  let fail = false;
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    if (fail) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ tokens: [{ chainId: 1, address: ARB_MAINNET, symbol: "ARB", decimals: 18 }, { chainId: "x", address: "junk" }] }), { status: 200 });
  }) as typeof fetch;
  const first = await loadTokenLists(1_000_000);
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(first.lists.has(1, ARB_MAINNET.toUpperCase()) && !first.lists.has(1, FAKE_USDC));
  const n = calls.length;
  await loadTokenLists(1_000_000 + 60_000);
  assert.equal(calls.length, n, "within the TTL nothing is fetched");
  fail = true;
  const stale = await loadTokenLists(1_000_000 + 2 * 24 * 3600_000);
  assert.ok(stale.ok && stale.lists.has(1, ARB_MAINNET), "an outage keeps the last copy");
  clearTokenLists();
  const never = await loadTokenLists(5_000_000);
  assert.equal(never.ok, false, "no copy at all is a reason to hold, not to call everything unlisted");
});

globalThis.fetch = realFetch;

console.log("\nSync loop");

function fakeReader(opts: { chainId?: number; head: bigint; logs: RawTransfer[]; noDecimals?: string[]; blockTime?: (n: bigint) => string; maxSpan?: bigint; tokenError?: Error; logsError?: Error; onLogs?: () => void }): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  const time = opts.blockTime ?? ((n: bigint) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + Number(n) * 12_000).toISOString());
  return {
    calls,
    async getChainId() { return opts.chainId ?? 1; },
    async getBlockNumber() { return opts.head; },
    async getBlockTime(n) { calls.push(`time:${n}`); return time(n); },
    async getTransferLogs({ address, direction, fromBlock, toBlock }) {
      calls.push(`logs:${direction}:${fromBlock}-${toBlock}`);
      opts.onLogs?.();
      if (opts.logsError) throw opts.logsError;
      if (opts.maxSpan !== undefined && toBlock - fromBlock + 1n > opts.maxSpan) throw new Error("query returned more than 10000 results");
      const a = address.toLowerCase();
      return opts.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && (direction === "in" ? l.to.toLowerCase() === a : l.from.toLowerCase() === a));
    },
    async tokenInfo(address) {
      if (opts.tokenError) throw opts.tokenError;
      if (opts.noDecimals?.includes(address.toLowerCase())) return { address, symbol: "BROKEN" };
      return address.toLowerCase() === USDC_MAINNET.toLowerCase() ? { address, symbol: "USDC", decimals: 6 } : { address, symbol: "ARB", decimals: 18 };
    },
  };
}
const fixedValue = async (q: { amount: number; token: string }) => ({
  ok: true as const,
  valuation: { eurPerUnit: 0.8, eurValue: Math.round(q.amount * 80) / 100, source: "fixed", asOf: "2026-09-30", symbol: q.token.toLowerCase() === USDC_MAINNET.toLowerCase() ? "USDC" : "ARB" },
});

const freshWallet = (over: Partial<ImportedWallet> = {}) => {
  const w = wallet({ id: `iw_${Math.random().toString(36).slice(2)}`, ...over });
  store.addImportedWallet(w);
  return w;
};

await check("a first sync with no start date books nothing old: the cursor starts at the safe head", async () => {
  const w = freshWallet();
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 500n })] });
  const r = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.cursor, "998");
  assert.equal(after.sync.status, "synced");
});

await check("from a start date: windows of maxBlockSpan, up to windowsPerTick per run, rows written once", async () => {
  const w = freshWallet({ sync: { status: "pending", from: "2026-09-01" } });
  const logs = [
    transfer({ blockNumber: 10n, txHash: H(10), logIndex: 0 }),
    transfer({ blockNumber: 150n, txHash: H(11), logIndex: 1, token: ARB_MAINNET, valueUnits: 5n * 10n ** 18n }),
    transfer({ blockNumber: 250n, txHash: H(12), logIndex: 2, from: SAFE, to: STRANGER, valueUnits: 1_000_000n }),
    transfer({ blockNumber: 350n, txHash: H(13), logIndex: 0 }),
  ];
  const reader = fakeReader({ head: 1000n, logs });
  const first = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(first.added, 3, "three windows of 100 blocks: 0-99, 100-199, 200-299");
  assert.equal(store.findImportedWallet(w.id)!.sync.cursor, "299");
  assert.equal(store.findImportedWallet(w.id)!.sync.status, "syncing", "behind the head after this run");
  const rows = store.ledgerOf("org_1").filter((e) => e.source.kind === "wallet" && e.source.walletId === w.id);
  assert.deepEqual(rows.map((e) => [e.direction, e.asset, e.amount]).sort(), [["in", "ARB", "5"], ["in", "USDC", "4000"], ["out", "USDC", "1"]].sort());
  const second = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(second.added, 1);
  // Rewind the cursor: a re-scan of booked blocks adds nothing.
  store.updateImportedWallet(w.id, { sync: { ...store.findImportedWallet(w.id)!.sync, cursor: "-1" } });
  const again = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(again.added, 0);
});

await check("a transfer in a block the chain still might reorg is left for the next run", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "990" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 999n, txHash: H(20) })] });
  const r = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  assert.equal(store.findImportedWallet(w.id)!.sync.cursor, "998");
});

await check("an RPC on the wrong chain is an error on the wallet, and the cursor does not move", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "10" } });
  const r = await syncWallet(w, fakeReader({ chainId: 8453, head: 1000n, logs: [] }), { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.status, "error");
  assert.match(after.sync.error ?? "", /8453/);
  assert.equal(after.sync.cursor, "10");
});

await check("a token whose decimals cannot be read is counted as skipped, with the reason, not booked at a guessed scale", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, token: ARB_MAINNET, txHash: H(30) })], noDecimals: [ARB_MAINNET.toLowerCase()] });
  const r = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 1);
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.skipped, 1);
  assert.match(after.sync.lastSkipReason ?? "", /decimals/);
});

await check("a valuation that fails still books the row, tagged needs-valuation", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, txHash: H(40) })] });
  const r = await syncWallet(w, reader, { value: async () => ({ ok: false as const, reason: "no price for this token", transient: false }), lists: listedAll, now: () => NOW });
  assert.equal(r.added, 1);
  const row = store.ledgerOf("org_1").find((e) => e.txHash === H(40))!;
  assert.ok(row.tags.includes("needs-valuation"));
  assert.equal(row.fiatValue, undefined);
});

await check("an unlisted token in a window books nothing and asks no price (anyone can mint one and send it); EURe is booked at par", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const eure = Object.keys(EMONEY_TOKENS[1])[0] as `0x${string}`;
  const priced: string[] = [];
  const logs = [
    transfer({ blockNumber: 10n, txHash: H(60), logIndex: 0, token: FAKE_USDC, valueUnits: 5n * 10n ** 18n }),
    transfer({ blockNumber: 11n, txHash: H(61), logIndex: 0, token: eure, valueUnits: 250n * 10n ** 18n }),
    transfer({ blockNumber: 12n, txHash: H(62), logIndex: 0 }),
  ];
  const reader = fakeReader({ head: 100n, logs });
  const lists = async () => ({ ok: true as const, lists: { has: (c: number, a: string) => a === USDC_MAINNET.toLowerCase(), size: 1 } });
  await syncWallet(w, reader, { value: async (q) => { priced.push(q.token); return fixedValue(q); }, lists, now: () => NOW });
  const rows = store.ledgerOf(w.orgId).filter((e) => e.source.kind === "wallet" && e.source.walletId === w.id);
  assert.equal(rows.find((e) => e.txHash === H(60)), undefined, "no row for an unlisted token");
  assert.ok(!priced.some((t) => t.toLowerCase() === FAKE_USDC.toLowerCase()), "no price asked for an unlisted token");
  const em = rows.find((e) => e.txHash === H(61))!;
  assert.equal(em.asset, "EURe");
  assert.equal(em.fiatValue, "250.00");
  assert.equal(em.txType, "transfer_in");
  assert.ok(!priced.some((t) => t.toLowerCase() === eure), "e-money is at par, not priced");
  assert.equal(rows.find((e) => e.txHash === H(62))!.txType, "transfer_in");
});

await check("at the books' row ceiling a wallet's sync pauses: nothing is booked or skipped, the cursor stays, the reason is shown", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const logs = [10n, 11n, 12n].map((b, i) => transfer({ blockNumber: b, txHash: H(80 + i), logIndex: 0 }));
  const reader = fakeReader({ head: 100n, logs });
  const ledgerCeiling = store.ledgerOf(w.orgId).length + 1;
  const paused = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW, ledgerCeiling });
  assert.equal(paused.added, 0);
  assert.equal(store.ledgerOf(w.orgId).filter((e) => e.source.kind === "wallet" && e.source.walletId === w.id).length, 0);
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.cursor, "0", "the cursor does not move past what was not booked");
  assert.equal(after.sync.status, "error");
  assert.match(after.sync.error ?? "", /paused/);
  // Already at the ceiling: paused before any chain read.
  const idle = fakeReader({ head: 100n, logs });
  const still = await syncWallet(store.findImportedWallet(w.id)!, idle, { value: fixedValue, lists: listedAll, now: () => NOW, ledgerCeiling: store.ledgerOf(w.orgId).length });
  assert.equal(still.added, 0);
  assert.deepEqual(idle.calls, [], "no log read for a wallet that cannot book");
  // Raised (by support): the same blocks are read again and booked.
  const resumed = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(resumed.added, 3);
});

await check("one block with more of the wallet's logs than the RPC returns is a counted gap, and sync carries on past it", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "40" } });
  const base = fakeReader({ head: 100n, logs: [49n, 50n, 51n, 60n].map((b, i) => transfer({ blockNumber: b, txHash: H(90 + i), logIndex: 0 })) });
  const reader: ChainReader = {
    ...base,
    async getTransferLogs(q) {
      if (q.fromBlock <= 50n && q.toBlock >= 50n) throw new Error("query returned more than 10000 results");
      return base.getTransferLogs(q);
    },
  };
  let skipped = 0;
  for (let run = 0; run < 5 && store.findImportedWallet(w.id)!.sync.status !== "synced"; run++) {
    skipped += (await syncWallet(store.findImportedWallet(w.id)!, reader, { value: fixedValue, lists: listedAll, now: () => NOW })).skipped;
  }
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.status, "synced", JSON.stringify(after.sync));
  assert.equal(after.sync.cursor, "98");
  assert.equal(skipped, 1);
  assert.match(after.sync.lastSkipReason ?? "", /block 50\b/);
  const booked = new Set(store.ledgerOf(w.orgId).filter((e) => e.source.kind === "wallet" && e.source.walletId === w.id).map((e) => e.txHash));
  assert.ok(booked.has(H(90)) && booked.has(H(92)) && booked.has(H(93)), "the blocks either side of the stuffed one, and later ones, are booked");
  assert.ok(!booked.has(H(91)), "a transfer inside the skipped block is not booked");
  assert.equal(after.sync.skipped, 1);
  // A gap is counted once, even when a later window of the same run holds.
  const twice = freshWallet({ sync: { status: "pending", cursor: "40" } });
  let limited = true;
  const stalled: ChainReader = {
    ...base,
    async getTransferLogs(q) {
      if (q.fromBlock <= 50n && q.toBlock >= 50n) throw new Error("query returned more than 10000 results");
      if (limited && q.fromBlock <= 70n && q.toBlock >= 70n) throw new Error("rate limit exceeded");
      return base.getTransferLogs(q);
    },
  };
  for (let run = 0; run < 5 && store.findImportedWallet(twice.id)!.sync.cursor !== "69"; run++) {
    await syncWallet(store.findImportedWallet(twice.id)!, stalled, { value: fixedValue, lists: listedAll, now: () => NOW });
  }
  assert.equal(store.findImportedWallet(twice.id)!.sync.cursor, "69", "held before the rate-limited block");
  limited = false;
  for (let run = 0; run < 5 && store.findImportedWallet(twice.id)!.sync.status !== "synced"; run++) {
    await syncWallet(store.findImportedWallet(twice.id)!, stalled, { value: fixedValue, lists: listedAll, now: () => NOW });
  }
  assert.equal(store.findImportedWallet(twice.id)!.sync.status, "synced");
  assert.equal(store.findImportedWallet(twice.id)!.sync.skipped, 1, "the stuffed block is counted once");
  // The shared readLogWindow still refuses at one block, so the crypto-in
  // poller, which uses it directly, holds rather than passing a block.
  const { readLogWindow } = await import("../services/api/src/log-range.js");
  await assert.rejects(
    readLogWindow(50n, 50n, 100n, async () => { throw new Error("query returned more than 10000 results"); }),
    /more than 10000 results/,
  );
  // A rate limit or quota is a reason to wait, never to pass a block.
  for (const limited of ["daily request count exceeded, request rate limited", "rate limit exceeded", "Your app has exceeded its compute units per second capacity."]) {
    const held = freshWallet({ sync: { status: "pending", cursor: "40" } });
    const r = await syncWallet(held, fakeReader({ head: 100n, logs: [], logsError: new Error(limited) }), { value: fixedValue, lists: listedAll, now: () => NOW });
    assert.equal(r.skipped, 0, limited);
    assert.equal(store.findImportedWallet(held.id)!.sync.cursor, "40", limited);
    assert.equal(store.findImportedWallet(held.id)!.sync.status, "error", limited);
  }
});

await check("token lists that never loaded hold the window: nothing is called unlisted by accident", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 100n, logs: [transfer({ blockNumber: 10n, txHash: H(63), logIndex: 0 })] });
  await syncWallet(w, reader, { value: fixedValue, lists: async () => ({ ok: false as const, reason: "1 of 7 token lists never loaded" }), now: () => NOW });
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.status, "error");
  assert.match(after.sync.error ?? "", /token lists/);
  assert.equal(after.sync.cursor, "0");
  assert.equal(store.ledgerOf(w.orgId).filter((e) => e.txHash === H(63)).length, 0);
});

await check("a price feed outage holds the window: nothing booked, the cursor stays, the wallet says why", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, txHash: H(50) })] });
  const r = await syncWallet(w, reader, { value: async () => ({ ok: false as const, reason: "the price feed answered 503", transient: true }), lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.cursor, "0");
  assert.equal(after.sync.status, "error");
  assert.match(after.sync.error ?? "", /price/);
  assert.equal(store.ledgerOf("org_1").some((e) => e.txHash === H(50)), false);
});

await check("an RPC failure reading a token holds the window rather than skipping the transfer", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, txHash: H(51) })], tokenError: new Error("HTTP request failed.") });
  await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  const after = store.findImportedWallet(w.id)!;
  assert.equal(after.sync.cursor, "0");
  assert.equal(after.sync.skipped, undefined);
  assert.equal(after.sync.status, "error");
});

await check("an RPC error never puts the RPC URL (and its API key) on the wallet", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const err = Object.assign(new Error("HTTP request failed.\n\nStatus: 429\nURL: https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123\nRequest body: {}"), { shortMessage: "HTTP request failed." });
  await syncWallet(w, fakeReader({ head: 1000n, logs: [], logsError: err }), { value: fixedValue, lists: listedAll, now: () => NOW });
  const msg = store.findImportedWallet(w.id)!.sync.error ?? "";
  assert.ok(msg.length > 0);
  assert.doesNotMatch(msg, /SECRETKEY123|alchemy|https?:/);
  const plain = new Error("call to https://rpc.example/v1/KEY987 failed");
  await syncWallet(w, fakeReader({ head: 1000n, logs: [], logsError: plain }), { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.doesNotMatch(store.findImportedWallet(w.id)!.sync.error ?? "", /KEY987|https?:/);
});

await check("a token whose decimals() returns bytes that do not decode is a fact about the token (skipped), not an outage (held)", async () => {
  const { AbiDecodingDataSizeTooSmallError, HttpRequestError, TimeoutError } = await import("viem");
  const { contractHasNo } = await import("../services/api/src/wallet-sync/sync.js");
  assert.equal(contractHasNo(new AbiDecodingDataSizeTooSmallError({ data: "0x01", params: [], size: 1 })), true);
  assert.equal(contractHasNo(new HttpRequestError({ url: "http://rpc.test", status: 429 })), false);
  assert.equal(contractHasNo(new TimeoutError({ body: {}, url: "http://rpc.test" })), false);
});

await check("a Node transport error (which names the host) is summarised on the wallet, not shown", async () => {
  const { publicSyncError } = await import("../services/api/src/wallet-sync/sync.js");
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND SECRETKEY.g.alchemy.com"), { code: "ENOTFOUND" });
  assert.doesNotMatch(publicSyncError(dns), /SECRETKEY|alchemy/);
  const conn = new Error("connect ECONNREFUSED 10.0.0.7:8545");
  assert.doesNotMatch(publicSyncError(conn), /10\.0\.0\.7/);
});

await check("a window the RPC refuses as too large is halved until it answers", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 30n, txHash: H(60) })], maxSpan: 25n });
  const r = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 1);
  const after = store.findImportedWallet(w.id)!;
  assert.notEqual(after.sync.status, "error", after.sync.error);
  assert.ok(BigInt(after.sync.cursor!) >= 30n);
});

await check("Base's public RPC wording (\"limited to a 1,000 range\") is a range refusal, so the window halves", async () => {
  const { readLogWindow, isLogRangeRefusal } = await import("../services/api/src/log-range.js");
  const refusal = new Error("eth_getLogs is limited to a 1,000 range");
  assert.equal(isLogRangeRefusal(refusal), true);
  assert.equal(isLogRangeRefusal(new Error("execution reverted")), false);
  const asked: bigint[] = [];
  const r = await readLogWindow(1n, 10_000n, 5_000n, async (from, to) => {
    asked.push(to - from + 1n);
    if (to - from + 1n > 1_000n) throw refusal;
    return "ok";
  });
  assert.equal(r.result, "ok");
  assert.deepEqual(asked, [5_000n, 2_500n, 1_250n, 625n]);
  assert.equal(r.toBlock, 625n);
  await assert.rejects(readLogWindow(1n, 10n, 10n, async () => { throw new Error("execution reverted"); }), /execution reverted/);
});

await check("a wallet removed while it syncs books nothing and does not stop the run", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, txHash: H(70) })], onLogs: () => { store.removeImportedWallet(w.id); } });
  const r = await syncWallet(w, reader, { value: fixedValue, lists: listedAll, now: () => NOW });
  assert.equal(r.added, 0);
  assert.equal(store.ledgerOf("org_1").some((e) => e.txHash === H(70)), false);
});

await check("an already-booked log is not priced again on a re-scan", async () => {
  const w = freshWallet({ sync: { status: "pending", cursor: "0" } });
  const reader = fakeReader({ head: 1000n, logs: [transfer({ blockNumber: 5n, txHash: H(80) })] });
  let priced = 0;
  const counting = async (q: any) => { priced++; return fixedValue(q); };
  await syncWallet(w, reader, { value: counting, lists: listedAll, now: () => NOW });
  store.updateImportedWallet(w.id, { sync: { ...store.findImportedWallet(w.id)!.sync, cursor: "0" } });
  await syncWallet(w, reader, { value: counting, lists: listedAll, now: () => NOW });
  assert.equal(priced, 1);
});

await check("the start date resolves to the first block at or after midnight UTC", async () => {
  const reader = fakeReader({ head: 10_000n, logs: [] });
  // Block n is at 2026-09-01 + 12s*n, so 2026-09-02 00:00 is block 7200.
  const n = await firstBlockAtOrAfter(reader, "2026-09-02T00:00:00.000Z", 10_000n);
  assert.equal(n, 7200n);
  const before = await firstBlockAtOrAfter(reader, "2026-08-01T00:00:00.000Z", 10_000n);
  assert.equal(before, 0n);
});

console.log("\nImport route");

{
  const express = (await import("express")).default;
  const { initStore } = await import("../services/api/src/store.js");
  const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
  initStore();
  const at = new Date().toISOString();
  const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
  store.addUser({ id: "u_owner", name: "Owner", country: "DE", kycStatus: "approved", address: SAFE, createdAt: at } as any);
  store.addOrganisation({ id: "org_paid", type: "business", name: "Zoldenburg UG", plan: "business", reporting, verifications: {}, createdAt: at, updatedAt: at } as any);
  store.addOrganisation({ id: "org_free", type: "business", name: "Starter GmbH", plan: "starter", reporting, verifications: {}, createdAt: at, updatedAt: at } as any);
  for (const o of ["org_paid", "org_free"]) {
    store.addMember({ id: `m_${o}`, orgId: o, userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: at, acceptedAt: at });
  }
  const app = express();
  app.use(express.json());
  app.use("/api/orgs", createOrgRouter((req: any, res: any) => {
    const id = req.header("x-user");
    if (id) return { userId: id };
    res.status(401).json({ error: "no session" });
    return undefined;
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const API = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (orgId: string, body: unknown) => {
    const res = await fetch(`${API}/api/orgs/${orgId}/wallets`, { method: "POST", headers: { "content-type": "application/json", "x-user": "u_owner" }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  };
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  await check("a wallet imported with a start day carries it, and the note says from when it is booked", async () => {
    const r = await post("org_paid", { address: addr(1), chainId: 1, kind: "safe", label: "Delegation Safe", syncFrom: "2026-01-01" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.wallet.sync.from, "2026-01-01");
    assert.match(r.data.note, /2026-01-01/);
  });

  await check("without a start day the wallet is booked from now on", async () => {
    const r = await post("org_paid", { address: addr(2), chainId: 1, kind: "safe" });
    assert.equal(r.status, 201);
    assert.equal(r.data.wallet.sync.from, undefined);
  });

  await check("a start day that is not a date, or in the future, is refused", async () => {
    assert.equal((await post("org_paid", { address: addr(3), chainId: 1, syncFrom: "01.01.2026" })).status, 400);
    assert.equal((await post("org_paid", { address: addr(3), chainId: 1, syncFrom: "2999-01-01" })).status, 400);
    assert.equal((await post("org_paid", { address: addr(3), chainId: 1, syncFrom: "2010-01-01" })).status, 400, "before any chain existed");
  });

  await check("backfill is the historical-sync capability: a plan without it is refused, and nothing is imported", async () => {
    const r = await post("org_free", { address: addr(4), chainId: 1, syncFrom: "2026-01-01" });
    assert.equal(r.status, 402, JSON.stringify(r.data));
    assert.equal(r.data.capability, "ledger.historicalSync");
    assert.equal(store.importedWalletsOf("org_free").length, 0);
    assert.equal((await post("org_free", { address: addr(4), chainId: 1 })).status, 201, "importing from now on stays open");
  });

  await check("the org's own Zold account cannot be imported: it would be booked twice", async () => {
    store.addAccount({ id: "acc_paid", orgId: "org_paid", currency: "EUR", label: "Operating EUR", status: "open", provider: "monerium", identifier: {}, address: addr(9), createdAt: at, updatedAt: at } as any);
    const r = await post("org_paid", { address: addr(9), chainId: 31337, kind: "safe" });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal((await post("org_paid", { address: addr(9), chainId: 1, kind: "safe" })).status, 201, "the same address on another chain is a different wallet");
  });

  server.close();
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
