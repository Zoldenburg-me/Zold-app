/**
 * Managed KYC guardian recovery policy.
 *
 * This does not execute an on-chain recovery. It proves the product/security
 * gate around the guardian: approved KYC, active recovery module, operator
 * approval, and a delay before the guardian signer is allowed to act.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { User } from "../services/api/src/store.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "transf-recovery-")), "db.json");
process.env.RECOVERY_DELAY_HOURS = "72";
process.env.RECOVERY_REQUEST_TTL_HOURS = String(24 * 14);
process.env.RECOVERY_MANAGED_KYC_GUARDIAN = "1";

const { buildRecoveryRequest, approveRecoveryRequest, publicRecoveryRequest, readinessStatus } = await import(
  "../services/api/src/recovery.js"
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
const t = (label: string, fn: () => void) => {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
};

try {
  console.log("Managed recovery");

  t("pending KYC cannot start managed recovery", () => {
    assert.throws(
      () => buildRecoveryRequest({ ...baseUser, kycStatus: "pending" }, randomUUID(), new Date()),
      /KYC pending/,
    );
  });

  t("a Safe without active recovery module cannot start", () => {
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

  t("a valid request starts in KYC_PENDING with guardian metadata", () => {
    assert.equal(req.status, "KYC_PENDING");
    assert.equal(req.recoveryDelayHours, 72);
    assert.equal(req.guardianAddress, baseUser.passkeySafe.recovery!.guardianAddress);
    assert.equal(req.recoveryModuleAddress, baseUser.passkeySafe.recovery!.moduleAddress);
    assert.equal(req.factors.kyc, "pending");
  });

  t("public projection redacts contact and operator fields", () => {
    const pub = publicRecoveryRequest({ ...req, reviewedBy: "operator:x", reviewReason: "private note" });
    assert.equal((pub as any).contact, undefined);
    assert.equal((pub as any).reviewedBy, undefined);
    assert.equal((pub as any).reviewReason, undefined);
  });

  const approved = approveRecoveryRequest(req, openedAt, "operator:test", "identity matched");

  t("operator approval starts the delay and marks factors passed", () => {
    assert.equal(approved.status, "DELAYING");
    assert.equal(approved.readyAt, "2026-08-07T12:00:00.000Z");
    assert.equal(approved.factors.manualReview, "passed");
  });

  t("readiness does not advance before the delay", () => {
    assert.equal(readinessStatus(approved, new Date("2026-08-07T11:59:59.000Z")), "DELAYING");
  });

  t("readiness advances only after the delay", () => {
    assert.equal(readinessStatus(approved, new Date("2026-08-07T12:00:00.000Z")), "READY_FOR_GUARDIAN");
  });

  t("request persists through the store", () => {
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
  rmSync(path.dirname(process.env.TRANSF_DB_PATH!), { recursive: true, force: true });
}
