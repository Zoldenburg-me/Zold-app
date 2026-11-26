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
 * The stub Monerium answers the app's client-credentials login, the order
 * reads and /tokens (EURe on the test chain, so nothing is minted). No chain:
 * the adapter, the store and the statement writer run in-process.
 *
 * Run: npm run monerium:money-in:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
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

const orders = new Map<string, any>();
/** While set, /auth/token answers this status with an OAuth error body. */
let tokenFault = 0;
const TOKEN_BODY = { error: "invalid_client", error_description: "client app-client unknown" };
const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (url.pathname === "/auth/token") {
    req.resume();
    req.on("end", () => tokenFault
      ? send(tokenFault, TOKEN_BODY)
      : send(200, { access_token: "tok-app", token_type: "Bearer", expires_in: 3600 }));
    return;
  }
  if (url.pathname === "/tokens") {
    return send(200, [{ kind: "evm", currency: "eur", symbol: "EURe", chain: "base", chainId: 84532, decimals: 18, address: "0x00000000000000000000000000000000000000e0" }]);
  }
  if (url.pathname === "/orders") return send(200, { orders: [...orders.values()] });
  const m = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (m) return orders.has(m[1]) ? send(200, orders.get(m[1])) : send(404, { code: 404, status: "Not Found" });
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { mirrorOrderById, pollDepositsOnce } = await import("../services/api/src/adapters/monerium-sandbox.js");
const { writeStatementLines, writeAccountStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { reconcile } = await import("../services/api/src/reconcile.js");

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

monerium.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
