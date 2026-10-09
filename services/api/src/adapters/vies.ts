/**
 * Ask VIES whether an EU VAT ID is registered, and to whom.
 *
 * A failure to answer is `unavailable`, never `invalid`: member-state
 * services go down for hours, and treating silence as "not registered" would
 * charge VAT that reverse charge says is the customer's. Callers warn on
 * `unavailable`; only VIES saying `valid: false` refuses anything.
 *
 * Sending our own VAT ID as the requester makes VIES return a consultation
 * number, which is the proof a tax office asks for.
 *
 * Valid and invalid answers are kept a day per number (VIES rate-limits, and
 * the editor checks as the user types); unavailable is not kept, so the next
 * try asks again. Concurrent lookups of one number by one requester share
 * one request.
 */
import { VIES } from "../config.js";
import type { VatCheck } from "../domain/invoicing.js";
import { normaliseVatId, vatIdShape } from "../domain/vat-ids.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_CACHED = 5_000;
/** What VIES said about a number, and the consultation number (with its
 *  date) it gave each requester: that number names who asked, so it is never
 *  served to another. */
type Consultation = { requestIdentifier: string; checkedAt: string };
type Entry = { at: number; check: VatCheck; consultations: Map<string, Consultation> };
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<VatCheck>>();

/** The requester VIES is told about, or "" when none is sent. */
function requesterKey(requesterVatId?: string): string {
  const r = requesterVatId ? vatIdShape(requesterVatId) : undefined;
  return r?.ok && r.vies ? `${r.prefix}${r.number}` : "";
}

function freshEntry(id: string): Entry | undefined {
  const hit = cache.get(id);
  return hit && Date.now() - hit.at < DAY_MS ? hit : undefined;
}

/** The answer as one requester may see it: its own consultation number, or none. */
function asSeenBy(entry: Entry, who: string): VatCheck {
  const own = who ? entry.consultations.get(who) : undefined;
  return own?.requestIdentifier ? { ...entry.check, ...own } : entry.check;
}

/** VIES puts "---" where a member state (Germany, Spain) withholds the name. */
const disclosed = (v: unknown) =>
  typeof v === "string" && v.trim() && !/^-+$/.test(v.trim()) ? v.trim().replace(/\s*\n\s*/g, ", ") : undefined;

/** What is already known about a number, without asking VIES; the
 *  consultation number only when this requester was given one. */
export function cachedVatCheck(vatId: string, requesterVatId?: string): VatCheck | undefined {
  const hit = freshEntry(normaliseVatId(vatId));
  return hit ? asSeenBy(hit, requesterKey(requesterVatId)) : undefined;
}

export async function checkVatId(vatId: string, requesterVatId?: string): Promise<VatCheck> {
  const id = normaliseVatId(vatId);
  const now = new Date().toISOString();
  const shape = vatIdShape(id);
  if (!shape.ok) return { vatId: id, status: "invalid", checkedAt: now };
  if (!shape.vies) return { vatId: id, status: "not_checkable", checkedAt: now };
  // A requester VIES has not answered yet asks again, for its own number.
  const who = requesterKey(requesterVatId);
  const hit = freshEntry(id);
  if (hit && (!who || hit.consultations.has(who))) return asSeenBy(hit, who);
  const key = `${id}|${who}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = lookup(id, shape.prefix, shape.number, requesterVatId).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function lookup(id: string, prefix: string, number: string, requesterVatId?: string): Promise<VatCheck> {
  const checkedAt = new Date().toISOString();
  const unavailable: VatCheck = { vatId: id, status: "unavailable", checkedAt };
  if (VIES.url === "off") return unavailable;
  const requester = requesterVatId ? vatIdShape(requesterVatId) : undefined;
  let data: any;
  try {
    const res = await fetch(VIES.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        countryCode: prefix,
        vatNumber: number,
        ...(requester?.ok && requester.vies ? { requesterMemberStateCode: requester.prefix, requesterNumber: requester.number } : {}),
      }),
      signal: AbortSignal.timeout(VIES.timeoutMs),
    });
    data = await res.json().catch(() => undefined);
    if (!res.ok && typeof data?.valid !== "boolean") return unavailable;
  } catch {
    return unavailable;
  }
  // VIES answers 200 with userError MS_UNAVAILABLE, TIMEOUT and the like when
  // the member state's own service is down: that is not a verdict.
  const userError = typeof data?.userError === "string" ? data.userError : undefined;
  if (typeof data?.valid !== "boolean" || (userError && !["VALID", "INVALID"].includes(userError))) return unavailable;
  const check: VatCheck = {
    vatId: id,
    status: data.valid ? "valid" : "invalid",
    checkedAt: typeof data.requestDate === "string" ? data.requestDate : checkedAt,
    ...(disclosed(data.name) ? { name: disclosed(data.name) } : {}),
    ...(disclosed(data.address) ? { address: disclosed(data.address) } : {}),
  };
  const who = requesterKey(requesterVatId);
  const own: Consultation = { requestIdentifier: typeof data.requestIdentifier === "string" ? data.requestIdentifier : "", checkedAt: check.checkedAt };
  // Within the day the entry keeps its answer and its clock; a new requester
  // only adds its own consultation number, so others are not asked again.
  const kept = freshEntry(id);
  const consultations = new Map(kept?.consultations ?? []);
  if (who) consultations.set(who, own);
  const entry: Entry = kept ? { ...kept, consultations } : { at: Date.now(), check, consultations };
  if (!kept && cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, entry);
  return who && own.requestIdentifier ? { ...check, ...own } : check;
}
