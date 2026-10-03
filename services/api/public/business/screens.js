/**
 * The screens drawn from the design/ui-v2 desktop references (build step 8b):
 * Approvals, Contacts, Members, Invoices and Books. The older views are
 * in views.js; the invoice editor in invoice.js. Each registers into RENDER
 * (the body) and META (title, subtitle, header actions).
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - There is no company balance. A company account spends from one member's
 *   own account; only that member sees a figure, labelled as theirs.
 * - A payment run is sent per run, with Face ID or fingerprint (exec-draft,
 *   unchanged). There is no batch send.
 * - Status words follow the record's own state; a run is Sent only when
 *   executed, an invoice Paid only when the API says so.
 */
import {
  $, Z, api, cap, day, esc, eur, gateHtml, maskIban, me, org, plain, roleCan, ROLE_CAN, ROLE_WORD, toast, when, ymd,
} from "./core.js";
import { META, RENDER, invoiceActions, settlementRows } from "./views.js";

const primary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--primary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const secondary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--secondary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const linkBtn = (label, view, icon, variant = "secondary") => `<a class="z-btn z-btn--${variant}" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const note = (text, icon = "info", tone = "") => `<div class="zb-note${tone ? ` zb-note--${tone}` : ""}">${Z.icon(icon)}<span>${text}</span></div>`;
const table = (head, rows) => `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr>${head.map(([h, cls]) => `<th scope="col"${cls ? ` class="${cls}"` : ""}>${h ? esc(h) : `<span class="z-sr">Actions</span>`}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const empty = (text) => `<div class="z-card"><p class="empty">${text}</p></div>`;

/* ── Members and payment runs, shared by several screens ─────────────────── */

let members = null;          // this org's, read once per render that needs them
export async function loadMembers() {
  if (!cap("members.manage").allowed && org.type === "personal") return [];
  try { members = (await api(`/api/orgs/${org.id}/members`)).members; } catch { members = members || []; }
  return members;
}
export function memberName(id) {
  if (id && id === org.memberId) return "you";
  const m = (members || []).find((x) => x.id === id);
  return m ? (m.name || m.email || "a member") : "a member";
}
const memberInitials = (id) => {
  if (id === org.memberId) return me?.name || "You";
  const m = (members || []).find((x) => x.id === id);
  return m?.name || m?.email || "?";
};

export const draftTitle = (d) => (d.lines.length === 1 ? d.lines[0].destination?.displayName || "1 payment" : `${d.lines.length} payments`);
export function draftTotal(d) {
  const parts = Object.entries(d.totals || {}).map(([asset, v]) => (/^(EUR|EURe)$/i.test(asset) ? eur(v) : `${Number(v).toLocaleString("en-GB", { maximumFractionDigits: 6 })} ${asset === "USDC" ? "USDC" : asset}`));
  return parts.join(" + ");
}
export function draftTag(d) {
  return {
    DRAFT: Z.tag("Draft"), PENDING_REVIEW: Z.tag("Waiting for review"), INVALID_DATA: Z.tag("Needs fixing"),
    REJECTED: Z.tag("Sent back", "amber"), REVIEWED: Z.tag("Approved"), EXECUTING: Z.tag("Sending", "pink"),
    EXECUTED: Z.tag("Sent"), FAILED: Z.tag("Failed"),
  }[d.state] || "";
}
/** Four eyes, as the API's canReviewDraft says it. */
export function mayReview(d) {
  if (!roleCan(org.role, "approve")) return { allowed: false, reason: `As ${(ROLE_WORD[org.role] || "a member").toLowerCase()} you can’t approve payments. An owner or admin can.` };
  if (d.createdByMemberId === org.memberId) return { allowed: false, reason: "You drafted this, so someone else has to approve it." };
  return { allowed: true };
}

/* ==========================================================================
   Approvals (the payments view)
   ========================================================================== */

const AP_TABS = [
  ["waiting", "Waiting", (d) => d.state === "PENDING_REVIEW"],
  ["approved", "Approved", (d) => ["REVIEWED", "EXECUTING"].includes(d.state)],
  ["fixing", "Needs fixing", (d) => ["INVALID_DATA", "REJECTED"].includes(d.state)],
  ["drafts", "Drafts", (d) => d.state === "DRAFT"],
  ["sent", "Sent", (d) => ["EXECUTED", "FAILED"].includes(d.state)],
];
export const ap = { tab: "waiting", drafts: [] };

META.payments = () => ({
  title: cap("transfers.approvals").allowed ? "Approvals" : "Payments",
  sub: cap("transfers.approvals").allowed
    ? "Whoever drafts a payment can’t approve it. Bank details are checked again before sending."
    : "Draft a payment, then send it with Face ID or fingerprint.",
  actions: roleCan(org.role, "propose") ? linkBtn("New payment", "send", "arrow_outward", "primary") : "",
});

function apRow(d) {
  const may = mayReview(d);
  const lines = `${d.lines.length} line${d.lines.length === 1 ? "" : "s"} · drafted by ${memberName(d.createdByMemberId)}`;
  const reviewer = d.reviewedByMemberId ? memberName(d.reviewedByMemberId)
    : d.state === "PENDING_REVIEW" ? (may.allowed ? "you" : "an owner or admin") : "";
  let act = "";
  if (d.state === "PENDING_REVIEW" && may.allowed) act = `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="review-draft" data-id="${esc(d.id)}">Review<span class="z-sr">: ${esc(draftTitle(d))}</span></button>`;
  if (d.state === "REVIEWED" && roleCan(org.role, "send")) act = `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="exec-draft" data-id="${esc(d.id)}">Send<span class="z-sr">: ${esc(draftTitle(d))}</span></button>`;
  if (d.state === "DRAFT" && roleCan(org.role, "propose")) {
    act = cap("transfers.approvals").allowed
      ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="submit-draft" data-id="${esc(d.id)}">Submit<span class="z-sr">: ${esc(draftTitle(d))}</span></button>`
      : roleCan(org.role, "send") ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="exec-draft" data-id="${esc(d.id)}">Send<span class="z-sr">: ${esc(draftTitle(d))}</span></button>` : "";
  }
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `<tr>
    <td><span class="z-tbl__who">${Z.avatar({ name: memberInitials(d.createdByMemberId) })}<span><button type="button" class="z-tbl__link" data-act="draft-detail" data-id="${esc(d.id)}">${esc(draftTitle(d))}</button><span class="zb-sub2">${esc(lines)}</span></span></span></td>
    <td>${reviewer ? esc(cap1(reviewer)) : '<span class="z-dim">None yet</span>'}</td>
    <td>${draftTag(d)}</td>
    <td class="z-tbl__num"><span class="z-amount">−${esc(draftTotal(d))}</span></td>
    <td><div class="zb-cellact">${act}</div></td></tr>`;
}

RENDER.payments = async () => {
  const [{ drafts }] = await Promise.all([api(`/api/orgs/${org.id}/drafts`), loadMembers()]);
  ap.drafts = drafts;
  const approvals = cap("transfers.approvals").allowed;
  // Drafts only when there are some; without approvals, no review tabs.
  const tabs = AP_TABS.filter(([k, , f]) => (k === "drafts" ? drafts.some(f) : approvals || k === "sent" || drafts.some(f)));
  if (!tabs.some(([k]) => k === ap.tab)) ap.tab = tabs[0][0];
  const [, , inTab] = AP_TABS.find(([k]) => k === ap.tab);
  const list = drafts.filter(inTab).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pills = `<div class="zb-pills" role="group" aria-label="Show">${tabs.map(([k, label, f]) => `<button type="button" class="zb-pill" data-act="ap-tab" data-tab="${k}" aria-current="${k === ap.tab}">${esc(label)} <b>${drafts.filter(f).length}</b></button>`).join("")}</div>`;
  const notes = [
    ...drafts.filter((d) => d.state === "INVALID_DATA").map((d) => {
      const bad = new Set(d.invalidLineIds || []);
      const names = d.lines.filter((l) => bad.has(l.id)).map((l) => l.destination?.displayName).filter(Boolean);
      const who = names.join(", ") || "A payee";
      return note(`${who === draftTitle(d) ? "" : `${esc(draftTitle(d))}: `}${esc(who)}’s bank details changed after this was drafted. Check them before it can be approved.`, "warning", "a");
    }),
    ...drafts.filter((d) => d.state === "REJECTED").map((d) => note(`${esc(draftTitle(d))}: sent back by ${esc(memberName(d.reviewedByMemberId))}${d.rejectedReason ? `: “${esc(plain(d.rejectedReason))}”` : "."}`, "undo", "a")),
    ...drafts.filter((d) => d.state === "PENDING_REVIEW" && d.createdByMemberId === org.memberId).map((d) => note(`${esc(draftTitle(d))}: you drafted it, so someone else has to approve it.`, "lock")),
  ];
  return `${approvals ? "" : gateHtml("transfers.approvals")}
    <div class="zb-bar">${pills}</div>
    ${list.length
      ? table([["Payment"], ["Reviewer"], ["Status"], ["Total", "z-tbl__num"], [""]], list.map(apRow))
      : empty(ap.tab === "waiting" ? "Nothing waiting for review." : "No payment runs here.")}
    ${notes.length ? `<div class="zb-notes">${notes.join("")}</div>` : ""}`;
};

/* ==========================================================================
   Contacts
   ========================================================================== */

META.contacts = () => ({
  title: "Contacts",
  sub: "People and companies you pay. Payments read their bank details from here.",
  actions: primary("Add contact", 'data-act="new-contact"', "person_add"),
});

export const ct = { contacts: [], drafts: [] };

/** A contact's payments: the lines of sent runs that paid them. */
export function contactPayments(c) {
  return ct.drafts.filter((d) => d.state === "EXECUTED")
    .flatMap((d) => d.lines.filter((l) => l.contactId === c.id).map((l) => ({ at: d.updatedAt, amount: l.amount, asset: l.asset })))
    .sort((a, b) => b.at.localeCompare(a.at));
}

RENDER.contacts = async () => {
  const [{ contacts }, dr] = await Promise.all([
    api(`/api/orgs/${org.id}/contacts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${org.id}/drafts`).catch(() => ({ drafts: [] })) : Promise.resolve({ drafts: [] }),
  ]);
  ct.contacts = contacts;
  ct.drafts = dr.drafts;
  if (!contacts.length) return empty("No contacts yet. Add the people and companies you pay.");
  const rows = [...contacts].sort((a, b) => a.name.localeCompare(b.name)).map((c) => {
    const b = c.bankAccounts[0];
    const n = contactPayments(c).length;
    return `<tr><td><span class="z-tbl__who">${Z.avatar({ name: c.name })}<button type="button" class="z-tbl__link" data-act="contact-detail" data-id="${esc(c.id)}">${esc(c.name)}</button></span></td>
      <td class="z-mono" translate="no">${b?.iban ? esc(maskIban(b.iban)) : b ? esc(b.accountNumber || b.mobile || "") : c.wallets[0] ? esc(`${c.wallets[0].address.slice(0, 8)}…${c.wallets[0].address.slice(-4)}`) : '<span class="z-dim">No details</span>'}</td>
      <td class="z-dim">${n ? `${n} payment${n === 1 ? "" : "s"}` : "No payments yet"}</td></tr>`;
  });
  return table([["Name"], ["IBAN"], ["History"]], rows);
};

/* ==========================================================================
   Members
   ========================================================================== */

META.members = () => ({
  title: "Members",
  sub: "Whoever proposes a payment can’t approve it. The company always keeps at least one owner.",
  actions: primary("Invite member", 'data-act="invite"', "person_add"),
});

RENDER.members = async () => {
  if (!cap("members.manage").allowed) return gateHtml("members.manage");
  const list = await loadMembers();
  const iAmOwner = org.role === "owner";
  const rows = list.map((m) => {
    const you = m.id === org.memberId;
    const name = m.name || m.email || "Member";
    const roles = Object.keys(ROLE_WORD).filter((r) => r !== "owner" || iAmOwner || m.role === "owner");
    const role = !you && m.status !== "deactivated"
      ? `<label class="z-sr" for="role-${esc(m.id)}">Role of ${esc(name)}</label><select class="zb-inline" id="role-${esc(m.id)}" data-role-of="${esc(m.id)}" data-was="${esc(m.role)}"${m.role === "owner" && !iAmOwner ? " disabled" : ""}>${roles.map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${ROLE_WORD[r]}</option>`).join("")}</select>`
      : esc(ROLE_WORD[m.role] || m.role);
    const can = ROLE_CAN[m.role] || {};
    const chips = [["propose", "Propose"], ["approve", "Approve"], ["send", "Send"]].map(([k, w]) => `<span class="zb-chip${can[k] ? "" : " zb-chip--off"}">${w}<span class="z-sr">${can[k] ? "" : ": no"}</span></span>`).join("");
    const status = m.status === "active" ? Z.tag("Active") : m.status === "invited" ? Z.tag("Waiting") : Z.tag("Off");
    const act = you ? "" : m.status === "active"
      ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="deactivate" data-id="${esc(m.id)}">Remove<span class="z-sr">: ${esc(name)}</span></button>`
      : m.status === "deactivated" ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="reactivate" data-id="${esc(m.id)}">Add back<span class="z-sr">: ${esc(name)}</span></button>` : "";
    const sub = you ? "you" : m.status === "invited" && m.inviteExpiresAt ? [m.name ? m.email : "", `invite ends ${day(m.inviteExpiresAt)}`].filter(Boolean).join(" · ") : m.email || "";
    return `<tr><td><span class="z-tbl__who">${Z.avatar({ name, tone: you ? "p" : "n" })}<span>${esc(name)}<span class="zb-sub2">${esc(sub)}</span></span></span></td>
      <td>${role}</td><td><div class="zb-chips">${chips}</div></td><td>${status}</td><td><div class="zb-cellact">${act}</div></td></tr>`;
  });
  return {
    html: table([["Member"], ["Role"], ["Can"], ["Status"], [""]], rows),
    bind(box) {
      box.querySelectorAll("[data-role-of]").forEach((sel) => {
        sel.onchange = async () => {
          sel.disabled = true;
          try {
            await api(`/api/orgs/${org.id}/members/${sel.dataset.roleOf}`, { method: "PATCH", body: { role: sel.value } });
            sel.dataset.was = sel.value;
            Z.announce(`Role changed to ${ROLE_WORD[sel.value]}.`);
            const chips = sel.closest("tr").querySelector(".zb-chips");
            const can = ROLE_CAN[sel.value] || {};
            chips.querySelectorAll(".zb-chip").forEach((c, i) => c.classList.toggle("zb-chip--off", !can[["propose", "approve", "send"][i]]));
          } catch (e) {
            sel.value = sel.dataset.was;
            toast(plain(e.message), true);
          } finally { sel.disabled = false; }
        };
      });
    },
  };
};

