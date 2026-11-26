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
        : send(200, { access_token: "tok-app", token_type: "Bearer", expires_in: 3600 });
    });
    return;
  }
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (bearer) { stub.bearers.push(bearer); stub.onBearer?.(bearer); }
  if (url.pathname === "/tokens") {
    return send(200, [{ kind: "evm", currency: "eur", symbol: "EURe", chain: "base", chainId: 84532, decimals: 18, address: "0x00000000000000000000000000000000000000e0" }]);
  }
  if (url.pathname === "/orders") return send(200, { orders: [...orders.values()] });
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
const dbm = await import("../services/api/src/store/db.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
const addr = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;

function org(id: string, type: "personal" | "business", entity?: "company" | "sole_trader") {
  store.addOrganisation({ id, type, ...(entity ? { entity } : {}), name: id, reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
}
function account(id: string, orgId: string, address: `0x${string}`, backingUserId?: string) {
  store.addAccount({
    id, orgId, currency: "EUR", label: "EUR account", status: backingUserId ? "active" : "gated", provider: "monerium" as any,
    identifier: {}, address, ...(backingUserId ? { backingUserId, backedSince: "2026-01-01T00:00:00.000Z" } : {}), createdAt: now, updatedAt: now,
  } as any);
}
function user(id: string, address: `0x${string}`) {
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", address, iban: "" } as any);
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
const recordOf = (orderId: string) => store.moneriumIssueOrders.find((o) => o.orderId === orderId);
const lineOf = (orgId: string, orderId: string) => store.ledgerOf(orgId).find((e) => e.statement?.links.orderId === orderId);

// A company with its own Safe (no backing user), and its owner's personal Safe.
const COMPANY_SAFE = addr("c");
org("org_co", "business", "company");
account("acc_co", "org_co", COMPANY_SAFE);
user("u_owner", addr("a"));
org("org_owner", "personal");
account("acc_owner", "org_owner", addr("a"), "u_owner");
// A sole trader: the person's Safe backs both their personal and business accounts.
user("u_st", addr("b"));
org("org_st_personal", "personal");
account("acc_st_personal", "org_st_personal", addr("b"), "u_st");
org("org_st", "business", "sole_trader");
account("acc_st", "org_st", addr("b"), "u_st");
// Ambiguous: a user's Safe that is also a company's account; two company accounts on one address.
user("u_clash", addr("d"));
org("org_clash", "business", "company");
account("acc_clash", "org_clash", addr("d"));
org("org_twin_1", "business", "company");
org("org_twin_2", "business", "company");
account("acc_twin_1", "org_twin_1", addr("e"));
account("acc_twin_2", "org_twin_2", addr("e"));

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
  assert.equal(store.isOrderProcessed(id), false);
  orders.delete(id);
});

console.log("\nBooked to the holder");

await check("a SEPA credit to a company's own Safe is booked to the company's account and books, not a person", async () => {
  const id = issue(COMPANY_SAFE.toUpperCase().replace("0X", "0x"));
  assert.equal(await mirrorOrderById(id), "recorded");
  assert.ok(store.isOrderProcessed(id));
  const r = recordOf(id)!;
  assert.equal(r.accountId, "acc_co");
  assert.equal(r.userId, undefined, "no person's record");
  writeStatementLines();
  const line = lineOf("org_co", id);
  assert.ok(line, "the company's books have the line");
  assert.equal(line!.statement!.event, "sepa_in");
  assert.equal(line!.statement!.amountCents, 1250);
  assert.equal(line!.source.kind === "account" && line!.source.accountId, "acc_co");
  assert.equal(lineOf("org_owner", id), undefined, "nothing on the owner's personal books");
  // The org's refresh (bookkeeping-export.ts) re-projects the account: nothing new, nothing doubled.
  assert.deepEqual(writeAccountStatementLines(store.findAccount("acc_co")!), { added: 0, updated: 0 });
});

await check("a SEPA credit to a person's Safe is booked under the user, on their personal books (unchanged)", async () => {
  const id = issue(addr("a"));
  assert.equal(await mirrorOrderById(id), "recorded");
  const r = recordOf(id)!;
  assert.equal(r.userId, "u_owner");
  assert.equal(r.accountId, undefined);
  writeStatementLines();
  assert.ok(lineOf("org_owner", id));
  assert.equal(lineOf("org_co", id), undefined, "the owner's own money is not the company's");
});

await check("a SEPA credit to a sole trader's Safe is booked under the user, on the business's books (unchanged)", async () => {
  const id = issue(addr("b"));
  assert.equal(await mirrorOrderById(id), "recorded");
  assert.equal(recordOf(id)!.userId, "u_st");
  writeStatementLines();
  assert.ok(lineOf("org_st", id));
  assert.equal(lineOf("org_st_personal", id), undefined);
});

console.log("\nFail closed");

await check("a user's Safe that is also another org's account books nothing, and the reconciler reports it", async () => {
  const id = issue(addr("d"));
  assert.equal(await mirrorOrderById(id), "ignored");
  assert.equal(store.isOrderProcessed(id), false);
  assert.equal(recordOf(id), undefined);
  const report = await reconcile();
  assert.ok(report.findings.some((f) => f.kind === "UNMIRRORED" && f.orderId === id));
});

await check("two accounts at one address book nothing, by the webhook or the poller", async () => {
  const id = issue(addr("e"));
  assert.equal(await mirrorOrderById(id), "ignored");
  await pollDepositsOnce();
  assert.equal(store.isOrderProcessed(id), false);
  assert.equal(recordOf(id), undefined, "keepIssueFacts refuses it too");
  assert.equal(lineOf("org_twin_1", id), undefined);
  assert.equal(lineOf("org_twin_2", id), undefined);
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
  assert.equal(store.moneriumIssueOrders.filter((o) => o.orderId === id).length, 1);
  assert.equal(store.ledgerOf("org_co").filter((e) => e.statement?.links.orderId === id).length, 1);
});

// ── Restart and two-worker boundaries ────────────────────────────────────
// The deployment is one process writing one file store (single writer). Two
// workers here are two callers in that process (the poller and a webhook, or
// two deliveries); a restart is the store re-read from disk with fresh module
// state (a new instance of the adapter module), which is all a real restart
// keeps.

let generation = 0;
async function restart() {
  initStore();
  generation++;
  return {
    sandbox: await import(`../services/api/src/adapters/monerium-sandbox.js?restart=${generation}`),
    connection: await import(`../services/api/src/adapters/monerium-connection.js?restart=${generation}`),
  };
}
const issueRecords = (id: string) => store.moneriumIssueOrders.filter((o) => o.orderId === id).length;
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
  assert.equal(issueRecords(id), 1);
});

