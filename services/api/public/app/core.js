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
/* An absent status is NOT approval: reading a missing field as "approved"
   would open funding on any payload that dropped it. */
const kycApproved = (u = user) => u?.kycStatus === "approved";
/* A company signup's own Safe is the company's account, not a personal one:
   its IBAN sits on the company's profile at Monerium. */
const ownAccountKind = (u = user) => (u?.accountType === "company" ? "Company" : "Personal");
/* The company a company login's account belongs to; app/phone.js
   phLoadOrgs sets it once the organisations are read. */
let ownCompanyOrg = null;
/* Whose account this is, by name. A company login's account is the
   company's, so it is named after the company: Monerium's name for the
   connected profile, else the company's legal name. Never the name of the
   person who signed up for it, which payers would copy as the beneficiary. */
const ownAccountName = (u = user) => {
  if (u?.accountType !== "company") return u?.name || "";
  const connected = (u.monerium?.profiles || []).find((p) => p?.id && p.id === u.monerium?.profileId);
  return connected?.name || ownCompanyOrg?.legalName || ownCompanyOrg?.name || "Company account";
};
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

/* A 5xx with no JSON body came from in front of the API (Cloudflare, the
   tunnel), not from it: the API never answers an error without a body. The
   request may or may not have reached us, so the message says that, and
   carries Cloudflare's ray id for the operator to look up. */
