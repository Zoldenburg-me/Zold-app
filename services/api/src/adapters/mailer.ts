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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The HTML part of the code email, in the app's colours (tokens.css). Inline
 * styles and tables only, because mail clients drop <style> and flexbox. No
 * remote image and no link: an image is a read receipt, and a link in a code
 * email is something to imitate. The logo is a table cell and a text
 * triangle, so it shows with images blocked.
 */
export function verificationCodeHtml(code: string, minutes: number): string {
  const digits = escapeHtml(code);
  const font = "Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>Your Zold code</title></head>
<body style="margin:0;padding:0;background:#f4f3f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f6;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:${font};">
<tr><td style="background:#08080b;padding:20px 28px;border-bottom:3px solid #ed188d;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;background:#ed188d;border-radius:8px;color:#ffffff;font-size:15px;line-height:32px;">&#9660;</td>
    <td style="padding-left:12px;color:#fbf9fc;font-size:20px;font-weight:700;letter-spacing:-0.3px;">Zold</td>
  </tr></table>
</td></tr>
<tr><td style="padding:32px 28px 8px;">
  <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#08080b;">Confirm your email</p>
  <p style="margin:0;font-size:15px;line-height:1.5;color:#4a4a55;">Type this code into the Zold app.</p>
</td></tr>
<tr><td align="center" style="padding:20px 28px;">
  <div style="display:inline-block;padding:16px 28px;background:#fdf0f7;border:1px solid #f4b3d6;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#c4106f;">${digits}</div>
  <p style="margin:12px 0 0;font-size:13px;color:#6b6b76;">It works for ${minutes} minutes.</p>
</td></tr>
<tr><td style="padding:8px 28px 28px;">
  <p style="margin:0;padding-top:20px;border-top:1px solid #ececf0;font-size:13px;line-height:1.5;color:#6b6b76;">If you did not sign up for Zold, ignore this email. Nobody can use the code without the app it was asked from.</p>
</td></tr>
<tr><td style="background:#08080b;padding:14px 28px;color:#9a9aa5;font-size:12px;">Zoldenburg</td></tr>
</table>
</td></tr></table>
</body></html>`;
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
    html: verificationCodeHtml(code, minutes),
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