/* ==========================================================================
   Invoices
   ========================================================================== */

const INV_FILTERS = [["open", "Open"], ["paid", "Paid"], ["overdue", "Overdue"]];
export const iv = { filter: "open", side: "issued", invoices: [] };

/* Who an invoice is to or from. A draft made from receipts has no recipient
   yet: it is named after the contact whose payments it collects. */
const invWho = (i) => {
  if (i.direction !== "outgoing") return i.supplier?.orgName || "Waiting for your supplier";
  return i.issued?.recipient?.name || i.fromReceipts?.payerName || "Customer";
};
const monthWord = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

export function invWord(i) {
  if (i.state === "DRAFT") return "DRAFT";
  if (["PAID", "RECONCILED"].includes(i.state)) return "PAID";
  if (i.state === "PAYING") return "IN FLIGHT";
  if (i.state === "LINK_CREATED") return "WAITING";
  return i.overdue ? "OVERDUE" : "OPEN";
}
export const invAmount = (i) => (i.issued && Number.isFinite(i.issued.grossCents)
  ? { value: i.issued.grossCents / 100, currency: i.issued.currency || "EUR" }
  : { value: Number(i.total) || 0, currency: i.currency || "EUR" });
const invIn = (f, i) => {
  const w = invWord(i);
  return f === "paid" ? w === "PAID" : f === "overdue" ? w === "OVERDUE" : w !== "PAID";
};

