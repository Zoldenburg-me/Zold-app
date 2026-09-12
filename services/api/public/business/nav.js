/** The left-hand navigation and the plan banner above it. */
import { $, cap, esc, org, setView, view } from "./core.js";
import { render } from "./shell.js";

export const VIEWS = [
  { id: "overview", label: "Overview", section: "" },
  { id: "accounts", label: "Accounts", section: "" },
  { id: "payments", label: "Payments", section: "Money", capability: "transfers.drafts" },
  { id: "invoices", label: "Invoices", section: "Money", capability: "invoices" },
  { id: "shopify", label: "Shopify", section: "Money" },
  { id: "contacts", label: "Contacts", section: "Money" },
  { id: "wallets", label: "Wallets", section: "Treasury" },
  { id: "ledger", label: "Transactions", section: "Books", capability: "ledger.transactions" },
  { id: "assets", label: "Assets", section: "Books", capability: "assets.costBasis" },
  { id: "coa", label: "Chart of accounts", section: "Books", capability: "coa.manage" },
  { id: "members", label: "Members", section: "Admin", capability: "members.manage" },
  { id: "settings", label: "Settings", section: "Admin" },
];

export function renderNav() {
  let html = "";
  let section = null;
  for (const v of VIEWS) {
    // Business-only entries stay out of a personal org entirely — that is a
    // product boundary, not a paywall.
    const verdict = v.capability ? cap(v.capability) : { allowed: true };
    if (v.capability && !verdict.allowed && !verdict.requiresPlan && !verdict.unavailable) continue;
    if (v.section !== section) { section = v.section; if (section) html += `<div class="sect">${esc(section)}</div>`; }
    const locked = v.capability && !verdict.allowed;
    html += `<a data-view="${v.id}" class="${view === v.id ? "active" : ""}">${esc(v.label)}
      ${locked ? `<span class="lock">${verdict.unavailable ? "—" : "PRO"}</span>` : ""}</a>`;
  }
  $("#nav").innerHTML = html;
  $("#nav").querySelectorAll("a").forEach((a) =>
    a.onclick = () => { setView(a.dataset.view); render(); });
}

export function planBanner() {
  if (!org) return "";
  const t = org.trial;
  if (t && !t.endedAt && new Date(t.endsAt) > new Date()) {
    const days = Math.ceil((new Date(t.endsAt) - new Date()) / 86400000);
    return `<div class="banner info">Trial of <b>${esc(t.grantsPlan)}</b> — ${days} day${days === 1 ? "" : "s"} left.
      When it ends you go back to ${esc(org.plan)}; nothing is deleted.
      <button class="sm" data-act="upgrade" data-plan="${esc(t.grantsPlan)}">Keep it</button></div>`;
  }
  if (org.plan === "starter") {
    return `<div class="banner warn">You are on <b>Starter</b> — payouts, contacts and history.
      ${org.trial ? "Your trial has been used." : "One 30-day trial is available."}
      ${org.trial ? "" : `<button class="sm" data-act="trial">Start trial</button>`}</div>`;
  }
  return "";
}
