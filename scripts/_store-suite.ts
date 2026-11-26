/**
 * One suite for every store backend (services/api/src/store/backend.ts): the
 * same calls and the same expectations on the JSON backend, on PGlite
 * (store-backend-test.ts, offline) and on Postgres 17 (store-pg-test.ts).
 * A backend passes when it behaves as store.ts does today.
 *
 * Run on an empty store. Rows are compared as JSON, since the JSON backend
 * hands out live rows and Postgres hands out parsed copies.
 */
import assert from "node:assert/strict";
import type { StoreBackend } from "../services/api/src/store/backend.js";
import type { Sql } from "../services/api/src/store/pg/sql.js";
import { DEFAULT_CHART, DEFAULT_RULES } from "../services/api/src/domain/coa.js";
import { auditEntry } from "../services/api/src/audit.js";

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const hash = (b: string) => `0x${b.repeat(32)}`;

export async function storeSuite(s: StoreBackend): Promise<void> {
  const now = iso(0);

  // ── Users ────────────────────────────────────────────────────────────────
  const userA = {
    id: "u_a", name: "Ada", email: " Ada@Example.com ", country: "DE", address: `0x${"aa".repeat(20)}`,
    iban: "DE89 3704 0044 0532 0130 00", kycStatus: "approved", createdAt: now,
    passkey: { credentialId: "cred-a", publicKey: "pk", signCount: 1 },
    passkeySafe: { address: `0x${"ab".repeat(20)}`, status: "active" },
    paymentPage: { handle: "ada" },
  } as any;
  await s.addUser(userA);
  await s.addUser({ id: "u_b", name: "Bo", email: "ada@example.com", address: `0x${"bb".repeat(20)}`, iban: "", createdAt: now, emailVerifiedAt: now } as any);
  assert.equal((await s.findUser("u_a"))?.name, "Ada");
  assert.equal(await s.findUser("nobody"), undefined);
  assert.equal((await s.findUserByAddress(`0x${"AA".repeat(20)}`))?.id, "u_a", "address match ignores case");
  assert.equal((await s.findUserByCredential("cred-a"))?.id, "u_a");
  assert.deepEqual((await s.usersByEmail("ADA@example.com ")).map((u) => u.id), ["u_a", "u_b"], "email match trims and ignores case, in stored order");
  assert.deepEqual(await s.usersByEmail("  "), []);
  assert.equal((await s.findUserByEmail("ada@example.com"))?.id, "u_b", "a confirmed address is preferred");
  assert.equal((await s.findUserBySafeAddress(` 0x${"AB".repeat(20)} `))?.id, "u_a", "found by its passkey Safe");
  assert.equal((await s.findUserByHandle(" ADA "))?.id, "u_a");
  assert.equal((await s.findUserByIban("de89370400440532013000"))?.id, "u_a", "IBAN match ignores spaces and case");

  // An org account backed by u_a follows u_a's IBAN; a gated one without an IBAN does not.
  await s.addOrganisation({ id: "org_a", type: "personal", name: "Ada", createdAt: now, updatedAt: now } as any);
  await s.addAccount({ id: "acc_eur", orgId: "org_a", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: { iban: "DE89370400440532013000" }, backingUserId: "u_a", createdAt: now, updatedAt: now } as any);
  await s.addAccount({ id: "acc_gated", orgId: "org_a", currency: "EUR", label: "EUR 2", status: "gated", provider: "monerium", identifier: {}, backingUserId: "u_a", address: `0x${"AA".repeat(20)}`, createdAt: now, updatedAt: now } as any);
  const moved = await s.updateUser("u_a", { iban: "DE02 1203 0000 0000 2020 51" });
  assert.ok(moved.ibanSince, "a new IBAN gets its date");
  assert.equal((await s.findAccount("acc_eur"))?.identifier.iban, "DE02120300000000202051", "the backed account follows, bare");
  assert.deepEqual((await s.findAccount("acc_gated"))?.identifier, {}, "a gated account without an IBAN does not follow");
  await assert.rejects(async () => await s.updateUser("nobody", { name: "x" }), /unknown user nobody/);

  assert.equal((await s.recordPasskeyUse("u_a", "cred-a", 7))?.passkey?.signCount, 7);
  assert.equal(await s.recordPasskeyUse("u_a", "cred-old", 8), undefined, "a replaced credential records nothing");
  assert.equal((await s.findUser("u_a"))?.passkey?.signCount, 7);
  assert.equal(await s.recordPasskeyUse("u_a", "cred-a", 7), undefined, "a count that does not advance records nothing");
  assert.equal(await s.recordPasskeyUse("u_a", "cred-a", 3), undefined, "nor one that went back");
  assert.equal((await s.recordPasskeyUse("u_a", "cred-a", 9))?.passkey?.signCount, 9);
  assert.equal((await s.findUser("u_a"))?.passkey?.signCount, 9);

  await s.setSegment("u_a", { value: "consumer", reason: "test" } as any);
  await assert.rejects(async () => await s.setSegment("u_a", { value: "business" } as any), /already has segment/);
  assert.equal((await s.setSegment("u_a", { value: "business" } as any, "admin")).segment?.decidedBy, "admin");
  // An UNDECIDED account is decided once, later, by the system; then it is set.
  await s.setSegment("u_b", { value: "UNDECIDED", reasonCode: "residence_not_given" } as any);
  assert.equal((await s.setSegment("u_b", { value: "EU_FULL", reasonCode: "test" } as any)).segment?.value, "EU_FULL");
  await assert.rejects(async () => await s.setSegment("u_b", { value: "UNDECIDED" } as any), /already has segment/);
  await s.addConsent("u_a", { kind: "terms", at: now } as any);
  await s.addConsent("u_a", { kind: "privacy", at: now } as any);
  assert.equal((await s.findUser("u_a"))?.consents?.length, 2, "consents are appended");
  assert.equal((await s.addUsAnswers("u_a", { at: now } as any)).usPersonAnswers?.length, 1);

  // ── Organisations, members, chart ────────────────────────────────────────
  assert.equal((await s.chartOf("org_a")).length, DEFAULT_CHART.length, "a new org gets the default chart");
  assert.equal((await s.rulesOf("org_a")).length, DEFAULT_RULES.length);
  await s.seedChartOfAccounts("org_a");
  assert.equal((await s.chartOf("org_a")).length, DEFAULT_CHART.length, "seeding twice adds nothing");
  await s.addOrganisation({ id: "org_b", type: "business", name: "B GmbH", createdAt: now, updatedAt: now, paymentPage: { handle: "bshop" } } as any, false);
  assert.equal((await s.chartOf("org_b")).length, 0, "seedCoa false seeds nothing");
  assert.equal((await s.findOrgByHandle("BSHOP"))?.id, "org_b");
  await assert.rejects(async () => await s.updateOrganisation("org_b", { safe: {} } as any), /setOrgSafePlan only/);
  assert.equal((await s.updateOrganisation("org_b", { name: "B AG" })).name, "B AG");
  await assert.rejects(async () => await s.setOrgSafePlan("org_a", {} as any), /not a company/);
  await assert.rejects(async () => await s.setOrgSafePlan("nobody", {} as any), /unknown organisation/);
  await assert.rejects(async () => await s.replaceUndeployedOrgSafePlan("org_b", `0x${"00".repeat(20)}`, {} as any), /no planned Safe/);

  await s.addMember({ id: "mem_old", orgId: "org_b", userId: "u_a", email: "a@x", role: "member", status: "deactivated", invitedAt: now } as any);
  await s.addMember({ id: "mem_a", orgId: "org_b", userId: "u_a", email: "a@x", role: "owner", status: "active", invitedAt: now, invite: { tokenHash: "inv-1" } } as any);
  await s.addMember({ id: "mem_pa", orgId: "org_a", userId: "u_a", email: "a@x", role: "owner", status: "active", invitedAt: now } as any);
  assert.equal((await s.memberFor("org_b", "u_a"))?.id, "mem_a", "the live membership, not the deactivated one");
  assert.equal((await s.findMemberByInviteHash("inv-1"))?.id, "mem_a");
  assert.deepEqual((await s.membersOf("org_b")).map((m) => m.id), ["mem_old", "mem_a"]);
  assert.deepEqual((await s.organisationsForUser("u_a")).map((x) => [x.member.id, x.org.id]), [["mem_a", "org_b"], ["mem_pa", "org_a"]]);
  assert.equal((await s.updateMember("mem_a", { role: "admin" } as any)).role, "admin");
  assert.equal((await s.findMember("mem_a"))?.role, "admin");

  // ── Accounts ─────────────────────────────────────────────────────────────
  assert.deepEqual((await s.accountsOf("org_a")).map((a) => a.id), ["acc_eur", "acc_gated"]);
  assert.deepEqual((await s.accountsAtAddress(`0x${"aa".repeat(20)}`)).map((a) => a.id), ["acc_gated"]);
  const companySafe = `0x${"cC".repeat(20)}`;
  const twin = (id: string, orgId: string, over: Record<string, unknown> = {}) =>
    ({ id, orgId, currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, address: companySafe, createdAt: now, updatedAt: now, ...over }) as any;
  assert.ok(await s.addAccount(twin("acc_co", "org_b")));
  assert.equal(await s.addAccount(twin("acc_twin", "org_c", { address: companySafe.toLowerCase() })), null, "a company Safe is one account");
  assert.equal(await s.findAccount("acc_twin"), undefined);
  assert.ok(await s.addAccount(twin("acc_aa_business", "org_b", { address: `0x${"aa".repeat(20)}`, backingUserId: "u_a" })), "a person's Safe backs their personal and their business account");
  const acc = await s.updateAccount("acc_eur", { label: "Main" });
  assert.equal(acc.label, "Main");
  assert.notEqual(acc.updatedAt, now, "updateAccount stamps updatedAt");

  // ── Quotes ───────────────────────────────────────────────────────────────
  await s.addQuote({ id: "q_stale", userId: "u_a", status: "OPEN", expiresAt: iso(-2 * DAY) } as any);
  await s.addQuote({ id: "q_kept", userId: "u_a", status: "CONSUMED", expiresAt: iso(-2 * DAY) } as any);
  await s.addQuote({ id: "q_1", userId: "u_a", status: "OPEN", expiresAt: iso(60_000) } as any);
  assert.equal(await s.findQuote("q_stale"), undefined, "an untaken quote a day past expiry is dropped");
  assert.ok(await s.findQuote("q_kept"), "a consumed quote stays");
  assert.equal(await s.consumeQuote("q_1"), true);
  assert.equal(await s.consumeQuote("q_1"), false, "a quote is consumed once");
  await assert.rejects(async () => await s.consumeQuote("nobody"), /unknown quote/);
  await s.addQuote({ id: "q_late", userId: "u_a", status: "OPEN", expiresAt: iso(-1_000) } as any);
  assert.equal(await s.consumeQuote("q_late"), false, "a quote past expiresAt but still OPEN is not consumed");
  assert.equal(await s.expireQuote("q_late"), true);
  assert.equal((await s.findQuote("q_late"))?.status, "EXPIRED");
  assert.equal(await s.expireQuote("q_1"), false, "a consumed quote is never marked expired");
  assert.equal((await s.findQuote("q_1"))?.status, "CONSUMED");
  assert.equal((await s.updateQuote("q_1", { rate: 2 } as any) as any).rate, 2);

  // ── Transfers ────────────────────────────────────────────────────────────
  const seen: string[] = [];
  s.onTransferStateChange((t, from) => { seen.push(`${t.id}:${from}->${t.state}`); });
  const transfer = (id: string, state: string, extra: object = {}) =>
    ({ id, userId: "u_a", quoteId: `q-${id}`, rail: "sepa", state, sendEur: 10, txs: [], createdAt: now, updatedAt: now, ...extra }) as any;
  await s.addTransfer(transfer("t_1", "CREATED", { auth: { challenge: "c" } }));
  assert.equal(await s.claimAuthorization("t_1"), true);
  assert.equal(await s.claimAuthorization("t_1"), false, "one authorization claim");
  assert.equal(await s.claimAuthorization("nobody"), false);
  await s.updateTransfer("t_1", { state: "PAID" });
  const late = await s.updateTransfer("t_1", { state: "FAILED", error: "late leg" });
  assert.equal(late.state, "PAID", "PAID is final");
  assert.equal(late.error, "late leg", "the late write keeps its other fields");
  assert.deepEqual(seen, ["t_1:CREATED->PAID"], "one state change announced, after it was written");
  await assert.rejects(async () => await s.updateTransfer("nobody", {}), /unknown transfer/);

  // A review resolves once, and a refund tx another record holds is refused.
  await s.addTransfer(transfer("t_other", "PAID", { txs: [{ step: "x", hash: hash("cd") }] }));
  await s.addTransfer(transfer("t_rev", "MANUAL_REVIEW", { error: "unknown outcome" }));
  const review = (evidence: string) => ({ state: "REFUNDED" as const, note: "Refunded by hand after checking the chain.", by: "op_1", evidence, refund: { amountEur: 10, movedEur: 10 } });
  await assert.rejects(async () => await s.resolveTransferReview("t_rev", { ...review(hash("ef")), note: "short" }), /note of/);
  assert.deepEqual(await s.resolveTransferReview("nobody", review(hash("ef"))), { ok: false, code: "NOT_FOUND" });
  assert.deepEqual(await s.resolveTransferReview("t_1", review(hash("ef"))), { ok: false, code: "NOT_IN_REVIEW" });
  assert.deepEqual(await s.resolveTransferReview("t_rev", review(hash("CD"))), { ok: false, code: "EVIDENCE_ON_RECORD", recordedOn: "transfer t_other" });
  const resolved = await s.resolveTransferReview("t_rev", review(hash("ef")));
  assert.ok(resolved.ok);
  assert.equal(resolved.transfer.state, "REFUNDED");
  assert.equal(resolved.transfer.reviewResolution?.previousError, "unknown outcome");
  assert.equal(resolved.transfer.txs.at(-1)?.hash, hash("ef"), "the refund tx is booked on the transfer");
  assert.deepEqual(await s.resolveTransferReview("t_rev", review(hash("ef"))), { ok: false, code: "NOT_IN_REVIEW" }, "once");
  assert.equal((await s.findTransfer("t_rev"))?.state, "REFUNDED");
  assert.equal((await s.auditFor("u_a", 1))[0]?.kind, "operator.transfer_review_resolved", "audited");
  assert.deepEqual(seen.at(-1), "t_rev:MANUAL_REVIEW->REFUNDED");

  // ── Cap holds ────────────────────────────────────────────────────────────
  const hold = await s.holdDailyCap("u_a", 60, 100, () => 30);
  assert.ok(hold.ok);
  assert.deepEqual(await s.holdDailyCap("u_a", 20, 100, () => 90), { ok: false, usedEur: 90, capEur: 100 });
  assert.equal(await s.heldEurToday("u_a"), 60);
  await assert.rejects(async () => await s.addTransferUnderHold(transfer("t_nohold", "CREATED"), "nohold"), /no cap hold/);
  assert.equal(await s.findTransfer("t_nohold"), undefined);
  await s.addTransferUnderHold(transfer("t_held", "CREATED"), hold.holdId);
  assert.ok(await s.findTransfer("t_held"));
  assert.equal(await s.heldEurToday("u_a"), 0, "the hold became the transfer");
  // NaN passes `used + eur > cap`; a stored NaN hold would open the cap all day.
  for (const [eur, used, cap] of [[Number.NaN, 0, 100], [-1, 0, 100], [Infinity, 0, 100], [1, Number.NaN, 100], [1, 0, Number.NaN]]) {
    await assert.rejects(async () => await s.holdDailyCap("u_nan", eur, cap, () => used), /daily cap/, `refused: ${eur} ${used} ${cap}`);
  }
  assert.equal(await s.heldEurToday("u_nan"), 0, "a refused amount holds nothing");
  const hold2 = await s.holdDailyCap("u_a", 5, 100, () => 0);
  assert.ok(hold2.ok);
  await s.releaseCapHold(hold2.holdId);
  assert.equal(await s.heldEurToday("u_a"), 0);

  // ── Sessions ─────────────────────────────────────────────────────────────
  await s.addSession({ id: "s_dead", userId: "u_a", tokenHash: "th-dead", createdAt: iso(-3 * DAY), lastUsedAt: iso(-3 * DAY), expiresAt: iso(-2 * DAY) });
  await s.addSession({ id: "s_1", userId: "u_a", tokenHash: "th-1", createdAt: now, lastUsedAt: now, expiresAt: iso(DAY) });
  assert.equal(await s.findSessionByTokenHash("th-dead"), undefined, "a session dead for a day is pruned on the next add");
  assert.equal((await s.touchSession("s_1")).lastUsedAt, now, "touched within a minute: unchanged");
  await s.addSession({ id: "s_2", userId: "u_a", tokenHash: "th-2", createdAt: now, lastUsedAt: iso(-120_000), expiresAt: iso(DAY) });
  await s.touchSession("s_2");
  assert.ok(Date.parse((await s.findSessionByTokenHash("th-2"))!.lastUsedAt) > Date.now() - 60_000, "an idle session's touch is written");
  assert.ok((await s.revokeSession("s_1")).revokedAt);
  await assert.rejects(async () => await s.touchSession("nobody"), /unknown session/);

  // ── Operators ────────────────────────────────────────────────────────────
  const op = await s.addOperator({ id: "op_1", email: " Op@Zold.test ", name: "Op", credentials: [{ credentialId: "oc-1", publicKey: "pk", signCount: 0 }], createdAt: now } as any);
  assert.equal(op.email, "op@zold.test", "stored lowercase");
  await s.addOperator({ id: "op_2", email: "two@zold.test", name: "Two", credentials: [], createdAt: now } as any);
  await assert.rejects(async () => await s.addOperator({ id: "op_3", email: "two@zold.test", credentials: [] } as any), /exists/);
  assert.equal((await s.findOperatorByEmail("OP@zold.test"))?.id, "op_1");
  assert.equal((await s.findOperator("op_2"))?.name, "Two");
  await assert.rejects(async () => await s.addOperatorCredential("op_2", { credentialId: "oc-1" } as any), /already registered/, "one passkey, one operator");
  await s.addOperatorCredential("op_2", { credentialId: "oc-2", publicKey: "pk", signCount: 0 } as any);
  const found = await s.findOperatorCredential("oc-2");
  assert.equal(found?.operator.id, "op_2");
  assert.equal(found?.credential.credentialId, "oc-2");
  assert.equal(await s.findOperatorCredential("nope"), undefined);
  await s.recordOperatorCredentialUse("op_2", "oc-2", 5);
  assert.equal((await s.findOperatorCredential("oc-2"))?.credential.signCount, 5);
  await assert.rejects(async () => await s.recordOperatorCredentialUse("op_2", "nope", 1), /unknown operator credential/);
  await s.addOperatorSession({ id: "os_1", operatorId: "op_2", tokenHash: "oth-1", createdAt: now, lastUsedAt: now, expiresAt: iso(DAY) });
  assert.equal((await s.findOperatorSessionByTokenHash("oth-1"))?.id, "os_1");
  assert.equal((await s.touchOperatorSession("os_1")).lastUsedAt, now);
  const disabled = await s.disableOperator("op_2");
  assert.ok(disabled.disabledAt);
  assert.equal((await s.findOperatorSessionByTokenHash("oth-1"))?.revokedAt, disabled.disabledAt, "disabling revokes the sessions");
  assert.equal((await s.revokeOperatorSession("os_1")).revokedAt, disabled.disabledAt, "revoked once");

  // ── Service credentials and audit ────────────────────────────────────────
  await s.rotateServiceCredential({ id: "sc_1", service: "checkout", tokenHash: "h1", createdAt: now }, 0, "op_1");
  const until = await s.rotateServiceCredential({ id: "sc_2", service: "checkout", tokenHash: "h2", createdAt: now }, 60_000, "op_1");
  const creds = await s.serviceCredentials("checkout");
  assert.deepEqual(creds.map((c) => c.id), ["sc_1", "sc_2"]);
  assert.equal(creds[0].expiresAt, until, "the previous credential stops at the overlap's end");
  assert.equal(creds[1].expiresAt, undefined);
  await s.audit(auditEntry("segment.decided" as any, { n: 1 }, "u_b"));
  await s.audit(auditEntry("segment.decided" as any, { n: 2 }, "u_b"));
  assert.deepEqual((await s.auditFor("u_b")).map((e) => e.data.n), [2, 1], "newest first");
  assert.deepEqual((await s.auditFor("u_b", 1)).map((e) => e.data.n), [2]);
  assert.equal((await s.auditFor(undefined, 1))[0].data.n, 2);

  // ── Recovery requests, Safe ops ──────────────────────────────────────────
  await s.addRecoveryRequest({ id: "rr_1", userId: "u_a", mode: "zoldenburg", status: "GRACE_PERIOD", requestedAt: now } as any);
  assert.equal((await s.updateRecoveryRequest("rr_1", { status: "CANCELED" } as any)).status, "CANCELED");
  assert.equal((await s.findRecoveryRequest("rr_1"))?.status, "CANCELED");
  assert.deepEqual((await s.recoveryRequestsForUser("u_a")).map((r) => r.id), ["rr_1"]);
  await assert.rejects(async () => await s.updateRecoveryRequest("nobody", {}), /unknown recovery request/);

  const sig = (memberId: string, owner: string) => ({ memberId, ownerAddress: owner as `0x${string}`, signature: "0x", signedAt: iso(1) });
  await s.addSafeOp({ id: "so_1", orgId: "org_b", state: "PENDING", signatures: [], dropped: [], createdAt: now, updatedAt: now } as any);
  assert.ok(await s.addSafeOpSignature("so_1", sig("mem_a", `0x${"0A".repeat(20)}`) as any));
  assert.equal(await s.addSafeOpSignature("so_1", sig("mem_x", `0x${"0a".repeat(20)}`) as any), null, "one signature per owner address");
  assert.ok(await s.addSafeOpSignature("so_1", sig("mem_b", `0x${"0b".repeat(20)}`) as any));
  const dropped = await s.dropSafeOpSignatures("so_1", [`0x${"0B".repeat(20)}`], "left");
  assert.deepEqual(dropped?.signatures.map((x) => x.memberId), ["mem_a"]);
  assert.deepEqual(dropped?.dropped.map((x) => x.memberId), ["mem_b"]);
  assert.equal((await s.safeOpsOf("org_b")).length, 1);
  assert.ok(await s.claimSafeOpRelay("so_1"));
  assert.equal(await s.claimSafeOpRelay("so_1"), null, "one relay");
  assert.equal(await s.endPendingSafeOp("so_1", { state: "EXPIRED", reason: "late" }), null, "only a pending op ends");
  await assert.rejects(async () => await s.finishSafeOp("so_1", { state: "PENDING" } as any), /final state/);
  assert.equal((await s.finishSafeOp("so_1", { state: "EXECUTED", txHash: hash("12") } as any)).state, "EXECUTED");
  await assert.rejects(async () => await s.finishSafeOp("so_1", { state: "FAILED" } as any), /not relaying/);
  await s.addSafeOp({ id: "so_2", orgId: "org_b", state: "PENDING", signatures: [], dropped: [], createdAt: now, updatedAt: now } as any);
  assert.equal((await s.endPendingSafeOp("so_2", { state: "CANCELLED", reason: "owner" }))?.state, "CANCELLED");
  assert.equal((await s.findSafeOp("so_2"))?.reason, "owner");

  // ── Monerium ─────────────────────────────────────────────────────────────
  assert.equal(await s.markOrderProcessed("ord-2"), true);
  assert.equal(await s.markOrderProcessed("ord-1"), true);
  assert.equal(await s.markOrderProcessed("ord-2"), false, "an order is claimed once");
  assert.deepEqual(await s.mirroredOrderIds(), ["ord-2", "ord-1"], "once each, in order");
  assert.equal(await s.isOrderProcessed("ord-1"), true);
  assert.equal(await s.isOrderProcessed("ord-3"), false);
  assert.equal(await s.markWebhookProcessed("wh-1"), true);
  assert.equal(await s.markWebhookProcessed("wh-1"), false, "a delivery is marked once");
  assert.equal(await s.isWebhookProcessed("wh-1"), true);
  assert.equal(await s.isWebhookProcessed("wh-2"), false);
  const issue = { orderId: "ord-1", userId: "u_a", amountEur: 5, processedAt: now, recordedAt: now };
  assert.deepEqual(json(await s.recordMoneriumIssue(issue)), issue);
  assert.deepEqual(json(await s.recordMoneriumIssue({ ...issue, amountEur: 6 })), issue, "the first record stands");

  // ── Receipt shares and documents ─────────────────────────────────────────
  await s.addReceiptShare({ id: "rs_1", slug: "slug-1", transferId: "t_1", userId: "u_a", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: iso(DAY) });
  assert.ok((await s.revokeReceiptShare("rs_1")).revokedAt);
  await s.addReceiptShare({ id: "rs_2", slug: "slug-2", transferId: "t_1", userId: "u_a", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: iso(DAY) });
  assert.equal((await s.findReceiptShareByTransfer("t_1"))?.id, "rs_2", "the live share");
  assert.equal((await s.findReceiptShareBySlug("slug-1"))?.id, "rs_1");
  assert.equal((await s.updateReceiptShare("rs_2", { expiresAt: iso(2 * DAY) })).id, "rs_2");
  await s.addDocument({ id: "doc_1", code: "CODE1", kind: "receipt", userId: "u_a", orgId: "org_a", createdAt: now } as any);
  assert.equal((await s.findDocumentByCode("CODE1"))?.id, "doc_1");
  assert.ok((await s.updateDocument("doc_1", { revokedAt: now })).revokedAt);
  assert.equal((await s.documentsForUser("u_a")).length, 1);
  assert.equal((await s.documentsForOrg("org_a")).length, 1);

  // ── Payment requests ─────────────────────────────────────────────────────
  const prSeen: string[] = [];
  s.onPaymentRequestStateChange((r, from) => { prSeen.push(`${r.id}:${from}->${r.state}`); });
  await s.addPaymentRequest({ id: "pr_1", code: "ABCD1234", userId: "u_a", state: "OPEN", payments: [], cryptoQuotes: [], source: { kind: "shopify", externalId: "1001", shop: "a.myshopify.com" }, createdAt: now, updatedAt: now } as any);
  await s.addPaymentRequest({ id: "pr_2", code: "EFGH5678", userId: "u_a", state: "OPEN", payments: [], cryptoQuotes: [], source: { kind: "shopify", externalId: "1001", shop: "b.myshopify.com" }, createdAt: now, updatedAt: now } as any);
  assert.equal((await s.findPaymentRequestByCode("abcd-1234"))?.id, "pr_1");
  assert.equal((await s.findPaymentRequestBySource("shopify", "1001", "b.myshopify.com"))?.id, "pr_2", "the shop is part of the key");
  assert.equal(await s.findPaymentRequestBySource("shopify", "1001", "c.myshopify.com"), undefined);
  await s.updatePaymentRequest("pr_1", { state: "PAID" });
  await s.updatePaymentRequest("pr_1", { description: "x" } as any);
  assert.deepEqual(prSeen, ["pr_1:OPEN->PAID"]);
  assert.equal((await s.findPaymentRequest("pr_1"))?.state, "PAID");
  assert.equal((await s.paymentRequestsForUser("u_a")).length, 2);

  // ── Shopify and merchant links ───────────────────────────────────────────
  await s.addShopifyConnection({ id: "sh_1", orgId: "org_b", shop: "a.myshopify.com", payeeUserId: "u_a", accessTokenEnc: "enc", scope: "", installedByUserId: "u_a", installedAt: now, updatedAt: now });
  assert.equal((await s.findShopifyConnectionByShop(" A.myshopify.com "))?.id, "sh_1");
  assert.equal((await s.updateShopifyConnection("sh_1", { scope: "read" })).scope, "read");
  assert.equal((await s.shopifyConnectionsForOrg("org_b")).length, 1);
  await s.removeShopifyConnection("sh_1");
  assert.equal(await s.findShopifyConnectionByShop("a.myshopify.com"), undefined);
  await s.recordShopifyDelivery({ id: "d_old", shop: "a.myshopify.com", at: iso(-73 * 3_600_000), handled: true });
  await s.recordShopifyDelivery({ id: "d_1", shop: "a.myshopify.com", at: now, handled: false });
  assert.equal((await s.recordShopifyDelivery({ id: "d_1", shop: "b.myshopify.com", at: now, handled: false })).shop, "a.myshopify.com", "a second recording of one id returns the first, with its shop");
  assert.equal(await s.shopifyDelivery("d_old"), undefined, "deliveries past 72 hours are dropped");
  await s.markShopifyDeliveryHandled("d_1");
  assert.equal((await s.shopifyDelivery("d_1"))?.handled, true);

  await s.addMerchantLink({ id: "ml_1", orgId: "org_b", integration: "shopify", shop: "a.myshopify.com", payeeUserId: "u_a", linkSecretEnc: "e", createdBy: "u_a", createdAt: now, updatedAt: now });
  assert.equal((await s.activeMerchantLinkForShop("A.myshopify.com"))?.id, "ml_1");
  await s.updateMerchantLink("ml_1", { revokedAt: now });
  assert.equal(await s.activeMerchantLinkForShop("a.myshopify.com"), undefined, "a revoked link is not active");
  await s.addMerchantLink({ id: "ml_2", orgId: "org_b", integration: "shopify", shop: "a.myshopify.com", payeeUserId: "u_a", linkSecretEnc: "e", createdBy: "u_a", createdAt: now, updatedAt: now });
  assert.equal((await s.activeMerchantLinkForShop("a.myshopify.com"))?.id, "ml_2");
  assert.equal((await s.findMerchantLink("ml_1"))?.revokedAt, now);
  assert.deepEqual((await s.merchantLinksForOrg("org_b")).map((l) => l.id), ["ml_1", "ml_2"]);

  // ── Crypto deposits and sends ────────────────────────────────────────────
  const deposit = { id: "dep_1", userId: "u_a", chainId: 84532, token: "EURE", txHash: hash("Aa"), logIndex: 3, amountUnits: "1", holding: "none", txs: [], createdAt: now, updatedAt: now } as any;
  assert.equal((await s.addCryptoDeposit(deposit)).id, "dep_1");
  assert.equal((await s.addCryptoDeposit({ ...deposit, id: "dep_dup", txHash: hash("aA") })).id, "dep_1", "one row per (chainId, txHash, logIndex)");
  for (const logIndex of [undefined, Number.NaN, 1.5, -1]) {
    await assert.rejects(async () => await s.addCryptoDeposit({ ...deposit, id: "dep_bad_index", txHash: hash("bb"), logIndex }), /logIndex/, `refused logIndex ${logIndex}`);
  }
  assert.equal(await s.findCryptoDeposit(84532, hash("bb"), 3), undefined);
  assert.equal((await s.findCryptoDeposit(84532, hash("AA"), 3))?.id, "dep_1");
  assert.equal(await s.findCryptoDeposit(84532, hash("aa"), 4), undefined);
  assert.equal(await s.findCryptoDeposit(8453, hash("aa"), 3), undefined, "another chain's log is another deposit");
  assert.equal((await s.addCryptoDeposit({ ...deposit, id: "dep_other_chain", chainId: 8453 })).id, "dep_other_chain", "the same hash and index on another chain is its own row");
  assert.equal((await s.updateCryptoDeposit("dep_1", { holding: "held" } as any)).holding, "held");
  assert.equal(await s.cryptoDepositCursor(84532), undefined);
  await s.setCryptoDepositCursor(84532, 12_345_678_901_234_567_890n);
  await s.setCryptoDepositCursor("84532", 12_345_678_901_234_567_891n);
  assert.equal(await s.cryptoDepositCursor("84532"), 12_345_678_901_234_567_891n, "a bigint, upserted");

  const sendHold = await s.holdDailyCap("u_a", 1, 100, () => 0);
  assert.ok(sendHold.ok);
  const send = { id: "cs_1", userId: "u_a", to: `0x${"11".repeat(20)}`, token: "EURE", amount: "1", capEur: 1, state: "CREATED", deadline: Date.now() / 1000 + 600, createdAt: now, updatedAt: now } as any;
  await s.addCryptoSendUnderHold(send, sendHold.holdId);
  await s.addCryptoSendUnderHold({ ...send, id: "cs_late", deadline: Date.now() / 1000 - 1 }, (await s.holdDailyCap("u_a", 1, 100, () => 0) as any).holdId);
  assert.equal(await s.claimCryptoSend("cs_1"), true);
  assert.equal(await s.claimCryptoSend("cs_1"), false, "one submission");
  assert.equal(await s.claimCryptoSend("cs_late"), false, "not past its deadline");
  assert.equal((await s.updateCryptoSend("cs_1", { state: "SENT", txHash: hash("99") })).state, "SENT");
  assert.equal((await s.findCryptoSend("cs_1"))?.authorizedAt !== undefined, true);

  // ── Contacts, drafts, invoices, wallets ──────────────────────────────────
  await s.addContact({ id: "c_1", orgId: "org_b", name: "Payee", wallets: [], bankAccounts: [], createdAt: now, updatedAt: now });
  assert.equal((await s.updateContact("c_1", { name: "Payee 2" })).name, "Payee 2");
  assert.equal((await s.contactsOf("org_b")).length, 1);
  assert.equal(await s.removeContact("c_1"), true);
  assert.equal(await s.removeContact("c_1"), false);
  assert.equal(await s.findContact("c_1"), undefined);

  const draft = await s.addDraft({ id: "dr_1", orgId: "org_b", source: { kind: "account", accountId: "acc_eur" }, state: "DRAFT", lines: [], createdByMemberId: "mem_a", activity: [], createdAt: now, updatedAt: now } as any);
  assert.equal(await s.claimDraftExecution("dr_1"), null, "a DRAFT is not claimed under review policy");
  assert.equal(await s.claimDraftExecution("dr_1", ["DRAFT"], "2000-01-01T00:00:00.000Z"), null, "written since it was read");
  assert.equal((await s.claimDraftExecution("dr_1", ["DRAFT"], draft.updatedAt))?.state, "EXECUTING");
  assert.equal(await s.claimDraftExecution("dr_1", ["DRAFT", "REVIEWED"]), null, "one claim");
  assert.equal((await s.updateDraft("dr_1", { failureReason: "x" } as any)).failureReason, "x");
  assert.equal((await s.draftsOf("org_b")).length, 1);
  assert.equal((await s.findDraft("dr_1"))?.state, "EXECUTING");

  await s.addInvoice({ id: "inv_1", orgId: "org_b", linkTokenHash: "lth-1", state: "DRAFT", lines: [], currency: "EUR", total: "1.00", createdByMemberId: "mem_a", createdAt: now, updatedAt: now } as any);
  assert.equal((await s.findInvoiceByLinkHash("lth-1"))?.id, "inv_1");
  assert.equal((await s.updateInvoice("inv_1", { state: "SUBMITTED" } as any)).state, "SUBMITTED");
  assert.equal((await s.findInvoice("inv_1"))?.state, "SUBMITTED");
  assert.equal((await s.invoicesOf("org_b")).length, 1);

  await s.addImportedWallet({ id: "w_1", orgId: "org_b", address: `0x${"22".repeat(20)}`, chainId: 8453, label: "W", kind: "safe", custody: "external", sync: {}, createdAt: now } as any);
  assert.equal((await s.updateImportedWallet("w_1", { label: "W2" })).label, "W2");
  assert.equal((await s.importedWalletsOf("org_b")).length, 1);
  assert.equal(await s.removeImportedWallet("w_1"), true);
  assert.equal(await s.findImportedWallet("w_1"), undefined);

  // ── Chart, rules, ledger, sweeps ─────────────────────────────────────────
  await s.addChartAccount({ id: "coa_x", orgId: "org_b", code: "1800", name: "Bank", type: "asset", archived: false, createdAt: now } as any);
  assert.equal((await s.updateChartAccount("coa_x", { archived: true })).archived, true);
  assert.deepEqual((await s.chartOf("org_b")).map((c) => c.id), ["coa_x"]);
  await s.addAccountRule({ id: "rule_x", orgId: "org_b", scope: "org", match: {}, direction: "in", accountCode: "1800", createdAt: now } as any);
  assert.equal(await s.removeAccountRule("rule_x"), true);
  assert.equal((await s.rulesOf("org_b")).length, 0);

  const line = (id: string, extra: object = {}) => ({ id, orgId: "org_b", source: { kind: "account", accountId: "acc_eur" }, direction: "in", asset: "EURe", amount: "1", tags: [], at: now, createdAt: now, ...extra }) as any;
  await s.addLedgerEntries([line("l_1", { txHash: hash("77") }), line("l_2")]);
  assert.equal((await s.updateLedgerEntry("l_1", { note: "n" })).note, "n");
  await s.replaceLedgerEntries([line("l_2", { accountCode: "8400" }), line("l_missing")]);
  const ledger = await s.ledgerOf("org_b");
  assert.deepEqual(ledger.map((e) => e.id), ["l_1", "l_2"], "a replace changes rows in place and adds none");
  assert.equal(ledger[1].accountCode, "8400");
  await s.addConversionSweep({ id: "sw_1", userId: "u_a", month: "2026-11", depositIds: [], amountInUnits: "0", creditedEur: 0, txs: [{ step: "s", hash: hash("88") }], at: now });

  // hashOnRecord across the other collections.
  await s.addTransfer(transfer("t_rev2", "MANUAL_REVIEW"));
  assert.deepEqual(await s.resolveTransferReview("t_rev2", review(hash("77"))), { ok: false, code: "EVIDENCE_ON_RECORD", recordedOn: "ledger line l_1" });
  assert.deepEqual(await s.resolveTransferReview("t_rev2", review(hash("88"))), { ok: false, code: "EVIDENCE_ON_RECORD", recordedOn: "sweep sw_1" });
  // The user's own plain EURe arrival of that hash is the refund itself.
  await s.addCryptoDeposit({ ...deposit, id: "dep_refund", txHash: hash("66"), logIndex: 0 });
  assert.ok((await s.resolveTransferReview("t_rev2", review(hash("66")))).ok, "the refund's own arrival is not another record");

  // Rows come back with their keys in the order written: callers compare
  // rows with JSON.stringify (bookkeeping/statement.ts).
  await s.addLedgerEntries([{ statement: { valueDate: "d", key: "k-order", counterparty: { name: "n", iban: "i" } }, id: "l_order", orgId: "org_b", zz: 1, a: 2 } as any]);
  const back = (await s.ledgerOf("org_b")).find((e) => e.id === "l_order")!;
  assert.equal(JSON.stringify(back), JSON.stringify({ statement: { valueDate: "d", key: "k-order", counterparty: { name: "n", iban: "i" } }, id: "l_order", orgId: "org_b", zz: 1, a: 2 }));

  // ── list() returns each collection as it was written ─────────────────────
  assert.deepEqual((await s.list("users")).map((u) => u.id), ["u_a", "u_b"]);
  assert.deepEqual((await s.list("quotes")).map((x) => x.id), ["q_kept", "q_1", "q_late"]);
  assert.deepEqual(await s.list("processedMoneriumOrders"), ["ord-2", "ord-1"]);
  assert.deepEqual(await s.list("processedMoneriumWebhooks"), ["wh-1"]);
  assert.deepEqual(await s.list("cryptoDepositCursor"), { "84532": "12345678901234567891" });
  assert.deepEqual(json(await s.list("moneriumIssueOrders")), [issue]);
  assert.deepEqual((await s.list("transfers")).map((x) => x.id), ["t_1", "t_other", "t_rev", "t_held", "t_rev2"]);
  assert.equal((await s.list("audit")).length, 6);
  assert.deepEqual((await s.list("organisations")).map((x) => x.id), ["org_a", "org_b"]);
  assert.equal((await s.list("chartAccounts")).length, DEFAULT_CHART.length + 1);
  assert.deepEqual((await s.list("contacts")), []);
}

