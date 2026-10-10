/**
 * Recovery: Zoldenburg as guardian (opt-in, operator-signed) and Candide's
 * email/SMS guardian — the Profile → Recovery screen, and recovering onto a
 * new device from the sign-in page.
 */
/* ---------- Email / SMS recovery (Candide guardian) ---------- */

/* One passkey ceremony over a challenge the server prepared. Every
   recovery-side signature is one of these: the SIWE statement the Safe signs,
   the operation that adds the guardian, the cancel. */
async function passkeySignPrepared(prepared) {
  const cred = await passkeyPrompt("get", {
    challenge: b64urlToBytes(prepared.challenge),
    allowCredentials: [{ type: "public-key", id: b64urlToBytes(prepared.credentialId) }],
    userVerification: "required",
  });
  return {
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* Adding a guardian enables a recovery module on the Safe, and that has never
   run on a Safe brought in from outside (passkeySafe.importedAt). Until it
   has, an imported Safe is not offered recovery anywhere: onboarding skips
   the step and Security says so. The API does not refuse it yet; only the
   screens hold it back. */
const recoveryOfferedFor = (u = user) => !u?.passkeySafe?.importedAt;

let recoveryScreen = null;   // last GET /recovery/candide
let recoveryOtpStage = null; // { submitTo, channel, target } while a code is outstanding

/* "3 days", or the test module's minutes — read from the API, which reads the
   module; never assumed. */
function graceText(seconds) {
  if (seconds == null) return "several days";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/* The warning the user acknowledged when they skipped Zoldenburg, repeated
   wherever the account is not covered. Same words as onboarding. */
function zoldWarnHtml() {
  return `<div class="rec-warn">
    <div class="rec-warn-title"><span aria-hidden="true">⚠</span> Without a guardian, a lost passkey is a lost account</div>
    <p>If you lose access to this account or your passkey, <b>Zoldenburg UG cannot recover your account.</b></p>
    <p>Only your e-money balance (<b>EURe</b>) can be recovered — from Monerium, its issuer, under Icelandic law. Anything else held in the account cannot be recovered.</p>
  </div>`;
}

async function renderRecoveryScreen() {
  const el = $("m-rc-body");
  const row = (k, v) => `<div class="m-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  if (!caps.emailSmsRecovery && !caps.zoldenburgRecovery && !caps.turnkeyGuardians) {
    el.innerHTML = `<div class="m-rows">${row("Status", "Unavailable")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">This deployment has no recovery guardian configured, so nothing here can be promised. Nothing is set up on your account.</div>
      <div style="margin-top:16px">${zoldWarnHtml()}</div>`;
    return;
  }
  if (!user?.passkeySafe || user.passkeySafe.status !== "active") {
    el.innerHTML = `<div class="m-rows">${row("Status", "Needs your smart account")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">Recovery is a guardian on your smart account. Finish the passkey and smart-account setup first.</div>`;
    return;
  }
  if (!recoveryOfferedFor()) {
    el.innerHTML = `<div class="m-rows">${row("Status", "Not available yet")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">Recovery adds a guardian to your Safe, and Zold has not yet tested that on a Safe brought in from outside. Until it has, it isn’t offered. Your Safe’s other owner, if you kept one, can still add or replace owners in Safe{Wallet}.</div>
      <div style="margin-top:16px">${zoldWarnHtml()}</div>`;
    return;
  }
  el.innerHTML = `<div id="m-rz"></div><div id="m-rc-candide"></div><div id="m-rc-turnkey"></div><div class="m-err hidden" role="alert" id="m-rc-err" style="margin-top:12px"></div>`;
  if (caps.zoldenburgRecovery) await renderZoldenburgSection($("m-rz"));
  if (caps.turnkeyGuardians) renderTurnkeySection($("m-rc-turnkey"));
  if (caps.emailSmsRecovery) await renderCandideSection($("m-rc-candide"));
}

/** Google or Apple login as a guardian: set up on its own page (/guardian),
 *  which says plainly that recovering with it is not built yet. */
function renderTurnkeySection(el) {
  el.innerHTML = `
    <div class="m-seclabel" style="margin-top:24px">Your Google or Apple login <span class="m-tag soon">Not yet run</span></div>
    <div class="m-lede" style="font-size:13px">Make your own Google or Apple login a guardian of this account. Built, not yet run on a live deployment. Recovering with it is not built yet, so it cannot recover this account until then.</div>
    <a class="m-cta" href="/guardian" style="margin-top:12px;display:inline-flex">Set up on the guardian page</a>`;
}

let zoldScreen = null; // last GET /recovery/zoldenburg

async function renderZoldenburgSection(el) {
  const row = (k, v) => `<div class="m-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  el.innerHTML = `<div class="m-lede" style="font-size:13px">Loading…</div>`;
  try { zoldScreen = await api(`/api/users/${user.id}/recovery/zoldenburg`); }
  catch (e) { el.innerHTML = `<div class="m-err" role="alert">${esc(e.message)}</div>`; return; }
  const z = zoldScreen;
  const grace = graceText(z.gracePeriodSeconds);
  const pending = z.onChain?.pendingRecovery;
  const asked = (z.requests || []).filter((r) => r.status === "PASSKEY_PENDING" || r.status === "REVIEW_PENDING");
  const status = z.active ? "Active" : z.choice?.choice === "declined" ? `Not set up — declined ${new Date(z.choice.at).toLocaleDateString()}` : "Not set up";
  el.innerHTML = `
    ${pending ? `<div class="rec-warn" role="alert">
        <div class="rec-warn-title"><span aria-hidden="true">⚠</span> A recovery of this account is under way</div>
        <p>It takes effect after <b>${esc(new Date(pending.executeAfter * 1000).toLocaleString())}</b> and replaces your passkey with a new one. If you did not ask for it, cancel it now — afterwards it cannot be undone.</p>
      </div>
      <button class="m-cta" id="m-rc-cancel" style="margin-top:12px">Cancel this recovery with my passkey</button>` : ""}
    ${asked.map((r) => `<div class="rec-warn" role="alert" style="margin-top:${pending ? 16 : 0}px">
        <div class="rec-warn-title"><span aria-hidden="true">⚠</span> Someone asked Zoldenburg to recover this account</div>
        <p>Reference <b translate="no">${esc(r.zoldenburg?.reference || "")}</b>, ${esc(new Date(r.requestedAt).toLocaleString())}. Nothing has been signed yet. If this was not you, cancel it.</p>
      </div>
      <button class="m-cta" data-rz-cancel="${esc(r.id)}" style="margin-top:12px">It wasn't me — cancel this request</button>`).join("")}
    <div class="m-seclabel" style="margin-top:${pending || asked.length ? 24 : 0}px">Zoldenburg recovery</div>
    <div class="m-rows">
      ${row("Status", status)}
      ${row("Waiting period", grace)}
      ${z.active && z.guardianAddress ? row("Guardian", `Zoldenburg · ${z.guardianAddress.slice(0, 10)}…`) : ""}
    </div>
    ${z.active ? `
      <div class="m-lede" style="font-size:13px;margin-top:12px">If you lose your passkey, choose "Recover your account" on the sign-in page, create a new passkey there and contact Zoldenburg support with the reference it shows. We check you against the identity Monerium verified before signing. The recovery then waits ${esc(grace)}, and this passkey can cancel it until then.</div>
      <button class="m-link" id="m-rz-remove" style="margin-top:12px">Remove Zoldenburg as guardian</button>`
    : `
      <div style="margin-top:16px">${zoldWarnHtml()}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">With Zoldenburg as guardian, a lost passkey is not a lost account: contact support, we check you against the identity Monerium verified and sign a recovery to a new passkey. It waits ${esc(grace)} on chain, and while your passkey works you can cancel it. Zoldenburg can start a recovery on its own; it cannot skip the wait.</div>
      <button class="m-cta" id="m-rz-add" style="margin-top:12px">Add Zoldenburg as guardian</button>`}`;
  const add = $("m-rz-add");
  if (add) add.onclick = () => zoldenburgRun(`/api/users/${user.id}/recovery/zoldenburg`, { acknowledged: true }, add);
  const rm = $("m-rz-remove");
  if (rm) rm.onclick = () => {
    if (!confirm("Remove Zoldenburg as your recovery guardian?\n\nIf you then lose your passkey, Zoldenburg UG cannot recover your account. Only your EURe balance can be recovered, from Monerium, under Icelandic law.")) return;
    zoldenburgRun(`/api/users/${user.id}/recovery/zoldenburg/remove`, {}, rm);
  };
  const cancel = $("m-rc-cancel");
  if (cancel) cancel.onclick = recoveryCancelOnChain;
  el.querySelectorAll("[data-rz-cancel]").forEach((b) => {
    b.onclick = async () => {
      clearErr("m-rc-err");
      b.disabled = true;
      try { await api(`/api/users/${user.id}/recovery/zoldenburg/requests/${b.dataset.rzCancel}/cancel`, {}); mobileNav("recovery"); }
      catch (e) { showErr("m-rc-err", e); b.disabled = false; }
    };
  });
}

/* One passkey-signed guardian change: prepare, sign, submit, re-render. */
async function zoldenburgRun(path, body, btn) {
  clearErr("m-rc-err");
  btn.disabled = true;
  try {
    const prep = await api(path, body);
    if (prep.challenge) await api(prep.submitTo, await passkeySignPrepared(prep));
    renderUser(await api(`/api/users/${user.id}`));
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
  finally { btn.disabled = false; }
}

async function renderCandideSection(el) {
  const row = (k, v) => `<div class="m-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  el.innerHTML = `<div class="m-lede" style="font-size:13px;margin-top:24px">Loading…</div>`;
  try { recoveryScreen = await api(`/api/users/${user.id}/recovery/candide`); }
  catch (e) { el.innerHTML = `<div class="m-err" role="alert">${esc(e.message)}</div>`; return; }
  const r = recoveryScreen;
  const grace = r.gracePeriodSeconds == null ? "unknown" : r.gracePeriodSeconds < 3600 ? `${Math.round(r.gracePeriodSeconds / 60)} minutes (test module)` : `${Math.round(r.gracePeriodSeconds / 86400)} days`;
  const status = r.guardianStatus === "active" ? "Active" : r.guardianStatus === "pending_setup" ? "Guardian not on your smart account yet" : "Not set up";
  // The Zoldenburg section already shows (and cancels) a pending recovery.
  const pending = caps.zoldenburgRecovery ? null : r.onChain?.pendingRecovery;
  const channels = (r.channels || []).map((c) => `
    <div class="m-secrow">
      <span class="material-symbols-rounded" aria-hidden="true">${c.channel === "sms" ? "sms" : "mail"}</span>
      <div style="flex:1;min-width:0"><div class="t">${esc(c.target)}</div><div class="d">${c.channel === "sms" ? "SMS code" : "Email code"} · verified ${esc(new Date(c.verifiedAt).toLocaleDateString())}</div></div>
      <button class="m-link" data-rc-remove="${esc(c.registrationId)}">Remove</button>
    </div>`).join("");
  el.innerHTML = `
    ${caps.zoldenburgRecovery ? `<div class="m-seclabel" style="margin-top:28px">Email / SMS recovery</div>` : ""}
    ${pending ? `<div class="m-rows" style="border:1px solid var(--m-pink)">
      ${row("Recovery in progress", `finalizable ${esc(new Date(pending.executeAfter * 1000).toLocaleString())}`)}
      ${row("New owner", esc(String(pending.newOwners?.[0] || "").slice(0, 12)) + "…")}
    </div>
    <div class="m-lede" style="font-size:13px;margin-top:8px">Someone passed the codes on every channel and started moving this account to a new passkey. If that was not you, cancel it now — after the waiting period it cannot be undone.</div>
    <button class="m-cta" id="m-rc-cancel" style="margin-top:12px">Cancel this recovery with my passkey</button>` : ""}
    <div class="m-rows" style="margin-top:${pending ? 20 : 0}px">
      ${row("Status", status)}
      ${row("Waiting period", grace)}
      ${r.guardianAddress ? row("Guardian", `Candide · ${r.guardianAddress.slice(0, 10)}…`) : ""}
    </div>
    ${channels ? `<div class="m-seclabel" style="margin-top:20px">Channels</div><div class="m-rows">${channels}</div>` : ""}
    ${r.guardianStatus === "pending_setup" ? `
      <div class="m-lede" style="font-size:13px;margin-top:16px">Your channel is registered with Candide, but the guardian is not on your smart account yet, so no recovery can run. One passkey approval fixes that.</div>
      <button class="m-cta" id="m-rc-activate" style="margin-top:12px">Add guardian to my smart account</button>` : ""}
    <div id="m-rc-otp" class="hidden" style="margin-top:20px"></div>
    <div id="m-rc-add" style="margin-top:20px">
      <div class="m-seclabel">Add a channel</div>
      <div class="m-field"><label>Email or phone (+49…)</label><input id="m-rc-target" autocomplete="off" placeholder="name@example.com or +4915112345678"></div>
      <button class="m-cta" id="m-rc-addbtn" style="margin-top:12px">Register with my passkey</button>
    </div>
    <div class="m-lede" style="font-size:12px;margin-top:20px;color:var(--m-dim)">
      Candide holds the guardian key and signs a recovery only after a code is confirmed on EVERY channel here.
      Adding or removing a channel is a message your smart account signs with your passkey. The waiting period is enforced on chain, not by Zold.
    </div>`;
  const act = $("m-rc-activate");
  if (act) act.onclick = recoveryActivateGuardian;
  const cancel = $("m-rc-cancel");
  if (cancel) cancel.onclick = recoveryCancelOnChain;
  $("m-rc-addbtn").onclick = () => recoveryAddChannel($("m-rc-target").value);
  el.querySelectorAll("[data-rc-remove]").forEach((b) => { b.onclick = () => recoveryRemoveChannel(b.dataset.rcRemove); });
  if (recoveryOtpStage) renderRecoveryOtp();
}

function renderRecoveryOtp() {
  const box = $("m-rc-otp");
  if (!box || !recoveryOtpStage) return;
  box.classList.remove("hidden");
  $("m-rc-add").classList.add("hidden");
  box.innerHTML = `
    <div class="m-seclabel">Confirm ${recoveryOtpStage.channel === "sms" ? "your phone" : "your email"}</div>
    <div class="m-lede" style="font-size:13px">A code was sent to ${esc(recoveryOtpStage.target)}.</div>
    <div class="m-field" style="margin-top:12px"><label>Code</label><input id="m-rc-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>
    <button class="m-cta" id="m-rc-codebtn" style="margin-top:12px">Confirm</button>
    <button class="m-link" id="m-rc-codecancel" style="margin-top:8px">Start over</button>`;
  $("m-rc-codebtn").onclick = async () => {
    clearErr("m-rc-err");
    const btn = $("m-rc-codebtn");
    btn.disabled = true;
    try {
      const r = await api(recoveryOtpStage.submitTo, { otp: $("m-rc-code").value });
      recoveryOtpStage = null;
      user = { ...user, ...r, recovery: undefined };
      renderUser(await api(`/api/users/${user.id}`));
      mobileNav("recovery");
      if (r.next === "guardian") await recoveryActivateGuardian();
    } catch (e) { showErr("m-rc-err", e); }
    finally { btn.disabled = false; }
  };
  $("m-rc-codecancel").onclick = () => { recoveryOtpStage = null; mobileNav("recovery"); };
}

async function recoveryAddChannel(raw) {
  clearErr("m-rc-err");
  const target = String(raw || "").trim();
  const channel = target.includes("@") ? "email" : "sms";
  const btn = $("m-rc-addbtn");
  btn.disabled = true;
  try {
    const prep = await api(`/api/users/${user.id}/recovery/candide/channels`, { channel, target });
    const sig = await passkeySignPrepared(prep);
    const sent = await api(prep.submitTo, sig);
    recoveryOtpStage = { submitTo: sent.submitTo, channel: sent.channel, target: sent.target };
    renderRecoveryOtp();
  } catch (e) { showErr("m-rc-err", e); }
  finally { btn.disabled = false; }
}

async function recoveryActivateGuardian() {
  clearErr("m-rc-err");
  // Absent when reached straight from a confirmed code rather than a click.
  const btn = $("m-rc-activate");
  if (btn) btn.disabled = true;
  try {
    const prep = await api(`/api/users/${user.id}/recovery/candide/guardian`, {});
    if (prep.challenge) {
      const sig = await passkeySignPrepared(prep);
      await api(prep.submitTo, sig);
    }
    renderUser(await api(`/api/users/${user.id}`));
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
  finally { if (btn) btn.disabled = false; }
}

async function recoveryRemoveChannel(registrationId) {
  clearErr("m-rc-err");
  if (!confirm("Remove this recovery channel? Codes will no longer be sent to it.")) return;
  try {
    const prep = await api(`/api/users/${user.id}/recovery/candide/channels/${registrationId}`, undefined, "DELETE");
    const sig = await passkeySignPrepared(prep);
    await api(prep.submitTo, sig);
    renderUser(await api(`/api/users/${user.id}`));
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
}

/* Cancel the recovery under way on chain: one passkey signature from this
   (the old) device. Also used by the Recovery-Alert screen in app/phone.js. */
async function recoveryCancelRun() {
  const prep = await api(`/api/users/${user.id}/recovery/candide/cancel`, {});
  const sig = await passkeySignPrepared(prep);
  await api(prep.submitTo, sig);
}

async function recoveryCancelOnChain() {
  clearErr("m-rc-err");
  if (!confirm("Cancel the recovery in progress? The new passkey will not take over this account.")) return;
  const btn = $("m-rc-cancel");
  if (btn) btn.disabled = true;
  try {
    await recoveryCancelRun();
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- lost device: recover from the onboarding page ---------- */
let rcState = null;
let rcEmail = "";
/* Which guardian this recovery goes through: "candide" (email/SMS codes) or
   "zoldenburg" (support checks the person, an operator signs). */
let rcMode = "candide";
/* The per-request secret the API hands out once when a recovery starts. It is
   what lets THIS browser drive the request (the id alone is not enough), so it
   is kept per email to survive a reload mid-recovery. */
let rcSecret = "";
const RC_SECRET_KEY = "zold-recovery-secret";
function rcSaved(email) {
  try { return JSON.parse(localStorage.getItem(RC_SECRET_KEY) || "{}")[email.toLowerCase()] || ""; } catch { return ""; }
}
function rcSave(email, secret) {
  try {
    const all = JSON.parse(localStorage.getItem(RC_SECRET_KEY) || "{}");
    if (secret) all[email.toLowerCase()] = secret; else delete all[email.toLowerCase()];
    localStorage.setItem(RC_SECRET_KEY, JSON.stringify(all));
  } catch { /* private mode: the recovery still works in this tab */ }
}
const rcApi = (path, body, method) => api(path, body, method, {
  ...(rcSecret ? { "x-recovery-secret": rcSecret } : {}),
  ...(rcOtpTicket ? { "x-recovery-otp-ticket": rcOtpTicket } : {}),
});
/* Handed out when THIS browser registers the new passkey. The codes the owner
   receives confirm that credential, so without the ticket the code form is not
   shown: an open ceremony whose passkey was made elsewhere is not ours. */
let rcOtpTicket = "";
const RC_TICKET_KEY = "zold-recovery-otp-ticket";
function rcTicketSaved(email) {
  try { return JSON.parse(localStorage.getItem(RC_TICKET_KEY) || "{}")[email.toLowerCase()] || ""; } catch { return ""; }
}
function rcTicketSave(email, ticket) {
  try {
    const all = JSON.parse(localStorage.getItem(RC_TICKET_KEY) || "{}");
    if (ticket) all[email.toLowerCase()] = ticket; else delete all[email.toLowerCase()];
    localStorage.setItem(RC_TICKET_KEY, JSON.stringify(all));
  } catch { /* private mode: the recovery still works in this tab */ }
}
/* The recovery screens themselves are OB entries in app/onboarding.js
   (#recover, #recover/codes, #recover/wait, #recover/zoldenburg,
   #recover/done). This half holds the state they draw from and the calls
   that move it; each call ends in rcShow(), which opens the screen the
   request's state names. */

/* Why the email step is showing again, when a recovery ended or failed. */
let rcNotice = "";
let rcTimer = null;

/* Statuses of a Zoldenburg request before the chain has it: support checks
   the person, then an operator signs from a hardware wallet. */
const RC_ZOLD_REVIEW = ["KYC_PENDING", "REVIEW_PENDING"];
const RC_ZOLD_SIGNING = ["DELAYING", "READY_FOR_GUARDIAN", "GUARDIAN_SUBMITTED"];

/** The screen a request's state belongs on. */
function rcRouteFor(r) {
  if (!r) return "recover";
  if (r.status === "OTP_PENDING") return "recover/codes";
  if (r.status === "GRACE_PERIOD") return "recover/wait";
  if (r.status === "FINALIZED") return "recover/done";
  if (rcMode === "zoldenburg" && [...RC_ZOLD_REVIEW, ...RC_ZOLD_SIGNING].includes(r.status)) return "recover/zoldenburg";
  return "recover";
}

/* One sentence for a request that cannot go on, shown on the email step. */
function rcEndedText(r) {
  if (r.status === "CANCELED") return "This recovery was cancelled, most likely from your old phone. Start again only if you still need to.";
  if (r.status === "EXPIRED") return "This recovery expired before it finished. Start again.";
  if (r.status === "PASSKEY_PENDING") return "Face ID or fingerprint sign-in wasn’t set up on this phone. Try again.";
  return r.error || r.cancelReason || "This recovery can’t continue. Start again.";
}

/** When the waiting period ends, from whichever guardian ran it. */
function rcFinalizeAfter(r) {
  const iso = r?.candide?.finalizeAfter || r?.zoldenburg?.finalizeAfter;
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/* "2d 21h", "5h 12m", "12m". Under a minute is "Less than a minute". */
function rcLeftText(ms) {
  if (ms <= 60000) return "Less than a minute";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/* "Thu 2 Oct at 14:05", in the phone's own time zone. */
function rcWhenText(d) {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}

/** Open the screen the current state names, and keep following it. */
function rcShow() {
  clearTimeout(rcTimer);
  const r = rcState;
  const name = rcRouteFor(r);
  if (name === "recover" && r) {
    rcNotice = rcEndedText(r);
    rcState = null;
  }
  if (name === "recover/done") {
    rcSave(rcEmail, "");
    rcTicketSave(rcEmail, "");
  }
  // Moving between the later steps replaces history: back from the waiting
  // period is the email step, not a code form that no longer applies.
  obGo(name, { replace: obScreen !== "recover" || name === "recover" });
  if (name === "recover/wait" || name === "recover/zoldenburg") rcFollow();
}

/* Re-read the request while it waits: every minute, or just after the
   waiting period ends. The countdown on screen is redrawn in place. */
function rcFollow() {
  clearTimeout(rcTimer);
  const r = rcState;
  if (!r) return;
  const until = rcFinalizeAfter(r);
  const wait = until ? Math.min(60000, Math.max(2000, until.getTime() - Date.now() + 1000)) : 60000;
  rcTimer = setTimeout(async () => {
    if (!obScreen?.startsWith("recover/") || rcState?.id !== r.id) return;
    try {
      const next = await rcApi(`/api/recovery/${rcMode}/${r.id}`);
      if (rcState?.id !== r.id) return;
      rcState = next;
      if (rcRouteFor(next) !== obScreen || (next.status !== r.status)) return rcShow();
    } catch (e) {
      // 410: the request expired while this phone waited. The body is the
      // request, now EXPIRED, so the email step can say so.
      if (e?.status === 410 && e.body?.status) { rcState = e.body; return rcShow(); }
      /* anything else: keep the screen; the next tick tries again */
    }
    rcTick();
    rcFollow();
  }, wait);
}

/* Redraw the countdown on the waiting screen without re-rendering it. */
function rcTick() {
  const until = rcFinalizeAfter(rcState);
  const left = $("rc-left"), bar = $("rc-bar"), fin = $("rc-finish-wrap");
  if (!until || !left) return;
  const ms = until.getTime() - Date.now();
  left.textContent = ms > 0 ? rcLeftText(ms) : "Finishing…";
  if (bar) bar.style.transform = `scaleX(${rcElapsed(rcState)})`;
  if (fin) fin.hidden = ms > 0;
}

/* How much of the waiting period has passed, 0 to 1. */
function rcElapsed(r) {
  const until = rcFinalizeAfter(r);
  const total = (r?.recoveryDelayHours || 0) * 3600000;
  if (!until || !total) return 0;
  return Math.min(1, Math.max(0, 1 - (until.getTime() - Date.now()) / total));
}

/** Email step: start (or resume) a recovery, then set up Face ID on this phone. */
async function recoverStart(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr("rc-err");
  const input = $("rc-email");
  rcEmail = input.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rcEmail)) {
    Z.setFieldError(input, "Enter the email on your account.");
    return Z.focusFirstError(input.form);
  }
  Z.setFieldError(input, "");
  Z.setLoading(btn, true);
  try {
    if (!window.PublicKeyCredential) throw new Error("This browser can’t use Face ID or fingerprint sign-in. Open Zold in Safari or Chrome.");
    rcSecret = rcSaved(rcEmail);
    rcOtpTicket = rcTicketSaved(rcEmail);
    // Email/SMS first where the deployment has it; an account without it
    // (404) falls through to Zoldenburg when that guardian is offered.
    const body = { email: rcEmail, ...(rcSecret ? { recoverySecret: rcSecret } : {}) };
    let r = null;
    if (caps.emailSmsRecovery) {
      try { r = await api("/api/recovery/candide", body); rcMode = "candide"; }
      catch (e) { if (!(e?.status === 404 && caps.zoldenburgRecovery)) throw e; }
    }
    if (!r) { r = await api("/api/recovery/zoldenburg", body); rcMode = "zoldenburg"; }
    if (r.recoverySecret) { rcSecret = r.recoverySecret; rcSave(rcEmail, rcSecret); }
    if (r.status === "PASSKEY_PENDING") {
      // The new owner: a passkey made on THIS device. P-256 only — it has to
      // be able to own a Safe.
      const cred = await passkeyPrompt("create", {
        challenge: b64urlToBytes(r.registerChallenge),
        rp: { name: "Zold", id: location.hostname },
        user: { id: new TextEncoder().encode(r.userHandle), name: rcEmail, displayName: r.displayName || rcEmail },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        extensions: { prf: {} },
      });
      r = await rcApi(r.submitTo, {
        credentialId: cred.id,
        attestation: b64url(cred.response.attestationObject),
        clientDataJSON: b64url(cred.response.clientDataJSON),
      });
      if (r.otpTicket) { rcOtpTicket = r.otpTicket; rcTicketSave(rcEmail, rcOtpTicket); }
    }
    rcNotice = "";
    rcState = r;
    rcShow();
  } catch (e) {
    obShowErr(e?.name === "NotAllowedError"
      ? new Error("Face ID or fingerprint setup was cancelled. Try again when you’re ready.")
      // Only the browser that started a recovery may continue it.
      : e?.code === "RECOVERY_IN_PROGRESS"
        ? new Error("A recovery of this account is already under way in another browser. Continue it there, or email support@zoldhq.com.")
        : e, "rc-err");
  } finally { if (btn.isConnected) Z.setLoading(btn, false); }
}

/* The channel whose code is asked for now: the first one not confirmed. */
const rcCurrentAuth = (r = rcState) => (r?.candide?.auths || []).findIndex((a) => !a.verified);

/** Code step: confirm the code for the current channel. */
async function recoverConfirmCode(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr("rc-err");
  const r = rcState;
  const i = rcCurrentAuth(r);
  const input = $("rc-code");
  const code = input.value.replace(/\s+/g, "");
  if (i < 0) return rcShow();
  if (!code) {
    Z.setFieldError(input, "Enter the code.");
    return Z.focusFirstError(input.form);
  }
  Z.setFieldError(input, "");
  Z.setLoading(btn, true);
  try {
    rcState = await rcApi(`/api/recovery/candide/${r.id}/otp`, { challengeId: r.candide.auths[i].challengeId, otp: code });
    if (rcRouteFor(rcState) === "recover/codes") {
      obRender({ focus: false });
      const next = rcState.candide.auths[rcCurrentAuth()];
      Z.announce(`Confirmed. Now the code for ${next?.channel === "sms" ? "your phone" : "your email"}.`);
      $("rc-code")?.focus();
      return;
    }
    rcShow();
  } catch (e) {
    if (e?.status === 403) {
      // The ticket is gone: this browser did not make the new sign-in.
      rcOtpTicket = ""; rcTicketSave(rcEmail, "");
      return obRender({ focus: true });
    }
    Z.setFieldError(input, obMessage(e));
    input.focus();
  } finally { if (btn.isConnected) Z.setLoading(btn, false); }
}

/** Waiting step, once the period is over: finish now rather than wait for Zold's sweep. */
async function recoverFinalize(btn) {
  if (Z.isDisabled(btn)) return;
  obClearErr("rc-err");
  Z.setLoading(btn, true);
  try {
    // No session comes back: once finalized, the new passkey signs in
    // through the ordinary login, which the done screen offers.
    rcState = await rcApi(`/api/recovery/${rcMode}/${rcState.id}/finalize`, {});
    rcShow();
  } catch (e) { obShowErr(e, "rc-err"); }
  finally { if (btn.isConnected) Z.setLoading(btn, false); }
}
