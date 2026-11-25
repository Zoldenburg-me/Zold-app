/**
 * A bank payout from a company's own IBAN (routes/business/org-monerium-payouts.ts,
 * domain/org-monerium-payout.ts, public/business/org-monerium-model.js).
 *
 * Covers:
 *   - the deployment switch: off by default, refused by name before anything
 *     is signed or read;
 *   - who signs: only an owner whose login passkey is an owner of the Safe on
 *     chain; an admin, a payer and a sole trader are refused;
 *   - what must hold first: approved keys, the company Safe behind the EUR
 *     account, an issued IBAN Monerium still lists on this Safe and network,
 *     a Safe at threshold 1 (2+ refused by name, nothing sent);
 *   - the amount: over what the Safe holds, or already claimed by a pending or
 *     unclear payout, is refused;
 *   - the redeem: the challenge is the Safe message hash of Monerium's exact
 *     message, only this owner's fresh assertion over it is accepted, and the
 *     order carries that message, the Safe's EIP-1271 signature, the amount,
 *     the counterpart and the remittance memo;
 *   - the outcome: `sent` only on Monerium's `processed`, `pending` while it
 *     holds the order, `failed` on 401/403 or an access refusal, and `unknown`
 *     (502, never retried) on a 4xx/5xx/timeout that may have placed it; an
 *     accepted order with no id is `unknown`, never sent;
 *   - Monerium's response body never reaches the browser or the log; a failure
 *     never wipes the saved connection;
 *   - keys removed while the passkey is checked: nothing is sent;
 *   - the list re-reads orders Monerium still holds, a failed read leaves the
 *     stored state, and history survives the keys being removed;
 *   - Settings words (org-monerium-model.js): pending is not sent, unclear
 *     says to check, the IBAN is masked.
 *
 * Offline: Monerium, the chain read, the balance and the Safe signature are
 * stubs injected into the router; the passkey is a software key.
 * Run: npm run org-monerium-payouts:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-payout-")), "db.json");
process.env.TRANSF_DB_PATH = DB;
process.env.TRANSF_CHAIN_ID = "31337";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.MONERIUM_ORG_PAYOUTS = "on";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createOrgMoneriumPayoutRoutes, clearPendingPayouts } = await import("../services/api/src/routes/business/org-monerium-payouts.js");
const { MoneriumAccessError, MoneriumApiError } = await import("../services/api/src/adapters/monerium-client.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { safeMessageHash } = await import("../services/api/src/wallet/candide.js");
const { passkeySafeChallenge } = await import("../services/api/src/wallet/passkey-safe-plan.js");
const { MONERIUM } = await import("../services/api/src/config.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/org-monerium-model.js")).href);
initStore();

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
const OTHER_IBAN = "DE89370400440532013000";
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
const hex = (b64: string) => ("0x" + Buffer.from(b64, "base64url").toString("hex")) as `0x${string}`;
const orgRow = (id: string, entity: string) =>
  store.addOrganisation({ id, type: "business", entity, name: "Acme GmbH", legalName: "Acme GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
orgRow("org_co", "company");
orgRow("org_st", "sole_trader");
for (const p of ["anna", "otto", "adam", "pia"] as const) {
  keys[p] = await makeSoftwarePasskey(p, ORIGIN);
  addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  store.addUser({
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved",
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
  const role = p === "adam" ? "admin" : p === "pia" ? "payer" : "owner";
  store.addMember({ id: `m_${p}`, orgId: "org_co", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
store.addMember({ id: "m_st", orgId: "org_st", userId: "u_anna", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
store.setOrgSafePlan("org_co", { kind: "org", status: "active", address: SAFE, owners: [{ x: hex(keys.anna.jwk.x!), y: hex(keys.anna.jwk.y!) }], createdAt: now } as any);
store.addAccount({
  id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "active", provider: null,
  identifier: { iban: IBAN }, address: SAFE,
  moneriumProfile: { id: PROFILE, kind: "corporate", name: "Acme GmbH", checkedAt: now },
  createdAt: now, updatedAt: now,
} as any);
const connected = (state = "approved") => ({
  clientId: "test-client-id-0000-1111",
  clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", "test-secret-placeholder-" + Math.random().toString(36).slice(2)),
  profile: { id: PROFILE, name: "Acme GmbH", state }, connectedAt: now, checkedAt: now, connectedByMemberId: "m_adam",
});
const reset = () => {
  store.updateOrganisation("org_co", { monerium: connected() as any });
  store.updateAccount("acc_co", {
    status: "active", provider: null, address: SAFE,
    identifier: { iban: IBAN },
    moneriumProfile: { id: PROFILE, kind: "corporate", name: "Acme GmbH", checkedAt: now },
    moneriumIban: undefined,
    moneriumPayouts: [],
  } as any);
  Object.assign(mon, freshMon());
  chain.owners = [addr.anna];
  chain.threshold = 1;
  signed.length = 0;
  bal = 1000;
  clearPendingPayouts();
};

// ── stubs: the chain, the balance, the Safe signature, Monerium ────────────
const chain = { owners: [addr.anna] as `0x${string}`[], threshold: 1 };
const signed: string[] = [];
let bal = 1000;
const PROVIDER_BODY = "provider-body-marker-must-not-reach-the-browser";
const freshMon = () => ({
  ibans: [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: MONERIUM.chain, state: "approved" }] as any[],
  ibansFail: false,
  placed: [] as any[],
  attempts: 0,
  placeAnswer: undefined as any,
  placeError: undefined as any,
  orders: {} as Record<string, any>,
  orderError: undefined as any,
  during: undefined as undefined | { call: string; act: () => void },
});
const meanwhile = (name: string) => {
  if (mon.during?.call === name) { const act = mon.during.act; mon.during = undefined; act(); }
};
const mon = freshMon();
const client = {
  async ibans() {
    if (mon.ibansFail) throw new Error("connect ECONNREFUSED");
    meanwhile("ibans");
    return { ibans: mon.ibans.map((i) => ({ ...i })) };
  },
  async placeOrder(body: any) {
    mon.attempts++;
    if (mon.placeError) throw mon.placeError;
    mon.placed.push(body);
    return mon.placeAnswer ?? { id: "ord_1", meta: { state: "pending" } };
  },
  async getOrder(id: string) {
    if (mon.orderError) throw mon.orderError;
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
  sign: (owner: any) => {
    signed.push(`${owner.x}:${owner.y}`);
    return "0x5167" as `0x${string}`;
  },
  balance: async () => bal,
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgMoneriumPayoutRoutes({ ctxOf: (req, res) => resolveOrg(req, res, requireSession as any) }, io as any));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, data: (text ? JSON.parse(text) : {}) as any };
};
const input = (over: Record<string, unknown> = {}) => ({ recipientName: "Bob GmbH", recipientIban: OTHER_IBAN, amountEur: 250, ...over });
/** Start, sign the challenge with `p`'s software passkey, submit. */
const pay = async (over: Record<string, unknown> = {}, p = "anna", tamper?: (start: any, signed: any) => void) => {
  const start = await call("POST", "/org_co/monerium/payouts/start", `u_${p}`, input(over));
  if (start.status !== 201) return start;
  const a = await keys[p].assert(start.data.challenge);
  const body = { requestId: start.data.requestId, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature };
  tamper?.(start.data, body);
  return call("POST", "/org_co/monerium/payouts", `u_${p}`, body);
};
const account = () => store.findAccount("acc_co")!;
const payouts = () => account().moneriumPayouts ?? [];