META.invoices = () => ({
  title: "Invoices",
  sub: "",
  actions: cap("invoices").allowed
    ? `${secondary("Collect receipts", 'data-act="collect-receipts"', "account_balance_wallet")}${secondary("Request an invoice", 'data-act="new-invoice"', "move_to_inbox")}${primary("Issue invoice", 'data-act="issue-invoice"', "add")}`
    : "",
});

RENDER.invoices = async () => {
  if (!cap("invoices").allowed) return gateHtml("invoices");
  const { invoices } = await api(`/api/orgs/${org.id}/invoices`);
  iv.invoices = invoices;
  const bySide = invoices.filter((i) => (iv.side === "issued" ? i.direction === "outgoing" : i.direction !== "outgoing"));
  const list = bySide.filter((i) => invIn(iv.filter, i));
  const pills = `<div class="zb-pills" role="group" aria-label="Show">${INV_FILTERS.map(([k, w]) => `<button type="button" class="zb-pill" data-act="inv-filter" data-f="${k}" aria-current="${k === iv.filter}">${w} <b>${bySide.filter((i) => invIn(k, i)).length}</b></button>`).join("")}</div>`;
  const sides = `<div class="zb-pills" role="group" aria-label="Whose">${[["issued", "Issued by you"], ["suppliers", "From suppliers"]].map(([k, w]) => `<button type="button" class="zb-pill" data-act="inv-side" data-s="${k}" aria-current="${k === iv.side}">${w}</button>`).join("")}</div>`;
  const withActs = list.some((i) => invoiceActions(i));
  const rows = list.map((i) => {
    const out = i.direction === "outgoing";
    const w = invWord(i);
    const who = invWho(i);
    const num = (out ? i.issued?.number : i.supplier?.invoiceNumber) || "";
    const a = invAmount(i);
    const fig = w === "WAITING" ? '<span class="z-dim">Not filled in</span>'
      : w === "PAID" ? Z.amount({ value: a.value, currency: a.currency, direction: out ? "in" : "out" })
        : `<span class="z-amount">${esc(Z.formatMoney(a.value, a.currency))}</span>`;
    return `<tr><td class="z-mono">${esc(num) || `<span class="z-dim">${w === "DRAFT" ? "Not issued" : "None"}</span>`}</td>
      <td><span class="z-tbl__who">${Z.avatar({ name: who })}<button type="button" class="z-tbl__link" data-act="invoice-detail" data-id="${esc(i.id)}">${esc(who)}</button></span></td>
      <td class="${w === "OVERDUE" ? "zb-due--late" : "z-dim"}">${i.dueDate ? esc(day(ymd(i.dueDate))) : "None"}</td>
      <td>${Z.tag(w)}</td>
      <td class="z-tbl__num">${fig}</td>
      ${withActs ? `<td><div class="zb-cellact">${invoiceActions(i)}</div></td>` : ""}</tr>`;
  });
  return `<div class="zb-bar">${pills}${sides}</div>
    ${list.length ? table([["Number"], [iv.side === "issued" ? "Customer" : "Supplier"], ["Due"], ["Status"], ["Amount", "z-tbl__num"], ...(withActs ? [[""]] : [])], rows)
      : empty(bySide.length ? "No invoices match that filter." : iv.side === "issued" ? "No invoices issued yet." : "No supplier invoices yet. Request one with a link.")}
    <div class="zb-notes">${note(`An invoice marks itself paid when a bank transfer with its number arrives. Your details on every invoice come from the <a href="?view=invoicing-settings" data-view-link="invoicing-settings">invoicing profile</a>.`, "auto_awesome")}</div>`;
};

