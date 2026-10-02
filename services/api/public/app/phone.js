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
        { id: "more", href: "#more", icon: "more_horiz", label: "More" },
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
  const r = phParse(location.hash);
  const route = r || { name: "home", arg: null };
  history.replaceState({ ph: true }, "", `${location.pathname}${location.search}${phHref(route.name, route.arg)}`);
  phOpen(route, { focus: false });
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

/* ==========================================================================
   Home
   ========================================================================== */

let phHidden = (() => { try { return localStorage.getItem("zold-hide-balance") === "1"; } catch { return false; } })();

function phBalance(value, label) {
  const s = phEur(value);                       // "€2,318.47"
  const m = /^€([\d,]+)(\.\d{2})$/.exec(s);
  const whole = m ? m[1] : s.replace("€", "");
  const cents = m ? m[2] : "";
  const long = (whole + cents).length > 9;
  const fig = phHidden
    ? `<span class="z-balance__fig" aria-label="Balance hidden"><span class="z-balance__cur" aria-hidden="true">€</span><span aria-hidden="true">••••</span></span>`
    : `<span class="z-balance__fig${long ? " z-balance__fig--long" : ""}"><span class="z-balance__cur">€</span>${esc(whole)}<span class="z-balance__cents">${esc(cents)}</span></span>`;
  return `<section class="z-balance" aria-labelledby="ph-bal-label">
    <div class="z-balance__head"><h2 class="z-balance__label" id="ph-bal-label">${esc(label)}</h2>
      <button type="button" class="z-iconbtn z-iconbtn--bare" id="ph-hide" aria-pressed="${phHidden}" aria-label="${phHidden ? "Show balance" : "Hide balance"}">${Z.icon(phHidden ? "visibility_off" : "visibility")}</button></div>
    <p class="z-fig">${fig}</p>
  </section>`;
}

/* The set-up list for a new account. Only what the API confirms is ticked. */
function phChecklist(u) {
  const recoveryOffered = (caps.emailSmsRecovery || caps.zoldenburgRecovery) && recoveryOfferedFor(u);
  const safe = u.passkeySafe || {};
  const recoveryOn = safe.recovery?.status === "active" || safe.candideRecovery?.guardianStatus === "active";
  const connected = hasConnectedMonerium(u);
  const approved = kycApproved(u);
  const wait = ibanWait(u);
  const items = [
    { title: "Face ID sign-in", sub: "This phone approves payments.", done: !!u.passkey?.credentialId },
    { title: "Account created", sub: safe.status === "active" ? "Your account is live." : "Finish setting up your account.",
      done: safe.status === "active", action: { id: "ph-ck-account", label: "Finish" } },
    ...(caps.emailVerification && u.email
      ? [{ title: "Confirm your email", sub: u.emailVerifiedAt ? "Confirmed." : "A 6-digit code to your email.",
          done: !!u.emailVerifiedAt, action: { id: "ph-ck-email", label: "Confirm" } }]
      : []),

    { title: "Verify with Monerium", sub: approved || connected ? "Connected." : "ID check, a few minutes.",
      done: approved || connected, action: { id: "ph-ck-verify", label: "Start" } },
    { title: "IBAN active",
      sub: u.iban && approved ? "Ready to receive bank transfers."
        : wait ? (wait.support ? "Needs Monerium support. Tap for details." : `Requested. ${wait.idCheck ? "Monerium is checking your ID." : "Monerium is issuing it."} Nothing to do.`)
        : "Follows your verification.",
      done: !!u.iban && approved,
      // While Monerium works there is nothing to press: the row shows Waiting.
      // A support case keeps a button to the screen that explains it.
      action: connected && !approved && (!wait || wait.support) ? { id: "ph-ck-verify2", label: wait ? "Details" : "Activate" } : null },
  ];
  const open = items.some((i) => !i.done);
  // Recovery is optional, so it is not a set-up step: a skipped choice is an
  // answer, and an unset recovery is one line the user may close. Security
  // keeps saying it is off.
  const declined = u.passkeySafe?.recoveryChoice?.choice === "declined";
  if (!recoveryOn && (recoveryOffered || declined) && !open && !phRecoveryBannerHidden(u)) {
    return `<div class="z-banner" role="note">${Z.icon("shield")}<span>Recovery isn’t set up. If you lose this phone, no one can get you back in. <a href="#recovery-settings">Set up</a></span>
      <button type="button" class="z-iconbtn z-iconbtn--bare" id="ph-rec-x" aria-label="Hide this">${Z.icon("close")}</button></div>`;
  }
  return phChecklistCard("Finish setting up", items);
}

const phRecoveryBannerKey = (u) => `zold-hide-recovery-banner:${u.id}`;
function phRecoveryBannerHidden(u) {
  try { return localStorage.getItem(phRecoveryBannerKey(u)) === "1"; } catch { return false; }
}

/* A set-up card: a row per open item; the finished ones are a count in the
   head, never rows. An item with an `action` ({ id } for a button, { href }
   for a link) offers it; one without waits on someone else. Nothing left to
   do: no card. */
function phChecklistCard(title, items) {
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return "";
  const rows = items.filter((i) => !i.done).map((i) => {
    const mark = `<span class="z-check-mark${i.done ? " is-done" : i.action ? "" : " is-wait"}" aria-hidden="true">${Z.icon(i.done ? "check" : i.action ? "radio_button_unchecked" : "schedule")}</span>`;
    const right = i.done ? Z.tag("Done")
      : i.action ? (i.action.href
        ? `<a class="z-btn z-btn--secondary z-btn--sm" href="${esc(i.action.href)}"${i.action.org ? ` data-ph-org="${esc(i.action.org)}"` : ""}>${esc(i.action.label)}<span class="z-sr">: ${esc(i.title)}</span></a>`
        : `<button type="button" class="z-btn z-btn--secondary z-btn--sm" id="${esc(i.action.id)}">${esc(i.action.label)}<span class="z-sr">: ${esc(i.title)}</span></button>`)
        : Z.tag("Waiting");
    return `<div class="z-row z-row--check${i.done ? " is-done" : ""}">${mark}<span class="z-row__main"><span class="z-row__title">${esc(i.title)}${i.done ? '<span class="z-sr"> (done)</span>' : ""}</span><span class="z-row__sub">${esc(i.sub)}</span></span><span class="z-row__right">${right}</span></div>`;
  });
  return `<section class="z-card z-checklist" aria-labelledby="ph-ck-title">
    <div class="z-checklist__head"><h2 id="ph-ck-title">${esc(title)}</h2><span class="z-fig">${done} of ${items.length} done</span></div>
    <ul class="z-list">${rows.map((r) => `<li>${r}</li>`).join("")}</ul></section>`;
}

PH.home = {
  title: "Home",
  tab: "home",
  live: () => JSON.stringify([user?.balanceEur, user?.iban, user?.kycStatus, user?.monerium?.connectedAt, user?.passkeySafe?.status,
    user?.passkeySafe?.recovery?.status, user?.passkeySafe?.candideRecovery?.guardianStatus, user?.passkeySafe?.recoveryChoice?.choice, user?.emailVerifiedAt, caps.emailVerification, user?.segment?.gate, caps.emailSmsRecovery, caps.zoldenburgRecovery, realMoney, phHistSig()]),
  html() {
    const u = user || {};
    const name = u.name || "Account";
    const checklist = phChecklist(u);
    const gate = u.segment?.gate;
    const inflight = hist.find(phInFlight);
    const ibanRight = u.iban && kycApproved(u)
      ? `<span class="z-mono z-dim" translate="no">•••• ${esc(String(u.iban).replace(/\s+/g, "").slice(-4))}</span>`
      : `<span class="z-dim">IBAN after verification</span>`;
    return `<h1 class="z-sr">Home</h1><header class="z-apphead">
        ${Z.avatar({ name, tone: "p" })}
        <span class="z-apphead__name">${esc(phFirst(name) || name)}</span>
        ${checklist ? Z.tag("Personal") : ""}
      </header>
      ${phMain(`
        ${gate ? Z.note({ tone: "a", html: `<strong>${esc(gate.reason)}</strong> ${esc(gate.needs)} <a href="mailto:support@zoldhq.com">Ask us about it</a>` }) : ""}
        ${phBalance(u.balanceEur ?? u.safeBalanceEur ?? 0, "Balance")}
        <a class="z-card z-acctrow" href="#account-details">${Z.icon("account_balance", "z-acctrow__ic")}<span class="z-acctrow__label">Account details</span>${ibanRight}${Z.icon("chevron_right", "z-row__chev")}</a>
        <div class="z-actions">
          ${Z.button({ variant: "primary", icon: "arrow_outward", label: "Send", href: "#send" })}
          ${Z.button({ icon: "add", label: "Add money", href: "#add" })}
          ${Z.button({ icon: "south_west", label: "Request", href: "#get-paid" })}
        </div>
        ${inflight ? `<a class="z-inflight" href="${phHref("send/progress", inflight.id)}">
            <span class="z-inflight__dot" aria-hidden="true"></span>
            <span class="z-row__main"><span class="z-row__title">${esc(phEur(inflight.sendEur))} to ${esc(inflight.recipientName || "")}</span>
            <span class="z-row__sub">Waiting for the bank to confirm</span></span>${Z.icon("chevron_right", "z-row__chev")}</a>` : ""}
        ${checklist}
        ${phActivityList(hist.slice(0, 5), {
          label: "Recent activity",
          action: hist.length ? { href: "#activity", label: "See all" } : undefined,
          empty: { text: u.iban ? "No payments yet. Share your account details to get paid." : "No payments yet. Once your IBAN is live, share it to get paid." },
        })}
      `)}`;
  },
  bind(root) {
    root.querySelector("#ph-hide").onclick = () => {
      phHidden = !phHidden;
      try { localStorage.setItem("zold-hide-balance", phHidden ? "1" : "0"); } catch { /* hidden for this visit */ }
      phRender();
      $("ph-hide")?.focus();
    };
    for (const id of ["ph-ck-verify", "ph-ck-verify2", "ph-ck-account"]) {
      const b = root.querySelector(`#${id}`);
      if (b) b.onclick = () => enterKycReview(user?.name || "Account");
    }
    const emailBtn = root.querySelector("#ph-ck-email");
    if (emailBtn) emailBtn.onclick = () => enterEmailConfirm();
    const recX = root.querySelector("#ph-rec-x");
    if (recX) recX.onclick = () => {
      try { localStorage.setItem(phRecoveryBannerKey(user), "1"); } catch { /* shown again next visit */ }
      recX.closest(".z-banner")?.remove();
    };
    phBindRetry(root);
    phRecoveryCheck();
  },
};

/* ==========================================================================
   Recovery under way (the old phone's alert)
   ========================================================================== */

/* What the guardians report: { chain: pendingRecovery|null, request: a
   Zoldenburg request nobody has signed yet|null, method: words|null }.
   null until the first read; `none` when nothing is under way. */
let phRec = null;
let phRecReadAt = 0;
let phRecDone = false;       // this phone just cancelled it
const PH_REC_SEEN = "zold-recovery-seen";
const phRecSig = (r) => (r?.chain ? `chain:${r.chain.executeAfter}` : r?.request ? `req:${r.request.id}` : "");

/* Read both guardians, at most once a minute. Home and the company's Home
   (app/business.js) call this; a recovery found here opens the alert, unless
   "It was me" hid that same one. */
async function phRecoveryCheck({ force = false } = {}) {
  const here = () => phRoute?.name === "recovery-alert";
  // No guardian can run a recovery here: there is nothing to find.
  if (!user?.id || user.passkeySafe?.status !== "active" || (!caps.emailSmsRecovery && !caps.zoldenburgRecovery)) {
    if (here()) { phRec = { none: true }; phRender(); }
    return;
  }
  if (!force && Date.now() - phRecReadAt < 60000) return;
  phRecReadAt = Date.now();
  const [c, z] = await Promise.all([
    caps.emailSmsRecovery ? api(`/api/users/${user.id}/recovery/candide`).catch(() => null) : null,
    caps.zoldenburgRecovery ? api(`/api/users/${user.id}/recovery/zoldenburg`).catch(() => null) : null,
  ]);
  if (!c && !z) {
    if (here()) { phRec = { failed: true }; phRender(); }
    return;
  }
  const chain = z?.onChain?.pendingRecovery || c?.onChain?.pendingRecovery || null;
  const reqs = z?.requests || [];
  const request = chain ? null : reqs.find((r) => ["PASSKEY_PENDING", "KYC_PENDING", "REVIEW_PENDING"].includes(r.status)) || null;
  // Which guardian is moving it, where the reads say so; otherwise left out.
  const kinds = [...new Set((c?.channels || []).map((x) => (x.channel === "sms" ? "phone" : "email")))];
  const codes = kinds.length ? `${kinds.join(" and ").replace(/^./, (x) => x.toUpperCase())} ${kinds.length > 1 ? "codes" : "code"}` : "Email or phone codes";
  const method = !chain ? "Zoldenburg ID check"
    : reqs.some((r) => r.status === "GRACE_PERIOD") ? "Zoldenburg ID check"
      : c?.guardianStatus === "active" && !z?.active ? codes : null;
  phRec = chain || request ? { chain, request, method } : { none: true };
  if (phRec.none) return phRoute?.name === "recovery-alert" && phRender();
  let seen = "";
  try { seen = sessionStorage.getItem(PH_REC_SEEN) || ""; } catch { /* no storage: always show */ }
  if (phRoute?.name === "recovery-alert") return phRender();
  if (["home", "company"].includes(phRoute?.name) && seen !== phRecSig(phRec)) phGo("recovery-alert");
}

