/**
 * The 1 € step of a Zoldenburg recovery on /recovery: at least 1 € from the
 * bank account the owner confirmed when they set up recovery, to their Zold
 * IBAN, with a reference this page asks for
 * (recovery/zoldenburg-bank-check.ts). Until it arrives, Zoldenburg may not
 * sign.
 *
 * Whoever holds this page has no session, only the request's secret, which
 * anyone who knows the account's email can get: so no digit of either IBAN
 * appears. The plain reference comes back once, from the POST; this page
 * keeps it in sessionStorage for the request, so a reload does not cost one
 * of the request's few references.
 *
 * No DOM; scripts/zoldenburg-bank-check-test.ts runs it.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const ISSUED_KEY = "zold-recovery-bank-ref";

/** The reference this tab was given, if it is still the request's open one. */
export function issuedFor(storage, request) {
  try {
    const v = JSON.parse(storage.getItem(ISSUED_KEY) || "null");
    return v && v.id === request?.id && v.codeIssuedAt === request?.bankCheck?.codeIssuedAt ? v : null;
  } catch { return null; }
}

/** Keep the answer of a bank-code POST for this tab; the plain code is dropped, the memo carries it. */
export function keepIssued(storage, answer) {
  try {
    storage.setItem(ISSUED_KEY, JSON.stringify({ id: answer.id, codeIssuedAt: answer.bankCheck?.codeIssuedAt, memo: answer.memo }));
  } catch { /* storage blocked: the reference shows until a reload */ }
}

/** Has anything the step shows changed between two reads of the request? */
export function bankStepChanged(was, now) {
  const a = was?.bankCheck || {}, b = now?.bankCheck || {};
  return Boolean(a.passed) !== Boolean(b.passed) || a.lastCheck?.at !== b.lastCheck?.at || a.codeIssuedAt !== b.codeIssuedAt || a.canIssueCode !== b.canIssueCode;
}

/** The step's markup. `issued` is this tab's open reference, from issuedFor. */
export function bankStepHtml(request, issued) {
  const b = request?.bankCheck;
  if (!b) return "";
  if (b.passed) return `<p class="r-done">✓ Your 1 € from your bank account arrived.</p>`;
  const details = issued
    ? `<ul class="r-list">
        <li><span>From</span><b>the bank account you set up recovery with</b></li>
        <li><span>To</span><b>your Zold IBAN</b></li>
        <li><span>Amount</span><b>at least ${esc(b.minimumEur)} €</b></li>
        <li><span>Reference</span><b translate="no" id="r-bank-ref">${esc(issued.memo)}</b></li>
      </ul>
      <div class="r-actions"><button type="button" class="z-btn" data-bank="copy">Copy reference</button></div>`
    : b.codeIssuedAt
      ? `<p class="r-note">You got a reference on ${esc(new Date(b.codeIssuedAt).toLocaleString())}. If you sent the 1 € with it, we pick it up on our own.${b.canIssueCode ? " Lost it? Get a new one: a transfer you already sent with an earlier reference still counts." : ""}</p>`
      : "";
  const more = b.codeIssuedAt && b.canIssueCode ? `<button type="button" class="z-btn" data-bank="new">Get a new reference</button>` : "";
  const actions = b.codeIssuedAt
    ? `<button type="button" class="z-btn z-btn--primary" data-bank="check">I sent it — check now</button>${more}`
    : `<button type="button" class="z-btn z-btn--primary" data-bank="new">Show my transfer details</button>`;
  return `
    <h2>First: move ${esc(b.minimumEur)} € to yourself</h2>
    <p>Send at least ${esc(b.minimumEur)} € from the bank account you used when you set up recovery to your Zold IBAN. It’s your own money and lands in your Zold balance; Zold charges nothing. Your Zold IBAN is in your bank’s record of that first transfer, and in your Monerium account.</p>
    <p class="r-warn">Only send this if you started this recovery yourself. Nobody from Zold or Zoldenburg will ask you to.</p>
    ${details}
    ${b.codeIssuedAt && b.lastCheck ? `<p class="r-note" role="status">${esc(b.lastCheck.reason)}</p>` : ""}
    ${b.codeIssuedAt && !b.canIssueCode && !issued ? `<p class="r-note">This recovery has had all its references. Use the last one you sent with, or email support@zoldhq.com.</p>` : ""}
    <div class="r-actions">${actions}</div>`;
}
