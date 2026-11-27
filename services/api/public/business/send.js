/**
 * Send: a new payment run (design canvas "Desk-Send"). Pick the account, pick
 * one or more saved contacts, enter each one's amount and note; the summary
 * beside it says who receives what and what happens next. The payees are
 * saved as the lines of one draft (send-model.js builds them).
 *
 * An account backed by another member's own account is offered too: the run
 * is drafted here and that member signs it when it is sent, so the card says
 * who sends it.
 *
 * Crypto wallet mode, where the deployment sends to wallets
 * (capabilities().cryptoSend): EURe or the dollar token to one saved contact's
 * wallet address on this network, from the Safe behind the account. A wallet
 * run has exactly one line (walletRunProblem, routes/business/drafts.ts).
 */
import { Z, api, cap, chainId, esc, eur, gateHtml, maskIban, me, org, reviewOn, roleCan, usdSymbol } from "./core.js";
import { loadMembers } from "./screens.js";
import { META, RENDER, linkBtn } from "./views.js";
import { companyBankAccounts, fundableAccounts, payableContacts } from "./home-model.js";
import { bankOf, maxPayees, openingRows, payeesTotal, sendAmount, setPayee } from "./send-model.js";

/** Picked before the form opens: a contact's Pay button, or what was typed
 *  and picked before Add a contact (a bank payment's payees and its account). */
export const sendState = { contactId: null, amount: "", note: "", mode: "bank", rows: [], accountId: null };

/** A contact's wallet on this deployment's network, or undefined. */
export const walletOf = (c, net = chainId) => (c.wallets || []).find((w) => w.chainId === net);

const last4 = (iban) => `•••• ${String(iban || "").replace(/\s+/g, "").slice(-4)}`;
/** A contact list long enough to need a search box. */
const FIND_FROM = 6;

META.send = () => {
  // A company's bank payment has no review step, whatever the org's review
  // setting (Q8): an owner sends it from Payments.
  const ownerSends = org?.entity === "company" && sendState.mode !== "crypto";
  const review = reviewOn() && !ownerSends;
  return {
    title: "New payment",
    sub: ownerSends
      ? "Save it. An owner sends it from Payments with their passkey; no second approval is needed."
      : review
        ? "It goes to Approvals: someone other than you approves it, then it’s sent with the sender’s passkey."
        : `Save it, then send it from Payments with your ${Z.passkeyName()}.`,
    actions: review ? linkBtn("Approvals", "payments", "inbox") : "",
  };
};

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

/** A contact to pick: one of many for a bank payment, the one for a wallet. */
function contactRow(c, checked, net) {
  const sub = net ? shortAddr(walletOf(c, net).address) : last4(bankOf(c).iban);
  return `<label class="zb-pick-row" data-name="${esc(c.name.toLowerCase())}">
    <input type="${net ? "radio" : "checkbox"}" name="contact" value="${esc(c.id)}"${checked ? " checked" : ""} />
    ${Z.avatar({ name: c.name, tone: "n" })}
    <span class="z-row__main"><span class="z-row__title">${esc(c.name)}</span><span class="z-row__sub z-mono">${esc(sub)}</span></span>
    ${Z.icon("check_circle", "zb-pick-row__check")}</label>`;
}

/** The steps a run goes through here, with the people it waits for. */
function nextSteps(account, approvers, crypto, payees = 1) {
  // A company's bank payment: an owner's passkey is the approval (Q8).
  if (org.entity === "company" && !crypto) {
    const steps = [
      ["edit_note", "You save it. It waits in Payments."],
      ["fingerprint", payees > 1
        ? `An owner sends it with their ${Z.passkeyName()}, one prompt per payee: ${payees} prompts. No second approval is needed.`
        : `An owner sends it with their ${Z.passkeyName()}. No second approval is needed.`],
      ["account_balance", payees > 1
        ? "Each payment leaves the company’s IBAN as its own bank transfer through Monerium, one after another. If Monerium does not accept one, the later ones are not sent."
        : "It leaves the company’s IBAN as a bank transfer through Monerium. It shows as sent once Monerium processes it."],
    ];
    return `<ol class="zb-next">${steps.map(([icon, text]) => `<li>${Z.icon(icon)}<span>${esc(text)}</span></li>`).join("")}</ol>`;
  }
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
    : ["account_balance", payees > 1 ? "Each payee gets their own bank transfer. Each turns to Paid when the bank confirms it." : "It leaves as a bank transfer. Its status turns to Paid when the bank confirms."]);
  return `<ol class="zb-next">${steps.map(([icon, text]) => `<li>${Z.icon(icon)}<span>${esc(text)}</span></li>`).join("")}</ol>`;
}

