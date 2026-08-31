/**
 * Append-only audit log for decisions that must be explainable later.
 *
 * WHAT GOES IN: the segment decision and the inputs that produced it, the US
 * questionnaire answers, consent events, partner account ids, and partner
 * webhook events. These are the things someone will one day have to
 * reconstruct — a regulator asking why an account was refused, or a user asking
 * why they were. A decision nobody can replay is a decision nobody can defend.
 *
 * WHAT NEVER GOES IN, and this is enforced rather than requested: a PAN, a bank
 * account number, an OAuth token, a session token. `redact()` hashes anything
 * marked sensitive and stores `sha256:<12 hex>` — enough to prove two entries
 * concern the same value, useless to anyone who reads the log. The point of an
 * audit log is to survive being read by the wrong person.
 *
 * APPEND-ONLY IS THE PROPERTY, and it is structural: there is no update method
 * and no delete method, deliberately. A log a process can edit is a log that
 * proves nothing.
 *
 * Storage is the same JSON store as everything else, which is honest about what
 * this is: durable enough to answer questions in a demo or a small deployment,
 * and not a tamper-evident ledger. A real deployment ships these to an
 * append-only sink. Said here rather than implied.
 */
import { createHash, randomUUID } from "node:crypto";

export type AuditKind =
  | "segment.decided"
  | "segment.changed_by_admin"
  | "us_questions.answered"
  | "consent.given"
  | "partner.account_created"
  | "partner.webhook_received"
  | "partner.call_refused";

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
 * A denylist is weaker than an allowlist and is used here on purpose: the
 * alternative is that a caller adding a field silently gets it dropped from the
 * audit trail, which is the worse failure for a log whose job is completeness.
 * The forbidden keys are hashed, never omitted — so the entry still records
 * that a PAN was involved.
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

export interface AuditSink {
  append(entry: AuditEntry): void;
  list(userId?: string, limit?: number): AuditEntry[];
}

/**
 * Build the log over whatever store is passed in.
 *
 * Injected rather than importing the store, so the tests exercise the real
 * redaction and ordering against an array instead of a file, and so nothing
 * here can reach for a user record it should not read.
 */
export function createAuditLog(rows: AuditEntry[], persist: () => void): AuditSink {
  return {
    append(entry) {
      rows.push(entry);
      persist();
    },
    list(userId, limit = 200) {
      const filtered = userId ? rows.filter((r) => r.userId === userId) : rows;
      return filtered.slice(-limit).reverse();
    },
  };
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
