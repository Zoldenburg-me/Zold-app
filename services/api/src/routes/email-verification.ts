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
import { emailLockKey } from "../domain/email.js";

export interface EmailVerificationDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;
}

const codeHash = (userId: string, code: string) => createHash("sha256").update(`zold/email-code/v1:${userId}:${code}`).digest("hex");

/** Another account already confirmed this address. */
async function confirmedElsewhere(user: User): Promise<boolean> {
  return !!user.email && (await store.usersByEmail(user.email)).some((u) => u.id !== user.id && !!u.emailVerifiedAt);
}

/** Addresses a code mail is going to right now. A send is recorded only once
 *  the mail is out, so a request in that window would pass the wait. */
const sending = new Set<string>();

const IN_USE = {
  error: "Another account already confirmed this email. Sign in to that account, or recover it if you lost the device.",
  code: "EMAIL_IN_USE",
};

export function createEmailVerificationRouter(deps: EmailVerificationDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  const owner = async (req: express.Request, res: express.Response): Promise<User | undefined> => {
    if (!EMAIL_VERIFICATION.enabled) {
      res.status(404).json({ error: "not found" });
      return undefined;
    }
    const user = await store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!(await requireUserSession(req, res, user.id))) return undefined;
    return user;
  };

  router.post(
    "/users/:id/email/code",
    wrap(async (req, res) => {
      const user = await owner(req, res);
      if (!user) return;
      if (!user.email) return res.status(409).json({ error: "this account has no email to confirm" });
      if (user.emailVerifiedAt) return res.status(409).json({ error: "this email is already confirmed", code: "EMAIL_VERIFIED" });
      if ((await confirmedElsewhere(user))) return res.status(409).json(IN_USE);

      const to = user.email.trim().toLowerCase();
      if (sending.has(to)) {
        const wait = Math.ceil(EMAIL_VERIFICATION.resendAfterMs / 1000);
        return res.status(429).json({ error: `Wait ${wait} seconds before asking for another code.`, code: "EMAIL_CODE_WAIT", retryAfterSeconds: wait });
      }
      // Held from the check to the write of the new code: the reads below and
      // the write await, and a second request must not send a second code.
      sending.add(to);
      try {
        const now = Date.now();
        const sentLastHour = (u: User) => (u.emailCode?.sentAt ?? []).filter((t) => now - Date.parse(t) < 3600_000);
        const recent = sentLastHour(user);
        // The wait and the hourly cap are per address: every account that signed
        // up with it counts, so more accounts mean neither more mail nor more guesses.
        const toAddress = (await store.usersByEmail(user.email)).flatMap(sentLastHour);
        const last = toAddress.length ? Math.max(...toAddress.map((t) => Date.parse(t))) : 0;
        if (now - last < EMAIL_VERIFICATION.resendAfterMs) {
          const wait = Math.ceil((EMAIL_VERIFICATION.resendAfterMs - (now - last)) / 1000);
          return res.status(429).json({ error: `Wait ${wait} seconds before asking for another code.`, code: "EMAIL_CODE_WAIT", retryAfterSeconds: wait });
        }
        if (toAddress.length >= EMAIL_VERIFICATION.maxSendsPerHour) {
          return res.status(429).json({ error: "Too many codes in the last hour. Try again later.", code: "EMAIL_CODE_LIMIT" });
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        try {
          await sendVerificationCode(user.email, code);
        } catch (err: any) {
          // The server's reply, which nodemailer appends to err.message, often
          // quotes the address: log only the error and SMTP codes.
          console.error(`email verification: sending to ${user.id} failed: ${err?.code ?? "error"}${err?.responseCode ? ` (SMTP ${err.responseCode})` : ""}`);
          // Nothing is stored: the previous code, if any, still stands.
          return res.status(502).json({ error: "The email could not be sent just now. Try again in a minute.", code: "MAIL_UNAVAILABLE" });
        }
        const sentAt = new Date(now).toISOString();
        await store.updateUser(user.id, {
          emailCode: {
            hash: codeHash(user.id, code),
            email: user.email,
            expiresAt: new Date(now + EMAIL_VERIFICATION.codeTtlMs).toISOString(),
            attempts: 0,
            sentAt: [...recent, sentAt],
          },
        });
        res.json({ sentTo: user.email, expiresAt: new Date(now + EMAIL_VERIFICATION.codeTtlMs).toISOString() });
      } finally {
        sending.delete(to);
      }
    }),
  );

  router.post(
    "/users/:id/email/verify",
    wrap(async (req, res) => {
      const user = await owner(req, res);
      if (!user) return;
      if (user.emailVerifiedAt) return res.json(await publicUser(user));
      const typed = String(req.body?.code ?? "").replace(/\s/g, "");
      const refuse = (error: string, code: string) => res.status(400).json({ error, code });
      if (!/^\d{6}$/.test(typed)) return refuse("Enter the 6-digit code from the email.", "EMAIL_CODE_FORMAT");
      // Counted on the stored row before it is compared: parallel guesses
      // each see the ones before, so the limit bounds guesses, not rounds.
      const c = (await store.countEmailCodeAttempt(user.id, EMAIL_VERIFICATION.maxAttempts))?.emailCode;
      if (!c) return refuse("This code is no longer valid. Ask for a new one.", "EMAIL_CODE_EXPIRED");
      const ok = timingSafeEqual(Buffer.from(codeHash(user.id, typed), "hex"), Buffer.from(c.hash, "hex"));
      if (!ok) {
        const left = EMAIL_VERIFICATION.maxAttempts - c.attempts;
        return left > 0
          ? refuse(`That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`, "EMAIL_CODE_WRONG")
          : refuse("That code is not right, and it no longer works. Ask for a new one.", "EMAIL_CODE_EXPIRED");
      }
      // Checked again at the moment of the write: two accounts may have had
      // codes out for one address, and the first to confirm keeps it. One
      // transaction, on the code that was compared: a new code sent since
      // voids this one.
      const updated = await store.tx(async () => {
        // The address is held, not only the row: two accounts confirming one
        // address at once each lock only their own row.
        if (user.email) await store.lockKey(emailLockKey(user.email));
        const now = await store.lockUser(user.id);
        if (now?.emailCode?.hash !== c.hash) return "expired" as const;
        if ((await confirmedElsewhere(now))) return "in_use" as const;
        return await store.updateUser(user.id, { emailVerifiedAt: new Date().toISOString(), emailCode: undefined });
      });
      if (updated === "expired") return refuse("This code is no longer valid. Ask for a new one.", "EMAIL_CODE_EXPIRED");
      if (updated === "in_use") return res.status(409).json(IN_USE);
      res.json(await publicUser(updated));
    }),
  );

  return router;
}