const tokenName = (t) => (t === "USDC" ? usdSymbol : "EURe");

/** The summary's lines for the payees of a bank payment, when there are several. */
const SUMMARY_NAMES = 10;
function payeesSummary(rows, contacts, kv) {
  const named = rows.slice(0, SUMMARY_NAMES).map((r) => {
    const a = sendAmount(r.amount, false);
    return kv(contacts.find((c) => c.id === r.contactId)?.name || "", a ? esc(eur(Number(a))) : '<span class="z-dim">No amount yet</span>');
  }).join("");
  // The payees past the named ones are in the form; here they are one row with their sum.
  const rest = rows.slice(SUMMARY_NAMES);
  const more = rest.length ? kv(`and ${rest.length} more`, rest.every((r) => sendAmount(r.amount, false)) ? esc(eur(payeesTotal(rest))) : '<span class="z-dim">No amount yet</span>') : "";
  return `${kv("To", `${rows.length} payees`)}${named}${more}`;
}

function summary(form, accounts, contacts, approvers, net, rows) {
  const crypto = !!net;
  const picked = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const account = accounts.find((a) => a.id === picked("account")) || accounts[0];
  const kv = (k, v, cls = "") => `<div class="zb-kv${cls}"><span>${esc(k)}</span><b>${v}</b></div>`;
  if (!crypto && rows.length !== 1) {
    const total = payeesTotal(rows);
    const allPriced = rows.length && rows.every((r) => sendAmount(r.amount, false));
    return `<h2 class="zb-h3">Summary</h2>
      ${rows.length ? payeesSummary(rows, contacts, kv) : kv("To", '<span class="z-dim">Pick one or more contacts</span>')}
      ${kv("From", esc(account.label || account.currency))}
      ${kv("Zold fee", esc(eur(0)))}
      ${kv("Total", allPriced ? esc(eur(total)) : '<span class="z-dim">Enter every amount</span>', " zb-kv--total")}
      <h2 class="zb-h3" style="margin-top:20px">What happens next</h2>${nextSteps(account, approvers, crypto, rows.length)}`;
  }
  const one = crypto ? null : rows[0];
  const contact = contacts.find((c) => c.id === (crypto ? picked("contact") : one.contactId));
  const amount = sendAmount(crypto ? form.elements.amount.value : one.amount, crypto);
  const shown = amount && (crypto ? `${Number(amount).toLocaleString("en-GB", { maximumFractionDigits: 6 })} ${tokenName(picked("token"))}` : eur(Number(amount)));
  return `<h2 class="zb-h3">Summary</h2>
    ${kv("To", contact ? esc(contact.name) : '<span class="z-dim">Pick a contact</span>')}
    ${crypto && contact ? kv("Wallet", `<span class="z-mono" style="word-break:break-all">${esc(walletOf(contact, net).address)}</span>`) : ""}
    ${kv("From", esc(account.label || account.currency))}
    ${kv("Zold fee", esc(eur(0)))}
    ${kv("They receive", shown ? esc(shown) : '<span class="z-dim">Enter an amount</span>', " zb-kv--total")}
    <h2 class="zb-h3" style="margin-top:20px">What happens next</h2>${nextSteps(account, approvers, crypto)}`;
}

/** One picked payee of a bank payment: their amount and note. `c` is the
 *  contact as saved now: gone, or without an IBAN, when it changed while the
 *  form was open, and the row says so until it is removed. */
