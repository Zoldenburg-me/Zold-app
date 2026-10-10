/**
 * Recovery with a Turnkey guardian, offline: the chain is a stub, the
 * guardian key a local account standing in for the Turnkey wallet, the new
 * passkey a software one.
 *
 * Proves, not just the happy path:
 *  - only an account whose Safe has an active Google/Apple guardian can
 *    start one; a request is resumed only with its secret; a stranger who
 *    knows the email cannot lock the owner out (parallel requests, at most
 *    five open, none while a recovery is on chain);
 *  - nothing is relayed until the owner's "someone asked" alert has gone out
 *    (fail closed: no mail, no relay);
 *  - the new passkey waits on the request, never on the account, until the
 *    chain shows it as the owner;
 *  - a signature is accepted only from the guardian recorded on the request,
 *    over the digest recomputed from the module (refused on a mismatch),
 *    while the module still lists that guardian at threshold 1 and holds no
 *    other recovery; then it is relayed with v 27/28 and the grace period
 *    comes from the chain;
 *  - finalise binds the new passkey only once the owners match; the sweep
 *    expires and finalises; the owner sees an open request and can cancel it;
 *  - the alert mail, the on-chain cancel and the public view cover the mode.
 *
 * What it cannot prove: a real Turnkey signature, the relayed transaction,
 * or the module's grace period. No chain runs here.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import { makeSoftwarePasskey } from "./_software-passkey.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-turnkey-recovery-")), "db.json");

const { createTurnkeyRecoveryRouter } = await import("../services/api/src/routes/recovery-turnkey-requests.js");
const { sweepTurnkeyRecoveries } = await import("../services/api/src/recovery/turnkey-recovery.js");
const { recoveryTypedData, recoveryDigest } = await import("../services/api/src/recovery/zoldenburg-guardian.js");
const { publicRecoveryRequest } = await import("../services/api/src/recovery.js");
const { store } = await import("../services/api/src/store.js");
type Chain = import("../services/api/src/recovery/turnkey-recovery.js").TurnkeyRecoveryChain;

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

const ORIGIN = "http://localhost:3000";
const addr = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;
const MODULE = addr("9");
const SAFE = addr("a");
const guardian = privateKeyToAccount(keccak256(toHex("turnkey-recovery-guardian")));
const stranger = privateKeyToAccount(keccak256(toHex("turnkey-recovery-stranger")));
const now = new Date().toISOString();

const passkey = (label: string) => ({ credentialId: label, rpId: "localhost", publicKey: { jwk: { kty: "EC" }, alg: "ES256" }, signCount: 0, createdAt: now });
const safe = (extra: Record<string, unknown> = {}) => ({ address: SAFE, status: "active", threshold: 1, passkeyPublicKey: { x: "0x01", y: "0x02" }, createdAt: now, ...extra });
const tkGuardian = (status = "active", address: `0x${string}` = guardian.address) => ({ kind: "self-social", address, turnkeySubOrgId: "sub-1", status, createdAt: now, activeAt: now });
const user = (id: string, extra: Record<string, unknown>) => ({
  id, name: id, email: `${id}@example.com`, country: "DE", kycStatus: "approved", iban: "", address: SAFE, createdAt: now, passkey: passkey(`old-${id}`), ...extra,
});
store.addUser(user("u_rec", { passkeySafe: safe({ socialGuardians: [tkGuardian()] }) }) as any);
store.addUser(user("u_none", { passkeySafe: safe() }) as any);
store.addUser(user("u_created", { passkeySafe: safe({ socialGuardians: [tkGuardian("created")] }) }) as any);
store.addUser(user("u_imported", { passkeySafe: safe({ importedAt: now, socialGuardians: [tkGuardian()] }) }) as any);

// ---- the chain, as the module would answer ---------------------------------
const chainState = {
  guardians: [guardian.address] as `0x${string}`[],
  threshold: 1,
  pending: null as null | { newOwners: `0x${string}`[]; newThreshold: number; executeAfter: number },
  owners: [addr("e")] as string[],
  digestOff: false,
};
const relayed: { td: any; signer: string; signature: Hex }[] = [];
const finalized: string[] = [];
const verifiers: unknown[] = [];
const GRACE_END = Math.floor(Date.now() / 1000) + 3600;
const chain: Chain = {
  async readState() {
    return { moduleAddress: MODULE, moduleEnabled: true, guardians: [...chainState.guardians], threshold: chainState.threshold, pending: chainState.pending };
  },
  async nonce() { return 0n; },
  async onChainDigest(td) { return chainState.digestOff ? (`0x${"00".repeat(32)}` as Hex) : recoveryDigest(td); },
  async relayRecovery(td, signer, signature) {
    relayed.push({ td, signer, signature });
    chainState.pending = { newOwners: td.message.newOwners, newThreshold: Number(td.message.newThreshold), executeAfter: GRACE_END };
    return { txHash: `0x${"5a".repeat(32)}` as `0x${string}` };
  },
  async relayFinalize(_module, safeAddress) {
    finalized.push(safeAddress);
    if (chainState.pending) chainState.owners = chainState.pending.newOwners;
    return { txHash: `0x${"f1".repeat(32)}` as `0x${string}` };
  },
  async safeOwners() { return [...chainState.owners] as `0x${string}`[]; },
  async deployVerifier(owner) { verifiers.push(owner); return "0xverifier"; },
};

let switchOn = true;
const requireUserSession = (req: express.Request, res: express.Response, userId: string) => {
  if (req.get("x-test-user") === userId) return true;
  res.status(401).json({ error: "sign in" });
  return false;
};
const app = express();
app.use(express.json());
let mailOn = true;
const ownerAlerted = (r: any) => mailOn && Boolean(r.ownerAlerts?.requested);
const markAlerted = (rid: string) => store.updateRecoveryRequest(rid, { ownerAlerts: { requested: new Date().toISOString() } });
app.use("/api", createTurnkeyRecoveryRouter({ requireUserSession, enabled: () => switchOn, chain, ownerAlerted }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
/** Turnkey's answer shape: r, s and v (the recovery id 00/01), hex without 0x. */
const turnkeySign = async (account: typeof guardian, digest: Hex) => {
  const sig = await account.sign({ hash: digest });
  return { r: sig.slice(2, 66), s: sig.slice(66, 130), v: (parseInt(sig.slice(130, 132), 16) - 27).toString(16).padStart(2, "0") };
};

