/**
 * The org Safe plan (domain/org-safe-plan.ts, store.setOrgSafePlan,
 * wallet/candide.ts prepareSafeOperation).
 *
 * Covers:
 *   - round-trip: a company org's plan is stored on the Organisation, survives
 *     a reload from disk, and is addressed (its address is not derived);
 *   - only setOrgSafePlan writes it: not updateOrganisation, not for a
 *     personal or sole_trader org, not with a malformed shape (the zero
 *     address, no status), never to a different address once stored, and
 *     never back to planned once active; what is read or written is a copy;
 *   - a company org with no plan is refused by name, and the resolver takes no
 *     user, so there is no caller's Safe to fall back to;
 *   - the public org projection carries no plan;
 *   - the personal path still refuses at threshold 2, directly and through
 *     prepareSafeOperation, and takes no signer list;
 *   - the org path reads the threshold from the chain and skips the
 *     passkey-alone guard: a signer not on the plan or too few signers are
 *     refused before anything is built.
 *
 * Offline: the chain is a fake JSON-RPC that answers eth_getCode and
 * getThreshold and refuses everything else.
 * Run: npm run org-safe-plan:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

let threshold = 2;
const reads: string[] = [];
const rpc = express().use(express.json());
rpc.post("/", (req, res) => {
  const { id, method, params } = req.body ?? {};
  if (method === "eth_getCode") return res.json({ jsonrpc: "2.0", id, result: "0x6080" });
  // getThreshold()
  if (method === "eth_call" && String(params?.[0]?.data).startsWith("0xe75235b8")) {
    reads.push(String(params[0].to).toLowerCase());
    return res.json({ jsonrpc: "2.0", id, result: `0x${threshold.toString(16).padStart(64, "0")}` });
  }
  res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake chain: ${method} not served` } });
});
const server = rpc.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-safe-plan-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = RPC;
process.env.CANDIDE_RPC_URL = RPC;
process.env.CANDIDE_BUNDLER_URL = RPC;
process.env.CANDIDE_PAYMASTER_URL = RPC;

const { initStore, store } = await import("../services/api/src/store.js");
const { orgSafePlan, OrgSafePlanRefusal } = await import("../services/api/src/domain/org-safe-plan.js");
const { publicOrg } = await import("../services/api/src/routes/org-context.js");
const {
  SafeThresholdError,
  prepareSafeOperation,
  prepareTransferExecution,
  smartAccountForPasskey,
  transferExecutionTransactions,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} = await import("../services/api/src/wallet/candide.js");
const { SafeMultiChainSigAccountV1: SafeAccount } = await import("abstractionkit");
initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const owner = async (label: string) => webauthnOwnerFromJwk((await makeSoftwarePasskey(label, ORIGIN)).jwk)!;
const anna = await owner("anna");
const bert = await owner("bert");
const cara = await owner("cara");
const ORG_SAFE = "0x5AFE5afe5afe5afe5afe5afe5afe5afe5afe5aFe" as const;
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;
const txs = transferExecutionTransactions(TOKEN, PAYEE, 1n);

const addOrg = (id: string, extra: object) =>
  store.addOrganisation({
    id, type: "business", name: id, reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" },
    verifications: {}, createdAt: now, updatedAt: now, ...extra,
  } as any, false);
addOrg("org_co", { entity: "company" });
addOrg("org_bare", { entity: "company" });
addOrg("org_sole", { entity: "sole_trader" });
addOrg("org_legacy", {});
store.addOrganisation({ id: "org_me", type: "personal", name: "Me", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any, false);

const plan = { kind: "org" as const, status: "planned" as const, address: ORG_SAFE, owners: [webauthnOwnerToStore(anna), webauthnOwnerToStore(bert)], createdAt: now };

await check("a company org's plan round-trips through the store and a reload from disk", () => {
  store.setOrgSafePlan("org_co", plan);
  initStore();
  const org = store.findOrganisation("org_co")!;
  assert.deepEqual(org.safe, plan);
  const read = orgSafePlan(org);
  assert.equal(read.address, ORG_SAFE);
  assert.deepEqual(read.owners, plan.owners);
  assert.equal(new SafeAccount(read.address).accountAddress, ORG_SAFE, "addressed, not derived");
  for (const o of [anna, bert]) {
    assert.notEqual(smartAccountForPasskey(o).accountAddress.toLowerCase(), ORG_SAFE.toLowerCase());
  }
});

await check("the owner list may change; the address never does", () => {
  const next = { ...plan, owners: [...plan.owners, webauthnOwnerToStore(cara)], createdAt: new Date(0).toISOString() };
  store.setOrgSafePlan("org_co", next);
  const org = store.findOrganisation("org_co")!;
  assert.equal(org.safe!.owners.length, 3);
  assert.equal(org.safe!.createdAt, now, "the first createdAt stays");
  assert.throws(() => store.setOrgSafePlan("org_co", { ...plan, address: "0x9999999999999999999999999999999999999999" }), /already has its Safe/);
  assert.equal(store.findOrganisation("org_co")!.safe!.address, ORG_SAFE);
});

await check("a deployed plan never goes back to planned", () => {
  store.setOrgSafePlan("org_co", { ...plan, owners: store.findOrganisation("org_co")!.safe!.owners, status: "active" });
  assert.throws(() => store.setOrgSafePlan("org_co", { ...plan, status: "planned" }), /cannot go back to planned/);
  assert.equal(store.findOrganisation("org_co")!.safe!.status, "active");
});

await check("the plan read and the plan written are copies, never the stored row", () => {
  const read = orgSafePlan(store.findOrganisation("org_co")!);
  read.owners.push({ x: "0x00", y: "0x00" });
  read.owners[0].x = "0x00";
  const stored = store.findOrganisation("org_co")!.safe!;
  assert.notEqual(stored.owners[0].x, "0x00");
  assert.ok(stored.owners.every((o) => o.x !== "0x00"));
  const given = { ...plan, owners: plan.owners.map((o) => ({ ...o })), status: "active" as const };
  store.setOrgSafePlan("org_co", given);
  given.owners[0].x = "0x00";
  assert.notEqual(store.findOrganisation("org_co")!.safe!.owners[0].x, "0x00");
});

await check("only setOrgSafePlan writes a plan, and only for a company", () => {
  assert.throws(() => store.updateOrganisation("org_bare", { safe: plan }), /setOrgSafePlan only/);
  for (const id of ["org_sole", "org_legacy", "org_me"]) {
    assert.throws(() => store.setOrgSafePlan(id, plan), /not a company/, id);
    assert.equal(store.findOrganisation(id)!.safe, undefined, id);
  }
});

await check("a malformed plan is refused, not repaired", () => {
  const bad = [
    { ...plan, kind: "personal" },
    { ...plan, address: "0x5afe" },
    { ...plan, address: "0x0000000000000000000000000000000000000000" },
    { ...plan, status: undefined },
    { ...plan, status: "deployed" },
    { ...plan, owners: [] },
    { ...plan, owners: [plan.owners[0], { ...plan.owners[0], x: plan.owners[0].x.toUpperCase().replace("0X", "0x") }] },
    { ...plan, owners: [{ x: "0x01", y: plan.owners[0].y }] },
    { ...plan, createdAt: "yesterday" },
  ];
  for (const b of bad) assert.throws(() => store.setOrgSafePlan("org_bare", b as any), /not a valid org Safe plan/, JSON.stringify(b).slice(0, 80));
  assert.equal(store.findOrganisation("org_bare")!.safe, undefined);
});

await check("a company org with no plan is refused by name; no caller's Safe to fall back to", () => {
  assert.equal(orgSafePlan.length, 1, "the resolver takes the org alone, never a user");
  const refusal = (org: any) => { try { orgSafePlan(org); } catch (e) { return e; } assert.fail("expected a refusal"); };
  const missing = refusal(store.findOrganisation("org_bare")) as InstanceType<typeof OrgSafePlanRefusal>;
  assert.ok(missing instanceof OrgSafePlanRefusal);
  assert.equal(missing.code, "ORG_SAFE_MISSING");
  assert.equal(missing.status, 409);
  for (const id of ["org_sole", "org_legacy", "org_me"]) {
    assert.equal((refusal(store.findOrganisation(id)) as any).code, "NOT_A_COMPANY", id);
  }
  const unreadable = refusal({ type: "business", entity: "company", safe: { ...plan, owners: [] } });
  assert.equal((unreadable as any).code, "ORG_SAFE_UNREADABLE");
});

await check("the public org projection carries no plan", () => {
  const view = publicOrg(store.findOrganisation("org_co")!);
  assert.ok(!("safe" in view));
  assert.ok(!JSON.stringify(view).toLowerCase().includes(ORG_SAFE.toLowerCase().slice(2)));
});

const personal = {
  address: smartAccountForPasskey(anna).accountAddress as `0x${string}`,
  threshold: 1 as const,
  passkeyPublicKey: webauthnOwnerToStore(anna),
};

await check("personal still refuses at threshold 2", async () => {
  threshold = 2;
  await assert.rejects(prepareTransferExecution(personal, TOKEN, PAYEE, 1n), (e: unknown) =>
    e instanceof SafeThresholdError && /needs 2 signatures and Zold can collect only your passkey/.test(e.message));
  await assert.rejects(prepareSafeOperation(personal, txs), (e: unknown) =>
    e instanceof SafeThresholdError && /only your passkey/.test(e.message));
  await assert.rejects(prepareSafeOperation({ ...personal, kind: "personal" }, txs), SafeThresholdError);
  await assert.rejects(prepareSafeOperation(personal, txs, [anna]), /takes no signer list/);
});

await check("the org path reads the chain's threshold and refuses too few or foreign signers", async () => {
  const stored = orgSafePlan(store.findOrganisation("org_co")!);
  threshold = 2;
  reads.length = 0;
  await assert.rejects(prepareSafeOperation(stored, txs, []), /must be an owner/);
  await assert.rejects(prepareSafeOperation({ ...stored, owners: [webauthnOwnerToStore(anna)] }, txs, [anna, bert]), /must be an owner/);
  assert.equal(reads.length, 0, "refused before the chain is asked");
  await assert.rejects(prepareSafeOperation(stored, txs, [anna]), (e: unknown) =>
    e instanceof SafeThresholdError && /needs 2 owner signatures and 1 were named/.test(e.message));
  assert.deepEqual(reads, [ORG_SAFE.toLowerCase()], "the threshold is the chain's, read at the plan's address");
  // At the threshold, the passkey-alone guard is not in the way: what fails
  // next is building the op, which this fake chain does not serve.
  await assert.rejects(prepareSafeOperation(stored, txs, [anna, bert]), (e: unknown) =>
    !(e instanceof SafeThresholdError) && !/only your passkey/.test(String((e as Error).message)));
});

server.close();
console.log(`\norg-safe-plan: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
