/**
 * Payment requests (pay links) — the builders offline, then the routes and the
 * crypto attribution against a real hardhat chain.
 *
 * What the chain half proves: a USDC transfer of exactly the quoted amount to
 * the payee's page address is read from the chain by the deposit poller,
 * attributed to the request by amount, and the request goes PAID while the
 * deposit settles as USDC (auto-convert off). A deposit nobody asked for is
 * left alone. Bank-side attribution runs against the store with the shapes
 * Monerium and our own transfers produce, since hardhat has no Monerium.
 *
 * Run: npm run paylinks:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8554";
process.env.TRANSF_RPC_URL = RPC;
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.MG_ANCHOR_DOMAIN = "";
const MID = 1.1379;
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: MID, INR: 109.87, KES: 147.53 });
process.env.DEPLOY_EURUSD_RATE ??= String(Math.round(MID * 1e6));

const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const children: ChildProcess[] = [];
const bg = (cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: process.env });
  children.push(c);
  return c;
};
async function waitRpc(timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`   ok  ${label}`);
};

// ---------------------------------------------------------------------------
console.log("1/4 builders, offline…");
const pr = await import("../services/api/src/payment-requests.js");
const { PAYMENT_REQUESTS } = await import("../services/api/src/config.js");

const now = new Date("2026-09-05T12:00:00.000Z");
const mkReq = (over: Partial<import("../services/api/src/payment-requests.js").PaymentRequest> = {}) => ({
  id: randomUUID(), code: pr.newRequestCode(), userId: "u1", handle: "miriam", currency: "EUR" as const,
  amountEur: 25, methods: ["crypto", "bank"] as ("crypto" | "bank")[], state: "OPEN" as const, cryptoQuotes: [], payments: [],
  source: { kind: "app" as const }, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  createdAt: now.toISOString(), updatedAt: now.toISOString(), ...over,
});
const mid = { usdPerEur: MID, provider: "test", asOf: now.toISOString() };

{
  const code = pr.newRequestCode();
  check("codes are 15 Crockford characters", /^[0-9A-HJKMNP-TV-Z]{15}$/.test(code), code);
  check("display groups them 5-5-5", /^.{5}-.{5}-.{5}$/.test(pr.displayCode(code)));
  check("look-alikes fold: o->0, i/l->1, u->v, hyphens and case dropped",
    pr.normaliseCode("abcde-fghlk-mnpqr") === "ABCDEFGH1KMNPQR" && pr.normaliseCode("0OIL1U") === "00111V");
  check("a memo carries the code however it was typed", pr.textCarriesCode(`Rechnung 4711 ${pr.displayCode(code).toLowerCase()} danke`, code));
  check("and a memo without it does not", !pr.textCarriesCode("Rechnung 4711", code));
}

{
  const user: any = { id: "u1", name: "Miriam Z", iban: "EE1234", paymentPage: { handle: "miriam", depositAddress: `0x${"11".repeat(20)}` } };
  const v = pr.validateCreate({ amountEur: 40, description: "  Invoice   14 " }, user, now);
  check("defaults: both methods, description whitespace folded, one-week expiry",
    v.methods.join() === "crypto,bank" && v.description === "Invoice 14" &&
      Date.parse(v.expiresAt) - now.getTime() === PAYMENT_REQUESTS.defaultTtlMs);
  assert.throws(() => pr.validateCreate({ amountEur: 1.005 }, user, now), /two decimals/);
  assert.throws(() => pr.validateCreate({ amountEur: -1 }, user, now), /positive/);
  check("amounts are cents, positive", true);
  const noIban: any = { ...user, iban: "" };
  assert.throws(() => pr.validateCreate({ methods: ["bank"] }, noIban, now), (e: any) => e.status === 409 && /IBAN/.test(e.message));
  check("a method the payee cannot offer is refused with what would add it", true);
  const open = pr.validateCreate({ amountEur: "" }, user, now);
  check("an empty amount means the payer chooses", open.amountEur === undefined);
}

let q25: import("../services/api/src/payment-requests.js").CryptoQuote;
{
  q25 = pr.quoteCrypto(25, mid, [], now);
  const expected = Math.ceil(2500 * MID * 1.005 * 10_000) / 1e6;
  check(`€25 quotes ${expected} USDC: live mid plus the stated 50bps allowance, rounded up`, q25.amountUsdc === expected, `${q25.amountUsdc}`);
  check("the quote records the mid, its provider and the allowance", q25.rate === MID && q25.rateProvider === "test" && q25.allowanceBps === 50);
  const q2 = pr.quoteCrypto(25, mid, [q25.amountUsdc], now);
  check("a colliding amount is nudged by one micro-unit so two links stay distinct",
    Math.round((q2.amountUsdc - q25.amountUsdc) * 1e6) === 1, `${q2.amountUsdc}`);
  check("the payment URI carries the amount in base units",
    pr.requestPaymentUri({ address: `0x${"aa".repeat(20)}`, decimals: 6 }, 31337, `0x${"bb".repeat(20)}`, q25.amountUsdc)
      .endsWith(`&uint256=${Math.round(q25.amountUsdc * 1e6)}`));
}

{
  const later = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  const rA = mkReq({ cryptoQuotes: [q25] });
  const dep = (amountUsdc: number, at = later(5)) => ({ token: "USDC" as const, amountUsdc, detectedAt: at, receipt: undefined });
  check("an exact amount matches in full", pr.matchDepositToRequests(dep(q25.amountUsdc), [rA])?.kind === "full");
  check("a hair under (within tolerance) still settles in full", pr.matchDepositToRequests(dep(q25.amountUsdc * 0.997), [rA])?.kind === "full");
  check("a little more than asked is an over-payment, still attributed", pr.matchDepositToRequests(dep(q25.amountUsdc + 1), [rA])?.kind === "over");
  check("double the amount is not this payment — it would swallow someone else's", pr.matchDepositToRequests(dep(q25.amountUsdc * 2), [rA]) === undefined);
  const q100 = pr.quoteCrypto(100, mid, [], now);
  const rBig = mkReq({ amountEur: 100, cryptoQuotes: [q100] });
  check("a deposit between two quotes is the short payment of the larger request, not an over-payment of the smaller",
    pr.matchDepositToRequests(dep(q100.amountUsdc * 0.6), [rA, rBig])?.request.id === rBig.id);
  check("half the amount is a partial payment", pr.matchDepositToRequests(dep(q25.amountUsdc / 2), [rA])?.kind === "partial");
  check("a tenth of the amount is not this payment at all", pr.matchDepositToRequests(dep(q25.amountUsdc * 0.1), [rA]) === undefined);
  check("a quote issued after the money arrived cannot be what the payer saw",
    pr.matchDepositToRequests(dep(q25.amountUsdc, new Date(now.getTime() - 60 * 60_000).toISOString()), [rA]) === undefined);
  const q26 = pr.quoteCrypto(26, mid, [], now);
  const rB = mkReq({ amountEur: 26, cryptoQuotes: [q26] });
  check("between two open requests the closest quoted amount wins",
    pr.matchDepositToRequests(dep(q26.amountUsdc), [rA, rB])?.request.id === rB.id);
  const rClosed = mkReq({ cryptoQuotes: [q25], state: "PAID" });
  check("a request that is not open is never a candidate", pr.matchDepositToRequests(dep(q25.amountUsdc), [rClosed]) === undefined);
  check("an EURe transfer is not a crypto payment of a USDC quote", pr.matchDepositToRequests({ ...dep(25), token: "EURE" }, [rA]) === undefined);
}

{
  const r = mkReq();
  const order = (memo: string, over: any = {}) => ({
    id: "ord-1", kind: "issue", amount: "25", address: `0x${"AB".repeat(20)}`, memo,
    meta: { state: "processed", processedAt: now.toISOString() },
    counterpart: { details: { firstName: "Alex", lastName: "Payer" } }, ...over,
  });
  const p = pr.matchMoneriumOrder(order(`invoice 14 ${pr.displayCode(r.code).toLowerCase()}`), r, `0x${"ab".repeat(20)}`);
  check("a processed Monerium issue order whose memo carries the code pays the request",
    p?.method === "bank" && p.amountEur === 25 && p.payerName === "Alex Payer" && p.settledAsset === "EURE", JSON.stringify(p));
  check("the amount is the order's, not the request's", pr.matchMoneriumOrder(order(r.code, { amount: "10" }), r, `0x${"ab".repeat(20)}`)?.kind === "partial");
  check("an order on someone else's address is ignored", pr.matchMoneriumOrder(order(r.code), r, `0x${"cd".repeat(20)}`) === undefined);
  check("a pending order is not money yet", pr.matchMoneriumOrder(order(r.code, { meta: { state: "pending" } }), r, `0x${"ab".repeat(20)}`) === undefined);
  check("a redeem is never a payment in", pr.matchMoneriumOrder(order(r.code, { kind: "redeem" }), r, `0x${"ab".repeat(20)}`) === undefined);

  const t: any = { id: "t-1", rail: "sepa", state: "PAID", recipientIban: "ee 12 34", reference: `${pr.displayCode(r.code)} thanks`, sendEur: 25.99, receiveEur: 25, updatedAt: now.toISOString() };
  const tp = pr.matchTransfer(t, r, "EE1234");
  check("our own PAID SEPA payout with the code as reference pays it", tp?.amountEur === 25 && tp.ref === "transfer:t-1");
  check("a payout to a different IBAN does not", pr.matchTransfer(t, r, "EE9999") === undefined);
  check("a payout still in flight does not", pr.matchTransfer({ ...t, state: "DEBITED" }, r, "EE1234") === undefined);

  let state = pr.applyPayment(r, tp!, now);
  check("a full payment marks the request PAID", state.added && state.request.state === "PAID" && Boolean(state.request.paidAt));
  const again = pr.applyPayment(state.request, tp!, now);
  check("the same ref is not booked twice", !again.added && again.request.payments.length === 1);
  const twin = pr.applyPayment(state.request, p!, now);
  check("the Monerium order for our own payout is the same money, merged onto one row with the payer's name",
    !twin.added && state.request.payments.length === 1 && state.request.payments[0].payerName === "Alex Payer" && state.request.payments[0].orderId === "ord-1");
  const rOpen = mkReq({ amountEur: undefined });
  const s2 = pr.applyPayment(rOpen, { ...tp!, ref: "x" }, now);
  check("an open-amount link stays OPEN and accumulates", s2.request.state === "OPEN" && pr.paidEur(s2.request) === 25);
  const rPart = mkReq({ amountEur: 50 });
  const s3 = pr.applyPayment(rPart, { ...tp!, ref: "a", amountEur: 30, kind: "partial" }, now);
  const s4 = pr.applyPayment(s3.request, { ...tp!, ref: "b", amountEur: 20, kind: "full" }, now);
  check("two partial payments that add up close the request", s3.request.state === "OPEN" && s4.request.state === "PAID");
  check("an OPEN request past its date reads as EXPIRED without a write",
    pr.effectiveState(mkReq({ expiresAt: new Date(now.getTime() - 1).toISOString() }), now) === "EXPIRED" &&
      pr.effectiveState(mkReq(), now) === "OPEN");
}

{
  const user: any = {
    id: "user-secret-id", name: "Miriam Zoldenburg", email: "miriam@example.com", iban: "EE123456789012345678", country: "DE",
    kycStatus: "approved", address: `0x${"aa".repeat(20)}`, authorizerAddress: `0x${"cc".repeat(20)}`,
    paymentPage: { handle: "miriam", displayName: "Miriam Z", depositAddress: `0x${"dd".repeat(20)}`, recipientAddress: `0x${"aa".repeat(20)}`,
      forwarder: { custodialWithdrawer: `0x${"ee".repeat(20)}` }, settlementAsset: "EURE", autoConvert: false },
    monerium: { accessTokenEnc: "tokentoken" },
  };
  const ctx = { chainId: 31337, token: { symbol: "USDC", address: `0x${"11".repeat(20)}` as `0x${string}`, decimals: 6 }, bicFor: () => "LHVBEE22", baseUrl: "https://zoldhq.com", now };
  const cryptoOnly = pr.publicPaymentRequest(mkReq({ methods: ["crypto"], cryptoQuotes: [q25] }), user, { ...ctx, quote: q25 });
  const s = JSON.stringify(cryptoOnly);
  for (const secret of ["miriam@example.com", "user-secret-id", "EE123456789012345678", "Miriam Zoldenburg", user.authorizerAddress, user.paymentPage.recipientAddress, user.paymentPage.forwarder.custodialWithdrawer, "tokentoken", "approved"]) {
    assert.ok(!s.includes(secret), `leaked ${secret} in ${s}`);
  }
  check("a crypto-only link leaks nothing: no email, id, IBAN, legal name, keys or KYC state", true);
  check("it carries the quoted amount, the page address and the URI", cryptoOnly.methods.crypto?.amountUsdc === q25.amountUsdc && cryptoOnly.methods.crypto?.address === user.paymentPage.depositAddress && cryptoOnly.methods.crypto?.uri.includes("uint256"));
  const withBank = pr.publicPaymentRequest(mkReq(), user, ctx);
  check("a link offering bank transfer names the IBAN, the holder and the code as reference — a SEPA transfer needs all three",
    withBank.methods.bank?.iban === user.iban && withBank.methods.bank?.holder === "Miriam Zoldenburg" && withBank.methods.bank?.reference === pr.displayCode(withBank.code.replace(/-/g, "")) && withBank.methods.bank?.bic === "LHVBEE22");
  check("but still no email or id", !JSON.stringify(withBank).includes("miriam@example.com") && !JSON.stringify(withBank).includes("user-secret-id"));
  check("without a live quote the crypto method is offered with no amount, not a made-up one", withBank.methods.crypto !== undefined && withBank.methods.crypto?.amountUsdc === undefined);
}

// ---------------------------------------------------------------------------
console.log("2/4 chain + routes…");
try {
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8554"]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, deployerWallet, writeAndWait } = await import("../services/api/src/chain.js");
  const { pollCryptoDepositsOnce } = await import("../services/api/src/adapters/crypto-deposits.js");
  const routes = await import("../services/api/src/routes/payment-requests.js");
  initStore();

  const owner = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
  const nowIso = new Date().toISOString();
  const miriam: any = {
    id: randomUUID(), name: "Miriam Zoldenburg", email: "miriam@example.com", country: "DE", address: owner, iban: "EE382200221020145685",
    kycStatus: "approved",
    passkey: { credentialId: "cred-m", publicKey: { x: "0x1", y: "0x2" } },
    passkeySafe: { status: "active", address: owner },
    paymentPage: {
      handle: "miriam", depositAddress: owner, recipientAddress: owner,
      forwarder: { provider: "local-safe", recipient: owner, destinationChainId: 31337, sourceChainIds: [31337], custodialWithdrawer: owner, active: true, activatedAt: nowIso },
      settlementAsset: "EURE", autoConvert: false, createdAt: nowIso, updatedAt: nowIso,
    },
    createdAt: nowIso,
  };
  store.addUser(miriam);

  const app = express();
  app.use(express.json());
  app.use("/api", routes.createPaymentRequestRouter((req, res, userId) => {
    if (req.header("x-user") === userId) return { userId };
    res.status(403).json({ error: "forbidden" });
    return undefined;
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const API = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, body?: unknown, asUser?: string) => {
    const res = await fetch(`${API}${p}`, {
      method, headers: { "content-type": "application/json", ...(asUser ? { "x-user": asUser } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };

  const created = await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 25, description: "Invoice 14" }, miriam.id);
  check("POST creates a link with both methods and a fresh quote", created.status === 201 && created.body.methods.join() === "crypto,bank" && created.body.latestQuote?.amountUsdc === q25.amountUsdc, JSON.stringify(created.body));
  check("the URL is /pay/<handle>/<code>", new RegExp(`/pay/miriam/[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$`).test(created.body.url), created.body.url);
  const code = created.body.code as string;
  check("someone else's session cannot create for this account", (await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 1 }, "stranger")).status === 403);

  const pub = await call("GET", `/api/pay/miriam/${code.toLowerCase()}`);
  check("the public page resolves the code case-insensitively", pub.status === 200 && pub.body.code === code);
  check("it shows the quoted USDC, the IBAN, the holder and the reference", pub.body.methods.crypto.amountUsdc === q25.amountUsdc && pub.body.methods.bank.iban === miriam.iban && pub.body.methods.bank.holder === "Miriam Zoldenburg" && pub.body.methods.bank.reference === code);
  const leak = JSON.stringify(pub.body);
  check("and no email, user id or KYC state", !leak.includes("miriam@example.com") && !leak.includes(miriam.id) && !leak.includes("approved"));
  check("the code under someone else's handle is a 404", (await call("GET", `/api/pay/someone/${code}`)).status === 404);
  check("a malformed code is a 404, not an error", (await call("GET", `/api/pay/miriam/not-a-code`)).status === 404);

  console.log("3/4 a USDC deposit of the quoted amount pays it…");
  const mintUsdc = (to: `0x${string}`, amountUsdc: number) =>
    writeAndWait(deployerWallet, { address: addrs().usdc, abi: abis.MockToken, functionName: "mint", args: [to, BigInt(Math.round(amountUsdc * 1e6))] });
  await pollCryptoDepositsOnce(); // establishes the cursor
  await mintUsdc(owner, q25.amountUsdc);
  const n = await pollCryptoDepositsOnce();
  check("the poller saw the deposit (the page is watched while a link is open, auto-convert or not)", n === 1, `${n}`);
  const r1 = store.findPaymentRequest(created.body.id)!;
  const d1 = store.cryptoDeposits.find((d) => d.paymentRequestId === r1.id);
  check("the deposit is attributed to the request by amount", Boolean(d1), JSON.stringify(store.cryptoDeposits));
  check("the request is PAID with one full crypto payment", r1.state === "PAID" && r1.payments.length === 1 && r1.payments[0].kind === "full" && r1.payments[0].amountUsdc === q25.amountUsdc, JSON.stringify(r1.payments));
  check("auto-convert is off, so the deposit is complete as USDC and the payment says what is held", d1!.state === "CONVERTED" && d1!.settlementAsset === "USDC" && r1.payments[0].settledAsset === "USDC", `${d1!.state} ${d1!.reason ?? ""}`);
  const pubPaid = await call("GET", `/api/pay/miriam/${code}`);
  check("the public page now reads PAID and lists the payment", pubPaid.body.state === "PAID" && pubPaid.body.payments[0].amountUsdc === q25.amountUsdc);
  check("a paid link cannot be cancelled", (await call("POST", `/api/users/${miriam.id}/payment-requests/${r1.id}/cancel`, {}, miriam.id)).status === 409);

  await mintUsdc(owner, 3.21);
  await pollCryptoDepositsOnce();
  const stray = store.cryptoDeposits.find((d) => d.amountUsdc === 3.21)!;
  check("money nobody asked for is recorded as an ordinary deposit, attributed to no link", stray && !stray.paymentRequestId && store.findPaymentRequest(r1.id)!.payments.length === 1);

  const openReq = await call("POST", `/api/users/${miriam.id}/payment-requests`, { methods: ["crypto"], description: "tip jar" }, miriam.id);
  check("an open-amount link has no quote until the payer names an amount", openReq.status === 201 && openReq.body.amountEur === undefined && !openReq.body.latestQuote);
  const quoted = await call("POST", `/api/pay/miriam/${openReq.body.code}/quote`, { amountEur: 12 });
  check("the payer's amount is quoted and recorded on the link", quoted.status === 200 && quoted.body.methods.crypto.amountUsdc > 13, JSON.stringify(quoted.body));
  await mintUsdc(owner, quoted.body.methods.crypto.amountUsdc);
  await pollCryptoDepositsOnce();
  const r2 = store.findPaymentRequest(openReq.body.id)!;
  check("the deposit matches the payer's own quote; the link stays OPEN and shows €12 received", r2.state === "OPEN" && r2.payments.length === 1 && r2.payments[0].amountEur === 12, JSON.stringify(r2.payments));
  check("a bank-only link refuses to quote crypto", (await call("POST", `/api/pay/miriam/${(await call("POST", `/api/users/${miriam.id}/payment-requests`, { methods: ["bank"] }, miriam.id)).body.code}/quote`, { amountEur: 5 })).status === 409);

  const part = await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 50, methods: ["crypto"] }, miriam.id);
  const q50 = part.body.latestQuote.amountUsdc as number;
  await mintUsdc(owner, Math.round(q50 * 0.6 * 1e6) / 1e6);
  await pollCryptoDepositsOnce();
  let r3 = store.findPaymentRequest(part.body.id)!;
  check("60% of the amount is a partial payment and the link stays open for the rest", r3.state === "OPEN" && r3.payments[0]?.kind === "partial" && r3.payments[0].amountEur === 30, JSON.stringify(r3.payments));
  await mintUsdc(owner, Math.round(q50 * 0.4 * 1e6) / 1e6);
  await pollCryptoDepositsOnce();
  r3 = store.findPaymentRequest(part.body.id)!;
  check("the remaining 40% closes it", r3.state === "PAID" && r3.payments.length === 2, JSON.stringify(r3.payments));

  console.log("4/4 bank side and housekeeping…");
  const bankReq = await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 40, methods: ["bank"] }, miriam.id);
  const bankCode = bankReq.body.code.replace(/-/g, "");
  const cancelled = await call("POST", `/api/users/${miriam.id}/payment-requests/${bankReq.body.id}/cancel`, {}, miriam.id);
  check("an unpaid link can be cancelled and the page says so", cancelled.body.state === "CANCELLED" && (await call("GET", `/api/pay/miriam/${bankReq.body.code}`)).body.state === "CANCELLED");

  const live = await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 40, methods: ["bank"] }, miriam.id);
  const liveCode = live.body.code.replace(/-/g, "");
  store.addTransfer({
    id: "t-paid", userId: "someone-else", quoteId: "q", rail: "sepa", recipientName: "Miriam Zoldenburg", recipientIban: miriam.iban,
    reference: `${live.body.code} invoice`, state: "PAID", sendEur: 40.99, receiveEur: 40, receiveKes: 0, txs: [], createdAt: nowIso, updatedAt: nowIso,
  } as any);
  const swept = await routes.sweepPaymentRequests();
  const r4 = store.findPaymentRequest(live.body.id)!;
  check("the sweep books our own PAID payout carrying the code, and the link is PAID", swept.matched === 1 && r4.state === "PAID" && r4.payments[0].transferId === "t-paid", JSON.stringify(r4.payments));
  const merged = routes.attributeMoneriumOrder({ id: "ord-9", kind: "issue", amount: "40", address: owner, memo: `${live.body.code} invoice`, meta: { state: "processed", processedAt: nowIso }, counterpart: { details: { name: "Payer Ltd" } } });
  check("Monerium's view of the same credit merges onto that row instead of doubling it", merged!.payments.length === 1 && merged!.payments[0].payerName === "Payer Ltd" && merged!.payments[0].orderId === "ord-9");
  void bankCode; void liveCode;

  const soon = await call("POST", `/api/users/${miriam.id}/payment-requests`, { amountEur: 5, methods: ["bank"], expiresAt: new Date(Date.now() + 90_000).toISOString() }, miriam.id);
  store.updatePaymentRequest(soon.body.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  check("an expired link reads EXPIRED on its page before the sweep runs", (await call("GET", `/api/pay/miriam/${soon.body.code}`)).body.state === "EXPIRED");
  const swept2 = await routes.sweepPaymentRequests();
  check("and the sweep writes it down", swept2.expired === 1 && store.findPaymentRequest(soon.body.id)!.state === "EXPIRED");

  const list = await call("GET", `/api/users/${miriam.id}/payment-requests`, undefined, miriam.id);
  check("the owner's list carries every link, newest first, with what the payee can offer", list.body.requests.length === 7 && list.body.methods.length === 2 && Date.parse(list.body.requests[0].createdAt) >= Date.parse(list.body.requests[1].createdAt));

  server.close();
  console.log(`\nPAYMENT REQUESTS TEST PASSED — ${passed} checks`);
} finally {
  for (const c of children) c.kill();
}
