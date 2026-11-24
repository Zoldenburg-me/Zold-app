/**
 * A company org's own Safe, deployed at account opening
 * (routes/org-safe-deployment.ts, wallet/candide.ts orgSafeAccountFor).
 *
 * Covers:
 *   - a company signup's first org gets a gated EUR account with no address,
 *     and its reasons say the Safe is not set up (not "no IBAN");
 *   - only an owner whose passkey can sign deploys: an admin, a payer, an
 *     owner with no passkey and a non-member are refused; a sole_trader and a
 *     personal org have no Safe of their own; the owner's own personal Safe
 *     need not be activated;
 *   - the org Safe's address is neither the owner's personal Safe nor another
 *     org's, though the same passkey owns all three;
 *   - prepare writes nothing; a bundler refusal writes nothing; an unconfirmed
 *     submit keeps the plan planned (and locks the entity), and a retry that
 *     finds the Safe on chain ("0x") finishes it: plan active, address set,
 *     account still gated; a replay is a no-op;
 *   - the happy path: sign, submit, plan active, address set, still gated,
 *     and the deploying owner's Member.signerAddress is the Safe's owner;
 *   - a planned plan whose owner has left is re-planned by another owner
 *     only where the chain has nothing at its address; a read that fails, or
 *     a Safe that is there, refuses;
 *   - a request is bound to the org and the member, and is used once; a
 *     passkey changed since the prepare is refused;
 *   - no Safe already another org's or a person's becomes this company's, and
 *     a person whose address is an org Safe cannot back another org with it;
 *   - the company refusals: fund, useMyAccount, a second EUR account, the
 *     wallet tier.
 *
 * Offline: the chain (prepare, submit) is a fake; passkeys are software keys.
 * Run: npm run org-safe-deploy:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-safe-deploy-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter, safeTakenBy } = await import("../services/api/src/routes/orgs.js");
const { createOrgSafeDeploymentRoutes } = await import("../services/api/src/routes/org-safe-deployment.js");
const { accountIsSpendable } = await import("../services/api/src/domain/accounts.js");
const { walletConnectable } = await import("../services/api/src/domain/wallet-tier.js");
const { BundlerRefusedError, SafeOperationUncertainError, orgSafeAccountFor, ownerAddressOfStored, passkeyAccountAddress, smartAccountForPasskey, webauthnOwnerFromJwk } =
  await import("../services/api/src/wallet/candide.js");
initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addUser = async (id: string, extra: object = {}, passkey = true) => {
  if (passkey) keys[id] = await makeSoftwarePasskey(id, ORIGIN);
  store.addUser({
    id, name: id, country: "DE", kycStatus: "pending", accountType: "company", address: `0x${id.padEnd(40, "0").replace(/[^0-9a-f]/g, "0").slice(0, 40)}`,
    ...(passkey ? { passkey: { credentialId: keys[id].credentialId, publicKey: { alg: "ES256", jwk: keys[id].jwk }, signCount: 0, rpId: "localhost", createdAt: now } } : {}),
    createdAt: now, ...extra,
  } as any);
};
const ownerKey = (id: string) => webauthnOwnerFromJwk(keys[id].jwk)!;
const addMember = (orgId: string, userId: string, role: string) =>
  store.addMember({ id: `m_${orgId}_${userId}`, orgId, userId, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
const addOrg = (id: string, extra: object) =>
  store.addOrganisation({ id, type: "business", name: id, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now, ...extra } as any, false);
const addEur = (id: string, orgId: string, extra: object = {}) =>
  store.addAccount({ id, orgId, currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, createdAt: now, updatedAt: now, ...extra } as any);

// ── the fake chain ──────────────────────────────────────────────────────────
type Outcome = "ok" | "refused" | "uncertain" | "reverted";
const chain = { deployed: new Set<string>(), outcome: "ok" as Outcome, prepares: 0, submits: 0, readFails: false };
const fakeChain = {
  prepare: async (plan: any) => {
    chain.prepares++;
    if (chain.deployed.has(plan.address.toLowerCase())) return { safeAddress: plan.address, challenge: "0x" as const, userOperation: {} as any };
    return { safeAddress: plan.address, challenge: `0x${"7a".repeat(32)}` as `0x${string}`, userOperation: { sender: plan.address } as any };
  },
  submit: async (plan: any) => {
    chain.submits++;
    if (chain.outcome === "refused") throw new BundlerRefusedError(Object.assign(new Error("AA21 didn't pay prefund"), { errno: -32500 }));
    if (chain.outcome !== "reverted") chain.deployed.add(plan.address.toLowerCase());
    if (chain.outcome === "uncertain") throw new SafeOperationUncertainError(`0x${"ee".repeat(32)}`, "timeout");
    return { userOpHash: `0x${"ab".repeat(32)}`, success: chain.outcome === "ok", gasPaidBy: "sponsored" as const };
  },
  isDeployed: async (address: string) => {
    if (chain.readFails) throw new Error("eth_getCode failed (503)");
    return chain.deployed.has(address.toLowerCase());
  },
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createOrgSafeDeploymentRoutes(requireSession as any, fakeChain as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const prepare = (orgId: string, user: string) => call("POST", `/api/orgs/${orgId}/safe/deployment`, user);
const submit = async (start: any, user: string, signer = user) => call("POST", start.submitTo, user, await keys[signer].assert(start.challenge));

// The owner's personal Safe is planned, never activated: the org Safe must
// not wait on it.
await addUser("anna", { passkeySafe: { status: "planned", address: "0x00000000000000000000000000000000000a11a0" } });
await addUser("adam");
await addUser("pia");
await addUser("olaf", {}, false);
await addUser("zed");

let orgId = "";
await check("a company signup's first org gets a gated EUR account with no address, and says the Safe is not set up", async () => {
  const r = await call("POST", "/api/orgs", "anna", { type: "business", entity: "company", name: "Acme GmbH", country: "DE" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  orgId = r.data.organisation.id;
  addMember(orgId, "adam", "admin");
  addMember(orgId, "pia", "payer");
  addMember(orgId, "olaf", "owner");
  const [a] = store.accountsOf(orgId);
  assert.equal(a.status, "gated");
  assert.equal(a.address, undefined);
  assert.equal(a.backingUserId, undefined);
  assert.match(a.gate!.reason, /Safe is not set up/);
  assert.match(accountIsSpendable(a, store.findOrganisation(orgId)!).reason!, /Safe is not set up yet/);
  assert.match(accountIsSpendable(a).reason!, /No IBAN/, "without the org, the old reason stands");
  const list = await call("GET", `/api/orgs/${orgId}/accounts`, "anna");
  assert.equal(list.data.adoption.allowed, false);
  assert.equal(list.data.adoption.code, "COMPANY_OWN_SAFE");
  assert.deepEqual(list.data.orgSafeDeploy, { allowed: true });
  assert.match(list.data.accounts[0].gate.reason, /Safe is not set up/);
  const forAdmin = await call("GET", `/api/orgs/${orgId}/accounts`, "adam");
  assert.equal(forAdmin.data.orgSafeDeploy.allowed, false);
  assert.equal(forAdmin.data.orgSafeDeploy.code, "NOT_A_SIGNER");
  assert.equal(forAdmin.data.orgSafeDeploy.reason, "Only an owner can set up the company’s Safe.");
  assert.match(list.data.accounts[0].gate.needs, /then the company’s IBAN on it \(Settings → Monerium\)/);
});

await check("only an owner whose passkey can sign deploys: admin, payer, passkey-less owner and non-member are refused", async () => {
  for (const [u, status, code] of [["adam", 403, "NOT_A_SIGNER"], ["pia", 403, "NOT_A_SIGNER"], ["olaf", 409, "NO_SIGNING_PASSKEY"]] as const) {
    const r = await prepare(orgId, u);
    assert.equal(r.status, status, `${u}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, code, u);
  }
  assert.equal((await prepare(orgId, "zed")).status, 404);
  assert.equal(chain.prepares, 0, "no refusal reaches the chain");
});

await check("a sole_trader and a personal org have no Safe of their own", async () => {
  addOrg("org_sole", { entity: "sole_trader" });
  addMember("org_sole", "anna", "owner");
  addEur("acc_sole", "org_sole");
  store.addOrganisation({ id: "org_me", type: "personal", name: "Me", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any, false);
  addMember("org_me", "anna", "owner");
  for (const id of ["org_sole", "org_me"]) {
    const r = await prepare(id, "anna");
    assert.equal(r.status, 409, id);
    assert.equal(r.data.code, "NOT_A_COMPANY", id);
  }
});

await check("the org Safe's address is neither the owner's personal Safe nor another org's", () => {
  const k = ownerKey("anna");
  const mine = smartAccountForPasskey(k).accountAddress.toLowerCase();
  const here = orgSafeAccountFor(k, orgId).accountAddress.toLowerCase();
  const there = orgSafeAccountFor(k, "org_other").accountAddress.toLowerCase();
  assert.notEqual(here, mine);
  assert.notEqual(here, there);
  assert.equal(orgSafeAccountFor(k, orgId).accountAddress.toLowerCase(), here, "deterministic");
});

await check("prepare writes nothing; a bundler refusal writes nothing", async () => {
  const start = await prepare(orgId, "anna");
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.equal(start.data.safeAddress.toLowerCase(), orgSafeAccountFor(ownerKey("anna"), orgId).accountAddress.toLowerCase());
  assert.equal(start.data.credentialId, keys.anna.credentialId);
  assert.equal(store.findOrganisation(orgId)!.safe, undefined);
  assert.equal(store.accountsOf(orgId)[0].address, undefined);
  chain.outcome = "refused";
  const r = await submit(start.data, "anna");
  assert.equal(r.status, 502, JSON.stringify(r.data));
  assert.equal(r.data.code, "BUNDLER_REFUSED");
  assert.equal(store.findOrganisation(orgId)!.safe, undefined);
  assert.equal(store.accountsOf(orgId)[0].address, undefined);
  assert.equal((await submit(start.data, "anna")).status, 404, "a request is used once");
});

await check("an unconfirmed submit keeps the plan planned; the retry finds the Safe and finishes it; a replay is a no-op", async () => {
  chain.outcome = "uncertain";
  const start = await prepare(orgId, "anna");
  const r = await submit(start.data, "anna");
  assert.equal(r.status, 502, JSON.stringify(r.data));
  assert.equal(r.data.code, "SAFE_OP_UNCONFIRMED");
  const org = store.findOrganisation(orgId)!;
  assert.equal(org.safe!.status, "planned");
  assert.equal(org.safe!.address, start.data.safeAddress);
  assert.equal(store.accountsOf(orgId)[0].address, undefined);
  const entity = await call("PATCH", `/api/orgs/${orgId}`, "anna", { entity: "sole_trader" });
  assert.equal(entity.data.code, "ENTITY_LOCKED", "a Safe that may have landed locks the entity");
  // Another owner cannot start a second Safe beside the planned one.
  await addUser("bert");
  addMember(orgId, "bert", "owner");
  const other = await prepare(orgId, "bert");
  assert.equal(other.data.code, "NOT_ON_CHAIN_OWNER", JSON.stringify(other.data));
  const retry = await prepare(orgId, "anna");
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.status, "active");
  const a = store.accountsOf(orgId)[0];
  assert.equal(a.address, start.data.safeAddress);
  assert.equal(a.status, "gated", "no IBAN yet");
  assert.equal(store.findOrganisation(orgId)!.safe!.status, "active");
  const annaRow = store.memberFor(orgId, "anna")!;
  assert.equal(annaRow.signerAddress!.toLowerCase(), passkeyAccountAddress(ownerKey("anna")).toLowerCase(), "the retry labels the deploying owner too");
  assert.doesNotMatch(accountIsSpendable(a, store.findOrganisation(orgId)!).reason!, /Safe is not set up/);
  const before = chain.prepares;
  const replay = await prepare(orgId, "anna");
  assert.equal(replay.status, 200);
  assert.equal(replay.data.status, "active");
  assert.equal(chain.prepares, before, "a deployed Safe is not prepared again");
  const list = await call("GET", `/api/orgs/${orgId}/accounts`, "anna");
  assert.equal(list.data.orgSafeDeploy.allowed, false);
  assert.match(list.data.accounts[0].gate.reason, /IBAN is not issued onto it yet/, "the IBAN is not shown as there");
  assert.doesNotMatch(list.data.accounts[0].gate.needs, /connect/i);
  assert.match(accountIsSpendable(a, store.findOrganisation(orgId)!).reason!, /not issued onto its Safe yet/);
});

await check("the happy path: sign, submit, plan active, address set, still gated", async () => {
  chain.outcome = "ok";
  addOrg("org_two", { entity: "company" });
  addMember("org_two", "anna", "owner");
  addMember("org_two", "bert", "owner");
  addEur("acc_two", "org_two");
  const start = await prepare("org_two", "anna");
  assert.equal(start.status, 201);
  // Bound to the member who prepared it, and to the org.
  assert.equal((await submit(start.data, "bert")).status, 404);
  assert.equal((await call("POST", `/api/orgs/${orgId}/safe/deployment/${start.data.requestId}`, "anna", await keys.anna.assert(start.data.challenge))).status, 404);
  const done = await submit(start.data, "anna");
  assert.equal(done.status, 201, JSON.stringify(done.data));
  const org = store.findOrganisation("org_two")!;
  assert.equal(org.safe!.status, "active");
  assert.equal(org.safe!.owners.length, 1);
  const signer = store.findMember("m_org_two_anna")!.signerAddress!;
  assert.equal(signer.toLowerCase(), passkeyAccountAddress(ownerKey("anna")).toLowerCase(), "the label is the address the Safe was deployed with");
  assert.equal(signer.toLowerCase(), ownerAddressOfStored(org.safe!.owners[0]).toLowerCase());
  assert.equal(store.findMember("m_org_two_bert")!.signerAddress, undefined, "only the deploying owner is labelled");
  const a = store.findAccount("acc_two")!;
  assert.equal(a.address, start.data.safeAddress);
  assert.equal(a.status, "gated");
  assert.notEqual(a.address!.toLowerCase(), store.accountsOf(orgId)[0].address!.toLowerCase());
});

await check("a passkey changed since the prepare is refused, and nothing is written", async () => {
  addOrg("org_three", { entity: "company" });
  addMember("org_three", "pia", "owner");
  addEur("acc_three", "org_three");
  const start = await prepare("org_three", "pia");
  assert.equal(start.status, 201);
  const fresh = await makeSoftwarePasskey("pia2", ORIGIN);
  store.updateUser("pia", { passkey: { credentialId: fresh.credentialId, publicKey: { alg: "ES256", jwk: fresh.jwk }, signCount: 0, rpId: "localhost", createdAt: now } } as any);
  const r = await call("POST", start.data.submitTo, "pia", await fresh.assert(start.data.challenge));
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "ORG_SAFE_CHANGED");
  assert.equal(store.findOrganisation("org_three")!.safe, undefined);
});

await check("a planned plan whose owner left is re-planned by another owner, only where the chain has nothing there", async () => {
  addOrg("org_orphan", { entity: "company" });
  await addUser("ilse");
  await addUser("jan");
  addMember("org_orphan", "ilse", "owner");
  addMember("org_orphan", "jan", "owner");
  addEur("acc_orphan", "org_orphan");
  chain.outcome = "uncertain";
  const first = await prepare("org_orphan", "ilse");
  assert.equal((await submit(first.data, "ilse")).data.code, "SAFE_OP_UNCONFIRMED");
  const old = store.findOrganisation("org_orphan")!.safe!.address;
  assert.equal((await prepare("org_orphan", "jan")).data.code, "NOT_ON_CHAIN_OWNER", "while ilse is an owner, her plan stands");
  store.updateMember("m_org_orphan_ilse", { status: "deactivated" });
  // The unconfirmed op did land: the Safe is there, with a passkey that left.
  const offer = await call("GET", "/api/orgs/org_orphan/accounts", "jan");
  assert.equal(offer.data.orgSafeDeploy.allowed, true);
  chain.readFails = true;
  const unread = await prepare("org_orphan", "jan");
  assert.equal(unread.status, 502, JSON.stringify(unread.data));
  assert.equal(store.findOrganisation("org_orphan")!.safe!.address, old, "a failed read changes nothing");
  chain.readFails = false;
  const landed = await prepare("org_orphan", "jan");
  assert.equal(landed.status, 409, JSON.stringify(landed.data));
  assert.equal(landed.data.code, "ORG_SAFE_OWNER_GONE");
  assert.equal(store.findOrganisation("org_orphan")!.safe!.address, old);
  // It did not land: jan re-plans at his own address and deploys.
  chain.deployed.delete(old.toLowerCase());
  chain.outcome = "ok";
  const start = await prepare("org_orphan", "jan");
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const mine = orgSafeAccountFor(ownerKey("jan"), "org_orphan").accountAddress.toLowerCase();
  assert.equal(start.data.safeAddress.toLowerCase(), mine);
  assert.notEqual(mine, old.toLowerCase());
  const replanned = store.auditFor("jan").filter((e) => e.kind === "org_safe.replanned");
  assert.deepEqual(replanned.map((e) => e.data), [{ orgId: "org_orphan", replaced: old, address: start.data.safeAddress }], "the re-plan is audited once, with both addresses");
  const done = await submit(start.data, "jan");
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(store.findOrganisation("org_orphan")!.safe!.status, "active");
  assert.equal(store.findAccount("acc_orphan")!.address!.toLowerCase(), mine);
  assert.throws(() => store.replaceUndeployedOrgSafePlan("org_orphan", mine, { ...store.findOrganisation("org_orphan")!.safe!, status: "planned" }), /no planned Safe/, "a deployed Safe is never re-planned");
});

await check("a bad assertion is refused before the chain", async () => {
  addOrg("org_four", { entity: "company" });
  addMember("org_four", "adam", "owner");
  addEur("acc_four", "org_four");
  const start = await prepare("org_four", "adam");
  const submits = chain.submits;
  const r = await call("POST", start.data.submitTo, "adam", await keys.adam.assert(Buffer.from("another challenge").toString("base64url")));
  assert.equal(r.status, 401, JSON.stringify(r.data));
  assert.equal(r.data.code, "BAD_ASSERTION");
  assert.equal(chain.submits, submits);
  assert.equal(store.findOrganisation("org_four")!.safe, undefined);
});

await check("no Safe already another org's or a person's becomes this company's", async () => {
  addOrg("org_five", { entity: "company" });
  addMember("org_five", "zed", "owner");
  addEur("acc_five", "org_five");
  const at = orgSafeAccountFor(ownerKey("zed"), "org_five").accountAddress;
  addEur("acc_squat", "org_sole", { address: at, currency: "EUR" });
  const r = await prepare("org_five", "zed");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "SAFE_IN_OTHER_ORG");
  assert.equal(store.findAccount("acc_five")!.address, undefined);
});

await check("a person whose address is an org Safe cannot back another org with it", () => {
  const safe = store.accountsOf(orgId)[0].address!;
  assert.deepEqual(safeTakenBy({ id: "u_nobody", address: safe }, "org_sole"), { id: orgId, name: "Acme GmbH" });
  assert.equal(safeTakenBy({ id: "u_nobody", address: safe }, orgId), undefined);
});

await check("a company is never funded from a member: fund, useMyAccount, a second EUR account, the wallet tier", async () => {
  const fund = await call("POST", `/api/orgs/org_two/accounts/acc_two/fund`, "anna");
  assert.equal(fund.status, 409);
  assert.equal(fund.data.code, "COMPANY_OWN_SAFE");
  const second = await call("POST", `/api/orgs/org_two/accounts`, "anna", { currency: "EUR" });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, "COMPANY_ONE_EUR_ACCOUNT");
  addOrg("org_six", { entity: "company" });
  addMember("org_six", "anna", "owner");
  const adopt = await call("POST", `/api/orgs/org_six/accounts`, "anna", { currency: "EUR", useMyAccount: true });
  assert.equal(adopt.status, 409);
  assert.equal(adopt.data.code, "COMPANY_OWN_SAFE");
  assert.equal(store.accountsOf("org_six").length, 0);
  const opened = await call("POST", `/api/orgs/org_six/accounts`, "anna", { currency: "EUR" });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  assert.equal(opened.data.account.address, undefined);
  assert.match(opened.data.account.gate.reason, /Safe is not set up/);
  const walletUser = { iban: undefined, passkeySafe: { status: "active" }, segment: { value: "WALLET_ONLY" }, kycStatus: "rejected" } as any;
  assert.equal(walletConnectable(walletUser, { type: "business", entity: "company" }), false);
  assert.equal(walletConnectable(walletUser, { type: "business", entity: "sole_trader" }), true);
});

server.close();
console.log(`\norg-safe-deploy: ${passed} passed`);
