/**
 * Home of the business console (design canvas "Home, business: Banking"):
 * what needs you, money in and out, the accounts, invoices and payments at a
 * glance, who paid and who got paid, and the latest statement lines.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - There is no company balance. Only the account backed by YOUR own account
 *   shows a figure; another names the member who backs it.
 * - Money in and out is summed from the statement lines Books shows. An org
 *   without Books gets no chart, never a row of zeros.
 * - Money out is Sent, never Paid: the bank's confirmation is not on a line.
 */
import { $, Z, api, cap, esc, eur, gateHtml, maskIban, me, org, roleCan, view, when, ymd } from "./core.js";
import { META, RENDER } from "./views.js";
import { side, waitingForMe } from "./nav.js";
import { invAmount, loadMembers, memberName } from "./screens.js";

const DAY = 86400000;
/* "Sep", not the "Sept" some locales give, to match dates elsewhere in the app. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_MAX_PX = 120;
const TOP_N = 4;
const ACTIVITY_ROWS = 8;
const PERIODS = [["30d", "Last 30 days"], ["month", "This month"], ["3m", "3 months"]];
const LINE_WORD = { sepa_in: "Received", sepa_out: "Sent", sepa_out_reversal: "Refunded", crypto_converted: "Received", crypto_held: "Received", eure_in: "Received", sweep: "Done" };

/* What the page remembers between redraws of one section. */
const hs = { period: "30d", tab: "all", month: null };

const linkBtn = (label, view, icon, variant = "secondary") => `<a class="z-btn z-btn--${variant}" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const isoDay = (d) => d.toISOString().slice(0, 10);
export const cents = (lines, dir) => lines.reduce((n, l) => n + (dir === "in" ? Math.max(l.amountCents, 0) : Math.max(-l.amountCents, 0)), 0);
const sumEur = (d) => Number(d.totals?.EUR || d.totals?.EURe || 0);
const within = (iso, days) => !!iso && Date.now() - Date.parse(iso) <= days * DAY;

/* ── Money in and out ─────────────────────────────────────────────────────── */

function windowOf(period) {
  const today = new Date();
  const from = period === "month" ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    : new Date(today.getTime() - (period === "3m" ? 89 : 29) * DAY);
  return { from: isoDay(from), to: isoDay(today) };
}

/** Weekly buckets from the Monday on or before `from`. */
export function weeks(lines, from, to) {
  const start = new Date(`${from}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const out = [];
  for (let d = start; isoDay(d) <= to; d = new Date(d.getTime() + 7 * DAY)) {
    const a = isoDay(d), b = isoDay(new Date(d.getTime() + 6 * DAY));
    const wk = lines.filter((l) => l.valueDate >= a && l.valueDate <= b);
    out.push({ label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, in: cents(wk, "in"), out: cents(wk, "out") });
  }
  return out;
}

/** Paired weekly bars, money in beside money out, with a list for screen readers. */
export function barsHtml(buckets, caption) {
  const max = Math.max(1, ...buckets.flatMap((b) => [b.in, b.out]));
  const h = (v) => (v ? Math.max(4, Math.round((v / max) * BAR_MAX_PX)) : 0);
  return `<figure class="zb-h-chart"><figcaption class="z-sr">${esc(caption)}</figcaption>
      <div class="zb-h-bars" style="--n:${buckets.length}">${buckets.map((b) => `<div class="zb-h-bar" title="${esc(b.label)}: in ${esc(eur(b.in / 100))}, out ${esc(eur(b.out / 100))}"><span class="zb-h-bar__in" style="height:${h(b.in)}px"></span><span class="zb-h-bar__out" style="height:${h(b.out)}px"></span></div>`).join("")}</div>
      <div class="zb-h-axis" style="--n:${buckets.length}" aria-hidden="true">${buckets.map((b) => `<span>${esc(b.label)}</span>`).join("")}</div>
      <ul class="z-sr">${buckets.map((b) => `<li>Week of ${esc(b.label)}: in ${esc(eur(b.in / 100))}, out ${esc(eur(b.out / 100))}</li>`).join("")}</ul></figure>`;
}