PH["recovery-alert"] = {
  title: "Recovery under way",
  html() {
    if (phRecDone) {
      return phMain(`
        <span class="z-tile z-tile--m z-tile--lg" aria-hidden="true">${Z.icon("verified_user")}</span>
        <div class="z-intro"><h1 class="z-title">Recovery cancelled</h1><p class="z-sub">Your account stays with this phone. If you didn’t start that recovery, someone may know your email. Check your recovery settings.</p></div>
      `, "z-app__main--state")
        + phFoot(`${Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" })}<a class="z-link-btn" href="#recovery-settings">Recovery settings</a>`);
    }
    if (!phRec) return `${Z.topbar({ srTitle: "Recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(Z.skeletonRows(2, "Checking for a recovery…"))}`;
    if (phRec.failed) {
      return `${Z.topbar({ srTitle: "Recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(`
        <div class="z-intro"><h2 class="z-title">Couldn’t check for a recovery</h2><p class="z-sub">Zold didn’t answer. Try again, or open Recovery settings.</p></div>`)}${phFoot(`${Z.button({ variant: "primary", full: true, label: "Try again", id: "ph-rec-retry" })}<a class="z-link-btn" href="#recovery-settings">Recovery settings</a>`)}`;
    }
    if (phRec.none) {
      return `${Z.topbar({ srTitle: "No recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(`
        <div class="z-intro"><h2 class="z-title">No recovery under way</h2><p class="z-sub">Nobody is moving your account to another phone.</p></div>`)}${phFoot(Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" }))}`;
    }
    const { chain, request, method } = phRec;
    const until = chain ? new Date(Number(chain.executeAfter) * 1000) : null;
    const left = until ? until.getTime() - Date.now() : 0;
    const title = chain ? "Someone is moving your account to a new phone" : "Someone asked to move your account to a new phone";
    const lede = chain
      ? `It completes on ${rcWhenText(until)} unless you cancel.`
      : `They asked Zoldenburg support${request.requestedAt ? ` on ${rcWhenText(new Date(request.requestedAt))}` : ""}. Nothing has been signed yet.`;
    const rows = [
      ...(method ? [{ key: "Recovery method", value: method }] : []),
      ...(chain ? [{ key: "Time left to cancel", valueHtml: `<span class="z-warn-fig">${esc(left > 0 ? rcLeftText(left) : "Finishing…")}</span>` }] : []),
      ...(request?.zoldenburg?.reference ? [{ key: "Their reference", value: request.zoldenburg.reference, mono: true }] : []),
    ];
    return phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("gpp_maybe")}</span>
      <div class="z-intro"><h1 class="z-title">${esc(title)}</h1><p class="z-sub">${esc(lede)}</p></div>
      ${rows.length ? Z.kv(rows) : ""}
      <p class="z-sub">If this wasn’t you, cancel now. Nothing moves while you decide, and your money stays in your account.</p>
      <div class="z-alert hidden" role="alert" id="ph-rec-err"></div>
    `, "z-app__main--state")
      + phFoot(`${Z.button({ variant: "primary", full: true, icon: chain ? "passkey" : "block", label: chain ? "Cancel with Face ID" : "Cancel the request", id: "ph-rec-cancel" })}
        ${Z.button({ variant: "secondary", full: true, label: "It was me", id: "ph-rec-mine" })}
        <p class="z-screen__fine z-screen__fine--flush">“It was me” only hides this on this phone. ${chain ? "The move goes ahead." : "The request stays open."}</p>`);
  },
  bind(root) {
    if (!phRec) phRecoveryCheck({ force: true });
    const retry = root.querySelector("#ph-rec-retry");
    if (retry) retry.onclick = () => { phRec = null; phRender({ focus: true }); };
    const cancel = root.querySelector("#ph-rec-cancel");
    if (cancel) cancel.onclick = async () => {
      if (Z.isDisabled(cancel)) return;
      clearErr("ph-rec-err");
      Z.setLoading(cancel, true);
      try {
        if (phRec.chain) await recoveryCancelRun();
        else await api(`/api/users/${user.id}/recovery/zoldenburg/requests/${phRec.request.id}/cancel`, {});
        phRec = null;
        phRecDone = true;
        phRender({ focus: true });
        phRecDone = false;
      } catch (e) {
        showErr("ph-rec-err", e?.name === "NotAllowedError" ? new Error("Face ID or fingerprint was cancelled. The recovery is still under way.") : e);
      } finally { if (cancel.isConnected) Z.setLoading(cancel, false); }
    };
    const mine = root.querySelector("#ph-rec-mine");
    if (mine) mine.onclick = () => {
      try { sessionStorage.setItem(PH_REC_SEEN, phRecSig(phRec)); } catch { /* shows again next time */ }
      phGo("home", null, { replace: true });
    };
  },
};

/* ==========================================================================
   Account details (a sheet over Home)
   ========================================================================== */

/* The BIC Monerium lists for this IBAN. Read once per IBAN. */
async function phLoadBic() {
  const iban = user?.iban || "";
  if (!iban || !user?.id) return null;
  if (phCache.bicFor === iban && phCache.bic !== undefined) return phCache.bic;
  if (user.bic) { phCache.bic = user.bic; phCache.bicFor = iban; return user.bic; }
  try {
    const r = await api(`/api/users/${user.id}/bic`);
    phCache.bic = r.bic || null;
  } catch {
    phCache.bic = null;
  }
  phCache.bicFor = iban;
  return phCache.bic;
}

function phDetailsText(u, bic) {
  return [`Account holder: ${u.name || ""}`, `IBAN: ${Z.groupIban(u.iban)}`, ...(bic ? [`BIC: ${bic}`] : [])].join("\n");
}

/* The account details body, used by the sheet and by Get paid. */
function phDetailsBody(u, bic, { loadingBic = false } = {}) {
  if (!u.iban || !kycApproved(u)) {
    return `<p class="z-sub">Your IBAN appears here once Monerium has verified you and issued it.</p>
      ${Z.button({ variant: "primary", full: true, label: "Verify with Monerium", id: "ph-det-verify" })}`;
  }
  const bicRow = loadingBic
    ? `<li><div class="z-copy" aria-hidden="true"><span class="z-copy__main"><span class="z-copy__label">BIC</span><span class="z-skel z-skel--line" style="width:40%;margin-top:6px"></span></span></div></li>`
    : bic ? `<li>${Z.copyRow({ label: "BIC", value: bic, mono: true })}</li>` : "";
  const wallet = u.address && u.passkeySafe?.status === "active"
    ? `<details class="z-disclose"><summary>Crypto wallet address${Z.icon("expand_more")}</summary>
        <div class="z-card">${Z.copyRow({ label: "Your wallet address", value: u.address, mono: true })}</div>
        ${Z.note({ tone: "a", text: "Only USDC on the Base network. Anything else sent here is lost." })}</details>`
    : "";
  return `<p class="z-sub">Share these to get paid by bank transfer.</p>
    <ul class="z-list z-card">
      <li>${Z.copyRow({ label: "Account holder", value: u.name || "" })}</li>
      <li>${Z.copyRow({ label: "IBAN", value: String(u.iban).replace(/\s+/g, ""), display: Z.groupIban(u.iban), mono: true })}</li>
      ${bicRow}
    </ul>
    ${wallet}
    <div class="z-pair">
      ${Z.button({ icon: "content_copy", label: "Copy all", id: "ph-det-copy" })}
      ${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-det-share" })}
    </div>`;
}

function phBindDetails(root) {
  const verify = root.querySelector("#ph-det-verify");
  if (verify) verify.onclick = () => { Z.closeOverlay(); enterKycReview(user?.name || "Account"); };
  const copy = root.querySelector("#ph-det-copy");
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(phDetailsText(user, phCache.bic)); Z.announce("Copied"); }
    catch { Z.announce("Could not copy. Select the text and copy it yourself."); }
  };
  const share = root.querySelector("#ph-det-share");
  if (share) share.onclick = () => phShare("My account details", phDetailsText(user, phCache.bic));
}

PH["account-details"] = {
  title: "Account details",
  tab: "home",
  html: () => PH.home.html(),
  bind(root) {
    PH.home.bind(root);
    const u = user || {};
    const ready = u.iban && kycApproved(u);
    const known = phCache.bicFor === u.iban && phCache.bic !== undefined;
    const sheetHtml = Z.overlay({
      id: "ph-details",
      title: "Account details",
      body: `<div class="z-sheet__body" id="ph-details-body">${phDetailsBody(u, known ? phCache.bic : null, { loadingBic: ready && !known })}</div>`,
    });
    document.body.insertAdjacentHTML("beforeend", sheetHtml);
    const scrim = $("ph-details");
    scrim.dataset.ph = "1";
    if (ready) scrim.querySelector(".z-overlay__head h2").insertAdjacentHTML("afterend", Z.tag("Active"));
    phBindDetails(scrim);
    Z.openOverlay("ph-details", root.querySelector('a[href="#account-details"]'));
    // Closing the sheet is going back to Home.
    const watch = new MutationObserver(() => {
      if (!scrim.classList.contains("is-open")) {
        watch.disconnect();
        if (phRoute?.name === "account-details") {
          if (history.state?.ph && history.length > 1) history.back(); else phGo("home", null, { replace: true });
        }
      }
    });
    watch.observe(scrim, { attributes: true, attributeFilter: ["class"] });
    if (ready && !known) {
      phLoadBic().then(() => {
        const body = $("ph-details-body");
        if (!body || phRoute?.name !== "account-details") return;
        body.innerHTML = phDetailsBody(user, phCache.bic);
        phBindDetails(scrim);
      });
    }
  },
};

/* ==========================================================================
   Activity and one payment
   ========================================================================== */

const PH_FILTERS = [["all", "All"], ["in", "Money in"], ["out", "Money out"], ["flight", "In flight"]];
let phQuery = "";

function phFiltered(filter, q) {
  const needle = q.trim().toLowerCase();
  return hist.filter((t) => {
    if (filter === "in" && t.kind !== "funding") return false;
    if (filter === "out" && t.kind === "funding") return false;
    if (filter === "flight" && !phInFlight(t)) return false;
    if (!needle) return true;
    const hay = [t.recipientName, t.reference, t.recipientIban, t.token === "USDC" ? "digital dollars usdc" : t.kind === "funding" ? "euros received" : ""]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

/* Grouped by when: today, this month, then one group per month. */
function phGroups(list) {
  const now = new Date();
  const groups = [];
  for (const t of list) {
    const d = new Date(t.at || t.createdAt || t.detectedAt);
    const label = d.toDateString() === now.toDateString() ? "Today"
      : d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? "Earlier this month"
        : new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(d);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.rows.push(t); else groups.push({ label, rows: [t] });
  }
  return groups;
}

function phActivityResults(filter) {
  if (!histLoaded && !histLoadFailed) return Z.skeletonRows(5, "Loading your payments…");
  if (histLoadFailed && !hist.length) return phActivityList([], {});
  const list = phFiltered(filter, phQuery);
  if (!list.length) {
    return Z.listGroup({ rows: [], empty: hist.length
      ? { text: "Nothing matches. Try another word or filter." }
      : { text: "No payments yet. Share your account details to get paid.", action: { href: "#account-details", label: "Account details" } } });
  }
  return phGroups(list).map((g) => Z.listGroup({ label: g.label, rows: g.rows.map(phActivityRow) })).join("");
}

PH.activity = {
  title: "Activity",
  tab: "activity",
  live: (arg) => `${arg}|${phHistSig()}`,
  html(arg) {
    const filter = PH_FILTERS.some(([k]) => k === arg) ? arg : "all";
    return `${phTop("Activity")}${phMain(`
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-q">Search payments</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-q" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Search payments…" value="${esc(phQuery)}">
      </form>
      <div class="z-pills" role="group" aria-label="Show">
        ${PH_FILTERS.map(([k, label]) => `<a class="z-pill" href="#activity${k === "all" ? "" : `/${k}`}" aria-current="${k === filter ? "true" : "false"}">${esc(label)}</a>`).join("")}
      </div>
      <div id="ph-results" aria-live="polite">${phActivityResults(filter)}</div>
    `)}`;
  },
  bind(root, arg) {
    const filter = PH_FILTERS.some(([k]) => k === arg) ? arg : "all";
    const q = root.querySelector("#ph-q");
    q.oninput = () => {
      phQuery = q.value;
      root.querySelector("#ph-results").innerHTML = phActivityResults(filter);
      phBindRetry(root);
    };
    phBindRetry(root);
  },
};

/* One payment: its body and its actions, drawn as a screen on the phone and
   as a drawer over Activity on a desktop (app/desktop.js). */
function phTxParts(id) {
  const t = hist.find((x) => x.id === id && x.kind !== "funding");
  if (!t) {
    return { t: null, foot: "", body: histLoaded || histLoadFailed
      ? Z.note({ text: "This payment is not on your account." })
      : Z.skeletonRows(3, "Loading the payment…") };
  }
  const cash = t.rail === "cash";
  const fee = !cash && typeof t.receiveEur === "number" ? Math.max(0, (t.sendEur || 0) - t.receiveEur) : null;
  const rows = [
    { key: "Date", value: phFull(t.createdAt) },
    ...(cash ? [{ key: "To mobile", value: t.recipientPhone }] : [{ key: "To IBAN", value: phShortIban(t.recipientIban), mono: true }]),
    ...(fee !== null ? [{ key: "Zold fee", value: phEur(fee) }] : []),
    { key: "Sent as", value: cash ? "Cash pickup" : "Bank transfer" },
    ...(!cash ? [{ key: "Reference", value: t.reference || "", hint: "On their bank statement" }] : []),
    ...(t.refund ? [{ key: "Refunded", value: phEur(t.refund.amountEur) }] : []),
  ];
  const hashes = (t.txs || []).filter((x) => x.hash);
  const tech = [
    { key: "Payment ID", value: t.id, mono: true },
    ...(!cash && t.recipientIban ? [{ key: "Full IBAN", value: Z.groupIban(t.recipientIban), mono: true }] : []),
    ...(t.sepa?.orderId ? [{ key: "Monerium order", value: t.sepa.orderId, mono: true }] : []),
    ...hashes.map((x) => ({ key: x.step, value: x.hash, mono: true })),
  ];
  const receipt = t.rail === "sepa" && t.state === "PAID";
  return { t, body: `
    <div class="z-txhead">
      ${Z.avatar({ name: t.recipientName })}
      <p class="z-txhead__amt z-fig">${phOut(t) ? "−" : ""}${esc(phEur(t.sendEur))}</p>
      <p class="z-sub">to ${esc(t.recipientName || "")}</p>
      ${Z.tag(phTxWord(t))}
    </div>
    ${t.error ? Z.note({ tone: "a", text: t.error }) : ""}
    ${phInFlight(t) ? Z.note({ tone: "p", html: `On its way. <a href="${phHref("send/progress", t.id)}">See progress</a>` }) : ""}
    ${Z.kv(rows)}
    <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv(tech)}</details>
    <p class="z-err" id="ph-tx-err" role="alert" hidden></p>
  `, foot: t.state === "CREATED" ? "" : `<div class="z-pair">
      ${receipt ? Z.button({ icon: "receipt_long", label: "Receipt", id: "ph-tx-receipt" }) : ""}
      ${Z.button({ variant: receipt ? "secondary" : "primary", icon: "ios_share", label: "Share", href: phHref("share", t.id), className: receipt ? "" : "z-btn--full" })}
    </div>` };
}

PH.tx = {
  title: "Payment",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? `${t.state}|${t.updatedAt}` : `none|${histLoaded}`; },
  html(id) {
    const p = phTxParts(id);
    return `${phTop("Payment", "activity")}${phMain(p.body)}${p.foot ? phFoot(p.foot) : ""}`;
  },
  bind(root, id) {
    const b = root.querySelector("#ph-tx-receipt");
    if (b) b.onclick = async () => {
      Z.setLoading(b, true);
      try {
        const d = await api(`/api/users/${user.id}/documents/receipt`, { transferId: id });
        const u = safeUrl(d.url) || (typeof d.url === "string" && d.url.startsWith("/") ? d.url : null);
        if (u) window.open(u, "_blank", "noopener");
      } catch (e) {
        const err = root.querySelector("#ph-tx-err");
        err.textContent = e.message; err.hidden = false;
      } finally { Z.setLoading(b, false); }
    };
    // Re-read the transfer, so an open screen is not a snapshot of the list.
    if (id && hist.some((x) => x.id === id)) {
      api(`/api/transfers/${encodeURIComponent(id)}`).then((fresh) => {
        const old = hist.find((x) => x.id === id);
        if (old && (old.state !== fresh.state || old.updatedAt !== fresh.updatedAt)) updateHistory({ kind: "transfer", ...old, ...fresh });
      }).catch(() => { /* keep what the list had */ });
    }
  },
};

/* The older share composer, reached from one payment. */
PH_LEGACY.share = "share";

/* ==========================================================================
   Send
   ========================================================================== */

/* The send in progress. The IBAN is what the device signs a commitment over,
   so it is always on screen before the approval. */
let phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };

/* People this account has paid, newest first, one per IBAN. */
function phPayees() {
  const seen = new Map();
  for (const t of hist) {
    if (t.kind === "funding" || t.rail !== "sepa" || !t.recipientIban) continue;
    const key = String(t.recipientIban).replace(/\s+/g, "").toUpperCase();
    if (!seen.has(key)) seen.set(key, { key, name: t.recipientName || "", iban: key, count: 0, payments: [] });
    const p = seen.get(key);
    p.count += 1;
    p.payments.push(t);
  }
  return [...seen.values()];
}

/* Why sending is closed, and the one thing that opens it. null: open. */
function phSendBlocked(u = user) {
  if (!HAS("onchain_balance")) return { text: "Sending is not part of this account.", action: null };
  if (!kycApproved(u) || !u?.iban) return { text: "Sending opens once Monerium has verified you and your IBAN is active.", action: { id: "ph-send-verify", label: "Verify with Monerium" } };
  return null;
}

function phPayeeRow(p, href) {
  return Z.row({ lead: Z.avatar({ name: p.name }), title: p.name || "Payee", sub: phMaskIban(p.iban), href });
}

PH.send = {
  title: "Send",
  tab: "send",
  live: () => `${user?.kycStatus}|${user?.iban}|${phHistSig()}`,
  html() {
    const blocked = phSendBlocked();
    const payees = phPayees();
    const q = phQuery;
    return `${phTop("Send")}${phMain(`
      ${blocked ? `${Z.note({ tone: "a", text: blocked.text })}${blocked.action ? Z.button({ variant: "primary", full: true, label: blocked.action.label, id: blocked.action.id }) : ""}` : `
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-sq">Search people you’ve paid</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-sq" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Name or IBAN…" value="">
      </form>
      <div id="ph-send-matches"></div>
      ${payees.length ? `<section class="z-group" aria-labelledby="ph-recent"><div class="z-group__head"><h2 class="z-eyebrow" id="ph-recent">Recent</h2></div>
        <div class="z-rail">${payees.slice(0, 6).map((p) => `<a class="z-rail__item" href="${phHref("send/amount", p.key)}">${Z.avatar({ name: p.name })}<span>${esc(phFirst(p.name) || "Payee")}</span></a>`).join("")}</div></section>` : ""}
      ${Z.listGroup({
        label: "New payment",
        rows: [
          Z.row({ lead: Z.iconTile({ icon: "account_balance", tone: "p" }), title: "Bank transfer", sub: "To any IBAN in Europe, no Zold fee", right: Z.tag("Beta"), href: "#send/new" }),
          Z.soonRow({ lead: Z.iconTile({ icon: "account_balance_wallet" }), title: "Crypto wallet", sub: "Send digital dollars (USDC) to a wallet" }),
        ],
      })}
      ${Z.listGroup({
        label: "People you’ve paid",
        rows: payees.map((p) => phPayeeRow(p, phHref("send/amount", p.key))),
        empty: { text: "The people you pay appear here." },
      })}`}
    `)}`;
  },
  bind(root) {
    // A new send starts clean; the amount screen fills in from the payee.
    phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };
    const v = root.querySelector("#ph-send-verify");
    if (v) v.onclick = () => enterKycReview(user?.name || "Account");
    const q = root.querySelector("#ph-sq");
    if (!q) return;
    q.oninput = () => {
      const needle = q.value.trim().toLowerCase().replace(/\s+/g, "");
      const out = root.querySelector("#ph-send-matches");
      if (!needle) { out.innerHTML = ""; return; }
      const hits = phPayees().filter((p) => p.name.toLowerCase().replace(/\s+/g, "").includes(needle) || p.iban.toLowerCase().includes(needle));
      const looksIban = /^[a-z]{2}\d{2}[a-z0-9]{8,}$/i.test(needle);
      out.innerHTML = Z.listGroup({
        rows: [
          ...hits.map((p) => phPayeeRow(p, phHref("send/amount", p.key))),
          ...(looksIban && !hits.length ? [Z.row({ lead: Z.iconTile({ icon: "add" }), title: "Pay a new IBAN", sub: Z.groupIban(needle.toUpperCase()), href: `#send/new/${encodeURIComponent(needle.toUpperCase())}` })] : []),
        ],
        empty: { text: "Nobody you’ve paid matches that.", action: { href: "#send/new", label: "New bank transfer" } },
      });
    };
  },
};

