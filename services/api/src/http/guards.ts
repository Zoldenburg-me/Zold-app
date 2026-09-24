/**
 * The checks a route runs before it does anything: KYC state, segment
 * capability, custody readiness, the daily cap, and the operator token.
 *
 * These are the enforcing checks; the UI hiding a button does not stop a
 * crafted request. They sit beside the session module so every route shares
 * them.
 */
import type express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { HARNESS, KYC } from "../config.js";
import { auditEntry } from "../audit.js";
import { can, type Segment } from "../domain/segments.js";
import { dailyCapUsage } from "../orchestrator.js";
import { store, type User } from "../store.js";
import { bearerToken } from "./sessions.js";

export function requireKycApproved(user: User, res: express.Response) {
  if (user.kycStatus === "approved") return true;
  res.status(409).json({
    error: `KYC ${user.kycStatus}; account funding and transfers are disabled until KYC is approved`,
    kycStatus: user.kycStatus,
  });
  return false;
}

/**
 * Refuse to issue an IBAN to an account nobody can get back into.
 *
 * An IBAN is the point of no return: once it exists, money can arrive, and an
 * account whose only credential is a session token becomes unreachable the
 * moment that token is gone. Signup requires a passkey, but an account whose
 * Safe never activated is the same hole reached later, so this is checked
 * again where money starts.
 *
 * HARNESS.enabled (hardhat only) waives it so the suites can fund an account
 * without a real authenticator.
 */
export function custodyBlockerBeforeFunding(user: User): string | null {
  if (HARNESS.enabled) return null;
  if (!user.passkey?.publicKey) {
    return (
      "a verified passkey is required before an account can be funded — without one there is " +
      "no way to sign back in, and a lost device key cannot be replaced"
    );
  }
  if (!user.passkeySafe) {
    return "a passkey Safe plan is required before an account can be funded";
  }
  if (
    user.passkeySafe.status !== "active" ||
    user.address.toLowerCase() !== user.passkeySafe.address.toLowerCase()
  ) {
    return "activate the passkey Safe before funding this account";
  }
  return null;
}

/**
 * The gate in front of every partner call.
 *
 * Enforced here, not in the UI. An IN_COLLECTIONS account cannot reach
 * Monerium, a Safe, a card or an on-chain balance whatever it POSTs, because
 * each of those routes checks here first.
 *
 * A user with no segment predates segmentation and is treated as EU_FULL: the
 * old country gate already required a Monerium-servable residence, and
 * refusing would lock them out of a funded account. `npm run segments:test`
 * covers the resolver; this fallback is the migration seam and stays narrow.
 */
export function requireCapability(
  user: User,
  capability: Parameters<typeof can>[1],
  res: express.Response,
): boolean {
  const segment: Segment = user.segment?.value ?? "EU_FULL";
  if (can(segment, capability)) return true;
  store.audit(auditEntry("partner.call_refused", { segment, capability }, user.id));
  res.status(403).json({
    error: "This is not part of your account.",
    code: "CAPABILITY_UNAVAILABLE",
    capability,
    ...(user.segment?.gate ? { gate: user.segment.gate } : {}),
  });
  return false;
}

/** Refuse a send that would take the account past its daily cap, counting both
 *  funding sources. The arithmetic lives in dailyCapUsage so it can be tested
 *  without standing up the HTTP layer. */
export async function assertDailyCap(
  user: User,
  sendEur: number,
  res: express.Response,
): Promise<boolean> {
  const { capEur, usedEur, fromSafeEur } = await dailyCapUsage(user);
  if (usedEur + sendEur > capEur) {
    res.status(400).json({
      error:
        `amount exceeds the daily cap of €${capEur.toFixed(2)} ` +
        `(already used €${usedEur.toFixed(2)} today from the Safe: €${fromSafeEur.toFixed(2)})`,
    });
    return false;
  }
  return true;
}

/** Constant-time operator-token check; false when no token is configured. */
export function isOperator(req: express.Request): boolean {
  const expected = KYC.operatorToken;
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(bearerToken(req) ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Operator authentication, separate from user sessions so a user cannot act
 * as the operator on their own account. With no token configured there is no
 * operator path.
 */
export function requireOperator(req: express.Request, res: express.Response): boolean {
  if (!KYC.operatorToken) {
    res.status(503).json({
      error: "no KYC operator token configured — set KYC_OPERATOR_TOKEN to enable operator review",
    });
    return false;
  }
  if (!isOperator(req)) {
    res.status(401).json({ error: "operator authorization required" });
    return false;
  }
  return true;
}

export function operatorLabel(req: express.Request): string {
  const token = bearerToken(req) ?? "";
  return `operator:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}
