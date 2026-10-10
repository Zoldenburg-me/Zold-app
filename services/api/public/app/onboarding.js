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
  name = ownAccountName() || name;
  let invite = null;
  try { invite = sessionStorage.getItem("zold-invite"); sessionStorage.removeItem("zold-invite"); } catch {}
  if (invite) {
    // Used once: a reload must not redeem (or fail on) the same link again.
    const qs = new URLSearchParams(location.search);
    if (qs.has("invite")) {
      qs.delete("invite");
      history.replaceState(history.state, "", `${location.pathname}${qs.size ? `?${qs}` : ""}${location.hash}`);
    }
    api("/api/orgs/invites/accept", { token: invite })
      .then(() => location.replace("/business"))
      // 404 and 410 are a dead link; a 403 or 409 says why this account
      // cannot take it (another email, already a member).
      .catch((e) => errShow("link", [404, 410].includes(e?.status) ? {}
        : { title: "This invitation can’t be accepted", sub: obMessage(e) }));
  }
  obScreen = null;
  $("onboard").style.display = "none";
  // An onboarding hash is not an app screen: the app then opens on Home.
  if (OB[location.hash.slice(1)]) history.replaceState(null, "", location.pathname + location.search);
  // The older screens still live in #dashboard, in its phone layout.
  $("dashboard").classList.add("m-on");
  phStart();
  $("userpill").style.display = "flex";
  $("pillname").textContent = name;
  $("avatar").textContent = name.trim()[0].toUpperCase();
  if (poll) clearInterval(poll);
  poll = setInterval(refresh, 5000);
  refresh();
  // A "Pay with Zold" link opened while signed out waits for this moment.
  void handlePayDeepLink();
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

/* Home's "Confirm your email" row: the code screen, then back to wherever
   the account is. */
function enterEmailConfirm() {
  obEmailSkipped = false;
  obShow();
  obGo("email", { replace: true });
}

/* Is the account's email still to be confirmed on this visit? "Do this later"
   holds until the app is reopened; Home keeps a row for it meanwhile. */
let obEmailSkipped = false;
function emailConfirmPending(u = user) {
  return !!(caps.emailVerification && u?.email && !u.emailVerifiedAt && !obEmailSkipped);
}

/* ==========================================================================
   Router
   ========================================================================== */

let obScreen = null;
let obBlockedCode = null;
/* An import of the company's existing Safe on this screen visit:
   { address, prepared, mode }. Nothing here is the truth; `prepare` is. */
let obImport = null;
/* Recovery choice made on this screen: shows its confirmation before moving on. */
let obRecoveryDone = null;

