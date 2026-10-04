/**
 * The phone app from design/ui-v2 (build steps 4 and 5): Home, account
 * details, Activity, one payment, Send, Add money, Get paid, Contacts, More,
 * main currency and converting digital dollars to euros. Invoices and
 * accounting connections (step 6) are in app/invoices.js; the company screens
 * and Settings (step 7) are in app/business.js and app/settings.js, loaded
 * after it.
 *
 * The phone acts for one account at a time: the personal account, or a
 * company the user is a member of (`phCompanyId`, chosen in More). A company
 * gets its own Home and an Approvals tab; its money moves in the web app.
 *
 * One screen at a time, rendered into #ph-root from the account's real state.
 * The URL hash names the screen (#home, #tx/<id>, #send/amount, …), so back,
 * reload and a shared link land where they should. Screens not redesigned yet
 * (recovery, documents, signers, Monerium keys, the card) are the older
 * #dashboard screens; their routes open them through mobileNav() and hide
 * this root.
 *
 * This file holds the router and the shared pieces; the screens are in the
 * files loaded right after it: phone-home.js (Home, recovery alert, account
 * details), phone-activity.js, phone-send.js, phone-add.js (Add money, main
 * currency, digital dollars to euros), phone-getpaid.js and phone-more.js
 * (Contacts, More).
 *
 * Declarations and listeners only. It is called from renderUser() and
 * renderHistory() at run time, and started by enterDashboard(); nothing here
 * runs at load. app/main.js stays last.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - Every figure is read from the API. A row the API has not confirmed is not
 *   ticked, and a status tag follows the transfer's own state.
 * - A payment is PAID only when the transfer says PAID. There is no separate
 *   "arriving" state in the API, so the progress screen does not draw one.
 * - Bank sends, payment links and digital-dollar deposits have never moved
 *   real money end to end: they carry a Beta tag. Sending to a crypto wallet
 *   and USD accounts are not built: Soon, not pressable.
 */

/* ==========================================================================
   Routing
   ========================================================================== */

let phRoute = null;            // { name, arg }
let phSig = "";                // what the open screen was drawn from, for the poll
const phCache = { deposits: null, links: null, methods: null, orgs: null, contacts: null, bic: undefined, bicFor: "", currencyPending: null,
  invoices: null, invProfile: null, invError: null, integrations: null, invIssued: null, invRequest: null,
  co: null, approvalsWaiting: 0, inviteLinks: {}, plans: {}, signers: undefined, soon: null, walletQr: null };

/* The company the phone acts for, or null for the personal account. Kept per
   user on this device, and dropped when the user is no longer a member. */
let phCompanyId = null;
const phCompanyKey = () => `zold-phone-company:${user?.id || ""}`;
const phCompany = () => (phCompanyId ? (phCache.orgs || []).find((o) => o.id === phCompanyId && o.type !== "personal") || null : null);
function phUseCompany(id) {
  phCompanyId = id || null;
  phCache.co = null; phCache.approvalsWaiting = 0; phCache.inviteLinks = {};
  try { if (phCompanyId) localStorage.setItem(phCompanyKey(), phCompanyId); else localStorage.removeItem(phCompanyKey()); } catch { /* this visit only */ }
}
/* A link into the web app for a company: the web app opens the organisation
   it last had, so the link names it first (see the click listener below). */
const phWebHref = (view) => `/business${view ? `?view=${encodeURIComponent(view)}` : ""}`;

/* Screens drawn here. `tab` lights the bottom nav (tab roots only show it),
   `live` returns what the screen depends on, so the 5-second poll redraws it
   only when that changed. */
const PH = {};

/* The desktop layout (app/desktop.js, from 1024px): `on()` says whether it
   applies, `side(route)` draws the sidebar, and a screen's `desk` ({ html,
   bind, live, wide, refresh }) replaces its phone layout there: `wide`
   gives it the full width, `refresh` updates its open drawer in place. Filled in by that later
   file; empty, every width gets the phone column. */
