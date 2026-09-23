/**
 * Onboarding: the account form, the passkey step, staged provisioning, the
 * Monerium gate, and recovery enrolment as step 3.
 *
 * Declares resumeSession(); app/main.js is what calls it.
 */
/* ---------- onboarding flow: create -> staged provisioning -> dashboard */
function provStep(i, state) {
  const el = document.querySelectorAll("#prov-steps .pstep")[i];
  if (el) el.className = "pstep" + (state ? " " + state : "");
}

function enterDashboard(name) {
  provisioningGen++;
  let invite = null;
  try { invite = sessionStorage.getItem("zold-invite"); sessionStorage.removeItem("zold-invite"); } catch {}
  if (invite) {
    api("/api/orgs/invites/accept", { token: invite })
      .then(() => location.replace("/business"))
      .catch((e) => alert(`The invitation could not be accepted: ${e.message}`));
  }
  $("onboard").style.display = "none";
  $("provisioning").style.display = "none";
  $("kyc-review").style.display = "none";
  // The mobile shell is the app now; the desktop sidebar/topbar/rail stay in
  // the document only until their Noir screens land.
  $("dashboard").classList.add("m-on");
  if (!$("dashboard").dataset.msub) $("dashboard").dataset.msub = "home";
  $("dashboard").style.display = "grid";
  $("userpill").style.display = "flex";
  $("pillname").textContent = name;
  $("avatar").textContent = name.trim()[0].toUpperCase();
  if (poll) clearInterval(poll);
  poll = setInterval(refresh, 5000);
  refresh();
}

/**
 * The gate/pending screen's own state.
 *
 * The checklist is derived, not scripted. The design shows three steps with
 * the first two ticked; here a step is ticked when the account actually
 * carries the thing it names, so a Monerium user who has not finished the
 * connect does not see a tick claiming they have.
 */
function renderKycGate(u, needsChoice) {
  const gate = $("kyc-pending");
  if (!gate) return;
  const connected = hasConnectedMonerium(u);
  const rejected = u.kycStatus === "rejected";
  const approved = kycApproved(u);
  const walletReady = !needsPasskeySafeSetup(u) && !!u.passkeySafe;
  const recoveryActive = u.passkeySafe?.candideRecovery?.guardianStatus === "active";

  // At the gate nothing is running yet, so there is nothing to report on.
  gate.classList.toggle("hidden", !!needsChoice);
  $("kyc-keys").classList.toggle("hidden", !needsChoice || !keysFormOpen);
  $("kyc-choice").classList.toggle("hidden", !needsChoice || keysFormOpen);
  $("btn-monerium-existing").classList.toggle("hidden", !caps.moneriumOAuth);
  $("btn-monerium-keys").classList.toggle("hidden", !caps.moneriumApiKeys);
  $("kyc-noroute").classList.toggle("hidden", caps.moneriumOAuth || caps.moneriumApiKeys);
  $("kyc-title").textContent = rejected ? "We could not verify you"
    : needsChoice ? (keysFormOpen ? "Monerium API keys" : "Connect Monerium")
      : connected && !approved ? "Activate your IBAN" : "Connecting Monerium";
  $("kyc-sub").textContent = rejected
    ? "Funding and transfers stay closed on this account."
    : needsChoice
      ? keysFormOpen
        ? `Keys from an app created in your Monerium account. This deployment talks to Monerium ${caps.moneriumEnvironment} (${caps.moneriumHost}); keys from the other environment are refused as a wrong secret.`
        : "Your smart wallet is deployed. Your identity check and your IBAN come from Monerium — sign up or sign in there, or add the API keys of a Monerium account you already have."
      : connected && !approved
        ? "Your Monerium account is connected. One passkey confirmation links your wallet under that account and asks Monerium for the IBAN."
        : "We are reading the identity Monerium holds for you. Nothing moves until it comes back approved.";
  $("kyc-keys-note").textContent =
    "Zold verifies the pair against Monerium before storing anything, encrypts the secret at rest and never returns it. Your Monerium account, its profile and its IBANs stay yours.";

  const mark = $("kyc-mark");
  mark.className = `m-gate-mark${rejected ? " stop" : !needsChoice && !approved ? " wait" : ""}`;
  mark.firstElementChild.textContent = rejected ? "priority_high" : approved ? "check" : "badge";

  const steps = [
    { t: "Account created", d: "Your passkey is registered", state: "done" },
    { t: "Smart wallet deployed", d: walletReady ? "Your account exists on-chain" : "Approve the deployment with your passkey", state: walletReady ? "done" : "now" },
    // Only where the deployment can offer it. Not "now" when skipped: nothing
    // is waiting on it, and the pulse belongs to the step that is.
    ...(caps.emailSmsRecovery ? [{ t: "Recovery set up",
      d: recoveryActive ? "Email registered, guardian on your smart wallet" : "Skipped — set it up from your profile; until then a lost device loses the account",
      state: recoveryActive ? "done" : "" }] : []),
    { t: "Monerium connected", d: connected ? (u.monerium?.method === "api_keys" ? "Your own API keys" : "Signed in with Monerium") : "Sign in, or add your API keys", state: connected ? "done" : "now" },
    { t: "IBAN activated", d: rejected ? "Not approved" : approved ? "Funding and sending are open" : "One passkey confirmation",
      state: rejected ? "bad" : approved ? "done" : "now" },
  ];
  /* Only the FIRST unfinished step is "in progress". Nothing is working on
     step three while step two is still waiting on you, and two things pulsing
     at once says the opposite. */
  let running = false;
  $("kyc-steps").innerHTML = steps.map((s) => {
    let state = s.state;
    if (state === "now") {
      if (running || rejected) state = "";
      else running = true;
    }
    return `<div class="m-gstep ${state}">
      <div class="nd"><span class="material-symbols-rounded" style="font-size:14px">${
        state === "done" ? "check" : state === "bad" ? "close" : "more_horiz"}</span></div>
      <div style="min-width:0"><div class="t">${esc(s.t)}</div><div class="d">${esc(s.d)}</div></div>
    </div>`;
  }).join("");

  const box = $("kyc-status-box");
  if (box) box.className = `m-gate-status${approved ? " ok" : rejected ? " no" : ""}`;
  $("btn-kyc-activate").classList.toggle("hidden", !(connected && !approved && !u.iban && !rejected));
  $("btn-kyc-reconnect").classList.toggle("hidden", !(connected && !approved));
}

