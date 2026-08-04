import { CHAIN_ID, RECOVERY } from "./config.js";
import { readinessStatus } from "./recovery.js";
import type { RecoveryRequest } from "./store.js";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface GuardianSignerPayload {
  action: "safe_social_recovery";
  requestId: string;
  userId: string;
  chainId: number;
  safeAddress: `0x${string}`;
  recoveryModuleAddress: `0x${string}`;
  guardianAddress: `0x${string}`;
  newOwners: `0x${string}`[];
  newThreshold: number;
}

export interface GuardianSubmission {
  mode: "external_signer";
  requestedAt: string;
  submittedAt: string;
  signerStatus: string;
  txHash?: `0x${string}`;
}

export function assertGuardianSubmissionReady(request: RecoveryRequest, now: Date) {
  const status = readinessStatus(request, now);
  if (status !== "READY_FOR_GUARDIAN") {
    throw new Error(`recovery request is ${status}; guardian cannot sign yet`);
  }
  if (now >= new Date(request.expiresAt)) {
    throw new Error("recovery request expired before guardian submission");
  }
  if (!request.newOwnerAddress) {
    throw new Error("newOwnerAddress is required before guardian submission");
  }
}

export function guardianSignerPayload(request: RecoveryRequest): GuardianSignerPayload {
  if (!request.newOwnerAddress) throw new Error("newOwnerAddress is required before guardian submission");
  return {
    action: "safe_social_recovery",
    requestId: request.id,
    userId: request.userId,
    chainId: CHAIN_ID,
    safeAddress: request.safeAddress,
    recoveryModuleAddress: request.recoveryModuleAddress,
    guardianAddress: request.guardianAddress,
    newOwners: [request.newOwnerAddress],
    newThreshold: 1,
  };
}

export async function submitGuardianRecovery(
  request: RecoveryRequest,
  now = new Date(),
): Promise<GuardianSubmission> {
  assertGuardianSubmissionReady(request, now);
  if (!RECOVERY.guardianSignerUrl) {
    throw new Error("RECOVERY_GUARDIAN_SIGNER_URL is required before guardian submission");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECOVERY.guardianSignerTimeoutMs);
  try {
    const response = await fetch(RECOVERY.guardianSignerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(RECOVERY.guardianSignerToken
          ? { authorization: `Bearer ${RECOVERY.guardianSignerToken}` }
          : {}),
      },
      body: JSON.stringify(guardianSignerPayload(request)),
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(
        `guardian signer rejected request (${response.status}): ${String(body?.error ?? text).slice(0, 160)}`,
      );
    }
    const txHash = typeof body?.txHash === "string" && TX_HASH_RE.test(body.txHash)
      ? (body.txHash as `0x${string}`)
      : undefined;
    return {
      mode: "external_signer",
      requestedAt: now.toISOString(),
      submittedAt: new Date().toISOString(),
      signerStatus: String(body?.status ?? (txHash ? "submitted" : "accepted")).slice(0, 80),
      ...(txHash ? { txHash } : {}),
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("guardian signer timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
