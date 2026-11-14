/**
 * The sidebar, the account menu and the banner row.
 *
 * One list: Home, Transactions, Approvals, Invoices, Contacts, Books, Members,
 * Apps, then the ACCOUNTS list, Coming soon and Settings. Books opens its own
 * screens beneath it while one of them is shown. New payment sits above the
 * list; Send and Get paid are the phone's tabs and are found by Search.
 * The older views keep their ?view= ids and sit under one of these (PARENT):
 * the ledger and assets under Statement, Shopify under Apps.
 */
import { $, Z, api, cap, esc, eur, me, mayActOnInvoice, needsPersonalOrg, org, orgs, personalLater, recoveryNone, recoveryPending, recoveryUnknown, reviewOn, roleCan, ROLE_WORD, setView, signOut, testMode, toast, view } from "./core.js";
import { loadOrg, render } from "./shell.js";
import { isOwnCompanyOrg } from "./access-model.js";

const BOOKS = [
  { id: "books-overview", label: "Overview", icon: "monitoring", capability: "ledger.transactions" },
  { id: "books", label: "Statement", icon: "list_alt", capability: "ledger.transactions" },
  { id: "wallets", label: "Wallets", icon: "wallet", capability: "wallets.manage" },
  { id: "coa", label: "Categories", icon: "category", capability: "coa.manage" },
  { id: "export", label: "Export", icon: "download", capability: "export.ledger" },
  { id: "documents", label: "Statements and documents", icon: "description" },
  { id: "integrations", label: "Connections", icon: "cable" },
];
const MAIN = [
  { id: "overview", label: "Home", icon: "home" },
  { id: "transactions", label: "Transactions", icon: "swap_vert", capability: "ledger.transactions" },
  { id: "payments", label: "Approvals", icon: "inbox", capability: "transfers.drafts" },
  { id: "invoices", label: "Invoices", icon: "receipt_long", capability: "invoices" },
  { id: "contacts", label: "Contacts", icon: "contacts" },
  { id: "books-overview", label: "Books", icon: "menu_book", capability: "ledger.transactions", books: true },
  { id: "members", label: "Members", icon: "group", capability: "members.manage" },
  { id: "apps", label: "Apps", icon: "apps" },
];
const SEND = { id: "send", label: "Send", icon: "arrow_outward", capability: "transfers.drafts" };
const GET_PAID = { id: "get-paid", label: "Get paid", icon: "south_west" };
/** Every screen with a name, for Search. */
export const VIEWS = [...MAIN, SEND, GET_PAID, ...BOOKS];

/** The phone's tab bar, the same on every screen; the rest is in Menu. */
const TABS = [MAIN[0], MAIN[2], SEND, GET_PAID];

/* Under 1024px the sidebar is a top bar, and Menu opens the rest of it as a
   full-screen panel. Opening it is a history entry, so Back closes it, as do
   Menu again, Escape, the organisation, Search and the screen already shown
   (all go back). Picking another screen closes it in place (`viaHistory:
   false`) and returns true while the Menu's entry is still on top, for the
   new view to take that entry over. The page behind it is inert. */
export function setMenu(open, { viaHistory = true } = {}) {
  const shell = document.querySelector(".zb");
  const btn = $("#menu-btn");
  if (!shell || !btn) return false;
  const was = shell.classList.contains("is-menu");
  if (!open && was && viaHistory && history.state?.zbMenu) { history.back(); return false; }  // popstate closes it
  shell.classList.toggle("is-menu", open);
  for (const id of ["#main", "#tabs"]) { const el = $(id); if (el) el.inert = open; }
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
  btn.querySelector(".z-ic").textContent = open ? "close" : "menu";
  if (open && !was) {
    history.pushState({ ...(history.state || {}), zbMenu: true }, "");
    // The first control drawn: New payment is in the tab bar here, not the panel.
    [...$("#side-menu").querySelectorAll("a, button")].find((el) => el.getClientRects().length)?.focus();
  }
  if (!open && was && (!document.activeElement || document.activeElement === document.body || $("#side-menu").contains(document.activeElement))) btn.focus();
  return !open && was && Boolean(history.state?.zbMenu);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".zb.is-menu")) setMenu(false);
});
// Search opens its own dialog over the page; the panel gets out of its way.
document.addEventListener("click", (e) => { if (e.target.closest?.("#search-btn")) setMenu(false); });
// From 1024px the panel is the sidebar again and Menu is hidden: an open Menu
// would leave the page inert with nothing on screen to close it.
matchMedia("(min-width: 1024px)").addEventListener("change", (e) => {
  if (e.matches && document.querySelector(".zb.is-menu")) setMenu(false);
});

