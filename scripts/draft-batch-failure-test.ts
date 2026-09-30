/**
 * A draft batch that fails partway: line 1 becomes a transfer, line 2 cannot
 * be prepared. The draft must go FAILED (not back to REVIEWED, where a retry
 * would fire a second batch on top of the first), say plainly that nothing
 * moved, list the transfer it left unsigned, release the invoice it had not
 * reached, and refuse a replay.
 *
 * The real draft router, mounted in-process on a temp store. The transfer
 * factory and the balance reader are the two injected dependencies, and both
 * are stubbed: the builder succeeds once and then refuses, and the balance is
 * a fixed number, so no chain or bundler is needed. The account's Monerium
 * connection is a row in the temp store, not a seam in the API; the profile
 * re-read that execution makes before any quote is answered by a fake
 * Monerium on loopback that knows one approved corporate profile.
 * draft:test covers the same route against a real chain up to the Monerium
 * refusal; this suite covers what lies after the claim.
 *
 * Run: npm run draft:failure:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-draft-fail-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-draft-failure-32b";

// The owner's Monerium login sees one approved corporate profile. Like the
// sandbox, the single-profile answer carries no name; the list does.
const TOKEN = "tok-owner";
const CORP = { id: "22222222-aaaa-4bbb-8ccc-000000000001", kind: "corporate", state: "approved", name: "Zoldenburg UG" };
const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { code: 401, status: "Unauthorized" });
  if (url.pathname === "/profiles") return send(200, { profiles: [CORP], total: 1 });
  if (url.pathname === `/profiles/${CORP.id}`) return send(200, { id: CORP.id, kind: CORP.kind, state: CORP.state });
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { currentFingerprint } = await import("../services/api/src/domain/drafts.js");
const { hashToken } = await import("../services/api/src/domain/invoices.js");
const { encryptToken } = await import("../services/api/src/adapters/monerium-connection.js");
type TransferFactory = import("../services/api/src/routes/business/shared.js").TransferFactory;

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

initStore();
const now = new Date().toISOString();
const SAFE = `0x${"aa".repeat(20)}` as const;

store.addUser({
  id: "u_owner",
  name: "Owner",
  country: "DE",
  kycStatus: "approved",
  address: SAFE,
  monerium: { connectedAt: now, method: "oauth", profileId: CORP.id, accessTokenEnc: encryptToken(TOKEN) },
  createdAt: now,
} as any);
store.addUser({ id: "u_reviewer", name: "Reviewer", country: "DE", kycStatus: "approved", address: `0x${"bb".repeat(20)}`, createdAt: now } as any);
store.addOrganisation({ id: "org_1", type: "business", name: "Zoldenburg UG", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
store.addMember({ id: "m_owner", orgId: "org_1", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
store.addMember({ id: "m_reviewer", orgId: "org_1", userId: "u_reviewer", email: "", role: "admin", status: "active", invitedAt: now, acceptedAt: now } as any);
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE, backingUserId: "u_owner", moneriumProfile: { id: CORP.id, kind: "corporate", name: CORP.name, checkedAt: now }, createdAt: now, updatedAt: now } as any);

const contact = (id: string, name: string, iban: string) => {
  const c = {
    id,
    orgId: "org_1",
    name,
    wallets: [],
    bankAccounts: [{ id: `${id}_bank`, currency: "EUR", country: "DE", holderName: name, iban }],
    createdAt: now,
    updatedAt: now,
  };
  store.addContact(c as any);
  return c;
};
const first = contact("c_first", "First Supplier GmbH", "DE89370400440532013000");
const second = contact("c_second", "Second Supplier GmbH", "DE02120300000000202051");

const invoice = (id: string, number: string) =>
  store.addInvoice({
    id,
    direction: "incoming",
    orgId: "org_1",
    linkTokenHash: hashToken(`link-${id}`),
    state: "PAYING",
    supplier: { orgName: number, email: "billing@supplier.example", invoiceNumber: number },
    lines: [],
    currency: "EUR",
    total: "40.00",
    payment: { draftId: "d_batch" },
    createdAt: now,
    updatedAt: now,
  } as any);
invoice("inv_first", "R-1");
invoice("inv_second", "R-2");

const line = (id: string, c: ReturnType<typeof contact>, invoiceId: string) => {
  const l = {
    id,
    contactId: c.id,
    invoiceId,
    destination: { kind: "bank" as const, bankAccountId: c.bankAccounts[0].id, displayName: c.name },
    asset: "EUR",
    amount: "40.00",
  };
  return { ...l, destination: { ...l.destination, fingerprint: currentFingerprint(l as any, c as any) } };
};
store.addDraft({
  id: "d_batch",
  orgId: "org_1",
  source: { kind: "account", accountId: "acc_1" },
  state: "REVIEWED",
  lines: [line("l1", first, "inv_first"), line("l2", second, "inv_second")],
  createdByMemberId: "m_owner",
  reviewedByMemberId: "m_reviewer",
  reviewedAt: now,
  activity: [],
  createdAt: now,
  updatedAt: now,
} as any);

// Line 1 is built; line 2 is refused the way buildTransferFromQuote refuses.
const built: { quoteId: string; recipientIban?: string; reference?: string }[] = [];
const REFUSAL = "a passkey Safe is required to send";
const builder: TransferFactory = async (quote, recipient) => {
  built.push({ quoteId: quote.id, recipientIban: recipient.recipientIban, reference: recipient.reference });
  if (built.length > 1) return { ok: false, status: 409, body: { error: REFUSAL } };
  return { ok: true, transfer: { id: "t_first" }, authorization: { userOpHash: "0x01" } };
};

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const deps = { ctxOf: (req: any, res: any) => resolveOrg(req, res, requireSession) };
app.use("/api/orgs", createDraftRoutes(deps, builder, async () => ({ safeBalanceEur: 1000 })));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const execute = async () => {
  const res = await fetch(`${API}/api/orgs/org_1/drafts/d_batch/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": "u_owner" },
  });
  return { status: res.status, data: (await res.json()) as any };
};

console.log("\nA batch that fails on its second line");

const run = await execute();

await check("the failure carries the builder's status and its refusal, naming the line", () => {
  assert.equal(run.status, 409, JSON.stringify(run.data));
  assert.match(run.data.error, /Line l2 could not be prepared, so the batch was stopped/);
  assert.equal(run.data.detail, REFUSAL);
});

await check("both lines were attempted, in order, each with its own quote", () => {
  assert.equal(built.length, 2);
  assert.notEqual(built[0].quoteId, built[1].quoteId);
  assert.deepEqual(built.map((b) => b.recipientIban), ["DE89370400440532013000", "DE02120300000000202051"]);
  assert.deepEqual(built.map((b) => b.reference), ["Invoice R-1 Zoldenburg UG", "Invoice R-2 Zoldenburg UG"]);
});

await check("the response says nothing moved and lists the transfer left unsigned", () => {
  assert.deepEqual(run.data.createdButUnsigned, ["t_first"]);
  assert.match(run.data.note, /Nothing moved/);
});

const after = store.findDraft("d_batch")!;
await check("the draft is FAILED with the reason and the unsigned transfer recorded", () => {
  assert.equal(after.state, "FAILED");
  assert.match(after.failureReason!, /Line l2 could not be prepared: a passkey Safe is required/);
  assert.deepEqual(after.transferIds, ["t_first"]);
  assert.equal(after.activity.at(-1)?.action, "execution_failed");
  assert.equal(after.activity.at(-1)?.actorMemberId, "m_owner");
});

await check("the invoice the batch had not reached is released for a fresh draft", () => {
  const inv = store.findInvoice("inv_second")!;
  assert.equal(inv.state, "SUBMITTED");
  assert.equal(inv.payment?.draftId, undefined);
});

await check("the invoice whose line was built follows its transfer, not the draft", () => {
  const inv = store.findInvoice("inv_first")!;
  assert.equal(inv.state, "PAYING");
  assert.equal(inv.payment?.transferId, "t_first");
});

const replay = await execute();
await check("a FAILED draft cannot be re-fired: no third build, no new transfer", () => {
  assert.equal(replay.status, 409);
  assert.match(replay.data.error, /This draft is FAILED/);
  assert.equal(built.length, 2);
  assert.deepEqual(store.findDraft("d_batch")!.transferIds, ["t_first"]);
});

server.close();
monerium.close();
if (process.exitCode) {
  console.error(`\nDRAFT BATCH FAILURE TEST FAILED`);
} else {
  console.log(`\nDRAFT BATCH FAILURE TEST PASSED — ${passed} checks.`);
  console.log("NOT PROVEN HERE: the transfer builder itself. It is stubbed; draft:test drives the real one.");
}
