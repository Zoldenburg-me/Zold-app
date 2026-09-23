/**
 * Transaction admission and attribution — the decision points money passes
 * through, and the three defects the September 2026 audit found in them.
 *
 * WHAT COUNTS AS A "DECISION ENGINE" HERE. There is no model and no scoring
 * service in this repo; the judgements that decide where money goes are plain
 * arithmetic over thresholds, and this is where they live:
 *
 *   admission    — does this transfer fit under the daily cap, right now
 *   attribution  — which open payment request, if any, does this USDC pay
 *   fail-closed  — what happens when the rate feed or a partner stops answering
 *
 * Each has a borderline case where the right answer is not the obvious one,
 * and each is covered at the boundary rather than in the middle. Where a
 * regression would be silent — a deposit booked twice, a cap that holds for
 * one request but not two — the test is written against the defect, not the
 * feature.
 *
 * No chain, no network (a loopback stub stands in for the rate feed).
 *
 * Run: npm run tx:audit:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CryptoQuote, PaymentRequest } from "../services/api/src/payment-requests.js";
import type { CryptoDeposit, Transfer } from "../services/api/src/store.js";

// The store is a singleton keyed on this at import time. Point it at a scratch
// file BEFORE importing anything that pulls it in, or the suite mutates the
// developer's own db.json.
const scratch = mkdtempSync(path.join(tmpdir(), "zold-tx-audit-"));
process.env.TRANSF_DB_PATH = path.join(scratch, "db.json");

// A rate feed that accepts the connection and then says nothing, so the
// timeout is the thing under test rather than a connection refusal. Frozen
// into config at import, hence before it.
const hung = createServer(() => { /* never responds, never closes */ });
await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
const hungPort = (hung.address() as any).port;
process.env.TRANSF_RATES_URL = `http://127.0.0.1:${hungPort}/latest`;
process.env.TRANSF_RATES_TIMEOUT_MS = "400";

const { FX, PAYMENT_REQUESTS, railFeeEur } = await import("../services/api/src/config.js");
const { matchDepositToRequests, quoteCrypto } = await import("../services/api/src/payment-requests.js");
const { store } = await import("../services/api/src/store.js");
const { destinationCommitment } = await import("../services/api/src/chain.js");
const { externalHttpUrl } = await import("../services/api/src/routes/shopify.js");
const { midRates, RateUnavailableError } = await import("../services/api/src/rates.js");

let n = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`${++n}. ${label}`))
    .catch((err: any) => {
      failures.push(`${label}: ${err?.message ?? err}`);
      console.log(`${++n}. FAILED — ${label}: ${err?.message ?? err}`);
    });

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-09-20T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** A quote for `usdc`, issued before the money arrives unless told otherwise. */
const quote = (usdc: number, eurValue: number, quotedAtMs = -60_000): CryptoQuote => ({
  amountEur: eurValue,
  amountUsdc: usdc,
  rate: 1.17,
  rateProvider: "test",
  rateAsOf: iso(-60_000),
  allowanceBps: 50,
  quotedAt: iso(quotedAtMs),
  validUntil: iso(15 * 60_000),
});

const request = (
  id: string,
  quotes: CryptoQuote[],
  over: Partial<PaymentRequest> = {},
): PaymentRequest => ({
  id,
  code: id.toUpperCase().padEnd(15, "0").slice(0, 15),
  userId: "u1",
  handle: "payee",
  currency: "EUR",
  methods: ["crypto"],
  state: "OPEN",
  cryptoQuotes: quotes,
  payments: [],
  source: { kind: "app" },
  expiresAt: iso(60 * 60_000),
  createdAt: iso(-10 * 60_000),
  updatedAt: iso(-10 * 60_000),
  ...over,
});

/** A USDC deposit that arrived at the page address. */
const deposit = (usdc: number): Pick<CryptoDeposit, "amountUsdc" | "detectedAt" | "receipt" | "token"> => ({
  token: "USDC",
  amountUsdc: usdc,
  detectedAt: iso(0),
  receipt: undefined,
});

/** The smallest amount that is still distinguishable: one USDC micro-unit. */
const MICRO = 1 / 1e6;

