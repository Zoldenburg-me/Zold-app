/**
 * Sessions and passkeys — how somebody proves they are this account.
 *
 * Registration parses and verifies the WebAuthn attestation (challenge,
 * origin, rpIdHash) and stores the COSE public key plus the sign counter;
 * login verifies the assertion signature SERVER-SIDE before a session is
 * issued. Re-registration needs a step-up from the CURRENT credential, because
 * a stolen session token would otherwise be permanent account access.
 *
 * The passkey-Safe deployment routes live here too: the Safe's owner IS the
 * passkey, so the ceremony that proves the credential and the operation that
 * deploys the account are one flow rather than two.
 */
import express from "express";
import { wrap } from "./util.js";
import { randomUUID } from "node:crypto";
import { CHAIN_ID, EMAIL_VERIFICATION, HARNESS, SECURITY } from "../config.js";
import { emailHeldBy } from "../domain/email.js";
import { accountBalances } from "../chain.js";
import { store, type User } from "../store.js";
import { rateLimit } from "../http/policy.js";
import { requireSession, revokeOtherSessions, tokenHash } from "../http/sessions.js";
import { requireCapability } from "../http/guards.js";
import {
  pendingPasskeySafeDeployments,
  prunePendingPasskeySafeDeployments,
} from "../http/pending.js";
import {
  activatePasskeySafePlan,
  passkeySafeChallenge,
  passkeySafePlan,
} from "../wallet/passkey-safe-plan.js";
import {
  CANDIDE,
  SafeOperationUncertainError,
  preparePasskeySafeDeployment,
  submitPasskeySafeOperationWithReceipt,
  type SubmittedOperation,
} from "../wallet/candide.js";
import { b64urlToBuf, issueChallenge, stepUpBinding, verifyAssertion, verifyRegistration } from "../webauthn.js";
import { publicUser, withSession } from "../users/public-user.js";
import { checkOpAssertion } from "../http/passkey-assertion.js";
import { faucetFundSafe } from "../faucet.js";
import { describeCause, redactedMessage } from "../http/log-cause.js";

/**
 * requireUserSession is injected so that server.ts stays the only place that
 * decides who is calling.
 */
export interface AuthDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => { id: string } | undefined;
}


// --- Passkeys (full WebAuthn verification) -----------------------------------
// Registration parses and verifies the attestation (challenge, origin,
// rpIdHash) and stores the COSE public key + sign counter. Login verifies the
// assertion signature server-side before a session is issued.

/**
 * The changes a step-up can approve. A challenge is issued for one of them and
 * verified only by the route that makes that change (webauthn.ts
 * stepUpBinding).
 */
export const STEP_UP_ACTIONS = [
  "passkey.replace",
  "monerium.connect",
  "monerium.disconnect",
  "authorizer.bind",
  "org.payment-review.off",
  "org.invoice-iban.change",
  "safe.import",
  "recovery.enrolment",
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
const isStepUpAction = (v: unknown): v is StepUpAction => STEP_UP_ACTIONS.includes(v as StepUpAction);
/**
 * Actions approved for one object, not just for the account. Their challenge
 * comes from the route that read the object (safe.import: /safe/import/prepare,
 * bound to the Safe's address, owners and threshold), never from
 * /webauthn/challenge.
 */
const TARGETED_STEP_UP_ACTIONS: readonly StepUpAction[] = ["safe.import"];

export async function verifyPasskeyStepUp(
  user: User,
  body: any,
  res: express.Response,
  action: StepUpAction,
  target?: string,
): Promise<boolean> {
  if (!user.passkey?.publicKey) {
    if (HARNESS.enabled) return true;
    res.status(409).json({ error: "a verified passkey is required for this change", code: "NO_PASSKEY" });
    return false;
  }
  const stepUp = body?.stepUp ?? {};
  const { credentialId, authenticatorData, clientDataJSON, signature } = stepUp;
  if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
    res.status(401).json({ error: "a fresh passkey approval is required for this change", code: "STEP_UP_REQUIRED" });
    return false;
  }
  if (credentialId !== user.passkey.credentialId) {
    res.status(403).json({ error: "passkey credential does not match this account", code: "STEP_UP_CREDENTIAL" });
    return false;
  }
  try {
    const { signCount } = await verifyAssertion(
      authenticatorData,
      clientDataJSON,
      signature,
      user.passkey.publicKey,
      user.passkey.signCount ?? 0,
      user.passkey.rpId ?? SECURITY.rpId,
      SECURITY.origins,
      "step_up",
      stepUpBinding(user.id, action, target),
    );
    if (!store.recordPasskeyUse(user.id, credentialId, signCount)) {
      throw new Error("this passkey is no longer the account's passkey");
    }
    return true;
  } catch (err: any) {
    res.status(401).json({ error: redactedMessage(err), code: "STEP_UP_INVALID" });
    return false;
  }
}