/** Which nav item an older view belongs to. */
const PARENT = {
  ledger: "books", assets: "books", gains: "books",
  shopify: "apps", "invoice-new": "invoices", "invoicing-settings": "settings", organisation: "settings", access: "settings", accounts: "accounts", payment: "payments",
};
/** Every view id the router accepts, including those without a nav item. */
export const KNOWN = new Set([...VIEWS.map((v) => v.id), ...Object.keys(PARENT), "settings", "soon"]);

/* An unbuilt feature keeps its entry; a feature this kind of org can never
   have (a business-only entry in a personal org) leaves it out. */
export function shown(v) {
  const verdict = v.capability ? cap(v.capability) : { allowed: true };
  return !v.capability || verdict.allowed || verdict.unavailable;
}

/* What the sidebar shows beside the nav: the org's accounts, and how many
   payment runs wait for this person. Read after each render, drawn from
   here; a failed read leaves the last one. */
export const side = { orgId: null, accounts: null, drafts: null, invoices: null };

/** Supplier invoices submitted through a link and not yet paid or under way,
 *  that this member can act on; none they could only look at. */
export const submittedInvoices = (invoices) => (invoices || [])
  .filter((i) => i.direction !== "outgoing" && i.state === "SUBMITTED" && mayActOnInvoice(i));

/** Waiting for this person: drafted by someone else, and their role approves. */
export const waitingForMe = (drafts) => (drafts || []).filter((d) =>
  d.state === "PENDING_REVIEW" && d.createdByMemberId !== org.memberId && roleCan(org.role, "approve"));

export async function refreshSide() {
  const id = org?.id;
  if (!id) return;
  const [a, d, i] = await Promise.allSettled([
    api(`/api/orgs/${id}/accounts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${id}/drafts`) : Promise.resolve({ drafts: [] }),
    // shortcut: the whole list for one count, fine at hundreds of invoices; add a count endpoint when orgs reach thousands.
    cap("invoices").allowed ? api(`/api/orgs/${id}/invoices`) : Promise.resolve({ invoices: [] }),
  ]);
  if (org?.id !== id) return;
  if (side.orgId !== id) { side.accounts = null; side.drafts = null; side.invoices = null; side.orgId = id; }
  if (a.status === "fulfilled") side.accounts = a.value.accounts;
  if (d.status === "fulfilled") side.drafts = d.value.drafts;
  if (i.status === "fulfilled") side.invoices = i.value.invoices;
  renderNav();
}