/* A new payee: name and IBAN. No design of its own; built from the field and
   the pinned action, like the onboarding forms. */
PH["send/new"] = {
  title: "New bank transfer",
  html(prefill) {
    const p = phSend.payee && !phSend.payee.fromHistory ? phSend.payee : null;
    return `${phTop("New bank transfer", "send")}<form id="ph-new" class="z-app__form" novalidate>${phMain(`
      <div class="z-form">
        ${Z.field({ id: "ph-new-name", label: "Their full name", name: "name", autocomplete: "off", placeholder: "Name on their account…", value: p?.name || "", required: true })}
        ${Z.field({ id: "ph-new-iban", label: "IBAN", name: "iban", autocomplete: "off", spellcheck: false, placeholder: "DE89 3704 0044 0532 0130 00…", value: p?.iban ? Z.groupIban(p.iban) : prefill ? Z.groupIban(prefill) : "", required: true })}
      </div>
      ${Z.note({ text: "Check the name and IBAN with them. Your Face ID approves the payment to exactly this IBAN." })}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Continue", type: "submit" }))}</form>`;
  },
  bind(root) {
    root.querySelector("#ph-new").onsubmit = (e) => {
      e.preventDefault();
      const name = root.querySelector("#ph-new-name");
      const iban = root.querySelector("#ph-new-iban");
      const clean = iban.value.replace(/\s+/g, "").toUpperCase();
      Z.setFieldError(name, name.value.trim() ? "" : "Enter the name on their account.");
      Z.setFieldError(iban, /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(clean) ? "" : "Enter an IBAN, like DE89 3704 0044 0532 0130 00.");
      if (Z.focusFirstError(root)) return;
      phSend = { payee: { name: name.value.trim(), iban: clean }, amount: "", reference: "", quote: null, transferId: null, error: null };
      phGo("send/amount", "new");
    };
  },
};

/** The payee for the amount step: from history by IBAN, or the one typed. */
function phPayeeFor(arg) {
  if (arg && arg !== "new") {
    const p = phPayees().find((x) => x.key === String(arg).toUpperCase());
    if (p) return { name: p.name, iban: p.iban, fromHistory: true };
  }
  return phSend.payee;
}

let phQuoteSeq = 0, phQuoteTimer = null;

/* The key-value rows without the card, as the amount screen draws them. */
const phFlatKv = (rows) => Z.kv(rows).replace('class="z-kv z-card"', 'class="z-kv z-kv--flat"');

function phQuoteRows(q, payee) {
  const first = phFirst(payee?.name) || "They";
  return phFlatKv([
    { key: "Zold fee", value: q ? phEur(q.fixedFeeEur) : phEur(0) },
    { key: "Exchange", value: "None, euro to euro" },
    { key: "Sent as", value: "Bank transfer" },
    { key: `${first} receives`, value: q ? phEur(q.receiveEur) : "Enter an amount" },
  ]);
}

PH["send/amount"] = {
  title: "Amount",
  // Redraw once, when a payee named in the URL is found in the loaded history.
  live: (arg) => `${!!phPayeeFor(arg)}|${histLoaded}`,
  html(arg) {
    const payee = phPayeeFor(arg);
    if (!payee && arg && arg !== "new" && !histLoaded && !histLoadFailed) return `${phTop("Amount", "send")}${phMain(Z.skeletonRows(2, "Loading…"))}`;
    if (!payee) return `${phTop("Amount", "send")}${phMain(Z.note({ text: "Pick who to pay first." }) + Z.button({ variant: "primary", full: true, label: "Choose a person", href: "#send" }))}`;
    const blocked = phSendBlocked();
    return `${phTop("Amount", "send")}<form id="ph-amt" class="z-app__form" novalidate>${phMain(`
      <div class="z-chip-payee">${Z.avatar({ name: payee.name })}<span class="z-row__title">${esc(payee.name)}</span><span class="z-mono z-dim" translate="no">•••• ${esc(payee.iban.slice(-4))}</span></div>
      ${blocked ? Z.note({ tone: "a", text: blocked.text }) : ""}
      <div class="z-amount-in">
        <label for="ph-amount" class="z-amount-in__label">You send</label>
        <div class="z-amount-in__box"><span class="z-amount-in__cur" aria-hidden="true">€</span>
          <input id="ph-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00…" value="${esc(phSend.amount)}" aria-describedby="ph-amount-hint ph-amount-err"></div>
        <p class="z-hint z-fig" id="ph-amount-hint">Available ${esc(phEur(user?.balanceEur ?? 0))}</p>
        <p class="z-err" id="ph-amount-err" role="alert" hidden></p>
      </div>
      <div id="ph-quote" aria-live="polite">${phQuoteRows(null, payee)}</div>
      ${Z.field({ id: "ph-ref", label: "Reference", optional: true, name: "reference", autocomplete: "off", placeholder: "What it’s for…", maxlength: 140, value: phSend.reference, hint: "Shown on their bank statement." })}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Enter an amount", type: "submit", id: "ph-amt-next", disabledReason: undefined }))}</form>`;
  },
  bind(root, arg) {
    const payee = phPayeeFor(arg);
    if (!payee) return;
    phSend.payee = payee;
    const input = root.querySelector("#ph-amount");
    const next = root.querySelector("#ph-amt-next");
    const err = root.querySelector("#ph-amount-err");
    const setNext = (label, ok) => {
      next.querySelector("span").textContent = label;
      if (ok) next.removeAttribute("aria-disabled"); else next.setAttribute("aria-disabled", "true");
    };
    const showErr = (msg) => { err.textContent = msg || ""; err.hidden = !msg; if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); };
    const price = async () => {
      const typed = input.value.trim();
      phSend.amount = typed;
      phSend.quote = null;
      const seq = ++phQuoteSeq;
      showErr("");
      root.querySelector("#ph-quote").innerHTML = phQuoteRows(null, payee);
      if (!typed) { setNext("Enter an amount", false); return; }
      const n = parseEurInput(typed);
      if (!(n > 0)) { setNext("Enter an amount", false); showErr(eurInputError(typed)); return; }
      if (phSendBlocked()) { setNext("Sending is not open yet", false); return; }
      if (n > (user?.balanceEur ?? 0)) { setNext("More than your balance", false); showErr(`You have ${phEur(user?.balanceEur ?? 0)}.`); return; }
      setNext("Pricing…", false);
      try {
        const q = await api("/api/quotes", { userId: user.id, rail: "sepa", sendEur: n });
        if (seq !== phQuoteSeq) return;
        phSend.quote = q;
        root.querySelector("#ph-quote").innerHTML = phQuoteRows(q, payee);
        setNext("Review", true);
      } catch (e) {
        if (seq !== phQuoteSeq) return;
        setNext("Enter an amount", false);
        showErr(e.message);
      }
    };
    input.oninput = () => { clearTimeout(phQuoteTimer); phQuoteTimer = setTimeout(price, 450); };
    root.querySelector("#ph-ref").oninput = (e) => { phSend.reference = e.target.value; };
    root.querySelector("#ph-amt").onsubmit = (e) => {
      e.preventDefault();
      if (Z.isDisabled(next) || !phSend.quote) { input.focus(); return; }
      phSend.reference = root.querySelector("#ph-ref").value.trim();
      phGo("send/review");
    };
    if (input.value) price(); else setNext("Enter an amount", false);
  },
};

