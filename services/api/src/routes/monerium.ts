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
import { pickProfileForSignup } from "../domain/monerium-profile.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  isDeployed,
  safeMessageHash,
  signMessageAsPasskeySafe,
  } from "../wallet/candide.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import { normalizeIban } from "../sepa.js";
import { confirmedMoves, mayApproveOnIban, releaseIbanFromOtherUsers } from "../adapters/monerium-sandbox.js";
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
 * The profile this login was connected under, recorded at connect by
 * pickProfileForSignup. Linking, IBAN issuance and moves all use it; a
 * profile id the browser names is only accepted when it is this one.
 */
function connectedProfileId(user: User): string | undefined {
  return user.monerium?.profileId ?? user.funding?.moneriumProfileId;
}

function otherProfileRefused(user: User, named: unknown) {
  if (typeof named !== "string" || !named) return undefined;
  const connected = connectedProfileId(user);
  if (connected && named === connected) return undefined;
  return {
    error: "This Zold account uses only the Monerium profile it was connected with. Another profile on the same Monerium login cannot be used here.",
    code: "MONERIUM_PROFILE_NOT_CONNECTED",
  };
}

/** An IBAN Monerium attributes to this address, on the connected profile.
 *  An item that names another profile is not this account's; one that names
 *  none is taken on the address match alone. */
function ownIbanOf(ibans: any[], address: string, profileId: string | undefined): string {
  return (
    ibans.find(
      (i: any) =>
        String(i?.address ?? "").toLowerCase() === address.toLowerCase() &&
        i.iban &&
        !(profileId && typeof i.profile === "string" && i.profile !== profileId),
    )?.iban ?? ""
  );
}

/**
 * May an IBAN this account already stores stay through a (re)connect under
 * `profileId`? Only when the connected login lists it on that profile. A
 * login connected earlier under its personal profile and now under its
 * corporate one would otherwise keep a personal IBAN on a company account.
 */
function storedIbanOnProfile(user: User, ibans: any[], profileId: string): boolean {
  const stored = ibanKey(user.iban);
  return Boolean(stored) && ibans.some((i: any) => ibanKey(i?.iban) === stored && i?.profile === profileId);
}

type Hex = `0x${string}`;
type ActiveSafeUser = User & {
  passkey: NonNullable<User["passkey"]>;
  passkeySafe: NonNullable<User["passkeySafe"]>;
};
const hasActiveSafe = (user: User): user is ActiveSafeUser =>
  Boolean(user.passkey?.publicKey && user.passkeySafe && user.passkeySafe.status === "active");

const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** An IBAN as the user typed or Monerium listed it, compared without spaces. */
const ibanKey = (v: unknown) => (typeof v === "string" ? normalizeIban(v) : "");
const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/;

/**
 * Monerium's answer to POST /ibans for a profile that already has its one
 * IBAN: 304, with no body (fetch drops a 304's body, so the status is the
 * signal; the text is matched too in case a proxy rewrites the status).
 */
const profileAlreadyHasIban = (err: unknown) =>
  err instanceof MoneriumApiError &&
  (err.status === 304 || /already has an iban/i.test(err.message));

const alreadyDone = (err: unknown) =>
  err instanceof MoneriumApiError &&
  err.status < 500 &&
  /already|exist|duplicate/i.test(err.message);

/**
 * Verify the passkey assertion over `challenge` (the Safe message hash of
 * LINK_MESSAGE) and turn it into the Safe's EIP-1271 signature. The API holds
 * no key: without the user's fresh assertion there is no signature.
 */