function link(it, active) {
  const here = it.id === active;
  const verdict = it.capability ? cap(it.capability) : { allowed: true };
  const locked = it.capability && !verdict.allowed;
  const href = it.href || `?view=${encodeURIComponent(it.id)}`;
  return `<a class="z-side__link" href="${esc(href)}"${it.href ? "" : ` data-view="${esc(it.id)}"`}${here ? ' aria-current="page"' : ""}>${Z.icon(it.icon)}<span>${esc(it.label)}</span>`
    + `${it.badge ? `<span class="z-side__badge"><span class="z-sr">, </span>${esc(it.badge)}<span class="z-sr"> waiting for you</span></span>` : ""}`
    + `${locked ? `${Z.icon("lock", "z-side__out")}<span class="z-sr"> (not available)</span>` : ""}`
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

/* Only a changed trigger is redrawn, so an open menu keeps the button that
   focus returns to and its aria-expanded. */
function paint(el, html) {
  if (!el || el.dataset.sig === html) return;
  el.dataset.sig = html;
  el.innerHTML = html;
}

export function renderNav() {
  if (!org) return;
  const active = PARENT[view] || view;
  const waiting = waitingForMe(side.drafts).length;
  const submitted = submittedInvoices(side.invoices).length;
  const named = (v) => ({
    ...v,
    label: v.id === "payments" && !reviewOn() ? "Payments" : v.label,
    badge: v.id === "payments" && waiting ? String(waiting) : v.id === "invoices" && submitted ? String(submitted) : "",
  });
  // Books opens the first of its screens this org has; while one is shown, all of them sit beneath it.
  const books = BOOKS.filter(shown);
  const inBooks = books.some((v) => v.id === active);
  $("#nav").innerHTML = MAIN.map((v) => {
    if (!v.books) return shown(v) ? link(named(v), active) : "";
    if (!books.length) return "";
    const head = link({ ...v, id: books[0].id, capability: books[0].capability }, "");
    return inBooks ? `${head}<div class="zb-side__sub" role="group" aria-label="Books">${books.map((b) => link(b, active)).join("")}</div>` : head;
  }).join("");

  const sendLocked = !cap(SEND.capability).allowed;
  $("#side-new").innerHTML = shown(SEND)
    ? `<a class="z-btn z-btn--primary zb-newpay" href="?view=send" data-view="send"${view === "send" ? ' aria-current="page"' : ""}>${Z.icon("add")}<span>New payment</span>${sendLocked ? `${Z.icon("lock")}<span class="z-sr"> (not available)</span>` : ""}</a>`
    : "";

  const tabs = TABS.filter(shown).map(named);
  $("#tabs").innerHTML = `<nav class="z-bnav zb-tabs" aria-label="Quick" style="grid-template-columns:repeat(${tabs.length + 1},1fr)">${tabs.map((it) =>
    `<a href="?view=${esc(it.id)}" data-view="${esc(it.id)}"${it.id === active ? ' aria-current="page"' : ""}>${Z.icon(it.icon)}<span>${esc(it.label)}</span>`
    + `${it.capability && !cap(it.capability).allowed ? `${Z.icon("lock", "zb-tabs__lock")}<span class="z-sr"> (not available)</span>` : ""}`
    + `${it.badge ? `<span class="z-bnav__badge"><span class="z-sr">, </span>${esc(it.badge)}<span class="z-sr"> waiting for you</span></span>` : ""}</a>`).join("")}
    <button type="button" class="z-bnav__btn" data-menu${tabs.some((it) => it.id === active) ? "" : ' aria-current="page"'}>${Z.icon("menu")}<span>Menu</span></button></nav>`;

  // The phone's top bar: the organisation. From 1024px the account chip above the page instead.
  const who = org.type === "personal" ? "Personal" : `Business · ${(ROLE_WORD[org.role] || org.role || "").toLowerCase()}`;
  const card = `${Z.avatar({ name: org.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(org.name)}</span><span class="z-row__sub">${esc(who)}</span></span>`;
  paint($("#side-org"), `<button type="button" class="z-side__org" id="org-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Account and organisations. Current: ${esc(org.name)}">${card}${Z.icon("unfold_more", "z-row__chev")}</button>`);
  paint($("#acct"), `<button type="button" class="zb-chip-acct" id="acct-btn" aria-haspopup="dialog" aria-expanded="false"><span class="zb-chip-acct__main"><span class="zb-chip-acct__kind">${org.type === "personal" ? "Personal" : "Business"}</span><span class="zb-chip-acct__name">${esc(org.name)}</span></span>${Z.icon("expand_more")}</button>`);

  const accts = side.accounts;
  $("#side-accounts").innerHTML = accts && accts.length
    ? `<section class="zb-accts" aria-labelledby="side-acc-h"><h2 class="z-eyebrow" id="side-acc-h">Accounts</h2>${accts.map((a) =>
      `<a class="zb-acct" href="?view=accounts" data-view="accounts"${view === "accounts" ? ' aria-current="page"' : ""}>${Z.icon("account_balance_wallet")}<span>${esc(a.label || a.currency)}</span><span class="zb-acct__right">${esc(accountRight(a))}</span></a>`).join("")}</section>`
    : "";
  // Sign out shows here under 1024px only, as the Menu's last row; from 1024px it is in the account menu.
  $("#side-foot").innerHTML = `${link({ id: "soon", icon: "hourglass_top", label: "Coming soon" }, active)}
    ${link({ id: "settings", icon: "settings", label: "Settings" }, active)}
    <div id="side-test"></div>
    <button type="button" class="z-side__link zb-signout" id="side-signout">${Z.icon("logout")}<span>Sign out</span></button>`;
  if (testMode !== undefined) $("#side-test").innerHTML = Z.testModePill(testMode);

  // A real link, so a modifier-click or middle-click opens the view in a new
  // tab (boot reads ?view=). A plain click stays in the page.
  document.querySelectorAll("#side a[data-view], #tabs a[data-view]").forEach((a) => {
    a.onclick = (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      // The screen already shown: only the Menu closes, and its entry goes.
      if (a.dataset.view === view && document.querySelector(".zb.is-menu")) { setMenu(false); return; }
      setView(a.dataset.view, { replace: setMenu(false, { viaHistory: false }) });
      render({ focus: true });
    };
  });
  $("#org-btn").onclick = () => { setMenu(false); accountSheet($("#org-btn")); };
  // #app, which holds the chip, leaves the page when start-up ends on an error screen.
  const chip = $("#acct-btn");
  if (chip) chip.onclick = () => accountSheet(chip);
  $("#side-signout").onclick = signOut;
  $("#menu-btn").onclick = () => setMenu(!document.querySelector(".zb.is-menu"));
  $("#tabs [data-menu]").onclick = () => setMenu(true);
}

/** The account menu: who is signed in, the organisations to switch between
 *  (here, in place), the personal app, Settings, and Sign out last. The
 *  personal app is one link away, except for a company signup: its login's
 *  Safe is the company's, so the app would show the company's money under
 *  "personal". */
function accountSheet(trigger) {
  document.getElementById("acct-menu")?.remove();
  const row = (o) => {
    const here = o.id === org.id;
    const sub = o.type === "personal" ? "Personal · books and invoices" : `Business · ${(ROLE_WORD[o.role] || o.role || "").toLowerCase()}`;
    return `<li><button type="button" class="z-row z-row--btn" data-org="${esc(o.id)}"${here ? ' aria-current="true"' : ""}>${Z.avatar({ name: o.name, tone: here ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(o.name)}</span><span class="z-row__sub">${esc(sub)}</span></span>${here ? `<span class="z-row__right">${Z.icon("check")}<span class="z-sr">(current)</span></span>` : ""}</button></li>`;
  };
  const person = me && (me.name || me.email)
    ? `<ul class="z-list z-card"><li>${Z.row({ lead: Z.avatar({ name: me.name || me.email, tone: "n" }), title: me.name || me.email, sub: me.name ? me.email : "" })}</li></ul>`
    : "";
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "acct-menu", title: "Your account",
    body: `<div class="z-sheet__body">${person}<ul class="z-list z-card" aria-label="Organisations">${orgs.map(row).join("")}${needsPersonalOrg()
      ? `<li><button type="button" class="z-row z-row--btn" data-act="create-personal">${Z.iconTile({ icon: "add" })}<span class="z-row__main"><span class="z-row__title">Set up your personal space</span><span class="z-row__sub">Your own invoices and books</span></span></button></li>` : ""}</ul>
      ${me?.accountType === "company" ? "" : `<ul class="z-list z-card"><li>${Z.row({ lead: Z.iconTile({ icon: "smartphone" }), title: "Your personal account", sub: "Home, send and get paid, in the app", href: "/app", right: Z.icon("open_in_new", "z-row__chev") })}</li></ul>`}
      <ul class="z-list z-card"><li><a class="z-row" href="?view=settings" data-view-link="settings">${Z.iconTile({ icon: "settings" })}<span class="z-row__main"><span class="z-row__title">Settings</span></span>${Z.icon("chevron_right", "z-row__chev")}</a></li>
      <li><button type="button" class="z-row z-row--btn" id="acct-signout">${Z.iconTile({ icon: "logout" })}<span class="z-row__main"><span class="z-row__title">Sign out</span></span></button></li></ul></div>`,
  }));
  const scrim = $("#acct-menu");
  scrim.querySelectorAll("[data-org]").forEach((b) => {
    b.onclick = async () => {
      Z.closeOverlay("acct-menu");
      if (b.dataset.org === org.id) return;
      try {
        await loadOrg(b.dataset.org);
      } catch (e) { toast(e.message, true); return; }
      setView("overview");
      render({ focus: true });
    };
  });
  $("#acct-signout").onclick = signOut;
  // The trigger says whether its menu is open; Z.closeOverlay takes is-open off on every way out.
  trigger.setAttribute("aria-expanded", "true");
  new MutationObserver((_, obs) => {
    if (scrim.classList.contains("is-open")) return;
    trigger.setAttribute("aria-expanded", "false");
    obs.disconnect();
  }).observe(scrim, { attributes: true, attributeFilter: ["class"] });
  Z.openOverlay("acct-menu", trigger);
}