/**
 * The store methods §2 of docs/postgres-store-design.md moved callers'
 * check-then-writes into (rules 2-4): each checks on the row as stored, in
 * the same write. Run after storeSuite, on its rows.
 */
export async function conditionalWriteSuite(s: StoreBackend): Promise<void> {
  const now = iso(0);

  // Rule 2: a sub-object changes from its stored value; a stale copy written
  // whole would lose what another writer put there.
  await s.updateUser("u_b", { passkeySafe: { address: `0x${"bc".repeat(20)}`, status: "active", socialGuardians: [] } } as any);
  const stale = (await s.findUser("u_b"))!;
  await s.patchUserSub("u_b", "passkeySafe", (ps) => ({ ...ps!, recoveryChoice: { choice: "declined", at: now } }));
  const both = await s.patchUserSub("u_b", "passkeySafe", (ps) => ({ ...ps!, recoveredAt: now }), { name: "Bo 2" });
  assert.equal((both.passkeySafe as any).recoveryChoice?.choice, "declined", "the first writer's field survives the second");
  assert.equal(both.passkeySafe?.recoveredAt, now);
  assert.equal(both.name, "Bo 2", "the patch goes in the same write");
  assert.equal(stale.passkeySafe?.recoveredAt, undefined, "a row handed out earlier is a copy");
  await assert.rejects(async () => await s.patchUserSub("nobody", "monerium", (m) => m), /unknown user nobody/);

  await s.patchOrgSub("org_b", "invoicing", (cur) => ({ ...cur, vatId: "DE123456789" }));
  const org = await s.patchOrgSub("org_b", "invoicing", (cur) => ({ ...cur, taxNumber: "12/345/67890" }), { name: "B 2" } as any);
  assert.deepEqual([org.invoicing?.vatId, org.invoicing?.taxNumber, org.name], ["DE123456789", "12/345/67890", "B 2"]);
  await assert.rejects(async () => await s.patchOrgSub("org_b", "integrations", (c) => c, { safe: {} } as any), /setOrgSafePlan only/);

  // A transfer's steps only grow: two writers from stale copies both land,
  // and a step one of them enriched keeps what it was given.
  await s.addTransfer({ id: "t_steps", userId: "u_a", quoteId: "q_steps", rail: "sepa", state: "DEBITED", sendEur: 1, txs: [{ step: "safe.debit", hash: hash("01") }], createdAt: now, updatedAt: now } as any);
  const copyA = (await s.findTransfer("t_steps"))!;
  const copyB = (await s.findTransfer("t_steps"))!;
  copyA.txs.push({ step: "executor.intent", hash: "0x" });
  await s.updateTransfer("t_steps", { txs: copyA.txs });
  copyB.txs.push({ step: "compensator.refund", hash: hash("02") });
  await s.updateTransfer("t_steps", { txs: copyB.txs });
  await s.appendTransferStep("t_steps", { step: "appended", hash: hash("03") }, { error: "e" });
  const enriched = (await s.findTransfer("t_steps"))!.txs.map((x) => (x.step === "safe.debit" ? { ...x, outputLogIndexes: [4] } : x));
  const steps = await s.updateTransfer("t_steps", { txs: enriched });
  assert.deepEqual(steps.txs.map((x) => x.step), ["safe.debit", "executor.intent", "compensator.refund", "appended"], "both stale writers' steps, in commit order");
  assert.deepEqual((steps.txs[0] as any).outputLogIndexes, [4], "an enriched step keeps its new field");
  assert.equal(steps.error, "e");
  await s.updateTransfer("t_steps", { txs: [{ step: "safe.debit", hash: hash("01") }] });
  assert.deepEqual(((await s.findTransfer("t_steps"))!.txs[0] as any).outputLogIndexes, [4], "a stale copy without the field removes nothing");
  const sepa = await s.patchTransferSub("t_steps", "sepa", (cur) => ({ ...(cur ?? {}), state: "processed" } as any), { state: "PAID" } as any);
  assert.deepEqual([sepa.sepa?.state, sepa.state], ["processed", "PAID"]);
  assert.equal((await s.patchTransferSub("t_steps", "sepa", (cur) => cur, { state: "FAILED" } as any)).state, "PAID", "the final-state guard still holds");

  // Drafts: activity is appended, never written whole; a conditional write
  // checks state, the row read and the drafter (four eyes).
  const d = await s.addDraft({ id: "dr_s2", orgId: "org_b", source: { kind: "account", accountId: "acc_eur" }, state: "PENDING_REVIEW", lines: [], createdByMemberId: "mem_a", activity: [{ at: now, by: "mem_a", action: "created" }], createdAt: now, updatedAt: "2000-01-01T00:00:00.000Z" } as any);
  await assert.rejects(async () => await s.updateDraft("dr_s2", { activity: [] } as any), /appendDraftActivity/);
  assert.equal(await s.updateDraftFrom("dr_s2", { state: "REVIEWED" }, { from: ["DRAFT"] }), null, "not from a state it is not in");
  assert.equal(await s.updateDraftFrom("dr_s2", { state: "REVIEWED" }, { from: ["PENDING_REVIEW"], drafter: "mem_b" }), null, "someone else became the drafter");
  assert.equal(await s.updateDraftFrom("dr_s2", { state: "REVIEWED" }, { from: ["PENDING_REVIEW"], expectedUpdatedAt: "1999-01-01T00:00:00.000Z" }), null, "written since it was read");
  const reviewed = await s.updateDraftFrom("dr_s2", { state: "REVIEWED" }, { from: ["PENDING_REVIEW"], expectedUpdatedAt: d.updatedAt, drafter: "mem_a", activity: { at: now, by: "mem_b", action: "reviewed" } as any });
  assert.deepEqual(reviewed?.activity.map((a: any) => a.action), ["created", "reviewed"]);
  assert.ok(await s.claimDraftExecution("dr_s2"));
  assert.equal(await s.updateDraftFrom("dr_s2", { state: "CANCELLED" }, { from: ["DRAFT", "PENDING_REVIEW", "REVIEWED", "INVALID_DATA"] }), null, "a cancel never lands on EXECUTING");
  const appended = await s.appendDraftActivity("dr_s2", { at: now, by: "system", action: "executing" } as any, { failureReason: "x" } as any);
  assert.deepEqual([appended.state, appended.activity.length, (appended as any).failureReason], ["EXECUTING", 3, "x"]);

  // Rule 3: a state write names the states it may leave.
  await s.addPaymentRequest({ id: "pr_s2", code: "JKLM9012", userId: "u_a", state: "OPEN", payments: [], cryptoQuotes: [], source: { kind: "shopify", externalId: "2002", shop: "a.myshopify.com" }, expiresAt: iso(DAY), createdAt: now, updatedAt: now } as any);
  const recorded = await s.recordPaymentRequestPayment("pr_s2", (r) => ({ payments: [...r.payments, { id: "p1", ref: "x", amountEur: 1 } as any], state: "PAID" }));
  assert.deepEqual([recorded.from, recorded.written, recorded.request.state], ["OPEN", true, "PAID"]);
  assert.equal((await s.recordPaymentRequestPayment("pr_s2", () => null)).written, false, "nothing to write writes nothing");
  assert.equal(await s.updatePaymentRequestFrom("pr_s2", ["OPEN"], { state: "EXPIRED" }), null, "the expiry sweep leaves a request paid meanwhile PAID");
  assert.equal(await s.cancelUnpaidPaymentRequest("pr_s2"), null, "a paid request is never cancelled");
  await s.addPaymentRequest({ id: "pr_s2b", code: "NOPQ3456", userId: "u_a", state: "OPEN", payments: [], cryptoQuotes: [], source: { kind: "app" }, expiresAt: iso(-1000), createdAt: now, updatedAt: now } as any);
  assert.equal(await s.cancelUnpaidPaymentRequest("pr_s2b"), null, "past its expiry it stays expired (a Shopify cancel)");
  assert.equal((await s.cancelUnpaidPaymentRequest("pr_s2b", new Date(), true))?.state, "CANCELLED", "the payee's own cancel takes a stored OPEN one");
  assert.equal((await s.updatePaymentRequestFrom("pr_s2b", ["CANCELLED"], { description: "d" } as any))?.state, "CANCELLED");

  const csHold = (await s.holdDailyCap("u_a", 1, 100, () => 0)) as { holdId: string };
  await s.addCryptoSendUnderHold({ id: "cs_s2", userId: "u_a", to: `0x${"11".repeat(20)}`, token: "EURE", amount: "1", capEur: 1, state: "CREATED", deadline: Date.now() / 1000 + 600, createdAt: now, updatedAt: now } as any, csHold.holdId);
  assert.equal(await s.claimCryptoSend("cs_s2"), true);
  assert.equal(await s.updateCryptoSendFrom("cs_s2", ["CREATED"], { state: "FAILED", error: "screening" }), null, "FAILED never over a claimed send");
  assert.equal((await s.findCryptoSend("cs_s2"))?.state, "SUBMITTED");
  assert.equal((await s.updateCryptoSendFrom("cs_s2", ["SUBMITTED"], { state: "SENT", txHash: hash("98") }))?.state, "SENT");

  // Invoices: pay-to, one settlement per ref, /pay once.
  await s.addInvoice({ id: "inv_s2", orgId: "org_b", direction: "outgoing", linkTokenHash: "lth-s2", state: "SUBMITTED", lines: [], currency: "EUR", total: "2.00", createdByMemberId: "mem_a", createdAt: now, updatedAt: now } as any);
  const settle = (ref: string, amountEur: number) => (i: any) => ({ settlements: [...(i.settlements ?? []).filter((x: any) => x.ref !== ref), { method: "bank", ref, amountEur, at: now }] });
  assert.ok(await s.settleInvoice("inv_s2", "monerium:o1", settle("monerium:o1", 1)));
  assert.equal(await s.settleInvoice("inv_s2", "monerium:o1", settle("monerium:o1", 1)), null, "the poller and a webhook settle one order once");
  assert.equal((await s.settleInvoice("inv_s2", "monerium:o1", settle("monerium:o1", 1.5), true))?.settlements?.length, 1, "a replace rewrites under its ref");
  assert.equal((await s.findInvoice("inv_s2"))?.settlements?.[0].amountEur, 1.5);
  const payDraft = (id: string) => ({ id, orgId: "org_b", source: { kind: "account", accountId: "acc_eur" }, state: "DRAFT", lines: [], createdByMemberId: "mem_a", activity: [], createdAt: now, updatedAt: now }) as any;
  const paying = await s.startInvoicePayment("inv_s2", ["SUBMITTED"], payDraft("dr_pay1"));
  assert.deepEqual([paying?.invoice.state, paying?.invoice.payment?.draftId], ["PAYING", "dr_pay1"]);
  assert.equal(await s.startInvoicePayment("inv_s2", ["SUBMITTED"], payDraft("dr_pay2")), null, "a second /pay finds it PAYING");
  assert.equal(await s.findDraft("dr_pay2"), undefined, "and adds no draft");
  assert.equal(await s.updateInvoiceFrom("inv_s2", ["LINK_CREATED"], { state: "SUBMITTED" } as any), null);

  await s.tx(async (t) => {
    assert.equal((await t.lockOrganisation("org_b"))?.id, "org_b");
    assert.equal((await s.lockUser("u_a"))?.id, "u_a", "store.lock… inside a tx joins it");
    await t.lockKey("ledger:org_b");
  });
  await assert.rejects(s.lockUser("u_a"), /lockUser outside a store\.tx holds nothing/);

  // A deposit is settled once.
  await s.addCryptoDeposit({ id: "dep_s2", userId: "u_a", chainId: 84532, token: "USDC", txHash: hash("5a"), logIndex: 1, amountUnits: "1", holding: "awaiting_approval", txs: [], createdAt: now, updatedAt: now } as any);
  const first = await s.settleCryptoDeposit("dep_s2", (row) => ({ holding: row.holding === "awaiting_approval" ? "held" : row.holding }) as any);
  assert.deepEqual([first?.holding, !!first?.settledAt], ["held", true]);
  assert.equal(await s.settleCryptoDeposit("dep_s2", () => ({ holding: "converted" }) as any), null, "settledAt is set once");
  assert.equal((await s.list("cryptoDeposits")).find((x) => x.id === "dep_s2")?.holding, "held");

  // Rule 4: the last owner, and an invitation spent once.
  await s.addMember({ id: "mem_o1", orgId: "org_b", userId: "u_o1", email: "a@x", role: "owner", status: "active", createdAt: now } as any);
  await s.addMember({ id: "mem_o2", orgId: "org_b", userId: "u_o2", email: "b@x", role: "owner", status: "active", createdAt: now } as any);
  const lastOwnerLeft = (members: any[], id: string, next: any) =>
    members.filter((m) => m.role === "owner" && m.status === "active" && m.id !== id).length > 0 || next.role === "owner";
  assert.ok(await s.updateMemberChecked("mem_o1", { role: "admin" } as any, (ms) => lastOwnerLeft(ms, "mem_o1", { role: "admin" })));
  assert.equal(await s.updateMemberChecked("mem_o2", { role: "admin" } as any, (ms) => lastOwnerLeft(ms, "mem_o2", { role: "admin" })), null, "the org keeps its last owner");
  assert.equal((await s.findMember("mem_o2"))?.role, "owner");
  await s.addMember({ id: "mem_inv", orgId: "org_b", email: "c@x", role: "viewer", status: "invited", invite: { tokenHash: "th-1", expiresAt: iso(DAY) }, createdAt: now } as any);
  assert.equal(await s.acceptInvite("mem_inv", "th-other", "u_c"), null, "not with another token");
  assert.equal(await s.acceptInvite("mem_inv", "th-1", "u_o1"), null, "not for someone already on the org");
  const accepted = await s.acceptInvite("mem_inv", "th-1", "u_c");
  assert.deepEqual([accepted?.status, accepted?.userId, accepted?.invite], ["active", "u_c", undefined]);
  assert.equal(await s.acceptInvite("mem_inv", "th-1", "u_d"), null, "spent once");

  // Candide: each wrong code counted on the stored row, cancelled past the limit.
  await s.addRecoveryRequest({ id: "rr_otp", userId: "u_a", mode: "candide", status: "OTP_PENDING", candide: { otpAttempts: 0 }, requestedAt: now } as any);
  assert.deepEqual([(await s.countRecoveryOtpAttempt("rr_otp", 2))?.attempts, (await s.countRecoveryOtpAttempt("rr_otp", 2))?.attempts], [1, 2]);
  const over = await s.countRecoveryOtpAttempt("rr_otp", 2);
  assert.deepEqual([over?.over, over?.request.status], [true, "CANCELED"]);
  assert.equal(await s.countRecoveryOtpAttempt("rr_otp", 2), null, "nothing counted once it left OTP_PENDING");

  // A recovery status leaves only the statuses named: of a cancel and a relay
  // made at once, one lands.
  await s.addRecoveryRequest({ id: "rr_from", userId: "u_a", mode: "zoldenburg", status: "REVIEW_PENDING", requestedAt: now } as any);
  const moves = await Promise.all([
    s.updateRecoveryRequestFrom("rr_from", ["REVIEW_PENDING"], { status: "CANCELED", cancelReason: "owner" }),
    s.updateRecoveryRequestFrom("rr_from", ["REVIEW_PENDING"], { status: "GRACE_PERIOD" }),
  ]);
  assert.equal(moves.filter(Boolean).length, 1, "one of two parallel moves from REVIEW_PENDING lands");
  assert.equal(await s.updateRecoveryRequestFrom("rr_from", ["PASSKEY_PENDING", "REVIEW_PENDING"], { status: "EXPIRED" }), null, "the sweep's EXPIRED never lands on a moved row");
  await assert.rejects(async () => await s.updateRecoveryRequestFrom("rr_none", ["REVIEW_PENDING"], { status: "EXPIRED" }), /unknown recovery request rr_none/);

  // Email code: each guess counted on the stored row, parallel ones too.
  await s.updateUser("u_a", { emailCode: { hash: "h", email: "ada@example.com", expiresAt: iso(DAY), attempts: 0, sentAt: [] } } as any);
  const guesses = await Promise.all(Array.from({ length: 8 }, () => s.countEmailCodeAttempt("u_a", 5)));
  assert.equal(guesses.filter(Boolean).length, 5, "8 parallel guesses against a limit of 5: 5 counted");
  assert.deepEqual(guesses.filter(Boolean).map((u) => u!.emailCode!.attempts).sort(), [1, 2, 3, 4, 5], "each sees the ones before");
  assert.equal((await s.findUser("u_a"))?.emailCode?.attempts, 5);
  await s.updateUser("u_a", { emailCode: { hash: "h", email: "ada@example.com", expiresAt: iso(-1000), attempts: 0, sentAt: [] } } as any);
  assert.equal(await s.countEmailCodeAttempt("u_a", 5), undefined, "an expired code takes no guess");
  await s.updateUser("u_a", { emailCode: { hash: "h", email: "other@example.com", expiresAt: iso(DAY), attempts: 0, sentAt: [] } } as any);
  assert.equal(await s.countEmailCodeAttempt("u_a", 5), undefined, "nor one sent to another address");
  await s.updateUser("u_a", { emailCode: undefined } as any);

  // A deposit changed from its stored value (§2 rules 2 and 5): the
  // conversion intent is claimed once, and partials appended in parallel are
  // both kept.
  const intent = { at: now, amountUnits: "1", safeAddress: `0x${"ab".repeat(20)}`, quote: { provider: "dex", rate: "1", minOut: "1" } };
  const claims = await Promise.all([1, 2].map(() => s.patchCryptoDeposit("dep_other_chain", (d) => (d.conversionIntent ? null : { conversionIntent: intent }))));
  assert.equal(claims.filter(Boolean).length, 1, "two parallel claims of one deposit's conversion: one");
  assert.deepEqual((await s.findCryptoDeposit(8453, hash("aa"), 3))?.conversionIntent, intent);
  const partial = (eur: number) => ({ creditedEur: eur, provider: "dex", rate: 1, conversion: { amountInUnits: "1" } });
  await Promise.all([1, 2].map((eur) => s.patchCryptoDeposit("dep_other_chain", (d) => ({ partials: [...(d.partials ?? []), partial(eur)] }))));
  assert.deepEqual((await s.findCryptoDeposit(8453, hash("aa"), 3))?.partials?.map((p) => p.creditedEur).sort(), [1, 2], "both partials kept");
  await assert.rejects(async () => await s.patchCryptoDeposit("dep_none", () => ({})), /unknown crypto deposit dep_none/);

  // Approvals waiting for a passkey: the operation comes back with its
  // bigints, an expired one is gone, a dropped one is gone.
  const userOperation = { sender: `0x${"ab".repeat(20)}`, nonce: 2n ** 70n + 1n, callData: "0x1234", maxFeePerGas: 7n, paymaster: `0x${"cd".repeat(20)}` } as any;
  const pendingRow = { userId: "u_a", expiresAt: Date.now() + 60_000, challenge: "ch", plan: { address: `0x${"ab".repeat(20)}`, status: "active" } as any, userOperation, batch: { recipient: `0x${"ef".repeat(20)}` as const, mode: "live" as const } };
  await s.putPendingExecution("transfer", "t_pending", pendingRow);
  const back = await s.findPendingExecution("transfer", "t_pending");
  assert.equal(back?.userOperation.nonce, 2n ** 70n + 1n, "a bigint comes back a bigint");
  assert.deepEqual(back, pendingRow, "the stored operation is the prepared one");
  assert.equal(await s.findPendingExecution("cryptoSend", "t_pending"), undefined, "keyed by kind");
  await s.putPendingExecution("cryptoSend", "cs_old", { ...pendingRow, expiresAt: Date.now() - 1 });
  assert.equal(await s.findPendingExecution("cryptoSend", "cs_old"), undefined, "an expired one is not handed out");
  await s.dropPendingExecution("transfer", "t_pending");
  assert.equal(await s.findPendingExecution("transfer", "t_pending"), undefined, "dropped with its claim");

  // Rule 4 over an organisation: a write only while a check on it holds.
  assert.equal(await s.updateOrganisationIf("org_b", () => false, () => ({ name: "never" })), null);
  assert.equal((await s.updateOrganisationIf("org_b", (o) => o.name === "B 2", (o) => ({ name: `${o.name}!` })))?.name, "B 2!");
}

