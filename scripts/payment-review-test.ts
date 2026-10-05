/**
 * Payment review as the organisation's own policy, and drafts that can be
 * edited and cancelled until sending starts.
 *
 * Review is a paid feature to switch on, but once an org works with it a
 * lapsed trial or a downgrade must not remove it: only an owner turns it off,
 * with a fresh passkey approval. Drafts already waiting for review keep
 * waiting and stay reviewable. A draft is a proposal, so it can be edited
 * (which sends a waiting or approved one back to Draft) or cancelled (kept as
 * CANCELLED, never deleted) until execution starts.
 *
 * In-process routers against a fake Monerium and a passkey made here; no
 * chain. Sending is observed up to the claim: a draft that passed the
 * review gate either moves on or is refused for a later reason, never by the
 * gate's own words.
 *
 * Run: npm run payment-review:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-payment-review-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-payment-review-32";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";

// ── A fake Monerium: one corporate profile behind one OAuth token ───────────
const CORP = { id: "22222222-aaaa-4bbb-8ccc-000000000001", kind: "corporate", state: "approved", name: "Acme Technik GmbH" };
const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (String(req.headers.authorization ?? "") !== "Bearer tok-owner") return send(401, { code: 401 });
  if (url.pathname === "/profiles") return send(200, { profiles: [CORP], total: 1 });
  if (url.pathname === "/ibans") return send(200, { ibans: [] });
  if (url.pathname === `/profiles/${CORP.id}`) return send(200, { id: CORP.id, kind: CORP.kind, state: CORP.state, details: { state: "approved" }, form: { state: "approved" }, verifications: [] });
  send(404, { code: 404 });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { encryptToken } = await import("../services/api/src/adapters/monerium-connection.js");
const { issueChallenge, verifyRegistration } = await import("../services/api/src/webauthn.js");
const { paymentReviewRequired, reviewHeldOnPlanChange } = await import("../services/api/src/domain/payment-review.js");
const { assertTransition, isCancellable, isEditable } = await import("../services/api/src/domain/drafts.js");
const { HARNESS, SECURITY } = await import("../services/api/src/config.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

// ── A P-256 passkey, registered and asserted the way a browser would ────────
const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
function cbor(v: any): Buffer {
  const head = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}
function derOf(raw: Buffer) {
  const int = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0x02, b.length + 1, 0]), b]) : Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const r = int(raw.subarray(0, 32)); const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}
const ORIGIN = SECURITY.origins.find((o: string) => o.startsWith("http://localhost"))!;
const clientData = (type: string, challenge: string) => b64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));
async function makePasskey(userId: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const credId = randomBytes(16);
  const authData = (flags: number, count: number, att = false) => {
    const base = Buffer.alloc(37); sha256(SECURITY.rpId).copy(base, 0); base[32] = flags; base.writeUInt32BE(count, 33);
    if (!att) return base;
    const cred = Buffer.alloc(18 + credId.length); cred.writeUInt16BE(credId.length, 16); credId.copy(cred, 18);
    return Buffer.concat([base, cred, cose]);
  };
  const challenge = issueChallenge("register", userId);
  const attestation = b64url(cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, 0, true)]])));
  const reg = verifyRegistration(attestation, clientData("webauthn.create", challenge), SECURITY.rpId, SECURITY.origins, userId);
  let count = 0;
  return {
    stored: { credentialId: reg.credentialId, publicKey: reg.key, signCount: 0, rpId: SECURITY.rpId, createdAt: new Date().toISOString() },
    /** A step-up assertion (user verified) over a fresh step_up challenge. */
    stepUp: async () => {
      count += 1;
      const cd = clientData("webauthn.get", issueChallenge("step_up", userId));
      const ad = authData(0x05, count);
      const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([ad, sha256(Buffer.from(cd, "base64url"))])));
      return { credentialId: reg.credentialId, authenticatorData: b64url(ad), clientDataJSON: cd, signature: b64url(derOf(raw)) };
    },
  };
}

