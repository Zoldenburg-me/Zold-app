/**
 * A processed Monerium issue order (a SEPA credit minted as EURe) is booked
 * to whoever the paid address belongs to (bookkeeping/money-in.ts):
 *
 *   1. a company's own Safe: the company's account and books, not a person;
 *   2. a person's Safe: under the user, as before, on their personal books;
 *   3. a sole trader's Safe: under the user, on the business's books;
 *   4. an address naming more than one holder books nothing, and the
 *      reconciler reports it;
 *   5. a second delivery of a recorded order is `duplicate`;
 *   6. a token request Monerium refuses (4xx) or cannot answer (5xx) leaves
 *      the delivery unresolved, and its log line names the status, never the
 *      token endpoint's body.
 *
 * Then the restart and contract matrix (#107 B1). The deployment is one
 * process writing one file store; "two workers" are two callers in it, and a
 * restart is the store re-read from disk under fresh adapter module state:
 *
 *   7. issue claims: concurrent deliveries, webhook + poller, and a restart
 *      before the claim, while it is held, and between the two writes, all
 *      book an order once; an amount that is not a euro decimal or a state
 *      other than processed books nothing; an order read that answers
 *      nothing usable (401/403/409/429/5xx, empty, non-JSON, another id,
 *      oversized) leaves the delivery unresolved, only a 404 settles it;
 *   8. the webhook: fuzzed unsigned bodies never set money state, a forged
 *      body naming a real order books Monerium's amount; one id costs one
 *      upstream read however often it is delivered, reads in flight are
 *      capped (503 past it), remembered 404s are capped, an unsigned
 *      webhook-id is not stored, and with a secret a bad signature reads
 *      nothing upstream;
 *   9. redeem polling: PAID once across two pollers and a restart; an order
 *      whose amount, IBAN, kind, currency or Safe differs from the signed
 *      redeem goes to review, never PAID or FAILED; a failed or foreign read
 *      writes nothing; an undocumented state halts;
 *  10. OAuth refresh against a stub that rotates the refresh token and
 *      refuses a spent one: two workers spend it once, the rotated token is
 *      on disk before the new access token is used, a restart (also
 *      mid-refresh) never resurrects a spent token, a lost answer ends in a
 *      refusal with no fallback to an old token or the app's, and a
 *      disconnect during a refresh stays disconnected.
 *
 * Not covered: Monerium's live paging of /orders (the poller reads one page;
 * see the pagination check), and multi-instance deployments.
 *
 * The stub Monerium answers the app's client-credentials login, the order
 * reads and /tokens (EURe on the test chain, so nothing is minted). No chain:
 * the adapter, the store and the statement writer run in-process.
 *
 * Run: npm run monerium:money-in:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import express from "express";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-money-in-")), "db.json");
process.env.TRANSF_CHAIN_ID = "84532";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:1"; // nothing here reads the chain
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-money-in-0032b";
process.env.MONERIUM_CLIENT_ID = "app-client";
process.env.MONERIUM_CLIENT_SECRET = "app-secret-0001";
process.env.MONERIUM_CHAIN = "base";

process.env.MONERIUM_MAX_RPS = "100000"; // the read limiter is not under test here

const orders = new Map<string, any>();
/** Orders only a company's own keys ("co-client") list: its own profile. */
const coOrders = new Map<string, any>();
/** While set, /auth/token answers this status with an OAuth error body. */
let tokenFault = 0;
const TOKEN_BODY = { error: "invalid_client", error_description: "client app-client unknown" };
/** What the stub saw and how it answers, for the restart, webhook and contract matrices. */
const stub = {
  /** GET /orders/:id per order id: the upstream cost of a webhook. */
  lookups: new Map<string, number>(),
  inFlight: 0,
  maxInFlight: 0,
  /** Answer each GET /orders/:id this many ms late. */
  orderDelayMs: 0,
  /** Hold the next N GET /orders/:id until released (a worker stuck mid-call). */
  holdOrders: 0,
  heldOrders: [] as (() => void)[],
  /** A raw answer for one order id, in place of the order. */
  orderAnswer: new Map<string, { status: number; raw: string }>(),
  /** The OAuth refresh grant: Monerium rotates the refresh token on every use
   *  and refuses a spent one. The rotation happens when it answers. */
  refresh: {
    current: "rt-0", n: 0, presented: [] as string[], spentPresented: 0,
    hold: 0, held: [] as (() => void)[], loseNext: false,
  },
  /** Bearer tokens on every non-token request. */
  bearers: [] as string[],
  onBearer: undefined as undefined | ((token: string) => void),
};
const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (url.pathname === "/auth/token") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        stub.refresh.presented.push(rt);
        const answer = () => {
          if (rt !== stub.refresh.current) {
            stub.refresh.spentPresented++;
            return send(400, { error: "invalid_grant" });
          }
          const n = ++stub.refresh.n;
          stub.refresh.current = `rt-${n}`;
          if (stub.refresh.loseNext) {
            // Monerium rotated, and the answer never arrives.
            stub.refresh.loseNext = false;
            return res.destroy();
          }
          send(200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
        };
        if (stub.refresh.hold > 0) { stub.refresh.hold--; stub.refresh.held.push(answer); return; }
        return answer();
      }
      tokenFault
        ? send(tokenFault, TOKEN_BODY)
        : send(200, { access_token: form.get("client_id") === "co-client" ? "tok-co" : "tok-app", token_type: "Bearer", expires_in: 3600 });
    });
    return;
  }
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (bearer) { stub.bearers.push(bearer); stub.onBearer?.(bearer); }
  if (url.pathname === "/tokens") {
    return send(200, [{ kind: "evm", currency: "eur", symbol: "EURe", chain: "base", chainId: 84532, decimals: 18, address: "0x00000000000000000000000000000000000000e0" }]);
  }
  if (url.pathname === "/orders") return send(200, { orders: [...(bearer === "tok-co" ? coOrders : orders).values()] });
  if (url.pathname === "/ibans") return send(200, { ibans: [] });
  const m = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    stub.lookups.set(id, (stub.lookups.get(id) ?? 0) + 1);
    stub.maxInFlight = Math.max(stub.maxInFlight, ++stub.inFlight);
    const answer = () => {
      stub.inFlight--;
      const fixed = stub.orderAnswer.get(id);
      if (fixed) { res.writeHead(fixed.status, { "content-type": "application/json" }); return res.end(fixed.raw); }
      orders.has(id) ? send(200, orders.get(id)) : send(404, { code: 404, status: "Not Found" });
    };
    if (stub.holdOrders > 0) { stub.holdOrders--; stub.heldOrders.push(answer); return; }
    if (stub.orderDelayMs) return void setTimeout(answer, stub.orderDelayMs);
    return answer();
  }
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { mirrorOrderById, pollDepositsOnce } = await import("../services/api/src/adapters/monerium-sandbox.js");
const { writeStatementLines, writeAccountStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { reconcile } = await import("../services/api/src/reconcile.js");
const { pollRedeemOrdersOnce } = await import("../services/api/src/adapters/monerium-sandbox.js");
const { MoneriumClient } = await import("../services/api/src/adapters/monerium-client.js");
const { createMoneriumWebhookRouter } = await import("../services/api/src/routes/monerium-webhook.js");
const { signStandardWebhook } = await import("../services/api/src/http/standard-webhooks.js");
const { SECURITY } = await import("../services/api/src/config.js");
const { payoutEvidence } = await import("../services/api/src/transfers/review-evidence.js");
const { paymentMemo } = await import("../services/api/src/sepa.js");
const { moneriumText } = await import("../services/api/src/adapters/monerium-client.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

await initStore();
const now = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
const addr = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;

async function org(id: string, type: "personal" | "business", entity?: "company" | "sole_trader") {
  await store.addOrganisation({ id, type, ...(entity ? { entity } : {}), name: id, reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
}
async function account(id: string, orgId: string, address: `0x${string}`, backingUserId?: string) {
  const row = {
    id, orgId, currency: "EUR", label: "EUR account", status: backingUserId ? "active" : "gated", provider: "monerium" as any,
    identifier: {}, address, ...(backingUserId ? { backingUserId, backedSince: "2026-01-01T00:00:00.000Z" } : {}), createdAt: now, updatedAt: now,
  } as any;
  if (await store.addAccount(row)) return;
  // A second company account at one Safe is refused now; a store from before
  // that rule can still hold one. On db.json the fixture writes it as such a
  // store would have; Postgres's key cannot hold it at all.
  if (process.env.STORE_BACKEND !== "postgres") (await import("../services/api/src/store/db.js")).db.accounts.push(row);
}
const twinsPossible = process.env.STORE_BACKEND !== "postgres";
async function user(id: string, address: `0x${string}`) {
  await store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", address, iban: "" } as any);
}
let n = 0;
function issue(address: string, amount = "12.50") {
  const id = `ord-money-in-${++n}`;
  orders.set(id, {
    id, kind: "issue", address, chain: "base", currency: "eur", amount,
    meta: { state: "processed", placedAt: now, processedAt: now },
    counterpart: { details: { name: "Kunde GmbH" }, identifier: { iban: "DE89370400440532013000" } },
    memo: `payment ${n}`,
  });
  return id;
}
const recordOf = async (orderId: string) => (await store.list("moneriumIssueOrders")).find((o) => o.orderId === orderId);
const lineOf = async (orgId: string, orderId: string) => (await store.ledgerOf(orgId)).find((e) => e.statement?.links.orderId === orderId);

// A company with its own Safe (no backing user), and its owner's personal Safe.
const COMPANY_SAFE = addr("c");
await org("org_co", "business", "company");
await account("acc_co", "org_co", COMPANY_SAFE);
await user("u_owner", addr("a"));
await org("org_owner", "personal");
await account("acc_owner", "org_owner", addr("a"), "u_owner");
// A sole trader: the person's Safe backs both their personal and business accounts.
await user("u_st", addr("b"));
await org("org_st_personal", "personal");
await account("acc_st_personal", "org_st_personal", addr("b"), "u_st");
await org("org_st", "business", "sole_trader");
await account("acc_st", "org_st", addr("b"), "u_st");
// Ambiguous: a user's Safe that is also a company's account; two company accounts on one address.
await user("u_clash", addr("d"));
await org("org_clash", "business", "company");
await account("acc_clash", "org_clash", addr("d"));
await org("org_twin_1", "business", "company");
await org("org_twin_2", "business", "company");
await account("acc_twin_1", "org_twin_1", addr("e"));
await account("acc_twin_2", "org_twin_2", addr("e"));

console.log("\nA failed token request");

// First, while the app client holds no cached token: the lookup must ask
// /auth/token.
await check("a refused or failed token request leaves the delivery unresolved and logs the status, not the body", async () => {
  const id = issue(addr("a"));
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => warned.push(String(m));
  try {
    for (const code of [401, 502]) {
      tokenFault = code;
      warned.length = 0;
      assert.equal(await mirrorOrderById(id), "unavailable", `a ${code} on the token request is retried`);
      const line = warned.find((w) => w.includes(id));
      assert.ok(line, `a warn line names the order (${warned.join(" | ")})`);
      assert.match(line!, new RegExp(`HTTP ${code}`));
      assert.ok(!/invalid_client|app-client/.test(line!), `no token endpoint body in the log: ${line}`);
    }
  } finally {
    tokenFault = 0;
    console.warn = realWarn;
  }
  assert.equal(await store.isOrderProcessed(id), false);
  orders.delete(id);
});

console.log("\nBooked to the holder");

await check("a SEPA credit to a company's own Safe is booked to the company's account and books, not a person", async () => {
  const id = issue(COMPANY_SAFE.toUpperCase().replace("0X", "0x"));
  assert.equal(await mirrorOrderById(id), "recorded");
  assert.ok(await store.isOrderProcessed(id));
  const r = (await recordOf(id))!;
  assert.equal(r.accountId, "acc_co");
  assert.equal(r.userId, undefined, "no person's record");
  await writeStatementLines();
  const line = await lineOf("org_co", id);
  assert.ok(line, "the company's books have the line");
  assert.equal(line!.statement!.event, "sepa_in");
  assert.equal(line!.statement!.amountCents, 1250);
  assert.equal(line!.source.kind === "account" && line!.source.accountId, "acc_co");
  assert.equal(await lineOf("org_owner", id), undefined, "nothing on the owner's personal books");
  // The org's refresh (bookkeeping-export.ts) re-projects the account: nothing new, nothing doubled.
  assert.deepEqual(await writeAccountStatementLines((await store.findAccount("acc_co"))!), { added: 0, updated: 0 });
});

await check("a company's own Safe is watched for crypto in; a person's Safe, a clash and twin accounts are not watched as a company", async () => {
  const { watchedAddresses } = await import("../services/api/src/adapters/crypto-deposits.js");
  const watched = await watchedAddresses();
  const company = watched.filter((w) => w.source === "company-safe").map((w) => w.account!.id).sort();
  // Postgres refuses the second twin, so the first is that address's only account there.
  assert.deepEqual(company, twinsPossible ? ["acc_co"] : ["acc_co", "acc_twin_1"]);
  assert.equal(watched.find((w) => w.address.toLowerCase() === addr("d"))?.user?.id, "u_clash", "a user's Safe stays the user's");
  if (twinsPossible) assert.ok(!watched.some((w) => w.address.toLowerCase() === addr("e")), "two accounts on one address name no holder");
});

await check("EURe and USDC landing on a company's own Safe are booked in the company's books, never a person's", async () => {
  const { settleOnArrival } = await import("../services/api/src/adapters/crypto-deposits.js");
  const { attributeDepositToRequest } = await import("../services/api/src/routes/payment-requests.js");
  const H = (k: number) => `0x${k.toString(16).padStart(64, "0")}`;
  const at = "2026-10-05T10:00:00.000Z";
  const common = { accountId: "acc_co", chainId: 31337, logIndex: 0, from: addr("f"), arrivedAt: at, paymentAddress: COMPANY_SAFE, holding: "awaiting_approval", txs: [], detectedAt: at, updatedAt: at } as const;
  const eure = await store.addCryptoDeposit({ ...common, id: "co-eure", token: "EURE", txHash: H(901), amountUnits: "40000000000000000000", amountEur: 40, creditedEur: 40, settlementAsset: "EURE" } as any);
  const usdc = await store.addCryptoDeposit({
    ...common, id: "co-usdc", token: "USDC", txHash: H(902), amountUnits: "110000000", amountUsdc: 110, amountEur: 100, settlementAsset: "USDC",
    receipt: { amountEur: 100, rate: 1.1, rateProvider: "ecb", rateAsOf: "2026-10-05", ratedAt: at, blockTimestamp: at },
  } as any);
  assert.equal(await attributeDepositToRequest(usdc), undefined, "no person's pay link");
  assert.equal((await settleOnArrival(eure)).holding, "none");
  const held = await settleOnArrival(usdc);
  assert.equal(held.holding, "held");
  assert.equal(held.creditedUsdc, 110);
  assert.ok(held.settledAt);
  await writeStatementLines();
  const lines = (await store.ledgerOf("org_co")).filter((e) => e.statement?.links.depositId?.startsWith("co-"));
  assert.deepEqual(lines.map((e) => [e.statement!.event, e.statement!.amountCents]).sort(), [["crypto_held", 10000], ["eure_in", 4000]]);
  assert.ok(lines.every((e) => e.source.kind === "account" && e.source.accountId === "acc_co"));
  for (const o of ["org_owner", "org_st", "org_clash"]) {
    assert.ok(!(await store.ledgerOf(o)).some((e) => e.statement?.links.depositId?.startsWith("co-")), `nothing on ${o}'s books`);
  }
  assert.deepEqual(await writeAccountStatementLines((await store.findAccount("acc_co"))!), { added: 0, updated: 0 }, "a re-run adds nothing");
});

await check("USDC that arrived while no rate could be read is valued later at its day's fixing, once; a converted one is not", async () => {
  const { valueUnratedReceipts } = await import("../services/api/src/adapters/crypto-deposits.js");
  const H = (k: number) => `0x${k.toString(16).padStart(64, "0")}`;
  const at = "2026-10-06T10:00:00.000Z";
  const row = (id: string, k: number, over: any = {}) => ({
    id, accountId: "acc_co", chainId: 31337, token: "USDC", txHash: H(k), logIndex: 0, from: addr("f"), arrivedAt: at, amountUnits: "110000000", amountUsdc: 110,
    settlementAsset: "USDC", holding: "held", creditedUsdc: 110, settledAt: at, txs: [], detectedAt: at, updatedAt: at, ...over,
  });
  await store.addCryptoDeposit(row("co-unrated", 911) as any);
  await store.addCryptoDeposit(row("co-unrated-converted", 912, { holding: "converted", creditedEur: 99, settlementAsset: "EURE" }) as any);
  await store.addCryptoDeposit(row("co-unrated-no-time", 913, { arrivedAt: undefined }) as any);
  // Each may have been swapped already: valuing it now could book the income twice.
  await store.addCryptoDeposit(row("co-unrated-intent", 914, { conversionIntent: { at, amountUnits: "110000000", safeAddress: COMPANY_SAFE, quote: { provider: "dex", rate: "1", minOut: "1" } } }) as any);
  await store.addCryptoDeposit(row("co-unrated-partial", 915, { partials: [{ creditedEur: 10, provider: "dex", rate: 1.1, conversion: { txHash: H(916) } }] }) as any);
  await store.addCryptoDeposit(row("co-unrated-unconfirmed", 917, { holding: "unconfirmed" }) as any);
  // Settled on arrival against an invoice at €0, as a pay link's deposit is when no rate was read.
  await store.addInvoice({
    id: "inv_co_unrated", orgId: "org_co", direction: "outgoing", state: "SUBMITTED", linkTokenHash: "b".repeat(32),
    lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", amount: "100.00" }], currency: "EUR", total: "100.00",
    createdByMemberId: "m_x", createdAt: at, updatedAt: at,
    issued: { number: "RE-UNRATED", issueDate: at.slice(0, 10), netCents: 10000, vatCents: 0, grossCents: 10000, currency: "EUR" },
  } as any);
  const inv = await store.addCryptoDeposit(row("co-unrated-inv", 918, { invoiceId: "inv_co_unrated" }) as any);
  const { recordInvoiceSettlement } = await import("../services/api/src/adapters/crypto-deposits.js");
  await recordInvoiceSettlement(inv);
  assert.equal((await store.findInvoice("inv_co_unrated"))!.state, "SUBMITTED", "a €0 payment leaves it open");
  const before = process.env.TRANSF_RATES_FIXED;
  process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1, KES: 147.53 });
  try {
    assert.equal(await valueUnratedReceipts(), 2);
    assert.equal(await valueUnratedReceipts(), 0, "stamped once");
  } finally {
    if (before === undefined) delete process.env.TRANSF_RATES_FIXED; else process.env.TRANSF_RATES_FIXED = before;
  }
  const byId = async (id: string) => (await store.list("cryptoDeposits")).find((d) => d.id === id)!;
  const valued = await byId("co-unrated");
  assert.equal(valued.receipt?.amountEur, 100);
  assert.equal(valued.receipt?.rateAsOf, "2026-10-06", "the fixing of the day it arrived");
  assert.equal((await byId("co-unrated-converted")).receipt, undefined, "its proceeds already are the payment");
  assert.equal((await byId("co-unrated-no-time")).receipt, undefined, "no block time, no day to value it at");
  for (const id of ["co-unrated-intent", "co-unrated-partial", "co-unrated-unconfirmed"]) {
    assert.equal((await byId(id)).receipt, undefined, `${id} may have converted already`);
  }
  const paidInv = (await store.findInvoice("inv_co_unrated"))!;
  assert.equal(paidInv.state, "PAID", "the valued payment covers the invoice");
  assert.deepEqual(paidInv.settlements!.map((s) => [s.ref, s.amountEur]), [["deposit:co-unrated-inv", 100]], "rewritten in place, not a second payment");
  await writeStatementLines();
  const line = (await store.ledgerOf("org_co")).find((e) => e.statement?.key === "deposit:co-unrated:held");
  assert.equal(line?.statement?.amountCents, 10000, "the books get the receipt they lacked");
  assert.equal(line?.txType, "transfer_in", "nobody invoiced it");
  assert.equal(line?.accountCode, "4100");

  // Tied to an invoice afterwards: the line becomes that invoice's payment and is re-coded by the rules.
  await store.addInvoice({
    id: "inv_co_late", orgId: "org_co", direction: "outgoing", state: "SUBMITTED", linkTokenHash: "a".repeat(32),
    lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", amount: "100.00" }], currency: "EUR", total: "100.00",
    createdByMemberId: "m_x", createdAt: at, updatedAt: at,
    issued: { number: "RE-LATE", issueDate: at.slice(0, 10), netCents: 10000, vatCents: 0, grossCents: 10000, currency: "EUR" },
  } as any);
  await store.updateCryptoDeposit("co-unrated", { invoiceId: "inv_co_late" });
  await writeStatementLines();
  const linked = (await store.ledgerOf("org_co")).find((e) => e.statement?.key === "deposit:co-unrated:held")!;
  assert.equal(linked.txType, "invoice_payment");
  assert.equal(linked.accountCode, "4000", "re-coded as the payment it now is");
  assert.equal(linked.statement!.links.invoiceNumber, "RE-LATE");
  // A code a human set survives the next change of type.
  await store.updateLedgerEntry(linked.id, { accountCode: "4100", accountCodeAuto: false });
  await store.updateCryptoDeposit("co-unrated", { invoiceId: undefined });
  await writeStatementLines();
  const kept = (await store.ledgerOf("org_co")).find((e) => e.id === linked.id)!;
  assert.equal(kept.txType, "transfer_in");
  assert.equal(kept.accountCode, "4100");
  assert.equal(kept.accountCodeAuto, false);
});

await check("a SEPA credit to a person's Safe is booked under the user, on their personal books (unchanged)", async () => {
  const id = issue(addr("a"));
  assert.equal(await mirrorOrderById(id), "recorded");
  const r = (await recordOf(id))!;
  assert.equal(r.userId, "u_owner");
  assert.equal(r.accountId, undefined);
  await writeStatementLines();
  assert.ok(await lineOf("org_owner", id));
  assert.equal(await lineOf("org_co", id), undefined, "the owner's own money is not the company's");
});

await check("a SEPA credit to a sole trader's Safe is booked under the user, on the business's books (unchanged)", async () => {
  const id = issue(addr("b"));
  assert.equal(await mirrorOrderById(id), "recorded");
  assert.equal((await recordOf(id))!.userId, "u_st");
  // Two statement sweeps in parallel write what one does (§2, ledger).
  await Promise.all([writeStatementLines(), writeStatementLines()]);
  assert.equal((await store.ledgerOf("org_st")).filter((e) => e.statement?.links.orderId === id).length, 1, "one line, whichever sweep wrote it");
  assert.equal(await lineOf("org_st_personal", id), undefined);
});

console.log("\nA company's own Monerium keys");

await check("a SEPA credit seen only on the company's own keys gets its issue record, a sepa_in line with the bank facts, and the reconciler lists it", async () => {
  await store.updateOrganisation("org_co", { monerium: {
    clientId: "co-client", clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", "co-secret-placeholder"),
    profile: { id: "prof-co", state: "approved" }, connectedAt: now, checkedAt: now, connectedByMemberId: "m_co",
  } } as any);
  const id = issue(COMPANY_SAFE);
  coOrders.set(id, orders.get(id));
  orders.delete(id); // the app's keys never list it
  // The company's keys listing an order for someone else's Safe: not the company's to feed.
  const foreign = issue(addr("a"));
  coOrders.set(foreign, orders.get(foreign));
  orders.delete(foreign);
  await pollDepositsOnce();
  const r = (await recordOf(id))!;
  assert.equal(r?.accountId, "acc_co", "booked to the company's account");
  const line = await lineOf("org_co", id);
  assert.equal(line?.statement?.event, "sepa_in");
  assert.equal(line?.statement?.counterparty?.name, "Kunde GmbH");
  assert.equal(await store.isOrderProcessed(foreign), false, "an order for another Safe on the company's keys books nothing");
  assert.equal(await recordOf(foreign), undefined);
  // The reconciler sees the same order: no PHANTOM for it, and the foreign one is not reported as missed.
  const report = await reconcile();
  assert.ok(!report.findings.some((f) => f.orderId === id || f.orderId === foreign), JSON.stringify(report.findings.filter((f) => f.orderId === id || f.orderId === foreign)));
  await pollDepositsOnce(); // the poll re-sees it: still one record, one line
  assert.equal((await store.list("moneriumIssueOrders")).filter((o) => o.orderId === id).length, 1);
  assert.equal((await store.ledgerOf("org_co")).filter((e) => e.statement?.links.orderId === id).length, 1);
});

await check("a company deposit the poller never recorded is reported UNMIRRORED by the reconciler", async () => {
  const id = issue(COMPANY_SAFE);
  coOrders.set(id, orders.get(id));
  orders.delete(id);
  const report = await reconcile();
  assert.ok(report.findings.some((f) => f.kind === "UNMIRRORED" && f.orderId === id), JSON.stringify(report.findings));
  await pollDepositsOnce();
  assert.equal((await recordOf(id))?.accountId, "acc_co");
});

await check("a company's keys that fail are skipped; the other sources are still read", async () => {
  const { companyIssueOrders } = await import("../services/api/src/adapters/monerium-sandbox.js");
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => warned.push(String(m));
  try {
    assert.deepEqual(await companyIssueOrders(() => ({ orders: async () => { throw new Error("401"); } })), []);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warned.some((w) => w.includes("org_co")), warned.join(" | "));
});

await check("a company credit the scanner saw as a mint and the poller as an issue order is one sepa_in line, no eure_in", async () => {
  const { settleOnArrival } = await import("../services/api/src/adapters/crypto-deposits.js");
  const id = issue(COMPANY_SAFE, "33.00");
  coOrders.set(id, orders.get(id));
  orders.delete(id);
  const mint = await store.addCryptoDeposit({
    id: "co-mint", accountId: "acc_co", chainId: 31337, token: "EURE", txHash: `0x${"9a".repeat(32)}`, logIndex: 0,
    from: `0x${"0".repeat(40)}`, amountUnits: "33000000000000000000", amountEur: 33, creditedEur: 33, settlementAsset: "EURE",
    paymentAddress: COMPANY_SAFE, holding: "awaiting_approval", txs: [], arrivedAt: now, detectedAt: now, updatedAt: now,
  } as any);
  await settleOnArrival(mint);
  await pollDepositsOnce();
  const lines = (await store.ledgerOf("org_co")).filter((e) => e.statement?.links.orderId === id || e.statement?.links.depositId === "co-mint");
  assert.deepEqual(lines.map((e) => e.statement!.event), ["sepa_in"], JSON.stringify(lines.map((e) => e.statement)));
  assert.equal(lines[0].statement!.amountCents, 3300);
});

await check("a company invoice paid by bank with its number is settled when the credit lands on the company's Safe", async () => {
  const invoiceId = "inv_co_bank";
  await store.addInvoice({
    id: invoiceId, orgId: "org_co", direction: "outgoing", state: "SUBMITTED", linkTokenHash: "0".repeat(32),
    lines: [{ description: "Work", quantity: "1", unitPrice: "12.50", amount: "12.50" }],
    currency: "EUR", total: "12.50", createdByMemberId: "m_co", createdAt: now, updatedAt: now,
    issued: {
      number: "CO-2026-0042", issueDate: now.slice(0, 10), issuer: { name: "org_co" }, recipient: { name: "Kunde GmbH" },
      vatTreatment: { kind: "exempt", reason: "kleinunternehmer" }, netCents: 1250, vatCents: 0, grossCents: 1250,
      buckets: [{ rate: 0, netCents: 1250, vatCents: 0 }], currency: "EUR",
    },
  } as any);
  // The same number paid to the owner's personal Safe is the owner's money: it settles nothing.
  const personal = issue(addr("a"));
  orders.get(personal).memo = "CO-2026-0042";
  await pollDepositsOnce();
  assert.equal((await store.findInvoice(invoiceId))!.state, "SUBMITTED");
  const id = issue(COMPANY_SAFE);
  coOrders.set(id, { ...orders.get(id), memo: "Rechnung CO-2026-0042" });
  orders.delete(id);
  await pollDepositsOnce();
  const inv = (await store.findInvoice(invoiceId))!;
  assert.equal(inv.state, "PAID", JSON.stringify(inv.settlements));
  assert.equal(inv.settlements?.length, 1);
  assert.equal((inv.settlements![0] as any).matchedOn, "invoice-number");
  // A later number that reads alike ("CO/2026/0042"): the re-polled credit is
  // already on the paid invoice and pays no second one.
  await store.addInvoice({ ...(await store.findInvoice(invoiceId))!, id: "inv_co_alike", linkTokenHash: "1".repeat(32), state: "SUBMITTED", settlements: [], payment: undefined,
    issued: { ...(await store.findInvoice(invoiceId))!.issued!, number: "CO/2026/0042" } } as any);
  await pollDepositsOnce();
  assert.equal((await store.findInvoice("inv_co_alike"))!.state, "SUBMITTED", "one bank order pays one invoice");
  assert.equal(((await store.findInvoice("inv_co_alike"))!.settlements ?? []).length, 0);
  // A new credit quoting that number names both: left for a person, the paid one is not the excuse to pick the other.
  const again = issue(COMPANY_SAFE);
  coOrders.set(again, { ...orders.get(again), memo: "CO/2026/0042" });
  orders.delete(again);
  await pollDepositsOnce();
  assert.equal(((await store.findInvoice("inv_co_alike"))!.settlements ?? []).length, 0, "ambiguous over every issued number");
  assert.equal((await store.findInvoice(invoiceId))!.settlements?.length, 1);
});

await check("a company pay link's code in a credit to the company Safe pays the link and its invoice, and no other invoice the memo names", async () => {
  const invoice = (id: string, number: string, hash: string) => store.addInvoice({
    id, orgId: "org_co", direction: "outgoing", state: "SUBMITTED", linkTokenHash: hash,
    lines: [{ description: "Work", quantity: "1", unitPrice: "20.00", amount: "20.00" }],
    currency: "EUR", total: "20.00", createdByMemberId: "m_co", createdAt: now, updatedAt: now,
    issued: {
      number, issueDate: now.slice(0, 10), issuer: { name: "org_co" }, recipient: { name: "Kunde GmbH" },
      vatTreatment: { kind: "exempt", reason: "kleinunternehmer" }, netCents: 2000, vatCents: 0, grossCents: 2000,
      buckets: [{ rate: 0, netCents: 2000, vatCents: 0 }], currency: "EUR",
    },
  } as any);
  await invoice("inv_co_link", "CO-2026-0100", "2".repeat(32));
  await invoice("inv_co_other", "CO-2026-0200", "3".repeat(32));
  const code = "C0MPANYC0DE0001";
  await store.addPaymentRequest({
    id: "pr_co", code, userId: "u_owner", orgId: "org_co", accountId: "acc_co", handle: "org-co", amountEur: 20, currency: "EUR",
    methods: ["bank"], state: "OPEN", invoiceId: "inv_co_link", cryptoQuotes: [], payments: [], source: { kind: "app" },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now, updatedAt: now,
  } as any);
  // The same code paid into the creating member's own Safe is their money, not the company link's.
  const personal = issue(addr("a"), "20.00");
  orders.get(personal).memo = code;
  await pollDepositsOnce();
  assert.equal((await store.findPaymentRequest("pr_co"))!.state, "OPEN");
  // Paid to the company: the memo carries the link code AND another invoice's number.
  const id = issue(COMPANY_SAFE, "20.00");
  coOrders.set(id, { ...orders.get(id), memo: `${code} CO-2026-0200` });
  orders.delete(id);
  await pollDepositsOnce();
  await pollDepositsOnce(); // re-seen: the order is on the link's invoice, so it settles no other
  const link = (await store.findPaymentRequest("pr_co"))!;
  assert.equal(link.state, "PAID");
  assert.deepEqual(link.payments.map((p) => p.orderId), [id]);
  const paid = (await store.findInvoice("inv_co_link"))!;
  assert.equal(paid.state, "PAID");
  assert.deepEqual((paid.settlements ?? []).map((s: any) => s.matchedOn), ["payment-link"]);
  assert.equal(((await store.findInvoice("inv_co_other"))!.settlements ?? []).length, 0, "one bank order pays one invoice");
  assert.equal((await store.findInvoice("inv_co_other"))!.state, "SUBMITTED");
});

await check("the reconciler runs on company keys alone, and does not report a company credit on another chain or currency", async () => {
  const { MONERIUM } = await import("../services/api/src/config.js");
  const onOtherChain = issue(COMPANY_SAFE);
  coOrders.set(onOtherChain, { ...orders.get(onOtherChain), chain: "ethereum" });
  orders.delete(onOtherChain);
  const inGbp = issue(COMPANY_SAFE);
  coOrders.set(inGbp, { ...orders.get(inGbp), currency: "gbp" });
  orders.delete(inGbp);
  const missed = issue(COMPANY_SAFE);
  coOrders.set(missed, orders.get(missed));
  orders.delete(missed);
  const appId = MONERIUM.clientId;
  (MONERIUM as any).clientId = ""; // no app keys; no user has their own
  try {
    const report = await reconcile();
    assert.ok(report.findings.some((f) => f.kind === "UNMIRRORED" && f.orderId === missed), "company keys alone open the comparison");
    assert.ok(!report.findings.some((f) => f.orderId === onOtherChain || f.orderId === inGbp), JSON.stringify(report.findings));
  } finally {
    (MONERIUM as any).clientId = appId;
  }
  await pollDepositsOnce();
  assert.equal(await store.isOrderProcessed(onOtherChain), false);
  assert.equal(await store.isOrderProcessed(inGbp), false);
});

console.log("\nFail closed");

await check("a user's Safe that is also another org's account books nothing, and the reconciler reports it", async () => {
  const id = issue(addr("d"));
  assert.equal(await mirrorOrderById(id), "ignored");
  assert.equal(await store.isOrderProcessed(id), false);
  assert.equal(await recordOf(id), undefined);
  const report = await reconcile();
  assert.ok(report.findings.some((f) => f.kind === "UNMIRRORED" && f.orderId === id));
});

await check("two accounts at one address book nothing, by the webhook or the poller", async () => {
  if (!twinsPossible) {
    assert.equal((await store.accountsAtAddress(addr("e"))).length, 1, "Postgres refused the second company account at one Safe");
    return;
  }
  const id = issue(addr("e"));
  assert.equal(await mirrorOrderById(id), "ignored");
  await pollDepositsOnce();
  assert.equal(await store.isOrderProcessed(id), false);
  assert.equal(await recordOf(id), undefined, "keepIssueFacts refuses it too");
  assert.equal(await lineOf("org_twin_1", id), undefined);
  assert.equal(await lineOf("org_twin_2", id), undefined);
});

await check("an address no one holds is ignored and not reported", async () => {
  const id = issue(addr("f"));
  assert.equal(await mirrorOrderById(id), "ignored");
  const report = await reconcile();
  assert.equal(report.findings.some((f) => f.orderId === id), false);
});

console.log("\nIdempotency");

await check("a recorded company order delivered again is `duplicate`, and the poller books it once", async () => {
  const id = [...orders.keys()][0];
  assert.equal(await mirrorOrderById(id), "duplicate");
  await pollDepositsOnce();
  assert.equal((await store.list("moneriumIssueOrders")).filter((o) => o.orderId === id).length, 1);
  assert.equal((await store.ledgerOf("org_co")).filter((e) => e.statement?.links.orderId === id).length, 1);
});

// ── Restart and two-worker boundaries ────────────────────────────────────
// The deployment is one process writing one file store (single writer). Two
// workers here are two callers in that process (the poller and a webhook, or
// two deliveries); a restart is the store re-read from disk with fresh module
// state (a new instance of the adapter module), which is all a real restart
// keeps.

let generation = 0;
async function restart() {
  await initStore();
  generation++;
  return {
    sandbox: await import(`../services/api/src/adapters/monerium-sandbox.js?restart=${generation}`),
    connection: await import(`../services/api/src/adapters/monerium-connection.js?restart=${generation}`),
  };
}
const issueRecords = async (id: string) => (await store.list("moneriumIssueOrders")).filter((o) => o.orderId === id).length;
const releaseHeldOrders = () => { for (const r of stub.heldOrders.splice(0)) r(); };
const waitFor = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

console.log("\nIssue claims across workers and restarts");

await check("two webhook deliveries of one order at once: one upstream read, one booking", async () => {
  const id = issue(addr("a"));
  stub.lookups.clear();
  const outcomes = await Promise.all([mirrorOrderById(id), mirrorOrderById(id), mirrorOrderById(id)]);
  assert.equal(outcomes.filter((o) => o === "recorded").length, 1, outcomes.join(","));
  assert.ok(outcomes.every((o) => o === "recorded" || o === "unavailable" || o === "duplicate"), outcomes.join(","));
  assert.equal(stub.lookups.get(id), 1, "concurrent deliveries share one upstream read");
  assert.equal(await issueRecords(id), 1);
});

await check("a webhook and the poller on one order at once book it once", async () => {
  const id = issue(addr("a"));
  await Promise.all([mirrorOrderById(id), pollDepositsOnce(), mirrorOrderById(id)]);
  assert.ok(await store.isOrderProcessed(id));
  assert.equal(await issueRecords(id), 1);
  await writeStatementLines();
  assert.equal((await store.ledgerOf("org_owner")).filter((e) => e.statement?.links.orderId === id).length, 1);
});

await check("restart after the order was marked processed, before its issue record: the poller adds the record once", async () => {
  const id = issue(addr("a"));
  await store.markOrderProcessed(id); // the crash lands between the two writes
  const { sandbox } = await restart();
  assert.equal(await issueRecords(id), 0);
  assert.equal(await sandbox.mirrorOrderById(id), "duplicate", "a redelivery does not book it again");
  await sandbox.pollDepositsOnce();
  await sandbox.pollDepositsOnce();
  assert.equal(await issueRecords(id), 1);
});

await check("restart while a worker holds the claim: the new process books it once, the old worker's late finish adds nothing", async () => {
  const id = issue(addr("a"));
  stub.holdOrders = 1;
  const stuck = mirrorOrderById(id); // the old process, stopped mid-read
  await waitFor(() => stub.heldOrders.length === 1, "the held read");
  const { sandbox } = await restart();
  assert.equal(await sandbox.mirrorOrderById(id), "recorded");
  releaseHeldOrders();
  assert.ok(["duplicate", "unavailable"].includes(await stuck), "the stale worker does not record");
  assert.equal(await issueRecords(id), 1);
  assert.equal((await store.mirroredOrderIds()).filter((x) => x === id).length, 1);
});

await check("restart before the claim: nothing was written, the redelivery books it", async () => {
  const id = issue(addr("a"));
  const { sandbox } = await restart();
  assert.equal(await sandbox.mirrorOrderById(id), "recorded");
  assert.equal(await mirrorOrderById(id), "duplicate");
  assert.equal(await issueRecords(id), 1);
});

console.log("\nIssue amounts and states from upstream");

await check("an issue order with an amount that is not a euro decimal is not booked, and the reconciler reports it", async () => {
  for (const amount of ["0x10", "Infinity", "1e3", "12.505", "-5", " 12.50", "12,50", "", "NaN"]) {
    const id = issue(addr("a"), amount);
    assert.equal(await mirrorOrderById(id), "ignored", `amount ${JSON.stringify(amount)}`);
    assert.equal(await store.isOrderProcessed(id), false, `amount ${JSON.stringify(amount)}`);
    assert.equal(await issueRecords(id), 0, `amount ${JSON.stringify(amount)}`);
    orders.delete(id);
  }
  for (const amount of ["12.5", "12.50", "1000", "12.500000"]) {
    const id = issue(addr("a"), amount);
    assert.equal(await mirrorOrderById(id), "recorded", `amount ${amount}`);
    assert.equal((await recordOf(id))!.amountEur, Number(amount));
  }
});

await check("an issue order whose amount is not a euro decimal settles no invoice and no payment link", async () => {
  const number = `RE-2026-${9000 + ++n}`;
  const invoiceId = `inv_0x10_${n}`;
  await store.addInvoice({
    id: invoiceId, orgId: "org_owner", direction: "outgoing", state: "SUBMITTED", linkTokenHash: `h${n}`,
    lines: [{ description: "Work", quantity: "1", unitPrice: "16.00", amount: "16.00" }], currency: "EUR", total: "16.00",
    createdByMemberId: "m", createdAt: now, updatedAt: now,
    issued: { number, issueDate: now.slice(0, 10), issuer: { name: "u_owner" }, recipient: { name: "Kunde" }, vatTreatment: { kind: "exempt", reason: "kleinunternehmer" },
      netCents: 1600, vatCents: 0, grossCents: 1600, buckets: [{ rate: 0, netCents: 1600, vatCents: 0 }], currency: "EUR" },
  } as any);
  const code = "0X10ABCDEFGH234";
  const linkId = `pr_0x10_${n}`;
  await store.addPaymentRequest({
    id: linkId, code, userId: "u_owner", handle: "owner", amountEur: 16, currency: "EUR", methods: ["bank"], state: "OPEN",
    payments: [], createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  } as any);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const amount of ["0x10", "1.6e1", "Infinity"]) {
      const id = issue(addr("a"), amount);
      orders.get(id).memo = `${number} ${code}`;
      await pollDepositsOnce();
      orders.delete(id);
      assert.equal(await issueRecords(id), 0, amount);
      const inv = (await store.findInvoice(invoiceId))!;
      assert.equal(inv.state, "SUBMITTED", `${amount}: the invoice is not marked paid`);
      assert.equal((inv.settlements ?? []).length, 0, `${amount}: no settlement on the invoice`);
      const link = (await store.findPaymentRequest(linkId))!;
      assert.equal(link.state, "OPEN", `${amount}: the link is not marked paid`);
      assert.equal(link.payments.length, 0, `${amount}: no payment on the link`);
    }
  } finally {
    console.warn = realWarn;
    await store.updatePaymentRequest(linkId, { state: "CANCELLED" });
  }
});

