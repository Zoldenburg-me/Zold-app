/**
 * /guardian: choose who can help you get your account back if you lose your
 * phone — Zoldenburg (our team checks your ID) or your own Google or Apple
 * login (a Turnkey wallet only that login can use). One at a time: nothing
 * collects two approvals yet, and at threshold 1 either alone could move the
 * account; the API refuses the combination (OTHER_GUARDIAN) as well.
 *
 * Adding or removing either is a passkey-approved op on the Safe; the page
 * shows what the API says the chain lists. The Google/Apple login is a
 * full-page redirect that comes back here with the ID token in the fragment
 * (guardian/oauth.js); recovering with it happens on /recovery.
 *
 * An ES module of its own under a CSP without inline script (routes/pages.ts),
 * so the Turnkey code never loads into /app.
 */
import { IndexedDbStamper } from "../vendor/turnkey.js";
import { OAUTH_STATE_KEY, readReturn, startLogin } from "./oauth.js";
import { providerButtons } from "./providers.js";


/**
 * Back from the Google/Apple login. Returns {step: "done" | "created" |
 * "error", …}: "created" means the Turnkey wallet exists but the passkey did
 * not approve adding it; "Finish" runs `finishAdd` again.
 */
export async function finishLogin(env) {
  const { hash, storage, stripHash, stamper, api, userId, now = Date.now } = env;
  stripHash();
  let storedState = null;
  try {
    storedState = storage.getItem(OAUTH_STATE_KEY);
    storage.removeItem(OAUTH_STATE_KEY);
  } catch {
    // Storage blocked: no state to match, so readReturn refuses the login.
  }
  const back = readReturn(hash, storedState, now());
  if (!back) return null;
  let guardian;
  try {
    if (!back.ok) return { step: "error", reason: back.reason };
    await stamper.init();
    const publicKey = stamper.getPublicKey();
    if (!publicKey) return { step: "error", reason: "That login timed out in this browser. Try again." };
    ({ guardian } = await api(`/api/recovery/turnkey/users/${userId}/guardians`, { oidcToken: back.idToken, publicKey }));
    if (!guardian) return { step: "error", reason: "That login didn’t come back as a guardian. Try again." };
  } catch (e) {
    return { step: "error", reason: e.message };
  } finally {
    // The key only bound this one token; approving a recovery makes a new one.
    await stamper.clear().catch(() => {});
  }
  return finishAdd(guardian, env);
}

/** Put a created Google/Apple guardian on chain: prepare, passkey, submit. */
export async function finishAdd(guardian, { api, userId, passkeyGet, beforePasskey = () => {} }) {
  if (!guardian) return { step: "error", reason: "That backup login is no longer on your account. Reload the page." };
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
    return { step: "created", guardian, reason: "Face ID or fingerprint was cancelled. Tap Finish to try again." };
  }
  try {
    const done = await api(prep.submitTo, assertion);
    return { step: "done", guardian: done.guardian };
  } catch (e) {
    return { step: "created", guardian, reason: e.message };
  }
}

/**
 * Any other guardian change: ask the API for the op, approve it with the
 * passkey, submit. An answer without a challenge needed no op (the chain
 * already says so). Returns {ok: true, result} or {ok: false, reason}.
 */
