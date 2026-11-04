/**
 * "Between my own accounts": the mark a person puts on a payment, because
 * Zold cannot know which outside account is theirs.
 *
 * Pins, through the routes and the real writer: a SEPA credit and payout on a
 * personal account land in Revenue and Expenses; marking moves one out of the
 * statement's category, the overview's Revenue and Expenses, the Beleg's
 * booking and both exports, and undo restores it, a person's own category
 * included. The mark needs a session, membership and `ledger.categorise`; it
 * asks for neither the chart of accounts nor `ledger.tags`. An issued
 * Beleg is never touched and keeps verifying.
 *
 * What this cannot show: the screens in a browser. Offline.
 *
 * Run: npm run own-transfer:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-own-transfer-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { createBooksLineRouter } = await import("../services/api/src/routes/books-line.js");
const { writeStatementLinesFor } = await import("../services/api/src/bookkeeping/writer.js");
const { issueBelegForLine } = await import("../services/api/src/bookkeeping/issue.js");
const { belegStillAgrees } = await import("../services/api/src/bookkeeping/beleg.js");
const { lineId } = await import("../services/api/src/bookkeeping/statement.js");
const model: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/home-model.js")).href);

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

initStore();
const NOW = "2026-10-26T10:00:00.000Z";
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" };
const safe = (b: string) => `0x${b.repeat(20)}`;
const addUser = (id: string, address = safe("0f")) =>
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", address, createdAt: "2026-01-01T00:00:00.000Z" } as any);
const member = (orgId: string, userId: string, role: string) =>
  store.addMember({ id: `m_${orgId}_${userId}`, orgId, userId, role, status: "active", createdAt: NOW } as any);
const payout = (id: string, userId: string, sendEur: number, over: any = {}) =>
  store.addTransfer({
    id, userId, state: "PAID", rail: "sepa", sendEur, receiveEur: sendEur, recipientName: "Me at my bank", recipientIban: "DE89370400440532013000",
    reference: "own", txs: [], createdAt: NOW, updatedAt: NOW, ...over,
  } as any);
const issue = (orderId: string, userId: string, amountEur: number) =>
  store.recordMoneriumIssue({ orderId, userId, amountEur, counterpartyName: "Me at my bank", processedAt: NOW, recordedAt: NOW } as any);

addUser("u_me", safe("aa"));
store.addOrganisation({ id: "org_me", type: "personal", name: "Me", reporting, createdAt: NOW, updatedAt: NOW } as any);
member("org_me", "u_me", "owner");
store.addAccount({ id: "acc_me", orgId: "org_me", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: safe("aa"), backingUserId: "u_me", createdAt: NOW } as any);
issue("ord_in", "u_me", 95);
payout("t_out", "u_me", 1000);
writeStatementLinesFor(store.findUser("u_me")!);

addUser("u_boss", safe("bb"));
for (const u of ["u_viewer", "u_payer", "u_accountant", "u_outsider"]) addUser(u, safe(u.charCodeAt(2).toString(16).padStart(2, "0")));
store.addOrganisation({ id: "org_co", type: "business", name: "Co", legalName: "Co UG", plan: "business", reporting, address: { line1: "A", postalCode: "1", city: "R", country: "DE" }, invoicing: {}, verifications: {}, createdAt: NOW, updatedAt: NOW } as any);
member("org_co", "u_boss", "owner");
member("org_co", "u_viewer", "viewer");
member("org_co", "u_payer", "payer");
member("org_co", "u_accountant", "accountant");
store.addAccount({ id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: safe("bb"), backingUserId: "u_boss", createdAt: NOW } as any);
payout("t_co", "u_boss", 400);
issue("ord_co", "u_boss", 70);
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
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, body?: unknown, asUser: string | null = "u_me") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", ...(asUser ? { "x-user": asUser } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, text };
};

const IN = lineId("org_me", "monerium:issue:ord_in");
const OUT = lineId("org_me", "transfer:t_out:payout");
const own = (org: string, id: string, value: boolean, as: string | null = "u_me") => call("PUT", `/orgs/${org}/ledger/${id}/own-transfer`, { own: value }, as);
const statement = async () => (await call("GET", "/orgs/org_me/bookkeeping/statement")).body.lines as any[];
const line = async (id: string) => (await statement()).find((l) => l.id === id);
/** Revenue and Expenses as Books overview sums them. */
const overview = async () => {
  const counted = model.countedLines(await statement());
  const sum = (dir: 1 | -1) => counted.reduce((n: number, l: any) => n + Math.max(dir * l.amountCents, 0), 0);
  return { revenue: sum(1), expenses: sum(-1) };
};
const lexware = async () => (await call("GET", "/orgs/org_me/bookkeeping/export/2026-10/lexware.csv")).text;
const ledgerCsv = async () => (await call("GET", "/orgs/org_me/export/ledger.csv")).text;
const row = (csv: string, needle: string) => csv.split("\r\n").join("\n").split("\n").find((l) => l.includes(needle)) ?? "";