function flowCard(all) {
  const { from, to } = windowOf(hs.period);
  const lines = all.filter((l) => l.valueDate >= from && l.valueDate <= to);
  const inC = cents(lines, "in"), outC = cents(lines, "out");
  const buckets = weeks(lines, from, to);
  const label = PERIODS.find((p) => p[0] === hs.period)[1];
  const pills = PERIODS.map(([id, text]) => `<button type="button" class="zb-h-pill" data-hp="${id}" aria-pressed="${hs.period === id}">${text}</button>`).join("");
  const signed = (sign, c) => `${c ? sign : ""}${esc(eur(Math.abs(c) / 100))}`;
  const figure = (text, value, cls) => `<div class="zb-h-fig"><span class="zb-h-fig__label">${text}</span><span class="zb-h-fig__value ${cls}">${value}</span></div>`;
  return `<div class="zb-side-card__head"><h2 id="home-flow">Money in and out</h2><div class="zb-h-pills" role="group" aria-label="Period">${pills}</div></div>
    <div class="zb-h-figs">${figure(`<span class="zb-h-key zb-h-key--in" aria-hidden="true"></span>Money in`, signed("+", inC), "is-in")}
      ${figure(`<span class="zb-h-key zb-h-key--out" aria-hidden="true"></span>Money out`, signed("−", outC), "")}
      ${figure("Net", signed(inC - outC < 0 ? "−" : "+", inC - outC), "")}</div>
    ${lines.length ? barsHtml(buckets, `Money in and out per week, ${label.toLowerCase()}`)
      : `<p class="zb-hint">No money moved in this period.</p>`}`;
}

/* ── Money movement and activity ──────────────────────────────────────────── */

