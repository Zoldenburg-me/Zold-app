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
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, HARNESS, SECURITY } from "../config.js";
import { accountBalances } from "../chain.js";
import { store, type User } from "../store.js";
import { rateLimit } from "../http/policy.js";
import { requireSession, tokenHash } from "../http/sessions.js";
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
  isDeployed,
  passkeyAccountAddress,
  preparePasskeySafeDeployment,
  prepareSafeSetupOperation,
  removeCosignerTransactions,
  safeOwners,
  safeThreshold,
  submitPasskeySafeOperation,
  webauthnOwnerFromStore,
} from "../wallet/candide.js";
import { b64urlToBuf, issueChallenge, verifyAssertion, verifyRegistration } from "../webauthn.js";
import { publicUser, withSession } from "../users/public-user.js";

/**
 * requireUserSession is injected so that server.ts stays the only place that
 * decides who is calling.
 */
export interface AuthDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


// --- Passkeys (full WebAuthn verification) -----------------------------------
// Registration parses and verifies the attestation (challenge, origin,
// rpIdHash) and stores the COSE public key + sign counter. Login verifies the
// assertion signature server-side before a session is issued.

export async function verifyPasskeyStepUp(user: User, body: any, res: express.Response): Promise<boolean> {
  if (!user.passkey?.publicKey) {
    if (HARNESS.enabled) return true;
    res.status(409).json({ error: "a verified passkey is required before binding a spending key" });
    return false;
  }
  const stepUp = body?.stepUp ?? {};
  const { credentialId, authenticatorData, clientDataJSON, signature } = stepUp;
  if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
    res.status(401).json({ error: "fresh passkey approval required before binding a spending key" });
    return false;
  }
  if (credentialId !== user.passkey.credentialId) {
    res.status(403).json({ error: "passkey credential does not match this account" });
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
      user.id,
    );
    store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
    return true;
  } catch (err: any) {
    res.status(401).json({ error: String(err?.message ?? err) });
    return false;
  }
}

/** Prepared co-signer removals awaiting the passkey's signature. In memory on
 *  purpose, like every other ceremony: a restart just means asking again. */
