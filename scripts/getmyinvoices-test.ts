/**
 * The GetMyInvoices connector against a local fake of their v3 API, and the
 * org routes around it: connecting a key (verified against /account, stored
 * encrypted, never returned), pushing a month's Belege (idempotent on the
 * document number), and the gates in front of both.
 *
 * The fake answers only to the one known key, records every request, and
 * plays a document as "already there" once uploaded. No network.
 *
 * Run: npm run gmi:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-gmi-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-getmyinvoices-32";

const GOOD_KEY = "gmi_test_key_0123456789abcdef";
const seen = { requests: [] as { method: string; path: string; key: string | undefined; ua: string | undefined; body: any }[], uploaded: new Map<string, number>() };
let nextUid = 1000;

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = raw ? JSON.parse(raw) : undefined;
    seen.requests.push({ method: req.method!, path: url.pathname + url.search, key: req.headers["x-api-key"] as string | undefined, ua: req.headers["user-agent"], body });
    const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.headers["x-api-key"] !== GOOD_KEY) return send(401, { success: false, detail: "Unauthorized", error_code: 401 });
    if (!req.headers["user-agent"]) return send(400, { success: false, detail: "Bad request. User-Agent malformed" });
    if (url.pathname === "/account") return send(200, { name: "Tony", organization: "Zoldenburg UG", accountId: 4711, email: "books@example.com", hasBankingAccess: true, apiKeyType: "FULL_PERMISSION", currency: "EUR" });
    if (url.pathname === "/bankAccounts") return send(200, { totalCount: 1, records: [{ bankAccountUid: 77, accountType: "CUSTOM", name: "Zold clearing", currencyCode: "EUR" }] });
    if (url.pathname === "/documents" && req.method === "GET") {
      const num = url.searchParams.get("documentNumberFilter") ?? "";
      const uid = seen.uploaded.get(num);
      return send(200, { totalCount: uid ? 1 : 0, records: uid ? [{ documentUid: uid, documentNumber: num, documentType: "PAYMENT_RECEIPT" }] : [] });
    }
    if (url.pathname === "/documents" && req.method === "POST") {
      if (!body?.fileName || !body?.fileContent || !body?.documentType) return send(400, { success: false, detail: "fileName, documentType and fileContent are required" });
      const uid = nextUid++;
      seen.uploaded.set(body.documentNumber, uid);
      return send(200, { success: true, documentUid: uid });
    }
    if (/^\/bankAccounts\/\d+\/transactions$/.test(url.pathname) && req.method === "POST") return send(200, { success: true, meta_data: {} });
    send(404, { success: false, detail: "unhandled " + url.pathname });
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${(fake.address() as any).port}`;
process.env.GETMYINVOICES_BASE_URL = FAKE;

const { GetMyInvoicesClient, GmiApiError, gmiUserAgent } = await import("../services/api/src/adapters/getmyinvoices.js");
const { initStore, store } = await import("../services/api/src/store.js");
const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { issueBelegForLine } = await import("../services/api/src/bookkeeping/issue.js");
const { belegUpload, createIntegrationRoutes } = await import("../services/api/src/routes/business/integrations.js");
const { createBookkeepingExportRoutes } = await import("../services/api/src/routes/business/bookkeeping-export.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { decryptField } = await import("../services/api/src/crypto-at-rest.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; }
};

console.log("\nClient");

await check("the key goes in X-API-KEY, a User-Agent names the product, and /account answers", async () => {
  const c = new GetMyInvoicesClient({ apiKey: GOOD_KEY, userAgent: gmiUserAgent(4711) });
  const a = await c.account();
  assert.equal(a.organization, "Zoldenburg UG");
  const r = seen.requests.at(-1)!;
  assert.equal(r.key, GOOD_KEY);
  assert.equal(r.ua, "Zold bookkeeping export/1.0 (account 4711)");
  assert.equal((await c.bankAccounts())[0].bankAccountUid, 77);
});

await check("a wrong key is a 401 GmiApiError whose message never contains the key", async () => {
  const c = new GetMyInvoicesClient({ apiKey: "gmi_wrong_key_00000000000000", userAgent: gmiUserAgent() });
  await assert.rejects(() => c.account(), (e: any) => e instanceof GmiApiError && e.status === 401 && !e.message.includes("gmi_wrong"));
});

await check("pushDocument uploads once, then reports the existing document; the file goes up as base64", async () => {
  const c = new GetMyInvoicesClient({ apiKey: GOOD_KEY, userAgent: gmiUserAgent() });
  const doc = { fileName: "x.pdf", file: Buffer.from("%PDF-1.4 test"), documentType: "PAYMENT_RECEIPT" as const, documentNumber: "ABCDEFGHJKMNPQR", documentDate: "2026-09-10", grossAmount: "119.62", currency: "EUR", paymentStatus: "Paid" as const, paidAt: "2026-09-10" };
  const first = await c.pushDocument(doc);
  assert.equal(first.outcome, "uploaded");
  const upload = seen.requests.find((r) => r.method === "POST" && r.path === "/documents")!;
  assert.equal(upload.body.fileContent, Buffer.from("%PDF-1.4 test").toString("base64"));
  assert.equal(upload.body.runOCR, false);
  assert.equal(upload.body.file, undefined, "the Buffer itself is not serialised");
  const second = await c.pushDocument(doc);
  assert.equal(second.outcome, "exists");
  assert.equal(second.documentUid, first.documentUid);
  assert.equal(seen.requests.filter((r) => r.method === "POST" && r.path === "/documents").length, 1);
});

console.log("\nRoutes");

initStore();
const SAFE = `0x${"aa".repeat(20)}` as const;
const now = new Date().toISOString();
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
store.addUser({ id: "u_owner", name: "Tony", country: "DE", kycStatus: "approved", address: SAFE, createdAt: now } as any);
store.addUser({ id: "u_viewer", name: "Viewer", country: "DE", kycStatus: "approved", address: `0x${"bb".repeat(20)}`, createdAt: now } as any);
store.addOrganisation({ id: "org_1", type: "business", name: "Zoldenburg UG", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now });
store.addOrganisation({ id: "org_starter", type: "business", name: "Starter GmbH", plan: "starter", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now });
store.addMember({ id: "m_owner", orgId: "org_1", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
store.addMember({ id: "m_viewer", orgId: "org_1", userId: "u_viewer", email: "", role: "viewer", status: "active", invitedAt: now, acceptedAt: now });
store.addMember({ id: "m_owner2", orgId: "org_starter", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE, backingUserId: "u_owner", createdAt: now, updatedAt: now });
store.recordMoneriumIssue({ orderId: "ord-1", userId: "u_owner", amountEur: 119, counterpartyName: "Kunde AG", counterpartyIban: "DE89370400440532013000", memo: "RE-2026-0041", processedAt: "2026-09-03T09:00:00.000Z", recordedAt: now });
store.addPaymentRequest({ id: "pr_1", code: "ABCDEFGHJKMNPQR", userId: "u_owner", orgId: "org_1", handle: "zold", amountEur: 119, currency: "EUR", methods: ["crypto"], state: "PAID", externalInvoiceNumber: "RE-2026-0042", cryptoQuotes: [], payments: [], source: { kind: "app" }, expiresAt: now, createdAt: now, updatedAt: now });
store.addCryptoDeposit({ id: "d-1", userId: "u_owner", chainId: 31337, token: "USDC", txHash: H(5), logIndex: 0, amountUnits: "137000000", amountUsdc: 137, receipt: { amountEur: 120.14, rate: 1.1403, rateProvider: "ecb", rateAsOf: "2026-09-10", ratedAt: now, blockTimestamp: "2026-09-10T09:58:00.000Z" }, state: "CONVERTED", settlementAsset: "EURE", creditedEur: 119.62, provider: "dex", rate: 1.1452, midRate: 1.1403, conversion: { txHash: H(7), at: "2026-09-10T10:02:00.000Z", amountInUnits: "137000000" }, paymentRequestId: "pr_1", txs: [], detectedAt: now, updatedAt: now });
writeStatementLines();

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const deps = { ctxOf: (req: any, res: any) => resolveOrg(req, res, requireSession) };
app.use("/api/orgs", createIntegrationRoutes(deps));
app.use("/api/orgs", createBookkeepingExportRoutes(deps));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_owner") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, body: data, headers: res.headers, bytes: Buffer.from(text, "latin1") };
};

await check("a starter org is refused the connector by plan (402); a viewer on a business org by role (403)", async () => {
  assert.equal((await call("POST", "/api/orgs/org_starter/integrations/getmyinvoices", { apiKey: GOOD_KEY })).status, 402);
  assert.equal((await call("POST", "/api/orgs/org_1/integrations/getmyinvoices", { apiKey: GOOD_KEY }, "u_viewer")).status, 403);
  assert.equal((await call("POST", "/api/orgs/org_1/integrations/getmyinvoices/push", { month: "2026-09" })).status, 409, "no key yet: pushing is refused");
});

await check("connecting verifies the key against /account, stores it encrypted and returns only the account's name", async () => {
  const bad = await call("POST", "/api/orgs/org_1/integrations/getmyinvoices", { apiKey: "gmi_wrong_key_00000000000000" });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("gmi_wrong"));
  const ok = await call("POST", "/api/orgs/org_1/integrations/getmyinvoices", { apiKey: GOOD_KEY });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.integrations.getmyinvoices.connected, true);
  assert.equal(ok.body.integrations.getmyinvoices.accountName, "Zoldenburg UG");
  assert.ok(!JSON.stringify(ok.body).includes(GOOD_KEY), "the key is not in the response");
  const stored = store.findOrganisation("org_1")!.integrations!.getmyinvoices!;
  assert.notEqual(stored.apiKeyEnc, GOOD_KEY);
  assert.equal(decryptField("getmyinvoices", process.env.MONERIUM_TOKEN_ENCRYPTION_KEY!, stored.apiKeyEnc), GOOD_KEY);
  assert.equal(stored.accountId, "4711");
  const list = await call("GET", "/api/orgs/org_1/integrations");
  assert.ok(!JSON.stringify(list.body).includes(GOOD_KEY) && !JSON.stringify(list.body).includes(stored.apiKeyEnc));
});

await check("the export prepares Belege for the month; the CSV and the ZIP follow", async () => {
  const st = await call("GET", "/api/orgs/org_1/bookkeeping/statement?month=2026-09");
  assert.equal(st.status, 200);
  assert.equal(st.body.lines.length, 2, JSON.stringify(st.body));
  assert.ok(st.body.note, "rule 2 note while no swap has executed");
  const prep = await call("POST", "/api/orgs/org_1/bookkeeping/export/2026-09/prepare");
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.body.belegeIssued, 2);
  assert.deepEqual(prep.body.failed, []);
  const csv = await call("GET", "/api/orgs/org_1/bookkeeping/export/2026-09/lexware.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const rows = csv.bytes.toString("latin1").split("\r\n");
  assert.equal(rows[0].split(";").length, 7);
  assert.equal(rows.length, 4, "header + 2 lines + trailing");
  assert.ok(rows[1].includes("Beleg ") && rows[2].includes("Beleg "), rows.join("|"));
  const zip = await fetch(`${API}/api/orgs/org_1/bookkeeping/export/2026-09/belege.zip`, { headers: { "x-user": "u_owner" } });
  assert.equal(zip.status, 200);
  const { listZip } = await import("../services/api/src/bookkeeping/zip.js");
  const entries = listZip(Buffer.from(await zip.arrayBuffer()));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.name.endsWith(".pdf") && e.crcOk));
  assert.equal((await call("GET", "/api/orgs/org_1/bookkeeping/export/2026-13/lexware.csv")).status, 400);
  assert.equal((await call("GET", "/api/orgs/org_1/bookkeeping/statement", undefined, "u_viewer")).status, 200, "a viewer may read");
  assert.equal((await call("POST", "/api/orgs/org_1/bookkeeping/export/2026-09/prepare", undefined, "u_viewer")).status, 403, "but not prepare");
});

await check("the upload body carries the document number (the Beleg code), the amounts, paid state, receipt date and the tx hashes", async () => {
  const doc = store.documentsForOrg("org_1").find((d) => (d.snapshot as any).receipt)!;
  const up = belegUpload(doc.snapshot as any, doc.code, doc.createdAt, 12);
  assert.equal(up.documentNumber, doc.code);
  assert.equal(up.grossAmount, "119.62");
  assert.equal(up.paymentStatus, "Paid");
  assert.equal(up.paidAt, "2026-09-10", "the receipt's block date, for Ist-Versteuerung");
  assert.equal(up.documentType, "PAYMENT_RECEIPT");
  assert.equal(up.paymentMethod, "online_payment");
  assert.ok(up.tags!.includes(`tx:${H(5)}`) && up.tags!.includes(`tx:${H(7)}`) && up.tags!.includes("invoice:RE-2026-0042"));
  assert.match(up.note!, /No conversion has yet executed with real money/);
  assert.equal(up.companyId, 12);
  assert.ok(up.file.subarray(0, 5).toString() === "%PDF-");
});

await check("push uploads each Beleg once; a second push uploads nothing", async () => {
  const before = seen.requests.filter((r) => r.method === "POST" && r.path === "/documents").length;
  const startIdx = seen.requests.length;
  const r1 = await call("POST", "/api/orgs/org_1/integrations/getmyinvoices/push", { month: "2026-09" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.results.map((x: any) => x.outcome).sort(), ["uploaded", "uploaded"]);
  const r2 = await call("POST", "/api/orgs/org_1/integrations/getmyinvoices/push", { month: "2026-09" });
  assert.deepEqual(r2.body.results.map((x: any) => x.outcome).sort(), ["exists", "exists"]);
  assert.equal(seen.requests.filter((r) => r.method === "POST" && r.path === "/documents").length - before, 2);
  const pushed = seen.requests.slice(startIdx).filter((r) => r.path.startsWith("/documents"));
  assert.ok(pushed.length >= 4, "two lookups and two uploads, then two lookups");
  assert.ok(pushed.every((r) => r.key === GOOD_KEY && r.ua?.includes("account 4711")), "the stored key and the account-bearing User-Agent are used");
  const audit = store.auditFor("u_owner").find((a) => a.kind === "partner.documents_pushed");
  assert.ok(audit, "the push is audited");
});

await check("removing the key stops pushes and leaves nothing of it in the org", async () => {
  assert.equal((await call("DELETE", "/api/orgs/org_1/integrations/getmyinvoices")).status, 200);
  assert.equal(store.findOrganisation("org_1")!.integrations?.getmyinvoices, undefined);
  assert.equal((await call("POST", "/api/orgs/org_1/integrations/getmyinvoices/push", { month: "2026-09" })).status, 409);
});

server.close();
fake.close();
console.log(`\ngetmyinvoices: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
console.log("NOT PROVEN HERE: no upload has been made to the real account. Only GET /account and GET /bankAccounts have been called there.");
