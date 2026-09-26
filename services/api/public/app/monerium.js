/**
 * Connecting a Monerium account with your OWN API keys, plus the mobile
 * screens' event wiring.
 */
/* ---------- Monerium: your own API keys ---------- */
function renderMoneriumScreen() {
  const el = $("m-mon-body");
  const u = user || {};
  const m = u.monerium;
  const keys = m?.method === "api_keys" ? m.apiKeys : null;
  const env = caps.moneriumEnvironment || "sandbox";
  const portal = env === "production" ? "monerium.app" : env === "sandbox" ? "monerium.dev" : caps.moneriumHost;
  $("m-mon-lede").textContent =
    `Connect the API keys of your own Monerium account. This deployment talks to Monerium ${env} (${caps.moneriumHost}), so the keys must come from an app created at ${portal} — keys from the other environment are refused as a wrong secret.`;
  const row = (k, v) => `<div class="m-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  const when = (iso) => { const d = new Date(iso || ""); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); };

  if (!caps.moneriumApiKeys) {
    el.innerHTML = `
      <div class="m-rows">${row("Status", "Unavailable")}</div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">This deployment has no MONERIUM_TOKEN_ENCRYPTION_KEY, so it cannot store a client secret. It refuses rather than keep one in plaintext.</div>`;
    return;
  }

  if (keys) {
    const funding = u.funding || {};
    const needsIban = kycApproved(u) && !u.iban && funding.mode === "sandbox";
    el.innerHTML = `
      <div class="m-rows">
        ${row("Status", "Connected")}
        ${row("Client id", keys.clientId)}
        ${keys.label ? row("Label", keys.label) : ""}
        ${keys.accountEmail ? row("Monerium account", keys.accountEmail) : ""}
        ${row("Environment", `${keys.environment} · ${keys.host}`)}
        ${row("Verified", when(keys.verifiedAt))}
        ${m.profileId ? row("Profile", m.profileId) : ""}
        ${row("IBAN", u.iban || "Not issued yet")}
      </div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">${esc(funding.detail || "Deposits to this account and SEPA payouts from it run on these keys.")}</div>
      ${needsIban ? `<button class="m-cta" id="m-mon-activate" style="margin-top:16px">Activate IBAN with passkey</button>` : ""}
      <button class="m-link" id="m-mon-refresh" style="margin-top:12px">Refresh accounts</button>
      <button class="m-link" id="m-mon-remove" style="margin-top:12px">Remove keys</button>
      <div class="m-err hidden" id="m-mon-err" style="margin-top:12px"></div>
      <div class="m-lede" style="font-size:12px;margin-top:20px;color:var(--m-dim)">
        The secret was checked against Monerium once and stored encrypted. It is never shown again, not even to you —
        to rotate it, remove the keys and connect the new pair.
      </div>`;
    const act = $("m-mon-activate");
    if (act) act.onclick = async () => {
      clearErr("m-mon-err");
      try { await issueAppIban(); mobileNav("monerium"); } catch (e) { showErr("m-mon-err", e); }
    };
    $("m-mon-refresh").onclick = async () => {
      clearErr("m-mon-err");
      try {
        const accounts = await api(`/api/users/${user.id}/monerium/accounts`);
        user = { ...user, monerium: { ...(user.monerium || {}), ...accounts } };
        renderUser(await api(`/api/users/${user.id}`));
        mobileNav("monerium");
      } catch (e) { showErr("m-mon-err", e); }
    };
    $("m-mon-remove").onclick = async () => {
      clearErr("m-mon-err");
      if (!confirm("Remove the Monerium keys from this account? Deposits and payouts on it pause until keys are connected again.")) return;
      try {
        renderUser(await api(`/api/users/${user.id}/monerium/api-keys`, undefined, "DELETE"));
        mobileNav("monerium");
      } catch (e) { showErr("m-mon-err", e); }
    };
    return;
  }

  el.innerHTML = `
    <div class="m-field"><label>Client id</label><input id="m-mon-id" autocomplete="off" spellcheck="false" placeholder="from your Monerium app"></div>
    <div class="m-field" style="margin-top:12px"><label>Client secret</label><input id="m-mon-secret" type="password" autocomplete="off" placeholder="shown once when the app was created"></div>
    <div class="m-field" style="margin-top:12px"><label>Label (optional)</label><input id="m-mon-label" placeholder="e.g. my sandbox app"></div>
    <button class="m-cta" id="m-mon-connect" style="margin-top:16px">Verify and connect</button>
    <div class="m-err hidden" id="m-mon-err" style="margin-top:12px"></div>
    <div class="m-lede" style="font-size:12px;margin-top:20px;color:var(--m-dim)">
      Zold verifies the pair against Monerium before storing anything, encrypts the secret at rest and never returns it.
      Your Monerium account, its profile and its IBANs stay yours; Zold links its smart account under that profile and asks
      Monerium for an IBAN bound to it. Deposits and SEPA payouts on this account then run on your keys.
      ${m?.method === "oauth" ? "This account is connected by OAuth today; connecting keys replaces that connection." : ""}
    </div>`;
  $("m-mon-connect").onclick = connectMoneriumKeys;
}

