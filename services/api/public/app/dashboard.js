/**
 * The account, the older phone screens app/phone.js has not replaced yet (the
 * card, Zold Plus, settings), their routing, and converting a received
 * digital-dollar payment.
 */
/* ---------- account ---------- */
function renderUser(u) {
  if (u.sessionToken) {
    sessionToken = u.sessionToken;
    localStorage.setItem("zold-session", sessionToken);
  }
  user = u;
  renderKycState(u);
  $("balance").innerHTML = `<span class="cur">€</span>${fmt(u.balanceEur ?? 0)}`;
  $("safe-balance").textContent = `€${fmt(u.safeBalanceEur ?? 0)}`;
  $("vault-balance").textContent = `€${fmt(u.balanceEur ?? u.safeBalanceEur ?? 0)}`;
  const plannedSafe = needsPasskeySafeSetup(u) ? u.passkeySafe?.address : null;
  $("address").textContent = plannedSafe ? `planned ${shortAddr(plannedSafe)} — finish smart wallet` : u.address;
  document.querySelector('[data-copy="address"]')?.classList.toggle("hidden", !!plannedSafe);
  renderHandle(u.paymentPage);
  const chip = $("fund-chip");
  if (!kycApproved(u)) {
    $("iban").textContent = kycCopy(u.kycStatus, u)[2];
    chip.textContent = "KYC"; chip.className = u.kycStatus === "rejected" ? "chip err" : "chip review";
  } else if (u.iban) {
    $("iban").textContent = u.iban;
    chip.textContent = "ACTIVE"; chip.className = "chip ok";
  } else if ((u.funding || {}).status === "error") {
    $("iban").textContent = (u.funding.detail || "provisioning failed").slice(0, 60);
    chip.textContent = "ERROR"; chip.className = "chip err";
  } else {
    $("iban").textContent = `${(u.funding || {}).detail || "waiting for Monerium"}…`;
    chip.textContent = "PENDING"; chip.className = "chip pend";
  }
  renderFundingActions(u);
  renderFundCard();
  renderPrivacyBundle();
  renderShellPages();
  renderMobile(u);
}

/* ==========================================================================
   MOBILE APP
   --------------------------------------------------------------------------
   Home, Activity, Send, Add money, Get paid, Contacts and More are
   app/phone.js. What stays here: the older screens it has not replaced yet
   (the card, Zold Plus, settings and what hangs off it) and their routing.
   ========================================================================== */

function renderMobile(u = user) {
  if (!u) return;
  /* Zold Plus is a preview: the tier in the design (card, no-FX-margin, vault
     boost) is not built, so it carries no price. The Privacy Bundle that DOES
     ship is reported on the Plus screen itself. */
  const sub = u.privacyBundle;
  const active = sub && sub.status !== "canceled";
  const plan = active ? bundlePlan(sub.planId) : null;
  applySegment();
  $("m-card-name").textContent = ownAccountName(u).toUpperCase() || "—";
  const cheapest = privacyCatalog?.plans?.[0];
  $("m-bundle-sub").textContent = active
    ? `${plan ? plan.name : "Subscribed"} · ${sub.status === "pending_fulfillment" ? "awaiting partner setup" : "active"}`
    : cheapest ? `eSIM and VPN, live today from €${cheapest.priceEur}` : "eSIM and VPN, live today";
  // The phone screens (app/phone.js) redraw from the same account.
  phRefresh();
}

/** Any screen by its older name. The ones app/phone.js draws go there (so
 *  the older screens' back buttons land on the new Home, Activity …); the
 *  rest open here. */
function mobileNav(target) {
  const v2 = PH_FROM_LEGACY[target];
  if (v2) {
    const r = phParse(`#${v2}`);
    return phGo(r.name, r.arg);
  }
  return mobileNavLegacy(target);
}

/** Routing of the older screens. `msub` names the sub-screen. */
function mobileNavLegacy(target) {
  const shell = $("dashboard");
  const sub = { plus: "plus", bundle: "bundle", payment: "payment", share: "share", card: "card",
    monerium: "monerium", recovery: "recovery", documents: "documents", signers: "signers" }[target];
  if (!sub) return phGo("settings");
  shell.dataset.msub = sub;
  switchView("dashboard");
  if (sub === "payment") { $("m-subtitle").textContent = "Payment page"; renderHandle(user?.paymentPage); }
  if (sub === "bundle") $("m-subtitle").textContent = "Zold Plus";
  if (sub === "card") renderCardScreen();
  if (sub === "share") renderShareScreen();
  if (sub === "monerium") renderMoneriumScreen();
  if (sub === "recovery") renderRecoveryScreen();
  if (sub === "documents") renderDocumentsScreen();
  if (sub === "signers") renderSignersScreen();
  $("dashboard").querySelector(".main").scrollTop = 0;
}