export async function runPasskeyOp(prepPath, body, { api, passkeyGet }) {
  try {
    const prep = await api(prepPath, body);
    if (!prep?.challenge) return { ok: true, result: prep };
    let assertion;
    try {
      assertion = await passkeyGet(prep);
    } catch {
      return { ok: false, reason: "Face ID or fingerprint was cancelled. Nothing changed." };
    }
    return { ok: true, result: await api(prep.submitTo, assertion) };
  } catch (e) {
    return { ok: false, reason: e.message };
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

const HOW = `
  <h2 class="g-sub">How it works</h2>
  <ul class="g-steps">
    <li>New phone? Go to <a href="/recovery">zoldhq.com/recovery</a> and follow the steps.</li>
    <li>Your account moves to the new phone after a short waiting period. Your old phone gets a heads-up and can stop it.</li>
  </ul>`;

function render(el, { caps, zold, guardians, message }) {
  const social = guardians.filter((g) => g.status === "active");
  const zoldOn = Boolean(zold?.active);
  const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

  const zoldCard = caps.zoldenburgRecovery ? `
    <section class="g-card">
      <h2 class="g-sub">Zoldenburg</h2>
      <p>Our team checks it’s you against the ID you gave Monerium, then moves your account to your new phone.</p>
      ${zoldOn
        ? `<p class="g-ok">Your guardian</p><div class="g-actions"><button type="button" class="z-btn" data-zold="remove">Remove</button></div>`
        : social.length
          ? `<p class="g-note">One guardian at a time: remove your backup login to choose Zoldenburg.</p>`
          : `<div class="g-actions"><button type="button" class="z-btn z-btn--primary" data-zold="add">Choose Zoldenburg</button></div>`}
    </section>` : "";

  const buttons = providerButtons(caps, "Add");
  const rows = guardians.map((g) => `<li><span translate="no">${esc(shortAddr(g.address))}</span>
      ${g.status === "active"
        ? `<span class="g-ok">Your guardian</span><button type="button" class="z-btn" data-remove="${esc(g.turnkeySubOrgId)}">Remove</button>`
        : `<span>Almost there</span><button type="button" class="z-btn" data-finish="${esc(g.turnkeySubOrgId)}">Finish</button>`}</li>`).join("");
  const loginCard = caps.turnkeyGuardians ? `
    <section class="g-card">
      <h2 class="g-sub">Your Google or Apple login</h2>
      <p>Approve the move with a login you already have. It stays yours alone: Zold never holds its key.</p>
      ${rows ? `<ul class="g-list">${rows}</ul>` : ""}
      ${social.length ? ""
        : zoldOn ? `<p class="g-note">One guardian at a time: remove Zoldenburg to use your Google or Apple login.</p>`
          : buttons ? `<div class="z-providers">${buttons}</div>` : ""}
      <p class="g-note">Tip: pick a login with a different email from your Zold account, and turn on two-step sign-in for it.</p>
    </section>` : "";

  el.innerHTML = `
    <h1>Your guardian</h1>
    <p>Lose your phone, keep your account. Pick who can help you move Zold to a new phone.</p>
    ${message ? `<p class="${message.ok ? "g-ok" : "g-err"}" role="${message.ok ? "status" : "alert"}">${esc(message.text)}</p>` : ""}
    ${zoldCard}
    ${loginCard}
    ${HOW}
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
  if (!caps.zoldenburgRecovery && !caps.turnkeyGuardians) return show(`<h1>Your guardian</h1><p>Guardians aren’t available right now.</p><p><a href="/app">Back to Zold</a></p>`);
  if (!token) return show(`<h1>Sign in first</h1><p>Open Zold and sign in, then come back to Security → Recovery.</p><p><a href="/app">Open Zold</a></p>`);
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
      p.textContent = `Confirm with Face ID or fingerprint to add ${g.address} as your guardian.`;
      el.prepend(p);
    },
  };
  let message = null;
  if (returnedHash) {
    try {
      const r = await finishLogin(env);
      if (r) message = r.step === "done" ? { ok: true, text: "Done. Your backup login now protects your account." } : { ok: false, text: r.reason ?? "Something went wrong." };
    } catch (e) {
      message = { ok: false, text: e?.message || "Something went wrong. Try again." };
    }
  }

  const showError = (e) => show(`<h1>Something went wrong</h1><p>${esc(e?.message || "Try again.")}</p><p><a href="/app">Back to Zold</a></p>`);
  const draw = async () => {
    const [zold, social] = await Promise.all([
      caps.zoldenburgRecovery ? api(`/api/users/${me.id}/recovery/zoldenburg`) : null,
      caps.turnkeyGuardians ? api(`/api/recovery/turnkey/users/${me.id}/guardians`) : { guardians: [] },
    ]);
    const guardians = social?.guardians ?? [];
    render(el, { caps, zold, guardians, message });
    const busyThen = (b, fn) => async () => {
      b.setAttribute("aria-busy", "true");
      b.disabled = true;
      try {
        message = await fn();
      } catch (e) {
        message = { ok: false, text: e?.message || "Something went wrong. Try again." };
      }
      try {
        await draw();
      } catch (e) {
        b.removeAttribute("aria-busy");
        b.disabled = false;
        showError(e);
      }
    };
    el.querySelectorAll("[data-start]").forEach((b) => {
      b.addEventListener("click", busyThen(b, async () => {
        try {
          await startLogin(b.dataset.start, { stamper, storage: sessionStorage, origin: location.origin, logins: caps.turnkeyLogins, go: (u) => location.assign(u) });
          return null;
        } catch (e) {
          return { ok: false, text: e.message };
        }
      }));
    });
    el.querySelectorAll("[data-finish]").forEach((b) => {
      b.addEventListener("click", busyThen(b, async () => {
        const r = await finishAdd(guardians.find((x) => x.turnkeySubOrgId === b.dataset.finish), env);
        return r.step === "done" ? { ok: true, text: "Done. Your backup login now protects your account." } : { ok: false, text: r.reason };
      }));
    });
    el.querySelectorAll("[data-remove]").forEach((b) => {
      b.addEventListener("click", busyThen(b, async () => {
        const r = await runPasskeyOp(`/api/recovery/turnkey/users/${me.id}/guardians/${encodeURIComponent(b.dataset.remove)}/remove`, {}, { api, passkeyGet });
        return r.ok ? { ok: true, text: "Your backup login is removed." } : { ok: false, text: r.reason };
      }));
    });
    el.querySelectorAll("[data-zold]").forEach((b) => {
      b.addEventListener("click", busyThen(b, async () => {
        const add = b.dataset.zold === "add";
        const r = await runPasskeyOp(`/api/users/${me.id}/recovery/zoldenburg${add ? "" : "/remove"}`, add ? { acknowledged: true } : {}, { api, passkeyGet });
        return r.ok ? { ok: true, text: add ? "Done. Zoldenburg is your guardian." : "Zoldenburg is removed." } : { ok: false, text: r.reason };
      }));
    });
  };
  await draw().catch(showError);
}

if (typeof document !== "undefined") boot();