async function connectMoneriumKeys() {
  clearErr("m-mon-err");
  const btn = $("m-mon-connect");
  btn.disabled = true;
  btn.textContent = "Checking with Monerium…";
  try {
    const updated = await api(`/api/users/${user.id}/monerium/api-keys`, {
      clientId: $("m-mon-id").value,
      clientSecret: $("m-mon-secret").value,
      label: $("m-mon-label").value,
    });
    $("m-mon-secret").value = "";
    renderUser(updated);
    mobileNav("monerium");
  } catch (e) {
    showErr("m-mon-err", e);
    btn.disabled = false;
    btn.textContent = "Verify and connect";
  }
}

document.querySelectorAll("#m-filters button").forEach((b) => {
  b.onclick = () => { mFilter = b.dataset.mfilter; renderActivityScreen(); };
});
$("m-pf-plus").onclick = () => mobileNav("plus");
$("m-pf-monerium").onclick = () => mobileNav("monerium");
$("m-pf-signout").onclick = () => $("btn-signout").click();

document.querySelectorAll("[data-mpreset]").forEach((b) => {
  b.onclick = () => { $("m-amount").value = b.dataset.mpreset; requestQuote(); };
});
$("m-amount").oninput = () => { clearTimeout(mQuoteTimer); mQuoteTimer = setTimeout(requestQuote, 450); };
$("m-amount-next").onclick = () => mSend.quote && toRecipient();
$("m-rec-send").onclick = submitMobileSend;
$("m-prog-done").onclick = () => { mSend = { dest: null, quote: null, rec: {}, transfer: null, prefill: null }; mobileNav("home"); };
$("m-country-q").oninput = (e) => renderCountryList(e.target.value);
$("m-pay-q").oninput = renderPayMatches;

document.querySelectorAll("[data-mback]").forEach((b) => {
  b.onclick = () => mobileNav(b.dataset.mback || "home");
});
$("m-go-bundle").onclick = () => mobileNav("bundle");
$("m-go-bank").onclick = () => mobileNav("bank");
$("m-go-crypto").onclick = () => mobileNav("crypto");
$("m-copy-wallet").onclick = async () => {
  if (!user?.address) return;
  try { await navigator.clipboard.writeText(user.address); } catch { return; }
  const b = $("m-copy-wallet");
  b.textContent = "Copied";
  setTimeout(() => { b.textContent = "Copy address"; }, 1400);
};

document.querySelectorAll("#m-nav button").forEach((b) => {
  b.onclick = () => mobileNav(b.dataset.mnav);
});
$("m-send").onclick = () => mobileNav("send");
$("m-add").onclick = () => mobileNav("add");
$("m-activity").onclick = () => mobileNav("activity");
$("m-bell").onclick = () => mobileNav("activity");
$("m-seeall").onclick = () => mobileNav("activity");
$("m-plus").onclick = () => mobileNav("plus");
$("m-payment-page").onclick = () => mobileNav("payment");
$("m-card-tile").onclick = () => mobileNav("card");
$("m-back").onclick = () => mobileNav("home");
$("m-kyc-banner").onclick = () => enterKycReview(user?.name || "Account");

$("m-iban-banner").onclick = async () => {
  const banner = $("m-iban-banner");
  const title = $("m-iban-banner-title");
  const err = $("m-iban-err");
  err.classList.add("hidden");
  banner.disabled = true;
  const prev = title.textContent;
  title.textContent = "Approve with your passkey…";
  try {
    await finishPasskeySafeSetup();
    await issueAppIban();
    renderUser(user);
  } catch (e) {
    title.textContent = prev;
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  } finally {
    banner.disabled = false;
  }
};

/* Copy the Safe address. The icon confirms for 1.4s, per the handoff. */
$("m-addr").onclick = async () => {
  if (!user?.address) return;
  try { await navigator.clipboard.writeText(user.address); } catch { return; }
  const icon = $("m-addr-icon");
  icon.textContent = "check";
  setTimeout(() => { icon.textContent = "content_copy"; }, 1400);
};

