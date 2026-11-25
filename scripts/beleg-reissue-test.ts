/**
 * A Beleg that stopped verifying: the books stop handing it out, and whoever
 * may manage the books replaces it.
 *
 * Pins, through the routes and the real writer: a Beleg issued on a line
 * marked as between own accounts stops verifying once the mark comes off. From
 * then on the statement offers it only as one to replace, the Lexware CSV does
 * not name its code, belege.zip leaves its PDF out and says why, and its PDF
 * link refuses, all by the same records check the verify page runs. Replace
 * revokes it and issues a new one: the owner, an admin or the accountant may,
 * a viewer and a payer may not, and one that still verifies is refused. The
 * revoked one keeps its frozen snapshot and fails verification at its code.
 * Marking the line again makes the old Beleg true again, with no replace.
 *
 * A replacement never carries the old code; two replaces at once leave one
 * live Beleg; replace refuses, revoking nothing, when the new Beleg would
 * fail too (a payout Monerium rejected); a deposit converted in parts has a
 * Beleg per fill that verifies before and after the rest is converted.
 *
 * What this cannot show: the screens in a browser. The GetMyInvoices push,
 * replace and re-send are in getmyinvoices-test. Offline.
 *
 * Run: npm run beleg-reissue:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-beleg-reissue-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { createBooksLineRouter } = await import("../services/api/src/routes/books-line.js");
const { createDocumentsRouter } = await import("../services/api/src/routes/documents.js");
const { writeStatementLinesFor } = await import("../services/api/src/bookkeeping/writer.js");
const { lineId } = await import("../services/api/src/bookkeeping/statement.js");
const { listZip } = await import("../services/api/src/bookkeeping/zip.js");

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

initStore();
const NOW = "2026-10-26T10:00:00.000Z";
const MONTH = "2026-10";
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" };
const safe = (b: string) => `0x${b.repeat(20)}`;
const addUser = (id: string, address: string) =>
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", address, createdAt: "2026-01-01T00:00:00.000Z" } as any);
const member = (userId: string, role: string) =>
  store.addMember({ id: `m_${userId}`, orgId: "org_co", userId, role, status: "active", createdAt: NOW } as any);

addUser("u_boss", safe("bb"));
["u_admin", "u_accountant", "u_viewer", "u_payer", "u_outsider"].forEach((u, i) => addUser(u, safe(`c${i}`)));
store.addOrganisation({ id: "org_co", type: "business", name: "Co", legalName: "Co UG", plan: "business", reporting, address: { line1: "A", postalCode: "1", city: "R", country: "DE" }, invoicing: {}, verifications: {}, createdAt: NOW, updatedAt: NOW } as any);
member("u_boss", "owner");
member("u_admin", "admin");
member("u_accountant", "accountant");
member("u_viewer", "viewer");
member("u_payer", "payer");
store.addAccount({ id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: safe("bb"), backingUserId: "u_boss", createdAt: NOW } as any);
store.recordMoneriumIssue({ orderId: "ord_co", userId: "u_boss", amountEur: 70, counterpartyName: "Me at my bank", processedAt: NOW, recordedAt: NOW } as any);
writeStatementLinesFor(store.findUser("u_boss")!);

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user") as string | undefined;
const requireSession = (req: any, res: any) => {
  const id = who(req);
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const requireUserSession = (req: any, res: any, userId: string) => {
  if (who(req) === userId) return { userId };
  res.status(who(req) ? 403 : 401).json({ error: "not yours" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
app.use("/api", createBooksLineRouter({ requireUserSession } as any));
app.use("/api", createDocumentsRouter({ requireUserSession } as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, body?: unknown, asUser: string | null = "u_boss") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", ...(asUser ? { "x-user": asUser } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let parsed: any = {};
  try { parsed = bytes.length ? JSON.parse(bytes.toString("utf8")) : {}; } catch { parsed = {}; }
  return { status: res.status, body: parsed, text: bytes.toString("latin1"), bytes };
};

const IN = lineId("org_co", "monerium:issue:ord_co");
const own = (value: boolean) => call("PUT", `/orgs/org_co/ledger/${IN}/own-transfer`, { own: value });
const line = async (as = "u_boss") => (await call("GET", `/orgs/org_co/bookkeeping/statement?month=${MONTH}`, undefined, as)).body.lines.find((l: any) => l.id === IN);
const csv = async () => (await call("GET", `/orgs/org_co/bookkeeping/export/${MONTH}/lexware.csv`)).text;
const zip = async () => listZip((await call("GET", `/orgs/org_co/bookkeeping/export/${MONTH}/belege.zip`)).bytes);
const replace = (as: string | null) => call("POST", `/orgs/org_co/bookkeeping/lines/${IN}/beleg/replace`, {}, as);
const recordsCheck = async (code: string) => (await call("GET", `/v/${code}`, undefined, null)).body.verification.checks.find((c: any) => c.name === "Records still match");

assert.equal((await own(true)).status, 200);
const first = await call("POST", `/orgs/org_co/bookkeeping/lines/${IN}/beleg`, {});
assert.equal(first.status, 201);
const OLD: string = first.body.code;

console.log("\nWhile the Beleg verifies");

await check("the statement, the CSV and the ZIP carry it, and replace refuses it", async () => {
  assert.equal((await line()).documentCode, OLD);
  assert.equal((await line()).belegStale, undefined);
  assert.ok((await csv()).includes(OLD));
  assert.ok((await zip()).some((e) => e.name.includes(OLD)));
  const r = await replace("u_boss");
  assert.equal(r.status, 409, "a Beleg that still verifies is not revoked");
  assert.equal(store.findDocumentByCode(OLD)!.revokedAt, undefined);
});

await check("the statement, the CSV and the ZIP index the documents once, not one scan per line", async () => {
  const real = store.findDocumentByCode;
  let scans = 0;
  (store as any).findDocumentByCode = (code: string) => { scans++; return real.call(store, code); };
  try {
    assert.equal((await line()).documentCode, OLD);
    assert.ok((await csv()).includes(OLD));
    assert.ok((await zip()).some((e) => e.name.includes(OLD)));
  } finally {
    (store as any).findDocumentByCode = real;
  }
  assert.equal(scans, 0, `${scans} per-line document scans`);
});

console.log("\nOnce the mark comes off");

await check("the verify page says the records no longer match", async () => {
  assert.equal((await own(false)).status, 200);
  const c = await recordsCheck(OLD);
  assert.equal(c.ok, false);
  assert.match(c.detail, /no longer marked/);
});

await check("the statement offers it only as one to replace, saying why", async () => {
  const l = await line();
  assert.equal(l.documentCode, undefined, "not drawn as the line's receipt");
  assert.equal(l.belegStale.code, OLD);
  assert.match(l.belegStale.detail, /no longer marked/);
  assert.ok(l.belegStale.url.includes(OLD), "the old one can still be opened, to see why it fails");
});

await check("the Lexware CSV does not name its code and says the Beleg must be replaced", async () => {
  const row = (await csv()).split("\r\n").find((r) => r.includes("70,00"))!;
  assert.ok(!row.includes(OLD), row);
  assert.match(row, /Beleg stimmt nicht mehr/);
});

await check("belege.zip leaves the PDF out and its note names the line and the reason", async () => {
  const entries = await zip();
  assert.ok(!entries.some((e) => e.name.includes(OLD)), entries.map((e) => e.name).join("|"));
  assert.ok(entries.some((e) => e.name === `MISSING-${MONTH}.txt`), "a note says what is missing");
  // Stored, not deflated: the note's text is in the archive's bytes as is.
  const text = (await call("GET", `/orgs/org_co/bookkeeping/export/${MONTH}/belege.zip`)).bytes.toString("utf8");
  assert.ok(text.includes(IN));
  assert.match(text, /no longer matches/);
  assert.match(text, /no longer marked/);
});

await check("its PDF link refuses: a PDF carries no verdict", async () => {
  const r = await call("GET", `/v/${OLD}/beleg.pdf`, undefined, null);
  assert.equal(r.status, 409);
  assert.equal(r.body.verifies, false);
});

await check("the /app payment sheet's lookup says the Beleg needs replacing", async () => {
  const r = await call("GET", "/users/u_boss/books-line/ord_co");
  assert.equal(r.body.line.lineId, IN);
  assert.equal(r.body.line.belegStale, true);
});

await check("marking the line again makes the old Beleg true again, with nothing replaced", async () => {
  await own(true);
  assert.equal((await line()).documentCode, OLD);
  assert.equal((await recordsCheck(OLD)).ok, true);
  assert.equal((await call("GET", "/users/u_boss/books-line/ord_co")).body.line.belegStale, undefined);
  await own(false);
});

console.log("\nReplace");

await check("no session 401, a stranger 404, a viewer and a payer 403; nothing is revoked", async () => {
  assert.equal((await replace(null)).status, 401);
  assert.equal((await replace("u_outsider")).status, 404);
  assert.equal((await replace("u_viewer")).status, 403);
  assert.equal((await replace("u_payer")).status, 403);
  assert.equal(store.findDocumentByCode(OLD)!.revokedAt, undefined);
  assert.equal((await call("POST", `/orgs/org_co/bookkeeping/lines/nope/beleg/replace`, {})).status, 404);
});

await check("the accountant replaces it: the old one is revoked, frozen and still answers at its code; the new one verifies", async () => {
  const frozen = JSON.stringify(store.findDocumentByCode(OLD)!.snapshot);
  const r = await replace("u_accountant");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const NEW: string = r.body.code;
  assert.notEqual(NEW, OLD);
  const old = store.findDocumentByCode(OLD)!;
  assert.ok(old.revokedAt, "revoked, not deleted");
  assert.equal(JSON.stringify(old.snapshot), frozen, "the snapshot is untouched");
  const page = (await call("GET", `/v/${OLD}`, undefined, null)).body;
  assert.equal(page.verification.checks.find((c: any) => c.name === "Not revoked").ok, false);
  assert.equal((await call("GET", `/v/${OLD}/beleg.pdf`, undefined, null)).status, 410);
  assert.equal((await recordsCheck(NEW)).ok, true);
  assert.equal((store.findDocumentByCode(NEW)!.snapshot as any).line.ownTransfer, undefined, "the new one says what the books say now");
  const l = await line();
  assert.equal(l.documentCode, NEW);
  assert.equal(l.belegStale, undefined);
  assert.ok((await csv()).includes(NEW));
  const names = (await zip()).map((e) => e.name);
  assert.ok(names.some((n) => n.includes(NEW)) && !names.includes(`MISSING-${MONTH}.txt`), names.join("|"));
  const audit = store.auditFor("u_accountant").find((a: any) => a.kind === "document.reissued");
  assert.ok(audit, "the replace is in the audit log, under the accountant");
  assert.equal((audit as any).data.lineId, IN);
  assert.ok(!JSON.stringify(audit).includes(OLD) && !JSON.stringify(audit).includes(NEW), "a verification code is a credential: not in the audit log");
});

await check("a Beleg issued before a mark keeps verifying, so replace refuses it; the owner and an admin may replace one that fails", async () => {
  assert.equal((await own(true)).status, 200);
  const NEW = (await line()).documentCode;
  assert.equal((await replace("u_admin")).status, 409, "issued unmarked, then marked: still true");
  store.updateDocument(store.findDocumentByCode(NEW)!.id, { revokedAt: NOW });
  const issued = await replace("u_admin");
  assert.equal(issued.status, 201, "nothing live to revoke: replace just issues");
  assert.equal((store.findDocumentByCode(issued.body.code)!.snapshot as any).line.ownTransfer, true);
  assert.equal((await own(false)).status, 200);
  assert.ok((await line()).belegStale, "stale again once the mark comes off");
  const byOwner = await replace("u_boss");
  assert.equal(byOwner.status, 201);
  assert.ok(store.findDocumentByCode(issued.body.code)!.revokedAt);
  assert.equal((await line()).documentCode, byOwner.body.code);
});

await check("a replacement never carries the old code: its public page does not return it", async () => {
  const NEW: string = (await line()).documentCode;
  const revoked = store.documentsForOrg("org_co").filter((d) => d.revokedAt && (d.snapshot as any).line?.lineId === IN).map((d) => d.code);
  assert.ok(revoked.length >= 2, "this line has replaced Belege behind it");
  const page = (await call("GET", `/v/${NEW}`, undefined, null)).text;
  for (const old of revoked) assert.ok(!page.includes(old), "a revoked Beleg's code is a credential to its figures");
  assert.equal((store.findDocumentByCode(NEW)!.snapshot as any).line.documentCode, undefined);
});

await check("two replaces at once: one replaces, the other finds the new Beleg live and is refused; one live Beleg on the line", async () => {
  assert.equal((await own(true)).status, 200);
  store.updateDocument(store.findDocumentByCode((await line()).documentCode)!.id, { revokedAt: NOW });
  assert.equal((await replace("u_boss")).status, 201, "a marked Beleg");
  assert.equal((await own(false)).status, 200);
  assert.ok((await line()).belegStale);
  const both = await Promise.all([replace("u_boss"), replace("u_accountant")]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  const live = store.documentsForOrg("org_co").filter((d) => !d.revokedAt && (d.snapshot as any).line?.lineId === IN);
  assert.equal(live.length, 1);
  assert.equal((await line()).documentCode, live[0].code);
});

console.log("\nWhere replacing cannot help");

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const lineOf = async (id: string, month = MONTH) => (await call("GET", `/orgs/org_co/bookkeeping/statement?month=${month}`)).body.lines.find((l: any) => l.id === id);

await check("a payout Monerium rejected after its Beleg: replace refuses with the reason, revokes nothing and issues nothing", async () => {
  store.addTransfer({ id: "t_out", userId: "u_boss", rail: "sepa", state: "PAYOUT_SUBMITTED", sendEur: 80, receiveEur: 80, recipientName: "Supplier GmbH", recipientIban: "DE89370400440532013000", reference: "RE-9", txs: [], createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" } as any);
  writeStatementLinesFor(store.findUser("u_boss")!);
  const OUT = lineId("org_co", "transfer:t_out:payout");
  const issued = await call("POST", `/orgs/org_co/bookkeeping/lines/${OUT}/beleg`, {});
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  store.updateTransfer("t_out", { state: "FAILED" } as any);
  assert.match((await recordsCheck(issued.body.code)).detail, /transfer is now FAILED/);
  const r = await call("POST", `/orgs/org_co/bookkeeping/lines/${OUT}/beleg/replace`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /would not match the books either/);
  assert.match(r.body.error, /transfer is now FAILED/);
  assert.equal(store.findDocumentByCode(issued.body.code)!.revokedAt, undefined, "the old one is not revoked");
  assert.equal(store.documentsForOrg("org_co").filter((d) => (d.snapshot as any).line?.lineId === OUT).length, 1, "no second one issued");
  assert.equal((await lineOf(OUT)).belegStale.code, issued.body.code);
});

await check("a deposit converted in parts: each fill's Beleg verifies and is handed out, before and after the rest is converted", async () => {
  const at = "2026-10-12T10:00:00.000Z";
  const p1 = { creditedEur: 40, receiptPortionEur: 40.4, provider: "dex", rate: 1.1, conversion: { txHash: H(30), at: "2026-10-12T10:01:00.000Z", amountInUnits: "44000000" } };
  store.addCryptoDeposit({ id: "d_part", userId: "u_boss", chainId: 31337, token: "USDC", txHash: H(5), logIndex: 0, amountUnits: "110000000", amountUsdc: 110,
    receipt: { amountEur: 101, rate: 1.089, rateProvider: "ecb", rateAsOf: "2026-10-12", ratedAt: at, blockTimestamp: "2026-10-12T09:58:00.000Z" },
    holding: "held", settledAt: at, settlementAsset: "EURE", partials: [p1], txs: [{ step: "safe.swap(usdc->eure)", hash: H(30) }], detectedAt: at, updatedAt: at } as any);
  writeStatementLinesFor(store.findUser("u_boss")!);
  const P1 = lineId("org_co", "deposit:d_part:disposal:p1");
  const first = await call("POST", `/orgs/org_co/bookkeeping/lines/${P1}/beleg`, {});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((await recordsCheck(first.body.code)).ok, true, "the first fill, the rest still held");
  assert.equal((await lineOf(P1)).documentCode, first.body.code);
  store.updateCryptoDeposit("d_part", { holding: "converted", settledAt: at, settlementAsset: "EURE", creditedEur: 100, provider: "dex", rate: 1.1, midRate: 1.09, realisedGainEur: -1,
    conversion: { txHash: H(31), at: "2026-10-12T11:00:00.000Z", amountInUnits: "66000000" }, txs: [{ step: "safe.swap(usdc->eure)", hash: H(30) }, { step: "safe.swap(usdc->eure)", hash: H(31) }] } as any);
  writeStatementLinesFor(store.findUser("u_boss")!);
  const FINAL = lineId("org_co", "deposit:d_part:disposal");
  const last = await call("POST", `/orgs/org_co/bookkeeping/lines/${FINAL}/beleg`, {});
  assert.equal(last.status, 201, JSON.stringify(last.body));
  assert.equal((store.findDocumentByCode(last.body.code)!.snapshot as any).conversion.creditedEur, 60, "the last fill alone");
  for (const [id, code] of [[P1, first.body.code], [FINAL, last.body.code]]) {
    assert.equal((await recordsCheck(code)).ok, true, `${id} verifies once the rest is converted`);
    assert.equal((await lineOf(id)).documentCode, code);
    assert.ok((await csv()).includes(code));
  }
});

console.log("\nThe screens");

await check("the books statement and the export draw Replace where the receipt stopped verifying; /app offers it under the payment", () => {
  const read = (f: string) => readFileSync(path.join(ROOT, "services/api/public", f), "utf8");
  const views = read("business/views.js");
  assert.match(views, /export const staleBeleg = [\s\S]*?data-act="line-beleg-replace"/);
  assert.match(views, /l\.belegStale \? staleBeleg\(l, mayBook\)/, "the export table");
  assert.match(read("business/screens.js"), /l\.belegStale \? staleBeleg\(l, mayMark, who\)/, "the books statement");
  assert.match(read("business/actions.js"), /"line-beleg-replace"[\s\S]*?\/beleg\/replace`, \{ method: "POST" \}/);
  const app = read("app/phone-activity.js");
  assert.match(app, /line\.belegStale \?[\s\S]*?Replace booking receipt/);
  assert.match(app, /\/beleg\/replace`, \{\}\)/);
  assert.match(views, /const dis = withBeleg \|\| stale \?/, "a month whose receipts are all stale still downloads: the files say why");
  assert.match(read("business/actions.js"), /x\.stale\)\.length, "receipts that no longer match the books/, "the GetMyInvoices result says why and what to do");
  assert.match(read("business/actions.js"), /no longer match the books[^"]*a payout Monerium rejected can’t be replaced/, "and that Books refuses to replace a rejected payout's receipt");
  assert.match(read("business/actions.js"), /bankLine\?\.revokedStillAttached[\s\S]{0,200}still attached[^"]*remove/, "a revoked receipt still attached in GetMyInvoices is said, with what to do");
  assert.match(read("document.js"), /doc\.revokedAt \|\| doc\.verification\?\.checks\?\.some\(\(c\) => c\.name === "Records still match" && !c\.ok\)/, "no PDF link the server refuses");
});

server.close();
console.log(`\n${passed} beleg-reissue checks passed`);
if (process.exitCode) process.exit(process.exitCode);
process.exit(0);
