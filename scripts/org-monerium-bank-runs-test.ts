/**
 * A company bank run: a draft of bank payees paid from the company's own IBAN
 * (routes/business/org-monerium-bank-runs.ts, domain/company-bank-run.ts).
 *
 * Covers:
 *   - execute never builds transfers for a company: it names where an owner
 *     signs the run (COMPANY_BANK_RUN_SIGN);
 *   - the switch, and everything a single payout refuses: keys missing, IBAN
 *     moved, a Safe needing 2+ signatures (ORG_SAFE_NEEDS_MORE_SIGNATURES),
 *     an expired approval; nothing is signed or sent;
 *   - roles: payers and admins prepare but do not sign; an owner whose passkey
 *     is not on the Safe is refused; no review step (Q8): the owner's
 *     signature is the approval, whatever the org's review setting, and a
 *     rejected draft is still never sent;
 *   - the balance across lines: lines that each fit but together do not are
 *     refused, and payouts pending or unclear at Monerium, and approvals still
 *     waiting, count against it;
 *   - the payee fingerprint: re-checked at start and again at submission, so
 *     an address-book edit after signing sends nothing;
 *   - every line signed before the first is sent: a missing, repeated or bad
 *     assertion, or an edit after signing, sends nothing;
 *   - the run: one redeem per line, in order, each with its own message and
 *     Safe signature; booked as sepa_out only once Monerium processed it;
 *     EXECUTED only when every line is sent;
 *   - partial failure: a line Monerium refuses stops the run; earlier lines
 *     stay placed, later lines are never sent, the draft reads FAILED with
 *     each line's state;
 *   - unknown mid-run: the run stops, the line is `unknown`, it holds its
 *     money, nothing is retried, and the run cannot be sent again;
 *   - a run line cannot be sent through the single-payout route;
 *   - Monerium's response body never reaches the browser or the log;
 *   - the words after signing (org-monerium-model.js): placed is not sent, a
 *     stopped run says where it stopped and what each line did.
 *
 * Offline: Monerium, the chain read, the balance and the Safe signature are
 * stubs; the passkeys are software keys.
 * Run: npm run org-monerium-bank-runs:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-bank-run-")), "db.json");
process.env.TRANSF_DB_PATH = DB;
process.env.TRANSF_CHAIN_ID = "31337";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.MONERIUM_ORG_PAYOUTS = "on";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { createOrgMoneriumPayoutRoutes, clearPendingPayouts } = await import("../services/api/src/routes/business/org-monerium-payouts.js");
const { createOrgMoneriumBankRunRoutes } = await import("../services/api/src/routes/business/org-monerium-bank-runs.js");
const { MoneriumApiError } = await import("../services/api/src/adapters/monerium-client.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { safeMessageHash } = await import("../services/api/src/wallet/candide.js");
const { passkeySafeChallenge } = await import("../services/api/src/wallet/passkey-safe-plan.js");
const { MONERIUM } = await import("../services/api/src/config.js");
const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
const { bankRunDraftState, bankRunLineState } = await import("../services/api/src/domain/company-bank-run.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/org-monerium-model.js")).href);
const paymentModel: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/payment-model.js")).href);
await initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

// ── a company: two owners (one not on the Safe), an admin, a payer ──────────
const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const OTHER_SAFE = "0x0000000000000000000000000000000000f0f0f0" as const;
const PROFILE = "prof-corp-1";
const IBAN = "DE02100100109307118603";
const PAYEES = [
  { id: "c_bob", name: "Bob GmbH", iban: "DE89370400440532013000" },
  { id: "c_cara", name: "Cara Schmidt", iban: "DE12500105170648489890" },
  { id: "c_dora", name: "Dora AG", iban: "DE02120300000000202051" },
];
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
const hex = (b64: string) => ("0x" + Buffer.from(b64, "base64url").toString("hex")) as `0x${string}`;
const orgRow = async (id: string, entity: string) =>
  await store.addOrganisation({ id, type: "business", entity, name: "Acme GmbH", legalName: "Acme GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
await orgRow("org_co", "company");
await orgRow("org_st", "sole_trader");
for (const p of ["anna", "otto", "adam", "pia"] as const) {
  keys[p] = await makeSoftwarePasskey(p, ORIGIN);
  addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  await store.addUser({
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved",
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
  const role = p === "adam" ? "admin" : p === "pia" ? "payer" : "owner";
  await store.addMember({ id: `m_${p}`, orgId: "org_co", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
await store.addMember({ id: "m_st", orgId: "org_st", userId: "u_anna", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
await store.setOrgSafePlan("org_co", { kind: "org", status: "active", address: SAFE, owners: [{ x: hex(keys.anna.jwk.x!), y: hex(keys.anna.jwk.y!) }], createdAt: now } as any);
await store.addAccount({
  id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "active", provider: null,
  identifier: { iban: IBAN }, address: SAFE,
  moneriumProfile: { id: PROFILE, kind: "corporate", name: "Acme GmbH", checkedAt: now },
  createdAt: now, updatedAt: now,
} as any);
await store.addAccount({ id: "acc_st", orgId: "org_st", currency: "EUR", label: "EUR", status: "active", provider: null, identifier: {}, createdAt: now, updatedAt: now } as any);
for (const c of PAYEES) {
  await store.addContact({ id: c.id, orgId: "org_co", name: c.name, wallets: [], bankAccounts: [{ id: `${c.id}_b`, currency: "EUR", country: "DE", holderName: c.name, iban: c.iban }], createdAt: now, updatedAt: now } as any);
}
const connected = (state = "approved") => ({
  clientId: "test-client-id-0000-1111",
  clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", "test-secret-placeholder-" + Math.random().toString(36).slice(2)),
  profile: { id: PROFILE, name: "Acme GmbH", state }, connectedAt: now, checkedAt: now, connectedByMemberId: "m_adam",
});

// ── stubs: the chain, the balance, the Safe signature, Monerium ────────────
const chain = { owners: [addr.anna] as `0x${string}`[], threshold: 1 };
const signed: string[] = [];
let bal = 1000;
const PROVIDER_BODY = "provider-body-marker-must-not-reach-the-browser";
const freshMon = () => ({
  ibans: [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: MONERIUM.chain, state: "approved" }] as any[],
  placed: [] as any[],
  attempts: 0,
  /** Thrown by the n-th placeOrder (1-based). */
  failAt: undefined as undefined | { n: number; err: unknown },
  orders: {} as Record<string, any>,
});
const mon = freshMon();
const client = {
  async ibans() { return { ibans: mon.ibans.map((i) => ({ ...i })) }; },
  async placeOrder(body: any) {
    mon.attempts++;
    if (mon.failAt?.n === mon.attempts) throw mon.failAt.err;
    mon.placed.push(body);
    return { id: `ord_${mon.attempts}`, meta: { state: "pending" } };
  },
  async getOrder(id: string) {
    const order = mon.orders[id];
    if (!order) throw new MoneriumApiError("Monerium answered 500", 500);
    return order;
  },
};
const io = {
  monerium: (org: any) => {
    assert.ok(org.monerium, "Monerium is only asked on the company's keys");
    return client;
  },
  safe: { read: async () => ({ owners: [...chain.owners], threshold: chain.threshold }) },
  sign: (_owner: any, a: any) => {
    const sig = `0x${Buffer.from(a.signature).toString("hex").slice(0, 16)}` as `0x${string}`;
    signed.push(sig);
    return sig;
  },
  balance: async () => bal,
};

