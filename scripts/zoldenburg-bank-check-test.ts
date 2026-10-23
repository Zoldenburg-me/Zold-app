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
import "./_local-chain.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-rbank-")), "db.json");
process.env.RECOVERY_IBAN_HMAC_KEY = "k".repeat(40);
// A real key, so the execute test can sign; it lives only in this process.
const guardianWallet = privateKeyToAccount(generatePrivateKey());
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = guardianWallet.address;

const express = (await import("express")).default;
const { store } = await import("../services/api/src/store.js");
const { RECOVERY } = await import("../services/api/src/config.js");
const E = await import("../services/api/src/recovery/zoldenburg-enrolment.js");
const B = await import("../services/api/src/recovery/zoldenburg-bank-check.js");
const { publicRecoveryRequest } = await import("../services/api/src/recovery.js");
const { createZoldenburgRecoveryRouter, sweepZoldenburgRecoveries, finalizeZoldenburgRecovery } = await import("../services/api/src/routes/recovery-zoldenburg.js");
const { zoldenburgChain } = await import("../services/api/src/recovery/zoldenburg-guardian.js");
const { createOperatorGate } = await import("../services/api/src/operators/gate.js");
const { createOperatorAuthRouter } = await import("../services/api/src/routes/operator-auth.js");
const { OPERATOR: OPERATOR_CONFIG, SECURITY } = await import("../services/api/src/config.js");
const { operatorKit } = await import("./_operator.js");
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
  assert.ok(!other.reason.includes("3000"), "no digits of the enrolled account");
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

await t("an account that is not armed never passes, whatever was paid, and the next check looks again", async () => {
  const safe = structuredClone(user().passkeySafe!);
  store.updateUser("u1", { passkeySafe: { ...safe, recovery: { ...safe.recovery!, status: "planned" } } });
  try {
    assert.equal(await B.checkRecoveryBankPayment("r1", reads([order()]), at(23)), "unreadable");
    assert.equal(req().zoldenburg!.bankCheck!.lastCheck!.cause, "not_armed");
    assert.ok(!/armed|enrol|confirm/i.test(req().zoldenburg!.bankCheck!.lastCheck!.reason), "the person's text names no cause");
    assert.equal(req().zoldenburg!.bankCheck!.passedAt, undefined);
  } finally {
    store.updateUser("u1", { passkeySafe: safe });
  }
});

await t("the right payment passes: time, order id, the enrolment it matched; no IBAN, no name; the code is spent", async () => {
  const o = order();
  assert.equal(await B.checkRecoveryBankPayment("r1", reads([order({ amount: "0.2" }), o]), at(24)), "passed");
  const b = req().zoldenburg!.bankCheck!;
  assert.deepEqual(b, { codesIssued: 1, lastReadAt: at(24).toISOString(), passedAt: at(24).toISOString(), orderId: o.id, enrolledAt: T0.toISOString() });
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
  // A request on chain blocks signing any other for the account; this one has done its part.
  store.updateRecoveryRequest("r-grace", { status: "FINALIZED" });
});

await t("a request that moves on while a check ran is left as it is", async () => {
  newRequest("r3");
  open = B.issueRecoveryBankCode(req("r3"), at(50));
  const slow: Reads = {
    orders: async () => { store.updateRecoveryRequest("r3", { status: "CANCELED" }); return [order(paidAt(52))]; },
    profileName: async () => "Anna Müller",
  };
  assert.equal(await B.checkRecoveryBankPayment("r3", slow, at(53)), "no_code");
  assert.equal(req("r3").zoldenburg!.bankCheck!.passedAt, undefined);
  assert.ok(req("r3").zoldenburg!.bankCheck!.code);
  store.updateRecoveryRequest("r3", { status: "REVIEW_PENDING" });
});

await t("a new code issued while a check ran does not lose a payment made with the earlier one", async () => {
  newRequest("r3b");
  open = B.issueRecoveryBankCode(req("r3b"), at(50));
  const slow: Reads = {
    orders: async () => { B.issueRecoveryBankCode(req("r3b"), at(51)); return [order(paidAt(52))]; },
    profileName: async () => "Anna Müller",
  };
  assert.equal(await B.checkRecoveryBankPayment("r3b", slow, at(53)), "passed");
  assert.equal(req("r3b").zoldenburg!.bankCheck!.codesIssued, 2, "the count survives the pass");
});

await t("the public projection carries none of it; the person's view no IBAN digits at all", () => {
  const pub = JSON.stringify(publicRecoveryRequest(req("r3")));
  assert.ok(!pub.includes("bankCheck") && !pub.includes('"hash"'), pub);
  const v = JSON.stringify(B.bankCheckView(req("r3"), user()));
  assert.ok(!/hash|hmac|last4/i.test(v), v);
  for (const s of ["3000", "0339"]) assert.ok(!v.includes(s), s);
});

