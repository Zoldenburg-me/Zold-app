/**
 * Send: a new payment run (design canvas "Desk-Send"). Pick the account, pick
 * a saved contact, enter the amount; the summary beside it says what the
 * contact receives and what happens next.
 *
 * An account backed by another member's own account is offered too: the run
 * is drafted here and that member signs it when it is sent, so the card says
 * who sends it.
 */
import { Z, api, cap, esc, eur, gateHtml, maskIban, me, org, roleCan, usdSymbol } from "./core.js";
import { loadMembers } from "./screens.js";
import { META, RENDER } from "./views.js";

export const sendState = { contactId: null };

const linkBtn = (label, view, icon) => `<a class="z-btn z-btn--secondary" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const last4 = (iban) => `•••• ${String(iban || "").replace(/\s+/g, "").slice(-4)}`;
/** A contact list long enough to need a search box. */
const FIND_FROM = 6;

META.send = () => ({
  title: "New payment",
  sub: cap("transfers.approvals").allowed
    ? "It goes to Approvals: someone other than you approves it, then it’s sent with Face ID or fingerprint."
    : "Save it, then send it from Payments with Face ID or fingerprint.",
  actions: cap("transfers.approvals").allowed ? linkBtn("Approvals", "payments", "inbox") : "",
});

/** Who signs a payment from this account: null when it is you. */
const sender = (a) => (a.backingUserId === me?.id ? null : a.backingMemberName || "the member whose account it is");

function accountCard(a, checked) {
  const who = sender(a);
  return `<label class="zb-pick">
    <input type="radio" name="account" value="${esc(a.id)}"${checked ? " checked" : ""} />
    <span class="zb-pick__title">${esc(a.label || a.currency)}</span>
    <span class="zb-pick__sub z-mono">${esc(maskIban(a.identifier?.iban || ""))}</span>
    <span class="zb-pick__sub">${who ? `${esc(who)} sends it` : "Spends from your account"}</span></label>`;
}

function contactRow(c, checked) {
  const iban = c.bankAccounts.find((b) => b.iban).iban;
  return `<label class="zb-pick-row" data-name="${esc(c.name.toLowerCase())}">
    <input type="radio" name="contact" value="${esc(c.id)}"${checked ? " checked" : ""} />
    ${Z.avatar({ name: c.name, tone: "n" })}
    <span class="z-row__main"><span class="z-row__title">${esc(c.name)}</span><span class="z-row__sub z-mono">${esc(last4(iban))}</span></span>
    ${Z.icon("check_circle", "zb-pick-row__check")}</label>`;
}

/** The steps a run goes through here, with the people it waits for. */
function nextSteps(account, approvers) {
  const who = sender(account);
  const signer = who ? `by ${who}, from their own account` : "by you";
  const names = approvers.map((m) => m.name || m.email).filter(Boolean);
  const approve = names.length
    ? `Someone other than you approves it: ${names.length > 2 ? `${names.slice(0, 2).join(", ")} or another approver` : names.join(" or ")}.`
    : "Someone other than you approves it. Nobody else here can approve yet: an owner can invite an admin in Members.";
  const steps = cap("transfers.approvals").allowed
    ? [["edit_note", "You submit it. It waits in Approvals."], ["how_to_reg", approve], ["fingerprint", `It’s sent with Face ID or fingerprint ${signer}.`]]
    : [["edit_note", "You save it. It waits in Payments."], ["fingerprint", `It’s sent with Face ID or fingerprint ${signer}.`]];
  steps.push(["account_balance", "It leaves as a bank transfer. Its status turns to Paid when the bank confirms."]);
  return `<ol class="zb-next">${steps.map(([icon, text]) => `<li>${Z.icon(icon)}<span>${esc(text)}</span></li>`).join("")}</ol>`;
}

function summary(form, accounts, contacts, approvers) {
  const picked = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const account = accounts.find((a) => a.id === picked("account")) || accounts[0];
  const contact = contacts.find((c) => c.id === picked("contact"));
  const raw = form.elements.amount.value.trim().replace(",", ".");
  const amount = /^\d+(\.\d{1,2})?$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  const kv = (k, v, cls = "") => `<div class="zb-kv${cls}"><span>${esc(k)}</span><b>${v}</b></div>`;
  return `<h2 class="zb-h3">Summary</h2>
    ${kv("To", contact ? esc(contact.name) : '<span class="z-dim">Pick a contact</span>')}
    ${kv("From", esc(account.label || account.currency))}
    ${kv("Zold fee", esc(eur(0)))}
    ${kv("They receive", amount ? esc(eur(amount)) : '<span class="z-dim">Enter an amount</span>', " zb-kv--total")}
    <h2 class="zb-h3" style="margin-top:20px">What happens next</h2>${nextSteps(account, approvers)}`;
}

RENDER.send = async () => {
  if (!cap("transfers.drafts").allowed) return gateHtml("transfers.drafts");
  if (!roleCan(org.role, "propose")) return `<div class="gate"><h3>Not for your role</h3><p>As a viewer you can see payments, not propose them.</p></div>`;
  const [{ contacts }, { accounts }, members] = await Promise.all([
    api(`/api/orgs/${org.id}/contacts`),
    api(`/api/orgs/${org.id}/accounts`),
    loadMembers(),
  ]);
  const payable = contacts.filter((c) => c.bankAccounts.some((b) => b.iban));
  const fundable = accounts.filter((a) => a.status === "active" && a.backingUserId && a.profile?.status !== "needs_check");
  if (!fundable.length) {
    return `<div class="gate"><h3>No account can pay yet</h3><p>${org.type === "business"
      ? "Connect the company’s Monerium profile to an account first."
      : "Open an account and fund it from your own account first."}</p><div class="zb-actions">${linkBtn("Accounts", "accounts")}</div></div>`;
  }
  if (!payable.length) {
    return `<div class="gate"><h3>Add who you’re paying</h3><p>A payment goes to a contact with bank details, so a later change to them is caught before sending.</p><div class="zb-actions"><button type="button" class="z-btn z-btn--primary" data-act="new-contact">${Z.icon("person_add")}<span>Add contact</span></button></div></div>`;
  }
  const approvers = (members || []).filter((m) => m.status === "active" && m.id !== org.memberId && roleCan(m.role, "approve"));
  const first = fundable.find((a) => a.backingUserId === me?.id) || fundable[0];
  const chosen = payable.find((c) => c.id === sendState.contactId)?.id;
  const action = cap("transfers.approvals").allowed ? "Submit for approval" : "Save payment";

  const html = `<div class="zb-send">
    <form class="z-card zb-pad zb-stack" id="send-form" style="gap:20px" novalidate>
      <fieldset class="zb-fieldset"><legend>From</legend><div class="zb-picks">${fundable.map((a) => accountCard(a, a === first)).join("")}</div></fieldset>
      <fieldset class="zb-fieldset"><legend>To</legend>
        ${payable.length >= FIND_FROM ? `<label class="z-sr" for="send-find">Find a contact</label><input id="send-find" type="search" autocomplete="off" placeholder="Find a contact…" style="margin-bottom:10px" />` : ""}
        <div class="z-card zb-pick-list" id="send-contacts">${payable.map((c) => contactRow(c, c.id === chosen)).join("")}
          <button type="button" class="zb-pick-row zb-pick-row--add" data-act="new-contact">${Z.iconTile({ icon: "person_add" })}<span class="z-row__main"><span class="z-row__title">Add a contact</span><span class="z-row__sub">A payment goes to a saved contact, so a later change to their bank details is caught before sending.</span></span></button>
        </div></fieldset>
      <div><label for="d-amt">Amount in euros</label><input id="d-amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" /></div>
      <div><label for="d-note">Reference <span class="desc">(on their bank statement)</span></label><input id="d-note" name="reference" autocomplete="off" maxlength="140" placeholder="Invoice 2026-114…" /></div>
      <p class="zb-err" id="send-err" role="alert"></p>
      <div class="zb-actions"><button type="button" class="z-btn z-btn--primary" data-act="send-create"><span>${action}</span></button>${linkBtn("Cancel", "payments")}</div>
    </form>
    <aside class="zb-send__side">
      <section class="z-card zb-pad" id="send-summary"></section>
      <div class="z-list z-card">${Z.soonRow({ lead: Z.iconTile({ icon: "account_balance_wallet" }), title: "Crypto wallet", sub: `Send digital dollars (${usdSymbol}) to a wallet` })}</div>
    </aside></div>`;

  return {
    html,
    bind(box) {
      const form = box.querySelector("#send-form");
      const draw = () => { box.querySelector("#send-summary").innerHTML = summary(form, fundable, payable, approvers); };
      draw();
      form.addEventListener("input", (ev) => {
        if (ev.target.id !== "send-find") return draw();
        const q = ev.target.value.trim().toLowerCase();
        box.querySelectorAll("#send-contacts [data-name]").forEach((row) => { row.hidden = !!q && !row.dataset.name.includes(q); });
      });
    },
  };
};