/* A draft made from wallet receipts: each receipt it bills, then the payer's
   rows of that month it leaves out, each with the reason. */
function receiptDraftSections(i) {
  const tx = (h) => (h ? `<span class="mono" title="${esc(h)}">${esc(h.slice(0, 10))}…${esc(h.slice(-6))}</span>` : "none");
  // An unpriced token is booked as SYMBOL@chain:address; the symbol is enough here.
  const tokenWord = (asset) => String(asset).split("@")[0];
  const fr = i.fromReceipts;
  const lines = i.lines.filter((l) => l.receipt);
  const billed = lines.length
    ? `<dl class="z-kv z-card">${lines.map((l) => `<div><dt>${esc(day(l.receipt.at))} · ${esc(l.receipt.amount)} ${esc(l.receipt.asset)} · ${tx(l.receipt.txHash)}</dt><dd class="z-fig">${esc(eur(l.receipt.eurCents / 100))}</dd></div>`).join("")}</dl>`
    : '<p class="zb-hint">No receipt of this month can be invoiced.</p>';
  const left = fr.excluded.length
    ? `<section><h3 class="z-eyebrow" style="margin-bottom:8px">Not included</h3>
        <ul class="z-list z-card">${fr.excluded.map((x) => `<li class="zb-left"><div>${esc(day(x.at))} · ${esc(x.amount)} ${esc(tokenWord(x.asset))}${x.txHash ? ` · ${tx(x.txHash)}` : ""}</div><p class="desc">${esc(x.reason)}</p></li>`).join("")}</ul></section>`
    : "";
  const gap = fr.mismatchCents
    ? note(`At this payer’s VAT rate no net amount plus VAT adds up to ${esc(eur(Number(i.total)))}, so the invoice would differ from the money by ${esc(eur(Math.abs(fr.mismatchCents) / 100))}. It can’t be issued from here.`, "warning", "a")
    : "";
  const behind = (fr.syncWarnings || []).length
    ? note(`This month may be incomplete: ${fr.syncWarnings.map(esc).join(" ")} Collect the month again once the wallets have caught up.`, "warning", "a")
    : "";
  return `${behind}<section><h3 class="z-eyebrow" style="margin-bottom:8px">Receipts, at their value on arrival</h3>${billed}</section>${left}${gap}
    ${note("Issuing gives it the next invoice number and today’s date, and marks it paid by these receipts. Collected " + esc(when(fr.runAt)) + ".", "info")}`;
}