async function passkeySafeLinkSignature(
  user: ActiveSafeUser,
  challenge: string,
  body: any,
): Promise<{ user: User; signature: Hex }> {
  const { authenticatorData, clientDataJSON, signature: assertionSignature } = body ?? {};
  const passkey = user.passkey;
  if (!passkey.publicKey) throw new Error("no passkey public key on this account");
  const { signCount } = await verifyAssertionForChallenge(
    authenticatorData,
    clientDataJSON,
    assertionSignature,
    passkey.publicKey,
    passkey.signCount ?? 0,
    passkey.rpId ?? SECURITY.rpId,
    SECURITY.origins,
    challenge,
    true,
  );
  const updated = store.updateUser(user.id, { passkey: { ...passkey, signCount } });
  const signature = await signMessageAsPasskeySafe(user.passkeySafe, user.address, LINK_MESSAGE, {
    authenticatorData: b64urlToBuf(authenticatorData),
    clientDataJSON: b64urlToBuf(clientDataJSON),
    signature: b64urlToBuf(assertionSignature),
  });
  return { user: updated, signature };
}

/**
 * POST /addresses: link the Safe under `profileId` with its signed ownership
 * declaration. "Already linked" is success. Returns the refusal to send, or
 * undefined when the address is linked (or was already).
 */
async function linkSafeAddress(
  user: User,
  accessToken: string,
  signature: Hex,
  profileId: string | undefined,
): Promise<string | undefined> {
  try {
    await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/addresses", {
      address: user.address,
      signature,
      chain: MONERIUM.chain,
      message: LINK_MESSAGE,
      ...(profileId ? { profile: profileId } : {}),
    });
    return undefined;
  } catch (err: any) {
    if (alreadyDone(err)) return undefined;
    console.error(`monerium: address linking refused for ${user.id}: ${err?.message ?? err}`);
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
    return `Monerium refused the address linking: ${err?.message ?? err}`;
  }
}

/** The profile Monerium has this address linked under, or undefined. */
async function linkedProfileOf(accessToken: string, address: string): Promise<string | undefined> {
  try {
    const rec = await moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", `/addresses/${address}`);
    return typeof rec?.profile === "string" && rec.profile ? rec.profile : undefined;
  } catch {
    return undefined;
  }
}