/* USD accounts: no waitlist exists, so there is no "notify me" button — the
   notice says so and can only be dismissed. */
$("m-usd-x").onclick = () => $("m-usd").classList.add("hidden");

/**
 * What this deployment lets the browser do. Defaults are the SAFE ones: with
 * no answer from /api/health every optional rail reads as closed, so a failed
 * probe hides a control the server might refuse rather than offering one it
 * will.
 */
let caps = { sandbox: true, moneriumOAuth: false, moneriumApiKeys: false, moneriumEnvironment: "production", moneriumHost: "api.monerium.app", emailSmsRecovery: false };

async function loadCapabilities() {
  try {
    const h = await (await fetch("/api/health")).json();
    if (h?.capabilities) caps = { ...caps, ...h.capabilities };
  } catch {
    /* keep the safe defaults */
  }
  $("recover-link-row").classList.toggle("hidden", !caps.emailSmsRecovery);
  renderFundCard();
}

/** How money actually arrives: a real SEPA transfer to the Monerium IBAN. */
function renderFundCard() {
  const hint = $("fund-real-hint");
  if (!hint) return;
  hint.textContent = user?.iban
    ? "Transfer euros to the IBAN above from any bank. They arrive as balance here once Monerium has minted them to your wallet."
    : "Your IBAN appears here once your Monerium account is connected and the IBAN is activated.";
}

function needsPasskeySafeSetup(u = user) {
  return !!(u?.passkeySafe && u.passkeySafe.status !== "active");
}

function hasConnectedMonerium(u = user) {
  return !!u?.monerium?.connectedAt;
}

function renderFundingActions(u = user) {
  const row = $("funding-actions");
  const hint = $("funding-action-hint");
  if (!row || !hint || !u) return;
  const funding = u.funding || {};
  const needsIban = kycApproved(u) && !u.iban && funding.mode === "sandbox";
  const showSafe = needsIban && needsPasskeySafeSetup(u);
  // Approval is already settled by this point (needsIban requires it), so the
  // remaining step is the same for both paths: one passkey ceremony that links
  // the Safe and issues the IBAN. In-house approved users do not need
  // Monerium's OAuth.
  const showActivate = needsIban && !needsPasskeySafeSetup(u);
  row.classList.toggle("hidden", !(showSafe || showActivate));
  $("btn-finish-safe").classList.toggle("hidden", !showSafe);
  $("btn-monerium-dashboard").classList.toggle("hidden", !showActivate);
  $("btn-monerium-dashboard").textContent = "Activate IBAN";
  hint.classList.toggle("hidden", !(showSafe || showActivate));
  hint.textContent = showSafe
    ? "Finish the smart wallet first, then activate the app IBAN."
    : showActivate
      ? hasConnectedMonerium(u)
        ? "Your Monerium account is connected. Activate the app IBAN with your passkey."
        : "Approve IBAN issuance with your passkey — one confirmation links your wallet to Monerium."
      : "";
}

async function loadPrivacyCatalog() {
  if (privacyCatalog) return privacyCatalog;
  privacyCatalog = await api("/api/privacy-bundles");
  return privacyCatalog;
}

function bundlePlan(planId) {
  return privacyCatalog?.plans?.find((p) => p.id === planId);
}

function usageLine(label, used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `<div class="bundle-line"><span>${label}</span><span>${fmt(used, 1)} / ${fmt(limit, 0)} GB</span></div><div class="bundle-meter"><span style="width:${pct}%"></span></div>`;
}

async function subscribePrivacyBundle(planId) {
  clearErr("privacy-err");
  try {
    const result = await api(`/api/users/${user.id}/privacy-bundle`, { planId });
    user = result.user;
    renderUser(user);
  } catch (e) { showErr("privacy-err", e); }
}

async function cancelPrivacyBundle() {
  clearErr("privacy-err");
  try {
    user = await api(`/api/users/${user.id}/privacy-bundle/cancel`, {});
    renderUser(user);
  } catch (e) { showErr("privacy-err", e); }
}

async function loadRecoveryInfo() {
  if (!user) return null;
  try {
    recoveryInfo = await api(`/api/users/${user.id}/recovery`);
    return recoveryInfo;
  } catch {
    recoveryInfo = null;
    return null;
  }
}

