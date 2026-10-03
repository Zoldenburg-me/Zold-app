/**
 * Books overview (design canvas "Books overview"): cash in and out, then
 * expenses and revenue by category, for a month or the last 30 days.
 *
 * Every figure is summed from the statement lines Books shows, grouped by the
 * category on each line and the type of that category in the chart of
 * accounts. Lines nobody categorised are counted as such, never guessed.
 */
import { Z, api, cap, esc, eur, gateHtml, org, plain } from "./core.js";
import { META, RENDER } from "./views.js";
import { MONTHS, barsHtml, cents, weeks } from "./home.js";

const DAY = 86400000;
const MONTH_PILLS = 5;
/* The account the default rule files every unsorted payment out under
   (domain/coa.ts DEFAULT_RULES, transfer_out). */
const DEFAULT_OUT_CODE = "6000";
/* The chart was allowed but its read failed: said as such, not as a plan limit. */
const CHART_FAILED = "failed";

const bo = { period: null };
const isoDay = (d) => d.toISOString().slice(0, 10);
const linkBtn = (label, view, icon) => `<a class="z-btn z-btn--secondary" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const monthName = (m, long = true) => long
  ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${m}-15T12:00:00`))
  : MONTHS[Number(m.slice(5, 7)) - 1];

/** The chosen period and the one before it, as inclusive day ranges. */
function ranges(period) {
  if (period === "30d") {
    const to = new Date();
    const from = new Date(to.getTime() - 29 * DAY);
    const pTo = new Date(from.getTime() - DAY);
    return { from: isoDay(from), to: isoDay(to), prev: { from: isoDay(new Date(pTo.getTime() - 29 * DAY)), to: isoDay(pTo) }, label: "the 30 days before", title: `${from.getUTCDate()} ${MONTHS[from.getUTCMonth()]} to ${to.getUTCDate()} ${MONTHS[to.getUTCMonth()]}` };
  }
  const [y, m] = period.split("-").map(Number);
  const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const pm = m === 1 ? [y - 1, 12] : [y, m - 1];
  const pad = (n) => String(n).padStart(2, "0");
  return {
    from: `${period}-01`, to: `${period}-${pad(last(y, m))}`,
    prev: { from: `${pm[0]}-${pad(pm[1])}-01`, to: `${pm[0]}-${pad(pm[1])}-${pad(last(pm[0], pm[1]))}` },
    label: monthName(`${pm[0]}-${pad(pm[1])}`).split(" ")[0], title: monthName(period),
  };
}

const inRange = (lines, r) => lines.filter((l) => l.valueDate >= r.from && l.valueDate <= r.to);

/** "+18% vs August", or nothing when there is no earlier figure to compare. */
function versus(now, before, label) {
  if (!before) return "";
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return `<span class="zb-hint">${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% vs ${esc(label)}</span>`;
}

function byCategory(lines, dir, chart) {
  const name = new Map((chart || []).map((c) => [c.code, plain(c.name)]));
  const by = new Map();
  for (const l of lines) {
    const v = dir === "in" ? l.amountCents : -l.amountCents;
    if (v <= 0) continue;
    const key = l.accountCode ? name.get(l.accountCode) || `Account ${l.accountCode}` : "Not categorised";
    by.set(key, (by.get(key) || 0) + v);
  }
  return [...by].sort((a, b) => b[1] - a[1]);
}

function categoryCard(id, title, dir, now, before, r, chart) {
  const names = Array.isArray(chart) ? chart : [];
  const total = cents(now, dir);
  const rows = byCategory(now, dir, names);
  const list = rows.length
    ? `<ul class="zb-bo-cats">${rows.map(([cat, v]) => {
      const pct = Math.round((v / total) * 100);
      return `<li><span class="zb-bo-cat"><span>${esc(cat)}</span><b>${esc(eur(v / 100))}</b><span class="zb-bo-pct">${pct}%</span></span>
        <span class="zb-bo-track" aria-hidden="true"><span class="zb-bo-fill zb-bo-fill--${dir}" style="width:${((v / total) * 100).toFixed(1)}%"></span></span></li>`;
    }).join("")}</ul>`
    : `<p class="zb-hint">Nothing ${dir === "in" ? "came in" : "went out"} in this period.</p>`;
  let hint = "";
  if (dir === "out") {
    const auto = now.filter((l) => l.amountCents < 0 && l.accountCode === DEFAULT_OUT_CODE && l.accountCodeAuto === true);
    // A line records that a rule chose its category, not which rule did.
    if (auto.length) hint = `<div class="zb-note zb-note--a">${Z.icon("rule")}<span>${auto.length} payment${auto.length === 1 ? "" : "s"} out ${auto.length === 1 ? "was" : "were"} filed under ${esc(names.find((c) => c.code === DEFAULT_OUT_CODE)?.name || "Transaction fees")} by a rule, not by a person. <a href="?view=books" data-view-link="books">Check them</a></span></div>`;
  }
  return `<section class="z-card zb-side-card" aria-labelledby="${id}"><div class="zb-side-card__head"><h2 id="${id}">${title}</h2><a href="?view=books" data-view-link="books">View lines</a></div>
    <div class="zb-h-fig"><span class="zb-h-fig__value">${esc(eur(total / 100))}</span>${versus(total, cents(before, dir), r.label)}</div>
    ${Array.isArray(chart) ? `<h3 class="zb-h-sub">By category</h3>${list}${hint}`
      : chart === CHART_FAILED ? `<p class="zb-hint">Categories couldn’t load. Open Books again to retry.</p>`
        : `<p class="zb-hint">Categories need the chart of accounts, which your plan doesn’t include.</p>`}</section>`;
}

