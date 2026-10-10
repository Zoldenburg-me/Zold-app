/**
 * Turnkey social guardians (backend only), offline: Turnkey is a stub.
 *
 * Proves the invariant the plan rests on, not just the happy path:
 *  - every sub-org payload has exactly one root user (the person), root
 *    quorum 1, no API key, no authenticator of ours, and one Ethereum
 *    account; anything else is refused before it can be sent;
 *  - an OIDC token is accepted only from Google or Apple, signed by a key
 *    they publish, for one of our OAuth client ids, unexpired, with its nonce
 *    bound to the browser's key; unreadable keys refuse the login;
 *  - a sub-org found by login is checked for the same shape on what
 *    Turnkey reports;
 *  - a Turnkey signature (v = 0/1) becomes a 65-byte signature with v 27/28
 *    that recovers to the signer;
 *  - the routes answer 404 while the switch is off, need the owner's
 *    session, refuse an account without its own Safe or with an imported
 *    one, never create a second sub-org for the same login (even from two
 *    users at once), and store only the address and the sub-org id;
 *  - adding the guardian on chain is a passkey-approved op the API prepares
 *    and submits: refused while a recovery is pending or while any other
 *    guardian is on the Safe (multi-guardian recovery is not built), and
 *    the row turns `active` only when the chain lists the address;
 *  - removing it is the same passkey-approved op (revokeGuardianWithThreshold),
 *    and the row goes only when the chain no longer lists the address;
 *  - Zoldenburg cannot be added while a Google/Apple guardian is on the Safe
 *    (either alone could then recover it);
 *  - source greps: no delegated access, no API key in a sub-org payload,
 *    only the Turnkey calls and activity types we chose, @turnkey/* imported
 *    by wallet/turnkey.ts alone, and no other network call there.
 *
 * What it cannot prove: anything about Turnkey itself. No request here
 * reaches api.turnkey.com.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as rsaSign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toFunctionSelector, toHex } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-turnkey-")), "db.json");
process.env.TURNKEY_GUARDIANS = "1";
process.env.TURNKEY_ORGANIZATION_ID = "org-parent-test";
// A throwaway P-256 key made for this run: never a real one.
const testKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }).d!;
process.env.TURNKEY_API_PRIVATE_KEY = Buffer.from(testKey, "base64url").toString("hex");
process.env.TURNKEY_OAUTH_CLIENT_IDS = "google-client.apps.googleusercontent.com,com.zoldhq.signin";
// Zoldenburg offered as a guardian too, to prove the two are never combined.
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = "0x8888888888888888888888888888888888888888";

const tk = await import("../services/api/src/wallet/turnkey.js");
const { createTurnkeyGuardianRouter } = await import("../services/api/src/routes/recovery-turnkey.js");
const { createZoldenburgRecoveryRouter, otherGuardianListed } = await import("../services/api/src/routes/recovery-zoldenburg.js");
const { store } = await import("../services/api/src/store.js");
const { capabilities } = await import("../services/api/src/capabilities.js");

let failed = 0;
let passed = 0;
const check = async (name: string, fn: () => unknown) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

// Turnkey's own example pair (docs.turnkey.com/authentication/social-logins):
// the nonce is sha256 over the public key's hex string.
const BROWSER_KEY = "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a"; // gitleaks:allow (public key from Turnkey's docs)
const BROWSER_NONCE = "1663bba492a323085b13895634a3618792c4ec6896f3c34ef3c26396df22ef82";
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An unsigned JWT, for the claims checks alone. */
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
// A stand-in for Google's signing key, published under kid "k1" by the JWKS stub.
const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const provider = rsa();
const stranger = rsa();
const signed = (claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) => {
  const head = `${b64url({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })}.${b64url(claims)}`;
  return `${head}.${rsaSign("RSA-SHA256", Buffer.from(head), opts.key ?? provider.privateKey).toString("base64url")}`;
};
const jwksCalls: { provider: string; fresh: boolean }[] = [];
let jwksDown = false;
const jwks = async (p: "Google" | "Apple", fresh = false) => {
  jwksCalls.push({ provider: p, fresh });
  if (jwksDown) throw new tk.TurnkeyGuardianError("cannot read keys", 503, "JWKS_UNAVAILABLE");
  return [{ ...provider.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }];
};
const googleClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: "google-client.apps.googleusercontent.com",
  sub: "1234567890",
  nonce: BROWSER_NONCE,
  exp: nowSec() + 600,
  ...over,
});

// ---------------------------------------------------------------------------
console.log("sub-org payload");

await check("the builder makes one root user with an OAuth login and nothing of ours", () => {
  const p = tk.buildGuardianSubOrg({ oidcToken: jwt(googleClaims()), providerName: "Google" });
  assert.equal(p.rootQuorumThreshold, 1);
  assert.equal(p.rootUsers.length, 1);
  const [u] = p.rootUsers;
  assert.deepEqual(u.apiKeys, []);
  assert.deepEqual(u.authenticators, []);
  assert.equal(u.oauthProviders.length, 1);
  assert.equal(u.oauthProviders[0].providerName, "Google");
  assert.equal(u.userEmail, undefined, "no email of the person is sent");
  assert.equal(u.userPhoneNumber, undefined);
  assert.equal(p.wallet?.accounts.length, 1);
  assert.equal(p.wallet?.accounts[0].addressFormat, "ADDRESS_FORMAT_ETHEREUM");
  assert.equal(p.wallet?.accounts[0].curve, "CURVE_SECP256K1");
  assert.equal(p.wallet?.accounts[0].path, "m/44'/60'/0'/0/0");
  assert.equal(p.verificationToken, undefined);
  assert.equal(p.clientSignature, undefined);
});