export function createAuthRouter(deps: AuthDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.delete(
    "/session",
    wrap(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) return;
      store.revokeSession(session.id);
      res.status(204).end();
    }),
  );

  router.get(
    "/session",
    wrap(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) return;
      const user = store.findUser(session.userId);
      if (!user) return res.status(404).json({ error: "session user not found" });
      const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.json({ ...publicUser(user), ...balances });
    }),
  );

  router.post(
    "/webauthn/challenge",
    wrap(async (req, res) => {
      const purpose =
        req.body?.purpose === "register"
          ? "register"
          : req.body?.purpose === "step_up"
            ? "step_up"
            : "login";
      // register and step_up act on a known account, so the challenge is bound to
      // it, and a step_up also to the one change it approves: an assertion
      // collected for one account, or one action, cannot be spent on another.
      // Login is unbound by necessity — there is no session yet.
      let binding: string | undefined;
      if (purpose !== "login") {
        const session = requireSession(req, res);
        if (!session) return;
        binding = session.userId;
        if (purpose === "step_up") {
          const action = req.body?.action;
          if (!isStepUpAction(action)) {
            return res.status(400).json({ error: `name the change this approval is for: action is one of ${STEP_UP_ACTIONS.join(", ")}` });
          }
          if (TARGETED_STEP_UP_ACTIONS.includes(action)) {
            return res.status(400).json({ error: `${action} is approved for one object; its challenge comes from the route that read it` });
          }
          binding = stepUpBinding(session.userId, action);
        }
      }
      res.json({ challenge: issueChallenge(purpose, binding), rpId: SECURITY.rpId });
    }),
  );

  router.post(
    "/users/:id/passkey",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      const session = requireUserSession(req, res, user.id);
      if (!session) return;
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if (store.findUserByCredential(credentialId)) {
        return res.status(409).json({ error: "credential already registered" });
      }
      // A deployed Safe's owner is on chain, so a new passkey is added there:
      // by recovery, or by an owner change the current passkey signs.
      if (user.passkeySafe?.status === "active") {
        return res.status(409).json({
          code: "SAFE_OWNER_ON_CHAIN",
          error:
            "This account's Safe is already deployed with your current passkey as its owner. A new passkey has to be added on the Safe itself — use account recovery if you lost the device.",
        });
      }
      // Replacing the account's authenticator is an account-takeover path if a
      // bearer token is enough for it: a stolen 24h session would become permanent
      // access, and the real passkey would be silently discarded. The current
      // authenticator has to approve its own replacement. First registration (no
      // verified passkey yet) is unaffected.
      const replacing = Boolean(user.passkey?.publicKey);
      if (replacing && !(await verifyPasskeyStepUp(user, req.body, res, "passkey.replace"))) return;
      let reg;
      try {
        reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, user.id);
      } catch (err: any) {
        return res.status(400).json({ error: redactedMessage(err) });
      }
      if (reg.credentialId !== credentialId) {
        return res.status(400).json({ error: "credentialId does not match attestation" });
      }
      const passkey = {
        credentialId,
        publicKey: reg.key,
        signCount: reg.signCount,
        rpId: SECURITY.rpId,
        attestation,
        createdAt: new Date().toISOString(),
      };
      // ONE CLAIMABLE ACCOUNT PER EMAIL, re-asserted here. Signup checks it,
      // but two passkey-less rows on one email both pass that check; the first
      // passkey is what makes a row claimable, so it is where the invariant
      // has to hold. Nothing is awaited between this check and the write.
      if (!user.passkey?.publicKey && user.email &&
          emailHeldBy(store.usersByEmail(user.email).filter((u) => u.id !== user.id), EMAIL_VERIFICATION.enabled)) {
        return res.status(409).json({
          error: "an account already uses this email — sign in with your passkey, or recover the account if you lost the device",
          code: "EMAIL_IN_USE",
        });
      }
      const plannedSafe = passkeySafePlan(user, reg.key);
      const updated = store.updateUser(user.id, {
        passkey: {
          ...passkey,
        },
        ...(plannedSafe ? { passkeySafe: plannedSafe } : {}),
      });
      // A bearer copied before the swap would otherwise keep working under the
      // new passkey until it expires.
      if (replacing) revokeOtherSessions(user.id, session.id);
      res.status(201).json(publicUser(updated));
    }),
  );

  router.post(
    "/users/:id/passkey-safe/deployment",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "safe", res)) return;
      if (!user.passkey?.publicKey || !user.passkeySafe) {
        return res.status(409).json({ error: "register a passkey before preparing the passkey Safe" });
      }
      if (user.passkeySafe.status === "active") {
        return res.json({ safeAddress: user.passkeySafe.address, status: "active" });
      }
      /**
       * Deploying a passkey Safe goes through an ERC-4337 bundler and paymaster.
       * A local hardhat node has neither, so under `npm run dev` this reaches
       * Candide asking about CANDIDE_CHAIN_ID for a Safe that exists only on this
       * machine, and the browser reports the network failure as "Failed to fetch"
       * — which reads as a bug in our code rather than a chain that cannot do the
       * operation.
       *
       * Explain it when it happens rather than refusing up front: an already
       * deployed Safe short-circuits before any bundler call, and that path works
       * locally (monerium:oauth:test relies on it). Guessing ahead of the failure
       * broke a passing flow.
       */
      let deployment: Awaited<ReturnType<typeof preparePasskeySafeDeployment>>;
      try {
        deployment = await preparePasskeySafeDeployment(user.passkeySafe);
      } catch (err: any) {
        const mismatch = BigInt(CHAIN_ID) !== BigInt(CANDIDE.chainId);
        return res.status(mismatch ? 409 : 502).json({
          error: mismatch
            ? `passkey Safe deployment needs an ERC-4337 bundler. This API is on chain ${CHAIN_ID} ` +
              `while Candide is configured for chain ${CANDIDE.chainId}, and a local hardhat node has ` +
              `no bundler or paymaster. Run against chain ${CANDIDE.chainId} (npm run api) rather than ` +
              `npm run dev. Underlying error: ${redactedMessage(err)}`
            : `passkey Safe deployment failed: ${redactedMessage(err)}`,
        });
      }
      if (deployment.challenge === "0x") {
        const updated = store.updateUser(user.id, {
          address: user.passkeySafe.address,
          wallet: { type: "candide-safe", deployed: true },
          passkeySafe: activatePasskeySafePlan(user.passkeySafe),
        });
        return res.json(publicUser(updated));
      }
      prunePendingPasskeySafeDeployments();
      const requestId = randomUUID();
      pendingPasskeySafeDeployments.set(requestId, {
        userId: user.id,
        expiresAt: Date.now() + 5 * 60_000,
        userOperation: deployment.userOperation,
        challenge: passkeySafeChallenge(deployment.challenge),
      });
      res.status(201).json({
        requestId,
        safeAddress: deployment.safeAddress,
        credentialId: user.passkey.credentialId,
        challenge: passkeySafeChallenge(deployment.challenge),
        submitTo: `/api/users/${user.id}/passkey-safe/deployment/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/passkey-safe/deployment/:requestId",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!user.passkeySafe) return res.status(409).json({ error: "no passkey Safe plan for this account" });
      prunePendingPasskeySafeDeployments();
      const pending = pendingPasskeySafeDeployments.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) {
        return res.status(404).json({ error: "passkey Safe deployment request not found or expired" });
      }
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (typeof authenticatorData !== "string" || typeof clientDataJSON !== "string" || typeof signature !== "string" ||
          !authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      const balances = await accountBalances(user.address);
      if (balances.safeBalanceEur > 0) {
        return res.status(409).json({
          error: "current account still has funds; move balances before activating the passkey Safe address",
          ...balances,
        });
      }
      // Claimed BEFORE the await: two parallel submits of one signature must
      // not both send the deployment operation.
      pendingPasskeySafeDeployments.delete(req.params.requestId);
      const approved = await checkOpAssertion(user, req.body, pending.challenge, res);
      if (!approved) return;
      let op: SubmittedOperation;
      try {
        op = await submitPasskeySafeOperationWithReceipt(user.passkeySafe, pending.userOperation, {
          authenticatorData: b64urlToBuf(authenticatorData),
          clientDataJSON: b64urlToBuf(clientDataJSON),
          signature: b64urlToBuf(signature),
        });
      } catch (err) {
        if (!(err instanceof SafeOperationUncertainError)) throw err;
        console.error(`safe deploy: operation ${err.userOpHash} unconfirmed:`, describeCause(err.cause));
        // It may still land. The account stays on its old address until the
        // deployment is confirmed; preparing again finds a Safe that did land.
        return res.status(502).json({
          error: `${redactedMessage(err)} — the Safe is not recorded as deployed until that is confirmed; try again shortly`,
          code: "SAFE_OP_UNCONFIRMED",
          deployOpHash: err.userOpHash,
        });
      }
      if (op.success !== true) {
        return res.status(502).json({
          error: `the deployment ${op.userOpHash} was included but reverted — the Safe was not activated`,
          code: "SAFE_OP_REVERTED",
          deployOpHash: op.userOpHash,
        });
      }
      const opHash = op.userOpHash;
      let updated = store.updateUser(user.id, {
        address: user.passkeySafe.address,
        wallet: { type: "candide-safe", deployed: true, deployOpHash: opHash ?? undefined },
        passkeySafe: activatePasskeySafePlan(user.passkeySafe),
      });
      // The Safe can be linked to Monerium now, but the link signature is a
      // passkey ceremony the client drives next. Until this patch, an account
      // whose deploy happened after KYC approval kept the stale pre-deploy
      // funding error forever and nothing ever issued its IBAN. Record where
      // provisioning actually stands so both the client and a reload know the
      // one remaining step.
      if (updated.kycStatus === "approved" && !updated.iban && updated.funding?.status !== "active") {
        updated = store.updateUser(user.id, {
          funding: {
            ...(updated.funding ?? {}),
            mode: "sandbox",
            status: "provisioning",
            detail: "smart wallet deployed — approve IBAN issuance with your passkey",
          },
        });
      }
      // Fire-and-forget: the testnet faucet seeds the new Safe with EURe, and
      // its failure must never fail a deployment that already succeeded.
      void faucetFundSafe(user.id);
      res.status(201).json({ ...publicUser(updated), deployOpHash: opHash });
    }),
  );

  router.post(
    "/passkey/login",
    wrap(async (req, res) => {
      const { credentialId, authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "credentialId, authenticatorData, clientDataJSON and signature required" });
      }
      // Also limit per credential: the per-IP bucket does nothing against attempts
      // spread across many sources at one account.
      if (!rateLimit(`c:${tokenHash(String(credentialId))}`, SECURITY.authRateLimitPerMin)) {
        return res.status(429).json({ error: "rate limited — slow down" });
      }
      const user = store.findUserByCredential(credentialId);
      if (!user?.passkey?.publicKey) {
        return res.status(404).json({ error: "no verified passkey for this credential — register again" });
      }
      try {
        const { signCount } = await verifyAssertion(
          authenticatorData,
          clientDataJSON,
          signature,
          user.passkey.publicKey,
          user.passkey.signCount ?? 0,
          user.passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
        );
        if (!store.recordPasskeyUse(user.id, credentialId, signCount)) {
          throw new Error("this passkey is no longer the account's passkey");
        }
      } catch (err: any) {
        return res.status(401).json({ error: redactedMessage(err) });
      }
      // Minted before the next await, so a recovery that lands during it
      // revokes this session too.
      const session = withSession(user);
      const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.json({ ...session, ...balances });
    }),
  );

  return router;
}
