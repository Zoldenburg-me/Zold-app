/**
 * One payment run (design "Transaction Details"): who it pays and from
 * where, what it costs, who drafted and approved it, and what happens next.
 * Read from GET /drafts/:id, the contacts and the accounts; a field none of
 * them holds is left out (payment-model.js).
 *
 * The run's id rides in the address (?view=payment&id=…). A link to it is
 * `<a data-view-link="payment" data-run="…">`; the capture listener below
 * notes the id before the shell's own click handler switches the view.
 */
import { Z, api, cap, esc, eur, gateHtml, maskIban, org, reviewOn, roleCan, view, when } from "./core.js";
import { META, RENDER } from "./views.js";
import { draftTag, draftTitle, draftTotal, loadMembers, mayReview, memberName } from "./screens.js";
import { approvals, bankReference, nextStep, payee, runIdFrom } from "./payment-model.js";

/* Read now: boot drops every query parameter but ?view= before the first render. */
const pd = { id: runIdFrom(location.search, null) };

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-run]");
  // The shell opens a modifier-click in a new tab; this tab keeps its run.
  if (a && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) pd.id = a.dataset.run;
}, true);
document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-pd-print]")) window.print();
});

/** A link to a run's page, for any list that shows runs. */
export const runLink = (id, html) => `<a class="z-tbl__link" href="?view=payment&id=${encodeURIComponent(id)}" data-view-link="payment" data-run="${esc(id)}">${html}</a>`;

