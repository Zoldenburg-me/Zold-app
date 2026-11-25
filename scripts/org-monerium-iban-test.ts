/**
 * A company's IBAN on its own Safe (routes/business/org-monerium-iban.ts,
 * domain/org-monerium-iban.ts, public/business/org-monerium-model.js).
 *
 * Covers:
 *   - who signs: only an owner whose login passkey is an owner of the Safe on
 *     chain; a payer and an admin get 403, an owner whose passkey is not on
 *     the Safe 403 NOT_A_SIGNER, a sole trader 409;
 *   - what must hold first: approved company keys, the company Safe set up
 *     behind the EUR account, a Safe at threshold 1 (more is refused by name,
 *     nothing sent to Monerium);
 *   - the declaration: the challenge is the Safe message hash of Monerium's
 *     LINK_MESSAGE; only this owner's fresh assertion over it is accepted, a
 *     request is spent on use and bound to the member; the signature sent is
 *     the one built from that assertion, for the org Safe under the company
 *     profile, never the founder's own Safe;
 *   - the IBAN: requested after Monerium shows the Safe on the company
 *     profile; the account opens only when Monerium attributes an approved
 *     IBAN to the Safe; a link Monerium has not made yet, and an IBAN not
 *     issued yet, are waiting states a check moves on; a Safe linked under
 *     another profile, or a profile whose one IBAN pays another address (the
 *     founder's own Safe), is refused and opens nothing;
 *   - an IBAN record for the Safe's address on another chain is never
 *     adopted; an issued IBAN Monerium now lists elsewhere closes the
 *     account, an outage or an unlisted IBAN changes nothing;
 *   - keys removed or replaced while Monerium answers are never written back;
 *   - an issued company account reads as verified, so its payment page opens;
 *   - deposits: only EUR issue orders into the company Safe on our chain,
 *     newest first, without the payer's IBAN; Monerium's own response body
 *     never reaches the browser;
 *   - Home and Settings say what the state is (org-monerium-model.js).
 *
 * Offline: Monerium, the chain read and the Safe signature are stubs
 * injected into the router; the passkey is a software key.
 * Run: npm run org-monerium-iban:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-iban-")), "db.json");
process.env.TRANSF_DB_PATH = DB;
process.env.TRANSF_CHAIN_ID = "31337";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createOrgMoneriumIbanRoutes } = await import("../services/api/src/routes/business/org-monerium-iban.js");
const { MoneriumApiError, LINK_MESSAGE } = await import("../services/api/src/adapters/monerium-client.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { safeMessageHash } = await import("../services/api/src/wallet/candide.js");
const { passkeySafeChallenge } = await import("../services/api/src/wallet/passkey-safe-plan.js");
const { companyIbanState } = await import("../services/api/src/domain/org-monerium-iban.js");
const { orgPageAccount } = await import("../services/api/src/routes/business/org-payment-page.js");
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
/** The founder's own personal Safe: company money must never land here. */
const OWN_SAFE = "0x0000000000000000000000000000000000f0f0f0" as const;
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
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved", address: p === "anna" ? OWN_SAFE : undefined,
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
  const role = p === "adam" ? "admin" : p === "pia" ? "payer" : "owner";
  await store.addMember({ id: `m_${p}`, orgId: "org_co", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
await store.addMember({ id: "m_st", orgId: "org_st", userId: "u_anna", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
await store.setOrgSafePlan("org_co", { kind: "org", status: "active", address: SAFE, owners: [{ x: hex(keys.anna.jwk.x!), y: hex(keys.anna.jwk.y!) }], createdAt: now } as any);
await store.addAccount({ id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "gated", provider: null, identifier: {}, address: SAFE, createdAt: now, updatedAt: now } as any);
const connected = (state = "approved") => ({
  clientId: "test-client-id-0000-1111",
  clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", "test-secret-placeholder-" + Math.random().toString(36).slice(2)),
  profile: { id: PROFILE, name: "Acme GmbH", state }, connectedAt: now, checkedAt: now, connectedByMemberId: "m_adam",
});
const reset = async () => {
  await store.updateOrganisation("org_co", { monerium: connected() as any });
  await store.updateAccount("acc_co", { status: "gated", provider: null, identifier: {}, moneriumProfile: undefined, address: SAFE } as any);
  Object.assign(mon, freshMon());
  chain.owners = [addr.anna];
  chain.threshold = 1;
  signed.length = 0;
};

// ── stubs: the chain, the Safe signature, Monerium on the company keys ──────
const chain = { owners: [addr.anna] as `0x${string}`[], threshold: 1 };
const signed: string[] = [];
const PROVIDER_BODY = "provider-body-marker-must-not-reach-the-browser";
const freshMon = () => ({
  links: [] as any[],
  linkedUnder: PROFILE as string | undefined,
  /** Linked only after this many reads: a link Monerium makes later. */
  linkAfterReads: 0,
  reads: 0,
  ibanRequests: [] as string[],
  ibanAnswer: "ok" as "ok" | "304" | "refuse",
  ibans: [] as any[],
  /** Issued on the IBAN request (Monerium issues within seconds). */
  issueOnRequest: true,
  orders: [] as any[],
  linkFails: "" as "" | "refuse" | "down",
  /** Runs while Monerium "answers" a call: a change made meanwhile. */
  during: undefined as undefined | { call: string; act: () => Promise<void> },
  ibansFail: false,
});
const meanwhile = async (name: string) => {
  if (mon.during?.call === name) { const act = mon.during.act; mon.during = undefined; await act(); }
};
const mon = freshMon();
const client = {
  async linkAddress(p: any) {
    if (mon.linkFails === "refuse") throw new MoneriumApiError(`Monerium POST /addresses failed (400): ${PROVIDER_BODY}`, 400);
    if (mon.linkFails === "down") throw new Error("connect ECONNREFUSED");
    mon.links.push(p);
    await meanwhile("link");
    return {};
  },
  async linkedProfile(address: string) {
    assert.equal(address.toLowerCase(), SAFE.toLowerCase(), "only the company Safe is looked up");
    mon.reads++;
    return mon.reads > mon.linkAfterReads ? mon.linkedUnder : undefined;
  },
  async requestIban(address: string) {
    mon.ibanRequests.push(address);
    await meanwhile("requestIban");
    if (mon.ibanAnswer === "304") throw new MoneriumApiError("Monerium POST /ibans failed (304): ", 304);
    if (mon.ibanAnswer === "refuse") throw new MoneriumApiError(`Monerium POST /ibans failed (422): ${PROVIDER_BODY}`, 422);
    if (mon.issueOnRequest) mon.ibans.push({ iban: IBAN, profile: PROFILE, address, chain: MONERIUM.chain, state: "approved" });
    return {};
  },
  async ibans() {
    if (mon.ibansFail) throw new Error("connect ECONNREFUSED");
    return { ibans: mon.ibans.map((i) => ({ ...i })) };
  },
  async orders() { return { orders: mon.orders }; },
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
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgMoneriumIbanRoutes({ ctxOf: async (req, res) => await resolveOrg(req, res, requireSession as any) }, io as any));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, data: (text ? JSON.parse(text) : {}) as any };
};
/** Start, sign the challenge with `p`'s software passkey, submit. */
const issue = async (p = "anna", tamper?: (start: any, signed: any) => void) => {
  const start = await call("POST", "/org_co/monerium/link/start", `u_${p}`);
  if (start.status !== 201) return start;
  const a = await keys[p].assert(start.data.challenge);
  const body = { requestId: start.data.requestId, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature };
  tamper?.(start.data, body);
  return call("POST", "/org_co/monerium/link", `u_${p}`, body);
};
const account = async () => (await store.findAccount("acc_co"))!;
const gatedStill = async () => {
  assert.equal((await account()).status, "gated", "the account stays closed");
  assert.equal((await account()).identifier.iban, undefined, "no IBAN shown");
};

try {
  await reset();

  await check("only an owner whose passkey is on the Safe signs; payers, admins and sole traders are refused", async () => {
    for (const u of ["u_pia", "u_adam"]) {
      const r = await call("POST", "/org_co/monerium/link/start", u);
      assert.equal(r.status, 403, `${u}: ${r.text}`);
    }
    const otto = await call("POST", "/org_co/monerium/link/start", "u_otto");
    assert.equal(otto.status, 403, otto.text);
    assert.equal(otto.data.code, "NOT_A_SIGNER");
    const st = await call("POST", "/org_st/monerium/link/start", "u_anna");
    assert.equal(st.status, 409);
    assert.equal(st.data.code, "NOT_A_COMPANY");
    assert.equal(mon.links.length, 0);
  });

  await check("keys not approved, no Safe, or a Safe needing two signatures: refused before Monerium is asked", async () => {
    await store.updateOrganisation("org_co", { monerium: connected("pending") as any });
    assert.equal((await call("POST", "/org_co/monerium/link/start", "u_anna")).data.code, "MONERIUM_NOT_CONNECTED");
    await store.updateOrganisation("org_co", { monerium: undefined });
    assert.equal((await call("POST", "/org_co/monerium/link/start", "u_anna")).data.code, "MONERIUM_NOT_CONNECTED");
    await reset();
    await store.updateAccount("acc_co", { address: undefined } as any);
    assert.equal((await call("POST", "/org_co/monerium/link/start", "u_anna")).data.code, "ORG_SAFE_NOT_DEPLOYED");
    await reset();
    chain.owners = [addr.anna, addr.otto];
    chain.threshold = 2;
    const two = await call("POST", "/org_co/monerium/link/start", "u_anna");
    assert.equal(two.status, 409);
    assert.equal(two.data.code, "ORG_SAFE_NEEDS_MORE_SIGNATURES");
    assert.equal(mon.links.length, 0);
    await gatedStill();
    await reset();
  });

  await check("the challenge is the Safe message hash of Monerium's declaration", async () => {
    const r = await call("POST", "/org_co/monerium/link/start", "u_anna");
    assert.equal(r.status, 201, r.text);
    assert.equal(r.data.challenge, passkeySafeChallenge(safeMessageHash(SAFE, LINK_MESSAGE)));
    assert.equal(r.data.address, SAFE);
    assert.equal(r.data.credentialId, keys.anna.credentialId);
    assert.equal(r.data.message, LINK_MESSAGE);
  });

  await check("an owner signs: the company Safe is linked under the company profile, the IBAN issued onto it, the account opened", async () => {
    await reset();
    const r = await issue();
    assert.equal(r.status, 200, r.text);
    assert.equal(mon.links.length, 1);
    const link = mon.links[0];
    assert.equal(link.address, SAFE, "the company Safe, never the founder's own Safe");
    assert.notEqual(link.address.toLowerCase(), OWN_SAFE.toLowerCase());
    assert.equal(link.profile, PROFILE);
    assert.equal(link.message, LINK_MESSAGE);
    assert.equal(link.signature, "0x5167", "the signature built from this owner's assertion");
    assert.deepEqual(signed, [`${BigInt(hex(keys.anna.jwk.x!))}:${BigInt(hex(keys.anna.jwk.y!))}`], "signed as anna's passkey owner");
    assert.deepEqual(mon.ibanRequests, [SAFE]);
    const a = await account();
    assert.equal(a.status, "active");
    assert.equal(a.identifier.iban, IBAN);
    assert.equal(a.address, SAFE);
    assert.equal(a.backingUserId, undefined, "no person backs a company account");
    assert.deepEqual({ id: a.moneriumProfile!.id, kind: a.moneriumProfile!.kind }, { id: PROFILE, kind: "corporate" });
    assert.equal(r.data.monerium.companyIban.state, "issued");
    assert.equal(r.data.monerium.companyIban.iban, IBAN);
    assert.ok(!r.text.includes("clientSecret"), "no secret in the answer");
    assert.equal(companyIbanState((await store.findOrganisation("org_co"))!, a), "issued");
    // Issued: nothing more to sign.
    assert.equal((await call("POST", "/org_co/monerium/link/start", "u_anna")).data.code, "IBAN_ISSUED");
  });

  await check("a request is spent on use and bound to its owner; an assertion over another challenge is refused", async () => {
    await reset();
    // Replayed request id.
    const start = await call("POST", "/org_co/monerium/link/start", "u_anna");
    const a = await keys.anna.assert(start.data.challenge);
    const body = { requestId: start.data.requestId, ...a };
    await store.updateOrganisation("org_co", { monerium: { ...connected(), safe: undefined } as any });
    const first = await call("POST", "/org_co/monerium/link", "u_anna", { ...body, signature: "AAAA" });
    assert.equal(first.status, 401, first.text);
    const replay = await call("POST", "/org_co/monerium/link", "u_anna", body);
    assert.equal(replay.status, 409, "a spent request is gone, even after a failed assertion");
    assert.equal(replay.data.code, "LINK_NOT_STARTED");
    // Another owner (whose passkey is on chain now) cannot finish anna's request.
    chain.owners = [addr.anna, addr.otto];
    const s2 = await call("POST", "/org_co/monerium/link/start", "u_anna");
    const o = await keys.otto.assert(s2.data.challenge);
    const other = await call("POST", "/org_co/monerium/link", "u_otto", { requestId: s2.data.requestId, ...o });
    assert.equal(other.status, 409);
    // An assertion over a different challenge.
    const s3 = await call("POST", "/org_co/monerium/link/start", "u_anna");
    const wrong = await keys.anna.assert(passkeySafeChallenge(safeMessageHash(OWN_SAFE, LINK_MESSAGE)));
    const w = await call("POST", "/org_co/monerium/link", "u_anna", { requestId: s3.data.requestId, ...wrong });
    assert.equal(w.status, 401, w.text);
    assert.equal(mon.links.length, 0, "nothing reached Monerium");
    await gatedStill();
  });

  await check("the Safe's owners changing after the challenge: the owner no longer on the Safe is refused", async () => {
    await reset();
    const start = await call("POST", "/org_co/monerium/link/start", "u_anna");
    const a = await keys.anna.assert(start.data.challenge);
    chain.owners = [addr.otto];
    const r = await call("POST", "/org_co/monerium/link", "u_anna", { requestId: start.data.requestId, ...a });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.data.code, "NOT_A_SIGNER");
    assert.equal(mon.links.length, 0);
    await gatedStill();
  });

  await check("a link Monerium makes later, then an IBAN issued later: waiting states a check moves on", async () => {
    await reset();
    mon.linkAfterReads = 1;
    mon.issueOnRequest = false;
    const r = await issue();
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.monerium.companyIban.state, "link_pending");
    assert.deepEqual(mon.ibanRequests, [], "no IBAN requested before Monerium shows the link");
    await gatedStill();
    assert.equal((await call("POST", "/org_co/monerium/iban/check", "u_pia")).status, 403, "a payer cannot");
    const c1 = await call("POST", "/org_co/monerium/iban/check", "u_adam");
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c1.data.monerium.companyIban.state, "iban_requested");
    assert.deepEqual(mon.ibanRequests, [SAFE]);
    await gatedStill();
    const c2 = await call("POST", "/org_co/monerium/iban/check", "u_adam");
    assert.equal(c2.data.monerium.companyIban.state, "iban_requested", "still not issued");
    assert.equal(mon.ibanRequests.length, 1, "requested once, not on every check");
    mon.ibans.push({ iban: IBAN, profile: PROFILE, address: SAFE, state: "pending" });
    assert.equal((await call("POST", "/org_co/monerium/iban/check", "u_adam")).data.monerium.companyIban.state, "iban_requested", "a pending IBAN opens nothing");
    mon.ibans[0].state = "approved";
    const c3 = await call("POST", "/org_co/monerium/iban/check", "u_adam");
    assert.equal(c3.data.monerium.companyIban.state, "issued");
    assert.equal((await account()).status, "active");
  });

  await check("a Safe Monerium has under another profile is refused: no IBAN requested, nothing opened", async () => {
    await reset();
    mon.linkedUnder = "prof-someone-else";
    const r = await issue();
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "ADDRESS_NOT_ON_PROFILE");
    assert.deepEqual(mon.ibanRequests, []);
    await gatedStill();
  });

  await check("the profile's one IBAN paying the founder's own Safe is never adopted for the company", async () => {
    await reset();
    mon.ibanAnswer = "304";
    mon.ibans = [{ iban: OTHER_IBAN, profile: PROFILE, address: OWN_SAFE, state: "approved" }];
    const r = await issue();
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "PROFILE_IBAN_ELSEWHERE");
    assert.ok(!r.text.includes(OTHER_IBAN), "the other IBAN is not shown");
    await gatedStill();
    // Even without the 304, an IBAN on the profile for another address is not this Safe's.
    await reset();
    mon.issueOnRequest = false;
    mon.ibans = [{ iban: OTHER_IBAN, profile: PROFILE, address: OWN_SAFE, state: "approved" }];
    assert.equal((await issue()).data.code, "PROFILE_IBAN_ELSEWHERE");
    await gatedStill();
    // An IBAN for this Safe on another profile is not the company's either.
    await reset();
    mon.issueOnRequest = false;
    mon.ibans = [{ iban: OTHER_IBAN, profile: "prof-someone-else", address: SAFE, state: "approved" }];
    assert.equal((await issue()).data.monerium.companyIban.state, "iban_requested");
    await gatedStill();
  });

  await check("an IBAN record for the Safe's address on another chain is never adopted", async () => {
    await reset();
    mon.issueOnRequest = false;
    mon.ibans = [{ iban: OTHER_IBAN, profile: PROFILE, address: SAFE, chain: "gnosis", state: "approved" }];
    const r = await issue();
    assert.equal(r.status, 409, r.text);
    assert.equal(r.data.code, "PROFILE_IBAN_ELSEWHERE");
    await gatedStill();
  });

  await check("an issued IBAN read again: moved elsewhere closes the account; an outage or an unlisted IBAN changes nothing", async () => {
    await reset();
    assert.equal((await issue()).data.monerium.companyIban.state, "issued");
    mon.ibansFail = true;
    const warn = console.warn;
    console.warn = () => {};
    let down;
    try { down = await call("POST", "/org_co/monerium/iban/check", "u_adam"); } finally { console.warn = warn; }
    mon.ibansFail = false;
    assert.equal(down.status, 503);
    assert.equal((await account()).status, "active", "an outage changes nothing");
    mon.ibans = [];
    assert.equal((await call("POST", "/org_co/monerium/iban/check", "u_adam")).data.monerium.companyIban.state, "issued", "an IBAN Monerium does not list is not taken off");
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: MONERIUM.chain, state: "approved" }];
    assert.equal((await call("POST", "/org_co/monerium/iban/check", "u_adam")).data.monerium.companyIban.state, "issued");
    // Moved to another address at Monerium: no longer offered for this Safe.
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: OWN_SAFE, chain: MONERIUM.chain, state: "approved" }];
    const moved = await call("POST", "/org_co/monerium/iban/check", "u_adam");
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.data.monerium.companyIban.state, "moved", "said as moved, not as waiting for issuance");
    assert.match(model.ibanNotice(moved.data.monerium), /elsewhere/);
    await gatedStill();
    // And it is not re-adopted for the Safe while it pays elsewhere.
    const again = await call("POST", "/org_co/monerium/iban/check", "u_adam");
    assert.equal(again.data.code, "PROFILE_IBAN_ELSEWHERE");
    await gatedStill();
    // Moved to the same address on another chain: also closed.
    await reset();
    await issue();
    mon.ibans = [{ iban: IBAN, profile: PROFILE, address: SAFE, chain: "gnosis", state: "approved" }];
    await call("POST", "/org_co/monerium/iban/check", "u_adam");
    await gatedStill();
  });

  await check("keys removed or replaced while Monerium answers are never written back", async () => {
    for (const at of ["link", "requestIban"] as const) {
      for (const change of ["remove", "replace"] as const) {
        await reset();
        const replacement = { ...connected(), clientId: "test-client-id-2222-3333" };
        mon.during = { call: at, act: async () => void await store.updateOrganisation("org_co", { monerium: change === "remove" ? undefined : replacement as any }) };
        const r = await issue();
        assert.equal(r.status, 409, `${at}/${change}: ${r.text}`);
        assert.equal(r.data.code, "MONERIUM_KEYS_CHANGED");
        const now = (await store.findOrganisation("org_co"))!.monerium;
        if (change === "remove") assert.equal(now, undefined, `${at}: the removal stands`);
        else assert.deepEqual(now, replacement, `${at}: the replacement is not written over`);
        await gatedStill();
      }
    }
  });

  await check("an issued company account reads as verified: its payment page can show it", async () => {
    await reset();
    assert.equal("code" in (await orgPageAccount((await store.findOrganisation("org_co"))!)), true, "no page before the IBAN");
    await issue();
    const page = (await orgPageAccount((await store.findOrganisation("org_co"))!)) as any;
    assert.equal(page.code, undefined, JSON.stringify(page));
    assert.equal(page.account.identifier.iban, IBAN);
    assert.equal(page.holder, "Acme GmbH");
  });

  await check("Monerium refusing or down: a fixed answer, never Monerium's body", async () => {
    await reset();
    mon.linkFails = "refuse";
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); };
    let r, d, i;
    try {
      r = await issue();
      mon.linkFails = "down";
      d = await issue();
      await reset();
      mon.ibanAnswer = "refuse";
      i = await issue();
    } finally { console.warn = warn; }
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.code, "MONERIUM_REFUSED");
    assert.equal(d.status, 503);
    assert.equal(i.status, 400);
    for (const x of [r, d, i]) assert.ok(!x.text.includes(PROVIDER_BODY), "not in the answer");
    assert.ok(!logged.join("\n").includes(PROVIDER_BODY), "not in the log");
    await gatedStill();
  });

  await check("deposits: only Monerium's issue orders into the company Safe, newest first, no payer IBAN", async () => {
    await reset();
    assert.deepEqual((await call("GET", "/org_co/monerium/deposits", "u_adam")).data.deposits, [], "none before the IBAN is issued");
    await issue();
    mon.orders = [
      { id: "o1", kind: "issue", amount: "12.50", chain: MONERIUM.chain, currency: "eur", address: SAFE, state: "processed", meta: { placedAt: "2026-11-01T10:00:00Z" }, counterpart: { identifier: { iban: OTHER_IBAN }, details: { companyName: "Kunde AG" } }, memo: "INV-7" },
      { id: "o2", kind: "redeem", amount: "5", address: SAFE, state: "processed", meta: { placedAt: "2026-11-02T10:00:00Z" } },
      { id: "o3", kind: "issue", amount: "99", address: OWN_SAFE, state: "processed", meta: { placedAt: "2026-11-03T10:00:00Z" } },
      { id: "o5", kind: "issue", amount: "100", chain: "gnosis", currency: "eur", address: SAFE, state: "processed", meta: { placedAt: "2026-11-05T10:00:00Z" } },
      { id: "o6", kind: "issue", amount: "7", chain: MONERIUM.chain, currency: "usd", address: SAFE, state: "processed", meta: { placedAt: "2026-11-06T10:00:00Z" } },
      { id: "o4", kind: "issue", amount: "3", chain: MONERIUM.chain, address: SAFE.toUpperCase().replace("0X", "0x"), state: "pending", meta: { placedAt: "2026-11-04T10:00:00Z" }, counterpart: { details: { firstName: "Eva", lastName: "Lang" } } },
    ];
    assert.equal((await call("GET", "/org_co/monerium/deposits", "u_pia")).status, 403);
    const r = await call("GET", "/org_co/monerium/deposits", "u_adam");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.deposits.map((x: any) => x.id), ["o4", "o1"]);
    assert.deepEqual(r.data.deposits[1], { id: "o1", amountEur: 12.5, state: "processed", at: "2026-11-01T10:00:00Z", from: "Kunde AG", memo: "INV-7" });
    assert.equal(r.data.deposits[0].from, "Eva Lang");
    assert.ok(!r.text.includes(OTHER_IBAN), "the payer's IBAN is not passed on");
  });

  await check("Home and Settings say what the state is", () => {
    assert.equal(model.ibanPanel({ companyIban: { state: "ready" } }, true).action, "issue");
    assert.equal(model.ibanPanel({ companyIban: { state: "ready" } }, false).action, undefined, "only an owner who signs gets the button");
    assert.equal(model.ibanPanel({ companyIban: { state: "iban_requested" } }, false).action, "check");
    assert.equal(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, false).iban, IBAN);
    assert.match(model.ibanPanel({ companyIban: { state: "issued", iban: IBAN } }, true).text, /not built yet/, "says payouts are not built");
    assert.equal(model.ibanPanel(null, true).action, undefined);
    assert.equal(model.ibanNotice({ companyIban: { state: "issued" } }), "The company’s IBAN is issued onto its Safe.");
    assert.equal(model.ibanPanel({ status: "connected", companyIban: { state: "issued", iban: IBAN } }, false).action, "check", "an issued IBAN can be checked again");
    assert.equal(model.ibanPanel({ status: "not_connected", companyIban: { state: "issued", iban: IBAN } }, false).action, undefined, "not without the keys");
  });
} finally {
  server.close();
}
console.log(`\n${passed} passed`);
