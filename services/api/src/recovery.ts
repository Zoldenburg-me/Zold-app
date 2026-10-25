import type { RecoveryRequest } from "./store.js";

/**
 * A recovery request as its starter sees it. Whoever knows the email can start
 * one and hold its secret, so it names no account, Safe, module or guardian;
 * the owner's session reads publicRecoveryRequest.
 */
export function starterRecoveryRequest(request: RecoveryRequest) {
  const { userId: _userId, safeAddress: _safeAddress, guardianAddress: _guardianAddress, recoveryModuleAddress: _module, ...rest } = publicRecoveryRequest(request);
  return rest;
}

/**
 * A recovery request as its owner may see it. The new
 * credential stays private until it is bound, stored secrets never leave, and
 * channel targets are masked: a recovery id is not a licence to read
 * someone's phone number.
 */
export function publicRecoveryRequest(request: RecoveryRequest) {
  const { contact: _contact, reviewedBy: _reviewedBy, reviewReason: _reviewReason, ownerAlerts: _ownerAlerts, candide, zoldenburg, turnkey, ...pub } = request;
  const out: Record<string, unknown> = { ...pub };
  if (candide) {
    const { newPasskey, auths, accessHash: _accessHash, otpTicketHash: _otpTicketHash, ...rest } = candide;
    out.candide = {
      ...rest,
      newPasskeyRegistered: Boolean(newPasskey),
      auths: (auths ?? []).map((a) => ({
        challengeId: a.challengeId,
        channel: a.channel,
        target: maskContact(a.channel, a.target),
        verified: a.verified,
      })),
    };
  }
  if (zoldenburg) {
    // bankCheck holds a code hash; routes/recovery-zoldenburg.ts adds its own view.
    const { newPasskey, accessHash: _accessHash, bankCheck: _bankCheck, ...rest } = zoldenburg;
    out.zoldenburg = { ...rest, newPasskeyRegistered: Boolean(newPasskey) };
  }
  if (turnkey) {
    const { newPasskey, accessHash: _accessHash, ...rest } = turnkey;
    out.turnkey = { ...rest, newPasskeyRegistered: Boolean(newPasskey) };
  }
  return out;
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