try {
  reset();

  await check("switched off: refused by name before anything is signed or read", async () => {
    process.env.MONERIUM_ORG_PAYOUTS = "off";
    try {
      const r = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
      assert.equal(r.status, 409, r.text);
      assert.equal(r.data.code, "ORG_PAYOUTS_OFF");
      assert.equal(mon.placed.length, 0);
      assert.deepEqual(signed, []);
      assert.deepEqual(payouts(), []);
    } finally {
      process.env.MONERIUM_ORG_PAYOUTS = "on";
    }
  });

  await check("only an owner whose passkey can sign; admins, payers and sole traders are refused", async () => {
    for (const u of ["u_pia", "u_adam"]) {
      const r = await call("POST", "/org_co/monerium/payouts/start", u, input());
      assert.equal(r.status, 403, `${u}: ${r.text}`);
    }
    const st = await call("POST", "/org_st/monerium/payouts/start", "u_anna", input());
    assert.equal(st.status, 409, st.text);
    assert.equal(st.data.code, "NOT_A_COMPANY");
    // An owner whose passkey is not one of the Safe's owners.
    chain.owners = [addr.otto];
    const otto = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    assert.equal(otto.status, 403, otto.text);
    assert.equal(otto.data.code, "NOT_A_SIGNER");
    assert.equal(mon.placed.length, 0);
  });

  await check("keys, Safe and IBAN must hold first; a moved or unlisted IBAN is refused", async () => {
    reset();
    store.updateOrganisation("org_co", { monerium: undefined });
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "MONERIUM_NOT_CONNECTED");
    reset();
    store.updateOrganisation("org_co", { monerium: connected("pending") as any });
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "MONERIUM_NOT_CONNECTED");
    reset();
    store.updateAccount("acc_co", { status: "gated", identifier: {} } as any);
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_ISSUED");
    reset();
    store.updateAccount("acc_co", { moneriumIban: { safeAddress: SAFE, profileId: PROFILE, movedAwayAt: now } } as any);
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    reset();
    mon.ibans = [];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_LISTED");
    reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: OTHER_SAFE, chain: MONERIUM.chain, state: "approved" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: "gnosis", state: "approved" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: MONERIUM.chain, state: "pending" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_APPROVED");
    assert.equal(mon.placed.length, 0);
    assert.deepEqual(signed, []);
  });

  await check("a Safe needing two signatures is refused by name: nothing signed or sent", async () => {
    reset();
    chain.owners = [addr.anna, addr.otto];
    chain.threshold = 2;
    const r = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "ORG_SAFE_NEEDS_MORE_SIGNATURES");
    assert.deepEqual(signed, []);
    assert.equal(mon.placed.length, 0);
  });

  await check("bad input is named: name, IBAN, amount and reference", async () => {
    reset();
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ recipientName: "" }))).data.code, "RECIPIENT_NAME_INVALID");
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ recipientIban: "DE00" }))).data.code, "RECIPIENT_IBAN_INVALID");
    for (const amountEur of [0, -1, 1.005, "abc"]) {
      assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur }))).data.code, "AMOUNT_INVALID", String(amountEur));
    }
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ reference: "x".repeat(141) }))).data.code, "REFERENCE_INVALID");
    assert.deepEqual(signed, []);
  });

  await check("the challenge is the Safe message hash of Monerium's exact redeem; the order carries it", async () => {
    reset();
    mon.placeAnswer = { id: "ord_ok", meta: { state: "processed" } };
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 250.5, reference: "INV-7" }));
    assert.equal(start.status, 201, start.text);
    assert.equal(start.data.amount, "250.5");
    assert.equal(start.data.iban, OTHER_IBAN);
    assert.match(start.data.message, /^Send EUR 250\.5 to DE89370400440532013000 at \d{4}-\d\d-\d\dT/);
    assert.equal(start.data.challenge, passkeySafeChallenge(safeMessageHash(SAFE, start.data.message)));
    assert.equal(start.data.credentialId, keys.anna.credentialId);
    const a = await keys.anna.assert(start.data.challenge);
    const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...a });
    assert.equal(r.status, 200, r.text);
    assert.equal(mon.placed.length, 1);
    const o = mon.placed[0];
    assert.equal(o.address, SAFE, "the company Safe, never another");
    assert.equal(o.chain, MONERIUM.chain);
    assert.equal(o.kind, "redeem");
    assert.equal(o.amount, "250.5");
    assert.equal(o.currency, "eur");
    assert.deepEqual(o.counterpart.identifier, { standard: "iban", iban: OTHER_IBAN });
    assert.equal(o.counterpart.details.country, "DE");
    assert.equal(o.counterpart.details.firstName, "Bob");
    assert.equal(o.counterpart.details.lastName, "GmbH");
    assert.equal(o.message, start.data.message, "the exact text the passkey signed");
    assert.equal(o.signature, "0x5167", "the Safe's EIP-1271 signature built from that assertion");
    assert.match(o.memo, /INV-7 Powered by Zold [0-9a-f]{8}$/);
    assert.deepEqual(signed, [`${BigInt(hex(keys.anna.jwk.x!))}:${BigInt(hex(keys.anna.jwk.y!))}`], "signed as anna's passkey owner");
    const p = payouts()[0];
    assert.equal(p.state, "sent", "only Monerium's processed means sent");
    assert.equal(p.orderId, "ord_ok");
    assert.equal(p.amountEur, 250.5);
    assert.equal(p.recipientIban, OTHER_IBAN);
    assert.equal(r.data.payout.state, "sent");
    assert.ok(!r.text.includes("signature"), "the signed message/signature is not re-displayed");
    assert.ok(!r.text.includes("message"), "the signed message stays server-side");
  });

  await check("a pending order is pending, not sent; an over-balance payout is refused", async () => {
    reset();
    bal = 100;
    mon.placeAnswer = { id: "ord_pending", meta: { state: "placed" } };
    const r = await pay({ amountEur: 60 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.payout.state, "pending", "Monerium holds it, it has not left");
    assert.match(model.payoutNotice(r.data.payout), /not sent until Monerium processes/);
    // 60 is claimed while pending: only 40 remains available.
    const over = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 50 }));
    assert.equal(over.status, 409, over.text);
    assert.equal(over.data.code, "AMOUNT_OVER_BALANCE");
    assert.match(over.data.error, /€40\.00/);
    const fits = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 40 }));
    assert.equal(fits.status, 201, fits.text);
  });

  await check("an assertion over another challenge is refused, and a request is spent on use", async () => {
    reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    const wrong = await keys.anna.assert(passkeySafeChallenge(safeMessageHash(OTHER_SAFE, start.data.message)));
    const w = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...wrong });
    assert.equal(w.status, 401, w.text);
    const replay = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...(await keys.anna.assert(start.data.challenge)) });
    assert.equal(replay.status, 409, "a spent request is gone, even after a failed assertion");
    assert.equal(replay.data.code, "PAYOUT_NOT_STARTED");
    assert.equal(mon.placed.length, 0);
    assert.deepEqual(payouts(), []);
  });

  await check("another member cannot finish the request; a Safe that lost the signer is refused", async () => {
    reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    const o = await keys.otto.assert(start.data.challenge);
    const other = await call("POST", "/org_co/monerium/payouts", "u_otto", { requestId: start.data.requestId, ...o });
    assert.equal(other.status, 409, other.text);
    assert.equal(other.data.code, "PAYOUT_NOT_STARTED");
    // The Safe's owners change after the challenge: anna is no longer a signer.
    const s2 = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    chain.owners = [addr.otto];
    const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: s2.data.requestId, ...(await keys.anna.assert(s2.data.challenge)) });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.data.code, "NOT_A_SIGNER");
    assert.equal(mon.placed.length, 0);
  });

  await check("a stale approval is refused before Monerium is asked", async () => {
    reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    const a = await keys.anna.assert(start.data.challenge);
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...a });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.data.code, "PAYOUT_EXPIRED");
    } finally { Date.now = realNow; }
    assert.equal(mon.placed.length, 0);
    assert.deepEqual(payouts(), []);
  });

  await check("Monerium's 401/403 means no order: failed, and the saved connection stays", async () => {
    reset();
    const before = store.findOrganisation("org_co")!.monerium;
    mon.placeError = new MoneriumApiError(`Monerium POST /orders failed (403): ${PROVIDER_BODY}`, 403);
    const r = await pay();
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.code, "MONERIUM_REFUSED");
    assert.equal(payouts()[0].state, "failed");
    assert.match(payouts()[0].error!, /Nothing was sent/);
    assert.deepEqual(store.findOrganisation("org_co")!.monerium, before, "the connection is not wiped");
    assert.ok(!r.text.includes(PROVIDER_BODY));
  });

  await check("a 5xx, a 4xx or a timeout may have placed it: unknown, 502, never retried", async () => {
    for (const err of [new MoneriumApiError(`Monerium POST /orders failed (503): ${PROVIDER_BODY}`, 503), new MoneriumApiError(`Monerium POST /orders failed (422): ${PROVIDER_BODY}`, 422), new Error("timeout")]) {
      reset();
      const before = store.findOrganisation("org_co")!.monerium;
      mon.placeError = err;
      const warn = console.warn;
      const logged: string[] = [];
      console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); };
      let r;
      try { r = await pay(); } finally { console.warn = warn; }
      assert.equal(r!.status, 502, r!.text);
      assert.equal(r!.data.code, "MONERIUM_UNSURE");
      assert.equal(payouts()[0].state, "unknown", "not sent, not failed");
      assert.match(payouts()[0].error!, /check Monerium before sending it again/i);
      assert.equal(mon.attempts, 1, "placed once, never retried");
      assert.ok(!r!.text.includes(PROVIDER_BODY), "not in the answer");
      assert.ok(!logged.join("\n").includes(PROVIDER_BODY), "not in the log");
      assert.deepEqual(store.findOrganisation("org_co")!.monerium, before, "the connection is not wiped");
    }
  });

  await check("Monerium accepting an order without an id is unknown, never sent", async () => {
    reset();
    mon.placeAnswer = { meta: { state: "placed" } };
    const r = await pay();
    assert.equal(r.status, 202, r.text);
    assert.equal(r.data.payout.state, "unknown");
    assert.match(r.data.payout.error, /no order id/);
    assert.equal(payouts()[0].state, "unknown");
  });

  await check("an access refusal before the order is failed: no payout was sent", async () => {
    reset();
    mon.placeError = new MoneriumAccessError(`token request failed (401): ${PROVIDER_BODY}`, 401);
    const r = await pay();
    assert.equal(r.status, 503, r.text);
    assert.equal(r.data.code, "MONERIUM_NOT_CONNECTED");
    assert.equal(payouts()[0].state, "failed");
    assert.ok(!r.text.includes(PROVIDER_BODY));
  });

  await check("keys removed while the passkey is checked: nothing is sent", async () => {
    reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    mon.during = { call: "ibans", act: () => store.updateOrganisation("org_co", { monerium: undefined }) };
    const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...(await keys.anna.assert(start.data.challenge)) });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "MONERIUM_KEYS_CHANGED");
    assert.equal(mon.placed.length, 0);
    assert.equal(payouts().length, 0);
    reset();
  });

  await check("the list re-reads orders Monerium still holds; a failed read leaves the stored state", async () => {
    reset();
    mon.placeAnswer = { id: "ord_a", meta: { state: "pending" } };
    assert.equal((await pay({ amountEur: 10 })).status, 200);
    mon.placeAnswer = { id: "ord_b", meta: { state: "pending" } };
    assert.equal((await pay({ amountEur: 20 })).status, 200);
    mon.orders = { ord_a: { id: "ord_a", meta: { state: "processed" } } };
    // ord_b's read fails: its stored pending state must stay.
    const r = await call("GET", "/org_co/monerium/payouts", "u_adam");
    assert.equal(r.status, 200, r.text);
    const a = r.data.payouts.find((p: any) => p.orderId === "ord_a");
    assert.equal(a.state, "sent", "Monerium processed it");
    const b = r.data.payouts.find((p: any) => p.orderId === "ord_b");
    assert.equal(b.state, "pending", "not read: stays pending, never claimed sent");
    assert.equal((await call("GET", "/org_co/monerium/payouts", "u_pia")).status, 403, "a payer cannot read them");
    assert.ok(!r.text.includes(IBAN), "the company IBAN is not re-displayed");
  });

  await check("payout history stays on the EUR account after the keys are removed", async () => {
    reset();
    mon.placeAnswer = { id: "ord_keep", meta: { state: "processed" } };
    assert.equal((await pay()).status, 200);
    const id = payouts()[0].id;
    store.updateOrganisation("org_co", { monerium: undefined });
    const r = await call("GET", "/org_co/monerium/payouts", "u_adam");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.payouts[0].id, id);
    assert.equal(r.data.payouts[0].state, "sent");
    assert.equal(r.text.includes("signature"), false);
  });

  await check("Settings words: pending is not sent, unclear says to check, the IBAN is masked", () => {
    assert.match(model.payoutNotice({ state: "pending" }), /not sent until Monerium processes/);
    assert.match(model.payoutNotice({ state: "unknown" }), /Check Monerium before sending it again/);
    assert.match(model.payoutNotice({ state: "sent" }), /^Sent:/);
    assert.match(model.payoutNotice({ state: "failed" }), /Not sent/);
    const [row] = model.payoutRows([{ id: "p1", amountEur: 12.5, recipientName: "Bob GmbH", recipientIban: OTHER_IBAN, state: "unknown", createdAt: "2026-11-25T10:00:00Z", error: "check" }]);
    assert.equal(row.title, "€12.50 to Bob GmbH");
    assert.ok(row.sub.includes("•••• 3000"), row.sub);
    assert.ok(!row.sub.includes(OTHER_IBAN), "only the last four digits");
    assert.equal(row.state, "Unclear: check Monerium");
    assert.equal(row.bad, true);
    assert.match(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, true, true).text, /pay a bank account from it below/);
    assert.match(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, true).text, /not built yet/);
  });
} finally {
  server.close();
}
console.log(`\n${passed} passed`);