const kv = (k, v) => `<div class="zb-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
const copyable = (value, label, shown = value) => `<span class="zb-pd-copy"><span class="z-mono" translate="no">${esc(shown)}</span><button class="z-iconbtn z-iconbtn--bare" type="button" data-z-copy="${esc(value)}" aria-label="Copy ${esc(label)}">${Z.icon("content_copy")}</button></span>`;
const ROLE = { drafted: "Drafted", approved: "Approved", rejected: "Sent back" };
const upper = (t) => t.charAt(0).toUpperCase() + t.slice(1);
/** Shown in groups of four, copied without spaces. */
const grouped = (iban) => iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");

META.payment = () => ({
  title: "Payment",
  sub: "",
  actions: `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=payments" data-view-link="payments">${Z.icon("arrow_back")}<span>${reviewOn() ? "Approvals" : "Payments"}</span></a>
    <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-pd-print>${Z.icon("print")}<span>Print</span></button>
    <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-z-copy="${esc(location.origin + location.pathname)}?view=payment&id=${esc(encodeURIComponent(runIdFrom(location.search, pd.id) || ""))}">${Z.icon("link")}<span>Copy link</span></button>`,
});

function linesHtml(run, contacts, invoices) {
  const many = run.lines.length > 1;
  return run.lines.map((l, i) => {
    const p = payee(l, contacts);
    const ref = bankReference(l, run, org.name, invoices);
    return `${many ? `<h3 class="zb-h3">Payment ${i + 1} of ${run.lines.length}</h3>` : ""}
      ${kv("Beneficiary", esc(p.name))}
      ${p.iban ? kv("IBAN", copyable(p.iban.replace(/\s+/g, ""), "IBAN", grouped(p.iban))) : ""}
      ${p.bic ? kv("BIC", `<span class="z-mono">${esc(p.bic)}</span>`) : ""}
      ${p.wallet ? kv("Wallet", copyable(p.wallet, "wallet address")) : ""}
      ${ref ? kv("Bank reference", `${copyable(ref, "bank reference")}${["EXECUTING", "EXECUTED", "FAILED"].includes(run.state) ? '<br><span class="z-dim">Built from today’s organisation name</span>' : ""}`) : ""}
      ${l.note ? kv("Note", `${esc(l.note)}<br><span class="z-dim">Yours, not sent to the bank</span>`) : ""}
      ${many ? kv("Amount", esc(/^(EUR|EURe)$/i.test(l.asset) ? eur(Number(l.amount)) : `${l.amount} ${l.asset}`)) : ""}`;
  }).join("");
}

function approvalsCard(run) {
  const a = approvals(run, reviewOn());
  const step = (s) => {
    const who = s.memberId ? upper(memberName(s.memberId)) : "An owner or admin";
    const sub = s.at ? esc(when(s.at)) : "Waiting";
    return `<li>${Z.icon(s.done ? "check_circle" : s.role === "rejected" ? "cancel" : "radio_button_unchecked", `zb-h-mark ${s.done ? "is-ok" : "is-unknown"}`)}
      <span class="z-row__main zb-h-checks__main"><span class="z-row__title">${esc(who)} ${Z.tag(s.done || s.role === "rejected" ? ROLE[s.role] : "Approves")}</span><span class="z-row__sub">${sub}${s.reason ? ` · ${esc(s.reason)}` : ""}</span></span></li>`;
  };
  const may = mayReview(run);
  // The same actions, on the same conditions, as the run's row in Approvals (screens.js apRow).
  const btn = (act, label) => `<button type="button" class="z-btn z-btn--primary" data-act="${act}" data-id="${esc(run.id)}">${label}</button>`;
  const act = run.state === "PENDING_REVIEW" && may.allowed ? btn("review-draft", "Review")
    : run.state === "REVIEWED" && roleCan(org.role, "send") ? btn("exec-draft", "Send")
    : run.state === "DRAFT" && roleCan(org.role, "propose") ? (reviewOn() ? btn("submit-draft", "Submit") : roleCan(org.role, "send") ? btn("exec-draft", "Send") : "")
    : run.state === "PENDING_REVIEW" ? `<p class="zb-hint">${esc(may.reason)}</p>` : "";
  return `<section class="z-card zb-side-card" aria-labelledby="pd-appr"><div class="zb-side-card__head"><h2 id="pd-appr">Approvals</h2><span class="z-fig">${a.have} of ${a.needed}</span></div>
    ${a.needed > 1 ? '<p class="zb-hint">Whoever drafts a payment can’t approve it.</p>' : ""}
    <ul class="zb-h-checks">${a.steps.map(step).join("")}</ul>
    ${a.sentBy ? `<p class="zb-hint">Sent by ${esc(memberName(a.sentBy.memberId))}, ${esc(when(a.sentBy.at))}, with ${a.sentBy.memberId === org.memberId ? "your" : "their"} passkey.</p>` : ""}
    ${act}</section>`;
}

RENDER.payment = async () => {
  if (!cap("transfers.drafts").allowed) return gateHtml("transfers.drafts");
  const id = runIdFrom(location.search, pd.id);
  if (!id) return `<div class="gate"><h3>No payment picked</h3><p>Open one from Approvals or Home.</p></div>`;
  const [r, ct, ac, iv] = await Promise.allSettled([
    api(`/api/orgs/${org.id}/drafts/${encodeURIComponent(id)}`),
    api(`/api/orgs/${org.id}/contacts`),
    api(`/api/orgs/${org.id}/accounts`),
    // Only for the reference of a line that pays an invoice; unread, that line shows none.
    cap("invoices").allowed ? api(`/api/orgs/${org.id}/invoices`) : Promise.resolve(null),
    loadMembers(),
  ]);
  if (r.status === "rejected") return `<div class="gate"><h3>Payment not found</h3><p>${esc(r.reason?.message || "It could not be read.")}</p></div>`;
  // The single-run route returns the totals beside the run, not in it.
  const run = { ...r.value.draft, totals: r.value.totals };
  // The address names the run, so a reload or a copied link opens it again.
  // Only while this run is still the one asked for: a slow read must not name a later run's entry.
  if (view === "payment" && pd.id === run.id && !new URLSearchParams(location.search).get("id")) {
    history.replaceState({ view: "payment" }, "", `${location.pathname}?view=payment&id=${encodeURIComponent(run.id)}`);
  }
  const contacts = ct.status === "fulfilled" ? ct.value.contacts : null;
  const invoices = iv.status === "fulfilled" && iv.value ? iv.value.invoices : null;
  const account = run.source.kind === "account" && ac.status === "fulfilled" ? ac.value.accounts.find((a) => a.id === run.source.accountId) : null;
  const wallet = run.source.kind === "wallet";
  const bank = run.lines.every((l) => l.destination.kind === "bank");
  // Euro bank lines go out by SEPA through Monerium, which Zold charges nothing for; other rails are not named here.
  const sepa = bank && run.lines.every((l) => /^(EUR|EURe)$/i.test(l.asset));
  const first = run.lines[0];

  const html = `<div class="zb-pd">
    <section class="z-card zb-pad zb-pd-head" aria-label="Summary">
      <div><p class="zb-pd-tags">${draftTag(run)}</p>
        <h2 class="zb-pd-title">${esc(draftTitle(run))}</h2>
        <p class="zb-hint">Drafted ${esc(when(run.createdAt))} · ${bank ? "Bank transfer" : "Wallet transfer"}${run.lines.length === 1 && bankReference(first, run, org.name, invoices) ? ` · Ref: ${esc(bankReference(first, run, org.name, invoices))}` : ""}</p></div>
      <p class="zb-pd-total">−${esc(draftTotal(run))}</p></section>
    <div class="zb-pd-grid">
      <section class="z-card zb-pad" aria-labelledby="pd-stmt"><h2 class="zb-h3" id="pd-stmt">Transfer</h2>
        ${linesHtml(run, contacts, invoices)}
        ${account ? kv("From", `${esc(account.label || account.currency)}${account.identifier?.iban ? `<br><span class="z-mono z-dim">${esc(maskIban(account.identifier.iban))}</span>` : ""}`)
          : run.source.kind === "account" && ac.status === "rejected" ? kv("From", '<span class="z-dim">The account could not be read just now.</span>') : ""}
        ${wallet ? kv("From", "An imported wallet") : ""}
        ${kv("Method", wallet ? "Prepared here, signed in your own wallet" : sepa ? "SEPA bank transfer, paid out by Monerium" : bank ? "Bank transfer" : "Transfer on chain from the account")}
        ${kv("Next", esc(wallet ? "Approve it in your own wallet. Zold does not send it." : nextStep(run, reviewOn())))}
        <div class="zb-kv zb-kv--total"><span>Total</span><b>−${esc(draftTotal(run))}</b></div>
        ${contacts ? "" : '<p class="zb-hint">The contacts could not be read, so the IBAN and BIC are not shown.</p>'}
        ${bank && contacts ? `<p class="zb-hint">IBAN and BIC are the contact’s as saved now. ${["EXECUTING", "EXECUTED"].includes(run.state) ? "Zold checked them against the drafted details before sending." : "Zold checks them again before sending, and stops the payment if they changed."}</p>` : ""}</section>
      ${approvalsCard(run)}
    </div></div>`;
  return { html };
};
