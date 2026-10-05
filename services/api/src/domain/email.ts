/**
 * The one email shape check. The length cap runs first, and the pattern
 * cannot backtrack: domain labels exclude the dot, so no two parts can match
 * the same characters. A pattern where they overlap (`[^@\s]+\.[^@\s]+`)
 * takes seconds of event loop on a 60,000-character "a@...@".
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

export function emailLooksValid(email: string): boolean {
  return email.length <= 254 && EMAIL_SHAPE.test(email);
}

/**
 * Does an account already hold this email, so a new signup must be refused?
 * Without email verification, any account with a passkey holds it (one
 * claimable account per email). With it, only an account that confirmed the
 * address does: an unconfirmed one may have typed someone else's email, and
 * must not lock the owner out. `others` are the accounts on this email,
 * excluding the one asking.
 */
export function emailHeldBy(
  others: { passkey?: unknown; emailVerifiedAt?: string }[],
  verificationOn: boolean,
): boolean {
  return verificationOn ? others.some((u) => !!u.emailVerifiedAt) : others.some((u) => !!u.passkey);
}