await check("the sub-org name carries no user id or email", () => {
  const a = tk.buildGuardianSubOrg({ oidcToken: jwt(googleClaims()), providerName: "Google" });
  const b = tk.buildGuardianSubOrg({ oidcToken: jwt(googleClaims()), providerName: "Google" });
  assert.match(a.subOrganizationName, /^zold-guardian-[0-9a-f]{32}$/);
  assert.notEqual(a.subOrganizationName, b.subOrganizationName);
});

const good = () => tk.buildGuardianSubOrg({ oidcToken: jwt(googleClaims()), providerName: "Google" });
const refused = (mutate: (p: ReturnType<typeof good>) => unknown, label: string) =>
  check(`the invariant refuses ${label}`, () => {
    const p = structuredClone(good());
    mutate(p);
    assert.throws(() => tk.assertPersonOnlySubOrg(p), /sub-org/);
  });
await refused((p) => p.rootUsers.push(structuredClone(p.rootUsers[0])), "a second root user");
await refused((p) => (p.rootUsers = []), "no root user");
await refused((p) => (p.rootQuorumThreshold = 2), "a root quorum other than 1");
await refused((p) => (p.rootQuorumThreshold = 0), "a root quorum of 0");
await refused(
  (p) => p.rootUsers[0].apiKeys.push({ apiKeyName: "zold", publicKey: "02".padEnd(66, "a"), curveType: "API_KEY_CURVE_P256" }),
  "an API key",
);
await refused((p) => (p.rootUsers[0].apiKeys = undefined as any), "a missing apiKeys list");
await refused((p) => p.rootUsers[0].authenticators.push({} as any), "an authenticator");
await refused((p) => (p.rootUsers[0].oauthProviders = []), "a root user with no login");
await refused((p) => p.rootUsers[0].oauthProviders.push(p.rootUsers[0].oauthProviders[0]), "two logins on one user");
await refused((p) => (p.wallet!.accounts = [...p.wallet!.accounts, p.wallet!.accounts[0]]), "two wallet accounts");
await refused((p) => (p.wallet = undefined), "no wallet");
await refused((p) => ((p as any).delegatedAccess = true), "an unknown field");
await refused((p) => (p.rootUsers[0].userEmail = "x@example.com"), "an email");

// ---------------------------------------------------------------------------
console.log("OIDC token");

await check("Turnkey's example: the nonce is sha256 over the key's hex string", () => {
  assert.equal(tk.oidcNonceFor(BROWSER_KEY), BROWSER_NONCE);
  assert.equal(createHash("sha256").update(BROWSER_KEY).digest("hex"), BROWSER_NONCE);
});

await check("a Google token for our client id, bound to the browser key, is accepted", () => {
  const r = tk.checkGuardianOidcToken(jwt(googleClaims()), BROWSER_KEY);
  assert.deepEqual(r, { providerName: "Google", issuer: "https://accounts.google.com", subject: "1234567890" });
});

await check("an Apple token is accepted; Apple's aud may be our services id", () => {
  const r = tk.checkGuardianOidcToken(jwt(googleClaims({ iss: "https://appleid.apple.com", aud: "com.zoldhq.signin" })), BROWSER_KEY);
  assert.equal(r.providerName, "Apple");
});

const badToken = (token: string, label: string, key = BROWSER_KEY) =>
  check(`a token is refused: ${label}`, () => {
    assert.throws(() => tk.checkGuardianOidcToken(token, key), (e: any) => e?.status === 400 && e?.code === "BAD_OIDC_TOKEN");
  });
await badToken(jwt(googleClaims({ iss: "https://zold.eu.auth0.com/" })), "an issuer we could run (Auth0)");
await badToken(jwt(googleClaims({ iss: "accounts.google.com" })), "Google's bare issuer spelling (one identity, one spelling)");
await badToken(jwt(googleClaims({ iss: "https://api.turnkey.com" })), "a Turnkey-issued token");
await badToken(jwt(googleClaims({ aud: "someone-elses-client" })), "another app's client id");
await badToken(jwt(googleClaims({ aud: "com.zoldhq.signin" })), "a Google token carrying our Apple services id");
await badToken(jwt(googleClaims({ aud: ["someone-elses-client", "google-client.apps.googleusercontent.com"] })), "a token for several audiences");
await badToken(jwt(googleClaims({ nonce: "00".repeat(32) })), "a nonce for another key");
await badToken(jwt(googleClaims({ nonce: undefined })), "no nonce");
await badToken(jwt(googleClaims({ exp: nowSec() - 1 })), "expired");
await badToken(jwt(googleClaims({ sub: "" })), "no subject");
await badToken("not-a-jwt", "not a JWT");
await badToken(jwt(googleClaims()), "a public key that is not compressed P-256 hex", "04abcd");