await t("a transfer sent with an earlier code still counts after a new one is issued", async () => {
  newRequest("r6");
  const first = B.issueRecoveryBankCode(req("r6"), at(60));
  B.issueRecoveryBankCode(req("r6"), at(70));
  assert.equal(req("r6").zoldenburg!.bankCheck!.earlierCodes!.length, 1);
  open = first;
  assert.equal(await B.checkRecoveryBankPayment("r6", reads([order(paidAt(65))]), at(71)), "passed");
});

await t("a request gets at most maxCodes codes; the count and the read clock survive a new code", async () => {
  newRequest("r7");
  for (let i = 0; i < B.RECOVERY_BANK.maxCodes; i++) {
    assert.ok(B.canIssueRecoveryBankCode(req("r7")));
    B.issueRecoveryBankCode(req("r7"), at(80 + i));
    if (i === 0) await B.checkRecoveryBankPayment("r7", reads([]), at(80));
  }
  assert.equal(B.canIssueRecoveryBankCode(req("r7")), false);
  assert.equal(req("r7").zoldenburg!.bankCheck!.lastReadAt, at(80).toISOString(), "a new code does not reset the read clock");
});

await t("a payment passes only the request whose code it carries, and only one request", async () => {
  newRequest("r-a");
  newRequest("r-b");
  const a = B.issueRecoveryBankCode(req("r-a"), at(90));
  const b = B.issueRecoveryBankCode(req("r-b"), at(90));
  open = a;
  const paid = order(paidAt(91));
  assert.equal(await B.checkRecoveryBankPayment("r-b", reads([paid]), at(92)), "waiting", "A's code does not pass B");
  assert.equal(await B.checkRecoveryBankPayment("r-a", reads([paid]), at(92)), "passed");
  const both = { ...paid, memo: `${a.memo} ${b.memo}` };
  assert.equal(await B.checkRecoveryBankPayment("r-b", reads([both]), at(93)), "mismatch", "an order already counted for A never passes B");
  assert.ok(!B.bankCheckPassed(req("r-b"), user()));
});

await t("an order processed before its code was issued never counts", async () => {
  newRequest("r9");
  open = B.issueRecoveryBankCode(req("r9"), at(100));
  assert.equal(await B.checkRecoveryBankPayment("r9", reads([order(paidAt(99))]), at(101)), "waiting");
  assert.equal(req("r9").zoldenburg!.bankCheck!.passedAt, undefined);
});

await t("two checks at once read Monerium once; the second says one is running", async () => {
  let asked = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: Reads = { orders: async () => { asked++; await gate; return []; }, profileName: async () => "Anna Müller" };
  const first = B.checkRecoveryBankPayment("r9", slow, at(102));
  assert.equal(await B.checkRecoveryBankPayment("r9", slow, at(102)), "running");
  release();
  assert.equal(await first, "waiting");
  assert.equal(asked, 1);
});

await t("a check that throws is recorded as unreadable, and never leaves the request stuck", async () => {
  const realUpdate = store.updateRecoveryRequest.bind(store);
  let calls = 0;
  (store as any).updateRecoveryRequest = (id: string, patch: any) => {
    if (id === "r9" && ++calls === 1) throw new Error("disk full");
    return realUpdate(id, patch);
  };
  try {
    assert.equal(await B.checkRecoveryBankPayment("r9", reads([]), at(103)), "unreadable");
  } finally {
    (store as any).updateRecoveryRequest = realUpdate;
  }
  assert.equal(req("r9").zoldenburg!.bankCheck!.lastCheck!.outcome, "unreadable");
  let asked = 0;
  assert.equal(await B.checkRecoveryBankPayment("r9", { orders: async () => { asked++; return []; }, profileName: async () => "x" }, at(104)), "waiting");
  assert.equal(asked, 1, "the next check reads again");
  // A malformed order throws inside the check: unreadable, not an old answer.
  const bad: Reads = { orders: async () => [{ get kind(): string { throw new Error("malformed"); } }] as any, profileName: async () => "Anna Müller" };
  assert.equal(await B.checkRecoveryBankPayment("r9", bad, at(105)), "unreadable");
  assert.equal(req("r9").zoldenburg!.bankCheck!.lastCheck!.cause, "error");
  // A programming error is not a failed read: it is thrown, not recorded.
  const buggy: Reads = { orders: async () => [{ get kind(): string { throw new TypeError("x is undefined"); } }] as any, profileName: async () => "Anna Müller" };
  await assert.rejects(B.checkRecoveryBankPayment("r9", buggy, at(106)), TypeError);
  assert.equal(await B.checkRecoveryBankPayment("r9", reads([]), at(107)), "waiting", "and the request is not stuck after it");
});

