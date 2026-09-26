/**
 * Append-only audit log for decisions that must be explainable later.
 *
 * In: the segment decision and its inputs, the US questionnaire answers,
 * consent events, partner account ids, and partner webhook events: what a
 * regulator or a user would need to reconstruct why an account was refused.
 *
 * Never in (enforced by sanitise()): a PAN, a bank account number, an OAuth
 * token, a session token. `redact()` stores `sha256:<12 hex>`, enough to show
 * two entries concern the same value without revealing it.
 *
 * There is no update or delete method, and there must not be one.
 *
 * Storage is the same JSON store as everything else: fine for a demo or a
 * small deployment, not a tamper-evident ledger. A real deployment ships these
 * to an append-only sink.
 */
import { createHash, randomUUID } from "node:crypto";

export type AuditKind =
  | "segment.decided"
  | "segment.changed_by_admin"
  | "us_questions.answered"
  | "consent.given"
  | "partner.account_created"
  | "partner.webhook_received"
  | "partner.call_refused"
  /** A user connected or removed credentials of their own for a partner. */
  | "partner.credentials_connected"
  | "partner.credentials_removed"
  /** Belege pushed to an accounting inbox; counts only, never a key. */
  | "partner.documents_pushed";

export interface AuditEntry {
  id: string;
  at: string;
  kind: AuditKind;
  userId?: string;
  /** Free-form, already redacted by the caller via `redact`. */
  data: Record<string, unknown>;
}

/** One-way, stable, and short enough to read. Same input -> same digest, so two
 *  entries about one value can be tied together without holding the value. */
export function redact(value: unknown): string {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

/** Keys that must never be written in the clear, whatever a caller passes. */
const FORBIDDEN = /^(pan|panNumber|accountNumber|bankAccount|iban|token|jwt|apiKey|sessionToken|password|secret)$/i;

/**
 * Copy a record, hashing anything whose key looks sensitive.
 *
 * A denylist, because with an allowlist a caller's new field would be dropped
 * from the audit trail with no error. Forbidden keys are hashed, not omitted,
 * so the entry still records that e.g. a PAN was involved.
 */
export function sanitise(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (FORBIDDEN.test(k)) out[k] = redact(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = sanitise(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}


export function auditEntry(
  kind: AuditKind,
  data: Record<string, unknown>,
  userId?: string,
): AuditEntry {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind,
    ...(userId ? { userId } : {}),
    data: sanitise(data),
  };
}