await check("a webhook and the poller on one order at once book it once", async () => {
  const id = issue(addr("a"));
  await Promise.all([mirrorOrderById(id), pollDepositsOnce(), mirrorOrderById(id)]);
  assert.ok(store.isOrderProcessed(id));
  assert.equal(issueRecords(id), 1);
  writeStatementLines();
  assert.equal(store.ledgerOf("org_owner").filter((e) => e.statement?.links.orderId === id).length, 1);
});

await check("restart after the order was marked processed, before its issue record: the poller adds the record once", async () => {
  const id = issue(addr("a"));
  store.markOrderProcessed(id); // the crash lands between the two writes
  const { sandbox } = await restart();
  assert.equal(issueRecords(id), 0);
  assert.equal(await sandbox.mirrorOrderById(id), "duplicate", "a redelivery does not book it again");
  await sandbox.pollDepositsOnce();
  await sandbox.pollDepositsOnce();
  assert.equal(issueRecords(id), 1);
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
  assert.equal(issueRecords(id), 1);
  assert.equal(dbm.db.processedMoneriumOrders.filter((x: string) => x === id).length, 1);
});

await check("restart before the claim: nothing was written, the redelivery books it", async () => {
  const id = issue(addr("a"));
  const { sandbox } = await restart();
  assert.equal(await sandbox.mirrorOrderById(id), "recorded");
  assert.equal(await mirrorOrderById(id), "duplicate");
  assert.equal(issueRecords(id), 1);
});

