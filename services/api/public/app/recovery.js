/**
 * Email / SMS recovery through Candide's guardian: enrolling from Profile, and
 * recovering onto a new device from the onboarding page.
 */
/* ---------- Email / SMS recovery (Candide guardian) ---------- */

/* One passkey ceremony over a challenge the server prepared. Every
   recovery-side signature is one of these: the SIWE statement the Safe signs,
   the operation that adds the guardian, the cancel. */
async function passkeySignPrepared(prepared) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(prepared.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(prepared.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

let recoveryScreen = null;   // last GET /recovery/candide
let recoveryOtpStage = null; // { submitTo, channel, target } while a code is outstanding

async function renderRecoveryScreen() {
  const el = $("m-rc-body");
  const row = (k, v) => `<div class="m-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  if (!caps.emailSmsRecovery) {
    el.innerHTML = `<div class="m-rows">${row("Status", "Unavailable")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">This deployment has no recovery service configured, so nothing here can be promised. Nothing is set up on your account.</div>`;
    return;
  }
  if (!user?.passkeySafe || user.passkeySafe.status !== "active") {
    el.innerHTML = `<div class="m-rows">${row("Status", "Needs your smart account")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">Recovery is a guardian on your smart account. Finish the passkey and smart-account setup first.</div>`;
    return;
  }
  el.innerHTML = `<div class="m-lede" style="font-size:13px">Loading…</div>`;
  try { recoveryScreen = await api(`/api/users/${user.id}/recovery/candide`); }
  catch (e) { el.innerHTML = `<div class="m-err">${esc(e.message)}</div>`; return; }
  const r = recoveryScreen;
  const grace = r.gracePeriodSeconds == null ? "unknown" : r.gracePeriodSeconds < 3600 ? `${Math.round(r.gracePeriodSeconds / 60)} minutes (test module)` : `${Math.round(r.gracePeriodSeconds / 86400)} days`;
  const status = r.guardianStatus === "active" ? "Active" : r.guardianStatus === "pending_setup" ? "Guardian not on your smart account yet" : "Not set up";
  const pending = r.onChain?.pendingRecovery;
  const channels = (r.channels || []).map((c) => `
    <div class="m-secrow">
      <span class="material-symbols-rounded">${c.channel === "sms" ? "sms" : "mail"}</span>
      <div style="flex:1;min-width:0"><div class="t">${esc(c.target)}</div><div class="d">${c.channel === "sms" ? "SMS code" : "Email code"} · verified ${esc(new Date(c.verifiedAt).toLocaleDateString())}</div></div>
      <button class="m-link" data-rc-remove="${esc(c.registrationId)}">Remove</button>
    </div>`).join("");
  el.innerHTML = `
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
    <div class="m-err hidden" id="m-rc-err" style="margin-top:12px"></div>
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
    try {
      const r = await api(recoveryOtpStage.submitTo, { otp: $("m-rc-code").value });
      recoveryOtpStage = null;
      user = { ...user, ...r, recovery: undefined };
      renderUser(await api(`/api/users/${user.id}`));
      mobileNav("recovery");
      if (r.next === "guardian") await recoveryActivateGuardian();
    } catch (e) { showErr("m-rc-err", e); }
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
  try {
    const prep = await api(`/api/users/${user.id}/recovery/candide/guardian`, {});
    if (prep.challenge) {
      const sig = await passkeySignPrepared(prep);
      await api(prep.submitTo, sig);
    }
    renderUser(await api(`/api/users/${user.id}`));
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
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

async function recoveryCancelOnChain() {
  clearErr("m-rc-err");
  if (!confirm("Cancel the recovery in progress? The new passkey will not take over this account.")) return;
  try {
    const prep = await api(`/api/users/${user.id}/recovery/candide/cancel`, {});
    const sig = await passkeySignPrepared(prep);
    await api(prep.submitTo, sig);
    mobileNav("recovery");
  } catch (e) { showErr("m-rc-err", e); }
}

/* ---------- lost device: recover from the onboarding page ---------- */
let rcState = null;
let rcEmail = "";

function showRecoverPanel(on) {
  $("onb-step1").classList.toggle("hidden", on);
  $("onb-recover").classList.toggle("hidden", !on);
  clearErr("rc-err");
}

function renderRecoverState() {
  const r = rcState;
  const otp = $("rc-otp");
  const st = $("rc-status");
  $("rc-start").classList.toggle("hidden", !!r);
  otp.classList.add("hidden");
  st.classList.add("hidden");
  if (!r) return;
  if (r.status === "OTP_PENDING") {
    const auths = (r.candide?.auths || []);
    otp.classList.remove("hidden");
    otp.innerHTML = auths.map((a, i) => `
      <label>${a.channel === "sms" ? "Code sent by SMS to" : "Code emailed to"} ${esc(a.target)}${a.verified ? " · confirmed" : ""}</label>
      <div class="onb-addrow">
        <input id="rc-code-${i}" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" ${a.verified ? "disabled" : ""} />
        <button type="button" data-rc-confirm="${i}" ${a.verified ? "disabled" : ""}>Confirm</button>
      </div>`).join("") +
      `<div class="sub" style="margin-top:12px">Every channel must confirm before anything happens. Once they all have, Candide signs the recovery and the waiting period starts on chain.</div>`;
    otp.querySelectorAll("[data-rc-confirm]").forEach((b) => {
      b.onclick = async () => {
        clearErr("rc-err");
        const i = Number(b.dataset.rcConfirm);
        try {
          rcState = await api(`/api/recovery/candide/${r.id}/otp`, { challengeId: auths[i].challengeId, otp: $(`rc-code-${i}`).value });
          renderRecoverState();
        } catch (e) { showErr("rc-err", e); }
      };
    });
    return;
  }
  st.classList.remove("hidden");
  if (r.status === "GRACE_PERIOD") {
    const until = r.candide?.finalizeAfter ? new Date(r.candide.finalizeAfter) : null;
    const ready = until && Date.now() >= until.getTime();
    st.innerHTML = `<label>Recovery is under way</label>
      <div class="sub">The account moves to the passkey you just created ${until ? `after ${esc(until.toLocaleString())}` : "after the waiting period"}. Until then the old device can still cancel it — that delay is the protection, so it cannot be skipped.</div>
      <button class="btn-primary-lite" id="btn-rc-finalize" ${ready ? "" : "disabled"}>${ready ? "Finish recovery" : "Waiting…"}</button>
      <div class="sub" style="margin-top:8px">You can close this page. Zold finishes the recovery for you once the period has passed; come back and sign in with your new passkey.</div>`;
    $("btn-rc-finalize").onclick = async () => {
      clearErr("rc-err");
      try {
        const done = await api(`/api/recovery/candide/${r.id}/finalize`, {});
        rcState = done;
        if (done.account) { renderUser(done.account); showRecoverPanel(false); enterDashboard(done.account.name); return; }
        renderRecoverState();
      } catch (e) { showErr("rc-err", e); }
    };
    if (!ready && until) setTimeout(async () => {
      try { rcState = await api(`/api/recovery/candide/${r.id}`); renderRecoverState(); } catch { /* keep the screen */ }
    }, Math.min(60000, Math.max(2000, until.getTime() - Date.now() + 1000)));
    return;
  }
  if (r.status === "FINALIZED") {
    st.innerHTML = `<label>Recovered</label><div class="sub">This device's passkey now owns the account. Sign in with it.</div>
      <button class="btn-primary-lite" id="btn-rc-signin">Sign in with your new passkey</button>`;
    $("btn-rc-signin").onclick = () => { showRecoverPanel(false); $("link-signin").click(); };
    return;
  }
  st.innerHTML = `<label>${esc(r.status.replaceAll("_", " ").toLowerCase())}</label><div class="sub">${esc(r.error || r.cancelReason || "This recovery cannot continue. Start again.")}</div>`;
}

async function recoverStart() {
  clearErr("rc-err");
  rcEmail = $("rc-email").value.trim();
  const btn = $("btn-rc-start");
  btn.disabled = true;
  try {
    if (!window.PublicKeyCredential) throw new Error("passkeys aren't supported in this browser");
    let r = await api("/api/recovery/candide", { email: rcEmail });
    if (r.status === "PASSKEY_PENDING") {
      // The new owner: a passkey made on THIS device. P-256 only — it has to
      // be able to own a Safe.
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: b64urlToBytes(r.registerChallenge),
          rp: { name: "Zold", id: location.hostname },
          user: { id: new TextEncoder().encode(r.userHandle), name: rcEmail, displayName: r.displayName || rcEmail },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          timeout: 60000,
          extensions: { prf: {} },
        },
      });
      r = await api(r.submitTo, {
        credentialId: cred.id,
        attestation: b64url(cred.response.attestationObject),
        clientDataJSON: b64url(cred.response.clientDataJSON),
      });
    }
    rcState = r;
    renderRecoverState();
  } catch (e) { showErr("rc-err", e); }
  finally { btn.disabled = false; }
}
