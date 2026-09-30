/**
 * Sign-in and onboarding (design/ui-v2 step 3): Auth, the install screens,
 * account type, the personal and business paths, Face ID set-up, the recovery
 * choice, Monerium and the welcome cards. Plus the passkey ceremonies every
 * later screen uses (sign-in, account set-up, IBAN link, send approvals).
 *
 * One screen at a time is rendered into #ob-root from a template, so the page
 * never holds two h1s or two forms. The hash names the screen; obGuard() sends
 * a screen the account is not ready for to the one it is.
 *
 * Declares resumeSession(); app/main.js is what calls it.
 */

/* ==========================================================================
   Entering the app
   ========================================================================== */

function enterDashboard(name) {
  let invite = null;
  try { invite = sessionStorage.getItem("zold-invite"); sessionStorage.removeItem("zold-invite"); } catch {}
  if (invite) {
    api("/api/orgs/invites/accept", { token: invite })
      .then(() => location.replace("/business"))
      .catch((e) => alert(`The invitation could not be accepted: ${e.message}`));
  }
  obScreen = null;
  $("onboard").style.display = "none";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  // The mobile shell is the app now; the desktop sidebar/topbar/rail stay in
  // the document only until their Noir screens land.
  $("dashboard").classList.add("m-on");
  if (!$("dashboard").dataset.msub) $("dashboard").dataset.msub = "home";
  $("dashboard").style.display = "grid";
  $("userpill").style.display = "flex";
  $("pillname").textContent = name;
  $("avatar").textContent = name.trim()[0].toUpperCase();
  if (poll) clearInterval(poll);
  poll = setInterval(refresh, 5000);
  refresh();
}

/* Onboarding is over (or put off): the welcome cards once for an account made
   in this browser, then the company's desk or the personal home. */
function obFinish() {
  if (obWelcomeDue()) return obGo("welcome");
  if (user?.accountType === "company") return location.assign("/business");
  enterDashboard(user?.name || "Account");
}

/* The account exists but is not approved: back to the step it is at. Also the
   dashboard's KYC banner, which opens the Monerium step from Home. */
function enterKycReview(_name) {
  obShow();
  obGo(obNextAfterAccount() || "monerium", { replace: true });
}

/* ==========================================================================
   Router
   ========================================================================== */

let obScreen = null;
let obBlockedCode = null;
/* Recovery choice made on this screen: shows its confirmation before moving on. */
let obRecoveryDone = null;

function obShow() {
  $("dashboard").style.display = "none";
  $("onboard").style.display = "block";
}

function obGo(name, { replace = false, focus = true } = {}) {
  const next = obGuard(name);
  const url = `${location.pathname}${location.search}#${next}`;
  const state = { ob: next, prev: obScreen };
  if (replace || !obScreen || obScreen === next) history.replaceState(state, "", url);
  else history.pushState(state, "", url);
  obScreen = next;
  obRender({ focus });
}

/* A screen the account is not ready for, or has passed, is not shown: the
   guard names the one it should see instead. */
function obGuard(name) {
  if (!OB[name]) name = "auth";
  const signedUp = !!user?.id;
  const kind = OB[name].kind;
  if (kind === "blocked") return obBlockedCode ? name : "auth";
  if (kind === "recover") return caps.emailSmsRecovery || caps.zoldenburgRecovery ? name : "auth";
  if (kind === "after") {
    if (!signedUp) return "auth";
    if (name === "welcome") return name;
    if (name === "recovery-email") return caps.emailSmsRecovery && user.passkeySafe?.status === "active" ? name : obNextAfterAccount() || "monerium";
    if (name === "monerium-keys") return caps.moneriumApiKeys && !kycApproved(user) ? name : obNextAfterAccount() || "monerium";
    if (name === "recovery") return recoveryEnrolmentPending() || obRecoveryDone ? name : obNextAfterAccount() || "monerium";
    return name;
  }
  // A link from the website straight to a path's first step picks the path.
  if (!obDraft.type && (name === "p-name" || name === "b-entity")) obDraft.type = name === "b-entity" ? "company" : "individual";
  // Before the account: an account that exists goes to its own next step.
  if (signedUp && user.passkey && !needsPasskeySafeSetup(user)) return obNextAfterAccount() || "monerium";
  if (kind === "entry") return name;
  if (signedUp) return user.accountType === "company" ? "b-passkey" : "p-passkey";
  const path = name.startsWith("b-") ? "company" : "individual";
  if (obDraft.type !== path) return "account-type";
  const order = path === "company" ? B_STEPS : P_STEPS;
  // The first earlier step that is not answered yet.
  for (const s of order) {
    if (s === name) return name;
    if (!OB[s].done()) return s;
  }
  return name;
}

/* Where an account that exists goes next. null: nothing left, open the app. */
function obNextAfterAccount(u = user) {
  if (!u) return "auth";
  if (!u.passkey || needsPasskeySafeSetup(u)) return u.accountType === "company" ? "b-passkey" : "p-passkey";
  if (zoldenburgChoicePending(u)) return "recovery";
  if (u.kycStatus === "rejected") return "monerium";
  if (kycApproved(u)) return null;
  if (hasConnectedMonerium(u)) return "activate";
  return "monerium";
}

function obRender({ focus = false } = {}) {
  const root = $("ob-root");
  const s = OB[obScreen];
  root.innerHTML = `<div class="z-screen" data-screen="${obScreen}">${obPill()}${s.html()}</div>`;
  document.title = `${s.title} · Zold`;
  s.bind?.(root);
  if (focus) root.querySelector("h1")?.focus({ preventScroll: false });
}

/* Capabilities arrived after a screen that depends on them was drawn. */
function obCapsChanged() {
  if (obScreen && ["auth", "monerium", "recovery"].includes(obScreen) && !$("ob-root").contains(document.activeElement)) obRender();
}

window.addEventListener("popstate", (e) => {
  if (!obScreen) return;
  const name = e.state?.ob || location.hash.slice(1);
  if (!OB[name]) return;
  obScreen = obGuard(name);
  // The address names the screen shown, not the one asked for.
  if (obScreen !== name) history.replaceState({ ob: obScreen, prev: e.state?.prev ?? null }, "", `${location.pathname}${location.search}#${obScreen}`);
  obRender({ focus: true });
});

/* Back arrows are links to the earlier step. When that step is the entry just
   behind this one in history, go back rather than push, so the browser's own
   back button does not return here. */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('#ob-root a[href^="#"]');
  if (!a) return;
  const target = a.getAttribute("href").slice(1);
  if (!OB[target]) return;
  e.preventDefault();
  if (history.state?.prev === target) history.back();
  else obGo(target);
});

// Leaving with answers typed and no account yet loses them.
window.addEventListener("beforeunload", (e) => {
  if (!user?.id && obScreen && OB[obScreen].kind === "form" && obDraftTouched) e.preventDefault();
});

/* ==========================================================================
   Pieces every screen shares
   ========================================================================== */

/* Test mode is the absence of real money, so it shows until /api/health says
   realMoney (capabilities.sandbox is true on every deployment). */
const obPill = () => Z.testModePill(!realMoney);

const obBrand = () => `<div class="z-screen__brand"><a href="/"><span class="z-brand-tri" aria-hidden="true">▽</span>Zold</a><a href="/">zoldhq.com</a></div>`;

function obProgress(step, of, label, back) {
  return `<div class="z-screen__head">${Z.progress({ step, of, label, back: back ? { href: `#${back}` } : null })}</div>`;
}

/* A head with only a back arrow (and a tag). */
function obBackHead(back, tagHtml = "") {
  return `<div class="z-screen__head"><div class="z-progress__head">${back ? Z.iconButton({ icon: "arrow_back", label: "Back", href: `#${back}` }) : ""}${tagHtml ? `<span>${tagHtml}</span>` : ""}</div></div>`;
}

const obIntro = (title, sub, big = true) =>
  `<div class="z-intro"><h1 class="z-title${big ? " z-title--lg" : ""}" tabindex="-1">${esc(title)}</h1>${sub ? `<p class="z-sub">${sub}</p>` : ""}</div>`;

const obAlert = (id = "ob-err") => `<div class="z-alert hidden" role="alert" id="${id}"></div>`;

/* Both legal links open in a new tab, so an answer typed on this screen stays. */
const LEGAL_LINKS = `<a href="/legal" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy notice</a>`;

function obYesNo(name, question, value, errorText) {
  const r = (v, label) => `<label><input type="radio" name="${name}" value="${v}"${value === (v === "yes") && value !== null ? " checked" : ""}>${label}</label>`;
  return `<fieldset class="z-q" id="q-${name}"${errorText ? ' aria-invalid="true"' : ""} aria-describedby="q-${name}-err"><legend>Required</legend>`
    + `<span class="z-q__text" id="q-${name}-text">${esc(question)}</span>`
    + `<div class="z-yn" role="radiogroup" aria-labelledby="q-${name}-text">${r("yes", "Yes")}${r("no", "No")}</div>`
    + `<p class="z-err" id="q-${name}-err"${errorText ? "" : " hidden"}>${esc(errorText || "")}</p></fieldset>`;
}

function obSetQuestionError(root, name, message) {
  const fs = root.querySelector(`#q-${name}`);
  const err = root.querySelector(`#q-${name}-err`);
  if (!fs || !err) return;
  if (message) { fs.setAttribute("aria-invalid", "true"); err.textContent = message; err.hidden = false; }
  else { fs.removeAttribute("aria-invalid"); err.hidden = true; }
}

function obRadio(root, name) {
  const v = root.querySelector(`input[name="${name}"]:checked`)?.value;
  return v === "yes" ? true : v === "no" ? false : null;
}

/* Focus the first field with an error, or the first unanswered question. */
function obFocusError(root) {
  const bad = root.querySelector('[aria-invalid="true"]');
  if (!bad) return false;
  (bad.matches("fieldset") ? bad.querySelector("input") : bad).focus();
  return true;
}

function obShowErr(e, id = "ob-err") {
  const el = $(id);
  if (!el) return;
  el.textContent = obMessage(e);
  el.classList.remove("hidden");
}
const obClearErr = (id = "ob-err") => $(id)?.classList.add("hidden");

