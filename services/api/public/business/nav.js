/**
 * The sidebar (design canvas "Desktop: Banking and Books") and the plan
 * banner.
 *
 * Two spaces behind one switch. Banking: Home, Approvals, Send, Get paid,
 * Invoices, Contacts, Members, Apps, then the ACCOUNTS list, Coming soon and
 * Settings. Books: Overview, Statement, Wallets, Categories, Export,
 * Connections, then Settings.
 * The older views keep their ?view= ids and sit under one of these (PARENT):
 * the ledger and assets under Statement, Shopify under Apps.
 */
import { $, Z, api, cap, esc, eur, me, needsPersonalOrg, org, orgs, personalLater, roleCan, ROLE_WORD, setView, testMode, view } from "./core.js";
import { loadOrg, render } from "./shell.js";

export const SPACES = {
  banking: [
    { id: "overview", label: "Home", icon: "home" },
    { id: "payments", label: "Approvals", icon: "inbox", capability: "transfers.drafts" },
    { id: "send", label: "Send", icon: "arrow_outward", capability: "transfers.drafts" },
    { id: "get-paid", label: "Get paid", icon: "south_west" },
    { id: "transactions", label: "Transactions", icon: "swap_vert", capability: "ledger.transactions" },
    { id: "documents", label: "Statements", icon: "description" },
    { id: "invoices", label: "Invoices", icon: "receipt_long", capability: "invoices" },
    { id: "contacts", label: "Contacts", icon: "contacts" },
    { id: "members", label: "Members", icon: "group", capability: "members.manage" },
    { id: "apps", label: "Apps", icon: "apps" },
  ],
  books: [
    { id: "books-overview", label: "Overview", icon: "monitoring", capability: "ledger.transactions" },
    { id: "books", label: "Statement", icon: "list_alt", capability: "ledger.transactions" },
    { id: "wallets", label: "Wallets", icon: "wallet", capability: "wallets.manage" },
    { id: "coa", label: "Categories", icon: "category", capability: "coa.manage" },
    { id: "export", label: "Export", icon: "download", capability: "export.ledger" },
    { id: "integrations", label: "Connections", icon: "cable" },
  ],
};
export const VIEWS = [...SPACES.banking, ...SPACES.books];
/** Where the Banking and Books switch lands. */
const SPACE_HOME = { banking: "overview", books: "books-overview" };

/** Which nav item an older view belongs to. */
export const PARENT = {
  ledger: "books", assets: "books", gains: "books",
  shopify: "apps", "invoice-new": "invoices", "invoicing-settings": "settings", organisation: "settings", plan: "settings", accounts: "accounts",
};
/** Every view id the router accepts, including those without a nav item. */
export const KNOWN = new Set([...VIEWS.map((v) => v.id), ...Object.keys(PARENT), "settings", "soon"]);

/** The space a view lives in. Settings and Coming soon stay in the one you came from. */
let lastSpace = "banking";
export function spaceOf(v) {
  const item = PARENT[v] || v;
  if (SPACES.books.some((it) => it.id === item)) lastSpace = "books";
  else if (SPACES.banking.some((it) => it.id === item) || item === "accounts") lastSpace = "banking";
  return lastSpace;
}

/* A plan limit keeps the entry, with a lock; a feature this kind of org can
   never have (a business-only entry in a personal org) leaves it out. */
function shown(v) {
  const verdict = v.capability ? cap(v.capability) : { allowed: true };
  return !v.capability || verdict.allowed || verdict.requiresPlan || verdict.unavailable;
}

/* What the sidebar shows beside the nav: the org's accounts, and how many
   payment runs wait for this person. Read after each render, drawn from
   here; a failed read leaves the last one. */
export const side = { orgId: null, accounts: null, drafts: null };

/** Waiting for this person: drafted by someone else, and their role approves. */
export const waitingForMe = (drafts) => (drafts || []).filter((d) =>
  d.state === "PENDING_REVIEW" && d.createdByMemberId !== org.memberId && roleCan(org.role, "approve"));

export async function refreshSide() {
  const id = org?.id;
  if (!id) return;
  const [a, d] = await Promise.allSettled([
    api(`/api/orgs/${id}/accounts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${id}/drafts`) : Promise.resolve({ drafts: [] }),
  ]);
  if (org?.id !== id) return;
  if (side.orgId !== id) { side.accounts = null; side.drafts = null; side.orgId = id; }
  if (a.status === "fulfilled") side.accounts = a.value.accounts;
  if (d.status === "fulfilled") side.drafts = d.value.drafts;
  renderNav();
}

