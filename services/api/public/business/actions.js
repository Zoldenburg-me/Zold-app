/**
 * Everything a [data-act] button does, keyed by action name.
 *
 * A map rather than a chain of ifs, for the same reason RENDER is one: the
 * shell dispatches on the attribute, so an action exists by being named here
 * and nowhere else. An action that opens a drawer returns "keep", so the
 * shell does not draw the page again under it.
 */
import { $, Z, api, cap, chainId, day, deviceLib, dialog, esc, eur, maskIban, me, org, plain, readHealth, reviewOn, roleCan, ROLE_WORD, setPersonalLater, setView, toast, token, view } from "./core.js";
import { docHref, docMonth, exportMonth, setExportMonth } from "./views.js";
import { sendState, walletOf } from "./send.js";
import { bankLines, sendAmount } from "./send-model.js";
import { forgetDraft, invoiceBody, invoiceDraft, readInvoiceEditor, setInvoiceDraft, storeDraft } from "./invoice.js";
import { ap, bk, contactPayments, ct, draftTag, draftTitle, draftTotal, invoiceDrawer, iv, mayReview, memberName } from "./screens.js";
import { loadOrg, render } from "./shell.js";
import { field, payerRuleDialog, payerRuleSection, runSummary } from "./receipts.js";
import { approvalProgress, showProgress, signedLineOutcome, signedRunToast, signingWarning } from "./payment-model.js";
import { bankRunNotice, ibanNotice, keyNotice, payoutNotice } from "./org-monerium-model.js";

/** A file the API serves behind the bearer header, which a navigation
 *  cannot carry: fetch it, then hand the bytes to the browser as a download. */
async function download(path, filename) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
  // A gate's HTML page must not be saved as the file.
  if (!res.ok || res.headers.get("content-type")?.includes("html")) return toast("The download failed. Reload the page and try again.", true);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** When a Safe's books start; the same rule as domain/safe-books.ts. */
function safeBooksStart(u) {
  const safe = u?.passkeySafe;
  if (safe?.importedAt) return u.ibanSince && u.ibanSince > safe.importedAt ? u.ibanSince : safe.importedAt;
  return safe?.createdAt ?? u?.createdAt;
}

/** A fresh passkey approval for one named action the server gates on one
 *  (verifyPasskeyStepUp), refused for any other. Undefined when the account
 *  has no passkey, and the server then says why it refuses. */
async function passkeyStepUp(action) {
  const session = await api("/api/session");
  const credentialId = session.passkey?.credentialId;
  if (!credentialId) return undefined;
  const { challenge } = await api("/api/webauthn/challenge", { method: "POST", body: { purpose: "step_up", action } });
  return (await deviceLib()).passkeyAssertion({ challenge, credentialId });
}

/* The month an export acts on: Books' month there, the statement's month on
   the statement screen. */
function monthChosen() {
  const v = $("#x-month")?.value || (view === "books" ? bk.month : exportMonth);
  setExportMonth(v);
  return v;
}

/* A link to hand over: no mail goes out, so the person copies it. */
function linkDialog(title, text, url) {
  dialog(title, `<p class="desc">${esc(text)}</p><ul class="z-list z-card" style="margin-top:16px"><li>${Z.copyRow({ label: "Link", value: url, mono: true })}</li></ul>`, null, { closeOnly: true });
}

/* A drawer (Z.overlay): a right panel from 1024px. */
function drawer(id, title, body, trigger) {
  document.getElementById(id)?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({ id, title, body: `<div class="z-sheet__body">${body}</div>` }));
  Z.openOverlay(id, trigger);
  return $(`#${id}`);
}
/** The store address typed into a Connect store form, checked against the
 *  shape the API accepts (shopify/hmac.ts SHOP_RE) before it is sent. */
function shopAddress(sel) {
  const shop = ($(sel).value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("Enter the store’s myshopify.com address, for example my-store.myshopify.com. You find it in Shopify under Settings, Domains.");
  }
  return shop;
}

/* ── Payment runs ─────────────────────────────────────────────────────── */

/** One run in a drawer: who drafted it, each line, and, when this person may
 *  review it, Approve and Send back. Four eyes is the server's call too. */
async function draftDrawer(el) {
  const [{ draft, totals }, { contacts }] = await Promise.all([
    api(`/api/orgs/${org.id}/drafts/${encodeURIComponent(el.dataset.id)}`),
    // Only to show the IBAN next to each payee; the review still works without.
    api(`/api/orgs/${org.id}/contacts`).catch(() => ({ contacts: [] })),
  ]);
  // The single-run route returns the totals beside the run, not in it.
  const d = { ...draft, totals };
  const ibanOf = (l) => {
    const c = contacts.find((x) => x.id === l.contactId);
    const b = c?.bankAccounts?.find((x) => x.id === l.destination.bankAccountId);
    return b?.iban || l.destination?.address || "";
  };
  const bad = new Set(d.invalidLineIds || []);
  const may = mayReview(d);
  const review = d.state === "PENDING_REVIEW" && may.allowed;
  const body = `<div>${draftTag(d)}</div>
    <p class="zb-hint">Drafted by ${esc(memberName(d.createdByMemberId))} on ${esc(day(d.createdAt))}${d.reviewedByMemberId ? ` · reviewed by ${esc(memberName(d.reviewedByMemberId))}` : ""}</p>
    <ul class="z-list z-card">${d.lines.map((l) => `<li><div class="z-row">${Z.avatar({ name: l.destination.displayName })}<span class="z-row__main"><span class="z-row__title">${bad.has(l.id) ? `${Z.icon("warning")} ` : ""}${esc(l.destination.displayName)}</span><span class="z-row__sub z-mono">${esc(ibanOf(l) ? maskIban(ibanOf(l)) : "")}${l.note ? ` · ${esc(l.note)}` : ""}</span></span><span class="z-row__right"><span class="z-amount">−${esc(/^EUR/i.test(l.asset) ? eur(l.amount) : `${l.amount} ${l.asset}`)}</span></span></div></li>`).join("")}
      <li><div class="z-row"><span class="z-row__main"><span class="z-row__title">Total</span></span><span class="z-row__right"><b class="z-amount">−${esc(draftTotal(d))}</b></span></div></li></ul>
    ${bad.size ? `<div class="zb-note zb-note--a">${Z.icon("warning")}<span>The marked payee’s bank details changed after this was drafted. Check them in Contacts before it can be approved.</span></div>` : ""}
    ${d.rejectedReason ? `<div class="zb-note zb-note--a">${Z.icon("undo")}<span>Sent back: “${esc(plain(d.rejectedReason))}”</span></div>` : ""}
    ${d.failureReason ? `<div class="zb-note zb-note--a">${Z.icon("error")}<span>${esc(plain(d.failureReason))}</span></div>` : ""}
    ${review ? `<label for="dr-reason">Reason, if you send it back <span class="desc">(optional)</span></label><textarea id="dr-reason" name="reason" autocomplete="off" maxlength="300" placeholder="The amount doesn’t match the invoice…"></textarea>
      <p class="zb-err" id="dr-err" role="alert"></p>
      <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="dr-back">Send back</button><button type="button" class="z-btn z-btn--primary" id="dr-ok">Approve</button></div>`
      : d.state === "PENDING_REVIEW" ? `<p class="zb-hint">${esc(may.reason)}</p>` : ""}
    ${manageHtml(d)}`;
  const scrim = drawer("draft-drawer", draftTitle(d), body, el);
  bindManage(scrim, d);
  if (!review) return;
  const url = `/api/orgs/${org.id}/drafts/${d.id}/review`;
  const run = (approve) => async () => {
    const btns = [scrim.querySelector("#dr-ok"), scrim.querySelector("#dr-back")];
    if (btns.some((b) => Z.isDisabled(b))) return;
    btns.forEach((b) => Z.setLoading(b, true));
    try {
      await api(url, { method: "POST", body: approve ? { approve: true } : { approve: false, reason: scrim.querySelector("#dr-reason").value.trim() || undefined } });
      Z.closeOverlay("draft-drawer");
      toast(approve ? "Approved. It can be sent now." : "Sent back to whoever drafted it.");
      render();
    } catch (e) {
      const err = scrim.querySelector("#dr-err");
      err.textContent = plain(e.message);
      btns.forEach((b) => Z.setLoading(b, false));
    }
  };
  scrim.querySelector("#dr-ok").onclick = run(true);
  scrim.querySelector("#dr-back").onclick = run(false);
}

/* A draft is a proposal: until sending starts it can be edited, which sends
   it back to Draft (what was approved is no longer what is in it), or
   cancelled, which keeps it under Cancelled. The server decides both again. */
const EDITABLE = ["DRAFT", "INVALID_DATA", "REJECTED", "PENDING_REVIEW", "REVIEWED"];
const mayEdit = (d) => EDITABLE.includes(d.state) && roleCan(org.role, "propose");
const mayCancel = (d) => EDITABLE.includes(d.state) && (roleCan(org.role, "propose") || roleCan(org.role, "approve"));

function manageHtml(d) {
  if (!mayEdit(d) && !mayCancel(d)) return "";
  const again = ["PENDING_REVIEW", "REVIEWED"].includes(d.state) && reviewOn()
    ? " It goes back to Draft and has to be approved again; as its editor, you can’t approve it." : "";
  // A company's bank line that pays an invoice pays all of it, or the run
  // refuses the line (org-monerium-bank-runs.ts planLines): the amount is fixed.
  const fixed = (l) => org.entity === "company" && l.invoiceId && l.destination.kind === "bank";
  const lineInputs = d.lines.map((l, i) => `<fieldset class="zb-fieldset"><legend>${esc(l.destination.displayName)}</legend>
      <label for="dr-amt-${i}">Amount${/^EUR/i.test(l.asset) ? " in euros" : ` in ${esc(l.asset)}`}${fixed(l) ? ' <span class="desc">(fixed: a company pays an invoice in full. If this is not the invoice total, cancel this run and pay the invoice again from Invoices.)</span>' : ""}</label>
      <input id="dr-amt-${i}" inputmode="decimal" autocomplete="off" value="${esc(l.amount)}"${fixed(l) ? " readonly" : ""} />
      <label for="dr-note-${i}">Note <span class="desc">(optional)</span></label>
      <input id="dr-note-${i}" autocomplete="off" maxlength="500" value="${esc(l.note || "")}" /></fieldset>`).join("");
  return `<div id="dr-manage">
      <div class="zb-actions">${mayEdit(d) ? `<button type="button" class="z-btn z-btn--secondary" id="dr-edit">${Z.icon("edit")}<span>Edit</span></button>` : ""}${mayCancel(d) ? `<button type="button" class="z-link-btn" id="dr-cancel">Cancel this payment run</button>` : ""}</div>
    </div>
    ${mayEdit(d) ? `<form id="dr-edit-form" class="zb-stack" hidden novalidate>
      ${lineInputs}
      <p class="zb-hint">To pay someone else, cancel this run and start a new payment.${again}</p>
      <p class="zb-err" id="dr-edit-err" role="alert"></p>
      <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="dr-edit-back">Discard changes</button><button type="submit" class="z-btn z-btn--primary" id="dr-edit-ok">Save</button></div>
    </form>` : ""}
    ${mayCancel(d) ? `<div id="dr-cancel-box" class="zb-stack" hidden>
      <p>Cancel this payment run? Nothing has been sent. It stays under Cancelled${d.lines.some((l) => l.invoiceId) ? ", and the invoice it was paying waits for payment again" : ""}.</p>
      <label for="dr-cancel-reason">Why <span class="desc">(optional)</span></label>
      <input id="dr-cancel-reason" autocomplete="off" maxlength="300" />
      <p class="zb-err" id="dr-cancel-err" role="alert"></p>
      <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="dr-cancel-no">Keep it</button><button type="button" class="z-btn z-btn--primary zb-danger" id="dr-cancel-yes">Cancel payment run</button></div>
    </div>` : ""}`;
}

