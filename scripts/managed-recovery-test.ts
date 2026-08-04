/**
 * Managed KYC guardian recovery policy.
 *
 * This does not execute an on-chain recovery. It proves the product/security
 * gate around the guardian: approved KYC, active recovery module, operator
 * approval, and a delay before the guardian signer is allowed to act.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { User } from "../services/api/src/store.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "transf-recovery-")), "db.json");
process.env.RECOVERY_DELAY_HOURS = "72";
process.env.RECOVERY_REQUEST_TTL_HOURS = String(24 * 14);
process.env.RECOVERY_MANAGED_KYC_GUARDIAN = "1";
process.env.RECOVERY_GUARDIAN_SIGNER_TOKEN = "test-signer-token-with-enough-length";

const signerHits: any[] = [];
const signer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    signerHits.push({
      authorization: req.headers.authorization,
      body: JSON.parse(body || "{}"),
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", txHash: `0x${"aa".repeat(32)}` }));
  });
});
await new Promise<void>((resolve) => signer.listen(0, "127.0.0.1", resolve));
const signerAddress = signer.address();
if (!signerAddress || typeof signerAddress === "string") throw new Error("failed to start recovery signer stub");
process.env.RECOVERY_GUARDIAN_SIGNER_URL = `http://127.0.0.1:${signerAddress.port}/guardian/recover`;

const { buildRecoveryRequest, approveRecoveryRequest, publicRecoveryRequest, readinessStatus } = await import(
  "../services/api/src/recovery.js"
);
const { assertGuardianSubmissionReady, guardianSignerPayload, submitGuardianRecovery } = await import(
  "../services/api/src/recovery-signer.js"
);
const { initStore, store } = await import("../services/api/src/store.js");

initStore();

const baseUser = {
  id: randomUUID(),
  name: "Recovery User",
  country: "DE",
  iban: "",
  address: "0x1111111111111111111111111111111111111111",
  kycStatus: "approved",
  kyc: { provider: "manual", checkedAt: new Date().toISOString() },
  passkeySafe: {
    address: "0x1111111111111111111111111111111111111111",
    status: "active",
    threshold: 2,
    cosignerAddress: "0x2222222222222222222222222222222222222222",
    passkeyPublicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    recovery: {
      moduleAddress: "0x3333333333333333333333333333333333333333",
      guardianAddress: "0x4444444444444444444444444444444444444444",
      threshold: 1,
      status: "active",
      enabledAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  },
  wallet: { type: "candide-safe", deployed: true },
  funding: { mode: "sandbox", status: "active" },
  createdAt: new Date().toISOString(),
} satisfies User;

let pass = 0;
const t = async (label: string, fn: () => void | Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

try {
  console.log("Managed recovery");

  await t("pending KYC cannot start managed recovery", () => {
    assert.throws(
      () => buildRecoveryRequest({ ...baseUser, kycStatus: "pending" }, randomUUID(), new Date()),
      /KYC pending/,
    );
  });

  await t("a Safe without active recovery module cannot start", () => {
    assert.throws(
      () =>
        buildRecoveryRequest(
          { ...baseUser, passkeySafe: { ...baseUser.passkeySafe, recovery: undefined } },
          randomUUID(),
          new Date(),
        ),
      /guardian is not enabled/,
    );
  });

  const openedAt = new Date("2026-08-04T12:00:00.000Z");
  const req = buildRecoveryRequest(
    baseUser,
    "rec_test",
    openedAt,
    "0x5555555555555555555555555555555555555555",
    "user@example.com",
  );

  await t("a valid request starts in KYC_PENDING with guardian metadata", () => {
    assert.equal(req.status, "KYC_PENDING");
    assert.equal(req.recoveryDelayHours, 72);
    assert.equal(req.guardianAddress, baseUser.passkeySafe.recovery!.guardianAddress);
    assert.equal(req.recoveryModuleAddress, baseUser.passkeySafe.recovery!.moduleAddress);
    assert.equal(req.factors.kyc, "pending");
  });

  await t("public projection redacts contact and operator fields", () => {
    const pub = publicRecoveryRequest({ ...req, reviewedBy: "operator:x", reviewReason: "private note" });
    assert.equal((pub as any).contact, undefined);
    assert.equal((pub as any).reviewedBy, undefined);
    assert.equal((pub as any).reviewReason, undefined);
  });

  const approved = approveRecoveryRequest(req, openedAt, "operator:test", "identity matched");

  await t("operator approval starts the delay and marks factors passed", () => {
    assert.equal(approved.status, "DELAYING");
    assert.equal(approved.readyAt, "2026-08-07T12:00:00.000Z");
    assert.equal(approved.factors.manualReview, "passed");
  });

  await t("readiness does not advance before the delay", () => {
    assert.equal(readinessStatus(approved, new Date("2026-08-07T11:59:59.000Z")), "DELAYING");
  });

  await t("readiness advances only after the delay", () => {
    assert.equal(readinessStatus(approved, new Date("2026-08-07T12:00:00.000Z")), "READY_FOR_GUARDIAN");
  });

  await t("guardian signer refuses before the delay", () => {
    assert.throws(
      () => assertGuardianSubmissionReady(approved, new Date("2026-08-07T11:59:59.000Z")),
      /cannot sign yet/,
    );
  });

  const ready = { ...approved, status: "READY_FOR_GUARDIAN" as const };

  await t("guardian signer requires a replacement owner address", () => {
    assert.throws(
      () => assertGuardianSubmissionReady({ ...ready, newOwnerAddress: undefined }, new Date("2026-08-07T12:00:00.000Z")),
      /newOwnerAddress/,
    );
  });

  await t("guardian signer payload contains only recovery execution data", () => {
    const payload = guardianSignerPayload(ready);
    assert.equal(payload.action, "safe_social_recovery");
    assert.equal(payload.safeAddress, baseUser.address);
    assert.deepEqual(payload.newOwners, [req.newOwnerAddress]);
    assert.equal((payload as any).contact, undefined);
  });

  await t("guardian handoff calls the isolated signer", async () => {
    const submission = await submitGuardianRecovery(ready, new Date("2026-08-07T12:00:00.000Z"));
    assert.equal(submission.mode, "external_signer");
    assert.equal(submission.signerStatus, "accepted");
    assert.equal(submission.txHash, `0x${"aa".repeat(32)}`);
    assert.equal(signerHits.length, 1);
    assert.equal(signerHits[0].authorization, "Bearer test-signer-token-with-enough-length");
    assert.equal(signerHits[0].body.requestId, req.id);
  });

  await t("request persists through the store", () => {
    store.addUser(baseUser);
    store.addRecoveryRequest(req);
    const stored = store.findRecoveryRequest(req.id);
    assert.equal(stored?.id, req.id);
    const updated = store.updateRecoveryRequest(req.id, approved);
    assert.equal(updated.status, "DELAYING");
    assert.equal(store.recoveryRequestsForUser(baseUser.id).length, 1);
  });

  console.log(`\nMANAGED RECOVERY TEST PASSED — ${pass}/${pass}`);
} finally {
  signer.close();
  rmSync(path.dirname(process.env.TRANSF_DB_PATH!), { recursive: true, force: true });
}