await check("an issue order in a state other than processed is not booked", async () => {
  for (const state of ["pending", "placed", "rejected", "PROCESSED", "processed ", "unknown"]) {
    const id = issue(addr("a"));
    orders.get(id).meta.state = state;
    assert.equal(await mirrorOrderById(id), "ignored", state);
    assert.equal(await issueRecords(id), 0, state);
    orders.delete(id);
  }
});

await check("an order read answered with nothing usable leaves the delivery unresolved; only a 404 settles it", async () => {
  const id = issue(addr("a"));
  const cases: [number, string, string][] = [
    [401, '{"code":401}', "unavailable"],
    [403, '{"code":403}', "unavailable"],
    [409, '{"code":409}', "unavailable"],
    [429, '{"code":429}', "unavailable"],
    [500, "oops", "unavailable"],
    [503, "", "unavailable"],
    [200, "", "unavailable"],
    [200, "<html>proxy</html>", "unavailable"],
    [200, JSON.stringify({ ...orders.get(id), id: "ord-someone-else" }), "unavailable"],
    [200, JSON.stringify({ ...orders.get(id), filler: "x".repeat(20 * 1024 * 1024) }), "unavailable"],
  ];
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [status, raw, want] of cases) {
      stub.orderAnswer.set(id, { status, raw });
      assert.equal(await mirrorOrderById(id), want, `HTTP ${status} ${raw.slice(0, 30)}`);
      assert.equal(await store.isOrderProcessed(id), false);
    }
    stub.orderAnswer.set(id, { status: 404, raw: '{"code":404}' });
    assert.equal(await mirrorOrderById(`${id}`), "ignored", "a 404 is Monerium's answer");
  } finally {
    stub.orderAnswer.delete(id);
    console.warn = realWarn;
  }
  assert.equal(await issueRecords(id), 0);
});

