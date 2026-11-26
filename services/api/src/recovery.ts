import { randomUUID } from "node:crypto";
import { store, type RecoveryRequest } from "./store.js";

/** The statuses a relay reserve can come from: an execute (Candide's OTP,
 *  a Turnkey or Zoldenburg approval) or a finalisation. */
export type RelayFrom = NonNullable<RecoveryRequest["relaying"]>["from"];

/**
 * How long a relay may hold RELAYING before the sweep asks the chain. The
 * relay call is bounded at about 3.5 minutes: viem's send makes six RPC
 * requests (chain id, block, priority fee, nonce, gas estimate, the raw
 * send), each at most 10 s with one retry (recovered-passkey.ts), and the
 * receipt wait is 90 s (recovery/zoldenburg-guardian.ts); Candide's
 * execute and finalize calls are bounded by PARTNER_TIMEOUT_MS
 * (recovery/candide-guardian.ts `bounded`). Once the receipt is in, the chain shows the relay and the sweep moves the row on, not back. So
 * a row still RELAYING after this was cut off (a restart, a crash).
 */
export const RELAY_TIMEOUT_MS = 10 * 60_000;

/** The reserve a relay claims before its chain call (§2 rule 5). The token
 *  is this claim's own: its outcome and its release write only over it, so a
 *  caller that ends late cannot clear a reserve the sweep or another caller
 *  took after its own was given back. */
export const relayFrom = (from: RelayFrom) => ({ status: "RELAYING" as const, relaying: { from, at: new Date().toISOString(), token: randomUUID() } });

/** The reserve a caller holds: what its release and outcome write over. */
export type Relay = NonNullable<RecoveryRequest["relaying"]>;

/** A relay that ended with nothing on chain gives the request back to the
 *  status it came from. A no-op once its own reserve is gone (the outcome
 *  moved it on, or it was released and someone else claimed it). */
export async function releaseRelay(id: string, held: Relay, patch: Partial<RecoveryRequest> = {}) {
  return store.updateRecoveryRelay(id, held.token ?? "", { ...patch, status: held.from, relaying: undefined });
}

/** Claim the reserve from `from` (one conditional write, committed before
 *  the call); the reserve held, or null when the request is no longer there. */
export async function claimRelay(id: string, from: RelayFrom): Promise<Relay | null> {
  const claimed = await store.updateRecoveryRequestFrom(id, [from], relayFrom(from));
  return claimed?.relaying ?? null;
}

/** The call's outcome, written only over the reserve it holds. Null when
 *  that reserve was ended meanwhile (an on-chain cancel, a stale-relay reconcile). */
export const endRelay = (id: string, held: Relay, patch: Partial<RecoveryRequest>) =>
  store.updateRecoveryRelay(id, held.token ?? "", { ...patch, relaying: undefined });

/** A reserve older than RELAY_TIMEOUT_MS (wall clock) was cut off. */
export const relayStale = (r: RecoveryRequest) => Date.now() - Date.parse(r.relaying?.at ?? r.requestedAt) >= RELAY_TIMEOUT_MS;

/**
 * A recovery request as its starter sees it. Whoever knows the email can start
 * one and hold its secret, so it names no account, Safe, module or guardian;
 * the owner's session reads publicRecoveryRequest.
 */
export function starterRecoveryRequest(request: RecoveryRequest) {
  const { userId: _userId, safeAddress: _safeAddress, guardianAddress: _guardianAddress, recoveryModuleAddress: _module, ...rest } = publicRecoveryRequest(request);
  // The new owner set is the starter's own key, but /recovery never reads it: no address leaves.
  for (const mode of ["candide", "zoldenburg"] as const) {
    if (rest[mode]) {
      const { newOwners: _newOwners, ...sub } = rest[mode] as Record<string, unknown>;
      rest[mode] = sub;
    }
  }
  return rest;
}

/**
 * A recovery request as its owner may see it. The new
 * credential stays private until it is bound, stored secrets never leave, and
 * channel targets are masked: a recovery id is not a licence to read
 * someone's phone number.
 */
export function publicRecoveryRequest(request: RecoveryRequest) {
  const { contact: _contact, reviewedBy: _reviewedBy, reviewReason: _reviewReason, ownerAlerts: _ownerAlerts, relaying, candide, zoldenburg, turnkey, ...pub } = request;
  // A relay runs for seconds; it shows as the status it came from, as before.
  const out: Record<string, unknown> = { ...pub, ...(request.status === "RELAYING" && relaying ? { status: relaying.from } : {}) };
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
