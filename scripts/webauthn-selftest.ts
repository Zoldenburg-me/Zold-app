/**
 * Self-test for the WebAuthn verifier: fabricates a genuine P-256 credential
 * (node webcrypto), builds real CBOR attestation + assertion payloads the way
 * an authenticator would, and runs them through verifyRegistration /
 * verifyAssertion — including negative cases (bad challenge, tampered
 * signature, cloned-counter). Run: npm run webauthn:selftest
 */
// The router cases import chain.js (no node is started or called).
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  issueChallenge,
  verifyRegistration,
  verifyAssertion,
  b64urlToBuf,
  bufToB64url,
} from "../services/api/src/webauthn.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// --- minimal CBOR encoder (uint, neg, bstr, tstr, map) ----------------------
function enc(v: any): Buffer {
  const head = (major: number, len: number) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b;
  };
  if (typeof v === "number") {
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(enc(k), enc(val));
    return Buffer.concat(parts);
  }
  throw new Error("enc: unsupported");
}

// raw r||s -> DER (what real authenticators emit)
function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function authDataBytes(flags: number, count: number, credId?: Buffer, coseKey?: Buffer): Buffer {
  const base = Buffer.alloc(37);
  sha256(RP_ID).copy(base, 0);
  base[32] = flags;
  base.writeUInt32BE(count, 33);
  if (credId && coseKey) {
    const cred = Buffer.alloc(18 + credId.length);
    cred.writeUInt16BE(credId.length, 16);
    credId.copy(cred, 18);
    return Buffer.concat([base, cred, coseKey]);
  }
  return base;
}

const clientData = (type: string, challenge: string) =>
  bufToB64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));

// --- fabricate a credential ---------------------------------------------------
const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
const cose = enc(new Map<number, any>([
  [1, 2], [3, -7], [-1, 1],
  [-2, b64urlToBuf(jwk.x!)], [-3, b64urlToBuf(jwk.y!)],
]));
const credId = Buffer.from("self-test-credential-0001");

// 1. registration
const regChallenge = issueChallenge("register");
const attObj = enc(new Map<string, any>([
  ["fmt", "none"],
  ["attStmt", new Map()],
  ["authData", authDataBytes(0x45, 0, credId, cose)],
]));
const reg = verifyRegistration(bufToB64url(attObj), clientData("webauthn.create", regChallenge), RP_ID, [ORIGIN]);
assert.equal(reg.credentialId, bufToB64url(credId));
assert.equal(reg.key.alg, "ES256");
console.log("1. registration verifies, COSE key extracted");

// 1b. a passkey enrolled on a touch alone (no UV) is refused
{
  const touchOnly = enc(new Map<string, any>([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authDataBytes(0x41, 0, credId, cose)],
  ]));
  assert.throws(
    () => verifyRegistration(bufToB64url(touchOnly), clientData("webauthn.create", issueChallenge("register")), RP_ID, [ORIGIN]),
    /user verification required to register/,
  );
  console.log("1b. registration without user verification rejected");
}

// 2. good assertion
const login = async (
  count: number,
  tamper = false,
  challenge?: string,
  purpose: "login" | "step_up" = "login",
  opts: { flags?: number; binding?: string } = {},
) => {
  const ch = challenge ?? issueChallenge(purpose, opts.binding);
  const cdj = clientData("webauthn.get", ch);
  // UP + UV: the verifier requires UV for every purpose, login included.
  const ad = authDataBytes(opts.flags ?? 0x05, count);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  const der = rawToDer(raw);
  if (tamper) der[der.length - 1] ^= 0xff;
  return verifyAssertion(
    bufToB64url(ad),
    cdj,
    bufToB64url(der),
    reg.key,
    reg.signCount,
    RP_ID,
    [ORIGIN],
    purpose,
    opts.binding,
  );
};
const ok = await login(1);
assert.equal(ok.signCount, 1);
console.log("2. valid assertion verifies, counter advances");