PH["send/review"] = {
  title: "Review payment",
  html() {
    const { payee, quote: q } = phSend;
    if (!payee || !q) return `${phTop("Review payment", "send")}${phMain(Z.note({ text: "This payment has no price yet. Enter the amount again." }) + Z.button({ variant: "primary", full: true, label: "Back to Send", href: "#send" }))}`;
    const first = phFirst(payee.name) || "They";
    return `${phTop("Review payment", "send/amount")}${phMain(`
      <div><p class="z-eyebrow">You send</p>${phBalanceFig(q.sendEur)}</div>
      <div class="z-card z-payee">${Z.avatar({ name: payee.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(payee.name)}</span><span class="z-mono z-dim" translate="no">${esc(Z.groupIban(payee.iban))}</span></span>${Z.tag("Beta")}</div>
      ${Z.kv([
        { key: "From", value: "Personal account" },
        { key: "Zold fee", value: phEur(q.fixedFeeEur) },
        { key: "Exchange", value: "None, euro to euro" },
        { key: "Sent as", value: "Bank transfer" },
        ...(phSend.reference ? [{ key: "Reference", value: phSend.reference }] : []),
        { key: `${first} receives`, value: phEur(q.receiveEur), strong: true },
      ])}
      ${Z.note({ icon: "verified_user", text: "Your Face ID approves this amount to this IBAN only. If either changes, nothing is sent." })}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        { key: "Price", value: q.id, mono: true },
        { key: "Price valid until", value: phFull(q.expiresAt) },
      ])}</details>
      <p class="z-err" id="ph-rev-err" role="alert" hidden></p>
    `)}${phFoot(Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Approve with Face ID", id: "ph-approve" }))}`;
  },
  bind(root) {
    const b = root.querySelector("#ph-approve");
    if (b) b.onclick = () => phSubmit(b, root.querySelector("#ph-rev-err"));
  },
};

/* The display figure for a single amount (review, results). */
function phBalanceFig(value) {
  const m = /^€([\d,]+)(\.\d{2})$/.exec(phEur(value));
  return `<p class="z-balance__fig z-fig"><span class="z-balance__cur">€</span>${esc(m ? m[1] : "")}<span class="z-balance__cents">${esc(m ? m[2] : "")}</span></p>`;
}

/**
 * Create, sign, authorise. The same guarantees as before this redesign: the
 * device recomputes the payout commitment and refuses to sign when the
 * server's terms name a different recipient, and the passkey signs the Safe
 * operation that is the debit.
 */
async function phSubmit(btn, errEl) {
  if (Z.isDisabled(btn)) return;
  errEl.hidden = true;
  Z.setLoading(btn, true);
  const { payee, quote: q } = phSend;
  let created = null;
  try {
    if (phSendBlocked()) throw new Error(phSendBlocked().text);
    if (!user.authorizerAddress) await registerDeviceKey(user);
    const recipient = { recipientName: payee.name, recipientIban: payee.iban };
    created = await api("/api/transfers", { quoteId: q.id, ...recipient, ...(phSend.reference ? { reference: phSend.reference } : {}) });
    phSend.transferId = created.id;
    const dev = await deviceLib;
    const addr = await dev.deviceAddress(credId());
    if (created.authorization.authorizer.toLowerCase() !== addr.toLowerCase()) {
      throw new Error("This account’s approval key is on a different browser. Send from there, or change the key there first.");
    }
    const expected = dev.destinationCommitment("sepa", { iban: recipient.recipientIban, name: recipient.recipientName });
    if (created.authorization.typedData.message.destination.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("The payment terms name a different recipient from the one you entered. Nothing was signed.");
    }
    const signature = await dev.signTypedData(created.authorization.typedData, credId());
    const execution = await safeExecutionAssertion(created.authorization);
    const redeem = await moneriumRedeemAssertion(created.authorization);
    const t = await api(`/api/transfers/${created.id}/authorize`, {
      signature,
      ...(execution ? { executionAssertion: execution } : {}),
      ...(redeem ? { moneriumRedeemAssertion: redeem } : {}),
    });
    phPutTransfer(t);
    refresh();
    phGo("send/progress", t.id, { replace: true });
  } catch (e) {
    Z.setLoading(btn, false);
    if (!created) {
      // Nothing was created: say why here, on the screen the user is on.
      errEl.textContent = e?.name === "NotAllowedError" ? "Face ID or fingerprint was cancelled. Nothing was sent." : e.message;
      errEl.hidden = false;
      return;
    }
    // A transfer exists: its own state decides what the user is told.
    phSend.error = e?.name === "NotAllowedError" ? "You cancelled Face ID or fingerprint." : e.message;
    try {
      const fresh = await api(`/api/transfers/${created.id}`);
      phPutTransfer(fresh);
    } catch { phPutTransfer(created); }
    phGo("send/error", created.id, { replace: true });
  }
}

/* Put a transfer into the activity list, new or updated. */
function phPutTransfer(t) {
  const row = { kind: "transfer", at: t.createdAt, ...t };
  if (hist.some((x) => x.id === t.id)) updateHistory(row); else addHistory(row);
}

/* Progress: approved, sent to the bank, paid. Paid only when the API says so. */
function phTimeline(t) {
  const approved = !!(t.auth?.authorizedAt || t.moneriumRedeem?.signedAt) || !["CREATED"].includes(t.state);
  const sent = ["PAYOUT_SUBMITTED", "PAID"].includes(t.state);
  const paid = t.state === "PAID";
  const time = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "");
  const steps = [
    { t: "Approved", d: approved ? `With Face ID${t.auth?.authorizedAt ? `, ${time(t.auth.authorizedAt)}` : ""}` : "Waiting for your approval", done: approved },
    { t: "Sent to their bank", d: sent ? "Left your account. Waiting for the bank to confirm." : "Next, once approved", done: sent },
    { t: "Paid", d: paid ? `Their bank confirmed${t.updatedAt ? `, ${time(t.updatedAt)}` : ""}` : "We mark it paid when the bank confirms", done: paid },
  ];
  const now = steps.findIndex((s) => !s.done);
  return `<ol class="z-timeline">${steps.map((s, i) => `<li class="${s.done ? "is-done" : i === now ? "is-now" : ""}">
      <span class="z-timeline__mark" aria-hidden="true">${s.done ? Z.icon("check") : ""}</span>
      <span class="z-timeline__main"><span class="z-timeline__title">${esc(s.t)}<span class="z-sr">${s.done ? ", done" : i === now ? ", in progress" : ", not yet"}</span></span><span class="z-timeline__sub">${esc(s.d)}</span></span></li>`).join("")}</ol>`;
}

PH["send/progress"] = {
  title: "Payment progress",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? `${t.state}|${t.sepa?.state}` : "none"; },
  html(id) {
    const t = hist.find((x) => x.id === id);
    if (!t) return `${phTop("", "home")}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    if (["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state)) return PH["send/error"].html(id);
    return `${Z.topbar({ srTitle: "Payment progress", back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <div>${Z.tag(phTxWord(t))}${phBalanceFig(t.sendEur)}<p class="z-sub">to ${esc(t.recipientName || "")}</p></div>
      <div aria-live="polite">${phTimeline(t)}</div>
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        { key: "Payment ID", value: t.id, mono: true },
        ...(t.sepa?.orderId ? [{ key: "Monerium order", value: t.sepa.orderId, mono: true }, { key: "Order state", value: t.sepa.state || "" }] : []),
      ])}</details>
    `)}${phFoot(`<div class="z-pair">${t.state !== "CREATED" ? Z.button({ icon: "ios_share", label: "Share receipt", href: phHref("share", t.id) }) : ""}${Z.button({ variant: "primary", label: "Done", href: "#home", className: t.state === "CREATED" ? "z-btn--full" : "" })}</div>`)}`;
  },
  bind(root, id) {
    if (!hist.some((x) => x.id === id) && id) {
      api(`/api/transfers/${encodeURIComponent(id)}`).then((t) => { phPutTransfer(t); phRender(); }).catch(() => {});
    }
  },
};

