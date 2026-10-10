/**
 * Phase 1 enrolment (recovery/zoldenburg-enrolment.ts): the 1 € from the
 * user's own bank that arms Zoldenburg as guardian.
 *
 * Checks: the name match (married names, middle names, transliterations,
 * order); the code (format, found in a memo however it is spaced, a wrong code
 * is not); the IBAN HMAC (keyed, normalised); which orders count; every
 * refusal (under 1 €, from the Zold IBAN, no payer IBAN or name, wrong name);
 * fail closed on an unreadable Monerium; what is stored (no IBAN, no name);
 * a failed re-enrolment keeps the account armed; a new key disarms; the
 * routes (session, guardian, IBAN, step-up, auth bucket); the operator gate
 * in the source; and nothing of it in the public projection.
 *
 * No chain, no Monerium. Run: npm run enrolment:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-enrol-")), "db.json");
process.env.RECOVERY_IBAN_HMAC_KEY = "k".repeat(40);
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = `0x${"9".repeat(40)}`;

const express = (await import("express")).default;
const { store } = await import("../services/api/src/store.js");
const { RECOVERY } = await import("../services/api/src/config.js");
const { namesMatch } = await import("../services/api/src/domain/name-match.js");
const E = await import("../services/api/src/recovery/zoldenburg-enrolment.js");
const { createZoldenburgEnrolmentRouter } = await import("../services/api/src/routes/recovery-zoldenburg-enrolment.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
type Reads = import("../services/api/src/recovery/zoldenburg-enrolment.js").EnrolmentReads;

let failed = 0;
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e: any) { failed++; console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
};
/** Swap the HMAC key for the length of fn. */
const withKey = async (key: string, fn: () => unknown) => {
  const before = RECOVERY.ibanHmacKey;
  (RECOVERY as any).ibanHmacKey = key;
  try { await fn(); } finally { (RECOVERY as any).ibanHmacKey = before; }
};
console.log("zoldenburg enrolment");

// ---- name match ------------------------------------------------------------

await t("names: the same person in a bank's spelling matches", () => {
  for (const [monerium, other] of [
    ["Anna Müller", "ANNA MUELLER"],
    ["Anna Müller", "Anna Muller"],
    ["Anna Müller", "Müller, Anna"],
    ["Anna Maria Schmidt", "Anna Schmidt"],
    ["Anna-Lena O'Brien", "ANNA LENA O BRIEN"],
    ["Jürgen Groß", "Juergen Gross"],
    ["José Álvarez", "Jose Alvarez"],
    ["Søren Kierkegaard", "Soren Kierkegaard"],
  ] as const) assert.ok(namesMatch(monerium, other), `${monerium} ~ ${other}`);
});

await t("names: split first/last, every last-name token and the first first name", () => {
  assert.ok(namesMatch("Anna Maria Meyer-Schmidt", { firstName: "Anna Maria", lastName: "Meyer-Schmidt" }));
  assert.ok(namesMatch("Anna Maria Meyer Schmidt", { firstName: "Anna", lastName: "Meyer Schmidt" }));
  assert.ok(!namesMatch("Anna Schmidt", { firstName: "Anna", lastName: "Meyer-Schmidt" }), "a married name the profile lacks");
  assert.ok(!namesMatch("Anna Schmidt", { firstName: "Maria", lastName: "Schmidt" }));
});

await t("names: anything else is a mismatch", () => {
  for (const [monerium, other] of [
    ["Anna Schmidt", "Peter Schmidt"],
    ["Anna Schmidt", "Anna Meyer"],
    ["Anna Schmidt", "Schmidt GmbH"],
    ["Anna Schmidt", "Annabelle Schmidt"],
    ["Anna Schmidt", "Anna und Peter Schmidt"],
    ["Anna Schmidt", "Anna Schmidt & Peter Meyer"],
    ["Hans Mueller", "Hans Mueller Bau GmbH"],
    ["Hans Mueller", "MUELLER HANS OR SCHMIDT ANNA"],
    ["Cher", "Cher Smith"],
    ["Anna Schmidt", ""],
    ["", "Anna Schmidt"],
  ] as const) assert.ok(!namesMatch(monerium, other), `${monerium} !~ ${other}`);
  assert.ok(!namesMatch(undefined, "Anna"));
  assert.ok(!namesMatch("Anna Schmidt", { firstName: "Anna" }));
});

// ---- code and HMAC ---------------------------------------------------------