// ── An org with an owner (whose account funds it), an admin and a payer ─────
initStore();
const now = new Date().toISOString();
const ownerKey = await makePasskey("u_owner");
store.addUser({
  id: "u_owner", name: "Olga Owner", country: "DE", kycStatus: "approved", createdAt: now,
  address: `0x${"1".repeat(40)}`, iban: "DE89370400440532013000",
  funding: { mode: "sandbox", status: "active", moneriumProfileId: CORP.id },
  monerium: { connectedAt: now, method: "oauth", profileId: CORP.id, accessTokenEnc: encryptToken("tok-owner"), profiles: [{ id: CORP.id, kind: CORP.kind, state: CORP.state }] },
  passkey: ownerKey.stored,
} as any);
for (const id of ["u_admin", "u_payer", "u_viewer"]) store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: now } as any);

function addOrg(id: string, plan: string, over: Record<string, unknown> = {}) {
  store.addOrganisation({ id, type: "business", name: "Acme Technik GmbH", legalName: "Acme Technik GmbH", plan, reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now, ...over } as any);
  for (const [userId, role] of [["u_owner", "owner"], ["u_admin", "admin"], ["u_payer", "payer"], ["u_viewer", "viewer"]]) {
    store.addMember({ id: `m_${id}_${userId}`, orgId: id, userId, email: "", role: role as any, status: "active", invitedAt: now, acceptedAt: now });
  }
  store.addAccount({ id: `acc_${id}`, orgId: id, currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, gate: { reason: "no funding identity", needs: "a member's account" }, createdAt: now, updatedAt: now });
  store.addContact({ id: `c_${id}`, orgId: id, name: "Supplier GmbH", wallets: [], bankAccounts: [{ id: `ba_${id}`, currency: "EUR", country: "DE", iban: "DE02120300000000202051", holderName: "Supplier GmbH" }], createdAt: now, updatedAt: now } as any);
}

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession));
const noTransfers = (async () => { throw new Error("no transfer is built in this suite"); }) as any;
/** Runs inside the balance read, the last await before the claim. */
let duringBalanceRead: (() => void) | undefined;
const richBalance = async () => { duringBalanceRead?.(); return { safeBalanceEur: 1_000_000 }; };
app.use("/api/orgs", createDraftRoutes({ ctxOf: (req: any, res: any) => resolveOrg(req, res, requireSession) }, noTransfers, richBalance));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, asUser: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