let keysFormOpen = false;

function enterKycReview(name) {
  $("onboard").style.display = "none";
  $("provisioning").style.display = "none";
  $("dashboard").style.display = "none";
  $("kyc-review").style.display = "grid";
  $("btn-kyc-dashboard").onclick = () => enterDashboard(name);
  renderKycState(user);
}

async function refreshKycStatus({ continueWhenApproved = false } = {}) {
  clearErr("kyc-err");
  try {
    const k = await api(`/api/users/${user.id}/kyc`);
    user = { ...user, ...k, funding: k.funding ?? user.funding };
    renderKycState(user);
    if (kycApproved(user) && continueWhenApproved) {
      const full = await api(`/api/users/${user.id}`);
      renderUser(full);
      if (user.iban || user.funding?.status === "active") {
        return enterDashboard(user.name || pendingInfo?.name || "Account");
      }
      return enterProvisioning(user.name || pendingInfo?.name || "Account");
    }
  } catch (e) { showErr("kyc-err", e); }
}


async function startMoneriumConnect(errorId = "kyc-err") {
  clearErr(errorId);
  try {
    const redirectUri = `${location.origin}/api/monerium/oauth/callback`;
    const connect = await api(`/api/users/${user.id}/monerium/connect/start`, { redirectUri });
    const target = safeUrl(connect.redirectUrl);
    if (!target) throw new Error("Monerium returned an unusable sign-in address");
    location.href = target;
  } catch (e) { showErr(errorId, e); }
}

/* Link the deployed Safe to Monerium and request the app IBAN. One passkey
   ceremony signs the ownership declaration; the server signs as the Safe
   (EIP-1271) and asks Monerium for the IBAN. Works for both approval paths:
   a connected Monerium account uses its own OAuth token, an in-house-approved
   account goes through the app credentials on the server. Returns true when
   the ceremony ran. */