function bindManage(scrim, d) {
  const q = (sel) => scrim.querySelector(sel);
  const manage = q("#dr-manage");
  if (!manage) return;
  const show = (box) => { manage.hidden = true; box.hidden = false; box.querySelector("input")?.focus(); };
  const back = (box) => { box.hidden = true; manage.hidden = false; };
  const form = q("#dr-edit-form");
  if (form) {
    q("#dr-edit").onclick = () => show(form);
    q("#dr-edit-back").onclick = () => back(form);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = q("#dr-edit-err");
      err.textContent = "";
      const lines = [];
      for (const [i, l] of d.lines.entries()) {
        const amount = q(`#dr-amt-${i}`).value.trim().replace(",", ".");
        if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
          err.textContent = `Enter an amount for ${l.destination.displayName}, like 250 or 250.00.`;
          q(`#dr-amt-${i}`).focus();
          return;
        }
        const { fingerprint, ...destination } = l.destination;
        lines.push({
          id: l.id, contactId: l.contactId, invoiceId: l.invoiceId, destination, asset: l.asset, amount,
          note: q(`#dr-note-${i}`).value.trim() || undefined, accountCode: l.accountCode, tags: l.tags,
        });
      }
      const ok = q("#dr-edit-ok");
      if (Z.isDisabled(ok)) return;
      Z.setLoading(ok, true);
      try {
        await api(`/api/orgs/${org.id}/drafts/${d.id}`, { method: "PATCH", body: { lines } });
        Z.closeOverlay("draft-drawer");
        ap.tab = "drafts";
        toast(["PENDING_REVIEW", "REVIEWED"].includes(d.state) ? "Saved. It’s a draft again." : "Saved.");
        render();
      } catch (e) {
        err.textContent = plain(e.message);
        Z.setLoading(ok, false);
      }
    };
  }
  const box = q("#dr-cancel-box");
  if (box) {
    q("#dr-cancel").onclick = () => show(box);
    q("#dr-cancel-no").onclick = () => back(box);
    q("#dr-cancel-yes").onclick = async () => {
      const yes = q("#dr-cancel-yes");
      if (Z.isDisabled(yes)) return;
      Z.setLoading(yes, true);
      try {
        await api(`/api/orgs/${org.id}/drafts/${d.id}/cancel`, { method: "POST", body: { reason: q("#dr-cancel-reason").value.trim() || undefined } });
        Z.closeOverlay("draft-drawer");
        toast("Cancelled. Nothing was sent.");
        render();
      } catch (e) {
        q("#dr-cancel-err").textContent = plain(e.message);
        Z.setLoading(yes, false);
      }
    };
  }
}

/* ── Contacts ─────────────────────────────────────────────────────────── */

function contactDrawer(el) {
  const c = ct.contacts.find((x) => x.id === el.dataset.id);
  if (!c) return;
  const b = c.bankAccounts.find((x) => x.iban) || c.bankAccounts[0];
  const pays = contactPayments(c);
  const open = ct.drafts.filter((d) => ["DRAFT", "PENDING_REVIEW", "REVIEWED", "INVALID_DATA", "REJECTED"].includes(d.state) && d.lines.some((l) => l.contactId === c.id));
  const canPay = cap("transfers.drafts").allowed && roleCan(org.role, "propose") && b?.iban;
  const mayManage = roleCan(org.role, "contacts");
  const body = `${c.email ? `<p class="zb-hint">${esc(c.email)}</p>` : ""}
    ${b?.iban ? `<ul class="z-list z-card"><li>${Z.copyRow({ label: "IBAN", value: String(b.iban).replace(/\s+/g, ""), display: Z.groupIban(b.iban), mono: true })}</li>${b.holderName && b.holderName !== c.name ? `<li>${Z.copyRow({ label: "Account holder", value: b.holderName })}</li>` : ""}</ul>` : `<p class="zb-hint">No bank details yet.</p>`}
    ${open.length ? `<div class="zb-note zb-note--a">${Z.icon("warning")}<span>${open.length === 1 ? "A payment run uses" : `${open.length} payment runs use`} these bank details. Changing them sends ${open.length === 1 ? "it" : "them"} back to be checked again.</span></div>` : ""}
    <section><h3 class="z-eyebrow" style="margin-bottom:8px">Past payments</h3>${pays.length
      ? `<dl class="z-kv z-card">${pays.slice(0, 8).map((p) => `<div><dt>${esc(day(p.at))}</dt><dd class="z-fig">−${esc(/^EUR/i.test(p.asset) ? eur(p.amount) : `${p.amount} ${p.asset}`)}</dd></div>`).join("")}</dl>`
      : '<p class="zb-hint">None yet.</p>'}</section>
    <div class="zb-actions">
      ${mayManage ? `<button type="button" class="z-btn z-btn--secondary" id="ct-edit">${Z.icon("edit")}<span>Edit</span></button>` : ""}
      ${canPay ? `<button type="button" class="z-btn z-btn--primary" id="ct-pay">${Z.icon("arrow_outward")}<span>Pay ${esc(c.name)}</span></button>` : ""}
      ${mayManage ? '<button type="button" class="z-link-btn" id="ct-del">Delete contact</button>' : ""}
    </div>
    ${payerRuleSection(c)}`;
  const scrim = drawer("contact-drawer", c.name, body, el);
  scrim.querySelector("#ct-pay")?.addEventListener("click", () => {
    Z.closeOverlay("contact-drawer");
    sendState.contactId = c.id;
    setView("send");
    render({ focus: true });
  });
  if (!mayManage) return;
  scrim.querySelector("#ct-edit")?.addEventListener("click", () => { Z.closeOverlay("contact-drawer"); editContact(c); });
  scrim.querySelector("#ct-rule")?.addEventListener("click", () => {
    Z.closeOverlay("contact-drawer");
    payerRuleDialog(c).catch((e) => toast(e.message, true));
  });
  scrim.querySelector("#ct-del")?.addEventListener("click", () => {
    Z.closeOverlay("contact-drawer");
    dialog(`Delete ${c.name}?`, `<p class="desc">Past payments keep their record. A payment run that still uses these details stops and has to be pointed somewhere else.</p>`,
      async () => { await api(`/api/orgs/${org.id}/contacts/${c.id}`, { method: "DELETE" }); toast("Contact deleted."); }, { okLabel: "Delete" });
  });
}

function editContact(c) {
  const b = c.bankAccounts.find((x) => x.iban) || c.bankAccounts[0];
  dialog(`Edit ${c.name}`,
    `${field("d-name", "Name", `value="${esc(c.name)}" autocomplete="organization"`)}
     ${field("d-email", "Email", `type="email" spellcheck="false" value="${esc(c.email || "")}"`)}
     ${field("d-iban", "IBAN", `spellcheck="false" value="${esc(b?.iban || "")}" placeholder="DE89 3704 0044 0532 0130 00…"`)}
     ${field("d-holder", "Account holder", `value="${esc(b?.holderName || c.name)}"`)}
     <p class="desc" style="margin-top:12px">Changing the IBAN sends any payment run that uses it back to be checked again.</p>`,
    async () => {
      const iban = $("#d-iban").value.trim();
      // A new IBAN drops the old one's BIC: it belongs to the old bank.
      const norm = (x) => String(x || "").replace(/\s+/g, "").toUpperCase();
      const bankAccounts = iban
        ? [{ ...(b || { currency: "EUR", country: iban.slice(0, 2).toUpperCase() }), ...(b && norm(b.iban) !== norm(iban) ? { bic: undefined } : {}), iban, holderName: $("#d-holder").value.trim() || $("#d-name").value.trim() }, ...c.bankAccounts.filter((x) => x !== b)]
        : c.bankAccounts.filter((x) => x !== b);
      await api(`/api/orgs/${org.id}/contacts/${c.id}`, { method: "PATCH", body: { name: $("#d-name").value.trim(), email: $("#d-email").value.trim(), bankAccounts } });
      toast("Saved.");
    }, { okLabel: "Save" });
}

/* ── Connections ──────────────────────────────────────────────────────── */

function gmiDrawer(el) {
  const scrim = drawer("gmi-drawer", "Connect GetMyInvoices", `
    <ol class="zb-steps"><li>In GetMyInvoices, open Settings, then API.</li><li>Create a key and copy it.</li><li>Paste it here.</li></ol>
    <div><label for="gmi-key">API key</label><input id="gmi-key" name="gmi-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key…" /></div>
    <div><label for="gmi-company">Company id <span class="desc">(optional)</span></label><input id="gmi-company" name="gmi-company" autocomplete="off" placeholder="Empty for the account’s own company…" /></div>
    <div class="zb-note">${Z.icon("lock")}<span>Zold checks the key once, stores it encrypted and never shows it again. It can upload documents; it can’t move money.</span></div>
    <div class="zb-note zb-note--a">${Z.icon("science")}<span>Beta. Check your first upload in GetMyInvoices before you close a month on it.</span></div>
    <p class="zb-err" id="gmi-err" role="alert"></p>
    <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="gmi-cancel">Cancel</button><button type="button" class="z-btn z-btn--primary" id="gmi-go">Check and connect</button></div>`, el);
  scrim.querySelector("#gmi-cancel").onclick = () => Z.closeOverlay("gmi-drawer");
  scrim.querySelector("#gmi-go").onclick = async () => {
    const btn = scrim.querySelector("#gmi-go");
    const err = scrim.querySelector("#gmi-err");
    const apiKey = scrim.querySelector("#gmi-key").value.trim();
    const companyId = scrim.querySelector("#gmi-company").value.trim();
    if (!apiKey) { err.textContent = "Paste the API key first."; scrim.querySelector("#gmi-key").focus(); return; }
    if (Z.isDisabled(btn)) return;
    Z.setLoading(btn, true);
    err.textContent = "";
    try {
      const r = await api(`/api/orgs/${org.id}/integrations/getmyinvoices`, { method: "POST", body: { apiKey, ...(companyId ? { companyId } : {}) } });
      Z.closeOverlay("gmi-drawer");
      toast(`Connected to ${r.account.organization || r.account.name || "GetMyInvoices"}.`);
      render();
    } catch (e) {
      err.textContent = plain(e.message);
      Z.setLoading(btn, false);
    }
  };
}

/* A company's own Monerium keys (routes/business/org-monerium.ts). Replacing
   stored keys needs a fresh passkey approval. */