const pendingCosignerRemovals = new Map<string, { userId: string; userOperation: any; expiresAt: number }>();
function prunePendingCosignerRemovals() {
  const now = Date.now();
  for (const [id, p] of pendingCosignerRemovals) if (p.expiresAt < now) pendingCosignerRemovals.delete(id);
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
      // it: an assertion collected for one account can no longer be spent on
      // another's step-up. Login is unbound by necessity — there is no session yet.
      let binding: string | undefined;
      if (purpose !== "login") {
        const session = requireSession(req, res);
        if (!session) return;
        binding = session.userId;
      }
      res.json({ challenge: issueChallenge(purpose, binding), rpId: SECURITY.rpId });
    }),
  );

  router.post(
    "/users/:id/passkey",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if (store.findUserByCredential(credentialId)) {
        return res.status(409).json({ error: "credential already registered" });
      }
      // Replacing the account's authenticator is an account-takeover path if a
      // bearer token is enough for it: a stolen 24h session would become permanent
      // access, and the real passkey would be silently discarded. The current
      // authenticator has to approve its own replacement. First registration (no
      // verified passkey yet) is unaffected.
      if (user.passkey?.publicKey && !(await verifyPasskeyStepUp(user, req.body, res))) return;
      let reg;
      try {
        reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, user.id);
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message ?? err) });
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
          store.usersByEmail(user.email).some((u) => u.id !== user.id && !!u.passkey)) {
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
      if (user.passkeySafe.cosignerAddress && !CANDIDE.cosignerKey) {
        return res.status(503).json({ error: "CANDIDE_COSIGNER_KEY is required before passkey Safe deployment" });
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
              `npm run dev. Underlying error: ${err?.message ?? err}`
            : `passkey Safe deployment failed: ${err?.message ?? err}`,
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
      if (!authenticatorData || !clientDataJSON || !signature) {
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
      const opHash = await submitPasskeySafeOperation(user.passkeySafe, pending.userOperation, {
        authenticatorData: b64urlToBuf(authenticatorData),
        clientDataJSON: b64urlToBuf(clientDataJSON),
        signature: b64urlToBuf(signature),
      });
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
      res.status(201).json({ ...publicUser(updated), deployOpHash: opHash });
    }),
  );

  /**
   * Retire the legacy co-signer from a 2-of-2 Safe, leaving the passkey as the
   * only owner at threshold 1. After this, nothing Zold holds can take part in
   * — or block — a movement of the user's funds.
   *
   * The user's passkey signs the removal. Because the Safe is still 2-of-2
   * when the operation executes, the co-signer key counter-signs its own
   * removal; that is the last signature it gives for this Safe. The owner set
   * is read from the chain both to build the call and to confirm the result.
   */
  router.post(
    "/users/:id/passkey-safe/cosigner-removal",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const plan = user.passkeySafe;
      if (!user.passkey?.publicKey || !plan || plan.status !== "active") {
        return res.status(409).json({ error: "an active passkey Safe is required" });
      }
      const cosigner = plan.cosignerAddress;
      if (!cosigner) return res.status(409).json({ error: "this Safe has no co-signer — the passkey is already its only owner" });
      if (!CANDIDE.cosignerKey) {
        return res.status(503).json({
          error: "CANDIDE_COSIGNER_KEY is required: the Safe is still 2-of-2, so the co-signer has to counter-sign its own removal",
        });
      }
      if (privateKeyToAccount(CANDIDE.cosignerKey).address.toLowerCase() !== cosigner.toLowerCase()) {
        return res.status(503).json({
          error: "the configured CANDIDE_COSIGNER_KEY is not the co-signer on this Safe, so its counter-signature would be rejected",
        });
      }
      if (store.recoveryRequests.some((r) => r.userId === user.id && !["FINALIZED", "CANCELED", "EXPIRED"].includes(r.status))) {
        return res.status(409).json({ error: "a recovery is in progress on this account — finish or cancel it first" });
      }
      if (!(await isDeployed(plan.address))) {
        return res.status(409).json({ error: "the Safe must be deployed before its owners can change" });
      }
      const owners = HARNESS.enabled
        ? [passkeyAccountAddress(webauthnOwnerFromStore(plan.passkeyPublicKey)), cosigner]
        : await safeOwners(plan.address);
      let txs;
      try {
        txs = removeCosignerTransactions(plan.address, owners, cosigner);
      } catch (err: any) {
        return res.status(409).json({ error: String(err?.message ?? err) });
      }
      const prepared = await prepareSafeSetupOperation(plan, txs);
      prunePendingCosignerRemovals();
      const requestId = randomUUID();
      pendingCosignerRemovals.set(requestId, {
        userId: user.id,
        userOperation: prepared.userOperation,
        expiresAt: Date.now() + 5 * 60_000,
      });
      res.status(201).json({
        requestId,
        credentialId: user.passkey.credentialId,
        rpId: user.passkey.rpId ?? SECURITY.rpId,
        challenge: passkeySafeChallenge(prepared.challenge),
        cosignerAddress: cosigner,
        submitTo: `/api/users/${user.id}/passkey-safe/cosigner-removal/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/passkey-safe/cosigner-removal/:requestId",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      prunePendingCosignerRemovals();
      const pending = pendingCosignerRemovals.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) {
        return res.status(404).json({ error: "co-signer removal request not found or expired" });
      }
      const plan = user.passkeySafe;
      const cosigner = plan?.cosignerAddress;
      if (!plan || !cosigner) return res.status(409).json({ error: "this Safe has no co-signer" });
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      // Claimed BEFORE the await: two parallel submits must not both send it.
      pendingCosignerRemovals.delete(req.params.requestId);
      const opHash = await submitPasskeySafeOperation(plan, pending.userOperation, {
        authenticatorData: b64urlToBuf(authenticatorData),
        clientDataJSON: b64urlToBuf(clientDataJSON),
        signature: b64urlToBuf(signature),
      });
      // Believe the chain, not the bundler's receipt: the stored plan changes
      // only once the owner set really lacks the co-signer.
      if (!HARNESS.enabled) {
        const [owners, threshold] = await Promise.all([safeOwners(plan.address), safeThreshold(plan.address)]);
        if (owners.some((o) => o.toLowerCase() === cosigner.toLowerCase()) || threshold !== 1) {
          return res.status(502).json({
            error: "the operation was submitted but the Safe still lists the co-signer — check the chain before retrying",
            opHash,
          });
        }
      }
      const updated = store.updateUser(user.id, {
        passkeySafe: {
          ...plan,
          cosignerAddress: undefined,
          threshold: 1,
          cosignerPolicy: plan.cosignerPolicy ? { ...plan.cosignerPolicy, enabled: false } : undefined,
          cosignerRemovedAt: new Date().toISOString(),
          cosignerRemovalOpHash: opHash ?? undefined,
        },
      });
      console.log(`CO-SIGNER: removed from ${user.id}'s Safe ${plan.address} (op ${opHash})`);
      res.status(201).json({ ...publicUser(updated), opHash });
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
        store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }
      const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.json({ ...withSession(user), ...balances });
    }),
  );

  return router;
}
