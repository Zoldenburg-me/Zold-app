/**
 * /api/gnosis-pay: the user's own connected Gnosis Pay card account.
 *
 * A router factory taking requireSession, so server.ts stays the only owner of
 * authentication (same shape as the orgs/business routers).
 *
 * This is a proxy. Gnosis Pay's JWT belongs to the user's account with them;
 * the browser holds it for the session and sends it on each call, and this
 * process never persists it. The routes exist because their API is not
 * CORS-open to our origin.
 *
 * Not built yet (docs/gnosis-pay-permissionless-integration.md, PR sequence):
 * signup, terms, KYC, phone OTP, Safe deploy, card creation and funding. This
 * is the auth and read-only layer. Keep the write paths out until reads are
 * stable, or a half-onboarded user gets stuck between two systems.
 */
import express from "express";
import { GNOSIS_PAY, SECURITY } from "../config.js";
import { store } from "../store.js";
import {
  GnosisPayError,
  buildSiweMessage,
  getAccountBalances,
  getNonce,
  getUser,
  listCards,
  listTransactions,
  safeAddressOf,
  verifySiwe,
} from "../adapters/gnosis-pay.js";
import type { SessionResolver } from "./org-context.js";
import { can } from "../domain/segments.js";
import { recordServerError } from "../http/error-log.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Sign-ins started and not yet finished, by nonce: the account that started
 * one, the exact message it was given and the cookie its nonce is bound to.
 * Verify spends the entry before anything is awaited, so a start finishes
 * once, on the account that made it, within SIWE_TTL_MS. Gnosis Pay's own
 * nonce check is theirs; this one is what stops a Zold session finishing a
 * sign-in another session started.
 *
 * Per process, like the WebAuthn challenges: a sign-in started on one
 * instance cannot be finished on another, nor after a restart.
 */
const pendingSignIns = new Map<string, { userId: string; message: string; cookie: string; exp: number }>();
const SIWE_TTL_MS = 5 * 60_000;
/** Starts need a session, but one account can still ask for many. Past the
 *  cap the oldest is dropped (a Map iterates in insertion order). */
const MAX_PENDING_SIGN_INS = 10_000;

function prunePendingSignIns(now = Date.now()) {
  for (const [k, v] of pendingSignIns) {
    if (v.exp >= now) break;
    pendingSignIns.delete(k);
  }
}

const NOT_THIS_SIGN_IN = {
  error: "This wallet sign-in is no longer valid for this account. Start it again.",
  code: "SIWE_NOT_PENDING",
};

const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The profile lists the wallet that signed as one of its sign-in wallets. */
function signedInWith(profile: Awaited<ReturnType<typeof getUser>>, signer: string): boolean {
  return Array.isArray(profile.signInWallets) &&
    profile.signInWallets.some((w) => sameAddress(typeof w === "string" ? w : w?.address, signer));
}

/**
 * Permissionless mode has no webhooks and no partner attribution. Every
 * response says so, so a card balance is not read as Zold's figure for a
 * Zold card.
 */
const PROVENANCE = {
  source: "gnosis-pay" as const,
  mode: "permissionless" as const,
  note:
    "Gnosis Pay issues and operates this card and holds its KYC. Zold shows your connected " +
    "account and cannot see card activity except when you open this view — there are no webhooks " +
    "in permissionless mode, so every figure is a snapshot, not a live balance.",
};

/** A Gnosis Pay refusal is passed on in their words. Anything else is ours:
 *  logged with its detail under a reference, and answered without it. */
function fail(req: express.Request, res: express.Response, err: unknown) {
  if (err instanceof GnosisPayError) {
    // Pass their status through EXCEPT for auth: a 401 from Gnosis Pay means
    // the user's session with THEM expired, not that our session is invalid,
    // and returning 401 here would make the browser log the user out of Zold.
    const status = err.status === 401 || err.status === 403 ? 409 : err.status;
    // Their text is passed on, but never the token: an error that quotes the
    // request would hand the bearer back in an error body.
    const jwt = req.header("x-gnosis-pay-token")?.trim();
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: jwt ? err.message.split(jwt).join("[token]") : err.message,
      ...(err.status === 401 || err.status === 403 ? { reauth: true } : {}),
    });
  }
  const { ref } = recordServerError(err, req);
  return res.status(500).json({
    error: `Something went wrong on our side reading your Gnosis Pay account; if it happens again, quote ${ref}.`,
    code: "INTERNAL",
    ref,
  });
}