await t("a code is 8 Crockford characters, shown as XXXX-XXXX, stored only as a hash", () => {
  const { code, hash } = E.newEnrolmentCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(!hash.toUpperCase().includes(code.replace("-", "")));
  assert.notEqual(E.newEnrolmentCode().code, code);
});

await t("the code is found in a memo however it is written, and a wrong one is not", () => {
  const { code, hash } = E.newEnrolmentCode();
  const raw = code.replace("-", "");
  for (const memo of [E.memoFor(code), raw, raw.toLowerCase(), `Zold ${raw.slice(0, 4)} ${raw.slice(4)} danke`, code.replace(/0/g, "O").replace(/1/g, "l")]) {
    assert.ok(E.memoCarriesCode(memo, hash), memo);
  }
  assert.ok(!E.memoCarriesCode(E.memoFor(E.newEnrolmentCode().code), hash));
  assert.ok(!E.memoCarriesCode(raw.slice(0, 7), hash));
  assert.ok(!E.memoCarriesCode(undefined, hash));
});

await t("the HMAC is keyed and ignores spacing and case; the key id changes with the key", async () => {
  const a = E.bankAccountHmac("DE89 3704 0044 0532 0130 00");
  assert.equal(a, E.bankAccountHmac("de89370400440532013000"));
  assert.notEqual(a, E.bankAccountHmac("DE89370400440532013001"));
  const id = E.ibanKeyId();
  await withKey("m".repeat(40), () => {
    assert.notEqual(E.bankAccountHmac("DE89370400440532013000"), a);
    assert.notEqual(E.ibanKeyId(), id);
  });
});

// ---- orders ----------------------------------------------------------------