/* A cancelled Face ID prompt is the user's choice, not a fault: say so plainly. */
function obMessage(e) {
  if (e?.name === "NotAllowedError") return "Face ID or fingerprint was cancelled, or it timed out. Try again when you’re ready.";
  if (e?.name === "InvalidStateError") return "This phone already has a Zold sign-in for this account. Sign in instead.";
  const m = String(e?.message || e || "Something went wrong.");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/* ==========================================================================
   Signup answers (kept for this tab only, until the account exists)
   ========================================================================== */

const OB_DRAFT_KEY = "zold-signup-draft";
let obDraftTouched = false;
const obDraft = (() => {
  const empty = {
    type: null, given: "", family: "", email: "", country: "", usPerson: null, companyUsNexus: null,
    legalName: "", tradingName: "", incorp: "", terms: false, authorised: false,
  };
  try { return { ...empty, ...JSON.parse(sessionStorage.getItem(OB_DRAFT_KEY) || "{}") }; } catch { return empty; }
})();
function obSaveDraft(patch) {
  Object.assign(obDraft, patch);
  obDraftTouched = true;
  try { sessionStorage.setItem(OB_DRAFT_KEY, JSON.stringify(obDraft)); } catch { /* private mode: kept in memory */ }
}
function obClearDraft() {
  try { sessionStorage.removeItem(OB_DRAFT_KEY); } catch {}
  obDraftTouched = false;
}

const obFullName = () => `${obDraft.given} ${obDraft.family}`.replace(/\s+/g, " ").trim();
const obCompany = () => obDraft.legalName || user?.orgName || "the company";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* The welcome cards are for an account made in this browser, shown once. */
const OB_WELCOME_KEY = "zold-welcome-due";
function obWelcomeDue() {
  try { return !!user?.id && localStorage.getItem(OB_WELCOME_KEY) === user.id; } catch { return false; }
}
function obSetWelcomeDue(on) {
  try { if (on) localStorage.setItem(OB_WELCOME_KEY, user.id); else localStorage.removeItem(OB_WELCOME_KEY); } catch {}
}

/* Every ISO 3166-1 alpha-2 country, not the ones we serve: which countries
   are served is the server's rule, and a filtered list is that rule shipped
   to the client. Names come from the browser in the reader's language; the
   code is what is sent. */
const ISO_COUNTRIES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

let obCountryCache = null;
function countryOptions() {
  if (obCountryCache) return obCountryCache;
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language, "en"], { type: "region" }); } catch { /* old browser: codes */ }
  // A malformed navigator.language (headless Linux reports "en-US@posix")
  // makes the Collator throw; a throw here would stop the whole screen.
  let collator;
  try { collator = new Intl.Collator(navigator.language); } catch { collator = new Intl.Collator("en"); }
  obCountryCache = ISO_COUNTRIES
    .map((code) => ({ code, name: (names && names.of(code)) || code }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return obCountryCache;
}
const countryName = (code) => countryOptions().find((c) => c.code === code)?.name || code || "";

/* No country is pre-selected. The browser's locale is a guess about the
   language someone reads, not where they live, and a pre-filled residence is
   an answer nobody gave. */
function obCountrySelect(o) {
  return Z.select({
    ...o,
    autocomplete: o.autocomplete || "off",
    required: true,
    options: [{ value: "", label: "Choose a country", disabled: true }, ...countryOptions().map((c) => ({ value: c.code, label: c.name }))],
  });
}

/* ==========================================================================
   Install (PWA). Shown before the account exists, never after: on iPhone the
   Home Screen app keeps its own storage, and the device key lives there.
   ========================================================================== */

const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const isIosSafari = () => {
  const ua = navigator.userAgent;
  // An iPad asks for the desktop site and says "Macintosh"; only touch gives it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
};
const isAndroid = () => /Android/.test(navigator.userAgent);
const OB_INSTALL_SKIP = "zold-install-skipped";
const installSkipped = () => { try { return sessionStorage.getItem(OB_INSTALL_SKIP) === "1"; } catch { return false; } };
const skipInstall = () => { try { sessionStorage.setItem(OB_INSTALL_SKIP, "1"); } catch {} };

function obCreateStart() {
  if (!isStandalone() && !installSkipped()) {
    if (isIosSafari()) return obGo("install-ios");
    if (isAndroid()) return obGo("install-android");
  }
  obGo("account-type");
}

/* ==========================================================================
   Screens
   ========================================================================== */

const P_STEPS = ["account-type", "p-name", "p-email", "p-residence", "p-review", "p-passkey"];
const B_STEPS = ["account-type", "b-entity", "b-registration", "b-you", "b-ownership", "b-review", "b-passkey"];

/* The steps after the account exists, numbered from what this deployment
   offers: no recovery service, no recovery step. */
function obAfterSteps() {
  return [...(caps.emailSmsRecovery || caps.zoldenburgRecovery ? ["recovery"] : []), "monerium", "activate"];
}
function obAfterProgress(name, label) {
  const steps = obAfterSteps();
  const i = Math.max(0, steps.indexOf(name === "recovery-email" ? "recovery" : name === "monerium-keys" ? "monerium" : name));
  return obProgress(i + 1, steps.length, label, null);
}

const OB = {};

/* ---- Auth ---------------------------------------------------------------- */
OB.auth = {
  kind: "entry",
  title: "Sign in or create an account",
  html: () => `${obBrand()}
    <main id="main" class="z-screen__main z-screen__main--center">
      <span class="z-mark" aria-hidden="true">▽</span>
      ${obIntro("Welcome to Zold", "Sign in with Face ID or your fingerprint, or open a new account.")}
      ${obAlert("auth-err")}
    </main>
    <div class="z-screen__foot">
      ${Z.button({ variant: "primary", full: true, icon: "passkey", label: "Sign in with Face ID", id: "link-signin" })}
      ${Z.button({ variant: "secondary", full: true, label: "Create an account", id: "btn-create" })}
      <p class="z-screen__alt" id="recover-link-row"${caps.emailSmsRecovery || caps.zoldenburgRecovery ? "" : " hidden"}>New phone, or lost this one? <a href="#recover">Recover your account</a></p>
    </div>
    <p class="z-screen__fine">By continuing you agree to the ${LEGAL_LINKS}.</p>`,
  bind: (root) => {
    root.querySelector("#link-signin").onclick = (e) => obSignIn(e.currentTarget);
    root.querySelector("#btn-create").onclick = obCreateStart;
  },
};

/* ---- Install ------------------------------------------------------------- */
OB["install-ios"] = {
  kind: "entry",
  title: "Install on iPhone",
  html: () => `${obBackHead("auth", Z.tag("Beta"))}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Put Zold on your Home Screen", "It opens full screen like any app, and it keeps you signed in.", false)}
      <ol class="z-howto">
        ${[["ios_share", "Tap Share", "It’s in Safari’s toolbar at the bottom of the screen."],
          ["add_box", "Choose Add to Home Screen", "Scroll the list if you don’t see it, then tap Add."],
          ["touch_app", "Open Zold from your Home Screen", "Create your account there, not in Safari."]]
          .map(([ic, t, d]) => `<li>${Z.iconTile({ icon: ic })}<span class="z-howto__main"><span class="z-howto__title">${t}</span><span class="z-howto__text">${d}</span></span></li>`).join("")}
      </ol>
      ${Z.note({ tone: "a", icon: "phone_iphone", text: "On iPhone the Home Screen app keeps its own storage. Setting up inside it keeps this phone’s key with the app you’ll use." })}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      <button type="button" class="z-link-btn" id="btn-install-skip">Continue in Safari instead</button>
      <span class="z-pointer" aria-hidden="true">${Z.icon("ios_share")}${Z.icon("south")}</span>
    </div>`,
  bind: (root) => {
    root.querySelector("#btn-install-skip").onclick = () => { skipInstall(); obGo("account-type"); };
  },
};

OB["install-android"] = {
  kind: "entry",
  title: "Install on Android",
  html: () => {
    const prompt = !!window.zoldInstallPrompt;
    return `${obBackHead("auth")}
    <main id="main" class="z-screen__main z-screen__main--tight" style="align-items:center;text-align:center">
      <span class="z-mark z-mark--app" aria-hidden="true">▽</span>
      ${obIntro("Install Zold", "Get the app on this phone. There’s nothing to download from a store.", false)}
      <ul class="z-points z-points--tight" style="align-self:stretch;text-align:left">
        <li>${Z.icon("fullscreen")}<span>Opens full screen, from your home screen</span></li>
        <li>${Z.icon("bolt")}<span>Starts faster and works on a weak connection</span></li>
        <li>${Z.icon("fingerprint")}<span>Fingerprint sign-in works like in any other app</span></li>
      </ul>
      ${prompt ? "" : `<div style="align-self:stretch;text-align:left">${Z.note({ icon: "more_vert", text: "Open your browser’s menu and choose Install app or Add to Home screen." })}</div>`}
      <div class="z-alert hidden" role="status" id="install-status"></div>
    </main>
    <div class="z-screen__foot">
      ${prompt ? Z.button({ variant: "primary", full: true, icon: "install_mobile", label: "Install app", id: "btn-install" }) : ""}
      ${prompt
        ? `<button type="button" class="z-link-btn" id="btn-install-skip">Not now</button>`
        : Z.button({ variant: "primary", full: true, label: "Continue in the browser", id: "btn-install-skip" })}
    </div>`;
  },
  bind: (root) => {
    root.querySelector("#btn-install-skip").onclick = () => { skipInstall(); obGo("account-type"); };
    const b = root.querySelector("#btn-install");
    if (b) b.onclick = async () => {
      const ev = window.zoldInstallPrompt;
      if (!ev) return;
      window.zoldInstallPrompt = null;
      ev.prompt();
      const { outcome } = await ev.userChoice.catch(() => ({ outcome: "dismissed" }));
      if (outcome === "accepted") {
        const st = $("install-status");
        st.textContent = "Installed. Open Zold from your home screen to create your account there.";
        st.classList.remove("hidden");
        b.remove();
      } else {
        skipInstall();
        obGo("account-type");
      }
    };
  },
};

/* ---- Account type ---------------------------------------------------------- */
OB["account-type"] = {
  kind: "form",
  title: "Choose an account type",
  done: () => !!obDraft.type,
  html: () => `${obBackHead("auth")}
    <main id="main" class="z-screen__main">
      ${obIntro("Who is this account for?", "We ask different questions for each. You can add the other kind later.")}
      <nav aria-label="Account type" class="z-form z-form--tight">
        ${[["individual", "p-name", "person", "Personal", "An account in your own name.", "Own IBAN, sending and getting paid, payment links"],
          ["company", "b-entity", "domain", "Business", "An account in your company’s name.", "Team approvals, invoices and books"]]
          .map(([t, href, ic, title, text, more]) => `<a class="z-option" href="#${href}" data-type="${t}">${Z.iconTile({ icon: ic, tone: "p" })}<span class="z-option__main"><span class="z-option__title">${title}</span><span class="z-option__text">${text}</span><span class="z-option__more">${more}</span></span>${Z.icon("chevron_right")}</a>`).join("")}
      </nav>
    </main>
    <p class="z-screen__alt" style="padding:16px 24px 28px">Already have an account? <a href="#auth">Sign in</a></p>`,
  bind: (root) => {
    // Set the path before the router's own link handler runs (capture phase).
    root.querySelectorAll("[data-type]").forEach((a) => a.addEventListener("click", () => {
      if (obDraft.type !== a.dataset.type) obSaveDraft({ type: a.dataset.type, terms: false, authorised: false });
    }, true));
  },
};

/* ---- Personal ------------------------------------------------------------ */
OB["p-name"] = {
  kind: "form",
  title: "Personal: your name",
  done: () => !!(obDraft.given.trim() && obDraft.family.trim()),
  html: () => `${obProgress(2, 6, "About you", "account-type")}
    <main id="main" class="z-screen__main">
      ${obIntro("What’s your name?", "Use the name on your ID, the same one you’ll give Monerium.")}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "given", name: "given-name", label: "First and middle names", autocomplete: "given-name", value: obDraft.given, maxlength: 60, placeholder: "Miriam…" })}
        ${Z.field({ id: "family", name: "family-name", label: "Last name", autocomplete: "family-name", value: obDraft.family, maxlength: 60, placeholder: "Zoldenburg…" })}
      </form>
    </main>
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, label: "Continue", type: "submit", id: "btn-next" }).replace("<button", '<button form="ob-form"')}</div>`,
  bind: (root) => obBindForm(root, () => {
    const given = root.querySelector("#given"), family = root.querySelector("#family");
    Z.setFieldError(given, given.value.trim() ? "" : "Enter your first name, as it is on your ID.");
    Z.setFieldError(family, family.value.trim() ? "" : "Enter your last name, as it is on your ID.");
    if (obFocusError(root)) return;
    obSaveDraft({ given: given.value.trim(), family: family.value.trim() });
    obGo("p-email");
  }),
};

OB["p-email"] = {
  kind: "form",
  title: "Personal: your email",
  done: () => EMAIL_RE.test(obDraft.email),
  html: () => `${obProgress(3, 6, "Contact", "p-name")}
    <main id="main" class="z-screen__main">
      ${obIntro("Your email", "It’s how you get back in if you lose this phone. No newsletters.")}
      <form class="z-form" id="ob-form" novalidate>
        ${obEmailField(obDraft.email)}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const email = obCheckEmail(root);
    if (!email) return;
    obSaveDraft({ email });
    obGo("p-residence");
  }),
};

OB["p-residence"] = {
  kind: "form",
  title: "Personal: where you live",
  done: () => !!obDraft.country && obDraft.usPerson !== null,
  html: () => `${obProgress(4, 6, "Residence", "p-email")}
    <main id="main" class="z-screen__main">
      ${obIntro("Where do you live?", "Your country decides which payment partner opens your account.")}
      <form class="z-form" id="ob-form" novalidate>
        ${obCountrySelect({ id: "country", name: "country", label: "Country of residence", autocomplete: "country", value: obDraft.country })}
        ${obYesNo("usPerson", "Are you a US citizen, a Green Card holder, or a US tax resident?", obDraft.usPerson)}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const country = root.querySelector("#country");
    const usPerson = obRadio(root, "usPerson");
    Z.setFieldError(country, country.value ? "" : "Choose the country you live in.");
    obSetQuestionError(root, "usPerson", usPerson === null ? "Answer yes or no." : "");
    if (obFocusError(root)) return;
    obSaveDraft({ country: country.value, usPerson });
    obGo("p-review");
  }),
};

