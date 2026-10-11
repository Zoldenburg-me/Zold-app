/**
 * Email verification: the code goes out over real SMTP (to a fake server in
 * this process), is stored only as a hash, works once, dies after five wrong
 * tries or its TTL, and only a confirmed email holds the address against
 * another signup or wins the recovery lookup. With the flag off, the routes
 * do not exist and the old rule (any account with a passkey holds the email)
 * stands.
 *
 * The code stays out of the subject (subjects show on lock screens and sit
 * in provider logs), and a failed send logs no email address.
 *
 * No chain. Run: npm run email:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import express from "express";

// ---- a fake SMTP server: accepts everything, keeps each message ----------
const inbox: string[] = [];
let smtpDown = false;
// Refuse the recipient the way real servers do, quoting the address back.
let smtpRejectRcpt = false;
const smtp = net.createServer((sock) => {
  if (smtpDown) return sock.end("421 down\r\n");
  let data = false;
  let buf = "";
  sock.write("220 fake ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i: number;
    while (true) {
      if (data) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        inbox.push(buf.slice(0, end));
        buf = buf.slice(end + 5);
        data = false;
        sock.write("250 queued\r\n");
        continue;
      }
      if ((i = buf.indexOf("\r\n")) < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "RCPT" && smtpRejectRcpt) sock.write(`550 5.1.1 ${line.slice(line.indexOf("<"))}: Recipient address rejected\r\n`);
      else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.end("221 bye\r\n"); return; }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-email-")), "db.json");
process.env.EMAIL_VERIFICATION = "1";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.SMTP_USER = "u";
process.env.SMTP_PASS = "p";
process.env.MAIL_FROM = "Zold <no-reply@zoldhq.com>";

const { store } = await import("../services/api/src/store.js");
const { createEmailVerificationRouter } = await import("../services/api/src/routes/email-verification.js");
const { emailHeldBy } = await import("../services/api/src/domain/email.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { capabilities } = await import("../services/api/src/capabilities.js");

const app = express().use(express.json()).use(
  "/api",
  createEmailVerificationRouter({
    // The session is the x-user header: who is calling is not under test here.
    requireUserSession: (req, res, id) => (req.header("x-user") === id ? true : (res.status(401).json({ error: "no" }), false)),
  }),
);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
const post = async (p: string, as: string, body: unknown = {}) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-user": as }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

const mk = (id: string, email: string, extra: object = {}) =>
  store.addUser({ id, name: id, email, country: "DE", kycStatus: "pending", iban: "", address: `0x${"0".repeat(39)}${id.length}`, createdAt: new Date().toISOString(), passkey: { credentialId: id } as any, ...extra } as any);
const codeIn = (msg: string) => /code to confirm this email for Zold is (\d{6})/.exec(msg.replace(/=\r\n/g, ""))?.[1];
const back = (id: string, ms: number) => {
  const c = store.findUser(id)!.emailCode!;
  store.updateUser(id, { emailCode: { ...c, sentAt: c.sentAt.map((t) => new Date(Date.parse(t) - ms).toISOString()) } });
};

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e: any) { failed++; console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
}

console.log("email verification");
mk("anna", "Anna@Example.com");
mk("squat", "anna@example.com");

await t("the app is told verification is on", () => assert.equal(capabilities().emailVerification, true));

await t("another person's session cannot ask for a code", async () => {
  assert.equal((await post("/users/anna/email/code", "squat")).status, 401);
});

let code = "";
await t("a code goes out by SMTP to the account's email, and only its hash is stored", async () => {
  const r = await post("/users/anna/email/code", "anna");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sentTo, "Anna@Example.com");
  assert.equal(inbox.length, 1);
  assert.match(inbox[0], /To: Anna@Example.com/i);
  code = codeIn(inbox[0])!;
  assert.match(code, /^\d{6}$/);
  const subject = /^Subject: (.*)$/im.exec(inbox[0])?.[1] ?? "";
  assert.ok(subject, "the message has a subject");
  assert.ok(!subject.includes(code), `the code is not in the subject: ${subject}`);
  const stored = JSON.stringify(store.findUser("anna"));
  assert.ok(!stored.includes(`"${code}"`), "the code itself is never stored");
  assert.ok(!JSON.stringify(publicUser(store.findUser("anna")!)).includes("emailCode"), "the hash is in no projection");
});

await t("a second code within a minute is refused with the wait", async () => {
  const r = await post("/users/anna/email/code", "anna");
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "EMAIL_CODE_WAIT");
  assert.equal(inbox.length, 1);
});

await t("a wrong code counts down, and a malformed one does not count", async () => {
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await post("/users/anna/email/verify", "anna", { code: "12ab" })).body.code, "EMAIL_CODE_FORMAT");
  const r = await post("/users/anna/email/verify", "anna", { code: wrong });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /4 tries left/);
});

await t("five wrong tries void the code, even the right one after", async () => {
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) await post("/users/anna/email/verify", "anna", { code: wrong });
  const r = await post("/users/anna/email/verify", "anna", { code });
  assert.equal(r.body.code, "EMAIL_CODE_EXPIRED");
  assert.equal(store.findUser("anna")!.emailVerifiedAt, undefined);
});

await t("an expired code does not work", async () => {
  back("anna", 61_000);
  assert.equal((await post("/users/anna/email/code", "anna")).status, 200);
  code = codeIn(inbox[inbox.length - 1])!;
  const c = store.findUser("anna")!.emailCode!;
  store.updateUser("anna", { emailCode: { ...c, expiresAt: new Date(Date.now() - 1).toISOString() } });
  assert.equal((await post("/users/anna/email/verify", "anna", { code })).body.code, "EMAIL_CODE_EXPIRED");
});

await t("a failed send stores nothing and says so", async () => {
  back("anna", 61_000);
  const before = store.findUser("anna")!.emailCode!.hash;
  smtpDown = true;
  const r = await post("/users/anna/email/code", "anna");
  smtpDown = false;
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "MAIL_UNAVAILABLE");
  assert.equal(store.findUser("anna")!.emailCode!.hash, before);
});

await t("a refused recipient is logged by error code, never by address", async () => {
  back("anna", 61_000);
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  smtpRejectRcpt = true;
  let r;
  try { r = await post("/users/anna/email/code", "anna"); }
  finally { smtpRejectRcpt = false; console.error = err; }
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "MAIL_UNAVAILABLE");
  const line = logged.join("\n");
  assert.match(line, /email verification/, "the failure is logged");
  assert.match(line, /550/, "with the server's code");
  assert.ok(!/example\.com/i.test(line), `no address in the log: ${line}`);
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes("example.com"), "nor in the answer");
});

await t("the right code confirms the email, once", async () => {
  back("anna", 61_000);
  assert.equal((await post("/users/anna/email/code", "anna")).status, 200);
  code = codeIn(inbox[inbox.length - 1])!;
  const r = await post("/users/anna/email/verify", "anna", { code });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.emailVerifiedAt);
  assert.equal(store.findUser("anna")!.emailCode, undefined);
});

await t("a confirmed email wins the recovery lookup over another account on it", () => {
  assert.equal(store.findUserByEmail("ANNA@example.com")!.id, "anna");
});

await t("once confirmed, nobody else can confirm the same address", async () => {
  const r = await post("/users/squat/email/code", "squat");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "EMAIL_IN_USE");
});

await t("five sends an hour at most", async () => {
  mk("bo", "bo@example.com");
  for (let i = 0; i < 5; i++) {
    assert.equal((await post("/users/bo/email/code", "bo")).status, 200);
    back("bo", 61_000);
  }
  const r = await post("/users/bo/email/code", "bo");
  assert.equal(r.body.code, "EMAIL_CODE_LIMIT");
});

await t("signup: with verification on, only a confirmed email holds the address", () => {
  assert.equal(emailHeldBy([{ passkey: {} }], true), false, "an unconfirmed account cannot lock the owner out");
  assert.equal(emailHeldBy([{ passkey: {}, emailVerifiedAt: "x" }], true), true);
  assert.equal(emailHeldBy([{ passkey: {} }], false), true, "off: any account with a passkey holds it, as before");
  assert.equal(emailHeldBy([{}], false), false);
});

// Config is read once per process, so the off and half-configured cases each
// get a fresh one.
const { spawnSync } = await import("node:child_process");
const probe = (env: Record<string, string>, code: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "-e", code], {
    env: { ...process.env, TRANSF_DB_PATH: process.env.TRANSF_DB_PATH!, SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", MAIL_FROM: "", ...env },
    encoding: "utf8",
  });

await t("EMAIL_VERIFICATION=1 without SMTP refuses to start, naming what is missing", () => {
  const r = probe({ EMAIL_VERIFICATION: "1", SMTP_HOST: "smtp.example.com" }, `await import("./services/api/src/config.ts")`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EMAIL_VERIFICATION=1 needs SMTP_USER, SMTP_PASS, MAIL_FROM/);
});

await t("off: the app is told so and both routes answer 404", () => {
  const r = probe({ EMAIL_VERIFICATION: "" }, `
    const { capabilities } = await import("./services/api/src/capabilities.ts");
    const { createEmailVerificationRouter } = await import("./services/api/src/routes/email-verification.ts");
    const express = (await import("express")).default;
    const s = express().use(express.json()).use("/api", createEmailVerificationRouter({ requireUserSession: () => true })).listen(0);
    const u = "http://127.0.0.1:" + s.address().port + "/api/users/anna/email/";
    const a = await fetch(u + "code", { method: "POST" }), b = await fetch(u + "verify", { method: "POST" });
    console.log(JSON.stringify([capabilities().emailVerification, a.status, b.status])); s.close();`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").pop(), JSON.stringify([false, 404, 404]));
});

server.close();
smtp.close();
if (failed) { console.error(`EMAIL VERIFICATION TEST FAILED — ${failed}`); process.exit(1); }
console.log("EMAIL VERIFICATION TEST PASSED");
