/**
 * Turnkey social guardians (wallet/turnkey.ts holds the rules). The /guardian
 * page drives them; every route is a 404 while TURNKEY_GUARDIANS is off.
 *
 * - GET  /recovery/turnkey/users/:id/guardians: the owner's Turnkey guardians.
 * - POST /recovery/turnkey/users/:id/guardians {oidcToken, publicKey}: the
 *   owner logged in with Google or Apple in this browser; find or create the
 *   sub-org for that login and record its address. `created` is not a
 *   guardian: only the passkey-signed addGuardianWithThreshold makes it one,
 *   and only the chain says it happened. At signup the Safe is not deployed
 *   yet, and the deployment operation carries that add.
 * - POST /recovery/turnkey/users/:id/guardians/:subOrgId/add: prepares the
 *   passkey op that puts that address on the Safe's recovery module
 *   (addGuardianWithThreshold, threshold 1, enabling the module first if the
 *   Safe never had it); POST /recovery/turnkey/users/:id/ops/:requestId
 *   submits the approved op. The row turns `active` only when the module
 *   lists the address afterwards. While any other guardian is on the Safe
 *   the add is refused: two guardians mean threshold 2, and no route collects
 *   two signatures yet, so Zoldenburg alone could no longer recover it.
 * - POST /recovery/turnkey/login {oidcToken, publicKey}: no Zold session (the
 *   device may be the lost one's replacement); a Turnkey session for the
 *   login's own sub-org, bound to the browser key, and that sub-org's
 *   address to sign a recovery with. Only the login's holder learns them.
 *
 * Under /recovery, so every call sits on the tight auth bucket
 * (http/policy.ts). The ID token is never stored or logged.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { MetaTransaction } from "abstractionkit";
import { SECURITY } from "../config.js";
import { store } from "../store.js";
import type { User } from "../store/types.js";
import { checkOpAssertion } from "../http/passkey-assertion.js";
import { zoldenburgGuardianRemoveTransaction } from "../recovery/zoldenburg-guardian.js";
import {
  assertRecoveryModuleDeployed,
  prepareSafeSetupOperation,
  readRecoveryState,
  recoveryGuardianSetupTransactions,
  submitPasskeySafeOperationWithReceipt,
  type PasskeySafeDeploymentPlan,
  type RecoveryModuleState,
} from "../wallet/candide.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import { b64urlToBuf } from "../webauthn.js";
import {
  TurnkeyGuardianError,
  buildGuardianSubOrg,
  verifiedGuardianEmail,
  verifyOtpVerificationToken,
  type ClientSignature,
  type OtpTokenCheck,
  type GuardianLogin,
  fetchJwks,
  turnkeyClient,
  turnkeyGuardiansEnabled,
  verifyGuardianOidcToken,
  type JwksSource,
  type TurnkeyGuardianClient,
} from "../wallet/turnkey.js";
import { wrap } from "./util.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface TurnkeyGuardianDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  /** Turnkey, or a stand-in under test. */
  client?: () => TurnkeyGuardianClient;
  enabled?: () => boolean;
  /** Google's and Apple's signing keys, or a stand-in under test. */
  jwks?: JwksSource;
  /** Turnkey's check of an email verification token, or a stand-in under test. */
  otpTokens?: OtpTokenCheck;
  /** The Safe's module and the bundler, or a stand-in under test. */
  safeOps?: TurnkeyGuardianSafeOps;
}