function obShow() {
  $("dashboard").style.display = "none";
  $("phone").hidden = true;
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
  if (kind === "state") return errState && name === `state-${errState.kind}` ? name : "auth";
  if (kind === "recover") {
    if (!caps.emailSmsRecovery && !caps.zoldenburgRecovery) return "auth";
    // A later recovery step is shown only while the request's state names it.
    return name === "recover" ? name : rcRouteFor(rcState);
  }
  if (kind === "after") {
    if (!signedUp) return "auth";
    if (name === "welcome") return name;
    if (name === "email") return caps.emailVerification && user.email && !user.emailVerifiedAt ? name : obNextAfterAccount() || "monerium";
    if (name === "recovery-email") return caps.emailSmsRecovery && user.passkeySafe?.status === "active" && recoveryOfferedFor() ? name : obNextAfterAccount() || "monerium";
    if (name === "monerium-keys") return caps.moneriumApiKeys && !kycApproved(user) ? name : obNextAfterAccount() || "monerium";
    if (name === "recovery") return recoveryEnrolmentPending() || obRecoveryDone ? name : obNextAfterAccount() || "monerium";
    return name;
  }
  if (kind === "import") {
    if (!signedUp) return "auth";
    if (!safeImportOffered(user)) return obNextAfterAccount() || "monerium";
    // The owner-change screen needs a `prepare` answer; confirm needs an address.
    if (name === "b-import-sign" && !obImport?.prepared) return safeImportFlag() ? "b-import-confirm" : "b-import-address";
    if (name === "b-import-confirm" && !safeImportFlag()) return "b-import-address";
    return name;
  }
  // A link from the website straight to a path's first step picks the path.
  if (!obDraft.type && (name === "p-name" || name === "b-entity")) obDraft.type = name === "b-entity" ? "company" : "individual";
  // Before the account: an account that exists goes to its own next step.
  if (signedUp && user.passkey && !needsPasskeySafeSetup(user)) return obNextAfterAccount() || "monerium";
  if (kind === "entry") return name;
  if (signedUp) return obSetupScreen(user);
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

/* An account with no live Safe yet. A company that may still bring in its own
   Safe never goes back to b-passkey, whose button deploys a new one: it gets
   the choice, or the import it started on this device. */
function obSetupScreen(u) {
  if (u.passkey && safeImportOffered(u)) return safeImportFlag(u) ? "b-import-confirm" : "b-safe-choice";
  return u.accountType === "company" ? "b-passkey" : "p-passkey";
}

/* Where an account that exists goes next. null: nothing left, open the app. */
function obNextAfterAccount(u = user) {
  if (!u) return "auth";
  if (!u.passkey || needsPasskeySafeSetup(u)) return obSetupScreen(u);
  if (emailConfirmPending(u)) return "email";
  if (zoldenburgChoicePending(u)) return "recovery";
  // A wallet account has no bank step to take: the app opens.
  if (!bankOffered(u)) return null;
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

// Leaving with answers typed, no account yet and no saved copy loses them.
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

/* A phone's prompt is Face ID or a fingerprint. A computer's may be Touch ID,
   Windows Hello, its password, a phone by QR code or a security key, so there
   it is named for what it makes: a passkey. */
const obOnPhone = () => !!window.matchMedia?.("(pointer: coarse)").matches;

/* A cancelled Face ID prompt is the user's choice, not a fault: say so plainly. */
function obMessage(e) {
  // A touch screen is a phone or tablet, where the prompt is Face ID or a
  // fingerprint; on a computer it may be Touch ID, Windows Hello, a phone by
  // QR code or a security key, so it is named for what it is: a passkey.
  const phone = obOnPhone();
  // Before the names: Chromium refuses a second open prompt as InvalidStateError.
  if (passkeyPending(e)) {
    return phone
      ? "A Face ID prompt is still open. Finish or close it, then try again."
      : "A passkey prompt is still open, maybe in another window, a tab or your password manager. Close it, reload this page, then try again.";
  }
  if (e?.name === "NotAllowedError") {
    return phone
      ? "Face ID or fingerprint was cancelled, or it timed out. Try again when you’re ready."
      : "The passkey prompt was cancelled, or it timed out. Try again when you’re ready.";
  }
  if (e?.name === "InvalidStateError") {
    return `This ${phone ? "phone" : "device"} already has a Zold sign-in for this account. Sign in instead.`;
  }
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
  // Only answers held in memory alone are lost on a reload: saved ones come
  // back, so "Leave site?" asks only when the save failed (private mode).
  try { sessionStorage.setItem(OB_DRAFT_KEY, JSON.stringify(obDraft)); obDraftTouched = false; }
  catch { obDraftTouched = true; }
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
  return [...(caps.emailVerification && !user?.emailVerifiedAt ? ["email"] : []), ...((caps.emailSmsRecovery || caps.zoldenburgRecovery) && !user?.passkeySafe?.importedAt ? ["recovery"] : []), ...(bankOffered() ? ["monerium", "activate"] : [])];
}
function obAfterProgress(name, label) {
  const steps = obAfterSteps();
  const i = steps.indexOf(name === "recovery-email" ? "recovery" : name === "monerium-keys" ? "monerium" : name);
  // A screen outside the numbered steps (a wallet account's bank screen) has
  // no "step n of m" to show.
  if (i < 0) return obBackHead(null);
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
      ${obOnPhone()
        ? obIntro("Set up Face ID or fingerprint", "It creates a sign-in key that never leaves this phone.")
        : obIntro("Create a passkey", "Approve it with Touch ID, your computer’s password, your phone or a security key. No face or fingerprint needed.")}
      <ul class="z-points">
        <li>${Z.icon("lock")}<span>It’s the only key to your account. Zold never sees it.</span></li>
        <li>${Z.icon("password")}<span>No Zold password to remember or leak.</span></li>
        <li>${Z.icon("restore")}<span>Set up recovery next, in case you lose this ${obOnPhone() ? "phone" : "device"}.</span></li>
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
      ${obIntro("Set up the company’s first approver", obOnPhone()
        ? `This phone becomes the first approver for ${esc(obCompany())}.`
        : `Your passkey makes you the first approver for ${esc(obCompany())}. Approve it with Touch ID, your computer’s password, your phone or a security key.`)}
      <ul class="z-points">
        <li>${Z.icon("lock")}<span>Company payments you draft need a teammate’s approval. Zold can’t approve any.</span></li>
        <li>${Z.icon("group_add")}<span>Invite teammates and give each a role after the account opens.</span></li>
        <li>${Z.icon("restore")}<span>Set up recovery next, in case you lose this ${obOnPhone() ? "phone" : "device"}.</span></li>
      </ul>
      ${obSetupSteps()}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, icon: "fingerprint", label: obPasskeyLabel(), id: "btn-passkey" })}</div>`,
  bind: (root) => { root.querySelector("#btn-passkey").onclick = (e) => obCreateAccount(e.currentTarget); },
};

/* ---- Bringing in the company's existing Safe --------------------------------
   Instead of deploying a new Safe, a company can bring in the Safe it already
   has (routes/safe-import.ts). The Safe's current owner, usually a hardware
   wallet, adds this phone's passkey as an owner in Safe{Wallet}; Zold never
   collects, relays or asks for that signature. Then `confirm` reads the chain
   and binds the Safe. Until it returns 201 nothing is imported, and these
   screens say so. Sending the owner change from a connected wallet here is
   not built: the file goes to Safe{Wallet}. */

const OB_CHAINS = { 8453: "Base", 84532: "Base Sepolia" };
const obChainName = (id) => OB_CHAINS[id] || `network ${id}`;
const SAFE_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/* One plain sentence per refusal. The server's own text is never shown alone. */
function obImportSentence(e) {
  const chain = obImport?.prepared ? obChainName(obImport.prepared.chainId) : "the network Zold uses";
  const s = {
    NO_CHAIN: "This Zold server can’t bring in a Safe.",
    NO_PASSKEY: "Set up Face ID sign-in on this phone first.",
    SAFE_ACTIVE: "This login already has its own account, so it can’t take a second one.",
    BAD_ADDRESS: "That isn’t a Safe address. It starts with 0x, followed by 40 letters and digits.",
    OWN_PLAN: "That’s the new account Zold prepared for you, not your company’s existing Safe.",
    ADDRESS_IN_USE: "Another Zold login already uses that Safe.",
    SAFE_DEPLOYED: "This login’s own account has already been set up, so it can’t switch to another Safe.",
    PLAN_HAS_FUNDS: "Money has already arrived at the new account Zold prepared for this login, so it can’t switch to another Safe.",
    RPC_FAILED: "Zold couldn’t read the network just now. Nothing was changed. Try again in a minute.",
    NO_CODE: `There’s no Safe at that address on ${chain}. Check the address, and that the Safe is on ${chain}.`,
    WRONG_SINGLETON: "This Safe is a version Zold can’t sign for. Zold works with Safe version 1.4.1 set up for ERC-4337.",
    MODULE_4337_DISABLED: "This Safe isn’t set up for the kind of payments Zold sends (its ERC-4337 module is off).",
    WRONG_FALLBACK_HANDLER: "This Safe isn’t set up for the kind of payments Zold sends (its fallback handler isn’t the ERC-4337 module).",
    EXTRA_MODULES: "This Safe has other modules switched on. Remove them in Safe{Wallet} under Settings → Modules, then try again.",
    GUARD_SET: "This Safe has a transaction guard. Remove it in Safe{Wallet} settings, then try again.",
    THRESHOLD_NOT_ONE: "This Safe needs more than one approval per payment. Zold collects only this phone’s approval, so lower it to 1 in Safe{Wallet} first.",
    TOO_MANY_OWNERS: "This Safe has more owners than Zold allows: this phone plus at most one of your own wallets. Remove the others in Safe{Wallet} first.",
    VERIFIER_NOT_OWNER: "The owner change isn’t on the network yet. Wait a minute after sending it, then try again.",
    VERIFIER_NO_CODE: "Zold couldn’t set up this phone’s signer on the network yet. Try again in a minute.",
    VERIFIER_PENDING: "This phone’s signer is still being set up on the network. Try again in a minute.",
    STEP_UP_REQUIRED: "Approve with Face ID to bring in this Safe.",
    STEP_UP_CREDENTIAL: "That approval came from another passkey. Approve with the one this login uses.",
    STEP_UP_INVALID: "That approval didn’t match the Safe as the network shows it now, or it expired. Check the Safe again and approve.",
    SAFE_CHANGED: "The Safe’s owners changed after you approved. Check the Safe again and approve it as it is now.",
  }[e?.code];
  if (s) return s;
  if (e?.offline) return "You appear to be offline. Zold could not be reached.";
  return `Zold couldn’t check this Safe (${obMessage(e).replace(/\.$/, "")}).`;
}

function obImportErr(e) { obShowErr(new Error(obImportSentence(e))); }

/* Every import screen offers the way back until confirm succeeds. */
const obNewAccountLink = () => `<button type="button" class="z-link-btn" id="btn-import-new">Use a new account instead</button>`;
function obBindNewAccountLink(root) {
  const b = root.querySelector("#btn-import-new");
  if (b) b.onclick = () => { clearSafeImportFlag(); obImport = null; obGo("b-safe-choice"); };
}

/* The Safe as the chain shows it, from the last `prepare`. */
function obSafeSummary(p) {
  const owners = p.owners.map((o) => `<span class="z-mono" translate="no" style="display:block;word-break:break-all">${esc(o)}${o.toLowerCase() === p.verifier.toLowerCase() ? " (this phone)" : ""}</span>`).join("");
  return Z.kv([
    { key: "Safe", valueHtml: `<span class="z-mono" translate="no" style="word-break:break-all">${esc(p.safeAddress)}</span>` },
    { key: "Network", value: obChainName(p.chainId) },
    { key: p.owners.length === 1 ? "Owner now" : "Owners now", valueHtml: owners },
    { key: "Approvals needed", value: `${p.threshold} of ${p.owners.length}` },
  ]);
}

/* Ask the server again. The flag says which Safe; `prepare` says what is true. */
async function obPrepareImport(address) {
  const p = await api(`/api/users/${user.id}/safe/import/prepare`, { address });
  obImport = { ...(obImport || {}), address: p.safeAddress, prepared: p };
  setSafeImportFlag(p.safeAddress);
  return p;
}

function obDownloadFile(file) {
  const url = URL.createObjectURL(new Blob([file.json], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: file.fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const obChoiceHtml = (name, v, title, text, checked) =>
  `<label class="z-choice"><input type="radio" name="${name}" value="${v}"${checked ? " checked" : ""}><span class="z-choice__main"><span class="z-choice__title">${title}</span><span class="z-choice__text">${text}</span></span></label>`;

OB["b-safe-choice"] = {
  kind: "import",
  title: "Business: choose the account",
  html: () => `${obBackHead(null)}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Where should the money sit?", `Your Face ID sign-in is saved. Choose the account ${esc(obCompany())} uses in Zold.`)}
      <form class="z-form z-form--tight" id="ob-form" novalidate>
        <fieldset class="z-form z-form--tight" style="border:0;margin:0;padding:0;min-width:0">
          <legend class="z-sr">Which account</legend>
          ${obChoiceHtml("safe-choice", "new", "Open a new account", "Zold sets up a new account for the company. One more Face ID approval.", true)}
          ${obChoiceHtml("safe-choice", "import", "Use our company’s existing Safe", "You already have a Safe, owned by a wallet such as a Ledger. Its owner adds this phone as an owner. No money moves.", false)}
        </fieldset>
      </form>
      ${obSetupSteps()}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${obSubmit("Continue")}</div>`,
  bind: (root) => {
    obBindForm(root, async () => {
      const btn = root.querySelector("#btn-next");
      if (Z.isDisabled(btn)) return;
      if (root.querySelector('input[name="safe-choice"]:checked')?.value === "import") return obGo("b-import-address");
      obClearErr();
      clearSafeImportFlag();
      obImport = null;
      Z.setLoading(btn, true);
      try { await obOpenOwnSafe(btn); } catch (e) { obSetupFailed(e); } finally {
        Z.setLoading(btn, false);
        const label = btn.querySelector("span:last-child");
        if (label) label.textContent = "Continue";
      }
    });
  },
};

OB["b-import-address"] = {
  kind: "import",
  title: "Business: your Safe’s address",
  html: () => {
    const p = obImport?.prepared;
    return `${obBackHead("b-safe-choice")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro(p ? "Is this your Safe?" : "Your company’s Safe", p
        ? "This is what the network shows for that address."
        : "Paste the Safe’s address. You find it at the top left of app.safe.global. It starts with 0x.")}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "safe-addr", name: "safe-address", label: "Safe address", autocomplete: "off", value: obImport?.address || "", maxlength: 42, placeholder: "0x…", spellcheck: false })}
      </form>
      ${p ? obSafeSummary(p) : ""}
      ${p?.alreadyOwner ? Z.note({ icon: "check_circle", text: "This phone is already an owner of the Safe. Nothing needs signing; finish on the next screen." }) : ""}
      ${obAlert()}
    </main>
    <div class="z-screen__foot">${p ? Z.button({ variant: "primary", full: true, label: "Yes, continue", id: "btn-import-next" }) : ""}${obSubmit(p ? "Check another address" : "Check this Safe").replace("z-btn--primary", p ? "z-btn--secondary" : "z-btn--primary")}${obNewAccountLink()}</div>`;
  },
  bind: (root) => {
    obBindNewAccountLink(root);
    const next = root.querySelector("#btn-import-next");
    if (next) next.onclick = () => obGo(obImport.prepared.alreadyOwner ? "b-import-confirm" : "b-import-sign");
    obBindForm(root, async () => {
      const btn = root.querySelector("#btn-next");
      if (Z.isDisabled(btn)) return;
      obClearErr();
      const input = root.querySelector("#safe-addr");
      const address = input.value.trim();
      if (!SAFE_ADDRESS_RE.test(address)) {
        Z.setFieldError(input, address ? obImportSentence({ code: "BAD_ADDRESS" }) : "Enter the Safe’s address.");
        return input.focus();
      }
      Z.setLoading(btn, true);
      try {
        obImport = { address, prepared: null };
        await obPrepareImport(address);
        obRender({ focus: true });
      } catch (e) {
        // No answer, no download: nothing from a failed prepare is kept.
        obImport = { address, prepared: null };
        obImportErr(e);
      } finally { Z.setLoading(btn, false); }
    });
  },
};

OB["b-import-sign"] = {
  kind: "import",
  title: "Business: add this phone to your Safe",
  html: () => {
    const p = obImport.prepared;
    const add = p.ownerChange?.add, swap = p.ownerChange?.swap;
    const canAdd = !!add && !add.refused, canSwap = !!swap && !swap.refused;
    if (!canAdd && !canSwap) {
      return `${obBackHead("b-import-address")}
      <main id="main" class="z-screen__main">
        ${obIntro("Zold can’t add this phone to that Safe", obImportSentence({ code: "TOO_MANY_OWNERS" }))}
        ${obSafeSummary(p)}
      </main>
      <div class="z-screen__foot">${obNewAccountLink()}</div>`;
    }
    const mode = obImport.mode === "swap" && canSwap ? "swap" : canAdd ? "add" : "swap";
    obImport.mode = mode;
    const c = p.ownerChange[mode];
    const chain = obChainName(p.chainId);
    return `${obBackHead("b-import-address")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Add this phone as an owner", "Whoever controls the Safe today approves one change in Safe{Wallet}. Zold never sees or sends that approval.")}
      ${canAdd && canSwap ? `<form class="z-form z-form--tight" id="ob-form" novalidate>
        <fieldset class="z-form z-form--tight" style="border:0;margin:0;padding:0;min-width:0">
          <legend class="z-sr">How to add this phone</legend>
          ${obChoiceHtml("import-mode", "add", "Keep your wallet as a second owner", "Afterwards this phone or your wallet can each approve on their own (1 of 2).", mode === "add")}
          ${obChoiceHtml("import-mode", "swap", "Replace your wallet with this phone", "Afterwards only this phone can approve.", mode === "swap")}
        </fieldset>
      </form>` : `<p class="z-sub">${mode === "add" ? "Your wallet stays a second owner: afterwards this phone or your wallet can each approve on their own (1 of 2)." : "This replaces your wallet with this phone."}</p>`}
      ${mode === "swap" ? Z.note({ tone: "a", icon: "warning", text: "This removes your wallet as an owner for good. If you then lose this phone, nobody can move the money in this Safe." }) : ""}
      <ol class="z-howto">
        ${[["download", "Download the file", "The button below saves it on this device."],
          ["link", "Open app.safe.global", `Connect the wallet that owns this Safe, and pick the Safe on ${esc(chain)}.`],
          ["apps", "Open Apps → Transaction Builder", "Drag the file in, or choose it."],
          ["draw", "Check it, then sign and send", "Sign with your wallet. Then come back here."]]
          .map(([ic, t, d]) => `<li>${Z.iconTile({ icon: ic })}<span class="z-howto__main"><span class="z-howto__title">${t}</span><span class="z-howto__text">${d}</span></span></li>`).join("")}
      </ol>
      <details class="z-card" style="padding:12px 16px">
        <summary>Send it another way</summary>
        <p class="z-sub" style="margin:8px 0">A transaction from the Safe to itself, to send with any Safe tool:</p>
        ${Z.copyRow({ label: "To", value: c.to, mono: true })}
        ${Z.copyRow({ label: "Value", value: c.value, mono: true })}
        ${Z.copyRow({ label: "Data", value: c.data, display: `${c.data.slice(0, 26)}…`, mono: true })}
        ${p.deployVerifier ? `<p class="z-sub" style="margin-top:8px">The file also sets up this phone’s signer on the network first. Sent another way, Zold sets that up itself when you finish.</p>` : ""}
      </details>
      ${obAlert()}
    </main>
    <div class="z-screen__foot">
      ${Z.button({ variant: "primary", full: true, icon: "download", label: "Download for Safe{Wallet}", id: "btn-import-download" })}
      ${Z.button({ variant: "secondary", full: true, label: "I’ve sent it", id: "btn-import-sent" })}
      ${obNewAccountLink()}
    </div>`;
  },
  bind: (root) => {
    obBindNewAccountLink(root);
    const form = root.querySelector("#ob-form");
    if (form) form.addEventListener("change", () => {
      obImport.mode = root.querySelector('input[name="import-mode"]:checked')?.value || "add";
      obRender();
      root.querySelector(`input[value="${obImport.mode}"]`)?.focus();
    });
    const dl = root.querySelector("#btn-import-download");
    if (dl) dl.onclick = () => {
      const file = obImport?.prepared?.ownerChange?.[obImport.mode]?.txBuilder;
      if (file) obDownloadFile(file);
    };
    const sent = root.querySelector("#btn-import-sent");
    if (sent) sent.onclick = () => obGo("b-import-confirm");
  },
};

/* Confirm is two steps, each retried by hand. Check asks `prepare` again: once
   the owner change is on the network it names the owners and issues the
   passkey challenge bound to them. Approve shows who else owns the Safe, then
   spends that challenge on `confirm`. The chain needs a block or two after
   the owner sends the change; no endless polling. */
let obImportChecking = false;

/* Why `prepare` issued no approval: the owners are not yet ones Zold binds. */
function obImportNotReadyCode(p) {
  if (!p.alreadyOwner) return "VERIFIER_NOT_OWNER";
  return p.threshold !== 1 ? "THRESHOLD_NOT_ONE" : "TOO_MANY_OWNERS";
}

/* An owner the user does not hold can move the Safe's money alone (threshold
   1), and anyone can be added as an owner: say who it is before approving. */
function obImportOwnersNote(p) {
  const others = p.otherOwners || [];
  if (!others.length) return Z.note({ icon: "check_circle", text: "This phone will be the Safe’s only owner." });
  return Z.note({
    tone: "a",
    icon: "warning",
    html: `This Safe has another owner: <span class="z-mono" translate="no" style="word-break:break-all">${esc(others.join(", "))}</span>. It can move the money on its own, without this phone. Approve only if that wallet is yours or your company’s.`,
  });
}
OB["b-import-confirm"] = {
  kind: "import",
  title: "Business: finish bringing in your Safe",
  html: () => {
    const p = obImport?.prepared;
    const retry = obImport?.notYet;
    const ready = !!p?.approval;
    return `${obBackHead(p && !p.alreadyOwner ? "b-import-sign" : "b-import-address")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro(ready ? "Approve bringing in your Safe" : "Finish bringing in your Safe", ready
        ? "Check the owners, then approve with Face ID. Zold makes the Safe this company’s account only with that approval."
        : "Once the owner change is on the network, Zold checks the Safe and asks for your approval.")}
      ${p ? obSafeSummary(p) : Z.skeletonRows(2, "Checking your Safe…")}
      ${ready ? obImportOwnersNote(p) : ""}
      <p class="z-sub hidden" id="import-wait" role="status">Checking the network. This can take up to two minutes.</p>
      ${obAlert()}
    </main>
    <div class="z-screen__foot">
      ${Z.button({ variant: "primary", full: true, label: ready ? "Approve with Face ID" : retry ? "Check again" : "I’ve sent it", id: "btn-import-confirm" })}
      ${obNewAccountLink()}
    </div>`;
  },
  bind: (root) => {
    obBindNewAccountLink(root);
    const flag = safeImportFlag();
    // A reload or another screen: ask the server again, the flag is only a hint.
    if (!obImport?.prepared && flag && !obImportChecking) {
      obImportChecking = true;
      obImport = { address: flag.address, prepared: null };
      obPrepareImport(flag.address)
        .then(() => { if (obScreen === "b-import-confirm") obRender(); })
        .catch(async (e) => {
          if (e?.code === "SAFE_ACTIVE") return obImportDone(await api(`/api/users/${user.id}`));
          if (obScreen === "b-import-confirm") obImportErr(e);
        })
        .finally(() => { obImportChecking = false; });
    }
    root.querySelector("#btn-import-confirm").onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (Z.isDisabled(btn)) return;
      obClearErr();
      const address = obImport?.address || flag?.address;
      if (!address) return obGo("b-import-address");
      const approval = obImport?.prepared?.approval;
      Z.setLoading(btn, true);
      $("import-wait")?.classList.remove("hidden");
      if (!approval) {
        try {
          const p = await obPrepareImport(address);
          if (!p.approval) {
            obImport = { ...obImport, notYet: true };
            obRender();
            return obImportErr({ code: obImportNotReadyCode(p) });
          }
          obImport = { ...obImport, notYet: false };
          return obRender({ focus: true });
        } catch (e) {
          if (e?.code === "SAFE_ACTIVE") return obImportDone(await api(`/api/users/${user.id}`));
          return obImportErr(e);
        } finally {
          Z.setLoading(btn, false);
          $("import-wait")?.classList.add("hidden");
        }
      }
      let bound;
      try {
        const stepUp = await passkeyAssertion(approval.challenge);
        bound = await api(`/api/users/${user.id}/safe/import/confirm`, { address, stepUp });
      } catch (e) {
        // The challenge is single-use: whatever failed, the next try checks
        // the Safe again and asks for a fresh approval.
        obImport = { ...obImport, prepared: { ...obImport.prepared, approval: null }, notYet: true };
        obRender();
        return obImportErr(e);
      } finally {
        Z.setLoading(btn, false);
        $("import-wait")?.classList.add("hidden");
      }
      // Bound on the server: whatever happens drawing the next screen, this
      // is not an import failure.
      obImportDone(bound);
    };
  },
};

/* 201 from confirm: the Safe is this account's. Same next step as after a
   fresh deployment, and never a deployment of the account's own Safe. */
function obImportDone(bound) {
  clearSafeImportFlag();
  renderUser({ ...bound, balanceEur: bound.balanceEur ?? 0, safeBalanceEur: bound.safeBalanceEur ?? 0 });
  obImport = null;
  obClearDraft();
  const next = obNextAfterAccount();
  return next ? obGo(next, { replace: true }) : obFinish();
}

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
  const phone = obOnPhone();
  return `<ul class="z-steps" aria-live="polite">${row(0, phone ? "Face ID sign-in on this phone" : "A passkey on this device", keyDone)}${row(1, phone ? "Your account, approved with Face ID" : "Your account, approved with your passkey", !!user?.passkey && !needsPasskeySafeSetup(user) && !!user?.passkeySafe)}</ul>`;
}
const obPasskeyLabel = () => obOnPhone()
  ? (user?.passkey ? "Finish with Face ID" : "Set up Face ID")
  : (user?.passkey ? "Finish with your passkey" : "Create passkey");

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
      obSetup = { step: 0, state: "now" }; obRerenderSteps();
      // The prompt has its own deadline; this bounds the requests around it.
      await withinPasskeyStep(registerPasskey(user), 30000, "Zold could not be reached. Try again.");
    }
    // A company may bring in the Safe it already has: stop before deploying
    // one. The choice screen deploys only if they pick a new account.
    if (safeImportOffered(user)) {
      obSetup = null;
      obClearDraft();
      return obGo(obSetupScreen(user), { replace: true });
    }
    await obOpenOwnSafe(btn);
  } catch (e) {
    obSetupFailed(e);
  } finally {
    Z.setLoading(btn, false);
    const label = btn.querySelector("span:last-child");
    if (label) label.textContent = obPasskeyLabel();
  }
}
/* Redraw the two set-up steps in place, or add them above the error. */
function obRerenderSteps() {
  const m = $("ob-root").querySelector(".z-steps");
  if (m) m.outerHTML = obSetupSteps(); else $("ob-err")?.insertAdjacentHTML("beforebegin", obSetupSteps());
}

/* The account's own Safe: the second Face ID approval deploys it, then on to
   the account's next step. Throws; the caller says what failed. */
async function obOpenOwnSafe(btn) {
  obSetup = { step: 1, state: "now" }; obRerenderSteps();
  btn.querySelector("span:last-child").textContent = obOnPhone() ? "Approve with Face ID again" : "Approve with your passkey again";
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
}

function obSetupFailed(e) {
  if (obSetup) obSetup.state = "fail";
  obRerenderSteps();
  obShowErr(obSetup?.step === 1
    ? new Error(`Your ${obOnPhone() ? "Face ID sign-in" : "passkey"} is saved, but setting up the account didn’t finish (${obMessage(e).replace(/\.$/, "")}). Try again; nothing needs setting up twice.`)
    : e);
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
    const cred = await passkeyPrompt("get", { challenge: b64urlToBytes(challenge), userVerification: "required" });
    const u = await api("/api/passkey/login", {
      credentialId: cred.id,
      authenticatorData: b64url(cred.response.authenticatorData),
      clientDataJSON: b64url(cred.response.clientDataJSON),
      signature: b64url(cred.response.signature),
    });
    renderUser(u);
    const next = obNextAfterAccount();
    if (next) obGo(next, { replace: true });
    else {
      enterDashboard(user.name);
      if (obAfterSignIn) phGo(obAfterSignIn);
    }
    obAfterSignIn = null;
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
  return !!(caps.zoldenburgRecovery && u?.passkeySafe?.status === "active" && recoveryOfferedFor(u)
    && !u.passkeySafe.recoveryChoice && u.passkeySafe.recovery?.status !== "active"
    // Recovery by email is the other answer to the same question.
    && u.passkeySafe.candideRecovery?.guardianStatus !== "active");
}

/* Is there Candide (email) enrolment left? True only where the deployment has
   the service, the account is set up and the guardian is not yet on it. */
function candideEnrolmentPending(u = user) {
  return !!(caps.emailSmsRecovery && u?.passkeySafe?.status === "active" && recoveryOfferedFor(u)
    && u.passkeySafe.candideRecovery?.guardianStatus !== "active");
}

function recoveryEnrolmentPending(u = user) {
  return zoldenburgChoicePending(u) || candideEnrolmentPending(u);
}

let obGrace = null;
/* ---- Email ---------------------------------------------------------------
   A 6-digit code to the signup email. The first visit asks for one by
   itself; "Send a new code" respects the server's wait, which it states. */
let obEmailSent = null; // { to, at } for this screen visit, or null
OB.email = {
  kind: "after",
  title: "Confirm your email",
  html: () => `${obAfterProgress("email", "Your email")}
    <main id="main" class="z-screen__main">
      ${obIntro("Confirm your email", obEmailSent
        ? `We sent a 6-digit code to ${esc(obEmailSent.to)}. It works for 15 minutes.`
        : `We’re sending a 6-digit code to ${esc(user?.email || "your email")}.`)}
      <form class="z-form" id="ob-form" novalidate>
        ${Z.field({ id: "em-code", name: "code", label: "Code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, spellcheck: false, placeholder: "123456…" })}
      </form>
      ${Z.note({ text: "Recovery and sign-in help find your account by this email, so only an email you’ve confirmed counts." })}
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${obSubmit("Confirm")}
      <button type="button" class="z-link-btn" id="btn-em-resend">Send a new code</button>
      <button type="button" class="z-link-btn" id="btn-em-later">Do this later</button>
    </div>`,
  bind: (root) => {
    const send = async () => {
      obClearErr();
      try {
        const r = await api(`/api/users/${user.id}/email/code`, {});
        obEmailSent = { to: r.sentTo, at: Date.now() };
        obRender();
        root.querySelector("#em-code")?.focus();
      } catch (e) { obShowErr(e); }
    };
    if (!obEmailSent) send();
    root.querySelector("#btn-em-resend").onclick = send;
    root.querySelector("#btn-em-later").onclick = () => {
      obEmailSkipped = true;
      const next = obNextAfterAccount();
      return next ? obGo(next) : obFinish();
    };
    root.querySelector("#ob-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      obClearErr();
      const input = root.querySelector("#em-code");
      const code = input.value.replace(/\s/g, "");
      Z.setFieldError(input, /^\d{6}$/.test(code) ? "" : "Enter the 6 digits from the email.");
      if (obFocusError(root)) return;
      const btn = root.querySelector("#btn-next");
      Z.setLoading(btn, true);
      try {
        const updated = await api(`/api/users/${user.id}/email/verify`, { code });
        renderUser(updated);
        obEmailSent = null;
        const next = obNextAfterAccount();
        return next ? obGo(next) : obFinish();
      } catch (e2) { obShowErr(e2); } finally { Z.setLoading(btn, false); }
    });
  },
};

OB.recovery = {
  kind: "after",
  title: "Recovery choice",
  html: () => {
    if (obRecoveryDone) {
      return `${obAfterProgress("recovery", "Recovery")}
      <main id="main" class="z-screen__main">
        ${obIntro(obRecoveryDone === "zoldenburg" ? "Zoldenburg is your guardian" : obRecoveryDone === "email" ? "Recovery by email is on" : "Recovery skipped",
          obRecoveryDone === "zoldenburg" ? "If you lose this phone, tap Recover your account on the sign-in screen. The move waits, and this phone can cancel it."
            : obRecoveryDone === "email" ? `A code to ${esc(user.email)} and a waiting period can move this account to a new phone.`
              : "You can set up recovery later in Security.")}
      </main>
      <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, label: "Continue", id: "btn-rec-next" })}</div>`;
    }
    const opts = [];
    if (caps.emailSmsRecovery && user?.email) opts.push(["email", `Email code ${Z.tag("Recommended", "pink")}${Z.tag("Beta")}`, "A code to your email starts recovery. You can cancel it while it waits."]);
    if (caps.zoldenburgRecovery) opts.push(["zoldenburg", `Add Zoldenburg as a guardian ${Z.tag("Beta")}`, `Only with an ID Monerium verified. Zoldenburg can’t send your money. A move to a new phone waits <span id="rec-grace">${esc(obGrace || "several days")}</span>, and you can cancel it.`]);
    opts.push(["skip", "Skip for now", "No one can recover this account."]);
    return `${obAfterProgress("recovery", "Recovery")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("If you lose access", "You can change this later in Security.")}
      <button type="button" class="z-link-btn z-link-btn--small" id="btn-rec-custody" style="align-self:flex-start;padding:0">${Z.icon("info")}You alone control this account</button>
      <form class="z-form z-form--tight" id="ob-form" novalidate>
        <fieldset class="z-form z-form--tight" style="border:0;margin:0;padding:0;min-width:0" aria-describedby="rec-choice-err">
          <legend class="z-sr">How to get back in</legend>
          ${opts.map(([v, t, d]) => `<label class="z-choice"><input type="radio" name="recovery" value="${v}"><span class="z-choice__main"><span class="z-choice__title">${t}</span><span class="z-choice__text">${d}</span></span></label>`).join("")}
        </fieldset>
        <p class="z-err" id="rec-choice-err" hidden></p>
        <div id="rec-skip" class="z-form z-form--tight" hidden>
          ${Z.note({ tone: "a", icon: "warning", text: "Lose this device and only your EURe can be recovered, from Monerium under Icelandic e-money law. Other assets are lost." })}
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
    const custody = root.querySelector("#btn-rec-custody");
    custody.onclick = () => obCustodySheet(custody);
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

/* Self-custody, said before the recovery choice: why no one can reset this
   account, and what a guardian can and cannot do. */
function obCustodySheet(trigger) {
  document.getElementById("ob-custody")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ob-custody", title: "You control this account",
    body: `<div class="z-sheet__body">
      <p class="z-sub">Your passkey is the only owner. Zold can’t move your money.</p>
      <p class="z-sub">So no one can reset your access. Without recovery, a lost phone is a lost account.</p>
      <p class="z-sub">Recovery moves the account to a new phone after a wait you can cancel.</p>
      <p class="z-sub">Monerium, the issuer, can still freeze EURe under the law.</p>
    </div>`,
  }));
  Z.openOverlay("ob-custody", trigger);
}

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
        ${obIntro("We can’t open a bank account for you right now", "Our banking partner, Monerium, can’t onboard you at the moment, so this account has no IBAN and no bank transfers. You can keep using Zold as a wallet: receive and hold digital dollars and euros, convert dollars to euros, get paid through your payment page, and send invoices.")}
        ${Z.note({ tone: "a", text: "Monerium decides who it verifies. Zold can’t change its answer." })}
        ${obAlert()}
      </main>
      <div class="z-screen__foot">
        ${Z.button({ variant: "primary", full: true, label: "Use Zold as a wallet", id: "btn-kyc-dashboard" })}
        ${Z.button({ variant: "secondary", full: true, label: "Use a different Monerium account", id: "btn-kyc-reconnect" })}
        ${Z.button({ variant: "quiet", full: true, label: "Email support", href: "mailto:support@zoldhq.com" })}
      </div>`;
    }
    const any = caps.moneriumOAuth || caps.moneriumApiKeys;
    return `${obAfterProgress("monerium", "Your IBAN")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Get your IBAN", "A quick ID check, then an IBAN in your name. You do it on our partner’s site and come back here.")}
      <div class="z-card z-partner">
        <span class="z-partner__name"><img src="/assets/logo-monerium.png" alt="" width="33" height="40" style="object-fit:contain">Monerium ehf.</span>
        <ul>
          <li>Takes a few minutes with your ID at hand.</li>
          <li>You can use Zold as a wallet while the check runs, or without it.</li>
          <li>Your IBAN switches on with one Face ID approval.</li>
        </ul>
      </div>
      ${any ? "" : Z.note({ tone: "a", text: "Monerium can’t be connected on this version of Zold yet, so no IBAN can be issued here." })}
      ${user?.moneriumRefusal && !hasConnectedMonerium(user) ? Z.note({ tone: "a", text: user.moneriumRefusal.error }) : ""}
      ${Z.note({ text: user?.accountType === "company"
        ? "When asked, choose Company. A personal profile can’t be used for a company account."
        : "When asked, choose Personal. A company profile can’t be used for a personal account." })}
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
        const updated = await api(`/api/users/${user.id}/monerium/api-keys`, { ...(await moneriumStepUp(user)), clientId: id.value.trim(), clientSecret: secret.value });
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
  html: () => obIbanReady && user?.iban ? obIbanReadyHtml() : ibanWait(user) ? obIbanWaitHtml(ibanWait(user)) : `${obAfterProgress("activate", "Switch on")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon("account_balance")}</span>
      ${obIntro("Switch on your IBAN", "You’re signed in at our partner. One approval links it to Zold and asks for your IBAN.")}
      ${Z.kv([
        { key: "Monerium", valueHtml: Z.tag("Connected", "mint") },
        { key: "How", value: user?.monerium?.method === "api_keys" ? "Your own API keys" : "Signed in with Monerium" },
        ...moneriumConnectedRows(),
        { key: "IBAN", valueHtml: user?.iban ? esc(Z.groupIban(user.iban)) : Z.tag("Waiting") },
      ])}
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${user?.iban ? "" : Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Switch on with Face ID", id: "btn-kyc-activate" })}
      <button type="button" class="z-link-btn" id="btn-kyc-refresh">Check again</button>
      <button type="button" class="z-link-btn z-link-btn--small" id="btn-kyc-reconnect">Not your login? Use a different Monerium account</button>
      ${user?.monerium?.method === "api_keys" ? "" : `<p class="z-sub" style="font-size:12px;text-align:center;margin:4px 0 0">Sign out at Monerium first, or it signs you back in to the same login.</p>`}
    </div>`,
  bind: (root) => {
    const act = root.querySelector("#btn-kyc-activate");
    if (act) act.onclick = () => activateIbanAtGate(act);
    const home = root.querySelector("#btn-kyc-home");
    if (home) home.onclick = () => obFinish();
    const ref = root.querySelector("#btn-kyc-refresh");
    ref.onclick = async () => { Z.setLoading(ref, true); await refreshKycStatus({ continueWhenApproved: true }); Z.setLoading(ref, false); };
    const re = root.querySelector("#btn-kyc-reconnect");
    if (re) re.onclick = () => obReconnect(re);
    // A redraw keeps the check already due: this screen can be redrawn every
    // few seconds, and a timer restarted on each redraw never fires.
    const w = ibanWait(user);
    if (w && !w.support) { if (!obIbanTimer) obIbanFollow(); }
    else { clearTimeout(obIbanTimer); obIbanTimer = null; }
  },
};