await check("a body that starts with a UTF-8 byte-order mark reads as Response.text() does", async () => {
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"id":"ord-bom"}')]);
  const text = await moneriumText(new Response(body));
  assert.equal(text, await new Response(body).text());
  assert.equal(JSON.parse(text).id, "ord-bom");
});

await check("an oversized 401 or 403 keeps its status, so the refusal stays definite", async () => {
  const client = new MoneriumClient({ baseUrl: process.env.MONERIUM_BASE_URL!, clientId: "app-client", clientSecret: "app-secret-0001" });
  const id = `ord-big-refusal-${++n}`;
  try {
    for (const status of [401, 403]) {
      stub.orderAnswer.set(id, { status, raw: JSON.stringify({ pad: "x".repeat(20 * 1024 * 1024) }) });
      const err: any = await client.getOrder(id).then(() => undefined, (e) => e);
      assert.equal(err?.name, "MoneriumApiError", String(err));
      assert.equal(err.status, status);
    }
  } finally {
    stub.orderAnswer.delete(id);
  }
});

await check("an app client without a secret refuses before any request", async () => {
  const before = stub.bearers.length;
  const lookupsBefore = [...stub.lookups.values()].reduce((a, b) => a + b, 0);
  const client = new MoneriumClient({ baseUrl: process.env.MONERIUM_BASE_URL!, clientId: "app-client" });
  await assert.rejects(client.getOrder("ord-x"), /MONERIUM_CLIENT_SECRET is required/);
  assert.equal(stub.bearers.length, before);
  assert.equal([...stub.lookups.values()].reduce((a, b) => a + b, 0), lookupsBefore);
});

