/**
 * /guardian: make your own Google or Apple login a recovery guardian of your
 * Zold account (docs/recovery-guardians-plan.md, Phase 2).
 *
 * 1. "Add with Google/Apple": a fresh P-256 key in IndexedDB (the vendored
 *    Turnkey stamper), its hash as the login's nonce, a one-time state, then
 *    off to the provider.
 * 2. Back here with the ID token in the fragment: strip it from the address
 *    bar, send it with the key it is bound to (the API checks both and makes
 *    the Turnkey wallet), drop the key, then the passkey approves the op that
 *    puts the wallet's address on the Safe's recovery module.
 *
 * 3. Recovery, on the device that lost its passkey: /app hands this tab the
 *    request (sessionStorage, RECOVERY_KEY). The same login, then: a Turnkey
 *    session for the guardian's sub-org bound to a fresh key, the digest the
 *    API recomputed from the module, Turnkey signs it with that key, the API
 *    checks and relays it, and the key is dropped.
 *
 * An ES module of its own, under a CSP without inline script whose
 * connect-src adds only Turnkey's API (routes/pages.ts), so the Turnkey code
 * never loads into /app.
 */
import { IndexedDbStamper } from "../vendor/turnkey.js";
import { OAUTH_STATE_KEY, authorizeUrl, newState, nonceFor, readReturn } from "./oauth.js";
import { signRawPayload } from "./turnkey-sign.js";

/** Set by /app's recovery screen: {requestId, secret, email}. */
export const RECOVERY_KEY = "zold-guardian-recovery";

const PROVIDER_NAMES = { google: "Google", apple: "Apple" };

/** Step 1: leave for the provider. Nothing is sent to Zold yet. */
export async function startLogin(provider, { stamper, storage, origin, logins, go, now = Date.now }) {
  const clientId = logins?.[provider];
  if (!clientId) throw new Error(`${PROVIDER_NAMES[provider] ?? provider} login is not set up on this deployment`);
  await stamper.init();
  await stamper.resetKeyPair();
  const publicKey = stamper.getPublicKey();
  if (!publicKey) throw new Error("this browser could not make a key; try another browser");
  const state = newState();
  storage.setItem(OAUTH_STATE_KEY, JSON.stringify({ state, provider, at: now() }));
  go(authorizeUrl(provider, { clientId, redirectUri: `${origin}/guardian`, nonce: await nonceFor(publicKey), state }));
}

/**
 * Step 2, on the way back. Returns {step: "done" | "created" | "error", …}:
 * "created" means the Turnkey wallet exists but the passkey did not approve
 * adding it; "Finish adding" runs `finishAdd` again.
 */
export async function finishLogin(env) {
  const { hash, storage, stripHash, stamper, api, userId, now = Date.now } = env;
  const storedState = storage.getItem(OAUTH_STATE_KEY);
  storage.removeItem(OAUTH_STATE_KEY);
  stripHash();
  const back = readReturn(hash, storedState, now());
  if (!back) return null;
  let guardian;
  try {
    if (!back.ok) return { step: "error", reason: back.reason };
    await stamper.init();
    const publicKey = stamper.getPublicKey();
    if (!publicKey) return { step: "error", reason: "The key this login was bound to is gone (another tab or a cleared browser). Start again." };
    ({ guardian } = await api(`/api/recovery/turnkey/users/${userId}/guardians`, { oidcToken: back.idToken, publicKey }));
  } catch (e) {
    return { step: "error", reason: e.message };
  } finally {
    // The key only bound this one token; signing a recovery makes a new one.
    await stamper.clear().catch(() => {});
  }
  return finishAdd(guardian, env);
}

