/**
 * Monerium: identity and the euro rail, connected by OAuth or by the user's
 * own API keys.
 *
 * Connecting is not approval. kycStatus stays pending until an IBAN is
 * attributed to this Safe's address on the connected account; that address
 * match is the only evidence that the Monerium account holder is the person
 * holding this Zold account.
 *
 * The OAuth callback is bound to an HttpOnly cookie nonce as well as `state`.
 * With state alone, an attacker could start a connect on their own account,
 * send the victim the consent link and receive the victim's tokens. The
 * connect must start in the browser that finishes it.
 *
 * Token encryption, refresh and "whose credentials act for this user" live in
 * adapters/monerium-connection.ts, because the sandbox adapter's redeem and
 * deposit polling need the same answer.
 */
import express from "express";
import { wrap } from "./util.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  IS_PRODUCTION,
  MONERIUM,
  PUBLIC_URL,
  SECURITY,
  moneriumOAuthEnabled,
  moneriumSandboxEnabled,
} from "../config.js";
import { accountBalances } from "../chain.js";
import { auditEntry } from "../audit.js";
import { store, type User } from "../store.js";
import { cookieValue } from "../http/sessions.js";
import { custodyBlockerBeforeFunding, requireCapability } from "../http/guards.js";
import { pendingMoneriumLinkSignatures, prunePendingMoneriumLinkSignatures } from "../http/pending.js";
import { publicUser } from "../users/public-user.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  isDeployed,
  safeMessageHash,
  signMessageAsPasskeySafe,
  } from "../wallet/candide.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import {
  encryptToken,
  forgetUserClient,
  hasOwnMoneriumCredentials,
  moneriumAccessToken,
  moneriumApiKeysAvailable,
  moneriumEnvironment,
  moneriumLinkAccessToken,
  validateApiKeyInput,
  verifyApiKeys,
} from "../adapters/monerium-connection.js";
import {
  exchangeAuthorizationCode,
  LINK_MESSAGE,
  MoneriumApiError,
  moneriumBearerRequest,
} from "../adapters/monerium-client.js";

const sandbox = moneriumSandboxEnabled();
const CONNECT_COOKIE = "zold_monerium_connect";
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

/** requireUserSession is injected — server.ts owns authentication. */
export interface MoneriumDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

/** The configured Monerium redirect URI, or the callback on a trusted origin. */
function allowedRedirectUri(candidate: string): boolean {
  if (!candidate) return false;
  if (candidate === MONERIUM.redirectUri) return true;
  try {
    const url = new URL(candidate);
    return SECURITY.origins.includes(url.origin) && url.pathname === "/api/monerium/oauth/callback";
  } catch {
    return false;
  }
}

function base64url(buf: Buffer) {
  return buf.toString("base64url");
}

function pkceChallenge(verifier: string) {
  return base64url(createHash("sha256").update(verifier).digest());
}

/*
 * Monerium token handling — encryption at rest, OAuth refresh, the app client
 * and the "whose credentials act for this user" decision — lives in
 * adapters/monerium-connection.ts, because the sandbox adapter's redeem and
 * deposit polling need the same answer as the routes below. Same AES-256-GCM
 * scheme as before (crypto-at-rest.ts, purpose `monerium`), so tokens written
 * by the previous in-file copy still decrypt.
 */

async function readMoneriumAccountSnapshot(user: User, accessToken?: string) {
  accessToken ??= await moneriumAccessToken(user);
  const [context, profileRes, ibanRes, addressRes] = await Promise.all([
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/auth/context"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/profiles"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/ibans"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/addresses"),
  ]);
  const profiles = Array.isArray(profileRes) ? profileRes : (profileRes?.profiles ?? []);
  const ibans = Array.isArray(ibanRes) ? ibanRes : (ibanRes?.ibans ?? []);
  const addresses = Array.isArray(addressRes) ? addressRes : (addressRes?.addresses ?? []);
  return { context, profiles, ibans, addresses };
}