const PH_DESK = { on: () => false, side: null };
/* The layout the open screen is drawn in: its desktop one, when it has one. */
const phView = (s) => (s.desk && PH_DESK.on() ? s.desk : s);

/* Routes that open an older screen in #dashboard. */
const PH_LEGACY = {
  plus: "plus", bundle: "bundle", card: "card", documents: "documents",
  signers: "signers", "monerium-settings": "monerium", "recovery-settings": "recovery", "page-settings": "payment",
};

/* What the older screens' back buttons and links name, mapped here. */
const PH_FROM_LEGACY = {
  home: "home", add: "add", bank: "account-details", crypto: "add/wallet", send: "send", pay: "send",
  activity: "activity", detail: "activity", links: "get-paid", payment: "get-paid/page", profile: "settings", more: "more",
};

function phParse(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const [path] = h.split("?");
  const parts = path.split("/");
  // Two-part names first: send/amount, add/wallet, get-paid/page …
  const two = `${parts[0]}/${parts[1] || ""}`;
  if (parts[1] && PH[two]) return { name: two, arg: parts.slice(2).join("/") || null };
  if (PH[parts[0]] || PH_LEGACY[parts[0]]) return { name: parts[0], arg: parts.slice(1).join("/") || null };
  return null;
}

const phHref = (name, arg) => `#${name}${arg ? `/${encodeURIComponent(arg)}` : ""}`;

/** Go to a screen. Pushes history so the browser's back button works. */
function phGo(name, arg = null, { replace = false } = {}) {
  const url = `${location.pathname}${location.search}${phHref(name, arg)}`;
  const state = { ph: true };
  if (replace || !phRoute) history.replaceState(state, "", url); else history.pushState(state, "", url);
  phOpen(phParse(phHref(name, arg)) || { name: "home", arg: null }, { focus: true });
}

/** Back from an older screen: to where the user came from when we know it. */
function phBack(legacyTarget) {
  if (history.state?.ph && history.length > 1) return history.back();
  phGo(PH_FROM_LEGACY[legacyTarget] || "home");
}

/* The app is on screen: #dashboard is shown only for the older screens. */
function phShowRoot(on) {
  $("phone").hidden = !on;
  $("dashboard").style.display = on ? "none" : "grid";
}

function phOpen(route, { focus = false } = {}) {
  // Acting for a company, Home is the company's.
  if (route.name === "home" && phCompanyId && PH.company) {
    route = { name: "company", arg: null };
    history.replaceState({ ph: true }, "", `${location.pathname}${location.search}#company`);
  }
  phRoute = route;
  // Out to one of the app's own tabs: the trip from /business is over.
  if (PH[route.name]?.tab) phSetFromBusiness(false);
  if (PH_LEGACY[route.name]) {
    phShowRoot(false);
    phSig = "";
    window.scrollTo(0, 0);
    // The share composer needs its payment; the others open by name.
    document.title = `${{ plus: "Zold Plus", bundle: "Zold Plus", card: "Card", documents: "Documents", signers: "Who approves payments", "monerium-settings": "Monerium", "recovery-settings": "Recovery", "page-settings": "Your page", share: "Share receipt" }[route.name] || "Zold"} · Zold`;
    if (route.name === "share") return route.arg ? openShare(route.arg) : phGo("activity", null, { replace: true });
    mobileNavLegacy(PH_LEGACY[route.name]);
    return;
  }
  phShowRoot(true);
  phRender({ focus });
}

/* Draw the open screen. The overlay a route names (account details, a
   contact) opens after the screen under it is drawn. */
