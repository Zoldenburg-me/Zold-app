/**
 * The permission split (design note §2.2, Q1): role × entity × action, for
 * the server table (domain/roles.ts) and the client one
 * (public/business/role-table.js), so the client cannot drift.
 *
 * Pins: on a company org payers, admins and owners queue and only owners
 * sign; a personal or sole_trader org keeps one step (the payer's own Safe
 * pays); an accountant drafts and never queues; signing on a company also
 * needs the passkey on chain (signerRefusal), and an AI-agent payer never
 * signs; the routes read the same table (draft execute is the queue gate,
 * /transfers/:id/authorize refuses a company's Safe).
 *
 * Offline. Run: npm run role-table:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { forEachSeq } from "../services/api/src/seq.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-role-table-")), "db.json");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ROLE_PERMISSIONS, roleCan } = await import("../services/api/src/domain/roles.js");
const { canQueueSafeOp, signerRefusal } = await import("../services/api/src/domain/safe-op-queue.js");
const client: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/role-table.js")).href);

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log(`  ok  ${name}`); };

type Role = keyof typeof ROLE_PERMISSIONS;
const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
const ENTITIES = [undefined, "sole_trader", "company"] as const;
const name = (e: (typeof ENTITIES)[number]) => e ?? "personal";

// The table, written out once. [queue, sign].
const EXPECTED: Record<string, Record<Role, [boolean, boolean]>> = {
  personal: { owner: [true, true], admin: [true, true], payer: [true, true], accountant: [false, false], viewer: [false, false] },
  sole_trader: { owner: [true, true], admin: [true, true], payer: [true, true], accountant: [false, false], viewer: [false, false] },
  company: { owner: [true, true], admin: [true, false], payer: [true, false], accountant: [false, false], viewer: [false, false] },
};

// Each client key is the server permissions it stands for (role-table.js).
const KEYS: Record<string, string[]> = {
  propose: ["drafts.create"],
  approve: ["drafts.review"],
  queue: ["transfers.queue"],
  sign: ["transfers.sign"],
  categorise: ["ledger.categorise", "coa.manage", "reports.run"],
  invoices: ["invoices.manage"],
  contacts: ["contacts.manage"],
  wallets: ["wallets.manage"],
  members: ["members.invite", "members.update"],
  accounts: ["accounts.open"],
};

await t("queue and sign, role × entity, on the server and the client", () => {
  for (const e of ENTITIES) {
    for (const role of ROLES) {
      const [queue, sign] = EXPECTED[name(e)][role];
      assert.equal(roleCan(role, "transfers.queue", e), queue, `server ${name(e)} ${role} queue`);
      assert.equal(roleCan(role, "transfers.sign", e), sign, `server ${name(e)} ${role} sign`);
      const c = client.roleTableFor(e)[role] ?? {};
      assert.equal(!!c.queue, queue, `client ${name(e)} ${role} queue`);
      assert.equal(!!c.sign, sign, `client ${name(e)} ${role} sign`);
    }
  }
});

await t("every other client key agrees with the server, for every entity", () => {
  for (const e of ENTITIES) {
    for (const role of ROLES) {
      const c = client.roleTableFor(e)[role] ?? {};
      for (const [key, perms] of Object.entries(KEYS)) {
        assert.equal(!!c[key], perms.every((p) => roleCan(role, p as any, e)), `${name(e)} ${role} ${key}`);
      }
      for (const key of Object.keys(c)) assert.ok(key in KEYS, `client key ${key} has a server permission`);
    }
  }
});

await t("the entity changes signing only: every other permission is the same table", () => {
  for (const role of ROLES) {
    for (const p of ROLE_PERMISSIONS.owner) {
      if (p === "transfers.sign") continue;
      assert.equal(roleCan(role, p, "company"), roleCan(role, p), `${role} ${p}`);
    }
  }
});

const OWNER_A = "0x00000000000000000000000000000000000000a1" as const;
const OWNER_B = "0x00000000000000000000000000000000000000b2" as const;
await t("company signing: role first, then a passkey, then the chain; the AI-agent payer never signs", () => {
  const active = (role: Role) => ({ role, status: "active" as const });
  // A payer with a key the Safe lists is still not a signer: the role decides first.
  for (const role of ["payer", "admin", "accountant", "viewer"] as Role[]) {
    assert.equal(signerRefusal(active(role), OWNER_A, [OWNER_A])?.code, "NOT_A_SIGNER", role);
  }
  // The AI agent: a payer with no passkey. Refused as a payer, never reaching a session check.
  assert.equal(signerRefusal(active("payer"), null, [OWNER_A])?.code, "NOT_A_SIGNER");
  assert.equal(signerRefusal(active("owner"), null, [OWNER_A])?.code, "NO_SIGNING_PASSKEY");
  assert.equal(signerRefusal(active("owner"), OWNER_B, [OWNER_A])?.code, "NOT_ON_CHAIN_OWNER");
  assert.equal(signerRefusal({ role: "owner", status: "deactivated" }, OWNER_A, [OWNER_A])?.code, "NOT_A_SIGNER");
  assert.equal(signerRefusal(active("owner"), OWNER_A, [OWNER_A]), undefined);
  assert.deepEqual(ROLES.filter(canQueueSafeOp).sort(), ["admin", "owner", "payer"], "an accountant drafts; it does not queue");
});

// ── The routes read the same table ─────────────────────────────────────────
const { initStore, store } = await import("../services/api/src/store.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
await initStore();

const now = new Date().toISOString();
const CO_SAFE = "0x00000000000000000000000000000000000000c0";
const ST_SAFE = "0x00000000000000000000000000000000000000c1";
for (const [orgId, entity] of [["org_co", "company"], ["org_st", "sole_trader"]] as const) {
  await store.addOrganisation({ id: orgId, type: "business", entity, name: orgId, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
  for (const role of ROLES) {
    await store.addMember({ id: `m_${orgId}_${role}`, orgId, userId: `u_${role}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
  }
}
await forEachSeq(ROLES, async (role, i) => await store.addUser({ id: `u_${role}`, name: role, country: "DE", kycStatus: "approved", address: `0x${(i + 1).toString(16).padStart(40, "0")}`, createdAt: now } as any));
await store.addAccount({ id: "acc_co", orgId: "org_co", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: CO_SAFE, createdAt: now, updatedAt: now } as any);
await store.addAccount({ id: "acc_st", orgId: "org_st", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: ST_SAFE, backingUserId: "u_st", createdAt: now, updatedAt: now } as any);
await store.addUser({ id: "u_co_safe", name: "co", country: "DE", kycStatus: "approved", address: CO_SAFE, createdAt: now } as any);
await store.addUser({ id: "u_st", name: "st", country: "DE", kycStatus: "approved", address: ST_SAFE, createdAt: now } as any);

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
const never = async () => { throw new Error("not reached"); };
app.use("/api/orgs", createDraftRoutes({ ctxOf: async (req, res) => await resolveOrg(req, res, requireSession as any) }, never as any, never as any, never as any));
app.use("/api", createTransferRouter({
  requireUserSession: async (req, res, userId) => (who(req) === userId ? { id: "s" } : (res.status(403).json({ error: "not yours" }), undefined)),
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

try {
  await t("draft execute is the queue gate: payers, admins and owners in, accountants and viewers 403, on both entities", async () => {
    for (const orgId of ["org_co", "org_st"]) {
      for (const role of ROLES) {
        const r = await call("POST", `/orgs/${orgId}/drafts/no_such_draft/execute`, `u_${role}`);
        if (roleCan(role, "transfers.queue")) {
          assert.equal(r.status, 404, `${orgId} ${role}: past the role gate`);
        } else {
          assert.equal(r.status, 403, `${orgId} ${role}`);
          assert.equal(r.data.needs, "transfers.queue");
        }
      }
    }
  });

  await t("/transfers/:id/authorize refuses a company's Safe before reading any signature", async () => {
    const add = async (id: string, userId: string) => await store.addTransfer({
      id, userId, quoteId: `q_${id}`, rail: "sepa", recipientName: "R", state: "CREATED", sendEur: 10, txs: [], createdAt: now, updatedAt: now,
      auth: { to: CO_SAFE, amountWei: "1", destination: `0x${"11".repeat(32)}`, deadline: Math.floor(Date.now() / 1000) + 900 },
    } as any);
    await add("t_co", "u_co_safe");
    await add("t_st", "u_st");
    const co = await call("POST", "/transfers/t_co/authorize", "u_co_safe", { signature: "0x1234" });
    assert.equal(co.status, 403, JSON.stringify(co.data));
    assert.equal(co.data.code, "COMPANY_SAFE");
    assert.equal((await store.findTransfer("t_co"))!.state, "CREATED");
    const st = await call("POST", "/transfers/t_st/authorize", "u_st", { signature: "0x1234" });
    assert.notEqual(st.data.code, "COMPANY_SAFE", "a sole trader's Safe is its owner's own");
  });
} finally {
  server.close();
}

console.log(`\nROLE TABLE TEST PASSED — ${pass}/${pass}`);
