/**
 * The one way Zold sends mail: SMTP, configured by EMAIL_VERIFICATION in
 * config.ts. Used only for email verification codes. No other route sends
 * mail, and none may say "we emailed you" without going through here.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { EMAIL_VERIFICATION, IS_PRODUCTION } from "../config.js";

let transport: Transporter | undefined;

function smtp(): Transporter {
  const c = EMAIL_VERIFICATION.smtp;
  transport ??= nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    // In production a server that cannot upgrade to TLS is refused rather
    // than sent the code in the clear.
    requireTLS: IS_PRODUCTION && !c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transport;
}

/** Send one verification code. Throws when the SMTP server does not accept
 *  the message; the caller then says nothing was sent. */
export async function sendVerificationCode(to: string, code: string): Promise<void> {
  const minutes = Math.round(EMAIL_VERIFICATION.codeTtlMs / 60_000);
  await smtp().sendMail({
    from: EMAIL_VERIFICATION.smtp.from,
    to,
    // The code stays in the body: a subject shows on lock screens and is
    // kept in the mail provider's logs.
    subject: "Your Zold code",
    text:
      `Your code to confirm this email for Zold is ${code}.\n\n` +
      `It works for ${minutes} minutes. Type it into the Zold app.\n\n` +
      `If you did not sign up for Zold, ignore this email. Nobody can use the code without the app it was asked from.\n\n` +
      `Zoldenburg`,
  });
}