function link(it, active) {
  const here = it.id === active;
  const verdict = it.capability ? cap(it.capability) : { allowed: true };
  const locked = it.capability && !verdict.allowed;
  const href = it.href || `?view=${encodeURIComponent(it.id)}`;
  return `<a class="z-side__link" href="${esc(href)}"${it.href ? "" : ` data-view="${esc(it.id)}"`}${here ? ' aria-current="page"' : ""}>${Z.icon(it.icon)}<span>${esc(it.label)}</span>`
    + `${it.badge ? `<span class="z-side__badge"><span class="z-sr">, </span>${esc(it.badge)}<span class="z-sr"> waiting for you</span></span>` : ""}`
    + `${locked ? `${Z.icon("lock", "z-side__out")}<span class="z-sr"> (not in your plan)</span>` : ""}`
    + `${it.out ? `${Z.icon("open_in_new", "z-side__out")}<span class="z-sr"> (the app)</span>` : ""}</a>`;
}

/* The sidebar's balance column: only the account that spends from YOUR
   account shows a figure, and it is your account's. There is no company
   balance in the API. */
function accountRight(a) {
  if (a.status !== "active") return a.status === "gated" ? "Not open" : "Waiting";
  if (a.backingUserId && me && a.backingUserId === me.id && typeof me.balanceEur === "number") return eur(me.balanceEur);
  const iban = a.identifier?.iban;
  return iban ? `•••• ${String(iban).replace(/\s+/g, "").slice(-4)}` : "";
}

export function renderNav() {
  if (!org) return;
  const active = PARENT[view] || view;
  // No Books item this org can open: no switch, Banking alone.
  const hasBooks = SPACES.books.some((v) => v.capability && shown(v));
  const space = hasBooks ? spaceOf(view) : "banking";
  const waiting = waitingForMe(side.drafts).length;
  const items = SPACES[space].filter(shown).map((v) => ({
    ...v,
    label: v.id === "payments" && !cap("transfers.approvals").allowed ? "Payments" : v.label,
    badge: v.id === "payments" && waiting ? String(waiting) : "",
  }));
  $("#nav").innerHTML = items.map((it) => link(it, active)).join("");
  $("#nav").setAttribute("aria-label", space === "books" ? "Books" : "Main");
  $("#side-space").innerHTML = hasBooks
    ? [["banking", "Banking", "account_balance_wallet"], ["books", "Books", "menu_book"]].map(([id, label, icon]) =>
      `<a class="zb-space__btn" href="?view=${SPACE_HOME[id]}" data-view="${SPACE_HOME[id]}"${space === id ? ' aria-current="page"' : ""}>${Z.icon(icon)}${label}</a>`).join("")
    : "";
  $("#side-space").hidden = !hasBooks;

  const who = org.type === "personal" ? "Personal" : `Business · ${(ROLE_WORD[org.role] || org.role || "").toLowerCase()}`;
  const card = `${Z.avatar({ name: org.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(org.name)}</span><span class="z-row__sub">${esc(who)}</span></span>`;
  $("#side-org").innerHTML = `<button type="button" class="z-side__org" id="org-btn" aria-haspopup="dialog" aria-label="Switch organisation. Current: ${esc(org.name)}">${card}${Z.icon("unfold_more", "z-row__chev")}</button>`;

  const accts = side.accounts;
  $("#side-accounts").innerHTML = space === "banking" && accts && accts.length
    ? `<section class="zb-accts" aria-labelledby="side-acc-h"><h2 class="z-eyebrow" id="side-acc-h">Accounts</h2>${accts.map((a) =>
      `<a class="zb-acct" href="?view=accounts" data-view="accounts"${view === "accounts" ? ' aria-current="page"' : ""}>${Z.icon("account_balance_wallet")}<span>${esc(a.label || a.currency)}</span><span class="zb-acct__right">${esc(accountRight(a))}</span></a>`).join("")}</section>`
    : "";
  $("#side-foot").innerHTML = `${space === "banking" ? link({ id: "soon", icon: "hourglass_top", label: "Coming soon" }, active) : ""}
    ${link({ id: "settings", icon: "settings", label: "Settings" }, active)}
    <div id="side-test"></div>`;
  if (testMode !== undefined) $("#side-test").innerHTML = Z.testModePill(testMode);

  // A real link, so a modifier-click or middle-click opens the view in a new
  // tab (boot reads ?view=). A plain click stays in the page.
  document.querySelectorAll("#side a[data-view]").forEach((a) => {
    a.onclick = (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setView(a.dataset.view);
      render({ focus: true });
    };
  });
  $("#org-btn").onclick = () => switchSheet($("#org-btn"));
}