// 3. tampered signature rejected
await assert.rejects(() => login(2, true), /signature verification failed/);
console.log("3. tampered signature rejected");

// 4. stale/unknown challenge rejected
await assert.rejects(() => login(3, false, "bogus-challenge"), /unknown or expired challenge/);
console.log("4. unknown challenge rejected");

// 5. counter regression rejected (stored count 5, assertion count 5)
{
  const ch = issueChallenge("login");
  const cdj = clientData("webauthn.get", ch);
  const ad = authDataBytes(0x05, 5);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  await assert.rejects(
    () => verifyAssertion(bufToB64url(ad), cdj, bufToB64url(rawToDer(raw)), reg.key, 5, RP_ID, [ORIGIN]),
    /counter did not advance/,
  );
  console.log("5. cloned-authenticator counter rejected");
}

// 6. wrong origin rejected
{
  const ch = issueChallenge("login");
  const cdj = bufToB64url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch, origin: "https://evil.example" })));
  const ad = authDataBytes(0x05, 9);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  await assert.rejects(
    () => verifyAssertion(bufToB64url(ad), cdj, bufToB64url(rawToDer(raw)), reg.key, 0, RP_ID, [ORIGIN]),
    /origin .* not allowed/,
  );
  console.log("6. foreign origin rejected");
}

// 7. step-up assertion uses its own challenge purpose
{
  const ok = await login(10, false, undefined, "step_up");
  assert.equal(ok.signCount, 10);
  await assert.rejects(() => login(11, false, issueChallenge("step_up")), /unknown or expired challenge/);
  console.log("7. step-up assertions require a step-up challenge");
}

// 8. a step-up without user verification is not a step-up
{
  await assert.rejects(
    () => login(12, false, undefined, "step_up", { flags: 0x01 }),
    /user verification required/,
  );
  const ok = await login(13, false, undefined, "step_up");
  assert.equal(ok.signCount, 13);
  console.log("8. step-up requires the user-verification flag");
}

// 9. a challenge bound to one account cannot be spent on another's step-up
{
  const forAccountA = issueChallenge("step_up", "user-a");
  await assert.rejects(
    () => login(14, false, forAccountA, "step_up", { binding: "user-b" }),
    /unknown or expired challenge/,
  );
  const ok = await login(15, false, issueChallenge("step_up", "user-a"), "step_up", { binding: "user-a" });
  assert.equal(ok.signCount, 15);
  console.log("9. step-up challenges are bound to their account");
}

// 10. a login without user verification gets no session
{
  await assert.rejects(() => login(16, false, undefined, "login", { flags: 0x01 }), /user verification required/);
  console.log("10. login requires the user-verification flag");
}