/* A person without a personal space is asked, on Home, until they make one or say not now. */
function personalBanner() {
  if (view !== "overview" || !needsPersonalOrg() || personalLater()) return "";
  return `<div class="banner info">${Z.icon("person")}<span>Your own invoices and books go in a <b>personal space</b>, next to the companies you work in.</span>
    <button class="z-btn z-btn--secondary z-btn--sm" data-act="create-personal">Set it up</button>
    <button class="z-btn z-btn--quiet z-btn--sm" data-act="personal-later">Not now</button></div>`;
}

/* The app holds the recovery screens; this says one is under way and goes
   there. A company login with no guardian is pointed at Access. */
function recoveryBanner() {
  // Only in the company this login is: elsewhere its Safe is not the
  // organisation's account. Access says all of this in its own card.
  const own = side.orgId === org?.id && isOwnCompanyOrg(me, org, side.accounts);
  // A recovery under way, or a check that failed, shows on every view,
  // Access included: its card is read once per visit, the banner every
  // minute (shell.js watchRecovery).
  if (recoveryUnknown) {
    return `<div class="banner warn" role="note">${Z.icon("help")}<span><b>We couldn’t check for a recovery on your sign-in.</b> Check it in the app, so a recovery you did not start cannot replace your sign-in unseen.</span>
    <a class="z-btn z-btn--secondary z-btn--sm" href="/app?from=business#recovery-alert">Check now</a></div>`;
  }
  if (recoveryNone && own && view !== "access") {
    return `<div class="banner warn">${Z.icon("warning")}<span><b>No one can recover this company’s account.</b> If this sign-in’s key is lost, Zoldenburg UG cannot recover it.</span>
    <a class="z-btn z-btn--secondary z-btn--sm" href="?view=access" data-view-link="access">Access</a></div>`;
  }
  if (!recoveryPending) return "";
  return `<div class="banner warn" role="note">${Z.icon("warning")}<span><b>A recovery is under way on your sign-in.</b> If you did not start it, stop it now: it would replace your sign-in.</span>
    <a class="z-btn z-btn--primary z-btn--sm" href="/app?from=business#recovery-alert">Check it</a></div>`;
}

export function planBanner() {
  if (!org) return "";
  return recoveryBanner() + personalBanner();
}