await check("pagination: an order Monerium lists on no page the poller reads is never invented (todo: follow pages once the live contract is known)", async () => {
  // Monerium's /orders answer documents no paging fields; the poller books
  // what the one page lists and nothing else. A deposit past it is booked by
  // its webhook (re-read by id), not guessed.
  const id = `ord-unlisted-${++n}`;
  const order = { id, kind: "issue", address: addr("a"), chain: "base", currency: "eur", amount: "3.00", meta: { state: "processed", placedAt: now } };
  stub.orderAnswer.set(id, { status: 200, raw: JSON.stringify(order) });
  try {
    await pollDepositsOnce();
    assert.equal(await store.isOrderProcessed(id), false, "not on the list, not booked by the poller");
    assert.equal(await mirrorOrderById(id), "recorded", "the webhook's re-read books it");
    assert.equal(await issueRecords(id), 1);
  } finally {
    stub.orderAnswer.delete(id);
  }
});

console.log("\nThe webhook body never sets money state");

const WEBHOOK_SECRET = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
const hookApp = express();
hookApp.use(express.json({ limit: SECURITY.jsonBodyLimit, verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
hookApp.use("/api", createMoneriumWebhookRouter());
const hookServer = hookApp.listen(0, "127.0.0.1");
await new Promise<void>((r) => hookServer.once("listening", () => r()));
const HOOK = `http://127.0.0.1:${(hookServer.address() as any).port}/api/webhooks/monerium`;
const post = (raw: string, headers: Record<string, string> = {}) =>
  fetch(HOOK, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
const signed = (raw: string, id = `msg_${Math.random().toString(36).slice(2)}`, ts = String(Math.floor(Date.now() / 1000))) => ({
  "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signStandardWebhook(id, ts, Buffer.from(raw), WEBHOOK_SECRET),
});
const moneyState = async () => JSON.stringify([(await store.list("moneriumIssueOrders")).length, (await store.list("transfers")).map((t) => [t.id, t.state])]);
let seed = 0x2366;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const randomId = () => pick([
  () => `ord-${Math.floor(rand() * 1e9).toString(36)}`,
  () => "../auth/context",
  () => "ord?x=1#y",
  () => "x".repeat(129),
  () => "ünïcödé",
  () => "",
  () => String(Math.floor(rand() * 1e6)),
])();

await check("200 fuzzed unsigned bodies with forged amounts, addresses and states book nothing", async () => {
  const pendingId = issue(addr("a"));
  orders.get(pendingId).meta.state = "pending"; // known to Monerium, not settled
  const before = await moneyState();
  for (let i = 0; i < 200; i++) {
    const id = pick([randomId(), pendingId, pendingId]);
    const forged = { amount: pick(["999999", "12.50", -1]), address: pick([addr("a"), addr("c"), "0x0"]), chain: "base", currency: "eur", kind: "issue", state: "processed", meta: { state: "processed" } };
    const body = pick([
      { data: { id, ...forged } },
      { order: { id, ...forged } },
      { id, ...forged },
      { data: { id: { id } } },
      { data: { id: [id] } },
      [id],
      null,
    ]);
    const res = await post(JSON.stringify(body));
    assert.ok([200, 400, 503].includes(res.status), `status ${res.status}`);
  }
  assert.equal(await moneyState(), before, "no issue record and no transfer state changed");
  assert.equal(await store.isOrderProcessed(pendingId), false);
  orders.delete(pendingId);
});

await check("a forged body naming a real processed order books Monerium's amount and holder, not the body's", async () => {
  const id = issue(addr("a"), "7.25");
  const res = await post(JSON.stringify({ data: { id, amount: "999999", address: COMPANY_SAFE } }));
  assert.equal(res.status, 200);
  assert.equal((await recordOf(id))!.amountEur, 7.25);
  assert.equal((await recordOf(id))!.userId, "u_owner");
});

await check("empty, non-JSON, wrong-type and oversized bodies change nothing and read nothing upstream", async () => {
  const before = await moneyState();
  const lookups = [...stub.lookups.values()].reduce((a, b) => a + b, 0);
  const answers = [
    await post(""),
    await post("not json"),
    await post("{\"data\":"),
    await fetch(HOOK, { method: "POST", headers: { "content-type": "text/plain" }, body: "ord-1" }),
    await post(JSON.stringify({ data: { id: "ord-x" }, pad: "x".repeat(200 * 1024) })),
  ];
  assert.deepEqual(answers.map((r) => r.status >= 400 || r.status === 200), answers.map(() => true));
  assert.equal(answers[4].status, 413, "past the JSON body limit");
  assert.equal(await moneyState(), before);
  assert.equal([...stub.lookups.values()].reduce((a, b) => a + b, 0), lookups, "no upstream read");
});

console.log("\nWebhook lookup cost");

await check("one unknown id delivered 50 times at once and 50 more after costs one upstream read", async () => {
  const id = `ord-unknown-${++n}`;
  stub.orderDelayMs = 30;
  try {
    await Promise.all(Array.from({ length: 50 }, () => post(JSON.stringify({ data: { id } }))));
  } finally {
    stub.orderDelayMs = 0;
  }
  for (let i = 0; i < 50; i++) await post(JSON.stringify({ data: { id } }));
  assert.equal(stub.lookups.get(id), 1);
});

await check("many distinct unknown ids at once: upstream reads in flight stay bounded and the rest are told to retry", async () => {
  stub.maxInFlight = 0;
  stub.orderDelayMs = 50;
  let answers: Response[];
  try {
    answers = await Promise.all(Array.from({ length: 120 }, (_, i) => post(JSON.stringify({ data: { id: `ord-flood-${n}-${i}` } }))));
  } finally {
    stub.orderDelayMs = 0;
  }
  assert.ok(stub.maxInFlight <= 16, `upstream reads in flight: ${stub.maxInFlight}`);
  const retry = answers.filter((r) => r.status === 503).length;
  assert.ok(retry > 0, "past the bound a delivery is answered 503, which Monerium retries");
  assert.equal(answers.filter((r) => r.status !== 503 && r.status !== 200).length, 0);
});

await check("the remembered unknown ids are capped: past the cap the oldest is read again", async () => {
  const first = `ord-cap-${++n}-0`;
  await mirrorOrderById(first);
  for (let i = 1; i <= 1000; i++) await mirrorOrderById(`ord-cap-${n}-${i}`);
  await mirrorOrderById(first);
  assert.equal(stub.lookups.get(first), 2, "evicted, so read again rather than remembered without bound");
  const recent = `ord-cap-${n}-1000`;
  await mirrorOrderById(recent);
  assert.equal(stub.lookups.get(recent), 1, "a recently remembered id costs no second read");
});

await check("an unsigned delivery's webhook-id is not stored; an unknown id answered 404 is remembered instead", async () => {
  for (let i = 0; i < 20; i++) {
    const res = await post(JSON.stringify({ data: { id: `ord-nobody-${n}-${i}` } }), { "webhook-id": `msg_forged_${n}_${i}` });
    assert.equal(res.status, 200);
    assert.equal(await store.isWebhookProcessed(`msg_forged_${n}_${i}`), false, "an id nobody signed costs no store write");
  }
});

await check("with MONERIUM_WEBHOOK_SECRET: a missing, wrong or stale signature is 401 with no upstream read; a valid one is read, its id spent", async () => {
  SECURITY.moneriumWebhookSecret = WEBHOOK_SECRET;
  try {
    const id = issue(addr("a"), "4.00");
    const raw = JSON.stringify({ data: { id } });
    const lookups = stub.lookups.get(id) ?? 0;
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const bad = [
      {},
      { ...signed(raw), "webhook-signature": "v1,AAAA" },
      signed(raw, "msg_stale", stale),
      signed(JSON.stringify({ data: { id, amount: "1" } })), // signature over another body
      { ...signed(raw), "webhook-id": "msg_swapped" },
    ];
    for (const headers of bad) assert.equal((await post(raw, headers)).status, 401, JSON.stringify(Object.keys(headers)));
    assert.equal(stub.lookups.get(id) ?? 0, lookups, "no read for an unauthenticated delivery");
    assert.equal(await issueRecords(id), 0);
    const good = signed(raw, "msg_good_236");
    assert.equal((await post(raw, good)).status, 200);
    assert.equal((await recordOf(id))!.amountEur, 4);
    assert.ok(await store.isWebhookProcessed("msg_good_236"));
    const again = await (await post(raw, signed(raw, "msg_good_236"))).json();
    assert.equal(again.duplicate, true);
  } finally {
    SECURITY.moneriumWebhookSecret = "";
  }
});

console.log("\nRedeem orders against the persisted transfer");

const PAYEE_IBAN = "DE89370400440532013000";
let tn = 0;
/** A SEPA transfer whose redeem was placed: what executeSepaTransfer leaves. */
async function placedRedeem(amount = "20.00", state = "PAYOUT_SUBMITTED", memoFor: (id: string) => string = (id) => paymentMemo(id, `RE-${tn}`)) {
  const id = `t_redeem_${++tn}`;
  const orderId = `ord-redeem-${tn}`;
  const memo = memoFor(id);
  await store.addTransfer({
    id, userId: "u_owner", rail: "sepa", state, sendEur: Number(amount), receiveEur: Number(amount),
    recipientName: "Supplier GmbH", recipientIban: PAYEE_IBAN, reference: `RE-${tn}`, txs: [{ step: "monerium.redeem.placed", hash: orderId }],
    moneriumRedeem: { amount, iban: PAYEE_IBAN, issuedAt: now, message: `Send EUR ${amount} to ${PAYEE_IBAN} at ${now}`, memo },
    sepa: { mode: "sandbox", orderId, state: "placed" }, createdAt: now, updatedAt: now,
  } as any);
  orders.set(orderId, {
    id: orderId, kind: "redeem", address: addr("a"), chain: "base", currency: "eur", amount,
    counterpart: { identifier: { standard: "iban", iban: PAYEE_IBAN }, details: { firstName: "Supplier", lastName: "GmbH" } },
    meta: { state: "processed", placedAt: now, processedAt: now }, memo,
  });
  return { id, orderId };
}
const stateOf = async (id: string) => (await store.findTransfer(id))!.state;

await check("an older transfer that signed the full-id memo is PAID when Monerium echoes that memo", async () => {
  // Older releases wrote the whole transfer id when the reference was blank;
  // paymentMemo now writes eight characters. The stored memo is what was signed.
  const { id } = await placedRedeem("20.00", "PAYOUT_SUBMITTED", (tid) => `Powered by Zold ${tid}`);
  assert.notEqual((await store.findTransfer(id))!.moneriumRedeem!.memo, paymentMemo(id, (await store.findTransfer(id))!.reference));
  await pollRedeemOrdersOnce();
  assert.equal(await stateOf(id), "PAID");
});

await check("a processed redeem whose answer carries no memo, or another transfer's, goes to review, never PAID", async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [what, change, why] of [
      ["no memo", (o: any) => { delete o.memo; }, /carries none/],
      ["empty memo", (o: any) => { o.memo = ""; }, /carries none/],
      ["another transfer's memo", (o: any) => { o.memo = paymentMemo("t_other_transfer", `RE-${tn}`); }, /payment memo/],
    ] as const) {
      const { id, orderId } = await placedRedeem();
      change(orders.get(orderId));
      await pollRedeemOrdersOnce();
      const t = (await store.findTransfer(id))!;
      assert.equal(t.state, "MANUAL_REVIEW", what);
      assert.match(t.error ?? "", why, what);
      assert.equal(t.sepa!.state, "mismatch", `${what}: no payout evidence`);
      assert.deepEqual(payoutEvidence(t), [], what);
    }
  } finally {
    console.warn = realWarn;
  }
});

await check("a processed redeem that matches the transfer is PAID once, by two pollers at once and after a restart", async () => {
  const { id } = await placedRedeem();
  const update = store.updateTransfer;
  let paidWrites = 0;
  store.updateTransfer = (tid, patch) => {
    if (tid === id && patch.state === "PAID") paidWrites++;
    return update.call(store, tid, patch);
  };
  // The poller writes PAID with the sepa sub-record in one patch.
  const patchSub = store.patchTransferSub;
  store.patchTransferSub = ((tid: string, key: any, fn: any, patch?: any) => {
    if (tid === id && patch?.state === "PAID") paidWrites++;
    return patchSub.call(store, tid, key, fn, patch);
  }) as typeof patchSub;
  try {
    await Promise.all([pollRedeemOrdersOnce(), pollRedeemOrdersOnce()]);
    assert.equal(await stateOf(id), "PAID");
    const { sandbox } = await restart();
    await sandbox.pollRedeemOrdersOnce();
  } finally {
    store.updateTransfer = update;
    store.patchTransferSub = patchSub;
  }
  assert.equal(paidWrites, 1, "PAID is written once");
  await writeStatementLines();
  assert.equal(await stateOf(id), "PAID");
  assert.equal((await store.ledgerOf("org_owner")).filter((e) => e.statement?.links.transferId === id).length, 1, "one statement line");
});

await check("a processed or rejected redeem whose amount, IBAN, kind, currency or Safe differs is neither PAID nor FAILED", async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const variants: [string, (o: any) => void][] = [
      ["amount", (o) => { o.amount = "2000.00"; }],
      ["iban", (o) => { o.counterpart.identifier.iban = "GB33BUKB20201555555555"; }],
      ["no iban", (o) => { delete o.counterpart; }],
      ["kind", (o) => { o.kind = "issue"; }],
      ["currency", (o) => { o.currency = "usd"; }],
      ["address", (o) => { o.address = addr("c"); }],
      ["chain", (o) => { o.chain = "ethereum"; }],
      ["memo", (o) => { o.memo = "another payment"; }],
    ];
    for (const final of ["processed", "rejected"]) {
      for (const [what, change] of variants) {
        const { id, orderId } = await placedRedeem();
        change(orders.get(orderId));
        orders.get(orderId).meta.state = final;
        await pollRedeemOrdersOnce();
        const t = (await store.findTransfer(id))!;
        assert.ok(t.state !== "PAID" && t.state !== "FAILED", `${final} with a different ${what}: ${t.state}`);
        assert.equal(t.state, "MANUAL_REVIEW", `${final} with a different ${what} goes to review`);
        assert.match(t.error ?? "", /does not match/, what);
      }
    }
  } finally {
    console.warn = realWarn;
  }
});

