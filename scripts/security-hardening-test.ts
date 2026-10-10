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
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.AUTH_RATE_LIMIT_PER_MIN = "20";
process.env.PARTNER_RATE_LIMIT_PER_MIN = "30";
process.env.DOCUMENT_RATE_LIMIT_PER_MIN = "10";
process.env.SHOPIFY_RATE_LIMIT_PER_MIN = "600";
process.env.OPERATOR_RATE_LIMIT_PER_MIN = "300";
const OPERATOR = "operator-token-for-rate-limit-tests-0123";
process.env.KYC_OPERATOR_TOKEN = OPERATOR;
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { passwordProblem, hashPassword, passwordMatches } = await import("../services/api/src/domain/passwords.js");
const { hashToken, ownerInvoiceView } = await import("../services/api/src/domain/invoices.js");
const { apiRateLimit, clientKey, securityHeaders, securityHeadersFor } = await import("../services/api/src/http/policy.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { persist } = await import("../services/api/src/store/db.js");

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
await check("scrypt hash is salted, verifies, and rejects a wrong password", async () => {
  const a = await hashPassword("copper kettle harbour 42");
  const b = await hashPassword("copper kettle harbour 42");
  assert.ok(a.startsWith("scrypt$"));
  assert.notEqual(a, b, "same password must hash differently (salt)");
  assert.equal(await passwordMatches("copper kettle harbour 42", a), true);
  assert.equal(await passwordMatches("copper kettle harbour 43", a), false);
});
await check("a legacy unsalted SHA-256 row still verifies", async () => {
  assert.equal(await passwordMatches("old-link-password", hashToken("old-link-password")), true);
  assert.equal(await passwordMatches("nope", hashToken("old-link-password")), false);
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
app.post("/api/quotes", (_req, res) => res.json({}));
app.post("/api/users/:id/documents/statement", (_req, res) => res.json({}));
app.post("/api/shopify/payment", (_req, res) => res.json({}));
app.get("/api/admin/overview", (_req, res) => res.json({}));
app.use("/api/invoice-links", createInvoiceLinkRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log("rate limits");
await check("unauthenticated challenge minting sits on the tight bucket", async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await fetch(`${base}/api/webauthn/challenge`, { method: "POST" })).status;
  assert.equal(last, 429);
});
await check("changing case or adding a trailing slash does not escape the tight bucket", async () => {
  // Express routes ignore both, so these reach the same handler as above.
  for (const p of ["/api/WebAuthn/Challenge", "/api/webauthn/challenge/"]) {
    assert.equal((await fetch(`${base}${p}`, { method: "POST" })).status, 429, p);
  }
});
await check("routes that call a partner have their own bucket", async () => {
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await fetch(`${base}/api/quotes`, { method: "POST" })).status);
  assert.equal(statuses[29], 200);
  assert.equal(statuses[30], 429);
});
await check("statement documents sit on a tighter one", async () => {
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await fetch(`${base}/api/users/u1/documents/statement`, { method: "POST" })).status;
  assert.equal(last, 429);
});
await check("Shopify's signed calls are not on the 20/min credential bucket", async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await fetch(`${base}/api/shopify/payment`, { method: "POST" })).status;
  assert.equal(last, 200);
});
await check("a valid operator token has its own bucket: the dashboard's refresh loop is not the 20/min one", async () => {
  // The challenge test above has already spent this IP's credential bucket.
  const auth = { authorization: `Bearer ${OPERATOR}` };
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await fetch(`${base}/api/admin/overview`, { headers: auth })).status);
  assert.deepEqual([...new Set(statuses)], [200]);
});
await check("a wrong operator token stays on the credential bucket", async () => {
  const r = await fetch(`${base}/api/admin/overview`, { headers: { authorization: "Bearer guess-guess-guess-guess-guess" } });
  assert.equal(r.status, 429);
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
await check("production pins HTTPS on every subdomain (five minutes while subdomains are confirmed); local dev does not", async () => {
  const headersFrom = async (production: boolean) => {
    const one = express();
    one.use(securityHeadersFor(production));
    one.get("/", (_req, res) => res.end());
    const s = one.listen(0);
    try {
      return (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`)).headers;
    } finally {
      s.close();
    }
  };
  assert.equal((await headersFrom(true)).get("strict-transport-security"), "max-age=300; includeSubDomains");
  assert.equal((await headersFrom(false)).get("strict-transport-security"), null);
});

console.log("invoice-link password");
const now = new Date().toISOString();
const token = "tok-" + "a".repeat(40);
store.addInvoice({
  id: "inv_sec", orgId: "org_sec", linkTokenHash: hashToken(token),
  linkPasswordHash: await hashPassword("copper kettle harbour 42"),
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
await check("guesses sent all at once still stop at ten, though checking is asynchronous", async () => {
  const token2 = "tok-" + "b".repeat(40);
  store.addInvoice({
    id: "inv_sec2", orgId: "org_sec", linkTokenHash: hashToken(token2),
    linkPasswordHash: await hashPassword("copper kettle harbour 42"),
    state: "LINK_CREATED", lines: [], currency: "EUR", total: "0.00",
    createdByMemberId: "m1", createdAt: now, updatedAt: now,
  } as any);
  const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    fetch(`${base}/api/invoice-links/${token2}`, {
      headers: { "x-invoice-password": `wrong ${i}`, "x-forwarded-for": `198.51.101.${i + 1}` },
    }).then((r) => r.status)));
  assert.equal(statuses.filter((x) => x === 401).length, 10, statuses.join(","));
  assert.equal(statuses.filter((x) => x === 429).length, 20);
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

console.log("availability");
const { emailLooksValid } = await import("../services/api/src/domain/email.js");
await check("the email check answers a hostile 60,000-character address at once", () => {
  for (const ok of ["a@b.de", "first.last+tag@mail.example.co.uk"]) assert.equal(emailLooksValid(ok), true, ok);
  for (const bad of ["a@b", "a@@b.de", "a b@c.de", "a@b..de", `${"a".repeat(250)}@b.de`]) assert.equal(emailLooksValid(bad), false, bad);
  const t = Date.now();
  assert.equal(emailLooksValid("a@" + ".".repeat(60_000) + "@"), false);
  assert.equal(emailLooksValid("a@b" + ".c".repeat(30_000) + "@"), false);
  assert.ok(Date.now() - t < 50, `took ${Date.now() - t} ms`);
});
await check("writes inside batched() reach the file once, at its end", async () => {
  const { readFileSync } = await import("node:fs");
  const onDisk = () => readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
  store.batched(() => {
    store.audit({ id: "aud_batch_1", at: now, action: "test.batch", data: {}, actorId: "t" } as any);
    store.audit({ id: "aud_batch_2", at: now, action: "test.batch", data: {}, actorId: "t" } as any);
    assert.equal(onDisk().includes("aud_batch_1"), false, "written before the batch ended");
  });
  assert.ok(onDisk().includes("aud_batch_1") && onDisk().includes("aud_batch_2"));
});
await check("a quote nobody took is dropped a day after it expired; a consumed one stays", () => {
  const q = (id: string, status: string, hoursAgo: number) => ({
    id, userId: "u1", rail: "sepa", status, sendEur: 1, fixedFeeEur: 0, fxRate: 1, receiveKes: 0, receiveEur: 1,
    midRate: 1, marginBps: 0, effectiveRate: 1, createdAt: now,
    expiresAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  } as any);
  store.addQuote(q("q_old_open", "OPEN", 30));
  store.addQuote(q("q_old_used", "CONSUMED", 30));
  store.addQuote(q("q_recent", "EXPIRED", 2));
  store.addQuote(q("q_new", "OPEN", -1));
  assert.equal(store.findQuote("q_old_open"), undefined);
  assert.ok(store.findQuote("q_old_used") && store.findQuote("q_recent") && store.findQuote("q_new"));
});

console.log("a passkey replaced by recovery while an approval is being verified");
{
  const { createHash, randomBytes, webcrypto } = await import("node:crypto");
  const { checkOpAssertion } = await import("../services/api/src/http/passkey-assertion.js");
  const { createAuthRouter, verifyPasskeyStepUp } = await import("../services/api/src/routes/auth.js");
  const { bindRecoveredPasskey } = await import("../services/api/src/recovery/recovered-passkey.js");
  const { issueChallenge, stepUpBinding } = await import("../services/api/src/webauthn.js");
  const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
  const b64url = (b: Buffer) => b.toString("base64url");
  const rawToDer = (raw: Buffer) => {
    const int = (b: Buffer) => {
      let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
      if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return Buffer.concat([Buffer.from([0x02, v.length]), v]);
    };
    const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
    return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
  };
  // A software P-256 authenticator, user-verified (flags UP|UV).
  const softPasskey = async (label: string) => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const credentialId = b64url(Buffer.from(`${label}-${randomBytes(4).toString("hex")}`));
    let count = 0;
    return {
      credentialId,
      stored: () => ({ credentialId, publicKey: { alg: "ES256", jwk }, signCount: 0, rpId: "localhost", createdAt: now }),
      assert: async (challenge: string) => {
        const authData = Buffer.alloc(37);
        sha256(Buffer.from("localhost")).copy(authData, 0);
        authData[32] = 0x05;
        authData.writeUInt32BE(++count, 33);
        const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000" }));
        const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([authData, sha256(clientData)])));
        return { credentialId, authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(rawToDer(raw)) };
      },
    };
  };
  const oldKey = await softPasskey("old-device");
  const newKey = await softPasskey("recovered");
  const uid = "u_race";
  store.addUser({
    id: uid, name: "Race", country: "DE", kycStatus: "approved", address: "0x5afe00000000000000000000000000000000ace1", createdAt: now,
    passkey: oldKey.stored(),
    passkeySafe: { address: "0x5afe00000000000000000000000000000000ace1", status: "active", threshold: 1 },
  } as any);
  const reset = () => store.updateUser(uid, { passkey: oldKey.stored() as any });

  // Hold WebCrypto's verify open until the test lets it go: the window in
  // which a recovery can finish.
  const subtle = webcrypto.subtle as any;
  const realVerify = subtle.verify.bind(subtle);
  let hold: { reached: () => void; release: Promise<void> } | undefined;
  subtle.verify = async (...args: any[]) => { if (hold) { hold.reached(); await hold.release; } return realVerify(...args); };
  /** Run `call`, and while its passkey verification is in flight, recover the account onto newKey. */
  const recoverDuring = async <T>(call: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    let reached!: () => void;
    const verifying = new Promise<void>((r) => (reached = r));
    hold = { reached, release: new Promise<void>((r) => (release = r)) };
    const result = call();
    await verifying;
    bindRecoveredPasskey(store.findUser(uid)!, { ...newKey.stored(), attestation: "none" } as any, new Date());
    release();
    try { return await result; } finally { hold = undefined; }
  };
  const fakeRes = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.status = (c: number) => ((r.statusCode = c), r);
    r.json = (b: unknown) => ((r.body = b), r);
    return r;
  };

  await check("a Safe-op approval by the old passkey does not put it back after recovery", async () => {
    reset();
    const challenge = b64url(randomBytes(32));
    const res = fakeRes();
    const ok = await recoverDuring(async () => checkOpAssertion(store.findUser(uid)!, await oldKey.assert(challenge), challenge, res));
    assert.equal(store.findUser(uid)!.passkey!.credentialId, newKey.credentialId);
    assert.equal(store.findUserByCredential(oldKey.credentialId), undefined);
    assert.equal(ok, undefined);
    assert.ok(res.statusCode >= 400);
  });

  await check("a step-up by the old passkey that finishes after recovery is refused", async () => {
    reset();
    const step = await oldKey.assert(issueChallenge("step_up", stepUpBinding(uid, "passkey.replace")));
    const res = fakeRes();
    const ok = await recoverDuring(() => verifyPasskeyStepUp(store.findUser(uid)!, { stepUp: step }, res, "passkey.replace"));
    assert.equal(ok, false);
    assert.equal(store.findUser(uid)!.passkey!.credentialId, newKey.credentialId);
  });

  await check("a login by the old passkey that finishes after recovery gets no session", async () => {
    reset();
    const app = express().use(express.json()).use("/api", createAuthRouter({ requireUserSession: () => undefined }));
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passkey/login`;
      const body = await oldKey.assert(issueChallenge("login"));
      const r = await recoverDuring(() => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const json = (await r.json()) as any;
      assert.equal(json.sessionToken, undefined);
      assert.equal(r.status, 401);
      assert.equal(store.sessions.filter((s) => s.userId === uid && !s.revokedAt).length, 0);
      assert.equal(store.findUser(uid)!.passkey!.credentialId, newKey.credentialId);
    } finally {
      server.close();
    }
  });
  subtle.verify = realVerify;

  await check("every passkey signCount write goes through store.recordPasskeyUse", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const src = new URL("../services/api/src/", import.meta.url);
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && f !== "store.ts")
      .filter((f) => /passkey:\s*\{\s*\.\.\.[\w.]+,\s*signCount\s*\}/.test(readFileSync(new URL(f, src), "utf8")));
    assert.deepEqual(offenders, []);
  });
}

console.log("database file");
await check("the database file is readable by its owner only, even over a stale world-readable .tmp", () => {
  const dbPath = process.env.TRANSF_DB_PATH!;
  rmSync(dbPath, { force: true });
  writeFileSync(dbPath + ".tmp", "{}", { mode: 0o644 });
  chmodSync(dbPath + ".tmp", 0o644);
  persist();
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});

console.log("secrets runner (scripts/with-env-fd.mjs)");
const RUNNER = new URL("./with-env-fd.mjs", import.meta.url).pathname;
const runWithSecrets = (dotenv: string | null, command: string[], env: NodeJS.ProcessEnv = {}) => {
  const file = path.join(os.tmpdir(), `zold-runner-test-${process.pid}.env`);
  writeFileSync(file, dotenv ?? "");
  const fd = openSync(file, "r");
  try {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
    if (dotenv !== null) stdio.push(fd);
    return spawnSync(process.execPath, [RUNNER, ...command], { stdio, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  } finally {
    closeSync(fd);
    rmSync(file, { force: true });
  }
};
const node = (code: string) => [process.execPath, "-e", code];
await check("refuses to start the command when nothing was decrypted", () => {
  for (const empty of ["", "# only a comment\n\n"]) {
    const r = runWithSecrets(empty, node("process.stdout.write('started')"));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no secrets decrypted/);
  }
});
await check("refuses when there is no fd 3 at all", () => {
  const r = runWithSecrets(null, node("process.stdout.write('started')"));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /could not read secrets on fd 3/);
});
await check("decrypted values reach the command; a variable already set wins", () => {
  const r = runWithSecrets("A=from_fd\nB=from_fd\n", node("process.stdout.write(process.env.A + ',' + process.env.B)"), { B: "from_env" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "from_fd,from_env");
});
await check("the command's exit code and killing signal come back out", () => {
  assert.equal(runWithSecrets("A=1\n", node("process.exit(7)")).status, 7);
  const killed = runWithSecrets("A=1\n", node("process.kill(process.pid, 'SIGTERM')"));
  assert.equal(killed.signal ?? (killed.status === 143 ? "SIGTERM" : killed.status), "SIGTERM");
});
await check("a command that does not exist is a plain error, not a crash", () => {
  const r = runWithSecrets("A=1\n", ["zold-no-such-command"]);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /could not start zold-no-such-command/);
});

console.log("secrets set (scripts/env-set.mjs, scripts/secrets.sh set)");
const SETTER = new URL("./env-set.mjs", import.meta.url).pathname;
const SECRETS_SH = new URL("./secrets.sh", import.meta.url).pathname;
const { parseEnv } = await import("node:util");
/** Runs env-set.mjs with `dotenv` on fd 3 and `value` (if any) on fd 4. */
const setVar = (dotenv: string, args: string[], value: string | null = null) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-env-set-"));
  const f3 = path.join(dir, "current");
  const f4 = path.join(dir, "value");
  writeFileSync(f3, dotenv);
  writeFileSync(f4, value ?? "");
  const fd3 = openSync(f3, "r");
  const fd4 = openSync(f4, "r");
  try {
    return spawnSync(process.execPath, [SETTER, ...args], {
      stdio: ["ignore", "pipe", "pipe", fd3, ...(value === null ? [] : [fd4])],
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
  } finally {
    closeSync(fd3);
    closeSync(fd4);
    rmSync(dir, { recursive: true, force: true });
  }
};
const CURRENT = "# operator settings\nA=one\n\nB='two words'\nC=three # trailing note\n";
await check("set adds a new name and keeps every other line, comments included", () => {
  const r = setVar(CURRENT, ["NEW_NAME"], "fake-value-1");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(CURRENT), "the existing text is kept as it was");
  assert.deepEqual(parseEnv(r.stdout), { ...parseEnv(CURRENT), NEW_NAME: "fake-value-1" });
});
await check("set refuses a name that is already set, unless --replace, and never echoes a value", () => {
  const r = setVar(CURRENT, ["A"], "fake-value-2");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /A is already set.*--replace/);
  assert.ok(!r.stderr.includes("fake-value-2") && !r.stderr.includes("one"));
});
await check("set --replace changes that one value and nothing else", () => {
  const r = setVar(CURRENT, ["A", "--replace"], "fake-value-3");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseEnv(r.stdout), { ...parseEnv(CURRENT), A: "fake-value-3" });
  assert.ok(r.stdout.includes("# operator settings"));
  assert.equal(r.stdout.match(/^A=/gm)?.length, 1, "the old A line is gone");
});
await check("values with spaces, # or quotes round-trip through the same parser as `run`, or are refused", () => {
  for (const v of ["has space", "has#hash", "a=b+c/d", "it's", 'say "hi"']) {
    const r = setVar(CURRENT, ["V"], v);
    if (r.status === 0) assert.equal(parseEnv(r.stdout).V, v, `round trip of ${JSON.stringify(v)}`);
    else assert.match(r.stderr, /cannot be written/);
  }
});
await check("set refuses an empty value, a value over two lines, and a bad name", () => {
  assert.match(setVar(CURRENT, ["V"], "").stderr, /empty/);
  assert.match(setVar(CURRENT, ["V"], "line1\nline2").stderr, /one line/);
  for (const bad of ["lower", "1ST", "A-B", ""]) {
    const r = setVar(CURRENT, [bad], "x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a variable name|usage/);
    if (bad) assert.ok(!r.stderr.includes(bad), "a rejected name is not echoed");
  }
});
await check("set --random makes 32 random bytes as base64, with an optional prefix, and prints none of it", () => {
  const a = setVar(CURRENT, ["DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
  const b = setVar(CURRENT, ["DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
  assert.equal(a.status, 0, a.stderr);
  const va = parseEnv(a.stdout).DATA_ENCRYPTION_KEYS!;
  assert.match(va, /^k1:[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(va.slice(3), "base64").length, 32);
  assert.notEqual(va, parseEnv(b.stdout).DATA_ENCRYPTION_KEYS);
  assert.ok(!a.stderr.includes(va.slice(3)));
});

const AGE_DIR = path.join(path.dirname(SECRETS_SH), "..", ".toolchain", "age-v1.3.2", "age");
if (!existsSync(path.join(AGE_DIR, "age"))) {
  console.log("  NOT RUN secrets.sh set end to end: age is not installed here (scripts/fetch-age.sh)");
} else {
  await check("secrets.sh set re-encrypts the file with the new name, keeps the old one encrypted, and run sees it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zold-secrets-set-"));
    try {
      const identity = path.join(dir, "identity");
      const recipients = path.join(dir, "recipients");
      spawnSync(path.join(AGE_DIR, "age-keygen"), ["-o", identity], { encoding: "utf8" });
      writeFileSync(recipients, spawnSync(path.join(AGE_DIR, "age-keygen"), ["-y", identity], { encoding: "utf8" }).stdout);
      const plain = path.join(dir, "dotenv");
      writeFileSync(plain, "A=one\n");
      const env = { PATH: process.env.PATH, AGE_IDENTITY_FILE: identity, AGE_RECIPIENTS_FILE: recipients, SECRETS_ENV_FILE: `${plain}.age` };
      const sh = (args: string[], input?: string) => spawnSync("bash", [SECRETS_SH, ...args], { env, input, encoding: "utf8" });
      assert.equal(sh(["encrypt", plain]).status, 0);
      rmSync(plain);
      const set = sh(["set", "NEW_NAME"], "fake-value-4\n");
      assert.equal(set.status, 0, set.stderr);
      assert.ok(!`${set.stdout}${set.stderr}`.includes("fake-value-4"), "set printed the value");
      assert.ok(existsSync(path.join(dir, "dotenv.prev.age")), "the previous file is kept, encrypted");
      const read = sh(["run", "--", "sh", "-c", 'printf "%s,%s" "$A" "$NEW_NAME"']);
      assert.equal(read.stdout, "one,fake-value-4", read.stderr);
      assert.equal(sh(["set", "A"], "other\n").status, 1);
      assert.equal(sh(["run", "--", "printenv", "A"]).stdout.trim(), "one", "a refused set leaves the file as it was");
      const rnd = sh(["set", "DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
      assert.equal(rnd.status, 0, rnd.stderr);
      assert.match(sh(["run", "--", "printenv", "DATA_ENCRYPTION_KEYS"]).stdout.trim(), /^k1:[A-Za-z0-9+/]{43}=$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("log lines");
await check("a URL in a log line keeps scheme and host only: keys in the path or query never print", async () => {
  const { urlForLog } = await import("../services/api/src/http/log-safe.js");
  const key = "fake-key-" + "x".repeat(23);
  assert.equal(urlForLog(`https://api.candide.dev/api/v3/84532/${key}`), "https://api.candide.dev");
  assert.equal(urlForLog(`https://rpc.example/v1?apikey=${key}`), "https://rpc.example");
  assert.equal(urlForLog(`https://user:${key}@host.example/x`), "https://host.example");
  assert.equal(urlForLog(undefined), "(unset)");
  assert.ok(!urlForLog(`not a url ${key}`).includes(key));
});
await check("no startup or request log interpolates a raw URL or an email", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const src = new URL("../services/api/src/", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(src, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(f, src), "utf8");
    // Whole calls, so a template literal spread over several lines is read too.
    for (const call of text.matchAll(/console\.(?:log|warn|error|info)\(([\s\S]*?)\);/g)) {
      const body = call[1];
      if (/\$\{(?![^}]*urlForLog)[^}]*(Url|URL|\.url)\b[^}]*\}/.test(body) || /\$\{[^}]*\bemail\b[^}]*\}/.test(body)) {
        offenders.push(`${f}:${text.slice(0, call.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The API's source, or the operator scripts' (not their suites or the shared
// harness modules, which only ever talk to local stubs).
async function sourceFiles(dir: "api" | "scripts"): Promise<{ file: string; text: string }[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = new URL(dir === "api" ? "../services/api/src/" : "./", import.meta.url);
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => dir === "api" || (!f.endsWith("-test.ts") && !f.split("/").pop()!.startsWith("_")))
    .map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8") }));
}
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const RAW_URL = /\$\{(?![^}]*urlForLog)[^}]*(Url|URL|\.url)\b[^}]*\}/;
// A whole console call or Error construction: up to the `);` that ends its
// line, so an arrow body or a nested call inside it does not cut it short.
const CONSOLE_CALL = /console\.(?:log|warn|error|info|debug)\(([\s\S]*?)\);\s*$/gm;
const ERROR_TEMPLATE = /new \w*Error\(\s*`([^`]*)`/g;
// Names an error goes by in a catch or callback.
const ERR = String.raw`(?:e|err|error|cause|e2|err2|error2|ex)`;
// Reading an error's text without a log-cause helper: a `?.message ??`
// fallback (the shape of an untyped catch), a cast's `.message`, the error
// interpolated whole, or the error object handed to console as an argument.
const RAW_ERROR_TEXT = [
  new RegExp(String.raw`\b${ERR}\b\)?\??\.message\s*\?\?`, "g"),
  new RegExp(String.raw`\(\s*${ERR}\s+as\s+\w+\s*\)\??\.message\b`, "g"),
  new RegExp(String.raw`\$\{\s*${ERR}\s*\}`, "g"),
  new RegExp(String.raw`String\(\s*${ERR}\s*\)`, "g"),
];
const HELPER_BEFORE = /\b(?:redactedMessage|describeCause|describeError|errorText)\([^)]*$/;

await check("an error's message is redacted before it is logged, stored or returned: a keyed RPC or bundler URL in it never survives", async () => {
  const { redactedMessage } = await import("../services/api/src/http/log-cause.js");
  const key = "fake-key-" + "x".repeat(23);
  const viemLike = Object.assign(new Error(`HTTP request failed.\n\nURL: https://base-sepolia.example/v2/${key}\nRequest body: {}`), {
    shortMessage: `HTTP request failed at https://base-sepolia.example/v2/${key}`,
  });
  const fetchLike = new Error(`request to https://api.candide.dev/paymaster/v3/84532/${key} failed, reason: getaddrinfo ENOTFOUND api.candide.dev`);
  for (const err of [viemLike, fetchLike, new Error("connect ECONNREFUSED 10.0.0.7:8545")]) {
    const out = redactedMessage(err);
    assert.ok(!out.includes(key), out);
    assert.ok(!/https?:\/\/|10\.0\.0\.7|candide\.dev/.test(out), out);
  }
  assert.equal(redactedMessage(viemLike), "HTTP request failed at <url>", "shortMessage first, one line, no error name");
  assert.equal(redactedMessage(new Error("amount exceeds balance")), "amount exceeds balance", "a plain message keeps its words");
  assert.equal(redactedMessage("refused"), "refused");
  assert.equal(redactedMessage(new Error("counterpart.identifier.iban is invalid")), "counterpart.identifier.iban is invalid", "a field path is not a host");
  assert.equal(
    redactedMessage(new Error("webauthn: origin https://evil.example not allowed"), { keepHosts: true }),
    "webauthn: origin https://evil.example not allowed",
    "keepHosts names the origin",
  );
  assert.equal(redactedMessage(viemLike, { keepHosts: true }), "HTTP request failed at https://base-sepolia.example", "keepHosts still drops the keyed path");
  assert.equal(redactedMessage(undefined), "unknown error");
});
await check("an error's text reaches a log line, a row or a response only through a log-cause helper", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("api")) {
    if (file.endsWith("log-cause.ts")) continue;
    for (const re of RAW_ERROR_TEXT) {
      for (const m of text.matchAll(re)) {
        const lineStart = text.lastIndexOf("\n", m.index!) + 1;
        if (HELPER_BEFORE.test(text.slice(lineStart, m.index!))) continue;
        offenders.push(`${file}:${lineOf(text, m.index!)}`);
      }
    }
    for (const call of text.matchAll(CONSOLE_CALL)) {
      if (new RegExp(String.raw`(^|,)\s*${ERR}\s*,?\s*$`).test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});
await check("no thrown error names a raw URL: a boot error is printed, so a keyed RPC URL in it reaches the log", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("api")) {
    for (const call of text.matchAll(ERROR_TEMPLATE)) {
      if (RAW_URL.test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
await check("operator scripts print a configured URL by its origin only", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("scripts")) {
    for (const call of text.matchAll(CONSOLE_CALL)) {
      if (RAW_URL.test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nsecurity hardening: all checks passed");
