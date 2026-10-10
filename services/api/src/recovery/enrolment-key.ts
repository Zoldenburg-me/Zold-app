/**
 * The key half of the 1 € enrolment (zoldenburg-enrolment.ts): whether it is
 * available, the HMAC that stands for an enrolled bank account, and whether
 * an account is armed. Config and hashing only, so the public user projection
 * and the capabilities can import it without the Monerium adapters.
 */
import { createHash, createHmac } from "node:crypto";
import { RECOVERY } from "../config.js";
import { normalizeIban } from "../sepa.js";
import type { User } from "../store/types.js";

export const enrolmentAvailable = () => Boolean(RECOVERY.ibanHmacKey);

/** Names the HMAC key without revealing it, so a rotated key shows as such. */
export const ibanKeyId = () =>
  createHash("sha256").update(`zold/recovery-iban-key-id:${RECOVERY.ibanHmacKey}`).digest("hex").slice(0, 12);

/** The stored form of a payer's bank account. */
export function bankAccountHmac(iban: string): string {
  if (!RECOVERY.ibanHmacKey) throw new Error("RECOVERY_IBAN_HMAC_KEY is not set");
  return createHmac("sha256", RECOVERY.ibanHmacKey).update(`zold/recovery-iban/v1:${normalizeIban(iban)}`).digest("hex");
}

/** Armed: the guardian is active on this Safe, and enrolled under the key in
 *  use now. */
export function zoldenburgArmed(user: User): boolean {
  const e = user.zoldenburgEnrolment;
  return Boolean(
    enrolmentAvailable() && user.passkeySafe?.recovery?.status === "active" &&
    e?.enrolledAt && e.bankAccountHmac && e.keyId === ibanKeyId(),
  );
}
