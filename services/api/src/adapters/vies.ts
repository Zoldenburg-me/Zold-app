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
 * try asks again. Concurrent lookups of one number share one request.
 */
import { VIES } from "../config.js";
import type { VatCheck } from "../domain/invoicing.js";
import { normaliseVatId, vatIdShape } from "../domain/vat-ids.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_CACHED = 5_000;
const cache = new Map<string, { at: number; check: VatCheck }>();
const inFlight = new Map<string, Promise<VatCheck>>();

/** VIES puts "---" where a member state (Germany, Spain) withholds the name. */
const disclosed = (v: unknown) =>
  typeof v === "string" && v.trim() && !/^-+$/.test(v.trim()) ? v.trim().replace(/\s*\n\s*/g, ", ") : undefined;

/** What is already known about a number, without asking VIES. */
export function cachedVatCheck(vatId: string): VatCheck | undefined {
  const hit = cache.get(normaliseVatId(vatId));
  return hit && Date.now() - hit.at < DAY_MS ? hit.check : undefined;
}

export async function checkVatId(vatId: string, requesterVatId?: string): Promise<VatCheck> {
  const id = normaliseVatId(vatId);
  const now = new Date().toISOString();
  const shape = vatIdShape(id);
  if (!shape.ok) return { vatId: id, status: "invalid", checkedAt: now };
  if (!shape.vies) return { vatId: id, status: "not_checkable", checkedAt: now };
  const known = cachedVatCheck(id);
  if (known) return known;
  const pending = inFlight.get(id);
  if (pending) return pending;
  const run = lookup(id, shape.prefix, shape.number, requesterVatId).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
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
    ...(typeof data.requestIdentifier === "string" && data.requestIdentifier ? { requestIdentifier: data.requestIdentifier } : {}),
  };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, { at: Date.now(), check });
  return check;
}