async function connectMoneriumKeysAtGate() {
  clearErr("kyc-err");
  const btn = $("btn-kyc-keys-connect");
  btn.disabled = true;
  btn.textContent = "Checking with Monerium…";
  try {
    const updated = await api(`/api/users/${user.id}/monerium/api-keys`, {
      clientId: $("kyc-mon-id").value,
      clientSecret: $("kyc-mon-secret").value,
    });
    $("kyc-mon-secret").value = "";
    keysFormOpen = false;
    renderUser(updated);
    if (kycApproved(user)) return enterProvisioning(user.name || "Account");
    renderKycState(user);
  } catch (e) {
    showErr("kyc-err", e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify and connect";
  }
}

/* Activation from the gate: the account is still pending (activation is what
   approves it), so this deliberately does not require approval first. */
async function activateIbanAtGate() {
  clearErr("kyc-err");
  const b = $("btn-kyc-activate");
  b.disabled = true;
  try {
    await issueAppIban();
    if (kycApproved(user)) return enterProvisioning(user.name || "Account");
    renderKycState(user);
  } catch (e) { showErr("kyc-err", e); } finally { b.disabled = false; }
}

async function issueAppIban() {
  // A connected Monerium account may activate before approval — activation
  // IS what approves it (address-matched IBAN on the connected account).
  if (!user?.id || user.iban || !(kycApproved(user) || hasConnectedMonerium(user))) return false;
  if ((user.funding || {}).mode !== "sandbox") return false;
  await finishPasskeySafeSetup();
  let profileId = user.monerium?.profileId;
  if (hasConnectedMonerium()) {
    const accounts = await api(`/api/users/${user.id}/monerium/accounts`);
    user = { ...user, monerium: { ...(user.monerium || {}), ...accounts } };
    profileId = user.monerium?.profileId || accounts.profiles?.[0]?.id;
  }
  const start = await api(`/api/users/${user.id}/monerium/link-signature/start`, { profileId });
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(start.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(start.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  const activated = await api(start.submitTo, {
    profileId,
    linkSignatureRequestId: start.requestId,
    credentialId: cred.id,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  });
  renderUser(activated);
  return true;
}

async function activateConnectedMonerium() {
  clearErr("dep-err");
  try {
    // A pending account with nothing connected still needs a Monerium
    // connection; an approved or connected account activates directly.
    if (!hasConnectedMonerium() && !kycApproved(user)) return startMoneriumConnect("dep-err");
    await issueAppIban();
  } catch (e) { showErr("dep-err", e); }
}

async function finishDashboardSmartWallet() {
  clearErr("dep-err");
  try {
    await finishPasskeySafeSetup();
    renderUser(user);
    const issued = await issueAppIban();
    if (!issued) await refresh();
  } catch (e) { showErr("dep-err", e); }
}

let provisioningGen = 0;
function enterProvisioning(name) {
  // Leaving the screen invalidates the poll: a tick from an earlier entry
  // must not yank the user back after "Continue without finishing".
  const gen = ++provisioningGen;
  $("onboard").style.display = "none";
  $("provisioning").style.display = "grid";
  provStep(0, "done");
  provStep(1, "active");
  $("btn-skip").onclick = () => enterDashboard(name);
  $("btn-prov-iban").onclick = async () => {
    const b = $("btn-prov-iban");
    b.disabled = true;
    $("prov-err").classList.add("hidden");
    try {
      await issueAppIban();
      b.classList.add("hidden");
      enterProvisioning(name); // resume polling; the IBAN (or its pending state) is now visible
    } catch (e) {
      const err = $("prov-err");
      err.textContent = e.message;
      err.classList.remove("hidden");
    } finally {
      b.disabled = false;
    }
  };

  const tick = async () => {
    if (gen !== provisioningGen) return;
    let u = user;
    try { u = await api(`/api/users/${user.id}`); user = u; } catch {}
    if (gen !== provisioningGen) return;
    if (!kycApproved(u)) return enterKycReview(name);
    const f = u.funding || {};
    const detail = (f.detail || "").toLowerCase();

    if (u.iban || f.status === "active") {
      provStep(1, "done"); provStep(2, "done"); provStep(3, "done");
      $("btn-prov-iban").classList.add("hidden");
      setTimeout(() => enterDashboard(name), 900);
      return;
    }
    // The wallet is deployed and only the link ceremony remains. A passkey
    // prompt cannot pop unbidden from a polling loop — stop and ask for the
    // click that starts it.
    if (f.status === "provisioning" && detail.includes("approve iban")) {
      provStep(1, "done"); provStep(2, "active");
      $("btn-prov-iban").classList.remove("hidden");
      $("btn-skip").classList.remove("hidden");
      return;
    }
    if (f.status === "error") {
      const err = $("prov-err");
      err.textContent = f.detail || "provisioning failed";
      err.classList.remove("hidden");
      $("btn-skip").classList.remove("hidden");
      return;
    }
    if (detail.includes("deploy")) {
      provStep(1, "active");
    } else if (detail.includes("link") || f.status === "iban_pending") {
      provStep(1, "done"); provStep(2, f.status === "iban_pending" ? "done" : "active");
      if (f.status === "iban_pending") provStep(3, "active");
    }
    setTimeout(tick, 2500);
  };
  tick();
}

/* ---------- onboarding wizard: info -> passkey -> provisioning ---------- */
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let pendingInfo = null;
let passkeyOnboardingBusy = false;

function setPasskeyButtonBusy(busy, label) {
  const btn = $("btn-passkey");
  passkeyOnboardingBusy = busy;
  btn.disabled = busy;
  btn.textContent = label || (user?.id ? "Finish smart wallet" : "Create passkey & open account");
}

/* ==========================================================================
   ONBOARDING STEP 1 — identity basics
   --------------------------------------------------------------------------
   The backend decides the path; this screen only collects. It deliberately
   does NOT branch on country, because a client that knows the rules is a
   client that can be read to learn them — and because two copies of a rule
   set drift. The only thing the UI derives locally is which partner to NAME
   in the consent line, and that is cosmetic: the server records the consent
   with the partner the segment actually assigns.

   Nothing here is pre-answered. An unanswered US question and a "no" are
   different facts, and the API refuses a half-filled set rather than reading
   silence as a denial.
   ========================================================================== */
let acctType = "individual";
let citizenships = [];
const usAnswers = { usPerson: null, companyUsNexus: null };

/** Which partner is named in the consent line. Cosmetic and best-effort — the
 *  server assigns the real one. India is named because its path is Xflow's. */
function partnerLabel(country) {
  const cc = (country || "").trim().toUpperCase();
  if (cc === "IN") return "Xflow";
  return "Monerium and Gnosis Pay";
}

function renderCitizenships() {
  $("cit-chips").innerHTML = citizenships.length
    ? citizenships.map((c) => `<span class="onb-chip">${esc(c)}<button type="button" data-rm="${esc(c)}">×</button></span>`).join("")
    : `<span class="onb-hint" style="font-size:13px">None added yet</span>`;
  $("cit-chips").querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = () => { citizenships = citizenships.filter((c) => c !== b.dataset.rm); renderCitizenships(); };
  });
}

function addCitizenship() {
  const v = $("cit-input").value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(v)) return showErr("create-err", new Error("use a two-letter country code, e.g. DE"));
  clearErr("create-err");
  if (!citizenships.includes(v)) citizenships.push(v);
  $("cit-input").value = "";
  renderCitizenships();
}
$("cit-add").onclick = addCitizenship;
$("cit-input").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addCitizenship(); } };