console.log("\nIssue amounts and states from upstream");

await check("an issue order with an amount that is not a euro decimal is not booked, and the reconciler reports it", async () => {
  for (const amount of ["0x10", "Infinity", "1e3", "12.505", "-5", " 12.50", "12,50", "", "NaN"]) {
    const id = issue(addr("a"), amount);
    assert.equal(await mirrorOrderById(id), "ignored", `amount ${JSON.stringify(amount)}`);
    assert.equal(store.isOrderProcessed(id), false, `amount ${JSON.stringify(amount)}`);
    assert.equal(issueRecords(id), 0, `amount ${JSON.stringify(amount)}`);
    orders.delete(id);
  }
  for (const amount of ["12.5", "12.50", "1000", "12.500000"]) {
    const id = issue(addr("a"), amount);
    assert.equal(await mirrorOrderById(id), "recorded", `amount ${amount}`);
    assert.equal(recordOf(id)!.amountEur, Number(amount));
  }
});

await check("an issue order in a state other than processed is not booked", async () => {
  for (const state of ["pending", "placed", "rejected", "PROCESSED", "processed ", "unknown"]) {
    const id = issue(addr("a"));
    orders.get(id).meta.state = state;
    assert.equal(await mirrorOrderById(id), "ignored", state);
    assert.equal(issueRecords(id), 0, state);
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
      assert.equal(store.isOrderProcessed(id), false);
    }
    stub.orderAnswer.set(id, { status: 404, raw: '{"code":404}' });
    assert.equal(await mirrorOrderById(`${id}`), "ignored", "a 404 is Monerium's answer");
  } finally {
    stub.orderAnswer.delete(id);
    console.warn = realWarn;
  }
  assert.equal(issueRecords(id), 0);
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
    assert.equal(store.isOrderProcessed(id), false, "not on the list, not booked by the poller");
    assert.equal(await mirrorOrderById(id), "recorded", "the webhook's re-read books it");
    assert.equal(issueRecords(id), 1);
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
const moneyState = () => JSON.stringify([store.moneriumIssueOrders.length, store.transfers.map((t) => [t.id, t.state])]);
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
  const before = moneyState();
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
  assert.equal(moneyState(), before, "no issue record and no transfer state changed");
  assert.equal(store.isOrderProcessed(pendingId), false);
  orders.delete(pendingId);
});

await check("a forged body naming a real processed order books Monerium's amount and holder, not the body's", async () => {
  const id = issue(addr("a"), "7.25");
  const res = await post(JSON.stringify({ data: { id, amount: "999999", address: COMPANY_SAFE } }));
  assert.equal(res.status, 200);
  assert.equal(recordOf(id)!.amountEur, 7.25);
  assert.equal(recordOf(id)!.userId, "u_owner");
});

await check("empty, non-JSON, wrong-type and oversized bodies change nothing and read nothing upstream", async () => {
  const before = moneyState();
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
  assert.equal(moneyState(), before);
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
});

