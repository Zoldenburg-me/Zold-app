/**
 * The screens drawn from the design/ui-v2 desktop references (build step 8b):
 * Home, Approvals, Contacts, Members, Invoices and Books. The older views are
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
import { side, waitingForMe } from "./nav.js";

const primary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--primary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const secondary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--secondary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const linkBtn = (label, view, icon, variant = "secondary") => `<a class="z-btn z-btn--${variant}" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const note = (text, icon = "info", tone = "") => `<div class="zb-note${tone ? ` zb-note--${tone}` : ""}">${Z.icon(icon)}<span>${text}</span></div>`;
const table = (head, rows) => `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr>${head.map(([h, cls]) => `<th scope="col"${cls ? ` class="${cls}"` : ""}>${h ? esc(h) : `<span class="z-sr">Actions</span>`}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const empty = (text) => `<div class="z-card"><p class="empty">${text}</p></div>`;

/* ── Members and payment runs, shared by several screens ─────────────────── */

let members = null;          // this org's, read once per render that needs them
async function loadMembers() {
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
   Home
   ========================================================================== */

/* A statement line's status, from its event: money out is Sent (it left
   the account; the bank's confirmation is not on the line), never Paid. */
const LINE_WORD = { sepa_in: "Received", sepa_out: "Sent", sepa_out_reversal: "Refunded", crypto_converted: "Received", crypto_held: "Received", sweep: "Done" };

META.overview = () => ({
  title: org.name,
  sub: "",
  actions: "",
});

RENDER.overview = async () => {
  const drafts = cap("transfers.drafts").allowed;
  const [acc, dr, inv, mem, st] = await Promise.allSettled([
    api(`/api/orgs/${org.id}/accounts`),
    drafts ? api(`/api/orgs/${org.id}/drafts`) : Promise.resolve({ drafts: [] }),
    cap("invoices").allowed ? api(`/api/orgs/${org.id}/invoices`) : Promise.resolve(null),
    loadMembers(),
    cap("ledger.transactions").allowed ? api(`/api/orgs/${org.id}/bookkeeping/statement`) : Promise.resolve(null),
  ]);
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : [];
  const runs = dr.status === "fulfilled" ? dr.value.drafts : [];
  const invoices = inv.status === "fulfilled" && inv.value ? inv.value.invoices : null;
  const lines = st.status === "fulfilled" && st.value ? st.value.lines : null;
  const team = (mem.status === "fulfilled" ? mem.value : []).filter((m) => m.status === "active");

  // Payment runs waiting for this person.
  const waiting = waitingForMe(runs);
  const sum = waiting.reduce((n, d) => n + Number(d.totals?.EUR || d.totals?.EURe || 0), 0);
  const oldest = [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const review = waiting.length
    ? `<section class="zb-review" aria-labelledby="home-rv">${Z.iconTile({ icon: "inbox", tone: "p" })}
        <div class="zb-review__main"><b id="home-rv">${waiting.length} payment${waiting.length === 1 ? "" : "s"} wait${waiting.length === 1 ? "s" : ""} for your review</b>
        <span>${sum ? `${esc(eur(sum))} in total · ` : ""}oldest drafted ${esc(when(oldest.createdAt).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase()))} by ${esc(memberName(oldest.createdByMemberId))}</span></div>
        ${linkBtn("Review", "payments", "", "primary")}</section>`
    : "";

  // No company balance: your own account's, when it is the one that pays.
  const mine = accounts.find((a) => a.status === "active" && a.backingUserId && me && a.backingUserId === me.id);
  const fig = (v) => {
    const s = eur(v);
    const m = /^€([\d,]+)(\.\d{2})$/.exec(s);
    return m ? `<span class="z-balance__fig"><span class="z-balance__cur">€</span>${esc(m[1])}<span class="z-balance__cents">${esc(m[2])}</span></span>` : `<span class="z-balance__fig">${esc(s)}</span>`;
  };
  const accCards = accounts.map((a) => {
    const iban = a.identifier?.iban;
    const isMine = a === mine;
    return `<a class="zb-acc" href="?view=accounts" data-view-link="accounts"><span class="zb-acc__name">${esc(a.label || a.currency)}</span>
      <span>${a.status === "active" ? Z.tag("Active") : Z.tag(a.status === "gated" ? "Not open" : "Waiting")}${isMine ? ' <span class="zb-hint">Spends from your account</span>' : ""}</span>
      ${iban ? `<span class="z-mono" translate="no">${esc(maskIban(iban))}</span>` : ""}</a>`;
  }).join("");
  const canPropose = drafts && roleCan(org.role, "propose");
  const acts = [
    canPropose ? (waiting.length ? linkBtn("New payment", "send", "arrow_outward") : linkBtn("New payment", "send", "arrow_outward", "primary")) : "",
    cap("invoices").allowed ? secondary("Issue invoice", 'data-act="issue-invoice"', "receipt_long") : "",
  ].filter(Boolean).join("");
  const balance = `<section class="z-card zb-bal" aria-labelledby="home-bal">
      ${mine && typeof me?.balanceEur === "number"
        ? `<div><p class="zb-bal__label" id="home-bal">Balance of your account</p><p class="z-balance" style="margin-top:6px">${fig(me.balanceEur)}</p>
           <p class="zb-hint" style="margin-top:8px">Your own account pays for ${esc(org.name)}, so its payments come from here.</p></div>`
        : `<div><h2 class="zb-h2" id="home-bal">Accounts</h2><p class="zb-hint" style="margin-top:4px">${accounts.some((a) => a.backingUserId)
          ? "A company account spends from one member’s own account. Only that member sees its balance."
          : "No account can pay yet. Connect the company’s Monerium profile on the Accounts screen."}</p></div>`}
      ${accounts.length ? `<div class="zb-accgrid">${accCards}</div>` : ""}
      ${acts ? `<div class="zb-actions" style="margin-top:0">${acts}</div>` : ""}
    </section>`;

  // Invoices: what is open and what is late, from the invoices themselves.
  let invCard = "";
  if (invoices) {
    const out = invoices.filter((i) => i.direction === "outgoing" && !["PAID", "RECONCILED", "DELETED"].includes(i.state));
    const late = out.filter((i) => i.overdue);
    const total = (list) => list.reduce((n, i) => n + (i.issued ? i.issued.grossCents / 100 : Number(i.total) || 0), 0);
    invCard = `<section class="z-card zb-side-card" aria-labelledby="home-inv">
      <div class="zb-side-card__head"><h2 id="home-inv">Invoices</h2><a href="?view=invoices" data-view-link="invoices">Open</a></div>
      <p class="zb-kv"><span>${out.length} open</span><b>${esc(eur(total(out)))}</b></p>
      <p class="zb-kv"><span>${late.length} overdue</span><b class="${late.length ? "is-late" : ""}">${esc(eur(total(late)))}</b></p>
    </section>`;
  }
  const teamCard = org.type === "personal" ? "" : `<section class="z-card zb-side-card" aria-labelledby="home-team">
      <div class="zb-side-card__head"><h2 id="home-team">Team</h2>${cap("members.manage").allowed ? '<a href="?view=members" data-view-link="members">Manage</a>' : ""}</div>
      <div class="zb-team">${team.map((m) => `<span title="${esc(m.name || m.email)}">${Z.avatar({ name: m.name || m.email, tone: m.id === org.memberId ? "p" : "n" })}<span class="z-sr">${esc(m.name || m.email)}</span></span>`).join("")}</div>
      <p class="zb-hint">${cap("transfers.approvals").allowed ? "Every payment needs a second person to approve it." : "On this plan, payments go out without a second approval."}</p>
    </section>`;

  // Recent activity: the statement lines, newest first.
  let activity = "";
  if (lines) {
    const rows = [...lines].sort((a, b) => b.valueDate.localeCompare(a.valueDate)).slice(0, 6).map((l) => {
      const inbound = l.amountCents >= 0;
      const who = l.counterparty?.name || (inbound ? "Money in" : "Payment");
      return `<tr><td class="z-dim">${esc(when(ymd(l.valueDate)))}</td>
        <td><span class="z-tbl__who">${Z.avatar({ name: who })}<a class="z-tbl__link" href="?view=books" data-view-link="books">${esc(who)}</a></span></td>
        <td>${l.note ? esc(l.note) : l.reference ? esc(plain(l.reference)) : '<span class="z-dim">No memo</span>'}</td>
        <td>${Z.tag(LINE_WORD[l.event] || (inbound ? "Received" : "Sent"))}</td>
        <td class="z-tbl__num">${Z.amount({ value: Math.abs(l.amountCents) / 100, direction: inbound ? "in" : "out" })}</td></tr>`;
    });
    activity = `<section class="zb-stack" style="margin-top:22px;gap:12px"><div class="z-group__head" style="padding:0"><h2 class="zb-h2">Recent activity</h2>${rows.length ? '<a class="z-group__action" href="?view=books" data-view-link="books">See all</a>' : ""}</div>
      ${rows.length ? table([["Date"], ["Who"], ["Memo"], ["Status"], ["Amount", "z-tbl__num"]], rows) : empty("No money has moved on this organisation’s accounts yet.")}</section>`;
  }
  return `${review}<div class="zb-home">${balance}<div class="zb-home__col">${invCard}${teamCard}</div></div>${activity}`;
};

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

export function invWord(i) {
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
    ? `${secondary("Request an invoice", 'data-act="new-invoice"', "move_to_inbox")}${primary("Issue invoice", 'data-act="issue-invoice"', "add")}`
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
    const who = (out ? i.issued?.recipient?.name : i.supplier?.orgName) || (out ? "Customer" : "Waiting for your supplier");
    const num = (out ? i.issued?.number : i.supplier?.invoiceNumber) || "";
    const a = invAmount(i);
    const fig = w === "WAITING" ? '<span class="z-dim">Not filled in</span>'
      : w === "PAID" ? Z.amount({ value: a.value, currency: a.currency, direction: out ? "in" : "out" })
        : `<span class="z-amount">${esc(Z.formatMoney(a.value, a.currency))}</span>`;
    return `<tr><td class="z-mono">${esc(num) || '<span class="z-dim">None</span>'}</td>
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

/** One invoice in a drawer: its parties, what it is for, how it was paid. */
export function invoiceDrawer(i, trigger) {
  const out = i.direction === "outgoing";
  const a = invAmount(i);
  const who = (out ? i.issued?.recipient?.name : i.supplier?.orgName) || "Not filled in yet";
  const num = (out ? i.issued?.number : i.supplier?.invoiceNumber) || "";
  const rows = [
    ["Number", num || "None"],
    [out ? "Customer" : "Supplier", who],
    ["Amount", Z.formatMoney(a.value, a.currency)],
    ["Due", i.dueDate ? day(ymd(i.dueDate)) : "None"],
    ...(!out && i.payTo?.bank?.iban ? [["Pay to", Z.groupIban(i.payTo.bank.iban)]] : []),
  ];
  document.getElementById("inv-drawer")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "inv-drawer", title: num ? `Invoice ${num}` : "Invoice",
    body: `<div class="z-sheet__body"><div>${Z.tag(invWord(i))}</div>
      <dl class="z-kv z-card">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${i.settlements?.length ? settlementRows(i.settlements) : ""}
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