/* While the wait screen is open, ask again in the background. GET /users/:id
   is what asks Monerium (refreshPendingIban), so it runs here, not /kyc, which
   only reads what is stored. Often at first, when an IBAN usually lands, then
   less: a profile Monerium is still checking can take a day. A hidden tab
   does not ask. Every few checks the profile list is read again too, so
   "checking your ID" turns into "issuing" when Monerium approves, and the
   state Zold keeps for the profile is Monerium's latest, not the one from
   before the approval. */
let obIbanTimer = null;
let obIbanSince = 0;
let obIbanChecks = 0;
let obIbanCheckedAt = null;
let obIbanReady = false;

function obIbanFollow() {
  clearTimeout(obIbanTimer);
  if (!obIbanSince) obIbanSince = Date.now();
  const age = Date.now() - obIbanSince;
  obIbanTimer = setTimeout(obIbanCheck, age < 2 * 60000 ? 5000 : age < 15 * 60000 ? 15000 : 60000);
}

async function obIbanCheck() {
  obIbanTimer = null;
  if (obScreen !== "activate" || !user?.id || !ibanWait(user)) { obIbanSince = 0; return; }
  if (document.hidden) return obIbanFollow();
  const was = ibanWait(user);
  try {
    let fresh = await api(`/api/users/${user.id}`);
    obIbanChecks++;
    if (hasConnectedMonerium(fresh) && (fresh.iban || obIbanChecks % 6 === 0)) {
      const monerium = await api(`/api/users/${fresh.id}/monerium/accounts`).catch(() => null);
      if (monerium) fresh = { ...fresh, monerium: { ...(fresh.monerium || {}), ...monerium } };
    }
    obIbanCheckedAt = new Date();
    // Not renderUser: it redraws this screen on every tick. The screen is
    // redrawn only when what it says changes.
    user = { ...user, ...fresh };
    if (obScreen !== "activate") return;
    if (user.iban && kycApproved(user)) {
      obIbanReady = true;
      obIbanSince = 0;
      return obRender({ focus: true });
    }
    const now = ibanWait(user);
    if (!now || now.support !== was?.support || now.idCheck !== was?.idCheck) return obRender({ focus: true });
    const stamp = $("ob-iban-checked");
    if (stamp) stamp.textContent = obIbanStamp();
  } catch { /* the next tick tries again */ }
  if (obScreen === "activate") obIbanFollow();
}