function phRender({ focus = false } = {}) {
  const r = phRoute;
  if (!r || !PH[r.name]) return;
  const s = PH[r.name];
  const root = $("ph-root");
  // Overlays are moved to <body> when they open; drop the old ones first,
  // closing an open one so the page behind it is no longer inert.
  document.querySelectorAll("body > .z-scrim[data-ph]").forEach((el) => { if (!el.hidden) Z.closeOverlay(el.id); el.remove(); });
  // A company has no activity list of its own here; its tab is Approvals.
  const co = !!phCompanyId;
  const nav = s.tab
    ? Z.bottomNav({
      active: s.tab,
      items: [
        { id: "home", href: co ? "#company" : "#home", icon: "home", label: "Home" },
        { id: "send", href: co ? "#company/send" : "#send", icon: "arrow_outward", label: "Send" },
        { id: "get-paid", href: co ? "#company/get-paid" : "#get-paid", icon: "south_west", label: "Get paid" },
        co ? { id: "approvals", href: "#approvals", icon: "inbox", label: "Approvals", badge: phCache.approvalsWaiting || "" }
          : { id: "activity", href: "#activity", icon: "swap_vert", label: "Activity" },
        { id: "more", href: "#more", icon: "person", label: "Profile" },
      ],
    })
    : "";
  const v = phView(s);
  const side = PH_DESK.side ? PH_DESK.side(r) : "";
  root.innerHTML = `${Z.skipLink("main")}${side}<div class="z-app${v.wide ? " z-app--desk" : ""}" data-screen="${esc(r.name)}">${Z.testModePill(!realMoney)}${v.html(r.arg)}</div>${nav}`;
  document.title = `${typeof s.title === "function" ? s.title(r.arg) : s.title} · Zold`;
  phSig = v.live ? v.live(r.arg) : "";
  v.bind?.(root, r.arg);
  if (focus) {
    window.scrollTo(0, 0);
    root.querySelector("h1")?.setAttribute("tabindex", "-1");
    root.querySelector("h1")?.focus({ preventScroll: true });
  }
}

/* The poll redraws the open screen only when its data changed, and never
   while someone is typing in it or has a sheet open over it. */
function phRefresh() {
  if (!phRoute || !PH[phRoute.name] || $("phone")?.hidden) return;
  const s = phView(PH[phRoute.name]);
  if (!s.live) return;
  const sig = s.live(phRoute.arg);
  if (sig === phSig) return;
  const active = document.activeElement;
  if (active && $("ph-root").contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  if (document.querySelector("body > .z-scrim[data-ph]:not([hidden])")) {
    if (s.refresh) { phSig = sig; s.refresh(phRoute.arg); }
    return;
  }
  phRender();
}

window.addEventListener("popstate", () => {
  if (obScreen || !phRoute) return;        // onboarding owns the hash while it is open
  const r = phParse(location.hash);
  // Back past the first app screen lands on an onboarding step the account
  // has finished: stay on Home instead.
  if (r) phOpen(r, { focus: true }); else phGo("home", null, { replace: true });
});

/* Links inside the app that name a screen go through the router. */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('#ph-root a[href^="#"], body > .z-scrim[data-ph] a[href^="#"]');
  if (!a || a.classList.contains("z-skip")) return;
  const r = phParse(a.getAttribute("href"));
  if (!r) return;
  e.preventDefault();
  // A link out of an open sheet closes the sheet first.
  document.querySelectorAll("body > .z-scrim[data-ph]:not([hidden])").forEach((el) => Z.closeOverlay(el.id));
  phGo(r.name, r.arg);
});

/* A link into the web app for a company names that company first. */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-ph-org]");
  if (a) try { localStorage.setItem("zold-org", a.dataset.phOrg); } catch { /* the web app opens its last one */ }
});

/** The app's entry: the screen the URL names, or Home. */
function phStart() {
  try { phCompanyId = localStorage.getItem(phCompanyKey()) || null; } catch { phCompanyId = null; }
  phTakeFromBusiness();
  const r = phParse(location.hash);
  const route = r || { name: "home", arg: null };
  history.replaceState({ ph: true }, "", `${location.pathname}${location.search}${phHref(route.name, route.arg)}`);
  phOpen(route, { focus: false });
  // A company login is named after its company, which may need the org read.
  if (user?.accountType === "company" && phCache.orgs === null) {
    phLoadOrgs().then(() => { if (!$("phone")?.hidden) phRender(); });
  }
}

/* ==========================================================================
   Shared pieces
   ========================================================================== */

