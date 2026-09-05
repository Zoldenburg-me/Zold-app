/**
 * Candide's email/SMS guardian — the Safe Recovery Service as a guardian on
 * the user's Safe.
 *
 * WHAT CANDIDE DOES: holds one guardian key, registers OTP channels against a
 * Safe (each registration is a SIWE statement the SAFE signs, so only an owner
 * can add a channel), and signs a recovery request only after the requester
 * passes an OTP on EVERY registered channel. Execution and finalisation are
 * sponsored by the service. The grace period is the module's, on chain.
 *
 * WHAT THIS FILE DOES: wraps the SDK behind a fail-closed availability check
 * (no RECOVERY_SERVICE_URL, no feature), validates channel targets before
 * they reach a third party, masks them on the way out, and pins one
 * invariant the SDK does not: the module Candide will recover through
 * (`getNetworkConfig().moduleAddress`) must be the module the guardian is
 * added to. A guardian in the wrong module is a guardian in no module.
 *
 * Nothing here signs. The Safe-side signatures (registration SIWE, adding the
 * guardian, cancelling) are passkey ceremonies driven by the routes; the
 * guardian signature is Candide's.
 */
import {
  RecoveryByCustodialGuardian,
  RecoveryByGuardian,
  SafeRecoveryServiceSdkError,
  type RecoveryByGuardianRequest,
  type SignatureRequest,
} from "safe-recovery-service-sdk";
import { RECOVERY } from "../config.js";
import { CANDIDE, recoveryGracePeriodSeconds } from "../wallet/candide.js";

export type RecoveryChannel = "email" | "sms";

export class CandideGuardianError extends Error {
  constructor(
    message: string,
    /** HTTP status a route should answer with. */
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CandideGuardianError";
  }
}

export const candideRecoveryEnabled = (): boolean => Boolean(RECOVERY.serviceUrl);

function requireEnabled(): string {
  if (!RECOVERY.serviceUrl) {
    throw new CandideGuardianError(
      "email/SMS recovery is not available on this deployment — RECOVERY_SERVICE_URL is unset",
      503,
      "RECOVERY_UNAVAILABLE",
    );
  }
  return RECOVERY.serviceUrl;
}

const siweOverrides = () => ({
  ...(RECOVERY.siweDomain ? { siweDomain: RECOVERY.siweDomain } : {}),
  ...(RECOVERY.siweUri ? { siweUri: RECOVERY.siweUri } : {}),
});

function custodial(): RecoveryByCustodialGuardian {
  return new RecoveryByCustodialGuardian(requireEnabled(), CANDIDE.chainId, siweOverrides());
}

function byGuardian(moduleAddress: string): RecoveryByGuardian {
  return new RecoveryByGuardian(requireEnabled(), CANDIDE.chainId, moduleAddress as any);
}

/**
 * Translate an SDK failure into something a route can answer with. The SDK
 * folds HTTP statuses into codes; a 4xx from the service is the caller's
 * problem (wrong OTP, unknown challenge, bad SIWE), everything else is the
 * service's and must not be reported as the user's.
 */
function translate(err: unknown, fallback: string): never {
  if (err instanceof CandideGuardianError) throw err;
  if (err instanceof SafeRecoveryServiceSdkError) {
    const code = err.code;
    const status =
      code === "HTTP_BAD_REQUEST" || code === "BAD_DATA" || code === "SIWE_ERROR"
        ? 400
        : code === "HTTP_UNAUTHORIZED" || code === "HTTP_FORBIDDEN"
          ? 403
          : code === "HTTP_NOT_FOUND"
            ? 404
            : code === "HTTP_CONFLICT"
              ? 409
              : code === "HTTP_TOO_MANY_REQUESTS"
                ? 429
                : 503;
    throw new CandideGuardianError(`${fallback}: ${err.message}`.slice(0, 300), status, code);
  }
  const message = String((err as any)?.message ?? err);
  throw new CandideGuardianError(`${fallback}: ${message}`.slice(0, 300), 503, "UNKNOWN_ERROR");
}

// ---------------------------------------------------------------------------
// channel targets

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Normalise and validate a channel target BEFORE it is sent to Candide. A
 *  malformed phone number is refused here rather than by a 400 that names
 *  their service. */