// Back on the tab: ask now rather than at the next tick.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || obScreen !== "activate" || !ibanWait(user) || ibanWait(user).support) return;
  clearTimeout(obIbanTimer);
  obIbanCheck();
});

function obIbanStamp() {
  return obIbanCheckedAt
    ? `Checking with Monerium. Last checked ${obIbanCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`
    : "Checking with Monerium…";
}

/* The IBAN landed while the person watched. Shown once, from the poll; a
   reload of an approved account goes straight on. */
function obIbanReadyHtml() {
  return `${obAfterProgress("activate", "IBAN ready")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon("check_circle")}</span>
      ${obIntro("Your IBAN is ready", user?.accountType === "company"
        ? "Your company’s IBAN is ready. Share it to get paid by bank transfer."
        : "Your IBAN is ready. Share it to get paid by bank transfer.")}
      ${Z.kv([{ key: "IBAN", valueHtml: `<span class="z-mono" translate="no">${esc(Z.groupIban(user.iban))}</span>` }])}
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${Z.button({ variant: "primary", full: true, label: "Go to dashboard", id: "btn-kyc-home" })}
    </div>`;
}

/* The IBAN is requested and the rest is Monerium's. Says what happens next and
   what (nothing, mostly) the person has to do, checks in the background while
   open (obIbanFollow), and offers Go to dashboard at any time: Home's
   checklist carries the wait, and the server's poller approves when the IBAN
   lands.
   "Ask Monerium again" stays for an account parked before the server could
   tell an existing IBAN from one being issued. */