await t("an enrolment replaced during the reads by the same account binds the pass to the new one", async () => {
  newRequest("r15");
  open = B.issueRecoveryBankCode(req("r15"), at(120));
  const e = structuredClone(user().zoldenburgEnrolment!);
  const later = at(121).toISOString();
  const mid: Reads = { orders: async () => { store.updateUser("u1", { zoldenburgEnrolment: { ...e, enrolledAt: later } }); return [order(paidAt(122))]; }, profileName: async () => "Anna Müller" };
  try {
    assert.equal(await B.checkRecoveryBankPayment("r15", mid, at(123)), "passed");
    assert.equal(req("r15").zoldenburg!.bankCheck!.enrolledAt, later);
    assert.ok(B.bankCheckPassed(req("r15"), user()));
  } finally {
    store.updateUser("u1", { zoldenburgEnrolment: e });
  }
});

await t("an enrolment removed during the reads is not passed against", async () => {
  newRequest("r10");
  open = B.issueRecoveryBankCode(req("r10"), at(110));
  const e = structuredClone(user().zoldenburgEnrolment!);
  const mid: Reads = { orders: async () => { store.updateUser("u1", { zoldenburgEnrolment: undefined }); return [order(paidAt(111))]; }, profileName: async () => "Anna Müller" };
  try {
    assert.equal(await B.checkRecoveryBankPayment("r10", mid, at(112)), "unreadable");
    assert.equal(req("r10").zoldenburg!.bankCheck!.passedAt, undefined);
  } finally {
    store.updateUser("u1", { zoldenburgEnrolment: e });
  }
});

