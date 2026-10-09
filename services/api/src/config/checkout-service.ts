import { envNumber, IS_PRODUCTION } from "./env.js";

/**
 * The pay-with-zold checkout service: a separate service that reads the SEPA
 * transfers it started (GET /api/service/checkout/transfers/:id) and may be
 * told when one changes state.
 *
 * Its bearer credential is not configured here: an operator issues and rotates
 * it (POST /api/admin/service-credentials/checkout/rotate), and the store
 * keeps only its hash.
 */
export const CHECKOUT_SERVICE = (() => {
  const webhookUrl = process.env.CHECKOUT_WEBHOOK_URL?.trim() ?? "";
  const webhookSecret = process.env.CHECKOUT_WEBHOOK_SECRET?.trim() ?? "";
  if (webhookUrl) {
    let u: URL;
    try {
      u = new URL(webhookUrl);
    } catch {
      throw new Error("CHECKOUT_WEBHOOK_URL is not a URL");
    }
    if (u.username || u.password) throw new Error("CHECKOUT_WEBHOOK_URL must not carry credentials; the signature authenticates us");
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(local && !IS_PRODUCTION)) {
      throw new Error("CHECKOUT_WEBHOOK_URL must be https (plain http only to localhost outside production)");
    }
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(webhookSecret) || Buffer.from(webhookSecret.slice(6), "base64").length < 24) {
      throw new Error("CHECKOUT_WEBHOOK_URL needs CHECKOUT_WEBHOOK_SECRET, a whsec_<base64> secret of at least 24 bytes");
    }
  }
  return {
    /** Requests per minute per IP with a valid credential. A wrong one counts
     *  on the auth bucket, like a wrong operator token. */
    rateLimitPerMin: envNumber("SERVICE_RATE_LIMIT_PER_MIN", 120, { min: 1, integer: true }),
    /** How long the previous credential keeps working after a rotation, so the
     *  service can be redeployed with the new one without a gap. */
    rotationOverlapMs: envNumber("CHECKOUT_SERVICE_ROTATION_OVERLAP_SEC", 24 * 3600, { min: 0 }) * 1000,
    /** Where a state change is announced. Unset = no webhook; the service polls. */
    webhookUrl,
    webhookSecret,
    /** First retry delay; each later one is four times the last. */
    webhookRetryBaseMs: envNumber("CHECKOUT_WEBHOOK_RETRY_BASE_MS", 5_000, { min: 1 }),
    webhookMaxAttempts: envNumber("CHECKOUT_WEBHOOK_MAX_ATTEMPTS", 6, { min: 1, integer: true }),
  };
})();