function obIbanWaitHtml(w) {
  const steps = [
    { t: "Signed in", d: "At our partner, Monerium.", done: true },
    { t: "IBAN requested", d: "Approved with your Face ID.", done: true },
    { t: w.idCheck ? "Your ID is checked" : "Your IBAN is issued",
      d: w.idCheck ? "Usually minutes, sometimes a day or two." : "Usually within minutes.", done: false },
    { t: "IBAN on your dashboard", d: "Share it and get paid by bank transfer.", done: false },
  ];
  return `${obAfterProgress("activate", "Almost there")}
    <main id="main" class="z-screen__main">
      <span class="z-mark z-mark--icon" aria-hidden="true">${Z.icon(w.support ? "support_agent" : "schedule")}</span>
      ${obIntro(w.title, w.sub)}
      ${w.support ? "" : rcTimeline(steps)}
      ${Z.note({ icon: "info", text: w.support
        ? "Your money and your account are safe meanwhile. Adding money by bank transfer opens once the IBAN is yours."
        : "You can leave this screen. Your IBAN shows on your dashboard once it’s issued, and bank transfers open then." })}
      ${w.support ? "" : `<p class="z-live" role="status"><span class="z-live__spin" aria-hidden="true"></span><span id="ob-iban-checked">${obIbanStamp()}</span></p>`}
      ${obAlert()}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${w.support
        ? Z.button({ variant: "primary", full: true, label: "Email support", href: "mailto:support@zoldhq.com" })
        : Z.button({ variant: "primary", full: true, label: "Go to dashboard", id: "btn-kyc-home" })}
      ${w.support ? Z.button({ variant: "quiet", full: true, label: "Go to dashboard", id: "btn-kyc-home" }) : ""}
      <button type="button" class="z-link-btn" id="btn-kyc-refresh">Check again</button>
      ${w.support ? "" : `<button type="button" class="z-link-btn z-link-btn--small" id="btn-kyc-activate">Ask Monerium again</button>`}
    </div>`;
}

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
    renderUser(await api(`/api/users/${user.id}/monerium/${path}`, await moneriumStepUp(user, true), "DELETE"));
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
          title: "Your IBAN is on its way.", sub: "We’ll show it on Home the moment it’s approved. Until then you can look around." }
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