// ---- routes ----------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api/admin", createOperatorGate());
app.use("/api", createOperatorAuthRouter());
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession: () => false }));
// A second mount whose chain sync the test stages (the harness skips chain reads).
let staged: (r: any) => Promise<any> = async (r) => r;
app.use("/staged", createZoldenburgRecoveryRouter({ requireUserSession: () => false, sync: ((r: any) => staged(r)) as any }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const base = `${origin}/api`;
// The operator signs in with a passkey and approves each change (scripts/_operator.ts).
const kit = await operatorKit({ base: origin, origin: OPERATOR_CONFIG.adminOrigin, rpId: SECURITY.rpId, dataDir: path.dirname(process.env.TRANSF_DB_PATH!) });
const opCall = async (p: string, body?: unknown) => {
  const r = await kit.call(body === undefined ? "GET" : "POST", `/api${p}`, body);
  return { status: r.status, data: r.body, text: JSON.stringify(r.body) };
};
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

newRequest("r4");

await t("routes: the request's secret is required; without it, 404", async () => {
  assert.equal((await call("/recovery/zoldenburg/r4/bank-code", {})).status, 404);
  assert.equal((await call("/recovery/zoldenburg/r4/bank-code", {}, { "x-recovery-secret": "nope" })).status, 404);
  assert.equal((await call("/recovery/zoldenburg/r4/bank-check", {})).status, 404);
});

let routeCode = "";
await t("routes: a code once, carried by its memo; GET shows the check, never the code, a hash or IBAN digits", async () => {
  const r = await call("/recovery/zoldenburg/r4/bank-code", {}, person);
  assert.equal(r.status, 201, r.text);
  routeCode = r.data.code;
  assert.match(r.data.memo, /^ZOLD [0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(E.memoCarriesCode(r.data.memo, req("r4").zoldenburg!.bankCheck!.code!.hash, "recovery"));
  assert.equal(r.data.bankCheck.canIssueCode, true);
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
  // A new code does not buy a new Monerium read.
  const fresh = await call("/recovery/zoldenburg/r4/bank-code", {}, person);
  assert.equal(fresh.status, 201, fresh.text);
  routeCode = fresh.data.code;
  const third = await call("/recovery/zoldenburg/r4/bank-check", {}, person);
  assert.equal(third.data.bankCheck.lastCheck, undefined, "no read: the new code has no answer yet");
});

await t("routes: past maxCodes, 429 TOO_MANY_CODES", async () => {
  newRequest("r8");
  for (let i = 0; i < B.RECOVERY_BANK.maxCodes; i++) assert.equal((await call("/recovery/zoldenburg/r8/bank-code", {}, person)).status, 201);
  const over = await call("/recovery/zoldenburg/r8/bank-code", {}, person);
  assert.equal(over.status, 429, over.text);
  assert.equal(over.data.code, "TOO_MANY_CODES");
  assert.equal(over.data.bankCheck.canIssueCode, false);
});

await t("operator: BANK_CHECK_PENDING on sign-request, execute and sync until the 1 € passed; no Safe Cover link", async () => {
  for (const [p, body] of [["sign-request", {}], ["execute", { signature: "0x00", reviewNote: "Video call, matched Monerium profile" }], ["sync", {}]] as const) {
    const r = await opCall(`/admin/recoveries/r4/${p}`, body);
    assert.equal(r.status, 409, `${p}: ${r.text}`);
    assert.equal(r.data.code, "BANK_CHECK_PENDING", p);
  }
  const row = (await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r4");
  assert.equal(row.bankCheck.passed, false);
  assert.ok(row.bankCheck.codeIssuedAt);
  assert.equal(row.safeCoverLink, null);
  assert.ok(!/"hash"|hmac/i.test(JSON.stringify(row)));
});

await t("operator: once passed, the gate opens (execute then asks for the review note)", async () => {
  open = { code: routeCode, memo: E.memoFor(routeCode) };
  const paid = order({ meta: { state: "processed", processedAt: new Date(Date.now() + 1000).toISOString() } });
  assert.equal(await B.checkRecoveryBankPayment("r4", reads([paid]), new Date()), "passed");
  const row = (await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r4");
  assert.equal(row.bankCheck.passed, true);
  const ex = await opCall("/admin/recoveries/r4/execute", { signature: "0x00" });
  assert.equal(ex.data.code, "NO_REVIEW_NOTE", ex.text);
  const again = await call("/recovery/zoldenburg/r4/bank-code", {}, person);
  assert.equal(again.data.code, "ALREADY_PASSED");
});

await t("operator: an unarmed account is NOT_ARMED, before any bank check", async () => {
  newRequest("r5");
  const e = structuredClone(user().zoldenburgEnrolment!);
  store.updateUser("u1", { zoldenburgEnrolment: undefined });
  assert.equal((await opCall("/admin/recoveries/r5/sign-request", {})).data.code, "NOT_ARMED");
  assert.equal((await call("/recovery/zoldenburg/r5/bank-code", {}, person)).data.code, "NOT_ARMED");
  store.updateUser("u1", { zoldenburgEnrolment: e });
});

await t("operator: a pass voided by re-enrolment or a new HMAC key locks signing again, and says so", async () => {
  assert.equal((await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r4").bankCheck.passed, true);
  const e = structuredClone(user().zoldenburgEnrolment!);
  store.updateUser("u1", { zoldenburgEnrolment: { ...e, enrolledAt: new Date().toISOString() } });
  try {
    for (const [p, body] of [["sign-request", {}], ["execute", { signature: "0x00", reviewNote: "Video call, matched Monerium profile" }], ["sync", {}]] as const) {
      assert.equal((await opCall(`/admin/recoveries/r4/${p}`, body)).data.code, "BANK_CHECK_PENDING", p);
    }
    const row = (await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r4");
    assert.equal(row.bankCheck.passed, false);
    assert.equal(row.bankCheck.voided, true);
    assert.equal(row.safeCoverLink, null);
    // Voided, the person may ask for a reference again.
    assert.equal((await call("/recovery/zoldenburg/r4", undefined, person)).data.bankCheck.canIssueCode, true);
  } finally {
    store.updateUser("u1", { zoldenburgEnrolment: e });
  }
  await withKey("n".repeat(40), async () => {
    assert.equal((await opCall("/admin/recoveries/r4/sign-request", {})).data.code, "NOT_ARMED");
    assert.equal((await call("/recovery/zoldenburg/r4/bank-code", {}, person)).data.code, "NOT_ARMED");
  });
  assert.equal((await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r4").bankCheck.passed, true, "the right key back, the pass counts");
});

await t("routes: check-now says what this click did", async () => {
  newRequest("r11");
  assert.equal((await call("/recovery/zoldenburg/r11/bank-code", {}, person)).status, 201);
  const first = await call("/recovery/zoldenburg/r11/bank-check", {}, person);
  assert.equal(first.data.check.outcome, "unreadable", "no Monerium here: this click's own answer");
  const again = await call("/recovery/zoldenburg/r11/bank-check", {}, person);
  assert.equal(again.data.check.outcome, "recent");
  assert.ok(Date.parse(again.data.check.nextCheckAt) > Date.now());
});

await t("routes: an expired request answers 410, then 409 as ended, and is never checked", async () => {
  newRequest("r12");
  assert.equal((await call("/recovery/zoldenburg/r12/bank-code", {}, person)).status, 201);
  store.updateRecoveryRequest("r12", { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const c = await call("/recovery/zoldenburg/r12/bank-check", {}, person);
  assert.equal(c.status, 410, c.text);
  assert.equal(c.data.status, "EXPIRED");
  assert.equal(req("r12").zoldenburg!.bankCheck!.lastReadAt, undefined, "no Monerium read");
  const code = await call("/recovery/zoldenburg/r12/bank-code", {}, person);
  assert.equal(code.status, 409, code.text);
  assert.equal(code.data.status, "EXPIRED", "an ended request gets no new code");
});

await t("operator: references can be given back; codes stay valid", async () => {
  assert.equal((await call("/recovery/zoldenburg/r8/bank-code", {}, person)).data.code, "TOO_MANY_CODES");
  const before = req("r8").zoldenburg!.bankCheck!.code!.hash;
  const r = await opCall("/admin/recoveries/r8/bank-reset", {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.bankCheck.codesIssued, 0);
  assert.equal(req("r8").zoldenburg!.bankCheck!.code!.hash, before, "the open code is kept");
  assert.equal((await call("/recovery/zoldenburg/r8/bank-code", {}, person)).status, 201);
  assert.equal((await opCall("/admin/recoveries/r5/bank-reset", {})).data.code, "NOTHING_TO_RESET");
});

await t("operator: a reset keeps the read clock, refuses a passed check or an ended request, and needs an operator", async () => {
  const before = req("r8").zoldenburg!.bankCheck!;
  store.updateRecoveryRequest("r8", { zoldenburg: { ...req("r8").zoldenburg, bankCheck: { ...before, lastReadAt: new Date().toISOString() } } });
  const clock = req("r8").zoldenburg!.bankCheck!.lastReadAt;
  assert.equal((await opCall("/admin/recoveries/r8/bank-reset", {})).status, 200);
  assert.equal(req("r8").zoldenburg!.bankCheck!.lastReadAt, clock, "a reset buys no Monerium read");
  assert.equal((await opCall("/admin/recoveries/r4/bank-reset", {})).data.code, "ALREADY_PASSED");
  store.updateRecoveryRequest("r8", { status: "CANCELED" });
  assert.equal((await opCall("/admin/recoveries/r8/bank-reset", {})).status, 409);
  store.updateRecoveryRequest("r8", { status: "REVIEW_PENDING" });
  const anon = await call("/admin/recoveries/r8/bank-reset", {});
  assert.ok([401, 403].includes(anon.status), `no operator: ${anon.status}`);
  const row = (await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r8");
  assert.equal(row.bankCheck.maxCodes, B.RECOVERY_BANK.maxCodes);
  assert.equal(typeof row.bankCheck.codesIssued, "number");
});

await t("routes: check-now with no open code says nothing to check; a recorded reason comes with the answer", async () => {
  newRequest("r13");
  const none = await call("/recovery/zoldenburg/r13/bank-check", {}, person);
  assert.equal(none.data.check.outcome, "no_code");
  assert.equal(none.data.check.reason, undefined);
  newRequest("r14");
  assert.equal((await call("/recovery/zoldenburg/r14/bank-code", {}, person)).status, 201);
  const read = await call("/recovery/zoldenburg/r14/bank-check", {}, person);
  assert.equal(read.data.check.outcome, "unreadable");
  assert.ok(read.data.check.reason, "this click recorded a reason and returns it");
  assert.equal(read.data.bankCheck.lastCheck.cause, undefined, "the cause is for the operator only");
  const row = (await opCall("/admin/recoveries")).data.requests.find((x: any) => x.id === "r14");
  assert.equal(row.bankCheck.lastCheck.cause, "monerium_orders");
});

await t("routes: a corrupt read clock does not 500", async () => {
  store.updateRecoveryRequest("r14", { zoldenburg: { ...req("r14").zoldenburg, bankCheck: { ...req("r14").zoldenburg!.bankCheck, lastReadAt: "not a date" } } });
  const r = await call("/recovery/zoldenburg/r14/bank-check", {}, person);
  assert.equal(r.status, 200, r.text);
});
await t("execute: a cancel landing while the signature is checked gets 409, and nothing is relayed", async () => {
  // r4 has passed its 1 € check; the operator fetches what to sign.
  const sr = await opCall("/admin/recoveries/r4/sign-request", {});
  assert.equal(sr.status, 200, sr.text);
  const { EIP712Domain: _d, ...types } = sr.data.typedData.types;
  const m = sr.data.typedData.message;
  const signature = await guardianWallet.signTypedData({ ...sr.data.typedData, types, message: { ...m, newThreshold: BigInt(m.newThreshold), nonce: BigInt(m.nonce) } });
  const { onChainDigest, relayRecovery } = zoldenburgChain;
  let relayed = 0;
  // The owner's cancel lands during execute's chain read.
  zoldenburgChain.onChainDigest = async (td) => {
    store.updateRecoveryRequest("r4", { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "cancelled by the account owner" });
    return onChainDigest(td);
  };
  zoldenburgChain.relayRecovery = async (...a) => { relayed++; return relayRecovery(...a); };
  try {
    const ex = await opCall("/admin/recoveries/r4/execute", { signature, reviewNote: "Video call, matched Monerium profile" });
    assert.equal(ex.status, 409, ex.text);
    assert.match(ex.data.error, /CANCELED/);
    assert.equal(relayed, 0, "no relay after the cancel");
    assert.equal(req("r4").status, "CANCELED");
  } finally {
    Object.assign(zoldenburgChain, { onChainDigest, relayRecovery });
  }
});

await t("execute: a 1 € check voided while the signature is checked gets 409, and nothing is relayed", async () => {
  store.updateRecoveryRequest("r4", { status: "REVIEW_PENDING", canceledAt: undefined, cancelReason: undefined });
  const sr = await opCall("/admin/recoveries/r4/sign-request", {});
  assert.equal(sr.status, 200, sr.text);
  const { EIP712Domain: _d, ...types } = sr.data.typedData.types;
  const m = sr.data.typedData.message;
  const signature = await guardianWallet.signTypedData({ ...sr.data.typedData, types, message: { ...m, newThreshold: BigInt(m.newThreshold), nonce: BigInt(m.nonce) } });
  const e = structuredClone(user().zoldenburgEnrolment!);
  const { onChainDigest, relayRecovery } = zoldenburgChain;
  let relayed = 0;
  // A re-enrolment lands during execute's chain read.
  zoldenburgChain.onChainDigest = async (td) => {
    store.updateUser("u1", { zoldenburgEnrolment: { ...e, enrolledAt: new Date().toISOString() } });
    return onChainDigest(td);
  };
  zoldenburgChain.relayRecovery = async (...a) => { relayed++; return relayRecovery(...a); };
  try {
    const ex = await opCall("/admin/recoveries/r4/execute", { signature, reviewNote: "Video call, matched Monerium profile" });
    assert.equal(ex.status, 409, ex.text);
    assert.equal(ex.data.code, "BANK_CHECK_PENDING");
    assert.equal(relayed, 0, "no relay after the check was voided");
  } finally {
    Object.assign(zoldenburgChain, { onChainDigest, relayRecovery });
    store.updateUser("u1", { zoldenburgEnrolment: e });
  }
});

await t("person's routes: an expired request asks the chain first; on chain it is in its grace period, unreadable stores nothing", async () => {
  newRequest("r22");
  store.updateRecoveryRequest("r22", { expiresAt: new Date(Date.now() - 1000).toISOString() });
  staged = async () => { throw new Error("rpc down"); };
  const r1 = await fetch(`${origin}/staged/recovery/zoldenburg/r22`, { headers: person });
  assert.equal(r1.status, 503, await r1.text());
  assert.equal(req("r22").status, "REVIEW_PENDING", "nothing stored on an unreadable chain");
  staged = async (r) => store.updateRecoveryRequest(r.id, { status: "GRACE_PERIOD" });
  const r2 = await fetch(`${origin}/staged/recovery/zoldenburg/r22`, { headers: person });
  assert.equal(r2.status, 200, await r2.text());
  assert.equal(req("r22").status, "GRACE_PERIOD");
  // Done: one on chain would block signing the account's others below.
  store.updateRecoveryRequest("r22", { status: "FINALIZED" });
  newRequest("r23");
  store.updateRecoveryRequest("r23", { expiresAt: new Date(Date.now() - 1000).toISOString() });
  staged = async (r) => r;
  const r3 = await fetch(`${origin}/staged/recovery/zoldenburg/r23`, { headers: person });
  assert.equal(r3.status, 410);
  assert.equal(req("r23").status, "EXPIRED");
});

await t("execute: while the relay is in flight nothing closes the request; afterwards it is in its grace period", async () => {
  store.updateRecoveryRequest("r4", { status: "REVIEW_PENDING", canceledAt: undefined, cancelReason: undefined });
  const sr = await opCall("/admin/recoveries/r4/sign-request", {});
  assert.equal(sr.status, 200, sr.text);
  const { EIP712Domain: _d, ...types } = sr.data.typedData.types;
  const m = sr.data.typedData.message;
  const signature = await guardianWallet.signTypedData({ ...sr.data.typedData, types, message: { ...m, newThreshold: BigInt(m.newThreshold), nonce: BigInt(m.nonce) } });
  const { relayRecovery } = zoldenburgChain;
  let during = "";
  zoldenburgChain.relayRecovery = async (...a) => {
    // The sweep runs mid-relay, long after the request's expiry.
    await sweepZoldenburgRecoveries(new Date(Date.parse(req("r4").expiresAt) + 1000), (async (r: any) => r) as any);
    during = req("r4").status;
    return relayRecovery(...a);
  };
  try {
    const ex = await opCall("/admin/recoveries/r4/execute", { signature, reviewNote: "Video call, matched Monerium profile" });
    assert.equal(ex.status, 200, ex.text);
    assert.equal(during, "REVIEW_PENDING", "the sweep left the in-flight request alone");
    assert.equal(req("r4").status, "GRACE_PERIOD");
  } finally {
    zoldenburgChain.relayRecovery = relayRecovery;
  }
});

await t("sweep: the chain is read before an expired request is closed", async () => {
  newRequest("r20");
  newRequest("r21");
  const later = new Date(Date.parse(req("r20").expiresAt) + 1000);
  const synced: string[] = [];
  // r20 was signed outside /admin (Safe Cover) and is on chain; r21 is not.
  const sync = async (r: any) => {
    synced.push(r.id);
    return r.id === "r20" ? store.updateRecoveryRequest(r.id, { status: "GRACE_PERIOD" }) : r;
  };
  await sweepZoldenburgRecoveries(later, sync as any);
  assert.ok(synced.includes("r20") && synced.includes("r21"));
  assert.equal(req("r20").status, "GRACE_PERIOD", "on chain: the grace period, so the owner is alerted");
  assert.equal(req("r21").status, "EXPIRED", "not on chain: expired");
});

server.close();

// ---- the page's 1 € step (public/recovery/bank-step.js) --------------------

const UI: any = await import(new URL("../services/api/public/recovery/bank-step.js", import.meta.url).href);
const memStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const view = (bankCheck: Record<string, unknown>) => ({ id: "rq", bankCheck: { minimumEur: 1, passed: false, canIssueCode: true, ...bankCheck } });

await t("page: no code yet offers the details; no IBAN digits anywhere; the warning is there", () => {
  const html = UI.bankStepHtml(view({}), null);
  assert.match(html, /data-bank="new"[^>]*>Show my transfer details/);
  assert.match(html, /Only send this if you started this recovery yourself/);
  assert.ok(!/\d{4}/.test(html.replace(/1 €/g, "")), "no 4-digit runs");
});

await t("page: the reference shows only for the open code of this request, and survives a reload", () => {
  const storage = memStore();
  const r = view({ codeIssuedAt: "2026-10-11T10:00:00.000Z" });
  UI.keepIssued(storage, { id: "rq", memo: "ZOLD AB12-CD34", bankCheck: { codeIssuedAt: "2026-10-11T10:00:00.000Z" } });
  assert.equal(UI.issuedFor(storage, r)?.memo, "ZOLD AB12-CD34");
  assert.match(UI.bankStepHtml(r, UI.issuedFor(storage, r)), /ZOLD AB12-CD34/);
  assert.equal(UI.issuedFor(storage, { ...r, id: "other" }), null, "another request's reference never shows");
  assert.equal(UI.issuedFor(storage, view({ codeIssuedAt: "2026-10-11T11:00:00.000Z" })), null, "a newer code elsewhere voids it");
  const lost = UI.bankStepHtml(r, null);
  assert.ok(!lost.includes("AB12"));
  assert.match(lost, /earlier reference still counts/);
  assert.equal(UI.issuedFor({ getItem: () => { throw new Error("blocked"); } } as any, r), null, "blocked storage reads as none");
});

await t("page: out of codes, no new-reference button and a way out; passed, the step is done", () => {
  const out = UI.bankStepHtml(view({ codeIssuedAt: "2026-10-11T10:00:00.000Z", canIssueCode: false }), null);
  assert.ok(!out.includes('data-bank="new"'));
  assert.match(out, /support@zoldhq.com/);
  const done = UI.bankStepHtml(view({ passed: true }), null);
  assert.ok(!done.includes("data-bank"));
  assert.match(done, /arrived/);
});

await t("page: a click's answer is this click's, never an older reason", () => {
  const base = view({ codeIssuedAt: "x", lastCheck: { at: "1", reason: "old reason" } });
  assert.equal(UI.checkAnswerText({ ...base, check: { outcome: "recent", nextCheckAt: new Date(10_000 + 12_000).toISOString() } }, 10_000), "We checked a moment ago. Try again in 12 seconds.");
  assert.match(UI.checkAnswerText({ ...base, check: { outcome: "running" } }), /already running/);
  assert.match(UI.checkAnswerText({ ...base, check: { outcome: "no_code" } }), /nothing to check/);
  assert.equal(UI.checkAnswerText({ ...base, check: { outcome: "waiting", reason: "this click's reason" } }), "this click's reason");
  assert.ok(!UI.checkAnswerText({ ...base, check: { outcome: "waiting" } }).includes("old reason"), "a reason this click did not record is never shown");
  assert.ok(!UI.checkAnswerText({ ...base, check: { outcome: "unreadable" } }).includes("old reason"));
  const html = UI.bankStepHtml(base, null, "We checked a moment ago. Try again in 12 seconds.");
  assert.match(html, /id="r-bank-note"/);
  assert.ok(!html.includes("old reason"), "the note replaces the recorded reason");
});

await t("page: the poll redraws only when the step changed", () => {
  const a = view({ codeIssuedAt: "x", lastCheck: { at: "1" } });
  assert.equal(UI.bankStepChanged(a, structuredClone(a)), false);
  assert.ok(UI.bankStepChanged(a, view({ codeIssuedAt: "x", lastCheck: { at: "2" } })));
  assert.ok(UI.bankStepChanged(a, view({ codeIssuedAt: "x", lastCheck: { at: "1" }, passed: true })));
});

// ---- source checks ---------------------------------------------------------

const src = (p: string) => readFileSync(new URL(`../services/api/src/${p}`, import.meta.url), "utf8");

await t("the person's routes sit on the auth rate bucket", () => {
  assert.ok(src("http/policy.ts").includes('path.startsWith("/recovery")'));
});

await t("writes after a chain read spread the stored state, not a copy from before the read", () => {
  const r = src("routes/recovery-zoldenburg.ts");
  const chain = r.slice(r.indexOf("export async function syncZoldenburgFromChain"), r.indexOf("export async function sweepZoldenburgRecoveries"));
  assert.ok(!/zoldenburg: \{ \.\.\.z,/.test(chain), "no `...z` spread: a 1 € pass recorded during the read would be put back");
  assert.equal(chain.match(/\.\.\.zoldenburgNow\(request\.id\)/g)?.length, 3);
});

await t("the owner's cancel, the operator's reject and the person's routes wait for a relay in flight", () => {
  const r = src("routes/recovery-zoldenburg.ts");
  for (const [from, to, write] of [
    ['"/users/:id/recovery/zoldenburg/requests/:rid/cancel"', "const findRecoverable", 'status: "CANCELED"'],
    ['"/admin/recoveries/:id/reject"', "return router;", 'status: "CANCELED"'],
    ["const requestFor = ", "const askView = ", 'status: "EXPIRED"'],
  ]) {
    const body = r.slice(r.indexOf(from), r.indexOf(to));
    assert.ok(body.indexOf("relaying.has(r.id)") > 0 && body.indexOf("relaying.has(r.id)") < body.indexOf(write), from);
  }
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

await t("a recovery that finishes closes the account's other requests, so none is left signable", async () => {
  // Its own account: binding the recovered passkey changes the owner.
  const safe = `0x${"d".repeat(40)}` as `0x${string}`;
  store.addUser({ ...structuredClone(user()), id: "u-fin", email: "fin@example.com", address: safe, passkeySafe: { ...structuredClone(user().passkeySafe!), address: safe } } as any);
  const { generateKeyPairSync } = await import("node:crypto");
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const base = {
    userId: "u-fin", safeAddress: safe, mode: "zoldenburg" as const, requestedAt: at(1).toISOString(),
    expiresAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(), recoveryDelayHours: 72,
    guardianAddress: process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS as `0x${string}`, recoveryModuleAddress: `0x${"4".repeat(40)}` as `0x${string}`,
    factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" } as any,
  };
  // The state Safe Cover leaves: the owners already changed, the sibling never saw a grace period here.
  store.addRecoveryRequest({ ...base, id: "fin-done", status: "GRACE_PERIOD", zoldenburg: {
    accessHash: "00", reference: "FIN00-00001", newOwners: [`0x${"e".repeat(40)}`], newThreshold: 1, finalizeAfter: at(0).toISOString(),
    newPasskey: { credentialId: "cred-fin", publicKey: { alg: "ES256", jwk } as any, signCount: 0, rpId: "localhost", attestation: "x", createdAt: at(1).toISOString() },
  } } as any);
  store.addRecoveryRequest({ ...base, id: "fin-other", status: "REVIEW_PENDING", zoldenburg: { accessHash: "00", reference: "FIN00-00002", newOwners: [`0x${"f".repeat(40)}`], newThreshold: 1 } } as any);
  store.addRecoveryRequest({ ...base, id: "fin-new", status: "PASSKEY_PENDING", zoldenburg: { accessHash: "00", reference: "FIN00-00003" } } as any);
  const { relayFinalize } = zoldenburgChain;
  zoldenburgChain.relayFinalize = async () => ({ txHash: `0x${"1".repeat(64)}` as `0x${string}` });
  try {
    assert.equal((await finalizeZoldenburgRecovery(req("fin-done"))).status, "FINALIZED");
  } finally {
    zoldenburgChain.relayFinalize = relayFinalize;
  }
  for (const id of ["fin-other", "fin-new"]) {
    assert.equal(req(id).status, "CANCELED", id);
    assert.equal(req(id).cancelReason, "another recovery for this account was signed");
  }
});

if (failed) { console.error(`ZOLDENBURG RECOVERY 1 € TEST FAILED — ${failed}`); process.exit(1); }
console.log("ZOLDENBURG RECOVERY 1 € TEST PASSED");
process.exit(0);