function orgMoneriumDrawer(el) {
  const replacing = el?.dataset?.replace === "1";
  const scrim = drawer("om-drawer", "Company Monerium keys", `
    <ol class="zb-steps"><li>Sign in to the company’s own Monerium account (not a personal one).</li><li>Open Developers and create an app with client credentials.</li><li>Paste its client id and client secret here.</li></ol>
    <div><label for="om-id">Client id</label><input id="om-id" name="om-id" autocomplete="off" spellcheck="false" placeholder="Paste the client id…" /></div>
    <div><label for="om-secret">Client secret</label><input id="om-secret" name="om-secret" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the client secret…" /></div>
    <div class="zb-note">${Z.icon("lock")}<span>Zold checks the keys with Monerium, stores the secret encrypted and never shows it again. Use keys from the same Monerium environment as this site.</span></div>
    <p class="zb-err" id="om-err" role="alert"></p>
    <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="om-cancel">Cancel</button><button type="button" class="z-btn z-btn--primary" id="om-go">Check and connect</button></div>`, el);
  scrim.querySelector("#om-cancel").onclick = () => Z.closeOverlay("om-drawer");
  scrim.querySelector("#om-go").onclick = async () => {
    const btn = scrim.querySelector("#om-go");
    const err = scrim.querySelector("#om-err");
    const clientId = scrim.querySelector("#om-id").value.trim();
    const clientSecret = scrim.querySelector("#om-secret").value.trim();
    if (!clientId || !clientSecret) { err.textContent = "Paste both the client id and the client secret."; return; }
    if (Z.isDisabled(btn)) return;
    Z.setLoading(btn, true);
    err.textContent = "";
    try {
      const stepUp = replacing ? await passkeyStepUp("org.monerium.keys") : undefined;
      const r = await api(`/api/orgs/${org.id}/monerium`, { method: "POST", body: { clientId, clientSecret, ...(stepUp ? { stepUp } : {}) } });
      Z.closeOverlay("om-drawer");
      toast(keyNotice(r.monerium, "save"), r.monerium.status === "invalid");
      render();
    } catch (e) {
      err.textContent = plain(e.message);
      Z.setLoading(btn, false);
    }
  };
}

/* A document opens in a new tab; the list below the buttons then shows it. */
function openDocument(d) {
  const url = docHref(d?.url);
  if (url) window.open(url, "_blank", "noopener");
  toast("Document issued.");
}

/**
 * Sign a run that pays a wallet: the passkey signs the Safe operation that
 * moves exactly that token and amount to exactly that address, then the API
 * checks the payee once more and submits it (routes/crypto-sends.ts).
 */
/**
 * A company bank run from its own IBAN (routes/business/org-monerium-bank-runs.ts):
 * one passkey prompt per line, each over Monerium's message for that amount
 * and IBAN. Nothing is sent until every line is signed; then the server sends
 * them one at a time and stops at the first Monerium does not accept.
 */
function signCompanyBankRun(startTo) {
  return dialog("Sign the bank payments", `
      <p class="desc">Each payment leaves the company’s Safe as its own Monerium order, so your ${Z.passkeyName()} signs each one: amount and IBAN. Nothing is sent until you have signed them all.</p>
      <p class="desc">They are then sent one at a time. If Monerium does not accept one, the run stops there: payments before it stay sent, later ones are not sent.</p>
      <p class="desc" id="dlg-progress" role="status"></p>`,
    async () => {
      const start = await api(startTo, { method: "POST" });
      const lib = await deviceLib();
      const assertions = [];
      for (const [i, l] of start.lines.entries()) {
        showProgress(`Signing ${i + 1} of ${start.lines.length}: €${Number(l.amountEur).toFixed(2)} to ${l.recipientName}.`, $("#dlg"), $("#dlg-progress"), toast);
        try {
          assertions.push({ requestId: l.requestId, ...(await lib.passkeyAssertion({ credentialId: start.credentialId, challenge: l.challenge, rpId: start.rpId })) });
        } catch (e) {
          throw new Error(e.name === "NotAllowedError" ? `${Z.byDevice("Face ID was cancelled.", "The passkey prompt was cancelled.")} Nothing was sent.` : e.message);
        }
      }
      try {
        const r = await api(start.submitTo, { method: "POST", body: { runId: start.runId, assertions } });
        const done = bankRunNotice(r.draft);
        setTimeout(() => toast(done.text, done.error), 0);
      } catch (e) {
        // Lines may have reached Monerium: say what each did, from the draft.
        if (e.draft) { const done = bankRunNotice(e.draft); setTimeout(() => toast(done.text, true), 0); return; }
        throw e;
      }
    }, { okLabel: "Sign and send" });
}

async function signCryptoRun(sends) {
  const lib = await deviceLib();
  const out = [];
  for (const a of sends) {
    const name = a.recipient || "the wallet";
    if (Date.now() / 1000 > Number(a.deadline)) { out.push(`${name}: not sent, approval expired`); continue; }
    try {
      const executionAssertion = await lib.passkeyAssertion(a.safeExecution);
      const sent = await api(a.submitTo, { method: "POST", body: { executionAssertion } });
      out.push(sent.state === "SENT" ? `Sent to ${name}.` : `${name}: sent to the network, not confirmed yet. Payments shows when it is.`);
    } catch (e) {
      out.push(`${name}: ${plain(e.message)}`);
    }
  }
  const ok = out.every((t) => t.startsWith("Sent to"));
  toast(out.join(" "), !ok);
}

/** One picked payee of New payment's bank form, as it stands in the page. */
const payeeRow = (el) => ({
  contactId: el.dataset.line,
  amount: el.querySelector('[data-lf="amount"]').value,
  note: el.querySelector('[data-lf="note"]').value,
});