$("acct-type").querySelectorAll("[data-acct]").forEach((b) => {
  b.onclick = () => {
    acctType = b.dataset.acct;
    $("acct-type").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    // Question (d) and the incorporation country only exist for a company.
    $("q-company").classList.toggle("hidden", acctType !== "company");
    $("incorp-wrap").classList.toggle("hidden", acctType !== "company");
    if (acctType !== "company") usAnswers.companyUsNexus = null;
  };
});

$("us-qs").querySelectorAll(".onb-q").forEach((row) => {
  row.querySelectorAll("[data-v]").forEach((b) => {
    b.onclick = () => {
      usAnswers[row.dataset.q] = b.dataset.v === "yes";
      row.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
});

$("country").oninput = () => { $("partner-name").textContent = partnerLabel($("country").value); };

$("btn-continue").onclick = () => {
  clearErr("create-err");
  const name = $("name").value.trim();
  if (!name) return showErr("create-err", new Error("please enter your name"));
  const email = $("email").value.trim();
  if (!email) return showErr("create-err", new Error("please enter your email — it is how a lost device gets this account back"));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return showErr("create-err", new Error("that email doesn't look right"));
  }
  const country = ($("country").value.trim() || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    return showErr("create-err", new Error("country of residence must be a two-letter code, e.g. DE"));
  }
  if (!citizenships.length) {
    return showErr("create-err", new Error("please add at least one citizenship"));
  }
  const required = ["usPerson", ...(acctType === "company" ? ["companyUsNexus"] : [])];
  if (required.some((k) => usAnswers[k] === null)) {
    return showErr("create-err", new Error("please answer the US question — yes or no"));
  }
  if (!$("consent-terms").checked) {
    return showErr("create-err", new Error("please accept the terms to continue"));
  }
  if (!$("consent-partner").checked) {
    return showErr("create-err", new Error("we cannot open the account without permission to share your details with the partner who opens it"));
  }
  pendingInfo = {
    name,
    email,
    country,
    accountType: acctType,
    citizenships: [...citizenships],
    usAnswers: { ...usAnswers },
    ...(acctType === "company" && $("incorp-country").value.trim()
      ? { companyIncorporationCountry: $("incorp-country").value.trim().toUpperCase() }
      : {}),
    consents: [
      { kind: "zold_terms" },
      { kind: "partner_share", partner: partnerLabel(country) },
    ],
  };
  $("onb-step1").classList.add("hidden");
  $("onb-step2").classList.remove("hidden");
  $("ostep1").className = "dot done";
  $("ostep2").className = "dot active";
};
renderCitizenships();

/** A refused signup is an outcome, not an error toast. Shows what Zold cannot
 *  offer; never the rule, the partner or the country policy. */
function showBlocked(code, _serverMessage) {
  $("onboard").style.display = "none";
  $("blocked").classList.add("on");
  $("blocked-title").textContent =
    code === "BLOCKED_US" ? "Zold is not available to US persons"
    : code === "BLOCKED_SANCTIONED" ? "Zold is not available in your country"
    : "Zold cannot open an account for you yet";
  // The server's message IS the title, so repeating it here said the same
  // sentence twice. The body carries the thing the user actually wants to know
  // next: that nothing was created and nothing was shared.
  $("blocked-body").textContent =
    "Nothing has been created, and none of your details have been shared with anyone.";
}

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function registerPasskey(u) {
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "register" });
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      rp: { name: "Zold", id: location.hostname },
      user: {
        id: new TextEncoder().encode(u.id),
        name: pendingInfo.email || pendingInfo.name,
        displayName: pendingInfo.name,
      },
      // P-256 only: the passkey becomes the Safe's owner and Candide's
      // WebAuthn owner needs a P-256 key; an RS256 credential registers and
      // then fails at Safe deployment.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      timeout: 60000,
      // FP4: ask for the PRF extension so this passkey can encrypt the
      // device spending key. Authenticators without it still register fine.
      extensions: { prf: {} },
    },
  });
  const updated = await api(`/api/users/${u.id}/passkey`, {
    credentialId: cred.id,
    attestation: b64url(cred.response.attestationObject),
    clientDataJSON: b64url(cred.response.clientDataJSON),
  });
  // Keep the full returned account locally. It includes the passkey Safe plan
  // that the next onboarding step deploys.
  user = { ...user, ...updated };
  if (!cred.getClientExtensionResults?.().prf?.enabled) {
    console.warn("this authenticator reports no PRF support — the device key cannot be passkey-encrypted");
  }
}