console.log("\nBefore the mark");

await check("a SEPA credit and a SEPA payout on a personal account land in Revenue and Expenses", async () => {
  assert.equal((await line(IN)).accountCode, "4100");
  assert.equal((await line(OUT)).accountCode, "6200");
  assert.deepEqual(await overview(), { revenue: 9500, expenses: 100000 });
  assert.equal((await line(IN)).ownTransfer, undefined);
  assert.equal((await line(IN)).ownTransferAllowed, true, "the screen draws the action only where the API takes it");
  assert.ok(row(await ledgerCsv(), "95.00").includes("4100"));
});

console.log("\nThe mark");

await check("marking the credit moves it out of the statement's category, Revenue and both exports; the payout stays", async () => {
  const before = store.ledgerOf("org_me").find((e: any) => e.id === IN)!;
  const r = await own("org_me", IN, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.line.ownTransfer, true);
  const l = await line(IN);
  assert.equal(l.ownTransfer, true);
  assert.equal(l.accountCode, undefined, "not on 4100 while marked");
  assert.equal(l.amountCents, 9500, "the line itself stays: the money did move");
  assert.deepEqual(await overview(), { revenue: 0, expenses: 100000 });
  const csv = await lexware();
  assert.ok(row(csv, "95,00").includes("Zwischen eigenen Konten"), "the bank import keeps the line and says so, or the account would not reconcile");
  assert.ok(!row(csv, "-1000,00").includes("Zwischen eigenen Konten"));
  const led = row(await ledgerCsv(), "95.00");
  assert.ok(!led.includes("4100") && led.includes("internal"), led);
  const entries = (await call("GET", "/orgs/org_me/ledger")).body.entries as any[];
  assert.equal(entries.find((e) => e.id === IN).accountCode, undefined);
  assert.equal((await call("GET", "/orgs/org_me/ledger?accountCode=4100")).body.total, 0, "a filter on the code does not find it");
  assert.equal(before.accountCode, "4100");
});

await check("the mark survives the writer and a rules re-run, and marking twice is one mark", async () => {
  writeStatementLinesFor(store.findUser("u_me")!);
  assert.equal((await call("POST", "/orgs/org_me/bookkeeping/statement/rebuild", {})).status, 200);
  assert.equal((await call("POST", "/orgs/org_co/account-rules/apply", {}, "u_boss")).status, 200);
  assert.equal((await line(IN)).ownTransfer, true);
  await own("org_me", IN, true);
  assert.equal(store.ledgerOf("org_me").find((e: any) => e.id === IN)!.tags.filter((t: string) => t === "internal").length, 1);
  assert.equal((await line(IN)).accountCode, undefined);
});

await check("undo restores the totals, the category and the exports", async () => {
  const r = await own("org_me", IN, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.line.ownTransfer, undefined);
  assert.equal((await line(IN)).accountCode, "4100");
  assert.equal((await line(IN)).accountCodeAuto, true, "still the rule's choice");
  assert.deepEqual(await overview(), { revenue: 9500, expenses: 100000 });
  assert.ok(!row(await lexware(), "95,00").includes("Zwischen eigenen Konten"));
  assert.ok(row(await ledgerCsv(), "95.00").includes("4100"));
});

