/**
 * What the pay-with-zold checkout service may see, and how it proves it is
 * the checkout service.
 *
 * Scope: a SEPA transfer whose reference carries a checkout reference, `ZP`
 * and 12 hex digits standing alone. Any other transfer is as invisible to the
 * service as one that does not exist.
 *
 * Credential: a bearer token we issue (`zsc_` + 256 random bits, base64url),
 * stored as its SHA-256 only. Rotation keeps the previous one valid for
 * CHECKOUT_SERVICE.rotationOverlapMs so the service can switch without a gap.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CHECKOUT_SERVICE } from "./config.js";
import { store, type ServiceCredential, type Transfer } from "./store.js";

/** `ZP` + 12 hex, not glued to a letter or digit on either side. */
const CHECKOUT_REFERENCE = /(?<![A-Za-z0-9])ZP[0-9A-Fa-f]{12}(?![A-Za-z0-9])/;

export function isCheckoutTransfer(t: Transfer): boolean {
  return t.rail === "sepa" && typeof t.reference === "string" && CHECKOUT_REFERENCE.test(t.reference);
}

/** The IBAN's last four characters: enough for the service to match a
 *  transfer it started, without handing it the payee's full account. */
function lastFour(iban?: string): string | undefined {
  if (!iban) return undefined;
  return `…${iban.replace(/\s+/g, "").slice(-4)}`;
}

/** The allowlist the service receives. Built field by field, so a field added
 *  to Transfer never reaches it by accident. */
export function checkoutTransferView(t: Transfer) {
  return {
    id: t.id,
    state: t.state,
    rail: t.rail,
    receiveEur: t.receiveEur,
    recipientIban: lastFour(t.recipientIban),
    reference: t.reference,
    updatedAt: t.updatedAt,
  };
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Whether any checkout credential was ever issued: none means the route is
 *  not set up (503), not that the caller is wrong (401). */
export function checkoutCredentialIssued(): boolean {
  return store.serviceCredentials("checkout").length > 0;
}

/** The credential this bearer token is, if it is current at `now`. Compares
 *  hashes in constant time against every row, matched or not. */
export function checkoutCredentialFor(token: string | undefined, now = Date.now()): ServiceCredential | undefined {
  if (!token) return undefined;
  const presented = hashToken(token);
  let found: ServiceCredential | undefined;
  for (const c of store.serviceCredentials("checkout")) {
    const stored = Buffer.from(c.tokenHash, "hex");
    const same = stored.length === presented.length && timingSafeEqual(stored, presented);
    const live = !c.expiresAt || Date.parse(c.expiresAt) > now;
    if (same && live) found = c;
  }
  return found;
}

/** Issue a new checkout credential. The token is returned once and never
 *  stored; losing it means rotating again. `revokePrevious` ends every
 *  earlier credential now instead of after the overlap: for a leaked one. */
export function rotateCheckoutCredential(
  by: string,
  revokePrevious = false,
): { id: string; token: string; previousValidUntil: string } {
  const token = `zsc_${randomBytes(32).toString("base64url")}`;
  const row: ServiceCredential = {
    id: randomUUID(),
    service: "checkout",
    tokenHash: hashToken(token).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const previousValidUntil = store.rotateServiceCredential(row, revokePrevious ? 0 : CHECKOUT_SERVICE.rotationOverlapMs, by, revokePrevious);
  return { id: row.id, token, previousValidUntil };
}