await check("a token signed by the provider's published key is accepted", async () => {
  const r = await tk.verifyGuardianOidcToken(signed(googleClaims()), BROWSER_KEY, jwks);
  assert.equal(r.subject, "1234567890");
});

const forged = (token: () => string, label: string) =>
  check(`a token is refused: ${label}`, async () => {
    await assert.rejects(tk.verifyGuardianOidcToken(token(), BROWSER_KEY, jwks), (e: any) => e?.status === 400 && e?.code === "BAD_OIDC_TOKEN");
  });
await forged(() => jwt(googleClaims()), "unsigned, with every claim right");
await forged(() => signed(googleClaims(), { key: stranger.privateKey }), "signed by another key under the provider's kid");
await forged(() => signed(googleClaims(), { alg: "HS256" }), "alg HS256");
await forged(() => signed(googleClaims(), { alg: "none" }), "alg none");
await forged(() => signed(googleClaims({ sub: "victim" })).replace(/\.([^.]+)\./, `.${b64url(googleClaims({ sub: "victim2" }))}.`), "claims changed after signing");

await check("an unknown kid refetches the keys once, then refuses", async () => {
  jwksCalls.length = 0;
  await assert.rejects(tk.verifyGuardianOidcToken(signed(googleClaims(), { kid: "k-rotated" }), BROWSER_KEY, jwks), (e: any) => e?.code === "BAD_OIDC_TOKEN");
  assert.deepEqual(jwksCalls, [{ provider: "Google", fresh: false }, { provider: "Google", fresh: true }]);
});

await check("keys that cannot be read refuse the login (fail closed)", async () => {
  jwksDown = true;
  try {
    await assert.rejects(tk.verifyGuardianOidcToken(signed(googleClaims()), BROWSER_KEY, jwks), (e: any) => e?.status === 503 && e?.code === "JWKS_UNAVAILABLE");
  } finally {
    jwksDown = false;
  }
});

// ---------------------------------------------------------------------------
console.log("found sub-org");

const person = { userId: "user-1", apiKeys: [] };
await check("a found sub-org with the person alone at quorum 1 passes", () => {
  tk.assertFoundSubOrg({ users: [person], rootQuorum: { threshold: 1, userIds: ["user-1"] } });
});
for (const [label, org] of [
  ["a second user", { users: [person, { userId: "user-2", apiKeys: [] }], rootQuorum: { threshold: 1, userIds: ["user-1"] } }],
  ["an API key on the person", { users: [{ userId: "user-1", apiKeys: [{}] }], rootQuorum: { threshold: 1, userIds: ["user-1"] } }],
  ["quorum 2", { users: [person], rootQuorum: { threshold: 2, userIds: ["user-1"] } }],
  ["a root quorum naming someone else", { users: [person], rootQuorum: { threshold: 1, userIds: ["user-9"] } }],
  ["no root quorum", { users: [person] }],
  ["no users", { users: [], rootQuorum: { threshold: 1, userIds: [] } }],
] as const) {
  await check(`a found sub-org is refused with ${label}`, () => {
    assert.throws(() => tk.assertFoundSubOrg(org as any), (e: any) => e?.code === "SUB_ORG_SHAPE");
  });
}

// ---------------------------------------------------------------------------
console.log("signature");

await check("Turnkey's r, s, v (v = 00/01) become a 65-byte signature with v 27/28 that recovers to the signer", async () => {
  const account = privateKeyToAccount(keccak256(toHex("turnkey-guardian-test")));
  const digest = keccak256(toHex("ExecuteRecovery digest stand-in"));
  const sig = await account.sign({ hash: digest });
  const r = sig.slice(2, 66);
  const s = sig.slice(66, 130);
  const v = parseInt(sig.slice(130, 132), 16) - 27; // Turnkey's recovery id
  const hex = tk.turnkeySignatureHex({ r, s, v: v.toString(16).padStart(2, "0") });
  assert.equal(hex, sig);
  assert.equal(await tk.recoverTurnkeySigner(digest, { r, s, v: `0${v}` }), account.address);
});

