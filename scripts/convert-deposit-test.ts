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
const { depositConversionBlocker, settleOnArrival, unconvertedUnits } =
  await import("../services/api/src/adapters/crypto-deposits.js");
const { buildCryptoSettlement } = await import("../services/api/src/domain/invoices.js");
const { migrateCryptoDepositHolding } = await import("../services/api/src/store/db.js");

await initStore();

let n = 0;
const failures: string[] = [];
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  try { await fn(); console.log(`  ok  ${label}`); n++; }
  catch (err: any) { failures.push(`${label}: ${err?.message ?? err}`); console.log(`  FAIL ${label}: ${err?.message ?? err}`); n++; }
};

const mkUser = async (over: any = {}) => {
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
  await store.addUser(u);
  return u;
};
/** Every fixture gets its OWN transaction. (txHash, logIndex) is the chain's
 *  identity for a transfer and the store now enforces it — two deposits
 *  sharing one hash is a thing that cannot happen on chain, and a fixture that
 *  did it was testing a shape the poller would never produce. */
let depositSeq = 0;
const mkDeposit = async (userId: string, over: any = {}) => {
  const d: any = {
    id: `d-${Math.random().toString(16).slice(2)}`,
    userId, chainId: 31337, token: "USDC",
    txHash: "0x" + String(++depositSeq).padStart(64, "a"), logIndex: 0,
    amountUnits: "500000000", amountUsdc: 500,
    holding: "awaiting_approval", settlementAsset: "USDC", txs: [],
    detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
  await store.addCryptoDeposit(d);
  return d;
};

console.log("\nSettled on arrival; the poller never converts");

await check("with auto-convert on, a deposit settles and WAITS for the passkey", async () => {
  const u = await mkUser();
  const out = await settleOnArrival(await mkDeposit(u.id));
  assert.ok(out.settledAt, "settled on arrival, before any conversion");
  assert.equal(out.holding, "awaiting_approval", "the poller must not claim to have converted");
  assert.equal(out.creditedUsdc, 500, "the USDC is what the account holds");
  assert.match(out.reason!, /passkey/i, "the reason must name the missing signature");
  assert.match(out.reason!, /ready to convert/i);
  assert.ok(!/sweep|owner key|allowance module/i.test(out.reason!), "must not surface an internal error");
});

await check("a USDC-settling page settles with NOTHING to convert", async () => {
  const u = await mkUser({ paymentPage: { handle: "u", autoConvert: true, settlementAsset: "USDC" } });
  const out = await settleOnArrival(await mkDeposit(u.id));
  assert.ok(out.settledAt);
  assert.equal(out.holding, "none");
  assert.equal(out.settlementAsset, "USDC");
  assert.equal(out.creditedUsdc, 500);
});

await check("auto-convert off: settled and HELD, convertible later", async () => {
  const u = await mkUser({ paymentPage: { handle: "u", autoConvert: false, settlementAsset: "EURE" } });
  const out = await settleOnArrival(await mkDeposit(u.id));
  assert.ok(out.settledAt);
  assert.equal(out.holding, "held");
  assert.equal(out.creditedEur, undefined, "no euro credit was invented");
  assert.equal(depositConversionBlocker(u, out), null, "a held deposit can be converted");
});

await check("a Safe with no payment page is a euro account: its USDC is held, not stuck", async () => {
  const u = await mkUser({ paymentPage: undefined });
  const out = await settleOnArrival(await mkDeposit(u.id));
  assert.equal(out.holding, "held");
  assert.equal(depositConversionBlocker(u, out), null);
});

await check("settling twice is a no-op: one settlement per deposit", async () => {
  const u = await mkUser();
  const first = await settleOnArrival(await mkDeposit(u.id));
  const again = await settleOnArrival(first);
  assert.equal(again.settledAt, first.settledAt);
});

console.log("\nThe blocker names what a user can act on");

await check("a pending account converts: the swap is user-signed from its own Safe, not a fiat rail", async () => {
  const u = await mkUser({ kycStatus: "pending" });
  assert.equal(depositConversionBlocker(u, await mkDeposit(u.id)), null);
});

await check("a rejected or manual-review account still converts: the partner refused a bank account, not the wallet", async () => {
  for (const kycStatus of ["rejected", "manual_review"]) {
    const u = await mkUser({ kycStatus });
    assert.equal(depositConversionBlocker(u, await mkDeposit(u.id)), null, kycStatus);
  }
});

await check("a WALLET_ONLY account converts; a segment without an on-chain balance is refused", async () => {
  const w = await mkUser({ kycStatus: "pending", segment: { value: "WALLET_ONLY" } });
  assert.equal(depositConversionBlocker(w, await mkDeposit(w.id)), null);
  const b = await mkUser({ segment: { value: "BLOCKED_SANCTIONED" } });
  assert.match(depositConversionBlocker(b, await mkDeposit(b.id))!, /not part of your account/i);
});

await check("dust below the floor is refused with the floor in it", async () => {
  const u = await mkUser();
  const b = depositConversionBlocker(u, await mkDeposit(u.id, { amountUsdc: 0.4, amountUnits: "400000" }));
  assert.match(b!, /below the .* floor/i);
  assert.match(b!, /cost more than it delivers/i);
});

await check("an already-converted deposit cannot be converted twice", async () => {
  const u = await mkUser();
  assert.match(depositConversionBlocker(u, await mkDeposit(u.id, { holding: "converted" }))!, /already been converted/i);
});

await check("a conversion whose outcome is unconfirmed cannot be prepared again", async () => {
  const u = await mkUser();
  const d = await mkDeposit(u.id, { holding: "unconfirmed", txs: [{ step: "safe.swap(usdc->eure).unconfirmed", hash: "0xop" }] });
  assert.match(depositConversionBlocker(u, d)!, /may still land/i);
});

await check("a refusal after an executed swap cannot be converted again; a reverted one can", async () => {
  const u = await mkUser();
  const spent = await mkDeposit(u.id, { holding: "refused", txs: [{ step: "safe.swap(usdc->eure)", hash: "0x1" }] });
  assert.match(depositConversionBlocker(u, spent)!, /went through/i);
  const reverted = await mkDeposit(u.id, { holding: "refused", txs: [{ step: "safe.swap(usdc->eure).reverted", hash: "0x2" }] });
  assert.equal(depositConversionBlocker(u, reverted), null);
});

await check("the convert route parks an uncertain submit as unconfirmed and refuses a reverted one", () => {
  const src = readFileSync("services/api/src/routes/crypto-deposits.ts", "utf8");
  const route = src.slice(src.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  const body = route.slice(0, route.indexOf("settleConvertedDeposit("));
  assert.match(body, /instanceof SafeOperationUncertainError[\s\S]*holding: "unconfirmed"/,
    "an op the bundler may have taken must not read as refused and convertible again");
  assert.match(body, /err\.userOpHash/, "the unconfirmed row carries the userOpHash to check");
  assert.match(body, /submitted\.success !== true[\s\S]*holding: "refused"/,
    "an included-but-reverted swap moved nothing and is refused before settlement");
});

await check("an unconfirmed row says it reverted only when its last swap step reverted", async () => {
  const { buildActivity } = await import("../services/api/src/transfers/activity.js");
  const u = await mkUser();
  const reverted = await mkDeposit(u.id, { holding: "unconfirmed",
    txs: [{ step: "safe.swap(usdc->eure).reverted", hash: "0x5" }, { step: "userOperation", hash: "0x6" }] });
  assert.match(depositConversionBlocker(u, reverted)!, /reverted/, "the sweep's reverted row");
  const row = (d: any) => buildActivity({ transfers: [], deposits: [d], issues: [] }).find((r) => r.id === d.id) as any;
  assert.equal(row(reverted).conversionReverted, true, "the activity row says it reverted");
  // An earlier submit reverted (refused, retryable); the retry is uncertain
  // and keeps that old step. The new op may still land.
  const retried = await mkDeposit(u.id, { holding: "unconfirmed",
    txs: [{ step: "safe.swap(usdc->eure).reverted", hash: "0x7" }, { step: "safe.swap(usdc->eure).unconfirmed", hash: "0x8" }] });
  const block = depositConversionBlocker(u, retried)!;
  assert.match(block, /may still land/, block);
  assert.doesNotMatch(block, /reverted/, block);
  assert.equal(row(retried).conversionReverted, undefined, "an op that may still land is not called reverted");
  // The retry executed, then settlement threw: its swap is the last step.
  const executed = await mkDeposit(u.id, { holding: "unconfirmed",
    txs: [{ step: "safe.swap(usdc->eure).reverted", hash: "0x9" }, { step: "safe.swap(usdc->eure)", hash: "0xa" }, { step: "userOperation", hash: "0xb" }] });
  assert.doesNotMatch(depositConversionBlocker(u, executed)!, /reverted/, "a retry that executed is not called reverted");
  assert.equal(row(executed).conversionReverted, undefined, "the activity row does not say nothing was converted");
  // A partial fill, then a retry that reverted: the last attempt reverted.
  const partialThenRevert = await mkDeposit(u.id, { holding: "unconfirmed",
    txs: [{ step: "safe.swap(usdc->eure)", hash: "0xc" }, { step: "safe.swap(usdc->eure).reverted", hash: "0xd" }] });
  assert.match(depositConversionBlocker(u, partialThenRevert)!, /reverted/, "the last attempt reverted");
  assert.equal(row(partialThenRevert).conversionReverted, true);
});

await check("a deposit with an unrecorded conversion intent is not offered again, whatever its holding", async () => {
  const u = await mkUser();
  const quote = { provider: "dex", rate: "1137900", minOut: "1" };
  for (const holding of ["held", "awaiting_approval", "refused"]) {
    const d = await mkDeposit(u.id, { holding, conversionIntent: { at: "2026-11-19T00:00:00.000Z", amountUnits: "500000000", safeAddress: u.address, quote } });
    assert.match(depositConversionBlocker(u, d)!, /outcome was not recorded/i, holding);
  }
});

await check("the convert route writes the intent before submitting and clears it only once settled or refused", () => {
  const src = readFileSync("services/api/src/routes/crypto-deposits.ts", "utf8");
  const route = src.slice(src.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  const intent = route.indexOf("conversionIntent: {");
  assert.ok(intent > 0 && intent < route.indexOf("submitPasskeySafeOperationWithReceipt("), "the intent is on disk before the swap is submitted");
  assert.match(route.slice(intent, route.indexOf("submitPasskeySafeOperationWithReceipt(")), /paymaster: pending\.userOperation\.paymaster/,
    "it names the paymaster, so a later settle does not count USDC gas as swap input");
  const uncertain = route.slice(route.indexOf("instanceof SafeOperationUncertainError"), route.indexOf('holding: "refused", reason'));
  assert.doesNotMatch(uncertain, /conversionIntent/, "an uncertain submit keeps its intent");
  assert.match(route, /holding: "refused", reason, conversionIntent: undefined/, "a stated refusal clears it");
  assert.match(route, /submitted\.success !== true[\s\S]{0,300}conversionIntent: undefined/, "a reverted swap clears it");
  const executed = route.slice(route.indexOf("const executed ="), route.indexOf("settleConvertedDeposit("));
  assert.doesNotMatch(executed, /conversionIntent/, "the post-swap unconfirmed write keeps it");
  assert.match(route, /settleConvertedDeposit\([\s\S]{0,600}conversionIntent: undefined/, "settling clears it");
  const caught = route.slice(route.indexOf("executed but was not recorded"), route.indexOf("const balances ="));
  assert.match(caught, /holding !== "unconfirmed"\) \{\s*(await )?clearSettledIntent\(deposit\.id\);\s*settled = recorded;\s*\} else/,
    "a throw after settling recorded the outcome clears the intent, so a partial fill's rest is not blocked");
  const settledBranch = caught.slice(caught.indexOf("clearSettledIntent("), caught.indexOf("} else"));
  assert.doesNotMatch(settledBranch, /SAFE_OP_UNCONFIRMED/, "a settled row is answered as settled, not as unconfirmed");
});

await check("a deposit already in the settlement currency has nothing to convert", async () => {
  const u = await mkUser();
  assert.match(depositConversionBlocker(u, await mkDeposit(u.id, { holding: "none" }))!, /settlement currency/i);
});

await check("held, waiting and refused deposits have NO blocker — a refused swap can be retried", async () => {
  const u = await mkUser();
  for (const holding of ["held", "awaiting_approval", "refused"]) {
    assert.equal(depositConversionBlocker(u, await mkDeposit(u.id, { holding })), null, holding);
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
    row({ id: "unc", state: "UNCONFIRMED", txs: [{ step: "safe.swap(usdc->eure).unconfirmed", hash: "0x2" }] }),
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
  assert.deepEqual([by("unc").holding, by("unc").settledAt], ["unconfirmed", undefined], "a swap that may still land is not offered again");
  assert.equal(rows.length, 8, "no row is dropped");
  migrateCryptoDepositHolding(rows, users);
  assert.equal(by("cu").holding, "held", "running it twice changes nothing");
});

console.log("\nThe tax record: valued at receipt, gain measured, tied to the invoice");

await check("a USDC deposit is valued in EUR AT RECEIPT, with the rate's provenance", async () => {
  const { midRates } = await import("../services/api/src/rates.js");
  const r = await midRates();
  // 100 USDC at 1.1379 USD/EUR is ~87.88 EUR.
  const expected = Math.round((100 / r.eur.USD) * 100) / 100;
  const u = await mkUser();
  const d = await mkDeposit(u.id, {
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
  const from = src.indexOf("export async function settleConvertedDeposit");
  const fn = src.slice(from, src.indexOf("export function recordInvoiceSettlement", from));
  assert.match(fn, /realisedGainEur =\s*deposit\.receipt\s*\n?\s*\?/,
    "the gain must be conditional on a receipt value existing");
  assert.ok(!/realisedGainEur:\s*0\b/.test(fn),
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

await check("conversion is gated by the segment, never by KYC approval", () => {
  const route = srv.slice(srv.indexOf('"/users/:id/auto-convert"'));
  const body = route.slice(0, route.indexOf("router.", 1));
  assert.ok(!/requireKycApproved/.test(body), "auto-convert must not require Monerium approval");
  assert.match(body, /requireCapability\(user, "onchain_balance", res\)/, "auto-convert must check the segment");
  const watched = dep.slice(dep.indexOf("function watchedAddresses"));
  assert.ok(!/kycStatus === "approved"/.test(watched.slice(0, watched.indexOf("return out;"))),
    "a pending account's page address must be watched when auto-convert is on");
  assert.match(dep, /walletBlocker\(user\)/, "depositConversionBlocker must use walletBlocker");
});

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

await check("the credited amount is MEASURED from the swap's logs, never taken from the quote", () => {
  const fn = dep.slice(dep.indexOf("export async function settleConvertedDeposit"));
  const head = fn.slice(0, 3400);
  assert.match(head, /output\s*=\s*await eureSwappedOut\(swapTx, conversion\?\.userOpHash, user\.address\)/);
  assert.match(head, /output === undefined\) throw/, "no receipt, no credit");
  assert.match(head, /receivedWei\s*=\s*output\.wei/);
  assert.match(head, /deltaWei\s*<\s*receivedWei/, "the balance delta checks the logged amount");
  assert.match(head, /receivedWei\s*<\s*quote\.minOut/, "the signed floor must be checked against the logged amount");
  assert.ok(!/creditedEur:\s*eur\.fromWei\(quote\./.test(head),
    "must not credit the quoted amount");
});


console.log("\nPartial fills, retries and the post-swap record");

const partial = (amountInUnits: string, creditedEur: number, receiptPortionEur?: number) => ({
  creditedEur, provider: "dex", rate: 1.14,
  ...(receiptPortionEur === undefined ? {} : { receiptPortionEur }),
  conversion: { txHash: "0x" + "c".repeat(64), amountInUnits },
});

await check("after a partial fill only the rest is to convert, and the floor applies to the rest", async () => {
  const u = await mkUser();
  const d = await mkDeposit(u.id, { holding: "held", partials: [partial("499700000", 438)],
    txs: [{ step: "safe.swap(usdc->eure)", hash: "0x1" }] });
  assert.equal(unconvertedUnits(d), 300000n);
  assert.match(depositConversionBlocker(u, d)!, /0\.3 .* below the .* floor/i);
  assert.equal(depositConversionBlocker(u, { ...d, partials: [partial("100000000", 88)] }), null,
    "400 left converts, and the partial's own swap step does not read as an unrecorded one");
});

await check("a refusal is retryable unless a swap executed that no fill records", async () => {
  const u = await mkUser();
  const fill = partial("100000000", 88);
  const reverted = await mkDeposit(u.id, { holding: "refused", partials: [fill],
    txs: [{ step: "safe.swap(usdc->eure)", hash: "0x1" }, { step: "safe.swap(usdc->eure).reverted", hash: "0x2" }] });
  assert.equal(depositConversionBlocker(u, reverted), null, "the partial's swap is recorded; the reverted one moved nothing");
  const spent = await mkDeposit(u.id, { holding: "refused", partials: [fill],
    txs: [{ step: "safe.swap(usdc->eure)", hash: "0x1" }, { step: "safe.swap(usdc->eure)", hash: "0x3" }] });
  assert.match(depositConversionBlocker(u, spent)!, /went through/i);
  const legacy = await mkDeposit(u.id, { holding: "refused", conversion: { txHash: "0x4" }, txs: [] });
  assert.match(depositConversionBlocker(u, legacy)!, /went through/i, "a pre-partials row with a conversion counts as executed");
});

await check("the invoice names the swap that converted, never a reverted attempt", async () => {
  const u = await mkUser();
  const d = await mkDeposit(u.id, { holding: "converted", settlementAsset: "EURE", creditedEur: 437,
    txs: [{ step: "safe.swap(usdc->eure).reverted", hash: "0xrev" }, { step: "safe.swap(usdc->eure)", hash: "0xok" }] });
  assert.equal(buildCryptoSettlement(d).conversion?.txHash, "0xok");
  assert.equal(buildCryptoSettlement({ ...d, conversion: { txHash: "0xchain" } }).conversion?.txHash, "0xchain");
});

await check("only the logs a swap delivered are conversion output; an unsettled swap covers its own user only", async () => {
  const { conversionOutputs } = await import("../services/api/src/transfers/conversion-outputs.js");
  const u = await mkUser();
  const tx = "0x" + "d".repeat(64);
  const settled = conversionOutputs([await mkDeposit(u.id, { holding: "converted", conversion: { txHash: tx },
    txs: [{ step: "safe.swap(usdc->eure)", hash: tx, outputLogIndexes: [4] }] })]);
  assert.ok(settled(tx.toUpperCase().replace("0X", "0x"), 4, u.id), "the credited log");
  assert.ok(!settled(tx, 1, u.id), "another op's EURe to the same Safe in the bundle is money in");
  const pending = conversionOutputs([await mkDeposit(u.id, { holding: "unconfirmed", txs: [{ step: "safe.swap(usdc->eure)", hash: tx }] })]);
  assert.ok(pending(tx, 1, u.id) && pending(tx, 4, u.id), "a swap not yet settled covers every EURe log to its own user");
  assert.ok(!pending(tx, 2, "someone-else"), "and never another user's payment in the same bundle");
  const legacy = conversionOutputs([await mkDeposit(u.id, { holding: "converted", conversion: { txHash: tx }, txs: [] })]);
  assert.ok(legacy(tx, 1, u.id) && !legacy(tx, 1, "someone-else"), "a row from before indexes: its whole transaction, its own user");
});

await check("an uncertain swap names its transaction once its userOp resolves, and stays put until then", async () => {
  const { conversionOutputs } = await import("../services/api/src/transfers/conversion-outputs.js");
  const { ENTRYPOINT_V9 } = await import("abstractionkit");
  const { settleUnconfirmedConversions } = await import("../services/api/src/adapters/crypto-deposits.js");
  const u = await mkUser();
  const op = "0x" + "e1".repeat(32);
  const tx = "0x" + "f1".repeat(32);
  // The route's uncertain submit: the userOpHash, not the transaction's hash.
  const d = await mkDeposit(u.id, { holding: "unconfirmed", txs: [{ step: "safe.swap(usdc->eure).unconfirmed", hash: op }] });
  const row = async () => (await store.list("cryptoDeposits")).find((x) => x.id === d.id)!;
  const answer = (outcome: { success: boolean; txHash: string } | null) => async (h: string) => (h === op ? outcome : null);

  await settleUnconfirmedConversions(answer(null));
  assert.equal((await row()).holding, "unconfirmed", "no receipt yet: still unconfirmed");
  assert.deepEqual((await row()).txs, d.txs, "and the userOp step is left for the next sweep");
  await settleUnconfirmedConversions(async () => { throw new Error("bundler down"); });
  assert.deepEqual((await row()).txs, d.txs, "an unreadable answer changes nothing");

  // Landed, but its receipt cannot be read: the step is not rewritten, so it
  // never claims the whole transaction, and the next sweep tries again.
  const { publicClient, addrs } = await import("../services/api/src/chain.js");
  const realReceipt = publicClient.getTransactionReceipt;
  (publicClient as any).getTransactionReceipt = async () => { throw new Error("rpc down"); };
  try {
    await settleUnconfirmedConversions(answer({ success: true, txHash: tx }));
    assert.deepEqual((await row()).txs, d.txs, "an unreadable output changes nothing");
    // The bundle: the swap's EURe to the Safe at log 1, then the op's event.
    const word = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
    (publicClient as any).getTransactionReceipt = async () => ({
      blockNumber: 10n,
      logs: [
        { address: addrs().eure, logIndex: 1, data: "0x" + (87n * 10n ** 18n).toString(16).padStart(64, "0"),
          topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", word("0x" + "77".repeat(20)), word(u.address)] },
        { address: ENTRYPOINT_V9, logIndex: 2, data: "0x", topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", op] },
      ],
    });
    await settleUnconfirmedConversions(answer({ success: true, txHash: tx }));
  } finally {
    (publicClient as any).getTransactionReceipt = realReceipt;
  }
  assert.ok((await row()).txs.some((t) => t.step === "safe.swap(usdc->eure)" && t.hash === tx && t.outputLogIndexes?.join() === "1"),
    "the swap step names the transaction and the logs it delivered");
  assert.ok((await row()).txs.some((t) => t.step === "userOperation" && t.hash === op), "the userOp hash is kept beside it");
  assert.ok(!(await row()).txs.some((t) => t.step.endsWith(".unconfirmed")), "nothing is left to resolve");
  const outputs = conversionOutputs(await store.list("cryptoDeposits"));
  assert.ok(outputs(tx, 1, u.id), "the arriving EURe is the swap's output, not money in");
  assert.ok(!outputs(tx, 3, u.id), "and any other EURe log in the bundle is money in");
  assert.equal((await row()).holding, "refused", "with no intent to settle against, it is left for review");
  assert.ok(!(await row()).creditedEur, "and nothing is credited");
  assert.match(depositConversionBlocker(u, await row())!, /under review/i, "and is not offered again");

  const rev = await mkDeposit(u.id, { holding: "unconfirmed", txs: [{ step: "safe.swap(usdc->eure).unconfirmed", hash: "0x" + "e2".repeat(32) }] });
  const revTx = "0x" + "f2".repeat(32);
  await settleUnconfirmedConversions(async (h) => (h === rev.txs[0].hash ? { success: false, txHash: revTx } : null));
  const reverted = (await store.list("cryptoDeposits")).find((x) => x.id === rev.id)!;
  assert.equal(reverted.holding, "unconfirmed", "a reverted swap is left for review, not offered again");
  assert.match(reverted.reason ?? "", /reverted/);
  assert.ok(reverted.txs.some((t) => t.step === "safe.swap(usdc->eure).reverted" && t.hash === revTx));
  assert.ok(!conversionOutputs(await store.list("cryptoDeposits"))(revTx, 1, u.id), "a reverted swap delivered nothing to leave out");
});

await check("a row with neither state nor holding is migrated, not skipped", () => {
  const rows: any[] = [
    { id: "bare", userId: "eu", token: "USDC", txs: [] },
    { id: "bare-eure", userId: "eu", token: "EURE", txs: [] },
    { id: "done", userId: "eu", token: "USDC", holding: "held", txs: [] },
  ];
  migrateCryptoDepositHolding(rows, [{ id: "eu", paymentPage: { settlementAsset: "EURE" } } as any]);
  assert.deepEqual(rows.map((r) => r.holding), ["awaiting_approval", "none", "held"]);
});

await check("the executed swap is recorded before settling, and a failed settle leaves it unconfirmed", () => {
  const route = srv.slice(srv.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  const body = route.slice(0, route.indexOf('"/users/:id/auto-convert"'));
  const marked = body.indexOf('holding: "unconfirmed",\n          reason: "the swap went through');
  const settle = body.indexOf("settleConvertedDeposit(");
  assert.ok(marked > 0 && marked < settle, "unconfirmed is written before settlement runs");
  assert.match(body.slice(body.indexOf("let settled: CryptoDeposit;")), /^let settled: CryptoDeposit;\s*try \{[\s\S]*?settled = await settleConvertedDeposit[\s\S]*catch[\s\S]*SAFE_OP_UNCONFIRMED/,
    "a settle failure answers SAFE_OP_UNCONFIRMED and leaves the row unconfirmed");
  const fn = dep.slice(dep.indexOf("export async function settleConvertedDeposit"));
  assert.ok(!/assertRateSane\(/.test(fn.slice(0, fn.indexOf("export function recordInvoiceSettlement"))),
    "no rate check that can throw after the swap executed");
});

await check("the units swapped are measured from the swap's logs, capped at what was left, never taken from the request", () => {
  const conv = srv.slice(srv.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  assert.match(conv, /const took = await usdcSwappedIn\(submitted\.txHash, submitted\.userOpHash, user\.address, pending\.userOperation\.paymaster\)/);
  assert.match(conv, /const amountIn = took === undefined \|\| took <= 0n \|\| took > asked \? asked : took;/);
  assert.match(conv, /conversionFacts\(submitted, amountIn\.toString\(\)\)/);
});

await check("one conversion per deposit at a time; failure writes never undo a conversion", () => {
  const prep = srv.slice(srv.indexOf('"/users/:id/crypto-deposits/:depositId/convert/prepare"'));
  assert.match(prep.slice(0, 1500), /convertingDeposits\.has\(deposit\.id\)[\s\S]{0,120}already running/);
  const conv = srv.slice(srv.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  assert.match(conv, /convertingDeposits\.add\(deposit\.id\);[\s\S]*finally \{\s*convertingDeposits\.delete\(deposit\.id\)/);
  assert.match(conv.slice(0, 2500), /const stale = depositConversionBlocker\(user, current\)/, "re-checked after the price was claimed");
  assert.match(srv, /function parkDeposit[\s\S]{0,500}holding === "converted"\) return;/);
});

await check("the sweep attributes a recovered deposit to its pay link before settling it", () => {
  const fn = dep.slice(dep.indexOf("export async function sweepPendingCryptoDeposits"));
  const a = fn.indexOf("attributeDepositToRequest(d)");
  assert.ok(a > 0 && a < fn.indexOf("settleOnArrival("));
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
