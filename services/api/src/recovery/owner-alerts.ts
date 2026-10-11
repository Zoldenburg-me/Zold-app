/**
 * Phase 0 of docs/recovery-guardians-plan.md, the email half: tell the
 * account's owner when someone asks to recover the account, and again when
 * a recovery enters its grace period. The grace period plus the owner's
 * passkey-signed cancel is the only defence against a takeover, and the
 * in-app banner reaches only a device where Zold is open.
 *
 * A sweep, not a call from each route: it catches every way a request is
 * made or reaches its grace period (both guardians, Safe Cover picked up by
 * the chain sync), and a failed send is retried at the next one.
 *
 * - One mail per event per request, recorded on the request (`ownerAlerts`).
 * - "Asked": open requests only, at most one per account per window. A
 *   stranger can restart a recovery as often as the rate limit allows (an
 *   email/SMS start supersedes the last), so each restart is marked covered
 *   by the mail already sent rather than mailed again.
 * - "Under way": every request that reaches GRACE_PERIOD, never held back.
 *   A request first seen there gets this mail alone.
 * - A send that fails is retried each sweep up to `maxAttempts`, then given
 *   up and logged. Logs carry the request id, never the address.
 */
import { sendRecoveryAlert, mailAvailable } from "../adapters/mailer.js";
import { store } from "../store.js";
import type { RecoveryRequest } from "../store/types.js";

export const OWNER_ALERTS = {
  /** At most one "asked" mail per account in this window. */
  askedWindowMs: 6 * 3600_000,
  /** Sends tried per request before giving up. */
  maxAttempts: 5,
};

const ASKED = ["PASSKEY_PENDING", "OTP_PENDING", "KYC_PENDING", "REVIEW_PENDING"];

function completesAt(r: RecoveryRequest): Date | undefined {
  const iso = r.zoldenburg?.finalizeAfter ?? r.candide?.finalizeAfter ?? r.turnkey?.finalizeAfter;
  const d = iso ? new Date(iso) : undefined;
  return d && Number.isFinite(d.getTime()) ? d : undefined;
}

/** When this account was last sent an "asked" mail, or marked covered by one. */
function lastAsked(userId: string): number {
  let last = 0;
  for (const r of store.recoveryRequestsForUser(userId)) {
    const t = r.ownerAlerts?.requested ? Date.parse(r.ownerAlerts.requested) : 0;
    if (t > last) last = t;
  }
  return last;
}

/** One request's due mail, or null when nothing is due. */
function due(r: RecoveryRequest, now: Date): "requested" | "executed" | null {
  if (r.mode !== "zoldenburg" && r.mode !== "candide" && r.mode !== "turnkey") return null;
  const a = r.ownerAlerts ?? {};
  if ((a.failures ?? 0) >= OWNER_ALERTS.maxAttempts) return null;
  if (r.status === "GRACE_PERIOD") return a.executed ? null : "executed";
  if (!ASKED.includes(r.status) || a.requested) return null;
  return now.getTime() < Date.parse(r.expiresAt) ? "requested" : null;
}

const mark = (r: RecoveryRequest, patch: NonNullable<RecoveryRequest["ownerAlerts"]>) =>
  store.updateRecoveryRequest(r.id, { ownerAlerts: { ...r.ownerAlerts, ...patch } });

/** What a sent (or covered) mail records: the grace mail says everything
 *  the "asked" one would, so it marks both. */
const sentPatch = (r: RecoveryRequest, kind: "requested" | "executed", at: string) =>
  kind === "executed" ? { requested: r.ownerAlerts?.requested ?? at, executed: at } : { requested: at };

/**
 * Send what is due. Returns how many mails went out. `mailOn` is for tests;
 * by default mail goes out only where the transport is configured.
 */
export async function sweepOwnerAlerts(now = new Date(), { mailOn = mailAvailable() } = {}): Promise<number> {
  if (!mailOn) return 0;
  let sent = 0;
  for (const r of [...store.recoveryRequests]) {
    const kind = due(r, now);
    if (!kind) continue;
    const at = now.toISOString();
    if (kind === "requested" && now.getTime() - lastAsked(r.userId) < OWNER_ALERTS.askedWindowMs) {
      mark(r, { requested: at });
      continue;
    }
    const email = store.findUser(r.userId)?.email;
    if (!email) {
      mark(r, sentPatch(r, kind, at));
      console.error(`recovery alert: ${r.id} ${kind}: the account has no email`);
      continue;
    }
    try {
      await sendRecoveryAlert(email, kind, new Date(r.requestedAt), completesAt(r));
    } catch (err: any) {
      const failures = (r.ownerAlerts?.failures ?? 0) + 1;
      mark(r, { failures });
      // Codes only: the SMTP server's reply can quote the address.
      console.error(`recovery alert: ${r.id} ${kind} failed (${failures}/${OWNER_ALERTS.maxAttempts}): ${err?.code ?? "error"}${err?.responseCode ? ` (SMTP ${err.responseCode})` : ""}`);
      continue;
    }
    mark(r, sentPatch(r, kind, at));
    console.log(`recovery alert: ${r.id} ${kind} sent`);
    sent++;
  }
  return sent;
}