async function activatePasskeySafe() {
  if (!user?.id || !credId() || !window.PublicKeyCredential) return;
  const prepared = await api(`/api/users/${user.id}/passkey-safe/deployment`, {});
  if (!prepared.challenge) {
    user = { ...user, ...prepared };
    return;
  }
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(prepared.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(prepared.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  const activated = await api(prepared.submitTo, {
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  });
  user = { ...user, ...activated };
}

async function finishPasskeySafeSetup(timeoutMs = 45000) {
  if (!user?.passkeySafe || user.passkeySafe.status === "active") return;
  await Promise.race([
    activatePasskeySafe(),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("passkey Safe deployment did not finish in time")), timeoutMs),
    ),
  ]);
  if (needsPasskeySafeSetup(user)) {
    throw new Error("smart wallet deployment did not activate");
  }
}

/* FP4: bind this browser's device key as the account's payment authorizer.
   The server records the first binding and refuses re-binding unless the
   existing device authorizes it, so this can establish but never steal. */
/* The passkey credential this browser wraps the device key with. */
const credId = () => user?.passkey?.credentialId || null;

async function passkeyStepUp() {
  if (!credId()) return null;
  const { challenge } = await api("/api/webauthn/challenge", { purpose: "step_up" });
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(credId()) }],
      // A step-up gates binding a spending key: the server now requires the UV
      // flag, so ask the authenticator to actually verify the human.
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: cred.id,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* The send-time approval of this transfer's debit. The server prepared the
   Safe operation that moves exactly this transfer's amount out of your Safe;
   the passkey signs its hash here, so the movement itself — amount and
   destination — is what you approve, and the chain enforces it. Nothing can
   move without one of these signatures. */
