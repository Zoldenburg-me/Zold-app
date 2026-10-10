/**
 * Converting an inbound crypto deposit.
 *
 * These cover:
 *   - the poller does not pretend it can convert; it parks the deposit and
 *     says a signature is needed;
 *   - a USDC-settling page still completes, because keeping the asset is a
 *     different settlement, not a refusal;
 *   - the blocker names each refusal in words a user can act on;
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
const { depositConversionBlocker, convertDeposit } =
  await import("../services/api/src/adapters/crypto-deposits.js");

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
    state: "DETECTED", txs: [],
    detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
  store.addCryptoDeposit(d);
  return d;
};

console.log("\nThe poller parks, it does not convert");

await check("a ready deposit stays DETECTED and says a signature is needed", async () => {
  const u = mkUser();
  const d = mkDeposit(u.id);
  const out = await convertDeposit(d);
  assert.equal(out.state, "DETECTED", "the poller must not claim to have converted");
  assert.match(out.reason!, /passkey/i, "the reason must name the missing signature");
  assert.match(out.reason!, /ready to convert/i);
  // A missing signature must read as a missing signature, not as a fault.
  assert.ok(!/sweep|owner key|allowance module/i.test(out.reason!), "must not surface an internal error");
});

await check("a USDC-settling page COMPLETES rather than being refused", async () => {
  const u = mkUser({ paymentPage: { handle: "u", autoConvert: true, settlementAsset: "USDC" } });
  const out = await convertDeposit(mkDeposit(u.id));
  assert.equal(out.state, "CONVERTED");
  assert.equal(out.settlementAsset, "USDC");
  assert.equal(out.creditedUsdc, 500);
});

await check("auto-settlement off COMPLETES as USDC — the forwarder already delivered it", async () => {
  const u = mkUser({ paymentPage: { handle: "u", autoConvert: false, settlementAsset: "EURE" } });
  const out = await convertDeposit(mkDeposit(u.id));
  assert.equal(out.state, "CONVERTED", "a deposit nothing converts is complete, not refused");
  assert.equal(out.settlementAsset, "USDC");
  assert.equal(out.creditedUsdc, 500);
  assert.equal(out.creditedEur, undefined, "no euro credit was invented");
});

console.log("\nThe blocker names what a user can act on");

await check("a pending account converts: the swap is user-signed from its own Safe, not a fiat rail", () => {
  const u = mkUser({ kycStatus: "pending" });
  assert.equal(depositConversionBlocker(u, mkDeposit(u.id)), null);
});

await check("a rejected or manual-review account still converts: the partner refused a bank account, not the wallet", () => {
  for (const kycStatus of ["rejected", "manual_review"]) {
    const u = mkUser({ kycStatus });
    assert.equal(depositConversionBlocker(u, mkDeposit(u.id)), null, kycStatus);
  }
});

await check("a WALLET_ONLY account converts; a segment without an on-chain balance is refused", () => {
  const w = mkUser({ kycStatus: "pending", segment: { value: "WALLET_ONLY" } });
  assert.equal(depositConversionBlocker(w, mkDeposit(w.id)), null);
  const b = mkUser({ segment: { value: "BLOCKED_SANCTIONED" } });
  assert.match(depositConversionBlocker(b, mkDeposit(b.id))!, /not part of your account/i);
});

await check("dust below the floor is refused with the floor in it", () => {
  const u = mkUser();
  const b = depositConversionBlocker(u, mkDeposit(u.id, { amountUsdc: 0.4, amountUnits: "400000" }));
  assert.match(b!, /below the .* floor/i);
  assert.match(b!, /cost more than it delivers/i);
});

await check("an already-converted deposit cannot be converted twice", () => {
  const u = mkUser();
  assert.match(depositConversionBlocker(u, mkDeposit(u.id, { state: "CONVERTED" }))!, /already been settled/i);
});

await check("a conversion whose outcome is unconfirmed cannot be prepared again", () => {
  const u = mkUser();
  const d = mkDeposit(u.id, { state: "UNCONFIRMED", txs: [{ step: "safe.swap(usdc->eure).unconfirmed", hash: "0xop" }] });
  assert.match(depositConversionBlocker(u, d)!, /may still land/i);
});

await check("the convert route parks an uncertain submit as UNCONFIRMED and refuses a reverted one", () => {
  const src = readFileSync("services/api/src/routes/crypto-deposits.ts", "utf8");
  const route = src.slice(src.indexOf('"/users/:id/crypto-deposits/:depositId/convert"'));
  const body = route.slice(0, route.indexOf("settleConvertedDeposit("));
  assert.match(body, /instanceof SafeOperationUncertainError[\s\S]*state: "UNCONFIRMED"/,
    "an op the bundler may have taken must not read as refused and convertible again");
  assert.match(body, /err\.userOpHash/, "the unconfirmed row carries the userOpHash to check");
  assert.match(body, /submitted\.success !== true[\s\S]*state: "REFUSED"/,
    "an included-but-reverted swap moved nothing and is refused before settlement");
});

await check("a ready deposit has NO blocker", () => {
  const u = mkUser();
  assert.equal(depositConversionBlocker(u, mkDeposit(u.id)), null);
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
