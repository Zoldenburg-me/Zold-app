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
  await assert.rejects(() => s.updateUser("nobody", { name: "x" }), /unknown user nobody/);

  assert.equal((await s.recordPasskeyUse("u_a", "cred-a", 7))?.passkey?.signCount, 7);
  assert.equal(await s.recordPasskeyUse("u_a", "cred-old", 8), undefined, "a replaced credential records nothing");
  assert.equal((await s.findUser("u_a"))?.passkey?.signCount, 7);

  await s.setSegment("u_a", { value: "consumer", reason: "test" } as any);
  await assert.rejects(() => s.setSegment("u_a", { value: "business" } as any), /already has segment/);
  assert.equal((await s.setSegment("u_a", { value: "business" } as any, "admin")).segment?.decidedBy, "admin");
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
  await assert.rejects(() => s.updateOrganisation("org_b", { safe: {} } as any), /setOrgSafePlan only/);
  assert.equal((await s.updateOrganisation("org_b", { name: "B AG" })).name, "B AG");
  await assert.rejects(() => s.setOrgSafePlan("org_a", {} as any), /not a company/);
  await assert.rejects(() => s.setOrgSafePlan("nobody", {} as any), /unknown organisation/);
  await assert.rejects(() => s.replaceUndeployedOrgSafePlan("org_b", `0x${"00".repeat(20)}`, {} as any), /no planned Safe/);

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
  await assert.rejects(() => s.consumeQuote("nobody"), /unknown quote/);
  assert.equal((await s.updateQuote("q_1", { rate: 2 } as any) as any).rate, 2);

  // ── Transfers ────────────────────────────────────────────────────────────
  const seen: string[] = [];
  s.onTransferStateChange((t, from) => seen.push(`${t.id}:${from}->${t.state}`));
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
  await assert.rejects(() => s.updateTransfer("nobody", {}), /unknown transfer/);

  // A review resolves once, and a refund tx another record holds is refused.
  await s.addTransfer(transfer("t_other", "PAID", { txs: [{ step: "x", hash: hash("cd") }] }));
  await s.addTransfer(transfer("t_rev", "MANUAL_REVIEW", { error: "unknown outcome" }));
  const review = (evidence: string) => ({ state: "REFUNDED" as const, note: "Refunded by hand after checking the chain.", by: "op_1", evidence, refund: { amountEur: 10, movedEur: 10 } });
  await assert.rejects(async () => s.resolveTransferReview("t_rev", { ...review(hash("ef")), note: "short" }), /note of/);
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
  await assert.rejects(() => s.addTransferUnderHold(transfer("t_nohold", "CREATED"), "nohold"), /no cap hold/);
  assert.equal(await s.findTransfer("t_nohold"), undefined);
  await s.addTransferUnderHold(transfer("t_held", "CREATED"), hold.holdId);
  assert.ok(await s.findTransfer("t_held"));
  assert.equal(await s.heldEurToday("u_a"), 0, "the hold became the transfer");
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
  await assert.rejects(() => s.touchSession("nobody"), /unknown session/);

  // ── Operators ────────────────────────────────────────────────────────────
  const op = await s.addOperator({ id: "op_1", email: " Op@Zold.test ", name: "Op", credentials: [{ credentialId: "oc-1", publicKey: "pk", signCount: 0 }], createdAt: now } as any);
  assert.equal(op.email, "op@zold.test", "stored lowercase");
  await s.addOperator({ id: "op_2", email: "two@zold.test", name: "Two", credentials: [], createdAt: now } as any);
  await assert.rejects(() => s.addOperator({ id: "op_3", email: "two@zold.test", credentials: [] } as any), /exists/);
  assert.equal((await s.findOperatorByEmail("OP@zold.test"))?.id, "op_1");
  assert.equal((await s.findOperator("op_2"))?.name, "Two");
  await assert.rejects(() => s.addOperatorCredential("op_2", { credentialId: "oc-1" } as any), /already registered/, "one passkey, one operator");
  await s.addOperatorCredential("op_2", { credentialId: "oc-2", publicKey: "pk", signCount: 0 } as any);
  const found = await s.findOperatorCredential("oc-2");
  assert.equal(found?.operator.id, "op_2");
  assert.equal(found?.credential.credentialId, "oc-2");
  assert.equal(await s.findOperatorCredential("nope"), undefined);
  await s.recordOperatorCredentialUse("op_2", "oc-2", 5);
  assert.equal((await s.findOperatorCredential("oc-2"))?.credential.signCount, 5);
  await assert.rejects(() => s.recordOperatorCredentialUse("op_2", "nope", 1), /unknown operator credential/);
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
  await assert.rejects(() => s.updateRecoveryRequest("nobody", {}), /unknown recovery request/);

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
  await assert.rejects(() => s.finishSafeOp("so_1", { state: "PENDING" } as any), /final state/);
  assert.equal((await s.finishSafeOp("so_1", { state: "EXECUTED", txHash: hash("12") } as any)).state, "EXECUTED");
  await assert.rejects(() => s.finishSafeOp("so_1", { state: "FAILED" } as any), /not relaying/);
  await s.addSafeOp({ id: "so_2", orgId: "org_b", state: "PENDING", signatures: [], dropped: [], createdAt: now, updatedAt: now } as any);
  assert.equal((await s.endPendingSafeOp("so_2", { state: "CANCELLED", reason: "owner" }))?.state, "CANCELLED");
  assert.equal((await s.findSafeOp("so_2"))?.reason, "owner");

  // ── Monerium ─────────────────────────────────────────────────────────────
  await s.markOrderProcessed("ord-2");
  await s.markOrderProcessed("ord-1");
  await s.markOrderProcessed("ord-2");
  assert.deepEqual(await s.mirroredOrderIds(), ["ord-2", "ord-1"], "once each, in order");
  assert.equal(await s.isOrderProcessed("ord-1"), true);
  assert.equal(await s.isOrderProcessed("ord-3"), false);
  await s.markWebhookProcessed("wh-1");
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
  s.onPaymentRequestStateChange((r, from) => prSeen.push(`${r.id}:${from}->${r.state}`));
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
  assert.equal((await s.addCryptoDeposit({ ...deposit, id: "dep_dup", txHash: hash("aA") })).id, "dep_1", "one row per (txHash, logIndex)");
  assert.equal((await s.findCryptoDeposit(hash("AA"), 3))?.id, "dep_1");
  assert.equal(await s.findCryptoDeposit(hash("aa"), 4), undefined);
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
  assert.deepEqual((await s.list("quotes")).map((x) => x.id), ["q_kept", "q_1"]);
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