function renderRecoveryInfo() {
  const el = $("set-recovery");
  const btn = $("btn-recovery-start");
  if (!el || !btn) return;
  if (!recoveryInfo) {
    el.textContent = "Checking recovery status.";
    btn.disabled = true;
    return;
  }
  const active = recoveryInfo.requests?.find((r) => !["FINALIZED", "CANCELED", "EXPIRED"].includes(r.status));
  if (active) {
    const ready = active.readyAt ? new Date(active.readyAt).toLocaleString() : "";
    el.textContent = active.status === "DELAYING" ? `Delay active until ${ready}` : active.status.replaceAll("_", " ").toLowerCase();
    btn.disabled = true;
    btn.textContent = "Open";
    return;
  }
  btn.textContent = "Start";
  btn.disabled = !recoveryInfo.available;
  el.textContent = recoveryInfo.available
    ? `Zold recovery module · ${recoveryInfo.delayHours}h delay`
    : (recoveryInfo.blocked || "Recovery unavailable");
}

async function startRecoveryRequest() {
  clearErr("recovery-err");
  $("btn-recovery-start").disabled = true;
  try {
    await api(`/api/users/${user.id}/recovery/requests`, {});
    await loadRecoveryInfo();
    renderRecoveryInfo();
  } catch (e) {
    showErr("recovery-err", e);
  } finally {
    renderRecoveryInfo();
  }
}