function gatewayMessage(res) {
  if (res.status < 500 || res.headers.get("x-zold-offline") === "1") return "";
  const ray = res.headers.get("cf-ray");
  return `Zold's server did not answer (HTTP ${res.status}${ray ? `, ray ${ray}` : ""}). ` +
    "The request may or may not have gone through: check before you try it again.";
}

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
    const err = new Error("you appear to be offline. Zold could not be reached");
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  // 503 is what the service worker returns when it could not reach us at all.
  setReachable(res.status !== 503);
  // statusText is EMPTY over HTTP/2, so a non-JSON error (a proxy's HTML 502,
  // a dropped tunnel) would otherwise surface as a blank "Error".
  if (!res.ok) {
    const err = new Error(data.error || gatewayMessage(res) || res.statusText || `request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.ref = data.ref;
    // The service worker's own 503: the network, not our server, failed.
    err.offline = res.headers.get("x-zold-offline") === "1";
    // A refusal the UI answers with its own screen (IBAN_EXISTS_ELSEWHERE)
    // needs the code and the fields that came with it.
    err.code = data.code;
    err.body = data;
    throw err;
  }
  return data;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/* The passkey credential this browser wraps the device key with. */
const credId = () => user?.passkey?.credentialId || null;

/* Every passkey prompt goes through here. A browser refuses a new prompt while
   an earlier one is still open ("A request is already pending"), and some never
   close one on their own, so a wait that merely gave up left the prompt open
   and the retry failed. Here a new prompt closes the one before it, and the
   deadline closes the prompt itself, not only our wait for it. The browser's
   timeout is long enough for a Mac password, a security key or a phone by QR
   code. */
const PASSKEY_TIMEOUT_MS = 120000;
const PASSKEY_DEADLINE_MS = PASSKEY_TIMEOUT_MS + 10000;
/* The waiting overlay comes up only if the prompt is still open after this:
   a quick Face ID never flashes it. */
const PASSKEY_OVERLAY_AFTER_MS = 400;
const PASSKEY_HINT_AFTER_MS = 8000;
let passkeyOpen = null; // { ctl, stop }
const passkeyCancel = () => { const o = passkeyOpen; passkeyOpen = null; o?.ctl.abort(); };
/* Cancel on the waiting overlay: close the browser's prompt, and tell the
   caller it was the person's choice. */
const passkeyUserCancel = () => { passkeyOpen?.stop(passkeyError("PASSKEY_CANCELLED", "You cancelled the passkey prompt. Try again when you’re ready.")); };

const passkeyOnPhone = () => !!window.matchMedia?.("(pointer: coarse)").matches;
function passkeyError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const passkeyNoAnswer = () => passkeyError("PASSKEY_NO_ANSWER", passkeyOnPhone()
  ? "No answer from Face ID or fingerprint. Is a screen lock set up on this phone?"
  : "The passkey prompt got no answer, so it was closed. Try again when you’re ready.");

/* A password manager that replaces navigator.credentials (LastPass) keeps its
   last request open for a moment after answering it, and ignores our abort, so
   it refuses the next one as "already pending" with nothing of ours open: the
   Safe deployment right after creating the passkey failed every time. That
   refusal opened no prompt, so it is safe to ask again after a pause. */
let PASSKEY_PENDING_RETRY_MS = 1500;
const PASSKEY_PENDING_RETRIES = 3;
const passkeyAborted = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
const passkeyPending = (e) => /request is (already )?pending/i.test(String(e?.message || ""));
const passkeyPause = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
async function passkeyAsk(kind, publicKey, signal) {
  for (let tries = 0; ; tries++) {
    try {
      return await navigator.credentials[kind]({ publicKey: { ...publicKey, timeout: PASSKEY_TIMEOUT_MS }, signal });
    } catch (e) {
      // Closed by a newer prompt, Cancel or the deadline: say aborted, as the
      // browser would, not "pending".
      if (signal.aborted) throw passkeyAborted();
      if (!passkeyPending(e) || tries >= PASSKEY_PENDING_RETRIES) throw e;
      await passkeyPause(PASSKEY_PENDING_RETRY_MS, signal);
      if (signal.aborted) throw passkeyAborted();
    }
  }
}

async function passkeyPrompt(kind, publicKey, deadlineMs = PASSKEY_DEADLINE_MS, overlayAfterMs = PASSKEY_OVERLAY_AFTER_MS) {
  passkeyCancel();
  const ctl = new AbortController();
  let stop;
  // Rejected by the deadline or by Cancel; rejecting first, because the abort
  // rejects the prompt too and the first to settle wins.
  const ended = new Promise((_, reject) => { stop = (err) => { reject(err); ctl.abort(); }; });
  const self = { ctl, stop };
  passkeyOpen = self;
  const prompt = passkeyAsk(kind, publicKey, ctl.signal);
  prompt.catch(() => {}); // the deadline may answer first
  const endsAt = Date.now() + deadlineMs;
  const timer = setTimeout(() => stop(passkeyNoAnswer()), deadlineMs);
  const shown = setTimeout(() => passkeyOverlayShow(self, endsAt), overlayAfterMs);
  try {
    return await Promise.race([prompt, ended]);
  } finally {
    clearTimeout(timer);
    clearTimeout(shown);
    passkeyOverlayHide(self);
    if (passkeyOpen === self) passkeyOpen = null;
  }
}

/* What the page shows while the browser's prompt is open. The browser reports
   nothing until the prompt answers, so this shows only what is known: that we
   are waiting, what can approve it here, and when the prompt closes. Drawing it
   may never stop the prompt, so any failure here is dropped. */
let passkeyOverlay = null; // { scrim, owner, tick }
function passkeyOverlayShow(owner, endsAt) {
  try {
    // A modal <dialog> sits in the top layer, above any overlay; it shows its own status.
    if (passkeyOverlay || document.querySelector("dialog[open]")) return;
    const phone = passkeyOnPhone();
    const box = document.createElement("div");
    box.innerHTML = Z.overlay({
      id: "passkey-wait",
      kind: "dialog",
      title: phone ? "Waiting for Face ID" : "Waiting for your passkey",
      body: `<div class="pk-wait">
        <span class="z-live__spin pk-wait__spin" aria-hidden="true"></span>
        <p class="pk-wait__lede">${phone
          ? "Approve with Face ID or your fingerprint."
          : "Your browser opened a passkey window. Approve it with Touch ID, your computer’s password, your phone or a security key."}</p>
        <p class="pk-wait__hint" hidden>${phone
          ? "Don’t see it? Cancel and try again."
          : "Don’t see it? It may be behind this window or in another tab. Or cancel and try again."}</p>
        <p class="pk-wait__left"></p>
        ${Z.button({ variant: "secondary", full: true, label: "Cancel", className: "pk-wait__cancel" })}
      </div>`,
    });
    const scrim = box.firstElementChild;
    const left = scrim.querySelector(".pk-wait__left");
    const hint = scrim.querySelector(".pk-wait__hint");
    const hintAt = Date.now() + PASSKEY_HINT_AFTER_MS;
    const draw = () => {
      const s = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      left.textContent = `Closes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (Date.now() >= hintAt) hint.hidden = false;
    };
    draw();
    // Close, Cancel, a click on the scrim and Escape all cancel the prompt.
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim || e.target.closest(".z-overlay__close, .pk-wait__cancel")) passkeyUserCancel();
    });
    scrim.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // ui.js would close the overlay beneath this one too
      passkeyUserCancel();
    });
    passkeyOverlay = { scrim, owner, tick: setInterval(draw, 1000) };
    document.body.appendChild(scrim);
    Z.openOverlay(scrim);
  } catch { /* the prompt matters; the overlay is a nicety */ }
}
function passkeyOverlayHide(owner) {
  const o = passkeyOverlay;
  if (!o || o.owner !== owner) return;
  passkeyOverlay = null;
  clearInterval(o.tick);
  try {
    Z.closeOverlay(o.scrim.id);
    setTimeout(() => o.scrim.remove(), 250);
  } catch { /* already gone */ }
}

