/**
 * Who signs for a company org's Safe (domain/org-signers.ts,
 * wallet/org-signers.ts, routes/business/org-safe.ts).
 *
 * Covers:
 *   - the join: an owner with a passkey maps; an owner without one is "no
 *     passkey yet", not a signer; an invited member is skipped; a deactivated
 *     owner still on chain is named and flagged; an owner no member matches
 *     is listed as added outside Zold; a re-bound passkey names the old
 *     owner by its label and says the passkey changed, and without a stored
 *     label never claims a passkey change; two members with one
 *     address are one owner; the label never makes anyone a signer;
 *   - the op view's projection of the join (safe-ops.ts) names only active
 *     owner members by their passkey;
 *   - a member is named by name, or by email without one;
 *   - memberForOwner / ownerAddressOfMember search this org only, by the
 *     login passkey;
 *   - GET /api/orgs/:orgId/safe: a viewer reads it; a non-member gets a 404;
 *     a sole_trader and a personal org are refused by name; before the
 *     deployment it is not_set_up; an RPC failure and a threshold above the
 *     owner count are "couldn't check" (502), never an empty owner set; no
 *     other org's member is named.
 *
 * Offline: the chain (owners, threshold) is a stub; passkeys are software keys.
 * Run: npm run org-signers:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-signers-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createOrgSafeRoutes } = await import("../services/api/src/routes/business/org-safe.js");
const { orgSigners, opSigners } = await import("../services/api/src/domain/org-signers.js");
const { memberForOwner, ownerAddressOfMember } = await import("../services/api/src/wallet/org-signers.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
await initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const M = (id: string, over: Record<string, unknown> = {}): any => ({ memberId: id, role: "owner", status: "active", name: id, hasUser: true, passkeyAddress: null, ...over });

// ── the pure join ───────────────────────────────────────────────────────────

await check("an owner with a passkey on chain maps to that member", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) })], [A(1)]);
  assert.deepEqual(j.owners, [{ address: A(1), memberId: "anna", name: "anna" }]);
  assert.deepEqual(j.unknown, []);
  assert.deepEqual(j.members, [{ memberId: "anna", name: "anna", passkey: true, signerAddress: A(1), onChain: true }]);
});

await check("an owner without a passkey is 'no passkey yet', not a signer", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("bert")], [A(1)]);
  const bert = j.members.find((m) => m.memberId === "bert")!;
  assert.equal(bert.passkey, false);
  assert.equal(bert.onChain, false);
  assert.equal(bert.signerAddress, null);
});

await check("an owner whose passkey is not on chain is listed as not a signer", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("cara", { passkeyAddress: A(3) })], [A(1)]);
  const cara = j.members.find((m) => m.memberId === "cara")!;
  assert.equal(cara.passkey, true);
  assert.equal(cara.onChain, false);
  assert.equal(j.owners.length, 1);
});

await check("an invited member with no login is skipped", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("inv", { status: "invited", hasUser: false })], [A(1)]);
  assert.deepEqual(j.members.map((m) => m.memberId), ["anna"]);
});

await check("a deactivated owner still on chain is named and flagged", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("dora", { status: "deactivated", passkeyAddress: A(4) })], [A(1), A(4)]);
  assert.deepEqual(j.owners[1], { address: A(4), memberId: "dora", name: "dora", note: "not_an_owner" });
  assert.deepEqual(j.unknown, [], "a former member's key is not an unknown owner");
  assert.ok(!j.members.some((m) => m.memberId === "dora"), "not an owner member any more");
});

await check("a member demoted from owner still on chain is flagged, not a signer", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("pete", { role: "payer", passkeyAddress: A(5) })], [A(1), A(5)]);
  assert.equal(j.owners[1].note, "not_an_owner");
});

await check("an owner no member matches is listed as added outside Zold", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) })], [A(1), A(9)]);
  assert.deepEqual(j.owners[1], { address: A(9), note: "added_outside_zold" });
  assert.deepEqual(j.unknown, [A(9)]);
});

await check("a re-bound passkey: the old owner is named by its label, the new key is not on chain", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(2), label: A(1) })], [A(1)]);
  assert.deepEqual(j.owners, [{ address: A(1), memberId: "anna", name: "anna", note: "passkey_changed" }]);
  assert.deepEqual(j.unknown, [], "not reported as unknown");
  assert.deepEqual(j.members, [{ memberId: "anna", name: "anna", passkey: true, signerAddress: A(2), onChain: false, oldSignerOnChain: A(1) }]);
});

await check("no stored label: a re-bound passkey's old owner is never called a passkey change", () => {
  // The deploy labels only the deploying owner and nothing else writes
  // Member.signerAddress, so an unset label is the state every other owner has.
  const j = orgSigners([M("anna", { passkeyAddress: A(2) })], [A(1)]);
  assert.deepEqual(j.owners, [{ address: A(1), note: "added_outside_zold" }]);
  assert.deepEqual(j.unknown, [A(1)]);
  assert.deepEqual(j.members, [{ memberId: "anna", name: "anna", passkey: true, signerAddress: A(2), onChain: false }]);
});

await check("the label never makes a signer: the op view leaves a label-only match unnamed", () => {
  const rows = opSigners([M("anna", { passkeyAddress: A(2), label: A(1) })], [A(1)], []);
  assert.deepEqual(rows, [{ address: A(1), signed: false }]);
});

await check("two members with one address are one owner", () => {
  const j = orgSigners([M("anna", { passkeyAddress: A(1) }), M("anna2", { passkeyAddress: A(1) })], [A(1)]);
  assert.equal(j.owners.length, 1);
  assert.equal(j.owners[0].memberId, "anna", "first member wins the address");
});

await check("addresses match whatever their case", () => {
  const j = orgSigners([M("anna", { passkeyAddress: `0x${"AB".repeat(20)}` })], [`0x${"ab".repeat(20)}`]);
  assert.equal(j.owners[0].memberId, "anna");
  assert.equal(j.members[0].onChain, true);
});

await check("op view: active owners by passkey, with who signed", () => {
  const rows = opSigners([M("anna", { passkeyAddress: A(1) }), M("dora", { status: "deactivated", passkeyAddress: A(4) })], [A(1), A(4)], [A(1)]);
  assert.deepEqual(rows, [{ address: A(1), memberId: "anna", name: "anna", signed: true }, { address: A(4), signed: false }]);
});

// ── the store half and the route ────────────────────────────────────────────

const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const COORD = () => `0x${randomBytes(32).toString("hex")}`;
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
const org = async (id: string, extra: Record<string, unknown>) =>
  await store.addOrganisation({ id, name: id, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now, ...extra } as any);
await org("org_co", { type: "business", entity: "company" });
await org("org_st", { type: "business", entity: "sole_trader" });
await org("org_pers", { type: "personal" });
await org("org_other", { type: "business", entity: "company" });
for (const p of ["anna", "bert", "vera", "nina", "olga"]) {
  if (p !== "bert") {
    keys[p] = await makeSoftwarePasskey(p, ORIGIN);
    addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  }
  await store.addUser({
    id: `u_${p}`, ...(p === "bert" ? {} : { name: p[0].toUpperCase() + p.slice(1) }), country: "DE", kycStatus: "approved",
    ...(keys[p] ? { passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now } } : {}),
    createdAt: now,
  } as any);
}
const member = async (id: string, orgId: string, userId: string, role: string, email = "") =>
  await store.addMember({ id, orgId, userId, email, role, status: "active", invitedAt: now, acceptedAt: now } as any);
await member("m_anna", "org_co", "u_anna", "owner");
await member("m_bert", "org_co", "u_bert", "owner", "bert@co.example"); // no passkey yet, no name
await member("m_vera", "org_co", "u_vera", "viewer");
await member("m_st", "org_st", "u_anna", "owner");
await member("m_pers", "org_pers", "u_anna", "owner");
await member("m_olga", "org_other", "u_olga", "owner");

await check("ownerAddressOfMember is the login passkey's address; memberForOwner searches one org", async () => {
  assert.equal(await ownerAddressOfMember((await store.findMember("m_anna"))!), addr.anna);
  assert.equal(await ownerAddressOfMember((await store.findMember("m_bert"))!), null, "no passkey: no address");
  assert.equal((await memberForOwner("org_co", addr.anna.toLowerCase()))?.id, "m_anna");
  assert.equal(await memberForOwner("org_co", addr.olga), undefined, "another org's owner is not this org's");
  assert.equal(await memberForOwner("org_co", addr.vera), undefined, "a viewer is no owner");
});

const stub = { owners: [] as `0x${string}`[], threshold: 1, fail: false, reads: 0 };
const reader = {
  read: async () => {
    stub.reads++;
    if (stub.fail) throw new Error("rpc down");
    return { owners: [...stub.owners], threshold: stub.threshold };
  },
};
const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgSafeRoutes({ ctxOf: async (req, res) => await resolveOrg(req, res, requireSession as any) }, reader));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const get = async (orgId: string, user: string) => {
  const res = await fetch(`${API}/orgs/${orgId}/safe`, { headers: { "x-user": user } });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

await check("before the deployment: 200 not_set_up, no chain read", async () => {
  stub.reads = 0;
  const r = await get("org_co", "u_vera");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { state: "not_set_up" });
  await store.setOrgSafePlan("org_co", { kind: "org", status: "active", address: SAFE, owners: [{ x: COORD(), y: COORD() }], createdAt: now });
  const planned = await get("org_co", "u_vera");
  assert.deepEqual(planned.data, { state: "not_set_up" }, "a plan with no account at its address is not deployed");
  assert.equal(stub.reads, 0);
});

await store.addAccount({ id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, address: SAFE, createdAt: now, updatedAt: now } as any);

await check("a viewer reads owners, threshold and each owner member's status", async () => {
  stub.fail = false;
  stub.owners = [addr.anna, addr.olga, addr.nina];
  stub.threshold = 2;
  const r = await get("org_co", "u_vera");
  assert.equal(r.status, 200);
  assert.equal(r.data.state, "set_up");
  assert.equal(r.data.safeAddress, SAFE);
  assert.equal(r.data.chainId, 84532);
  assert.equal(r.data.threshold, 2, "the chain's threshold");
  assert.deepEqual(r.data.owners[0], { address: addr.anna, memberId: "m_anna", name: "Anna" });
  assert.deepEqual(r.data.unknown, [addr.olga, addr.nina], "an owner of another org's Safe is unknown here");
  assert.ok(!JSON.stringify(r.data).includes("Olga") && !JSON.stringify(r.data).includes("m_olga"), "no other org's member is named");
  assert.deepEqual(r.data.members.map((m: any) => [m.memberId, m.passkey, m.onChain]), [["m_anna", true, true], ["m_bert", false, false]]);
  assert.equal(r.data.members[1].name, "bert@co.example", "a member without a name is shown by email");
});

await check("a non-member gets a 404", async () => {
  assert.equal((await get("org_co", "u_olga")).status, 404);
});

await check("a sole_trader and a personal org are refused by name", async () => {
  const st = await get("org_st", "u_anna");
  assert.equal(st.status, 409);
  assert.equal(st.data.code, "NOT_A_COMPANY");
  const pers = await get("org_pers", "u_anna");
  assert.equal(pers.status, 409);
  assert.equal(pers.data.code, "NOT_A_COMPANY");
});

await check("an RPC failure is couldn't check, never an empty owner set", async () => {
  stub.fail = true;
  const r = await get("org_co", "u_vera");
  assert.equal(r.status, 502);
  assert.equal(r.data.code, "SAFE_UNREADABLE");
  assert.equal(r.data.owners, undefined);
  stub.fail = false;
});

await check("a threshold above the owner count, or no owners, fails closed", async () => {
  stub.owners = [addr.anna];
  stub.threshold = 2;
  assert.equal((await get("org_co", "u_vera")).data.code, "SAFE_UNREADABLE");
  stub.owners = [];
  stub.threshold = 1;
  assert.equal((await get("org_co", "u_vera")).data.code, "SAFE_UNREADABLE");
});

server.close();
console.log(`\norg-signers: ${passed} passed`);
