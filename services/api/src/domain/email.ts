/**
 * The one email shape check. The length cap runs first, and the pattern
 * cannot backtrack: the old `[^@\s]+@[^@\s]+\.[^@\s]+` let the domain part
 * and the dot overlap, so a 60,000-character "a@...@" held the event loop
 * for about two seconds per request.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

export function emailLooksValid(email: string): boolean {
  return email.length <= 254 && EMAIL_SHAPE.test(email);
}