/** One invoice in a drawer: its parties, what it is for, how it was paid. */
export function invoiceDrawer(i, trigger) {
  const out = i.direction === "outgoing";
  const a = invAmount(i);
  const isDraft = i.state === "DRAFT";
  const who = out ? invWho(i) : i.supplier?.orgName || "Not filled in yet";
  const num = (out ? i.issued?.number : i.supplier?.invoiceNumber) || "";
  const rows = isDraft ? [
    ["Payer", who],
    ["Addressed to", i.fromReceipts.recipientName || "Set in the payer rule"],
    ["Tax line", i.fromReceipts.vat ? (i.fromReceipts.vat.kind === "standard" ? `${i.fromReceipts.vat.rate}% VAT, contained in what was received` : `No VAT (${i.fromReceipts.vat.reason.replace(/_/g, " ")})`) : "Set in the payer rule"],
    ["Receipts of", monthWord(i.fromReceipts.month)],
    ["Total received", Z.formatMoney(a.value, a.currency)],
    ["Number and date", "Given when you issue it"],
  ] : [
    ["Number", num || "None"],
    [out ? "Customer" : "Supplier", who],
    ["Amount", Z.formatMoney(a.value, a.currency)],
    ["Due", i.dueDate ? day(ymd(i.dueDate)) : "None"],
    ...(!out && i.payTo?.bank?.iban ? [["Pay to", Z.groupIban(i.payTo.bank.iban)]] : []),
  ];
  document.getElementById("inv-drawer")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "inv-drawer", title: isDraft ? `Draft for ${monthWord(i.fromReceipts.month)}` : num ? `Invoice ${num}` : "Invoice",
    body: `<div class="z-sheet__body"><div>${Z.tag(invWord(i))}</div>
      <dl class="z-kv z-card">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${isDraft ? receiptDraftSections(i) : i.settlements?.length ? settlementRows(i.settlements) : ""}
      <div class="zb-actions" style="margin-top:0">${invoiceActions(i)}</div></div>`,
  }));
  Z.openOverlay("inv-drawer", trigger);
}