await check("a signature with v outside 0/1/27/28, or short r/s, is refused", () => {
  for (const bad of [
    { r: "11".repeat(32), s: "22".repeat(32), v: "02" },
    { r: "11".repeat(31), s: "22".repeat(32), v: "00" },
    { r: "11".repeat(32), s: "zz".repeat(32), v: "00" },
  ]) {
    assert.throws(() => tk.turnkeySignatureHex(bad), (e: any) => e?.code === "BAD_SIGNATURE", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
console.log("config");

await check("the API public key is derived from the private key as compressed P-256 hex", () => {
  assert.match(tk.turnkeyApiPublicKey(), /^0[23][0-9a-f]{64}$/);
});

await check("capabilities() publishes the switch and the two login client ids", () => {
  assert.equal(capabilities().turnkeyGuardians, true);
  assert.deepEqual(capabilities().turnkeyLogins, { google: "google-client.apps.googleusercontent.com", apple: "com.zoldhq.signin" });
});

// ---------------------------------------------------------------------------
console.log("routes");

const now = new Date().toISOString();
const addr = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;
const pk = { x: "0x01", y: "0x02" };
const baseUser = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, email: `${id}@example.com`, country: "DE", kycStatus: "approved", iban: "", address: addr("a"), createdAt: now, ...extra,
});
store.addUser(baseUser("u_ok", { passkeySafe: { address: addr("a"), status: "active", threshold: 1, passkeyPublicKey: pk, createdAt: now } }) as any);
store.addUser(baseUser("u_nosafe") as any);
store.addUser(baseUser("u_twin", { address: addr("c"), passkeySafe: { address: addr("c"), status: "active", threshold: 1, passkeyPublicKey: pk, createdAt: now } }) as any);
store.addUser(baseUser("u_imported", { passkeySafe: { address: addr("b"), status: "active", threshold: 1, passkeyPublicKey: pk, createdAt: now, importedAt: now } }) as any);

const calls: { op: string; arg?: unknown }[] = [];
let createGate: Promise<void> = Promise.resolve();
const subOrgs = new Map<string, { id: string; address: `0x${string}` }>(); // by OIDC subject
const subjectOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).sub as string;
const stub: import("../services/api/src/wallet/turnkey.js").TurnkeyGuardianClient = {
  async subOrgIdsForOidcToken(t) {
    calls.push({ op: "find", arg: t });
    const s = subOrgs.get(subjectOf(t));
    return s ? [s.id] : [];
  },
  async createSubOrg(p) {
    calls.push({ op: "create", arg: p });
    await createGate;
    const id = `sub-${subOrgs.size + 1}`;
    const address = addr(String(subOrgs.size + 1));
    subOrgs.set(subjectOf(p.rootUsers[0].oauthProviders[0].oidcToken!), { id, address });
    return { subOrgId: id, address };
  },
  async walletAddress(subOrgId) {
    calls.push({ op: "address", arg: subOrgId });
    for (const s of subOrgs.values()) if (s.id === subOrgId) return s.address;
    throw new Error("unknown sub-org");
  },
  async oauthLogin(subOrgId, _oidcToken, publicKey) {
    calls.push({ op: "login", arg: { subOrgId, publicKey } });
    return `session-for-${subOrgId}`;
  },
};

// The Safe side: the module's state as the chain would report it, and the
// bundler. Recorded so a test can see what was prepared and submitted.
type SafeOps = import("../services/api/src/routes/recovery-turnkey.js").TurnkeyGuardianSafeOps;
const chain = { guardians: [] as `0x${string}`[], moduleEnabled: false, pending: false, listAfterSubmit: true, revert: false };
const safeCalls: { op: string; arg?: any }[] = [];
const MODULE = addr("9");
const safeOps: SafeOps = {
  async readState() {
    safeCalls.push({ op: "read" });
    return { moduleAddress: MODULE, moduleEnabled: chain.moduleEnabled, guardians: [...chain.guardians], threshold: chain.guardians.length ? 1 : 0,
      pending: chain.pending ? { newOwners: [addr("e")], newThreshold: 1, executeAfter: 1 } : null };
  },
  async revokeTx(_plan, state, address) {
    safeCalls.push({ op: "revokeTx", arg: { address, guardians: state.guardians } });
    return { to: MODULE, value: 0n, data: `${toFunctionSelector("revokeGuardianWithThreshold(address,address,uint256)")}${"0".repeat(24)}${"1".padStart(40, "0")}${"0".repeat(24)}${address.slice(2)}${"0".repeat(64)}` };
  },
  async prepare(_plan, txs) {
    safeCalls.push({ op: "prepare", arg: txs });
    return { userOperation: { txs }, challenge: `0x${"ab".repeat(32)}` };
  },
  async checkAssertion(user, body, _challenge, res) {
    safeCalls.push({ op: "assert", arg: body });
    if ((body as any)?.signature !== "good") {
      res.status(401).json({ error: "passkey approval refused" });
      return undefined;
    }
    return user;
  },
  async submit(_plan, userOperation) {
    safeCalls.push({ op: "submit", arg: userOperation });
    if (chain.revert) return { success: false, txHash: "0xdead" };
    const REVOKE = toFunctionSelector("revokeGuardianWithThreshold(address,address,uint256)");
    for (const tx of userOperation.txs) {
      if (tx.data.startsWith(REVOKE)) {
        chain.guardians = chain.guardians.filter((g) => !tx.data.toLowerCase().includes(g.slice(2).toLowerCase()));
        continue;
      }
      const hit = /^0x[0-9a-f]+$/i.test(tx.data) && [addr("1"), addr("2")].find((a) => tx.data.toLowerCase().includes(a.slice(2).toLowerCase()));
      if (hit && chain.listAfterSubmit) chain.guardians.push(hit);
    }
    return { success: true, txHash: "0xfeed", userOpHash: "0xbeef" };
  },
};

let switchOn = true;
// The session stub stands in for server.ts: the header names the signed-in user.
const requireUserSession = (req: express.Request, res: express.Response, userId: string) => {
  if (req.get("x-test-user") === userId) return true;
  res.status(401).json({ error: "sign in" });
  return false;
};
const app = express();
app.use(express.json());
app.use("/api", createTurnkeyGuardianRouter({ requireUserSession, client: () => stub, enabled: () => switchOn, jwks, safeOps }));
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: String(err?.message ?? err) });
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api/recovery/turnkey`;
const call = async (method: string, p: string, body?: unknown, user?: string) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const addBody = (claims = googleClaims()) => ({ oidcToken: signed(claims), publicKey: BROWSER_KEY });

try {
  await check("switch off: every route answers 404 TURNKEY_OFF", async () => {
    switchOn = false;
    for (const [m, p] of [["GET", "/users/u_ok/guardians"], ["POST", "/users/u_ok/guardians"], ["POST", "/login"]] as const) {
      const r = await call(m, p, m === "POST" ? addBody() : undefined, "u_ok");
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.code, "TURNKEY_OFF");
    }
    switchOn = true;
    assert.equal(calls.length, 0, "nothing reached Turnkey");
  });

  await check("another user's session is refused", async () => {
    const r = await call("POST", "/users/u_ok/guardians", addBody(), "u_nosafe");
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  });

  await check("an unknown user is a 404", async () => {
    const r = await call("POST", "/users/u_ghost/guardians", addBody(), "u_ghost");
    assert.equal(r.status, 404);
  });

  await check("an account without its own Safe is refused before Turnkey is called", async () => {
    const r = await call("POST", "/users/u_nosafe/guardians", addBody(), "u_nosafe");
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "NO_SAFE");
    assert.equal(calls.length, 0);
  });

  await check("an imported Safe is not offered a guardian", async () => {
    const r = await call("POST", "/users/u_imported/guardians", addBody(), "u_imported");
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "IMPORTED_SAFE");
    assert.equal(calls.length, 0);
  });

  await check("a bad token is refused before Turnkey is called", async () => {
    const r = await call("POST", "/users/u_ok/guardians", addBody(googleClaims({ nonce: "00".repeat(32) })), "u_ok");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "BAD_OIDC_TOKEN");
    assert.equal(calls.length, 0);
  });

  await check("a good login creates one sub-org and stores only its id and address, not yet a guardian", async () => {
    const r = await call("POST", "/users/u_ok/guardians", addBody(), "u_ok");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(calls.map((c) => c.op), ["find", "create"]);
    tk.assertPersonOnlySubOrg(calls[1].arg as any);
    assert.deepEqual(Object.keys(r.body.guardian).sort(), ["address", "createdAt", "kind", "status", "turnkeySubOrgId"]);
    assert.equal(r.body.guardian.kind, "self-social");
    assert.equal(r.body.guardian.status, "created");
    const stored = store.findUser("u_ok")!.passkeySafe!.socialGuardians!;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].address, addr("1"));
    assert.equal(stored[0].turnkeySubOrgId, "sub-1");
    assert.ok(!JSON.stringify(store.findUser("u_ok")).includes("accounts.google.com"), "no token or issuer stored");
  });

  await check("the same login again reuses its sub-org: no second create, no duplicate row", async () => {
    calls.length = 0;
    const r = await call("POST", "/users/u_ok/guardians", addBody(), "u_ok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.map((c) => c.op), ["find", "address"]);
    assert.equal(store.findUser("u_ok")!.passkeySafe!.socialGuardians!.length, 1);
  });

  await check("the owner can list their guardians", async () => {
    const r = await call("GET", "/users/u_ok/guardians", undefined, "u_ok");
    assert.equal(r.status, 200);
    assert.equal(r.body.guardians.length, 1);
    assert.equal(r.body.guardians[0].address, addr("1"));
  });

  await check("login: a known login gets a Turnkey session for its own sub-org, bound to the browser key", async () => {
    calls.length = 0;
    const r = await call("POST", "/login", addBody());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session, "session-for-sub-1");
    assert.equal(r.body.subOrgId, "sub-1");
    assert.deepEqual(calls.at(-1), { op: "login", arg: { subOrgId: "sub-1", publicKey: BROWSER_KEY } });
  });

  await check("login: an unknown login is a 404 and creates nothing", async () => {
    calls.length = 0;
    const r = await call("POST", "/login", addBody(googleClaims({ sub: "999" })));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "NO_GUARDIAN");
    assert.ok(!calls.some((c) => c.op === "create" || c.op === "login"));
  });

  await check("login: a forged token naming a known guardian is refused before Turnkey is called (no oracle)", async () => {
    calls.length = 0;
    const r = await call("POST", "/login", { oidcToken: jwt(googleClaims()), publicKey: BROWSER_KEY });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "BAD_OIDC_TOKEN");
    assert.equal(calls.length, 0);
  });

  await check("login: unreadable provider keys answer 503 and Turnkey is not called", async () => {
    calls.length = 0;
    jwksDown = true;
    try {
      const r = await call("POST", "/login", addBody());
      assert.equal(r.status, 503);
      assert.equal(r.body.code, "JWKS_UNAVAILABLE");
      assert.equal(calls.length, 0);
    } finally {
      jwksDown = false;
    }
  });

  await check("two users adding the same new login at once make one sub-org; the second is told to wait", async () => {
    calls.length = 0;
    let open!: () => void;
    createGate = new Promise((r) => (open = r));
    const claims = googleClaims({ sub: "777" });
    const first = call("POST", "/users/u_ok/guardians", addBody(claims), "u_ok");
    while (!calls.some((c) => c.op === "create")) await new Promise((r) => setTimeout(r, 5));
    const second = await call("POST", "/users/u_twin/guardians", addBody(claims), "u_twin");
    open();
    createGate = Promise.resolve();
    assert.equal((await first).status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "BUSY");
    assert.equal(calls.filter((c) => c.op === "create").length, 1);
    const again = await call("POST", "/users/u_twin/guardians", addBody(claims), "u_twin");
    assert.equal(again.status, 201, "after the first finishes, the second finds the same sub-org");
    assert.equal(calls.filter((c) => c.op === "create").length, 1);
  });

  // ---- adding the guardian on chain ----------------------------------------
  store.updateUser("u_ok", { passkey: { credentialId: "cred-ok", rpId: "localhost", publicKey: { kty: "EC" }, createdAt: now } as any });
  const sub1 = () => store.findUser("u_ok")!.passkeySafe!.socialGuardians!.find((g) => g.turnkeySubOrgId === "sub-1")!;

  await check("add on chain: another user's session is refused", async () => {
    const r = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_twin");
    assert.equal(r.status, 401);
  });

  await check("add on chain: an unknown sub-org is a 404", async () => {
    const r = await call("POST", "/users/u_ok/guardians/sub-404/add", {}, "u_ok");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "NO_GUARDIAN");
  });

  await check("add on chain: refused while a recovery is pending", async () => {
    chain.pending = true;
    try {
      const r = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "RECOVERY_PENDING");
    } finally {
      chain.pending = false;
    }
  });

  await check("add on chain: refused while any other guardian is on the Safe (Zoldenburg alone could then not recover it)", async () => {
    chain.guardians = [addr("8")];
    chain.moduleEnabled = true;
    safeCalls.length = 0;
    try {
      const r = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "OTHER_GUARDIAN");
      assert.ok(!safeCalls.some((c) => c.op === "prepare"), "nothing prepared");
    } finally {
      chain.guardians = [];
      chain.moduleEnabled = false;
    }
  });

  let requestId = "";
  await check("add on chain: prepares enable-module + addGuardianWithThreshold(address, 1) for the passkey to approve", async () => {
    safeCalls.length = 0;
    const r = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const txs = safeCalls.find((c) => c.op === "prepare")!.arg as { to: string; data: string }[];
    assert.equal(txs.length, 2, "the module is enabled first on a Safe that never had one");
    const add = txs[1].data.toLowerCase();
    assert.ok(add.includes(addr("1").slice(2)), "the guardian is the sub-org's address");
    assert.ok(add.endsWith("1".padStart(64, "0")), "threshold 1");
    assert.equal(r.body.credentialId, "cred-ok");
    assert.equal(r.body.rpId, "localhost");
    assert.match(r.body.challenge, /^[A-Za-z0-9_-]+$/);
    assert.equal(r.body.submitTo, `/api/recovery/turnkey/users/u_ok/ops/${r.body.requestId}`);
    requestId = r.body.requestId;
    assert.equal(sub1().status, "created", "nothing is active before the chain says so");
  });

  await check("add on chain: preparing again replaces the earlier op (one pending op per user)", async () => {
    const again = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
    assert.equal(again.status, 201);
    const old = await call("POST", `/users/u_ok/ops/${requestId}`, { signature: "good" }, "u_ok");
    assert.equal(old.status, 404, "the first op is gone");
    requestId = again.body.requestId;
  });

  await check("add on chain: a guardian or recovery that appeared after preparing refuses the submit", async () => {
    for (const [label, set, code] of [
      ["another guardian", () => { chain.guardians = [addr("8")]; chain.moduleEnabled = true; }, "OTHER_GUARDIAN"],
      ["a pending recovery", () => { chain.pending = true; }, "RECOVERY_PENDING"],
    ] as const) {
      const prep = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
      assert.equal(prep.status, 201, label);
      set();
      safeCalls.length = 0;
      const r = await call("POST", `/users/u_ok/ops/${prep.body.requestId}`, { signature: "good" }, "u_ok");
      chain.guardians = []; chain.moduleEnabled = false; chain.pending = false;
      assert.equal(r.status, 409, label);
      assert.equal(r.body.code, code, label);
      assert.ok(!safeCalls.some((c) => c.op === "submit"), `${label}: nothing submitted`);
    }
    const fresh = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
    requestId = fresh.body.requestId;
  });

  await check("add on chain: a refused passkey approval submits nothing", async () => {
    safeCalls.length = 0;
    const r = await call("POST", `/users/u_ok/ops/${requestId}`, { signature: "bad" }, "u_ok");
    assert.equal(r.status, 401);
    assert.ok(!safeCalls.some((c) => c.op === "submit"));
  });

  await check("add on chain: another user cannot submit the op", async () => {
    const r = await call("POST", `/users/u_twin/ops/${requestId}`, { signature: "good" }, "u_twin");
    assert.equal(r.status, 404);
  });

  await check("add on chain: approved and listed by the chain, the guardian turns active", async () => {
    safeCalls.length = 0;
    const r = await call("POST", `/users/u_ok/ops/${requestId}`, { signature: "good" }, "u_ok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.guardian.status, "active");
    assert.equal(sub1().status, "active");
    assert.ok(sub1().activeAt);
    assert.deepEqual(safeCalls.map((c) => c.op), ["assert", "read", "submit", "read"], "the chain is re-checked before submitting and read after, not trusted");
  });

  await check("add on chain: a used request id is gone", async () => {
    const r = await call("POST", `/users/u_ok/ops/${requestId}`, { signature: "good" }, "u_ok");
    assert.equal(r.status, 404);
  });

  await check("add on chain: a guardian the chain already lists turns active without an op", async () => {
    store.updateUser("u_ok", { passkeySafe: { ...store.findUser("u_ok")!.passkeySafe!, socialGuardians: [{ ...sub1(), status: "created", activeAt: undefined }] } });
    safeCalls.length = 0;
    const r = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.guardian.status, "active");
    assert.ok(!safeCalls.some((c) => c.op === "prepare"));
  });

  await check("add on chain: a reverted op, or one the chain does not show, leaves the guardian `created`", async () => {
    // u_twin owns sub-org "sub-2" (subject 777) from the parallel-add check.
    store.updateUser("u_twin", { passkey: { credentialId: "cred-twin", rpId: "localhost", publicKey: { kty: "EC" }, createdAt: now } as any });
    chain.guardians = [];
    chain.moduleEnabled = true;
    const twin = () => store.findUser("u_twin")!.passkeySafe!.socialGuardians![0];
    for (const [label, set] of [["reverted", () => (chain.revert = true)], ["not listed", () => (chain.listAfterSubmit = false)]] as const) {
      const prep = await call("POST", `/users/u_twin/guardians/${twin().turnkeySubOrgId}/add`, {}, "u_twin");
      assert.equal(prep.status, 201, `${label}: ${JSON.stringify(prep.body)}`);
      set();
      const r = await call("POST", `/users/u_twin/ops/${prep.body.requestId}`, { signature: "good" }, "u_twin");
      chain.revert = false;
      chain.listAfterSubmit = true;
      assert.equal(r.status, 502, label);
      assert.equal(twin().status, "created", label);
    }
    chain.guardians = [];
    chain.moduleEnabled = false;
  });

  await check("add on chain: switch off answers 404 on both routes", async () => {
    switchOn = false;
    try {
      for (const p of ["/users/u_ok/guardians/sub-1/add", "/users/u_ok/ops/x"]) {
        const r = await call("POST", p, {}, "u_ok");
        assert.equal(r.status, 404, p);
        assert.equal(r.body.code, "TURNKEY_OFF");
      }
    } finally {
      switchOn = true;
    }
  });

  // ---- one guardian at a time, and removing the Google/Apple one ------------
  await check("Zoldenburg is refused while a Google/Apple guardian is on the account", async () => {
    store.updateUser("u_ok", { passkeySafe: { ...store.findUser("u_ok")!.passkeySafe!, socialGuardians: [{ ...sub1(), status: "active" }] } });
    const r = await fetch(`${base.replace("/recovery/turnkey", "")}/users/u_ok/recovery/zoldenburg`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-user": "u_ok" }, body: JSON.stringify({ acknowledged: true }),
    });
    const body: any = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(body.code, "OTHER_GUARDIAN");
  });

  await check("remove: refused while a recovery is pending", async () => {
    chain.guardians = [addr("1")];
    chain.moduleEnabled = true;
    chain.pending = true;
    try {
      const r = await call("POST", "/users/u_ok/guardians/sub-1/remove", {}, "u_ok");
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "RECOVERY_PENDING");
    } finally {
      chain.pending = false;
    }
  });

  await check("remove: the passkey approves revokeGuardianWithThreshold, and the row goes once the chain drops it", async () => {
    safeCalls.length = 0;
    const prep = await call("POST", "/users/u_ok/guardians/sub-1/remove", {}, "u_ok");
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    assert.deepEqual(safeCalls.find((c) => c.op === "revokeTx")?.arg, { address: addr("1"), guardians: [addr("1")] });
    assert.ok(sub1(), "nothing changes before the passkey approves");
    const r = await call("POST", `/users/u_ok/ops/${prep.body.requestId}`, { signature: "good" }, "u_ok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removed, true);
    assert.equal(store.findUser("u_ok")!.passkeySafe!.socialGuardians!.length, 0);
    assert.deepEqual(chain.guardians, []);
  });

  await check("remove: a row the chain never listed goes without an op", async () => {
    store.updateUser("u_ok", { passkeySafe: { ...store.findUser("u_ok")!.passkeySafe!, socialGuardians: [{ kind: "self-social", address: addr("1"), turnkeySubOrgId: "sub-1", status: "created", createdAt: now }] } });
    safeCalls.length = 0;
    const r = await call("POST", "/users/u_ok/guardians/sub-1/remove", {}, "u_ok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removed, true);
    assert.ok(!safeCalls.some((c) => c.op === "prepare"));
    assert.equal(store.findUser("u_ok")!.passkeySafe!.socialGuardians!.length, 0);
  });

  await check("remove: dropping a row the chain never listed also drops its prepared add", async () => {
    store.updateUser("u_ok", { passkeySafe: { ...store.findUser("u_ok")!.passkeySafe!, socialGuardians: [{ kind: "self-social", address: addr("1"), turnkeySubOrgId: "sub-1", status: "created", createdAt: now }] } });
    chain.guardians = [];
    chain.moduleEnabled = true;
    const prep = await call("POST", "/users/u_ok/guardians/sub-1/add", {}, "u_ok");
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    const gone = await call("POST", "/users/u_ok/guardians/sub-1/remove", {}, "u_ok");
    assert.equal(gone.body.removed, true);
    safeCalls.length = 0;
    const r = await call("POST", `/users/u_ok/ops/${prep.body.requestId}`, { signature: "good" }, "u_ok");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.ok(!safeCalls.some((c) => c.op === "submit"), "the stale add never reaches the chain");
    assert.deepEqual(chain.guardians, []);
  });

  await check("Zoldenburg's chain check: any guardian but Zoldenburg and the account's own email/SMS one is another guardian", () => {
    const z = addr("a");
    const candide = addr("c");
    assert.equal(otherGuardianListed([], z, candide), false);
    assert.equal(otherGuardianListed([z.toUpperCase().replace("0X", "0x") as `0x${string}`], z, candide), false);
    assert.equal(otherGuardianListed([z, candide], z, candide), false);
    assert.equal(otherGuardianListed([z, addr("1")], z, candide), true);
    assert.equal(otherGuardianListed([addr("1")], z, undefined), true);
  });

  await check("login: a bad token is refused before Turnkey is called", async () => {
    calls.length = 0;
    const r = await call("POST", "/login", addBody(googleClaims({ exp: nowSec() - 5 })));
    assert.equal(r.status, 400);
    assert.equal(calls.length, 0);
  });
} finally {
  server.close();
}

// ---------------------------------------------------------------------------
console.log("source greps");

const SRC = path.join(ROOT, "services/api/src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const turnkeyFiles = ["wallet/turnkey.ts", "routes/recovery-turnkey.ts", "config/turnkey.ts"];
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

await check("the Turnkey files are readable (a zero count below means something)", () => {
  for (const f of turnkeyFiles) assert.ok(read(f).length > 200, f);
});

await check("no delegated access anywhere in the Turnkey code", () => {
  for (const f of turnkeyFiles) assert.doesNotMatch(code(f), /delegat/i, f);
});

await check("the only apiKeys in a sub-org payload is the empty list", () => {
  for (const f of turnkeyFiles) {
    const uses = code(f).match(/apiKeys\s*:[^,}\n]*/g) ?? [];
    for (const u of uses) assert.match(u, /^apiKeys\s*:\s*\[\s*\]$/, `${f}: ${u}`);
  }
});

await check("the backend uses only the Turnkey calls and activity types it needs: no signing, keys, users, policies or quorum", () => {
  const w = code("wallet/turnkey.ts");
  const methods = new Set([...w.matchAll(/\bhttp\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...methods].sort(), ["createSubOrganization", "getOrganization", "getSubOrgIds", "getWalletAccounts", "getWallets", "oauthLogin"]);
  const activities = new Set([...turnkeyFiles.map(code).join("\n").matchAll(/ACTIVITY_TYPE_\w+/g)].map((m) => m[0]));
  assert.deepEqual([...activities].sort(), ["ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8", "ACTIVITY_TYPE_OAUTH_LOGIN"]);
});

await check("@turnkey/* is imported by wallet/turnkey.ts alone", () => {
  const importers = walk(SRC).filter((p) => /from\s+["']@turnkey\//.test(readFileSync(p, "utf8")));
  assert.deepEqual(importers.map((p) => path.relative(SRC, p)), ["wallet/turnkey.ts"]);
});

await check("the only other network call in the Turnkey code reads the providers' published keys", () => {
  assert.doesNotMatch(code("routes/recovery-turnkey.ts") + code("config/turnkey.ts"), /\bfetch\s*\(/);
  const fetches = [...code("wallet/turnkey.ts").matchAll(/\bfetch\s*\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["JWKS_URLS[provider]"]);
});

await check("wallet/turnkey.ts is the only file that creates a sub-org, and only through the builder", () => {
  const creators = walk(SRC).filter((p) => /createSubOrganization\b/.test(readFileSync(p, "utf8")));
  assert.deepEqual(creators.map((p) => path.relative(SRC, p)), ["wallet/turnkey.ts"]);
  const w = code("wallet/turnkey.ts");
  const body = w.slice(w.indexOf("createSubOrganization"));
  assert.match(body.slice(0, 400), /assertPersonOnlySubOrg/, "the create call asserts the payload right before sending it");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