export function normaliseChannelTarget(channel: string, target: unknown): { channel: RecoveryChannel; target: string } {
  const value = String(target ?? "").trim();
  if (channel === "email") {
    const email = value.toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new CandideGuardianError("a valid email address is required", 400, "BAD_TARGET");
    }
    return { channel, target: email };
  }
  if (channel === "sms") {
    const phone = value.replace(/[\s().-]/g, "");
    if (!E164_RE.test(phone)) {
      throw new CandideGuardianError(
        "a phone number in international format is required, e.g. +4915112345678",
        400,
        "BAD_TARGET",
      );
    }
    return { channel, target: phone };
  }
  throw new CandideGuardianError('channel must be "email" or "sms"', 400, "BAD_CHANNEL");
}

/** What a public response may show of a channel target. */
export function maskTarget(channel: string, target: string): string {
  if (channel === "email") {
    const [local = "", domain = ""] = target.split("@");
    const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
    return `${head}${"•".repeat(Math.max(1, local.length - head.length))}@${domain}`;
  }
  const digits = target.replace(/\D/g, "");
  return `${target.startsWith("+") ? "+" : ""}${"•".repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// module agreement

/**
 * GET /v1/config/getNetworkConfig — the same call the SDK makes inside
 * createAndExecuteRecoveryRequest, which is exactly why we need it early:
 * the SDK will recover through whatever module this returns.
 */
async function fetchNetworkConfig(
  serviceUrl: string,
  chainId: bigint,
): Promise<{ moduleAddress: string; sponsorships?: { execution?: { enabled: boolean }; finalization?: { enabled: boolean } } }> {
  const url = `${serviceUrl}/v1/config/getNetworkConfig?${new URLSearchParams({ chainId: String(Number(chainId)) })}`;
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof body?.moduleAddress !== "string") {
    throw new CandideGuardianError(
      `network config for chain ${chainId} unavailable (${res.status}): ${String(body?.message ?? "no moduleAddress").slice(0, 120)}`,
      503,
      "NETWORK_CONFIG",
    );
  }
  return body;
}

let networkConfigCache: { at: number; moduleAddress: string; sponsoredExecution: boolean; sponsoredFinalization: boolean } | null = null;

/**
 * The module Candide recovers through on this chain. Cached for a minute:
 * every enrolment and every recovery asks, and the answer changes only when
 * Candide redeploys.
 */
export async function serviceModule(): Promise<{ moduleAddress: string; sponsoredExecution: boolean; sponsoredFinalization: boolean }> {
  const url = requireEnabled();
  if (networkConfigCache && Date.now() - networkConfigCache.at < 60_000) return networkConfigCache;
  try {
    const cfg = await fetchNetworkConfig(url, CANDIDE.chainId);
    networkConfigCache = {
      at: Date.now(),
      moduleAddress: String(cfg.moduleAddress),
      sponsoredExecution: Boolean(cfg.sponsorships?.execution?.enabled),
      sponsoredFinalization: Boolean(cfg.sponsorships?.finalization?.enabled),
    };
    return networkConfigCache;
  } catch (err) {
    return translate(err, "could not read the recovery service's network configuration");
  }
}

/**
 * Refuse to enrol a guardian into a module the service will not recover
 * through. Returns the agreed module address.
 */
export async function assertModuleAgreement(ourModule: string): Promise<`0x${string}`> {
  const theirs = await serviceModule();
  if (theirs.moduleAddress.toLowerCase() !== ourModule.toLowerCase()) {
    throw new CandideGuardianError(
      `this deployment enables recovery module ${ourModule} but Candide's service recovers chain ` +
        `${CANDIDE.chainId} through ${theirs.moduleAddress} — set CANDIDE_RECOVERY_MODULE_ADDRESS to match`,
      409,
      "MODULE_MISMATCH",
    );
  }
  if (recoveryGracePeriodSeconds(ourModule) === null) {
    throw new CandideGuardianError(`${ourModule} is not a known SocialRecoveryModule deployment`, 409, "MODULE_UNKNOWN");
  }
  return ourModule as `0x${string}`;
}

// ---------------------------------------------------------------------------
// enrolment: register a channel with the service (SIWE signed by the Safe, then OTP)

export function registrationStatement(safeAddress: string, channel: RecoveryChannel, target: string): string {
  return custodial().createRegistrationToRecoverySiweStatementToSign(safeAddress, channel, target);
}

/** Submit the Safe-signed SIWE message; Candide sends an OTP to the target
 *  and returns the challenge id to answer it with. */