/* Nothing was sent, or we do not know yet: words from the real state. */
PH["send/error"] = {
  title: "Payment not sent",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? t.state : "none"; },
  html(id) {
    const t = hist.find((x) => x.id === id) || {};
    const review = t.state === "MANUAL_REVIEW";
    const refunded = t.state === "REFUNDED";
    // FAILED after money left the Safe is on its way back (the server
    // compensates it); FAILED before that moved nothing.
    const returning = t.state === "FAILED" && (t.txs || []).some((x) => x.hash);
    const title = review ? "We’re checking this payment" : returning ? "This payment failed" : "Nothing was sent";
    const lede = review
      ? "We can’t tell yet whether it reached the bank, so nothing is refunded automatically. Write to support@zoldhq.com and we’ll look into it."
      : refunded ? `It was refused, and ${phEur(t.refund?.amountEur ?? t.sendEur)} is back in your account.`
        : returning ? "The money that left your account is being returned. It shows as refunded once it is back."
          : phSend.error || t.error || "The payment was stopped before any money left your account.";
    const word = review ? "IN REVIEW" : refunded ? "REFUNDED" : t.state === "FAILED" ? "FAILED" : null;
    const sub = review ? "outcome not known yet" : refunded ? "refunded" : returning ? "being returned" : "not debited";
    return `${Z.topbar({ srTitle: title, back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon(review ? "hourglass_top" : "sync_problem")}</span>
      <div class="z-intro"><h2 class="z-title">${esc(title)}</h2><p class="z-sub">${esc(lede)}</p></div>
      ${t.recipientName ? `<div class="z-card">${Z.row({ lead: Z.avatar({ name: t.recipientName }), title: t.recipientName, sub: `${phEur(t.sendEur)} · ${sub}`, right: word ? Z.tag(word) : "" })}</div>` : ""}
    `)}${phFoot(review
      ? Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" })
      : `${Z.button({ variant: "primary", full: true, label: "Review again", id: "ph-again" })}<a class="z-link-btn" href="#home">Back to Home</a>`)}`;
  },
  bind(root, id) {
    const b = root.querySelector("#ph-again");
    if (!b) return;
    b.onclick = () => {
      const t = hist.find((x) => x.id === id);
      // A new approval needs a new price: back to the amount, filled in.
      if (t?.recipientIban) phSend.payee = { name: t.recipientName, iban: String(t.recipientIban).replace(/\s+/g, "").toUpperCase() };
      if (t?.sendEur) phSend.amount = String(t.sendEur);
      if (t?.reference) phSend.reference = t.reference;
      phSend.error = null;
      phGo("send/amount", "new");
    };
  },
};

/* ==========================================================================
   Add money
   ========================================================================== */

PH.add = {
  title: "Add money",
  tab: "home",
  html() {
    const rows = [];
    if (HAS("monerium")) rows.push(Z.row({ lead: Z.iconTile({ icon: "account_balance", tone: "p" }), title: "Bank transfer", sub: "To your IBAN, from any bank in Europe", href: "#account-details" }));
    if (HAS("onchain_balance")) rows.push(Z.row({ lead: Z.iconTile({ icon: "account_balance_wallet", tone: "p" }), title: "Crypto wallet", sub: "Digital dollars (USDC) from any wallet or exchange", right: Z.tag("Beta"), href: "#add/wallet" }));
    rows.push(Z.soonRow({ lead: Z.iconTile({ icon: "attach_money" }), title: "USD account", sub: "ACH and wire in" }));
    return `${phTop("Add money")}${phMain(`<p class="z-sub">Both land in the same account.</p>${Z.listGroup({ rows })}${phFaucetCard()}`)}`;
  },
  bind(root) {
    const b = root.querySelector("#ph-faucet");
    if (!b) return;
    b.onclick = async () => {
      const err = root.querySelector("#ph-faucet-err");
      err.hidden = true;
      b.disabled = true;
      try {
        const r = await api(`/api/users/${user.id}/faucet`, {});
        if (r.user) user = r.user;
        Z.announce(`${phEur(r.grantedEur)} test EURe sent.`);
        phRender();
      } catch (e) {
        err.textContent = e?.message || "The test faucet could not send.";
        err.hidden = false;
        b.disabled = false;
      }
    };
  },
};

/* The testnet faucet: only where /api/health offers one (never on a chain
   where EURe is real money), once per account, after the Safe exists. The
   grant is a real token transfer on the test chain, so it shows in Activity
   like any deposit. */
function phFaucetCard() {
  const grant = caps.faucetEur || 0;
  const tokens = caps.faucetTokens || [];
  if (user?.passkeySafe?.status !== "active" || (!grant && !tokens.length)) return "";
  // The public faucet page funds any address, this account's included, and a
  // test payer's own wallet for paying an invoice or a link.
  const more = tokens.length
    ? Z.note({ icon: "water_drop", html: `More test tokens (${esc(tokens.join(", "))}), for this account or a payer’s wallet: <a href="/faucet?address=${encodeURIComponent(user.address)}" target="_blank" rel="noopener">open the faucet</a>` })
    : "";
  if (!grant || user.faucet?.txHash) {
    return `${grant ? Z.note({ icon: "science", text: `This account received its ${phEur(user.faucet.grantedEur)} of test EURe.` }) : ""}${more}`;
  }
  return `<div class="z-card">
      ${Z.row({ lead: Z.iconTile({ icon: "science", tone: "p" }), title: "Test EURe", sub: `${phEur(grant)} to try the app with. Test chain only, not real money.`, right: Z.tag("Testnet") })}
      ${Z.button({ variant: "primary", full: true, label: `Get ${phEur(grant)} test EURe`, id: "ph-faucet" })}
      <p class="z-err" id="ph-faucet-err" role="alert" hidden></p>
    </div>${more}`;
}

PH["add/wallet"] = {
  title: "From a crypto wallet",
  live: () => JSON.stringify([phCache.deposits?.map((d) => `${d.id}:${d.state}`), user?.paymentPage?.handle, phCache.settlementAsset, phCache.autoConvert]),
  html() {
    const u = user || {};
    const page = u.paymentPage || {};
    // Always the Safe itself: the payment page's address may be a forwarder,
    // and one screen never shows two addresses (or a QR of another one).
    const address = u.passkeySafe?.status === "active" ? u.address : "";
    const deps = phCache.deposits;
    const waiting = (deps || []).filter((d) => d.state === "DETECTED" && d.token === "USDC");
    // Refused by the poller, or submitted without a confirmed result. The
    // API does not say which, so these are shown with their reason and no
    // Convert button: a second try could spend other USDC in the account.
    const refused = (deps || []).filter((d) => d.state === "REFUSED" && d.token === "USDC");
    const asset = phCache.settlementAsset || page.settlementAsset;
    const autoConvert = phCache.autoConvert ?? page.autoConvert;
    const change = page.handle ? ` <a href="#settings/currency/wallet">Change</a>` : "";
    return `${phTop("From a crypto wallet", "add", Z.tag("Beta"))}${phMain(`
      ${address ? `<div class="z-qr"><img id="ph-wallet-qr" ${phCache.walletQr?.key === `${u.id}:${address}` ? `src="${phCache.walletQr.url}"` : "hidden"} width="168" height="168" alt="QR code of your wallet address"></div>` : ""}
      ${address ? `<div class="z-card">${Z.copyRow({ label: "Your wallet address", value: address, mono: true })}</div>`
        : Z.note({ tone: "a", text: "Your account is not set up yet, so it has no wallet address." })}
      ${Z.note({ tone: "a", text: "Only USDC on the Base network. Anything else sent here is lost." })}
      ${!address ? "" : caps.paymentPageForwarding
        ? Z.note({ icon: "link", html: page.handle
          ? `Your payment page takes more tokens from other chains. <a href="/pay/${encodeURIComponent(page.handle)}" target="_blank" rel="noopener">See the list</a>`
          : `Set up a payment page to take more tokens from other chains. <a href="#get-paid/page">Set it up</a>` })
        : page.handle ? "" : Z.note({ icon: "link", html: `Set up a payment page: a link and QR anyone can pay. <a href="#get-paid/page">Set it up</a>` })}
      ${Z.note({ icon: "currency_exchange", html: `${asset === "USDC" || !autoConvert
        ? "Digital dollars that arrive stay as USDC."
        : "Your main currency is euro, so we ask before converting dollars."}${change}` })}
      ${deps === null ? Z.skeletonRows(1, "Loading payments…") : Z.listGroup({
        label: "Waiting to convert",
        rows: waiting.map((d) => `<div class="z-row">${Z.iconTile({ icon: "currency_exchange", tone: "m" })}<span class="z-row__main"><span class="z-row__title z-fig">${esc(Z.formatMoney(d.amountUsdc ?? 0, "USDC"))}</span><span class="z-row__sub">Arrived ${esc(phDay(d.detectedAt))}${d.receipt ? ` · worth ${esc(phEur(d.receipt.amountEur))} then` : ""}</span></span><span class="z-row__right"><a class="z-btn z-btn--primary z-btn--sm" href="${phHref("convert", d.id)}" aria-label="Convert ${esc(Z.formatMoney(d.amountUsdc ?? 0, "USDC"))}">Convert</a></span></div>`),
        empty: { text: "Nothing waiting. Payments show up here within a minute of arriving." },
      })}
      ${refused.length ? Z.listGroup({
        label: "Not converted",
        rows: refused.map((d) => Z.row({
          lead: Z.iconTile({ icon: "currency_exchange" }),
          title: Z.formatMoney(d.amountUsdc ?? 0, "USDC"),
          // The reason is the server's wording (it says EURe); plain words here.
          sub: `Arrived ${phDay(d.detectedAt)}. Not converted: check your balance, or write to support@zoldhq.com.`,
          right: Z.tag("IN REVIEW"),
        })),
      }) : ""}
    `)}`;
  },
  bind(root) {
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "add/wallet") phRender(); });
    const img = root.querySelector("#ph-wallet-qr");
    if (img?.hidden) phLoadWalletQr(img);
  },
};

/* The wallet QR route is signed-in only, and an <img> request carries no
   bearer header, so the SVG is fetched with the session and shown from a
   blob URL. Kept per user and address so a redraw does not refetch. */
async function phLoadWalletQr(img) {
  const key = `${user.id}:${user.address}`;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/address/qr.svg`, {
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    if (phCache.walletQr) URL.revokeObjectURL(phCache.walletQr.url);
    phCache.walletQr = { key, url };
    if (img.isConnected) { img.src = url; img.hidden = false; }
  } catch {
    // No QR is better than a broken image; the address is copyable below it.
  }
}

async function phLoadDeposits() {
  if (!user?.id) return;
  try {
    const d = await api(`/api/users/${user.id}/crypto-deposits`);
    phCache.deposits = d.deposits || [];
    phCache.settlementAsset = d.settlementAsset;
    phCache.autoConvert = d.autoConvert;
  } catch {
    phCache.deposits = phCache.deposits || [];
  }
}

/* ==========================================================================
   Digital dollars to euros
   --------------------------------------------------------------------------
   What the API does, and so what these screens may say:
   - Nothing converts without the holder's Face ID or fingerprint. The poller
     spots a payment to the page and leaves it waiting (DETECTED) only when
     the page settles in euros and "ask me" (autoConvert) is on.
   - Otherwise the poller settles the payment as USDC, and a payment settled
     as USDC cannot be converted through this route later. That includes
     payments already waiting when the setting changes.
   - The price is a quote with a floor (minEur). What arrives is measured
     (creditedEur) and is the only euro figure called "arrived".
   - "Your dollars didn't move" is said only for a refusal the server gave
     before it submitted anything. A 502, a 503 (also what the service worker
     answers offline), a lost connection or a REFUSED deposit after submitting
     can each hide a swap that landed, so those say "not confirmed".
   ========================================================================== */

/* The open conversion: its price, and the outcome of the last approval. */
const phConv = { id: null, prep: null, error: null, pricing: false, refusal: null, priced: null };

const phUsdc = (n) => Z.formatMoney(n ?? 0, "USDC");
const phDeposit = (id) => (phCache.deposits || []).find((d) => d.id === id) || null;
/* A price the server still holds. Its expiry is the server's, not ours. */
const phPriceLive = (id) => phConv.id === id && phConv.prep && Date.parse(phConv.prep.expiresAt) > Date.now();
const phRate = (p) => (p.amountUsdc ? p.expectedEur / p.amountUsdc : 0);

/* The main currency, in the words of the Settings row. */
function phCurrencyWords(page) {
  if (!page?.handle) return "Set up your page first";
  if (page.settlementAsset === "USDC") return "Digital dollars (USDC)";
  return page.autoConvert ? "Euro, ask before converting dollars" : "Euro, keep dollars as USDC";
}

PH["settings/currency"] = {
  title: "Main currency",
  live: () => JSON.stringify([user?.paymentPage?.settlementAsset, user?.paymentPage?.autoConvert, phCache.deposits?.filter((d) => d.state === "DETECTED").length]),
  html(from) {
    const page = user?.paymentPage;
    const back = from === "wallet" ? "add/wallet" : "settings";
    if (!page?.handle) {
      return `${phTop("Main currency", back)}${phMain(`
        <p class="z-sub">Your main currency decides what happens when someone pays your page in digital dollars (USDC).</p>
        ${Z.note({ text: "It applies to your page, so set that up first." })}
        ${Z.button({ variant: "primary", full: true, label: "Set up your page", href: "#get-paid/page" })}`)}`;
    }
    const usdc = page.settlementAsset === "USDC";
    const pending = phCache.currencyPending;       // a "keep" choice waiting for confirmation
    const ask = pending ? false : !!page.autoConvert;
    const waiting = (phCache.deposits || []).filter((d) => d.state === "DETECTED").length;
    const choice = (name, value, checked, title, text) =>
      `<label class="z-choice"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}><span class="z-choice__main"><span class="z-choice__title">${esc(title)}</span><span class="z-choice__text">${esc(text)}</span></span></label>`;
    const waitingWord = waiting === 1 ? "1 payment is" : `${waiting} payments are`;
    return `${phTop("Main currency", back)}${phMain(`
      <p class="z-sub">Pick what your account keeps when someone pays you in digital dollars (USDC).</p>
      <fieldset class="z-fieldset" id="ph-cur-main" aria-describedby="ph-cur-err">
        <legend class="z-eyebrow">Keep my money in</legend>
        <div class="z-choices">
          ${choice("main", "EURE", !usdc && pending !== "USDC", "Euros", "Your balance stays in euros. Below, pick what happens to dollar payments.")}
          ${choice("main", "USDC", usdc || pending === "USDC", "Digital dollars (USDC)", "Dollar payments stay as dollars. Nothing is converted.")}
        </div>
      </fieldset>
      ${usdc || pending === "USDC" ? "" : `<fieldset class="z-fieldset" id="ph-cur-ask">
        <legend class="z-eyebrow">When dollars arrive</legend>
        <div class="z-choices">
          ${choice("ask", "ask", ask, "Ask me to convert", "We spot the payment and show you the price. It converts only after you approve with Face ID or fingerprint.")}
          ${choice("ask", "keep", !ask, "Keep them as dollars", "They stay as USDC in your account.")}
        </div>
      </fieldset>`}
      ${pending ? `<div class="z-confirm" role="group" aria-labelledby="ph-cur-warn">
          ${Z.note({ tone: "a", icon: "warning", html: `<span id="ph-cur-warn">${esc(waitingWord)} waiting to convert. ${waiting === 1 ? "It stays" : "They stay"} as USDC too, and can’t be converted here later.</span>` })}
          <div class="z-pair">${Z.button({ label: "Cancel", id: "ph-cur-cancel" })}${Z.button({ variant: "primary", label: "Keep as dollars", id: "ph-cur-confirm" })}</div>
        </div>` : ""}
      <p class="z-err" id="ph-cur-err" role="alert" hidden></p>
      ${Z.note({ text: "This covers dollar payments to your page and your payment links. Zold charges no fee for converting." })}
    `)}`;
  },
  bind(root) {
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "settings/currency") phRender(); });
    const save = async (change) => {
      root.querySelector("#ph-cur-err").hidden = true;
      // One change at a time: the controls wait for the answer.
      root.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
      try {
        const current = user.paymentPage;
        if (change.settlementAsset && change.settlementAsset !== current.settlementAsset) {
          // The page's own route stores the asset. Same name and display
          // name, so the page and its wallet address stay as they are.
          const r = await api(`/api/users/${user.id}/handle`, {
            handle: current.handle,
            ...(current.displayName ? { displayName: current.displayName } : {}),
            settlementAsset: change.settlementAsset,
          });
          user.paymentPage = r.paymentPage;
        }
        if (change.autoConvert !== undefined && change.autoConvert !== !!user.paymentPage.autoConvert) {
          const u = await api(`/api/users/${user.id}/auto-convert`, { enabled: change.autoConvert });
          if (u.paymentPage) user.paymentPage = u.paymentPage;
        }
        phCache.currencyPending = null;
        await phLoadDeposits();
        Z.announce("Saved.");
        phRender();
      } catch (e) {
        // Redraw from what the server holds, then say why it refused.
        phCache.currencyPending = null;
        phRender();
        const el = $("ph-root").querySelector("#ph-cur-err");
        el.textContent = e.message;
        el.hidden = false;
      }
    };
    const waiting = () => (phCache.deposits || []).filter((d) => d.state === "DETECTED").length;
    root.querySelectorAll('input[name="main"]').forEach((i) => {
      i.onchange = () => {
        if (i.value === "USDC" && waiting() > 0) { phCache.currencyPending = "USDC"; return phRender(); }
        save({ settlementAsset: i.value });
      };
    });
    root.querySelectorAll('input[name="ask"]').forEach((i) => {
      i.onchange = () => {
        if (i.value === "keep" && waiting() > 0) { phCache.currencyPending = "keep"; return phRender(); }
        save({ autoConvert: i.value === "ask" });
      };
    });
    const cancel = root.querySelector("#ph-cur-cancel");
    if (cancel) cancel.onclick = () => { phCache.currencyPending = null; phRender(); };
    const confirm = root.querySelector("#ph-cur-confirm");
    if (confirm) confirm.onclick = () => save(phCache.currencyPending === "USDC" ? { settlementAsset: "USDC" } : { autoConvert: false });
  },
};