/**
 * The outbox (outbox.ts, docs/postgres-store-design.md §5): rows written with
 * the change they report, claimed once until their lease ends, settled
 * delivered, due again or dead, deduped on their key.
 */
export async function outboxSuite(s: StoreBackend): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const KINDS = ["suite.a", "suite.k", "suite.l"];
  const before = await s.outboxCounts();
  const a = (await s.enqueueOutbox({ kind: "suite.a", payload: { n: 1 } }))!;
  assert.match(a.id, /^msg_[0-9a-f-]{36}$/, "the row id is the receiver's idempotency key");
  assert.equal(a.attempts, 0);
  const k = (await s.enqueueOutbox({ kind: "suite.k", payload: { n: 2 }, key: "suite:k" }))!;
  assert.equal(await s.enqueueOutbox({ kind: "suite.k", payload: { n: 3 }, key: "suite:k" }), null, "a second row with one key is not written");
  assert.deepEqual(await s.outboxCounts(), { pending: before.pending + 2, dead: before.dead });

  const claimed = (await s.claimOutbox(10, 60_000, KINDS)).filter((r) => r.kind.startsWith("suite."));
  assert.deepEqual(claimed.map((r) => r.id).sort(), [a.id, k.id].sort(), "both due rows claimed");
  assert.ok(claimed.every((r) => r.attempts === 1 && r.claimedUntil), "the attempt is counted at the claim");
  assert.deepEqual((await s.claimOutbox(10, 60_000, KINDS)).filter((r) => r.kind.startsWith("suite.")), [], "a claimed row is not claimed again");

  assert.equal(await s.settleOutbox(a.id, 1, { ok: true }), true);
  assert.equal(await s.settleOutbox(a.id, 1, { ok: true }), false, "settled once");
  assert.ok((await s.findOutboxRow(a.id))?.deliveredAt);
  assert.equal(await s.settleOutbox(k.id, 1, { ok: false, error: "HTTP 503", retryInMs: 0 }), true);
  const again = (await s.claimOutbox(10, 60_000, KINDS)).filter((r) => r.kind.startsWith("suite."));
  assert.deepEqual(again.map((r) => [r.id, r.attempts, r.lastError]), [[k.id, 2, "HTTP 503"]], "due again after its backoff, the attempt counted");
  assert.equal(await s.settleOutbox(k.id, 2, { ok: false, error: "HTTP 503", retryInMs: 3_600_000 }), true);
  assert.deepEqual((await s.claimOutbox(10, 60_000, KINDS)).filter((r) => r.kind.startsWith("suite.")), [], "not before its backoff ends");

  // Only the kinds asked for: a row whose kind has no handler is left alone.
  const other = (await s.enqueueOutbox({ kind: "suite.unhandled", payload: {} }))!;
  assert.deepEqual((await s.claimOutbox(10, 60_000, ["suite.a"])).map((r) => r.id), []);
  assert.equal((await s.findOutboxRow(other.id))?.attempts, 0, "not claimed, no attempt counted");

  // A claim whose lease ran out (a process that died delivering) is due again.
  const l = (await s.enqueueOutbox({ kind: "suite.l", payload: {} }))!;
  assert.equal((await s.claimOutbox(10, 1, KINDS)).filter((r) => r.id === l.id).length, 1);
  await wait(20);
  const reclaimed = (await s.claimOutbox(10, 60_000, KINDS)).find((r) => r.id === l.id);
  assert.equal(reclaimed?.attempts, 2, "a lapsed claim is claimed again");
  assert.equal(await s.settleOutbox(l.id, 1, { ok: true }), false, "the lapsed claim's settle does not touch the new claim");
  assert.equal(await s.settleOutbox(l.id, 2, { ok: false, error: "gave up", dead: true }), true);
  assert.equal((await s.findOutboxRow(l.id))?.lastError, "gave up");
  assert.ok((await s.findOutboxRow(l.id))?.deadAt);
  assert.deepEqual(await s.outboxCounts(), { pending: before.pending + 2, dead: before.dead + 1 });

  // Pruning drops delivered rows only.
  assert.ok((await s.pruneOutbox(new Date(Date.now() + 60_000).toISOString())) >= 1);
  assert.equal(await s.findOutboxRow(a.id), undefined, "a delivered row is pruned");
  assert.ok(await s.findOutboxRow(k.id), "a pending row stays");
  assert.ok(await s.findOutboxRow(l.id), "a dead row stays");

  // A state listener's draft is written with the state change; one that
  // throws fails neither the write nor the next listener.
  const now = iso(0);
  await s.addTransfer({ id: "t_ob", userId: "u_a", quoteId: "q-t_ob", rail: "sepa", state: "CREATED", txs: [], createdAt: now, updatedAt: now } as any);
  s.onTransferStateChange((t) => {
    if (t.id === "t_ob") throw new Error("listener blew up");
  });
  s.onTransferStateChange((t, from) => (t.id === "t_ob" ? { kind: "suite.state", payload: { id: t.id, from, to: t.state } } : undefined));
  await s.updateTransfer("t_ob", { state: "DEBITED" });
  await s.updateTransfer("t_ob", { reference: "no state change" } as any);
  const states = (await s.list("outbox")).filter((r) => r.kind === "suite.state").map((r) => r.payload);
  assert.deepEqual(states, [{ id: "t_ob", from: "CREATED", to: "DEBITED" }], "one row per state change, none for another write");
  assert.equal((await s.findTransfer("t_ob"))?.state, "DEBITED");
  // A row enqueued inside a transaction is part of it.
  const inTx = await s.tx(async (t) => (await t.enqueueOutbox({ kind: "suite.tx", payload: {} }))!);
  assert.ok(await s.findOutboxRow(inTx.id));
}

