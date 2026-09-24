/**
 * What every screen needs: the DOM helper, module-level state, the escaping
 * that guards innerHTML, and api().
 *
 * Loads first, and the order matters. These are classic scripts sharing one
 * scope, and a file may only call into files loaded before it at parse time.
 * Files after this one hold declarations and event wiring; nothing calls
 * forward. app/main.js loads last and is the only file that starts work across
 * files, so anything that awaits and then renders goes there.
 */
const $ = (id) => document.getElementById(id);
let user = null, quote = null, transfer = null, poll = null;

/* The device module (ESM) loads after this classic script — hand it a
   resolver so send-time code can await the crypto library. */
const deviceLib = new Promise((resolve) => { window.__deviceLibReady = resolve; });
let sessionToken = localStorage.getItem("zold-session")
  // Carry a session over from before the Zoll -> Zold rename so a returning
  // browser is not silently signed out.
  || localStorage.getItem("zoll-session")
  || null;
let privacyCatalog = null;
let recoveryInfo = null;
let activeView = "dashboard";
let txFilter = "all";
let contacts = JSON.parse(localStorage.getItem("zoll-contacts") || "[]");

const fmt = (n, dp = 2) => Number(n).toLocaleString("en", { minimumFractionDigits: dp, maximumFractionDigits: dp });
/* Anything that reaches an innerHTML template goes through this first. Some of
   it is typed by the user (recipient names), and some arrives from a payout
   partner (anchor error text, anchor URLs) — neither is markup. */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* Render a partner link only if it is an http(s) URL: "javascript:" in an
   href runs a script.

   Parsed with no base, so the link must be absolute. Don't resolve against
   location.origin: a missing moreInfoUrl becomes "<origin>/undefined", passes
   the caller's falsy check, and renders a dead link. A value that is not a
   non-empty string is not a link. */
const safeUrl = (u) => {
  if (typeof u !== "string" || u.trim() === "") return null;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch { return null; }
};
/* An absent status is NOT approval. The old default read a missing field as
   "approved", which after the in-house review path was removed would have
   opened funding on any payload that dropped the field. */
const kycApproved = (u = user) => u?.kycStatus === "approved";
const kycCopy = (status = "pending", u = user) => {
  if (status !== "approved" && hasConnectedMonerium(u)) {
    return ["MONERIUM", "Activate your IBAN", "Your Monerium account is connected. One passkey confirmation links your wallet to it and asks Monerium for the IBAN."];
  }
  return ({
  pending: ["PENDING", "Connect Monerium", "Your IBAN, deposits, quotes and transfers open once a Monerium account is connected and the IBAN is activated."],
  manual_review: ["MANUAL REVIEW", "Additional review needed", "Monerium is still reviewing this account; funding and transfers open when it completes."],
  rejected: ["REJECTED", "Not approved", "Funding and transfers are disabled for this account."],
  approved: ["APPROVED", "Account approved", "Funding and transfers are available."],
}[status] || ["REVIEW", `KYC ${status}`, "Funding and transfers are paused until approval."]);
};

/**
 * Show or clear the offline bar.
 *
 * `navigator.onLine` only reports a network interface, not whether Zold
 * answers, and a dead server on live wifi looks like a broken app. So the bar
 * shows when the interface goes away or when an API call fails to reach us.
 */
function setReachable(ok) {
  const bar = document.getElementById("offline-bar");
  if (bar) bar.classList.toggle("hidden", !!ok && navigator.onLine);
}
window.setReachable = setReachable;

/**
 * `method` is explicit only where the verb is not implied by the body: a body
 * means POST and no body means GET, which covers every call but DELETE.
 */
async function api(path, body, method, extraHeaders) {
  // Every call carries the session token, so the path must be ours: a
  // `submitTo` from a response is followed only under /api/.
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    throw new Error("refusing to call a path outside this app's API");
  }
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let res;
  try {
    res = await fetch(path, {
      ...(body ? { method: method ?? "POST", body: JSON.stringify(body) } : method ? { method } : {}),
      headers,
    });
  } catch {
    /* A dead network reads as "Failed to fetch", which tells the user nothing
       and looks like our bug. The service worker turns API calls into a 503
       with a readable body, but it only controls the page once it is active —
       first load, and browsers without one, land here. */
    setReachable(false);
    throw new Error("you appear to be offline — Zold could not be reached");
  }
  const data = await res.json().catch(() => ({}));
  // 503 is what the service worker returns when it could not reach us at all.
  setReachable(res.status !== 503);
  // statusText is EMPTY over HTTP/2, so a non-JSON error (a proxy's HTML 502,
  // a dropped tunnel) would otherwise surface as a blank "Error".
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || `request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
const showErr = (id, e) => { const el = $(id); el.textContent = e.message; el.classList.remove("hidden"); };
const clearErr = (id) => $(id).classList.add("hidden");
const shortAddr = (addr) => addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : "—";