/** What adding a guardian on chain needs from the Safe side. */
export interface TurnkeyGuardianSafeOps {
  /** The module's guardians, threshold and pending recovery, read from the chain. */
  readState(plan: PasskeySafeDeploymentPlan): Promise<RecoveryModuleState>;
  prepare(plan: PasskeySafeDeploymentPlan, txs: MetaTransaction[]): Promise<{ userOperation: any; challenge: `0x${string}` }>;
  /** The op that takes `address` off the module, lowering the threshold to what remains. */
  revokeTx(plan: PasskeySafeDeploymentPlan, state: RecoveryModuleState, address: `0x${string}`): Promise<MetaTransaction>;
  /** Writes the refusal itself and answers undefined when the approval is not good. */
  checkAssertion(user: User, body: unknown, challenge: string, res: express.Response): Promise<User | undefined>;
  submit(plan: PasskeySafeDeploymentPlan, userOperation: any, body: any): Promise<{ success?: boolean; txHash?: string; userOpHash?: string | null }>;
}

const chainSafeOps: TurnkeyGuardianSafeOps = {
  async readState(plan) {
    const state = await readRecoveryState(plan);
    await assertRecoveryModuleDeployed(state.moduleAddress);
    return state;
  },
  prepare: (plan, txs) => prepareSafeSetupOperation(plan, txs),
  revokeTx: (plan, state, address) => zoldenburgGuardianRemoveTransaction(plan.address, state.moduleAddress, address, state.guardians),
  checkAssertion: checkOpAssertion,
  submit: (plan, userOperation, body) =>
    submitPasskeySafeOperationWithReceipt(plan, userOperation, {
      authenticatorData: b64urlToBuf(body.authenticatorData),
      clientDataJSON: b64urlToBuf(body.clientDataJSON),
      signature: b64urlToBuf(body.signature),
    }),
};

/** A prepared op lives this long between "Add" and the passkey approval. */
const CEREMONY_TTL_MS = 5 * 60_000;