async function safeExecutionAssertion(authorization) {
  const exec = authorization?.safeExecution;
  if (!exec) return undefined;
  if (!exec.challenge || !exec.credentialId) return undefined;
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(exec.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(exec.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: exec.credentialId,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

async function moneriumRedeemAssertion(authorization) {
  const redeem = authorization?.moneriumRedeem;
  if (!redeem) return undefined;
  if (!redeem.challenge || !redeem.credentialId) return undefined;
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(redeem.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(redeem.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: redeem.credentialId,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

/* FP4: mint the device key and bind it as the account's payment authorizer.
   Runs after passkey registration so the key can be wrapped with the
   authenticator's PRF secret; the server takes the first binding and refuses
   re-binding by anyone but the device, so this establishes, never steals. */
async function registerDeviceKey(u) {
  const dev = await deviceLib;
  const { address, protection } = dev.keyStatus().present
    ? { address: await dev.deviceAddress(credId()), protection: dev.keyStatus().protection }
    : await dev.createKey(credId());
  const updated = await api(`/api/users/${u.id}/authorizer`, { address, stepUp: await passkeyStepUp() });
  if (updated.authorizerAddress) user = { ...user, authorizerAddress: updated.authorizerAddress };
  if (protection !== "prf") {
    console.warn("device key stored unprotected — this authenticator has no PRF support");
  }
  return updated;
}

/* The onboarding checklist under the passkey button. Mirrors provStep(), plus
   a fail state whose dot swaps to ✕ — a red check would read as "done, badly". */
function pkStep(i, state) {
  const el = document.querySelectorAll("#pk-steps .pstep")[i];
  if (!el) return;
  el.className = "pstep" + (state ? " " + state : "");
  el.querySelector(".pdot").textContent = state === "fail" ? "✕" : "✓";
}

/* ---------- Onboarding step 3: recovery enrolment ---------- */

/* Is there recovery work left that onboarding should offer? True only where
   the deployment has the service, the Safe is active and the guardian is not
   yet on it. */
function recoveryEnrolmentPending(u = user) {
  return !!(caps.emailSmsRecovery && u?.passkeySafe?.status === "active"
    && u.passkeySafe.candideRecovery?.guardianStatus !== "active");
}

/* Runs right after the smart wallet is active and before the Monerium gate.
   Same three calls the Profile screen makes (channel -> signature -> OTP,
   then guardian), against the email given at signup. Resolves true when the
   guardian is on the Safe, false when skipped or unavailable; it never
   throws, because a recovery failure must not stop the account it protects
   from being finished — the Profile screen keeps the same controls. */
function offerRecoveryEnrolment() {
  if (!recoveryEnrolmentPending() || !user?.email) return Promise.resolve(false);
  return new Promise((resolve) => {
    const panes = ["rec-intro", "rec-otp", "rec-done"];
    const show = (id) => panes.forEach((x) => $(x).classList.toggle("hidden", x !== id));
    $("onb-step2").classList.add("hidden");
    $("onb-step3").classList.remove("hidden");
    $("ostep2").className = "dot done";
    $("ostep3").className = "dot active";
    $("rec-email").textContent = user.email;
    clearErr("rec-err");
    show("rec-intro");
    let otp = null; // { submitTo } while a code is outstanding
    const finish = (enrolled) => {
      $("onb-step3").classList.add("hidden");
      $("ostep3").className = "dot done";
      resolve(enrolled);
    };
    $("btn-rec-skip").onclick = () => finish(false);
    $("btn-rec-continue").onclick = () => finish(user.passkeySafe?.candideRecovery?.guardianStatus === "active");
    $("btn-rec-restart").onclick = () => { otp = null; clearErr("rec-err"); show("rec-intro"); };
    $("btn-rec-register").onclick = async () => {
      clearErr("rec-err");
      const b = $("btn-rec-register");
      b.disabled = true;
      b.textContent = "Approve with your passkey…";
      try {
        const prep = await api(`/api/users/${user.id}/recovery/candide/channels`, { channel: "email", target: user.email });
        const sig = await passkeySignPrepared(prep);
        const sent = await api(prep.submitTo, sig);
        otp = { submitTo: sent.submitTo };
        $("rec-target").textContent = sent.target;
        $("rec-code").value = "";
        show("rec-otp");
        $("rec-code").focus();
      } catch (e) { showErr("rec-err", e); }
      finally { b.disabled = false; b.textContent = "Register with my passkey"; }
    };
    $("btn-rec-confirm").onclick = async () => {
      if (!otp) return;
      clearErr("rec-err");
      const b = $("btn-rec-confirm");
      b.disabled = true;
      b.textContent = "Checking the code…";
      try {
        const r = await api(otp.submitTo, { otp: $("rec-code").value.trim() });
        otp = null;
        user = { ...user, ...r, recovery: undefined, next: undefined };
        if (r.next === "guardian") {
          b.textContent = "Approve the guardian with your passkey…";
          const prep = await api(`/api/users/${user.id}/recovery/candide/guardian`, {});
          const done = prep.challenge ? await api(prep.submitTo, await passkeySignPrepared(prep)) : prep;
          user = { ...user, ...done, recovery: undefined, status: undefined, opHash: undefined };
        }
        const active = user.passkeySafe?.candideRecovery?.guardianStatus === "active";
        $("rec-done-text").innerHTML = active
          ? `<b>Recovery is on.</b> A code to ${esc(user.email)} plus the waiting period can move this account to a new passkey. You can add a phone number from your profile.`
          : `<b>Your email is registered</b>, but the guardian is not on your smart wallet yet, so no recovery can run. One passkey approval from your profile finishes it.`;
        show("rec-done");
      } catch (e) {
        showErr("rec-err", e);
        // Five wrong codes end the registration server-side; the only way on
        // is to start over, and the button for that is on this pane.
        if (!otp) show("rec-intro");
      } finally { b.disabled = false; b.textContent = "Confirm"; }
    };
  });
}

async function createAccount(withPasskey) {
  clearErr("pk-err");
  try {
    if (!user?.id) {
      // ONE request. api() surfaces only the message, and a refusal needs the
      // CODE to pick its wording — so signup reads the response itself rather
      // than retrying to find out why the first attempt failed.
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingInfo),
      }).catch(() => null);
      if (!res) throw new Error("you appear to be offline — Zold could not be reached");
      const u = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A refusal is a destination, not a toast.
        if (res.status === 403 && String(u.code || "").startsWith("BLOCKED_")) {
          return showBlocked(u.code, u.error);
        }
        throw new Error(u.error || `could not create the account (HTTP ${res.status})`);
      }
      u.balanceEur = 0;
      u.safeBalanceEur = 0;
      user = u;
      renderUser(u);
    }
    if (withPasskey) {
      // Which checklist step is running, so a failure marks the step that
      // actually failed instead of implying the whole chain did.
      let step = 0;
      try {
        $("pk-steps").classList.remove("hidden");
        if (user.passkey) pkStep(0, "done");
        else {
          pkStep(0, "active");
          setPasskeyButtonBusy(true, "Creating passkey...");
          // Hard stop: some environments leave the WebAuthn ceremony pending
          // forever instead of rejecting — never strand the user on it.
          await Promise.race([
            registerPasskey(user),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("no response from your device — is a screen lock set up?")), 30000),
            ),
          ]);
          pkStep(0, "done");
        }
        step = 1;
        pkStep(1, "active");
        setPasskeyButtonBusy(true, "Approve smart wallet deployment...");
        await finishPasskeySafeSetup();
        pkStep(1, "done");
        // Only the hardhat harness auto-approves; a real account is pending
        // here and continues at the Monerium gate below.
        if (kycApproved(user) && !user.iban && (user.funding || {}).mode === "sandbox") {
          step = 2;
          pkStep(2, "active");
          setPasskeyButtonBusy(true, "Approve IBAN issuance...");
          await issueAppIban();
          pkStep(2, "done");
        }
      } catch (e) {
        pkStep(step, "fail");
        showErr(
          "pk-err",
          new Error(
            step === 0
              ? `passkey setup didn't complete (${e.message})`
              : step === 1
                ? `your passkey was created and is safe — only the smart wallet deployment failed (${e.message}). Press "Finish smart wallet" to retry; nothing needs to be registered again.`
                : `your passkey and smart wallet are ready — only IBAN issuance failed (${e.message}). Retry it from your account with "Activate IBAN".`,
          ),
        );
        if (step < 2) {
          setPasskeyButtonBusy(false, user?.passkey ? "Finish smart wallet" : "Create passkey & open account");
          return;
        }
        // Wallet is done; the IBAN can be retried from the dashboard.
      } finally {
        if (needsPasskeySafeSetup(user)) setPasskeyButtonBusy(false, "Finish smart wallet");
        else setPasskeyButtonBusy(false, "Create passkey & open account");
      }
      // Step 3, while the account is still pending at the Monerium gate:
      // the wallet exists and only this device can spend from it, so this
      // is the moment to give it a way back. Resolves at once where the
      // deployment has no recovery service.
      if (!needsPasskeySafeSetup(user)) await offerRecoveryEnrolment();
    }
    const displayName = pendingInfo?.name || user.name || "Account";
    if (!kycApproved(user)) return enterKycReview(displayName);
    enterProvisioning(displayName);
  } catch (e) { showErr("pk-err", e); }
}