await check("a mismatched redeem whose stored state already reads processed is no payout evidence", async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const start of ["PAYOUT_SUBMITTED", "MANUAL_REVIEW"]) {
      const { id, orderId } = await placedRedeem("20.00", start);
      // executeSepaTransfer copies the state of Monerium's first answer, which can be processed.
      await store.updateTransfer(id, { sepa: { ...(await store.findTransfer(id))!.sepa!, state: "processed" } });
      orders.get(orderId).amount = "2000.00";
      await pollRedeemOrdersOnce();
      const t = (await store.findTransfer(id))!;
      assert.equal(t.state, "MANUAL_REVIEW", start);
      assert.deepEqual(payoutEvidence(t), [], `${start}: a mismatched order cannot be cited as paid`);
      await pollRedeemOrdersOnce();
      assert.deepEqual(payoutEvidence((await store.findTransfer(id))!), [], `${start}: nor after a second pass`);
    }
  } finally {
    console.warn = realWarn;
  }
});

await check("a redeem read that is not this order (empty, another id, non-JSON, oversized) or fails (401/409/429/5xx) changes nothing", async () => {
  const { id, orderId } = await placedRedeem();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [status, raw] of [
      [200, ""], [200, JSON.stringify({ ...orders.get(orderId), id: "ord-other" })], [200, "<html/>"],
      [200, JSON.stringify({ ...orders.get(orderId), pad: "x".repeat(20 * 1024 * 1024) })],
      [401, "{}"], [409, "{}"], [429, "{}"], [500, "{}"], [503, ""],
    ] as [number, string][]) {
      stub.orderAnswer.set(orderId, { status, raw });
      await pollRedeemOrdersOnce();
      const t = (await store.findTransfer(id))!;
      assert.equal(t.state, "PAYOUT_SUBMITTED", `HTTP ${status} ${raw.slice(0, 20)}`);
      assert.equal(t.sepa!.state, "placed", `HTTP ${status} ${raw.slice(0, 20)}: the stored order state is not overwritten`);
    }
  } finally {
    stub.orderAnswer.delete(orderId);
    console.warn = realWarn;
  }
});

