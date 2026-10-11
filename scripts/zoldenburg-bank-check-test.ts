/**
 * Phase 1 recovery (recovery/zoldenburg-bank-check.ts): the second 1 €, from
 * the bank account the owner enrolled, before the operator may sign.
 *
 * Checks: a recovery code is not an enrolment code and the other way round;
 * which orders count; every refusal (another bank account, another name, the
 * Zold IBAN, no enrolment, a rotated key); fail closed on an unreadable
 * Monerium; what is stored (no IBAN, no name, the code spent); a re-enrolment
 * voids a pass; only open REVIEW_PENDING requests are checked; the person's
 * routes (secret required, code once, IBANs as last 4 only, refusals); the
 * operator gate (BANK_CHECK_PENDING before the pass, through it after); and
 * nothing of it in the public projection.
 *
 * No chain, no Monerium. Run: npm run recovery-bank:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const OPERATOR = "op-token-for-the-bank-check-test";
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-rbank-")), "db.json");
process.env.RECOVERY_IBAN_HMAC_KEY = "k".repeat(40);
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = `0x${"9".repeat(40)}`;
process.env.KYC_OPERATOR_TOKEN = OPERATOR;

const express = (await import("express")).default;
const { store } = await import("../services/api/src/store.js");
const { RECOVERY } = await import("../services/api/src/config.js");
const E = await import("../services/api/src/recovery/zoldenburg-enrolment.js");
const B = await import("../services/api/src/recovery/zoldenburg-bank-check.js");
const { publicRecoveryRequest } = await import("../services/api/src/recovery.js");
const { createZoldenburgRecoveryRouter } = await import("../services/api/src/routes/recovery-zoldenburg.js");
type Reads = import("../services/api/src/recovery/zoldenburg-enrolment.js").EnrolmentReads;

let failed = 0;
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e: any) { failed++; console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
};
const withKey = async (key: string, fn: () => unknown) => {
  const before = RECOVERY.ibanHmacKey;
  (RECOVERY as any).ibanHmacKey = key;
  try { await fn(); } finally { (RECOVERY as any).ibanHmacKey = before; }
};
console.log("zoldenburg recovery 1 € check");

// ---- an armed account and a recovery waiting for review --------------------

const SAFE = `0x${"a".repeat(40)}` as const;
// Checksums deliberately wrong: no real-looking IBAN in the tree.
const ZOLD_IBAN = "IS00 0159 2600 7654 5510 7303 39";
const BANK = "DE00370400440532013000";
const OTHER_BANK = "FR0030006000011234567890189";
const T0 = new Date("2026-10-11T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
store.addUser({
  id: "u1", name: "Anna Müller", email: "anna@example.com", country: "DE", kycStatus: "approved", iban: ZOLD_IBAN,
  address: SAFE, createdAt: T0.toISOString(), monerium: { profileId: "p1" },
  passkeySafe: { address: SAFE, status: "active", threshold: 1, passkeyPublicKey: { x: "1", y: "2" }, createdAt: T0.toISOString(),
    recovery: { moduleAddress: `0x${"4".repeat(40)}`, guardianAddress: process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS as `0x${string}`, threshold: 1, status: "active" } },
  passkey: { credentialId: "cred-u1", publicKey: { kty: "EC" } },
  zoldenburgEnrolment: {
    bankAccountHmac: E.bankAccountHmac(BANK), keyId: E.ibanKeyId(), bankAccountLast4: "3000",
    orderId: "enrol-order", enrolledAt: T0.toISOString(),
  },
} as any);
const user = () => store.findUser("u1")!;

const SECRET = "the-recovering-browsers-secret";
const newRequest = (id: string, status = "REVIEW_PENDING") => store.addRecoveryRequest({
  id, userId: "u1", safeAddress: SAFE, mode: "zoldenburg", status: status as any,
  requestedAt: at(1).toISOString(), expiresAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
  recoveryDelayHours: 72, guardianAddress: process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS as `0x${string}`,
  recoveryModuleAddress: `0x${"4".repeat(40)}`,
  factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
  zoldenburg: { accessHash: createHash("sha256").update(SECRET, "utf8").digest("hex"), reference: "ABCDE-12345", newOwners: [`0x${"c".repeat(40)}`], newThreshold: 1 },
});
newRequest("r1");
const req = (id = "r1") => store.findRecoveryRequest(id)!;

let open = { code: "", memo: "" };
let n = 0;
const order = (over: Record<string, any> = {}) => ({
  id: `o${++n}`, kind: "issue", amount: "1", currency: "eur", address: SAFE, memo: open.memo,
  meta: { state: "processed", processedAt: at(10).toISOString() },
  counterpart: { details: { name: "ANNA MUELLER" }, identifier: { iban: BANK } },
  ...over,
});
const paidAt = (min: number) => ({ meta: { state: "processed", processedAt: at(min).toISOString() } });
const reads = (orders: any[] | Error, name: string | Error | null = "Anna Müller"): Reads => ({
  orders: async () => { if (orders instanceof Error) throw orders; return orders; },
  profileName: async () => { if (name instanceof Error) throw name; return name ?? undefined; },
});

open = B.issueRecoveryBankCode(req(), at(5));

// ---- the code --------------------------------------------------------------

await t("a recovery code is not an enrolment code, and the other way round", () => {
  const hash = req().zoldenburg!.bankCheck!.code!.hash;
  assert.ok(E.memoCarriesCode(open.memo, hash, "recovery"));
  assert.ok(!E.memoCarriesCode(open.memo, hash, "enrolment"));
  const enrol = E.newEnrolmentCode();
  assert.ok(!E.memoCarriesCode(E.memoFor(enrol.code), enrol.hash, "recovery"));
  assert.ok(!JSON.stringify(req()).includes(open.code.replace("-", "")), "only the hash is stored");
});

await t("only processed issues to this Safe, after the code, carrying the recovery code, are candidates", () => {
  const good = order();
  const enrolmentStyle = E.newEnrolmentCode();
  const cands = E.ordersCarrying([
    good,
    order({ kind: "redeem" }),
    order({ address: `0x${"b".repeat(40)}` }),
    order(paidAt(2)),
    order({ memo: E.memoFor(enrolmentStyle.code) }),
  ] as any, user(), req().zoldenburg!.bankCheck!.code, "recovery");
  assert.deepEqual(cands.map((o) => o.id), [good.id]);
});

// ---- judging an order ------------------------------------------------------

await t("refusals: another bank account, another name, the Zold IBAN, under 1 €", () => {
  const j = (o: any) => B.judgeRecoveryOrder(o, user(), "Anna Müller") as any;
  const other = j(order({ counterpart: { details: { name: "Anna Müller" }, identifier: { iban: OTHER_BANK } } }));
  assert.match(other.reason, /different bank account/);
  assert.match(other.reason, /ending 3000/);
  assert.match(j(order({ counterpart: { details: { name: "Peter Schmidt" }, identifier: { iban: BANK } } })).reason, /does not match/);
  assert.match(j(order({ counterpart: { details: { name: "Anna Müller" }, identifier: { iban: ZOLD_IBAN.replace(/ /g, "") } } })).reason, /Zold IBAN/);
  assert.match(j(order({ amount: "0.50" })).reason, /under 1 €/);
  assert.deepEqual(j(order({ counterpart: { details: { firstName: "Anna", lastName: "Mueller" }, identifier: { iban: BANK.toLowerCase() } } })), { ok: true, iban: BANK });
});

await t("refusals: no enrolment on the account, or one made under another key", async () => {
  const e = structuredClone(user().zoldenburgEnrolment!);
  store.updateUser("u1", { zoldenburgEnrolment: undefined });
  assert.match((B.judgeRecoveryOrder(order() as any, user(), "Anna Müller") as any).reason, /never confirmed/);
  store.updateUser("u1", { zoldenburgEnrolment: e });
  await withKey("n".repeat(40), () => assert.match((B.judgeRecoveryOrder(order() as any, user(), "Anna Müller") as any).reason, /never confirmed/));
  assert.ok(B.judgeRecoveryOrder(order() as any, user(), "Anna Müller").ok);
});

// ---- the check -------------------------------------------------------------

await t("fail closed: unreadable orders or profile name leave the check open", async () => {
  assert.equal(await B.checkRecoveryBankPayment("r1", reads(new Error("401")), at(20)), "unreadable");
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([order()], new Error("down")), at(20)), "unreadable");
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([order()], null), at(20)), "unreadable");
  assert.equal(req().zoldenburg!.bankCheck!.passedAt, undefined);
  assert.equal(req().zoldenburg!.bankCheck!.lastCheck!.outcome, "unreadable");
  assert.equal(B.bankCheckPassed(req(), user()), false);
});

await t("no payment yet: waiting; from another account: the reason, and not passed", async () => {
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([]), at(21)), "waiting");
  const wrong = order({ counterpart: { details: { name: "Anna Müller" }, identifier: { iban: OTHER_BANK } } });
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([wrong]), at(22)), "mismatch");
  assert.match(req().zoldenburg!.bankCheck!.lastCheck!.reason, /different bank account/);
  assert.ok(!JSON.stringify(req()).includes(OTHER_BANK), "no payer IBAN stored");
  assert.equal(B.bankCheckPassed(req(), user()), false);
});

await t("an account that is not armed fails the check whatever was paid", async () => {
  const safe = structuredClone(user().passkeySafe!);
  store.updateUser("u1", { passkeySafe: { ...safe, recovery: { ...safe.recovery!, status: "planned" } } });
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([order()]), at(23)), "mismatch");
  assert.match(req().zoldenburg!.bankCheck!.lastCheck!.reason, /never confirmed/);
  store.updateUser("u1", { passkeySafe: safe });
});

await t("the right payment passes: time, order id, the enrolment it matched; no IBAN, no name; the code is spent", async () => {
  const o = order();
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([order({ amount: "0.2" }), o]), at(24)), "passed");
  const b = req().zoldenburg!.bankCheck!;
  assert.deepEqual(b, { passedAt: at(24).toISOString(), orderId: o.id, enrolledAt: T0.toISOString() });
  for (const s of [BANK, "MUELLER", "Müller"]) assert.ok(!JSON.stringify(req()).includes(s), `no ${s}`);
  assert.ok(B.bankCheckPassed(req(), user()));
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([o]), at(25)), "no_code");
});

await t("a pass no longer counts once the owner re-enrols, or the guardian is not active", async () => {
  const e = structuredClone(user().zoldenburgEnrolment!);
  store.updateUser("u1", { zoldenburgEnrolment: { ...e, enrolledAt: at(30).toISOString() } });
  assert.equal(B.bankCheckPassed(req(), user()), false);
  store.updateUser("u1", { zoldenburgEnrolment: e });
  assert.ok(B.bankCheckPassed(req(), user()));
  const safe = structuredClone(user().passkeySafe!);
  store.updateUser("u1", { passkeySafe: { ...safe, recovery: { ...safe.recovery!, status: "planned" } } });
  assert.equal(B.bankCheckPassed(req(), user()), false);
  store.updateUser("u1", { passkeySafe: safe });
});

await t("only open REVIEW_PENDING requests are checked; the sweep skips the rest", async () => {
  newRequest("r-grace", "GRACE_PERIOD");
  newRequest("r-old");
  store.updateRecoveryRequest("r-old", { expiresAt: at(40).toISOString() });
  for (const id of ["r-grace", "r-old"]) B.issueRecoveryBankCode(req(id), at(35));
  newRequest("r2");
  open = B.issueRecoveryBankCode(req("r2"), at(35));
  let asked = 0;
  const counting: Reads = { orders: async () => { asked++; return [order(paidAt(36))]; }, profileName: async () => "Anna Müller" };
  assert.equal(await B.checkRecoveryBankPayment("r-grace", counting, at(41)), "no_code");
  assert.equal(await B.checkRecoveryBankPayment("r-old", counting, at(41)), "no_code");
  assert.equal(asked, 0);
  assert.equal(await B.sweepRecoveryBankChecks(counting, at(41)), 1, "r2 passes");
  assert.equal(asked, 1, "r1 is spent, r-grace and r-old skipped");
  assert.ok(B.bankCheckPassed(req("r2"), user()));
});

await t("a newer code issued while a check ran is not overwritten by the older check", async () => {
  newRequest("r3");
  open = B.issueRecoveryBankCode(req("r3"), at(50));
  const slow: Reads = {
    orders: async () => { B.issueRecoveryBankCode(req("r3"), at(51)); return [order(paidAt(52))]; },
    profileName: async () => "Anna Müller",
  };
  assert.equal(await B.checkRecoveryBankPayment("r3", slow, at(53)), "no_code");
  assert.equal(req("r3").zoldenburg!.bankCheck!.passedAt, undefined);
  assert.ok(req("r3").zoldenburg!.bankCheck!.code);
});

await t("the public projection carries none of it; the person's view only last 4s", () => {
  const pub = JSON.stringify(publicRecoveryRequest(req("r3")));
  assert.ok(!pub.includes("bankCheck") && !pub.includes('"hash"'), pub);
  const v = B.bankCheckView(req("r3"), user());
  assert.equal(v.passed, false);
  assert.equal(v.fromLast4, "3000");
  assert.equal(v.toLast4, "0339");
  assert.ok(!/hash|hmac/i.test(JSON.stringify(v)));
  assert.ok(!JSON.stringify(v).includes(ZOLD_IBAN.replace(/ /g, "").slice(0, 8)), "never the whole Zold IBAN");
});

// ---- routes ----------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession: () => false }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const call = async (p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, data: text ? JSON.parse(text) : null };
};
const person = { "x-recovery-secret": SECRET };
const operator = { authorization: `Bearer ${OPERATOR}` };

newRequest("r4");

await t("routes: the request's secret is required; without it, 404", async () => {
  assert.equal((await call("/recovery/zoldenburg/r4/bank-code", {})).status, 404);
  assert.equal((await call("/recovery/zoldenburg/r4/bank-code", {}, { "x-recovery-secret": "nope" })).status, 404);
  assert.equal((await call("/recovery/zoldenburg/r4/bank-check", {})).status, 404);
});

let routeCode = "";
await t("routes: a code once, carried by its memo; GET shows the check by last 4s, never the code or a hash", async () => {
  const r = await call("/recovery/zoldenburg/r4/bank-code", {}, person);
  assert.equal(r.status, 201, r.text);
  routeCode = r.data.code;
  assert.match(r.data.memo, /^ZOLD [0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(E.memoCarriesCode(r.data.memo, req("r4").zoldenburg!.bankCheck!.code!.hash, "recovery"));
  assert.equal(r.data.bankCheck.fromLast4, "3000");
  const g = await call("/recovery/zoldenburg/r4", undefined, person);
  assert.equal(g.status, 200, g.text);
  assert.equal(g.data.bankCheck.passed, false);
  assert.ok(g.data.bankCheck.codeIssuedAt);
  assert.ok(!g.text.includes(routeCode.replace("-", "")) && !g.text.includes(routeCode));
  assert.ok(!/"hash"|hmac/i.test(g.text), g.text);
  assert.ok(!g.text.includes(ZOLD_IBAN.replace(/ /g, "")));
});

await t("routes: check-now fails closed with no Monerium connection, and is throttled", async () => {
  const c = await call("/recovery/zoldenburg/r4/bank-check", {}, person);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.data.bankCheck.passed, false);
  assert.equal(c.data.bankCheck.lastCheck.outcome, "unreadable");
  const at1 = c.data.bankCheck.lastCheck.at;
  const again = await call("/recovery/zoldenburg/r4/bank-check", {}, person);
  assert.equal(again.data.bankCheck.lastCheck.at, at1, "a fast second click gets the last answer");
});

await t("operator: BANK_CHECK_PENDING on sign-request, execute and sync until the 1 € passed; no Safe Cover link", async () => {
  for (const [p, body] of [["sign-request", {}], ["execute", { signature: "0x00", reviewNote: "Video call, matched Monerium profile" }], ["sync", {}]] as const) {
    const r = await call(`/admin/recoveries/r4/${p}`, body, operator);
    assert.equal(r.status, 409, `${p}: ${r.text}`);
    assert.equal(r.data.code, "BANK_CHECK_PENDING", p);
  }
  const row = (await call("/admin/recoveries", undefined, operator)).data.requests.find((x: any) => x.id === "r4");
  assert.equal(row.bankCheck.passed, false);
  assert.equal(row.bankCheck.lastCheck.outcome, "unreadable");
  assert.equal(row.safeCoverLink, null);
  assert.ok(!/"hash"|hmac/i.test(JSON.stringify(row)));
});

await t("operator: once passed, the gate opens (execute then asks for the review note)", async () => {
  open = { code: routeCode, memo: E.memoFor(routeCode) };
  const paid = order({ meta: { state: "processed", processedAt: new Date(Date.now() + 1000).toISOString() } });
  assert.equal(await B.checkRecoveryBankPayment("r4", reads([paid]), new Date()), "passed");
  const row = (await call("/admin/recoveries", undefined, operator)).data.requests.find((x: any) => x.id === "r4");
  assert.equal(row.bankCheck.passed, true);
  const ex = await call("/admin/recoveries/r4/execute", { signature: "0x00" }, operator);
  assert.equal(ex.data.code, "NO_REVIEW_NOTE", ex.text);
  const again = await call("/recovery/zoldenburg/r4/bank-code", {}, person);
  assert.equal(again.data.code, "ALREADY_PASSED");
});

await t("operator: an unarmed account is NOT_ARMED, before any bank check", async () => {
  newRequest("r5");
  const e = structuredClone(user().zoldenburgEnrolment!);
  store.updateUser("u1", { zoldenburgEnrolment: undefined });
  assert.equal((await call("/admin/recoveries/r5/sign-request", {}, operator)).data.code, "NOT_ARMED");
  assert.equal((await call("/recovery/zoldenburg/r5/bank-code", {}, person)).data.code, "NOT_ARMED");
  store.updateUser("u1", { zoldenburgEnrolment: e });
});
server.close();

// ---- source checks ---------------------------------------------------------

const src = (p: string) => readFileSync(new URL(`../services/api/src/${p}`, import.meta.url), "utf8");

await t("the person's routes sit on the auth rate bucket", () => {
  assert.ok(src("http/policy.ts").includes('path.startsWith("/recovery")'));
});

await t("the operator routes refuse before they hand out or relay anything", () => {
  const r = src("routes/recovery-zoldenburg.ts");
  const between = (a: string, b: string) => r.slice(r.indexOf(a), r.indexOf(b));
  for (const [route, next] of [['"/admin/recoveries/:id/sign-request"', '"/admin/recoveries/:id/execute"'], ['"/admin/recoveries/:id/execute"', '"/admin/recoveries/:id/sync"']]) {
    const body = between(route, next);
    assert.ok(body.includes("const refusal = refusalFor(r);\n      if (refusal) return res.status(409).json(refusal);"), route);
    assert.ok(body.indexOf("refusalFor(r)") < body.indexOf("typedDataFor(r)"), route);
  }
  const sync = between('"/admin/recoveries/:id/sync"', '"/admin/recoveries/:id/finalize"');
  assert.ok(sync.indexOf("refusalFor(r)") > 0 && sync.indexOf("refusalFor(r)") < sync.indexOf("syncZoldenburgFromChain"));
});

if (failed) { console.error(`ZOLDENBURG RECOVERY 1 € TEST FAILED — ${failed}`); process.exit(1); }
console.log("ZOLDENBURG RECOVERY 1 € TEST PASSED");
process.exit(0);