$("btn-passkey").onclick = () => {
  if (passkeyOnboardingBusy) return;
  if (!window.PublicKeyCredential) {
    // No passkey, no account: there is nothing an account without one can
    // hold, and no skip path that lands somewhere useful.
    return showErr("pk-err", new Error("this browser doesn't support passkeys — open Zold in a browser with passkey support to create an account"));
  }
  createAccount(true);
};
$("btn-monerium-existing").onclick = () => startMoneriumConnect();
$("btn-monerium-keys").onclick = () => { keysFormOpen = true; clearErr("kyc-err"); renderKycState(user); };
$("btn-kyc-keys-back").onclick = () => { keysFormOpen = false; clearErr("kyc-err"); renderKycState(user); };
$("btn-kyc-keys-connect").onclick = connectMoneriumKeysAtGate;
$("btn-kyc-activate").onclick = activateIbanAtGate;
$("btn-kyc-reconnect").onclick = async () => {
  clearErr("kyc-err");
  try {
    const path = user.monerium?.method === "api_keys" ? "api-keys" : "connect";
    renderUser(await api(`/api/users/${user.id}/monerium/${path}`, undefined, "DELETE"));
    keysFormOpen = false;
    renderKycState(user);
  } catch (e) { showErr("kyc-err", e); }
};
$("btn-monerium-dashboard").onclick = () => activateConnectedMonerium();
$("btn-finish-safe").onclick = () => finishDashboardSmartWallet();
$("btn-kyc-refresh").onclick = () => refreshKycStatus({ continueWhenApproved: true });
$("btn-dash-kyc-refresh").onclick = async () => {
  await refresh();
  if (kycApproved(user)) enterDashboard(user.name);
};
$("btn-recovery-start").onclick = startRecoveryRequest;
$("m-pf-recovery").onclick = () => mobileNav("recovery");
$("m-pf-documents").onclick = () => mobileNav("documents");
$("m-pf-links").onclick = () => mobileNav("links");
$("btn-links").onclick = () => mobileNav("links");
$("m-det-receipt").onclick = async () => {
  const t = hist.find((x) => x.id === mDetailId);
  if (!t) return;
  try {
    const d = await api(`/api/users/${user.id}/documents/receipt`, { transferId: t.id });
    window.open(d.url, "_blank", "noopener");
  } catch (e) { $("m-det-error").textContent = e.message; $("m-det-error").classList.remove("hidden"); }
};
$("link-recover").onclick = (ev) => { ev.preventDefault(); rcState = null; showRecoverPanel(true); renderRecoverState(); };
$("link-rc-back").onclick = (ev) => { ev.preventDefault(); showRecoverPanel(false); };
$("btn-rc-start").onclick = recoverStart;