/* ---- Recover (lost device) ------------------------------------------------
   The state and the calls are app/recovery.js's; these are the screens. Every
   one reads rcState, and the guard sends a screen the state does not name
   back to the one it does (a reload lands on the email step, which resumes
   the same request from this browser's saved secret). Recovery has never run
   on chain, so every screen carries a Beta tag. */

const rcBeta = () => Z.tag("Beta");
const rcHead = (step, label, back) =>
  `<div class="z-screen__head">${Z.progress({ step, of: 3, label, back: back ? { href: `#${back}` } : null, tag: rcBeta(), barLabel: "Recovery progress" })}</div>`;
const rcGrace = (r) => graceText(r?.recoveryDelayHours != null ? r.recoveryDelayHours * 3600 : r?.candide?.gracePeriodSeconds);

/* One step of the move, in the timeline shape payment progress uses. */
function rcTimeline(steps) {
  const now = steps.findIndex((s) => !s.done);
  return `<ol class="z-timeline">${steps.map((s, i) => `<li class="${s.done ? "is-done" : i === now ? "is-now" : ""}">
      <span class="z-timeline__mark" aria-hidden="true">${s.done ? Z.icon("check") : ""}</span>
      <span class="z-timeline__main"><span class="z-timeline__title">${esc(s.t)}<span class="z-sr">${s.done ? ", done" : i === now ? ", in progress" : ", not yet"}</span></span><span class="z-timeline__sub">${s.d}</span></span></li>`).join("")}</ol>`;
}

/* "Email and phone", from the channels this recovery asked codes on. */
function rcChannelWords(r) {
  const kinds = [...new Set((r?.candide?.auths || []).map((a) => (a.channel === "sms" ? "phone" : "email")))];
  const words = kinds.map((k, i) => (i ? k : k[0].toUpperCase() + k.slice(1)));
  return words.join(" and ") || "Codes";
}

OB.recover = {
  kind: "recover",
  title: "Recover your account",
  html: () => `${rcHead(1, "Recovery", "auth")}
    <main id="main" class="z-screen__main z-screen__main--tight">
      ${obIntro("Recover your account", "Enter the email on your account. You’ll set up Face ID or fingerprint sign-in on this phone, then confirm a code or contact support.")}
      ${rcNotice ? Z.note({ tone: "a", text: rcNotice, role: "status" }) : ""}
      <form class="z-form" id="rc-start" novalidate>
        ${Z.field({ id: "rc-email", name: "email", type: "email", label: "Email", autocomplete: "email", inputmode: "email", placeholder: "you@example.com…", value: rcEmail || undefined })}
      </form>
      ${obAlert("rc-err")}
    </main>
    <div class="z-screen__foot">
      ${Z.button({ variant: "primary", full: true, label: "Continue", type: "submit", id: "btn-rc-start" }).replace("<button", '<button form="rc-start"')}
      <p class="z-screen__fine z-screen__fine--flush">After that, a waiting period starts. Your old phone can cancel it.</p>
    </div>`,
  bind: (root) => {
    rcState = null;
    clearTimeout(rcTimer);
    root.querySelector("#rc-start").addEventListener("submit", (e) => { e.preventDefault(); recoverStart($("btn-rc-start")); });
  },
};

