/**
 * Phase 1 of docs/recovery-guardians-plan.md, enrolment: the 1 € check that
 * arms Zoldenburg as guardian.
 *
 * Adding the guardian on chain is not enough for the operator to sign for it.
 * The user also sends at least 1 € from their own bank account to their Zold
 * IBAN, with a code we show them as the reference. Monerium reports the payer
 * on the issue order; we keep an HMAC of the payer's IBAN, so that at
 * recovery time a second 1 € must come from the same account. Until then the
 * guardian is on chain but NOT ARMED, and /admin/recoveries refuses to sign
 * for it (routes/recovery-zoldenburg.ts).
 *
 * - The code is a credential: 40 random bits, shown once, stored as a hash.
 * - The payer's name must match the name Monerium verified
 *   (domain/name-match.ts), read live. A payment from the user's own Zold
 *   IBAN proves nothing and is refused.
 * - Stored: the HMAC, the last 4 characters, the order id, the time. Not the
 *   payer's name, not the IBAN.
 * - Fail closed: an unreadable Monerium connection or profile name leaves the
 *   enrolment open with a reason. It never passes on a failed read.
 */
import { createHash, randomBytes } from "node:crypto";
import { store, type User } from "../store.js";
import { normalizeIban } from "../sepa.js";
import { namesMatch } from "../domain/name-match.js";
import { moneriumOrderProcessed } from "../domain/monerium-order.js";
import type { MoneriumOrderLike } from "../domain/invoices.js";
import { moneriumClientFor } from "../adapters/monerium-connection.js";
import { readMoneriumProfile } from "../adapters/monerium-profile.js";
import { describeCause } from "../http/log-cause.js";
import { bankAccountHmac, enrolmentAvailable, ibanKeyId, zoldenburgArmed } from "./enrolment-key.js";

export { bankAccountHmac, enrolmentAvailable, ibanKeyId, zoldenburgArmed };

export const ENROLMENT = {
  /** How long a code waits for its payment. */
  codeTtlMs: 30 * 24 * 3600_000,
  minimumEur: 1,
  /** How often open codes are checked against Monerium. */
  pollMs: 5 * 60_000,
  /** A user's "check now" reaches Monerium at most this often. */
  checkEveryMs: 30_000,
  /** A Monerium read that has not answered by then counts as unreadable. */
  readTimeoutMs: 20_000,
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ---------------------------------------------------------------------------
// the code

const hashCode = (canonical: string) => createHash("sha256").update(`zold/enrolment-code:${canonical}`).digest("hex");

/** Upper case, the letters Crockford reads as digits mapped, separators out. */
const canonical = (s: string) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");

export function newEnrolmentCode(): { code: string; hash: string } {
  let bits = 0n;
  for (const b of randomBytes(5)) bits = (bits << 8n) | BigInt(b);
  let raw = "";
  for (let i = 7; i >= 0; i--) raw += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, hash: hashCode(raw) };
}

/** Does this memo carry the code, however the payer spaced or cased it? */
export function memoCarriesCode(memo: string | undefined, codeHash: string): boolean {
  const s = canonical(memo ?? "");
  for (let i = 0; i + 8 <= s.length; i++) if (hashCode(s.slice(i, i + 8)) === codeHash) return true;
  return false;
}

export const memoFor = (code: string) => `ZOLD ${code}`;

// ---------------------------------------------------------------------------
// judging one order

export type OrderVerdict = { ok: true; iban: string } | { ok: false; reason: string };

/** The payer's name as Monerium reports it: first and last, or one string. */
function payerName(o: MoneriumOrderLike): string | { firstName?: string; lastName?: string } | undefined {
  const d = o.counterpart?.details ?? {};
  if (d.firstName || d.lastName) return { firstName: d.firstName, lastName: d.lastName };
  return d.name || undefined;
}

/**
 * Is this order the user's 1 € from their own bank? `profileName` is the name
 * Monerium verified, read on this check. Only orders that carry the code
 * reach here.
 */
