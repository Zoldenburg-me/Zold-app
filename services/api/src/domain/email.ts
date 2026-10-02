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