/* ==========================================================================
   Books
   ========================================================================== */

export const bk = { month: null, lines: [], chart: null };

META.books = () => ({
  title: "Books",
  sub: bk.month ? `${new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${bk.month}-15T12:00:00`))} · every euro in and out, with its Beleg` : "Every euro in and out, with its Beleg",
  actions: cap("export.ledger").allowed
    ? `${secondary("Issue Belege", 'data-act="export-prepare"', "receipt")}${secondary("Belege as ZIP", 'data-act="export-zip"', "folder_zip")}${secondary("Lexware CSV", 'data-act="export-csv"', "download")}`
    : "",
});

RENDER.books = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const first = await api(`/api/orgs/${org.id}/bookkeeping/statement`);
  const months = first.months.length ? first.months : [new Date().toISOString().slice(0, 7)];
  if (!bk.month || !months.includes(bk.month)) bk.month = months[0];
  const [d, chart, mem] = await Promise.all([
    api(`/api/orgs/${org.id}/bookkeeping/statement?month=${encodeURIComponent(bk.month)}`),
    cap("coa.manage").allowed ? api(`/api/orgs/${org.id}/chart-of-accounts`).then((r) => r.accounts).catch(() => null) : Promise.resolve(null),
    loadMembers(),
  ]);
  bk.lines = d.lines;
  bk.chart = chart;
  // The header names the month; drawn again now that it is known.
  const meta = META.books();
  $("#view-sub").textContent = meta.sub;
  const monthName = (m) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${m}-15T12:00:00`));
  const pills = `<div class="zb-pills" role="group" aria-label="Month">${months.slice(0, 6).map((m) => `<button type="button" class="zb-pill" data-act="bk-month" data-m="${esc(m)}" aria-current="${m === bk.month}">${esc(monthName(m))}</button>`).join("")}</div>`;
  const rows = [...d.lines].sort((a, b) => b.valueDate.localeCompare(a.valueDate)).map((l) => {
    const inbound = l.amountCents >= 0;
    const who = l.counterparty?.name || (inbound ? "Money in" : "Payment");
    const cat = chart
      ? `<label class="z-sr" for="cat-${esc(l.id)}">Category for ${esc(who)}, ${esc(day(ymd(l.valueDate)))}</label><select class="zb-inline" id="cat-${esc(l.id)}" data-cat-of="${esc(l.id)}" data-was="${esc(l.accountCode || "")}">
          ${l.accountCode ? "" : '<option value="" selected>Choose…</option>'}${chart.map((c) => `<option value="${esc(c.code)}"${c.code === l.accountCode ? " selected" : ""}>${esc(plain(c.name))}</option>`).join("")}</select>`
      : l.accountCode ? esc(l.accountCode) : '<span class="z-dim">None</span>';
    const memo = l.note
      ? `<button type="button" class="zb-memo zb-memo--set" data-act="bk-memo" data-id="${esc(l.id)}">${esc(l.note)}<span class="z-sr">, change the memo</span></button>`
      : `<button type="button" class="zb-memo" data-act="bk-memo" data-id="${esc(l.id)}">${Z.icon("edit_note")}Add memo<span class="z-sr"> for ${esc(who)}</span></button>`;
    const beleg = l.documentCode
      ? `<a class="zb-beleg" href="${esc(l.documentUrl)}" target="_blank" rel="noopener">${Z.icon("attach_file")}Beleg<span class="z-sr"> ${esc(l.documentCode)} (opens in a new tab)</span></a>`
      : `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="line-beleg" data-line="${esc(l.id)}">Issue<span class="z-sr"> a Beleg for ${esc(who)}</span></button>`;
    return `<tr><td class="z-dim">${esc(day(ymd(l.valueDate)))}</td>
      <td><span class="z-tbl__who">${Z.avatar({ name: who })}<span>${esc(who)}${l.reference && l.reference !== l.note ? `<span class="zb-sub2">${esc(l.reference)}</span>` : ""}</span></span></td>
      <td>${memo}</td><td>${cat}</td><td>${beleg}${l.unexecuted ? ` ${Z.tag("Unproven", "amber")}` : ""}</td>
      <td class="z-tbl__num">${Z.amount({ value: Math.abs(l.amountCents) / 100, direction: inbound ? "in" : "out" })}</td></tr>`;
  });
  const accountants = (mem || []).filter((m) => m.role === "accountant" && m.status === "active");
  const who = accountants.length
    ? `Your accountant${accountants.length > 1 ? "s" : ""}, ${esc(accountants.map((m) => m.name || m.email).join(", "))}, can read the books and export on their own.`
    : "Invite your accountant as a member with the Accountant role: they can read the books and export on their own.";
  return {
    html: `${d.swapsHaveExecuted ? "" : `<div class="banner warn">${Z.icon("science")}<span>${esc(plain(d.note || ""))}</span></div>`}
      <div class="zb-bar">${pills}</div>
      ${rows.length ? table([["Date"], ["Who"], ["Memo"], ["Category"], ["Receipt"], ["Amount", "z-tbl__num"]], rows)
        : empty(`No money moved in ${esc(monthName(bk.month))}. Lines appear once money moves on an account backed by a member’s own account.`)}
      <div class="zb-notes"><div class="zb-note">${Z.icon("person")}<span>${who}</span>
        ${linkBtn("Connections", "integrations", "hub")}${cap("coa.manage").allowed ? linkBtn("Chart of accounts", "coa") : ""}</div>
        <div class="zb-note">${Z.icon("more_horiz")}<span>Also in your books:
          <a href="?view=ledger" data-view-link="ledger">every transaction</a>${cap("assets.costBasis").allowed ? `, <a href="?view=assets" data-view-link="assets">assets and tax lots</a>` : ""},
          <a href="?view=wallets" data-view-link="wallets">imported wallets</a> and the
          <a href="?view=export" data-view-link="export">month’s statement lines</a>.</span></div></div>`,
    bind(box) {
      box.querySelectorAll("[data-cat-of]").forEach((sel) => {
        sel.onchange = async () => {
          if (!sel.value) return;
          sel.disabled = true;
          try {
            await api(`/api/orgs/${org.id}/ledger/${sel.dataset.catOf}`, { method: "PATCH", body: { accountCode: sel.value } });
            sel.dataset.was = sel.value;
            sel.querySelector('option[value=""]')?.remove();
            Z.announce("Category saved.");
          } catch (e) {
            sel.value = sel.dataset.was;
            toast(plain(e.message), true);
          } finally { sel.disabled = false; }
        };
      });
    },
  };
};
