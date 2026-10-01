/**
 * Whole-screen states from design/ui-v2 (build step 9): offline, something
 * went wrong on our side, and a link that does not work. They are OB entries
 * of kind "state", drawn into #ob-root by errShow() without touching the URL:
 * a state is not a place, so reload and back never land on one.
 *
 * Declarations only; resumeSession(), enterDashboard() and
 * handlePayDeepLink() in app/onboarding.js open them at run time.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - Offline shows no balance: nothing is stored on the phone to show, and a
 *   figure from an earlier visit would be read as today's.
 * - The error screen has no reference code. The API's 500 answer carries
 *   none, and a code made up here could not be looked up anywhere.
 */

/* What the open state screen says: { kind, title?, sub? }. */
let errState = null;

/** Show a state screen over whatever is on screen. */
function errShow(kind, opts = {}) {
  errState = { kind, ...opts };
  obShow();
  obScreen = `state-${kind}`;
  obRender({ focus: true });
}

/* The brand row the state screens share: Zold, and nowhere to go from it. */
const errBrand = () => `<div class="z-screen__brand"><span class="z-screen__logo"><span class="z-brand-tri" aria-hidden="true">▽</span>Zold</span></div>`;

function errBody(icon, tone, title, sub) {
  return `${errBrand()}
    <main id="main" class="z-screen__main z-screen__main--center z-state">
      <span class="z-tile z-tile--xl${tone ? ` z-tile--${tone}` : ""}" aria-hidden="true">${Z.icon(icon)}</span>
      ${obIntro(title, sub, false)}
    </main>`;
}

/* Try again: start the app over from the saved session. A screen that is
   still offline, or still failing, comes back by itself. */
async function errRetry(btn) {
  if (Z.isDisabled(btn)) return;
  Z.setLoading(btn, true);
  try { await resumeSession(loadCapabilities()); }
  finally { if (btn.isConnected) Z.setLoading(btn, false); }
}

/* The browser knows whether it has a network, not whether Zold answers: with
   a network and no answer, the screen says that instead of "offline". */
OB["state-offline"] = {
  kind: "state",
  title: "You’re offline",
  html: () => `${navigator.onLine
    ? errBody("cloud_off", "", "Zold can’t be reached", "Your connection works, but Zold isn’t answering. Payments need it. Try again in a minute.")
    : errBody("wifi_off", "", "You’re offline", "Payments need a connection. Zold opens again as soon as this phone is back online.")}
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Try again", id: "btn-err-retry" })}</div>`,
  bind: (root) => { root.querySelector("#btn-err-retry").onclick = (e) => errRetry(e.currentTarget); },
};

OB["state-error"] = {
  kind: "state",
  title: "Something went wrong",
  html: () => `${errBody("error", "a", "Something went wrong on our side", "Nothing was sent: payments only go out when you approve them. Try again in a minute.")}
    <div class="z-screen__foot">
      ${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Try again", id: "btn-err-retry" })}
      ${Z.button({ variant: "secondary", full: true, icon: "mail", label: "Contact support", href: "mailto:support@zoldhq.com" })}
    </div>`,
  bind: (root) => { root.querySelector("#btn-err-retry").onclick = (e) => errRetry(e.currentTarget); },
};

OB["state-link"] = {
  kind: "state",
  title: "This link doesn’t work",
  html: () => `${errBody("link_off", "", errState?.title || "This link doesn’t work", esc(errState?.sub || "It may have expired, been closed, or been typed wrong. Ask the person who sent it for a new one."))}
    <div class="z-screen__foot">${Z.button({ variant: "primary", full: true, icon: "home", label: user ? "Go to Home" : "Go to sign-in", id: "btn-err-home" })}</div>`,
  bind: (root) => {
    root.querySelector("#btn-err-home").onclick = () => {
      errState = null;
      if (!user) return obGo("auth", { replace: true });
      // Home, as the button says, not whatever screen the address names.
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
      enterDashboard(user.name);
    };
  },
};

/** A failed start-up: offline, our fault, or a session that is really over. */
function errFromStartup(e) {
  if (e?.offline || (!e?.status && !navigator.onLine)) return "offline";
  if (e?.status >= 500) return "error";
  return null;
}
