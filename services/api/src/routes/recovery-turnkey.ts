/**
 * Turnkey social guardians (wallet/turnkey.ts holds the rules). The /guardian
 * page drives them; every route is a 404 while TURNKEY_GUARDIANS is off.
 *
 * - GET  /recovery/turnkey/users/:id/guardians: the owner's Turnkey guardians.
 * - POST /recovery/turnkey/users/:id/guardians {oidcToken, publicKey}: the
 *   owner logged in with Google or Apple in this browser; find or create the
 *   sub-org for that login and record its address. `created` is not a
 *   guardian: only the passkey-signed addGuardianWithThreshold makes it one,
 *   and only the chain says it happened.
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
 *   login's own sub-org, bound to the browser key, so it can sign a recovery.
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
  /** The Safe's module and the bundler, or a stand-in under test. */
  safeOps?: TurnkeyGuardianSafeOps;
}

/** What adding a guardian on chain needs from the Safe side. */
export interface TurnkeyGuardianSafeOps {
  /** The module's guardians, threshold and pending recovery, read from the chain. */
  readState(plan: PasskeySafeDeploymentPlan): Promise<RecoveryModuleState>;
  prepare(plan: PasskeySafeDeploymentPlan, txs: MetaTransaction[]): Promise<{ userOperation: any; challenge: `0x${string}` }>;
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
  safeOps = chainSafeOps,
}: TurnkeyGuardianDeps) {
  const router = express.Router();
  const pendingOps = new Map<string, { userId: string; subOrgId: string; address: `0x${string}`; userOperation: any; challenge: string; expiresAt: number }>();
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
      if (!safe || safe.status !== "active") {
        return res.status(409).json({ error: "a guardian needs your own deployed Safe", code: "NO_SAFE" });
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
        const { oidcToken, publicKey } = req.body ?? {};
        const login = await verifyGuardianOidcToken(oidcToken, publicKey, jwks);
        lock(`login:${login.issuer}|${login.subject}`);
        const turnkey = client();
        const ids = await turnkey.subOrgIdsForOidcToken(oidcToken);
        if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
        const found = ids.length === 1 ? { subOrgId: ids[0], address: await turnkey.walletAddress(ids[0]) } : undefined;
        const { subOrgId, address } = found ?? (await turnkey.createSubOrg(buildGuardianSubOrg({ oidcToken, providerName: login.providerName })));

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
        prune();
        // One op in flight per user: two prepared adds could each pass the
        // check above and together leave two guardians at threshold 1.
        for (const [id, op] of pendingOps) if (op.userId === user.id) pendingOps.delete(id);
        const requestId = randomUUID();
        const challenge = passkeySafeChallenge(prepared.challenge);
        pendingOps.set(requestId, {
          userId: user.id, subOrgId: guardian.turnkeySubOrgId, address: guardian.address,
          userOperation: prepared.userOperation, challenge, expiresAt: Date.now() + CEREMONY_TTL_MS,
        });
        res.status(201).json({
          requestId,
          credentialId: user.passkey!.credentialId,
          rpId: user.passkey!.rpId ?? SECURITY.rpId,
          challenge,
          submitTo: `/api/recovery/turnkey/users/${user.id}/ops/${requestId}`,
        });
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
        if (!(await safeOps.checkAssertion(user, req.body, pending.challenge, res))) return;
        pendingOps.delete(req.params.requestId);
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

  router.post(
    "/recovery/turnkey/login",
    wrap(async (req, res) => {
      try {
        const { oidcToken, publicKey } = req.body ?? {};
        await verifyGuardianOidcToken(oidcToken, publicKey, jwks);
        const turnkey = client();
        const ids = await turnkey.subOrgIdsForOidcToken(oidcToken);
        if (ids.length === 0) throw new TurnkeyGuardianError("this login is not a guardian", 404, "NO_GUARDIAN");
        if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
        const session = await turnkey.oauthLogin(ids[0], oidcToken, publicKey);
        res.json({ session, subOrgId: ids[0] });
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  return router;
}

/** Our refusals keep their status; anything from Turnkey is a 502. The log
 *  names the error's type and code only: a Turnkey error may echo the
 *  request, and the request carries the ID token and the browser key. */
function sendError(res: express.Response, e: unknown) {
  if (e instanceof TurnkeyGuardianError) return res.status(e.status).json({ error: e.message, code: e.code });
  const err = e as { name?: string; code?: unknown };
  console.error("[turnkey] request failed:", err?.name ?? typeof e, err?.code ?? "");
  res.status(502).json({ error: "Turnkey did not answer as expected; try again", code: "TURNKEY_FAILED" });
}