const reset = async () => {
  await store.updateOrganisation("org_co", { monerium: connected() as any, paymentReview: undefined } as any);
  await store.updateAccount("acc_co", {
    status: "active", provider: null, address: SAFE, identifier: { iban: IBAN },
    moneriumProfile: { id: PROFILE, kind: "corporate", name: "Acme GmbH", checkedAt: now },
    moneriumIban: undefined, moneriumPayouts: [],
  } as any);
  for (const c of PAYEES) await store.updateContact(c.id, { bankAccounts: [{ id: `${c.id}_b`, currency: "EUR", country: "DE", holderName: c.name, iban: c.iban }] } as any);
  Object.assign(mon, freshMon());
  chain.owners = [addr.anna];
  chain.threshold = 1;
  signed.length = 0;
  bal = 1000;
  clearPendingPayouts();
};

const noTransfers = (async () => { throw new Error("a company bank run must never build a transfer"); }) as any;
const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
const deps = { ctxOf: (req: any, res: any) => resolveOrg(req, res, requireSession as any) };
app.use("/api/orgs", createDraftRoutes(deps, noTransfers, async () => ({ safeBalanceEur: 1000 })));
app.use("/api/orgs", createOrgMoneriumPayoutRoutes(deps, io as any));
app.use("/api/orgs", createOrgMoneriumBankRunRoutes(deps, io as any));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, data: (text ? JSON.parse(text) : {}) as any };
};

/** A draft by the payer, reviewed by the admin (four eyes). */
const draftOf = async (amounts: string[], opts: { review?: boolean; org?: string; account?: string } = {}) => {
  const org = opts.org ?? "org_co";
  const lines = amounts.map((amount, i) => {
    const c = PAYEES[i];
    return { contactId: c.id, destination: { kind: "bank", bankAccountId: `${c.id}_b`, displayName: c.name }, asset: "EUR", amount };
  });
  const d = await call("POST", `/${org}/drafts`, org === "org_co" ? "u_pia" : "u_anna", { source: { kind: "account", accountId: opts.account ?? "acc_co" }, lines });
  assert.equal(d.status, 201, d.text);
  const id = d.data.draft.id as string;
  if (opts.review !== false && org === "org_co") {
    assert.equal((await call("POST", `/${org}/drafts/${id}/submit`, "u_pia")).status, 200);
    const rv = await call("POST", `/${org}/drafts/${id}/review`, "u_adam", { approve: true });
    assert.equal(rv.status, 200, rv.text);
  }
  return id;
};
const start = (id: string, user = "u_anna") => call("POST", `/org_co/drafts/${id}/bank-run/start`, user);
const assertionsFor = async (s: any, p = "anna") => {
  const out = [];
  for (const l of s.lines) {
    const a = await keys[p].assert(l.challenge);
    out.push({ requestId: l.requestId, ...a });
  }
  return out;
};
/** Start, sign every line with `p`'s passkey, submit. */
const run = async (id: string, p = "anna", tamper?: (body: any) => void | Promise<void>) => {
  const s = await start(id, `u_${p}`);
  if (s.status !== 201) return s;
  const body = { runId: s.data.runId, assertions: await assertionsFor(s.data, p) };
  await tamper?.(body);
  return call("POST", s.data.submitTo.replace("/api/orgs", ""), `u_${p}`, body);
};
const payouts = async () => (await store.findAccount("acc_co"))!.moneriumPayouts ?? [];
const draft = async (id: string) => (await call("GET", `/org_co/drafts/${id}`, "u_anna")).data.draft;
/** Every write the run makes, checked against the file on disk right after
 *  it: what a process that stopped there would leave behind. */