const SAFE = `0x${"a".repeat(40)}` as const;
const ZOLD_IBAN = "IS00 0159 2600 7654 5510 7303 39";
const BANK = "DE89370400440532013000";
const NEW_BANK = "FR0030006000011234567890189";
const T0 = new Date("2026-10-10T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
store.addUser({
  id: "u1", name: "Anna Müller", email: "anna@example.com", country: "DE", kycStatus: "approved", iban: ZOLD_IBAN,
  address: SAFE, createdAt: T0.toISOString(), monerium: { profileId: "p1" },
  passkeySafe: { address: SAFE, status: "active", threshold: 1, passkeyPublicKey: { x: "1", y: "2" }, createdAt: T0.toISOString(),
    recovery: { moduleAddress: `0x${"4".repeat(40)}`, guardianAddress: process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS as `0x${string}`, threshold: 1, status: "active" } },
  passkey: { credentialId: "cred-u1", publicKey: { kty: "EC" } },
} as any);
const user = () => store.findUser("u1")!;

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

open = E.issueEnrolmentCode(user(), T0);

await t("only processed EURe issues to this Safe, after the code, carrying it, are candidates", () => {
  const good = order();
  const cands = E.candidateOrders([
    good,
    order({ kind: "redeem" }),
    order({ address: `0x${"b".repeat(40)}` }),
    order({ currency: "usd" }),
    order({ meta: { state: "pending", processedAt: at(10).toISOString() } }),
    order(paidAt(-10)),
    order({ memo: "ZOLD AAAA-BBBB" }),
  ] as any, user());
  assert.deepEqual(cands.map((o) => o.id), [good.id]);
});

await t("refusals: under 1 €, from the Zold IBAN, no payer IBAN, no payer name, another person", () => {
  const j = (o: any) => E.judgeEnrolmentOrder(o, user(), "Anna Müller") as any;
  assert.match(j(order({ amount: "0.99" })).reason, /under 1 €/);
  assert.match(j(order({ counterpart: { details: { name: "Anna Müller" }, identifier: { iban: ZOLD_IBAN.replace(/ /g, "") } } })).reason, /Zold IBAN/);
  assert.match(j(order({ counterpart: { details: { name: "Anna Müller" } } })).reason, /which account/);
  assert.match(j(order({ counterpart: { identifier: { iban: BANK } } })).reason, /payer's name/);
  assert.match(j(order({ counterpart: { details: { firstName: "Peter", lastName: "Müller" }, identifier: { iban: BANK } } })).reason, /does not match/);
  assert.deepEqual(j(order({ amount: "5.00" })), { ok: true, iban: BANK });
});

await t("fail closed: unreadable orders or profile name leave the code open and store nothing", async () => {
  assert.equal(await E.checkEnrolment("u1", reads(new Error("401")), at(20)), "unreadable");
  assert.equal(await E.checkEnrolment("u1", reads([order()], new Error("down")), at(20)), "unreadable");
  assert.equal(await E.checkEnrolment("u1", reads([order()], null), at(20)), "unreadable");
  assert.equal(user().zoldenburgEnrolment?.bankAccountHmac, undefined);
  assert.equal(E.zoldenburgArmed(user()), false);
  assert.equal(user().zoldenburgEnrolment?.lastCheck?.outcome, "unreadable");
});

await t("no payment yet: waiting; a mismatch: the reason, and still not armed", async () => {
  assert.equal(await E.checkEnrolment("u1", reads([]), at(20)), "waiting");
  assert.equal(await E.checkEnrolment("u1", reads([order({ counterpart: { details: { name: "Peter Schmidt" }, identifier: { iban: BANK } } })]), at(21)), "mismatch");
  assert.match(user().zoldenburgEnrolment!.lastCheck!.reason, /does not match/);
  assert.ok(!JSON.stringify(user().zoldenburgEnrolment).includes("Peter"), "no payer name stored");
  assert.equal(E.zoldenburgArmed(user()), false);
});

let firstOrder = "";
await t("the right payment arms: HMAC, last 4, order id; no IBAN, no name; the code is spent", async () => {
  const o = order();
  firstOrder = o.id;
  // A wrong payment beside the right one does not block it.
  assert.equal(await E.checkEnrolment("u1", reads([order({ amount: "0.5" }), o]), at(22)), "enrolled");
  const e = user().zoldenburgEnrolment!;
  assert.equal(e.bankAccountHmac, E.bankAccountHmac(BANK));
  assert.equal(e.bankAccountLast4, "3000");
  assert.equal(e.orderId, o.id);
  assert.equal(e.code, undefined);
  assert.equal(e.lastCheck, undefined);
  const row = JSON.stringify(e);
  for (const s of [BANK, "MUELLER", "Müller", "Anna"]) assert.ok(!row.includes(s), `no ${s}`);
  assert.ok(E.zoldenburgArmed(user()));
  assert.equal(await E.checkEnrolment("u1", reads([o]), at(23)), "no_code");
});

await t("a failed re-enrolment keeps the account armed on the old account", async () => {
  open = E.issueEnrolmentCode(user(), at(30));
  assert.equal(await E.checkEnrolment("u1", reads([order({ ...paidAt(40), counterpart: { details: { name: "Someone Else" }, identifier: { iban: NEW_BANK } } })]), at(41)), "mismatch");
  assert.ok(E.zoldenburgArmed(user()));
  assert.equal(user().zoldenburgEnrolment!.orderId, firstOrder);
  assert.equal(await E.checkEnrolment("u1", reads([order({ ...paidAt(42), counterpart: { details: { name: "Anna Müller" }, identifier: { iban: NEW_BANK } } })]), at(43)), "enrolled");
  assert.equal(user().zoldenburgEnrolment!.bankAccountHmac, E.bankAccountHmac(NEW_BANK));
  assert.equal(user().zoldenburgEnrolment!.bankAccountLast4, "0189");
});

await t("an expired code is not checked; a new HMAC key disarms until the user enrols again", async () => {
  open = E.issueEnrolmentCode(user(), at(50));
  assert.equal(await E.checkEnrolment("u1", reads([order(paidAt(51))]), new Date(at(50).getTime() + E.ENROLMENT.codeTtlMs)), "no_code");
  await withKey("n".repeat(40), () => assert.equal(E.zoldenburgArmed(user()), false));
  assert.ok(E.zoldenburgArmed(user()));
});

await t("the sweep checks open codes only, and does nothing with no key", async () => {
  open = E.issueEnrolmentCode(user(), at(60));
  let asked = 0;
  const counting: Reads = { orders: async () => { asked++; return []; }, profileName: async () => "Anna Müller" };
  await E.sweepEnrolments(counting, at(61));
  assert.equal(asked, 1);
  await withKey("", async () => assert.equal(await E.sweepEnrolments(counting, at(62)), 0));
  assert.equal(asked, 1);
});

await t("armed only while the guardian is active on the Safe", () => {
  const safe = structuredClone(user().passkeySafe!);
  store.updateUser("u1", { passkeySafe: { ...safe, recovery: { ...safe.recovery!, status: "planned" } } });
  assert.equal(E.zoldenburgArmed(user()), false);
  store.updateUser("u1", { passkeySafe: safe });
  assert.ok(E.zoldenburgArmed(user()));
});

await t("the owner's view names the account by its last 4 only; the public user carries none of it", () => {
  const v: any = E.enrolmentView(user(), at(63));
  assert.equal(v.armed, true);
  assert.equal(v.bankAccountLast4, "0189");
  assert.ok(v.codeIssuedAt);
  assert.ok(!/hash|hmac/i.test(JSON.stringify(v)));
  assert.ok(!("zoldenburgEnrolment" in publicUser(user())));
});

// ---- routes ----------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api", createZoldenburgEnrolmentRouter({
  requireUserSession: (req: any, res: any, userId: string) => {
    if (req.headers["x-test-user"] !== userId) { res.status(401).json({ error: "no session" }); return undefined; }
    return { userId };
  },
}));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/users`;
const call = async (p: string, body?: any, who = "u1") => {
  const res = await fetch(base + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-test-user": who }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

await t("routes: a session for this account is required", async () => {
  assert.equal((await call("/u1/recovery/zoldenburg/enrolment", undefined, "other")).status, 401);
  assert.equal((await call("/u1/recovery/zoldenburg/enrolment", {}, "other")).status, 401);
});

await t("routes: a new code needs a fresh passkey approval, every time", async () => {
  const r = await call("/u1/recovery/zoldenburg/enrolment", {});
  assert.equal(r.status, 401);
  assert.equal(r.data.code, "STEP_UP_REQUIRED");
});

await t("routes: no guardian, no active IBAN, or no key on the server: refused before the passkey", async () => {
  const u = structuredClone(user());
  store.updateUser("u1", { iban: undefined });
  assert.equal((await call("/u1/recovery/zoldenburg/enrolment", {})).data.code, "IBAN_NOT_ACTIVE");
  store.updateUser("u1", { iban: u.iban, passkeySafe: { ...u.passkeySafe!, recovery: undefined } });
  assert.equal((await call("/u1/recovery/zoldenburg/enrolment", {})).data.code, "NO_GUARDIAN");
  store.updateUser("u1", { passkeySafe: u.passkeySafe });
  await withKey("", async () => {
    const off = await call("/u1/recovery/zoldenburg/enrolment", {});
    assert.equal(off.status, 503);
    assert.equal(off.data.code, "ENROLMENT_UNAVAILABLE");
  });
});

await t("routes: GET and check return the view, and never the code or the HMAC", async () => {
  const g = await call("/u1/recovery/zoldenburg/enrolment");
  assert.equal(g.status, 200);
  assert.equal(g.data.armed, true);
  const c = await call("/u1/recovery/zoldenburg/enrolment/check", {});
  assert.equal(c.status, 200);
  const text = JSON.stringify([g.data, c.data]);
  assert.ok(!text.includes(user().zoldenburgEnrolment!.bankAccountHmac!));
  assert.ok(!/hash|hmac/i.test(text));
});
server.close();

// ---- source checks ---------------------------------------------------------

const src = (p: string) => readFileSync(new URL(`../services/api/src/${p}`, import.meta.url), "utf8");

await t("the enrolment routes sit on the auth rate bucket", () => {
  assert.ok(src("http/policy.ts").includes("recovery\\/zoldenburg\\/enrolment"));
});

await t("the operator cannot sign for an account that is not armed", () => {
  const r = src("routes/recovery-zoldenburg.ts");
  const between = (a: string, b: string) => r.slice(r.indexOf(a), r.indexOf(b));
  for (const [route, next] of [['"/admin/recoveries/:id/sign-request"', '"/admin/recoveries/:id/execute"'], ['"/admin/recoveries/:id/execute"', '"/admin/recoveries/:id/sync"']]) {
    const body = between(route, next);
    assert.ok(body.includes("if (!armedFor(r)) return res.status(409).json(NOT_ARMED)"), `${route} checks the enrolment`);
    assert.ok(body.indexOf("armedFor(r)") < body.indexOf("typedDataFor(r)"), `${route} checks before it hands out or relays anything`);
  }
  assert.match(r, /safeCoverLink:\s*\n\s*user && zoldenburgArmed\(user\)/, "no Safe Cover link before arming");
  const sync = between('"/admin/recoveries/:id/sync"', '"/admin/recoveries/:id/finalize"');
  assert.ok(sync.indexOf("!armedFor(r)") > 0 && sync.indexOf("!armedFor(r)") < sync.indexOf("syncZoldenburgFromChain"), "sync records no review for an unarmed account");
  assert.equal(r.match(/zoldenburgEnrolment: undefined/g)?.length, 3, "adding or removing the guardian drops the enrolled account");
});

if (failed) { console.error(`ZOLDENBURG ENROLMENT TEST FAILED — ${failed}`); process.exit(1); }
console.log("ZOLDENBURG ENROLMENT TEST PASSED");
process.exit(0);