await check("an unsigned delivery's webhook-id is not stored; an unknown id answered 404 is remembered instead", async () => {
  const before = dbm.db.processedMoneriumWebhooks.length;
  for (let i = 0; i < 20; i++) {
    const res = await post(JSON.stringify({ data: { id: `ord-nobody-${n}-${i}` } }), { "webhook-id": `msg_forged_${n}_${i}` });
    assert.equal(res.status, 200);
  }
  assert.equal(dbm.db.processedMoneriumWebhooks.length, before, "an id nobody signed costs no store write");
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
    assert.equal(issueRecords(id), 0);
    const good = signed(raw, "msg_good_236");
    assert.equal((await post(raw, good)).status, 200);
    assert.equal(recordOf(id)!.amountEur, 4);
    assert.ok(store.isWebhookProcessed("msg_good_236"));
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
function placedRedeem(amount = "20.00", state = "PAYOUT_SUBMITTED") {
  const id = `t_redeem_${++tn}`;
  const orderId = `ord-redeem-${tn}`;
  store.addTransfer({
    id, userId: "u_owner", rail: "sepa", state, sendEur: Number(amount), receiveEur: Number(amount),
    recipientName: "Supplier GmbH", recipientIban: PAYEE_IBAN, reference: `RE-${tn}`, txs: [{ step: "monerium.redeem.placed", hash: orderId }],
    moneriumRedeem: { amount, iban: PAYEE_IBAN, issuedAt: now, message: `Send EUR ${amount} to ${PAYEE_IBAN} at ${now}` },
    sepa: { mode: "sandbox", orderId, state: "placed" }, createdAt: now, updatedAt: now,
  } as any);
  orders.set(orderId, {
    id: orderId, kind: "redeem", address: addr("a"), chain: "base", currency: "eur", amount,
    counterpart: { identifier: { standard: "iban", iban: PAYEE_IBAN }, details: { firstName: "Supplier", lastName: "GmbH" } },
    meta: { state: "processed", placedAt: now, processedAt: now },
  });
  return { id, orderId };
}
const stateOf = (id: string) => store.findTransfer(id)!.state;

await check("a processed redeem that matches the transfer is PAID once, by two pollers at once and after a restart", async () => {
  const { id } = placedRedeem();
  await Promise.all([pollRedeemOrdersOnce(), pollRedeemOrdersOnce()]);
  assert.equal(stateOf(id), "PAID");
  const { sandbox } = await restart();
  await sandbox.pollRedeemOrdersOnce();
  writeStatementLines();
  assert.equal(stateOf(id), "PAID");
  assert.equal(store.ledgerOf("org_owner").filter((e) => e.statement?.links.transferId === id).length, 1, "one statement line");
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
    ];
    for (const final of ["processed", "rejected"]) {
      for (const [what, change] of variants) {
        const { id, orderId } = placedRedeem();
        change(orders.get(orderId));
        orders.get(orderId).meta.state = final;
        await pollRedeemOrdersOnce();
        const t = store.findTransfer(id)!;
        assert.ok(t.state !== "PAID" && t.state !== "FAILED", `${final} with a different ${what}: ${t.state}`);
        assert.equal(t.state, "MANUAL_REVIEW", `${final} with a different ${what} goes to review`);
        assert.match(t.error ?? "", /does not match/, what);
      }
    }
  } finally {
    console.warn = realWarn;
  }
});

await check("a redeem read that is not this order (empty, another id, non-JSON, oversized) or fails (401/409/429/5xx) changes nothing", async () => {
  const { id, orderId } = placedRedeem();
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
      const t = store.findTransfer(id)!;
      assert.equal(t.state, "PAYOUT_SUBMITTED", `HTTP ${status} ${raw.slice(0, 20)}`);
      assert.equal(t.sepa!.state, "placed", `HTTP ${status} ${raw.slice(0, 20)}: the stored order state is not overwritten`);
    }
  } finally {
    stub.orderAnswer.delete(orderId);
    console.warn = realWarn;
  }
});

await check("a redeem in a state Monerium did not document halts: not PAID, not FAILED, no refund", async () => {
  const { id, orderId } = placedRedeem();
  orders.get(orderId).meta.state = "on_hold_new_state";
  await pollRedeemOrdersOnce();
  assert.equal(stateOf(id), "PAYOUT_SUBMITTED");
  assert.equal(store.findTransfer(id)!.refund, undefined);
});

console.log("\nOAuth token refresh across workers and restarts");

const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { moneriumAccessToken, moneriumClientFor } = await import("../services/api/src/adapters/monerium-connection.js");
const past = () => new Date(Date.now() - 3_600_000).toISOString();
user("u_oauth", addr("9"));
store.updateUser("u_oauth", {
  monerium: {
    connectedAt: now, method: "oauth", profileId: "profile-oauth",
    accessTokenEnc: SECRETS.moneriumAccessToken.seal("u_oauth", "at-0"),
    refreshTokenEnc: SECRETS.moneriumRefreshToken.seal("u_oauth", "rt-0"),
    expiresAt: past(),
  } as any,
});
const oauthUser = () => store.findUser("u_oauth")!;
const expire = () => store.updateUser("u_oauth", { monerium: { ...oauthUser().monerium!, expiresAt: past() } });
/** The refresh token as it is on disk right now. */
const refreshOnDisk = () => {
  const row = JSON.parse(readFileSync(process.env.TRANSF_DB_PATH!, "utf8")).users.find((u: any) => u.id === "u_oauth");
  return SECRETS.moneriumRefreshToken.open("u_oauth", row.monerium.refreshTokenEnc);
};