try {
  console.log("starting");

  await check("switch off: the routes answer 404 TURNKEY_OFF", async () => {
    switchOn = false;
    try {
      const r = await call("POST", "/recovery/turnkey/requests", { email: "u_rec@example.com" });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "TURNKEY_OFF");
    } finally {
      switchOn = true;
    }
  });

  await check("only an account with an active Google/Apple guardian on its own Safe can start", async () => {
    for (const email of ["nobody@example.com", "u_none@example.com", "u_created@example.com", "u_imported@example.com"]) {
      const r = await call("POST", "/recovery/turnkey/requests", { email });
      assert.equal(r.status, 404, email);
    }
  });

  let id = "";
  let secret = "";
  let challenge = "";
  await check("start: a secret once, the request PASSKEY_PENDING for the guardian on the account", async () => {
    const r = await call("POST", "/recovery/turnkey/requests", { email: "u_rec@example.com" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.mode, "turnkey");
    assert.equal(r.body.status, "PASSKEY_PENDING");
    assert.equal(r.body.guardianAddress, guardian.address);
    assert.equal(r.body.recoveryModuleAddress.toLowerCase(), MODULE.toLowerCase());
    assert.match(r.body.recoverySecret, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.body.submitTo, `/api/recovery/turnkey/requests/${r.body.id}/passkey`);
    assert.equal(r.body.turnkey?.accessHash, undefined, "the secret's hash never leaves");
    ({ id, recoverySecret: secret, registerChallenge: challenge } = r.body);
  });

  const auth = () => ({ "x-recovery-secret": secret });

  let strangerId = "";
  await check("a second start without the secret is a separate request (a stranger cannot lock the owner out); with it, the same request resumes", async () => {
    const r = await call("POST", "/recovery/turnkey/requests", { email: "u_rec@example.com" });
    assert.equal(r.status, 201);
    assert.notEqual(r.body.id, id);
    strangerId = r.body.id;
    const again = await call("POST", "/recovery/turnkey/requests", { email: "u_rec@example.com", recoverySecret: secret });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, id);
    assert.equal(again.body.recoverySecret, undefined, "the secret is handed out once");
    challenge = again.body.registerChallenge;
  });

  await check("a request id without its secret is a 404", async () => {
    assert.equal((await call("GET", `/recovery/turnkey/requests/${id}`)).status, 404);
    assert.equal((await call("GET", `/recovery/turnkey/requests/${id}`, undefined, { "x-recovery-secret": "nope" })).status, 404);
  });

  await check("the digest is not offered before the new passkey exists", async () => {
    const r = await call("GET", `/recovery/turnkey/requests/${id}/digest`, undefined, auth());
    assert.equal(r.status, 409);
  });

  const newKey = await makeSoftwarePasskey("turnkey-recovery-new", ORIGIN);
  await check("the new passkey is held on the request, not the account, and never shown", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/passkey`, newKey.register(challenge), auth());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "REVIEW_PENDING");
    assert.equal(r.body.turnkey.newPasskeyRegistered, true);
    assert.equal(r.body.turnkey.newPasskey, undefined);
    assert.equal(store.findUser("u_rec")!.passkey!.credentialId, "old-u_rec", "the account keeps its passkey");
    assert.equal(store.findRecoveryRequest(id)!.turnkey!.newOwners!.length, 1);
  });

  console.log("signing");

  let digest = "" as Hex;
  await check("the digest is the module's ExecuteRecovery hash for the new owner", async () => {
    const r = await call("GET", `/recovery/turnkey/requests/${id}/digest`, undefined, auth());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rq = store.findRecoveryRequest(id)!;
    const expected = recoveryDigest(recoveryTypedData({ moduleAddress: MODULE, safeAddress: SAFE, newOwners: rq.turnkey!.newOwners!, newThreshold: 1, nonce: 0n }));
    assert.equal(r.body.digest, expected);
    assert.equal(r.body.guardianAddress, guardian.address);
    assert.equal(r.body.subOrgId, "sub-1");
    digest = r.body.digest;
  });

  await check("a digest the module would not compute is refused (DIGEST_MISMATCH)", async () => {
    chainState.digestOff = true;
    try {
      const r = await call("GET", `/recovery/turnkey/requests/${id}/digest`, undefined, auth());
      assert.equal(r.status, 503, "503, not 502: Cloudflare replaces a 502's body");
      assert.equal(r.body.code, "DIGEST_MISMATCH");
      markAlerted(id);
      const s = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
      assert.equal(s.body.code, "DIGEST_MISMATCH");
      assert.equal(relayed.length, 0);
    } finally {
      chainState.digestOff = false;
      store.updateRecoveryRequest(id, { ownerAlerts: undefined });
    }
  });

  await check("nothing is relayed before the owner's alert went out, or without mail at all", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "OWNER_NOT_ALERTED");
    markAlerted(id);
    mailOn = false;
    try {
      const off = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
      assert.equal(off.body.code, "OWNER_NOT_ALERTED");
    } finally {
      mailOn = true;
    }
    assert.equal(relayed.length, 0);
  });

  await check("a signature from anyone but the request's guardian is refused, nothing relayed", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(stranger, digest), auth());
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "WRONG_SIGNER");
    assert.equal(relayed.length, 0);
  });

  await check("a malformed signature is refused", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, { r: "11", s: "22", v: "00" }, auth());
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "BAD_SIGNATURE");
  });

  await check("a threshold above 1 is refused: collecting several approvals is not built", async () => {
    chainState.threshold = 2;
    try {
      const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "NEEDS_MORE_APPROVALS");
      assert.equal(relayed.length, 0);
    } finally {
      chainState.threshold = 1;
    }
  });

  await check("a guardian the module no longer lists is refused", async () => {
    chainState.guardians = [];
    try {
      const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "GUARDIAN_GONE");
    } finally {
      chainState.guardians = [guardian.address];
    }
  });

  await check("another recovery already on the module is refused", async () => {
    chainState.pending = { newOwners: [addr("d")], newThreshold: 1, executeAfter: GRACE_END };
    try {
      const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "RECOVERY_PENDING");
      assert.equal(relayed.length, 0);
    } finally {
      chainState.pending = null;
    }
  });

  await check("the guardian's signature is relayed with v 27/28, and the grace period comes from the chain", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "GRACE_PERIOD");
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0].signer, guardian.address);
    assert.ok(["1b", "1c"].includes(relayed[0].signature.slice(130)), relayed[0].signature);
    assert.equal(r.body.turnkey.finalizeAfter, new Date(GRACE_END * 1000).toISOString());
    assert.equal(r.body.turnkey.recoveryHash, digest);
    assert.equal(verifiers.length, 1, "the new passkey's verifier is deployed ahead of its first use");
  });

  await check("a second signature does nothing", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/signature`, await turnkeySign(guardian, digest), auth());
    assert.equal(r.status, 409);
    assert.equal(relayed.length, 1);
  });

  await check("the other open request is closed once one is on chain, and no new one starts while it is", async () => {
    assert.equal(store.findRecoveryRequest(strangerId)!.status, "CANCELED");
    const r = await call("POST", "/recovery/turnkey/requests", { email: "u_rec@example.com" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "RECOVERY_IN_PROGRESS");
  });

  console.log("owner");

  await check("the owner sees the request and the module's pending recovery", async () => {
    const r = await call("GET", "/users/u_rec/recovery/turnkey/requests", undefined, { "x-test-user": "u_rec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.requests.length, 1);
    assert.equal(r.body.requests[0].id, id);
    assert.equal(r.body.requests[0].turnkey.newPasskey, undefined);
    assert.equal(r.body.onChain.pendingRecovery.executeAfter, GRACE_END);
  });

  await check("another user's session cannot read them", async () => {
    const r = await call("GET", "/users/u_rec/recovery/turnkey/requests", undefined, { "x-test-user": "u_none" });
    assert.equal(r.status, 401);
  });

  console.log("finalising");

  await check("finalise before the grace period ends is refused", async () => {
    const r = await call("POST", `/recovery/turnkey/requests/${id}/finalize`, {}, auth());
    assert.equal(r.status, 425);
  });

  await check("after the grace period, finalise binds the new passkey once the owners match", async () => {
    store.updateRecoveryRequest(id, { turnkey: { ...store.findRecoveryRequest(id)!.turnkey!, finalizeAfter: new Date(Date.now() - 1000).toISOString() } });
    const r = await call("POST", `/recovery/turnkey/requests/${id}/finalize`, {}, auth());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "FINALIZED");
    assert.deepEqual(finalized, [SAFE]);
    assert.equal(store.findUser("u_rec")!.passkey!.credentialId, newKey.credentialId, "the account now signs in with the new passkey");
  });

  console.log("sweep and cancel");

  await check("the sweep expires an unanswered request and finalises one past its grace period", async () => {
    const mk = (status: string, extra: Record<string, unknown> = {}) => {
      const r: any = {
        id: `sw-${status}`, userId: "u_none", safeAddress: SAFE, mode: "turnkey", status, requestedAt: now,
        expiresAt: new Date(Date.now() - 1000).toISOString(), recoveryDelayHours: 1, guardianAddress: guardian.address,
        recoveryModuleAddress: MODULE, factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" }, turnkey: {}, ...extra,
      };
      store.addRecoveryRequest(r);
      return r.id;
    };
    const expiring = mk("PASSKEY_PENDING");
    const owners = [addr("7")];
    const sweptKey = await makeSoftwarePasskey("turnkey-recovery-swept", ORIGIN);
    const grace = mk("GRACE_PERIOD", { turnkey: { newPasskey: { ...passkey(sweptKey.credentialId), publicKey: { jwk: sweptKey.jwk, alg: "ES256" } }, newOwners: owners, newThreshold: 1, finalizeAfter: new Date(Date.now() - 1000).toISOString() } });
    chainState.pending = { newOwners: owners, newThreshold: 1, executeAfter: 1 };
    const n = await sweepTurnkeyRecoveries(new Date(), chain);
    assert.equal(store.findRecoveryRequest(expiring)!.status, "EXPIRED");
    assert.equal(store.findRecoveryRequest(grace)!.status, "FINALIZED");
    assert.equal(n, 1);
    chainState.pending = null;
  });

  await check("the owner cancels a request still waiting for the guardian", async () => {
    store.updateUser("u_none", { passkeySafe: { ...store.findUser("u_none")!.passkeySafe!, socialGuardians: [tkGuardian()] as any } });
    chainState.owners = [addr("e")];
    const start = await call("POST", "/recovery/turnkey/requests", { email: "u_none@example.com" });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const other = await call("POST", `/users/u_none/recovery/turnkey/requests/${start.body.id}/cancel`, {}, { "x-test-user": "u_rec" });
    assert.equal(other.status, 401);
    const r = await call("POST", `/users/u_none/recovery/turnkey/requests/${start.body.id}/cancel`, {}, { "x-test-user": "u_none" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.findRecoveryRequest(start.body.id)!.status, "CANCELED");
  });

  await check("at most five requests stay open per account; the oldest expires", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await call("POST", "/recovery/turnkey/requests", { email: "u_none@example.com" })).body.id);
    const open = store.recoveryRequestsForUser("u_none").filter((r) => r.mode === "turnkey" && ["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status));
    assert.equal(open.length, 5);
    assert.equal(store.findRecoveryRequest(ids[0])!.status, "EXPIRED");
  });

  await check("a signature racing the owner's cancel is refused before the relay", async () => {
    store.updateUser("u_created", { passkeySafe: { ...store.findUser("u_created")!.passkeySafe!, socialGuardians: [tkGuardian()] as any } });
    const start = await call("POST", "/recovery/turnkey/requests", { email: "u_created@example.com" });
    const h = { "x-recovery-secret": start.body.recoverySecret };
    const key = await makeSoftwarePasskey("turnkey-recovery-race", ORIGIN);
    await call("POST", `/recovery/turnkey/requests/${start.body.id}/passkey`, key.register(start.body.registerChallenge), h);
    markAlerted(start.body.id);
    const d = await call("GET", `/recovery/turnkey/requests/${start.body.id}/digest`, undefined, h);
    const realNonce = chain.nonce;
    chain.nonce = async (m, s) => {
      // The owner cancels while the API is reading the module.
      store.updateRecoveryRequest(start.body.id, { status: "CANCELED" });
      return realNonce(m, s);
    };
    try {
      const before = relayed.length;
      const r = await call("POST", `/recovery/turnkey/requests/${start.body.id}/signature`, await turnkeySign(guardian, d.body.digest), h);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(relayed.length, before, "nothing relayed");
    } finally {
      chain.nonce = realNonce;
    }
  });

  await check("an expired request answers 410 to its starter", async () => {
    const start = await call("POST", "/recovery/turnkey/requests", { email: "u_none@example.com" });
    store.updateRecoveryRequest(start.body.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = await call("GET", `/recovery/turnkey/requests/${start.body.id}`, undefined, { "x-recovery-secret": start.body.recoverySecret });
    assert.equal(r.status, 410);
  });
} finally {
  server.close();
}

console.log("covered elsewhere");

await check("the public view hides the new passkey and the secret's hash", () => {
  const out: any = publicRecoveryRequest({ id: "x", mode: "turnkey", turnkey: { accessHash: "h", newPasskey: passkey("p") as any, guardianSubOrgId: "sub-1" } } as any);
  assert.equal(out.turnkey.accessHash, undefined);
  assert.equal(out.turnkey.newPasskey, undefined);
  assert.equal(out.turnkey.newPasskeyRegistered, true);
});

await check("the alert mail, the on-chain cancel and the alert's completion time cover the turnkey mode", () => {
  const alerts = readFileSync(path.join(ROOT, "services/api/src/recovery/owner-alerts.ts"), "utf8");
  assert.match(alerts, /r\.mode !== "zoldenburg" && r\.mode !== "candide" && r\.mode !== "turnkey"/);
  assert.match(alerts, /r\.turnkey\?\.finalizeAfter/);
  const cancel = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-candide.ts"), "utf8");
  assert.match(cancel, /r\.mode === "candide" \|\| r\.mode === "zoldenburg" \|\| r\.mode === "turnkey"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
