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
      <div class="m-lede" style="font-size:13px;margin-top:16px">This deployment has no data encryption key (DATA_ENCRYPTION_KEYS), so it cannot store a client secret. It refuses rather than keep one in plaintext.</div>`;
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
      <div class="m-err hidden" role="alert" id="m-mon-err" style="margin-top:12px"></div>
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
        renderUser(await api(`/api/users/${user.id}/monerium/api-keys`, await moneriumStepUp(user, true), "DELETE"));
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
    <div class="m-err hidden" role="alert" id="m-mon-err" style="margin-top:12px"></div>
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
      ...(await moneriumStepUp(user)),
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


/* The older screens' back buttons: back where the user came from. */
document.querySelectorAll("[data-mback]").forEach((b) => {
  b.onclick = () => phBack(b.dataset.mback || "home");
});
$("m-go-bundle").onclick = () => mobileNav("bundle");
$("m-back").onclick = () => phBack("home");

/**
 * What this deployment lets the browser do. Defaults are the SAFE ones: with
 * no answer from /api/health every optional rail reads as closed, so a failed
 * probe hides a control the server might refuse rather than offering one it
 * will.
 */
let caps = { sandbox: true, cashRail: false, moneriumOAuth: false, moneriumApiKeys: false, moneriumEnvironment: "production", moneriumHost: "api.monerium.app", emailSmsRecovery: false };

/* Real money only when /api/health says so: capabilities.sandbox is true on
   every deployment, so it cannot decide the "Test mode" pill. */
let realMoney = false;

/* The app's dollar token as it names itself: "USDC" on Base mainnet, "zUSD"
   on a staging chain. Read only after loadCapabilities(), never at load. */
const usdSym = () => {
  const s = caps.usdToken?.symbol;
  return typeof s === "string" && /^[A-Za-z0-9.]{1,11}$/.test(s) ? s : "USDC";
};

async function loadCapabilities() {
  try {
    const h = await (await fetch("/api/health")).json();
    if (h?.capabilities) caps = { ...caps, ...h.capabilities };
    realMoney = h?.realMoney === true;
  } catch {
    /* keep the safe defaults */
  }
  obCapsChanged();
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

/* Bringing in a company's existing Safe (onboarding's b-safe-choice). Offered
   only where the server takes it and this login could still switch: a passkey
   and a Safe of its own that was never activated. The server also refuses a
   planned Safe that is deployed or holds money; only `prepare` can say so. */
function safeImportOffered(u = user) {
  return !!(caps.safeImport && u?.accountType === "company" && u.passkey && u.passkeySafe
    && u.passkeySafe.status !== "active");
}

/* "An import was started on THIS device." `prepare` stores nothing, so the
   server cannot know an owner change may be on its way; this flag is the only
   thing that keeps this browser from deploying the account's own Safe in the
   meantime, which would end the import for good. Per device: another browser
   signed in to the same account does not see it. A hint, never the truth —
   every screen that reads it asks `prepare` again. */
const SAFE_IMPORT_KEY = "zold-safe-import";
function safeImportFlag(u = user) {
  try {
    const f = JSON.parse(localStorage.getItem(SAFE_IMPORT_KEY) || "null");
    return f && u?.id && f.userId === u.id && /^0x[0-9a-fA-F]{40}$/.test(f.address || "") ? f : null;
  } catch { return null; }
}
function setSafeImportFlag(address, u = user) {
  try { localStorage.setItem(SAFE_IMPORT_KEY, JSON.stringify({ userId: u.id, address })); } catch { /* private mode: this visit only */ }
}
function clearSafeImportFlag() {
  try { localStorage.removeItem(SAFE_IMPORT_KEY); } catch {}
}

function hasConnectedMonerium(u = user) {
  return !!u?.monerium?.connectedAt;
}

/* Which Monerium login and profile the connection stands for, as rows for
   Z.kv. A browser still signed in at Monerium skips its login form, so this
   is the one place the user sees which login Zold got. */
function moneriumConnectedRows(u = user) {
  const m = u?.monerium;
  if (!m) return [];
  const p = (m.profiles || []).find((x) => x?.id === m.profileId);
  const kind = p?.kind === "corporate" ? "Company" : p?.kind === "personal" ? "Personal" : "";
  const state = p?.state && p.state !== "approved" ? ` · ${p.state}` : "";
  return [
    ...(m.accountEmail ? [{ key: "Monerium login", value: m.accountEmail }] : []),
    ...(p ? [{ key: "Profile", value: `${p.name || "Unnamed"}${kind ? ` (${kind})` : ""}${state}` }] : []),
  ];
}

/* The IBAN has been asked for and the account waits on Monerium, not on the
   user. null when there is something to do here (or nothing left to wait for).
   `idCheck` reads the profile state Zold last saw, which only says "still
   checking" while Monerium itself says so. */
function ibanWait(u = user) {
  if (!u || kycApproved(u) || u.iban || u.funding?.status !== "iban_pending") return null;
  const detail = String(u.funding?.detail || "");
  if (/linked under Monerium profile/.test(detail)) {
    return { support: true, title: "Monerium needs to fix a link",
      sub: "Your account is linked to a different Monerium profile than the one you signed in with. Only Monerium support can move it. Write to us and we’ll raise it with them." };
  }
  const profile = (u.monerium?.profiles || []).find((p) => p.id === u.monerium?.profileId);
  const idCheck = !!profile && profile.state !== "approved";
  return idCheck
    ? { idCheck, title: "Monerium is checking your ID",
        sub: "Your IBAN is requested. Monerium issues it once they’ve verified you. If they ask for anything, it comes by email from Monerium." }
    : { idCheck, title: "Monerium is issuing your IBAN",
        sub: "Your IBAN is requested. It usually appears within minutes." };
}

function renderFundingActions(u = user) {
  const row = $("funding-actions");
  const hint = $("funding-action-hint");
  if (!row || !hint || !u) return;
  const funding = u.funding || {};
  const needsIban = kycApproved(u) && !u.iban && funding.mode === "sandbox";
  // While an import is under way on this device, "Finish smart wallet" would
  // deploy the account's own Safe and end it: offer the import's last step.
  const importing = needsPasskeySafeSetup(u) && !!safeImportFlag(u);
  const showSafe = needsIban && needsPasskeySafeSetup(u) && !importing;
  // Approval is already settled by this point (needsIban requires it), so the
  // remaining step is the same for both paths: one passkey ceremony that links
  // the Safe and issues the IBAN. In-house approved users do not need
  // Monerium's OAuth.
  const showActivate = needsIban && !needsPasskeySafeSetup(u);
  row.classList.toggle("hidden", !(showSafe || showActivate || importing));
  $("btn-finish-safe").classList.toggle("hidden", !showSafe);
  $("btn-finish-import").classList.toggle("hidden", !importing);
  $("btn-monerium-dashboard").classList.toggle("hidden", !showActivate);
  $("btn-monerium-dashboard").textContent = "Activate IBAN";
  hint.classList.toggle("hidden", !(showSafe || showActivate || importing));
  hint.textContent = importing
    ? "Once your Safe’s owner has added this phone, finish bringing the Safe in."
    : showSafe
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

/* The settings row reads the account row; Profile → Recovery reads the chain
   and holds every control. */
async function loadRecoveryInfo() {
  recoveryInfo = user ? { safe: user.passkeySafe } : null;
  return recoveryInfo;
}

function renderRecoveryInfo() {
  const el = $("set-recovery");
  const btn = $("btn-recovery-start");
  if (!el || !btn) return;
  const safe = user?.passkeySafe;
  btn.textContent = "Manage";
  btn.disabled = !safe || safe.status !== "active" || (!caps.zoldenburgRecovery && !caps.emailSmsRecovery);
  el.textContent = !caps.zoldenburgRecovery && !caps.emailSmsRecovery ? "No recovery guardian on this deployment."
    : safe?.recovery?.status === "active" ? "Zoldenburg is your recovery guardian."
      : safe?.candideRecovery?.guardianStatus === "active" ? "Email/SMS recovery is on."
        : "No guardian — Zoldenburg UG cannot recover this account if you lose your passkey.";
}

function startRecoveryRequest() {
  mobileNav("recovery");
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
  // payments are re-read rather than updated optimistically.
  await phLoadDeposits();
  phRefresh();
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll(".nav a").forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
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
    : safe.importedAt
      // An imported Safe may keep the owner's own wallet as a second owner.
      ? "Your company’s Safe, brought into Zold · your passkey is an owner and signs every movement Zold makes. Any other owner is your own wallet."
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
    histLoadFailed = false;
    histLoaded = true;
    renderHistory();
    renderTransactionPage();
  } catch {
    // Say so rather than letting the list read "No transfers yet".
    histLoadFailed = true;
    renderHistory();
  }
}