OB["p-review"] = {
  kind: "form",
  title: "Personal: check and agree",
  done: () => obDraft.terms,
  html: () => `${obProgress(5, 6, "Agree", "p-residence")}
    <main id="main" class="z-screen__main">
      ${obIntro("Check and agree", "One last look before we make your account.")}
      <form class="z-form" id="ob-form" novalidate>
        <div class="z-group">
          <div class="z-group__head"><h2 class="z-eyebrow">Your details</h2><a class="z-group__action" href="#p-name">Edit</a></div>
          ${Z.kv([
            { key: "Name", value: obFullName() },
            { key: "Email", value: obDraft.email },
            { key: "Lives in", value: countryName(obDraft.country) },
            { key: "US person", value: obDraft.usPerson ? "Yes" : "No" },
          ])}
        </div>
        ${obTermsCheck()}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    if (!obCheckTerms(root)) return;
    obSaveDraft({ terms: true });
    obGo("p-passkey");
  }),
};

OB["p-passkey"] = {
  kind: "form",
  title: "Personal: set up sign-in",
  done: () => false,
  html: () => `${obProgress(6, 6, "Sign-in", user?.id ? null : "p-review")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon("passkey")}</span>
      ${obIntro("Set up Face ID or fingerprint", "It creates a sign-in key that never leaves this phone.")}
      <ul class="z-points">
        <li>${Z.icon("lock")}<span>It’s the only key to your account. Zold never sees it.</span></li>
        <li>${Z.icon("password")}<span>No password to remember or leak.</span></li>
        <li>${Z.icon("restore")}<span>Set up recovery next, in case you lose this phone.</span></li>
      </ul>
      ${obSetupSteps()}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, icon: "fingerprint", label: obPasskeyLabel(), id: "btn-passkey" })}</div>`,
  bind: (root) => { root.querySelector("#btn-passkey").onclick = (e) => obCreateAccount(e.currentTarget); },
};

/* ---- Business ------------------------------------------------------------ */
OB["b-entity"] = {
  kind: "form",
  title: "Business: company name",
  done: () => obDraft.legalName.trim().length >= 2,
  html: () => `${obProgress(2, 7, "Company", "account-type")}
    <main id="main" class="z-screen__main">
      ${obIntro("What’s the company called?", "Exactly as registered, with the legal form.")}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "legal-name", name: "organization", label: "Legal name", autocomplete: "organization", value: obDraft.legalName, maxlength: 120, placeholder: "Lindner Holzbau GmbH…" })}
        ${Z.field({ id: "trading-name", name: "trading-name", label: "Trading name", optional: true, value: obDraft.tradingName, maxlength: 120, hint: "If customers know you by another name." })}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const legal = root.querySelector("#legal-name");
    Z.setFieldError(legal, legal.value.trim().length >= 2 ? "" : "Enter the company’s registered name.");
    if (obFocusError(root)) return;
    obSaveDraft({ legalName: legal.value.trim(), tradingName: root.querySelector("#trading-name").value.trim() });
    obGo("b-registration");
  }),
};

OB["b-registration"] = {
  kind: "form",
  title: "Business: registration",
  done: () => !!obDraft.incorp,
  html: () => `${obProgress(3, 7, "Registration", "b-entity")}
    <main id="main" class="z-screen__main">
      ${obIntro("Where is it registered?", "The country of the company’s register entry.")}
      <form class="z-form" id="ob-form" novalidate>
        ${obCountrySelect({ id: "incorp", name: "incorporation-country", label: "Country of incorporation", value: obDraft.incorp })}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const incorp = root.querySelector("#incorp");
    Z.setFieldError(incorp, incorp.value ? "" : "Choose the country the company is registered in.");
    if (obFocusError(root)) return;
    obSaveDraft({ incorp: incorp.value });
    obGo("b-you");
  }),
};

OB["b-you"] = {
  kind: "form",
  title: "Business: about you",
  done: () => !!(obDraft.given.trim() && EMAIL_RE.test(obDraft.email) && obDraft.country),
  html: () => `${obProgress(4, 7, "About you", "b-registration")}
    <main id="main" class="z-screen__main">
      ${obIntro("And who are you?", "You’ll be the first owner. Add teammates after the account is open.")}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "b-name", name: "name", label: "Your full name", autocomplete: "name", value: obFullName(), maxlength: 120, placeholder: "Miriam Zoldenburg…" })}
        ${obCountrySelect({ id: "country", name: "country", label: "Where you live", autocomplete: "country", value: obDraft.country })}
        ${obEmailField(obDraft.email, "Work email", "Used to recover access if you lose this phone.")}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const name = root.querySelector("#b-name"), country = root.querySelector("#country");
    Z.setFieldError(name, name.value.trim() ? "" : "Enter your full name.");
    Z.setFieldError(country, country.value ? "" : "Choose the country you live in.");
    const email = obCheckEmail(root);
    if (obFocusError(root) || !email) return;
    // One name field on this path; the API takes the full name as one string.
    obSaveDraft({ given: name.value.trim(), family: "", country: country.value, email });
    obGo("b-ownership");
  }),
};

