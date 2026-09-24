/*
 * Cookie and storage notice. Shared by the landing page, the personal app and
 * the business dashboard.
 *
 * A notice, not a consent prompt: everything Zold stores is strictly
 * necessary for a service the person asked for:
 *   - one cookie, `zold_monerium_connect` (HttpOnly, 10 minutes, only while
 *     connecting Monerium: it binds the OAuth callback to this browser);
 *   - localStorage: the session, the device key, saved contacts and the
 *     selected organisation;
 *   - the service worker's cache of the app's own files.
 * There is no analytics, advertising or tracking of any kind, and fonts are
 * self-hosted. Strictly necessary storage needs no consent under ePrivacy
 * Art. 5(3) / TTDSG §25(2), only information, and a "Reject" button would
 * reject nothing. If a non-essential cookie is ever added, this must become a
 * consent prompt that blocks it until accepted.
 *
 * The full list lives in the landing page's notes (#cookies); keep the two in
 * step. Dismissal is remembered in localStorage (itself necessary storage); if
 * storage is blocked the notice shows again next time.
 */
(function () {
  var KEY = "zold-cookie-notice";
  try { if (localStorage.getItem(KEY) === "1") return; } catch (_) { /* show it */ }

  function show() {
    if (document.getElementById("zold-cookie-notice")) return;
    var onLanding = location.pathname === "/" || location.pathname === "/landing.html";
    // The personal app has a fixed bottom nav on phones; sit above it when it
    // is actually on screen (it is in the DOM, hidden, during onboarding).
    var nav = document.getElementById("m-nav");
    var lift = nav && nav.getClientRects().length && getComputedStyle(nav).display !== "none" ? 88 : 16;
    var box = document.createElement("div");
    box.id = "zold-cookie-notice";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Cookies and storage");
    box.style.cssText =
      "position:fixed;left:16px;right:16px;bottom:calc(" + lift + "px + env(safe-area-inset-bottom,0px));" +
      "z-index:2147483000;max-width:560px;margin:0 auto;padding:14px 16px;border-radius:14px;" +
      "background:rgba(19,19,23,.97);border:1px solid #2c2c33;color:#ededf0;" +
      "box-shadow:0 18px 50px rgba(0,0,0,.55);font:13px/1.5 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "display:flex;gap:14px;align-items:center;flex-wrap:wrap";

    var text = document.createElement("div");
    text.style.cssText = "flex:1 1 260px;min-width:0;color:#b4b4bd";
    text.innerHTML =
      '<b style="color:#ededf0;font-weight:600">No tracking cookies.</b> ' +
      "Zold stores only what it needs to work: your sign-in and device key in this browser, " +
      "and one short-lived cookie while you connect Monerium. ";
    var more = document.createElement("a");
    more.href = onLanding ? "#cookies" : "/#cookies";
    if (!onLanding) { more.target = "_blank"; more.rel = "noopener"; }
    more.textContent = "What we store";
    more.style.cssText = "color:#e8a9cd;text-decoration:none;border-bottom:1px solid rgba(232,169,205,.4);white-space:nowrap";
    text.appendChild(more);

    var ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "Got it";
    ok.style.cssText =
      "flex:none;height:36px;padding:0 18px;border:0;border-radius:999px;background:#ed188d;color:#fff;" +
      "font:600 13px Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer";
    ok.onclick = function () {
      try { localStorage.setItem(KEY, "1"); } catch (_) { /* shows again next visit */ }
      box.remove();
    };

    box.appendChild(text);
    box.appendChild(ok);
    document.body.appendChild(box);
  }

  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show);
})();
