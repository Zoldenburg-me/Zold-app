/**
 * Zoldenburg as the recovery guardian of a company's own Safe, through the
 * org Safe queue, unarmed (wallet/org-recovery.ts, routes/business/org-recovery.ts).
 *
 * Covers:
 *   - GET /orgs/:orgId/recovery answers every member from the module read by
 *     the Safe's address: before deployment, no module, the guardian on
 *     chain; armed is always false; a failed read is 502, never "none";
 *     a personal or sole-trader org is NOT_A_COMPANY;
 *   - only an owner queues the setup; it is one op of kind
 *     "recovery-guardian" whose two transactions enable the module and add
 *     Zoldenburg at threshold 1, prepared for the chain's owners;
 *   - a second setup while one is open, or with the guardian on chain,
 *     queues nothing;
 *   - below the Safe's threshold nothing relays; Organisation.recovery is
 *     written only once the op executed and the chain lists the guardian;
 *   - a guardian Zold did not add is flagged on the read and refuses the
 *     setup; a pending recovery refuses it; queue off and no guardian
 *     configured refuse before anything is built;
 *   - the same rules are re-read before each owner's signature: another
 *     guardian, a pending recovery, the guardian already on chain or no
 *     longer offered end the op unsigned and unrelayed; a failed read
 *     refuses that signature only;
 *   - an unarmed guardian cannot be made to sign: /admin/recoveries refuses
 *     a request naming the company's Safe (NOT_ARMED).
 *
 * Offline: the module read, the Safe's owners and threshold, the prepared
 * operation and the relay are fakes; passkeys are software keys.
 * Run: npm run org-recovery:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";
import { companyOrg, businessOrg, member } from "./_org-fixtures.js";

const GUARDIAN = "0x6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a";
const FOREIGN = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-recovery-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";
process.env.ORG_SAFE_QUEUE_ENABLED = "1";
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = GUARDIAN;

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createSafeOpRoutes, opSignRefusal } = await import("../services/api/src/routes/business/safe-ops.js");
const { createOrgRecoveryRoutes } = await import("../services/api/src/routes/business/org-recovery.js");
const { createZoldenburgRecoveryRouter } = await import("../services/api/src/routes/recovery-zoldenburg.js");
const { setOperator } = await import("../services/api/src/operators/principal.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { CANDIDE, safeOperationDigest } = await import("../services/api/src/wallet/candide.js");
await initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

// ── a company with two owners, an admin, a payer and a viewer ───────────────
const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const SAFE2 = "0x5afe00000000000000000000000000000000beef" as const;
const MODULE = (CANDIDE.recoveryModuleAddress as string).toLowerCase();
const hex = (b64: string) => ("0x" + Buffer.from(b64, "base64url").toString("hex")) as `0x${string}`;
const people = ["anna", "bert", "admin", "payer", "viewer"] as const;
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
for (const p of people) {
  keys[p] = await makeSoftwarePasskey(p, ORIGIN);
  addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  await store.addUser({
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved", address: `0x${randomBytes(20).toString("hex")}`,
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
}
const roleOf = (p: string) => (p === "anna" || p === "bert" ? "owner" : p);
const planOwners = [keys.anna, keys.bert].map((k) => ({ x: hex(k.jwk.x!), y: hex(k.jwk.y!) }));
// org_1: deployed, no IBAN yet (gated). org_2: deployed, a foreign guardian
// on its module. org_3: planned only. org_4: a sole trader.
for (const [id, safe] of [["org_1", SAFE], ["org_2", SAFE2]] as const) {
  await store.addOrganisation(companyOrg(id, `${id} GmbH`));
  for (const p of people) await store.addMember({ ...member(`m_${id}_${p}`, id, `u_${p}`, roleOf(p) as any), ...(p === "anna" ? { signerAddress: addr.anna } : {}) });
  await store.setOrgSafePlan(id, { kind: "org", status: "active", address: safe, owners: planOwners, createdAt: now } as any);
  await store.addAccount({ id: `acc_${id}`, orgId: id, currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, address: safe, createdAt: now, updatedAt: now } as any);
}
await store.addOrganisation(companyOrg("org_3", "Later GmbH"));
await store.addMember(member("m_org_3_anna", "org_3", "u_anna", "owner"));
await store.setOrgSafePlan("org_3", { kind: "org", status: "planned", address: "0x5afe0000000000000000000000000000000000c3", owners: planOwners.slice(0, 1), createdAt: now } as any);
await store.addOrganisation(businessOrg("org_4", "Solo", { entity: "sole_trader" }));
await store.addMember(member("m_org_4_anna", "org_4", "u_anna", "owner"));

// ── the fake chain ──────────────────────────────────────────────────────────
type ModuleState = { moduleEnabled: boolean; guardians: `0x${string}`[]; pending: any };
const modules: Record<string, ModuleState> = {};
const fresh = (): ModuleState => ({ moduleEnabled: false, guardians: [], pending: null });
let readFails = false;
const recoveryChain = {
  read: async (safe: `0x${string}`) => {
    if (readFails) throw new Error("rpc down");
    const m = modules[safe.toLowerCase()] ?? fresh();
    return { moduleAddress: MODULE as `0x${string}`, moduleEnabled: m.moduleEnabled, guardians: [...m.guardians], threshold: m.guardians.length ? 1 : 0, pending: m.pending };
  },
  assertModuleDeployed: async () => {},
};
const safeChain = { owners: [addr.anna, addr.bert] as `0x${string}`[], threshold: 2, nonce: 0n, relays: [] as string[][] };
const opChain = {
  read: async () => ({ owners: [...safeChain.owners], threshold: safeChain.threshold, nonce: safeChain.nonce }),
  relay: async (op: any, sigs: any[]) => {
    safeChain.relays.push(sigs.map((s) => s.memberId));
    // What the op did on chain: the module enabled, the guardian added.
    modules[op.safeAddress.toLowerCase()] = { moduleEnabled: true, guardians: [GUARDIAN], pending: null };
    return { userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, success: true, gasPaidBy: "sponsored" } as any;
  },
};
// The callData carries the batched txs' data, as a Safe executeBatch does;
// bareCallData leaves it out, so nothing in the op names the guardian.
let bareCallData = false;
const prepares: { txs: { to: string; data: string; value: bigint }[]; signers: string[] }[] = [];
const prepare = async (plan: any, txs: any[], signers: any[]) => {
  prepares.push({ txs, signers: signers.map((s) => `${s.x}:${s.y}`) });
  const userOperation: any = {
    sender: plan.address, nonce: safeChain.nonce, factory: null, factoryData: null, callData: `0x${randomBytes(8).toString("hex")}${bareCallData ? "" : txs.map((t) => t.data.slice(2)).join("")}`, callGasLimit: 1n,
    verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymaster: null,
    paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null, signature: "0x",
  };
  return { challenge: safeOperationDigest(plan.address, userOperation), userOperation, nonce: safeChain.nonce } as any;
};
const keyOf = (p: string) => `${BigInt(hex(keys[p].jwk.x!))}:${BigInt(hex(keys[p].jwk.y!))}`;

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
const deps = { ctxOf: async (req: any, res: any) => await resolveOrg(req, res, requireSession as any) };
app.use((req: any, _res, next) => { if (req.header("x-operator")) setOperator(req, { id: "op1", name: "Operator", sessionId: "s1" }); next(); });
app.use("/api/orgs", createOrgRecoveryRoutes(deps, { chain: recoveryChain, orgSafeReader: opChain, prepare }));
app.use("/api/orgs", createSafeOpRoutes(deps, opChain as any, opSignRefusal(recoveryChain)));
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession: async (req, res, userId) => (who(req) === userId ? { id: "s" } : (res.status(403).json({ error: "not yours" }), undefined)) }));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const challengeOf = (op: { digest: string }) => Buffer.from(op.digest.slice(2), "hex").toString("base64url");
const sign = async (p: string, opId: string, org = "org_1") => call("POST", `/orgs/${org}/safe-ops/${opId}/signatures`, `u_${p}`, await keys[p].assert(challengeOf((await store.findSafeOp(opId))!)));
const setup = (p: string, org = "org_1") => call("POST", `/orgs/${org}/recovery/guardian`, `u_${p}`);
const read = (p: string, org = "org_1") => call("GET", `/orgs/${org}/recovery`, `u_${p}`);
const strip = (a: string) => a.toLowerCase().replace(/^0x/, "");

try {
  await check("every member reads the company's recovery from chain; nothing is on the Safe yet", async () => {
    const r = await read("viewer");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.state, "set_up");
    assert.equal(r.data.available, true);
    assert.equal(r.data.guardian.toLowerCase(), GUARDIAN);
    assert.equal(r.data.moduleEnabled, false);
    assert.deepEqual(r.data.guardians, []);
    assert.equal(r.data.guardianOnChain, false);
    assert.equal(r.data.pendingRecovery, null);
    assert.equal(r.data.armed, false);
    assert.equal(r.data.setupOp, null);
    assert.equal(r.data.queueOpen, true, "the card offers the setup only where the queue would take it");
  });

  await check("before deployment it is not_set_up; a sole trader's is NOT_A_COMPANY; a failed read is 502, never none", async () => {
    assert.equal((await read("anna", "org_3")).data.state, "not_set_up");
    const solo = await read("anna", "org_4");
    assert.equal(solo.status, 409);
    assert.equal(solo.data.code, "NOT_A_COMPANY");
    readFails = true;
    const r = await read("viewer");
    readFails = false;
    assert.equal(r.status, 502);
    assert.equal(r.data.code, "RECOVERY_UNREADABLE");
    assert.equal(r.data.guardians, undefined, "no guardian list is made up");
  });

  await check("only an owner queues the setup; the others are refused with nothing prepared", async () => {
    for (const p of ["admin", "payer", "viewer"]) {
      const r = await setup(p);
      assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.data)}`);
    }
    assert.equal(prepares.length, 0);
    assert.equal((await store.safeOpsOf("org_1")).length, 0);
  });

  let opId = "";
  await check("an owner queues one recovery-guardian op: enable the module, add Zoldenburg at threshold 1", async () => {
    const r = await setup("anna");
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.op.kind, "recovery-guardian");
    assert.equal(r.data.op.state, "PENDING");
    assert.equal(r.data.op.signatures.length, 0, "nobody's signature comes with it");
    opId = r.data.op.id;
    const [p] = prepares;
    assert.deepEqual(p.signers.sort(), [keyOf("anna"), keyOf("bert")].sort(), "prepared for the chain's owners at its threshold");
    assert.equal(p.txs.length, 2);
    assert.equal(p.txs[0].to.toLowerCase(), SAFE, "the Safe enables the module on itself");
    assert.ok(p.txs[0].data.toLowerCase().includes(strip(MODULE)), "enableModule names the recovery module");
    assert.equal(p.txs[1].to.toLowerCase(), MODULE, "the guardian is added on the module");
    assert.ok(p.txs[1].data.toLowerCase().includes(strip(GUARDIAN)), "addGuardianWithThreshold names Zoldenburg's guardian");
    assert.ok(p.txs[1].data.toLowerCase().endsWith("1".padStart(64, "0")), "at threshold 1");
    assert.ok(p.txs.every((t) => BigInt(t.value) === 0n), "no value moves");
    assert.equal((await store.findOrganisation("org_1"))!.recovery, undefined, "nothing recorded while queued");
    assert.equal((await read("viewer")).data.setupOp.id, opId, "the read shows the queued op");
  });

  await check("a second setup while one is open queues nothing", async () => {
    const r = await setup("bert");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.op.id, opId);
    assert.equal(prepares.length, 1);
    assert.equal((await store.safeOpsOf("org_1")).length, 1);
  });

  await check("below the threshold nothing relays; a non-owner cannot sign", async () => {
    const payer = await sign("payer", opId);
    assert.equal(payer.status, 403, JSON.stringify(payer.data));
    const a = await sign("anna", opId);
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.equal(a.data.op.state, "PENDING");
    assert.equal(safeChain.relays.length, 0);
    assert.equal((await read("viewer")).data.guardianOnChain, false);
    assert.equal((await store.findOrganisation("org_1"))!.recovery, undefined);
  });

  await check("at the threshold it relays; the read shows the guardian, unarmed, and records it", async () => {
    const b = await sign("bert", opId);
    assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.equal(b.data.op.state, "EXECUTED");
    assert.equal(safeChain.relays.length, 1);
    safeChain.nonce = 1n;
    const r = await read("viewer");
    assert.equal(r.data.moduleEnabled, true);
    assert.equal(r.data.guardianOnChain, true);
    assert.deepEqual(r.data.otherGuardians, []);
    assert.equal(r.data.armed, false, "armed needs the company's IBAN (10b)");
    assert.equal(r.data.setupOp, null);
    const rec = (await store.findOrganisation("org_1"))!.recovery!;
    assert.equal(rec.guardianAddress.toLowerCase(), GUARDIAN);
    assert.equal(rec.addedAt, (await store.findSafeOp(opId))!.updatedAt);
    assert.equal(r.data.addedAt, rec.addedAt);
  });

  await check("with the guardian on chain a setup queues nothing", async () => {
    const r = await setup("anna");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.op, null);
    assert.equal(prepares.length, 1);
  });

  await check("a guardian Zold did not add is flagged on the read and refuses the setup", async () => {
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [FOREIGN], pending: null };
    const r = await read("viewer", "org_2");
    assert.deepEqual(r.data.otherGuardians.map((a: string) => a.toLowerCase()), [FOREIGN]);
    assert.equal(r.data.guardianOnChain, false);
    const s = await setup("anna", "org_2");
    assert.equal(s.status, 409, JSON.stringify(s.data));
    assert.equal(s.data.code, "OTHER_GUARDIAN");
    assert.equal(prepares.length, 1);
    // Beside ours, it is still flagged.
    modules[SAFE.toLowerCase()].guardians = [GUARDIAN, FOREIGN];
    assert.deepEqual((await read("viewer")).data.otherGuardians.map((a: string) => a.toLowerCase()), [FOREIGN]);
    modules[SAFE.toLowerCase()].guardians = [GUARDIAN];
  });

  await check("a pending recovery, the queue off, or no guardian configured refuse before anything is built", async () => {
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [], pending: { newOwners: [addr.anna], newThreshold: 1, executeAfter: 99 } };
    const p = await setup("anna", "org_2");
    assert.equal(p.data.code, "RECOVERY_PENDING");
    assert.ok((await read("viewer", "org_2")).data.pendingRecovery, "the read shows it");
    modules[SAFE2.toLowerCase()] = fresh();
    process.env.ORG_SAFE_QUEUE_ENABLED = "";
    const off = await setup("anna", "org_2");
    process.env.ORG_SAFE_QUEUE_ENABLED = "1";
    assert.equal(off.data.code, "ORG_SAFE_QUEUE_OFF");
    const g = (CANDIDE as any).recoveryGuardianAddress;
    (CANDIDE as any).recoveryGuardianAddress = "";
    const none = await setup("anna", "org_2");
    const noneRead = await read("viewer", "org_2");
    (CANDIDE as any).recoveryGuardianAddress = g;
    assert.equal(none.status, 503);
    assert.equal(none.data.code, "RECOVERY_UNAVAILABLE");
    assert.equal(noneRead.data.available, false);
    assert.equal(prepares.length, 1);
    assert.equal((await store.safeOpsOf("org_2")).length, 0);
  });

  await check("before a signature the module is read again: a failed read refuses, a changed module ends the op", async () => {
    const relays = safeChain.relays.length;
    const queue = async () => {
      const q = await setup("anna", "org_2");
      assert.equal(q.status, 201, JSON.stringify(q.data));
      return q.data.op.id as string;
    };
    const refusedAndEnded = async (id: string, code: string) => {
      const r = await sign("anna", id, "org_2");
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, code);
      const op = (await store.findSafeOp(id))!;
      assert.equal(op.state, "INVALIDATED", code);
      assert.equal(op.signatures.length, 0, "no signature is taken");
    };

    let id = await queue();
    readFails = true;
    const down = await sign("anna", id, "org_2");
    readFails = false;
    assert.equal(down.status, 502, JSON.stringify(down.data));
    assert.equal(down.data.code, "RECOVERY_UNREADABLE");
    assert.equal((await store.findSafeOp(id))!.state, "PENDING", "a failed read refuses this signature only");
    assert.equal((await store.findSafeOp(id))!.signatures.length, 0);

    // An owner adds their own guardian in Safe{Wallet} while the op waits.
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [FOREIGN], pending: null };
    await refusedAndEnded(id, "OTHER_GUARDIAN");

    modules[SAFE2.toLowerCase()] = fresh();
    id = await queue();
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [], pending: { newOwners: [addr.anna], newThreshold: 1, executeAfter: 99 } };
    await refusedAndEnded(id, "RECOVERY_PENDING");

    modules[SAFE2.toLowerCase()] = fresh();
    id = await queue();
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [GUARDIAN], pending: null };
    await refusedAndEnded(id, "ALREADY_GUARDIAN");

    modules[SAFE2.toLowerCase()] = fresh();
    id = await queue();
    const g = (CANDIDE as any).recoveryGuardianAddress;
    (CANDIDE as any).recoveryGuardianAddress = FOREIGN;
    try { await refusedAndEnded(id, "RECOVERY_UNAVAILABLE"); }
    finally { (CANDIDE as any).recoveryGuardianAddress = g; }

    // The last owner's signature is the one that relays: it is re-checked too.
    id = await queue();
    assert.equal((await sign("anna", id, "org_2")).status, 201);
    modules[SAFE2.toLowerCase()] = { moduleEnabled: true, guardians: [FOREIGN], pending: null };
    const last = await sign("bert", id, "org_2");
    assert.equal(last.data.code, "OTHER_GUARDIAN");
    assert.equal((await store.findSafeOp(id))!.state, "INVALIDATED");
    assert.equal(safeChain.relays.length, relays, "nothing relayed");
    modules[SAFE2.toLowerCase()] = fresh();
  });

  await check("the guardian is matched by the field stored on the op; an op without it falls back to its UserOperation", async () => {
    const queue = async (bare: boolean) => {
      modules[SAFE2.toLowerCase()] = fresh();
      bareCallData = bare;
      try {
        const q = await setup("anna", "org_2");
        assert.equal(q.status, 201, JSON.stringify(q.data));
        return q.data.op.id as string;
      } finally { bareCallData = false; }
    };
    const end = async (id: string) => await store.endPendingSafeOp(id, { state: "CANCELLED", reason: "test" });
    const refused = async (id: string) => {
      const r = await sign("anna", id, "org_2");
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, "RECOVERY_UNAVAILABLE");
      assert.equal((await store.findSafeOp(id))!.state, "INVALIDATED");
      assert.equal((await store.findSafeOp(id))!.signatures.length, 0, "no signature is taken");
    };

    // The UserOperation does not name the guardian; the stored field does.
    let id = await queue(true);
    let op = (await store.findSafeOp(id))!;
    assert.equal(op.guardianAddress?.toLowerCase(), GUARDIAN, "the guardian is stored on the op");
    assert.ok(!op.userOperation.toLowerCase().includes(strip(GUARDIAN)), "the op itself does not name it");
    assert.equal((await sign("anna", id, "org_2")).status, 201, "the stored field matches the deployment's guardian");
    await end(id);

    // The UserOperation names the guardian, but the stored field is another one.
    id = await queue(false);
    op = (await store.findSafeOp(id))!;
    assert.ok(op.userOperation.toLowerCase().includes(strip(GUARDIAN)));
    op.guardianAddress = FOREIGN;
    await refused(id);

    // An op queued before the field existed: the substring check decides.
    id = await queue(false);
    delete (await store.findSafeOp(id))!.guardianAddress;
    assert.equal((await sign("anna", id, "org_2")).status, 201, "a legacy op that names the guardian may be signed");
    await end(id);
    id = await queue(true);
    delete (await store.findSafeOp(id))!.guardianAddress;
    await refused(id);
    modules[SAFE2.toLowerCase()] = fresh();
  });

  await check("the unarmed guardian cannot be made to sign: /admin/recoveries refuses the company's Safe", async () => {
    await store.addRecoveryRequest({
      id: "rr_org", userId: "u_anna", safeAddress: SAFE, mode: "zoldenburg", status: "REVIEW_PENDING",
      requestedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), recoveryDelayHours: 72,
      guardianAddress: GUARDIAN, recoveryModuleAddress: MODULE,
      zoldenburg: { reference: "ZR-ORG", newOwners: [addr.bert], newThreshold: 1 },
    } as any);
    const r = await call("POST", "/admin/recoveries/rr_org/sign-request", "", {}, { "x-operator": "1" });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, "NOT_ARMED");
    assert.equal(r.data.typedData, undefined, "nothing to sign is handed out");
  });
} finally {
  server.close();
}

console.log(process.exitCode ? "org recovery: FAILED" : `org recovery: ok (${passed} checks)`);
