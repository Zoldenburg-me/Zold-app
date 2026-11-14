/**
 * Send: a new payment run (design canvas "Desk-Send"). Pick the account, pick
 * a saved contact, enter the amount; the summary beside it says what the
 * contact receives and what happens next.
 *
 * An account backed by another member's own account is offered too: the run
 * is drafted here and that member signs it when it is sent, so the card says
 * who sends it.
 *
 * Crypto wallet mode, where the deployment sends to wallets
 * (capabilities().cryptoSend): EURe or the dollar token to a saved contact's
 * wallet address on this network, from the Safe behind the account.
 */
import { Z, api, cap, chainId, esc, eur, gateHtml, maskIban, me, org, reviewOn, roleCan, usdSymbol } from "./core.js";
import { loadMembers } from "./screens.js";
import { META, RENDER } from "./views.js";
import { fundableAccounts, payableContacts } from "./home-model.js";

/** Picked before the form opens: a contact's Pay button, Home's Quick send, or what was typed before Add a contact. */
export const sendState = { contactId: null, amount: "", note: "", mode: "bank" };

/** A contact's wallet on this deployment's network, or undefined. */
export const walletOf = (c, net = chainId) => (c.wallets || []).find((w) => w.chainId === net);

const linkBtn = (label, view, icon) => `<a class="z-btn z-btn--secondary" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const last4 = (iban) => `•••• ${String(iban || "").replace(/\s+/g, "").slice(-4)}`;
/** A contact list long enough to need a search box. */
const FIND_FROM = 6;

META.send = () => ({
  title: "New payment",
  sub: reviewOn()
    ? "It goes to Approvals: someone other than you approves it, then it’s sent with the sender’s passkey."
    : `Save it, then send it from Payments with your ${Z.passkeyName()}.`,
  actions: reviewOn() ? linkBtn("Approvals", "payments", "inbox") : "",
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

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function contactRow(c, checked, net) {
  const sub = net ? shortAddr(walletOf(c, net).address) : last4(c.bankAccounts.find((b) => b.iban).iban);
  return `<label class="zb-pick-row" data-name="${esc(c.name.toLowerCase())}">
    <input type="radio" name="contact" value="${esc(c.id)}"${checked ? " checked" : ""} />
    ${Z.avatar({ name: c.name, tone: "n" })}
    <span class="z-row__main"><span class="z-row__title">${esc(c.name)}</span><span class="z-row__sub z-mono">${esc(sub)}</span></span>
    ${Z.icon("check_circle", "zb-pick-row__check")}</label>`;
}

/** The steps a run goes through here, with the people it waits for. */
function nextSteps(account, approvers, crypto) {
  const who = sender(account);
  const signer = who ? `by ${who}, from their own account` : "by you";
  const sentWith = `It’s sent with ${who ? "their passkey" : `your ${Z.passkeyName()}`} ${signer}.`;
  const names = approvers.map((m) => m.name || m.email).filter(Boolean);
  const approve = names.length
    ? `Someone other than you approves it: ${names.length > 2 ? `${names.slice(0, 2).join(", ")} or another approver` : names.join(" or ")}.`
    : "Someone other than you approves it. Nobody else here can approve yet: an owner can invite an admin in Members.";
  const steps = reviewOn()
    ? [["edit_note", "You submit it. It waits in Approvals."], ["how_to_reg", approve], ["fingerprint", sentWith]]
    : [["edit_note", "You save it. It waits in Payments."], ["fingerprint", sentWith]];
  steps.push(crypto
    ? ["account_balance_wallet", "It leaves as an on-chain payment to their saved wallet address. Its status turns to Paid when the network confirms it."]
    : ["account_balance", "It leaves as a bank transfer. Its status turns to Paid when the bank confirms."]);
  return `<ol class="zb-next">${steps.map(([icon, text]) => `<li>${Z.icon(icon)}<span>${esc(text)}</span></li>`).join("")}</ol>`;
}

/** What an amount field holds as a payable number, or null. Euros take cents;
 *  a token takes six places, as the crypto-send route does. */
export function sendAmount(raw, crypto) {
  const v = String(raw || "").trim().replace(",", ".");
  return (crypto ? /^\d{1,12}(\.\d{1,6})?$/ : /^\d+(\.\d{1,2})?$/).test(v) && Number(v) > 0 ? v : null;
}
const tokenName = (t) => (t === "USDC" ? usdSymbol : "EURe");

function summary(form, accounts, contacts, approvers, net) {
  const crypto = !!net;
  const picked = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const account = accounts.find((a) => a.id === picked("account")) || accounts[0];
  const contact = contacts.find((c) => c.id === picked("contact"));
  const amount = sendAmount(form.elements.amount.value, crypto);
  const shown = amount && (crypto ? `${Number(amount).toLocaleString("en-GB", { maximumFractionDigits: 6 })} ${tokenName(picked("token"))}` : eur(Number(amount)));
  const kv = (k, v, cls = "") => `<div class="zb-kv${cls}"><span>${esc(k)}</span><b>${v}</b></div>`;
  return `<h2 class="zb-h3">Summary</h2>
    ${kv("To", contact ? esc(contact.name) : '<span class="z-dim">Pick a contact</span>')}
    ${crypto && contact ? kv("Wallet", `<span class="z-mono" style="word-break:break-all">${esc(walletOf(contact, net).address)}</span>`) : ""}
    ${kv("From", esc(account.label || account.currency))}
    ${kv("Zold fee", esc(eur(0)))}
    ${kv("They receive", shown ? esc(shown) : '<span class="z-dim">Enter an amount</span>', " zb-kv--total")}
    <h2 class="zb-h3" style="margin-top:20px">What happens next</h2>${nextSteps(account, approvers, crypto)}`;
}

/** The aside row that switches between a bank transfer and a wallet payment. */
const modeRow = (mode, icon, title, sub) => `<div class="z-list z-card"><button type="button" class="z-row" style="width:100%;text-align:left" data-act="send-mode" data-mode="${mode}">${Z.iconTile({ icon })}<span class="z-row__main"><span class="z-row__title">${esc(title)}</span><span class="z-row__sub">${esc(sub)}</span></span>${Z.icon("chevron_right", "z-row__chev")}</button></div>`;

RENDER.send = async () => {
  if (!cap("transfers.drafts").allowed) return gateHtml("transfers.drafts");
  if (!roleCan(org.role, "propose")) return `<div class="gate"><h3>Not for your role</h3><p>As a viewer you can see payments, not propose them.</p></div>`;
  const [{ contacts }, { accounts }, members, health] = await Promise.all([
    api(`/api/orgs/${org.id}/contacts`),
    api(`/api/orgs/${org.id}/accounts`),
    loadMembers(),
    api("/api/health").catch(() => null),
  ]);
  // The control exists only where the API would accept the send.
  const cryptoOn = health?.capabilities?.cryptoSend === true;
  const crypto = cryptoOn && sendState.mode === "crypto";
  const net = health?.chainId ?? chainId;
  const payable = crypto ? contacts.filter((c) => walletOf(c, net)) : payableContacts(contacts);
  const fundable = fundableAccounts(accounts);
  if (!fundable.length) {
    // Nothing here can use Quick send's amount: a later New payment starts empty.
    sendState.amount = "";
    sendState.note = "";
    return `<div class="gate"><h3>No account can pay yet</h3><p>${org.type === "business"
      ? `Connect ${esc(org.name)}’s Monerium profile to an account first.`
      : "Open an account and fund it from your own account first."}</p><div class="zb-actions">${linkBtn("Accounts", "accounts")}</div></div>`;
  }
  if (!payable.length && !crypto) {
    return `<div class="gate"><h3>Add who you’re paying</h3><p>A payment goes to a contact with bank details, so a later change to them is caught before sending.</p><div class="zb-actions"><button type="button" class="z-btn z-btn--primary" data-act="new-contact">${Z.icon("person_add")}<span>Add contact</span></button>${cryptoOn ? `<button type="button" class="z-btn z-btn--secondary" data-act="send-mode" data-mode="crypto">${Z.icon("account_balance_wallet")}<span>Pay a crypto wallet</span></button>` : ""}</div></div>`;
  }
  const approvers = (members || []).filter((m) => m.status === "active" && m.id !== org.memberId && roleCan(m.role, "approve"));
  const first = fundable.find((a) => a.backingUserId === me?.id) || fundable[0];
  const chosen = payable.find((c) => c.id === sendState.contactId)?.id;
  const action = reviewOn() ? "Submit for approval" : "Save payment";
  // Quick send's amount, or what was typed before Add a contact, fills the form once; a later New payment starts empty.
  const amount = sendState.amount;
  const note = sendState.note;

  const addRow = crypto
    ? `<button type="button" class="zb-pick-row zb-pick-row--add" data-act="new-wallet-contact">${Z.iconTile({ icon: "person_add" })}<span class="z-row__main"><span class="z-row__title">Add a wallet contact</span><span class="z-row__sub">An ENS name or 0x address, saved with the contact, so a later change to it is caught before sending.</span></span></button>`
    : `<button type="button" class="zb-pick-row zb-pick-row--add" data-act="new-contact">${Z.iconTile({ icon: "person_add" })}<span class="z-row__main"><span class="z-row__title">Add a contact</span><span class="z-row__sub">A payment goes to a saved contact, so a later change to their bank details is caught before sending.</span></span></button>`;
  const tokenPick = (t, label) => `<label class="zb-pick"><input type="radio" name="token" value="${t}"${t === "EURE" ? " checked" : ""} /><span class="zb-pick__title">${esc(label)}</span></label>`;
  const html = `<div class="zb-send">
    <form class="z-card zb-pad zb-stack" id="send-form" style="gap:20px" novalidate>
      <fieldset class="zb-fieldset"><legend>From</legend><div class="zb-picks">${fundable.map((a) => accountCard(a, a === first)).join("")}</div></fieldset>
      <fieldset class="zb-fieldset"><legend>To</legend>
        ${payable.length >= FIND_FROM ? `<label class="z-sr" for="send-find">Find a contact</label><input id="send-find" type="search" autocomplete="off" placeholder="Find a contact…" style="margin-bottom:10px" />` : ""}
        <div class="z-card zb-pick-list" id="send-contacts">${payable.map((c) => contactRow(c, c.id === chosen, crypto && net)).join("")}
          ${addRow}
        </div></fieldset>
      ${crypto ? `<fieldset class="zb-fieldset"><legend>Send</legend><div class="zb-picks">${tokenPick("EURE", "EURe")}${tokenPick("USDC", usdSymbol)}</div></fieldset>` : ""}
      <div><label for="d-amt">${crypto ? "Amount" : "Amount in euros"}</label><input id="d-amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" value="${esc(amount)}" /></div>
      <div><label for="d-note">Note <span class="desc">(for you; not sent ${crypto ? "with the payment" : "to the bank"})</span></label><input id="d-note" name="reference" autocomplete="off" maxlength="140" placeholder="October timber…" value="${esc(note)}" /></div>
      <p class="zb-err" id="send-err" role="alert"></p>
      <div class="zb-actions"><button type="button" class="z-btn z-btn--primary" data-act="send-create"><span>${action}</span></button>${linkBtn("Cancel", "payments")}</div>
    </form>
    <aside class="zb-send__side">
      <section class="z-card zb-pad" id="send-summary"></section>
      ${!cryptoOn ? "" : crypto
        ? modeRow("bank", "account_balance", "Bank transfer", "Send euros to an IBAN instead")
        : modeRow("crypto", "account_balance_wallet", "Crypto wallet", `Send EURe or ${usdSymbol} to a wallet`)}
    </aside></div>`;

  return {
    html,
    bind(box) {
      // Cleared only by the render that is shown: a superseded one never binds.
      sendState.amount = "";
      sendState.note = "";
      const form = box.querySelector("#send-form");
      const draw = () => { box.querySelector("#send-summary").innerHTML = summary(form, fundable, payable, approvers, crypto && net); };
      draw();
      form.addEventListener("input", (ev) => {
        if (ev.target.id !== "send-find") return draw();
        const q = ev.target.value.trim().toLowerCase();
        box.querySelectorAll("#send-contacts [data-name]").forEach((row) => { row.hidden = !!q && !row.dataset.name.includes(q); });
      });
    },
  };
};
