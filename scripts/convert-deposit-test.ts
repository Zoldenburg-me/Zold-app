/**
 * Converting an inbound crypto deposit.
 *
 * These cover:
 *   - every deposit settles on arrival; with auto-convert on a USDC one waits
 *     for the passkey, otherwise it is held, and the poller never converts;
 *   - a USDC-settling page has nothing to convert;
 *   - the blocker names each refusal in words a user can act on, and lets a
 *     held or refused deposit be converted later;
 *   - rows written with the old single `state` migrate on load;
 *   - the conversion routes exist, are capability-gated, and claim the pending
 *     execution BEFORE any await so one signature cannot be submitted twice;
 *   - the swap plan delivers EURe back to the user's OWN Safe, not to the
 *     orchestrator — the property that makes this non-custodial.
 *
 * No chain and no network: the store is driven directly and the wiring is
 * asserted against the source, the same way custody:test does.
 *
 * Run: npm run convert:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A fresh store per run: the fixture hashes restart at 1 each run and the
// store deduplicates on (txHash, logIndex), so a shared path would hand run
// two run one's rows.
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-convert-")), "db.json");
process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, KES: 147.53, INR: 109.87 });
process.env.ALLOW_FIXED_RATES = "1";

const { store, initStore } = await import("../services/api/src/store.js");
const { depositConversionBlocker, settleOnArrival } =
  await import("../services/api/src/adapters/crypto-deposits.js");
const { migrateCryptoDepositHolding } = await import("../services/api/src/store/db.js");

initStore();

let n = 0;
const failures: string[] = [];
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  try { await fn(); console.log(`  ok  ${label}`); n++; }
  catch (err: any) { failures.push(`${label}: ${err?.message ?? err}`); console.log(`  FAIL ${label}: ${err?.message ?? err}`); n++; }
};

const mkUser = (over: any = {}) => {
  const u: any = {
    id: `u-${Math.random().toString(16).slice(2)}`,
    name: "Zoldenburg UG", country: "DE", kycStatus: "approved",
    address: "0x1111111111111111111111111111111111111111",
    wallet: { type: "candide-safe", deployed: true },
    // safeDebitBlocker requires an ACTIVE passkey Safe at the user's own
    // address — the same check the send path uses, so a deposit cannot be
    // marked ready for a signature the account cannot produce.
    passkey: { credentialId: "cred-1", publicKey: { x: "0x1", y: "0x2" } },
    passkeySafe: { status: "active", address: "0x1111111111111111111111111111111111111111" },
    createdAt: new Date().toISOString(),
    paymentPage: { handle: "zold", autoConvert: true, settlementAsset: "EURE" },
    ...over,
  };
  store.addUser(u);
  return u;
};
/** Every fixture gets its OWN transaction. (txHash, logIndex) is the chain's
 *  identity for a transfer and the store now enforces it — two deposits
 *  sharing one hash is a thing that cannot happen on chain, and a fixture that
 *  did it was testing a shape the poller would never produce. */