/** Put a created guardian on chain: prepare, approve with the passkey, submit. */
export async function finishAdd(guardian, { api, userId, passkeyGet, beforePasskey = () => {} }) {
  if (guardian.status === "active") return { step: "done", guardian };
  let prep;
  try {
    prep = await api(`/api/recovery/turnkey/users/${userId}/guardians/${encodeURIComponent(guardian.turnkeySubOrgId)}/add`, {});
  } catch (e) {
    return { step: "created", guardian, reason: e.message };
  }
  if (prep.guardian) return { step: "done", guardian: prep.guardian };
  let assertion;
  try {
    beforePasskey(guardian);
    assertion = await passkeyGet(prep);
  } catch {
    return { step: "created", guardian, reason: "The passkey did not approve adding the guardian. Nothing changed on your account." };
  }
  try {
    const done = await api(prep.submitTo, assertion);
    return { step: "done", guardian: done.guardian };
  } catch (e) {
    return { step: "created", guardian, reason: e.message };
  }
}

/** The request /app handed over, or null. A day-old hand-off is ignored:
 *  the tab is then free to add a guardian again. */
const RECOVERY_HANDOFF_MS = 24 * 3600_000;
export function recoveryContext(storage, now = Date.now()) {
  try {
    const c = JSON.parse(storage.getItem(RECOVERY_KEY) || "null");
    const fresh = c && typeof c.at === "number" && now - c.at <= RECOVERY_HANDOFF_MS;
    return fresh && typeof c.requestId === "string" && typeof c.secret === "string" ? c : null;
  } catch {
    return null;
  }
}

/**
 * Step 3, back from the login on the lost-device path. Returns
 * {step: "approved", request} or {step: "error", reason}; null when there is
 * no login to handle. The key is dropped whatever happens.
 */
export async function finishApprove(env) {
  const { hash, storage, stripHash, stamper, api, recovery, turnkeyApi, sign = signRawPayload, now = Date.now } = env;
  const storedState = storage.getItem(OAUTH_STATE_KEY);
  storage.removeItem(OAUTH_STATE_KEY);
  stripHash();
  const back = readReturn(hash, storedState, now());
  if (!back) return null;
  const withSecret = { "x-recovery-secret": recovery.secret };
  const path = (suffix = "") => `/api/recovery/turnkey/requests/${encodeURIComponent(recovery.requestId)}${suffix}`;
  try {
    if (!back.ok) return { step: "error", reason: back.reason };
    await stamper.init();
    const publicKey = stamper.getPublicKey();
    if (!publicKey) return { step: "error", reason: "The key this login was bound to is gone (another tab or a cleared browser). Start again." };
    const login = await api("/api/recovery/turnkey/login", { oidcToken: back.idToken, publicKey });
    const toSign = await api(path("/digest"), undefined, withSecret);
    if (login.subOrgId !== toSign.subOrgId) {
      return { step: "error", reason: "This Google or Apple account is not this account’s guardian. Log in with the one you added." };
    }
    const signature = await sign({ stamper, baseUrl: turnkeyApi, organizationId: login.subOrgId, signWith: toSign.guardianAddress, payload: toSign.digest });
    const request = await api(path("/signature"), signature, withSecret);
    return { step: "approved", request };
  } catch (e) {
    return { step: "error", reason: e.message };
  } finally {
    await stamper.clear().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The browser side: everything below needs a DOM.

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const bytesToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The account's passkey approves the prepared Safe op. */
async function passkeyGet(prep) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(prep.challenge),
      rpId: prep.rpId,
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(prep.credentialId) }],
      userVerification: "required",
      timeout: 120_000,
    },
  });
  return {
    authenticatorData: bytesToB64url(cred.response.authenticatorData),
    clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
    signature: bytesToB64url(cred.response.signature),
  };
}

function apiWith(token) {
  return async (path, body, headers = {}) => {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `request failed (${r.status})`), { code: data.code, status: r.status });
    return data;
  };
}

const NOTES = `
  <h2 class="g-sub">How it works</h2>
  <ul class="g-steps">
    <li>New phone? Open Zold, choose “Recover your account” and approve with this login.</li>
    <li>Your account moves to the new phone after a short waiting period. Your old phone gets a heads-up and can stop it.</li>
  </ul>
  <p class="g-note">Tip: pick a login with a different email from your Zold account, and turn on two-step sign-in for it.</p>`;