await check("a redeem in a state Monerium did not document halts: not PAID, not FAILED, no refund", async () => {
  const { id, orderId } = await placedRedeem();
  orders.get(orderId).meta.state = "on_hold_new_state";
  await pollRedeemOrdersOnce();
  assert.equal(await stateOf(id), "PAYOUT_SUBMITTED");
  assert.equal((await store.findTransfer(id))!.refund, undefined);
});

console.log("\nOAuth token refresh across workers and restarts");

const { moneriumAccessToken, moneriumClientFor } = await import("../services/api/src/adapters/monerium-connection.js");
const past = () => new Date(Date.now() - 3_600_000).toISOString();
await user("u_oauth", addr("9"));
await store.updateUser("u_oauth", {
  monerium: {
    connectedAt: now, method: "oauth", profileId: "profile-oauth",
    accessTokenEnc: SECRETS.moneriumAccessToken.seal("u_oauth", "at-0"),
    refreshTokenEnc: SECRETS.moneriumRefreshToken.seal("u_oauth", "rt-0"),
    expiresAt: past(),
  } as any,
});
const oauthUser = async () => (await store.findUser("u_oauth"))!;
const expire = async () => store.updateUser("u_oauth", { monerium: { ...(await oauthUser()).monerium!, expiresAt: past() } });
/** The refresh token as it is stored right now: db.json on disk, or the
 *  committed row on Postgres (STORE_BACKEND=postgres, check:pg). The read
 *  starts when this is called. */
