/**
 * The last step of Zoldenburg recovery on /guardian: 1 € from a bank account
 * in the person's own name to their Zold IBAN, with a code as the reference
 * (recovery/zoldenburg-enrolment.ts). Until it arrives, Zoldenburg may not
 * sign a recovery for them. The plain code comes back once, from the POST,
 * and lives only in the page; the API keeps its hash.
 *
 * No DOM; scripts/turnkey-guardian-page-test.ts runs it.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = (iso) => new Date(iso).toLocaleDateString();

/**
 * The step's markup for the Zoldenburg card. `e` is the API's enrolment view;
 * `issued` the last POST's answer in this page, if it is still the open code;
 * `ibanReady` whether the person's Zold IBAN is active (the 1 € goes there).
 */
export function enrolmentHtml(e, { issued = null, ibanReady = false } = {}) {
  if (!e) return "";
  if (!e.available) {
    return `<p class="g-note">The last step, confirming your bank account, isn’t open yet. Until it is, Zoldenburg can’t move your account.</p>`;
  }
  const open = issued && issued.codeIssuedAt === e.codeIssuedAt ? issued : null;
  const waiting = e.codeIssuedAt ? `
    ${open ? `<ul class="g-list">
        <li><span>To</span><b translate="no">${esc(open.payTo?.iban)}</b></li>
        <li><span>Name</span><b>${esc(open.payTo?.name)}</b></li>
        <li><span>Amount</span><b>at least ${esc(e.minimumEur)} €</b></li>
        <li><span>Reference</span><b translate="no">${esc(open.memo)}</b></li>
      </ul>
      <div class="g-actions"><button type="button" class="z-btn" data-enrol="copy">Copy reference</button></div>`
    : `<p class="g-note">Your code is valid until ${esc(day(e.codeExpiresAt))}. If you’ve sent it, we pick it up on our own. Lost the code? Get a new one.</p>`}
    ${e.lastCheck ? `<p class="g-note" role="status">${esc(e.lastCheck.reason)}</p>` : ""}
    <div class="g-actions">
      <button type="button" class="z-btn z-btn--primary" data-enrol="check">I sent it — check now</button>
      <button type="button" class="z-btn" data-enrol="new">Get a new code</button>
    </div>` : "";
  if (e.armed) {
    return `<p class="g-note">Your bank account ending ${esc(e.bankAccountLast4)} is confirmed. If you ever need Zoldenburg, you confirm it’s you with 1 € from this account again.</p>
      ${waiting || `<div class="g-actions"><button type="button" class="z-btn" data-enrol="new">Changed banks? Use another account</button></div>`}`;
  }
  return `<p><b>One step left: confirm your bank account.</b> Move ${esc(e.minimumEur)} € from your own bank account to your Zold IBAN, with a code we give you as the reference. It’s your money: it lands in your Zold balance, and nothing is charged.</p>
    <p class="g-note">This tells us which bank account is yours, and it’s how you confirm a recovery later. We keep a fingerprint of the account and its last 4 characters, not the IBAN.</p>
    ${!ibanReady
      ? `<p class="g-note">Your Zold IBAN comes first. Once Monerium has issued it, this step opens here.</p>`
      : waiting || `<div class="g-actions"><button type="button" class="z-btn z-btn--primary" data-enrol="new">Show my transfer details</button></div>`}`;
}

/** A new code, approved with a passkey step-up every time. Returns the POST's answer. */
export async function issueEnrolmentCode({ api, userId, stepUp }) {
  return api(`/api/users/${encodeURIComponent(userId)}/recovery/zoldenburg/enrolment`, { stepUp: await stepUp("recovery.enrolment") });
}

/** Ask Monerium now (at most every few minutes per account; a faster click gets the last answer). */
export function checkEnrolment({ api, userId }) {
  return api(`/api/users/${encodeURIComponent(userId)}/recovery/zoldenburg/enrolment/check`, {});
}