function payeeLine(c, r, i) {
  const b = bankOf(c);
  c = { id: r.contactId, name: c?.name || "A contact no longer saved" };
  return `<div class="zb-payee" data-line="${esc(c.id)}">
    <div class="zb-payee__name"><span class="z-row__title">${esc(c.name)}</span><span class="z-row__sub z-mono">${b ? esc(last4(b.iban)) : "No IBAN saved: remove to save"}</span></div>
    <div><label for="pl-${i}-a">Amount in euros<span class="z-sr"> for ${esc(c.name)}</span></label><input id="pl-${i}-a" data-lf="amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" value="${esc(r.amount)}" /></div>
    <div><label for="pl-${i}-n">Note <span class="desc">(for you; not sent to the bank)</span></label><input id="pl-${i}-n" data-lf="note" autocomplete="off" maxlength="140" placeholder="October timber…" value="${esc(r.note)}" /></div>
    <button type="button" class="z-iconbtn zb-payee__drop" data-drop="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">${Z.icon("close")}</button></div>`;
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
  // A company's bank account is its own Safe, which only its owners sign: a
  // payment saved here is a run an owner sends with their passkey
  // (routes/business/org-monerium-bank-runs.ts). Only while the deployment
  // allows bank payouts from a company's IBAN.
  const companyBank = org.entity === "company" && !crypto;
  if (companyBank && health?.capabilities?.orgBankPayouts !== true) {
    return `<div class="gate"><h3>Bank payments are switched off</h3><p>Paying a bank account from ${esc(org.name)}’s IBAN is switched off on this deployment, so nothing can be saved here.</p><div class="zb-actions">${cryptoOn ? `<button type="button" class="z-btn z-btn--secondary" data-act="send-mode" data-mode="crypto">${Z.icon("account_balance_wallet")}<span>Pay a crypto wallet</span></button>` : ""}</div></div>`;
  }
  const net = health?.chainId ?? chainId;
  const payable = crypto ? contacts.filter((c) => walletOf(c, net)) : payableContacts(contacts);
  const fundable = companyBank ? companyBankAccounts(accounts) : fundableAccounts(accounts);
  if (!fundable.length) {
    // Nothing here can use a carried amount: a later New payment starts empty.
    sendState.amount = "";
    sendState.note = "";
    sendState.rows = [];
    return `<div class="gate"><h3>No account can pay yet</h3><p>${companyBank
      ? `${esc(org.name)}’s IBAN isn’t on its Safe yet. Issue it in Settings → Monerium first.`
      : org.type === "business"
      ? `Connect ${esc(org.name)}’s Monerium profile to an account first.`
      : "Open an account and fund it from your own account first."}</p><div class="zb-actions">${linkBtn("Accounts", "accounts")}</div></div>`;
  }
  if (!payable.length && !crypto) {
    return `<div class="gate"><h3>Add who you’re paying</h3><p>A payment goes to a contact with bank details, so a later change to them is caught before sending.</p><div class="zb-actions"><button type="button" class="z-btn z-btn--primary" data-act="new-contact">${Z.icon("person_add")}<span>Add contact</span></button>${cryptoOn ? `<button type="button" class="z-btn z-btn--secondary" data-act="send-mode" data-mode="crypto">${Z.icon("account_balance_wallet")}<span>Pay a crypto wallet</span></button>` : ""}</div></div>`;
  }
  const approvers = (members || []).filter((m) => m.status === "active" && m.id !== org.memberId && roleCan(m.role, "approve"));
  const first = fundable.find((a) => a.id === sendState.accountId) || fundable.find((a) => a.backingUserId === me?.id) || fundable[0];
  const chosen = payable.find((c) => c.id === sendState.contactId)?.id;
  const action = reviewOn() && !companyBank ? "Submit for approval" : "Save payment";
  // What was typed before Add a contact fills the form once; a later New payment starts empty.
  const amount = sendState.amount;
  const note = sendState.note;
  const max = maxPayees(companyBank);
  // A bank payment's payees, in the order they were picked: the ones entered
  // before Add a contact keep their amounts and notes, and what was typed for
  // one contact goes to that contact.
  const opening = crypto ? [] : openingRows(sendState.rows, chosen && { contactId: chosen, amount, note }, payable, max);

  const addRow = crypto
    ? `<button type="button" class="zb-pick-row zb-pick-row--add" data-act="new-wallet-contact">${Z.iconTile({ icon: "person_add" })}<span class="z-row__main"><span class="z-row__title">Add a wallet contact</span><span class="z-row__sub">An ENS name or 0x address, saved with the contact, so a later change to it is caught before sending.</span></span></button>`
    : `<button type="button" class="zb-pick-row zb-pick-row--add" data-act="new-contact">${Z.iconTile({ icon: "person_add" })}<span class="z-row__main"><span class="z-row__title">Add a contact</span><span class="z-row__sub">A payment goes to a saved contact, so a later change to their bank details is caught before sending.</span></span></button>`;
  const tokenPick = (t, label) => `<label class="zb-pick"><input type="radio" name="token" value="${t}"${t === "EURE" ? " checked" : ""} /><span class="zb-pick__title">${esc(label)}</span></label>`;
  const html = `<div class="zb-send">
    <form class="z-card zb-pad zb-stack" id="send-form" style="gap:20px" novalidate>
      <fieldset class="zb-fieldset"><legend>From</legend><div class="zb-picks">${fundable.map((a) => accountCard(a, a === first)).join("")}</div></fieldset>
      <fieldset class="zb-fieldset"><legend>To</legend>
        ${payable.length >= FIND_FROM ? `<label class="z-sr" for="send-find">Find a contact</label><input id="send-find" type="search" autocomplete="off" placeholder="Find a contact…" style="margin-bottom:10px" />` : ""}
        <div class="z-card zb-pick-list" id="send-contacts">${payable.map((c) => contactRow(c, crypto ? c.id === chosen : opening.some((r) => r.contactId === c.id), crypto && net)).join("")}
          ${addRow}
        </div></fieldset>
      ${crypto ? `<fieldset class="zb-fieldset"><legend>Send</legend><div class="zb-picks">${tokenPick("EURE", "EURe")}${tokenPick("USDC", usdSymbol)}</div></fieldset>` : ""}
      ${crypto
        ? `<div><label for="d-amt">Amount</label><input id="d-amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" value="${esc(amount)}" /></div>
      <div><label for="d-note">Note <span class="desc">(for you; not sent with the payment)</span></label><input id="d-note" name="reference" autocomplete="off" maxlength="140" placeholder="October timber…" value="${esc(note)}" /></div>`
        : `<fieldset class="zb-fieldset"><legend>Amounts</legend>
        <p class="zb-hint" id="send-max">${companyBank ? `Up to ${max} payees in one payment. When an owner sends it, each payee is its own ${esc(Z.passkeyName())} prompt.` : "Each payee gets their own amount and note."}</p>
        <div class="zb-payees" id="send-lines"></div></fieldset>`}
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
      sendState.rows = [];
      sendState.accountId = null;
      const form = box.querySelector("#send-form");
      const rows = opening;
      const draw = () => { box.querySelector("#send-summary").innerHTML = summary(form, fundable, payable, approvers, crypto && net, rows); };
      const drawLines = () => {
        const list = box.querySelector("#send-lines");
        if (!list) return;
        list.innerHTML = rows.length
          ? rows.map((r, i) => payeeLine(contacts.find((c) => c.id === r.contactId), r, i)).join("")
          : '<p class="z-dim">Pick one or more contacts above.</p>';
        // Full: no more contacts can be picked until one is removed.
        const full = rows.length >= max;
        box.querySelectorAll('#send-contacts input[name="contact"]').forEach((el) => { el.disabled = full && !el.checked; });
        box.querySelector("#send-max").textContent = full
          ? `That is ${max} payees, the most one payment can have. Remove one to pick another, or save this and start a second payment.`
          : companyBank ? `Up to ${max} payees in one payment. When an owner sends it, each payee is its own ${Z.passkeyName()} prompt.` : "Each payee gets their own amount and note.";
      };
      drawLines();
      draw();
      form.addEventListener("change", (ev) => {
        if (crypto || ev.target.name !== "contact") return;
        const id = ev.target.value;
        ev.target.checked = setPayee(rows, id, ev.target.checked, max);
        drawLines();
        draw();
        if (ev.target.checked) [...box.querySelectorAll("#send-lines [data-line]")].find((el) => el.dataset.line === id)?.querySelector('[data-lf="amount"]').focus();
      });
      form.addEventListener("click", (ev) => {
        const drop = ev.target.closest?.("[data-drop]");
        if (!drop) return;
        setPayee(rows, drop.dataset.drop, false, max);
        const pick = [...box.querySelectorAll('#send-contacts input[name="contact"]')].find((el) => el.value === drop.dataset.drop);
        if (pick) pick.checked = false;
        drawLines();
        draw();
      });
      form.addEventListener("input", (ev) => {
        const line = ev.target.closest?.("[data-line]");
        if (line) {
          const r = rows.find((x) => x.contactId === line.dataset.line);
          if (r) r[ev.target.dataset.lf] = ev.target.value;
          return draw();
        }
        if (ev.target.id !== "send-find") return draw();
        const q = ev.target.value.trim().toLowerCase();
        box.querySelectorAll("#send-contacts [data-name]").forEach((row) => { row.hidden = !!q && !row.dataset.name.includes(q); });
      });
    },
  };
};