/* returning users: discoverable-credential sign-in */
$("link-signin").onclick = async (ev) => {
  ev.preventDefault();
  clearErr("create-err");
  try {
    if (!window.PublicKeyCredential) throw new Error("passkeys aren't supported in this browser");
    const { challenge } = await api("/api/webauthn/challenge", { purpose: "login" });
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(challenge),
        userVerification: "preferred",
        timeout: 60000,
      },
    });
    const u = await api("/api/passkey/login", {
      credentialId: cred.id,
      authenticatorData: b64url(cred.response.authenticatorData),
      clientDataJSON: b64url(cred.response.clientDataJSON),
      signature: b64url(cred.response.signature),
    });
    user = u;
    renderUser(user);
    if (kycApproved(user)) enterDashboard(user.name);
    else enterKycReview(user.name);
	  } catch (e) { showErr("create-err", e); }
		};

/**
 * /app?pay=<handle>/<code> — "Open in Zold" from a payment request page.
 *
 * Reads the public request and enters the SEPA send flow with the payee's
 * account, the amount and the reference filled in. Filled in, not hidden: the
 * IBAN is what the device signs a commitment over, so it stays on screen.
 */
async function handlePayDeepLink() {
  const qs = new URLSearchParams(location.search);
  const target = qs.get("pay");
  if (!target || !user) return;
  history.replaceState(null, "", location.pathname);
  const [handle, code] = target.split("/");
  if (!handle || !code) return;
  try {
    const p = await api(`/api/pay/${encodeURIComponent(handle)}/${encodeURIComponent(code)}`);
    const b = p.methods?.bank;
    if (!b) throw new Error("this request cannot be paid from a Zold account — it takes crypto only");
    if (p.state !== "OPEN") throw new Error(`this payment request is ${p.state.toLowerCase()}`);
    const amount = p.outstandingEur ?? Number(qs.get("amount") || 0);
    $("m-amount").value = amount > 0 ? String(amount) : "";
    startSend("sepa", { rail: "sepa", name: b.holder, id: b.iban, reference: b.reference });
  } catch (e) {
    alert(e.message);
  }
}

async function resumeSession() {
  if (!sessionToken) return;
  try {
    const u = await api("/api/session");
    renderUser(u);
    if (kycApproved(user)) enterDashboard(user.name);
    else enterKycReview(user.name);
    if (kycApproved(user)) await handlePayDeepLink();
  } catch {
    sessionToken = null;
    localStorage.removeItem("zold-session");
    localStorage.removeItem("zoll-session");
  }
}
