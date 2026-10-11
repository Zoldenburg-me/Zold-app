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
 * Recovering WITH this guardian is not built yet, and the page says so. An
 * ES module of its own, under a CSP without inline script (routes/pages.ts),
 * so the Turnkey code never loads into /app.
 */
import { IndexedDbStamper } from "../vendor/turnkey.js";
import { OAUTH_STATE_KEY, authorizeUrl, newState, nonceFor, readReturn } from "./oauth.js";

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
  return async (path, body) => {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `request failed (${r.status})`), { code: data.code, status: r.status });
    return data;
  };
}

const NOTES = `
  <p class="g-note"><b>Built, not yet run on a live deployment.</b> No Google or Apple login has been added as a guardian with this page yet. Recovering your account with such a guardian is not built, so until it is, this guardian cannot recover your account.</p>
  <p class="g-note">Use a login whose email is not your Zold account's email: whoever controls that inbox could otherwise start a recovery and delete the alert mail. In your Google or Apple account, add a second way to sign in, so losing one does not lose the guardian.</p>
  <p class="g-note">While you are logged in to a guardian on this page, the page's own code holds that login. The waiting period and the alerts on your account are the protection if that code were ever changed.</p>`;

function render(el, { me, caps, guardians, result }) {
  const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  const rows = guardians.length
    ? `<ul class="g-list">${guardians.map((g) => `<li><span translate="no">${esc(shortAddr(g.address))}</span> · ${g.status === "active" ? `Added to your account${g.activeAt ? ` on ${esc(new Date(g.activeAt).toLocaleDateString())}` : ""}` : "Not on your account yet"}
        ${g.status === "created" ? `<button type="button" class="z-btn" data-finish="${esc(g.turnkeySubOrgId)}">Finish adding</button>` : ""}</li>`).join("")}</ul>`
    : `<p>No Google or Apple guardian yet.</p>`;
  const buttons = ["google", "apple"].filter((p) => caps.turnkeyLogins?.[p])
    .map((p) => `<button type="button" class="z-btn z-btn--primary" data-start="${p}">Add with ${PROVIDER_NAMES[p]}</button>`).join(" ");
  const message = result
    ? result.step === "done" ? `<p class="g-ok" role="status">Your ${result.provider ? `${esc(PROVIDER_NAMES[result.provider])} ` : ""}login is now a guardian on your account.</p>`
    : `<p class="g-err" role="alert">${esc(result.reason ?? "Something went wrong.")}</p>`
    : "";
  el.innerHTML = `
    <h1>Your Google or Apple login as a guardian</h1>
    <p>Signed in as ${esc(me.name || me.email || "you")}. A guardian can approve moving this account to a new passkey if you lose yours. Zold never holds this guardian's key: Turnkey keeps it, and only your login can use it.</p>
    ${message}
    ${rows}
    <p>${buttons || "No login provider is set up on this deployment."}</p>
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
      p.textContent = `Approve with your passkey: add ${g.address} as a guardian of your account.`;
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

if (typeof document !== "undefined") boot();