/* Review the price for one payment, and approve it. */
PH.convert = {
  title: "Convert to euros",
  live: (id) => { const d = phDeposit(id); return `${phCache.deposits === null}|${d?.state}|${phConv.id === id ? phConv.prep?.challenge || phConv.error || "" : ""}`; },
  html(id) {
    const top = phTop("Convert to euros", "add/wallet", Z.tag("Beta"));
    if (phCache.deposits === null) return `${top}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    const d = phDeposit(id);
    if (!d || d.token !== "USDC" || d.state !== "DETECTED") {
      const text = !d ? "We can’t find this payment in your account."
        : d.state === "CONVERTED" ? (d.settlementAsset === "EURE" ? "This payment is already converted." : "This payment was kept as USDC.")
          : "This payment isn’t waiting to convert.";
      return `${top}${phMain(`${Z.note({ text })}${Z.button({ variant: "primary", full: true, label: "Back to your wallet", href: "#add/wallet" })}`)}`;
    }
    const from = `Arrived ${phDay(d.detectedAt)}, in digital dollars`;
    const p = phConv.id === id ? phConv.prep : null;
    const head = `<div class="z-card">${Z.row({ lead: Z.iconTile({ icon: "currency_exchange", tone: "m" }), title: `${phUsdc(d.amountUsdc)} received`, sub: from })}</div>`;
    if (!p) {
      const e = phConv.id === id ? phConv.error : null;
      return `${top}${phMain(`${head}${e
        ? `${Z.note({ tone: "a", text: e })}`
        : Z.skeletonRows(4, "Getting a price…")}`)}${e ? phFoot(`${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Try again", id: "ph-conv-retry" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`) : ""}`;
    }
    const expired = !phPriceLive(id);
    return `${top}${phMain(`
      ${head}
      <section class="z-card z-conv" aria-label="The price">
        <div><p class="z-conv__label">You convert</p><p class="z-conv__usdc z-fig">${esc(Z.formatMoney(p.amountUsdc, "USDC").replace(/\s*USDC$/, ""))}<span class="z-conv__unit">USDC</span></p></div>
        <div class="z-conv__arrow" aria-hidden="true">${Z.icon("arrow_downward")}<span></span></div>
        <div><p class="z-conv__label">You get about</p>${phBalanceFig(p.expectedEur)}</div>
      </section>
      ${Z.kv([
        { key: "Rate", value: `1 USDC = €${phRate(p).toFixed(4)}` },
        { key: "Zold fee", value: phEur(0) },
        { key: "At least", hint: "Or nothing converts", valueHtml: `<strong>${esc(phEur(p.minEur))}</strong>` },
        { key: "Price holds for", valueHtml: `<span id="ph-conv-left">${expired ? "Expired" : esc(phLeft(p.expiresAt))}</span>` },
      ])}
      ${Z.note({ icon: "verified_user", text: `If less than ${phEur(p.minEur)} would arrive, nothing converts and your dollars stay where they are. We credit what actually arrives.` })}
      <p class="z-err" id="ph-conv-err" role="alert" hidden></p>
    `)}${phFoot(`${expired
      ? Z.button({ variant: "primary", full: true, icon: "refresh", label: "Get a new price", id: "ph-conv-retry" })
      : Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Convert with Face ID", id: "ph-conv-go" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`)}`;
  },
  bind(root, id) {
    if (phCache.deposits === null) {
      phLoadDeposits().then(() => { if (phRoute?.name === "convert" && phRoute.arg === id) phRender(); });
      return;
    }
    const d = phDeposit(id);
    if (d?.state === "CONVERTED" && d.settlementAsset === "EURE") return phGo("convert/done", id, { replace: true });
    if (!d || d.state !== "DETECTED") return;
    if (!phConv.pricing && (phConv.id !== id || (!phConv.prep && !phConv.error))) phPrice(id);
    const retry = root.querySelector("#ph-conv-retry");
    if (retry) retry.onclick = () => phPrice(id, retry);
    const go = root.querySelector("#ph-conv-go");
    if (go) go.onclick = () => phConvert(id, go, root.querySelector("#ph-conv-err"));
    phTick(id);
  },
};

/* "14:32" left on the price, or "15 minutes" when it has just been given. */
function phLeft(iso) {
  const s = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
  if (s >= 14 * 60 + 55) return `${Math.round(s / 60)} minutes`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
let phTickTimer = null;
function phTick(id) {
  clearInterval(phTickTimer);
  phTickTimer = setInterval(() => {
    const el = document.getElementById("ph-conv-left");
    if (!el || phRoute?.name !== "convert" || phRoute.arg !== id || !phConv.prep) return clearInterval(phTickTimer);
    if (!phPriceLive(id)) { clearInterval(phTickTimer); return phRender(); }
    el.textContent = phLeft(phConv.prep.expiresAt);
  }, 1000);
}

/* Ask for a price. Nothing is signed here; a refusal names its reason. */
async function phPrice(id, btn) {
  if (btn) Z.setLoading(btn, true);
  Object.assign(phConv, { id, prep: null, error: null, pricing: true, refusal: null });
  try {
    const p = await api(`/api/users/${user.id}/crypto-deposits/${encodeURIComponent(id)}/convert/prepare`, {});
    if (phConv.id !== id) return;
    phConv.prep = p;
  } catch (e) {
    if (phConv.id !== id) return;
    // The server's own words, which name what to do; its dashes read as commas here.
    const why = String(e.message || "").replace(/\s*—\s*/g, ", ").replace(/\.$/, "");
    phConv.error = e.status === 409
      ? `This payment can’t be converted: ${why}.`
      : `No price right now, so nothing was converted. ${why}.`;
  } finally {
    if (phConv.id === id) phConv.pricing = false;
  }
  if (phRoute?.name === "convert" && phRoute.arg === id) phRender({ focus: false });
}

/**
 * Approve the price. Face ID or fingerprint signs the Safe operation that
 * swaps this payment's USDC into euros in the user's own Safe.
 */
async function phConvert(id, btn, errEl) {
  if (Z.isDisabled(btn)) return;
  const p = phConv.prep;
  if (!p || !phPriceLive(id)) return phRender();
  errEl.hidden = true;
  Z.setLoading(btn, true);
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(p.challenge),
        rpId: location.hostname,
        allowCredentials: p.credentialId ? [{ type: "public-key", id: b64urlToBytes(p.credentialId) }] : [],
        userVerification: "required",
      },
    });
    if (!assertion) throw new Error("No response from Face ID or fingerprint.");
  } catch (e) {
    // Nothing has been sent to the server yet: the payment is where it was.
    Z.setLoading(btn, false);
    errEl.textContent = e?.name === "NotAllowedError" ? "Face ID or fingerprint was cancelled. Nothing was converted." : e.message;
    errEl.hidden = false;
    return;
  }
  phConv.priced = { id, expectedEur: p.expectedEur, minEur: p.minEur };
  try {
    const out = await api(`/api/users/${user.id}/crypto-deposits/${encodeURIComponent(id)}/convert`, {
      executionAssertion: {
        credentialId: p.credentialId,
        authenticatorData: b64url(assertion.response.authenticatorData),
        clientDataJSON: b64url(assertion.response.clientDataJSON),
        signature: b64url(assertion.response.signature),
      },
    });
    phConv.prep = null;
    if (out.safeBalanceEur !== undefined) {
      user.safeBalanceEur = out.safeBalanceEur;
      user.balanceEur = out.balanceEur ?? out.safeBalanceEur;
    }
    await phLoadDeposits();
    renderUser(user);
    const d = phDeposit(id) || out.deposit;
    phGo(d?.state === "CONVERTED" && d.settlementAsset === "EURE" ? "convert/done" : "convert/check", id, { replace: true });
  } catch (e) {
    phConv.prep = null;
    // 400, 401, 403 and 409 are answered before the operation is submitted,
    // and the service worker never makes them up: nothing moved.
    if ([400, 401, 403, 409].includes(e.status)) {
      phConv.refusal = { id, expired: e.status === 409 };
      await phLoadDeposits();
      return phGo("convert/refused", id, { replace: true });
    }
    await phLoadDeposits();
    phGo("convert/check", id, { replace: true });
  }
}

/* Converted: what arrived, measured, never the price that was shown. */
PH["convert/done"] = {
  title: "Converted to euros",
  live: (id) => `${phCache.deposits === null}|${phDeposit(id)?.state}`,
  html(id) {
    const d = phDeposit(id);
    const top = Z.topbar({ srTitle: "Converted to euros", back: { href: "#home", label: "Back to Home" } });
    if (phCache.deposits === null) return `${top}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    if (!d || d.state !== "CONVERTED" || d.settlementAsset !== "EURE" || typeof d.creditedEur !== "number") {
      return `${top}${phMain(`${Z.note({ text: "This payment isn’t converted to euros." })}${Z.button({ variant: "primary", full: true, label: "Back to your wallet", href: "#add/wallet" })}`)}`;
    }
    const shown = phConv.priced?.id === id ? phConv.priced : null;
    const diff = shown ? Math.round((shown.expectedEur - d.creditedEur) * 100) / 100 : 0;
    const why = !shown || Math.abs(diff) < 0.01 ? ""
      : diff > 0
        ? `${phEur(diff)} less than the price shown, because markets move while it converts. It stayed above your ${phEur(shown.minEur)} floor. Your records use the ${phEur(d.creditedEur)} that arrived.`
        : `${phEur(-diff)} more than the price shown, because markets move while it converts. The extra is yours. Your records use the ${phEur(d.creditedEur)} that arrived.`;
    return `${top}${phMain(`
      <div>${Z.tag("RECEIVED")}<p class="z-balance__fig z-balance__fig--in z-fig"><span class="z-balance__cur">+€</span>${esc(phEur(d.creditedEur).replace(/^€/, ""))}</p><p class="z-sub">Now in euros in your account.</p></div>
      ${Z.kv([
        { key: "Converted", value: phUsdc(d.amountUsdc) },
        ...(shown ? [{ key: "Price shown", value: `about ${phEur(shown.expectedEur)}` }] : []),
        { key: "Arrived", valueHtml: `<strong>${esc(phEur(d.creditedEur))}</strong>` },
      ])}
      ${why ? Z.note({ text: why }) : ""}
      ${d.conversion?.txHash || d.provider ? `<details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        ...(d.provider ? [{ key: "Converted by", value: d.provider }] : []),
        ...(d.conversion?.txHash ? [{ key: "Transaction", value: d.conversion.txHash, mono: true }] : []),
      ])}</details>` : ""}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Done", href: "#home" }))}`;
  },
  bind(root, id) {
    if (phCache.deposits === null || !phDeposit(id)) phLoadDeposits().then(() => { if (phRoute?.name === "convert/done") phRender(); });
  },
};

/* Refused before anything was submitted: the dollars did not move. Only
   reachable straight from an approval; a reload goes back to the price. */
PH["convert/refused"] = {
  title: "Nothing was converted",
  html(id) {
    const r = phConv.refusal?.id === id ? phConv.refusal : null;
    const d = phDeposit(id);
    const top = Z.topbar({ srTitle: "Nothing was converted", back: { href: "#add/wallet", label: "Back to your wallet" } });
    if (!r) return `${top}${phMain(Z.skeletonRows(2, "Loading the payment…"))}`;
    const lede = r.expired
      ? "The price ran out before your approval reached us, so we stopped. Your dollars didn’t move."
      : "We stopped before anything was sent. Your dollars didn’t move.";
    return `${top}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("currency_exchange")}</span>
      <div class="z-intro"><h2 class="z-title">Nothing was converted</h2><p class="z-sub">${esc(lede)}</p></div>
      ${d ? `<div class="z-card z-held"><p class="z-held__main"><span class="z-held__label">Still in your account</span><span class="z-held__fig z-fig">${esc(phUsdc(d.amountUsdc))}</span></p>${Z.iconTile({ icon: "account_balance_wallet" })}</div>` : ""}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([{ key: "Payment ID", value: id, mono: true }])}</details>
    `)}${phFoot(`${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Get a new price", id: "ph-conv-new" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`)}`;
  },
  bind(root, id) {
    if (phConv.refusal?.id !== id) return phGo("convert", id, { replace: true });
    const b = root.querySelector("#ph-conv-new");
    if (b) b.onclick = () => { Object.assign(phConv, { id: null, prep: null, error: null, refusal: null }); phGo("convert", id, { replace: true }); };
  },
};

/* Submitted, but the outcome is not known. Says nothing about the dollars. */
PH["convert/check"] = {
  title: "Conversion not confirmed",
  live: (id) => `${phCache.deposits === null}|${phDeposit(id)?.state}`,
  html(id) {
    const d = phDeposit(id);
    return `${Z.topbar({ srTitle: "Conversion not confirmed", back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("hourglass_top")}</span>
      <div class="z-intro"><h2 class="z-title">We couldn’t confirm this conversion</h2><p class="z-sub">Your approval was sent, but no clear result came back, so we can’t say yet whether it converted. Check your balance in a few minutes. If it still isn’t clear, write to support@zoldhq.com.</p></div>
      ${d ? `<div class="z-card">${Z.row({ lead: Z.iconTile({ icon: "currency_exchange" }), title: phUsdc(d.amountUsdc), sub: `Arrived ${phDay(d.detectedAt)}`, right: Z.tag("IN REVIEW") })}</div>` : ""}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([{ key: "Payment ID", value: id, mono: true }])}</details>
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" }))}`;
  },
  bind(root, id) {
    const d = phDeposit(id);
    // The swap landed after all: say so with the measured figure.
    if (d?.state === "CONVERTED" && d.settlementAsset === "EURE") return phGo("convert/done", id, { replace: true });
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "convert/check") phRender(); });
  },
};

/* ==========================================================================
   Get paid
   ========================================================================== */