OB["b-ownership"] = {
  kind: "form",
  title: "Business: ownership questions",
  done: () => obDraft.companyUsNexus !== null && obDraft.usPerson !== null,
  html: () => `${obProgress(5, 7, "Ownership", "b-you")}
    <main id="main" class="z-screen__main">
      ${obIntro("Two required questions", "We need both answers before we can open a company account.")}
      <form class="z-form" id="ob-form" novalidate>
        ${obYesNo("companyUsNexus", "Is the company incorporated in the US, or is any owner of 25% or more a US person?", obDraft.companyUsNexus)}
        ${obYesNo("usPerson", "Are you a US citizen, a Green Card holder, or a US tax resident?", obDraft.usPerson)}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const nexus = obRadio(root, "companyUsNexus"), usPerson = obRadio(root, "usPerson");
    obSetQuestionError(root, "companyUsNexus", nexus === null ? "Answer yes or no." : "");
    obSetQuestionError(root, "usPerson", usPerson === null ? "Answer yes or no." : "");
    if (obFocusError(root)) return;
    obSaveDraft({ companyUsNexus: nexus, usPerson });
    obGo("b-review");
  }),
};

OB["b-review"] = {
  kind: "form",
  title: "Business: check and agree",
  done: () => obDraft.terms && obDraft.authorised,
  html: () => `${obProgress(6, 7, "Agree", "b-ownership")}
    <main id="main" class="z-screen__main">
      ${obIntro("Check and agree", `One last look before we open the account for ${esc(obCompany())}.`)}
      <form class="z-form" id="ob-form" novalidate>
        <div class="z-group">
          <div class="z-group__head"><h2 class="z-eyebrow">Your details</h2><a class="z-group__action" href="#b-entity">Edit</a></div>
          ${Z.kv([
            { key: "Company", value: obDraft.legalName },
            ...(obDraft.tradingName ? [{ key: "Trading name", value: obDraft.tradingName }] : []),
            { key: "Registered in", value: countryName(obDraft.incorp) },
            { key: "You", value: obFullName() },
            { key: "Email", value: obDraft.email },
            { key: "You live in", value: countryName(obDraft.country) },
          ])}
        </div>
        <label class="z-check" for="c-authorised"><input id="c-authorised" name="authorised" type="checkbox"${obDraft.authorised ? " checked" : ""} aria-describedby="c-authorised-err"><span>I’m authorised to open an account for ${esc(obCompany())}.</span></label>
        <p class="z-err" id="c-authorised-err" hidden></p>
        ${obTermsCheck()}
      </form>
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`,
  bind: (root) => obBindForm(root, () => {
    const auth = root.querySelector("#c-authorised");
    const err = root.querySelector("#c-authorised-err");
    if (!auth.checked) { err.textContent = "Confirm you may open an account for the company."; err.hidden = false; auth.setAttribute("aria-invalid", "true"); }
    else { err.hidden = true; auth.removeAttribute("aria-invalid"); }
    if (!obCheckTerms(root) || !auth.checked) { obFocusError(root); return; }
    obSaveDraft({ terms: true, authorised: true });
    obGo("b-passkey");
  }),
};

OB["b-passkey"] = {
  kind: "form",
  title: "Business: set up sign-in",
  done: () => false,
  html: () => `${obProgress(7, 7, "Sign-in", user?.id ? null : "b-review")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon("passkey")}</span>
      ${obIntro("Set up the company’s first approver", `This phone becomes the first approver for ${esc(obCompany())}.`)}
      <ul class="z-points">
        <li>${Z.icon("lock")}<span>Company payments you draft need a teammate’s approval. Zold can’t approve any.</span></li>
        <li>${Z.icon("group_add")}<span>Invite teammates and give each a role after the account opens.</span></li>
        <li>${Z.icon("restore")}<span>Set up recovery next, in case you lose this phone.</span></li>
      </ul>
      ${obSetupSteps()}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, icon: "fingerprint", label: obPasskeyLabel(), id: "btn-passkey" })}</div>`,
  bind: (root) => { root.querySelector("#btn-passkey").onclick = (e) => obCreateAccount(e.currentTarget); },
};

/* Shared form parts. */
const obSubmit = (label = "Continue") =>
  Z.button({ variant: "primary", full: true, label, type: "submit", id: "btn-next" }).replace("<button", '<button form="ob-form"');

function obEmailField(value, label = "Email", hint) {
  const error = obEmailInUse ? "An account already uses this email. Sign in instead, or recover it if you lost your phone." : undefined;
  obEmailInUse = false;
  return Z.field({ id: "email", name: "email", type: "email", label, autocomplete: "email", inputmode: "email", value, maxlength: 254, placeholder: "miriam@example.com…", hint, error })
    .replace('type="email"', 'type="email" autocapitalize="off"');
}

function obCheckEmail(root) {
  const input = root.querySelector("#email");
  const v = input.value.trim();
  Z.setFieldError(input, !v ? "Enter your email address." : EMAIL_RE.test(v) ? "" : "Enter an email address like miriam@example.com.");
  return EMAIL_RE.test(v) ? v : null;
}

function obTermsCheck() {
  return `<label class="z-check" for="c-terms"><input id="c-terms" name="terms" type="checkbox"${obDraft.terms ? " checked" : ""} aria-describedby="c-terms-err"><span>I accept Zold’s ${LEGAL_LINKS.replace("and <a", "and have read the <a")}.</span></label>
        <p class="z-err" id="c-terms-err" hidden></p>`;
}
function obCheckTerms(root) {
  const box = root.querySelector("#c-terms"), err = root.querySelector("#c-terms-err");
  if (box.checked) { err.hidden = true; box.removeAttribute("aria-invalid"); return true; }
  err.textContent = "Accept the Terms to continue.";
  err.hidden = false;
  box.setAttribute("aria-invalid", "true");
  obFocusError(root);
  return false;
}

/* Submit on Enter and on the pinned button; fields clear their error as they change. */
function obBindForm(root, onSubmit) {
  const form = root.querySelector("#ob-form");
  form.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(); });
  form.addEventListener("input", (e) => {
    obDraftTouched = true;
    if (e.target.matches(".z-input, .z-select")) Z.setFieldError(e.target, "");
    const fs = e.target.closest("fieldset.z-q");
    if (fs) obSetQuestionError(root, fs.id.slice(2), "");
  });
}

/* ---- Face ID set-up and account creation ----------------------------------- */

/* Two prompts, named so a failure points at the one that failed: the sign-in
   key itself, then the approval that sets up the account on the network. */
let obSetup = null; // { step: 0|1, state: "now"|"fail" } while running or after a failure
function obSetupSteps() {
  if (!obSetup && !user?.passkey) return "";
  const keyDone = !!user?.passkey;
  const row = (i, label, done) => {
    const st = done ? "is-done" : obSetup?.step === i ? (obSetup.state === "fail" ? "is-fail" : "is-now") : "";
    const ic = done ? "check_circle" : st === "is-fail" ? "error" : st === "is-now" ? "radio_button_checked" : "radio_button_unchecked";
    const word = done ? "done" : st === "is-fail" ? "did not finish" : st === "is-now" ? "in progress" : "next";
    return `<li class="${st}">${Z.icon(ic)}<span>${label}<span class="z-sr">, ${word}</span></span></li>`;
  };
  return `<ul class="z-steps" aria-live="polite">${row(0, "Face ID sign-in on this phone", keyDone)}${row(1, "Your account, approved with Face ID", !!user?.passkey && !needsPasskeySafeSetup(user) && !!user?.passkeySafe)}</ul>`;
}
const obPasskeyLabel = () => (user?.passkey ? "Finish with Face ID" : "Set up Face ID");

function obSignupBody() {
  const company = obDraft.type === "company";
  return {
    name: obFullName(),
    email: obDraft.email,
    country: obDraft.country,
    accountType: company ? "company" : "individual",
    usAnswers: { usPerson: obDraft.usPerson === true, ...(company ? { companyUsNexus: obDraft.companyUsNexus === true } : {}) },
    ...(company && obDraft.incorp ? { companyIncorporationCountry: obDraft.incorp } : {}),
    // Only Zold's own terms. Zold sends Monerium nothing: the user gives
    // Monerium their details on Monerium's site.
    consents: [{ kind: "zold_terms" }],
  };
}
/* registerPasskey() labels the passkey with these. */
let pendingInfo = null;

async function obCreateAccount(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr();
  if (!window.PublicKeyCredential) {
    // No passkey, no account: nothing an account without one could hold.
    return obShowErr(new Error("This browser can’t set up Face ID or fingerprint sign-in. Open Zold in Safari or Chrome to create an account."));
  }
  Z.setLoading(btn, true);
  const rerender = () => { const m = $("ob-root").querySelector(".z-steps"); if (m) m.outerHTML = obSetupSteps(); else $("ob-err")?.insertAdjacentHTML("beforebegin", obSetupSteps()); };
  try {
    if (!user?.id) {
      pendingInfo = obSignupBody();
      // ONE request, read by hand: a refusal needs its CODE to pick the screen.
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingInfo),
      }).catch(() => null);
      if (!res) throw new Error("You appear to be offline. Zold could not be reached.");
      const u = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 && String(u.code || "").startsWith("BLOCKED_")) {
          obBlockedCode = u.code;
          obClearDraft();
          return obGo("blocked", { replace: true });
        }
        if (u.code === "EMAIL_IN_USE") {
          obEmailInUse = true;
          return obGo(obDraft.type === "company" ? "b-you" : "p-email");
        }
        throw new Error(u.error || `The account could not be created (HTTP ${res.status}).`);
      }
      u.balanceEur = 0;
      u.safeBalanceEur = 0;
      renderUser(u);
      obSetWelcomeDue(true);
    }
    pendingInfo ||= { name: user.name, email: user.email };
    if (user.accountType === "company") await obEnsureOrg();

    if (!user.passkey) {
      obSetup = { step: 0, state: "now" }; rerender();
      // Some environments leave the ceremony pending forever instead of
      // rejecting: never strand the user on it.
      await Promise.race([
        registerPasskey(user),
        new Promise((_, rej) => setTimeout(() => rej(new Error("No answer from this phone. Is a screen lock set up?")), 30000)),
      ]);
    }
    obSetup = { step: 1, state: "now" }; rerender();
    btn.querySelector("span:last-child").textContent = "Approve with Face ID again";
    await finishPasskeySafeSetup();
    obSetup = null;
    // Only the hardhat harness auto-approves; a real account goes on to
    // recovery and Monerium.
    if (kycApproved(user) && !user.iban && (user.funding || {}).mode === "sandbox") {
      try { await issueAppIban(); } catch { /* retried from Home */ }
    }
    obClearDraft();
    const next = obNextAfterAccount();
    return next ? obGo(next, { replace: true }) : obFinish();
  } catch (e) {
    if (obSetup) obSetup.state = "fail";
    rerender();
    obShowErr(obSetup?.step === 1
      ? new Error(`Your Face ID sign-in is saved, but setting up the account didn’t finish (${obMessage(e).replace(/\.$/, "")}). Try again; nothing needs setting up twice.`)
      : e);
  } finally {
    Z.setLoading(btn, false);
    const label = btn.querySelector("span:last-child");
    if (label) label.textContent = obPasskeyLabel();
  }
}
/* Set when signup refused the email: the email field says why, once. */
let obEmailInUse = false;

/* A company account is an organisation with this person as its owner. Made
   once: a retry after a reload finds the one already there. */
async function obEnsureOrg() {
  const { organisations = [] } = await api("/api/orgs");
  if (organisations.some((o) => o.type === "business")) return;
  if (!obDraft.legalName || !obDraft.incorp) return; // answers gone (another tab): the owner adds it from /business
  await api("/api/orgs", {
    type: "business",
    name: obDraft.tradingName || obDraft.legalName,
    legalName: obDraft.legalName,
    country: obDraft.incorp,
    email: obDraft.email,
  });
}

/* ---- Blocked --------------------------------------------------------------- */
/* An outcome, not an error. Says what Zold cannot offer and stops: naming the
   rule tells someone which answer to change. The reason is in the audit log. */
OB.blocked = {
  kind: "blocked",
  title: "Zold is not available",
  html: () => `${obBrand()}
    <main id="main" class="z-screen__main z-screen__main--center">
      ${obIntro(obBlockedCode === "BLOCKED_US" ? "Zold isn’t available to US persons"
        : obBlockedCode === "BLOCKED_SANCTIONED" ? "Zold isn’t available in your country"
          : "Zold can’t open an account for you yet",
        "Nothing has been created, and none of your details have been shared with anyone.")}
      <p class="z-sub">If you think this is wrong, write to <a href="mailto:support@zoldhq.com">support@zoldhq.com</a> and we’ll look at it.</p>
    </main>`,
};

/* ---- Sign in ---------------------------------------------------------------- */
async function obSignIn(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr("auth-err");
  if (!window.PublicKeyCredential) return obShowErr(new Error("This browser can’t use Face ID or fingerprint sign-in. Open Zold in Safari or Chrome."), "auth-err");
  Z.setLoading(btn, true);
  try {
    const { challenge } = await api("/api/webauthn/challenge", { purpose: "login" });
    const cred = await navigator.credentials.get({
      publicKey: { challenge: b64urlToBytes(challenge), userVerification: "preferred", timeout: 60000 },
    });
    const u = await api("/api/passkey/login", {
      credentialId: cred.id,
      authenticatorData: b64url(cred.response.authenticatorData),
      clientDataJSON: b64url(cred.response.clientDataJSON),
      signature: b64url(cred.response.signature),
    });
    renderUser(u);
    const next = obNextAfterAccount();
    if (next) obGo(next, { replace: true });
    else enterDashboard(user.name);
  } catch (e) {
    obShowErr(e?.name === "NotAllowedError"
      ? new Error("Sign-in was cancelled, or this phone has no Zold sign-in saved. Create an account, or recover one you lost.")
      : e, "auth-err");
  } finally { Z.setLoading(btn, false); }
}

/* ---- Recovery choice -------------------------------------------------------- */

/* Has the user still to answer the Zoldenburg-guardian offer? Only where the
   deployment has a guardian, the account is set up, and they neither added it
   nor declined it. */
function zoldenburgChoicePending(u = user) {
  return !!(caps.zoldenburgRecovery && u?.passkeySafe?.status === "active"
    && !u.passkeySafe.recoveryChoice && u.passkeySafe.recovery?.status !== "active"
    // Recovery by email is the other answer to the same question.
    && u.passkeySafe.candideRecovery?.guardianStatus !== "active");
}

/* Is there Candide (email) enrolment left? True only where the deployment has
   the service, the account is set up and the guardian is not yet on it. */
function candideEnrolmentPending(u = user) {
  return !!(caps.emailSmsRecovery && u?.passkeySafe?.status === "active"
    && u.passkeySafe.candideRecovery?.guardianStatus !== "active");
}

function recoveryEnrolmentPending(u = user) {
  return zoldenburgChoicePending(u) || candideEnrolmentPending(u);
}

let obGrace = null;
OB.recovery = {
  kind: "after",
  title: "Recovery choice",
  html: () => {
    if (obRecoveryDone) {
      return `${obAfterProgress("recovery", "Recovery")}
      <main id="main" class="z-screen__main">
        ${obIntro(obRecoveryDone === "zoldenburg" ? "Zoldenburg can help you back in" : obRecoveryDone === "email" ? "Recovery by email is on" : "Recovery skipped",
          obRecoveryDone === "zoldenburg" ? "If you lose this phone, contact Zoldenburg support from the sign-in screen. The move waits, and this phone can cancel it."
            : obRecoveryDone === "email" ? `A code to ${esc(user.email)} and a waiting period can move this account to a new phone.`
              : "You can set up recovery later in Security.")}
      </main>
      <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, label: "Continue", id: "btn-rec-next" })}</div>`;
    }
    const opts = [];
    if (caps.emailSmsRecovery && user?.email) opts.push(["email", `Email code ${Z.tag("Recommended", "pink")}${Z.tag("Beta")}`, "A code to your email starts recovery on a new phone. A waiting period lets you cancel it."]);
    if (caps.zoldenburgRecovery) opts.push(["zoldenburg", `Zoldenburg can help ${Z.tag("Beta")}`, `Zoldenburg verifies you against your Monerium ID and starts recovery. You sign once to allow it. The move waits <span id="rec-grace">${esc(obGrace || "several days")}</span>, and you can cancel it from this phone.`]);
    opts.push(["skip", "Skip for now", "No one can recover this account."]);
    return `${obAfterProgress("recovery", "Recovery")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("If you lose this phone", "Pick how you’d get back in. You can change this later in Security.")}
      <form class="z-form z-form--tight" id="ob-form" novalidate>
        <fieldset class="z-form z-form--tight" style="border:0;margin:0;padding:0;min-width:0" aria-describedby="rec-choice-err">
          <legend class="z-sr">How to get back in</legend>
          ${opts.map(([v, t, d]) => `<label class="z-choice"><input type="radio" name="recovery" value="${v}"><span class="z-choice__main"><span class="z-choice__title">${t}</span><span class="z-choice__text">${d}</span></span></label>`).join("")}
        </fieldset>
        <p class="z-err" id="rec-choice-err" hidden></p>
        <div id="rec-skip" class="z-form z-form--tight" hidden>
          ${Z.note({ tone: "a", icon: "warning", text: caps.zoldenburgRecovery
            ? "If you skip and lose this phone, Zoldenburg can’t recover the account. Only your euros can be reclaimed from Monerium."
            : "If you skip and lose this phone, no one can recover the account. Only your euros can be reclaimed from Monerium." })}
          <label class="z-check" for="c-skip"><input id="c-skip" type="checkbox" aria-describedby="c-skip-err"><span>I understand. Skip recovery for now.</span></label>
          <p class="z-err" id="c-skip-err" hidden></p>
        </div>
      </form>
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${obSubmit()}</div>`;
  },
  bind: (root) => {
    const next = root.querySelector("#btn-rec-next");
    if (next) {
      next.onclick = () => {
        obRecoveryDone = null;
        const n = obNextAfterAccount();
        if (n) obGo(n, { replace: true }); else obFinish();
      };
      return;
    }
    if (!obGrace && caps.zoldenburgRecovery) {
      api(`/api/users/${user.id}/recovery/zoldenburg`)
        .then((r) => { obGrace = graceText(r.gracePeriodSeconds); const g = $("rec-grace"); if (g) g.textContent = obGrace; })
        .catch(() => { /* keep the generic wording */ });
    }
    const form = root.querySelector("#ob-form");
    form.addEventListener("change", () => {
      root.querySelector("#rec-choice-err").hidden = true;
      root.querySelector("#rec-skip").hidden = obChoice(root) !== "skip";
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      obClearErr();
      const choice = obChoice(root);
      const err = root.querySelector("#rec-choice-err");
      if (!choice) { err.textContent = "Choose how you’d get back in."; err.hidden = false; root.querySelector('input[name="recovery"]').focus(); return; }
      const btn = root.querySelector("#btn-next");
      if (choice === "email") return obGo("recovery-email");
      if (choice === "skip") {
        const ack = root.querySelector("#c-skip"), ackErr = root.querySelector("#c-skip-err");
        if (!ack.checked) { ackErr.textContent = "Tick the box to skip recovery."; ackErr.hidden = false; ack.focus(); return; }
      }
      Z.setLoading(btn, true);
      try {
        if (choice === "zoldenburg") {
          const prep = await api(`/api/users/${user.id}/recovery/zoldenburg`, { acknowledged: true });
          if (prep.challenge) await api(prep.submitTo, await passkeySignPrepared(prep));
        } else if (caps.zoldenburgRecovery) {
          // The decline is recorded, so the offer is not made again.
          await api(`/api/users/${user.id}/recovery/zoldenburg/decline`, { acknowledged: true });
        }
        renderUser(await api(`/api/users/${user.id}`));
        obRecoveryDone = choice;
        obRender({ focus: true });
      } catch (e2) { obShowErr(e2); } finally { Z.setLoading(btn, false); }
    });
  },
};
const obChoice = (root) => root.querySelector('input[name="recovery"]:checked')?.value || null;

/* Candide email enrolment: register (Face ID) -> code -> guardian (Face ID),
   against the signup email. Candide sends the code; Zold sends nothing. */
let obRecOtp = null; // { submitTo, target } while a code is outstanding
OB["recovery-email"] = {
  kind: "after",
  title: "Recovery by email",
  html: () => `${obAfterProgress("recovery-email", "Recovery")}
    <main id="main" class="z-screen__main">
      ${obIntro("Recovery by email", obRecOtp
        ? `Enter the code sent to ${esc(obRecOtp.target)}.`
        : `We’ll register ${esc(user.email)} for recovery codes. It takes two Face ID approvals.`)}
      ${obRecOtp ? `<form class="z-form" id="ob-form" novalidate>${Z.field({ id: "rec-code", name: "one-time-code", label: "Code", autocomplete: "one-time-code", inputmode: "numeric", maxlength: 10, spellcheck: false })}</form>`
        : `${Z.note({ icon: "info", text: "Someone who controls your mailbox could start a recovery too. The waiting period is what lets you stop it from this phone." })}`}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">
      ${obRecOtp ? obSubmit("Confirm") : Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Register with Face ID", id: "btn-rec-register" })}
      ${obRecOtp ? `<button type="button" class="z-link-btn" id="btn-rec-restart">Start over</button>` : `<a class="z-link-btn" href="#recovery">Choose another way</a>`}
    </div>`,
  bind: (root) => {
    const reg = root.querySelector("#btn-rec-register");
    if (reg) reg.onclick = async () => {
      if (Z.isDisabled(reg)) return;
      obClearErr();
      Z.setLoading(reg, true);
      try {
        const prep = await api(`/api/users/${user.id}/recovery/candide/channels`, { channel: "email", target: user.email });
        const sent = await api(prep.submitTo, await passkeySignPrepared(prep));
        obRecOtp = { submitTo: sent.submitTo, target: sent.target };
        obRender({ focus: true });
        $("rec-code")?.focus();
      } catch (e) { obShowErr(e); } finally { Z.setLoading(reg, false); }
    };
    const restart = root.querySelector("#btn-rec-restart");
    if (restart) restart.onclick = () => { obRecOtp = null; obRender({ focus: true }); };
    const form = root.querySelector("#ob-form");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      obClearErr();
      const code = root.querySelector("#rec-code");
      if (!code.value.trim()) { Z.setFieldError(code, "Enter the code."); code.focus(); return; }
      const btn = root.querySelector("#btn-next");
      Z.setLoading(btn, true);
      try {
        const r = await api(obRecOtp.submitTo, { otp: code.value.trim() });
        obRecOtp = null;
        user = { ...user, ...r, recovery: undefined, next: undefined };
        if (r.next === "guardian") {
          const prep = await api(`/api/users/${user.id}/recovery/candide/guardian`, {});
          const done = prep.challenge ? await api(prep.submitTo, await passkeySignPrepared(prep)) : prep;
          user = { ...user, ...done, recovery: undefined, status: undefined, opHash: undefined };
        }
        renderUser(await api(`/api/users/${user.id}`));
        if (user.passkeySafe?.candideRecovery?.guardianStatus === "active") {
          obRecoveryDone = "email";
          return obGo("recovery", { replace: true });
        }
        throw new Error("Your email is registered, but the last Face ID approval didn’t finish. You can finish it in Security.");
      } catch (e2) {
        // Five wrong codes end the registration server-side; the way on is to start over.
        obShowErr(e2);
      } finally { Z.setLoading(btn, false); }
    });
  },
};

/* ---- Monerium ---------------------------------------------------------------- */
OB.monerium = {
  kind: "after",
  title: "Get your IBAN",
  html: () => {
    const rejected = user?.kycStatus === "rejected";
    if (rejected) {
      return `${obAfterProgress("monerium", "Your IBAN")}
      <main id="main" class="z-screen__main">
        ${obIntro("Monerium couldn’t verify you", "Adding money and sending stay closed on this account. You can connect a different Monerium account, or write to support.")}
        ${Z.note({ tone: "a", text: "Monerium decides who it verifies. Zold can’t change its answer." })}
        ${obAlert()}
      </main>
      <div class="z-screen__foot">
        ${Z.button({ variant: "secondary", full: true, label: "Use a different Monerium account", id: "btn-kyc-reconnect" })}
        ${Z.button({ variant: "quiet", full: true, label: "Email support", href: "mailto:support@zoldhq.com" })}
      </div>`;
    }
    const any = caps.moneriumOAuth || caps.moneriumApiKeys;
    return `${obAfterProgress("monerium", "Your IBAN")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Get your IBAN", "Monerium checks your ID and issues an IBAN in your name. You sign in or sign up on Monerium’s site, then come back here.")}
      <div class="z-card z-partner">
        <span class="z-partner__name"><img src="/assets/logo-monerium.png" alt="" width="33" height="40" style="object-fit:contain">Monerium ehf.</span>
        <ul>
          <li>Takes a few minutes with your ID at hand.</li>
          <li>You can use Zold while Monerium reviews it.</li>
          <li>Your IBAN switches on with one Face ID approval.</li>
        </ul>
      </div>
      ${any ? "" : Z.note({ tone: "a", text: "Monerium can’t be connected on this version of Zold yet, so no IBAN can be issued here." })}
      <p class="z-hint">Monerium’s own terms apply. <a href="/partner-terms#monerium" target="_blank" rel="noopener">Partner terms</a></p>
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${caps.moneriumOAuth ? Z.button({ variant: "primary", full: true, icon: "open_in_new", label: "Continue with Monerium", id: "btn-monerium-existing" }) : ""}
      <button type="button" class="z-link-btn" id="btn-kyc-dashboard">Do this later</button>
      ${caps.moneriumApiKeys ? `<a class="z-link-btn z-link-btn--small" href="#monerium-keys">${Z.icon("code")}Developer option: use your own API keys</a>` : ""}
    </div>`;
  },
  bind: (root) => {
    const oauth = root.querySelector("#btn-monerium-existing");
    if (oauth) oauth.onclick = () => { Z.setLoading(oauth, true); startMoneriumConnect("ob-err").finally(() => Z.setLoading(oauth, false)); };
    const later = root.querySelector("#btn-kyc-dashboard");
    if (later) later.onclick = () => obFinish();
    const re = root.querySelector("#btn-kyc-reconnect");
    if (re) re.onclick = () => obReconnect(re);
  },
};

OB["monerium-keys"] = {
  kind: "after",
  title: "Monerium API keys",
  html: () => `${obBackHead("monerium", Z.tag("Beta"))}
    <main id="main" class="z-screen__main">
      ${obIntro("Use your own API keys", `For developers with their own Monerium account. Use keys from an app in Monerium ${esc(caps.moneriumEnvironment)} (${esc(caps.moneriumHost)}); keys from the other environment are refused.`)}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "kyc-mon-id", name: "client-id", label: "Client ID", spellcheck: false, placeholder: "From your Monerium app…" })}
        ${Z.field({ id: "kyc-mon-secret", name: "client-secret", type: "password", label: "Client secret", placeholder: "Shown once when the app was made…" })}
      </form>
      ${Z.note({ text: "Zold checks the pair with Monerium before storing anything, encrypts the secret and never shows it again. Your Monerium account and its IBANs stay yours." })}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${obSubmit("Verify and connect")}</div>`,
  bind: (root) => {
    root.querySelector("#ob-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      obClearErr();
      const id = root.querySelector("#kyc-mon-id"), secret = root.querySelector("#kyc-mon-secret");
      Z.setFieldError(id, id.value.trim() ? "" : "Enter the client ID.");
      Z.setFieldError(secret, secret.value ? "" : "Enter the client secret.");
      if (obFocusError(root)) return;
      const btn = root.querySelector("#btn-next");
      Z.setLoading(btn, true);
      try {
        const updated = await api(`/api/users/${user.id}/monerium/api-keys`, { clientId: id.value.trim(), clientSecret: secret.value });
        secret.value = "";
        renderUser(updated);
        obAfterMonerium();
      } catch (e2) { obShowErr(e2); } finally { Z.setLoading(btn, false); }
    });
  },
};

/* Connected, not yet approved: one Face ID approval links the account under
   the Monerium profile and asks for the IBAN. */
OB.activate = {
  kind: "after",
  title: "Switch on your IBAN",
  html: () => `${obAfterProgress("activate", "Switch on")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon("account_balance")}</span>
      ${obIntro("Switch on your IBAN", "Your Monerium account is connected. One Face ID approval links it to your Zold account and asks Monerium for your IBAN.")}
      ${Z.kv([
        { key: "Monerium", valueHtml: Z.tag("Connected", "mint") },
        { key: "How", value: user?.monerium?.method === "api_keys" ? "Your own API keys" : "Signed in with Monerium" },
        { key: "IBAN", valueHtml: user?.iban ? esc(Z.groupIban(user.iban)) : Z.tag("Waiting") },
      ])}
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${user?.iban ? "" : Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Switch on with Face ID", id: "btn-kyc-activate" })}
      <button type="button" class="z-link-btn" id="btn-kyc-refresh">Check again</button>
      <button type="button" class="z-link-btn z-link-btn--small" id="btn-kyc-reconnect">Use a different Monerium account</button>
    </div>`,
  bind: (root) => {
    const act = root.querySelector("#btn-kyc-activate");
    if (act) act.onclick = () => activateIbanAtGate(act);
    const ref = root.querySelector("#btn-kyc-refresh");
    ref.onclick = async () => { Z.setLoading(ref, true); await refreshKycStatus({ continueWhenApproved: true }); Z.setLoading(ref, false); };
    const re = root.querySelector("#btn-kyc-reconnect");
    re.onclick = () => obReconnect(re);
  },
};

/* After a connection: approved goes on, connected goes to the switch-on step. */
function obAfterMonerium() {
  if (kycApproved(user)) return obFinish();
  obGo(obNextAfterAccount() || "activate", { replace: true });
}

async function obReconnect(btn) {
  obClearErr();
  Z.setLoading(btn, true);
  try {
    const path = user.monerium?.method === "api_keys" ? "api-keys" : "connect";
    renderUser(await api(`/api/users/${user.id}/monerium/${path}`, undefined, "DELETE"));
    obGo("monerium", { replace: true });
  } catch (e) { obShowErr(e); } finally { Z.setLoading(btn, false); }
}

/* ---- Welcome ------------------------------------------------------------------ */
let obCard = 0;
OB.welcome = {
  kind: "after",
  title: "Welcome",
  html: () => {
    const cards = obWelcomeCards();
    const c = cards[obCard] || cards[0];
    const last = obCard >= cards.length - 1;
    return `<div class="z-screen__head"><div class="z-progress__head"><span class="z-sr">Card ${obCard + 1} of ${cards.length}</span><span><button type="button" class="z-link-btn" id="btn-welcome-skip">Skip</button></span></div></div>
    <main id="main" class="z-screen__main z-screen__main--center" style="padding-left:24px;padding-right:24px">
      <div class="z-card z-tour">${c.card}</div>
      <div class="z-intro"><h1 class="z-title" tabindex="-1">${esc(c.title)}</h1><p class="z-sub">${esc(c.sub)}</p></div>
      <div class="z-dots" aria-hidden="true">${cards.map((_, i) => `<span${i === obCard ? ' class="is-on"' : ""}></span>`).join("")}</div>
    </main>
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, label: last ? "Go to Home" : "Next", id: "btn-welcome-next" })}</div>`;
  },
  bind: (root) => {
    const done = () => { obCard = 0; obSetWelcomeDue(false); obFinish(); };
    root.querySelector("#btn-welcome-skip").onclick = done;
    root.querySelector("#btn-welcome-next").onclick = () => {
      if (obCard >= obWelcomeCards().length - 1) return done();
      obCard++;
      obRender({ focus: true });
    };
  },
};

/* Card one says where the IBAN really is. Nothing shows digits the API has not
   returned: an IBAN in review has none yet. */
function obWelcomeCards() {
  const iban = user?.iban;
  const connected = hasConnectedMonerium(user) || kycApproved(user);
  const ibanCard = iban
    ? { tag: Z.tag("Ready", "mint"), value: `<div class="z-tour__value" translate="no">${esc(Z.groupIban(iban))}</div>`, note: "Issued by Monerium in your name",
        title: "Your IBAN is ready.", sub: "Share it to get paid by bank transfer. You’ll find it on Home." }
    : connected
      ? { tag: Z.tag("In review"), value: `<div class="z-tour__value z-tour__value--text">Not issued yet</div>`, note: "Monerium is checking your ID",
          title: "Your IBAN is on its way.", sub: "We’ll show it on Home the moment Monerium approves. Until then you can look around." }
      : { tag: Z.tag("Waiting"), value: `<div class="z-tour__value z-tour__value--text">Not connected yet</div>`, note: "Connect Monerium from Home",
          title: "Get your IBAN when you’re ready.", sub: "It takes a few minutes with your ID at hand. Until then you can look around." };
  const plain = (icon, label, text) => `<div class="z-tour__row"><span>${label}</span>${Z.iconTile({ icon, tone: "p" })}</div><div class="z-tour__value z-tour__value--text">${text}</div>`;
  return [
    { card: `<div class="z-tour__row"><span>Your IBAN</span>${ibanCard.tag}</div>${ibanCard.value}<span class="z-tour__row">${ibanCard.note}</span>`, title: ibanCard.title, sub: ibanCard.sub },
    { card: plain("fingerprint", "Every payment", "Approved with your Face ID"), title: "Only you can move your money.", sub: "Each payment asks for your Face ID or fingerprint, for one amount to one recipient. Zold can’t send anything on its own." },
    { card: plain("account_balance", "Bank transfers", "Any IBAN in Europe"), title: "Pay by bank transfer.", sub: "You see the amount and any fee before you approve." },
    { card: plain("link", "Payment links", "Share a link, get paid"), title: "Get paid with a link.", sub: "Share a payment link or your IBAN. The money arrives in your own account." },
  ];
}

/* ---- Recover (lost device). The states are app/recovery.js's; this is the
   frame they render into. The recovery screens get their own design later. */
OB.recover = {
  kind: "recover",
  title: "Recover your account",
  html: () => `${obBackHead("auth", Z.tag("Beta"))}
    <main id="main" class="z-screen__main">
      ${obIntro("Recover your account", "Enter the email on your account. You’ll set up Face ID on this phone, then confirm a code or contact Zoldenburg support, depending on how the account is protected.")}
      <form class="z-form" id="rc-start" novalidate>
        ${Z.field({ id: "rc-email", name: "email", type: "email", label: "Email", autocomplete: "email", inputmode: "email", placeholder: "miriam@example.com…" })}
        ${Z.button({ variant: "primary", full: true, label: "Continue", type: "submit", id: "btn-rc-start" })}
      </form>
      <div id="rc-otp" class="z-form hidden"></div>
      <div id="rc-status" class="z-form hidden"></div>
      <div class="z-alert hidden" role="alert" id="rc-err"></div>
    </main>`,
  bind: (root) => {
    rcState = null;
    root.querySelector("#rc-start").addEventListener("submit", (e) => { e.preventDefault(); recoverStart(); });
  },
};

/* app/recovery.js calls this for its own back and "sign in" links. */
function showRecoverPanel(on) {
  obShow();
  obGo(on ? "recover" : "auth");
}

/* ==========================================================================
   The Monerium gate's actions (shared with Home's KYC card)
   ========================================================================== */

/* renderKycState() (app/monerium.js) calls this on every account update. The
   Monerium screens are redrawn from the new state; a form being typed into is
   left alone. */
function renderKycGate() {
  if (!obScreen || !["monerium", "activate"].includes(obScreen)) return;
  if ($("ob-root").contains(document.activeElement) && document.activeElement.matches("input")) return;
  obRender();
}

async function refreshKycStatus({ continueWhenApproved = false } = {}) {
  obClearErr();
  try {
    const k = await api(`/api/users/${user.id}/kyc`);
    user = { ...user, ...k, funding: k.funding ?? user.funding };
    renderKycState(user);
    if (kycApproved(user) && continueWhenApproved) {
      renderUser(await api(`/api/users/${user.id}`));
      return obFinish();
    }
  } catch (e) { obShowErr(e); }
}

async function startMoneriumConnect(errorId = "ob-err") {
  try {
    const redirectUri = `${location.origin}/api/monerium/oauth/callback`;
    const connect = await api(`/api/users/${user.id}/monerium/connect/start`, { redirectUri });
    const target = safeUrl(connect.redirectUrl);
    if (!target) throw new Error("Monerium returned an unusable sign-in address");
    location.href = target;
  } catch (e) {
    if ($(errorId)?.classList.contains("z-alert")) obShowErr(e, errorId);
    else showErr(errorId, e);
  }
}

/* Activation: the account is still pending (activation is what approves it),
   so this deliberately does not require approval first. */
async function activateIbanAtGate(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr();
  Z.setLoading(btn, true);
  try {
    await issueAppIban();
    if (kycApproved(user)) return obFinish();
    obRender({ focus: true });
  } catch (e) { obShowErr(e); } finally { Z.setLoading(btn, false); }
}

/* Link the deployed Safe to Monerium and request the app IBAN. One passkey
   ceremony signs the ownership declaration; the server signs as the Safe
   (EIP-1271) and asks Monerium for the IBAN. Works for both approval paths:
   a connected Monerium account uses its own OAuth token, an in-house-approved
   account goes through the app credentials on the server. Returns true when
   the ceremony ran. */
async function issueAppIban() {
  // A connected Monerium account may activate before approval — activation
  // IS what approves it (address-matched IBAN on the connected account).
  if (!user?.id || user.iban || !(kycApproved(user) || hasConnectedMonerium(user))) return false;
  if ((user.funding || {}).mode !== "sandbox") return false;
  await finishPasskeySafeSetup();
  let profileId = user.monerium?.profileId;
  if (hasConnectedMonerium()) {
    const accounts = await api(`/api/users/${user.id}/monerium/accounts`);
    user = { ...user, monerium: { ...(user.monerium || {}), ...accounts } };
    profileId = user.monerium?.profileId || accounts.profiles?.[0]?.id;
  }
  const start = await api(`/api/users/${user.id}/monerium/link-signature/start`, { profileId });
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(start.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(start.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  let activated;
  try {
    activated = await api(start.submitTo, {
      profileId,
      linkSignatureRequestId: start.requestId,
      credentialId: cred.id,
      authenticatorData: b64url(cred.response.authenticatorData),
      clientDataJSON: b64url(cred.response.clientDataJSON),
      signature: b64url(cred.response.signature),
    });
  } catch (e) {
    if (e.code !== "IBAN_EXISTS_ELSEWHERE" || !e.body?.existing) throw e;
    // The profile's one IBAN pays another address. Only the user decides
    // whether to move it; the API recorded nothing but the reason.
    activated = await offerIbanMove(e.body.existing, profileId);
    if (!activated) {
      renderUser(await api(`/api/users/${user.id}`));
      throw new Error("IBAN not moved. Your Monerium IBAN still pays into the other wallet; move it whenever you are ready.");
    }
  }
  renderUser(activated);
  return true;
}

/* "Move my existing Monerium IBAN to Zold". A Monerium profile has ONE IBAN,
   so a user who already has one cannot get a second; they can point the one
   they have at this Safe. Resolves with the account as the API returns it
   after the move, or null on Cancel. Nothing here says "done": the caller
   renders whatever the API reports, and the API approves only once Monerium
   lists the IBAN against this Safe. */
function offerIbanMove(existing, profileId) {
  const iban = String(existing.iban || "").replace(/\s+/g, "").toUpperCase();
  const masked = `•••• •••• •••• ${iban.slice(-4)}`;
  const from = existing.address ? String(existing.address) : "another address";
  const dlg = document.createElement("dialog");
  dlg.className = "m-dialog";
  dlg.setAttribute("aria-labelledby", "m-mv-title");
  dlg.innerHTML = `
    <h2 id="m-mv-title">Your Monerium IBAN already pays somewhere else</h2>
    <div class="m-lede" style="font-size:13px">Monerium gives each profile one IBAN. Yours exists, so Zold cannot get a second one. You can move it to this account instead.</div>
    <div class="m-rows">
      <div class="m-detrow"><div style="min-width:0"><div class="m-rowk">IBAN</div><div class="m-rowv">${esc(masked)}</div></div></div>
      <div class="m-detrow"><div style="min-width:0"><div class="m-rowk">Pays into now</div><div class="m-rowv">${esc(from)}</div></div></div>
    </div>
    <div class="m-note warn" style="margin-top:16px;font-size:13px;line-height:1.45">
      After the move, payments to this IBAN arrive in your Zold account and the old wallet stops receiving them.
      Anyone paying you keeps using the same IBAN. You can move it back from Monerium.
    </div>
    <div class="m-field" style="margin-top:16px"><label for="m-mv-confirm">Type MOVE to confirm</label>
      <input id="m-mv-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
    <div class="m-lede hidden" id="m-mv-status" role="status" style="font-size:13px;margin-top:12px"></div>
    <div class="m-err hidden" role="alert" id="m-mv-err" style="margin-top:12px"></div>
    <button class="m-cta" id="m-mv-go" disabled>Move IBAN to Zold</button>
    <button class="m-cta quiet" id="m-mv-cancel">Cancel</button>`;
  document.body.appendChild(dlg);
  const q = (id) => dlg.querySelector(`#${id}`);
  const go = q("m-mv-go");
  const cancel = q("m-mv-cancel");
  const input = q("m-mv-confirm");
  const status = q("m-mv-status");
  const errEl = q("m-mv-err");
  input.oninput = () => { go.disabled = input.value.trim() !== "MOVE"; };

  return new Promise((resolve) => {
    let busy = false;
    let result = null;
    const finish = () => { dlg.close(); dlg.remove(); resolve(result); };
    cancel.onclick = () => { if (!busy) finish(); };
    // Escape is Cancel, but never mid-ceremony.
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); if (!busy) finish(); });
    go.onclick = async () => {
      if (result) return finish();
      busy = true;
      go.disabled = true;
      cancel.disabled = true;
      errEl.classList.add("hidden");
      try {
        const start = await api(`/api/users/${user.id}/monerium/link-signature/start`, { profileId, purpose: "move-iban", iban });
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBytes(start.challenge),
            allowCredentials: [{ type: "public-key", id: b64urlToBytes(start.credentialId) }],
            userVerification: "required",
            timeout: 60000,
          },
        });
        status.textContent = "Asking Monerium to move the IBAN…";
        status.classList.remove("hidden");
        const moved = await api(start.submitTo, {
          iban,
          confirm: input.value.trim(),
          requestId: start.requestId,
          credentialId: cred.id,
          authenticatorData: b64url(cred.response.authenticatorData),
          clientDataJSON: b64url(cred.response.clientDataJSON),
          signature: b64url(cred.response.signature),
        });
        result = moved;
        if (moved.iban && kycApproved(moved)) return finish();
        // Accepted, not yet visible at Monerium: say exactly that.
        status.textContent = "Monerium accepted the move but does not list the IBAN on your Zold account yet. It is checked again each time you open the app; until then it is not shown as yours.";
        go.textContent = "OK";
        go.disabled = false;
        input.disabled = true;
      } catch (e) {
        status.classList.add("hidden");
        errEl.textContent = e.name === "NotAllowedError" ? "Face ID was cancelled." : e.message;
        errEl.classList.remove("hidden");
        go.disabled = input.value.trim() !== "MOVE";
      } finally {
        busy = false;
        cancel.disabled = !!result;
      }
    };
    dlg.showModal();
    input.focus();
  });
}

