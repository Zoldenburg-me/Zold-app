/**
 * Tying a crypto deposit to an organisation's invoice.
 *
 * Marking the org's invoice paid is invoice management: a viewer or an
 * accountant may not do it with a deposit into their own Safe. Only a deposit
 * into the Safe that backs the org's account settles its invoice; a payer or
 * admin's personal Safe never does. One deposit settles one
 * invoice: once its payment is on an invoice it cannot be moved or dropped,
 * or the same money would settle a second one. Only an invoice the org issued
 * can be paid this way, never a bill it owes.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-deposit-invoice-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { createCryptoDepositRouter } = await import("../services/api/src/routes/crypto-deposits.js");
const { holdUntil } = await import("./_interleave.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

await initStore();
const now = new Date().toISOString();
const ORG = "org_dep";
const roles = { u_owner: "owner", u_admin: "admin", u_payer: "payer", u_accountant: "accountant", u_viewer: "viewer" } as const;
await store.addOrganisation({ id: ORG, type: "business", name: "Acme", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
for (const [userId, role] of Object.entries(roles)) {
  await store.addUser({ id: userId, name: userId, country: "DE", kycStatus: "approved", createdAt: now, address: `0x${randomBytes(20).toString("hex")}` } as any);
  await store.addMember({ id: `m_${userId}`, orgId: ORG, userId, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
await store.addAccount({ id: "acc_dep", orgId: ORG, currency: "EUR", label: "main", status: "active", provider: "monerium", identifier: {}, backingUserId: "u_owner", createdAt: now, updatedAt: now } as any);

const invoice = async (over: Record<string, unknown> = {}) => {
  const id = `inv_${randomBytes(6).toString("hex")}`;
  await store.addInvoice({
    id, orgId: ORG, direction: "outgoing", state: "SUBMITTED", linkTokenHash: randomBytes(16).toString("hex"),
    lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", amount: "100.00" }],
    currency: "EUR", total: "100.00", createdByMemberId: "m_u_owner", createdAt: now, updatedAt: now,
    issued: { number: "RE-1", issueDate: now.slice(0, 10), netCents: 10000, vatCents: 0, grossCents: 10000, currency: "EUR" },
    ...over,
  } as any);
  return id;
};
const deposit = async (userId: string) => {
  const id = `dep_${randomBytes(6).toString("hex")}`;
  await store.addCryptoDeposit({
    id, userId, chainId: 31337, token: "EURE", txHash: `0x${randomBytes(32).toString("hex")}`, logIndex: 0,
    amountUnits: String(100n * 10n ** 18n), amountEur: 100, creditedEur: 100, settlementAsset: "EURE", holding: "none", settledAt: now, txs: [],
    detectedAt: now, updatedAt: now,
  } as any);
  return id;
};

const app = express();
app.use(express.json());
app.use("/api", createCryptoDepositRouter({
  requireUserSession: async (req, res, userId) => {
    if (req.header("x-user") === userId) return { id: "s" };
    res.status(403).json({ error: "forbidden" });
    return undefined;
  },
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const link = async (userId: string, depositId: string, invoiceId: string | null) => {
  const res = await fetch(`${API}/api/users/${userId}/crypto-deposits/${depositId}/invoice`, {
    method: "POST", headers: { "content-type": "application/json", "x-user": userId }, body: JSON.stringify({ invoiceId }),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const stateOf = async (id: string) => (await store.list("invoices")).find((i) => i.id === id)!.state;

await check("a viewer cannot mark the org's invoice paid with a deposit into their own Safe", async () => {
  const inv = await invoice();
  assert.equal((await link("u_viewer", await deposit("u_viewer"), inv)).status, 403);
  assert.equal(await stateOf(inv), "SUBMITTED");
});

await check("nor can an accountant: books, not money", async () => {
  const inv = await invoice();
  assert.equal((await link("u_accountant", await deposit("u_accountant"), inv)).status, 403);
  assert.equal(await stateOf(inv), "SUBMITTED");
});

await check("an admin cannot with a deposit into their own Safe: it does not back the org's account", async () => {
  const inv = await invoice();
  assert.equal((await link("u_admin", await deposit("u_admin"), inv)).status, 403);
  assert.equal(await stateOf(inv), "SUBMITTED");
  assert.equal(((await store.list("invoices")).find((i) => i.id === inv)!.settlements ?? []).length, 0);
});

await check("nor can a payer", async () => {
  const inv = await invoice();
  assert.equal((await link("u_payer", await deposit("u_payer"), inv)).status, 403);
  assert.equal(await stateOf(inv), "SUBMITTED");
});

await check("the member whose Safe backs the org's account can, and the converted deposit settles the invoice", async () => {
  const inv = await invoice();
  const r = await link("u_owner", await deposit("u_owner"), inv);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await stateOf(inv), "PAID");
});

await check("once its payment is on an invoice, the deposit cannot be moved to a second invoice", async () => {
  const a = await invoice();
  const b = await invoice();
  const d = await deposit("u_owner");
  assert.equal((await link("u_owner", d, a)).status, 200);
  assert.equal((await link("u_owner", d, b)).status, 409);
  assert.equal(await stateOf(b), "SUBMITTED");
});

await check("nor unlinked and then linked again elsewhere", async () => {
  const a = await invoice();
  const b = await invoice();
  const d = await deposit("u_owner");
  assert.equal((await link("u_owner", d, a)).status, 200);
  assert.equal((await link("u_owner", d, null)).status, 409);
  assert.equal((await link("u_owner", d, b)).status, 409);
  assert.equal(await stateOf(b), "SUBMITTED");
});

await check("parallel links of one settled deposit to different invoices: one settles, the rest are refused", async () => {
  const invs = [await invoice(), await invoice(), await invoice(), await invoice()];
  const d = await deposit("u_owner");
  // Every link reaches the membership read before any links: the window
  // between the settled check and the settlement.
  const restore = holdUntil(store, "membersOf", invs.length);
  const results = await Promise.all(invs.map((inv) => link("u_owner", d, inv))).finally(restore);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  const paid = [];
  for (const inv of invs) if (await stateOf(inv) === "PAID") paid.push(inv);
  assert.equal(paid.length, 1, "one deposit, one invoice paid");
  const dep = (await store.list("cryptoDeposits")).find((x) => x.id === d)!;
  assert.equal(dep.invoiceId, paid[0], "the deposit points at the invoice it paid");
});

await check("linking the same invoice again records the payment once", async () => {
  const a = await invoice();
  const d = await deposit("u_owner");
  assert.equal((await link("u_owner", d, a)).status, 200);
  assert.equal((await link("u_owner", d, a)).status, 200);
  assert.equal((await store.list("invoices")).find((i) => i.id === a)!.settlements!.length, 1);
});

await check("a bill the org owes cannot be paid by a deposit", async () => {
  const bill = await invoice({ direction: "incoming" });
  assert.equal((await link("u_owner", await deposit("u_owner"), bill)).status, 409);
});

await check("a non-member gets 404, as for an invoice that does not exist", async () => {
  await store.addUser({ id: "u_out", name: "out", country: "DE", kycStatus: "approved", createdAt: now } as any);
  assert.equal((await link("u_out", await deposit("u_out"), await invoice())).status, 404);
});

server.close();
console.log(`\ndeposit-invoice-link: ${passed} checks passed`);