const refreshOnDisk = async () => {
  const row = process.env.STORE_BACKEND === "postgres"
    ? await store.findUser("u_oauth")
    : JSON.parse(readFileSync(process.env.TRANSF_DB_PATH!, "utf8")).users.find((u: any) => u.id === "u_oauth");
  return SECRETS.moneriumRefreshToken.open("u_oauth", row!.monerium!.refreshTokenEnc!);
};

await check("two workers inside the refresh window spend the refresh token once and get the same new token", async () => {
  const presented = stub.refresh.presented.length;
  const [u1, u2, u3] = [await oauthUser(), await oauthUser(), await oauthUser()];
  const [a, b, c] = await Promise.all([moneriumAccessToken(u1), moneriumAccessToken(u2), moneriumAccessToken(u3)]);
  assert.equal(stub.refresh.presented.length - presented, 1, "one refresh grant");
  assert.deepEqual([a, b, c], ["at-1", "at-1", "at-1"]);
  assert.equal(await refreshOnDisk(), "rt-1");
});

await check("the rotated refresh token is on disk before the new access token is used", async () => {
  await expire();
  const seenOnDisk: Promise<string>[] = [];
  stub.onBearer = (token) => { if (token === "at-2") seenOnDisk.push(refreshOnDisk()); };
  try {
    await moneriumClientFor(await oauthUser()).ibans();
  } finally {
    stub.onBearer = undefined;
  }
  assert.deepEqual(await Promise.all(seenOnDisk), ["rt-2"]);
});

