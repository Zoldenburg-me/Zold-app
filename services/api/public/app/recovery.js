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
  el.innerHTML = `<div id="m-rc-guardian"></div><div id="m-rc-candide"></div><div class="m-err hidden" role="alert" id="m-rc-err" style="margin-top:12px"></div>`;
  if (caps.zoldenburgRecovery || caps.turnkeyGuardians) renderGuardianSection($("m-rc-guardian"));
  if (caps.emailSmsRecovery) await renderCandideSection($("m-rc-candide"));
}

/** Who can move the account to a new phone. Chosen and changed on /guardian
 *  (Zoldenburg, or the person's own Google or Apple login). */
function renderGuardianSection(el) {
  const safe = user.passkeySafe || {};
  const zold = safe.recovery?.status === "active";
  const social = (safe.socialGuardians || []).some((g) => g.status === "active");
  const who = zold ? "Zoldenburg" : social ? "Your Google or Apple login" : "";
  el.innerHTML = `
    <div class="m-seclabel">Your guardian</div>
    <div class="m-lede" style="font-size:13px">${who
      ? `${esc(who)} can move your account to a new phone if you lose this one.`
      : "Lose your phone, keep your account: choose Zoldenburg or your own Google or Apple login to help you move Zold to a new phone."}</div>
    <a class="m-cta" href="/guardian" style="margin-top:12px;display:inline-flex">${who ? "Manage your guardian" : "Choose your guardian"}</a>`;
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

/* ---------- times the recovery alert shows ---------- */
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