/** The JWT rides in a dedicated header, never a cookie and never the body:
 *  a cookie would be sent automatically on requests that have no business
 *  carrying somebody's card credential. */
function tokenOf(req: express.Request, res: express.Response): string | undefined {
  const raw = req.header("x-gnosis-pay-token") ?? "";
  const jwt = raw.trim();
  if (!jwt) {
    res.status(401).json({
      error: "no Gnosis Pay session — sign in with your wallet first",
      reauth: true,
    });
    return undefined;
  }
  return jwt;
}

export function createGnosisPayRouter(requireSession: SessionResolver): express.Router {
  const r = express.Router();

  /**
   * Segment gate for the whole router: Gnosis Pay is EU_FULL only. It sits on
   * the router so a new endpoint cannot miss it. A pre-segmentation account
   * defaults to EU_FULL, as in the server-side guard.
   */
  r.use((req, res, next) => {
    const session = requireSession(req, res);
    if (!session) return;
    // Resolved once here; every handler below reads it from res.locals.
    res.locals.session = session;
    const user = store.findUser(session.userId);
    const segment = user?.segment?.value ?? "EU_FULL";
    if (!can(segment, "gnosis_pay")) {
      return res.status(403).json({
        error: "This is not part of your account.",
        code: "CAPABILITY_UNAVAILABLE",
        capability: "gnosis_pay",
      });
    }
    next();
  });

  /** What this deployment can do, so the client renders a real state. */
  r.get("/config", (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    const user = store.findUser(session.userId);
    res.json({
      chainId: GNOSIS_PAY.siweChainId,
      partnerMode: Boolean(GNOSIS_PAY.partnerId),
      ...PROVENANCE,
      connected: user?.gnosisPay ?? null,
    });
  });

  /**
   * Start SIWE. Returns the message to sign AND the cookie the challenge is
   * bound to — the caller must hand both back, because Gnosis Pay verifies the
   * signature against the session that issued the nonce.
   */
  r.post("/siwe/start", async (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    const address = String(req.body?.address ?? "").trim();
    if (!ADDRESS.test(address)) {
      return res.status(400).json({ error: "address must be an EVM address" });
    }
    try {
      const { nonce, cookie } = await getNonce();
      // The SIWE domain/uri must match where the user is actually signing, or
      // a wallet that checks them (most do) refuses before we ever ask.
      const origin = SECURITY.origins[0] ?? `http://localhost:${process.env.TRANSF_API_PORT ?? 3000}`;
      const message = buildSiweMessage({
        address,
        nonce,
        domain: new URL(origin).host,
        uri: origin,
      });
      prunePendingSignIns();
      while (pendingSignIns.size >= MAX_PENDING_SIGN_INS) pendingSignIns.delete(pendingSignIns.keys().next().value!);
      pendingSignIns.set(nonce, { userId: session.userId, message, cookie, exp: Date.now() + SIWE_TTL_MS });
      res.json({ message, cookie, chainId: GNOSIS_PAY.siweChainId });
    } catch (err) {
      return fail(req, res, err);
    }
  });

  /** Finish SIWE. The token is RETURNED to the browser, never stored here. */
  r.post("/siwe/verify", async (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    const user = store.findUser(session.userId);
    if (!user) return res.status(404).json({ error: "no such account" });

    const message = String(req.body?.message ?? "");
    const signature = String(req.body?.signature ?? "");
    const cookie = String(req.body?.cookie ?? "");
    if (!message || !signature || !cookie) {
      return res.status(400).json({ error: "message, signature and cookie are all required" });
    }
    // Spent here, before any await: the start this session made, its exact
    // message and cookie, once, in time. Anything else never reaches Gnosis Pay.
    const nonce = /^Nonce: (\S+)$/m.exec(message)?.[1] ?? "";
    const pending = pendingSignIns.get(nonce);
    pendingSignIns.delete(nonce);
    if (!pending || pending.exp < Date.now() || pending.userId !== user.id ||
        pending.message !== message || pending.cookie !== cookie) {
      return res.status(409).json(NOT_THIS_SIGN_IN);
    }
    try {
      // Take the address from the message we built rather than trusting the
      // profile to echo it back — line 2 of a SIWE message IS the address,
      // and it is the one thing here we know for certain.
      const signedBy = message.split("\n")[1]?.trim() ?? "";
      const { token } = await verifyAndProfile(message, signature, cookie, user.id, signedBy);
      res.json({ token, ...PROVENANCE, connected: store.findUser(user.id)?.gnosisPay ?? null });
    } catch (err) {
      return fail(req, res, err);
    }
  });

  /** Profile + cards + balances in one call: the Card view needs all three to
   *  render anything at all, and three round trips to show one screen is three
   *  chances to render half of it. */
  r.get("/account", async (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    const jwt = tokenOf(req, res);
    if (!jwt) return;
    try {
      const profile = await getUser(jwt);
      // The token is the browser's, so it may be any Gnosis Pay account's. Only
      // the profile this account signed in to refreshes the stored status; any
      // other is refused, never shown or recorded as this account's.
      const connected = store.findUser(session.userId)?.gnosisPay;
      if (connected && (!profile?.id || profile.id !== connected.userId)) {
        throw new GnosisPayError("This Gnosis Pay session is for a different account than the one connected. Sign in again with your wallet.", 401);
      }
      // Cards and balances are fetched together but must fail independently:
      // a user with no Safe yet has no balance, and that is a state to render,
      // not an error that hides their profile.
      const [cards, balances] = await Promise.all([
        listCards(jwt).catch(() => null),
        getAccountBalances(jwt).catch(() => null),
      ]);
      const asOf = new Date().toISOString();
      if (connected) recordStatus(session.userId, profile, cards?.length, asOf, connected.connectedAddress);
      res.json({
        ...PROVENANCE,
        asOf,
        user: {
          id: profile.id,
          email: profile.email,
          kycStatus: profile.kycStatus,
          status: profile.status,
          isPhoneValidated: profile.isPhoneValidated,
          isSourceOfFundsAnswered: profile.isSourceOfFundsAnswered,
          safeAddress: safeAddressOf(profile),
        },
        cards,
        balances,
      });
    } catch (err) {
      return fail(req, res, err);
    }
  });

  r.get("/transactions", async (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    const jwt = tokenOf(req, res);
    if (!jwt) return;
    try {
      const transactions = await listTransactions(jwt);
      res.json({ ...PROVENANCE, asOf: new Date().toISOString(), transactions });
    } catch (err) {
      return fail(req, res, err);
    }
  });

  /** Forget the connection. Only status is held, so this is a status delete —
   *  it does NOT close the user's Gnosis Pay account, and says so. */
  r.delete("/connection", (req, res) => {
    const session = res.locals.session as NonNullable<ReturnType<typeof requireSession>>;
    store.updateUser(session.userId, { gnosisPay: undefined });
    res.json({
      disconnected: true,
      note:
        "Zold has forgotten this connection. Your Gnosis Pay account and card are unaffected — " +
        "close those with Gnosis Pay directly.",
    });
  });

  return r;
}