/** The owner's own deployed Safe, approved by their passkey; never an imported one. */
function activePlan(user: User): PasskeySafeDeploymentPlan {
  const plan = user.passkeySafe;
  if (!plan || plan.status !== "active" || user.address.toLowerCase() !== plan.address.toLowerCase()) {
    throw new TurnkeyGuardianError("a guardian needs your own deployed Safe", 409, "NO_SAFE");
  }
  if (plan.importedAt) throw new TurnkeyGuardianError("an imported Safe is not offered a recovery guardian", 409, "IMPORTED_SAFE");
  if (!user.passkey?.publicKey) throw new TurnkeyGuardianError("a verified passkey is required first", 409, "NO_PASSKEY");
  return plan as PasskeySafeDeploymentPlan;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * May `address` be added now? Checked when the op is prepared AND again right
 * before it is submitted: a guardian or a recovery can appear in between
 * (another op, another tab). "listed" means the module already has it.
 */
function assertCanAdd(state: RecoveryModuleState, address: string): "listed" | "ok" {
  if (state.pending) throw new TurnkeyGuardianError("a recovery is pending on this account — cancel it first", 409, "RECOVERY_PENDING");
  if (state.guardians.some((g) => sameAddress(g, address))) return "listed";
  if (state.guardians.length) {
    throw new TurnkeyGuardianError(
      "this Safe already has a recovery guardian; combining guardians needs recovery with several approvals, which is not built yet",
      409,
      "OTHER_GUARDIAN",
    );
  }
  return "ok";
}

type SocialGuardian = NonNullable<NonNullable<User["passkeySafe"]>["socialGuardians"]>[number];

const view = (g: SocialGuardian) => ({
  kind: g.kind,
  address: g.address,
  turnkeySubOrgId: g.turnkeySubOrgId,
  status: g.status,
  createdAt: g.createdAt,
  activeAt: g.activeAt,
});

/** The user's row for this sub-org taken off the account (the Turnkey wallet
 *  itself stays the person's; adding the same login again finds it). */
function dropGuardian(userId: string, subOrgId: string) {
  const safe = store.findUser(userId)!.passkeySafe!;
  store.updateUser(userId, { passkeySafe: { ...safe, socialGuardians: (safe.socialGuardians ?? []).filter((g) => g.turnkeySubOrgId !== subOrgId) } });
}

/** The user's row for this sub-org changed to `patch`, written back. */
function updateGuardian(userId: string, subOrgId: string, patch: Partial<SocialGuardian>): SocialGuardian {
  const safe = store.findUser(userId)!.passkeySafe!;
  const rows = (safe.socialGuardians ?? []).map((g) => (g.turnkeySubOrgId === subOrgId ? { ...g, ...patch } : g));
  store.updateUser(userId, { passkeySafe: { ...safe, socialGuardians: rows } });
  return rows.find((g) => g.turnkeySubOrgId === subOrgId)!;
}

export function createTurnkeyGuardianRouter({
  requireUserSession,
  client = turnkeyClient,
  enabled = turnkeyGuardiansEnabled,
  jwks = fetchJwks,
  otpTokens = verifyOtpVerificationToken,
  safeOps = chainSafeOps,
}: TurnkeyGuardianDeps) {
  const router = express.Router();
  const pendingOps = new Map<string, { userId: string; kind: "add" | "remove"; subOrgId: string; address: `0x${string}`; userOperation: any; challenge: string; expiresAt: number }>();
  /** Keep a prepared op for the passkey; one per user (a second replaces it). */
  const holdOp = (user: User, op: { kind: "add" | "remove"; subOrgId: string; address: `0x${string}` }, prepared: { userOperation: any; challenge: `0x${string}` }) => {
    prune();
    for (const [id, o] of pendingOps) if (o.userId === user.id) pendingOps.delete(id);
    const requestId = randomUUID();
    const challenge = passkeySafeChallenge(prepared.challenge);
    pendingOps.set(requestId, { userId: user.id, ...op, userOperation: prepared.userOperation, challenge, expiresAt: Date.now() + CEREMONY_TTL_MS });
    return {
      requestId,
      credentialId: user.passkey!.credentialId,
      rpId: user.passkey!.rpId ?? SECURITY.rpId,
      challenge,
      submitTo: `/api/recovery/turnkey/users/${user.id}/ops/${requestId}`,
    };
  };
  const prune = () => {
    const now = Date.now();
    for (const [id, op] of pendingOps) if (op.expiresAt <= now) pendingOps.delete(id);
  };
  /**
   * Adds in flight, by user and by login identity: two parallel adds of the
   * same Google account (two tabs, or two Zold users) would both find no
   * sub-org and make two, and a login with two sub-orgs can no longer sign
   * a recovery (AMBIGUOUS). Per process: the API runs as one.
   */
  const adding = new Set<string>();

  router.use("/recovery/turnkey", (_req, res, next) => {
    if (enabled()) return next();
    res.status(404).json({ error: "Turnkey guardians are not available on this deployment", code: "TURNKEY_OFF" });
  });

  router.get("/recovery/turnkey/users/:id/guardians", (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    res.json({ guardians: (user.passkeySafe?.socialGuardians ?? []).map(view) });
  });

  router.post(
    "/recovery/turnkey/users/:id/guardians",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const safe = user.passkeySafe;
      // A planned Safe is enough: at signup the login comes before the Safe,
      // and the deployment adds the guardian (routes/auth.ts).
      if (!safe) {
        return res.status(409).json({ error: "a guardian needs your own Safe", code: "NO_SAFE" });
      }
      if (safe.importedAt) {
        return res.status(409).json({ error: "an imported Safe is not offered a recovery guardian", code: "IMPORTED_SAFE" });
      }
      const locks: string[] = [];
      const lock = (key: string) => {
        if (adding.has(key)) throw new TurnkeyGuardianError("a guardian is already being added", 409, "BUSY");
        adding.add(key);
        locks.push(key);
      };
      try {
        lock(`user:${user.id}`);
        const { login, filter, identity } = await guardianLogin(req.body ?? {}, jwks, otpTokens);
        lock(identity);
        const turnkey = client();
        const ids = await turnkey.subOrgIds(...filter);
        if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
        const found = ids.length === 1 ? { subOrgId: ids[0], address: await turnkey.walletAddress(ids[0]) } : undefined;
        const { subOrgId, address } = found ?? (await turnkey.createSubOrg(buildGuardianSubOrg(login)));

        const fresh = store.findUser(user.id)!;
        const current = fresh.passkeySafe!;
        const existing = (current.socialGuardians ?? []).find((g) => g.turnkeySubOrgId === subOrgId);
        if (existing) return res.json({ guardian: view(existing) });
        const guardian: SocialGuardian = { kind: "self-social", address, turnkeySubOrgId: subOrgId, status: "created", createdAt: new Date().toISOString() };
        store.updateUser(user.id, { passkeySafe: { ...current, socialGuardians: [...(current.socialGuardians ?? []), guardian] } });
        res.status(201).json({ guardian: view(guardian) });
      } catch (e) {
        sendError(res, e);
      } finally {
        for (const key of locks) adding.delete(key);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/users/:id/guardians/:subOrgId/add",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      try {
        const plan = activePlan(user);
        const guardian = (user.passkeySafe!.socialGuardians ?? []).find((g) => g.turnkeySubOrgId === req.params.subOrgId);
        if (!guardian) throw new TurnkeyGuardianError("no such guardian on this account", 404, "NO_GUARDIAN");
        const state = await safeOps.readState(plan);
        if (assertCanAdd(state, guardian.address) === "listed") {
          const active = updateGuardian(user.id, guardian.turnkeySubOrgId, { status: "active", activeAt: guardian.activeAt ?? new Date().toISOString() });
          return res.json({ guardian: view(active) });
        }
        const txs = recoveryGuardianSetupTransactions(plan.address, state.moduleAddress, guardian.address, 1, state.moduleEnabled);
        const prepared = await safeOps.prepare(plan, txs);
        // One op in flight per user: two prepared adds could each pass the
        // check above and together leave two guardians at threshold 1.
        res.status(201).json(holdOp(user, { kind: "add", subOrgId: guardian.turnkeySubOrgId, address: guardian.address }, prepared));
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/users/:id/guardians/:subOrgId/remove",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      try {
        const plan = activePlan(user);
        const guardian = (user.passkeySafe!.socialGuardians ?? []).find((g) => g.turnkeySubOrgId === req.params.subOrgId);
        if (!guardian) throw new TurnkeyGuardianError("no such guardian on this account", 404, "NO_GUARDIAN");
        const state = await safeOps.readState(plan);
        if (state.pending) throw new TurnkeyGuardianError("a recovery is pending on this account — cancel it first", 409, "RECOVERY_PENDING");
        if (!state.guardians.some((g) => sameAddress(g, guardian.address))) {
          // A prepared add for this row would otherwise land on chain later
          // with no row left to show it.
          for (const [id, o] of pendingOps) if (o.userId === user.id && o.subOrgId === guardian.turnkeySubOrgId) pendingOps.delete(id);
          dropGuardian(user.id, guardian.turnkeySubOrgId);
          return res.json({ removed: true });
        }
        const prepared = await safeOps.prepare(plan, [await safeOps.revokeTx(plan, state, guardian.address)]);
        res.status(201).json(holdOp(user, { kind: "remove", subOrgId: guardian.turnkeySubOrgId, address: guardian.address }, prepared));
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/users/:id/ops/:requestId",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      prune();
      const pending = pendingOps.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) return res.status(404).json({ error: "request not found or expired — start again" });
      try {
        const plan = activePlan(user);
        // Claimed BEFORE any await: one approval submits the operation once.
        // A refused approval gives it back for another try.
        pendingOps.delete(req.params.requestId);
        if (!(await safeOps.checkAssertion(user, req.body, pending.challenge, res))) {
          pendingOps.set(req.params.requestId, pending);
          return;
        }
        if (!(user.passkeySafe!.socialGuardians ?? []).some((g) => g.turnkeySubOrgId === pending.subOrgId)) {
          throw new TurnkeyGuardianError("no such guardian on this account", 404, "NO_GUARDIAN");
        }
        if (pending.kind === "remove") {
          const op = await safeOps.submit(plan, pending.userOperation, req.body);
          if (op.success === false) return res.status(502).json({ error: "the operation was included but reverted — nothing changed", code: "REVERTED", txHash: op.txHash });
          const after = await safeOps.readState(plan);
          if (after.guardians.some((g) => sameAddress(g, pending.address))) {
            return res.status(502).json({ error: "the operation was submitted but the module still lists the guardian — check again shortly", code: "STILL_LISTED" });
          }
          dropGuardian(user.id, pending.subOrgId);
          console.log(`RECOVERY: ${user.id} removed a Turnkey guardian (${op.userOpHash ?? op.txHash})`);
          return res.json({ removed: true, txHash: op.txHash, userOpHash: op.userOpHash });
        }
        if (assertCanAdd(await safeOps.readState(plan), pending.address) === "listed") {
          const active = updateGuardian(user.id, pending.subOrgId, { status: "active", activeAt: new Date().toISOString() });
          return res.json({ guardian: view(active) });
        }
        const op = await safeOps.submit(plan, pending.userOperation, req.body);
        if (op.success === false) {
          return res.status(502).json({ error: "the operation was included but reverted — nothing changed", code: "REVERTED", txHash: op.txHash });
        }
        // Confirm on the chain, not on the op's say-so.
        const state = await safeOps.readState(plan);
        if (!state.guardians.some((g) => sameAddress(g, pending.address))) {
          return res.status(502).json({ error: "the operation was submitted but the module does not list the guardian yet — check again shortly", code: "NOT_LISTED" });
        }
        const active = updateGuardian(user.id, pending.subOrgId, { status: "active", activeAt: new Date().toISOString() });
        console.log(`RECOVERY: ${user.id} added a Turnkey guardian (${op.userOpHash ?? op.txHash})`);
        res.json({ guardian: view(active), txHash: op.txHash, userOpHash: op.userOpHash });
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  /** Turnkey emails a 6-digit code: to add an email guardian (also at
   *  signup, before the account exists) or to approve a recovery with one. */
  router.post(
    "/recovery/turnkey/email/code",
    wrap(async (req, res) => {
      try {
        const email = String(req.body?.email ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 254) throw new TurnkeyGuardianError("enter an email address", 400, "BAD_EMAIL");
        res.json(await client().initEmailOtp(email));
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  /** The code, encrypted in the browser to Turnkey's enclave, for a token. */
  router.post(
    "/recovery/turnkey/email/verify",
    wrap(async (req, res) => {
      try {
        const { otpId, encryptedOtpBundle } = req.body ?? {};
        if (typeof otpId !== "string" || typeof encryptedOtpBundle !== "string" || !otpId || encryptedOtpBundle.length > 8192) {
          throw new TurnkeyGuardianError("otpId and encryptedOtpBundle required", 400, "BAD_OTP");
        }
        res.json({ verificationToken: await client().verifyEmailOtp(otpId, encryptedOtpBundle) });
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/login",
    wrap(async (req, res) => {
      try {
        const { oidcToken, publicKey, verificationToken, clientSignature, credentialId } = req.body ?? {};
        const turnkey = client();
        const one = async (filter: Parameters<TurnkeyGuardianClient["subOrgIds"]>) => {
          const ids = await turnkey.subOrgIds(...filter);
          if (ids.length === 0) throw new TurnkeyGuardianError("this login is not a guardian", 404, "NO_GUARDIAN");
          if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
          return ids[0];
        };
        // A passkey signs its own requests to Turnkey: no session to hand out.
        if (credentialId !== undefined) {
          if (typeof credentialId !== "string" || !credentialId || credentialId.length > 1024) throw new TurnkeyGuardianError("credentialId required", 400, "BAD_PASSKEY");
          const subOrgId = await one(["CREDENTIAL_ID", credentialId]);
          return res.json({ subOrgId, address: await turnkey.walletAddress(subOrgId) });
        }
        if (verificationToken !== undefined) {
          const { email, publicKey: key } = await verifiedGuardianEmail(verificationToken, otpTokens);
          if (!isClientSignature(clientSignature, key)) throw new TurnkeyGuardianError("the browser key's signature is missing", 400, "BAD_OTP_TOKEN");
          const subOrgId = await one(["EMAIL", email]);
          const session = await turnkey.otpLogin(subOrgId, verificationToken, key, clientSignature);
          return res.json({ session, subOrgId, address: await turnkey.walletAddress(subOrgId) });
        }
        await verifyGuardianOidcToken(oidcToken, publicKey, jwks);
        const subOrgId = await one(["OIDC_TOKEN", oidcToken]);
        const session = await turnkey.oauthLogin(subOrgId, oidcToken, publicKey);
        res.json({ session, subOrgId, address: await turnkey.walletAddress(subOrgId) });
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  return router;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The add route's body as one login: an ID token, an email verification
 *  token, or a new passkey. `identity` locks parallel adds of the same one. */
async function guardianLogin(body: any, jwks: JwksSource, otpTokens: OtpTokenCheck): Promise<{ login: GuardianLogin; filter: Parameters<TurnkeyGuardianClient["subOrgIds"]>; identity: string }> {
  if (body.verificationToken !== undefined) {
    const { email } = await verifiedGuardianEmail(body.verificationToken, otpTokens);
    return { login: { kind: "email", email }, filter: ["EMAIL", email], identity: `email:${email}` };
  }
  if (body.passkey !== undefined) {
    const { challenge, attestation } = body.passkey ?? {};
    const id = attestation?.credentialId;
    if (typeof challenge !== "string" || typeof id !== "string" || !id || typeof attestation.clientDataJson !== "string" || typeof attestation.attestationObject !== "string") {
      throw new TurnkeyGuardianError("passkey challenge and attestation required", 400, "BAD_PASSKEY");
    }
    const transports = Array.isArray(attestation.transports) ? attestation.transports.filter((t: unknown) => typeof t === "string" && /^AUTHENTICATOR_TRANSPORT_[A-Z]+$/.test(t)) : [];
    const clean = { credentialId: id, clientDataJson: attestation.clientDataJson, attestationObject: attestation.attestationObject, transports };
    return { login: { kind: "passkey", challenge, attestation: clean }, filter: ["CREDENTIAL_ID", id], identity: `passkey:${id}` };
  }
  const login = await verifyGuardianOidcToken(body.oidcToken, body.publicKey, jwks);
  return { login: { kind: "oidc", oidcToken: body.oidcToken, providerName: login.providerName }, filter: ["OIDC_TOKEN", body.oidcToken], identity: `login:${login.issuer}|${login.subject}` };
}

/** Signed by the key the verification token is bound to (Turnkey checks the signature). */
const isClientSignature = (sig: any, key: string): sig is ClientSignature =>
  !!sig && sig.publicKey === key && sig.scheme === "CLIENT_SIGNATURE_SCHEME_API_P256" && typeof sig.message === "string" && typeof sig.signature === "string";

/** Our refusals keep their status; anything from Turnkey is a 502. The log
 *  names the error's type and code only: a Turnkey error may echo the
 *  request, and the request carries the ID token and the browser key. */
function sendError(res: express.Response, e: unknown) {
  if (e instanceof TurnkeyGuardianError) return res.status(e.status).json({ error: e.message, code: e.code });
  const err = e as { name?: string; code?: unknown };
  console.error("[turnkey] request failed:", err?.name ?? typeof e, err?.code ?? "");
  res.status(502).json({ error: "Turnkey did not answer as expected; try again", code: "TURNKEY_FAILED" });
}