/* ==========================================================================
   PER-SEGMENT RENDERING
   --------------------------------------------------------------------------
   A user never sees a feature their segment does not include.
   --------------------------------------------------------------------------
   Presentation only. Every feature hidden here is also refused by the
   server's capability guard (requireCapability in server.ts), so a crafted
   request gets a 403. Don't make this the only check.

   The client gets `capabilities`, never the rule that produced them, so a
   reader cannot learn which input to change.
   ========================================================================== */
const HAS = (cap) => (user?.segment?.capabilities ?? [
  // A pre-segmentation account keeps everything, matching the server's
  // migration fallback.
  "monerium", "gnosis_pay", "safe", "card", "onchain_balance",
]).includes(cap);

function applySegment() {
  // Home, Send and Add money read the capabilities themselves (app/phone.js);
  // this is what is left of the older layout.
  $("btn-send")?.classList.toggle("hidden", !HAS("onchain_balance"));
}

/* ==========================================================================
   CARD — a connected Gnosis Pay account, not a Zold card
   --------------------------------------------------------------------------
   Gnosis Pay issues the card, holds its KYC and owns the card Safe. In
   permissionless mode there are no webhooks and no attribution of card
   activity back to Zold, so:

     1. Never imply Zold issued it. The provenance line is rendered on every
        state, including errors.
     2. Every figure shows when it was read. Nothing pushes updates, so a
        balance without a timestamp would look live when it is not.

   The JWT lives in this page's memory only. It is a bearer credential for the
   user's third-party account: never write it to localStorage (an XSS would own
   their card account for an hour) and never persist it server side. A reload
   means signing in again, and the screen says so.

   The signature comes from the user's own browser wallet. Zold's passkey Safe
   cannot sign here yet: an EIP-1271 signature is only verifiable where the
   contract is deployed, and the Zold Safe is not on Gnosis Chain.
   ========================================================================== */
let gpToken = null;          // in-memory only, deliberately
let gpAccount = null;

