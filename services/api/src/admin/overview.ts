/**
 * The operator dashboard's derived views: one issues feed and the overview
 * counts. Everything is read from the store at request time; nothing here
 * writes.
 *
 * An issue is something an operator may need to act on, from wherever it was
 * recorded: a server 500 (by ref, in memory), a transfer that failed or has
 * not moved, a refused deposit, a Monerium refusal or provisioning error, a
 * recovery that would not finalize, a partner call refused by policy.
 */
import { CHAIN_ID } from "../config.js";
import { store, type User } from "../store.js";
import { recentServerErrors } from "../http/error-log.js";
import { moneriumProfileState, onboardingOf, recoveryEnrolment, safeIsLive } from "./onboarding.js";

/** In flight and untouched for this long reads as stuck. */
export const STALE_MS = 30 * 60_000;
const ATTENTION = new Set(["FAILED", "REFUNDED", "MANUAL_REVIEW"]);
const TERMINAL = new Set(["PAID", ...ATTENTION]);

export interface Issue {
  id: string;
  source: "server" | "transfer" | "deposit" | "monerium" | "recovery" | "policy";
  severity: "error" | "warning";
  at: string;
  title: string;
  detail?: string;
  userId?: string;
  userName?: string;
  /** What the dashboard opens: a transfer, a user, a recovery, a server ref. */
  target?: { kind: "transfer" | "user" | "recovery" | "server"; id: string };
}

export function issues(now = Date.now()): Issue[] {
  const name = (id?: string) => (id ? store.findUser(id)?.name : undefined);
  const out: Issue[] = [];

  for (const e of recentServerErrors()) {
    out.push({
      id: `server:${e.ref}`, source: "server", severity: "error", at: e.at,
      title: `${e.status} ${e.method} ${e.route}`, detail: `${e.name}: ${e.message}`,
      target: { kind: "server", id: e.ref },
    });
  }

  for (const t of store.transfers) {
    const at = t.updatedAt || t.createdAt;
    if (ATTENTION.has(t.state)) {
      out.push({
        id: `transfer:${t.id}`, source: "transfer", severity: t.state === "REFUNDED" ? "warning" : "error", at,
        title: `Transfer ${t.state.toLowerCase().replace("_", " ")}`,
        detail: t.error ?? t.sepa?.detail ?? t.refund?.deductions,
        userId: t.userId, userName: name(t.userId), target: { kind: "transfer", id: t.id },
      });
    } else if (!TERMINAL.has(t.state) && now - Date.parse(at) > STALE_MS) {
      out.push({
        id: `stuck:${t.id}`, source: "transfer", severity: "warning", at,
        title: `Transfer stuck in ${t.state}`, detail: t.sepa?.detail ?? t.sepa?.state,
        userId: t.userId, userName: name(t.userId), target: { kind: "transfer", id: t.id },
      });
    }
  }

  for (const d of store.cryptoDeposits) {
    if (d.state !== "REFUSED" && d.state !== "UNCONFIRMED") continue;
    out.push({
      id: `deposit:${d.id}`, source: "deposit", severity: "warning", at: d.updatedAt || d.detectedAt,
      title: d.state === "UNCONFIRMED" ? `${d.token} conversion unconfirmed` : `${d.token} deposit refused`, detail: d.reason,
      userId: d.userId, userName: name(d.userId), target: { kind: "transfer", id: d.id },
    });
  }

  for (const u of store.users) {
    if (u.moneriumRefusal) {
      out.push({
        id: `refusal:${u.id}`, source: "monerium", severity: "warning", at: u.moneriumRefusal.at,
        title: `Monerium connect refused (${u.moneriumRefusal.code})`, detail: u.moneriumRefusal.error,
        userId: u.id, userName: u.name, target: { kind: "user", id: u.id },
      });
    }
    if (u.funding?.status === "error" || u.funding?.addressUnlinkable) {
      out.push({
        id: `funding:${u.id}`, source: "monerium", severity: "error", at: u.monerium?.connectedAt ?? u.createdAt,
        title: u.funding.addressUnlinkable ? "Monerium will not link this Safe address" : "Monerium provisioning error",
        detail: u.funding.detail, userId: u.id, userName: u.name, target: { kind: "user", id: u.id },
      });
    }
  }

  for (const r of store.recoveryRequests) {
    const finalizeError = r.zoldenburg?.finalizeError ?? r.candide?.finalizeError;
    if (!finalizeError || r.status === "FINALIZED" || r.status === "CANCELED") continue;
    out.push({
      id: `recovery:${r.id}`, source: "recovery", severity: "error", at: r.zoldenburg?.finalizeAfter ?? r.requestedAt,
      title: `Recovery would not finalize${r.zoldenburg?.reference ? ` (${r.zoldenburg.reference})` : ""}`,
      detail: `${finalizeError}${r.zoldenburg?.finalizeAttempts ? ` — ${r.zoldenburg.finalizeAttempts} attempts` : ""}`,
      userId: r.userId, userName: name(r.userId), target: { kind: "recovery", id: r.id },
    });
  }

  for (const e of store.auditFor(undefined, 2000)) {
    if (e.kind !== "partner.call_refused") continue;
    out.push({
      id: `policy:${e.id}`, source: "policy", severity: "warning", at: e.at,
      title: `Partner call refused${e.data.partner ? ` (${e.data.partner})` : ""}`,
      detail: Object.entries(e.data).filter(([k]) => k !== "partner").map(([k, v]) => `${k}: ${v}`).join(" · "),
      userId: e.userId, userName: name(e.userId), target: e.userId ? { kind: "user", id: e.userId } : undefined,
    });
  }

  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const dayKey = (iso?: string) => (iso ? iso.slice(0, 10) : "");

/** Counts per day for the last `days` days, oldest first. */
function perDay(dates: (string | undefined)[], days: number, now: number) {
  const keys = Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const d of dates) {
    const k = dayKey(d);
    if (counts.has(k)) counts.set(k, counts.get(k)! + 1);
  }
  return keys.map((day) => ({ day, count: counts.get(day)! }));
}