function top(lines, dir) {
  const by = new Map();
  for (const l of lines) {
    const v = dir === "in" ? l.amountCents : -l.amountCents;
    if (v <= 0) continue;
    const who = l.counterparty?.name || (dir === "in" ? "Money in" : "Payment");
    by.set(who, (by.get(who) || 0) + v);
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
}

function movement(all, months) {
  if (!hs.month || !months.includes(hs.month)) hs.month = months[0];
  const i = months.indexOf(hs.month);
  const lines = all.filter((l) => l.valueDate.slice(0, 7) === hs.month);
  const name = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${hs.month}-15T12:00:00`));
  const side2 = (dir, title, sub) => {
    const rows = top(lines, dir);
    const total = cents(lines, dir) / 100;
    return `<div class="z-card zb-h-move"><div class="zb-h-fig"><span class="zb-h-fig__label">${title}</span><span class="zb-h-fig__value ${dir === "in" ? "is-in" : ""}">${total ? (dir === "in" ? "+" : "−") : ""}${esc(eur(total))}</span></div>
      <h3 class="zb-h-sub">${sub}</h3>
      ${rows.length ? `<ul class="zb-h-tops">${rows.map(([who, v]) => `<li>${Z.avatar({ name: who })}<span>${esc(who)}</span><b>${esc(eur(v / 100))}</b></li>`).join("")}</ul>` : `<p class="zb-hint">None this month.</p>`}</div>`;
  };
  return `<div class="zb-h-head"><h2 class="zb-h2" id="home-move">Money movement</h2>
      <span class="zb-h-month"><button type="button" class="zb-h-icon-btn" data-hm="${esc(months[i + 1] || "")}" aria-label="Previous month"${months[i + 1] ? "" : " disabled"}>${Z.icon("chevron_left")}</button>
      <span>${esc(name)}</span>
      <button type="button" class="zb-h-icon-btn" data-hm="${esc(months[i - 1] || "")}" aria-label="Next month"${i > 0 ? "" : " disabled"}>${Z.icon("chevron_right")}</button></span></div>
    <div class="zb-grid2">${side2("in", "Money in", "Top payers")}${side2("out", "Money out", "Top payees")}</div>`;
}

/** Home shows the latest few; Transactions shows them all. */
function activity(all, limit = ACTIVITY_ROWS) {
  const tabs = [["all", "All"], ["in", "Money in"], ["out", "Money out"]].map(([id, text]) => `<button type="button" class="zb-h-chip" data-ht="${id}" aria-pressed="${hs.tab === id}">${text}</button>`).join("");
  const rows = [...all].filter((l) => hs.tab === "all" || (hs.tab === "in") === (l.amountCents >= 0))
    .sort((a, b) => b.valueDate.localeCompare(a.valueDate)).slice(0, limit).map((l) => {
      const inbound = l.amountCents >= 0;
      const who = l.counterparty?.name || (inbound ? "Money in" : "Payment");
      return `<tr><td class="z-dim">${esc(when(ymd(l.valueDate)))}</td>
        <td><span class="z-tbl__who">${Z.avatar({ name: who })}<a class="z-tbl__link" href="?view=books" data-view-link="books">${esc(who)}</a></span></td>
        <td>${l.note ? esc(l.note) : l.reference ? esc(l.reference) : '<span class="z-dim">No memo</span>'}</td>
        <td>${Z.tag(LINE_WORD[l.event] || (inbound ? "Received" : "Sent"))}</td>
        <td class="z-tbl__num">${Z.amount({ value: Math.abs(l.amountCents) / 100, direction: inbound ? "in" : "out" })}</td></tr>`;
    });
  const all_ = limit === Infinity;
  return `<div class="zb-h-head">${all_ ? "" : `<h2 class="zb-h2" id="home-act">Recent activity</h2>`}<div class="zb-h-chips" role="group" aria-label="Show">${tabs}</div>
      ${all_ ? "" : `<a class="z-group__action zb-h-end" href="?view=transactions" data-view-link="transactions">See all</a>`}</div>
    ${rows.length ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Who</th><th scope="col">Memo</th><th scope="col">Status</th><th scope="col" class="z-tbl__num">Amount</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">No money has moved on this organisation’s accounts yet.</p></div>`}`;
}

/* ── The cards that need no chart ─────────────────────────────────────────── */

function attention({ waiting, invoices, lines, accounts }) {
  const rows = [];
  const row = (icon, tone, title, sub, act) => `<li class="zb-h-att">${Z.iconTile({ icon, tone })}<span class="z-row__main"><span class="z-row__title">${title}</span><span class="z-row__sub">${sub}</span></span>${act}</li>`;
  if (waiting.length) {
    const oldest = [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const sum = waiting.reduce((n, d) => n + sumEur(d), 0);
    rows.push(row("inbox", "p", `${waiting.length} payment${waiting.length === 1 ? "" : "s"} wait${waiting.length === 1 ? "s" : ""} for your review`,
      `${sum ? `${esc(eur(sum))} in total · ` : ""}oldest drafted ${esc(when(oldest.createdAt).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase()))} by ${esc(memberName(oldest.createdByMemberId))}`,
      linkBtn("Review", "payments", "", "primary")));
  }
  const late = (invoices || []).filter((i) => i.direction === "outgoing" && i.overdue && !["PAID", "RECONCILED", "DELETED", "DRAFT"].includes(i.state));
  if (late.length) {
    const first = late[0];
    const who = first.issued?.recipient?.name || "Customer";
    rows.push(row("schedule", "a", `${late.length} invoice${late.length === 1 ? " is" : "s are"} overdue`,
      late.length === 1 ? `${esc(who)} · ${esc(eur(invAmount(first).value))}${first.dueDate ? `, due ${esc(when(ymd(first.dueDate)))}` : ""}` : `${esc(eur(late.reduce((n, i) => n + invAmount(i).value, 0)))} in total`,
      linkBtn(late.length === 1 ? "Open invoice" : "Open invoices", "invoices")));
  }
  const noReceipt = (lines || []).filter((l) => l.amountCents < 0 && !l.documentCode && within(ymd(l.valueDate), 60));
  if (noReceipt.length) {
    rows.push(row("attach_file", "n", `${noReceipt.length} payment${noReceipt.length === 1 ? " has" : "s have"} no receipt`,
      "In the last 60 days. Your accountant needs one for each payment out.", linkBtn("Add receipts", "books")));
  }
  for (const a of accounts.filter((x) => x.profile?.status === "needs_check")) {
    rows.push(row("verified_user", "a", `${esc(a.label || a.currency)} needs its Monerium profile checked`, "Payments from it wait until the check passes.", linkBtn("Accounts", "accounts")));
  }
  return rows.length ? `<section class="z-card zb-h-attention" aria-labelledby="home-att"><h2 id="home-att">Needs attention</h2><ul>${rows.join("")}</ul></section>` : "";
}

function accountsCard(accounts) {
  if (!accounts.length) return `<section class="z-card zb-side-card" aria-labelledby="home-acc"><div class="zb-side-card__head"><h2 id="home-acc">Accounts</h2></div><p class="zb-hint">No account can pay yet. Connect the company’s Monerium profile on the Accounts screen.</p>${linkBtn("Accounts", "accounts")}</section>`;
  const one = (a) => {
    const mine = a.status === "active" && a.backingUserId && me && a.backingUserId === me.id;
    const first = (a.backingMemberName || "").split(" ")[0];
    const sub = mine ? "Spends from your account"
      : a.backingUserId ? `Spends from ${a.backingMemberName ? `${esc(a.backingMemberName)}’s` : "a member’s"} account. Only ${first ? esc(first) : "they"} see${first ? "s" : ""} its balance.`
        : "Not connected to a member’s account yet.";
    const iban = a.identifier?.iban;
    return `<div class="zb-h-acc"><span class="zb-h-acc__head"><b>${esc(a.label || a.currency)}</b>${a.status === "active" ? Z.tag("Active") : Z.tag(a.status === "gated" ? "Not open" : "Waiting")}</span>
      ${mine && typeof me.balanceEur === "number" ? `<span class="zb-h-acc__fig">${esc(eur(me.balanceEur))}</span>` : ""}
      <span class="zb-hint">${sub}</span>${iban ? `<span class="z-mono" translate="no">${esc(maskIban(iban))}</span>` : ""}</div>`;
  };
  return `<section class="z-card zb-side-card" aria-labelledby="home-acc"><div class="zb-side-card__head"><h2 id="home-acc">Accounts</h2><a href="?view=get-paid" data-view-link="get-paid">Details</a></div>${accounts.map(one).join("")}</section>`;
}

function statCard(id, title, view, cells) {
  return `<section class="z-card zb-side-card" aria-labelledby="${id}"><div class="zb-side-card__head"><h2 id="${id}">${title}</h2><a href="?view=${view}" data-view-link="${view}">View all</a></div>
    <dl class="zb-h-stats">${cells.map(([label, n, amount, tone]) => `<div><dt>${label}</dt><dd class="${tone || ""}"><b>${n}</b><span>${esc(eur(amount))}</span></dd></div>`).join("")}</dl></section>`;
}

/* ── Screen ───────────────────────────────────────────────────────────────── */

/* New payment is the page's one pink action unless runs wait for you: then
   Review in Needs attention is, and New payment steps back. */
function headerActions(waiting) {
  const drafts = cap("transfers.drafts").allowed && roleCan(org.role, "propose");
  return [
    drafts ? linkBtn("New payment", "send", "arrow_outward", waiting ? "secondary" : "primary") : "",
    cap("invoices").allowed ? `<button type="button" class="z-btn z-btn--secondary" data-act="issue-invoice">${Z.icon("receipt_long")}<span>Issue invoice</span></button>` : "",
    linkBtn("Request payment", "get-paid", "south_west"),
  ].join("");
}

META.overview = () => ({ title: org.name, sub: "", actions: headerActions(waitingForMe(side.drafts).length) });

RENDER.overview = async () => {
  const books = cap("ledger.transactions").allowed;
  const [acc, dr, inv, , st] = await Promise.allSettled([
    api(`/api/orgs/${org.id}/accounts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${org.id}/drafts`) : Promise.resolve({ drafts: [] }),
    cap("invoices").allowed ? api(`/api/orgs/${org.id}/invoices`) : Promise.resolve(null),
    loadMembers(),
    books ? api(`/api/orgs/${org.id}/bookkeeping/statement`) : Promise.resolve(null),
  ]);
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : [];
  const runs = dr.status === "fulfilled" ? dr.value.drafts : [];
  // Only while Home is still the open view: a slow load must not overwrite another header.
  if (view === "overview") $("#view-actions").innerHTML = headerActions(waitingForMe(runs).length);
  const invoices = inv.status === "fulfilled" && inv.value ? inv.value.invoices : null;
  const lines = st.status === "fulfilled" && st.value ? st.value.lines : null;
  const months = st.status === "fulfilled" && st.value ? st.value.months : [];

  const cards = [];
  if (invoices) {
    const out = invoices.filter((i) => i.direction === "outgoing" && i.state !== "DELETED");
    const open = out.filter((i) => !["PAID", "RECONCILED"].includes(i.state));
    const late = open.filter((i) => i.overdue);
    const paid = out.filter((i) => ["PAID", "RECONCILED"].includes(i.state) && within(i.payment?.paidAt || i.payment?.manual?.at, 30));
    const total = (list) => list.reduce((n, i) => n + invAmount(i).value, 0);
    cards.push(statCard("home-inv", "Invoices", "invoices", [["Open", open.length, total(open)], ["Overdue", late.length, total(late), late.length ? "is-late" : ""], ["Paid, last 30 days", paid.length, total(paid)]]));
  }
  if (cap("transfers.drafts").allowed) {
    const by = (s) => runs.filter((d) => d.state === s);
    const total = (list) => list.reduce((n, d) => n + sumEur(d), 0);
    // What left the account, from the statement; without Books, the runs marked sent.
    const out30 = (lines || []).filter((l) => l.amountCents < 0 && within(ymd(l.valueDate), 30));
    const sent = lines
      ? ["Sent, last 30 days", out30.length, cents(out30, "out") / 100]
      : ["Sent", by("EXECUTED").length, total(by("EXECUTED"))];
    cards.push(statCard("home-pay", "Payments", "payments", [["Waiting for review", by("PENDING_REVIEW").length, total(by("PENDING_REVIEW"))], ["Approved, not sent", by("REVIEWED").length, total(by("REVIEWED"))], sent]));
  }

  const html = `<div id="hm-root">${attention({ waiting: waitingForMe(runs), invoices, lines, accounts })}
    <div class="zb-h-top">${lines ? `<section class="z-card zb-side-card zb-h-flow" id="hm-flow" aria-labelledby="home-flow">${flowCard(lines)}</section>` : ""}${accountsCard(accounts)}</div>
    ${cards.length ? `<div class="zb-grid2">${cards.join("")}</div>` : ""}
    ${lines && months.length ? `<section class="zb-h-section" id="hm-move" aria-labelledby="home-move">${movement(lines, months)}</section>` : ""}
    ${lines ? `<section class="zb-h-section" id="hm-act" aria-labelledby="home-act">${activity(lines)}</section>` : ""}</div>`;

  return {
    html,
    bind(box) {
      // On #hm-root, which each render replaces: #view itself outlives renders.
      box.querySelector("#hm-root").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-hp],[data-ht],[data-hm]");
        if (!b || !lines) return;
        // Redraw only the section, then put focus back on the control that was pressed.
        let again;
        if (b.dataset.hp) { hs.period = b.dataset.hp; box.querySelector("#hm-flow").innerHTML = flowCard(lines); again = `[data-hp="${hs.period}"]`; }
        else if (b.dataset.ht) { hs.tab = b.dataset.ht; box.querySelector("#hm-act").innerHTML = activity(lines); again = `[data-ht="${hs.tab}"]`; }
        else if (b.dataset.hm) {
          const back = b.getAttribute("aria-label");
          hs.month = b.dataset.hm;
          box.querySelector("#hm-move").innerHTML = movement(lines, months);
          again = `[data-hm][aria-label="${back}"]:not([disabled])`;
        }
        box.querySelector(again)?.focus();
      });
    },
  };
};

/* ── Transactions: every statement line, newest first ─────────────────────── */

META.transactions = () => ({ title: "Transactions", sub: "Every euro in and out of this organisation’s accounts.", actions: "" });

RENDER.transactions = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const { lines } = await api(`/api/orgs/${org.id}/bookkeeping/statement`);
  return {
    html: `<section id="tx-root" aria-label="Transactions">${activity(lines, Infinity)}</section>`,
    bind(box) {
      box.querySelector("#tx-root").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-ht]");
        if (!b) return;
        hs.tab = b.dataset.ht;
        box.querySelector("#tx-root").innerHTML = activity(lines, Infinity);
        box.querySelector(`[data-ht="${hs.tab}"]`)?.focus();
      });
    },
  };
};