const line = (orgId: string, amount = "10.00") => ({
  contactId: `c_${orgId}`, destination: { kind: "bank", bankAccountId: `ba_${orgId}`, displayName: "Supplier GmbH" }, asset: "EUR", amount,
});
async function draftIn(orgId: string, asUser = "u_payer", amount?: string) {
  const r = await call("POST", `/api/orgs/${orgId}/drafts`, asUser, { source: { kind: "account", accountId: `acc_${orgId}` }, lines: [line(orgId, amount)] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.draft.id as string;
}
const stateOf = (id: string) => store.findDraft(id)!.state;
const GATE = /requires a second person to review|is waiting for review/;
/** Execute as the owner (the only member who can sign for the account) and
 *  say whether the review gate let it through. */
async function sendGate(orgId: string, draftId: string) {
  const r = await call("POST", `/api/orgs/${orgId}/drafts/${draftId}/execute`, "u_owner");
  return { passed: !(r.status === 409 && GATE.test(String(r.data.error))), r };
}

console.log("\nPolicy rules");

await check("the harness is off: the passkey approval below is checked for real", () => {
  assert.equal(HARNESS.enabled, false);
});

await check("review follows the plan until something sets it, and a trial that granted it keeps it after it ends", () => {
  const base = { type: "business" as const, plan: "starter" as const };
  assert.equal(paymentReviewRequired({ ...base }), false);
  assert.equal(paymentReviewRequired({ ...base, plan: "business" }), true);
  const ended = { grantsPlan: "business" as const, startedAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-31T00:00:00Z", endedAt: "2026-01-31T00:00:00Z" };
  assert.equal(paymentReviewRequired({ ...base, trial: ended }), true, "a lapsed trial does not drop review");
  assert.equal(paymentReviewRequired({ ...base, trial: ended, paymentReview: { required: false, changedAt: now, source: "owner" } }), false);
  assert.equal(paymentReviewRequired({ ...base, plan: "business", paymentReview: { required: false, changedAt: now, source: "owner" } }), false, "an owner's choice wins over the plan");
});

await check("leaving a plan with review records the policy; a plan change that keeps or never had review records nothing", () => {
  const onBusiness = { type: "business" as const, plan: "business" as const };
  assert.deepEqual(reviewHeldOnPlanChange(onBusiness, "business"), {});
  assert.equal((reviewHeldOnPlanChange(onBusiness, "starter") as any).paymentReview.required, true);
  assert.equal((reviewHeldOnPlanChange(onBusiness, "starter") as any).paymentReview.source, "plan_change");
  assert.deepEqual(reviewHeldOnPlanChange({ type: "business", plan: "starter" }, "starter"), {});
});

await check("a draft is editable and cancellable until execution starts, and CANCELLED is final", () => {
  for (const s of ["DRAFT", "INVALID_DATA", "REJECTED", "PENDING_REVIEW", "REVIEWED"] as const) {
    assert.ok(isEditable(s), `${s} editable`);
    assert.ok(isCancellable(s), `${s} cancellable`);
  }
  for (const s of ["EXECUTING", "EXECUTED", "FAILED", "CANCELLED"] as const) {
    assert.ok(!isEditable(s), `${s} not editable`);
    assert.ok(!isCancellable(s), `${s} not cancellable`);
  }
  assert.throws(() => assertTransition("CANCELLED", "DRAFT"), /final state/);
});

console.log("\nA downgrade keeps review");

addOrg("org_a", "business");
await check("the owner funds the business account from their own Monerium company profile", async () => {
  const r = await call("POST", "/api/orgs/org_a/accounts/acc_org_a/fund", "u_owner");
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

let waiting = "";
let approved = "";
await check("on the business plan a draft is submitted, and an unreviewed draft is not sent", async () => {
  waiting = await draftIn("org_a");
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${waiting}/submit`, "u_payer")).status, 200);
  assert.equal(stateOf(waiting), "PENDING_REVIEW");
  approved = await draftIn("org_a");
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${approved}/submit`, "u_payer")).status, 200);
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${approved}/review`, "u_admin", { approve: true })).status, 200);
  const plain = await draftIn("org_a");
  assert.equal((await sendGate("org_a", plain)).passed, false);
  assert.equal(stateOf(plain), "DRAFT");
});

await check("the owner downgrades: the org says review is still required, recorded as kept from the plan", async () => {
  const r = await call("POST", "/api/orgs/org_a/plan", "u_owner", { plan: "starter" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.organisation.capabilities["transfers.approvals"].allowed, false);
  assert.equal(r.data.organisation.paymentReview.required, true);
  assert.equal(store.findOrganisation("org_a")!.paymentReview?.source, "plan_change");
});

await check("after the downgrade an unreviewed draft is still not sent, and a new one can still be submitted", async () => {
  const d = await draftIn("org_a");
  const g = await sendGate("org_a", d);
  assert.equal(g.passed, false, JSON.stringify(g.r.data));
  assert.equal(stateOf(d), "DRAFT");
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${d}/submit`, "u_payer")).status, 200);
});

await check("after the downgrade a waiting draft can still be reviewed, by someone other than its drafter", async () => {
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${waiting}/review`, "u_payer", { approve: true })).status, 403);
  const r = await call("POST", `/api/orgs/org_a/drafts/${waiting}/review`, "u_admin", { approve: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(stateOf(waiting), "REVIEWED");
});

await check("after the downgrade an approved draft passes the review gate", async () => {
  const g = await sendGate("org_a", approved);
  assert.equal(g.passed, true, JSON.stringify(g.r.data));
});

console.log("\nOnly an owner turns review off, with a passkey");

let stillWaiting = "";
await check("an admin cannot turn review off", async () => {
  stillWaiting = await draftIn("org_a");
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${stillWaiting}/submit`, "u_payer")).status, 200);
  const r = await call("POST", "/api/orgs/org_a/payment-review", "u_admin", { required: false });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(paymentReviewRequired(store.findOrganisation("org_a")!), true);
});