const gpApi = async (path, body, method) => {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (gpToken) headers["x-gnosis-pay-token"] = gpToken;
  const res = await fetch(`/api/gnosis-pay${path}`, {
    ...(body ? { method: method ?? "POST", body: JSON.stringify(body) } : method ? { method } : {}),
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (HTTP ${res.status})`);
    err.reauth = Boolean(data.reauth);
    throw err;
  }
  return data;
};

/** Minor-unit integer strings, kept as strings. Their format is documented as
 *  ^[0-9]+$; parseFloat on a balance is how a cent goes missing. */
function gpAmount(minor) {
  if (typeof minor !== "string" || !/^[0-9]+$/.test(minor)) return "—";
  const pad = minor.padStart(3, "0");
  return `€${pad.slice(0, -2)}.${pad.slice(-2)}`;
}

const gpWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function renderCardScreen() {
  const el = $("m-card-body");
  const connected = user?.gnosisPay || null;

  if (!gpToken) {
    // Not signed in to Gnosis Pay this session. Show the stored status and
    // when it was seen, but never a balance from it: it may be stale.
    el.innerHTML = `
      <div class="m-rows">
        ${connected ? `
          <div class="m-row"><span class="k">Connected wallet</span><span class="v">${esc(shortAddr(connected.connectedAddress))}</span></div>
          ${connected.safeAddress ? `<div class="m-row"><span class="k">Gnosis Pay Safe</span><span class="v">${esc(shortAddr(connected.safeAddress))}</span></div>` : ""}
          ${connected.kycStatus ? `<div class="m-row"><span class="k">Their KYC</span><span class="v">${esc(connected.kycStatus)}</span></div>` : ""}
          <div class="m-row"><span class="k">Last seen</span><span class="v">${esc(gpWhen(connected.asOf) || "—")}</span></div>
        ` : `
          <div class="m-row"><span class="k">Status</span><span class="v">Not connected</span></div>
        `}
      </div>
      <div class="m-lede" style="font-size:13px;margin-top:16px">
        ${connected
          ? "Your Gnosis Pay session ended. Sign in again with the same wallet to see cards and balances."
          : "Connect a Gnosis Pay account you already have. Zold does not create one for you."}
      </div>
      <button class="m-cta" id="m-card-signin" style="margin-top:16px">Sign in with wallet</button>
      <div class="m-err hidden" role="alert" id="m-card-err" style="margin-top:12px"></div>
      <div class="m-lede" style="font-size:12px;margin-top:20px;color:var(--m-dim)">
        Gnosis Pay issues and operates this card and holds its KYC. Zold shows your connected account
        and cannot see card activity except when you open this screen.
      </div>`;
    $("m-card-signin").onclick = gpSignIn;
    return;
  }

  const a = gpAccount || {};
  const cards = Array.isArray(a.cards) ? a.cards : [];
  const b = a.balances || null;
  el.innerHTML = `
    <div class="m-rows">
      <div class="m-row"><span class="k">Spendable</span><span class="v">${b ? esc(gpAmount(b.spendable)) : "—"}</span></div>
      <div class="m-row"><span class="k">Pending</span><span class="v">${b ? esc(gpAmount(b.pending)) : "—"}</span></div>
      <div class="m-row"><span class="k">Total</span><span class="v">${b ? esc(gpAmount(b.total)) : "—"}</span></div>
      ${a.user?.safeAddress ? `<div class="m-row"><span class="k">Gnosis Pay Safe</span><span class="v">${esc(shortAddr(a.user.safeAddress))}</span></div>` : ""}
      ${a.user?.kycStatus ? `<div class="m-row"><span class="k">Their KYC</span><span class="v">${esc(a.user.kycStatus)}</span></div>` : ""}
    </div>
    ${!b ? `<div class="m-lede" style="font-size:13px;margin-top:12px">No balance yet — Gnosis Pay has not deployed a card Safe for this account.</div>` : ""}
    <div class="m-sec" style="margin-top:24px"><div class="m-mono">Cards</div></div>
    ${cards.length
      ? `<div class="m-rows">${cards.map((c) => `
          <div class="m-row">
            <span class="k">${c.virtual ? "Virtual" : "Physical"} ·••••&nbsp;${esc(c.lastFourDigits || "····")}</span>
            <span class="v">${esc(c.statusName || "—")}</span>
          </div>`).join("")}</div>`
      : `<div class="m-empty">No cards on this account yet. Create one in Gnosis Pay.</div>`}
    <div class="m-lede" style="font-size:12px;margin-top:20px;color:var(--m-dim)">
      Read at ${esc(gpWhen(a.asOf) || "—")}. Gnosis Pay issues and operates this card and holds its KYC —
      there are no live updates here, so this is a snapshot, not a running balance.
    </div>
    <button class="m-link" id="m-card-refresh" style="margin-top:12px">Refresh</button>
    <button class="m-link" id="m-card-forget" style="margin-top:12px">Disconnect</button>
    <div class="m-err hidden" role="alert" id="m-card-err" style="margin-top:12px"></div>`;
  $("m-card-refresh").onclick = () => gpLoadAccount().catch((e) => showErr("m-card-err", e));
  $("m-card-forget").onclick = gpDisconnect;
}

async function gpSignIn() {
  clearErr("m-card-err");
  const eth = window.ethereum;
  if (!eth) {
    return showErr("m-card-err", new Error(
      "no browser wallet found. Gnosis Pay sign-in needs a wallet that can sign a message on Gnosis Chain.",
    ));
  }
  try {
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("no account was shared by the wallet");
    // The server fetches the nonce and hands back BOTH the message and the
    // cookie it is bound to — Gnosis Pay verifies the signature against the
    // session that issued the nonce, so the cookie must ride back with it.
    const { message, cookie } = await gpApi("/siwe/start", { address });
    const signature = await eth.request({ method: "personal_sign", params: [message, address] });
    const out = await gpApi("/siwe/verify", { message, signature, cookie });
    gpToken = out.token;
    if (out.connected && user) user.gnosisPay = out.connected;
    await gpLoadAccount();
  } catch (err) {
    showErr("m-card-err", err.code === 4001 ? new Error("signature request was rejected") : err);
  }
}

async function gpLoadAccount() {
  try {
    gpAccount = await gpApi("/account");
    renderCardScreen();
    } catch (err) {
    if (err.reauth) { gpToken = null; gpAccount = null; renderCardScreen(); }
    throw err;
  }
}

async function gpDisconnect() {
  try {
    await gpApi("/connection", undefined, "DELETE");
  } catch { /* forgetting is best-effort; the token is dropped either way */ }
  gpToken = null;
  gpAccount = null;
  if (user) user.gnosisPay = undefined;
  renderCardScreen();
}


/**
 * Euros as typed, to the cent, or NaN. A comma is a decimal separator: this
 * is a euro app and a German keyboard's inputmode=decimal types "120,50",
 * which Number() refused while the screen only said "Enter an amount". No
 * exponents ("1e3") and nothing below a cent, which priced as €0.00.
 */
function parseEurInput(raw) {
  const v = String(raw ?? "").replace(/\s/g, "");
  if (!/^\d+([.,]\d{0,2})?$/.test(v)) return NaN;
  const n = Number(v.replace(",", "."));
  return n >= 0.01 ? n : NaN;
}

/* Why parseEurInput refused what was typed, in the words that fix it. */
function eurInputError(raw, example = "120,50") {
  const v = String(raw ?? "").replace(/\s/g, "");
  if (/^-/.test(v)) return "The amount can’t be negative.";
  if (/^\d+[.,]\d{3,}$/.test(v)) return `Use at most two decimals for cents, like ${example}.`;
  if (/^\d+([.,]\d*)?$/.test(v)) return "Enter more than €0.00.";
  return `Enter euros and cents, like ${example}.`;
}