/** Pick an organisation: here, in place. The personal app is one link away,
 *  except for a company signup: its login's Safe is the company's, so the app
 *  would show the company's money under "personal". */
function switchSheet(trigger) {
  document.getElementById("org-switch")?.remove();
  const row = (o) => {
    const here = o.id === org.id;
    const sub = o.type === "personal" ? "Personal · books and invoices" : `Business · ${(ROLE_WORD[o.role] || o.role || "").toLowerCase()}`;
    return `<li><button type="button" class="z-row z-row--btn" data-org="${esc(o.id)}"${here ? ' aria-current="true"' : ""}>${Z.avatar({ name: o.name, tone: here ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(o.name)}</span><span class="z-row__sub">${esc(sub)}</span></span>${here ? `<span class="z-row__right">${Z.icon("check")}<span class="z-sr">(current)</span></span>` : ""}</button></li>`;
  };
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "org-switch", title: "Switch organisation",
    body: `<div class="z-sheet__body"><ul class="z-list z-card">${orgs.map(row).join("")}${needsPersonalOrg()
      ? `<li><button type="button" class="z-row z-row--btn" data-act="create-personal">${Z.iconTile({ icon: "add" })}<span class="z-row__main"><span class="z-row__title">Create your personal space</span><span class="z-row__sub">Your own invoices and books</span></span></button></li>` : ""}</ul>
      ${me?.accountType === "company" ? "" : `<ul class="z-list z-card"><li>${Z.row({ lead: Z.iconTile({ icon: "smartphone" }), title: "Your personal account", sub: "Home, send and get paid, in the app", href: "/app", right: Z.icon("open_in_new", "z-row__chev") })}</li></ul>`}</div>`,
  }));
  const scrim = $("#org-switch");
  scrim.querySelectorAll("[data-org]").forEach((b) => {
    b.onclick = async () => {
      Z.closeOverlay("org-switch");
      if (b.dataset.org === org.id) return;
      await loadOrg(b.dataset.org);
      setView("overview");
      render({ focus: true });
    };
  });
  Z.openOverlay("org-switch", trigger);
}

/* A person without a personal space is asked until they make one or say not now. */
function personalBanner() {
  if (!needsPersonalOrg() || personalLater()) return "";
  return `<div class="banner info">${Z.icon("person")}<span>Your own invoices and books go in a <b>personal space</b>, next to the companies you work in.</span>
    <button class="z-btn z-btn--primary z-btn--sm" data-act="create-personal">Create it</button>
    <button class="z-btn z-btn--quiet z-btn--sm" data-act="personal-later">Not now</button></div>`;
}

export function planBanner() {
  if (!org) return "";
  return personalBanner() + planNotice();
}

function planNotice() {
  const t = org.trial;
  if (t && !t.endedAt && new Date(t.endsAt) > new Date()) {
    const days = Math.ceil((new Date(t.endsAt) - new Date()) / 86400000);
    return `<div class="banner info">${Z.icon("hourglass_top")}<span>Trial of <b>${esc(t.grantsPlan)}</b>: ${days} day${days === 1 ? "" : "s"} left.
      When it ends you go back to ${esc(org.plan)}. Nothing is deleted.</span></div>`;
  }
  if (org.plan === "starter" && org.type !== "personal") {
    return `<div class="banner warn">${Z.icon("info")}<span>You’re on <b>Starter</b>: payouts, contacts and history.
      ${org.trial ? "Your trial has been used." : "One 30-day trial is available."}</span>
      ${org.trial || org.role !== "owner" ? "" : `<button class="z-btn z-btn--secondary z-btn--sm" data-act="trial">Start trial</button>`}</div>`;
  }
  return "";
}