await check("an owner without a fresh passkey approval cannot turn it off, and nothing changes", async () => {
  const r = await call("POST", "/api/orgs/org_a/payment-review", "u_owner", { required: false });
  assert.equal(r.status, 401, JSON.stringify(r.data));
  assert.equal(store.findOrganisation("org_a")!.paymentReview?.source, "plan_change");
});

await check("an owner with a fresh passkey approval turns it off, and the change is audited", async () => {
  const r = await call("POST", "/api/orgs/org_a/payment-review", "u_owner", { required: false, stepUp: await ownerKey.stepUp() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.organisation.paymentReview.required, false);
  assert.equal(r.data.organisation.paymentReview.source, "owner");
  const audit = store.auditFor(undefined, 10_000).filter((e) => e.kind === "org.payment_review_changed");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].data.required, false);
  assert.equal(audit[0].userId, "u_owner");
});

await check("with review off a new draft passes the review gate without review", async () => {
  const d = await draftIn("org_a");
  const g = await sendGate("org_a", d);
  assert.equal(g.passed, true, JSON.stringify(g.r.data));
});

await check("with review off a draft that was waiting still waits: it is not sent until someone reviews it", async () => {
  const g = await sendGate("org_a", stillWaiting);
  assert.equal(g.passed, false, JSON.stringify(g.r.data));
  assert.match(g.r.data.error, /waiting for review/);
  assert.equal(stateOf(stillWaiting), "PENDING_REVIEW");
  assert.equal((await call("POST", `/api/orgs/org_a/drafts/${stillWaiting}/review`, "u_admin", { approve: true })).status, 200);
  assert.equal(stateOf(stillWaiting), "REVIEWED");
});

await check("turning review back on needs the plan: refused on starter", async () => {
  const r = await call("POST", "/api/orgs/org_a/payment-review", "u_owner", { required: true });
  assert.equal(r.status, 402, JSON.stringify(r.data));
  assert.equal(paymentReviewRequired(store.findOrganisation("org_a")!), false);
});

await check("on a plan with review an owner turns it back on without a passkey (it adds a control)", async () => {
  addOrg("org_b", "business");
  const off = await call("POST", "/api/orgs/org_b/payment-review", "u_owner", { required: false, stepUp: await ownerKey.stepUp() });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const on = await call("POST", "/api/orgs/org_b/payment-review", "u_owner", { required: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.organisation.paymentReview.required, true);
});

await check("with review off, an edit that lands while a run is being prepared stops it: what is sent is what was checked", async () => {
  const d = await draftIn("org_a");
  duringBalanceRead = () => {
    const row = store.findDraft(d)!;
    store.updateDraft(d, { lines: row.lines.map((l) => ({ ...l, amount: "9000.00" })) });
  };
  try {
    const r = await call("POST", `/api/orgs/org_a/drafts/${d}/execute`, "u_owner");
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /changed while it was being prepared/);
    assert.equal(stateOf(d), "DRAFT");
  } finally {
    duringBalanceRead = undefined;
  }
});

console.log("\nEdit and cancel a draft");