const phFirst = (name) => String(name || "").trim().split(/\s+/)[0] || "";
const phEur = (n) => Z.formatMoney(n ?? 0, "EUR");
/* The plan check, as the organisation read reports it. */
const phCan = (org, cap) => org?.capabilities?.[cap]?.allowed === true;
const phPersonalOrg = () => (phCache.orgs || []).find((o) => o.type === "personal") || null;
async function phLoadOrgs() {
  if (phCache.orgs !== null) return phCache.orgs;
  try {
    phCache.orgs = (await api("/api/orgs")).organisations || [];
    const owned = user?.accountType === "company" ? phCache.orgs.filter((o) => o.type === "business") : [];
    ownCompanyOrg = owned.find((o) => o.role === "owner") || owned[0] || null;
    // No longer a member: back to the personal account.
    if (phCompanyId && !phCompany()) phUseCompany(null);
  } catch { phCache.orgs = []; }
  return phCache.orgs;
}
/* "26 Sep": day first, and the short month en-GB spells "Sept". */
const phDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).formatToParts(d);
  return `${parts.find((p) => p.type === "day").value} ${parts.find((p) => p.type === "month").value}`;
};
const phWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same
    ? `Today ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d)}`
    : phDay(iso);
};
const phFull = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${phDay(iso)} ${d.getFullYear()}, ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d)}`;
};
/* "PL27 1140 2004 …0001": enough to recognise, short enough for one line. */
const phShortIban = (iban) => {
  const s = String(iban || "").replace(/\s+/g, "");
  return s.length > 16 ? `${Z.groupIban(s.slice(0, 12))} …${s.slice(-4)}` : Z.groupIban(s);
};
const phMaskIban = (iban) => {
  const s = String(iban || "").replace(/\s+/g, "");
  return s.length > 12 ? `${s.slice(0, 4)} ${s.slice(4, 8)} •••• ${s.slice(-4)}` : Z.groupIban(s);
};

/* A pushed screen: top bar with back, then main. */
const phTop = (title, back = "home", right = "") =>
  Z.topbar({ title, back: { href: `#${back}`, label: "Back" }, right });

/* /business links its sign-in and recovery here as /app?from=business#security
   (business/settings.js). Remembered for this tab, so Security's back goes to
   /business, until the person opens one of the app's own tabs. */
let phFromBusiness = false;
function phSetFromBusiness(on) {
  phFromBusiness = on;
  try { if (on) sessionStorage.setItem("zold-from-business", "1"); else sessionStorage.removeItem("zold-from-business"); } catch { /* this screen only */ }
}
function phTakeFromBusiness() {
  const qs = new URLSearchParams(location.search);
  if (qs.get("from") === "business") {
    phSetFromBusiness(true);
    qs.delete("from");
    history.replaceState(history.state, "", `${location.pathname}${qs.size ? `?${qs}` : ""}${location.hash}`);
    return;
  }
  try { phFromBusiness = sessionStorage.getItem("zold-from-business") === "1"; } catch { phFromBusiness = false; }
}
/* Security's top bar: back to /business when that is where the person came from. */
const phSecurityTop = () => (phFromBusiness
  ? Z.topbar({ title: "Security", back: { href: "/business?view=settings", label: "Back to Zold Business" } })
  : phTop("Security", "settings"));

/* The transfer's state, in the status words of SYSTEM.md. */
const PH_LIVE = ["CREATED", "DEBITED", "SWAPPED", "BRIDGED", "PAYOUT_DETAILS_PENDING", "PAYOUT_FUNDING_PENDING",
  "PAYOUT_FUNDED", "PAYOUT_READY", "PAYOUT_SUBMITTED"];
function phTxWord(t) {
  if (t.state === "PAID") return "PAID";
  if (t.state === "REFUNDED") return "REFUNDED";
  if (t.state === "FAILED") return "FAILED";
  if (t.state === "MANUAL_REVIEW") return "IN REVIEW";
  return "IN FLIGHT";
}
/* Signed, and past the point where the user could still walk away. */
const phInFlight = (t) => t.kind !== "funding" && PH_LIVE.includes(t.state) && t.state !== "CREATED";
/* Money that never left (or came back) carries no minus. */
const phOut = (t) => !["FAILED", "REFUNDED"].includes(t.state) && t.state !== "CREATED";