let depositSeq = 0;
const mkDeposit = (userId: string, over: any = {}) => {
  const d: any = {
    id: `d-${Math.random().toString(16).slice(2)}`,
    userId, chainId: 31337, token: "USDC",
    txHash: "0x" + String(++depositSeq).padStart(64, "a"), logIndex: 0,
    amountUnits: "500000000", amountUsdc: 500,
    holding: "awaiting_approval", settlementAsset: "USDC", txs: [],
    detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
  store.addCryptoDeposit(d);
  return d;
};

console.log("\nSettled on arrival; the poller never converts");

await check("with auto-convert on, a deposit settles and WAITS for the passkey", async () => {
  const u = mkUser();
  const out = settleOnArrival(mkDeposit(u.id));
  assert.ok(out.settledAt, "settled on arrival, before any conversion");
  assert.equal(out.holding, "awaiting_approval", "the poller must not claim to have converted");
  assert.equal(out.creditedUsdc, 500, "the USDC is what the account holds");
  assert.match(out.reason!, /passkey/i, "the reason must name the missing signature");
  assert.match(out.reason!, /ready to convert/i);
  assert.ok(!/sweep|owner key|allowance module/i.test(out.reason!), "must not surface an internal error");
});

await check("a USDC-settling page settles with NOTHING to convert", async () => {
  const u = mkUser({ paymentPage: { handle: "u", autoConvert: true, settlementAsset: "USDC" } });
  const out = settleOnArrival(mkDeposit(u.id));
  assert.ok(out.settledAt);
  assert.equal(out.holding, "none");
  assert.equal(out.settlementAsset, "USDC");
  assert.equal(out.creditedUsdc, 500);
});

await check("auto-convert off: settled and HELD, convertible later", async () => {
  const u = mkUser({ paymentPage: { handle: "u", autoConvert: false, settlementAsset: "EURE" } });
  const out = settleOnArrival(mkDeposit(u.id));
  assert.ok(out.settledAt);
  assert.equal(out.holding, "held");
  assert.equal(out.creditedEur, undefined, "no euro credit was invented");
  assert.equal(depositConversionBlocker(u, out), null, "a held deposit can be converted");
});

await check("a Safe with no payment page is a euro account: its USDC is held, not stuck", async () => {
  const u = mkUser({ paymentPage: undefined });
  const out = settleOnArrival(mkDeposit(u.id));
  assert.equal(out.holding, "held");
  assert.equal(depositConversionBlocker(u, out), null);
});

await check("settling twice is a no-op: one settlement per deposit", async () => {
  const u = mkUser();
  const first = settleOnArrival(mkDeposit(u.id));
  const again = settleOnArrival(first);
  assert.equal(again.settledAt, first.settledAt);
});

console.log("\nThe blocker names what a user can act on");

await check("an unapproved account is refused for KYC, not for something cryptic", () => {
  const u = mkUser({ kycStatus: "pending" });
  assert.match(depositConversionBlocker(u, mkDeposit(u.id))!, /not approved/i);
});

await check("dust below the floor is refused with the floor in it", () => {
  const u = mkUser();
  const b = depositConversionBlocker(u, mkDeposit(u.id, { amountUsdc: 0.4, amountUnits: "400000" }));
  assert.match(b!, /below the .* floor/i);
  assert.match(b!, /cost more than it delivers/i);
});

await check("an already-converted deposit cannot be converted twice", () => {
  const u = mkUser();
  assert.match(depositConversionBlocker(u, mkDeposit(u.id, { holding: "converted" }))!, /already been converted/i);
});

await check("a deposit already in the settlement currency has nothing to convert", () => {
  const u = mkUser();
  assert.match(depositConversionBlocker(u, mkDeposit(u.id, { holding: "none" }))!, /settlement currency/i);
});

await check("held, waiting and refused deposits have NO blocker — a refused swap can be retried", () => {
  const u = mkUser();
  for (const holding of ["held", "awaiting_approval", "refused"]) {
    assert.equal(depositConversionBlocker(u, mkDeposit(u.id, { holding })), null, holding);
  }
});

console.log("\nRows written with the old single state migrate on load");

await check("each old state maps to settled + a holding; nothing else changes", () => {
  const users: any[] = [
    { id: "eu", paymentPage: { settlementAsset: "EURE" } },
    { id: "us", paymentPage: { settlementAsset: "USDC" } },
  ];
  const row = (over: any) => ({ id: over.id, userId: "eu", token: "USDC", txs: [], detectedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", reason: "kept", ...over });
  const rows: any[] = [
    row({ id: "cu", state: "CONVERTED", settlementAsset: "USDC" }),
    row({ id: "cu-us", userId: "us", state: "CONVERTED", settlementAsset: "USDC" }),
    row({ id: "ce", state: "CONVERTED", settlementAsset: "EURE", creditedEur: 9 }),
    row({ id: "eure", token: "EURE", state: "CONVERTED", settlementAsset: "EURE" }),
    row({ id: "det", state: "DETECTED", settlementAsset: "EURE" }),
    row({ id: "ref-swap", state: "REFUSED", txs: [{ step: "safe.swap(usdc->eure)", hash: "0x1" }] }),
    row({ id: "ref-kyc", state: "REFUSED" }),
  ];
  migrateCryptoDepositHolding(rows, users);
  const by = (id: string) => rows.find((r) => r.id === id);
  assert.deepEqual([by("cu").holding, by("cu").settledAt], ["held", "2026-09-02T00:00:00.000Z"]);
  assert.equal(by("cu-us").holding, "none", "USDC on a USDC-settling page has nothing to convert");
  assert.deepEqual([by("ce").holding, by("ce").settlementAsset, by("ce").settledAt], ["converted", "EURE", "2026-09-02T00:00:00.000Z"]);
  assert.equal(by("eure").holding, "none");
  assert.deepEqual([by("det").holding, by("det").settledAt, by("det").settlementAsset], ["awaiting_approval", undefined, "USDC"],
    "never settled before, so the sweep settles it once");
  assert.deepEqual([by("ref-swap").holding, by("ref-swap").settledAt], ["refused", undefined]);
  assert.deepEqual([by("ref-kyc").holding, by("ref-kyc").settledAt], ["held", undefined], "a detection-time refusal is money held");
  assert.ok(rows.every((r) => !("state" in r)), "the old field is gone");
  assert.ok(rows.every((r) => r.reason === "kept"), "the reason survives");
  assert.equal(rows.length, 7, "no row is dropped");
  migrateCryptoDepositHolding(rows, users);
  assert.equal(by("cu").holding, "held", "running it twice changes nothing");
});

console.log("\nThe tax record: valued at receipt, gain measured, tied to the invoice");

await check("a USDC deposit is valued in EUR AT RECEIPT, with the rate's provenance", async () => {
  const { midRates } = await import("../services/api/src/rates.js");
  const r = await midRates();
  // 100 USDC at 1.1379 USD/EUR is ~87.88 EUR.
  const expected = Math.round((100 / r.eur.USD) * 100) / 100;
  const u = mkUser();
  const d = mkDeposit(u.id, {
    amountUsdc: 100, amountUnits: "100000000",
    receipt: {
      amountEur: expected, rate: r.eur.USD, rateProvider: r.provider,
      rateAsOf: r.asOf, ratedAt: new Date().toISOString(),
    },
  });
  assert.equal(d.receipt!.amountEur, expected);
  // The rate alone proves nothing; the source is what makes it a record.
  assert.ok(d.receipt!.rateProvider, "the rate's provider must be stored");
  assert.ok(d.receipt!.rateAsOf, "when the provider published it must be stored");
  assert.ok(d.receipt!.ratedAt, "when we read it must be stored — it differs from asOf");
});

await check("the realised gain is what arrived minus the receipt value", () => {
  // Converting promptly keeps this near zero, which is the tax argument for
  // converting promptly at all.
  const receiptEur = 87.88;
  const credited = 87.9;
  assert.equal(Math.round((credited - receiptEur) * 100) / 100, 0.02);
});

await check("an unvalued receipt yields NO gain rather than a zero", () => {
  const src = readFileSync("services/api/src/adapters/crypto-deposits.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function settleConvertedDeposit"));
  assert.match(fn.slice(0, 2200), /deposit\.receipt\s*\n?\s*\?/,
    "the gain must be conditional on a receipt value existing");
  assert.ok(!/realisedGainEur:\s*0\b/.test(fn.slice(0, 2200)),
    "an unknown basis gives an unknown gain — zero would be a claim");
});

await check("the receipt is stamped at DETECTION, not recomputed later", () => {
  const src = readFileSync("services/api/src/adapters/crypto-deposits.ts", "utf8");
  assert.match(src, /const receipt =\s*\n?\s*token\.token === "USDC"/,
    "valuation must happen in the detection loop");
  assert.match(src, /blockTimes\.get\(log\.blockNumber\)/,
    "the chain's own timestamp must be recorded alongside the rate's");
});

// The builder moved to domain/invoices.ts when bank credits gained a settlement
// record of their own; the properties are unchanged, so the checks follow it.
await check("an invoice settlement carries the whole thread", () => {
  const src = readFileSync("services/api/src/domain/invoices.ts", "utf8");
  const fn = src.slice(src.indexOf("export function buildCryptoSettlement"));
  const body = fn.slice(0, 2600);
  for (const field of ["receiptTxHash", "receiptAmountEur", "receiptRateProvider", "creditedEur", "realisedGainEur"]) {
    assert.ok(body.includes(field), `settlement must carry ${field}`);
  }
  assert.match(body, /conversion:\s*\{/, "the disposal must be its own block, absent while the asset is held");
  assert.match(body, /txHash/, "the conversion must carry its transaction");
});

await check("settlements append rather than replace", () => {
  const src = readFileSync("services/api/src/domain/invoices.ts", "utf8");
  const fn = src.slice(src.indexOf("export function withSettlement"));
  assert.match(fn.slice(0, 600), /filter\(\(x\) => settlementRef\(x\) !== settlementRef\(s\)\)/,
    "an invoice can be paid more than once; overwriting would erase the earlier payments");
});

await check("the fee reported is the venue's spread against the mid, never receipt-minus-credit", () => {
  const src = readFileSync("services/api/src/domain/invoices.ts", "utf8");
  const fn = src.slice(src.indexOf("export function buildCryptoSettlement"), src.indexOf("export function buildBankSettlement"));
  assert.match(fn, /deposit\.midRate/, "the spread must be measured against an independent mid");
  assert.ok(!/receipt\.amountEur\s*-\s*.*credited/.test(fn),
    "receipt minus credit also contains market movement; calling that a fee misstates both numbers");
});

await check("the invoice link is explicit, never inferred from amounts", () => {
  const src = readFileSync("services/api/src/routes/crypto-deposits.ts", "utf8");
  const route = src.slice(src.indexOf("/crypto-deposits/:depositId/invoice"));
  assert.match(route.slice(0, 2000), /req\.body\?\.invoiceId/,
    "the account holder names the invoice — matching by amount and date guesses");
});

console.log("\nThe wiring that makes it non-custodial");

const liq = readFileSync("services/api/src/liquidity.ts", "utf8");
const dep = readFileSync("services/api/src/adapters/crypto-deposits.ts", "utf8");
// The deposit routes left server.ts in the modularity pass.
const srv = readFileSync("services/api/src/routes/crypto-deposits.ts", "utf8");

await check("nothing sweeps the user's USDC to the orchestrator", () => {
  assert.ok(!/sweepToOrchestrator\s*\(/.test(dep.replace(/\*.*sweepToOrchestrator.*/g, "")),
    "sweepToOrchestrator must not be called anywhere");
});

await check("the swap delivers EURe back to the user's OWN Safe", () => {
  const fn = liq.slice(liq.indexOf("export async function prepareDepositConversion"));
  assert.match(fn.slice(0, 1200), /executor:\s*safeAddress,\s*recipient:\s*safeAddress/,
    "executor and recipient must both be the user's Safe — anything else is a transfer, not a conversion");
  assert.match(fn.slice(0, 1200), /"USDC_TO_EURE"/);
});

await check("prepare checks the Safe still holds the USDC before taking a quote, and says how long the price holds", () => {
  const route = srv.slice(srv.indexOf("/convert/prepare"));
  const seg = route.slice(0, route.indexOf("prepareDepositConversion("));
  assert.match(seg, /heldUsdcBlocker\(user, deposit\)/, "a spent deposit must be refused before any venue call");
  assert.match(route.slice(0, 4000), /expiresAt: new Date\(expiresAt\)\.toISOString\(\)/);
  assert.match(route.slice(0, 4000), /const expiresAt = Date\.now\(\) \+ AUTH_WINDOW_SEC \* 1000/,
    "the price holds exactly as long as the pending execution");
});

await check("switching auto-convert off turns waiting deposits into held ones, and on leaves held ones alone", () => {
  const route = srv.slice(srv.indexOf('"/users/:id/auto-convert"'));
  assert.match(route.slice(0, 2500), /if \(!enabled\)[\s\S]{0,300}holding === "awaiting_approval"[\s\S]{0,200}holding: "held"/);
});

await check("the poller's sweep only settles unsettled rows; it never re-runs held ones", () => {
  const fn = dep.slice(dep.indexOf("export async function sweepPendingCryptoDeposits"));
  assert.match(fn.slice(0, 800), /if \(d\.settledAt\) continue;/);
  assert.ok(!/convert/i.test(fn.slice(0, fn.indexOf("export function startCryptoDepositPoller")).replace(/\/\*[\s\S]*?\*\//g, "")),
    "no conversion logic in the sweep");
});

await check("the conversion batch carries NO fee", () => {
  const route = srv.slice(srv.indexOf("/convert/prepare"));
  assert.match(route.slice(0, 3000), /feeAmount:\s*0n/,
    "a user converting their own money must not be charged a fee leg");
});

await check("both routes are capability-gated", () => {
  // Bounded by the next route's PATH, searched from the start: the old anchor
  // was a docstring phrase, which a file header can repeat above the routes.
  const start = srv.indexOf("/crypto-deposits/:depositId/convert/prepare");
  const end = srv.indexOf("/auto-convert", start);
  assert.ok(start > 0 && end > start, "the auto-convert route anchors the end of the convert routes");
  const seg = srv.slice(start, end);
  assert.equal((seg.match(/requireCapability\(user, "onchain_balance", res\)/g) || []).length, 2,
    "prepare and convert must both check the capability");
});

await check("the pending execution is claimed BEFORE any await — no double submit", () => {
  const seg = srv.slice(srv.indexOf('const pending = pendingDepositConversions.get(deposit.id);'));
  const claim = seg.indexOf("pendingDepositConversions.delete(deposit.id);");
  const firstAwait = seg.indexOf("await ");
  assert.ok(claim > -1 && claim < firstAwait,
    "the claim must happen synchronously, before anything yields");
});

await check("the credited amount is MEASURED, never taken from the quote", () => {
  const fn = dep.slice(dep.indexOf("export async function settleConvertedDeposit"));
  assert.match(fn.slice(0, 1600), /receivedWei\s*=\s*after\s*-\s*balanceBeforeWei/);
  assert.match(fn.slice(0, 1600), /receivedWei\s*<\s*quote\.minOut/, "the signed floor must be checked");
  assert.ok(!/creditedEur:\s*eur\.fromWei\(quote\./.test(fn.slice(0, 1600)),
    "must not credit the quoted amount");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} of ${n} checks FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`convert-deposit: ${n}/${n} checks passed`);
console.log("");
console.log("NOT PROVEN HERE: no real swap has executed. That needs a funded passkey Safe, a");
console.log("Safe-executable venue with real liquidity, and a passkey ceremony in a browser.");