const onDisk = () => JSON.parse(readFileSync(DB, "utf8"));
const halfWritten = (): string[] => {
  const db = onDisk();
  const rows = new Map<string, any>();
  for (const a of db.accounts ?? []) for (const p of a.moneriumPayouts ?? []) rows.set(p.id, p);
  const bad: string[] = [];
  for (const d of db.drafts ?? []) {
    if (d.orgId !== "org_co") continue;
    if (d.state === "EXECUTING" && !d.bankRun && !d.transferIds?.length && !d.cryptoSendIds?.length) bad.push(`${d.id} EXECUTING without its run`);
    for (const l of d.bankRun?.lines ?? []) {
      const row = rows.get(l.payoutId);
      if (l.state === "sending" && !row) bad.push(`${l.lineId} sending without its payout row`);
      if (row && l.state !== "sending" && row.state !== l.state) bad.push(`${l.lineId} reads ${l.state}, its row ${row.state}`);
      if (row && l.state === "signed") bad.push(`${l.lineId} signed although its row exists`);
    }
  }
  return bad;
};
const watchWrites = () => {
  const seen: string[] = [];
  const names = ["claimDraftExecution", "appendDraftActivity", "updateDraft", "updateDraftFrom", "updateAccount"] as const;
  const saved = names.map((n) => [n, (store as any)[n]] as const);
  for (const [n, fn] of saved) {
    (store as any)[n] = async (...args: unknown[]) => {
      const out = await fn(...args);
      for (const b of halfWritten()) seen.push(`after ${n}: ${b}`);
      return out;
    };
  }
  return { seen, stop: () => { for (const [n, fn] of saved) (store as any)[n] = fn; } };
};
const nothingSent = async () => {
  assert.equal(mon.attempts, 0, "no order asked for");
  assert.deepEqual(await payouts(), [], "no payout row");
};