export function judgeEnrolmentOrder(o: MoneriumOrderLike, user: User, profileName: string): OrderVerdict {
  const amount = Number(o.amount);
  if (!Number.isFinite(amount) || amount < ENROLMENT.minimumEur) {
    return { ok: false, reason: `The payment with your code was under ${ENROLMENT.minimumEur} €. Send at least ${ENROLMENT.minimumEur} € with a new code.` };
  }
  const iban = o.counterpart?.identifier?.iban;
  if (!iban) return { ok: false, reason: "Monerium did not report which account the payment came from. Send it again from a bank account in your name." };
  if (user.iban && normalizeIban(iban) === normalizeIban(user.iban)) {
    return { ok: false, reason: "The payment came from your Zold IBAN. Send it from your own bank account instead." };
  }
  const name = payerName(o);
  if (!name) return { ok: false, reason: "Monerium did not report the payer's name. Send it again from a bank account in your name." };
  if (!namesMatch(profileName, name)) {
    return { ok: false, reason: "The name on the paying account does not match the name Monerium verified for you." };
  }
  return { ok: true, iban: normalizeIban(iban) };
}

/** The orders that could be this code's payment: processed EURe issues to
 *  this account's Safe, after the code was issued, carrying the code. */
export function candidateOrders(orders: MoneriumOrderLike[], user: User): MoneriumOrderLike[] {
  const code = user.zoldenburgEnrolment?.code;
  const safe = user.passkeySafe?.address?.toLowerCase();
  if (!code || !safe) return [];
  const since = Date.parse(code.issuedAt);
  return orders
    .filter((o) =>
      o.kind === "issue" &&
      moneriumOrderProcessed(o.meta?.state ?? o.state) &&
      String(o.currency ?? "eur").toLowerCase() === "eur" &&
      String(o.address ?? "").toLowerCase() === safe &&
      Date.parse(o.meta?.processedAt ?? "") >= since &&
      memoCarriesCode(o.memo, code.hash))
    .sort((a, b) => Date.parse(a.meta!.processedAt!) - Date.parse(b.meta!.processedAt!));
}

// ---------------------------------------------------------------------------
// the check

export interface EnrolmentReads {
  orders: (user: User) => Promise<MoneriumOrderLike[]>;
  profileName: (user: User) => Promise<string | undefined>;
}

const profileIdOf = (u: User) => u.monerium?.profileId ?? u.funding?.moneriumProfileId;

/** The reads, given how to reach Monerium; tests hand in fakes. A response
 *  in neither known shape throws rather than reading as "no orders yet". */
export function moneriumReadsWith(
  clientFor: (user: User) => { orders(profile?: string): Promise<unknown> },
  readProfile: (user: User, profileId: string) => Promise<{ name?: string }>,
): EnrolmentReads {
  return {
    async orders(user) {
      const res: any = await clientFor(user).orders(profileIdOf(user));
      if (Array.isArray(res)) return res;
      if (Array.isArray(res?.orders)) return res.orders;
      throw new Error("Monerium answered the order list in an unknown shape");
    },
    async profileName(user) {
      const id = profileIdOf(user);
      if (!id) return undefined;
      return (await readProfile(user, id)).name;
    },
  };
}

export const moneriumReads: EnrolmentReads = moneriumReadsWith(moneriumClientFor as any, readMoneriumProfile);

/** A read that does not answer in time fails, so one stuck call cannot hold
 *  an account's checks, or the sweep, forever. */
