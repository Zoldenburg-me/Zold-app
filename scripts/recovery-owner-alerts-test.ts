/**
 * Phase 0 recovery alert email (services/api/src/recovery/owner-alerts.ts):
 * the account's owner is emailed when someone asks to recover the account,
 * and again when a recovery enters its grace period, over real SMTP to a
 * fake server in this process.
 *
 * Checks: one mail per event per request, an open request only, a request
 * already in its grace period gets the grace mail alone, a stranger who
 * restarts a recovery over and over gets one "asked" mail per account per
 * window, a failed send is retried and then given up, no address or code in
 * any log line, no link and no account details in the mail, the record of
 * sent alerts is in no public projection, and nothing is sent with mail off.
 *
 * No chain. Run: npm run recovery-alerts:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

// ---- a fake SMTP server: keeps each message ------------------------------
const inbox: string[] = [];
let smtpDown = false;
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
        inbox.push(buf.slice(0, end).replace(/=\r\n/g, ""));
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
      else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.end("221 bye\r\n"); return; }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-alerts-")), "db.json");
process.env.EMAIL_VERIFICATION = "1";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.SMTP_USER = "u";
process.env.SMTP_PASS = "p";
process.env.MAIL_FROM = "Zold <no-reply@zoldhq.com>";

const { store } = await import("../services/api/src/store.js");
const { sweepOwnerAlerts, OWNER_ALERTS } = await import("../services/api/src/recovery/owner-alerts.js");
const { publicRecoveryRequest } = await import("../services/api/src/recovery.js");

// Every console line, to prove no address leaks into the log.
const logged: string[] = [];
for (const k of ["log", "error", "warn"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); orig(...a); };
}

const T0 = new Date("2026-10-10T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const mkUser = (id: string, email: string) =>
  store.addUser({ id, name: `Name ${id}`, email, country: "DE", kycStatus: "approved", iban: "DE89370400440532013000", address: `0x${"1".repeat(38)}${String(id.length).padStart(2, "0")}`, createdAt: T0.toISOString(), passkey: { credentialId: id } as any } as any);
let seq = 0;
const mkReq = (userId: string, status: string, extra: object = {}) => {
  const id = `rq${++seq}`;
  store.addRecoveryRequest({
    id, userId, safeAddress: `0x${"2".repeat(40)}`, mode: "zoldenburg", status, requestedAt: T0.toISOString(),
    expiresAt: at(14 * 24 * 60).toISOString(), recoveryDelayHours: 72, guardianAddress: `0x${"3".repeat(40)}`,
    recoveryModuleAddress: `0x${"4".repeat(40)}`, factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
    zoldenburg: { reference: "ZR-SECRET-REF" }, ...extra,
  } as any);
  return id;
};
const alerts = (id: string) => store.findRecoveryRequest(id)!.ownerAlerts ?? {};
const to = (m: string) => /^To: (.*)$/im.exec(m)?.[1] ?? "";
const subject = (m: string) => /^Subject: (.*)$/im.exec(m)?.[1] ?? "";
const body = (m: string) => m.split(/\r\n\r\n/).slice(1).join("\n");

let failed = 0;
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e: any) { failed++; console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
};
console.log("recovery owner alerts");

mkUser("anna", "anna@example.com");
mkUser("ben", "ben@example.com");
mkUser("cleo", "cleo@example.com");

let annaAsked = "";
await t("an open request: the owner gets one 'asked' mail, and a second sweep sends nothing", async () => {
  annaAsked = mkReq("anna", "PASSKEY_PENDING");
  await sweepOwnerAlerts(at(1));
  assert.equal(inbox.length, 1);
  assert.match(to(inbox[0]), /anna@example\.com/);
  assert.match(subject(inbox[0]), /recovery/i);
  assert.ok(alerts(annaAsked).requested, "recorded");
  await sweepOwnerAlerts(at(2));
  assert.equal(inbox.length, 1, "once per request");
});

await t("the mail says what happened and what to do, with no link and no account details", () => {
  const m = inbox[0];
  assert.match(body(m), /move your Zold account to a new device/i);
  assert.match(body(m), /open the Zold app/i);
  assert.ok(!/https?:\/\/|www\./i.test(body(m)), "no link in the body");
  for (const s of ["Name anna", "DE89", "ZR-SECRET-REF", "0x2222", "0x1111"]) assert.ok(!m.includes(s), `no ${s}`);
});

await t("entering the grace period: one more mail with the date it completes", async () => {
  store.updateRecoveryRequest(annaAsked, { status: "GRACE_PERIOD", zoldenburg: { reference: "ZR-SECRET-REF", finalizeAfter: "2026-10-13T09:00:00.000Z" } } as any);
  await sweepOwnerAlerts(at(3));
  assert.equal(inbox.length, 2);
  assert.match(body(inbox[1]), /13 October 2026/);
  assert.match(body(inbox[1]), /cancel/i);
  assert.ok(alerts(annaAsked).executed);
  await sweepOwnerAlerts(at(4));
  assert.equal(inbox.length, 2, "once");
});

await t("a request already in its grace period gets the grace mail alone", async () => {
  const id = mkReq("ben", "GRACE_PERIOD", { mode: "candide", candide: { finalizeAfter: "2026-10-12T10:00:00.000Z" }, zoldenburg: undefined });
  const before = inbox.length;
  await sweepOwnerAlerts(at(5));
  assert.equal(inbox.length, before + 1);
  assert.match(to(inbox.at(-1)!), /ben@example\.com/);
  assert.match(body(inbox.at(-1)!), /12 October 2026/);
  assert.ok(alerts(id).requested && alerts(id).executed, "both marked: the asked mail would only repeat it");
});

await t("finished, cancelled, expired or legacy requests get nothing", async () => {
  const before = inbox.length;
  for (const status of ["FINALIZED", "CANCELED", "EXPIRED"]) mkReq("cleo", status);
  mkReq("cleo", "PASSKEY_PENDING", { expiresAt: at(-1).toISOString() });
  mkReq("cleo", "REVIEW_PENDING", { mode: "managed" });
  await sweepOwnerAlerts(at(6));
  assert.equal(inbox.length, before);
});

await t("a stranger restarting a recovery again and again: one 'asked' mail per account per window", async () => {
  const before = inbox.length;
  const ids = [mkReq("cleo", "PASSKEY_PENDING"), mkReq("cleo", "PASSKEY_PENDING"), mkReq("cleo", "OTP_PENDING", { mode: "candide", zoldenburg: undefined })];
  await sweepOwnerAlerts(at(7));
  await sweepOwnerAlerts(at(8));
  assert.equal(inbox.length, before + 1);
  for (const id of ids) assert.ok(alerts(id).requested, "each marked, so none is sent later");
  // After the window, a new request is mailed again.
  const later = mkReq("cleo", "PASSKEY_PENDING");
  await sweepOwnerAlerts(at(8 + OWNER_ALERTS.askedWindowMs / 60_000 + 1));
  assert.equal(inbox.length, before + 2);
  assert.ok(alerts(later).requested);
});

await t("the grace mail is never held back by the window", async () => {
  const id = mkReq("cleo", "GRACE_PERIOD", { zoldenburg: { finalizeAfter: "2026-10-14T00:00:00.000Z" } });
  const before = inbox.length;
  await sweepOwnerAlerts(at(10 + OWNER_ALERTS.askedWindowMs / 60_000));
  assert.equal(inbox.length, before + 1);
  assert.ok(alerts(id).executed);
});

await t("a failed send is retried next sweep, then given up after the limit", async () => {
  mkUser("dan", "dan@example.com");
  const id = mkReq("dan", "REVIEW_PENDING");
  smtpDown = true;
  for (let i = 0; i < OWNER_ALERTS.maxAttempts; i++) await sweepOwnerAlerts(at(20 + i));
  smtpDown = false;
  assert.equal(alerts(id).requested, undefined, "nothing marked as sent");
  assert.equal(alerts(id).failures, OWNER_ALERTS.maxAttempts);
  const before = inbox.length;
  await sweepOwnerAlerts(at(40));
  assert.equal(inbox.length, before, "given up: no endless retries");
  // A retry that works marks it sent.
  mkUser("eve", "eve@example.com");
  const id2 = mkReq("eve", "REVIEW_PENDING");
  smtpDown = true;
  await sweepOwnerAlerts(at(41));
  smtpDown = false;
  await sweepOwnerAlerts(at(42));
  assert.ok(alerts(id2).requested);
  assert.match(to(inbox.at(-1)!), /eve@example\.com/);
});

await t("no log line carries an address or the reference", () => {
  const all = logged.join("\n");
  assert.ok(!/@example\.com/i.test(all), "no address");
  assert.ok(!all.includes("ZR-SECRET-REF"));
  assert.match(all, /recovery alert/i, "failures are logged");
});

await t("the record of sent alerts is in no public projection", () => {
  assert.ok(!("ownerAlerts" in publicRecoveryRequest(store.findRecoveryRequest(annaAsked)!)));
});

await t("mail off: the sweep sends nothing and marks nothing", async () => {
  mkUser("fay", "fay@example.com");
  const id = mkReq("fay", "PASSKEY_PENDING");
  const before = inbox.length;
  await sweepOwnerAlerts(at(50), { mailOn: false });
  assert.equal(inbox.length, before);
  assert.deepEqual(alerts(id), {});
});

smtp.close();
if (failed) { console.error(`RECOVERY OWNER ALERTS TEST FAILED — ${failed}`); process.exit(1); }
console.log("RECOVERY OWNER ALERTS TEST PASSED");
process.exit(0);
