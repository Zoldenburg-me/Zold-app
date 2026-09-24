/**
 * Login rate limits, invoice-link passwords, and what never carries a user IP.
 *
 * Offline: an in-process express app on an ephemeral port and a throwaway db.
 *
 *   npm run security:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

process.env.AUTH_RATE_LIMIT_PER_MIN = "20";
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { passwordProblem, hashPassword, passwordMatches } = await import("../services/api/src/domain/passwords.js");
const { hashToken, ownerInvoiceView } = await import("../services/api/src/domain/invoices.js");
const { apiRateLimit, clientKey, securityHeaders } = await import("../services/api/src/http/policy.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");

initStore();
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

console.log("password policy");
await check("too short, common, low-variety, sequential and contextual passwords are refused", () => {
  assert.match(passwordProblem("short")!, /at least 12/);
  assert.match(passwordProblem("Password1234")!, /common/);
  assert.match(passwordProblem("abababababab")!, /too few/);
  assert.match(passwordProblem("abcdefghijklmn")!, /sequence|common/);
  assert.match(passwordProblem("AcmeGmbH-invoices", ["Acme GmbH", "Acme"])!, /organisation/);
  assert.equal(passwordProblem("x".repeat(129) + "abcde")?.includes("at most"), true);
});
await check("a long, varied passphrase is accepted", () => {
  assert.equal(passwordProblem("copper kettle harbour 42"), undefined);
});

console.log("password hashing");
await check("scrypt hash is salted, verifies, and rejects a wrong password", () => {
  const a = hashPassword("copper kettle harbour 42");
  const b = hashPassword("copper kettle harbour 42");
  assert.ok(a.startsWith("scrypt$"));
  assert.notEqual(a, b, "same password must hash differently (salt)");
  assert.equal(passwordMatches("copper kettle harbour 42", a), true);
  assert.equal(passwordMatches("copper kettle harbour 43", a), false);
});
await check("a legacy unsalted SHA-256 row still verifies", () => {
  assert.equal(passwordMatches("old-link-password", hashToken("old-link-password")), true);
  assert.equal(passwordMatches("nope", hashToken("old-link-password")), false);
});

console.log("client keys");
await check("IPv6 is keyed on its /64; mapped IPv4 as IPv4", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey(undefined), "?");
});

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(securityHeaders);
app.use("/api", apiRateLimit);
app.post("/api/webauthn/challenge", (_req, res) => res.json({ challenge: "x" }));
app.use("/api/invoice-links", createInvoiceLinkRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log("rate limits");
await check("unauthenticated challenge minting sits on the tight bucket", async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await fetch(`${base}/api/webauthn/challenge`, { method: "POST" })).status;
  assert.equal(last, 429);
});
await check("every response says no-referrer and nosniff", async () => {
  const r = await fetch(`${base}/api/invoice-links/nothing`);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
await check("every response carries a same-origin CSP and refuses to be framed", async () => {
  const r = await fetch(`${base}/api/invoice-links/nothing`);
  const csp = r.headers.get("content-security-policy") ?? "";
  for (const d of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(d), `CSP lacks ${d}: ${csp}`);
  }
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

console.log("invoice-link password");
const now = new Date().toISOString();
const token = "tok-" + "a".repeat(40);
store.addInvoice({
  id: "inv_sec", orgId: "org_sec", linkTokenHash: hashToken(token),
  linkPasswordHash: hashPassword("copper kettle harbour 42"),
  state: "LINK_CREATED", lines: [], currency: "EUR", total: "0.00",
  createdByMemberId: "m1", createdAt: now, updatedAt: now,
} as any);
// Distinct source per request, so only the per-link counter can stop this.
let src = 0;
const open = (pw?: string) =>
  fetch(`${base}/api/invoice-links/${token}`, {
    headers: { ...(pw ? { "x-invoice-password": pw } : {}), "x-forwarded-for": `198.51.100.${++src}` },
  });
app.set("trust proxy", 1);
await check("no password asks for one; the right one opens the link", async () => {
  assert.equal((await open()).status, 401);
  assert.equal((await open("copper kettle harbour 42")).status, 200);
});
await check("ten wrong guesses from ten addresses lock the link, even for the right password", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await open(`wrong guess ${i}`)).status, 401);
  assert.equal((await open("copper kettle harbour 42")).status, 429);
});
server.close();

console.log("no hashes, no IPs");
await check("the owner view drops both link hashes", () => {
  const v = ownerInvoiceView(store.findInvoice("inv_sec")!) as Record<string, unknown>;
  assert.equal("linkTokenHash" in v, false);
  assert.equal("linkPasswordHash" in v, false);
});
await check("a legacy consent row's IP is never projected", () => {
  const u = publicUser({
    id: "u1", name: "n", country: "DE", kycStatus: "pending", iban: "", address: "0x0", createdAt: now,
    consents: [{ kind: "zold_terms", version: "1", at: now, ip: "203.0.113.9" }],
  } as any);
  assert.equal(JSON.stringify(u).includes("203.0.113.9"), false);
  assert.equal(u.consents?.length, 1);
});

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nsecurity hardening: all checks passed");