function inTime<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from Monerium in ${ENROLMENT.readTimeoutMs / 1000}s`)), ENROLMENT.readTimeoutMs);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type EnrolmentOutcome = "enrolled" | "waiting" | "mismatch" | "unreadable" | "no_code";

const inFlight = new Set<string>();

/**
 * Look for the payment of this user's open code and record what was found.
 * Enrolment replaces an earlier one only on a match; a failed re-enrolment
 * leaves the account armed as before.
 */
export async function checkEnrolment(userId: string, reads: EnrolmentReads = moneriumReads, now = new Date()): Promise<EnrolmentOutcome> {
  const user = store.findUser(userId);
  const code = user?.zoldenburgEnrolment?.code;
  if (!user || !code || now.getTime() >= Date.parse(code.expiresAt) || !enrolmentAvailable()) return "no_code";
  if (inFlight.has(userId)) return "waiting";
  inFlight.add(userId);
  const record = (outcome: "waiting" | "mismatch" | "unreadable", reason: string) => {
    const fresh = store.findUser(userId)!;
    // A newer code issued while this check ran owns the row now.
    if (fresh.zoldenburgEnrolment?.code?.hash !== code.hash) return outcome;
    store.updateUser(userId, { zoldenburgEnrolment: { ...fresh.zoldenburgEnrolment, lastCheck: { at: now.toISOString(), outcome, reason } } });
    return outcome;
  };
  try {
    let orders: MoneriumOrderLike[];
    try {
      orders = await inTime(reads.orders(user));
    } catch (err) {
      console.warn(`enrolment: could not read orders for ${user.id}: ${describeCause(err)}`);
      return record("unreadable", "We could not read your payments at Monerium. If this stays, connect Monerium again.");
    }
    const found = candidateOrders(orders, user);
    if (!found.length) return record("waiting", "No payment with your code has arrived yet. A bank transfer can take a working day.");
    let name: string | undefined;
    try {
      name = await inTime(reads.profileName(user));
    } catch (err) {
      console.warn(`enrolment: could not read the Monerium profile for ${user.id}: ${describeCause(err)}`);
    }
    if (!name) return record("unreadable", "Your payment arrived, but we could not read your verified name at Monerium. We will try again.");
    let reason = "";
    for (const o of found) {
      const verdict = judgeEnrolmentOrder(o, user, name);
      if (!verdict.ok) {
        reason = verdict.reason;
        continue;
      }
      if (store.findUser(userId)!.zoldenburgEnrolment?.code?.hash !== code.hash) return "no_code";
      // The code is spent: the new row replaces the old one whole.
      store.updateUser(userId, {
        zoldenburgEnrolment: {
          bankAccountHmac: bankAccountHmac(verdict.iban),
          keyId: ibanKeyId(),
          bankAccountLast4: verdict.iban.slice(-4),
          orderId: o.id,
          enrolledAt: now.toISOString(),
        },
      });
      console.log(`enrolment: ${user.id} armed Zoldenburg recovery (order ${o.id})`);
      return "enrolled";
    }
    return record("mismatch", reason);
  } finally {
    inFlight.delete(userId);
  }
}

/** Check every open code. Returns how many accounts were armed. */
export async function sweepEnrolments(reads: EnrolmentReads = moneriumReads, sweepNow?: Date): Promise<number> {
  if (!enrolmentAvailable()) return 0;
  let armed = 0;
  for (const u of [...store.users]) {
    const code = u.zoldenburgEnrolment?.code;
    // Each account's own time: a slow sweep must not judge a later account
    // by the clock at its start.
    const now = sweepNow ?? new Date();
    if (!code || now.getTime() >= Date.parse(code.expiresAt)) continue;
    // One account's failure is logged and the sweep goes on to the next.
    try {
      if ((await checkEnrolment(u.id, reads, now)) === "enrolled") armed++;
    } catch (err) {
      console.error(`enrolment: check failed for ${u.id}: ${describeCause(err)}`);
    }
  }
  return armed;
}

// ---------------------------------------------------------------------------
// what the owner sees

export function enrolmentView(user: User, now = new Date()) {
  const e = user.zoldenburgEnrolment;
  const open = e?.code && now.getTime() < Date.parse(e.code.expiresAt) ? e.code : undefined;
  return {
    available: enrolmentAvailable(),
    armed: zoldenburgArmed(user),
    minimumEur: ENROLMENT.minimumEur,
    ...(e?.enrolledAt ? { enrolledAt: e.enrolledAt, bankAccountLast4: e.bankAccountLast4 } : {}),
    ...(open ? { codeIssuedAt: open.issuedAt, codeExpiresAt: open.expiresAt } : {}),
    ...(open && e?.lastCheck ? { lastCheck: e.lastCheck } : {}),
  };
}

/** Issue a code, replacing any open one. The plain code is returned once. */
export function issueEnrolmentCode(user: User, now = new Date()): { code: string; memo: string } {
  const { code, hash } = newEnrolmentCode();
  const { lastCheck: _drop, ...rest } = store.findUser(user.id)!.zoldenburgEnrolment ?? {};
  store.updateUser(user.id, {
    zoldenburgEnrolment: {
      ...rest,
      code: { hash, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ENROLMENT.codeTtlMs).toISOString() },
    },
  });
  return { code, memo: memoFor(code) };
}
