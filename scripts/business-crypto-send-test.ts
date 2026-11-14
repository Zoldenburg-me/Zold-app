/**
 * A business payment run that pays a crypto wallet (routes/business/drafts.ts
 * walletRun, routes/crypto-sends.ts authorize).
 *
 * Covers:
 *   - four eyes: the drafter cannot approve, an edit makes the editor the
 *     drafter, and only the member whose Safe backs the account can send;
 *   - the run becomes one crypto send that the backing member's passkey signs;
 *     it is SENT and the run reads EXECUTED;
 *   - the payee fingerprint is checked at review, at execution and again at
 *     submission: an edit to the contact's wallet holds the run and sends
 *     nothing, and a backer removed since execution cannot submit it;
 *   - the personal crypto-send checks run on it (a sanctioned address is
 *     refused and the run is not claimed);
 *   - two wallet lines, a wallet on another network, and sending switched
 *     off are refused before anything is created (at submit, and at execute);
 *   - a run that is sending is never rewritten (no INVALID_DATA, so no second
 *     send), and a send no longer bound to its run's line is refused;
 *   - a frozen account, a wallet with a bad checksum, USDC at the mid, review
 *     off, the invoice it pays, an expired approval, a lost claim race and an
 *     unconfirmed send each read as they should; totals keep six places.
 *
 * Offline: Monerium is a local fake, the balance, rate and screen are stubs,
 * and the Safe operation is the hardhat harness stand-in.
 * Run: npm run business:crypto-send:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-biz-crypto-")), "db.json");
process.env.CRYPTO_SEND_ENABLED = "1";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
// A throwaway key for this test only.
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "biz-crypto-".padEnd(40, "x");

// Monerium answers the execution-time profile re-read for one company profile.
const PROFILE_ID = "0b7f3c2e-6a1d-4f8e-9c55-2d4e6f8a0b1c";
const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname === "/auth/token") {
      const body = new URLSearchParams(raw);
      return body.get("client_secret") === "biz-secret" ? send(200, { access_token: "tok", expires_in: 3600, token_type: "Bearer" }) : send(401, {});
    }
    if (req.headers.authorization !== "Bearer tok") return send(401, {});
    if (url.pathname === `/profiles/${PROFILE_ID}`) return send(200, { id: PROFILE_ID, kind: "corporate", state: "approved", name: "Zoldenburg UG" });
    send(404, {});
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { createCryptoSendsRouter, createCryptoSendPreparer } = await import("../services/api/src/routes/crypto-sends.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { syncInvoicePayment } = await import("../services/api/src/routes/business/state.js");
const { validateWallet } = await import("../services/api/src/domain/contacts.js");
const { totalsByAsset } = await import("../services/api/src/domain/drafts.js");
initStore();

const SAFE = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222";
const MALLORY = "0x3333333333333333333333333333333333333333";
const sanctioned = new Set<string>();
const stubs = {
  resolveName: async () => ({ ok: false as const, status: 400 as const, code: "BAD_NAME" as const, error: "no names here" }),
  balanceOf: async () => 1_000n * 10n ** 18n,
  usdPerEur: async () => 1.25,
  screen: async (a: string) => sanctioned.has(a.toLowerCase()),
};

const ORIGIN = "http://localhost:3000";
const passkey = await makeSoftwarePasskey("biz-cs", ORIGIN);
const hex = (b64: string) => "0x" + Buffer.from(b64, "base64url").toString("hex");
const now = new Date().toISOString();
store.addUser({
  id: "u_owner", name: "Owner", country: "DE", kycStatus: "approved", address: SAFE,
  wallet: { type: "candide-safe", deployed: true },
  passkey: { credentialId: passkey.credentialId, publicKey: { alg: "ES256", jwk: passkey.jwk }, signCount: 0, rpId: "localhost" },
  passkeySafe: { status: "active", address: SAFE, threshold: 1, importedAt: now, passkeyPublicKey: { x: hex(passkey.jwk.x!), y: hex(passkey.jwk.y!) } },
  monerium: { connectedAt: now, method: "api_keys", profileId: PROFILE_ID, apiKeys: { clientId: "biz", clientSecretEnc: SECRETS.moneriumApiSecret.seal("u_owner", "biz-secret"), baseUrl: process.env.MONERIUM_BASE_URL, verifiedAt: now } },
  createdAt: now,
} as any);
store.addUser({ id: "u_admin", name: "Admin", country: "DE", kycStatus: "approved", address: `0x${"bb".repeat(20)}`, createdAt: now } as any);
store.addOrganisation({ id: "org_1", type: "business", name: "Zoldenburg UG", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
store.addMember({ id: "m_owner", orgId: "org_1", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
store.addMember({ id: "m_admin", orgId: "org_1", userId: "u_admin", email: "", role: "admin", status: "active", invitedAt: now, acceptedAt: now } as any);
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE, backingUserId: "u_owner", moneriumProfile: { id: PROFILE_ID, kind: "corporate", name: "Zoldenburg UG", checkedAt: now }, createdAt: now, updatedAt: now } as any);
store.addContact({ id: "c_w", orgId: "org_1", name: "Alice Studio", wallets: [{ id: "cw_1", chainId: 31337, address: ALICE }], bankAccounts: [], createdAt: now, updatedAt: now } as any);

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
const noSepa = async () => { throw new Error("a wallet run builds no SEPA transfer"); };
app.use("/api/orgs", createDraftRoutes({ ctxOf: (req, res) => resolveOrg(req, res, requireSession as any) }, noSepa as any, async () => ({ safeBalanceEur: 1000 }), createCryptoSendPreparer(stubs)));
app.use("/api", createCryptoSendsRouter({
  requireUserSession: (req, res, userId) => (who(req) === userId ? { id: "s" } : (res.status(403).json({ error: "not yours" }), undefined)),
  ...stubs,
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const walletLine = (extra: Record<string, unknown> = {}) => ({ contactId: "c_w", destination: { kind: "wallet", chainId: 31337, address: ALICE, displayName: "Alice Studio" }, asset: "EURE", amount: "10", ...extra });
/** Drafted by the owner, approved by the admin. */
const approvedRun = async (lines = [walletLine()]) => {
  const d = await call("POST", "/orgs/org_1/drafts", "u_owner", { source: { kind: "account", accountId: "acc_1" }, lines });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const id = d.data.draft.id;
  assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/submit`, "u_owner")).status, 200);
  const r = await call("POST", `/orgs/org_1/drafts/${id}/review`, "u_admin", { approve: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id as string;
};
const setWallet = (address: string) => store.updateContact("c_w", { wallets: [{ id: "cw_1", chainId: 31337, address: address as `0x${string}` }] });

let pass = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); pass++; console.log(`  ok  ${name}`); };
try {
  await t("four eyes: the drafter cannot approve, and an edit makes the editor the drafter", async () => {
    const d = await call("POST", "/orgs/org_1/drafts", "u_owner", { source: { kind: "account", accountId: "acc_1" }, lines: [walletLine()] });
    const id = d.data.draft.id;
    await call("POST", `/orgs/org_1/drafts/${id}/submit`, "u_owner");
    assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/review`, "u_owner", { approve: true })).status, 403);
    assert.equal((await call("PATCH", `/orgs/org_1/drafts/${id}`, "u_admin", {})).status, 200);
    await call("POST", `/orgs/org_1/drafts/${id}/submit`, "u_admin");
    assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/review`, "u_admin", { approve: true })).status, 403, "the editor is now the drafter");
    await call("POST", `/orgs/org_1/drafts/${id}/cancel`, "u_owner");
  });

  await t("only the backing member sends; their passkey signs one crypto send and the run reads EXECUTED", async () => {
    const id = await approvedRun();
    assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_admin")).status, 403, "the approver holds no key for this Safe");
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    assert.equal(x.status, 201, JSON.stringify(x.data));
    assert.equal(x.data.authorizations, undefined, "no SEPA transfer");
    const [cs] = x.data.cryptoSends;
    assert.equal(cs.to.toLowerCase(), ALICE);
    assert.equal(cs.token, "EURE");
    assert.equal(cs.amount, "10");
    assert.equal(store.findCryptoSend(cs.cryptoSendId)!.userId, "u_owner", "debited from the backing member's Safe");
    assert.equal((await call("GET", `/orgs/org_1/drafts/${id}`, "u_owner")).data.draft.state, "EXECUTING");
    const executionAssertion = await passkey.assert(cs.safeExecution.challenge);
    assert.equal((await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_admin", { executionAssertion })).status, 403, "another member cannot submit it");
    const s = await call("POST", cs.submitTo.replace(/^\/api/, ""), "u_owner", { executionAssertion });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.state, "SENT");
    assert.equal((await call("GET", `/orgs/org_1/drafts/${id}`, "u_owner")).data.draft.state, "EXECUTED");
    assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).status, 409, "a sent run is not sent twice");
  });

  await t("a contact edit between review and execution holds the run; nothing is created", async () => {
    const id = await approvedRun();
    const before = store.cryptoSends.length;
    setWallet(MALLORY);
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    setWallet(ALICE);
    assert.equal(x.status, 409, JSON.stringify(x.data));
    assert.equal(x.data.draft.state, "INVALID_DATA");
    assert.equal(store.cryptoSends.length, before);
  });

  await t("a contact edit between execution and the signature sends nothing and fails the run", async () => {
    const id = await approvedRun();
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    assert.equal(x.status, 201, JSON.stringify(x.data));
    const [cs] = x.data.cryptoSends;
    setWallet(MALLORY);
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    setWallet(ALICE);
    assert.equal(s.status, 409, JSON.stringify(s.data));
    assert.equal(s.data.code, "INVALID_DATA");
    const sent = store.findCryptoSend(cs.cryptoSendId)!;
    assert.equal(sent.state, "FAILED");
    assert.ok(!sent.txHash);
    assert.equal((await call("GET", `/orgs/org_1/drafts/${id}`, "u_owner")).data.draft.state, "FAILED");
  });

  await t("a backer removed after execution can no longer submit the send", async () => {
    const id = await approvedRun();
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    const [cs] = x.data.cryptoSends;
    const m = store.membersOf("org_1").find((r) => r.userId === "u_owner")!;
    m.status = "deactivated" as any;
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    m.status = "active" as any;
    assert.equal(s.status, 409, JSON.stringify(s.data));
    assert.equal(s.data.code, "NOT_SENDER");
    assert.equal(store.findCryptoSend(cs.cryptoSendId)!.state, "FAILED");
  });

  await t("the crypto-send checks run: a sanctioned address is refused and the run is not claimed", async () => {
    const id = await approvedRun();
    sanctioned.add(ALICE);
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    sanctioned.delete(ALICE);
    assert.equal(x.status, 403, JSON.stringify(x.data));
    assert.equal(x.data.code, "SANCTIONED");
    assert.equal(store.findDraft(id)!.state, "REVIEWED", "nothing claimed; it can be sent once the screen clears");
  });

  await t("two wallet lines, another network and an unknown token are refused at submit, before review", async () => {
    store.updateContact("c_w", { wallets: [{ id: "cw_1", chainId: 31337, address: ALICE }, { id: "cw_2", chainId: 1, address: ALICE }] } as any);
    for (const lines of [[walletLine(), walletLine()], [walletLine({ asset: "DAI" })], [walletLine({ destination: { kind: "wallet", chainId: 1, address: ALICE, displayName: "Alice Studio" } })]]) {
      const d = await call("POST", "/orgs/org_1/drafts", "u_owner", { source: { kind: "account", accountId: "acc_1" }, lines });
      const sub = await call("POST", `/orgs/org_1/drafts/${d.data.draft.id}/submit`, "u_owner");
      assert.equal(sub.status, 422, JSON.stringify(sub.data));
      assert.equal(store.findDraft(d.data.draft.id)!.state, "DRAFT");
    }
    setWallet(ALICE);
  });

  await t("review off: the same refusal at execute, and a one-line run sends from DRAFT", async () => {
    const org = store.findOrganisation("org_1")!;
    org.paymentReview = { required: false } as any;
    try {
      const bad = await call("POST", "/orgs/org_1/drafts", "u_owner", { source: { kind: "account", accountId: "acc_1" }, lines: [walletLine(), walletLine()] });
      assert.equal((await call("POST", `/orgs/org_1/drafts/${bad.data.draft.id}/execute`, "u_owner")).status, 422);
      const d = await call("POST", "/orgs/org_1/drafts", "u_owner", { source: { kind: "account", accountId: "acc_1" }, lines: [walletLine()] });
      const x = await call("POST", `/orgs/org_1/drafts/${d.data.draft.id}/execute`, "u_owner");
      assert.equal(x.status, 201, JSON.stringify(x.data));
    } finally {
      delete (org as any).paymentReview;
    }
  });

  await t("a run that is sending is never rewritten: an edited contact holds the send, and no second send follows", async () => {
    const id = await approvedRun();
    const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
    setWallet(MALLORY);
    const again = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    assert.equal(again.status, 409, JSON.stringify(again.data));
    assert.equal(store.findDraft(id)!.state, "EXECUTING", "not INVALID_DATA, so it cannot be edited and sent again");
    assert.equal((await call("PATCH", `/orgs/org_1/drafts/${id}`, "u_owner", {})).status, 409);
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    setWallet(ALICE);
    assert.equal(s.status, 409);
    assert.equal(store.findCryptoSend(cs.cryptoSendId)!.state, "FAILED");
  });

  await t("a send whose run no longer names it, or names another address, is refused", async () => {
    const id = await approvedRun();
    const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
    // As if the run had been reopened and re-pointed by a path that bypassed the state machine.
    store.updateDraft(id, { lines: [{ ...store.findDraft(id)!.lines[0], amount: "11" }] });
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    assert.equal(s.status, 409, JSON.stringify(s.data));
    assert.equal(s.data.code, "INVALID_DATA");
    const id2 = await approvedRun();
    const [cs2] = (await call("POST", `/orgs/org_1/drafts/${id2}/execute`, "u_owner")).data.cryptoSends;
    store.updateDraft(id2, { state: "CANCELLED" });
    const s2 = await call("POST", `/crypto-sends/${cs2.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs2.safeExecution.challenge) });
    assert.equal(s2.status, 409);
    assert.equal(store.findCryptoSend(cs2.cryptoSendId)!.state, "FAILED");
  });

  await t("an account frozen after execution cannot send", async () => {
    const id = await approvedRun();
    const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
    store.updateAccount("acc_1", { status: "frozen" } as any);
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    store.updateAccount("acc_1", { status: "active" } as any);
    assert.equal(s.status, 409, JSON.stringify(s.data));
    assert.equal(s.data.code, "NOT_SENDER");
  });

  await t("USDC is capped at the mid and sent", async () => {
    const id = await approvedRun([walletLine({ asset: "USDC", amount: "10" })]);
    const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
    assert.equal(cs.token, "USDC");
    assert.equal(store.findCryptoSend(cs.cryptoSendId)!.capEur, 8, "10 USDC at 1.25 USD per EUR");
    const s = await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
    assert.equal(s.status, 200, JSON.stringify(s.data));
  });

  await t("the invoice a run pays follows its send: Paid when sent, waiting again when it fails", async () => {
    for (const ok of [true, false]) {
      const inv = `inv_${ok}`;
      store.addInvoice({ id: inv, orgId: "org_1", state: "SUBMITTED", createdAt: now, updatedAt: now } as any);
      const id = await approvedRun([walletLine({ invoiceId: inv })]);
      store.updateInvoice(inv, { state: "PAYING", payment: { draftId: id } } as any);
      const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
      assert.equal(store.findInvoice(inv)!.payment?.cryptoSendId, cs.cryptoSendId);
      if (ok) await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) });
      else store.updateCryptoSend(cs.cryptoSendId, { state: "FAILED", error: "test" });
      const after = syncInvoicePayment(store.findInvoice(inv)!);
      assert.equal(after.state, ok ? "PAID" : "SUBMITTED");
      if (!ok) assert.equal(after.payment?.draftId, undefined, "free to be paid by a new run");
    }
  });

  await t("an expired approval reads FAILED, cannot be submitted, and the run says so", async () => {
    const id = await approvedRun();
    const [cs] = (await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")).data.cryptoSends;
    store.findCryptoSend(cs.cryptoSendId)!.deadline = Math.floor(Date.now() / 1000) - 1;
    assert.equal((await call("GET", `/orgs/org_1/drafts/${id}`, "u_owner")).data.draft.state, "FAILED");
    assert.equal((await call("POST", `/crypto-sends/${cs.cryptoSendId}/authorize`, "u_owner", { executionAssertion: await passkey.assert(cs.safeExecution.challenge) })).status, 410);
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    assert.equal(x.status, 409);
    assert.match(x.data.error, /failed/i);
  });

  await t("two executes at once: one send survives, the loser's is failed; an unconfirmed send keeps the run sending", async () => {
    const id = await approvedRun();
    const both = await Promise.all([1, 2].map(() => call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner")));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], JSON.stringify(both.map((r) => r.data)));
    const mine = store.cryptoSends.filter((c) => c.draftId === id);
    assert.equal(mine.filter((c) => c.state === "CREATED").length, 1, "one signable send");
    assert.ok(mine.every((c) => c.state === "CREATED" || c.state === "FAILED"));
    const live = mine.find((c) => c.state === "CREATED")!;
    store.updateCryptoSend(live.id, { state: "SUBMITTED" });
    assert.equal((await call("GET", `/orgs/org_1/drafts/${id}`, "u_owner")).data.draft.state, "EXECUTING");
  });

  await t("a wallet with a bad checksum is refused; totals keep a token's six places", async () => {
    assert.throws(() => validateWallet({ chainId: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" }), /checksum/);
    assert.equal(validateWallet({ chainId: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }).address, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    const d = { lines: [walletLine({ asset: "USDC", amount: "1.234567" }), walletLine({ asset: "USDC", amount: "0.000001" })] } as any;
    assert.deepEqual(totalsByAsset(d), { USDC: "1.234568" });
    assert.deepEqual(totalsByAsset({ lines: [{ destination: { kind: "bank" }, asset: "EUR", amount: "1.25" }, { destination: { kind: "bank" }, asset: "EUR", amount: "2.5" }] } as any), { EUR: "3.75" }, "bank lines still in cents");
    const bank = { destination: { kind: "bank" }, asset: "EUR", amount: "1" };
    const wallet = { destination: { kind: "wallet" }, asset: "EUR", amount: "1" };
    assert.deepEqual(totalsByAsset({ lines: [bank, wallet] } as any), { EUR: "2" }, "mixed lines, bank first");
    assert.deepEqual(totalsByAsset({ lines: [wallet, bank] } as any), { EUR: "2" }, "mixed lines, wallet first");
  });

  await t("off unless CRYPTO_SEND_ENABLED=1", async () => {
    const id = await approvedRun();
    delete process.env.CRYPTO_SEND_ENABLED;
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_owner");
    process.env.CRYPTO_SEND_ENABLED = "1";
    assert.equal(x.status, 503);
    assert.equal(x.data.code, "CRYPTO_SEND_OFF");
  });
  console.log(`business crypto send: ${pass} ok`);
} finally {
  server.close();
  fake.close();
}