function body(lines, months, chart) {
  const r = ranges(bo.period);
  const now = inRange(lines, r), before = inRange(lines, r.prev);
  const inC = cents(now, "in"), outC = cents(now, "out"), net = inC - outC;
  const signed = (sign, c) => `${c ? sign : ""}${esc(eur(Math.abs(c) / 100))}`;
  const pills = [["30d", "Last 30 days"], ...months.slice(0, MONTH_PILLS).map((m) => [m, monthName(m, false)])]
    .map(([id, text]) => `<button type="button" class="zb-h-chip" data-bo="${esc(id)}" aria-pressed="${bo.period === id}">${esc(text)}</button>`).join("");
  return `<div class="zb-h-chips zb-bo-periods" role="group" aria-label="Period">${pills}</div>
    <p class="zb-hint zb-bo-range">${esc(r.title)}</p>
    <section class="z-card zb-side-card zb-bo-cash" aria-labelledby="bo-cash">
      <div class="zb-bo-cash__figs"><h2 id="bo-cash">Cash</h2>
        <div class="zb-h-fig"><span class="zb-h-fig__label">Net cash flow</span><span class="zb-h-fig__value zb-bo-big">${signed(net < 0 ? "−" : "+", net)}</span>${versus(net, cents(before, "in") - cents(before, "out"), r.label)}</div>
        <dl class="zb-bo-io"><div><dt><span class="zb-h-key zb-h-key--in" aria-hidden="true"></span>Money in</dt><dd class="is-in">${signed("+", inC)}</dd></div><div><dt><span class="zb-h-key zb-h-key--out" aria-hidden="true"></span>Money out</dt><dd>${signed("−", outC)}</dd></div></dl></div>
      ${now.length ? barsHtml(weeks(now, r.from, r.to), `Money in and out per week, ${r.title}`) : `<p class="zb-hint">No money moved in this period.</p>`}
    </section>
    <div class="zb-grid2 zb-bo-split">${categoryCard("bo-exp", "Expenses", "out", now, before, r, chart)}${categoryCard("bo-rev", "Revenue", "in", now, before, r, chart)}</div>`;
}

META["books-overview"] = () => ({
  title: "Books",
  sub: "",
  actions: cap("export.ledger").allowed ? linkBtn("Export", "export", "download") : "",
});

RENDER["books-overview"] = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const [st, coa] = await Promise.all([
    api(`/api/orgs/${org.id}/bookkeeping/statement`),
    cap("coa.manage").allowed ? api(`/api/orgs/${org.id}/chart-of-accounts`).then((r) => r.accounts).catch(() => CHART_FAILED) : Promise.resolve(null),
  ]);
  const { lines, months } = st;
  if (!bo.period || (bo.period !== "30d" && !months.includes(bo.period))) bo.period = months[0] || "30d";
  if (!lines.length) return `<div class="z-card"><p class="empty">No money has moved on this organisation’s accounts yet. Lines appear once money moves on an account backed by a member’s own account.</p></div>`;
  return {
    html: `<div id="bo-body">${body(lines, months, coa)}</div>`,
    bind(box) {
      // On #bo-body, which each render replaces: #view itself outlives renders.
      box.querySelector("#bo-body").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-bo]");
        if (!b) return;
        bo.period = b.dataset.bo;
        box.querySelector("#bo-body").innerHTML = body(lines, months, coa);
        box.querySelector(`[data-bo="${bo.period}"]`)?.focus();
      });
    },
  };
};
