/**
 * Everything a [data-act] button does, keyed by action name.
 *
 * A map rather than a chain of ifs, for the same reason RENDER is one: the
 * shell dispatches on the attribute, so an action exists by being named here
 * and nowhere else. An action that opens a drawer returns "keep", so the
 * shell does not draw the page again under it.
 */
import { $, Z, api, cap, day, dialog, esc, eur, maskIban, me, org, plain, roleCan, ROLE_WORD, setView, toast, token, view } from "./core.js";
import { docHref, docMonth, exportMonth, sendState, setExportMonth } from "./views.js";
import { forgetDraft, invoiceBody, invoiceDraft, readInvoiceEditor, setInvoiceDraft, storeDraft } from "./invoice.js";
import { ap, bk, contactPayments, ct, draftTag, draftTitle, draftTotal, invoiceDrawer, iv, mayReview, memberName } from "./screens.js";
import { loadOrg, render } from "./shell.js";

/** A file the API serves behind the bearer header, which a navigation
 *  cannot carry: fetch it, then hand the bytes to the browser as a download. */
async function download(path, filename) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return toast("The download failed. Try again.", true);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* The month an export acts on: Books' month there, the statement's month on
   the statement screen. */
function monthChosen() {
  const v = $("#x-month")?.value || (view === "books" ? bk.month : exportMonth);
  setExportMonth(v);
  return v;
}

/* A link handed over once: no mail goes out, so the person copies it. */
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
const field = (id, label, extra = "") => `<label for="${id}">${label}</label><input id="${id}" name="${id}" autocomplete="off" ${extra} />`;

/* ── Payment runs ─────────────────────────────────────────────────────── */

/** One run in a drawer: who drafted it, each line, and, when this person may
 *  review it, Approve and Send back. Four eyes is the server's call too. */