// ---------------------------------------------------------------------------
// The same rules through the routes a person actually calls: signup
// (routes/users.ts), the challenge and passkey routes (routes/auth.ts), a
// software passkey, a throwaway store. One process: the challenge Map is
// per process, so what a second instance or a restart would do is not
// tested here (an open deployment decision, docs: PR body of board #232).
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-webauthn-")), "db.json");
  // Case 18 relies on verification being off; set here, not inherited.
  process.env.EMAIL_VERIFICATION = "0";
  const { EMAIL_VERIFICATION } = await import("../services/api/src/config.js");
  assert.equal(EMAIL_VERIFICATION.enabled, false, "EMAIL_VERIFICATION was read before this suite set it");
  const express = (await import("express")).default;
  const { initStore, store } = await import("../services/api/src/store.js");
  const { requireUserSession } = await import("../services/api/src/http/sessions.js");
  const { createUserRouter } = await import("../services/api/src/routes/users.js");
  const { createAuthRouter } = await import("../services/api/src/routes/auth.js");
  const { makeSoftwarePasskey } = await import("./_software-passkey.js");
  await initStore();
  const app = express().use(express.json());
  app.use("/api", createUserRouter({ requireUserSession }));
  app.use("/api", createAuthRouter({ requireUserSession }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const call = async (p: string, body: unknown, token?: string) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const signup = async (email: string) => {
    const r = await call("/users", { name: "Test Person", email, country: "DE" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.id as string, token: r.body.sessionToken as string };
  };
  const challenge = async (purpose: string, token?: string, extra: object = {}) => {
    const r = await call("/webauthn/challenge", { purpose, ...extra }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.challenge as string;
  };
  const register = (who: { id: string; token: string }, body: object) => call(`/users/${who.id}/passkey`, body, who.token);
  const passkey = (label: string) => makeSoftwarePasskey(label, ORIGIN);
  let r: Awaited<ReturnType<typeof call>>;

  const a = await signup("a@example.test");
  const b = await signup("b@example.test");
  const keyA = await passkey("a");
  const keyB = await passkey("b");

  // 11. a register challenge is bound to the account that asked for it
  const chA = await challenge("register", a.token);
  r = await register(b, keyB.register(chA));
  assert.equal(r.status, 400, "B registered with a challenge minted for A");
  assert.equal((await store.findUser(b.id))!.passkey, undefined);
  r = await register(a, keyA.register(chA));
  assert.equal(r.status, 400, "a challenge tried once on another account is spent, not handed back");
  console.log("11. a register challenge is not usable by another account, and a misused one is burned");

  // 12. a login challenge is not a register challenge
  r = await register(a, keyA.register(await challenge("login")));
  assert.equal(r.status, 400);
  console.log("12. a login challenge cannot register a passkey");

  // 13. an expired register challenge is refused
  {
    const ch = await challenge("register", a.token);
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000 + 1_000;
    try { r = await register(a, keyA.register(ch)); } finally { Date.now = realNow; }
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal((await store.findUser(a.id))!.passkey, undefined);
    console.log("13. a register challenge past its five minutes is refused");
  }

  // 14. foreign origin or RP id at registration is refused
  r = await register(a, keyA.register(await challenge("register", a.token), { origin: "https://evil.example" }));
  assert.equal(r.status, 400);
  r = await register(a, keyA.register(await challenge("register", a.token), { rpId: "evil.example" }));
  assert.equal(r.status, 400);
  assert.equal((await store.findUser(a.id))!.passkey, undefined);
  console.log("14. registration from another origin or for another RP id is refused");

  // 15. success spends the challenge
  const chOk = await challenge("register", a.token);
  r = await register(a, keyA.register(chOk));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const keyA2 = await passkey("a2");
  // With a valid step-up, so the replay reaches the challenge check: without
  // one, the missing step-up refuses it first and the challenge goes untested.
  r = await register(a, { ...keyA2.register(chOk), stepUp: await keyA.assert(await challenge("step_up", a.token, { action: "passkey.replace" })) });
  assert.equal(r.status, 400, `the challenge of a completed registration registered again: ${JSON.stringify(r.body)}`);
  assert.match(r.body.error, /unknown or expired challenge/, "refused for a reason other than the spent challenge");
  assert.equal((await store.findUser(a.id))!.passkey!.credentialId, keyA.credentialId);
  console.log("15. the challenge of a completed registration cannot be replayed");

  r = await register(b, keyB.register(await challenge("register", b.token)));
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // 16. replacing a passkey needs a step-up from THIS account's current
  // passkey, bound to passkey.replace on THIS account
  {
    const stepUp = async (token: string, key: typeof keyA, action = "passkey.replace") =>
      key.assert(await challenge("step_up", token, { action }));
    const replace = async (stepUpBody: unknown) =>
      register(a, { ...keyA2.register(await challenge("register", a.token)), stepUp: stepUpBody });
    r = await replace(undefined);
    assert.equal(r.status, 401, "no step-up");
    r = await replace(await stepUp(b.token, keyB));
    assert.equal(r.status, 403, "B's passkey approved A's replacement");
    r = await replace({ ...(await stepUp(b.token, keyA)), credentialId: keyA.credentialId });
    assert.equal(r.status, 401, "A's passkey over a challenge bound to B's account");
    r = await replace(await stepUp(a.token, keyA, "monerium.connect"));
    assert.equal(r.status, 401, "a step-up for another action approved the replacement");
    r = await replace(await keyA.assert(await challenge("login")));
    assert.equal(r.status, 401, "a login challenge stood in for a step-up");
    r = await replace(await keyA.assert(await challenge("step_up", a.token, { action: "passkey.replace" }), { origin: "https://evil.example" }));
    assert.equal(r.status, 401, "a step-up from another origin");
    assert.equal((await store.findUser(a.id))!.passkey!.credentialId, keyA.credentialId, "nothing replaced so far");
    const other = (await call("/passkey/login", await keyA.assert(await challenge("login")))).body.sessionToken as string;
    r = await replace(await stepUp(a.token, keyA));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await store.findUser(a.id))!.passkey!.credentialId, keyA2.credentialId);
    const stale = await fetch(`${base}/session`, { headers: { authorization: `Bearer ${other}` } });
    assert.equal(stale.status, 401, "a session minted before the swap outlived it");
    console.log("16. passkey replacement: only this account's current passkey, for this action, revokes other sessions");
  }

  // 17. login is bound to the credential's account, its RP, and an unspent
  // login challenge from an allowed origin
  {
    r = await call("/passkey/login", await keyA.assert(await challenge("login")));
    assert.equal(r.status, 404, "the replaced passkey still signs in");
    r = await call("/passkey/login", { ...(await keyB.assert(await challenge("login"))), credentialId: keyA2.credentialId });
    assert.equal(r.status, 401, "B's signature over A's credential id");
    const assertion = await keyB.assert(await challenge("login"));
    r = await call("/passkey/login", assertion);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, b.id, "a login signed by B's passkey answered as another account");
    r = await call("/passkey/login", assertion);
    assert.equal(r.status, 401, "a spent login challenge signed in again");
    r = await call("/passkey/login", await keyB.assert(await challenge("step_up", b.token, { action: "passkey.replace" })));
    assert.equal(r.status, 401, "a step-up challenge used to sign in");
    r = await call("/passkey/login", await keyB.assert(await challenge("login"), { origin: "https://evil.example" }));
    assert.equal(r.status, 401, "a login from another origin");
    r = await call("/passkey/login", await keyB.assert(await challenge("login"), { rpId: "evil.example" }));
    assert.equal(r.status, 401, "a login for another RP id");
    const ch = await challenge("login");
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000 + 1_000;
    try { r = await call("/passkey/login", await keyB.assert(ch)); } finally { Date.now = realNow; }
    assert.equal(r.status, 401, "an expired login challenge");
    console.log("17. login: right account, RP id, origin, purpose; once; within the TTL");
  }

  // 18. two signups on one email, finished at the same moment: one claimable
  // account (EMAIL_VERIFICATION off, so a passkey holds the address)
  {
    const c1 = await signup("twin@example.test");
    const c2 = await signup("Twin@Example.test ");
    const [k1, k2] = await Promise.all([passkey("t1"), passkey("t2")]);
    const [ch1, ch2] = await Promise.all([challenge("register", c1.token), challenge("register", c2.token)]);
    const rs = await Promise.all([register(c1, k1.register(ch1)), register(c2, k2.register(ch2))]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [201, 409], JSON.stringify(rs.map((x) => x.body)));
    assert.equal(rs.find((x) => x.status === 409)!.body.code, "EMAIL_IN_USE");
    assert.equal((await store.usersByEmail("twin@example.test")).filter((u) => u.passkey?.publicKey).length, 1);
    r = await call("/users", { name: "Third", email: "TWIN@example.test", country: "DE" });
    assert.equal(r.status, 409, "a third signup on the held address");
    console.log("18. parallel passkey completions on one email give one claimable account");
  }

  server.close();
}

console.log("\nWEBAUTHN SELF-TEST PASSED — 19/19");