function render(el, { me, caps, guardians, result }) {
  const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  const rows = guardians.length
    ? `<ul class="g-list">${guardians.map((g) => `<li><span translate="no">${esc(shortAddr(g.address))}</span> · ${g.status === "active" ? `Your guardian${g.activeAt ? ` since ${esc(new Date(g.activeAt).toLocaleDateString())}` : ""}` : "Almost there"}
        ${g.status === "created" ? `<button type="button" class="z-btn" data-finish="${esc(g.turnkeySubOrgId)}">Finish adding</button>` : ""}</li>`).join("")}</ul>`
    : "";
  const buttons = ["google", "apple"].filter((p) => caps.turnkeyLogins?.[p])
    .map((p) => `<button type="button" class="z-btn z-btn--primary" data-start="${p}">Add with ${PROVIDER_NAMES[p]}</button>`).join("");
  const message = result
    ? result.step === "done" ? `<p class="g-ok" role="status">Done. Your ${result.provider ? `${esc(PROVIDER_NAMES[result.provider])} ` : ""}login now protects your account.</p>`
    : `<p class="g-err" role="alert">${esc(result.reason ?? "Something went wrong.")}</p>`
    : "";
  el.innerHTML = `
    <h1>Your backup login</h1>
    <p>Lose your phone, keep your account. Your Google or Apple login can move Zold to a new phone in a few taps. It stays yours alone: Zold never holds its key.</p>
    ${message}
    ${rows}
    ${buttons ? `<div class="g-actions">${buttons}</div>` : "<p>No login provider is set up on this deployment.</p>"}
    ${NOTES}
    <p><a href="/app">Back to Zold</a></p>`;
}

async function boot() {
  // A login coming back carries its ID token in the fragment: take it out of
  // the address bar and history before anything else, whatever happens next.
  const returnedHash = location.hash;
  if (returnedHash) history.replaceState(null, "", location.pathname);
  const el = document.getElementById("g-body");
  const show = (html) => (el.innerHTML = html);
  let token = null;
  try { token = localStorage.getItem("zold-session"); } catch { /* storage blocked */ }
  const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  const caps = health?.capabilities ?? {};
  if (!caps.turnkeyGuardians) return show(`<h1>Not available</h1><p>Google and Apple guardians are not switched on for this deployment.</p><p><a href="/app">Back to Zold</a></p>`);
  const recovery = recoveryContext(sessionStorage);
  if (recovery) return bootApprove(el, { caps, recovery, returnedHash });
  if (!token) return show(`<h1>Sign in first</h1><p>Open Zold, sign in with your passkey, then come back to Security → Recovery.</p><p><a href="/app">Open Zold</a></p>`);
  const api = apiWith(token);
  let me;
  try { me = await api("/api/session"); } catch { return show(`<h1>Sign in first</h1><p>Your session has ended. Sign in again, then come back here.</p><p><a href="/app">Open Zold</a></p>`); }

  const stamper = new IndexedDbStamper();
  const env = {
    hash: returnedHash, storage: sessionStorage, stamper, api, userId: me.id, passkeyGet,
    stripHash: () => history.replaceState(null, "", location.pathname),
    beforePasskey: (g) => {
      const p = document.createElement("p");
      p.className = "g-ok";
      p.setAttribute("role", "status");
      p.textContent = `Confirm with your passkey to add ${g.address} as your guardian.`;
      el.prepend(p);
    },
  };
  const providerOnReturn = (() => { try { return JSON.parse(sessionStorage.getItem(OAUTH_STATE_KEY) || "{}").provider; } catch { return undefined; } })();
  let result = returnedHash ? await finishLogin(env) : null;
  if (result) result.provider = providerOnReturn;

  const draw = async () => {
    const { guardians } = await api(`/api/recovery/turnkey/users/${me.id}/guardians`);
    render(el, { me, caps, guardians, result });
    el.querySelectorAll("[data-start]").forEach((b) => {
      b.addEventListener("click", async () => {
        b.setAttribute("aria-busy", "true");
        try {
          await startLogin(b.dataset.start, { stamper, storage: sessionStorage, origin: location.origin, logins: caps.turnkeyLogins, go: (u) => location.assign(u) });
        } catch (e) {
          result = { step: "error", reason: e.message };
          await draw();
        }
      });
    });
    el.querySelectorAll("[data-finish]").forEach((b) => {
      b.addEventListener("click", async () => {
        b.setAttribute("aria-busy", "true");
        const g = guardians.find((x) => x.turnkeySubOrgId === b.dataset.finish);
        result = await finishAdd(g, env);
        await draw();
      });
    });
  };
  await draw().catch((e) => show(`<h1>Something went wrong</h1><p>${esc(e.message)}</p><p><a href="/app">Back to Zold</a></p>`));
}