await check("after a restart the fresh process refreshes with the persisted token and never presents a spent one", async () => {
  await expire();
  const { connection } = await restart();
  assert.equal(await connection.moneriumAccessToken((await store.findUser("u_oauth"))!), "at-3");
  assert.equal(await refreshOnDisk(), "rt-3");
  assert.equal(stub.refresh.spentPresented, 0);
});

await check("restart mid-refresh: the new process's refresh wins, the old one's late answer writes nothing", async () => {
  await expire();
  stub.refresh.hold = 1;
  const old = moneriumAccessToken(await oauthUser()); // the old process, its grant in flight
  await waitFor(() => stub.refresh.held.length === 1, "the held refresh");
  const { connection } = await restart();
  assert.equal(await connection.moneriumAccessToken((await store.findUser("u_oauth"))!), "at-4");
  for (const r of stub.refresh.held.splice(0)) r();
  await assert.rejects(old, (e: any) => e?.name === "MoneriumAccessError", "the spent token is refused, not retried");
  assert.equal(await refreshOnDisk(), "rt-4", "the new process's tokens stay");
  assert.equal(SECRETS.moneriumAccessToken.open("u_oauth", (await oauthUser()).monerium!.accessTokenEnc!), "at-4");
});

await check("a refresh answer lost after Monerium rotated: the next refresh is refused, nothing falls back to the old token or the app", async () => {
  await expire();
  stub.refresh.loseNext = true;
  await assert.rejects(moneriumAccessToken(await oauthUser()), (e: any) => e?.name !== "MoneriumAccessError", "a lost answer is a transient");
  assert.equal(await refreshOnDisk(), "rt-4", "nothing written");
  const bearers = stub.bearers.length;
  await assert.rejects(moneriumClientFor(await oauthUser()).ibans(), (e: any) => e?.name === "MoneriumAccessError");
  assert.equal(stub.bearers.length, bearers, "no request went out on the expired token or the app's");
});

await check("disconnected while the refresh was in flight: the late answer does not reconnect the account", async () => {
  await store.updateUser("u_oauth", {
    monerium: { ...(await oauthUser()).monerium!, refreshTokenEnc: SECRETS.moneriumRefreshToken.seal("u_oauth", stub.refresh.current), expiresAt: past() },
  });
  stub.refresh.hold = 1;
  const p = moneriumAccessToken(await oauthUser());
  await waitFor(() => stub.refresh.held.length === 1, "the held refresh");
  await store.updateUser("u_oauth", { monerium: undefined });
  for (const r of stub.refresh.held.splice(0)) r();
  await assert.rejects(p, (e: any) => e?.name === "MoneriumAccessError");
  assert.equal((await oauthUser()).monerium, undefined);
});

hookServer.close();
monerium.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