try {
  await reset();

  await check("execute never builds transfers for a company: it names where an owner signs the run", async () => {
    const id = await draftOf(["10"]);
    const x = await call("POST", `/org_co/drafts/${id}/execute`, "u_pia");
    assert.equal(x.status, 409, x.text);
    assert.equal(x.data.code, "COMPANY_BANK_RUN_SIGN");
    assert.equal(x.data.startTo, `/api/orgs/org_co/drafts/${id}/bank-run/start`);
    assert.equal((await draft(id)).state, "REVIEWED");
    await nothingSent();
  });

  await check("switched off: refused by name, nothing signed or sent", async () => {
    await reset();
    const id = await draftOf(["10"]);
    process.env.MONERIUM_ORG_PAYOUTS = "off";
    try {
      const r = await start(id);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.data.code, "ORG_PAYOUTS_OFF");
    } finally {
      process.env.MONERIUM_ORG_PAYOUTS = "on";
    }
    await nothingSent();
  });

  await check("roles: payers and admins prepare but do not sign; an owner off the Safe and a sole trader are refused", async () => {
    await reset();
    const id = await draftOf(["10", "20"]);
    for (const u of ["u_pia", "u_adam"]) {
      const r = await start(id, u);
      assert.equal(r.status, 403, `${u}: ${r.text}`);
      assert.equal(r.data.code, "OWNER_SIGNS");
    }
    // Otto is an owner member, but his passkey is not an owner of the Safe.
    const otto = await start(id, "u_otto");
    assert.equal(otto.status, 403, otto.text);
    assert.equal(otto.data.code, "NOT_A_SIGNER");
    const stId = await draftOf(["10"], { org: "org_st", account: "acc_st" });
    const st = await call("POST", `/org_st/drafts/${stId}/bank-run/start`, "u_anna");
    assert.equal(st.status, 409, st.text);
    assert.equal(st.data.code, "NOT_A_COMPANY");
    await nothingSent();
  });

  await check("no review step: the owner's signature is the approval, whatever the org's review setting", async () => {
    await reset();
    // The business plan turns review on for this org; a company run ignores it.
    const { paymentReviewRequired } = await import("../services/api/src/domain/payment-review.js");
    assert.equal(paymentReviewRequired((await store.findOrganisation("org_co"))!), true);
    const draftOnly = await draftOf(["10"], { review: false });
    assert.equal((await draft(draftOnly)).state, "DRAFT");
    assert.equal((await run(draftOnly)).status, 201);
    await reset();
    const waiting = await draftOf(["10"], { review: false });
    assert.equal((await call("POST", `/org_co/drafts/${waiting}/submit`, "u_pia")).status, 200);
    assert.equal((await run(waiting)).status, 201);
    assert.equal(mon.placed.length, 1);
    // A rejected or cancelled draft is still never sent.
    await reset();
    const rejected = await draftOf(["10"], { review: false });
    assert.equal((await call("POST", `/org_co/drafts/${rejected}/submit`, "u_pia")).status, 200);
    assert.equal((await call("POST", `/org_co/drafts/${rejected}/review`, "u_adam", { approve: false, reason: "no" })).status, 200);
    const r = await start(rejected);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "NOT_SENDABLE");
    await nothingSent();
  });

  await check("a Safe needing 2+ signatures, missing keys, a moved IBAN: refused by name, nothing sent", async () => {
    await reset();
    const id = await draftOf(["10", "20"]);
    chain.owners = [addr.anna, addr.otto];
    chain.threshold = 2;
    const t = await start(id);
    assert.equal(t.status, 409, t.text);
    assert.equal(t.data.code, "ORG_SAFE_NEEDS_MORE_SIGNATURES");
    chain.owners = [addr.anna];
    chain.threshold = 1;
    await store.updateOrganisation("org_co", { monerium: undefined });
    assert.equal((await start(id)).data.code, "MONERIUM_NOT_CONNECTED");
    await store.updateOrganisation("org_co", { monerium: connected() as any });
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: OTHER_SAFE, chain: MONERIUM.chain, state: "approved" }];
    assert.equal((await start(id)).data.code, "IBAN_MOVED");
    await nothingSent();
  });

  await check("the threshold is read again at submission: raised after signing, nothing is sent", async () => {
    await reset();
    const id = await draftOf(["10", "20"]);
    const r = await run(id, "anna", () => { chain.owners = [addr.anna, addr.otto]; chain.threshold = 2; });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "ORG_SAFE_NEEDS_MORE_SIGNATURES");
    assert.equal((await draft(id)).state, "REVIEWED");
    await nothingSent();
  });

  await check("the balance across lines: each fits, together they do not; pending, unclear and waiting payouts count", async () => {
    await reset();
    bal = 100;
    const id = await draftOf(["60", "60"]);
    const over = await start(id);
    assert.equal(over.status, 409, over.text);
    assert.equal(over.data.code, "AMOUNT_OVER_BALANCE");
    assert.equal(over.data.totalEur, 120);
    // An unclear payout and a pending one hold their money.
    bal = 200;
    await store.updateAccount("acc_co", { moneriumPayouts: [
      { id: "p_u", amountEur: 50, recipientName: "X", recipientIban: PAYEES[0].iban, memo: "m", message: "x", issuedAt: now, safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna", state: "unknown", createdAt: now, updatedAt: now },
      { id: "p_p", amountEur: 40, recipientName: "X", recipientIban: PAYEES[0].iban, memo: "m", message: "x", issuedAt: now, safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna", state: "pending", orderId: "ord_p", createdAt: now, updatedAt: now },
    ] } as any);
    const held = await start(id);
    assert.equal(held.status, 409, held.text);
    assert.equal(held.data.availableEur, 110);
    // An approval waiting for a passkey holds its money too.
    await store.updateAccount("acc_co", { moneriumPayouts: [] } as any);
    const single = await call("POST", "/org_co/monerium/payouts/start", "u_anna", { recipientName: "Eve", recipientIban: PAYEES[0].iban, amountEur: 90 });
    assert.equal(single.status, 201, single.text);
    const waiting = await start(id);
    assert.equal(waiting.status, 409, waiting.text);
    assert.equal(waiting.data.availableEur, 110);
    clearPendingPayouts();
    const fits = await start(id);
    assert.equal(fits.status, 201, fits.text);
    // And a run waiting for its passkey holds its lines against a payout by
    // the same signer: €200 less the run's €120 leaves €80.
    const after = await call("POST", "/org_co/monerium/payouts/start", "u_anna", { recipientName: "Eve", recipientIban: PAYEES[0].iban, amountEur: 90 });
    assert.equal(after.status, 409, after.text);
    assert.equal(after.data.code, "AMOUNT_OVER_BALANCE");
    assert.match(after.data.error, /€80\.00 available/);
    assert.equal(mon.attempts, 0);
  });

  await check("the payee fingerprint: an address-book edit before start holds the draft; after signing it sends nothing", async () => {
    await reset();
    const id = await draftOf(["10", "20"]);
    await store.updateContact("c_cara", { bankAccounts: [{ id: "c_cara_b", currency: "EUR", country: "DE", holderName: "Cara Schmidt", iban: "DE02500105170137075030" }] } as any);
    const before = await start(id);
    assert.equal(before.status, 409, before.text);
    assert.equal(before.data.code, "INVALID_DATA");
    assert.equal((await draft(id)).state, "INVALID_DATA");

    await reset();
    const id2 = await draftOf(["10", "20"]);
    const r = await run(id2, "anna", async () => {
      await store.updateContact("c_bob", { bankAccounts: [{ id: "c_bob_b", currency: "EUR", country: "DE", holderName: "Bob GmbH", iban: "DE02500105170137075030" }] } as any);
    });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "INVALID_DATA");
    await nothingSent();
  });

  await check("every line is signed before any is sent: missing, repeated or bad assertions, or an edit after signing, send nothing", async () => {
    await reset();
    const id = await draftOf(["10", "20", "30"]);
    const short = await run(id, "anna", (b) => { b.assertions.pop(); });
    assert.equal(short.status, 400, short.text);
    assert.equal(short.data.code, "RUN_INCOMPLETE");
    const twice = await run(id, "anna", (b) => { b.assertions[2] = { ...b.assertions[1] }; });
    assert.equal(twice.status, 400, twice.text);
    // Line 2's assertion swapped onto line 3's challenge: not the message signed.
    const swapped = await run(id, "anna", (b) => {
      const [x, y] = [b.assertions[1], b.assertions[2]];
      b.assertions[1] = { ...y, requestId: x.requestId };
      b.assertions[2] = { ...x, requestId: y.requestId };
    });
    assert.equal(swapped.status, 401, swapped.text);
    assert.equal(swapped.data.code, "PASSKEY_INVALID");
    // Another person's passkey over the right challenges.
    const s = await start(id);
    const otto = [];
    for (const l of s.data.lines) otto.push({ requestId: l.requestId, ...(await keys.otto.assert(l.challenge)) });
    const wrong = await call("POST", `/org_co/drafts/${id}/bank-run`, "u_anna", { runId: s.data.runId, assertions: otto });
    assert.equal(wrong.status, 401, wrong.text);
    // An edit by the payer after the owner signed.
    const edited = await run(id, "anna", async () => {
      const e = await call("PATCH", `/org_co/drafts/${id}`, "u_pia", {});
      assert.equal(e.status, 200, e.text);
    });
    assert.equal(edited.status, 409, edited.text);
    assert.ok(["NOT_SENDABLE", "DRAFT_CHANGED"].includes(edited.data.code), edited.text);
    await nothingSent();
    assert.deepEqual(signed, [], "no Safe signature was built");
  });

  await check("an expired approval sends nothing", async () => {
    await reset();
    const id = await draftOf(["10", "20"]);
    const realNow = Date.now;
    const r = await run(id, "anna", () => { const t0 = realNow(); Date.now = () => t0 + 10 * 60_000; });
    Date.now = realNow;
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "PAYOUT_EXPIRED");
    await nothingSent();
  });

  let doneId = "";
  await check("the run: one redeem per line, in order, each its own message and signature; booked only once processed", async () => {
    await reset();
    const id = doneId = await draftOf(["10", "20.5", "30"]);
    const s = await start(id);
    assert.equal(s.status, 201, s.text);
    assert.equal(s.data.lines.length, 3);
    for (const l of s.data.lines) assert.equal(l.challenge, passkeySafeChallenge(safeMessageHash(SAFE, l.message)));
    const body = { runId: s.data.runId, assertions: await assertionsFor(s.data) };
    const r = await call("POST", `/org_co/drafts/${id}/bank-run`, "u_anna", body);
    assert.equal(r.status, 201, r.text);
    assert.equal(mon.placed.length, 3);
    PAYEES.forEach((c, i) => {
      const o = mon.placed[i];
      assert.equal(o.kind, "redeem");
      assert.equal(o.address, SAFE);
      assert.equal(o.counterpart.identifier.iban, c.iban);
      assert.equal(o.message, s.data.lines[i].message);
      assert.equal(o.signature, signed[i]);
      assert.ok(o.message.includes(c.iban), "the message names the payee's IBAN");
    });
    assert.equal(new Set(mon.placed.map((o) => o.signature)).size, 3, "one signature per line");
    assert.deepEqual(mon.placed.map((o) => Number(o.amount)), [10, 20.5, 30]);
    const rows = await payouts();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((p) => p.draftId === id && p.state === "pending" && p.signedByMemberId === "m_anna"));
    let d = await draft(id);
    assert.equal(d.state, "EXECUTING");
    assert.deepEqual(d.bankRun.lines.map((l: any) => l.state), ["pending", "pending", "pending"]);
    // Nothing is booked while Monerium holds the orders.
    const book = async () => projectStatementLines({
      orgId: "org_co", accountId: "acc_co", safeAddress: SAFE, timeZone: "Europe/Berlin",
      transfers: [], deposits: [], issueOrders: [], sweeps: [], invoices: [], paymentRequests: [],
      companyPayouts: await payouts(), swapsHaveExecuted: false,
    }).filter((l) => l.statement?.event === "sepa_out");
    assert.equal((await book()).length, 0);
    // Two processed: booked, the run still sending.
    mon.orders.ord_1 = { id: "ord_1", meta: { state: "processed", processedAt: "2026-11-26T09:00:00Z" } };
    mon.orders.ord_2 = { id: "ord_2", meta: { state: "processed", processedAt: "2026-11-26T09:01:00Z" } };
    mon.orders.ord_3 = { id: "ord_3", meta: { state: "pending" } };
    await call("GET", "/org_co/monerium/payouts", "u_anna");
    assert.equal((await book()).length, 2);
    d = await draft(id);
    assert.equal(d.state, "EXECUTING");
    mon.orders.ord_3 = { id: "ord_3", meta: { state: "processed", processedAt: "2026-11-26T09:02:00Z" } };
    await call("GET", "/org_co/monerium/payouts", "u_anna");
    const booked = await book();
    assert.equal(booked.length, 3);
    assert.deepEqual(booked.map((l) => l.statement!.amountCents).sort((a, b) => a - b), [-3000, -2050, -1000]);
    d = await draft(id);
    assert.equal(d.state, "EXECUTED");
    assert.equal((await store.findDraft(id))!.state, "EXECUTED", "stored, not only derived");
  });

  await check("a sent run cannot be sent again, and its lines cannot go through the single-payout route", async () => {
    const again = await start(doneId);
    assert.equal(again.status, 409, again.text);
    assert.equal(again.data.code, "RUN_ALREADY_SENT");
    await reset();
    const id = await draftOf(["10"]);
    const s = await start(id);
    const a = await keys.anna.assert(s.data.lines[0].challenge);
    const single = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: s.data.lines[0].requestId, ...a });
    assert.equal(single.status, 409, single.text);
    assert.equal(single.data.code, "PAYOUT_NOT_STARTED");
    await nothingSent();
  });

  await check("partial failure: a refused line stops the run; earlier lines stay placed, later ones are never sent", async () => {
    await reset();
    const id = await draftOf(["10", "20", "30"]);
    mon.failAt = { n: 2, err: new MoneriumApiError(`Monerium POST /orders failed (403): ${PROVIDER_BODY}`, 403) };
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); };
    let r;
    try { r = await run(id); } finally { console.warn = warn; }
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.code, "MONERIUM_REFUSED");
    assert.ok(!r.text.includes(PROVIDER_BODY), "not in the answer");
    assert.ok(!logged.join("\n").includes(PROVIDER_BODY), "not in the log");
    assert.equal(mon.attempts, 2, "line 3 was never asked for");
    const rows = await payouts();
    assert.deepEqual(rows.map((p) => [p.lineId && PAYEES.findIndex((c) => c.iban === p.recipientIban), p.state]).sort(), [[0, "pending"], [1, "failed"]]);
    const d = await draft(id);
    assert.equal(d.state, "FAILED");
    assert.deepEqual(d.bankRun.lines.map((l: any) => l.state), ["pending", "failed", "not_sent"]);
    assert.match(d.failureReason, /Dora AG €30\.00/);
    assert.match(d.failureReason, /new payment for the not sent lines only/);
    // The placed line still settles and is booked.
    mon.orders.ord_1 = { id: "ord_1", meta: { state: "processed", processedAt: "2026-11-26T10:00:00Z" } };
    await call("GET", "/org_co/monerium/payouts", "u_anna");
    assert.equal((await draft(id)).bankRun.lines[0].state, "sent");
    assert.equal((await draft(id)).state, "FAILED");
  });

  await check("unknown mid-run: the run stops, the line is unknown and holds its money, nothing is retried", async () => {
    await reset();
    bal = 100;
    const id = await draftOf(["10", "20", "30"]);
    mon.failAt = { n: 2, err: new MoneriumApiError(`Monerium POST /orders failed (503): ${PROVIDER_BODY}`, 503) };
    const r = await run(id);
    assert.equal(r.status, 502, r.text);
    assert.equal(r.data.code, "MONERIUM_UNSURE");
    assert.ok(!r.text.includes(PROVIDER_BODY));
    assert.match(r.data.error, /check Monerium before paying it again/);
    assert.equal(mon.attempts, 2);
    const d = await draft(id);
    assert.equal(d.state, "FAILED");
    assert.deepEqual(d.bankRun.lines.map((l: any) => l.state), ["pending", "unknown", "not_sent"]);
    // Never retried: the reconcile reads only orders with an id, and the run is closed.
    await call("GET", "/org_co/monerium/payouts", "u_anna");
    assert.equal(mon.attempts, 2);
    assert.equal((await start(id)).data.code, "RUN_ALREADY_SENT");
    // The pending and the unclear line hold €30 of the €100.
    const next = await draftOf(["50", "25"]);
    const held = await start(next);
    assert.equal(held.status, 409, held.text);
    assert.equal(held.data.availableEur, 70);
  });

  await check("a process that stopped mid-run: past the window a signed line is not sent and a sending line is unclear", () => {
    const issuedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const runRow = { accountId: "acc_co", safeAddress: SAFE, signedByMemberId: "m_anna", issuedAt, lines: [
      { lineId: "a", payoutId: "pa", amountEur: 1, recipientName: "A", recipientIban: PAYEES[0].iban, state: "pending" },
      { lineId: "b", payoutId: "pb", amountEur: 1, recipientName: "B", recipientIban: PAYEES[1].iban, state: "signed" },
    ] } as any;
    assert.equal(bankRunDraftState(runRow), "FAILED");
    assert.equal(bankRunDraftState({ ...runRow, issuedAt: new Date().toISOString() }), "EXECUTING");
    // A line whose order was being asked for when the process stopped may
    // have reached Monerium: unclear, never not sent.
    const sending = { ...runRow, lines: [{ ...runRow.lines[1], state: "sending" }] };
    assert.equal(bankRunLineState(sending, sending.lines[0]), "unknown");
    assert.equal(bankRunLineState({ ...sending, issuedAt: new Date().toISOString() }, sending.lines[0]), "sending");
  });

  await check("no write leaves a run half-written on disk: claim with its run, a sending line with its row, a row with its line", async () => {
    await reset();
    const id = await draftOf(["10", "20", "30"]);
    mon.failAt = { n: 3, err: new MoneriumApiError("Monerium POST /orders failed (503)", 503) };
    const w = watchWrites();
    try {
      await run(id);
      mon.orders.ord_1 = { id: "ord_1", meta: { state: "processed", processedAt: "2026-11-26T09:00:00Z" } };
      mon.orders.ord_2 = { id: "ord_2", meta: { state: "rejected" } };
      await call("GET", "/org_co/monerium/payouts", "u_anna");
    } finally { w.stop(); }
    assert.deepEqual(w.seen, []);
    assert.deepEqual((await draft(id)).bankRun.lines.map((l: any) => l.state), ["sent", "failed", "unknown"]);
  });

  await check("two lines with the same amount and IBAN are refused: they would carry one message and one signature", async () => {
    await reset();
    await store.updateContact("c_cara", { bankAccounts: [{ id: "c_cara_b", currency: "EUR", country: "DE", holderName: "Cara Schmidt", iban: PAYEES[0].iban }] } as any);
    const id = await draftOf(["10", "10"]);
    const r = await start(id);
    assert.equal(r.status, 422, r.text);
    assert.equal(r.data.code, "LINES_NOT_PAYABLE");
    assert.match(r.data.problems[0].reason, /same amount to the same IBAN/);
    // Different amounts to one IBAN are two messages.
    await reset();
    await store.updateContact("c_cara", { bankAccounts: [{ id: "c_cara_b", currency: "EUR", country: "DE", holderName: "Cara Schmidt", iban: PAYEES[0].iban }] } as any);
    const ok = await draftOf(["10", "11"]);
    const s = await start(ok);
    assert.equal(s.status, 201, s.text);
    assert.notEqual(s.data.lines[0].challenge, s.data.lines[1].challenge);
    await nothingSent();
  });

  await check("payouts switched off: execute says so before any sign dialog opens", async () => {
    await reset();
    const id = await draftOf(["10"]);
    process.env.MONERIUM_ORG_PAYOUTS = "off";
    try {
      const x = await call("POST", `/org_co/drafts/${id}/execute`, "u_anna");
      assert.equal(x.status, 409, x.text);
      assert.equal(x.data.code, "ORG_PAYOUTS_OFF");
      assert.equal(x.data.startTo, undefined);
    } finally { process.env.MONERIUM_ORG_PAYOUTS = "on"; }
  });

  await check("one Monerium client places every order of a run", async () => {
    await reset();
    const id = await draftOf(["10", "20", "30"]);
    const clients: object[] = [];
    const placedBy: object[] = [];
    const real = io.monerium;
    io.monerium = (org: any) => {
      const c = { ...real(org), placeOrder: async (b: any) => { placedBy.push(c); return client.placeOrder(b); } };
      clients.push(c);
      return c;
    };
    try { assert.equal((await run(id)).status, 201); } finally { io.monerium = real; }
    assert.equal(placedBy.length, 3);
    assert.equal(new Set(placedBy).size, 1, "every order on one client");
  });

  await check("an invoice line must pay the invoice in full, and is marked paid only then", async () => {
    await reset();
    const inv = (id: string, total: string) => store.addInvoice({ id, orgId: "org_co", direction: "incoming", linkTokenHash: `h_${id}`, state: "SUBMITTED", supplier: { name: "Bob GmbH", invoiceNumber: id }, lines: [], currency: "EUR", total, createdByMemberId: "m_pia", createdAt: now, updatedAt: now } as any);
    await inv("inv_short", "25.00");
    const lines = [{ contactId: "c_bob", invoiceId: "inv_short", destination: { kind: "bank", bankAccountId: "c_bob_b", displayName: "Bob GmbH" }, asset: "EUR", amount: "10" }];
    const d = await call("POST", "/org_co/drafts", "u_pia", { source: { kind: "account", accountId: "acc_co" }, lines });
    assert.equal(d.status, 201, d.text);
    const r = await start(d.data.draft.id);
    assert.equal(r.status, 422, r.text);
    assert.match(r.data.problems[0].reason, /invoice is for €25\.00/);
    // The signing dialog shows only `error`: it carries what to correct.
    assert.match(r.data.error, /1 of 1 line\(s\) cannot be paid\. Nothing was sent\. This line pays €10\.00, but the invoice is for €25\.00/);
    // The full amount to an account the supplier did not give is refused too.
    await inv("inv_iban", "25.00");
    const e = await call("POST", "/org_co/drafts", "u_pia", { source: { kind: "account", accountId: "acc_co" }, lines: [{ ...lines[0], invoiceId: "inv_iban", amount: "25" }] });
    await store.updateInvoice("inv_iban", { state: "PAYING", payment: { draftId: e.data.draft.id }, payTo: { kind: "bank", bank: { iban: PAYEES[1].iban } } } as any);
    assert.match((await start(e.data.draft.id)).data.error, /to the account the supplier gave/);
    await store.updateInvoice("inv_iban", { payTo: { kind: "bank", bank: { iban: PAYEES[0].iban } } } as any);
    assert.equal((await start(e.data.draft.id)).status, 201);
    // A run line recorded as sent for less than the invoice never marks it paid.
    const { syncInvoicePayment } = await import("../services/api/src/routes/business/state.js");
    await inv("inv_paying", "25.00");
    await store.addDraft({ id: "dft_paid", orgId: "org_co", source: { kind: "account", accountId: "acc_co" }, state: "EXECUTED", createdByMemberId: "m_pia", activity: [], createdAt: now, updatedAt: now,
      lines: [{ id: "dl_1", contactId: "c_bob", invoiceId: "inv_paying", destination: { kind: "bank", bankAccountId: "c_bob_b", displayName: "Bob GmbH" }, asset: "EUR", amount: "10", tags: [] }],
      bankRun: { accountId: "acc_co", safeAddress: SAFE, signedByMemberId: "m_anna", issuedAt: now, lines: [{ lineId: "dl_1", payoutId: "p1", amountEur: 10, recipientName: "Bob GmbH", recipientIban: PAYEES[0].iban, state: "sent" }] } } as any);
    await store.updateInvoice("inv_paying", { state: "PAYING", payment: { draftId: "dft_paid" } } as any);
    assert.equal((await syncInvoicePayment((await store.findInvoice("inv_paying"))!)).state, "PAYING");
    await store.updateInvoice("inv_paying", { total: "10.00" } as any);
    assert.equal((await syncInvoicePayment((await store.findInvoice("inv_paying"))!)).state, "PAID");
  });

  await check("New payment offers a company the account its run pays from: live, on its Safe, IBAN issued", async () => {
    const homeModel: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/home-model.js")).href);
    const ok = { id: "a", status: "active", address: SAFE, identifier: { iban: IBAN } };
    assert.deepEqual(homeModel.companyBankAccounts([ok, { ...ok, id: "b", identifier: {} }, { ...ok, id: "c", status: "gated" }, { ...ok, id: "d", backingUserId: "u" }]).map((a: any) => a.id), ["a"]);
  });

  await check("the screens offer an owner Send on a company bank run in any open state, never a Submit for review", () => {
    const bank = { destination: { kind: "bank" } };
    const wallet = { destination: { kind: "wallet" } };
    for (const state of ["DRAFT", "PENDING_REVIEW", "REVIEWED"]) {
      assert.equal(paymentModel.ownerSendsWithoutReview("company", { state, lines: [bank, bank] }), true, state);
    }
    for (const state of ["REJECTED", "CANCELLED", "EXECUTING", "EXECUTED", "FAILED", "INVALID_DATA"]) {
      assert.equal(paymentModel.ownerSendsWithoutReview("company", { state, lines: [bank] }), false, state);
    }
    assert.equal(paymentModel.ownerSendsWithoutReview("sole_trader", { state: "DRAFT", lines: [bank] }), false);
    assert.equal(paymentModel.ownerSendsWithoutReview("company", { state: "DRAFT", lines: [wallet] }), false, "a wallet run keeps its own path");
    assert.equal(paymentModel.ownerSendsWithoutReview("company", { state: "DRAFT", lines: [] }), false);
    // The Approvals card and Next line agree with the Send button.
    const waiting = { state: "PENDING_REVIEW", lines: [bank], createdByMemberId: "m_pia", createdAt: now, activity: [] };
    const a = paymentModel.approvals(waiting, false, true);
    assert.deepEqual([a.have, a.needed], [1, 1], "no approval outstanding");
    assert.match(paymentModel.nextStep(waiting, true, true), /owner sends it with their passkey\. No second approval/);
    assert.deepEqual([paymentModel.approvals(waiting, true).needed], [2], "other runs keep their approval");
  });

  await check("the words after signing: placed is not sent; a stopped run says what each line did", () => {
    const view = (states: string[], failureReason?: string) => ({ bankRun: { lines: states.map((state) => ({ state })) }, ...(failureReason ? { failureReason } : {}) });
    assert.match(model.bankRunNotice(view(["pending", "pending"])).text, /not sent until Monerium processes them/);
    assert.equal(model.bankRunNotice(view(["pending", "pending"])).error, undefined);
    assert.match(model.bankRunNotice(view(["sent", "sent"])).text, /^Sent: Monerium processed all 2/);
    const stopped = model.bankRunNotice(view(["pending", "failed", "not_sent"], "Not sent: Dora AG €30.00."));
    assert.equal(stopped.error, true);
    assert.match(stopped.text, /did not accept.*Not sent: Dora AG/);
    assert.match(model.bankRunNotice(view(["pending", "unknown", "not_sent"])).text, /did not confirm/);
  });
} finally {
  server.close();
}
console.log(`\norg-monerium-bank-runs: ${passed} passed`);
