/**
 * /recovery: move a Zold account to a new phone after losing the old one.
 *
 * One page for every guardian (recovery/flow.js picks it): email, a new
 * passkey made on this phone, then the guardian's step — codes by email/SMS,
 * Zoldenburg's ID check, or the person's own Google/Apple login (signed here,
 * recovery/approve.js) — then the waiting period, during which the old phone
 * can stop it, then sign in.
 *
 * Its own ES-module page under a CSP without inline script, whose connect-src
 * adds only Turnkey's API (routes/pages.ts). No Zold session: each call
 * carries the request's secret.
 */
import { IndexedDbStamper } from "../vendor/turnkey.js";
import { startLogin } from "../guardian/oauth.js";
import { providerButtons } from "../guardian/providers.js";
import { finishApprove } from "./approve.js";
import {
  EMAIL_KEY, SECRET_KEY, TICKET_KEY, currentAuth, endedText, finalizeAfter, requestPath, saveFor, savedFor, screenFor, startRecovery,
} from "./flow.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const bytesToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function api(path, body, headers = {}) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `request failed (${r.status})`), { status: r.status, code: data.code, body: data });
  return data;
}

/** "2d 21h", "5h 12m", "12m". */
function leftText(ms) {
  if (ms <= 60000) return "less than a minute";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

async function boot() {
  // A login coming back carries its ID token in the fragment: out of the
  // address bar and history before anything else.
  const returnedHash = location.hash;
  if (returnedHash) history.replaceState(null, "", location.pathname);
  const el = document.getElementById("r-body");
  const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  const caps = health?.capabilities ?? {};

  // `gen` counts renders: a poll that started before the latest one drops its answer.
  const s = { email: "", mode: "", request: null, notice: "", error: "", timer: null, gen: 0 };
  try { s.email = sessionStorage.getItem(EMAIL_KEY) || ""; } catch { /* storage blocked */ }
  const secret = () => savedFor(localStorage, SECRET_KEY, s.email);
  const ticket = () => savedFor(localStorage, TICKET_KEY, s.email);
  const auth = () => ({ ...(secret() ? { "x-recovery-secret": secret() } : {}), ...(ticket() ? { "x-recovery-otp-ticket": ticket() } : {}) });

  const show = () => {
    clearTimeout(s.timer);
    s.gen++;
    const screen = screenFor(s.mode, s.request);
    if (screen === "email" && s.request) {
      s.notice = endedText(s.request);
      s.request = null;
    }
    if (screen === "done") {
      saveFor(localStorage, SECRET_KEY, s.email, "");
      saveFor(localStorage, TICKET_KEY, s.email, "");
      try { sessionStorage.removeItem(EMAIL_KEY); } catch { /* nothing to clear */ }
    }
    el.innerHTML = SCREENS[screen]();
    el.querySelector("h1")?.focus?.();
    BIND[screen]?.();
    if (["wait", "zoldenburg", "approve"].includes(screen)) follow();
  };
  const fail = (e) => {
    s.error = e?.name === "NotAllowedError" ? "Face ID or fingerprint was cancelled. Try again when you’re ready." : e?.message || String(e);
    const box = el.querySelector("#r-err");
    if (box) { box.textContent = s.error; box.hidden = false; }
  };
  const busy = (btn, on) => { if (btn) { btn.toggleAttribute("aria-busy", on); btn.disabled = on; } };

  /* Re-read the request while it waits: every minute, or just after the waiting period. */
  const follow = () => {
    const r = s.request;
    const gen = s.gen;
    const until = finalizeAfter(r);
    const wait = until ? Math.min(60000, Math.max(2000, until.getTime() - Date.now() + 1000)) : 60000;
    s.timer = setTimeout(async () => {
      let next;
      try {
        next = await api(requestPath(s.mode, r.id), undefined, auth());
      } catch (e) {
        if (gen !== s.gen) return;
        if (e?.status === 410 && e.body?.status) { s.request = e.body; return show(); }
        // Gone, or no longer this browser's: stop asking.
        if (e?.status === 404) { s.request = { status: "GONE", error: "This recovery can’t continue from this browser. Start again." }; return show(); }
      }
      if (gen !== s.gen) return;
      if (next) {
        const changed = next.status !== r.status;
        s.request = next;
        if (changed) return show();
      }
      tick();
      follow();
    }, wait);
  };
  const tick = () => {
    const until = finalizeAfter(s.request);
    const left = el.querySelector("#r-left"), fin = el.querySelector("#r-finish");
    if (!until || !left) return;
    const ms = until.getTime() - Date.now();
    left.textContent = ms > 0 ? leftText(ms) : "finishing";
    if (fin) fin.hidden = ms > 0;
  };

  const after = (mode, request) => {
    s.mode = mode;
    s.request = request;
    if (request.recoverySecret) saveFor(localStorage, SECRET_KEY, s.email, request.recoverySecret);
    if (request.otpTicket) saveFor(localStorage, TICKET_KEY, s.email, request.otpTicket);
    s.notice = "";
    s.error = "";
    show();
  };

  /** The new owner: a passkey made on THIS phone. P-256 only, to own a Safe. */
  const makePasskey = async () => {
    const r = s.request;
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(r.registerChallenge),
        rp: { name: "Zold", id: location.hostname },
        user: { id: new TextEncoder().encode(r.userHandle), name: s.email, displayName: s.email },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        extensions: { prf: {} },
      },
    });
    return api(r.submitTo, {
      credentialId: cred.id,
      attestation: bytesToB64url(cred.response.attestationObject),
      clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
    }, auth());
  };

  const start = async (btn) => {
    const input = el.querySelector("#r-email");
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(new Error("Enter the email on your account."));
    busy(btn, true);
    try {
      if (!window.PublicKeyCredential) throw new Error("This browser can’t use Face ID or fingerprint sign-in. Open Zold in Safari or Chrome.");
      s.email = email;
      try { sessionStorage.setItem(EMAIL_KEY, email); } catch { /* resumes by typing the email again */ }
      let { mode, request } = await startRecovery(email, { api, caps, secret: secret() });
      if (request.recoverySecret) saveFor(localStorage, SECRET_KEY, email, request.recoverySecret);
      s.mode = mode;
      s.request = request;
      if (request.status === "PASSKEY_PENDING") request = await makePasskey();
      after(mode, request);
    } catch (e) {
      fail(e?.code === "RECOVERY_IN_PROGRESS"
        ? new Error("This account is already being moved from another browser. Carry on there, or write to support@zoldhq.com.")
        : e);
    } finally { busy(btn, false); }
  };

  const SCREENS = {
    email: () => `
      <h1 tabindex="-1">Get your account back</h1>
      <p>New phone? Enter the email on your Zold account. You’ll set up Face ID or fingerprint here, then confirm it’s you.</p>
      ${s.notice ? `<p class="r-note" role="status">${esc(s.notice)}</p>` : ""}
      <form id="r-start" novalidate>
        <label for="r-email">Email</label>
        <input id="r-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(s.email)}" required />
        <p class="r-err" id="r-err" role="alert" hidden></p>
        <div class="r-actions"><button type="submit" class="z-btn z-btn--primary" id="r-go">Continue</button></div>
      </form>
      <p><a href="/app">Back to sign in</a></p>`,
    passkey: () => `
      <h1 tabindex="-1">Set up this phone</h1>
      <p>Add Face ID or fingerprint sign-in on this phone. It becomes the way you approve everything on your account.</p>
      <p class="r-err" id="r-err" role="alert" hidden></p>
      <div class="r-actions"><button type="button" class="z-btn z-btn--primary" id="r-passkey">Set up Face ID</button></div>`,
    codes: () => {
      const r = s.request;
      const a = r.candide?.auths?.[currentAuth(r)];
      return `
      <h1 tabindex="-1">Enter your code</h1>
      <p>We sent a code to ${esc(a?.target || "you")}.</p>
      <form id="r-code-form" novalidate>
        <label for="r-code">Code</label>
        <input id="r-code" inputmode="numeric" autocomplete="one-time-code" />
        <p class="r-err" id="r-err" role="alert" hidden></p>
        <div class="r-actions"><button type="submit" class="z-btn z-btn--primary" id="r-confirm">Confirm</button></div>
      </form>`;
    },
    zoldenburg: () => {
      const ref = s.request.zoldenburg?.reference || "";
      const mail = `mailto:support@zoldhq.com?subject=${encodeURIComponent(`Account recovery ${ref}`)}`;
      return `
      <h1 tabindex="-1">Let’s confirm it’s you</h1>
      <p>Our team checks you against the ID you gave Monerium, then moves your account to this phone.</p>
      ${ref ? `<p class="r-ref">Your reference <b translate="no">${esc(ref)}</b></p>` : ""}
      <div class="r-actions"><a class="z-btn z-btn--primary" href="${esc(mail)}">Email support</a></div>
      <p class="r-note">Write from the email on your account and keep this page open.</p>`;
    },
    approve: () => {
      return `
      <h1 tabindex="-1">Log in to confirm it’s you</h1>
      <p>Use the Google or Apple account you set as your backup login. Your Zold account then moves to this phone.</p>
      <p class="r-err" id="r-err" role="alert"${s.error ? "" : " hidden"}>${esc(s.error)}</p>
      <div class="z-providers">${providerButtons(caps, "Continue")}</div>`;
    },
    wait: () => {
      const until = finalizeAfter(s.request);
      const ms = until ? until.getTime() - Date.now() : 0;
      return `
      <h1 tabindex="-1">Your account is on its way</h1>
      <p>It arrives on this phone in <b id="r-left">${esc(ms > 0 ? leftText(ms) : "a moment")}</b>${until ? ` (${esc(until.toLocaleString())})` : ""}. Your old phone gets a heads-up and can stop it in the meantime.</p>
      <p class="r-err" id="r-err" role="alert" hidden></p>
      <div class="r-actions" id="r-finish"${ms > 0 ? " hidden" : ""}><button type="button" class="z-btn z-btn--primary" id="r-finalize">Finish</button></div>
      <p class="r-note">You can close this page; come back any time to finish.</p>`;
    },
    done: () => `
      <h1 tabindex="-1">Welcome back</h1>
      <p>Your account is on this phone. Sign in with Face ID or fingerprint, and you’re all set.</p>
      <div class="r-actions"><a class="z-btn z-btn--primary" href="/app">Sign in</a></div>`,
  };

  const BIND = {
    email: () => el.querySelector("#r-start").addEventListener("submit", (e) => { e.preventDefault(); start(el.querySelector("#r-go")); }),
    passkey: () => el.querySelector("#r-passkey").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      busy(btn, true);
      try { after(s.mode, await makePasskey()); } catch (err) { fail(err); } finally { busy(btn, false); }
    }),
    codes: () => el.querySelector("#r-code-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = el.querySelector("#r-confirm");
      const r = s.request;
      const code = el.querySelector("#r-code").value.replace(/\s+/g, "");
      if (!code) return fail(new Error("Enter the code."));
      busy(btn, true);
      try {
        after(s.mode, await api(`/api/recovery/candide/${r.id}/otp`, { challengeId: r.candide.auths[currentAuth(r)].challengeId, otp: code }, auth()));
      } catch (err) { fail(err); } finally { busy(btn, false); }
    }),
    approve: () => el.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", async () => {
      busy(b, true);
      try {
        await startLogin(b.dataset.start, {
          stamper: new IndexedDbStamper(), storage: sessionStorage, origin: location.origin, logins: caps.turnkeyLogins,
          returnPath: "/recovery", go: (u) => location.assign(u),
        });
      } catch (err) { busy(b, false); fail(err); }
    })),
    wait: () => {
      tick();
      el.querySelector("#r-finalize")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        busy(btn, true);
        try { after(s.mode, await api(requestPath(s.mode, s.request.id, "/finalize"), {}, auth())); } catch (err) { fail(err); } finally { busy(btn, false); }
      });
    },
  };

  if (!caps.emailSmsRecovery && !caps.zoldenburgRecovery && !caps.turnkeyGuardians) {
    el.innerHTML = `<h1 tabindex="-1">Account recovery isn’t available right now</h1><p>Write to support@zoldhq.com and we’ll help.</p><p><a href="/app">Back to sign in</a></p>`;
    return;
  }
  // Back in this tab mid-recovery (a reload, or a Google/Apple login): pick
  // the request up again with this browser's secret.
  if (s.email && secret()) {
    try {
      const { mode, request } = await startRecovery(s.email, { api, caps, secret: secret() });
      // The saved request may have ended and a new one started: keep ITS secret.
      if (request.recoverySecret) saveFor(localStorage, SECRET_KEY, s.email, request.recoverySecret);
      if (request.otpTicket) saveFor(localStorage, TICKET_KEY, s.email, request.otpTicket);
      s.mode = mode;
      s.request = request;
      if (returnedHash && mode === "turnkey" && request.status === "REVIEW_PENDING") {
        const result = await finishApprove({
          hash: returnedHash, storage: sessionStorage, stamper: new IndexedDbStamper(), api,
          recovery: { requestId: request.id, secret: secret() }, turnkeyApi: caps.turnkeyApi,
          stripHash: () => history.replaceState(null, "", location.pathname),
        });
        if (result?.step === "approved") s.request = result.request;
        else if (result?.step === "error") s.error = result.reason;
      }
    } catch (e) {
      s.notice = e?.code === "RECOVERY_IN_PROGRESS" ? "This account is already being moved from another browser." : "";
    }
  }
  show();
}

if (typeof document !== "undefined") boot();