async function activateConnectedMonerium() {
  clearErr("dep-err");
  try {
    // A pending account with nothing connected still needs a Monerium
    // connection; an approved or connected account activates directly.
    if (!hasConnectedMonerium() && !kycApproved(user)) return startMoneriumConnect("dep-err");
    await issueAppIban();
  } catch (e) { showErr("dep-err", e); }
}

async function finishDashboardSmartWallet() {
  clearErr("dep-err");
  try {
    await finishPasskeySafeSetup();
    renderUser(user);
    const issued = await issueAppIban();
    if (!issued) await refresh();
  } catch (e) { showErr("dep-err", e); }
}

/* ==========================================================================
   Passkey ceremonies
   ========================================================================== */
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function registerPasskey(u) {
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "register" });
  const label = pendingInfo?.email || u.email || pendingInfo?.name || u.name;
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      rp: { name: "Zold", id: location.hostname },
      user: {
        id: new TextEncoder().encode(u.id),
        name: label,
        displayName: pendingInfo?.name || u.name,
      },
      // ES256 (P-256) only. This passkey becomes the Safe's owner, which
      // verifies P-256 signatures; any other algorithm would fail at deployment.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      timeout: 60000,
      // Ask for the PRF extension so this passkey can encrypt the
      // device spending key. Authenticators without it still register fine.
      extensions: { prf: {} },
    },
  });
  const updated = await api(`/api/users/${u.id}/passkey`, {
    credentialId: cred.id,
    attestation: b64url(cred.response.attestationObject),
    clientDataJSON: b64url(cred.response.clientDataJSON),
  });
  // Keep the full returned account locally. It includes the passkey Safe plan
  // that the next onboarding step deploys.
  user = { ...user, ...updated };
  if (!cred.getClientExtensionResults?.().prf?.enabled) {
    console.warn("this authenticator reports no PRF support — the device key cannot be passkey-encrypted");
  }
}