async function draftDrawer(el) {
  const [{ drafts }, { contacts }] = await Promise.all([
    api(`/api/orgs/${org.id}/drafts`),
    // Only to show the IBAN next to each payee; the review still works without.
    api(`/api/orgs/${org.id}/contacts`).catch(() => ({ contacts: [] })),
  ]);
  const d = drafts.find((x) => x.id === el.dataset.id);
  if (!d) throw new Error("This payment run no longer exists.");
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
      : d.state === "PENDING_REVIEW" ? `<p class="zb-hint">${esc(may.reason)}</p>` : ""}`;
  const scrim = drawer("draft-drawer", draftTitle(d), body, el);
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

/* ── Contacts ─────────────────────────────────────────────────────────── */

function contactDrawer(el) {
  const c = ct.contacts.find((x) => x.id === el.dataset.id);
  if (!c) return;
  const b = c.bankAccounts.find((x) => x.iban) || c.bankAccounts[0];
  const pays = contactPayments(c);
  const open = ct.drafts.filter((d) => ["DRAFT", "PENDING_REVIEW", "REVIEWED", "INVALID_DATA", "REJECTED"].includes(d.state) && d.lines.some((l) => l.contactId === c.id));
  const canPay = cap("transfers.drafts").allowed && roleCan(org.role, "propose") && b?.iban;
  const body = `${c.email ? `<p class="zb-hint">${esc(c.email)}</p>` : ""}
    ${b?.iban ? `<ul class="z-list z-card"><li>${Z.copyRow({ label: "IBAN", value: String(b.iban).replace(/\s+/g, ""), display: Z.groupIban(b.iban), mono: true })}</li>${b.holderName && b.holderName !== c.name ? `<li>${Z.copyRow({ label: "Account holder", value: b.holderName })}</li>` : ""}</ul>` : `<p class="zb-hint">No bank details yet.</p>`}
    ${open.length ? `<div class="zb-note zb-note--a">${Z.icon("warning")}<span>${open.length === 1 ? "A payment run uses" : `${open.length} payment runs use`} these bank details. Changing them sends ${open.length === 1 ? "it" : "them"} back to be checked again.</span></div>` : ""}
    <section><h3 class="z-eyebrow" style="margin-bottom:8px">Past payments</h3>${pays.length
      ? `<dl class="z-kv z-card">${pays.slice(0, 8).map((p) => `<div><dt>${esc(day(p.at))}</dt><dd class="z-fig">−${esc(/^EUR/i.test(p.asset) ? eur(p.amount) : `${p.amount} ${p.asset}`)}</dd></div>`).join("")}</dl>`
      : '<p class="zb-hint">None yet.</p>'}</section>
    <div class="zb-actions">
      <button type="button" class="z-btn z-btn--secondary" id="ct-edit">${Z.icon("edit")}<span>Edit</span></button>
      ${canPay ? `<button type="button" class="z-btn z-btn--primary" id="ct-pay">${Z.icon("arrow_outward")}<span>Pay ${esc(c.name)}</span></button>` : ""}
      <button type="button" class="z-link-btn" id="ct-del">Delete contact</button>
    </div>`;
  const scrim = drawer("contact-drawer", c.name, body, el);
  scrim.querySelector("#ct-pay")?.addEventListener("click", () => {
    Z.closeOverlay("contact-drawer");
    sendState.contactId = c.id;
    setView("send");
    render({ focus: true });
  });
  scrim.querySelector("#ct-edit").onclick = () => { Z.closeOverlay("contact-drawer"); editContact(c); };
  scrim.querySelector("#ct-del").onclick = () => {
    Z.closeOverlay("contact-drawer");
    dialog(`Delete ${c.name}?`, `<p class="desc">Past payments keep their record. A payment run that still uses these details stops and has to be pointed somewhere else.</p>`,
      async () => { await api(`/api/orgs/${org.id}/contacts/${c.id}`, { method: "DELETE" }); toast("Contact deleted."); }, { okLabel: "Delete" });
  };
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
      const bankAccounts = iban
        ? [{ ...(b || { currency: "EUR", country: iban.slice(0, 2).toUpperCase() }), iban, holderName: $("#d-holder").value.trim() || $("#d-name").value.trim() }, ...c.bankAccounts.filter((x) => x !== b)]
        : c.bankAccounts.filter((x) => x !== b);
      await api(`/api/orgs/${org.id}/contacts/${c.id}`, { method: "PATCH", body: { name: $("#d-name").value.trim(), email: $("#d-email").value.trim() || undefined, bankAccounts } });
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
    <div class="zb-note zb-note--a">${Z.icon("science")}<span>Beta: tested against a stand-in of the GetMyInvoices API, not a live account yet. Check the first upload before you close a month on it.</span></div>
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

/* A document opens in a new tab; the list below the buttons then shows it. */
function openDocument(d) {
  const url = docHref(d?.url);
  if (url) window.open(url, "_blank", "noopener");
  toast("Document issued.");
}

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
      const lib = await window.__deviceLib;
      const sig = await lib.passkeyAssertion(d.safeSignature);
      d = await api(d.safeSignature.submitTo, { method: "POST", body: sig });
    }
    openDocument(d);
  },
  async "doc-receipt"(el) {
    openDocument(await api(`/api/users/${me.id}/documents/receipt`, { method: "POST", body: { transferId: el.dataset.id } }));
  },

  /* Filters and tabs: state in the screen's module, then a redraw. */
  "ap-tab"(el) { ap.tab = el.dataset.tab; },
  "inv-filter"(el) { iv.filter = el.dataset.f; },
  "inv-side"(el) { iv.side = el.dataset.s; },
  "bk-month"(el) { bk.month = el.dataset.m; },

  "draft-detail": async (el) => { await draftDrawer(el); return "keep"; },
  "review-draft": async (el) => { await draftDrawer(el); return "keep"; },
  "contact-detail": (el) => { contactDrawer(el); return "keep"; },
  "invoice-detail": (el) => {
    const i = iv.invoices.find((x) => x.id === el.dataset.id);
    if (i) invoiceDrawer(i, el);
    return "keep";
  },
  "gmi-drawer": (el) => { gmiDrawer(el); return "keep"; },

  async "shopify-connect"() {
    const shop = ($("#sh-shop").value || "").trim().toLowerCase();
    const r = await api(`/api/orgs/${org.id}/shopify/install`, { method: "POST", body: { shop } });
    if (!/^https:\/\//i.test(String(r.authorizeUrl))) return toast("Shopify sent back an address Zold can’t use.", true);
    location.href = r.authorizeUrl;
  },
  "shopify-disconnect": (el) => dialog("Disconnect this store?", `<p class="desc">Customers can no longer pick Zold at its checkout.</p>`,
    async () => { await api(`/api/orgs/${org.id}/shopify/${el.dataset.id}`, { method: "DELETE" }); toast("Store disconnected."); }, { okLabel: "Disconnect" }),
  async upgrade(el) {
    const r = await api(`/api/orgs/${org.id}/plan`, { method: "POST", body: { plan: el.dataset.plan } });
    if (r.note) toast(r.note);
    await loadOrg(org.id);
  },
  async trial() {
    await api(`/api/orgs/${org.id}/plan/trial`, { method: "POST" });
    toast("Trial started: 30 days.");
    await loadOrg(org.id);
  },
  "open-account": () => dialog("Open an account",
    `<label for="d-cur">Currency</label><select id="d-cur" name="currency">
      <option value="EUR">Euro: bank transfer</option><option value="USD">US dollar</option>
      <option value="GBP">British pound</option><option value="KES">Kenyan shilling: M-Pesa</option>
      <option value="INR">Indian rupee</option></select>
     ${field("d-label", 'Name <span class="desc">(optional)</span>', 'placeholder="Operating…"')}
     <p class="desc" style="margin-top:12px">A currency that isn’t open yet says what it still needs, and nothing is simulated.</p>`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/accounts`, { method: "POST", body: { currency: $("#d-cur").value, label: $("#d-label").value } });
      toast(plain(r.note) || `${r.account.currency} account opened.`);
    }, { okLabel: "Open account" }),
  "new-contact": () => dialog("Add contact",
    `${field("d-name", "Name", 'autocomplete="organization" placeholder="Druckerei Kessler…"')}
     ${field("d-email", 'Email <span class="desc">(optional)</span>', 'type="email" spellcheck="false" placeholder="buchhaltung@kessler.de…"')}
     ${field("d-iban", "IBAN", 'spellcheck="false" placeholder="DE89 3704 0044 0532 0130 00…"')}
     ${field("d-holder", 'Account holder <span class="desc">(if not the name)</span>')}
     ${field("d-country", "Country", 'maxlength="2" placeholder="DE…"')}`,
    async () => {
      const iban = $("#d-iban").value.trim();
      await api(`/api/orgs/${org.id}/contacts`, {
        method: "POST",
        body: {
          name: $("#d-name").value, email: $("#d-email").value || undefined,
          bankAccounts: iban ? [{
            currency: "EUR", country: $("#d-country").value || iban.slice(0, 2).toUpperCase() || "DE",
            holderName: $("#d-holder").value || $("#d-name").value, iban,
          }] : [],
        },
      });
      toast("Contact added.");
    }, { okLabel: "Add contact" }),
  async "del-contact"(el) {
    await api(`/api/orgs/${org.id}/contacts/${el.dataset.id}`, { method: "DELETE" });
  },
  "import-wallet": () => dialog("Import a wallet",
    `<p class="desc">Read only. Zold never holds a key for an imported wallet.</p>
     ${field("d-addr", "Address", 'spellcheck="false" placeholder="0x…"')}
     ${field("d-chain", "Network id", 'inputmode="numeric" value="8453"')}
     <label for="d-kind">Type</label><select id="d-kind" name="kind"><option value="eoa">Ordinary wallet</option>
       <option value="safe">Safe</option><option value="mpc">MPC</option></select>
     ${field("d-label", "Name")}`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/wallets`, {
        method: "POST",
        body: { address: $("#d-addr").value, chainId: Number($("#d-chain").value), kind: $("#d-kind").value, label: $("#d-label").value },
      });
      toast(plain(r.note));
    }, { okLabel: "Import wallet" }),
  async "fund-account"(el) {
    let r;
    try {
      r = await api(`/api/orgs/${org.id}/accounts/${el.dataset.id}/fund`, { method: "POST" });
    } catch (e) {
      // A refusal can carry Monerium's newer answer (a profile still pending):
      // draw the row again so it shows it.
      render();
      throw e;
    }
    toast(plain(r.warning ? `${r.note} ${r.warning}` : r.note));
  },
  async "invoice-pay-link"(el) {
    // Offer every method the payee's account can take; the server picks the
    // amount from the invoice.
    const { methods } = await api(`/api/users/${me.id}/payment-requests/methods`);
    const usable = methods.filter((m) => m.available).map((m) => m.method);
    if (!usable.length) throw new Error(plain(methods.map((m) => m.needs).filter(Boolean).join(" ")) || "No way to get paid is set up on this account yet.");
    const r = await api(`/api/orgs/${org.id}/payment-requests`, { method: "POST", body: { invoiceId: el.dataset.id, methods: usable } });
    setTimeout(() => linkDialog("Payment link ready", `Send your customer this link. It asks for ${eur(r.amountEur)} and marks the invoice paid when the money arrives.`, r.url), 0);
  },
  "new-pay-link"() {
    dialog("New payment link",
      `<p class="desc">Your customer pays it into ${esc(org.name)}’s euro account. Leave the amount empty to let them enter it.</p>
       ${field("d-desc", "What it’s for", 'maxlength="140" placeholder="Deposit, roof Weber…"')}
       ${field("d-amt", "Amount in euros (optional)", 'inputmode="decimal" placeholder="1200.00…"')}`,
      async () => {
        const { methods } = await api(`/api/users/${me.id}/payment-requests/methods`);
        const usable = methods.filter((m) => m.available).map((m) => m.method);
        if (!usable.length) throw new Error(plain(methods.map((m) => m.needs).filter(Boolean).join(" ")) || "No way to get paid is set up on this account yet.");
        const amount = $("#d-amt").value.trim().replace(",", ".");
        const r = await api(`/api/orgs/${org.id}/payment-requests`, { method: "POST", body: { description: $("#d-desc").value, ...(amount ? { amountEur: amount } : {}), methods: usable } });
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
  invite: () => {
    const roles = Object.keys(ROLE_WORD).filter((r) => r !== "owner" || org.role === "owner");
    const says = { viewer: "Viewer: sees everything, changes nothing", accountant: "Accountant: books and exports, no money", payer: "Payer: proposes and sends", admin: "Admin: proposes, approves, sends, invites", owner: "Owner: everything, including the plan" };
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
      setTimeout(() => linkDialog(`Invoice ${r.invoice.issued.number} is ready`, "Send your customer this link. It shows the invoice and how to pay it. It’s shown once: copy it now.", location.origin + r.linkPath), 0);
    };
    try {
      await issue(false);
    } catch (e) {
      if (e.status === 409 && e.warnings?.length) {
        dialog("Issue it with these warnings?", `<ul class="desc" style="margin:8px 0 0 18px">${e.warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul>
          <p class="desc" style="margin-top:12px">Your acceptance is recorded on the invoice.</p>`, () => issue(true), { okLabel: "Issue anyway" });
        return "keep";
      }
      throw e;
    }
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
    // Who the issuer is lives on the organisation; sent only when changed, so
    // a member who may manage invoices but not the organisation can still
    // save the rest.
    const a = org.address || {};
    const issuer = {
      legalName: val("i-legal"),
      address: { line1: val("i-addr1"), line2: val("i-addr2"), postalCode: val("i-zip"), city: val("i-city"), country: val("i-country") },
    };
    if (!issuer.address.country) throw new Error("Choose your country: it decides which invoicing rules apply.");
    const changed = issuer.legalName !== (org.legalName || "") ||
      ["line1", "line2", "postalCode", "city", "country"].some((k) => issuer.address[k] !== (a[k] || ""));
    if (changed) await api(`/api/orgs/${org.id}`, { method: "PATCH", body: issuer });
    const display = {};
    document.querySelectorAll("[data-display]").forEach((el) => { display[el.dataset.display] = el.checked; });
    await api(`/api/orgs/${org.id}/invoicing/profile`, {
      method: "PATCH",
      body: {
        vatId: val("i-vatid"), taxNumber: val("i-taxno"),
        smallBusiness: $("#i-klein")?.checked === true,
        defaultVatRate: $("#i-rate")?.value ? Number($("#i-rate").value) : undefined,
        paymentTermsDays: val("i-terms-days") ? Number(val("i-terms-days")) : undefined,
        paymentTermsNote: val("i-terms"),
        registerCourt: val("i-court"), registerNumber: val("i-reg"),
        managingDirector: val("i-gf"), footerNote: val("i-footer"),
        bank: { holder: val("i-bank-holder"), iban: val("i-bank-iban"), bic: val("i-bank-bic") },
        numberSeries: { prefix: val("i-prefix"), next: Number(val("i-next") || 1), padding: 4 },
        display,
      },
    });
    toast("Invoicing profile saved.");
    if (changed) await loadOrg(org.id);
  },
  "pay-invoice": async (el) => {
    const r = await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/pay`, { method: "POST", body: {} });
    toast(plain(r.note) || "Payment run drafted. It’s in Approvals.");
  },
  "reconcile-invoice": (el) => dialog("Mark this invoice as paid",
    `${field("d-note", 'Note <span class="desc">(optional)</span>', 'placeholder="Paid from the company’s other bank account on 3 Sept…"')}`,
    async () => {
      await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/reconcile`, { method: "POST", body: { note: $("#d-note").value || undefined } });
      toast("Marked as paid.");
    }, { okLabel: "Mark as paid" }),
  "new-invoice": () => dialog("Request an invoice",
    `<p class="desc">Your supplier fills in a one-time link, with no account and no wallet.</p>
     ${field("d-cur", "Currency", `value="${esc(org.reporting.currency)}" maxlength="3"`)}
     ${field("d-due", 'Due <span class="desc">(optional)</span>', 'type="date"')}
     ${field("d-pw", 'Password <span class="desc">(optional, 12 characters or more)</span>', 'type="password" autocomplete="new-password" minlength="12" placeholder="Send it separately from the link…"')}`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/invoices`, {
        method: "POST",
        body: { currency: $("#d-cur").value, dueDate: $("#d-due").value || undefined, password: $("#d-pw").value || undefined },
      });
      setTimeout(() => linkDialog("Copy the invoice link", plain(r.note) || "Send it to your supplier yourself.", location.origin + r.linkPath), 0);
    }, { okLabel: "Create link" }),
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
  async "export-rebuild"() {
    const r = await api(`/api/orgs/${org.id}/bookkeeping/statement/rebuild`, { method: "POST" });
    toast(`${r.added} line${r.added === 1 ? "" : "s"} added, ${r.updated} refreshed. Categories you set yourself were left alone.`);
  },
  async "export-prepare"() {
    const month = monthChosen();
    const r = await api(`/api/orgs/${org.id}/bookkeeping/export/${month}/prepare`, { method: "POST" });
    toast(`${month}: ${r.lines} line${r.lines === 1 ? "" : "s"}, ${r.belegeIssued} Beleg${r.belegeIssued === 1 ? "" : "e"} issued${r.failed.length ? `, ${r.failed.length} failed` : ""}.`, r.failed.length > 0);
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
    toast(`Beleg ${r.code} ${r.issued ? "issued" : "already existed"}.`);
  },
  "gmi-push": () => {
    const month = monthChosen();
    dialog(`Send ${month}’s Belege to GetMyInvoices?`, `<p class="desc">Each Beleg goes up once; ones already there (same number) are skipped.</p>`, async () => {
      const r = await api(`/api/orgs/${org.id}/integrations/getmyinvoices/push`, { method: "POST", body: { month } });
      const n = (k) => r.results.filter((x) => x.outcome === k).length;
      toast(`${n("uploaded")} uploaded, ${n("exists")} already there, ${n("no-beleg")} without a Beleg, ${n("failed")} failed.`, n("failed") > 0);
    }, { okLabel: "Send" });
  },
  "gmi-disconnect": () => dialog("Remove the GetMyInvoices key?", `<p class="desc">Nothing already uploaded is touched.</p>`,
    async () => { await api(`/api/orgs/${org.id}/integrations/getmyinvoices`, { method: "DELETE" }); toast("Key removed."); }, { okLabel: "Remove key" }),
  async "save-org"() {
    const body = {
      name: $("#s-name").value, legalName: $("#s-legal").value,
      taxId: $("#s-tax").value, notificationEmail: $("#s-notify").value,
      address: {
        line1: $("#s-addr1").value, line2: $("#s-addr2").value,
        postalCode: $("#s-zip").value, city: $("#s-city").value,
        country: $("#s-country").value,
      },
    };
    const cur = $("#s-currency");
    if (cur && !cur.disabled && cur.value !== org.reporting.currency) body.reporting = { currency: cur.value };
    await api(`/api/orgs/${org.id}`, { method: "PATCH", body });
    toast("Saved.");
    await loadOrg(org.id);
  },

  // ── Payment runs ─────────────────────────────────────────────────────────
  /** A new run of one payment: saved, then (with approvals) submitted, so it
   *  waits in Approvals for someone other than the drafter. */
  async "send-create"() {
    const err = $("#send-err");
    err.textContent = "";
    const amount = $("#d-amt").value.trim().replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      err.textContent = "Enter an amount in euros and cents, like 250 or 250.00.";
      $("#d-amt").focus();
      return "keep";
    }
    const { contacts } = await api(`/api/orgs/${org.id}/contacts`);
    const c = contacts.find((x) => x.id === $("#d-con").value);
    const b = c?.bankAccounts.find((x) => x.iban);
    if (!b) { err.textContent = "That contact has no IBAN."; return "keep"; }
    const r = await api(`/api/orgs/${org.id}/drafts`, {
      method: "POST",
      body: {
        source: { kind: "account", accountId: $("#d-acct").value },
        lines: [{
          contactId: c.id,
          destination: { kind: "bank", bankAccountId: b.id, displayName: b.holderName || c.name },
          asset: "EUR",
          amount,
          note: $("#d-note").value.trim() || undefined,
        }],
      },
    });
    sendState.contactId = null;
    if (cap("transfers.approvals").allowed) {
      await api(`/api/orgs/${org.id}/drafts/${r.draft?.id || r.id}/submit`, { method: "POST" });
      ap.tab = "waiting";
      toast("Submitted. Someone other than you approves it next.");
    } else {
      ap.tab = "drafts";
      toast("Saved. Send it from the list with Face ID or fingerprint.");
    }
    setView("payments");
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
    const r = await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/execute`, { method: "POST" });

    if (r.unsigned) {
      return dialog("Sign in your own wallet",
        `<p class="desc">${esc(r.note)}</p>
         <table><thead><tr><th>To</th><th>Amount</th></tr></thead><tbody>${r.lines
           .map((l) => `<tr><td>${esc(l.destination.displayName)}</td>
             <td class="mono">${esc(l.amount)} ${esc(l.asset)}</td></tr>`).join("")}</tbody></table>`,
        null, { closeOnly: true });
    }
    if (!r.authorizations?.length) return toast(r.note || "Nothing to sign.");

    const lib = await window.__deviceLib;
    // The passkey that wraps this browser's device key, from the session:
    // nothing writes it to storage.
    const me = await api("/api/session");
    const credentialId = me.passkey?.credentialId || undefined;
    let signed = 0;
    const failures = [];
    for (const a of r.authorizations) {
      try {
        const signature = await lib.signTypedData(a.authorization.typedData, credentialId);
        // The debit itself is a Safe operation the passkey signs, then the
        // Monerium redeem order on a SEPA line, in that order, as the server
        // verifies them (authenticator counters rise with each ceremony).
        const executionAssertion = await lib.passkeyAssertion(a.authorization.safeExecution);
        const moneriumRedeemAssertion = await lib.passkeyAssertion(a.authorization.moneriumRedeem);
        await api(a.authorization.submitTo, {
          method: "POST",
          body: {
            signature,
            ...(executionAssertion ? { executionAssertion } : {}),
            ...(moneriumRedeemAssertion ? { moneriumRedeemAssertion } : {}),
          },
        });
        signed++;
        toast(`Signed ${signed} of ${r.authorizations.length}…`);
      } catch (e) {
        // Reported per line rather than aborting silently: the ones already
        // signed are real payments and the user must know which.
        failures.push(`${a.recipient}: ${plain(e.message)}`);
      }
    }
    toast(
      failures.length
        ? `${signed} of ${r.authorizations.length} sent. Not sent: ${failures.join("; ")}`
        : `All ${signed} payment${signed === 1 ? "" : "s"} signed and sent to the bank.`,
      failures.length > 0,
    );
  },
};
