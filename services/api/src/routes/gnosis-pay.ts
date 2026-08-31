/**
 * /api/gnosis-pay — the user's own connected Gnosis Pay card account.
 *
 * A router factory taking requireSession, so server.ts stays the single owner
 * of authentication (same shape as the orgs/business routers).
 *
 * THE SHAPE, and why it is a proxy rather than a store: Gnosis Pay's JWT
 * belongs to the user's account with THEM. The browser holds it for the length
 * of a session and sends it on each call; this process never persists it. So
 * every read here takes the token from a header and forwards it. That is the
 * whole reason these routes exist rather than the browser calling Gnosis Pay
 * directly — their API is not CORS-open to our origin, and putting the token
 * through a server we control keeps it out of a cross-origin request.
 *
 * WHAT IS DELIBERATELY ABSENT in this first cut (docs/gnosis-pay-permissionless
 * -integration.md, PR sequence): signup, terms, KYC, phone OTP, Safe deploy,
 * card creation and funding. This is the auth + read-only foundation. Adding
 * the write paths before the read paths are stable is how a half-onboarded
 * user ends up stuck between two systems with no way back.
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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Permissionless mode has no webhooks and no partner attribution. Every
 * response says so, because a card balance rendered with no provenance reads
 * as Zold's number about Zold's card, and it is neither.
 */
const PROVENANCE = {
  source: "gnosis-pay" as const,
  mode: "permissionless" as const,
  note:
    "Gnosis Pay issues and operates this card and holds its KYC. Zold shows your connected " +
    "account and cannot see card activity except when you open this view — there are no webhooks " +
    "in permissionless mode, so every figure is a snapshot, not a live balance.",
};

function fail(res: express.Response, err: unknown) {
  if (err instanceof GnosisPayError) {
    // Pass their status through EXCEPT for auth: a 401 from Gnosis Pay means
    // the user's session with THEM expired, not that our session is invalid,
    // and returning 401 here would make the browser log the user out of Zold.
    const status = err.status === 401 || err.status === 403 ? 409 : err.status;
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: err.message,
      ...(err.status === 401 || err.status === 403 ? { reauth: true } : {}),
    });
  }
  return res.status(500).json({ error: String((err as any)?.message ?? err) });
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
   * Segment gate for the whole router.
   *
   * Gnosis Pay is EU_FULL only. Enforced here rather than per-route so a new
   * endpoint added later cannot forget it — the gate is the door, not a note
   * on each room. A pre-segmentation account defaults to EU_FULL for the same
   * migration reason as the server-side guard.
   */
  r.use((req, res, next) => {
    const session = requireSession(req, res);
    if (!session) return;
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
    const session = requireSession(req, res);
    if (!session) return;
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
    const session = requireSession(req, res);
    if (!session) return;
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
      res.json({ message, cookie, chainId: GNOSIS_PAY.siweChainId });
    } catch (err) {
      return fail(res, err);
    }
  });

  /** Finish SIWE. The token is RETURNED to the browser, never stored here. */
  r.post("/siwe/verify", async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const user = store.findUser(session.userId);
    if (!user) return res.status(404).json({ error: "no such account" });

    const message = String(req.body?.message ?? "");
    const signature = String(req.body?.signature ?? "");
    const cookie = String(req.body?.cookie ?? "");
    if (!message || !signature || !cookie) {
      return res.status(400).json({ error: "message, signature and cookie are all required" });
    }
    try {
      // Take the address from the message we built rather than trusting the
      // profile to echo it back — line 2 of a SIWE message IS the address,
      // and it is the one thing here we know for certain.
      const signedBy = message.split("\n")[1]?.trim() ?? "";
      const { token } = await verifyAndProfile(message, signature, cookie, user.id, signedBy);
      res.json({ token, ...PROVENANCE, connected: store.findUser(user.id)?.gnosisPay ?? null });
    } catch (err) {
      return fail(res, err);
    }
  });

  /** Profile + cards + balances in one call: the Card view needs all three to
   *  render anything at all, and three round trips to show one screen is three
   *  chances to render half of it. */
  r.get("/account", async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const jwt = tokenOf(req, res);
    if (!jwt) return;
    try {
      const profile = await getUser(jwt);
      // Cards and balances are fetched together but must fail independently:
      // a user with no Safe yet has no balance, and that is a state to render,
      // not an error that hides their profile.
      const [cards, balances] = await Promise.all([
        listCards(jwt).catch(() => null),
        getAccountBalances(jwt).catch(() => null),
      ]);
      const asOf = new Date().toISOString();
      recordStatus(session.userId, profile, cards?.length, asOf);
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
      return fail(res, err);
    }
  });

  r.get("/transactions", async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const jwt = tokenOf(req, res);
    if (!jwt) return;
    try {
      const transactions = await listTransactions(jwt);
      res.json({ ...PROVENANCE, asOf: new Date().toISOString(), transactions });
    } catch (err) {
      return fail(res, err);
    }
  });

  /** Forget the connection. Only status is held, so this is a status delete —
   *  it does NOT close the user's Gnosis Pay account, and says so. */
  r.delete("/connection", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
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
 *  never ahead of what Gnosis Pay actually says. */
async function verifyAndProfile(
  message: string,
  signature: string,
  cookie: string,
  userId: string,
  signedBy: string,
): Promise<{ token: string }> {
  const { token } = await verifySiwe(message, signature, cookie);
  try {
    const profile = await getUser(token);
    const cards = await listCards(token).catch(() => undefined);
    recordStatus(userId, profile, cards?.length, new Date().toISOString(), signedBy);
  } catch {
    // A profile read that fails right after a successful sign-in is worth not
    // failing the sign-in over: the token is valid, and /account will report
    // the real reason on the next call.
  }
  return { token };
}

function recordStatus(
  userId: string,
  profile: Awaited<ReturnType<typeof getUser>>,
  cardCount: number | undefined,
  asOf: string,
  signedBy?: string,
): void {
  const signer = Array.isArray(profile.signInWallets)
    ? profile.signInWallets
        .map((w) => (typeof w === "string" ? w : w?.address))
        .find((a) => typeof a === "string" && ADDRESS.test(a))
    : undefined;
  const existing = store.findUser(userId)?.gnosisPay;
  const fromMessage = signedBy && ADDRESS.test(signedBy) ? signedBy : undefined;
  const connectedAddress = (fromMessage ?? signer ?? existing?.connectedAddress) as
    | `0x${string}`
    | undefined;
  if (!connectedAddress) return;
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