await check("marking the payout moves it out of Expenses the same way", async () => {
  await own("org_me", OUT, true);
  assert.deepEqual(await overview(), { revenue: 9500, expenses: 0 });
  assert.equal((await line(OUT)).accountCode, undefined);
  await own("org_me", OUT, false);
  assert.equal((await line(OUT)).accountCode, "6200");
});

await check("a category a person chose comes back on undo, and is still theirs", async () => {
  const id = lineId("org_co", "transfer:t_co:payout");
  assert.equal((await call("PATCH", `/orgs/org_co/ledger/${id}`, { accountCode: "6100" }, "u_boss")).status, 200);
  await own("org_co", id, true, "u_boss");
  assert.equal((await call("POST", "/orgs/org_co/account-rules/apply", {}, "u_boss")).status, 200);
  await own("org_co", id, false, "u_boss");
  const l = (await call("GET", "/orgs/org_co/bookkeeping/statement", undefined, "u_boss")).body.lines.find((x: any) => x.id === id);
  assert.equal(l.accountCode, "6100");
  assert.equal(l.accountCodeAuto, false);
});

console.log("\nWho may");

await check("session, membership and ledger.categorise: no session 401, stranger 404, viewer and payer 403, accountant and owner 200", async () => {
  const id = lineId("org_co", "monerium:issue:ord_co");
  assert.equal((await own("org_co", id, true, null)).status, 401);
  assert.equal((await own("org_co", id, true, "u_outsider")).status, 404);
  assert.equal((await own("org_co", id, true, "u_viewer")).status, 403);
  assert.equal((await own("org_co", id, true, "u_payer")).status, 403);
  assert.equal((await own("org_co", id, true, "u_accountant")).status, 200);
  assert.equal((await own("org_co", id, false, "u_boss")).status, 200);
});

await check("the mark opens nothing else on a personal account: the chart and its rules stay closed", async () => {
  const chart = await call("GET", "/orgs/org_me/chart-of-accounts");
  assert.equal(chart.status, 409);
  assert.equal(chart.body.capability, "coa.manage");
  assert.equal((await call("POST", "/orgs/org_me/account-rules/apply", {})).status, 409);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "services/api/src/routes/business/bookkeeping.ts"), "utf8").match(/own-transfer"[\s\S]*?\n  }\);/)![0], /ledger\.tags|coa\./);
});

await check("only true or false; a line of another org, or a wallet row, is no such line", async () => {
  assert.equal((await call("PUT", `/orgs/org_me/ledger/${IN}/own-transfer`, { own: "yes" })).status, 400);
  assert.equal((await own("org_me", lineId("org_co", "transfer:t_co:payout"), true)).status, 404);
  store.addLedgerEntries([{ id: "w1", orgId: "org_me", source: { kind: "wallet", walletId: "w" }, direction: "in", asset: "OP", amount: "1", tags: [], at: NOW, createdAt: NOW } as any]);
  assert.equal((await own("org_me", "w1", true)).status, 404, "tagging a wallet row would change its cost basis");
});

await check("a fee, a line settling an invoice and a reversal are refused; undo always works", async () => {
  const fee = "feeline";
  const base = store.ledgerOf("org_me").find((e: any) => e.id === OUT)!;
  const facts = (over: any) => ({ ...base.statement!, ...over });
  store.addLedgerEntries([
    { ...base, id: fee, tags: [], statement: facts({ key: "transfer:t_out:fee" }) },
    { ...base, id: "rev", tags: [], statement: facts({ key: "transfer:t_out:refund", event: "sepa_out_reversal" }) },
    { ...base, id: "swp", tags: [], statement: facts({ key: "sweep:s", event: "sweep" }) },
    { ...base, id: "inv", tags: [], statement: facts({ key: "transfer:t2:payout", links: { txHashes: [], invoiceId: "i1" } }) },
    { ...base, id: "was", tags: ["internal"], statement: facts({ key: "transfer:t3:payout", links: { txHashes: [], invoiceId: "i2" } }) },
  ] as any);
  for (const id of [fee, "rev", "swp", "inv"]) {
    assert.equal((await own("org_me", id, true)).status, 409, id);
    assert.equal((await line(id)).ownTransferAllowed, undefined, id);
  }
  assert.equal((await own("org_me", "was", false)).status, 200);
});