/** Tables whose rows the database keeps (migrations/0006, §5). */
export const KEPT_TABLES = ["ledger", "organisations", "accounts", "invoices", "documents", "transfers", "audit", "ledger_history"] as const;

/**
 * Postgres only, after storeSuite: every change of a ledger row keeps the row
 * as it was in `ledger_history`, and no role deletes or truncates the kept
 * tables, or changes an audit or history row.
 */
export async function keptRowsSuite(s: StoreBackend, sql: Sql): Promise<void> {
  const now = iso(0);
  const history = async (id: string) => (await sql.query<{ doc: any }>("SELECT doc FROM ledger_history WHERE entry_id = $1 ORDER BY seq", [id])).rows.map((r) => r.doc);
  const entry = { id: "le_hist", orgId: "org_h", source: { kind: "wallet", walletId: "w_h" }, direction: "in", asset: "EURe", amount: "5", accountCode: "1000", accountCodeAuto: true, at: now, createdAt: now } as any;
  await s.addLedgerEntries([entry]);
  assert.deepEqual(await history("le_hist"), [], "an insert is not a change");
  await s.updateLedgerEntry("le_hist", { fiatValue: "5.00" } as any);
  await s.updateLedgerEntry("le_hist", { accountCode: "4400", accountCodeAuto: false } as any);
  await s.replaceLedgerEntries([(await s.ledgerOf("org_h"))[0]!]);
  const h = await history("le_hist");
  assert.deepEqual(h.map((d) => [d.fiatValue, d.accountCode]), [[undefined, "1000"], ["5.00", "1000"]], "each change keeps the row as it was; a save of the same row is not a change");
  const cur = (await s.ledgerOf("org_h"))[0] as any;
  assert.deepEqual([cur.fiatValue, cur.accountCode], ["5.00", "4400"]);

  for (const t of KEPT_TABLES) {
    const n = Number((await sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
    assert.ok(n > 0, `${t} has a row to refuse deleting`);
    await assert.rejects(() => sql.query(`DELETE FROM ${t}`), /DELETE on \w+ is refused/, `no DELETE on ${t}`);
    await assert.rejects(() => sql.query(`TRUNCATE ${t} CASCADE`), /TRUNCATE on \w+ is refused/, `no TRUNCATE on ${t}`);
  }
  await assert.rejects(() => sql.query("UPDATE audit SET doc = doc"), /UPDATE on audit is refused/, "audit is append-only");
  await assert.rejects(() => sql.query("UPDATE ledger_history SET doc = doc"), /UPDATE on ledger_history is refused/, "history is append-only");
}