/** One activity row: a transfer out, or money in. */
function phActivityRow(t) {
  if (t.kind === "funding") {
    const usdc = t.token === "USDC";
    const word = t.state === "REFUSED" ? "IN REVIEW" : "RECEIVED";
    return Z.row({
      lead: Z.iconTile({ icon: usdc ? "currency_exchange" : "euro" }),
      title: usdc ? "Digital dollars (USDC)" : "Euros received",
      // Activity lists on-chain deposits only; a bank transfer in shows in the
      // balance, not here (GET /activity has no Monerium issue rows).
      sub: `From a crypto wallet · ${phWhen(t.at || t.detectedAt)}`,
      right: `${usdc
        ? `<span class="z-amount z-amount--in">+${esc(Z.formatMoney(t.amountUsdc || 0, "USDC"))}</span>`
        : Z.amount({ value: t.amountEur || 0, direction: "in" })}${Z.tag(word)}`,
      href: usdc ? "#add/wallet" : undefined,
      chevron: false,
    });
  }
  const cash = t.rail === "cash";
  const sub = [t.reference || (cash ? "Cash pickup" : "Bank transfer"), phInFlight(t) ? "Waiting for the bank" : phWhen(t.createdAt)].join(" · ");
  return Z.row({
    lead: Z.avatar({ name: t.recipientName }),
    title: t.recipientName || "Payment",
    sub,
    right: `${phOut(t) ? Z.amount({ value: t.sendEur, direction: "out" }) : `<span class="z-amount">${esc(phEur(t.sendEur))}</span>`}${Z.tag(phTxWord(t))}`,
    href: phHref("tx", t.id),
    chevron: false,
  });
}

/* The list is loading, failed, or empty: never a blank card. */
function phActivityList(rows, { label, action, empty }) {
  if (!histLoaded && !histLoadFailed) {
    return `<section class="z-group">${label ? `<div class="z-group__head"><h2 class="z-eyebrow">${esc(label)}</h2></div>` : ""}${Z.skeletonRows(3, "Loading your payments…")}</section>`;
  }
  if (histLoadFailed && !hist.length) {
    return `<section class="z-group">${label ? `<div class="z-group__head"><h2 class="z-eyebrow">${esc(label)}</h2></div>` : ""}`
      + `${Z.note({ tone: "a", html: `We couldn’t load your payments. <button type="button" class="z-link-btn z-link-btn--inline" data-ph-retry>Try again</button>` })}</section>`;
  }
  return Z.listGroup({ label, action, rows: rows.map(phActivityRow), empty });
}

function phBindRetry(root) {
  root.querySelectorAll("[data-ph-retry]").forEach((b) => { b.onclick = () => loadTransfers(); });
}

/* A signature of the activity list, for the poll. */
const phHistSig = () => `${histLoaded}|${histLoadFailed}|${hist.map((t) => `${t.id}:${t.state}`).join(",")}`;

/* The screen body, with the one pinned action area when there is one. */
const phMain = (inner, cls = "") => `<main id="main" class="z-app__main${cls ? ` ${cls}` : ""}">${inner}</main>`;
const phFoot = (inner) => `<div class="z-app__foot">${inner}</div>`;

/* Share text, or copy it where the browser has no share sheet. */
/* One text with the link on its own last line. Passed as separate `text` and
   `url`, some share targets glue the text straight onto the link, and the
   pasted link then points at nothing. */
async function phShare(title, text, url) {
  const body = url ? `${text}\n${url}` : text;
  if (navigator.share) {
    try { await navigator.share({ title, text: body }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(body);
    Z.announce("Copied. Paste it where you want to share it.");
  } catch {
    Z.announce("Could not copy. Select the text and copy it yourself.");
  }
}