OB["recover/codes"] = {
  kind: "recover",
  title: "Enter the code",
  html: () => {
    const r = rcState;
    // Codes confirm the sign-in THIS browser made. Without its ticket, they
    // would hand the account to a sign-in someone else made.
    if (!rcOtpTicket) {
      return `${rcHead(2, "Recovery", "recover")}
        <main id="main" class="z-screen__main z-screen__main--tight">
          ${obIntro("Don’t enter any codes", "The Face ID or fingerprint sign-in this recovery would install wasn’t set up in this browser. If you didn’t start it, someone may be trying to take the account.")}
          ${Z.note({ tone: "a", text: "Don’t share codes with anyone. Once this recovery expires, start again from this phone." })}
        </main>
        <div class="z-screen__foot">${Z.button({ variant: "secondary", full: true, label: "Back to sign-in", href: "#auth" })}</div>`;
    }
    const auths = r.candide?.auths || [];
    const cur = rcCurrentAuth(r);
    const a = auths[cur] || auths[0];
    const where = a ? esc(a.target) : "your email or phone";
    const rows = auths.map((x, i) => Z.row({
      lead: Z.iconTile({ icon: x.channel === "sms" ? "sms" : "mail", tone: i === cur ? "p" : "n" }),
      title: x.channel === "sms" ? "Phone" : "Email",
      sub: x.target,
      right: x.verified ? Z.tag("Done") : i === cur ? Z.tag("Entering", "pink") : Z.tag("Next"),
    }));
    return `${rcHead(2, "Recovery", "recover")}
      <main id="main" class="z-screen__main z-screen__main--tight">
        ${obIntro("Enter the code", `Check <span translate="no">${where}</span> for a code from Candide, our recovery partner.${auths.length > 1 ? " Each one needs its own code." : ""}`)}
        <form class="z-form" id="rc-codes" novalidate>
          <div class="z-field"><label for="rc-code">Code for ${a?.channel === "sms" ? "your phone" : "your email"}</label>
            <input class="z-input z-code" id="rc-code" name="one-time-code" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" placeholder="Code…" aria-describedby="rc-code-hint">
            <p class="z-hint" id="rc-code-hint">Only enter it if you started this recovery on this phone.</p>
            <p class="z-err" id="rc-code-err" hidden></p></div>
        </form>
        ${auths.length ? Z.listGroup({ label: "Codes needed on", rows }) : ""}
        ${obAlert("rc-err")}
      </main>
      <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, label: "Continue", type: "submit", id: "btn-rc-code" }).replace("<button", '<button form="rc-codes"')}</div>`;
  },
  bind: (root) => {
    root.querySelector("#rc-codes")?.addEventListener("submit", (e) => { e.preventDefault(); recoverConfirmCode($("btn-rc-code")); });
  },
};

OB["recover/wait"] = {
  kind: "recover",
  title: "Your account is moving to this phone",
  html: () => {
    const r = rcState;
    const until = rcFinalizeAfter(r);
    const ms = until ? until.getTime() - Date.now() : 0;
    const zold = rcMode === "zoldenburg";
    return `${rcHead(3, "Waiting period", null)}
      <main id="main" class="z-screen__main z-screen__main--tight">
        ${obIntro("Your account is moving to this phone", "For your safety there’s a waiting period. Your old phone can still cancel it.")}
        <section class="z-count z-card" aria-labelledby="rc-left-label">
          <h2 class="z-count__label" id="rc-left-label">Time left</h2>
          <p class="z-count__fig" id="rc-left">${until ? esc(ms > 0 ? rcLeftText(ms) : "Finishing…") : "Not known yet"}</p>
          ${until ? `<p class="z-count__sub">Done on ${esc(rcWhenText(until))}</p>` : ""}
          <span class="z-count__track" aria-hidden="true"><span class="z-count__bar" id="rc-bar" style="transform:scaleX(${rcElapsed(r)})"></span></span>
        </section>
        ${rcTimeline([
          { t: "Face ID or fingerprint set up", d: "On this phone", done: true },
          zold ? { t: "ID check by Zoldenburg", d: "Done", done: true } : { t: "Codes confirmed", d: esc(rcChannelWords(r)), done: true },
          { t: "Waiting period", d: `${esc(rcGrace(r))}, so you can cancel if it wasn’t you`, done: false },
          { t: "Your account is on this phone", d: "Sign in and pay as usual", done: false },
        ])}
        ${Z.note({ icon: "lock", text: "Until the waiting period ends, this phone can’t sign in or send money. Your balance stays where it is. The move finishes on its own, so you can close this page." })}
        ${obAlert("rc-err")}
      </main>
      <div class="z-screen__foot z-screen__foot--quiet">
        <div id="rc-finish-wrap" class="z-stack"${until && ms > 0 ? " hidden" : ""}>${Z.button({ variant: "primary", full: true, label: "Finish recovery", id: "btn-rc-finish" })}</div>
        <a class="z-link-btn" href="#auth">Close</a>
      </div>`;
  },
  bind: (root) => {
    root.querySelector("#btn-rc-finish").onclick = (e) => recoverFinalize(e.currentTarget);
  },
};

OB["recover/zoldenburg"] = {
  kind: "recover",
  title: "We’re checking it’s you",
  html: () => {
    const r = rcState;
    const ref = r.zoldenburg?.reference || "";
    const checked = RC_ZOLD_SIGNING.includes(r.status);
    const mail = `mailto:support@zoldhq.com?subject=${encodeURIComponent(`Account recovery ${ref}`)}`;
    return `${obBackHead("recover", rcBeta())}
      <main id="main" class="z-screen__main z-screen__main--tight">
        ${obIntro("We’re checking it’s you", "Zoldenburg compares you with the ID you gave Monerium. A person does this, not a machine.")}
        ${ref ? `<div class="z-card">${Z.copyRow({ label: "Your reference", value: ref, mono: true })}</div>` : ""}
        ${rcTimeline([
          { t: "Face ID or fingerprint set up", d: "On this phone", done: true },
          { t: "ID check by Zoldenburg", d: checked ? "Done" : "Email support@zoldhq.com with your reference", done: checked },
          { t: "Waiting period", d: `${esc(rcGrace(r))}. Your old phone can cancel it`, done: false },
          { t: "Your account is on this phone", d: "Sign in and pay as usual", done: false },
        ])}
        ${Z.note({ icon: "shield", text: "Zoldenburg can only start a move. It can’t send your money, and the waiting period always applies." })}
      </main>
      <div class="z-screen__foot z-screen__foot--quiet">
        ${checked ? "" : Z.button({ variant: "primary", full: true, icon: "mail", label: "Email support", href: mail })}
        <p class="z-screen__fine z-screen__fine--flush">Write from the email on your account. Keep this browser: only it can follow the request.</p>
      </div>`;
  },
};

/* After sign-in, open this app screen instead of Home (Recovery-Done's link). */
let obAfterSignIn = null;

OB["recover/done"] = {
  kind: "recover",
  title: "Your account is on this phone",
  html: () => `<main id="main" class="z-screen__main z-screen__main--center z-result">
      <span class="z-tile z-tile--m z-tile--xl" aria-hidden="true">${Z.icon("verified_user")}</span>
      ${obIntro("Your account is on this phone", "This phone now approves everything on your account. Your old phone can’t approve payments any more.", false)}
    </main>
    <div class="z-screen__foot z-screen__foot--quiet">
      ${Z.button({ variant: "primary", full: true, icon: "passkey", label: "Sign in", id: "btn-rc-signin" })}
      <button type="button" class="z-link-btn" id="btn-rc-settings">Check your recovery settings</button>
    </div>`,
  bind: (root) => {
    const signIn = (after) => {
      obAfterSignIn = after;
      obGo("auth", { replace: true });
      $("link-signin")?.click();
    };
    root.querySelector("#btn-rc-signin").onclick = () => signIn(null);
    root.querySelector("#btn-rc-settings").onclick = () => signIn("recovery-settings");
  },
};

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
    const connect = await api(`/api/users/${user.id}/monerium/connect/start`, { ...(await moneriumStepUp(user)), redirectUri });
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
  // The server picked the profile at connect (personal for a personal
  // account, corporate for a company); any other profile is refused.
  if (hasConnectedMonerium()) {
    const accounts = await api(`/api/users/${user.id}/monerium/accounts`);
    user = { ...user, monerium: { ...(user.monerium || {}), ...accounts } };
  }
  const profileId = user.monerium?.profileId;
  const start = await api(`/api/users/${user.id}/monerium/link-signature/start`, { profileId });
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(start.challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(start.credentialId) }],
    userVerification: "required",
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
    const choices = e.body?.choices?.length ? e.body.choices : e.body?.existing ? [e.body.existing] : [];
    if (e.code !== "IBAN_EXISTS_ELSEWHERE" || !choices.length) throw e;
    // The profile's IBAN pays another address. Only the user decides whether
    // to move it, and which one; the API recorded nothing but the reason.
    activated = await offerIbanMove(choices, profileId);
    if (!activated) {
      renderUser(await api(`/api/users/${user.id}`));
      throw new Error("Your IBAN was not moved, so it still pays into the other wallet. Press Activate IBAN again when you are ready to move it.");
    }
  }
  renderUser(activated);
  return true;
}

/* "Move my existing Monerium IBAN to Zold". A Monerium profile has ONE IBAN,
   so a user who already has one cannot get a second; they can point the one
   they have at this Safe. A test or company login can hold several; then the
   user picks one and none is preselected. Resolves with the account as the API returns it
   after the move, or null on Cancel. Nothing here says "done": the caller
   renders whatever the API reports, and the API approves only once Monerium
   lists the IBAN against this Safe. */
