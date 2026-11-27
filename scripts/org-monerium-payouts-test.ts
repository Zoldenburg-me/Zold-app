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
const OTHER_IBAN = "DE89370400440532013000";
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
const connected = (state = "approved") => ({
  clientId: "test-client-id-0000-1111",
  clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", "test-secret-placeholder-" + Math.random().toString(36).slice(2)),
  profile: { id: PROFILE, name: "Acme GmbH", state }, connectedAt: now, checkedAt: now, connectedByMemberId: "m_adam",
});
const reset = async () => {
  await store.updateOrganisation("org_co", { monerium: connected() as any });
  await store.updateAccount("acc_co", {
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
  await store.updateMember("m_anna", { role: "owner", status: "active" } as any);
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
  during: undefined as undefined | { call: string; act: () => Promise<void> },
  /** Awaited inside placeOrder: another request runs to its end meanwhile. */
  wait: undefined as undefined | (() => Promise<void>),
});
const meanwhile = async (name: string) => {
  if (mon.during?.call === name) { const act = mon.during.act; mon.during = undefined; await act(); }
};
const mon = freshMon();
const client = {
  async ibans() {
    if (mon.ibansFail) throw new Error("connect ECONNREFUSED");
    await meanwhile("ibans");
    return { ibans: mon.ibans.map((i) => ({ ...i })) };
  },
  async placeOrder(body: any) {
    mon.attempts++;
    await meanwhile("place");
    if (mon.wait) { const w = mon.wait; mon.wait = undefined; await w(); }
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
const account = async () => (await store.findAccount("acc_co"))!;
const payouts = async () => (await account()).moneriumPayouts ?? [];

try {
  await reset();

  await check("switched off: refused by name before anything is signed or read", async () => {
    process.env.MONERIUM_ORG_PAYOUTS = "off";
    try {
      const r = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
      assert.equal(r.status, 409, r.text);
      assert.equal(r.data.code, "ORG_PAYOUTS_OFF");
      assert.equal(mon.placed.length, 0);
      assert.deepEqual(signed, []);
      assert.deepEqual((await payouts()), []);
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
    await reset();
    await store.updateOrganisation("org_co", { monerium: undefined });
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "MONERIUM_NOT_CONNECTED");
    await reset();
    await store.updateOrganisation("org_co", { monerium: connected("pending") as any });
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "MONERIUM_NOT_CONNECTED");
    await reset();
    await store.updateAccount("acc_co", { status: "gated", identifier: {} } as any);
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_ISSUED");
    await reset();
    await store.updateAccount("acc_co", { moneriumIban: { safeAddress: SAFE, profileId: PROFILE, movedAwayAt: now } } as any);
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    await reset();
    mon.ibans = [];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_LISTED");
    await reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: OTHER_SAFE, chain: MONERIUM.chain, state: "approved" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    await reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: "gnosis", state: "approved" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_MOVED");
    await reset();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: MONERIUM.chain, state: "pending" }];
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input())).data.code, "IBAN_NOT_APPROVED");
    assert.equal(mon.placed.length, 0);
    assert.deepEqual(signed, []);
  });

  await check("a Safe needing two signatures is refused by name: nothing signed or sent", async () => {
    await reset();
    chain.owners = [addr.anna, addr.otto];
    chain.threshold = 2;
    const r = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "ORG_SAFE_NEEDS_MORE_SIGNATURES");
    assert.deepEqual(signed, []);
    assert.equal(mon.placed.length, 0);
  });

  await check("bad input is named: name, IBAN, amount and reference", async () => {
    await reset();
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ recipientName: "" }))).data.code, "RECIPIENT_NAME_INVALID");
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ recipientIban: "DE00" }))).data.code, "RECIPIENT_IBAN_INVALID");
    for (const amountEur of [0, -1, 1.005, "abc"]) {
      assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur }))).data.code, "AMOUNT_INVALID", String(amountEur));
    }
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ reference: "x".repeat(141) }))).data.code, "REFERENCE_INVALID");
    assert.deepEqual(signed, []);
  });

  await check("the challenge is the Safe message hash of Monerium's exact redeem; the order carries it", async () => {
    await reset();
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
    const p = (await payouts())[0];
    assert.equal(p.state, "sent", "only Monerium's processed means sent");
    assert.equal(p.orderId, "ord_ok");
    assert.equal(p.amountEur, 250.5);
    assert.equal(p.recipientIban, OTHER_IBAN);
    assert.equal(r.data.payout.state, "sent");
    assert.ok(!r.text.includes("signature"), "the signed message/signature is not re-displayed");
    assert.ok(!r.text.includes("message"), "the signed message stays server-side");
  });

  await check("a pending order is pending, not sent; an over-balance payout is refused", async () => {
    await reset();
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
    await reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    const wrong = await keys.anna.assert(passkeySafeChallenge(safeMessageHash(OTHER_SAFE, start.data.message)));
    const w = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...wrong });
    assert.equal(w.status, 401, w.text);
    const replay = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...(await keys.anna.assert(start.data.challenge)) });
    assert.equal(replay.status, 409, "a spent request is gone, even after a failed assertion");
    assert.equal(replay.data.code, "PAYOUT_NOT_STARTED");
    assert.equal(mon.placed.length, 0);
    assert.deepEqual((await payouts()), []);
  });

  await check("another member cannot finish the request; a Safe that lost the signer is refused", async () => {
    await reset();
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
    await reset();
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
    assert.deepEqual((await payouts()), []);
  });

  await check("Monerium's 401/403 means no order: failed, and the saved connection stays", async () => {
    await reset();
    const before = (await store.findOrganisation("org_co"))!.monerium;
    mon.placeError = new MoneriumApiError(`Monerium POST /orders failed (403): ${PROVIDER_BODY}`, 403);
    const r = await pay();
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.code, "MONERIUM_REFUSED");
    assert.equal((await payouts())[0].state, "failed");
    assert.match((await payouts())[0].error!, /Nothing was sent/);
    assert.deepEqual((await store.findOrganisation("org_co"))!.monerium, before, "the connection is not wiped");
    assert.ok(!r.text.includes(PROVIDER_BODY));
  });

  await check("a 5xx, a 4xx or a timeout may have placed it: unknown, 502, never retried", async () => {
    for (const err of [new MoneriumApiError(`Monerium POST /orders failed (503): ${PROVIDER_BODY}`, 503), new MoneriumApiError(`Monerium POST /orders failed (422): ${PROVIDER_BODY}`, 422), new Error("timeout")]) {
      await reset();
      const before = (await store.findOrganisation("org_co"))!.monerium;
      mon.placeError = err;
      const warn = console.warn;
      const logged: string[] = [];
      console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); };
      let r;
      try { r = await pay(); } finally { console.warn = warn; }
      assert.equal(r!.status, 502, r!.text);
      assert.equal(r!.data.code, "MONERIUM_UNSURE");
      assert.equal((await payouts())[0].state, "unknown", "not sent, not failed");
      assert.match((await payouts())[0].error!, /check Monerium before sending it again/i);
      assert.equal(mon.attempts, 1, "placed once, never retried");
      assert.ok(!r!.text.includes(PROVIDER_BODY), "not in the answer");
      assert.ok(!logged.join("\n").includes(PROVIDER_BODY), "not in the log");
      assert.deepEqual((await store.findOrganisation("org_co"))!.monerium, before, "the connection is not wiped");
    }
  });

  await check("Monerium accepting an order without an id is unknown, never sent", async () => {
    await reset();
    mon.placeAnswer = { meta: { state: "placed" } };
    const r = await pay();
    assert.equal(r.status, 202, r.text);
    assert.equal(r.data.payout.state, "unknown");
    assert.match(r.data.payout.error, /no order id/);
    assert.equal((await payouts())[0].state, "unknown");
  });

  await check("an access refusal before the order is failed: no payout was sent", async () => {
    await reset();
    mon.placeError = new MoneriumAccessError(`token request failed (401): ${PROVIDER_BODY}`, 401);
    const r = await pay();
    assert.equal(r.status, 503, r.text);
    assert.equal(r.data.code, "MONERIUM_NOT_CONNECTED");
    assert.equal((await payouts())[0].state, "failed");
    assert.ok(!r.text.includes(PROVIDER_BODY));
  });

  await check("keys removed while the passkey is checked: nothing is sent", async () => {
    await reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    mon.during = { call: "ibans", act: async () => void await store.updateOrganisation("org_co", { monerium: undefined }) };
    const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...(await keys.anna.assert(start.data.challenge)) });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "MONERIUM_KEYS_CHANGED");
    assert.equal(mon.placed.length, 0);
    assert.equal((await payouts()).length, 0);
    await reset();
  });

  await check("the list re-reads orders Monerium still holds; a failed read leaves the stored state", async () => {
    await reset();
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
    await reset();
    mon.placeAnswer = { id: "ord_keep", meta: { state: "processed" } };
    assert.equal((await pay()).status, 200);
    const id = (await payouts())[0].id;
    await store.updateOrganisation("org_co", { monerium: undefined });
    const r = await call("GET", "/org_co/monerium/payouts", "u_adam");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.payouts[0].id, id);
    assert.equal(r.data.payouts[0].state, "sent");
    assert.equal(r.text.includes("signature"), false);
  });

  await check("a role revoked while the passkey is checked: nothing is sent", async () => {
    await reset();
    const start = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input());
    mon.during = { call: "ibans", act: async () => void await store.updateMember("m_anna", { role: "viewer" } as any) };
    const r = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: start.data.requestId, ...(await keys.anna.assert(start.data.challenge)) });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.data.code, "NOT_A_SIGNER");
    assert.equal(mon.placed.length, 0);
    assert.equal((await payouts()).length, 0);
    await reset();
  });

  await check("the row is written as unknown before Monerium is asked", async () => {
    await reset();
    let seen: string | undefined;
    mon.during = { call: "place", act: async () => { seen = (await payouts())[0]?.state; } };
    assert.equal((await pay()).status, 200);
    assert.equal(seen, "unknown", "a crash mid-call must not leave a row claiming Monerium holds an order");
    assert.equal((await payouts())[0].state, "pending");
  });

  await check("a new start replaces this owner's unsubmitted approval: a cancelled prompt does not block a retry", async () => {
    await reset();
    bal = 300;
    const first = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 300 }));
    assert.equal(first.status, 201, first.text);
    const again = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 300 }));
    assert.equal(again.status, 201, again.text);
    const old = await call("POST", "/org_co/monerium/payouts", "u_anna", { requestId: first.data.requestId, ...(await keys.anna.assert(first.data.challenge)) });
    assert.equal(old.data.code, "PAYOUT_NOT_STARTED", "the replaced approval is gone");
    assert.equal(mon.placed.length, 0);
  });

  await check("unresolved payouts keep their holds past the history cap, and old pending orders are re-read", async () => {
    await reset();
    const { capPayouts } = await import("../services/api/src/domain/org-monerium-payout.js");
    const row = (i: number, state: string) => ({ id: `p${i}`, amountEur: 1, state, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }) as any;
    const many = [...Array.from({ length: 60 }, (_, i) => row(100 - i, "sent")), row(1, "pending"), row(2, "unknown")];
    const kept = capPayouts(many);
    assert.equal(kept.filter((p) => p.state === "sent").length, 50);
    assert.ok(kept.some((p) => p.id === "p1") && kept.some((p) => p.id === "p2"), "pending and unknown rows are never dropped");
    // 7 pending orders, older than 20 newer finished rows: every one is re-read within two lists.
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const pend = Array.from({ length: 7 }, (_, i) => ({ ...row(i, "pending"), id: `old${i}`, orderId: `ord_old${i}`, createdAt: at(i), updatedAt: at(i), recipientName: "Bob", recipientIban: OTHER_IBAN, memo: "m", message: "x", issuedAt: at(i), safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna" }));
    const newer = Array.from({ length: 25 }, (_, i) => ({ ...pend[0], id: `new${i}`, orderId: `ord_new${i}`, state: "sent", createdAt: at(100 + i) }));
    await store.updateAccount("acc_co", { moneriumPayouts: [...newer, ...pend] } as any);
    mon.orders = Object.fromEntries(pend.map((p) => [p.orderId, { id: p.orderId, meta: { state: "processed" } }]));
    await call("GET", "/org_co/monerium/payouts", "u_adam");
    await call("GET", "/org_co/monerium/payouts", "u_adam");
    assert.deepEqual((await payouts()).filter((p) => p.id.startsWith("old")).map((p) => p.state), Array(7).fill("sent"));
  });

  await check("a company statement books a payout once Monerium carried it out, never before", async () => {
    const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
    const base = { id: "px", amountEur: 42.5, recipientName: "Bob GmbH", recipientIban: OTHER_IBAN, reference: "INV-7", memo: "m", message: "x", issuedAt: now, safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna", orderId: "ord_px", createdAt: now, updatedAt: now };
    const lines = (state: string) => projectStatementLines({
      orgId: "org_co", accountId: "acc_co", safeAddress: SAFE, timeZone: "Europe/Berlin",
      transfers: [], deposits: [], issueOrders: [], sweeps: [], invoices: [], paymentRequests: [],
      companyPayouts: [{ ...base, state } as any], swapsHaveExecuted: false,
    });
    for (const state of ["pending", "unknown", "failed"]) assert.equal(lines(state).length, 0, state);
    const [line] = lines("sent");
    assert.equal(line.direction, "out");
    assert.equal(line.statement!.amountCents, -4250);
    assert.equal(line.statement!.event, "sepa_out");
    assert.equal(line.statement!.reference, "INV-7");
    assert.equal(line.statement!.counterparty.iban, OTHER_IBAN);
  });

  await check("Monerium's processing time is kept and is the statement's value date; the sweep books a payout-only account", async () => {
    await reset();
    mon.placeAnswer = { id: "ord_late", meta: { state: "pending" } };
    assert.equal((await pay({ amountEur: 75 })).status, 200);
    mon.orders = { ord_late: { id: "ord_late", meta: { state: "processed", processedAt: "2026-10-31T22:30:00Z" } } };
    await call("GET", "/org_co/monerium/payouts", "u_adam");
    const p = (await payouts())[0];
    assert.equal(p.state, "sent");
    assert.equal(p.processedAt, "2026-10-31T22:30:00.000Z");
    const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
    await writeStatementLines();
    const line = (await store.ledgerOf("org_co")).find((e) => e.statement?.key === `org-payout:${p.id}`);
    assert.ok(line, "an account with only a payout is still swept");
    assert.equal(line!.statement!.valueDate, "2026-10-31", "the day Monerium processed it, not the day Zold read it");
  });

  await check("a payout being answered by Monerium is not counted twice against the next one", async () => {
    await reset();
    bal = 100;
    let r: any;
    // A second payout is started while Monerium is still answering the first.
    mon.wait = async () => { r = await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 40 })); };
    assert.equal((await pay({ amountEur: 60 })).status, 200);
    assert.equal(r.status, 201, `60 held once leaves 40: ${r.text}`);
  });

  await check("an old pending payout that turns sent behind 50 newer finished rows is booked, not dropped", async () => {
    await reset();
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const base = { amountEur: 1, recipientName: "Bob GmbH", recipientIban: OTHER_IBAN, memo: "m", message: "x", safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna" };
    const old = { ...base, id: "old-one", orderId: "ord_old_one", state: "pending", issuedAt: at(0), createdAt: at(0), updatedAt: at(0) };
    const newer = Array.from({ length: 50 }, (_, i) => ({ ...base, id: `fin${i}`, orderId: `ord_fin${i}`, state: "failed", issuedAt: at(100 + i), createdAt: at(100 + i), updatedAt: at(100 + i) }));
    await store.updateAccount("acc_co", { moneriumPayouts: [...newer, old] } as any);
    mon.orders = { ord_old_one: { id: "ord_old_one", meta: { state: "processed", processedAt: at(5) } } };
    assert.equal((await call("GET", "/org_co/monerium/payouts", "u_adam")).status, 200);
    const line = (await store.ledgerOf("org_co")).find((e) => e.statement?.key === "org-payout:old-one");
    assert.ok(line, "the payout Monerium carried out has its statement line before the history cap drops its row");
    assert.equal(line!.statement!.amountCents, -100);
  });

  await check("a token-grant 5xx is before POST /orders: failed, no hold, nothing placed", async () => {
    await reset();
    bal = 300;
    const { companyMoneriumClient } = await import("../services/api/src/routes/business/org-monerium-iban.js");
    const realFetch = globalThis.fetch;
    let orders = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1")) return realFetch(url, init);
      if (u.endsWith("/auth/token")) return new Response(`upstream ${PROVIDER_BODY}`, { status: 503 });
      if (u.endsWith("/orders")) orders++;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const stubbed = io.monerium;
    // Only placeOrder goes to the real client: the IBAN checks stay stubbed.
    io.monerium = (org: any) => ({ ...client, placeOrder: (b: any) => companyMoneriumClient(org).placeOrder(b) }) as any;
    let r;
    try { r = await pay({ amountEur: 300 }); } finally { globalThis.fetch = realFetch; io.monerium = stubbed; }
    assert.equal(orders, 0, "POST /orders was never sent");
    assert.equal((await payouts())[0].state, "failed", "no order was placed, so it is not unknown");
    assert.ok(!r!.text.includes(PROVIDER_BODY));
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 300 }))).status, 201, "the failed payout holds nothing");
  });

  await check("an owner clears an unknown payout without an order id after checking Monerium, audited; nothing else is cleared", async () => {
    await reset();
    bal = 300;
    mon.placeAnswer = { meta: { state: "placed" } };
    assert.equal((await pay({ amountEur: 300 })).status, 202);
    const id = (await payouts())[0].id;
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 1 }))).data.code, "AMOUNT_OVER_BALANCE", "the unknown row holds the euros");
    clearPendingPayouts();
    assert.equal((await call("POST", `/org_co/monerium/payouts/${id}/clear`, "u_adam", { checkedMonerium: true })).status, 403, "an admin cannot");
    const unconfirmed = await call("POST", `/org_co/monerium/payouts/${id}/clear`, "u_anna", {});
    assert.equal(unconfirmed.status, 400, unconfirmed.text);
    assert.equal((await payouts())[0].state, "unknown");
    const r = await call("POST", `/org_co/monerium/payouts/${id}/clear`, "u_anna", { checkedMonerium: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.payout.state, "failed");
    assert.match(r.data.payout.error, /owner/i);
    assert.match(model.payoutNotice(r.data.payout), /owner cleared/, "the toast says why, not that Monerium refused");
    const audit = (await store.list("audit")).filter((a: any) => a.kind === "org_payout.cleared");
    assert.equal(audit.length, 1);
    assert.equal((audit[0] as any).userId, "u_anna");
    assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 300 }))).status, 201, "the hold is released");
    clearPendingPayouts();
    assert.equal((await call("POST", `/org_co/monerium/payouts/${id}/clear`, "u_anna", { checkedMonerium: true })).status, 409, "a failed row is not cleared again");
    // A pending order Monerium holds is never cleared by hand.
    mon.placeAnswer = { id: "ord_hold", meta: { state: "pending" } };
    assert.equal((await pay({ amountEur: 10 })).status, 200);
    const held = (await payouts()).find((p) => p.orderId === "ord_hold")!;
    assert.equal((await call("POST", `/org_co/monerium/payouts/${held.id}/clear`, "u_anna", { checkedMonerium: true })).status, 409);
  });

  await check("a payout still being sent is not cleared: the hold stays and the order is placed", async () => {
    await reset();
    bal = 300;
    let cleared: any, listed: any;
    mon.wait = async () => {
      const id = (await payouts())[0].id;
      listed = (await call("GET", "/org_co/monerium/payouts", "u_otto")).data.payouts[0];
      cleared = await call("POST", `/org_co/monerium/payouts/${id}/clear`, "u_otto", { checkedMonerium: true });
      assert.equal((await call("POST", "/org_co/monerium/payouts/start", "u_anna", input({ amountEur: 1 }))).data.code, "AMOUNT_OVER_BALANCE", "the euros stay held");
    };
    const r = await pay({ amountEur: 300 });
    assert.equal(cleared.status, 409, cleared.text);
    assert.equal(cleared.data.code, "PAYOUT_IN_FLIGHT");
    assert.equal(listed.inFlight, true);
    assert.equal(model.payoutRows([listed])[0].clearable, false, "Settings offers no clear while it is being sent");
    assert.equal(r.status, 200, r.text);
    assert.equal((await payouts())[0].state, "pending", "the order placed meanwhile is what the row says");
    assert.equal((await store.list("audit")).filter((a: any) => a.kind === "org_payout.cleared" && a.payoutId === (r.data.payout.id)).length, 0);
    assert.equal((await call("GET", "/org_co/monerium/payouts", "u_otto")).data.payouts[0].inFlight, undefined, "answered: no longer in flight");
  });

  await check("an old unclear payout behind newer ones is still listed, and clearing it past the history cap answers and is audited", async () => {
    await reset();
    const at = (n: number) => new Date(Date.parse(now) - n * 60_000).toISOString();
    const row = (id: string, state: string, n: number) => ({ id, amountEur: 5, recipientName: "Bob GmbH", recipientIban: OTHER_IBAN, memo: "m", message: "x", issuedAt: at(n), safeAddress: SAFE, profileId: PROFILE, signedByMemberId: "m_anna", state, createdAt: at(n), updatedAt: at(n) });
    await store.updateAccount("acc_co", { moneriumPayouts: [...Array.from({ length: 50 }, (_, i) => row(`done-${i}`, "failed", i)), row("old-unclear", "unknown", 99)] } as any);
    const list = (await call("GET", "/org_co/monerium/payouts", "u_anna")).data.payouts;
    assert.equal(list.length, 21, "the newest twenty and the one still holding money");
    assert.equal(model.payoutRows(list).find((p: any) => p.id === "old-unclear")?.clearable, true);
    const before = (await store.list("audit")).filter((a: any) => a.kind === "org_payout.cleared").length;
    const r = await call("POST", "/org_co/monerium/payouts/old-unclear/clear", "u_anna", { checkedMonerium: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.payout.state, "failed");
    assert.ok(!(await payouts()).some((p) => p.id === "old-unclear"), "(the cap dropped the cleared row)");
    const audit = (await store.list("audit")).filter((a: any) => a.kind === "org_payout.cleared");
    assert.equal(audit.length, before + 1, "who cleared it is recorded");
    assert.equal((audit.at(-1) as any).userId, "u_anna");
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
    assert.equal(row.clearable, true, "unclear with no order: an owner may clear it");
    assert.equal(model.payoutRows([{ id: "p2", amountEur: 1, recipientName: "B", recipientIban: OTHER_IBAN, state: "unknown", orderId: "ord_x", createdAt: now }])[0].clearable, false, "an order to follow is never cleared by hand");
    assert.match(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, true, true).text, /pay a bank account from it below/);
    assert.match(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, true).text, /not built yet/);
  });
} finally {
  server.close();
}
console.log(`\n${passed} passed`);