/**
 * Connect the user's own Monerium app credentials.
 *
 * For testing against your own Monerium account: create an app in the
 * account's developer section and paste its client id and secret. The server
 * checks the pair against Monerium first, stores the secret encrypted and
 * treats the connection like an OAuth one. Activation, deposit polling and
 * SEPA redeems run on these credentials, since the app's own keys cannot see
 * the user's profile.
 *
 * This does not approve KYC. Approval comes from activation (an
 * address-matched IBAN on the connected account), as for OAuth, unless the
 * connected account already attributes an IBAN to this Safe.
 */
/**
 * Forget the user's API keys. The IBAN Monerium issued stays recorded (it
 * exists at Monerium either way), but nothing on this account can be read or
 * redeemed until keys are connected again, and the funding detail says so.
 */

export function createMoneriumRouter(deps: MoneriumDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/users/:id/monerium/connect/start",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "monerium", res)) return;
      if (!moneriumOAuthEnabled()) {
        return res.status(503).json({ error: "Monerium OAuth client is not configured" });
      }
      if (!MONERIUM.tokenEncryptionKey) {
        return res.status(503).json({ error: "Monerium token encryption key is not configured" });
      }
      const state = randomBytes(24).toString("base64url");
      const codeVerifier = randomBytes(48).toString("base64url");
      // The redirect target is ours or nothing: the configured URI, or the
      // callback path on an origin this deployment already trusts for passkeys.
      // Monerium's exact-match registration is not the only thing between a
      // body-supplied URL and the token exchange.
      const requested = typeof req.body?.redirectUri === "string" ? req.body.redirectUri : "";
      const redirectUri = allowedRedirectUri(requested) ? requested : MONERIUM.redirectUri;
      // The browser that started this connection is the only one that may
      // finish it. Without the nonce cookie, an attacker could start a connect
      // on THEIR account, send the victim the consent link, and have the
      // victim's Monerium tokens land on the attacker's account.
      const nonce = randomBytes(24).toString("base64url");
      const approved = user.kycStatus === "approved";
      store.updateUser(user.id, {
        kyc: { ...user.kyc, provider: "monerium", onboardingPath: "existing_monerium" },
        // A live account re-connecting keeps its funding state; only a pending
        // one is (re)marked as waiting on Monerium.
        ...(approved
          ? {}
          : {
              funding: {
                ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }),
                status: "kyc_pending" as const,
                detail: "connect existing Monerium account",
              },
            }),
        moneriumConnect: {
          state,
          codeVerifier,
          redirectUri,
          nonceHash: sha256Hex(nonce),
          createdAt: new Date().toISOString(),
        },
      });
      res.setHeader(
        "set-cookie",
        `${CONNECT_COOKIE}=${nonce}; Path=/api/monerium/oauth; Max-Age=600; HttpOnly; SameSite=Lax` +
          (IS_PRODUCTION || PUBLIC_URL.startsWith("https://") ? "; Secure" : ""),
      );
      const params = new URLSearchParams({
        response_type: "code",
        client_id: MONERIUM.oauthClientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: "S256",
      });
      res.status(201).json({ redirectUrl: `${MONERIUM.authUrl}?${params}` });
    }),
  );

  router.get(
    "/monerium/oauth/callback",
    wrap(async (req, res) => {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!state || !code) return res.status(400).json({ error: "state and code required" });
      const user = store.users.find((u) => u.moneriumConnect?.state === state);
      if (!user?.moneriumConnect) return res.status(400).json({ error: "unknown or expired OAuth state" });
      if (Date.now() - Date.parse(user.moneriumConnect.createdAt) > 10 * 60_000) {
        store.updateUser(user.id, { moneriumConnect: undefined });
        return res.status(410).json({ error: "OAuth state expired; start Monerium connect again" });
      }
      const nonce = cookieValue(req, CONNECT_COOKIE);
      if (!nonce || sha256Hex(nonce) !== user.moneriumConnect.nonceHash) {
        return res.status(400).json({
          error: "this Monerium connection was started in a different browser — start it again from the app",
        });
      }

      const token = await exchangeAuthorizationCode(
        {
          baseUrl: MONERIUM.baseUrl,
          clientId: MONERIUM.oauthClientId,
          clientSecret: MONERIUM.clientSecret,
        },
        {
          code,
          codeVerifier: user.moneriumConnect.codeVerifier,
          redirectUri: user.moneriumConnect.redirectUri,
        },
      );
      const snapshot = await readMoneriumAccountSnapshot(user, token.access_token);
      const approvedProfile = snapshot.profiles.find((p: any) => p.state === "approved");
      const profileId = approvedProfile?.id ?? snapshot.profiles[0]?.id;

      store.updateUser(user.id, {
        moneriumConnect: undefined,
        kyc: {
          provider: "monerium",
          onboardingPath: "existing_monerium",
          checkedAt: undefined,
          applicantId: profileId,
          reason: "existing Monerium account connected; activate IBAN with passkey",
        },
        funding: {
          mode: "sandbox",
          status: "provisioning",
          moneriumProfileId: profileId,
          detail: "smart wallet deployed — approve IBAN issuance with your passkey",
        },
        monerium: {
          connectedAt: new Date().toISOString(),
          profileId,
          accessTokenEnc: encryptToken(token.access_token),
          refreshTokenEnc: token.refresh_token ? encryptToken(token.refresh_token) : undefined,
          expiresAt: token.expires_in
            ? new Date(Date.now() + token.expires_in * 1000).toISOString()
            : undefined,
          profiles: snapshot.profiles,
          ibans: snapshot.ibans,
          addresses: snapshot.addresses,
        },
      });
      // The app lives at /app, not /, since the landing page took the root.
      res.redirect("/app?monerium=connected");
    }),
  );

  router.get(
    "/users/:id/monerium/accounts",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!hasOwnMoneriumCredentials(user)) {
        return res.status(409).json({ error: "no Monerium account is connected to this account — connect one by OAuth or with your own API keys" });
      }
      const snapshot = await readMoneriumAccountSnapshot(user);
      const updated = store.updateUser(user.id, {
        monerium: { ...user.monerium!, ...snapshot },
      });
      res.json(publicUser(updated).monerium);
    }),
  );

  router.post(
    "/users/:id/monerium/link-signature/start",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const custodyBlocked = custodyBlockerBeforeFunding(user);
      if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
      if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
        return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
      }
      // Fail here, before the passkey ceremony, if no Monerium access exists —
      // a ceremony whose submit is doomed just burns the user's approval.
      await moneriumLinkAccessToken(user);
      if (!(await isDeployed(user.address))) {
        return res.status(409).json({ error: "passkey Safe must be deployed before Monerium address linking" });
      }
      prunePendingMoneriumLinkSignatures();
      const requestId = randomUUID();
      const profileId = typeof req.body?.profileId === "string" ? req.body.profileId : user.monerium?.profileId;
      const challenge = passkeySafeChallenge(safeMessageHash(user.address, LINK_MESSAGE));
      pendingMoneriumLinkSignatures.set(requestId, {
        userId: user.id,
        profileId,
        challenge,
        expiresAt: Date.now() + 5 * 60_000,
      });
      res.status(201).json({
        requestId,
        credentialId: user.passkey.credentialId,
        challenge,
        rpId: user.passkey.rpId ?? SECURITY.rpId,
        message: LINK_MESSAGE,
        address: user.address,
        submitTo: `/api/users/${user.id}/monerium/activate`,
      });
    }),
  );

  router.post(
    "/users/:id/monerium/activate",
    wrap(async (req, res) => {
      let user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "monerium", res)) return;
      const custodyBlocked = custodyBlockerBeforeFunding(user);
      if (custodyBlocked) {
        return res.status(409).json({ error: custodyBlocked });
      }
      const { accessToken, viaApp } = await moneriumLinkAccessToken(user);

      if (!(await isDeployed(user.address))) {
        return res.status(409).json({
          error: "passkey Safe must be deployed before Monerium address linking",
        });
      }
      if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
        return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
      }
      // Captured under the guard above: `user` is reassigned below (store
      // updates), which discards TypeScript's narrowing on these.
      const passkey = user.passkey;
      const passkeyKey = user.passkey.publicKey;
      const passkeySafe = user.passkeySafe;

      prunePendingMoneriumLinkSignatures();
      let profileId: string | undefined;
      let signature: `0x${string}`;

      const rawSignature = req.body?.signature;
      if (typeof rawSignature === "string" && /^0x[0-9a-fA-F]+$/.test(rawSignature)) {
        signature = rawSignature as `0x${string}`;
        profileId = typeof req.body?.profileId === "string" ? req.body.profileId : user.monerium?.profileId;
      } else {
        const requestId =
          typeof req.body?.requestId === "string"
            ? req.body.requestId
            : typeof req.body?.linkSignatureRequestId === "string"
            ? req.body.linkSignatureRequestId
            : "";
        const pending = requestId ? pendingMoneriumLinkSignatures.get(requestId) : undefined;
        if (!pending || pending.userId !== user.id) {
          return res.status(409).json({
            error: "fresh passkey Safe signature required for Monerium address linking",
            start: `/api/users/${user.id}/monerium/link-signature/start`,
          });
        }
        pendingMoneriumLinkSignatures.delete(requestId);
        const { authenticatorData, clientDataJSON, signature: assertionSignature } = req.body ?? {};
        if (!authenticatorData || !clientDataJSON || !assertionSignature) {
          return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
        }
        profileId =
          pending.profileId ?? user.monerium?.profileId ?? user.funding?.moneriumProfileId;
        /**
         * No whitelabel path: the app never creates Monerium profiles for a
         * user. The address is linked under the profile the USER's own
         * connection (OAuth or API keys) exposes, so without one there is
         * nothing to link to and the route refuses above.
         */
        if (viaApp) {
          return res.status(409).json({
            error: "connect a Monerium account first — sign in with Monerium or add your Monerium API keys — before activating an IBAN",
          });
        }
        try {
          const { signCount } = await verifyAssertionForChallenge(
            authenticatorData,
            clientDataJSON,
            assertionSignature,
            passkeyKey,
            passkey.signCount ?? 0,
            passkey.rpId ?? SECURITY.rpId,
            SECURITY.origins,
            pending.challenge,
            true,
          );
          user = store.updateUser(user.id, { passkey: { ...passkey, signCount } });
          signature = await signMessageAsPasskeySafe(passkeySafe, user.address, LINK_MESSAGE, {
            authenticatorData: b64urlToBuf(authenticatorData),
            clientDataJSON: b64urlToBuf(clientDataJSON),
            signature: b64urlToBuf(assertionSignature),
          });
        } catch (err: any) {
          return res.status(401).json({ error: String(err?.message ?? err) });
        }
      }
      /**
       * Wrong-profile bindings are detected and parked. Don't unlink them. An
       * address linked under the app's default profile has its IBAN request
       * park forever, and POST /addresses answers "already linked" without
       * moving the binding. Unlinking to re-link burns the address: Monerium
       * answers every later link with "Cannot link, please contact support",
       * and a Safe's address cannot change (seen on 0x9650E5…). Detection tells
       * the operator what to raise with Monerium.
       */
      let wrongProfileBinding: string | undefined;
      if (viaApp && profileId) {
        try {
          const rec = await moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", `/addresses/${user.address}`);
          if (rec?.profile && rec.profile !== profileId) wrongProfileBinding = rec.profile;
        } catch {
          // not linked yet — the normal first-run case
        }
      }
      const alreadyDone = (err: unknown) =>
        err instanceof MoneriumApiError &&
        err.status < 500 &&
        /already|exist|duplicate/i.test(err.message);
      try {
        await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/addresses", {
          address: user.address,
          signature,
          chain: MONERIUM.chain,
          message: LINK_MESSAGE,
          ...(profileId ? { profile: profileId } : {}),
        });
      } catch (err: any) {
        if (!alreadyDone(err)) {
          console.error(`monerium activate: address linking refused for ${user.id}: ${err?.message ?? err}`);
          // "Cannot link ... contact support" is Monerium's permanent verdict on
          // a burned (once-unlinked) address. A Safe's address cannot change, so
          // record it: the client stops offering an activation that can only
          // fail, and the account page says why instead of erroring forever.
          if (/cannot link/i.test(String(err?.message ?? ""))) {
            store.updateUser(user.id, {
              funding: {
                ...(user.funding ?? { mode: "sandbox" as const }),
                mode: "sandbox",
                status: "error",
                addressUnlinkable: true,
                detail: "Monerium cannot link this address (support required) — this account cannot receive an IBAN; open a new account",
              } as User["funding"],
            });
          }
          // 400, not 502: Cloudflare swallows origin 502 bodies with its own
          // error page, so the reason above never reached the user.
          return res.status(400).json({ error: `Monerium refused the address linking: ${err?.message ?? err}` });
        }
      }
      try {
        await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/ibans", {
          address: user.address,
          chain: MONERIUM.chain,
        });
      } catch (err: any) {
        if (!alreadyDone(err)) {
          console.error(`monerium activate: IBAN request refused for ${user.id}: ${err?.message ?? err}`);
          return res.status(400).json({ error: `Monerium refused the IBAN request: ${err?.message ?? err}` });
        }
      }
      const snapshot = await readMoneriumAccountSnapshot(user, accessToken);
      /**
       * Address-matched IBANs only.
       *
       * With app credentials the snapshot lists every customer's IBAN. Falling
       * back to the first one when this address's is not issued yet would show
       * another account's IBAN here, and a payment sent to it mints into that
       * user's Safe. No IBAN yet means iban_pending; refreshPendingIban polls
       * by address and attributes it.
       */
      const iban =
        snapshot.ibans.find(
          (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
        )?.iban ?? "";

      const updated = store.updateUser(user.id, {
        // What Monerium attributes to THIS address, or nothing. Falling back to
        // a previously stored value would preserve a mis-attribution.
        iban,
        // Approval is the address-matched IBAN, not the POSTs succeeding: a
        // "duplicate" answer on both proves nothing about THIS address, and an
        // IBAN not yet issued is iban_pending, which refreshPendingIban resolves
        // and approves when it lands.
        ...(viaApp || !iban
          ? {}
          : {
              kycStatus: "approved" as const,
              kyc: {
                provider: "monerium" as const,
                onboardingPath: "existing_monerium" as const,
                checkedAt: new Date().toISOString(),
                applicantId: profileId,
                reason: `approved via connected Monerium profile ${profileId ?? "(unnamed)"}`,
              },
            }),
        funding: {
          mode: "sandbox",
          status: iban ? "active" : "iban_pending",
          moneriumProfileId: profileId,
          detail: iban
            ? undefined
            : wrongProfileBinding
              ? `address is linked under Monerium profile ${wrongProfileBinding} instead of this account's — needs Monerium support to move; do NOT unlink`
              : "Monerium IBAN requested; waiting for activation",
        },
        monerium: { ...user.monerium!, profileId, ...snapshot },
      });
      const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.json({ ...publicUser(updated), ...balances });
    }),
  );

  router.delete(
    "/users/:id/monerium/connect",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      forgetUserClient(user.id);
      const updated = store.updateUser(user.id, {
        moneriumConnect: undefined,
        monerium: undefined,
        funding: { ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }), status: "kyc_pending" as const },
      });
      res.json(publicUser(updated));
    }),
  );

  router.post(
    "/users/:id/monerium/api-keys",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "monerium", res)) return;
      if (!moneriumApiKeysAvailable()) {
        return res.status(503).json({
          error: "Monerium token encryption key is not configured — set MONERIUM_TOKEN_ENCRYPTION_KEY; API keys are never stored in plaintext",
        });
      }
      let input: ReturnType<typeof validateApiKeyInput>;
      try {
        input = validateApiKeyInput(req.body);
      } catch (err: any) {
        return res.status(400).json({ error: err?.message ?? "invalid credentials" });
      }
      let verified: Awaited<ReturnType<typeof verifyApiKeys>>;
      try {
        verified = await verifyApiKeys(input.clientId, input.clientSecret);
      } catch (err: any) {
        if (err instanceof MoneriumApiError && err.status < 500) {
          store.audit(auditEntry("partner.call_refused", { partner: "monerium", capability: "api_keys", status: err.status }, user.id));
          return res.status(400).json({ error: err.message });
        }
        return res.status(503).json({ error: `Monerium could not be reached to verify the keys: ${String(err?.message ?? err).slice(0, 200)}` });
      }

      const approvedProfile = verified.profiles.find((p: any) => p.state === "approved");
      const profileId = approvedProfile?.id ?? verified.profiles[0]?.id;
      // ADDRESS-MATCHED ONLY, for the reason activate gives: any other IBAN in
      // the snapshot is somebody's money routing, not this account's.
      const ownIban =
        verified.ibans.find(
          (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
        )?.iban ?? "";
      const now = new Date().toISOString();
      const wasApproved = user.kycStatus === "approved";

      const updated = store.updateUser(user.id, {
        moneriumConnect: undefined,
        ...(wasApproved
          ? {}
          : ownIban
            ? {
                kycStatus: "approved" as const,
                kyc: {
                  provider: "monerium" as const,
                  onboardingPath: "existing_monerium" as const,
                  checkedAt: now,
                  applicantId: profileId,
                  reason: `approved via connected Monerium profile ${profileId ?? "(unnamed)"} (IBAN already attributed to this account)`,
                },
              }
            : {
                kyc: {
                  provider: "monerium" as const,
                  onboardingPath: "existing_monerium" as const,
                  applicantId: profileId,
                  reason: "own Monerium API keys connected; activate IBAN with passkey",
                },
              }),
        ...(ownIban ? { iban: ownIban } : {}),
        funding: {
          ...(user.funding ?? {}),
          mode: "sandbox" as const,
          status: ownIban
            ? ("active" as const)
            : user.funding?.status === "active"
              ? ("active" as const)
              : ("provisioning" as const),
          moneriumProfileId: profileId,
          detail: ownIban
            ? `IBAN attributed to this account by your Monerium (${moneriumEnvironment()}) account`
            : user.funding?.status === "active"
                ? "own Monerium keys connected; the existing IBAN is kept and Monerium calls for this account now use your keys"
                : "own Monerium account connected — approve IBAN issuance with your passkey",
        },
        monerium: {
          connectedAt: now,
          method: "api_keys",
          profileId,
          apiKeys: {
            clientId: input.clientId,
            clientSecretEnc: encryptToken(input.clientSecret),
            baseUrl: MONERIUM.baseUrl,
            label: input.label,
            verifiedAt: now,
            accountEmail: typeof verified.context?.email === "string" ? verified.context.email : undefined,
          },
          profiles: verified.profiles,
          ibans: verified.ibans,
          addresses: verified.addresses,
        },
      });
      forgetUserClient(user.id);
      store.audit(auditEntry(
        "partner.credentials_connected",
        { partner: "monerium", method: "api_keys", clientId: input.clientId, environment: moneriumEnvironment(), profileId, ibanAttributed: Boolean(ownIban) },
        user.id,
      ));
      const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.status(201).json({ ...publicUser(updated), ...balances });
    }),
  );

  router.delete(
    "/users/:id/monerium/api-keys",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (user.monerium?.method !== "api_keys") {
        return res.status(409).json({ error: "no Monerium API keys are connected to this account" });
      }
      forgetUserClient(user.id);
      const updated = store.updateUser(user.id, {
        monerium: undefined,
        funding: user.funding
          ? {
              ...user.funding,
              detail: sandbox
                ? "own Monerium keys removed; the app's credentials act for this account again"
                : "own Monerium keys removed — deposits and payouts on this account are paused until keys are connected again",
            }
          : user.funding,
      });
      store.audit(auditEntry("partner.credentials_removed", { partner: "monerium", method: "api_keys" }, user.id));
      res.json(publicUser(updated));
    }),
  );

  return router;
}
