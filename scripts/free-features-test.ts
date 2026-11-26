/**
 * Every built feature is free: an org with no plan and no trial has every
 * capability. The other two checks still hold — no session is refused, and a
 * member's role still decides what they may do.
 *
 * Offline: in-process express on an ephemeral port and a throwaway db.
 *
 *   npm run free-features:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-free-")), "db.json");

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { CAPABILITIES, LIMITS } = await import("../services/api/src/domain/plans.js");

await initStore();
const now = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
for (const id of ["u_owner", "u_viewer", "u_admin", "u_stranger"]) {
  await store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: now } as any);
}
// No `plan`, no `trial`: what every org created now looks like.
await store.addOrganisation({ id: "org_b", type: "business", name: "Free GmbH", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
await store.addOrganisation({ id: "org_p", type: "personal", name: "Me", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
for (const [orgId, userId, role] of [["org_b", "u_owner", "owner"], ["org_b", "u_viewer", "viewer"], ["org_b", "u_admin", "admin"], ["org_p", "u_owner", "owner"]]) {
  await store.addMember({ id: `m_${orgId}_${userId}`, orgId, userId, email: "", role: role as any, status: "active", invitedAt: now, acceptedAt: now });
}

const { sendAfterCommit } = await import("../services/api/src/http/send-after-commit.js");
const app = express().use(sendAfterCommit);
app.use(express.json());
const requireSession = async (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(async (r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, user?: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`FAIL  ${name}\n      ${(err as Error).message}`); }
}

await check("a business org with no plan and no trial has every built capability", async () => {
  const r = await call("GET", "/api/orgs/org_b", "u_owner");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const caps = r.data.organisation.capabilities;
  assert.equal(Object.keys(caps).length, Object.keys(CAPABILITIES).length);
  for (const [id, v] of Object.entries<any>(caps)) {
    assert.equal(v.allowed, id !== "cards", `${id}: ${v.reason}`);
  }
  assert.ok(caps.cards.unavailable, "cards say they are not built");
  assert.deepEqual(r.data.organisation.limits, LIMITS);
  for (const k of ["plan", "effectivePlan", "trial"]) assert.equal(k in r.data.organisation, false, `${k} is not served`);
});

await check("a personal org has every capability except the business-shaped ones", async () => {
  const caps = (await call("GET", "/api/orgs/org_p", "u_owner")).data.organisation.capabilities;
  for (const [id, v] of Object.entries<any>(caps)) {
    const businessOnly = CAPABILITIES[id as keyof typeof CAPABILITIES].orgTypes?.includes("business");
    assert.equal(v.allowed, id !== "cards" && !businessOnly, id);
  }
  assert.match(caps["members.manage"].reason, /business product/);
});

await check("the trial and plan routes are gone", async () => {
  assert.equal((await call("POST", "/api/orgs/org_b/plan/trial", "u_owner", {})).status, 404);
  assert.equal((await call("POST", "/api/orgs/org_b/plan", "u_owner", { plan: "business" })).status, 404);
  assert.equal((await call("GET", "/api/orgs/org_b/plan", "u_owner")).status, 404);
});

await check("no session is still refused", async () => {
  assert.equal((await call("GET", "/api/orgs/org_b")).status, 401);
});

await check("a non-member is still refused", async () => {
  const r = await call("GET", "/api/orgs/org_b", "u_stranger");
  assert.ok(r.status === 403 || r.status === 404, String(r.status));
});

await check("roles still refuse: a viewer cannot invite, an admin cannot turn review off", async () => {
  const invite = await call("POST", "/api/orgs/org_b/members", "u_viewer", { email: "x@example.com", role: "viewer" });
  assert.equal(invite.status, 403, JSON.stringify(invite.data));
  assert.equal(invite.data.needs, "members.invite");
  const off = await call("POST", "/api/orgs/org_b/payment-review", "u_admin", { required: false });
  assert.equal(off.status, 403, JSON.stringify(off.data));
});

await check("payment review starts off and an owner turns it on: a control, not a paid feature", async () => {
  assert.equal((await call("GET", "/api/orgs/org_b", "u_owner")).data.organisation.paymentReview.required, false);
  const on = await call("POST", "/api/orgs/org_b/payment-review", "u_owner", { required: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.organisation.paymentReview.required, true);
});

// §2 rule 4 on the JSON backend: these were synchronous from check to write;
// with an async store they are one store method each.
await check("two owners each demoting the other in parallel: one succeeds, one owner remains", async () => {
  await store.addOrganisation({ id: "org_two", type: "business", name: "Two", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
  for (const userId of ["u_owner", "u_admin"]) {
    await store.addMember({ id: `m_two_${userId}`, orgId: "org_two", userId, email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
  }
  const [a, b] = await Promise.all([
    call("PATCH", "/api/orgs/org_two/members/m_two_u_admin", "u_owner", { role: "viewer" }),
    call("PATCH", "/api/orgs/org_two/members/m_two_u_owner", "u_admin", { role: "viewer" }),
  ]);
  // The second is refused: 409 when it found the other still an owner, 403
  // when it found itself already demoted.
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200, JSON.stringify([a.data, b.data]));
  assert.ok([403, 409].includes(statuses[1]), JSON.stringify([a.data, b.data]));
  const owners = (await store.membersOf("org_two")).filter((m) => m.role === "owner" && m.status === "active");
  assert.equal(owners.length, 1);
});

await check("one invitation accepted twice in parallel: spent once", async () => {
  const { createHash } = await import("node:crypto");
  const email = "invitee@example.com";
  await store.addUser({
    id: "u_invitee", name: "Invitee", country: "DE", kycStatus: "approved", email, createdAt: now,
    passkeySafe: { address: `0x${"cd".repeat(20)}`, status: "active", candideRecovery: { channels: [{ channel: "email", target: email, verifiedAt: now }] } },
  } as any);
  const token = "invite-token-race";
  await store.addMember({
    id: "m_invited", orgId: "org_b", email, role: "viewer", status: "invited", invitedAt: now,
    invite: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  } as any);
  const answers = await Promise.all([1, 2].map(() => call("POST", "/api/orgs/invites/accept", "u_invitee", { token })));
  // The loser finds the invite spent (404) or, on Postgres where both read it
  // before either committed, loses the claim (409); either way it is refused.
  const [won, lost] = answers.map((r) => r.status).sort();
  assert.ok(won === 200 && [404, 409].includes(lost), JSON.stringify(answers.map((r) => r.data)));
  assert.equal((await store.membersOf("org_b")).filter((m) => m.userId === "u_invitee").length, 1);
});

server.close();
if (failed) { console.error(`\nFREE FEATURES TEST FAILED — ${failed} check(s)`); process.exit(1); }
console.log(`\nFREE FEATURES TEST PASSED — ${passed}/${passed}: every built feature is free, and session and role checks still refuse`);