console.log("\nThe payment detail sheet's lookup");

await check("a payment finds its line, in the org its Safe books under, with the mark's state", async () => {
  const look = (id: string, as = "u_me", user = "u_me") => call("GET", `/users/${user}/books-line/${id}`, undefined, as);
  assert.deepEqual((await look("t_out")).body, { line: { orgId: "org_me", lineId: OUT, ownTransfer: false } });
  assert.deepEqual((await look("ord_in")).body.line.lineId, IN);
  await own("org_me", IN, true);
  assert.equal((await look("ord_in")).body.line.ownTransfer, true);
  await own("org_me", IN, false);
  assert.equal((await look("nope")).body.line, null, "no line yet: the sheet shows no action");
  assert.equal((await look("t_out", "u_boss")).status, 403, "someone else's payments");
  assert.equal((await look("t_co", "u_boss", "u_boss")).body.line.orgId, "org_co");
});

await check("no line for a member who may not categorise, or for another person's payment", async () => {
  store.updateMember("m_org_co_u_boss", { role: "viewer" } as any);
  assert.equal((await call("GET", "/users/u_boss/books-line/t_co", undefined, "u_boss")).body.line, null);
  store.updateMember("m_org_co_u_boss", { role: "owner" } as any);
  assert.equal((await call("GET", "/users/u_me/books-line/t_co")).body.line, null);
});

console.log("\nBelege");

await check("an issued Beleg is never touched: it still verifies, is not revoked, and keeps the booking it froze", async () => {
  const entry = store.ledgerOf("org_me").find((e: any) => e.id === OUT)!;
  const { doc } = await issueBelegForLine(entry);
  const frozen = JSON.stringify(doc.snapshot);
  await own("org_me", OUT, true);
  const after = store.ledgerOf("org_me").find((e: any) => e.id === OUT)!;
  const stored = store.findDocumentByCode(doc.code)!;
  assert.equal(JSON.stringify(stored.snapshot), frozen);
  assert.equal(stored.revokedAt, undefined);
  assert.equal(after.statement!.documentCode, doc.code);
  const verdict = belegStillAgrees(stored.snapshot as any, { entry: after, transfer: store.findTransfer("t_out")! });
  assert.equal(verdict.ok, true, verdict.detail);
  assert.equal((stored.snapshot as any).line.accountCode, "6200");
  assert.equal((await lexware()).includes(`Beleg ${doc.code}`), true);
  await own("org_me", OUT, false);
});

await check("a Beleg issued on a marked line carries no income or expense code and says what it is", async () => {
  await own("org_me", IN, true);
  const { doc } = await issueBelegForLine(store.ledgerOf("org_me").find((e: any) => e.id === IN)!);
  const s = doc.snapshot as any;
  assert.equal(s.line.accountCode, undefined);
  assert.equal(s.line.ownTransfer, true);
  await own("org_me", IN, false);
});

console.log("\nThe screens");

await check("Revenue and Expenses are summed from counted lines; cash keeps every line; both screens carry the plain words", () => {
  const read = (f: string) => readFileSync(path.join(ROOT, "services/api/public", f), "utf8");
  const bo = read("business/books-overview.js");
  assert.match(bo, /countedLines as counted/);
  assert.match(bo, /categoryCard\("bo-exp", "Expenses", "out", counted\(now\), counted\(before\)/);
  assert.match(bo, /categoryCard\("bo-rev", "Revenue", "in", counted\(now\), counted\(before\)/);
  for (const f of ["business/screens.js", "app/phone-activity.js"]) {
    assert.match(read(f), /Between my own accounts/, f);
    assert.match(read(f), /[Nn]ot income or an expense/, f);
  }
});

server.close();
console.log(`\n${passed} own-transfer checks passed`);
if (process.exitCode) process.exit(process.exitCode);
process.exit(0);