const PH_GP_TABS = [["get-paid", "Links"], ["get-paid/details", "Account details"], ["get-paid/page", "Your page"]];
const phTabs = (active) => `<nav class="z-pills" aria-label="Get paid">${PH_GP_TABS.map(([r, l]) => `<a class="z-pill" href="#${r}" aria-current="${r === active ? "page" : "false"}">${esc(l)}</a>`).join("")}</nav>`;

async function phLoadLinks() {
  try {
    const d = await api(`/api/users/${user.id}/payment-requests`);
    phCache.links = d.requests || [];
    phCache.methods = d.methods || [];
  } catch (e) {
    phCache.links = phCache.links || [];
    phCache.linksError = e.message;
  }
}

function phLinkWord(r) {
  return { OPEN: ["OPEN"], PAID: ["PAID"], EXPIRED: ["Expired", "dim"], CANCELLED: ["Closed", "dim"] }[r.state] || [r.state, "dim"];
}
function phLinkSub(r) {
  const amt = r.amountEur == null ? "Any amount" : phEur(r.amountEur);
  if (r.state === "PAID") return `${amt} · paid ${phDay(r.paidAt || r.updatedAt)}`;
  if (r.state === "OPEN") {
    const days = Math.ceil((new Date(r.expiresAt) - Date.now()) / 86400000);
    return `${amt} · ${days > 1 ? `expires in ${days} days` : "expires today"}`;
  }
  return amt;
}

/* The button says what the plan allows, in the plan's own words. Invoices on
   the phone are the personal account's; a company's are in the web app. */
function phInvoiceButton() {
  if (phCache.orgs === null) return Z.button({ icon: "receipt_long", label: "Invoice", disabledReason: "Checking your plan…" });
  if (phCan(phPersonalOrg(), "invoices")) return Z.button({ icon: "receipt_long", label: "Invoice", href: "#invoice/new" });
  const org = (phCache.orgs || []).find((o) => phCan(o, "invoices"));
  if (org) return Z.button({ icon: "receipt_long", label: "Invoice", href: "/business" });
  const reason = phPersonalOrg()?.capabilities?.invoices?.reason || "Invoices are not part of this account.";
  return Z.button({ icon: "receipt_long", label: "Invoice", disabledReason: reason });
}

PH["get-paid"] = {
  title: "Get paid",
  tab: "get-paid",
  live: () => JSON.stringify([phCache.links?.map((r) => `${r.id}:${r.state}`), phCache.orgs === null]),
  html() {
    const links = phCache.links;
    return `${phTop("Get paid")}${phMain(`
      ${phTabs("get-paid")}
      <div class="z-pair">
        ${Z.button({ variant: "primary", icon: "add_link", label: "Payment link", href: "#link/new" })}
        ${phInvoiceButton()}
      </div>
      ${links === null ? Z.skeletonRows(3, "Loading your links…") : `<section class="z-group">
        <div class="z-group__head"><h2 class="z-eyebrow">Your links</h2>${Z.tag("Beta")}</div>
        <ul class="z-list z-card">${links.length ? links.map((r) => { const [w, tone] = phLinkWord(r); return `<li>${Z.row({
          lead: Z.iconTile({ icon: "link", tone: r.state === "OPEN" ? "p" : "n" }), title: r.description || "Any amount", sub: phLinkSub(r), right: Z.tag(w, tone), href: phHref("link", r.id),
        })}</li>`; }).join("") : `<li><div class="z-row z-row--empty"><span>No links yet. A link asks for an amount and shows how to pay it.</span></div></li>`}</ul></section>`}
      ${phCache.linksError ? Z.note({ tone: "a", text: phCache.linksError }) : ""}
    `)}`;
  },
  bind() {
    if (phCache.links === null) phLoadLinks().then(() => { if (phRoute?.name === "get-paid") phRender(); });
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "get-paid") phRender(); });
  },
};

PH["get-paid/details"] = {
  title: "Get paid",
  tab: "get-paid",
  html() {
    const u = user || {};
    const known = phCache.bicFor === u.iban && phCache.bic !== undefined;
    return `${phTop("Get paid")}${phMain(`${phTabs("get-paid/details")}<div id="ph-gp-details" class="z-stack">${phDetailsBody(u, known ? phCache.bic : null, { loadingBic: !!u.iban && kycApproved(u) && !known })}</div>`)}`;
  },
  bind(root) {
    phBindDetails(root);
    const u = user || {};
    if (u.iban && kycApproved(u) && !(phCache.bicFor === u.iban && phCache.bic !== undefined)) {
      phLoadBic().then(() => {
        const el = $("ph-gp-details");
        if (!el) return;
        el.innerHTML = phDetailsBody(user, phCache.bic);
        phBindDetails(el);
      });
    }
  },
};

/* What the page's address takes, as the API read it from the forwarder's
   routes at the last activation. */
function phAcceptsList(page) {
  const list = page?.supportedTokens || [];
  if (!list.length) return "";
  const unitsOf = (raw, dec) => {
    const v = BigInt(raw), d = 10n ** BigInt(dec);
    const frac = (v % d).toString().padStart(dec, "0").replace(/0+$/, "");
    return `${v / d}${frac ? `.${frac}` : ""}`;
  };
  return Z.listGroup({
    label: "Your page takes",
    rows: list.map((t) => Z.row({
      lead: Z.iconTile({ icon: "currency_exchange" }),
      title: `${t.symbol} on ${t.chainName || phChainName(t.chainId)}`,
      sub: t.minAmount ? `At least ${unitsOf(t.minAmount, t.decimals)} ${t.symbol}` : "Arrives directly",
    })),
  });
}

function phChainName(id) {
  return { 1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis", 137: "Polygon", 8453: "Base", 42161: "Arbitrum", 84532: "Base Sepolia", 31337: "local chain" }[id] || `chain ${id}`;
}

PH["get-paid/page"] = {
  title: "Your page",
  tab: "get-paid",
  html() {
    const u = user || {};
    const page = u.paymentPage;
    const url = page?.handle ? `${location.host}/pay/${page.handle}` : "";
    const body = page?.handle
      ? `<div class="z-card z-page">
          <div class="z-page__head">${Z.avatar({ name: page.displayName || u.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(page.displayName || u.name || "")}</span><span class="z-row__sub z-mono" translate="no">${esc(url)}</span></span></div>
          <p class="z-hint">Anyone with this link can pay you in digital dollars (USDC). They see your name, never your balance. The page is public.</p>
        </div>
        ${phAcceptsList(page)}
        <div class="z-pair">
          ${Z.button({ icon: "tune", label: "Page settings", href: "#page-settings" })}
          ${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-page-share" })}
        </div>`
      : u.passkeySafe?.status !== "active"
        ? Z.note({ tone: "a", text: "Your page opens once your account is set up." })
        : `<form id="ph-claim" class="z-form" novalidate>
            <p class="z-sub">Pick the name for your page. People pay you at ${esc(location.host)}/pay/<em>name</em>.</p>
            ${Z.field({ id: "ph-handle", label: "Page name", name: "handle", autocomplete: "off", spellcheck: false, placeholder: "yourname…", maxlength: 30, hint: "Lower-case letters, numbers and hyphens." })}
            ${Z.button({ variant: "primary", full: true, label: "Create my page", type: "submit" })}
          </form>`;
    return `${phTop("Get paid")}${phMain(`${phTabs("get-paid/page")}${body}`)}`;
  },
  bind(root) {
    const share = root.querySelector("#ph-page-share");
    if (share) share.onclick = () => phShare("Pay me", "You can pay me here:", `${location.origin}/pay/${user.paymentPage.handle}`);
    const form = root.querySelector("#ph-claim");
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const input = root.querySelector("#ph-handle");
      const btn = form.querySelector('button[type="submit"]');
      Z.setFieldError(input, input.value.trim() ? "" : "Enter a name for your page.");
      if (Z.focusFirstError(form)) return;
      Z.setLoading(btn, true);
      try {
        const r = await api(`/api/users/${user.id}/handle`, {
          handle: input.value.trim().toLowerCase(),
          ...(user.paymentPage?.settlementAsset ? { settlementAsset: user.paymentPage.settlementAsset } : {}),
        });
        user.paymentPage = r.paymentPage;
        phRender({ focus: true });
      } catch (err) {
        Z.setLoading(btn, false);
        Z.setFieldError(input, err.message);
        input.focus();
      }
    };
  },
};

/* A new link, or one link. */
PH.link = {
  title: (id) => (id === "new" ? "New payment link" : "Payment link"),
  live: (id) => { const r = phCache.links?.find((x) => x.id === id); return r ? `${r.state}|${(r.payments || []).length}` : "none"; },
  html(id) {
    if (id === "new") {
      const methods = phCache.methods;
      if (methods === null) return `${phTop("New payment link", "get-paid")}${phMain(Z.skeletonRows(2, "Loading…"))}`;
      const can = (m) => !!methods.find((x) => x.method === m)?.available;
      const needs = methods.filter((m) => !m.available).map((m) => `${m.method === "crypto" ? "Digital dollars" : "Bank transfer"} opens once you ${m.needs}.`);
      const check = (idx, m, label) => `<label class="z-check"><input type="checkbox" id="${idx}" name="methods" value="${m}"${can(m) ? " checked" : " disabled"}><span>${esc(label)}</span></label>`;
      return `${phTop("New payment link", "get-paid", Z.tag("Beta"))}<form id="ph-link" class="z-app__form" novalidate>${phMain(`
        <div class="z-form">
          ${Z.field({ id: "ph-lk-amount", label: "Amount in euros", optional: true, name: "amount", inputmode: "decimal", autocomplete: "off", placeholder: "40.00…", hint: "Leave it empty and the payer chooses." })}
          ${Z.field({ id: "ph-lk-desc", label: "What it’s for", name: "description", autocomplete: "off", maxlength: 140, placeholder: "Concert tickets…" })}
          <fieldset class="z-fieldset"><legend class="z-label">Ways to pay</legend>
            ${check("ph-lk-bank", "bank", "Bank transfer, with the link’s code as reference")}
            ${check("ph-lk-crypto", "crypto", "Digital dollars (USDC) to your page")}
          </fieldset>
          ${needs.length ? Z.note({ text: needs.join(" ") }) : ""}
          <p class="z-err" id="ph-lk-err" role="alert" hidden></p>
        </div>
      `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Create link", type: "submit", ...(can("bank") || can("crypto") ? {} : { disabledReason: "No way to pay is open on this account yet." }) }))}</form>`;
    }
    const r = phCache.links?.find((x) => x.id === id);
    if (!r) return `${phTop("Payment link", "get-paid")}${phMain(phCache.links === null ? Z.skeletonRows(2, "Loading the link…") : Z.note({ text: "This link is not on your account." }))}`;
    const [w, tone] = phLinkWord(r);
    const closable = r.state === "OPEN" && !(r.payments || []).length;
    const pays = (r.payments || []).map((p) => Z.row({
      title: p.method === "crypto" ? `${Z.formatMoney(p.amountUsdc ?? 0, "USDC")}` : "Bank transfer",
      sub: [p.payerName, p.kind === "partial" ? "part payment" : ""].filter(Boolean).join(" · ") || "Received",
      right: Z.amount({ value: p.amountEur, direction: "in" }),
    }));
    return `${phTop("Payment link", "get-paid")}${phMain(`
      <div class="z-txhead">
        <p class="z-txhead__amt z-fig">${esc(r.amountEur == null ? "Any amount" : phEur(r.amountEur))}</p>
        <p class="z-sub">${esc([r.description, r.state === "OPEN" ? `expires ${phDay(r.expiresAt)}` : ""].filter(Boolean).join(" · "))}</p>
        ${Z.tag(w, tone)}
      </div>
      <div class="z-card">${Z.copyRow({ label: "Link", value: r.url, display: r.url.replace(/^https?:\/\//, ""), mono: true })}</div>
      ${Z.note({ text: "Share this link yourself. Zold doesn’t send emails or messages for you." })}
      ${r.methods.includes("bank") ? Z.kv([{ key: "Bank reference", value: r.code, mono: true }]) : ""}
      ${Z.listGroup({ label: "Received", rows: pays, empty: { text: "Nothing received yet." } })}
      <p class="z-err" id="ph-lk-err" role="alert" hidden></p>
    `)}${phFoot(`<div class="z-pair">${closable ? Z.button({ icon: "link_off", label: "Close link", id: "ph-lk-close" }) : ""}${r.state === "OPEN" ? Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-lk-share", className: closable ? "" : "z-btn--full" }) : ""}</div>`)}`;
  },
  bind(root, id) {
    if (phCache.links === null || phCache.methods === null) {
      phLoadLinks().then(() => { if (phRoute?.name === "link") phRender(); });
      return;
    }
    if (id === "new") {
      const form = root.querySelector("#ph-link");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (Z.isDisabled(btn)) return;
        const amount = root.querySelector("#ph-lk-amount");
        const desc = root.querySelector("#ph-lk-desc");
        const raw = amount.value.trim();
        const n = raw ? parseEurInput(raw) : undefined;
        Z.setFieldError(amount, raw && !(n > 0) ? eurInputError(raw, "40,50") : "");
        Z.setFieldError(desc, desc.value.trim() ? "" : "Say what it’s for. The payer sees this.");
        if (Z.focusFirstError(form)) return;
        const methods = [...form.querySelectorAll('input[name="methods"]:checked')].map((i) => i.value);
        const err = root.querySelector("#ph-lk-err");
        if (!methods.length) { err.textContent = "Pick at least one way to pay."; err.hidden = false; return; }
        Z.setLoading(btn, true);
        try {
          const r = await api(`/api/users/${user.id}/payment-requests`, { ...(n ? { amountEur: n } : {}), description: desc.value.trim(), methods });
          phCache.links = [r, ...(phCache.links || [])];
          phGo("link", r.id, { replace: true });
        } catch (x) {
          Z.setLoading(btn, false);
          err.textContent = x.message; err.hidden = false;
        }
      };
      return;
    }
    const r = phCache.links.find((x) => x.id === id);
    const share = root.querySelector("#ph-lk-share");
    if (share && r) share.onclick = () => {
      const lead = [r.amountEur == null ? "" : phEur(r.amountEur), r.description || ""].filter(Boolean).join(" for ");
      phShare(r.description || "Payment link", `${lead ? `${lead}. ` : ""}You can pay me here:`, r.url);
    };
    const close = root.querySelector("#ph-lk-close");
    if (close && r) close.onclick = () => phConfirm({
      id: "ph-lk-confirm",
      title: "Close this link?",
      text: "Nobody can pay it after this. Payments already made stay on your account.",
      confirm: "Close link",
      trigger: close,
      onConfirm: async () => {
        try {
          await api(`/api/users/${user.id}/payment-requests/${encodeURIComponent(r.id)}/cancel`, {});
          await phLoadLinks();
          phRender();
        } catch (x) {
          const err = root.querySelector("#ph-lk-err");
          err.textContent = x.message; err.hidden = false;
        }
      },
    });
  },
};

/* A centred confirmation. The safe choice is focused first. */
function phConfirm(o) {
  document.getElementById(o.id)?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: o.id, kind: "dialog", title: o.title,
    body: `<p class="z-sub">${esc(o.text)}</p><div class="z-pair z-pair--dialog">${Z.button({ label: o.cancel || "Keep it", autofocus: true, className: "z-overlay__close-btn" })}${Z.button({ variant: "primary", label: o.confirm, id: `${o.id}-ok` })}</div>`,
  }));
  const scrim = $(o.id);
  scrim.dataset.ph = "1";
  scrim.querySelector(".z-overlay__close-btn").onclick = () => Z.closeOverlay(o.id);
  $(`${o.id}-ok`).onclick = async () => { Z.closeOverlay(o.id); await o.onConfirm(); };
  Z.openOverlay(o.id, o.trigger);
}

/* ==========================================================================
   Contacts
   ========================================================================== */

/* The personal organisation's address book when there is one; otherwise the
   people this account has paid. */
async function phLoadContacts() {
  phCache.contacts = [];
  try {
    await phLoadOrgs();
    const org = phPersonalOrg();
    if (org && phCan(org, "contacts.manage")) {
      const d = await api(`/api/orgs/${encodeURIComponent(org.id)}/contacts`);
      phCache.contacts = (d.contacts || []).flatMap((c) => (c.bankAccounts || []).filter((b) => b.iban).slice(0, 1)
        .map((b) => ({ key: String(b.iban).replace(/\s+/g, "").toUpperCase(), name: c.name, iban: String(b.iban).replace(/\s+/g, "").toUpperCase(), kind: "Contact" })));
    }
  } catch { /* fall back to the people paid */ }
}

function phContactList() {
  const byIban = new Map();
  for (const c of phCache.contacts || []) byIban.set(c.key, { ...c, payments: [] });
  for (const p of phPayees()) {
    const had = byIban.get(p.key);
    if (had) had.payments = p.payments; else byIban.set(p.key, { key: p.key, name: p.name, iban: p.iban, payments: p.payments });
  }
  return [...byIban.values()].sort((a, b) => a.name.localeCompare(b.name));
}

PH.contacts = {
  title: "Contacts",
  tab: "more",
  live: () => `${phHistSig()}|${(phCache.contacts || []).length}`,
  html(key) {
    const list = phContactList();
    const loading = phCache.orgs === null && !histLoaded;
    return `${phTop("Contacts", "more")}${phMain(`
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-cq">Search contacts</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-cq" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Search people and companies…">
      </form>
      <div id="ph-contacts">${loading ? Z.skeletonRows(4, "Loading contacts…") : Z.listGroup({
        rows: list.map((c) => phPayeeRow(c, phHref("contacts", c.key))),
        empty: { text: "Contacts appear after your first payment.", action: { href: "#send", label: "Send money" } },
      })}</div>
    `)}`;
  },
  bind(root, key) {
    const q = root.querySelector("#ph-cq");
    q.oninput = () => {
      const needle = q.value.trim().toLowerCase();
      const list = phContactList().filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.iban.toLowerCase().includes(needle.replace(/\s+/g, "")));
      root.querySelector("#ph-contacts").innerHTML = Z.listGroup({ rows: list.map((c) => phPayeeRow(c, phHref("contacts", c.key))), empty: { text: "Nobody matches that." } });
    };
    if (phCache.contacts === null || phCache.orgs === null) phLoadContacts().then(() => { if (phRoute?.name === "contacts") phRender(); });
    if (key) phOpenContact(key, root);
  },
};