/** Verify the signature, then read the profile once so the stored status is
 *  never ahead of what Gnosis Pay actually says. A profile that has no id or
 *  does not list the wallet that signed is refused, and nothing connected. */
async function verifyAndProfile(
  message: string,
  signature: string,
  cookie: string,
  userId: string,
  signedBy: string,
): Promise<{ token: string }> {
  const { token } = await verifySiwe(message, signature, cookie);
  let profile: Awaited<ReturnType<typeof getUser>>;
  try {
    profile = await getUser(token);
  } catch {
    // A profile read that fails right after a successful sign-in is worth not
    // failing the sign-in over: the token is valid, nothing is connected, and
    // /account will report the real reason on the next call.
    return { token };
  }
  if (!profile || typeof profile !== "object") return { token };
  if (!profile.id || !ADDRESS.test(signedBy) || !signedInWith(profile, signedBy)) {
    throw new GnosisPayError("This Gnosis Pay account does not list the wallet that signed in, so it was not connected.", 409);
  }
  const cards = await listCards(token).catch(() => undefined);
  recordStatus(userId, profile, cards?.length, new Date().toISOString(), signedBy as `0x${string}`);
  return { token };
}

/** The connected address is the verified signer at sign-in, and the stored
 *  one on a refresh: never read from the profile. */
function recordStatus(
  userId: string,
  profile: Awaited<ReturnType<typeof getUser>>,
  cardCount: number | undefined,
  asOf: string,
  connectedAddress: `0x${string}`,
): void {
  store.updateUser(userId, {
    gnosisPay: {
      connectedAddress,
      userId: profile.id,
      safeAddress: safeAddressOf(profile) as `0x${string}` | undefined,
      kycStatus: profile.kycStatus,
      accountStatus: profile.status,
      cardCount,
      asOf,
    },
  });
}