/* A step with a prompt in it (fetch the challenge, ask, submit) gets the
   prompt's deadline plus extraMs for its requests, and running out closes the
   open prompt too. */
async function withinPasskeyStep(work, extraMs, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); passkeyCancel(); }, PASSKEY_DEADLINE_MS + extraMs);
  });
  try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
}

/* A fresh passkey approval for a change a session alone may not make: binding
   a spending key, or replacing the Monerium connection. The server requires
   the UV flag, so the authenticator has to verify the human, and issues the
   challenge for one named action (STEP_UP_ACTIONS in routes/auth.ts): an
   approval for one change is refused by every other. */
async function passkeyStepUp(action) {
  if (!credId()) return null;
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "step_up", action });
  return passkeyAssertion(challenge);
}

/* A user-verified assertion over a challenge the server already issued for
   one change, such as the Safe import approval from /safe/import/prepare. */
async function passkeyAssertion(challenge) {
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(credId()) }],
    userVerification: "required",
  });
  return {
    credentialId: cred.id,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* The step-up a Monerium credential change needs: dropping one (always), or
   connecting on an account that already carries a Monerium identity, which
   the server reports as moneriumChangeNeedsPasskey. A brand-new account's
   first connection needs none. Mirrors approvesMoneriumChange in
   routes/monerium.ts. */
async function moneriumStepUp(u, always = false) {
  if (always) return { stepUp: await passkeyStepUp("monerium.disconnect") };
  return u?.moneriumChangeNeedsPasskey ? { stepUp: await passkeyStepUp("monerium.connect") } : {};
}
/* role="alert" so a screen reader announces the error: a red line appearing
   under a button is otherwise silent. Static .error slots carry the role in
   the markup; this covers the ones built from template strings. */
const showErr = (id, e) => {
  const el = $(id);
  if (!el.hasAttribute("role")) el.setAttribute("role", "alert");
  el.textContent = e.message;
  el.classList.remove("hidden");
};
const clearErr = (id) => $(id).classList.add("hidden");
/* Say something to a screen reader without drawing it — for confirmations
   shown only as an icon swap or a label on a button whose accessible name is
   fixed ("Copied"). One polite region, #sr-announce in index.html (it must
   exist before the text changes, or nothing is read). Cleared first so the
   same message twice is announced twice. */
function announce(msg) {
  const el = $("sr-announce");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = msg; }, 50);
}
/** A sent transfer's amount as a signed outflow — except where the money
 *  never left or came back (FAILED, REFUNDED): a "−€120.00" beside a
 *  transfer that debited nothing reads as money gone. */
const txAmountLabel = (t) => `${["FAILED", "REFUNDED"].includes(t.state) ? "" : "−"}€${fmt(t.sendEur)}`;
const shortAddr = (addr) => addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : "—";
