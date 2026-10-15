/**
 * /guardian: choose who can help you get your account back if you lose your
 * phone — Zoldenburg (our team checks your ID) or your own Google or Apple
 * login, email address or recovery passkey (a Turnkey wallet only that login
 * can use; guardian/logins.js). One at a time: nothing
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
import { IndexedDbStamper, encryptOtpCodeToBundle } from "../vendor/turnkey.js";
import { createGuardianPasskey, emailCodeToToken, sendEmailCode } from "./logins.js";
import { OAUTH_STATE_KEY, readReturn, startLogin } from "./oauth.js";
import { providerButtons } from "./providers.js";
import { afterCheck, checkEnrolment, enrolmentHtml, issueEnrolmentCode } from "./enrolment.js";
import { byDevice } from "./device-words.js";


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
    if (!guardian) return { step: "error", reason: "That login didn’t come back as a recovery helper. Try again." };
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
    return { step: "created", guardian, reason: byDevice("Face ID or fingerprint was cancelled. Tap Finish to try again.", "The passkey prompt was cancelled. Click Finish to try again.") };
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
      return { ok: false, reason: byDevice("Face ID or fingerprint was cancelled. Nothing changed.", "The passkey prompt was cancelled. Nothing changed.") };
    }
    return { ok: true, result: await api(prep.submitTo, assertion) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * A button's click that runs one at a time, and only while no other action
 * sharing `lock` runs: each one redraws the page, so a second would draw over
 * the first. aria-disabled, not disabled: a disabled button drops focus to the
 * page, and its progress is never read out.
 */
export function oneAtATime(b, fn, lock = { busy: false }) {
  return async () => {
    if (lock.busy || b.getAttribute("aria-disabled") === "true") return;
    lock.busy = true;
    b.setAttribute("aria-disabled", "true");
    b.setAttribute("aria-busy", "true");
    try {
      await fn();
    } finally {
      lock.busy = false;
      b.removeAttribute("aria-disabled");
      b.removeAttribute("aria-busy");
    }
  };
}

/**
 * Add or remove Zoldenburg: one passkey-approved Safe op. Once the passkey is
 * done the chain still takes up to a minute, so the button says so, and
 * `announce` reads it out; a button that looks dead invites a second try.
 */
export async function zoldenburgOp(add, btn, { api, userId, passkeyGet, announce = () => {} }) {
  const label = btn.textContent;
  try {
    const r = await runPasskeyOp(`/api/users/${userId}/recovery/zoldenburg${add ? "" : "/remove"}`, add ? { acknowledged: true } : {}, {
      api,
      passkeyGet: async (prep) => {
        const assertion = await passkeyGet(prep);
        btn.textContent = add ? "Adding Zoldenburg to your wallet… up to a minute" : "Removing Zoldenburg from your wallet… up to a minute";
        announce(btn.textContent);
        return assertion;
      },
    });
    return r.ok ? { ok: true, text: add ? "Zoldenburg is added." : "Zoldenburg is removed." } : { ok: false, text: r.reason };
  } finally {
    btn.textContent = label;
  }
}

// ---------------------------------------------------------------------------
// The browser side: everything below needs a DOM.

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const bytesToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The account's passkey approves the prepared Safe op. */
/** A step-up for one action (routes/auth.ts): a challenge bound to it, approved with the account's passkey. */
function stepUpWith(api, me) {
  return async (action) => {
    if (!me.passkey?.credentialId) throw new Error(byDevice("Add Face ID or fingerprint sign-in in Zold first, then come back.", "Add passkey sign-in in Zold first, then come back."));
    const { challenge } = await api("/api/webauthn/challenge", { purpose: "step_up", action });
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(challenge),
        rpId: me.passkey?.rpId || location.hostname,
        allowCredentials: [{ type: "public-key", id: b64urlToBytes(me.passkey.credentialId) }],
        userVerification: "required",
        timeout: 120_000,
      },
    });
    return {
      credentialId: cred.id,
      authenticatorData: bytesToB64url(cred.response.authenticatorData),
      clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
      signature: bytesToB64url(cred.response.signature),
    };
  };
}

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