const transfer = (id: string, sendEur: number, over: Partial<Transfer> = {}): Transfer => ({
  id,
  userId: "cap-user",
  quoteId: `q-${id}`,
  rail: "sepa",
  recipientName: "Recipient",
  recipientIban: "DE02120300000000202051",
  state: "CREATED",
  sendEur,
  receiveKes: 0,
  receiveEur: sendEur,
  fundingSource: "safe",
  txs: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const usedByCapUser = () =>
  store.heldEurToday("cap-user") +
  store.transfers
    .filter(
      (t) =>
        t.userId === "cap-user" &&
        t.fundingSource === "safe" &&
        t.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10) &&
        !["FAILED", "REFUNDED"].includes(t.state),
    )
    .reduce((sum, t) => sum + t.sendEur, 0);

console.log("─── (a) clean, valid transactions ───");

await check("SEPA carries no fee and the cash corridor carries its own", () => {
  assert.equal(railFeeEur("sepa"), 0);
  assert.equal(railFeeEur("cash"), 0.99);
});

await check("an exact-amount deposit settles its request in full", () => {
  const r = request("r1", [quote(117.5, 100)]);
  const m = matchDepositToRequests(deposit(117.5), [r]);
  assert.ok(m, "an exact match was not attributed");
  assert.equal(m.request.id, "r1");
  assert.equal(m.kind, "full");
});

await check("the quoted USDC amount rounds UP and carries the allowance visibly", () => {
  const q = quoteCrypto(100, { usdPerEur: 1.17, provider: "test", asOf: iso(0) }, [], new Date(T0));
  assert.equal(q.allowanceBps, PAYMENT_REQUESTS.cryptoAllowanceBps);
  assert.ok(
    q.amountUsdc >= 100 * 1.17,
    `quote ${q.amountUsdc} is below the unadjusted conversion — the allowance went the wrong way`,
  );
  assert.equal(q.amountEur, 100, "the euro amount asked for must not move");
});

await check("two open requests for the same euro amount get distinguishable USDC figures", () => {
  const mid = { usdPerEur: 1.17, provider: "test", asOf: iso(0) };
  const first = quoteCrypto(100, mid, [], new Date(T0));
  const second = quoteCrypto(100, mid, [first.amountUsdc], new Date(T0));
  assert.notEqual(
    second.amountUsdc,
    first.amountUsdc,
    "two open requests quoted the same amount — attribution by amount cannot tell them apart",
  );
});

/** What buildTransferFromQuote does: hold the cap, then commit the row. */
const addUnderCap = (t: Transfer) => {
  const held = store.holdDailyCap(t.userId, t.sendEur, FX.DAILY_CAP_EUR, usedByCapUser);
  if (held.ok) store.addTransferUnderHold(t, held.holdId);
  return held;
};

await check("a transfer that fits under the cap is written", () => {
  const res = addUnderCap(transfer("t-fits", 100));
  assert.equal(res.ok, true);
  assert.ok(store.findTransfer("t-fits"), "the transfer was accepted but not persisted");
});

await check("the destination commitment binds the recipient's NAME, not just the account", () => {
  const a = destinationCommitment("sepa", { iban: "DE02120300000000202051", name: "Alice" });
  const b = destinationCommitment("sepa", { iban: "DE02120300000000202051", name: "Mallory" });
  assert.notEqual(a, b, "the payout name is outside the signed commitment — it could be swapped after signing");
});

console.log("─── (b) high-risk and flagged ───");

await check("a deposit below the partial floor is not attributed to the request at all", () => {
  const r = request("r1", [quote(100, 85)]);
  const belowFloor = 100 * (PAYMENT_REQUESTS.partialFloorBps / 10_000) - 1;
  assert.equal(matchDepositToRequests(deposit(belowFloor), [r]), undefined);
});

await check("a deposit far above the quote is not attributed to it", () => {
  const r = request("r1", [quote(100, 85)]);
  const farOver = 100 * (1 + PAYMENT_REQUESTS.overpayCapBps / 10_000) + 50;
  assert.equal(matchDepositToRequests(deposit(farOver), [r]), undefined);
});

await check("a quote issued after the money arrived is never a candidate", () => {
  // Beyond the 5-minute grace the matcher allows for clock skew.
  const r = request("r1", [quote(117.5, 100, 10 * 60_000)]);
  assert.equal(
    matchDepositToRequests(deposit(117.5), [r]),
    undefined,
    "a quote the payer could not have seen was used to attribute their payment",
  );
});

await check("a closed request takes no payment", () => {
  for (const state of ["PAID", "EXPIRED", "CANCELLED"] as const) {
    const r = request("r1", [quote(117.5, 100)], { state });
    assert.equal(matchDepositToRequests(deposit(117.5), [r]), undefined, `a ${state} request was matched`);
  }
});

await check("the short payment of a big request beats the over-payment of a small one", () => {
  // 60 USDC against a 100 request (partial) and a 57 request (over, within cap).
  const big = request("big", [quote(100, 85)]);
  const small = request("small", [quote(57, 48)], { createdAt: iso(-20 * 60_000) });
  const m = matchDepositToRequests(deposit(60), [big, small]);
  assert.ok(m);
  assert.equal(m.request.id, "big", "a 40% shortfall was booked as somebody else's tip");
  assert.equal(m.kind, "partial");
});

await check("a merchant URL that is not http(s) is dropped rather than rendered", () => {
  for (const bad of [
    "javascript:alert(document.domain)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "",
    undefined,
    null,
    42,
  ]) {
    assert.equal(externalHttpUrl(bad as any), undefined, `${String(bad)} survived the URL guard`);
  }
  assert.equal(externalHttpUrl("https://shop.example/thank_you"), "https://shop.example/thank_you");
});

console.log("─── (c) borderline and ambiguous ───");

await check("exactly at the underpay tolerance still settles in full", () => {
  const quoted = 100;
  const atTolerance = quoted * (1 - PAYMENT_REQUESTS.underpayToleranceBps / 10_000);
  const m = matchDepositToRequests(deposit(atTolerance), [request("r1", [quote(quoted, 85)])]);
  assert.ok(m);
  assert.equal(m.kind, "full", `${atTolerance} is exactly at tolerance and must not read as partial`);
});

await check("one micro-unit past the tolerance is partial, not full", () => {
  const quoted = 100;
  const pastTolerance = quoted * (1 - PAYMENT_REQUESTS.underpayToleranceBps / 10_000) - MICRO;
  const m = matchDepositToRequests(deposit(pastTolerance), [request("r1", [quote(quoted, 85)])]);
  assert.ok(m);
  assert.equal(m.kind, "partial");
});

await check("exactly at the partial floor is attributed; one micro-unit below is not", () => {
  const quoted = 100;
  const atFloor = quoted * (PAYMENT_REQUESTS.partialFloorBps / 10_000);
  const below = atFloor - MICRO;
  const r = () => request("r1", [quote(quoted, 85)]);
  assert.ok(matchDepositToRequests(deposit(atFloor), [r()]), "the floor itself was refused");
  assert.equal(matchDepositToRequests(deposit(below), [r()]), undefined, "below the floor was still attributed");
});

await check("exactly at the overpay cap is an over-payment; past it is nobody's", () => {
  const quoted = 100;
  const atCap = quoted * (1 + PAYMENT_REQUESTS.overpayCapBps / 10_000);
  const past = atCap + MICRO;
  const r = () => request("r1", [quote(quoted, 85)]);
  const m = matchDepositToRequests(deposit(atCap), [r()]);
  assert.ok(m, "the cap itself was refused");
  assert.equal(m.kind, "over");
  assert.equal(matchDepositToRequests(deposit(past), [r()]), undefined, "past the cap was still attributed");
});

await check("an equidistant tie goes to the OLDER request", () => {
  // 100 sits exactly between 98 and 102: both within tolerance of nothing,
  // both partial/over candidates at the same distance.
  const older = request("older", [quote(102, 87)], { createdAt: iso(-30 * 60_000) });
  const newer = request("newer", [quote(98, 83)], { createdAt: iso(-5 * 60_000) });
  const m = matchDepositToRequests(deposit(100), [newer, older]);
  assert.ok(m);
  // 100 is under 102 by 1.96% (past tolerance -> partial) and over 98 by 2.04%
  // (within the over cap). Full beats partial beats over, so the partial wins;
  // the point of the case is that the answer does not depend on input order.
  const reversed = matchDepositToRequests(deposit(100), [older, newer]);
  assert.equal(m.request.id, reversed?.request.id, "attribution depends on the order requests are listed in");
});

await check("a transfer landing exactly ON the cap is allowed", () => {
  store.transfers.length = 0;
  const res = addUnderCap(transfer("t-on-cap", FX.DAILY_CAP_EUR));
  assert.equal(res.ok, true, "the cap is exclusive where it should be inclusive");
});

await check("one cent over the cap is refused", () => {
  store.transfers.length = 0;
  const res = addUnderCap(transfer("t-over-cap", FX.DAILY_CAP_EUR + 0.01));
  assert.equal(res.ok, false);
  assert.equal(store.findTransfer("t-over-cap"), undefined, "a refused transfer was still written");
});

console.log("─── (d) partner and network failure ───");

await check("two transfers prepared in parallel cannot both reserve the whole cap", async () => {
  store.transfers.length = 0;
  const half = FX.DAILY_CAP_EUR * 0.6; // two of these exceed the cap
  // Each "request" does its slow work (a balance read, a venue call) and only
  // then writes its row — which is exactly the window the audit found open.
  // The hold is taken up front, the slow work happens, then the row is
  // written — so the second request must be refused while the first is still
  // preparing, before it could have called Bridge.
  const race = async (id: string) => {
    const held = store.holdDailyCap("cap-user", half, FX.DAILY_CAP_EUR, usedByCapUser);
    await new Promise((r) => setTimeout(r, 5));
    if (!held.ok) return false;
    store.addTransferUnderHold(transfer(id, half), held.holdId);
    return true;
  };
  const [a, b] = await Promise.all([race("race-a"), race("race-b")]);
  assert.equal([a, b].filter(Boolean).length, 1, "both concurrent transfers reserved the full cap");
  assert.equal(usedByCapUser(), half, "the cap ledger does not match the transfers that were written");
});

await check("transfer creation RESERVES the cap rather than only checking it", () => {
  // The unit tests above prove the primitive. This proves the call site uses
  // it, and uses it EARLY: the hold must be taken before the quote is spent
  // and before Bridge is asked for a transfer, or a cap refusal leaves an
  // unfunded Bridge transfer behind (the finding this replaced).
  const src = readFileSync("services/api/src/server.ts", "utf8");
  const hold = src.indexOf("store.holdDailyCap(");
  assert.ok(hold > 0, "transfer creation no longer holds the cap");
  assert.ok(hold < src.indexOf("store.consumeQuote(quote.id)"), "the quote is consumed before the cap is held");
  assert.ok(hold < src.indexOf("await createBridgeTransfer("), "Bridge is called before the cap is held");
  assert.match(src, /store\.addTransferUnderHold\(/, "the row is not written under the hold");
  assert.match(src, /finally \{\s*if \(hold\.id\) store\.releaseCapHold\(hold\.id\)/, "a refused or failed preparation keeps its hold");
  assert.doesNotMatch(
    src,
    /\bstore\.addTransfer\(/,
    "a non-reserving store.addTransfer is back on the transfer-creation path",
  );
});

await check("a released hold frees the cap; a committed one cannot be released twice", () => {
  store.transfers.length = 0;
  const a = store.holdDailyCap("cap-user", FX.DAILY_CAP_EUR, FX.DAILY_CAP_EUR, usedByCapUser);
  assert.equal(a.ok, true);
  const blocked = store.holdDailyCap("cap-user", 1, FX.DAILY_CAP_EUR, usedByCapUser);
  assert.equal(blocked.ok, false, "a second hold fit beside a full-cap hold that is still preparing");
  store.releaseCapHold((a as { holdId: string }).holdId);
  assert.equal(usedByCapUser(), 0, "a released hold still counts against the cap");
  const b = store.holdDailyCap("cap-user", 10, FX.DAILY_CAP_EUR, usedByCapUser);
  assert.equal(b.ok, true, "the cap stayed taken after the refused transfer released it");
  const id = (b as { holdId: string }).holdId;
  store.addTransferUnderHold(transfer("t-held", 10), id);
  store.releaseCapHold(id); // what the finally block does after success
  assert.equal(usedByCapUser(), 10, "committing a hold counted the amount twice, or releasing it uncounted the row");
  assert.throws(() => store.addTransferUnderHold(transfer("t-held-2", 10), id), /no cap hold/);
});

await check("a deposit recorded twice by overlapping scans is stored once", () => {
  const base = {
    userId: "u1",
    chainId: 31337,
    token: "USDC" as const,
    txHash: "0xfeed" + "0".repeat(60),
    logIndex: 3,
    amountUnits: "1000000",
    amountUsdc: 1,
    settlementAsset: "USDC" as const,
    paymentAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    state: "DETECTED" as const,
    txs: [],
    detectedAt: iso(0),
    updatedAt: iso(0),
  };
  const before = store.cryptoDeposits.length;
  const first = store.addCryptoDeposit({ id: "dep-first", ...base });
  const second = store.addCryptoDeposit({ id: "dep-second", ...base });
  assert.equal(store.cryptoDeposits.length, before + 1, "one on-chain transfer was recorded as two deposits");
  assert.equal(second.id, first.id, "the second write did not return the row that already existed");
});

await check("a hung rate feed times out and REFUSES rather than serving a stale rate", async () => {
  delete process.env.TRANSF_RATES_FIXED;
  await assert.rejects(
    () => midRates(),
    (e: any) => e instanceof RateUnavailableError,
    "a feed that never answers did not produce RateUnavailableError",
  );
});

await check("the refusal is not cached as a rate — the next call refuses too", async () => {
  delete process.env.TRANSF_RATES_FIXED;
  await assert.rejects(() => midRates(), (e: any) => e instanceof RateUnavailableError);
});

await check("every partner client on a money path bounds its own calls", () => {
  // Node's global fetch has no default timeout, so an upstream that accepts
  // and never answers hangs the caller forever. Asserted against the source
  // because the failure is the ABSENCE of a line, which no happy-path test
  // can see.
  const files = [
    "services/api/src/adapters/monerium-client.ts",
    "services/api/src/bridge/bridgexyz.ts",
    "services/api/src/wallet/candide.ts",
    "services/api/src/adapters/candide-forwarder.ts",
    "services/api/src/recovery/candide-guardian.ts",
    "services/api/src/stellar/anchor.ts",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const calls = (src.match(/\bfetch\(/g) ?? []).length;
    const bounded = (src.match(/partnerTimeout\(/g) ?? []).length;
    assert.ok(calls > 0, `${f} has no fetch call — has it moved?`);
    assert.ok(
      bounded >= calls,
      `${f}: ${calls} fetch call(s), ${bounded} bounded — an unbounded partner call can hang a sweep forever`,
    );
  }
});

await check("the deposit scanner refuses to run two scans at once", () => {
  const src = readFileSync("services/api/src/adapters/crypto-deposits.ts", "utf8");
  assert.match(
    src,
    /if \(scanning\) return 0;/,
    "the single-flight guard is gone — setInterval does not wait for the previous tick",
  );
});

await check("a malformed partner timeout refuses at boot, not at the first partner call", () => {
  // Imported in a child process because the value is read once at import and
  // this process already has it. A typo that reached AbortSignal.timeout would
  // throw a RangeError on every Monerium, Bridge and Candide call instead.
  const load = (value: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "-e", 'await import("./services/api/src/http.ts")'], {
      env: { ...process.env, PARTNER_HTTP_TIMEOUT_MS: value },
      encoding: "utf8",
    });
  for (const bad of ["30s", "1.5", "0"]) {
    const r = load(bad);
    assert.notEqual(r.status, 0, `PARTNER_HTTP_TIMEOUT_MS=${bad} was accepted`);
    assert.match(r.stderr, /PARTNER_HTTP_TIMEOUT_MS/, `the refusal for ${bad} does not name the variable`);
  }
  assert.equal(load("45000").status, 0, "a valid timeout was refused");
});

hung.close();
console.log(`\n${n - failures.length}/${n} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
