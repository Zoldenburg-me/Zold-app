import { RECOVERY } from "./config.js";
import type { RecoveryRequest, User } from "./store.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function assertRecoveryAvailable(user: User): string | null {
  if (!RECOVERY.managedKycGuardian) return "managed KYC recovery is disabled";
  if (user.kycStatus !== "approved") return `KYC ${user.kycStatus}; recovery requires approved identity`;
  if (!user.passkeySafe || user.passkeySafe.status !== "active") return "active passkey Safe required";
  if (!user.passkeySafe.recovery || user.passkeySafe.recovery.status !== "active") {
    return "managed recovery guardian is not enabled on this Safe";
  }
  return null;
}

export function buildRecoveryRequest(
  user: User,
  id: string,
  now: Date,
  newOwnerAddress?: `0x${string}`,
  contact?: string,
): RecoveryRequest {
  const blocked = assertRecoveryAvailable(user);
  if (blocked) throw new Error(blocked);
  const requestedAt = now.toISOString();
  return {
    id,
    userId: user.id,
    safeAddress: user.address,
    status: "KYC_PENDING",
    requestedAt,
    expiresAt: new Date(now.getTime() + RECOVERY.requestTtlHours * 60 * 60 * 1000).toISOString(),
    recoveryDelayHours: RECOVERY.delayHours,
    guardianAddress: user.passkeySafe!.recovery!.guardianAddress,
    recoveryModuleAddress: user.passkeySafe!.recovery!.moduleAddress,
    ...(newOwnerAddress ? { newOwnerAddress } : {}),
    ...(contact ? { contact } : {}),
    factors: {
      kyc: "pending",
      otp: "pending",
      liveness: "pending",
      manualReview: "pending",
    },
  };
}

export function approveRecoveryRequest(
  request: RecoveryRequest,
  now: Date,
  reviewer: string,
  reason?: string,
): RecoveryRequest {
  if (request.status !== "KYC_PENDING") throw new Error(`recovery request is ${request.status}`);
  const approvedAt = now.toISOString();
  return {
    ...request,
    status: "DELAYING",
    kycApprovedAt: approvedAt,
    readyAt: new Date(now.getTime() + request.recoveryDelayHours * 60 * 60 * 1000).toISOString(),
    reviewedBy: reviewer,
    reviewReason: reason,
    factors: {
      kyc: "passed",
      otp: "passed",
      liveness: "passed",
      manualReview: "passed",
    },
  };
}

export function readinessStatus(request: RecoveryRequest, now: Date): RecoveryRequest["status"] {
  if (request.status !== "DELAYING") return request.status;
  if (!request.readyAt || now < new Date(request.readyAt)) return request.status;
  return "READY_FOR_GUARDIAN";
}

export function publicRecoveryRequest(request: RecoveryRequest) {
  const { contact, reviewedBy, reviewReason, candide, ...pub } = request;
  if (!candide) return pub;
  // The new credential stays private until it is bound, and channel targets
  // are masked: a recovery id is not a licence to read someone's phone number.
  const { newPasskey, auths, ...rest } = candide;
  return {
    ...pub,
    candide: {
      ...rest,
      newPasskeyRegistered: Boolean(newPasskey),
      auths: (auths ?? []).map((a) => ({
        challengeId: a.challengeId,
        channel: a.channel,
        target: maskContact(a.channel, a.target),
        verified: a.verified,
      })),
    },
  };
}

function maskContact(channel: string, target: string): string {
  if (channel === "email") {
    const [local = "", domain = ""] = target.split("@");
    const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
    return `${head}${"•".repeat(Math.max(1, local.length - head.length))}@${domain}`;
  }
  const digits = target.replace(/\D/g, "");
  return `${target.startsWith("+") ? "+" : ""}${"•".repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}