export async function registerChannel(
  safeAddress: string,
  channel: RecoveryChannel,
  target: string,
  siweMessage: string,
  eip1271Signature: string,
): Promise<{ challengeId: string }> {
  try {
    const challengeId = await custodial().createRegistrationToRecovery(safeAddress, channel, target, siweMessage, eip1271Signature);
    return { challengeId };
  } catch (err) {
    return translate(err, `could not register ${channel} recovery`);
  }
}

export async function verifyRegistration(
  challengeId: string,
  otp: string,
): Promise<{ registrationId: string; guardianAddress: `0x${string}` }> {
  const code = String(otp ?? "").trim();
  if (!/^[0-9A-Za-z-]{4,12}$/.test(code)) throw new CandideGuardianError("enter the code you were sent", 400, "BAD_OTP");
  try {
    const r = await custodial().submitRegistrationChallenge(challengeId, code);
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.guardianAddress)) {
      throw new CandideGuardianError("the recovery service returned no guardian address", 502, "BAD_DATA");
    }
    return { registrationId: r.registrationId, guardianAddress: r.guardianAddress as `0x${string}` };
  } catch (err) {
    return translate(err, "the code was not accepted");
  }
}

export function deleteRegistrationStatement(safeAddress: string, registrationId: string): string {
  return custodial().deleteRegistrationSiweStatementToSign(safeAddress, registrationId);
}

export async function deleteRegistration(registrationId: string, siweMessage: string, eip1271Signature: string): Promise<boolean> {
  try {
    return await custodial().deleteRegistration(registrationId, siweMessage, eip1271Signature);
  } catch (err) {
    return translate(err, "could not remove the recovery channel");
  }
}

// ---------------------------------------------------------------------------
// recovery: OTP on every channel, then Candide signs, then execute + finalize

export async function requestSignatureChallenge(
  safeAddress: string,
  newOwners: string[],
  newThreshold: number,
): Promise<SignatureRequest> {
  try {
    return await custodial().requestCustodialGuardianSignatureChallenge(safeAddress, newOwners, newThreshold);
  } catch (err) {
    return translate(err, "could not start recovery with the guardian service");
  }
}

export async function submitSignatureChallenge(
  requestId: string,
  challengeId: string,
  otp: string,
): Promise<{ success: boolean; guardianAddress?: `0x${string}`; guardianSignature?: string }> {
  const code = String(otp ?? "").trim();
  if (!/^[0-9A-Za-z-]{4,12}$/.test(code)) throw new CandideGuardianError("enter the code you were sent", 400, "BAD_OTP");
  try {
    const r = await custodial().submitCustodialGuardianSignatureChallenge(requestId, challengeId, code);
    return {
      success: Boolean(r.success),
      ...(r.custodianGuardianAddress ? { guardianAddress: r.custodianGuardianAddress as `0x${string}` } : {}),
      ...(r.custodianGuardianSignature ? { guardianSignature: r.custodianGuardianSignature } : {}),
    };
  } catch (err) {
    return translate(err, "the code was not accepted");
  }
}

/** Create the recovery with Candide's guardian signature and execute it on
 *  chain (sponsored). The grace period starts when this returns. */
export async function executeRecovery(
  safeAddress: string,
  newOwners: string[],
  newThreshold: number,
  guardianAddress: string,
  guardianSignature: string,
): Promise<RecoveryByGuardianRequest> {
  try {
    return await custodial().createAndExecuteRecoveryRequest(safeAddress, newOwners, newThreshold, guardianAddress, guardianSignature);
  } catch (err) {
    return translate(err, "could not execute the recovery");
  }
}

export async function finalizeRecovery(moduleAddress: string, recoveryRequestId: string): Promise<boolean> {
  try {
    return await byGuardian(moduleAddress).finalizeRecoveryRequest(recoveryRequestId);
  } catch (err) {
    return translate(err, "could not finalize the recovery");
  }
}

/** Candide's view of the Safe's recoveries at the current nonce, for status
 *  reads. Empty when nothing is in flight. */
export async function recoveryRequestsFor(
  moduleAddress: string,
  safeAddress: string,
  status: "PENDING" | "EXECUTED" | "FINALIZED",
): Promise<RecoveryByGuardianRequest[]> {
  try {
    return await byGuardian(moduleAddress).getRecoveryRequestsForLatestNonce(CANDIDE.rpcUrl, safeAddress, status);
  } catch (err) {
    return translate(err, "could not read recovery state from the guardian service");
  }
}