function render(el, { caps, zold, guardians, message, issued = null, ibanReady = false, otp = null }) {
  const social = guardians.filter((g) => g.status === "active");
  const zoldOn = Boolean(zold?.active);
  const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

  const zoldCard = caps.zoldenburgRecovery ? `
    <section class="g-card">
      <h2 class="g-sub" id="g-zold-head" tabindex="-1">Zoldenburg</h2>
      ${zoldOn
        ? `${zold.enrolment?.armed ? `<p class="g-ok">Your recovery helper</p>` : `<p class="g-ok">Added to your wallet.</p>`}
          ${enrolmentHtml(zold.enrolment, { issued, ibanReady })}
          <p class="g-note">If you lose your phone, our team checks it’s you against the ID you gave Monerium, then moves your account to your new phone.</p>
          <div class="g-actions"><button type="button" class="z-link-btn" data-zold="remove">Remove Zoldenburg</button></div>`
        : social.length
          ? `<p>Our team checks it’s you against the ID you gave Monerium, then moves your account to your new phone.</p>
            <p class="g-note">One recovery helper at a time: remove your backup login to choose Zoldenburg.</p>`
          : `<p>Our team checks it’s you against the ID you gave Monerium, then moves your account to your new phone.</p>
            <div class="g-actions"><button type="button" class="z-btn z-btn--primary" data-zold="add">Choose Zoldenburg</button></div>`}
    </section>` : "";

  const logins = caps.turnkeyLogins || {};
  const buttons = `${providerButtons(caps, "Add")}${logins.passkey ? `<button type="button" class="z-btn z-provider" data-add="passkey"><span>Add a recovery passkey</span></button>` : ""}`;
  const emailForm = !logins.email ? "" : otp
    ? `<form id="g-otp" novalidate><label for="g-otp-code">Code sent to ${esc(otp.to)}</label>
        <input id="g-otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        <div class="g-actions"><button class="z-btn z-btn--primary" id="g-otp-go">Add this email</button></div></form>`
    : `<form id="g-mail" novalidate><label for="g-mail-addr">Or an email address</label>
        <input id="g-mail-addr" type="email" autocomplete="email" autocapitalize="off" required>
        <div class="g-actions"><button class="z-btn" id="g-mail-go">Send a code</button></div></form>`;
  const rows = guardians.map((g) => `<li><span translate="no">${esc(shortAddr(g.address))}</span>
      ${g.status === "active"
        ? `<span class="g-ok">Your recovery helper</span><button type="button" class="z-btn" data-remove="${esc(g.turnkeySubOrgId)}">Remove</button>`
        : `<span>Almost there</span><button type="button" class="z-btn" data-finish="${esc(g.turnkeySubOrgId)}">Finish</button>`}</li>`).join("");
  const loginCard = caps.turnkeyGuardians ? `
    <section class="g-card">
      <h2 class="g-sub" id="g-login-head" tabindex="-1">Your own backup login</h2>
      <p>Approve the move with your Google or Apple login, an email address or a recovery passkey. It stays yours alone: Zold never holds its key.</p>
      ${rows ? `<ul class="g-list">${rows}</ul>` : ""}
      ${social.length ? ""
        : zoldOn ? `<p class="g-note">One recovery helper at a time: remove Zoldenburg to use your Google or Apple login.</p>`
          : `${buttons ? `<div class="z-providers">${buttons}</div>` : ""}${emailForm}`}
      <p class="g-note">Tip: pick a login with a different email from your Zold account, and turn on two-step sign-in for it. A recovery passkey must survive losing this phone: use a security key, or save it on another device.</p>
    </section>` : "";

  el.innerHTML = `
    <h1>Your recovery helper</h1>
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
  if (!caps.zoldenburgRecovery && !caps.turnkeyGuardians) return show(`<h1>Your recovery helper</h1><p>Recovery helpers aren’t available right now.</p><p><a href="/app">Back to Zold</a></p>`);
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
      p.textContent = `Confirm with your ${byDevice("Face ID or fingerprint", "passkey")} to add ${g.address} as your recovery helper.`;
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

  // The last enrolment code issued in this page: shown until it is used or replaced.
  let issued = null;
  // An email code on its way to a new backup email: {otpId, otpEncryptionTargetBundle, to}.
  let otp = null;
  // One action at a time on the whole page, across redraws.
  const pageLock = { busy: false };
  const ibanReady = me.kycStatus === "approved" && Boolean(me.iban);
  const stepUp = stepUpWith(api, me);
  const live = document.getElementById("g-status");
  const announce = (text) => { if (live) live.textContent = text; };
  const showError = (e) => show(`<h1>Something went wrong</h1><p>${esc(e?.message || "Try again.")}</p><p><a href="/app">Back to Zold</a></p>`);
  const draw = async () => {
    const [zold, social] = await Promise.all([
      caps.zoldenburgRecovery ? api(`/api/users/${me.id}/recovery/zoldenburg`) : null,
      caps.turnkeyGuardians ? api(`/api/recovery/turnkey/users/${me.id}/guardians`) : { guardians: [] },
    ]);
    const guardians = social?.guardians ?? [];
    render(el, { caps, zold, guardians, message, issued, ibanReady, otp });
    // The redraw replaces the clicked button: focus goes to its card's heading,
    // not to the top of the page, and the outcome is read out.
    const busyThen = (b, fn) => oneAtATime(b, async () => {
      const head = b.closest?.(".g-card")?.querySelector("h2")?.id;
      try {
        message = await fn();
      } catch (e) {
        message = { ok: false, text: e?.message || "Something went wrong. Try again." };
      }
      await draw().catch(showError);
      if (message?.text) announce(message.text);
      if (head) document.getElementById(head)?.focus({ preventScroll: false });
    }, pageLock);
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
    const added = async (body) => {
      const r = await finishAdd((await api(`/api/recovery/turnkey/users/${me.id}/guardians`, body)).guardian, env);
      return r.step === "done" ? { ok: true, text: "Done. Your backup login now protects your account." } : { ok: false, text: r.reason };
    };
    el.querySelectorAll('[data-add="passkey"]').forEach((b) => b.addEventListener("click", busyThen(b, async () => added({ passkey: await createGuardianPasskey() }))));
    const onSubmit = (id, btnId, fn) => {
      const form = el.querySelector(id);
      if (!form) return;
      const run = busyThen(form.querySelector(btnId), fn);
      form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
    };
    onSubmit("#g-mail", "#g-mail-go", async () => {
      const to = el.querySelector("#g-mail-addr").value.trim();
      otp = { ...(await sendEmailCode(api, to)), to };
      return { ok: true, text: `We sent a 6-digit code to ${to}.` };
    });
    onSubmit("#g-otp", "#g-otp-go", async () => {
      const code = el.querySelector("#g-otp-code").value.replace(/\s/g, "");
      const stamper = new IndexedDbStamper();
      try {
        const verificationToken = await emailCodeToToken({ api, stamper, encrypt: encryptOtpCodeToBundle, otp, code });
        otp = null;
        return await added({ verificationToken });
      } finally {
        await stamper.clear().catch(() => {});
      }
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
        return zoldenburgOp(b.dataset.zold === "add", b, { api, userId: me.id, passkeyGet, announce });
      }));
    });
    el.querySelectorAll("[data-enrol]").forEach((b) => {
      if (b.dataset.enrol === "copy") {
        // The reference as drawn with this button, not whatever `issued` holds later.
        const memo = issued?.memo;
        b.addEventListener("click", async () => {
          if (!memo) return;
          try { await navigator.clipboard.writeText(memo); b.textContent = "Copied"; }
          catch { b.textContent = "Copy failed: select it above"; }
          announce(b.textContent);
        });
        return;
      }
      b.addEventListener("click", busyThen(b, async () => {
        if (b.dataset.enrol === "new") {
          issued = await issueEnrolmentCode({ api, userId: me.id, stepUp });
          return { ok: true, text: "Your transfer details are below." };
        }
        const next = afterCheck(await checkEnrolment({ api, userId: me.id }), issued);
        issued = next.issued;
        return next.message;
      }));
    });
  };
  await draw().catch(showError);
}

if (typeof document !== "undefined") boot();