const maskIban = (iban: string) => `•••• ${normalizeIban(iban).slice(-4)}`;

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
      // Prefill Monerium's login and sign-up form with the email this Zold
      // account signed up with: Monerium cannot be told which profile kind to
      // use, and the profile follows the Monerium login, so the email is the
      // one steer we have. The user can still change it there.
      if (user.email) params.set("email", user.email);
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
      // A personal signup uses only its personal profile, a company signup
      // only its corporate one. No profile of that kind: nothing is stored,
      // not even the token, and the app shows why.
      const pick = pickProfileForSignup(user.accountType, snapshot.profiles);
      if (!pick.ok) {
        store.updateUser(user.id, {
          moneriumConnect: undefined,
          moneriumRefusal: { code: pick.code, error: pick.error, at: new Date().toISOString() },
        });
        store.audit(auditEntry(
          "partner.connect_refused",
          { partner: "monerium", method: "oauth", code: pick.code, accountType: user.accountType ?? "individual" },
          user.id,
        ));
        return res.redirect("/app?monerium=refused");
      }
      const profileId = pick.profile.id;
      // An IBAN from another profile is not carried into this connection.
      const dropIban = Boolean(user.iban) && !storedIbanOnProfile(user, snapshot.ibans, profileId);

      store.updateUser(user.id, {
        moneriumConnect: undefined,
        moneriumRefusal: undefined,
        ...(dropIban ? { iban: undefined } : {}),
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
      // No access at all is the account's state, not a server fault: a 409
      // the UI can show, not a 500.
      if (!hasOwnMoneriumCredentials(user) && !MONERIUM.clientSecret) {
        return res.status(409).json({
          error: "no Monerium connection for this account — sign in with Monerium or add your Monerium API keys first",
          code: "MONERIUM_NOT_CONNECTED",
        });
      }
      await moneriumLinkAccessToken(user);
      if (!(await isDeployed(user.address))) {
        return res.status(409).json({ error: "passkey Safe must be deployed before Monerium address linking" });
      }
      // A move is approved for the one IBAN the user confirmed, and its
      // ceremony is good for nothing else.
      const purpose = req.body?.purpose === "move-iban" ? ("move-iban" as const) : ("activate" as const);
      const iban = purpose === "move-iban" ? ibanKey(req.body?.iban) : undefined;
      if (purpose === "move-iban" && !IBAN_SHAPE.test(iban ?? "")) {
        return res.status(400).json({ error: "the IBAN to move is required" });
      }
      const otherProfile = otherProfileRefused(user, req.body?.profileId);
      if (otherProfile) return res.status(409).json(otherProfile);
      prunePendingMoneriumLinkSignatures();
      const requestId = randomUUID();
      const profileId = connectedProfileId(user);
      const challenge = passkeySafeChallenge(safeMessageHash(user.address, LINK_MESSAGE));
      pendingMoneriumLinkSignatures.set(requestId, {
        userId: user.id,
        profileId,
        challenge,
        purpose,
        ...(iban ? { iban } : {}),
        expiresAt: Date.now() + 5 * 60_000,
      });
      res.status(201).json({
        requestId,
        credentialId: user.passkey.credentialId,
        challenge,
        rpId: user.passkey.rpId ?? SECURITY.rpId,
        message: LINK_MESSAGE,
        address: user.address,
        submitTo: `/api/users/${user.id}/monerium/${purpose === "move-iban" ? "move-iban" : "activate"}`,
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
      if (!hasActiveSafe(user)) {
        return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
      }
      // Captured under the guard above: `user` is reassigned below (store
      // updates), which discards TypeScript's narrowing.
      const safeUser = user;

      prunePendingMoneriumLinkSignatures();
      let profileId: string | undefined;
      let signature: `0x${string}`;

      const rawSignature = req.body?.signature;
      if (typeof rawSignature === "string" && /^0x[0-9a-fA-F]+$/.test(rawSignature)) {
        signature = rawSignature as `0x${string}`;
        const otherProfile = otherProfileRefused(user, req.body?.profileId);
        if (otherProfile) return res.status(409).json(otherProfile);
        profileId = connectedProfileId(user);
      } else {
        const requestId =
          typeof req.body?.requestId === "string"
            ? req.body.requestId
            : typeof req.body?.linkSignatureRequestId === "string"
            ? req.body.linkSignatureRequestId
            : "";
        const pending = requestId ? pendingMoneriumLinkSignatures.get(requestId) : undefined;
        if (!pending || pending.userId !== user.id || pending.purpose === "move-iban") {
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
        profileId = connectedProfileId(user) ?? pending.profileId;
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
          ({ user, signature } = await passkeySafeLinkSignature(safeUser, pending.challenge, req.body));
        } catch (err: any) {
          return res.status(401).json({ error: String(err?.message ?? err) });
        }
      }
      // The address is linked under the ONE profile this login was connected
      // with (pickProfileForSignup: corporate for a company signup). Without a
      // recorded profile, POST /addresses would fall back to the token's
      // default profile, which for a company's Monerium login can be its
      // personal one.
      if (!profileId) {
        return res.status(409).json({
          error: "Zold has no Monerium profile recorded for this account, so it cannot tell whose IBAN to activate. Connect your Monerium account again, then activate.",
          code: "MONERIUM_NOT_CONNECTED",
        });
      }
      const linkRefused = await linkSafeAddress(user, accessToken, signature, profileId);
      if (linkRefused) {
        // 400, not 502: Cloudflare swallows origin 502 bodies with its own
        // error page, so the reason never reached the user.
        return res.status(400).json({ error: linkRefused });
      }
      /**
       * Check where the address actually is before asking for an IBAN: POST
       * /addresses answers "already linked" without moving an earlier binding,
       * and POST /ibans issues under whatever profile the address is linked
       * to. A company Safe linked under its owner's personal profile would get
       * a personal IBAN. Refuse, and don't unlink: unlinking burns the address
       * (Monerium answers every later link with "Cannot link, please contact
       * support", and a Safe's address cannot change).
       */
      const linkedUnder = await linkedProfileOf(accessToken, user.address);
      if (linkedUnder !== profileId) {
        const kindOf = (id: string | undefined) =>
          (user.monerium?.profiles ?? []).find((p: any) => p?.id === id)?.kind as string | undefined;
        const other = kindOf(linkedUnder);
        const detail = linkedUnder
          ? `address is linked under Monerium profile ${linkedUnder}${other ? ` (${other})` : ""}, not ${profileId}; needs Monerium support to move; do NOT unlink`
          : `Monerium does not show this address linked under profile ${profileId}`;
        store.updateUser(user.id, {
          funding: { ...(user.funding ?? { mode: "sandbox" as const, status: "provisioning" as const }), detail },
        });
        return res.status(409).json({
          error: linkedUnder
            ? `Monerium has this account's address under your ${other ?? "other"} profile, not the ${kindOf(profileId) ?? "connected"} one Zold uses, so no IBAN was requested. Monerium support has to move it; write to support@zoldhq.com and we will raise it with them.`
            : "Monerium did not confirm which profile this account's address is linked under, so no IBAN was requested. Try again in a moment.",
          code: "ADDRESS_NOT_ON_PROFILE",
        });
      }
      // A Monerium profile has ONE IBAN. For a profile that already has it,
      // POST /ibans answers 304: not a refusal, but not an IBAN for this Safe
      // either. What to do about it is the user's call (move-iban).
      let profileHasIban = false;
      try {
        await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/ibans", {
          address: user.address,
          chain: MONERIUM.chain,
        });
      } catch (err: any) {
        if (profileAlreadyHasIban(err)) {
          profileHasIban = true;
        } else if (!alreadyDone(err)) {
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
      const iban = ownIbanOf(snapshot.ibans, user.address, profileId);
      // POST /ibans is not the only witness: the sandbox has answered 201 for a
      // profile whose one IBAN pays another address, which parked the account
      // in iban_pending for an IBAN that never comes. The user's own snapshot
      // (scoped to their profiles, unlike the app's) says so directly.
      if (!viaApp && profileId && !iban) {
        profileHasIban ||= snapshot.ibans.some(
          (i: any) =>
            i?.profile === profileId &&
            ibanKey(i.iban) &&
            String(i?.address ?? "").toLowerCase() !== user.address.toLowerCase(),
        );
      }

      if (profileHasIban && !iban) {
        /**
         * The profile's IBAN pays another address. Say which, so the user can
         * decide whether to move it here, and store nothing but the reason:
         * that IBAN is not this account's until Monerium attributes it to
         * this Safe. With the app's credentials the list is every customer's
         * IBANs, so nothing from it is shown.
         */
        const say = (status: number, body: Record<string, unknown>, detail: string) => {
          store.updateUser(user.id, {
            funding: { ...(user.funding ?? { mode: "sandbox" as const, status: "provisioning" as const }), detail },
          });
          return res.status(status).json(body);
        };
        if (viaApp) {
          return say(409, {
            error: "Monerium says this profile already has an IBAN. Connect your own Monerium account to see it and move it here.",
          }, "Monerium profile already has an IBAN; connect your own Monerium account to move it");
        }
        const candidates = linkedUnder
          ? snapshot.ibans.filter((i: any) => i?.profile === linkedUnder && ibanKey(i.iban))
          : [];
        if (!candidates.length) {
          // Fail closed: no profile to read, or no IBAN on it to offer.
          const why = !linkedUnder
            ? "Monerium does not say which profile this Safe is linked under"
            : `Monerium lists no IBAN on profile ${linkedUnder}`;
          return say(409, {
            error: `Monerium says this profile already has an IBAN, but ${why}, so Zold cannot tell which one to offer. Nothing was changed.`,
            code: "IBAN_EXISTS_UNRESOLVED",
          }, `Monerium profile already has an IBAN; ${why}`);
        }
        // Every IBAN on the profile, each with where it pays now. With more
        // than one, the user picks; nothing is chosen for them. `existing` is
        // set only when there is exactly one.
        const choices = candidates.map((i: any) => ({
          iban: ibanKey(i.iban),
          address: i.address ?? null,
          chain: i.chain ?? null,
          profileId: linkedUnder,
        }));
        const one = choices.length === 1 ? choices[0] : undefined;
        const where = one
          ? `(${maskIban(one.iban)}), currently paying into ${one.address ?? "another address"} on ${one.chain ?? "another chain"}`
          : `on this profile: Monerium lists ${choices.length}, none paying into this account`;
        return say(409, {
          error: `You already have an IBAN at Monerium ${where}. Zold uses that same IBAN: move ${one ? "it" : "one of them"} to this account to finish. Nothing has changed yet.`,
          code: "IBAN_EXISTS_ELSEWHERE",
          ...(one ? { existing: one } : {}),
          choices,
        }, `Your Monerium profile already has an IBAN ${where} — move ${one ? "it" : "one"} to this account, or keep ${one ? "it" : "them"} where ${one ? "it is" : "they are"}`);
      }

      const updated = store.updateUser(user.id, {
        // What Monerium attributes to THIS address, or nothing. Falling back to
        // a previously stored value would preserve a mis-attribution.
        iban,
        // Approval is the address-matched IBAN, not the POSTs succeeding: a
        // "duplicate" answer on both proves nothing about THIS address, and an
        // IBAN not yet issued is iban_pending, which refreshPendingIban resolves
        // and approves when it lands.
        ...(viaApp || !iban || !mayApproveOnIban(user)
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
          detail: iban ? undefined : "Monerium IBAN requested; waiting for activation",
        },
        monerium: { ...user.monerium!, profileId, ...snapshot },
      });
      const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
      res.json({ ...publicUser(updated), ...balances });
    }),
  );

  /**
   * Move the user's EXISTING Monerium IBAN to this Safe.
   *
   * A Monerium profile has one IBAN, so a user who already has one gets 304
   * from POST /ibans (activate answers IBAN_EXISTS_ELSEWHERE). PATCH
   * /ibans/{iban} {address, chain} points that IBAN at another address: bank
   * payments to it mint there from then on, and the old wallet stops
   * receiving them. Because that changes where someone's money lands, the
   * route wants a typed "MOVE", a fresh passkey ceremony started for this
   * IBAN, and the user's OWN connection (never the app's credentials).
   *
   * The IBAN in the body only chooses what to move. What is stored is what
   * Monerium's re-read attributes to this Safe's address, and only that
   * approves the account. A PATCH that is accepted but not yet visible leaves
   * the account iban_pending; refreshPendingIban finishes it.
   */
  router.post(
    "/users/:id/monerium/move-iban",
    wrap(async (req, res) => {
      let user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "monerium", res)) return;
      const custodyBlocked = custodyBlockerBeforeFunding(user);
      if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
      if (!hasActiveSafe(user)) {
        return res.status(409).json({ error: "active passkey Safe required before moving an IBAN to it" });
      }
      const safeUser = user;

      // Checked before the ceremony is consumed, so a typo costs no approval.
      if (req.body?.confirm !== "MOVE") {
        return res.status(400).json({
          error: 'type MOVE to confirm — this changes where bank payments to the IBAN land',
          code: "CONFIRMATION_REQUIRED",
        });
      }
      const requested = ibanKey(req.body?.iban);
      if (!IBAN_SHAPE.test(requested)) {
        return res.status(400).json({ error: "the IBAN to move is required" });
      }
      if (!hasOwnMoneriumCredentials(user)) {
        return res.status(409).json({
          error: "moving an IBAN needs your own Monerium connection — sign in with Monerium or add your Monerium API keys",
          code: "MONERIUM_NOT_CONNECTED",
        });
      }
      const { accessToken, viaApp } = await moneriumLinkAccessToken(user);
      if (viaApp) {
        return res.status(409).json({
          error: "moving an IBAN needs your own Monerium connection, not the app's",
          code: "MONERIUM_NOT_CONNECTED",
        });
      }
      if (!(await isDeployed(user.address))) {
        return res.status(409).json({ error: "passkey Safe must be deployed before an IBAN can be moved to it" });
      }

      prunePendingMoneriumLinkSignatures();
      const requestId =
        typeof req.body?.requestId === "string"
          ? req.body.requestId
          : typeof req.body?.linkSignatureRequestId === "string"
            ? req.body.linkSignatureRequestId
            : "";
      const pending = requestId ? pendingMoneriumLinkSignatures.get(requestId) : undefined;
      if (pending?.userId === user.id) pendingMoneriumLinkSignatures.delete(requestId);
      if (!pending || pending.userId !== user.id || pending.purpose !== "move-iban" || pending.iban !== requested) {
        return res.status(409).json({
          error: "fresh passkey approval for moving this IBAN required",
          start: `/api/users/${user.id}/monerium/link-signature/start`,
        });
      }
      let signature: Hex;
      try {
        ({ user, signature } = await passkeySafeLinkSignature(safeUser, pending.challenge, req.body));
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }

      // Where the IBAN is and which profile holds it, read on the user's own
      // connection. Exactly one match, on one of the user's own profiles, on
      // the profile this account is connected under — or refuse.
      const before = await readMoneriumAccountSnapshot(user, accessToken);
      const matches = before.ibans.filter((i: any) => ibanKey(i?.iban) === requested);
      const notOnProfile = (error: string) =>
        res.status(409).json({ error, code: "IBAN_NOT_ON_PROFILE" });
      if (matches.length !== 1) {
        return notOnProfile(
          matches.length
            ? `Monerium lists ${maskIban(requested)} ${matches.length} times on your account; refusing to guess`
            : `${maskIban(requested)} is not on your connected Monerium account`,
        );
      }
      const current = matches[0];
      const ibanProfile = typeof current.profile === "string" ? current.profile : "";
      const ownProfiles = before.profiles.map((p: any) => p?.id);
      if (!ibanProfile || !ownProfiles.includes(ibanProfile)) {
        return notOnProfile(`Monerium does not show ${maskIban(requested)} on a profile of your connected account`);
      }
      // The profile the server recorded for this connection wins over the one
      // the browser named when it started the ceremony.
      // No recorded profile is a refusal, not a pass: any profile of the login
      // would do, and a company account could take its owner's personal IBAN.
      const accountProfile = user.monerium?.profileId ?? user.funding?.moneriumProfileId ?? pending.profileId;
      if (!accountProfile) {
        return notOnProfile("this account has no Monerium profile recorded; connect your Monerium account again first");
      }
      if (accountProfile !== ibanProfile) {
        return notOnProfile(
          `${maskIban(requested)} belongs to Monerium profile ${ibanProfile}, but this account is connected under profile ${accountProfile}`,
        );
      }

      // The Safe must be linked under the IBAN's profile before Monerium will
      // point the IBAN at it: link it exactly as activate does, then check.
      const linkRefused = await linkSafeAddress(user, accessToken, signature, ibanProfile);
      if (linkRefused) return res.status(400).json({ error: linkRefused });
      const linkedUnder = await linkedProfileOf(accessToken, user.address);
      if (linkedUnder !== ibanProfile) {
        return res.status(409).json({
          error: linkedUnder
            ? `this Safe is linked under Monerium profile ${linkedUnder}, not ${ibanProfile} — Monerium support has to move it; do NOT unlink`
            : `Monerium does not show this Safe linked under profile ${ibanProfile}; nothing was moved`,
          code: "ADDRESS_NOT_ON_PROFILE",
        });
      }

      const requestedAt = new Date().toISOString();
      const move = {
        iban: requested,
        profileId: ibanProfile,
        fromAddress: String(current.address ?? ""),
        fromChain: String(current.chain ?? ""),
        toAddress: user.address,
        toChain: MONERIUM.chain,
        requestedAt,
      };
      if (!sameAddress(current.address, user.address)) {
        try {
          await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "PATCH", `/ibans/${encodeURIComponent(requested)}`, {
            address: user.address,
            chain: MONERIUM.chain,
          });
        } catch (err: any) {
          console.error(`monerium move-iban: PATCH refused for ${user.id}: ${err?.message ?? err}`);
          return res.status(400).json({ error: `Monerium refused to move the IBAN: ${err?.message ?? err}` });
        }
      }

      // Only Monerium's own list decides. A failed re-read is "not confirmed".
      const after = await readMoneriumAccountSnapshot(user, accessToken).catch(() => undefined);
      const landed = after?.ibans.filter((i: any) => ibanKey(i?.iban) === requested) ?? [];
      const confirmed = landed.length === 1 && sameAddress(landed[0].address, user.address);
      const moves = [...(user.moneriumIbanMoves ?? []), move];
      let updated: User;
      if (confirmed) {
        const iban = ibanKey(landed[0].iban);
        releaseIbanFromOtherUsers(iban, user.id);
        updated = store.updateUser(user.id, {
          iban,
          moneriumIbanMoves: moves,
          ...(!mayApproveOnIban(user)
            ? {}
            : {
                kycStatus: "approved" as const,
                kyc: {
                  provider: "monerium" as const,
                  onboardingPath: "existing_monerium" as const,
                  checkedAt: new Date().toISOString(),
                  applicantId: ibanProfile,
                  reason: `approved when Monerium moved IBAN ${maskIban(iban)} to ${user.address} (profile ${ibanProfile})`,
                },
              }),
          funding: {
            ...(user.funding ?? {}),
            mode: "sandbox",
            status: "active",
            moneriumProfileId: ibanProfile,
            detail: undefined,
          },
          monerium: { ...user.monerium!, profileId: ibanProfile, ...after },
        });
        updated = store.updateUser(user.id, { moneriumIbanMoves: confirmedMoves(updated, iban) });
      } else {
        updated = store.updateUser(user.id, {
          iban: "",
          moneriumIbanMoves: moves,
          funding: {
            ...(user.funding ?? {}),
            mode: "sandbox",
            status: "iban_pending",
            moneriumProfileId: ibanProfile,
            detail: `Monerium accepted moving ${maskIban(requested)} to this account but does not show it here yet — checked again on every visit`,
          },
          ...(after ? { monerium: { ...user.monerium!, profileId: ibanProfile, ...after } } : {}),
        });
      }
      store.audit(auditEntry(
        "partner.iban_moved",
        { partner: "monerium", profileId: ibanProfile, ibanLast4: requested.slice(-4), fromChain: move.fromChain, confirmed },
        user.id,
      ));
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

      // The same rule as the OAuth callback: the profile of this login's
      // signup kind, or a refusal that stores nothing.
      const pick = pickProfileForSignup(user.accountType, verified.profiles);
      if (!pick.ok) {
        store.audit(auditEntry(
          "partner.connect_refused",
          { partner: "monerium", method: "api_keys", code: pick.code, accountType: user.accountType ?? "individual" },
          user.id,
        ));
        return res.status(pick.status).json({ error: pick.error, code: pick.code });
      }
      const profileId = pick.profile.id;
      // ADDRESS-MATCHED ONLY, for the reason activate gives: any other IBAN in
      // the snapshot is somebody's money routing, not this account's.
      const ownIban = ownIbanOf(verified.ibans, user.address, profileId);
      // A stored IBAN stays only if this login lists it on the picked profile.
      const keepsIban = !ownIban && user.funding?.status === "active" && storedIbanOnProfile(user, verified.ibans, profileId);
      const dropIban = Boolean(user.iban) && !ownIban && !keepsIban;
      const now = new Date().toISOString();
      const wasApproved = user.kycStatus === "approved";

      const updated = store.updateUser(user.id, {
        moneriumConnect: undefined,
        moneriumRefusal: undefined,
        ...(wasApproved || !mayApproveOnIban(user)
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
        ...(ownIban ? { iban: ownIban } : dropIban ? { iban: undefined } : {}),
        funding: {
          ...(user.funding ?? {}),
          mode: "sandbox" as const,
          status: ownIban || keepsIban ? ("active" as const) : ("provisioning" as const),
          moneriumProfileId: profileId,
          detail: ownIban
            ? `IBAN attributed to this account by your Monerium (${moneriumEnvironment()}) account`
            : keepsIban
                ? "own Monerium keys connected; the existing IBAN is kept and Monerium calls for this account now use your keys"
                : dropIban
                  ? "the IBAN this account had is not on the Monerium profile now connected; approve IBAN issuance with your passkey"
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