async function renderPrivacyBundle() {
  const card = $("privacy-card");
  if (!card || !user) return;
  try { await loadPrivacyCatalog(); } catch { return; }
  if (!privacyCatalog.enabled) {
    card.classList.add("hidden");
    return;
  }
  card.classList.toggle("hidden", !kycApproved(user));
  const active = user.privacyBundle?.status && user.privacyBundle.status !== "canceled";
  const activePlan = active ? bundlePlan(user.privacyBundle.planId) : null;
  const chip = $("privacy-chip");
  chip.textContent = active ? user.privacyBundle.status.replace("_", " ").toUpperCase() : "OPTIONAL";
  chip.className = active && user.privacyBundle.status === "active" ? "chip ok" : active ? "chip pend" : "chip review";
  $("privacy-plans").innerHTML = privacyCatalog.plans.map((p) => {
    const isActive = activePlan?.id === p.id;
    const disabled = !p.marginProtected || isActive;
    const label = isActive ? "Selected" : p.marginProtected ? "Add" : "Paused";
    return `<div class="plan ${isActive ? "active" : ""}">
      <div class="pn">${esc(p.name)}</div>
      <div class="pp">€${fmt(p.priceEur)}/mo</div>
      <div class="pd">${esc(p.esimGb)} GB eSIM · ${esc(p.vpnGb)} GB VPN · ${esc(p.vpnDevices)} devices</div>
      <div class="pm">${esc(p.esimRegion)} coverage · monthly allowance</div>
      <button class="${isActive ? "ghost" : ""}" data-plan="${esc(p.id)}" ${disabled ? "disabled" : ""}>${label}</button>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-plan]").forEach((b) => {
    b.onclick = () => subscribePrivacyBundle(b.dataset.plan);
  });
  const status = $("privacy-status");
  if (!activePlan) {
    status.classList.add("hidden");
    status.innerHTML = "";
    return;
  }
  const b = user.privacyBundle;
  status.classList.remove("hidden");
  status.innerHTML = `
    <div class="bundle-line"><span>Kokio eSIM</span><span>${b.esim?.status || "pending"} · ${b.esim?.region || activePlan.esimRegion}</span></div>
    ${usageLine("eSIM data", b.usage?.esimGb || 0, b.esim?.dataGb || activePlan.esimGb)}
    <div class="bundle-line"><span>Mysterium VPN</span><span>${b.vpn?.status || "pending"} · ${b.vpn?.devices || activePlan.vpnDevices} devices</span></div>
    ${usageLine("VPN bandwidth", b.usage?.vpnGb || 0, b.vpn?.bandwidthGb || activePlan.vpnGb)}
    <div class="bundle-line"><span>Renews</span><span>${new Date(b.renewsAt).toLocaleDateString()}</span></div>
    <button class="ghost" id="btn-privacy-cancel">Cancel bundle</button>`;
  $("btn-privacy-cancel").onclick = cancelPrivacyBundle;
}

function renderKycState(u = user) {
  if (!u) return;
  const blocked = !kycApproved(u);
  const [label, main, detail] = kycCopy(u.kycStatus, u);
  for (const [id, value] of [
    ["kyc-label", label], ["kyc-main", main], ["kyc-detail", detail],
    ["dash-kyc-label", label], ["dash-kyc-main", main], ["dash-kyc-detail", detail],
  ]) {
    const el = $(id);
    if (el) el.textContent = value;
  }
  // Nothing connected yet = offer the two routes. A chosen-but-abandoned OAuth
  // (path set, never authorised) still counts as nothing connected.
  const needsChoice = blocked && u.kycStatus === "pending" && !hasConnectedMonerium(u);
  $("kyc-choice")?.classList.toggle("hidden", !needsChoice);
  $("kyc-card")?.classList.toggle("hidden", !blocked);
  renderKycGate(u, needsChoice);
  $("btn-send").disabled = blocked;
  document.querySelectorAll(".dest-btn").forEach((b) => { b.disabled = blocked; });
  $("fund-card")?.classList.toggle("hidden", blocked);
  $("send-card")?.classList.toggle("hidden", blocked);
}

async function refresh() {
  if (!user) return;
  try {
    renderUser(await api(`/api/users/${user.id}`));
    await loadTransfers();
    await loadRecoveryInfo();
    renderRecoveryInfo();
  } catch (e) {
    // A 401 means the session is gone; frozen numbers would say otherwise.
    if (e?.status === 401) return signOut();
  }
  // Conversion happens on the server's poll, not on a user action, so the
  // panel has to be re-read rather than updated optimistically.
  await refreshCryptoDeposits();
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  $("view-title").textContent = ({ dashboard: "Dashboard", transactions: "Transactions", accounts: "Accounts", contacts: "Contacts", settings: "Settings" })[view] || "Dashboard";
  $("send-card")?.classList.toggle("hidden", view !== "dashboard" || !kycApproved(user));
  renderShellPages();
}

function renderShellPages() {
  if (!user) return;
  $("send-card")?.classList.toggle("hidden", activeView !== "dashboard" || !kycApproved(user));
  $("acct-balance").innerHTML = `<span class="cur">€</span>${fmt(user.balanceEur ?? 0)}`;
  $("acct-iban").textContent = user.iban || "Not issued yet";
  const plannedSafe = needsPasskeySafeSetup(user) ? user.passkeySafe?.address : null;
  $("acct-address").textContent = plannedSafe ? `planned ${shortAddr(plannedSafe)} — not deployed` : (user.address || "—");
  document.querySelector('[data-copy="acct-address"]')?.classList.toggle("hidden", !!plannedSafe);
  $("acct-owner").textContent = user.passkeySafe?.status === "active"
    ? "passkey"
    : "passkey setup required";
  $("acct-kyc").textContent = kycCopy(user.kycStatus, user)[1];
  $("acct-kyc-chip").textContent = (user.kycStatus || "approved").toUpperCase();
  $("acct-kyc-chip").className = user.kycStatus === "approved" ? "chip ok" : user.kycStatus === "rejected" ? "chip err" : "chip review";
  const funding = user.funding || {};
  $("acct-funding").textContent = user.iban || funding.detail || `${funding.mode || "sandbox"} · ${funding.status || "active"}`;
  $("acct-funding-chip").textContent = (funding.status || "ACTIVE").toUpperCase();
  $("acct-funding-chip").className = funding.status === "error" ? "chip err" : funding.status === "active" || user.iban ? "chip ok" : "chip pend";
  $("acct-authorizer").textContent = user.authorizerAddress || "Registered when you send from this browser.";
  $("set-passkey").textContent = user.passkey ? `Credential ${user.passkey.credentialId.slice(0, 16)}…` : "No passkey on this account yet.";
  $("set-device").textContent = user.authorizerAddress ? `Bound to ${user.authorizerAddress.slice(0, 10)}…${user.authorizerAddress.slice(-6)}` : "Not bound yet.";
  const safe = user.passkeySafe;
  $("set-wallet-policy").textContent = !safe
    ? "Passkey Safe not planned yet."
    : `Passkey-only Safe · you are its only owner and sign every movement with your passkey.`;
  renderRecoveryInfo();
  $("set-privacy-live").textContent = privacyCatalog
    ? `Kokio ${privacyCatalog.fulfillment.kokio}; Mysterium ${privacyCatalog.fulfillment.mysterium}.`
    : "Pending partner credentials.";
  renderContacts();
  renderTransactionPage();
}

async function loadTransfers() {
  if (!user) return;
  try {
    const data = await api(`/api/users/${user.id}/activity`);
    hist.splice(0, hist.length, ...(data.activity || []));
    renderHistory();
    renderTransactionPage();
  } catch {}
}