function offerIbanMove(choices, profileId) {
  const norm = (i) => String(i || "").replace(/\s+/g, "").toUpperCase();
  const one = choices.length === 1 ? choices[0] : null;
  const ibanOf = () => one ? norm(one.iban) : norm(dlg.querySelector('input[name="m-mv-iban"]:checked')?.value);
  const fromOf = (c) => { const a = c.address ? String(c.address) : ""; return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "another address"; };
  const pick = one
    ? `<div class="m-rows">
      <div class="m-detrow"><div style="min-width:0"><div class="m-rowk">IBAN</div><div class="m-rowv">${esc(`•••• •••• •••• ${norm(one.iban).slice(-4)}`)}</div></div></div>
      <div class="m-detrow"><div style="min-width:0"><div class="m-rowk">Pays into now</div><div class="m-rowv">${esc(fromOf(one))}</div></div></div>
    </div>`
    : `<fieldset class="m-rows" style="border:0;padding:0;margin:0"><legend class="m-rowk" style="padding:0 0 8px">Which IBAN to move</legend>
      ${choices.map((c) => `<label class="m-detrow" style="cursor:pointer;gap:12px"><input type="radio" name="m-mv-iban" value="${esc(norm(c.iban))}">
        <div style="min-width:0"><div class="m-rowv">${esc(Z.groupIban(norm(c.iban)))}</div>
        <div class="m-rowk" style="word-break:break-all">Pays into ${esc(fromOf(c))}${c.chain ? ` on ${esc(c.chain)}` : ""}</div></div></label>`).join("")}
    </fieldset>`;
  // The login the IBAN moves from: a browser still signed in at Monerium may
  // have connected a login the user did not expect.
  const connectedAs = moneriumConnectedRows().map((r) => `<div class="m-detrow"><div style="min-width:0"><div class="m-rowk">${esc(r.key)}</div><div class="m-rowv" style="word-break:break-all">${esc(r.value)}</div></div></div>`).join("");
  const dlg = document.createElement("dialog");
  dlg.className = "m-dialog";
  dlg.setAttribute("aria-labelledby", "m-mv-title");
  dlg.innerHTML = `
    <h2 id="m-mv-title">Move your IBAN to Zold</h2>
    <div class="m-lede" style="font-size:13px">${one
      ? `You already have an IBAN ending ${esc(norm(one.iban).slice(-4))}. Zold will use it.`
      : `You already have ${choices.length} IBANs. Pick the one Zold should use.`}</div>
    ${pick}
    ${connectedAs ? `<div class="m-rows" style="margin-top:12px">${connectedAs}</div>` : ""}
    <div class="m-note warn" style="margin-top:16px;font-size:13px;line-height:1.45">
      New payments arrive in Zold, and the old wallet stops getting them. People who pay you keep the same IBAN. You can move it back later.
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
  const ready = () => input.value.trim() === "MOVE" && !!ibanOf();
  input.oninput = () => { go.disabled = !ready(); };
  dlg.querySelectorAll('input[name="m-mv-iban"]').forEach((r) => { r.onchange = input.oninput; });

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
      const iban = ibanOf();
      dlg.querySelectorAll('input[name="m-mv-iban"]').forEach((r) => { r.disabled = true; });
      try {
        const start = await api(`/api/users/${user.id}/monerium/link-signature/start`, { profileId, purpose: "move-iban", iban });
        const cred = await passkeyPrompt("get", {
          challenge: b64urlToBytes(start.challenge),
          allowCredentials: [{ type: "public-key", id: b64urlToBytes(start.credentialId) }],
          userVerification: "required",
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
        dlg.querySelectorAll('input[name="m-mv-iban"]').forEach((r) => { r.disabled = false; });
        go.disabled = !ready();
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
async function registerPasskey(u) {
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "register" });
  const label = pendingInfo?.email || u.email || pendingInfo?.name || u.name;
  const cred = await passkeyPrompt("create", {
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
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    // Ask for the PRF extension so this passkey can encrypt the
    // device spending key. Authenticators without it still register fine.
    extensions: { prf: {} },
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
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(prepared.challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(prepared.credentialId) }],
    userVerification: "required",
  });
  const activated = await api(prepared.submitTo, {
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  });
  user = { ...user, ...activated };
}

async function finishPasskeySafeSetup(extraMs = 45000) {
  if (!user?.passkeySafe || user.passkeySafe.status === "active") return;
  // Deploying now would end the import started on this device for good.
  // "Use a new account instead" clears the flag first.
  if (safeImportFlag()) throw new Error("you started bringing in your company’s existing Safe. Finish that, or choose a new account instead");
  await withinPasskeyStep(activatePasskeySafe(), extraMs, "setting up your account took too long");
  if (needsPasskeySafeSetup(user)) {
    throw new Error("your account was not set up");
  }
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
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(exec.challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(exec.credentialId) }],
    userVerification: "required",
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
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(redeem.challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(redeem.credentialId) }],
    userVerification: "required",
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
  // A record that cannot be read is not this account's key if none is bound
  // yet, so it is replaced; with a key bound it may be that key, and device.js
  // refuses to write over it.
  const replaceDamaged = !!dev.keyStatus().damaged && !u.authorizerAddress;
  const { address, protection } = dev.keyStatus().present && !replaceDamaged
    ? { address: await dev.deviceAddress(credId()), protection: dev.keyStatus().protection }
    : await dev.createKey(credId(), { replaceDamaged });
  const updated = await api(`/api/users/${u.id}/authorizer`, { address, stepUp: await passkeyStepUp("authorizer.bind") });
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
$("btn-finish-import").onclick = () => { obShow(); obGo(obNextAfterAccount() || "monerium", { replace: true }); };
$("btn-dash-kyc-refresh").onclick = async () => {
  await refresh();
  if (kycApproved(user)) enterDashboard(user.name);
};
$("btn-recovery-start").onclick = startRecoveryRequest;
$("btn-links").onclick = () => phGo("get-paid");

/** Kept until the app opens: sign-in and onboarding drop the query. */
function parkPayLink() {
  const target = new URLSearchParams(location.search).get("pay");
  if (!target) return null;
  try { sessionStorage.setItem("zold-pay", target); } catch {}
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
  return target;
}

/**
 * /app?pay=<handle>/<code> — "Open in Zold" from a payment request page.
 *
 * Reads the public request and enters the SEPA send flow with the payee's
 * account, the amount and the reference filled in. Filled in, not hidden: the
 * IBAN is what the device signs a commitment over, so it stays on screen.
 */
async function handlePayDeepLink() {
  const qs = new URLSearchParams(location.search);
  let target = parkPayLink();
  if (!user) return;
  try { target = sessionStorage.getItem("zold-pay"); sessionStorage.removeItem("zold-pay"); } catch {}
  if (!target) return;
  // A company pays through a payment run in Zold Business, approved like any
  // other; this app does not move a company's money.
  if (user.accountType === "company") {
    return errShow("link", { title: "Pay this from Zold Business", sub: "A company account pays through a payment run, so it is approved like any other payment. Add the payee in Zold Business and create the payment there." });
  }
  const [handle, code] = target.split("/");
  if (!handle || !code) return;
  try {
    const p = await api(`/api/pay/${encodeURIComponent(handle)}/${encodeURIComponent(code)}`);
    const b = p.methods?.bank;
    if (!b) {
      return errShow("link", { title: "This link can’t be paid from Zold", sub: `It takes digital dollars (${usdSym()}) only. Open it in a crypto wallet instead.` });
    }
    if (p.state !== "OPEN") return errShow("link");
    const amount = p.outstandingEur ?? Number(qs.get("amount") || 0);
    phSend = {
      payee: { name: b.holder, iban: String(b.iban).replace(/\s+/g, "").toUpperCase() },
      amount: amount > 0 ? String(amount) : "", reference: b.reference || "", quote: null, transferId: null, error: null,
    };
    phGo("send/amount", "new");
  } catch (e) {
    const state = errFromStartup(e);
    if (state) return errShow(state);
    errShow("link", e?.status === 404 ? {} : { sub: obMessage(e) });
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
    parkPayLink(); // signed out: kept for after sign-in
    return obStart();
  }
  try {
    const u = await api("/api/session");
    renderUser(u);
    await capabilitiesLoaded;
    const next = obNextAfterAccount();
    // "Do this later" on the Monerium step opened the app: a reload on an app
    // screen stays in the app, whose Home offers the step again. An IBAN that
    // is requested waits on Monerium, not on the person: Home, not the gate.
    if (!next || (["monerium", "activate"].includes(next) && (phParse(location.hash) || ibanWait(user)))) {
      enterDashboard(user.name);
      return;
    }
    parkPayLink(); // onboarding first: kept for when the app opens
    obShow();
    const want = location.hash.slice(1);
    // Reload on a later step it may still see (keys form, welcome) stays there.
    obGo(OB[want]?.kind === "after" && obGuard(want) === want ? want : next, { replace: true, focus: false });
  } catch (e) {
    // No network or a server error is not a dead session: keep it, and say
    // what happened instead of signing the person out.
    const state = errFromStartup(e);
    if (state) {
      await capabilitiesLoaded;
      return errShow(state);
    }
    sessionToken = null;
    localStorage.removeItem("zold-session");
    localStorage.removeItem("zoll-session");
    await capabilitiesLoaded;
    obStart();
  }
}