addOrg("org_c", "business");
{
  // One Monerium profile backs one org's account, so this org's account is
  // given the same funding identity directly rather than adopted again.
  const { id, orgId, ...funded } = store.findAccount("acc_org_a")! as any;
  store.updateAccount("acc_org_c", { ...funded, gate: undefined } as any);
}
await check("an approved draft can be edited: it goes back to DRAFT, its review is cleared and the editor becomes its drafter", async () => {
  const d = await draftIn("org_c");
  await call("POST", `/api/orgs/org_c/drafts/${d}/submit`, "u_payer");
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${d}/review`, "u_admin", { approve: true })).status, 200);
  const row = store.findDraft(d)!;
  const r = await call("PATCH", `/api/orgs/org_c/drafts/${d}`, "u_admin", { lines: row.lines.map((l) => ({ ...l, amount: "12.50" })) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft.state, "DRAFT");
  assert.equal(r.data.draft.lines[0].amount, "12.50");
  assert.equal(r.data.draft.reviewedByMemberId, undefined);
  assert.equal(r.data.draft.createdByMemberId, "m_org_c_u_admin");
  // Four eyes against the new drafter: the admin who edited it cannot approve it.
  await call("POST", `/api/orgs/org_c/drafts/${d}/submit`, "u_admin");
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${d}/review`, "u_admin", { approve: true })).status, 403);
});

await check("a waiting draft can be edited too, and goes back to DRAFT", async () => {
  const d = await draftIn("org_c");
  await call("POST", `/api/orgs/org_c/drafts/${d}/submit`, "u_payer");
  const r = await call("PATCH", `/api/orgs/org_c/drafts/${d}`, "u_payer", { lines: store.findDraft(d)!.lines });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(stateOf(d), "DRAFT");
});

await check("a draft is cancelled by whoever may propose or review payments; the row is kept with who and why", async () => {
  const d = await draftIn("org_c");
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${d}/cancel`, "u_viewer")).status, 403);
  const r = await call("POST", `/api/orgs/org_c/drafts/${d}/cancel`, "u_payer", { reason: "Paid by card instead" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(stateOf(d), "CANCELLED");
  const last = store.findDraft(d)!.activity.at(-1)!;
  assert.equal(last.action, "cancelled");
  assert.equal(last.detail, "Paid by card instead");
  assert.equal(last.actorMemberId, "m_org_c_u_payer");
  assert.ok(store.draftsOf("org_c").some((x) => x.id === d), "a cancelled draft is kept, not deleted");
});

await check("waiting and approved drafts can be cancelled; a cancelled one cannot be sent, edited, reviewed or cancelled again", async () => {
  const w = await draftIn("org_c");
  await call("POST", `/api/orgs/org_c/drafts/${w}/submit`, "u_payer");
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${w}/cancel`, "u_admin")).status, 200);
  const a = await draftIn("org_c");
  await call("POST", `/api/orgs/org_c/drafts/${a}/submit`, "u_payer");
  await call("POST", `/api/orgs/org_c/drafts/${a}/review`, "u_admin", { approve: true });
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${a}/cancel`, "u_payer")).status, 200);
  const sent = await sendGate("org_c", a);
  assert.equal(sent.passed, false, JSON.stringify(sent.r));
  assert.equal((await call("PATCH", `/api/orgs/org_c/drafts/${a}`, "u_payer", { lines: store.findDraft(a)!.lines })).status, 409);
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${a}/review`, "u_admin", { approve: true })).status, 400);
  assert.equal((await call("POST", `/api/orgs/org_c/drafts/${a}/cancel`, "u_payer")).status, 409);
  assert.equal(stateOf(a), "CANCELLED");
});

await check("a draft that has started sending cannot be cancelled", async () => {
  const d = await draftIn("org_c");
  store.updateDraft(d, { state: "EXECUTING" });
  const r = await call("POST", `/api/orgs/org_c/drafts/${d}/cancel`, "u_owner");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(stateOf(d), "EXECUTING");
});

await check("cancelled drafts do not count against the open-drafts ceiling", async () => {
  const before = store.draftsOf("org_c").filter((x) => !["EXECUTED", "FAILED", "REJECTED", "CANCELLED"].includes(x.state)).length;
  const d = await draftIn("org_c");
  await call("POST", `/api/orgs/org_c/drafts/${d}/cancel`, "u_payer");
  const after = store.draftsOf("org_c").filter((x) => !["EXECUTED", "FAILED", "REJECTED", "CANCELLED"].includes(x.state)).length;
  assert.equal(after, before);
});

server.close();
monerium.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