async function activatePasskeySafe() {
  if (!user?.id || !credId() || !window.PublicKeyCredential) return;
  const prepared = await api(`/api/users/${user.id}/passkey-safe/deployment`, {});
  if (!prepared.challenge) {
    user = { ...user, ...prepared };
    return;
  }
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(prepared.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(prepared.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  const activated = await api(prepared.submitTo, {
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  });
  user = { ...user, ...activated };
}

async function finishPasskeySafeSetup(timeoutMs = 45000) {
  if (!user?.passkeySafe || user.passkeySafe.status === "active") return;
  await Promise.race([
    activatePasskeySafe(),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("setting up your account took too long")), timeoutMs),
    ),
  ]);
  if (needsPasskeySafeSetup(user)) {
    throw new Error("your account was not set up");
  }
}

/* The passkey credential this browser wraps the device key with. */
const credId = () => user?.passkey?.credentialId || null;

async function passkeyStepUp() {
  if (!credId()) return null;
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "step_up" });
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(credId()) }],
      // A step-up gates binding a spending key: the server now requires the UV
      // flag, so ask the authenticator to actually verify the human.
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: cred.id,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* The send-time approval of this transfer's debit. The server prepared the
   Safe operation that moves exactly this transfer's amount out of your Safe;
   the passkey signs its hash here, so the movement itself — amount and
   destination — is what you approve, and the chain enforces it. Nothing can
   move without one of these signatures. */