await check("two workers inside the refresh window spend the refresh token once and get the same new token", async () => {
  const presented = stub.refresh.presented.length;
  const [a, b, c] = await Promise.all([moneriumAccessToken(oauthUser()), moneriumAccessToken(oauthUser()), moneriumAccessToken(oauthUser())]);
  assert.equal(stub.refresh.presented.length - presented, 1, "one refresh grant");
  assert.deepEqual([a, b, c], ["at-1", "at-1", "at-1"]);
  assert.equal(refreshOnDisk(), "rt-1");
});

await check("the rotated refresh token is on disk before the new access token is used", async () => {
  expire();
  const seenOnDisk: string[] = [];
  stub.onBearer = (token) => { if (token === "at-2") seenOnDisk.push(refreshOnDisk()); };
  try {
    await moneriumClientFor(oauthUser()).ibans();
  } finally {
    stub.onBearer = undefined;
  }
  assert.deepEqual(seenOnDisk, ["rt-2"]);
});

await check("after a restart the fresh process refreshes with the persisted token and never presents a spent one", async () => {
  expire();
  const { connection } = await restart();
  assert.equal(await connection.moneriumAccessToken(store.findUser("u_oauth")), "at-3");
  assert.equal(refreshOnDisk(), "rt-3");
  assert.equal(stub.refresh.spentPresented, 0);
});

await check("restart mid-refresh: the new process's refresh wins, the old one's late answer writes nothing", async () => {
  expire();
  stub.refresh.hold = 1;
  const old = moneriumAccessToken(oauthUser()); // the old process, its grant in flight
  await waitFor(() => stub.refresh.held.length === 1, "the held refresh");
  const { connection } = await restart();
  assert.equal(await connection.moneriumAccessToken(store.findUser("u_oauth")), "at-4");
  for (const r of stub.refresh.held.splice(0)) r();
  await assert.rejects(old, (e: any) => e?.name === "MoneriumAccessError", "the spent token is refused, not retried");
  assert.equal(refreshOnDisk(), "rt-4", "the new process's tokens stay");
  assert.equal(SECRETS.moneriumAccessToken.open("u_oauth", oauthUser().monerium!.accessTokenEnc!), "at-4");
});

await check("a refresh answer lost after Monerium rotated: the next refresh is refused, nothing falls back to the old token or the app", async () => {
  expire();
  stub.refresh.loseNext = true;
  await assert.rejects(moneriumAccessToken(oauthUser()), (e: any) => e?.name !== "MoneriumAccessError", "a lost answer is a transient");
  assert.equal(refreshOnDisk(), "rt-4", "nothing written");
  const bearers = stub.bearers.length;
  await assert.rejects(moneriumClientFor(oauthUser()).ibans(), (e: any) => e?.name === "MoneriumAccessError");
  assert.equal(stub.bearers.length, bearers, "no request went out on the expired token or the app's");
});

await check("disconnected while the refresh was in flight: the late answer does not reconnect the account", async () => {
  store.updateUser("u_oauth", {
    monerium: { ...oauthUser().monerium!, refreshTokenEnc: SECRETS.moneriumRefreshToken.seal("u_oauth", stub.refresh.current), expiresAt: past() },
  });
  stub.refresh.hold = 1;
  const p = moneriumAccessToken(oauthUser());
  await waitFor(() => stub.refresh.held.length === 1, "the held refresh");
  store.updateUser("u_oauth", { monerium: undefined });
  for (const r of stub.refresh.held.splice(0)) r();
  await assert.rejects(p, (e: any) => e?.name === "MoneriumAccessError");
  assert.equal(oauthUser().monerium, undefined);
});

hookServer.close();
monerium.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