export const ACTIONS = {
  // ── Documents (views.js RENDER.documents) ────────────────────────────────
  async "doc-statement"() {
    const v = $("#doc-month").value;
    docMonth.value = v;
    const [y, m] = v.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, m, 1) - 1).toISOString();
    openDocument(await api(`/api/users/${me.id}/documents/statement`, { method: "POST", body: { from, to } }));
  },
  async "doc-balance"() {
    openDocument(await api(`/api/users/${me.id}/documents/balance`, { method: "POST", body: {} }));
  },
  async "doc-ownership"() {
    let d = await api(`/api/users/${me.id}/documents/ownership`, { method: "POST", body: {} });
    if (d.safeSignature) {
      // The account's own signature: the part a screenshot cannot fake.
      const lib = await deviceLib();
      const sig = await lib.passkeyAssertion(d.safeSignature);
      d = await api(d.safeSignature.submitTo, { method: "POST", body: sig });
    }
    openDocument(d);
  },
  async "doc-receipt"(el) {
    openDocument(await api(`/api/users/${me.id}/documents/receipt`, { method: "POST", body: { transferId: el.dataset.id } }));
  },

  // The organisation onboarding (shell.js boot), which lands on Invoices.
  "create-personal"() { location.assign("/business?setup=invoices"); },
  "personal-later"() { setPersonalLater(); },

  /* Filters and tabs: state in the screen's module, then a redraw. */
  "ap-tab"(el) { ap.tab = el.dataset.tab; },
  "inv-filter"(el) { iv.filter = el.dataset.f; },
  "inv-side"(el) { iv.side = el.dataset.s; },
  "inv-suppliers"() { iv.side = "suppliers"; iv.filter = "open"; setView("invoices"); },
  "bk-month"(el) { bk.month = el.dataset.m; },

  "draft-detail": async (el) => { await draftDrawer(el); return "keep"; },
  "contact-detail": (el) => { contactDrawer(el); return "keep"; },
  "invoice-detail": (el) => {
    const i = iv.invoices.find((x) => x.id === el.dataset.id);
    if (i) invoiceDrawer(i, el);
    return "keep";
  },
  "gmi-drawer": (el) => { gmiDrawer(el); return "keep"; },
  "org-monerium-drawer": (el) => { orgMoneriumDrawer(el); return "keep"; },
  async "org-monerium-check"() {
    // A refused check can still change what is stored (a profile gone): draw the screen again, then say why.
    const r = await api(`/api/orgs/${org.id}/monerium/check`, { method: "POST" }).catch((e) => { render(); throw e; });
    toast(keyNotice(r.monerium, "check"), r.monerium.status === "invalid");
  },
  "org-monerium-remove": () => dialog("Remove the Monerium keys?", `<p class="desc">Zold forgets the keys. Nothing changes at Monerium, and an IBAN already issued stays the company’s; delete the app there too if it is no longer used. Your ${Z.passkeyName()} approves this.</p>`,
    async () => {
      const stepUp = await passkeyStepUp("org.monerium.keys");
      await api(`/api/orgs/${org.id}/monerium`, { method: "DELETE", body: stepUp ? { stepUp } : {} });
      toast("Keys removed.");
    }, { okLabel: "Remove keys" }),
  /* The company's IBAN onto its own Safe: this owner's passkey signs
     Monerium's declaration as the Safe (routes/business/org-monerium-iban.ts). */
  "org-iban-issue": () => dialog(`Issue ${org.name}’s IBAN?`, `<ul class="zb-next" style="margin-top:6px">
      <li>${Z.icon("fingerprint")}<span>Your ${Z.passkeyName()} signs Monerium’s declaration that ${esc(org.name)} owns its Safe.</span></li>
      <li>${Z.icon("account_balance")}<span>Monerium then issues the company’s IBAN onto the Safe. Bank transfers to it arrive there as euros.</span></li>
    </ul>`, async () => {
      const start = await api(`/api/orgs/${org.id}/monerium/link/start`, { method: "POST" });
      let signed;
      try {
        signed = await (await deviceLib()).passkeyAssertion(start);
      } catch (e) {
        throw new Error(e.name === "NotAllowedError" ? Z.byDevice("Face ID was cancelled.", "The passkey prompt was cancelled.") : e.message);
      }
      const r = await api(start.submitTo, { method: "POST", body: { requestId: start.requestId, ...signed } });
      setTimeout(() => toast(ibanNotice(r.monerium)), 0);
    }, { okLabel: "Sign and issue" }),
  async "org-iban-check"() {
    const r = await api(`/api/orgs/${org.id}/monerium/iban/check`, { method: "POST" }).catch((e) => { render(); throw e; });
    toast(ibanNotice(r.monerium));
  },
  /* A bank payout from the company's own IBAN: one Monerium redeem from the
     company Safe, signed by this owner's passkey
     (routes/business/org-monerium-payouts.ts). Nothing is retried here: a
     payout Monerium did not confirm is said as unclear. */
  "org-payout-new": () => dialog(`Pay a bank account from ${org.name}’s IBAN?`, `
      <p class="desc">The euros leave the company’s Safe and Monerium sends a SEPA transfer to the recipient’s bank. Your ${Z.passkeyName()} signs exactly this amount and IBAN.</p>
      <div><label for="op-name">Recipient name</label><input id="op-name" autocomplete="off" maxlength="140" placeholder="Müller Holzbau GmbH…" /></div>
      <div><label for="op-iban">Recipient IBAN</label><input id="op-iban" autocomplete="off" spellcheck="false" placeholder="DE…" /></div>
      <div><label for="op-amount">Amount in euros</label><input id="op-amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" /></div>
      <div><label for="op-ref">Reference <span class="desc">(optional; reaches the recipient’s statement)</span></label><input id="op-ref" autocomplete="off" maxlength="140" placeholder="Invoice 2026-014…" /></div>
      <p class="zb-hint">Zold takes no fee; Monerium’s own fees apply. Nothing is retried automatically: if Monerium does not confirm, the payout is marked unclear and you check Monerium before sending it again.</p>`,
    async () => {
      const reference = $("#op-ref").value.trim();
      const body = {
        recipientName: $("#op-name").value.trim(),
        recipientIban: $("#op-iban").value.trim(),
        amountEur: $("#op-amount").value.trim(),
        ...(reference ? { reference } : {}),
      };
      const start = await api(`/api/orgs/${org.id}/monerium/payouts/start`, { method: "POST", body });
      let signed;
      try {
        signed = await (await deviceLib()).passkeyAssertion(start);
      } catch (e) {
        throw new Error(e.name === "NotAllowedError" ? Z.byDevice("Face ID was cancelled.", "The passkey prompt was cancelled.") : e.message);
      }
      try {
        const r = await api(start.submitTo, { method: "POST", body: { requestId: start.requestId, ...signed } });
        setTimeout(() => toast(payoutNotice(r.payout), r.payout?.state !== "sent" && r.payout?.state !== "pending"), 0);
      } catch (e) {
        // A payout row exists: the order may have reached Monerium. Close the
        // dialog, draw the list with its new state, and say it there.
        if (e.payout) { setTimeout(() => toast(payoutNotice(e.payout), true), 0); return; }
        throw e;
      }
    }, { okLabel: "Sign and send" }),
  /* An unclear payout with no Monerium order holds its euros until an owner
     says Monerium has no such order. Never automatic; the API records who. */
  "org-payout-clear": (el) => dialog("Clear this unclear payout?", `
      <p class="desc">Do this only after checking in Monerium that it holds no order for this payout. The payout is then marked not sent, and its euros are free for other payouts. Zold records that you cleared it.</p>`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/monerium/payouts/${encodeURIComponent(el.dataset.id)}/clear`, { method: "POST", body: { checkedMonerium: true } });
      setTimeout(() => toast(payoutNotice(r.payout)), 0);
    }, { okLabel: "I checked: clear it" }),

  async "shopify-connect"() {
    const shop = shopAddress("#sh-shop");
    const r = await api(`/api/orgs/${org.id}/shopify/install`, { method: "POST", body: { shop } });
    if (!/^https:\/\//i.test(String(r.authorizeUrl))) return toast("Shopify sent back an address Zold can’t use.", true);
    location.href = r.authorizeUrl;
  },
  async "merchant-link-connect"() {
    const shop = shopAddress("#ml-shop");
    const r = await api(`/api/orgs/${org.id}/merchant-links`, { method: "POST", body: { integration: "shopify", shop } });
    if (!/^https:\/\//i.test(String(r.installUrl)) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(String(r.installUrl))) {
      return toast("The checkout sent back an address Zold can’t use.", true);
    }
    location.href = r.installUrl;
  },
  "merchant-link-disconnect": (el) => dialog("Disconnect this store?", `<p class="desc">The store can no longer open Zold payments. Orders already waiting for payment stay open, and money that arrives for them still reaches your account.</p>`,
    async () => { await api(`/api/orgs/${org.id}/merchant-links/${el.dataset.id}`, { method: "DELETE" }); toast("Store disconnected."); }, { okLabel: "Disconnect" }),
  "shopify-disconnect": (el) => dialog("Disconnect this store?", `<p class="desc">Customers can no longer pick Zold at its checkout.</p>`,
    async () => { await api(`/api/orgs/${org.id}/shopify/${el.dataset.id}`, { method: "DELETE" }); toast("Store disconnected."); }, { okLabel: "Disconnect" }),
  "open-account": () => dialog("Open an account",
    `<label for="d-cur">Currency</label><select id="d-cur" name="currency">
      <option value="EUR">Euro: bank transfer</option><option value="USD">US dollar</option>
      <option value="GBP">British pound</option><option value="KES">Kenyan shilling: M-Pesa</option></select>
     ${field("d-label", 'Name <span class="desc">(optional)</span>', 'placeholder="Operating…"')}
     <p class="desc" style="margin-top:12px">A currency that isn’t open yet says what it still needs, and nothing is simulated.</p>`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/accounts`, { method: "POST", body: { currency: $("#d-cur").value, label: $("#d-label").value } });
      toast(plain(r.note) || `${r.account.currency} account opened.`);
    }, { okLabel: "Open account" }),
  "new-contact": () => {
    const fromSend = view === "send";
    dialog("Add contact",
    `${field("d-name", "Name", 'autocomplete="organization" placeholder="Druckerei Kessler…"')}
     ${field("d-email", 'Email <span class="desc">(optional)</span>', 'type="email" spellcheck="false" placeholder="buchhaltung@kessler.de…"')}
     ${field("d-iban", "IBAN", 'spellcheck="false" placeholder="DE89 3704 0044 0532 0130 00…"')}
     ${field("d-holder", 'Account holder <span class="desc">(if not the name)</span>')}
     ${field("d-country", "Country", 'maxlength="2" placeholder="DE…"')}`,
    async () => {
      const iban = $("#d-iban").value.trim();
      const r = await api(`/api/orgs/${org.id}/contacts`, {
        method: "POST",
        body: {
          name: $("#d-name").value, email: $("#d-email").value || undefined,
          bankAccounts: iban ? [{
            currency: "EUR", country: $("#d-country").value || iban.slice(0, 2).toUpperCase() || "DE",
            holderName: $("#d-holder").value || $("#d-name").value, iban,
          }] : [],
        },
      });
      // From New payment: saving redraws the form, so what was typed and picked rides in sendState. Cancel stores nothing.
      if (fromSend) {
        sendState.amount = $("#d-amt")?.value.trim() || "";
        sendState.note = $("#d-note")?.value.trim() || "";
        sendState.rows = [...document.querySelectorAll("#send-lines [data-line]")].map(payeeRow);
        sendState.accountId = $('#send-form input[name="account"]:checked')?.value || null;
        sendState.contactId = r.contact.id;
      }
      toast("Contact added.");
    }, { okLabel: "Add contact" });
  },
  "import-wallet": () => dialog("Import a wallet",
    `<p class="desc">Read only. Zold never holds a key for an imported wallet.</p>
     ${field("d-addr", "Address", 'spellcheck="false" placeholder="0x…"')}
     ${field("d-chain", "Network id", 'inputmode="numeric" value="8453"')}
     <label for="d-kind">Type</label><select id="d-kind" name="kind"><option value="eoa">Ordinary wallet</option>
       <option value="safe">Safe</option><option value="mpc">MPC</option></select>
     ${field("d-label", "Name")}
     ${cap("ledger.historicalSync").allowed
       ? `${field("d-from", "Book from (optional)", 'type="date"')}<p class="zb-hint">Token transfers from this day on are booked. Leave empty to start from today.</p>`
       : ""}`,
    async () => {
      const from = $("#d-from")?.value;
      const r = await api(`/api/orgs/${org.id}/wallets`, {
        method: "POST",
        body: { address: $("#d-addr").value, chainId: Number($("#d-chain").value), kind: $("#d-kind").value, label: $("#d-label").value, ...(from ? { syncFrom: from } : {}) },
      });
      toast(plain(r.note));
    }, { okLabel: "Import wallet" }),
  async "fund-account"(el) {
    const connect = async () => {
      let r;
      try {
        r = await api(`/api/orgs/${org.id}/accounts/${el.dataset.id}/fund`, { method: "POST" });
      } catch (e) {
        // A refusal can carry Monerium's newer answer (a profile still pending):
        // draw the row again so it shows it.
        render();
        throw e;
      }
      setTimeout(() => toast(plain(r.warning ? `${r.note} ${r.warning}` : r.note)), 0);
    };
    if (org.type !== "business") return connect();
    // Said before, not after: from here the account is the company's.
    const from = safeBooksStart(me);
    const since = from ? new Date(from).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
    dialog(`Connect your account to ${org.name}?`, `<ul class="zb-next" style="margin-top:6px">
        <li>${Z.icon("domain")}<span>Your account${me?.iban ? `, IBAN ${esc(Z.groupIban(me.iban))},` : ""} then belongs to ${esc(org.name)}, with everything on it.</span></li>
        <li>${Z.icon("menu_book")}<span>Its transactions${since ? ` since ${esc(since)}` : ""} appear in ${esc(org.name)}’s books and statements. Members who can see the books see them.</span></li>
        <li>${Z.icon("block")}<span>While it is connected here, it can’t be connected to another organisation.</span></li>
        <li>${Z.icon("fingerprint")}<span>Only your ${Z.passkeyName()} can approve its payments.</span></li>
      </ul>`, connect, { okLabel: "Connect" });
    return "keep";
  },
  /* A company's own Safe, deployed with this owner's passkey as its first
     owner. The passkey prompt is the onboarding one (app/onboarding.js). */
  async "deploy-safe"() {
    dialog(`Set up ${org.name}’s Safe?`, `<ul class="zb-next" style="margin-top:6px">
        <li>${Z.icon("domain")}<span>${esc(org.name)} gets a Safe of its own. Your personal account stays separate.</span></li>
        <li>${Z.icon("fingerprint")}<span>Your ${Z.passkeyName()} becomes its first signer. Approve once to set it up.</span></li>
      </ul>`, async () => {
      const start = await api(`/api/orgs/${org.id}/safe/deployment`, { method: "POST" });
      if (start.requestId) {
        let signed;
        try {
          signed = await (await deviceLib()).passkeyAssertion(start);
        } catch (e) {
          throw new Error(e.name === "NotAllowedError" ? Z.byDevice("Face ID was cancelled.", "The passkey prompt was cancelled.") : e.message);
        }
        await api(start.submitTo, { method: "POST", body: signed });
      }
      setTimeout(() => toast(`${org.name}’s Safe is set up.`), 0);
    }, { okLabel: "Set up" });
    return "keep";
  },
  async "invoice-pay-link"(el) {
    // No methods sent: the server takes every way the company's account may be
    // paid on this link, which is the payee's, not this member's. It picks the
    // amount from the invoice.
    const [r, page] = await Promise.all([
      api(`/api/orgs/${org.id}/payment-requests`, { method: "POST", body: { invoiceId: el.dataset.id } }),
      api(`/api/orgs/${org.id}/payment-page`).catch(() => null),
    ]);
    // Without a company page the link opens under the member's own page
    // address; the money still lands in this organisation's account.
    const personal = page && !page.paymentPage && page.ready
      ? ` It opens under your own page address (/pay/${r.handle}/…) because ${org.name} has no payment page yet; set one up under Get paid for links in the company’s name. The money goes to ${org.name}’s account either way.`
      : "";
    setTimeout(() => linkDialog("Payment link ready", `Send your customer this link. It asks for ${eur(r.amountEur)} and marks the invoice paid when the money arrives.${personal}`, r.url), 0);
  },
  async "new-pay-link"() {
    // A link opens under the company page when there is one; say which.
    const page = await api(`/api/orgs/${org.id}/payment-page`).catch(() => null);
    const where = page?.paymentPage
      ? ` It opens at ${esc(location.host)}/pay/${esc(page.paymentPage.handle)}/….`
      : page?.ready ? ` ${esc(org.name)} has no payment page yet, so it opens under your own page address. For links in the company’s name, ${["owner", "admin"].includes(org.role) ? "set up its page under Get paid first" : "ask an owner or admin to set up its page"}.` : "";
    dialog("New payment link",
      `<p class="desc">Your customer pays it into ${esc(org.name)}’s euro account. Leave the amount empty to let them enter it.${where}</p>
       ${field("d-desc", "What it’s for", 'maxlength="140" placeholder="Deposit, roof Weber…"')}
       ${field("d-amt", "Amount in euros (optional)", 'inputmode="decimal" placeholder="1200.00…"')}`,
      async () => {
        // The server takes every way the company's account can be paid now:
        // the account may be another member's, so this caller's methods do not decide.
        const amount = $("#d-amt").value.trim().replace(",", ".");
        const r = await api(`/api/orgs/${org.id}/payment-requests`, { method: "POST", body: { description: $("#d-desc").value, ...(amount ? { amountEur: amount } : {}) } });
        setTimeout(() => linkDialog("Payment link ready", `Send your customer this link.${typeof r.amountEur === "number" ? ` It asks for ${eur(r.amountEur)}.` : ""} It shows as paid here when the money arrives.`, r.url), 0);
      }, { okLabel: "Create link" });
  },
  async "org-page"() {
    const { paymentPage } = await api(`/api/orgs/${org.id}/payment-page`);
    const guess = (org.name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    dialog(paymentPage ? "Edit your payment page" : "Set up your payment page",
      `<p class="desc">A public page at ${esc(location.host)}/pay/… with this company’s name and the bank details of its euro account. Bank transfer only.</p>
       ${field("d-handle", "Address", `spellcheck="false" maxlength="30" value="${esc(paymentPage?.handle || guess)}"`)}
       <p class="zb-hint">3 to 30 lowercase letters, numbers and hyphens. A changed address stops the old link working.</p>
       ${field("d-dn", "Name on the page (optional)", `maxlength="40" value="${esc(paymentPage?.displayName || "")}" placeholder="${esc(org.legalName || org.name)}…"`)}`,
      async () => {
        await api(`/api/orgs/${org.id}/payment-page`, { method: "POST", body: { handle: $("#d-handle").value, displayName: $("#d-dn").value } });
        toast("Payment page saved.");
      }, { okLabel: paymentPage ? "Save" : "Create page" });
    return "keep";
  },
  async "cancel-link"(el) {
    await api(`/api/orgs/${org.id}/payment-requests/${el.dataset.id}/cancel`, { method: "POST" });
    toast("Link cancelled. It no longer takes payments.");
  },
  async "copy-text"(el) {
    try {
      await navigator.clipboard.writeText(el.dataset.text);
      toast(el.dataset.said || "Copied");
    } catch {
      toast("Couldn’t copy. Select the link and copy it by hand.", true);
    }
    return "keep";
  },
  async "check-profile"(el) {
    const r = await api(`/api/orgs/${org.id}/accounts/${el.dataset.id}/profile-check`, { method: "POST" });
    toast(plain(r.warning) || "Checked with Monerium. This account can send again.");
  },
  async "del-wallet"(el) {
    await api(`/api/orgs/${org.id}/wallets/${el.dataset.id}`, { method: "DELETE" });
  },
  /**
   * Prove a wallet is the organisation's: Zold issues a challenge, the person
   * signs it in the wallet itself, and the wallet's chain is asked. Nothing
   * here signs: the screen gives the exact text and takes back the
   * signature, or nothing from a Safe that signed the message on chain.
   */
  async "prove-wallet"(el) {
    const id = el.dataset.id;
    const { challenge } = await api(`/api/orgs/${org.id}/wallets/${id}/ownership/challenge`, { method: "POST" });
    dialog("Prove this wallet is yours",
      `<p class="desc">Sign this exact text in the wallet itself. It moves no funds and approves no transaction. Zold then asks the wallet’s own network whether the signature is valid.</p>
       <label for="pw-msg">Text to sign</label>
       <textarea id="pw-msg" rows="11" readonly class="z-mono" style="width:100%;font-size:12px" translate="no">${esc(challenge.message)}</textarea>
       <div class="zb-actions" style="margin:8px 0 12px"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="copy-text" data-text="${esc(challenge.message)}" data-said="Text copied">Copy the text</button></div>
       <ol class="zb-steps">
         <li>An ordinary wallet: sign the text as a message and paste the signature below.</li>
         <li>A Safe: sign it as a message in Safe{Wallet}. When enough owners have signed, paste the signature it shows. If the Safe signed the message on chain instead, leave the field empty.</li>
       </ol>
       <label for="pw-sig">Signature <span class="desc">(empty for a message the Safe signed on chain)</span></label>
       <textarea id="pw-sig" rows="3" class="z-mono" spellcheck="false" autocomplete="off" placeholder="0x…" style="width:100%"></textarea>
       <p class="zb-hint">The text is valid until ${esc(day(challenge.expiresAt))}. Hash, for checking: <span class="z-mono" translate="no">${esc(challenge.messageHash)}</span></p>`,
      async () => {
        const signature = $("#pw-sig").value.trim();
        await api(`/api/orgs/${org.id}/wallets/${id}/ownership`, { method: "POST", body: { challengeId: challenge.id, ...(signature ? { signature } : {}) } });
        toast("Proven: the wallet’s network accepted the signature.");
      }, { okLabel: "Check the signature" });
    return "keep";
  },
  async "recheck-wallet"(el) {
    const r = await api(`/api/orgs/${org.id}/wallets/${el.dataset.id}/ownership/recheck`, { method: "POST" });
    toast(r.wallet.proofState === "proven" ? "Checked: the proof still holds." : `The proof has lapsed: ${plain(r.wallet.ownership.lapseReason || "")}.`, r.wallet.proofState !== "proven");
  },
  async "revalue-row"(el) {
    const r = await api(`/api/orgs/${org.id}/ledger/${el.dataset.id}/revalue`, { method: "POST" });
    toast(`Valued at ${eur(Number(r.entry.fiatValue))}.`);
  },
  async "revalue-all"() {
    // A page of rows per call, in order, until none are left.
    const results = [];
    let after;
    do {
      const r = await api(`/api/orgs/${org.id}/ledger/revalue`, { method: "POST", body: after ? { after } : {} });
      results.push(...r.results);
      after = r.next;
      if (after) toast(`Asked for ${results.length} prices…`);
    } while (after);
    const count = (s) => results.filter((x) => x.status === s).length;
    const parts = [`${count("valued")} of ${results.length} valued.`];
    if (count("no-price")) parts.push(`${count("no-price")} still have no price.`);
    if (count("unreachable")) parts.push(`${count("unreachable")} could not be asked: the price source did not answer. Try again later.`);
    if (count("skipped")) parts.push(`${count("skipped")} cannot be revalued.`);
    toast(parts.join(" "), count("unreachable") > 0);
  },
  invite: () => {
    const roles = Object.keys(ROLE_WORD).filter((r) => r !== "owner" || org.role === "owner");
    const says = org.entity === "company"
      ? { viewer: "Viewer: sees everything, changes nothing", accountant: "Accountant: books and exports, no money", payer: "Payer: proposes payments; an owner signs them", admin: "Admin: proposes, approves, invites; an owner signs", owner: "Owner: everything, including signing payments and turning review off" }
      : { viewer: "Viewer: sees everything, changes nothing", accountant: "Accountant: books and exports, no money", payer: "Payer: proposes and sends", admin: "Admin: proposes, approves, sends, invites", owner: "Owner: everything, including turning review off" };
    dialog("Invite a member",
      `<p class="desc">Send the link yourself. Zold doesn’t send emails. It works once and ends in 3 days.</p>
       ${field("d-email", "Their email", 'type="email" spellcheck="false" autocomplete="email" placeholder="sara@lindner-holzbau.de…"')}
       <label for="d-role">Role</label><select id="d-role" name="role">${roles.map((r) => `<option value="${r}"${r === "payer" ? " selected" : ""}>${esc(says[r])}</option>`).join("")}</select>`,
      async () => {
        const r = await api(`/api/orgs/${org.id}/members`, { method: "POST", body: { email: $("#d-email").value.trim(), role: $("#d-role").value } });
        // No mail transport here, so hand the link over rather than pretend.
        setTimeout(() => linkDialog("Copy the invite link", "Send it to them yourself. It works once and ends in 3 days.", `${location.origin}/app?invite=${r.inviteToken}`), 0);
      }, { okLabel: "Create link" });
  },
  async deactivate(el) {
    await api(`/api/orgs/${org.id}/members/${el.dataset.id}`, { method: "PATCH", body: { status: "deactivated" } });
    toast("Removed. They can be added back.");
  },
  async reactivate(el) {
    await api(`/api/orgs/${org.id}/members/${el.dataset.id}`, { method: "PATCH", body: { status: "active" } });
  },
  "issue-invoice"() { setInvoiceDraft(null); setView("invoice-new"); },
  "inv-cancel"() { setInvoiceDraft(null); setView("invoices"); },
  "inv-save"() {
    toast(storeDraft() ? "Draft saved in this browser." : "This browser won’t keep a draft.", false);
    return "keep";
  },
  "inv-add-line"() {
    readInvoiceEditor();
    invoiceDraft.lines.push({ description: "", quantity: "1", unitPriceNet: "" });
  },
  "inv-del-line"(el) {
    readInvoiceEditor();
    invoiceDraft.lines.splice(Number(el.dataset.i), 1);
  },
  "inv-biz"() {
    readInvoiceEditor();
    invoiceDraft.recipient.isBusiness = !invoiceDraft.recipient.isBusiness;
    if (!invoiceDraft.recipient.isBusiness) invoiceDraft.recipient.vatId = "";
  },
  "inv-supply"(el) {
    readInvoiceEditor();
    invoiceDraft.supplyKind = el.dataset.kind === "goods" ? "goods" : "services";
  },
  /** Take the treatment the check suggested. Replaces, like inv-vat-mode. */
  "inv-apply-suggestion"() {
    readInvoiceEditor();
    const s = invoiceDraft._suggestion;
    if (!s) return "keep";
    invoiceDraft.vat = s.reason
      ? { kind: "exempt", reason: s.reason }
      : { kind: "standard", rate: invoiceDraft._defaultRate ?? "" };
  },
  "inv-vat-mode"(el) {
    readInvoiceEditor();
    // Switching mode REPLACES the treatment rather than merging: carrying a
    // rate across into the exempt arm is precisely the § 14c mistake.
    // The first available reason, not a German one: see the jurisdiction split.
    invoiceDraft.vat = el.dataset.mode === "exempt"
      ? { kind: "exempt", reason: invoiceDraft._reasons?.[0] ?? "other" }
      : { kind: "standard", rate: invoiceDraft._defaultRate ?? "" };
  },
  async "inv-issue"() {
    readInvoiceEditor();
    const issue = async (acceptWarnings) => {
      const r = await api(`/api/orgs/${org.id}/invoicing/issue`, { method: "POST", body: { ...invoiceBody(), ...(acceptWarnings ? { acceptWarnings: true } : {}) } });
      setInvoiceDraft(null);
      forgetDraft();
      setView("invoices");
      await render();
      // After any dialog that led here has closed.
      // One link to send: the invoice, with a Pay button when a payment link
      // could be made for it. When it could not, say why rather than hide it.
      const pay = r.payment;
      const how = pay?.ok
        ? `It opens the invoice with a Pay button${typeof pay.amountEur === "number" ? ` for ${eur(pay.amountEur)}` : ""}, and the invoice is marked paid when the money arrives.`
        : `It opens the invoice with your bank details. There’s no Pay button on it: ${plain(pay?.reason || "no payment link could be made.")}`;
      setTimeout(() => linkDialog(`Invoice ${r.invoice.issued.number} is ready`, `Send your customer this link. ${how}`, location.origin + r.linkPath), 0);
    };
    const tryIssue = async (acceptWarnings) => {
      try {
        await issue(acceptWarnings);
      } catch (e) {
        if (e.status === 409 && e.warnings?.length) {
          // Defer past the current dialog's close: this can run inside the
          // "not supported" dialog's submit, and showModal() on an open
          // dialog throws.
          setTimeout(() => dialog("Issue it with these warnings?", `<ul class="desc" style="margin:8px 0 0 18px">${e.warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul>
            <p class="desc" style="margin-top:12px">Your acceptance is recorded on the invoice.</p>`, () => tryIssue(true), { okLabel: "Issue anyway" }), 0);
          return;
        }
        throw e;
      }
    };
    // Outside Germany no national rules are encoded: issuing is the issuer's
    // own verification, said to their face once before the invoice goes out.
    const jur = invoiceDraft._jur;
    if (jur && jur.ruleSet !== "DE") {
      const checked = jur.ruleSet === "EU"
        ? `Zold checked the content the EU VAT Directive requires — both parties’ names and addresses, the dates, a unique number and, for reverse charge, both VAT IDs — but nothing against ${esc(jur.countryName)}’s own invoicing or tax law.`
        : `Zold checked only that this invoice names you, your address and a unique number — nothing in it is verified against ${esc(jur.countryName)}’s invoicing or tax law.`;
      dialog(`${jur.countryName}: ${jur.ruleSet === "EU" ? "national " : ""}invoicing rules not supported`,
        `<p class="desc">${checked}</p>
         <p class="desc" style="margin-top:10px">It goes out exactly as you wrote it: the number, both parties’ details, the amounts and the tax line are yours to verify — with your accountant where you have one.</p>`,
        () => tryIssue(false), { okLabel: "I verified it — issue" });
      return "keep";
    }
    await tryIssue(false);
    return "keep";
  },
  "add-custom-reason": () => dialog("Add your own rule",
    `<p class="desc">For something your country requires that Zold doesn’t encode. The note is printed on the invoice exactly as you write it, and isn’t checked.</p>
     ${field("cr-id", "Short id", 'placeholder="gst_rcm…"')}
     ${field("cr-label", "Name", 'placeholder="GST reverse charge…"')}
     ${field("cr-basis", 'Legal basis <span class="desc">(optional)</span>', 'placeholder="Section 9(3) CGST Act…"')}
     ${field("cr-note", "Note printed on the invoice", 'placeholder="Tax payable under reverse charge…"')}
     <label class="zb-check"><input type="checkbox" id="cr-vat" /><span><b>Needs the customer’s tax number</b></span></label>`,
    async () => {
      const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
      const existing = d.profile.customReasons ?? [];
      await api(`/api/orgs/${org.id}/invoicing/profile`, {
        method: "PATCH",
        body: {
          customReasons: [...existing, {
            id: $("#cr-id").value, label: $("#cr-label").value,
            legalBasis: $("#cr-basis").value, invoiceNote: $("#cr-note").value,
            requiresRecipientVatId: $("#cr-vat").checked,
          }],
        },
      });
    }, { okLabel: "Add rule" }),
  async "del-custom-reason"(el) {
    const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
    await api(`/api/orgs/${org.id}/invoicing/profile`, {
      method: "PATCH",
      body: { customReasons: (d.profile.customReasons ?? []).filter((c) => c.id !== el.dataset.id) },
    });
  },
  async "save-invoicing"() {
    const val = (id) => $("#" + id)?.value?.trim() ?? "";
    // Who the issuer is (name, address, tax and registration numbers) is the
    // business profile's, saved there; this saves only how invoices are made.
    const display = {};
    document.querySelectorAll("[data-display]").forEach((el) => { display[el.dataset.display] = el.checked; });
    // A new payout IBAN takes an owner or admin and a passkey approval. It is
    // asked for before anything is sent, so a cancelled passkey saves nothing.
    const current = await api(`/api/orgs/${org.id}/invoicing/profile`);
    const typedIban = val("i-bank-iban").replace(/\s+/g, "").toUpperCase();
    const stepUp = typedIban !== (current.profile.bank?.iban || "") ? await passkeyStepUp("org.invoice-iban.change") : undefined;
    await api(`/api/orgs/${org.id}/invoicing/profile`, {
      method: "PATCH",
      body: {
        language: val("i-lang") || "en",
        smallBusiness: $("#i-klein")?.checked === true,
        defaultVatRate: $("#i-rate")?.value ? Number($("#i-rate").value) : undefined,
        paymentTermsDays: val("i-terms-days") ? Number(val("i-terms-days")) : undefined,
        paymentTermsNote: val("i-terms"),
        footerNote: val("i-footer"),
        bank: { holder: val("i-bank-holder"), iban: val("i-bank-iban"), bic: val("i-bank-bic") },
        numberSeries: { prefix: val("i-prefix"), next: Number(val("i-next") || 1), padding: 4 },
        display,
        stepUp,
      },
    });
    toast("Invoicing profile saved.");
  },
  "collect-receipts": () => {
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const d = new Date();
    const current = ym(d);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    dialog("Collect receipts into draft invoices",
      `<p class="desc">For each contact with a payer rule, the month’s payments into your imported wallets become one draft invoice. Collecting a month again updates its drafts and never touches an issued invoice. A month that is still running can be collected; what arrives later joins its draft the next time you collect.</p>
       <label for="rc-month">Month</label><input id="rc-month" name="rc-month" type="month" value="${ym(d)}" max="${current}" />`,
      async () => {
        const r = await api(`/api/orgs/${org.id}/income-invoices/run`, { method: "POST", body: { month: $("#rc-month").value } });
        // After this dialog has closed.
        setTimeout(() => dialog("Receipts collected", runSummary(r), null, { closeOnly: true }), 0);
      }, { okLabel: "Collect" });
    return "keep";
  },
  async "issue-receipt-draft"(el) {
    const id = el.dataset.id;
    const issue = async (acceptWarnings) => {
      const r = await api(`/api/orgs/${org.id}/income-invoices/${id}/issue`, { method: "POST", body: acceptWarnings ? { acceptWarnings: true } : {} });
      Z.closeOverlay("inv-drawer");
      // Queued whether or not the redraw works, and after it, so a dialog
      // that led here has closed by then.
      const showLink = () => setTimeout(() => linkDialog(`Invoice ${r.invoice.issued.number} is issued`, "It is marked paid by the receipts it bills. This link shows the invoice.", location.origin + r.linkPath), 0);
      try { await render(); } finally { showLink(); }
    };
    try {
      await issue(false);
    } catch (e) {
      if (e.status === 409 && e.warnings?.length) {
        // An open drawer makes the rest of the page inert, a dialog included.
        Z.closeOverlay("inv-drawer");
        dialog("Issue it with these warnings?", `<ul class="desc" style="margin:8px 0 0 18px">${e.warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul>
          <p class="desc" style="margin-top:12px">Your acceptance is recorded on the invoice.</p>`, () => issue(true), { okLabel: "Issue anyway" });
        return "keep";
      }
      // The draft was rebuilt under us: show the new one, not the stale drawer.
      if (e.changed) {
        Z.closeOverlay("inv-drawer");
        await render();
      }
      throw e;
    }
    return "keep";
  },
  "discard-receipt-draft": (el) => {
    Z.closeOverlay("inv-drawer");
    dialog("Discard this draft?",
      `<p class="desc">Its receipts go back to being uninvoiced. Collecting the month again makes a new draft from them.</p>`,
      async () => {
        await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}`, { method: "DELETE" });
        toast("Draft discarded.");
      }, { okLabel: "Discard" });
    return "keep";
  },
  "invoice-link": async (el) => {
    const r = await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/link`);
    // One overlay at a time: the drawer closes before the dialog opens.
    Z.closeOverlay("inv-drawer");
    setTimeout(() => linkDialog("Copy the invoice link", "Anyone with this link can open the invoice.", location.origin + r.linkPath), 0);
    return "keep";
  },
  "pay-invoice": async (el) => {
    const r = await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/pay`, { method: "POST", body: {} });
    toast(plain(r.note) || "Payment run drafted. It’s in Approvals.");
  },
  "correct-invoice": (el) => {
    const id = el.dataset.id;
    const correct = async (acceptWarnings) => {
      const r = await api(`/api/orgs/${org.id}/invoices/${id}/correct`, { method: "POST", body: acceptWarnings ? { acceptWarnings: true } : {} });
      // Paid already: nothing to collect. Otherwise say whether it has a Pay button, and why not.
      const pay = r.payment;
      const how = r.invoice.state === "PAID" ? "It is already paid."
        : pay?.ok ? `It has a Pay button${typeof pay.amountEur === "number" ? ` for ${eur(pay.amountEur)}` : ""}.`
        : `There’s no Pay button on it${pay?.reason ? `: ${plain(pay.reason)}` : "."}`;
      const showLink = () => setTimeout(() => linkDialog(`Invoice ${r.invoice.issued.number} replaces ${el.dataset.number}`,
        `Send your customer this link. ${how} The old invoice’s link now says it was replaced; money sent with its payment details counts for the new one.`, location.origin + r.linkPath), 0);
      try { await render(); } finally { showLink(); }
    };
    Z.closeOverlay("inv-drawer");
    dialog(`Correct invoice ${el.dataset.number}?`,
      `<p class="desc">A new invoice with the next number and today’s date, the same customer, lines and amount, and your business details as they are now. It says which invoice it replaces.</p>
       <p class="desc" style="margin-top:8px">The old invoice stays in your records, marked replaced. Any payment on it counts for the new one.</p>`,
      async () => {
        try {
          await correct(false);
        } catch (e) {
          if (e.status === 409 && e.warnings?.length) {
            setTimeout(() => dialog("Issue it with these warnings?", `<ul class="desc" style="margin:8px 0 0 18px">${e.warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul>
              <p class="desc" style="margin-top:12px">Your acceptance is recorded on the invoice.</p>`, () => correct(true), { okLabel: "Issue anyway" }), 0);
            return;
          }
          throw e;
        }
      }, { okLabel: "Issue corrected invoice" });
    return "keep";
  },
  "reconcile-invoice": (el) => dialog("Mark this invoice as paid",
    `${field("d-note", 'Note <span class="desc">(optional)</span>', 'placeholder="Paid from the company’s other bank account on 3 Sept…"')}`,
    async () => {
      await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/reconcile`, { method: "POST", body: { note: $("#d-note").value || undefined } });
      toast("Marked as paid.");
    }, { okLabel: "Mark as paid" }),
  "new-invoice": async () => {
    // A wallet is offered only where the API would pay one (capabilities().cryptoSend).
    const wallets = (await readHealth().catch(() => null))?.capabilities?.cryptoSend === true;
    dialog("Request an invoice",
    `<p class="desc">Your supplier fills in a link, with no account. You pay it by bank transfer${wallets ? ", or to their wallet" : ""}.</p>
     <label for="d-cur">Currency</label><select id="d-cur" name="currency">
       <option value="EUR">Euro: bank transfer${wallets ? ", or EURe to a wallet" : ""}</option>
       ${wallets ? `<option value="USD"${org.reporting.currency === "USD" ? " selected" : ""}>US dollar: USDC to a wallet</option>` : ""}</select>
     ${field("d-due", 'Due <span class="desc">(optional)</span>', 'type="date"')}
     ${field("d-pw", 'Password <span class="desc">(optional, 12 characters or more)</span>', 'type="password" autocomplete="new-password" minlength="12" placeholder="Send it separately from the link…"')}`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/invoices`, {
        method: "POST",
        body: { currency: $("#d-cur").value, dueDate: $("#d-due").value || undefined, password: $("#d-pw").value || undefined },
      });
      setTimeout(() => linkDialog("Copy the invoice link", plain(r.note) || "Send it to your supplier yourself.", location.origin + r.linkPath), 0);
    }, { okLabel: "Create link" });
  },
  "new-coa": () => dialog("Add a category",
    `${field("d-code", "Code", 'inputmode="numeric" placeholder="6400…"')}
     ${field("d-name", "Name", 'placeholder="Marketing…"')}
     <label for="d-type">Type</label><select id="d-type" name="type"><option value="expense">Expense</option><option value="revenue">Revenue</option>
       <option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option></select>`,
    async () => {
      await api(`/api/orgs/${org.id}/chart-of-accounts`, { method: "POST", body: { code: $("#d-code").value, name: $("#d-name").value, type: $("#d-type").value } });
    }, { okLabel: "Add category" }),
  async "apply-rules"() {
    const r = await api(`/api/orgs/${org.id}/account-rules/apply`, { method: "POST" });
    toast(`${r.changed} transaction${r.changed === 1 ? "" : "s"} sorted again. ${plain(r.note)}`);
  },
  async "export-ledger"() {
    await download(`/api/orgs/${org.id}/export/ledger.csv`, "transactions.csv");
  },

  // ── Books and the month's export ─────────────────────────────────────────
  "bk-memo": (el) => {
    const l = bk.lines.find((x) => x.id === el.dataset.id);
    if (!l) return;
    dialog(l.note ? "Change the memo" : "Add a memo",
      `<p class="desc">${esc(l.counterparty?.name || "This line")}, ${esc(day(`${l.valueDate}T12:00:00`))}. Your accountant sees it next to the line.</p>
       ${field("d-memo", "Memo", `maxlength="200" value="${esc(l.note || "")}" placeholder="Timber, lot 44…"`)}`,
      async () => {
        await api(`/api/orgs/${org.id}/ledger/${l.id}`, { method: "PATCH", body: { note: $("#d-memo").value.trim() } });
      }, { okLabel: "Save" });
  },
  /** The line stays on the statement; the view redraws with its category gone or back. */
  async "bk-own"(el) {
    const own = el.dataset.own === "true";
    await api(`/api/orgs/${org.id}/ledger/${el.dataset.id}/own-transfer`, { method: "PUT", body: { own } });
    toast(own ? "Marked as between your own accounts: not income or an expense." : "Back in your income and expenses.");
  },
  async "export-rebuild"() {
    const r = await api(`/api/orgs/${org.id}/bookkeeping/statement/rebuild`, { method: "POST" });
    toast(`${r.added} line${r.added === 1 ? "" : "s"} added, ${r.updated} refreshed. Categories you set yourself were left alone.`);
  },
  async "export-prepare"() {
    const month = monthChosen();
    const r = await api(`/api/orgs/${org.id}/bookkeeping/export/${month}/prepare`, { method: "POST" });
    toast(`${month}: ${r.lines} line${r.lines === 1 ? "" : "s"}, ${r.belegeIssued} receipt${r.belegeIssued === 1 ? "" : "s"} created${r.failed.length ? `, ${r.failed.length} failed` : ""}.`, r.failed.length > 0);
  },
  async "export-csv"() {
    const month = monthChosen();
    await download(`/api/orgs/${org.id}/bookkeeping/export/${month}/lexware.csv`, `zold-${month}-lexware.csv`);
  },
  async "export-zip"() {
    const month = monthChosen();
    await download(`/api/orgs/${org.id}/bookkeeping/export/${month}/belege.zip`, `zold-${month}-belege.zip`);
  },
  async "line-beleg"(el) {
    const r = await api(`/api/orgs/${org.id}/bookkeeping/lines/${el.dataset.line}/beleg`, { method: "POST" });
    toast(`Receipt ${r.code} ${r.issued ? "created" : "already existed"}.`);
  },
  /** The old receipt is revoked, not deleted: its page then says so. */
  async "line-beleg-replace"(el) {
    const r = await api(`/api/orgs/${org.id}/bookkeeping/lines/${el.dataset.line}/beleg/replace`, { method: "POST" });
    toast(`Receipt ${r.code} created${r.revoked ? "; the old one is revoked" : ""}. Download the month's export again for your accountant.`);
  },
  /** One step from Connections or the export page: pick the month, send.
   *  The server issues any missing Beleg first; the result says what landed. */
  async "gmi-push"() {
    const [{ months }, banks, { integrations }] = await Promise.all([
      api(`/api/orgs/${org.id}/bookkeeping/statement`),
      // A failed read is said as such, not as "no manual bank account".
      api(`/api/orgs/${org.id}/integrations/getmyinvoices/bank-accounts`).then((r) => r.bankAccounts.filter((b) => b.accountType === "CUSTOM")).catch((e) => ({ error: plain(e.message) })),
      api(`/api/orgs/${org.id}/integrations`),
    ]);
    if (!months.length) return toast("There are no statement lines yet, so there is nothing to send.");
    const preset = view === "export" ? monthChosen() : months[0];
    const picked = integrations.getmyinvoices?.bankAccountUid;
    const name = (m) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${m}-15T12:00:00`));
    const bankField = banks.error
      ? `<p class="zb-hint" style="margin-top:12px">The bank accounts in GetMyInvoices could not be read: ${esc(banks.error)} Only the receipts go up unless that is fixed before you send.</p>`
      : banks.length
      ? `<label for="gmi-bank">Bank account in GetMyInvoices</label><select id="gmi-bank" name="bank">${banks.map((b) => `<option value="${esc(String(b.bankAccountUid))}"${b.bankAccountUid === picked ? " selected" : ""}>${esc(b.name || `Account ${b.bankAccountUid}`)}</option>`).join("")}</select>`
      : `<p class="zb-hint" style="margin-top:12px">GetMyInvoices has no manual bank account yet, so only the receipts go up. Add one there (Bank accounts → add a manual account, e.g. “Zold”) and send again to add the bank lines.</p>`;
    dialog("Send to GetMyInvoices", `<p class="desc">Each bank line of the month goes to the bank account you pick, with its booking receipt attached as the document. Lines without one get one first. Anything already there is skipped, never doubled.</p>
      <label for="gmi-month">Month</label><select id="gmi-month" name="month">${months.map((m) => `<option value="${esc(m)}"${m === preset ? " selected" : ""}>${esc(name(m))}</option>`).join("")}</select>
      ${bankField}`,
      async () => {
        const month = $("#gmi-month").value;
        const bank = $("#gmi-bank")?.value;
        const r = await api(`/api/orgs/${org.id}/integrations/getmyinvoices/push`, { method: "POST", body: { month, ...(bank ? { bankAccountUid: Number(bank) } : {}) } });
        const n = (k) => r.results.filter((x) => x.outcome === k).length;
        const bl = (k) => r.results.filter((x) => x.bankLine?.outcome === k).length;
        const attached = r.results.filter((x) => x.bankLine?.assigned).length;
        const late = r.results.filter((x) => x.tagsMayBeMissing).length;
        const rows = [
          [bl("added"), "bank lines added"], [bl("exists"), "bank lines already there"], [attached, "with their receipt attached"],
          [n("uploaded"), "receipts sent now"], [n("exists"), "receipts already there, skipped"],
          [n("failed") + bl("failed"), "failed: send again; whatever did arrive is skipped"],
          [n("unknown") + bl("unknown"), "got no answer and can’t be found there yet: send again in a few minutes"],
          [r.results.filter((x) => x.outcome === "no-beleg" && !x.stale).length, "lines that could not get a receipt, so not sent"],
          [r.results.filter((x) => x.stale).length, "receipts that no longer match the books, so not sent: replace them in Books and send again (a payout Monerium rejected can’t be replaced; Books says why)"],
          [r.results.reduce((k, x) => k + (x.bankLine?.revokedStillAttached ?? 0), 0), "replaced receipts still attached to their bank line in GetMyInvoices: remove the old one there; Zold does not detach it"],
          [late, "receipts that arrived slowly and may be missing their tags"],
        ].filter(([k]) => k > 0);
        const body = r.results.length
          ? `<ul class="zb-next" style="margin-top:10px">${rows.map(([k, t]) => `<li><b>${k}</b>&nbsp;${esc(t)}</li>`).join("")}</ul>
             ${r.bankAccountUid ? "" : r.bankAccountsError
               ? `<p class="desc" style="margin-top:12px">No bank lines were added: the bank accounts in GetMyInvoices could not be read (${esc(plain(r.bankAccountsError))}). Send again later.</p>`
               : `<p class="desc" style="margin-top:12px">No bank lines were added: GetMyInvoices has no manual bank account to add them to. Add one there and send again.</p>`}`
          : `<p class="desc">${esc(name(month))} has no bank lines.</p>`;
        setTimeout(() => dialog(`${name(month)} sent to GetMyInvoices`, body, null, { closeOnly: true }), 0);
      }, { okLabel: "Send" });
  },
  "gmi-disconnect": () => dialog("Remove the GetMyInvoices key?", `<p class="desc">Nothing already uploaded is touched.</p>`,
    async () => { await api(`/api/orgs/${org.id}/integrations/getmyinvoices`, { method: "DELETE" }); toast("Key removed."); }, { okLabel: "Remove key" }),
  /** Company or sole trader: an owner, until the euro account is set up
   *  (the API answers 409 ENTITY_LOCKED after that). */
  "org-entity": () => dialog("Legal form", `<label for="d-entity">Legal form</label>
      <select id="d-entity">
        <option value="company"${org.entity === "company" ? " selected" : ""}>Company: its own legal person (GmbH, UG, AG, Ltd…)</option>
        <option value="sole_trader"${org.entity === "sole_trader" ? " selected" : ""}>Sole trader: you trade under your own name</option>
      </select>
      <p class="desc">It can’t change once the euro account is set up.</p>`,
    async () => {
      await api(`/api/orgs/${org.id}`, { method: "PATCH", body: { entity: $("#d-entity").value } });
      await loadOrg(org.id);
      toast("Saved.");
    }),
  async "save-org"() {
    const body = {
      name: $("#s-name").value, legalName: $("#s-legal").value,
      vatId: $("#s-vatid").value, taxNumber: $("#s-taxno").value,
      registerCourt: $("#s-court").value, registerNumber: $("#s-reg").value, managingDirector: $("#s-gf").value,
      email: $("#s-email").value, notificationEmail: $("#s-notify").value,
      address: {
        line1: $("#s-addr1").value, line2: $("#s-addr2").value,
        postalCode: $("#s-zip").value, city: $("#s-city").value,
        country: $("#s-country").value,
      },
    };
    const cur = $("#s-currency");
    const tz = $("#s-tz");
    const reporting = {};
    if (cur && !cur.disabled && cur.value !== org.reporting.currency) reporting.currency = cur.value;
    if (tz && tz.value.trim() && tz.value.trim() !== org.reporting.timeZone) reporting.timeZone = tz.value.trim();
    if (Object.keys(reporting).length) body.reporting = reporting;
    await api(`/api/orgs/${org.id}`, { method: "PATCH", body });
    toast("Saved.");
    await loadOrg(org.id);
  },

  // ── Payment runs ─────────────────────────────────────────────────────────
  /** A new run of one payment: saved, then (with approvals) submitted, so it
   *  waits in Approvals for someone other than the drafter. */
  /** Bank transfer or crypto wallet on the Send screen; the shell draws it again. */
  "send-mode"(el) {
    sendState.mode = el.dataset.mode === "crypto" ? "crypto" : "bank";
    sendState.amount = $("#d-amt")?.value || "";
  },
  /** A payee with a wallet on this network: an ENS name is resolved here and
   *  the address is what is saved, so the run pays the address shown. */
  "new-wallet-contact": () => dialog("Add a wallet contact",
    `${field("d-name", "Name", 'autocomplete="organization" placeholder="Druckerei Kessler…"')}
     ${field("d-wallet", "ENS name or 0x address", 'spellcheck="false" autocomplete="off" placeholder="kessler.eth or 0x…"')}
     <p class="desc">Only an address on this network. Tokens sent to an address on another network can be lost.</p>`,
    async () => {
      const typed = $("#d-wallet").value.trim();
      let address = typed;
      let label;
      if (!/^0x[0-9a-fA-F]{40}$/.test(typed)) {
        if (!typed.includes(".")) throw new Error("Enter an ENS name like kessler.eth, or an address: 0x and 40 hex characters.");
        const found = await api(`/api/ens/lookup?name=${encodeURIComponent(typed)}`);
        address = found.address;
        label = found.name;
      }
      const net = (await api("/api/health")).chainId ?? chainId;
      const { contact } = await api(`/api/orgs/${org.id}/contacts`, {
        method: "POST",
        body: { name: $("#d-name").value, wallets: [{ chainId: net, address, ...(label ? { label } : {}) }] },
      });
      sendState.contactId = contact.id;
      toast(label ? `Contact added: ${label} is ${address}.` : "Contact added.");
    }, { okLabel: "Add contact" }),
  async "send-create"() {
    const err = $("#send-err");
    err.textContent = "";
    const crypto = sendState.mode === "crypto" && !!$("#send-form input[name=token]");
    const picked = (name) => $(`#send-form input[name="${name}"]:checked`)?.value;
    let lines;
    if (crypto) {
      const amount = sendAmount($("#d-amt").value, true);
      if (!amount) {
        err.textContent = "Enter an amount, like 250 or 12.5 (at most 6 decimals).";
        $("#d-amt").focus();
        return "keep";
      }
      if (!picked("contact")) { err.textContent = "Pick who you’re paying."; return "keep"; }
      const [{ contacts }, health] = await Promise.all([api(`/api/orgs/${org.id}/contacts`), api("/api/health")]);
      const c = contacts.find((x) => x.id === picked("contact"));
      const w = c && walletOf(c, health.chainId);
      if (!w) { err.textContent = "That contact has no wallet on this network."; return "keep"; }
      lines = [{ contactId: c.id, destination: { kind: "wallet", chainId: w.chainId, address: w.address, displayName: c.name }, asset: picked("token") === "USDC" ? "USDC" : "EURE", amount, note: $("#d-note").value.trim() || undefined }];
    } else {
      // Every payee picked, each with its own amount and note, as one draft.
      // The contacts are read again: a line is built from the address book as
      // it is now, never from what the form drew.
      const els = [...document.querySelectorAll("#send-lines [data-line]")];
      const rows = els.map(payeeRow);
      const { contacts } = rows.length ? await api(`/api/orgs/${org.id}/contacts`) : { contacts: [] };
      const built = bankLines(rows, contacts, { companyBank: org.entity === "company" });
      if (built.error) {
        err.textContent = built.error;
        els.find((el) => el.dataset.line === built.contactId)?.querySelector('[data-lf="amount"]').focus();
        return "keep";
      }
      lines = built.lines;
    }
    const r = await api(`/api/orgs/${org.id}/drafts`, {
      method: "POST",
      body: { source: { kind: "account", accountId: picked("account") }, lines },
    });
    sendState.contactId = null;
    sendState.mode = "bank";
    // A company's bank payment has no review step: an owner sends it (Q8).
    if (org.entity === "company" && !crypto) {
      ap.tab = "drafts";
      toast(roleCan(org.role, "sign") ? `Saved. Send it from the list with your ${Z.passkeyName()}.` : "Saved. An owner sends it with their passkey.");
      return setView("payments");
    }
    if (reviewOn()) {
      try {
        await api(`/api/orgs/${org.id}/drafts/${r.draft.id}/submit`, { method: "POST" });
      } catch (e) {
        // The draft exists: staying on the form would make a second press draft it again.
        ap.tab = "drafts";
        setView("payments");
        toast(`Saved as a draft, but not submitted: ${plain(e.message)} Submit it from Drafts.`, true);
        return;
      }
      ap.tab = "waiting";
      toast("Submitted. Someone other than you approves it next.");
    } else {
      ap.tab = "drafts";
      toast(`Saved. Send it from the list with your ${Z.passkeyName()}.`);
    }
    setView("payments");
  },
  /** Turning review off removes a control, so the owner approves it with
   *  their passkey; the server checks that approval and the owner role. */
  "review-off"() {
    dialog("Turn payment review off?",
      `<p class="desc">Anyone who may send payments could then send one without a second person approving it. Payments already waiting for review keep waiting until someone approves them. You’ll confirm with your ${Z.passkeyName()}.</p>`,
      async () => {
        const stepUp = await passkeyStepUp("org.payment-review.off");
        await api(`/api/orgs/${org.id}/payment-review`, { method: "POST", body: { required: false, stepUp } });
        await loadOrg(org.id);
        toast("Payment review is off.");
      },
      { okLabel: "Turn off" });
  },
  /** Queue adding Zoldenburg as the company Safe's recovery guardian, for
   *  the owners to sign. Owner only; the API decides. */
  async "org-recovery-setup"() {
    const r = await api(`/api/orgs/${org.id}/recovery/guardian`, { method: "POST" });
    toast(r.note || (r.op ? "Adding Zoldenburg UG is already queued for the owners’ signatures." : "Zoldenburg UG is already the guardian of the company’s Safe."));
  },
  async "review-on"() {
    await api(`/api/orgs/${org.id}/payment-review`, { method: "POST", body: { required: true } });
    await loadOrg(org.id);
    toast("Payment review is on. Every payment now needs a second approval.");
  },
  async "submit-draft"(el) {
    await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/submit`, { method: "POST" });
    ap.tab = "waiting";
    toast("Submitted for approval.");
  },
  /**
   * Send: create one transfer per line, then sign each on this device.
   *
   * Execution and signing are deliberately separate round trips. The server
   * never holds the key, so the batch exists as unsigned transfers until the
   * device signs them, and if signing is abandoned halfway, the rest simply
   * expire without moving anything.
   */
  async "exec-draft"(el) {
    let r;
    try {
      r = await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/execute`, { method: "POST" });
    } catch (e) {
      // A company's bank run: the owner signs each line with their passkey.
      if (e.code === "COMPANY_BANK_RUN_SIGN" && e.startTo) return signCompanyBankRun(e.startTo);
      throw e;
    }

    if (r.unsigned) {
      return dialog("Approve in your own wallet",
        `<p class="desc">${esc(r.note)}</p>
         <div class="z-tbl-wrap"><table class="z-tbl"><thead><tr><th>To</th><th>Amount</th></tr></thead><tbody>${r.lines
           .map((l) => `<tr><td>${esc(l.destination.displayName)}</td>
             <td class="mono">${esc(l.amount)} ${esc(l.asset)}</td></tr>`).join("")}</tbody></table></div>`,
        null, { closeOnly: true });
    }
    // A company's send is queued for its owners; nobody signs it here.
    if (r.safeOp) return toast(r.note);
    if (r.cryptoSends?.length) return signCryptoRun(r.cryptoSends);
    if (!r.authorizations?.length) return toast(r.note || "Nothing to approve.");

    // Before the first prompt: every line's deadline is already running, and
    // a run sent again would pay its sent lines twice.
    const warning = signingWarning(r.authorizations, Date.now() / 1000);
    const sign = async () => {
      const lib = await deviceLib();
      // The passkey that wraps this browser's device key, from the session:
      // nothing writes it to storage.
      const session = await api("/api/session");
      const credentialId = session.passkey?.credentialId;
      if (!credentialId) throw new Error("This account has no passkey here, so nothing can be approved.");
      let approved = 0;
      let expired = 0;
      let failed = 0;
      const progress = () => showProgress(approvalProgress(approved, expired, r.authorizations.length, failed), $("#dlg"), $("#dlg-progress"), toast);
      const lines = [];
      for (const a of r.authorizations) {
        // No passkey prompt for a line the server would refuse.
        if (Date.now() / 1000 > Number(a.authorization.typedData.message.deadline)) {
          lines.push({ recipient: a.recipient, outcome: "not_sent", why: "approval expired" });
          expired++;
          progress();
          continue;
        }
        let submitted = false;
        try {
          const signature = await lib.signTypedData(a.authorization.typedData, credentialId, a.authorization.authorizer);
          // The debit itself is a Safe operation the passkey signs, then the
          // Monerium redeem order on a SEPA line, in that order, as the server
          // verifies them (authenticator counters rise with each ceremony).
          const executionAssertion = await lib.passkeyAssertion(a.authorization.safeExecution);
          const moneriumRedeemAssertion = await lib.passkeyAssertion(a.authorization.moneriumRedeem);
          submitted = true;
          const t = await api(a.authorization.submitTo, {
            method: "POST",
            body: {
              signature,
              ...(executionAssertion ? { executionAssertion } : {}),
              ...(moneriumRedeemAssertion ? { moneriumRedeemAssertion } : {}),
            },
          });
          lines.push({ recipient: a.recipient, outcome: signedLineOutcome(t, true) });
          approved++;
          progress();
        } catch (e) {
          // Reported per line rather than aborting silently: the ones already
          // signed are real payments and the user must know which.
          lines.push({ recipient: a.recipient, outcome: submitted ? signedLineOutcome(e, false) : "not_sent", why: plain(e.message) });
          failed++;
          progress();
        }
      }
      const done = signedRunToast(r.authorizations.length, lines);
      toast(done.text, done.error);
    };
    if (!warning) return sign();
    // Signing runs from the dialog's own button, inside the click that allows a passkey prompt.
    return dialog("Approve each payment", `<p class="desc">${esc(warning)}</p><p class="desc" id="dlg-progress" role="status"></p>`, sign, { okLabel: "Start approving" });
  },
};
