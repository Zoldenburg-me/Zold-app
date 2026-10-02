/** Keep enough of a payee identifier (IBAN, phone) to recognise it, never the
 *  whole value: the ops views poll, and a full list of third parties' IBANs
 *  on every tick is more than an operator needs to tell rows apart. */
export function maskIdentifier(v?: string): string | undefined {
  if (!v) return v;
  const s = String(v).replace(/\s+/g, "");
  return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-2)}`;
}
