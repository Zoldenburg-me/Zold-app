/**
 * The one way Zold sends mail: SMTP, configured by EMAIL_VERIFICATION in
 * config.ts. It sends email verification codes and the owner's recovery
 * alerts (recovery/owner-alerts.ts). No other code sends mail, and nothing
 * may say "we emailed you" without going through here.
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

/** Mail goes out only where the SMTP transport is configured, which config
 *  checks when EMAIL_VERIFICATION=1. */
export const mailAvailable = () => EMAIL_VERIFICATION.enabled;

/** "13 October 2026, 09:00 UTC": the same for every reader, whatever their zone. */
const utcText = (d: Date) =>
  `${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}, ` +
  `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

/**
 * Tell the account's owner that someone asked to recover the account, or
 * that a recovery is approved and completes at `completesAt` unless they
 * cancel. It says no more than that: no name, amount, address, reference or
 * link, because the email may be unconfirmed and reach a stranger, and a
 * link in an alert is something to imitate. The owner acts in the app.
 */
export async function sendRecoveryAlert(to: string, kind: "requested" | "executed", at: Date, completesAt?: Date): Promise<void> {
  const how = "open the Zold app on the device you use now. A warning at the top of the screen lets you cancel it with your passkey.";
  const text = kind === "requested"
    ? `Someone asked to move your Zold account to a new device on ${utcText(at)}.\n\n` +
      `If this was you, there is nothing to do.\n\n` +
      `If it was not you, ${how} Nothing has been signed yet, and your account and money stay with your current passkey.\n\n`
    : `A recovery of your Zold account was approved. It moves the account to a new device` +
      `${completesAt ? ` on ${utcText(completesAt)}` : " when the waiting period ends"} unless you cancel before then.\n\n` +
      `If this was you, there is nothing to do.\n\n` +
      `If it was not you, ${how} Once the waiting period ends it cannot be undone.\n\n`;
  await smtp().sendMail({
    from: EMAIL_VERIFICATION.smtp.from,
    to,
    subject: kind === "requested" ? "A recovery of your Zold account was requested" : "A recovery of your Zold account is under way",
    text: text +
      `Zold never asks for your passkey or a code by email, and this email has no link.\n\n` +
      `Zoldenburg`,
  });
}
