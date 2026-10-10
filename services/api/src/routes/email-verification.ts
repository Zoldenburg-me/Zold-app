/**
 * Confirming the account's email with a 6-digit code (docs/email-verification.md).
 *
 * Off unless EMAIL_VERIFICATION is enabled; both routes then answer 404, as
 * if they did not exist, and capabilities() tells the app not to ask. When
 * on, a confirmed email is the one that blocks another signup on the same
 * address and the one recovery finds first (store.findUserByEmail).
 *
 * The code is a credential: stored only as a hash, bound to the address it
 * was sent to, void after EMAIL_VERIFICATION.maxAttempts wrong tries or its
 * TTL, and on the auth rate bucket (http/policy.ts).
 */
import express from "express";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { wrap } from "./util.js";
import { EMAIL_VERIFICATION } from "../config.js";
import { store, type User } from "../store.js";
import { sendVerificationCode } from "../adapters/mailer.js";
import { publicUser } from "../users/public-user.js";
import { describeCause } from "../http/log-cause.js";

export interface EmailVerificationDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const codeHash = (userId: string, code: string) => createHash("sha256").update(`zold/email-code/v1:${userId}:${code}`).digest("hex");

/** Another account already confirmed this address. */
function confirmedElsewhere(user: User): boolean {
  return !!user.email && store.usersByEmail(user.email).some((u) => u.id !== user.id && !!u.emailVerifiedAt);
}

const IN_USE = {
  error: "Another account already confirmed this email. Sign in to that account, or recover it if you lost the device.",
  code: "EMAIL_IN_USE",
};

export function createEmailVerificationRouter(deps: EmailVerificationDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  const owner = (req: express.Request, res: express.Response): User | undefined => {
    if (!EMAIL_VERIFICATION.enabled) {
      res.status(404).json({ error: "not found" });
      return undefined;
    }
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!requireUserSession(req, res, user.id)) return undefined;
    return user;
  };

  router.post(
    "/users/:id/email/code",
    wrap(async (req, res) => {
      const user = owner(req, res);
      if (!user) return;
      if (!user.email) return res.status(409).json({ error: "this account has no email to confirm" });
      if (user.emailVerifiedAt) return res.status(409).json({ error: "this email is already confirmed", code: "EMAIL_VERIFIED" });
      if (confirmedElsewhere(user)) return res.status(409).json(IN_USE);

      const now = Date.now();
      const recent = (user.emailCode?.sentAt ?? []).filter((t) => now - Date.parse(t) < 3600_000);
      const last = recent.length ? Math.max(...recent.map((t) => Date.parse(t))) : 0;
      if (now - last < EMAIL_VERIFICATION.resendAfterMs) {
        const wait = Math.ceil((EMAIL_VERIFICATION.resendAfterMs - (now - last)) / 1000);
        return res.status(429).json({ error: `Wait ${wait} seconds before asking for another code.`, code: "EMAIL_CODE_WAIT", retryAfterSeconds: wait });
      }
      if (recent.length >= EMAIL_VERIFICATION.maxSendsPerHour) {
        return res.status(429).json({ error: "Too many codes in the last hour. Try again later.", code: "EMAIL_CODE_LIMIT" });
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        await sendVerificationCode(user.email, code);
      } catch (err: any) {
        console.error(`email verification: sending to ${user.id} failed: ${describeCause(err)}`);
        // Nothing is stored: the previous code, if any, still stands.
        return res.status(502).json({ error: "The email could not be sent just now. Try again in a minute.", code: "MAIL_UNAVAILABLE" });
      }
      const sentAt = new Date(now).toISOString();
      store.updateUser(user.id, {
        emailCode: {
          hash: codeHash(user.id, code),
          email: user.email,
          expiresAt: new Date(now + EMAIL_VERIFICATION.codeTtlMs).toISOString(),
          attempts: 0,
          sentAt: [...recent, sentAt],
        },
      });
      res.json({ sentTo: user.email, expiresAt: new Date(now + EMAIL_VERIFICATION.codeTtlMs).toISOString() });
    }),
  );

  router.post(
    "/users/:id/email/verify",
    wrap(async (req, res) => {
      const user = owner(req, res);
      if (!user) return;
      if (user.emailVerifiedAt) return res.json(publicUser(user));
      const typed = String(req.body?.code ?? "").replace(/\s/g, "");
      const c = user.emailCode;
      const refuse = (error: string, code: string) => res.status(400).json({ error, code });
      if (!/^\d{6}$/.test(typed)) return refuse("Enter the 6-digit code from the email.", "EMAIL_CODE_FORMAT");
      if (!c || !user.email || !sameEmail(c.email, user.email) || Date.now() > Date.parse(c.expiresAt) || c.attempts >= EMAIL_VERIFICATION.maxAttempts) {
        return refuse("This code is no longer valid. Ask for a new one.", "EMAIL_CODE_EXPIRED");
      }
      const ok = timingSafeEqual(Buffer.from(codeHash(user.id, typed), "hex"), Buffer.from(c.hash, "hex"));
      if (!ok) {
        const attempts = c.attempts + 1;
        store.updateUser(user.id, { emailCode: { ...c, attempts } });
        const left = EMAIL_VERIFICATION.maxAttempts - attempts;
        return left > 0
          ? refuse(`That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`, "EMAIL_CODE_WRONG")
          : refuse("That code is not right, and it no longer works. Ask for a new one.", "EMAIL_CODE_EXPIRED");
      }
      // Checked again at the moment of the write: two accounts may have had
      // codes out for one address, and the first to confirm keeps it.
      if (confirmedElsewhere(user)) return res.status(409).json(IN_USE);
      const updated = store.updateUser(user.id, {
        emailVerifiedAt: new Date().toISOString(),
        emailCode: undefined,
      });
      res.json(publicUser(updated));
    }),
  );

  return router;
}