async function safeExecutionAssertion(authorization) {
  const exec = authorization?.safeExecution;
  if (!exec) return undefined;
  if (!exec.challenge || !exec.credentialId) return undefined;
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(exec.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(exec.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: exec.credentialId,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

async function moneriumRedeemAssertion(authorization) {
  const redeem = authorization?.moneriumRedeem;
  if (!redeem) return undefined;
  if (!redeem.challenge || !redeem.credentialId) return undefined;
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(redeem.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(redeem.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: redeem.credentialId,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* Mint the device key and bind it as the account's payment authorizer.
   Runs after passkey registration so the key can be wrapped with the
   authenticator's PRF secret; the server takes the first binding and refuses
   re-binding by anyone but the device, so this establishes, never steals. */
async function registerDeviceKey(u) {
  const dev = await deviceLib;
  const { address, protection } = dev.keyStatus().present
    ? { address: await dev.deviceAddress(credId()), protection: dev.keyStatus().protection }
    : await dev.createKey(credId());
  const updated = await api(`/api/users/${u.id}/authorizer`, { address, stepUp: await passkeyStepUp() });
  if (updated.authorizerAddress) user = { ...user, authorizerAddress: updated.authorizerAddress };
  if (protection !== "prf") {
    console.warn("device key stored unprotected — this authenticator has no PRF support");
  }
  return updated;
}

/* ==========================================================================
   Home's own buttons (the dashboard still lives in index.html)
   ========================================================================== */
$("btn-monerium-dashboard").onclick = () => activateConnectedMonerium();
$("btn-finish-safe").onclick = () => finishDashboardSmartWallet();
$("btn-dash-kyc-refresh").onclick = async () => {
  await refresh();
  if (kycApproved(user)) enterDashboard(user.name);
};
$("btn-recovery-start").onclick = startRecoveryRequest;
$("m-pf-recovery").onclick = () => mobileNav("recovery");
$("m-pf-documents").onclick = () => mobileNav("documents");
$("m-pf-links").onclick = () => mobileNav("links");
$("btn-links").onclick = () => mobileNav("links");
$("m-det-receipt").onclick = async () => {
  const t = hist.find((x) => x.id === mDetailId);
  if (!t) return;
  try {
    const d = await api(`/api/users/${user.id}/documents/receipt`, { transferId: t.id });
    window.open(d.url, "_blank", "noopener");
  } catch (e) { $("m-det-error").textContent = e.message; $("m-det-error").classList.remove("hidden"); }
};

/**
 * /app?pay=<handle>/<code> — "Open in Zold" from a payment request page.
 *
 * Reads the public request and enters the SEPA send flow with the payee's
 * account, the amount and the reference filled in. Filled in, not hidden: the
 * IBAN is what the device signs a commitment over, so it stays on screen.
 */
async function handlePayDeepLink() {
  const qs = new URLSearchParams(location.search);
  const target = qs.get("pay");
  if (!target || !user) return;
  history.replaceState(null, "", location.pathname);
  const [handle, code] = target.split("/");
  if (!handle || !code) return;
  try {
    const p = await api(`/api/pay/${encodeURIComponent(handle)}/${encodeURIComponent(code)}`);
    const b = p.methods?.bank;
    if (!b) throw new Error("this request cannot be paid from a Zold account — it takes crypto only");
    if (p.state !== "OPEN") throw new Error(`this payment request is ${p.state.toLowerCase()}`);
    const amount = p.outstandingEur ?? Number(qs.get("amount") || 0);
    $("m-amount").value = amount > 0 ? String(amount) : "";
    startSend("sepa", { rail: "sepa", name: b.holder, id: b.iban, reference: b.reference });
  } catch (e) {
    alert(e.message);
  }
}

/* Signed out: the screen the hash names if it is one a signed-out person may
   see, else sign-in. Returning users see sign-in first. */
function obStart() {
  obShow();
  const want = location.hash.slice(1);
  obGo(OB[want] && ["entry", "form", "recover"].includes(OB[want].kind) ? want : "auth", { replace: true, focus: false });
}

async function resumeSession(capabilitiesLoaded) {
  // A return from Monerium's sign-in lands on /app?monerium=connected.
  const qs = new URLSearchParams(location.search);
  if (qs.has("monerium")) {
    qs.delete("monerium");
    history.replaceState(null, "", `${location.pathname}${qs.size ? `?${qs}` : ""}${location.hash}`);
  }
  if (!sessionToken) {
    await capabilitiesLoaded;
    return obStart();
  }
  try {
    const u = await api("/api/session");
    renderUser(u);
    await capabilitiesLoaded;
    const next = obNextAfterAccount();
    if (!next) {
      enterDashboard(user.name);
      await handlePayDeepLink();
      return;
    }
    obShow();
    const want = location.hash.slice(1);
    // Reload on a later step it may still see (keys form, welcome) stays there.
    obGo(OB[want]?.kind === "after" && obGuard(want) === want ? want : next, { replace: true, focus: false });
  } catch {
    sessionToken = null;
    localStorage.removeItem("zold-session");
    localStorage.removeItem("zoll-session");
    await capabilitiesLoaded;
    obStart();
  }
}