/** The lost-device path: no Zold session, the request's secret instead. */
async function bootApprove(el, { caps, recovery, returnedHash }) {
  const api = apiWith(null);
  const stamper = new IndexedDbStamper();
  const back = `<p><a href="/app#recover">Back to Zold</a></p>`;
  let result = null;
  if (returnedHash) {
    result = await finishApprove({
      hash: returnedHash, storage: sessionStorage, stamper, api, recovery, turnkeyApi: caps.turnkeyApi,
      stripHash: () => history.replaceState(null, "", location.pathname),
    });
  }
  if (result?.step === "approved") {
    // Done here; /app finds the request again by the email.
    try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ email: recovery.email })); } catch { /* the email is retyped */ }
    const until = result.request?.turnkey?.finalizeAfter ? new Date(result.request.turnkey.finalizeAfter).toLocaleString() : null;
    el.innerHTML = `<h1>You’re all set</h1>
      <p class="g-ok" role="status">Your account is on its way to this phone${until ? `. It arrives ${esc(until)}` : ""}.</p>
      <p>Head back to Zold to follow along.</p>${back}`;
    return;
  }
  let status = "";
  try {
    status = (await api(`/api/recovery/turnkey/requests/${encodeURIComponent(recovery.requestId)}`, undefined, { "x-recovery-secret": recovery.secret })).status;
  } catch (e) {
    el.innerHTML = `<h1>Nothing to approve</h1><p>${esc(e.message)}</p>${back}`;
    return;
  }
  if (status !== "REVIEW_PENDING") {
    el.innerHTML = `<h1>Nothing to approve</h1><p>This recovery is not waiting for an approval (${esc(status)}).</p>${back}`;
    return;
  }
  const buttons = ["google", "apple"].filter((p) => caps.turnkeyLogins?.[p])
    .map((p) => `<button type="button" class="z-btn z-btn--primary" data-start="${p}">Approve with ${PROVIDER_NAMES[p]}</button>`).join("");
  el.innerHTML = `<h1>Welcome back</h1>
    ${result?.step === "error" ? `<p class="g-err" role="alert">${esc(result.reason)}</p>` : ""}
    <p>Log in with the Google or Apple account you chose as your backup login, and we’ll move your Zold account to this phone.</p>
    ${buttons ? `<div class="g-actions">${buttons}</div>` : "<p>No login provider is set up on this deployment.</p>"}
    ${back}`;
  el.querySelectorAll("[data-start]").forEach((b) => {
    b.addEventListener("click", async () => {
      b.setAttribute("aria-busy", "true");
      try {
        await startLogin(b.dataset.start, { stamper, storage: sessionStorage, origin: location.origin, logins: caps.turnkeyLogins, go: (u) => location.assign(u) });
      } catch (e) {
        b.removeAttribute("aria-busy");
        el.insertAdjacentHTML("afterbegin", `<p class="g-err" role="alert">${esc(e.message)}</p>`);
      }
    });
  });
}

if (typeof document !== "undefined") boot();