function tally<T>(items: T[], key: (x: T) => string | undefined) {
  const out: Record<string, number> = {};
  for (const x of items) {
    const k = key(x) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function overview(now = Date.now()) {
  const users = store.users;
  const transfers = store.transfers;
  const zRecoveries = store.recoveryRequests.filter((r) => r.mode === "zoldenburg");
  const list = issues(now);
  const since = (ms: number) => (iso: string) => now - Date.parse(iso) <= ms;
  const paid = transfers.filter((t) => t.state === "PAID");
  const volume = (ms: number) => paid.filter((t) => since(ms)(t.updatedAt)).reduce((s, t) => s + (t.sendEur || 0), 0);

  return {
    chainId: CHAIN_ID,
    generatedAt: new Date(now).toISOString(),
    users: {
      total: users.length,
      new7d: users.filter((u) => since(7 * 86_400_000)(u.createdAt)).length,
      stages: tally(users, (u: User) => onboardingOf(u).stage),
      kyc: tally(users, (u: User) => u.kycStatus),
      safesLive: users.filter(safeIsLive).length,
      withIban: users.filter((u) => u.kycStatus === "approved" && u.iban).length,
      signups: perDay(users.map((u) => u.createdAt), 14, now),
    },
    monerium: {
      connected: users.filter((u) => u.monerium?.connectedAt).length,
      methods: tally(users.filter((u) => u.monerium), (u: User) => u.monerium?.method ?? (u.monerium?.accessTokenEnc ? "oauth" : undefined)),
      profileStates: tally(users.filter((u) => u.monerium || u.funding?.moneriumProfileId), moneriumProfileState),
      refusals: users.filter((u) => u.moneriumRefusal).length,
      issueOrders: store.moneriumIssueOrders.length,
      issuedEur: store.moneriumIssueOrders.reduce((s, r) => s + (r.amountEur || 0), 0),
    },
    transfers: {
      total: transfers.length,
      states: tally(transfers, (t) => t.state),
      paid: paid.length,
      volume7dEur: volume(7 * 86_400_000),
      volume30dEur: volume(30 * 86_400_000),
      volumeEur: paid.reduce((s, t) => s + (t.sendEur || 0), 0),
      perDay: perDay(transfers.map((t) => t.createdAt), 14, now),
    },
    recoveries: {
      statuses: tally(zRecoveries, (r) => r.status),
      open: zRecoveries.filter((r) => ["PASSKEY_PENDING", "REVIEW_PENDING", "GRACE_PERIOD"].includes(r.status)).length,
      enrolment: tally(users.filter(safeIsLive), (u: User) => recoveryEnrolment(u).zoldenburg),
    },
    issues: {
      total: list.length,
      errors: list.filter((i) => i.severity === "error").length,
      last24h: list.filter((i) => since(86_400_000)(i.at)).length,
      bySource: tally(list, (i) => i.source),
      latest: list.slice(0, 8),
    },
  };
}