function phOpenContact(key, root) {
  const c = phContactList().find((x) => x.key === key);
  if (!c) return;
  const pays = c.payments || [];
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-contact", title: c.name,
    body: `<div class="z-sheet__body"><p class="z-sub">${pays.length ? `${pays.length} payment${pays.length === 1 ? "" : "s"}` : "No payments yet"}</p>
      <div class="z-card">${Z.copyRow({ label: "IBAN", value: c.iban, display: Z.groupIban(c.iban), mono: true })}</div>
      ${pays.length ? `<section class="z-group"><h3 class="z-eyebrow">Past payments</h3><dl class="z-kv z-kv--flat">${pays.slice(0, 5).map((t) => `<div><dt>${esc(phDay(t.createdAt))}</dt><dd class="z-fig">${phOut(t) ? "−" : ""}${esc(phEur(t.sendEur))}</dd></div>`).join("")}</dl></section>` : ""}
      ${phSendBlocked() ? "" : Z.button({ variant: "primary", full: true, icon: "arrow_outward", label: "Pay", href: phHref("send/amount", c.key), id: "ph-contact-pay" })}</div>`,
  }));
  const scrim = $("ph-contact");
  scrim.dataset.ph = "1";
  const pay = scrim.querySelector("#ph-contact-pay");
  if (pay) pay.onclick = (e) => {
    e.preventDefault();
    phSend = { payee: { name: c.name, iban: c.iban }, amount: "", reference: "", quote: null, transferId: null, error: null };
    Z.closeOverlay("ph-contact");
    phGo("send/amount", "new");
  };
  Z.openOverlay("ph-contact", root.querySelector(`a[href="${phHref("contacts", key)}"]`));
  const watch = new MutationObserver(() => {
    if (!scrim.classList.contains("is-open")) {
      watch.disconnect();
      // Removed by a redraw, which opens the sheet again: not a close.
      if (!scrim.isConnected) return;
      if (phRoute?.name === "contacts" && phRoute.arg) history.replaceState({ ph: true }, "", `${location.pathname}${location.search}#contacts`), (phRoute = { name: "contacts", arg: null });
    }
  });
  watch.observe(scrim, { attributes: true, attributeFilter: ["class"] });
}

/* ==========================================================================
   More
   ========================================================================== */

const PH_ROLE = { owner: "Owner", admin: "Admin", payer: "Payer", accountant: "Accountant", viewer: "Viewer" };
const phRoleWord = (role) => PH_ROLE[role] || String(role || "");

/* A row into the web app for a company. */
const phWebRow = (org, o) => Z.row(o).replace('<a class="z-row"', `<a class="z-row" data-ph-org="${esc(org.id)}"`);

/* Who the phone acts for: the personal account or one company. */
function phSwitchSheet(trigger) {
  const u = user || {};
  const companies = (phCache.orgs || []).filter((o) => o.type !== "personal");
  const choice = (id, name, sub) => {
    const here = (id || null) === phCompanyId;
    return `<li><button type="button" class="z-row z-row--btn" data-ph-switch="${esc(id || "")}"${here ? ' aria-current="true"' : ""}>${Z.avatar({ name, tone: here ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(name)}</span><span class="z-row__sub">${esc(sub)}</span></span>${here ? `<span class="z-row__right">${Z.icon("check")}<span class="z-sr">(current)</span></span>` : ""}</button></li>`;
  };
  document.getElementById("ph-switch")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-switch", title: "Switch account",
    body: `<ul class="z-list z-card">${choice(null, u.name || "Personal", "Personal account")}${companies.map((o) => choice(o.id, o.name, `Business · you are ${phRoleWord(o.role).toLowerCase()}`)).join("")}</ul>`,
  }));
  const scrim = $("ph-switch");
  scrim.dataset.ph = "1";
  scrim.querySelectorAll("[data-ph-switch]").forEach((b) => {
    b.onclick = () => {
      Z.closeOverlay("ph-switch");
      phUseCompany(b.dataset.phSwitch || null);
      phGo(phCompanyId ? "company" : "home");
    };
  });
  Z.openOverlay("ph-switch", trigger);
}

PH.more = {
  title: "More",
  tab: "more",
  live: () => JSON.stringify([phCache.orgs?.map((o) => o.id), phCompanyId]),
  html() {
    const u = user || {};
    const orgs = phCache.orgs || [];
    const companies = orgs.filter((o) => o.type !== "personal");
    const co = phCompany();
    const has = (cap) => orgs.some((o) => phCan(o, cap));
    const who = co
      ? { name: co.name, sub: `Business · you are ${phRoleWord(co.role).toLowerCase()}` }
      : { name: u.name || "", sub: companies.length ? `Personal · switch to ${companies.map((o) => o.name).join(", ")}` : "Personal account" };
    const switcher = companies.length
      ? `<button type="button" class="z-card z-switch" id="ph-switch-btn" aria-haspopup="dialog">${Z.avatar({ name: who.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(who.name)}</span><span class="z-row__sub">${esc(who.sub)}</span></span>${Z.icon("unfold_more", "z-row__chev")}</button>`
      : `<div class="z-card z-switch">${Z.avatar({ name: who.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(who.name)}</span><span class="z-row__sub">${esc(who.sub)}</span></span></div>`;
    const work = co
      ? [
        ...(phCan(co, "invoices") ? [phWebRow(co, { lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "In the web app", href: phWebHref("invoices") })] : []),
        phWebRow(co, { lead: Z.iconTile({ icon: "contacts" }), title: "Contacts", sub: "In the web app", href: phWebHref("contacts") }),
        ...(phCan(co, "ledger.transactions") ? [phWebRow(co, { lead: Z.iconTile({ icon: "menu_book" }), title: "Books", sub: "Memos, categories, receipts, exports", href: phWebHref("ledger") })] : []),
        Z.row({ lead: Z.iconTile({ icon: "inbox" }), title: "Approvals", sub: "Payments waiting for a second person", href: "#approvals" }),
        Z.row({ lead: Z.iconTile({ icon: "group" }), title: "Members", sub: "Who is in this company and what they can do", href: "#members" }),
      ]
      : [
        ...(phPersonalOrg()
          ? [Z.row({ lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "Issue, request and pay invoices", href: "#invoices" })]
          : has("invoices") ? [Z.row({ lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "In your company account", href: "/business" })] : []),
        Z.row({ lead: Z.iconTile({ icon: "contacts" }), title: "Contacts", sub: "People and companies you pay", href: "#contacts" }),
        ...(has("ledger.transactions") ? [Z.row({ lead: Z.iconTile({ icon: "menu_book" }), title: "Books", sub: "Memos, categories, receipts, exports", href: "/business" })] : []),
        companies.length
          ? Z.row({ lead: Z.iconTile({ icon: "inbox" }), title: "Approvals", sub: `In ${companies.map((o) => o.name).join(", ")}`, right: Z.tag("Business"), href: "#approvals" })
          : `<div class="z-row z-row--soon" aria-disabled="true">${Z.iconTile({ icon: "inbox" })}<span class="z-row__main"><span class="z-row__title">Approvals</span><span class="z-row__sub">Only in company accounts</span></span><span class="z-row__right">${Z.tag("Business")}</span></div>`,
      ];
    const other = [
      Z.row({ lead: Z.iconTile({ icon: "settings" }), title: "Settings", sub: "Account, security, plan", href: "#settings" }),
      Z.row({ lead: Z.iconTile({ icon: "hourglass_top" }), title: "Coming soon", sub: "What this account can’t do yet, and why", href: "#soon" }),
      ...(!co && HAS("gnosis_pay") ? [Z.row({ lead: Z.iconTile({ icon: "credit_card" }), title: "Gnosis Pay card", sub: "A card you already have, connected", right: Z.tag("Beta"), href: "#card" })] : []),
      Z.row({ lead: Z.iconTile({ icon: "help" }), title: "Help", sub: "support@zoldhq.com", href: "mailto:support@zoldhq.com" }),
    ];
    return `<header class="z-app__head">${Z.largeTitle({ title: "More" })}</header>${phMain(`
      ${phCache.orgs === null ? `<div class="z-card">${Z.skeletonRows(1, "Loading…")}</div>` : switcher}
      ${Z.listGroup({ rows: work })}
      ${Z.listGroup({ rows: other })}
    `)}`;
  },
  bind(root) {
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "more") phRender(); });
    const sw = root.querySelector("#ph-switch-btn");
    if (sw) sw.onclick = () => phSwitchSheet(sw);
  },
};

/* Reset the per-account caches (sign-out, a different account). */
function phReset() {
  phCache.deposits = null; phCache.links = null; phCache.methods = null; phCache.orgs = null;
  phCache.invoices = null; phCache.invProfile = null; phCache.invError = null; phCache.integrations = null;
  phCache.invIssued = null; phCache.invRequest = null;
  phCache.co = null; phCache.approvalsWaiting = 0; phCache.inviteLinks = {}; phCache.plans = {}; phCache.signers = undefined; phCache.soon = null;
  phCompanyId = null;
  phCache.contacts = null; phCache.bic = undefined; phCache.bicFor = ""; phCache.linksError = null;
  phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };
  phQuery = "";
}
