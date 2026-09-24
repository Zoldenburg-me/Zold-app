/**
 * The account, the mobile shell, and the screens reachable from the bottom
 * nav: home, add funds, the bank and crypto panes, the card tile, the Pay hub
 * and the send flow's own screens.
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
  renderAutoConvert(u.paymentPage?.autoConvert);
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
   MOBILE APP — "Noir" home
   --------------------------------------------------------------------------
   Renders the design's dashboard from real account state. Where the design
   shows something the API cannot back, this says so rather than inventing a
   figure — the savings vault and USD accounts are marked SOON, and Zold Plus
   is bound to the privacy bundle that actually exists rather than the design's
   €7.99 card tier.
   ========================================================================== */

/** The design's three figures, mapped onto what the API reports.
 *
 *  There is one balance: the EURe in the user's Safe. Don't add a second pot
 *  to the arithmetic; a permanent zero reads as if one existed.
 *
 *  "Total" and "available" are the same number because an in-flight transfer
 *  has already moved its EURe out of the Safe. "In flight" is summed from
 *  transfers past CREATED but not yet terminal; nothing on-chain reports it. */
function mobileFigures(u) {
  const safe = u.safeBalanceEur ?? u.balanceEur ?? 0;
  const live = ["DEBITED", "SWAPPED", "BRIDGED", "PAYOUT_DETAILS_PENDING", "PAYOUT_FUNDING_PENDING",
    "PAYOUT_FUNDED", "PAYOUT_READY", "PAYOUT_SUBMITTED"];
  const inflight = hist.filter((t) => live.includes(t.state)).reduce((n, t) => n + (t.sendEur || 0), 0);
  return { total: safe, available: u.balanceEur ?? safe, inflight };
}

function renderMobile(u = user) {
  if (!u) return;
  const name = u.name || "Account";
  $("m-name").textContent = name;
  $("m-initials").textContent = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "—";

  const approved = kycApproved(u);
  const dotColour = approved ? "var(--m-mint)" : u.kycStatus === "rejected" ? "var(--m-pink)" : "var(--m-amber)";
  const dot = $("m-kyc-dot");
  dot.style.background = dotColour;
  dot.style.boxShadow = `0 0 8px ${dotColour}`;
  $("m-kyc-label").textContent = approved ? "Verified" : u.kycStatus === "rejected" ? "Not verified" : "Verification pending";
  $("m-kyc-label").style.color = approved ? "var(--m-mint)" : u.kycStatus === "rejected" ? "var(--m-pink)" : "var(--m-amber)";
  $("m-kyc-banner").classList.toggle("hidden", approved);

  // Approved but no IBAN yet: surface the activation the desktop card hides.
  // The same tap finishes an undeployed smart wallet first — the two are one
  // chain for the user, and splitting them made each look broken.
  const wantsIban =
    approved && !u.iban && (u.funding || {}).mode === "sandbox" && !(u.funding || {}).addressUnlinkable;
  $("m-iban-banner").classList.toggle("hidden", !wantsIban);
  if (wantsIban) {
    const safePending = needsPasskeySafeSetup(u);
    $("m-iban-banner-title").textContent = safePending ? "Finish your smart wallet" : "Activate your IBAN";
    $("m-iban-banner-sub").textContent = safePending
      ? "Deploy the wallet, then one passkey approval issues your IBAN."
      : "One passkey approval issues your account IBAN.";
  } else {
    $("m-iban-err").classList.add("hidden");
  }

  const f = mobileFigures(u);
  $("m-total").textContent = fmt(f.total);
  $("m-available").textContent = `€${fmt(f.available)}`;
  $("m-inflight").textContent = `€${fmt(f.inflight)}`;

  const addr = u.address && u.address !== "0x0000000000000000000000000000000000000000" ? u.address : "";
  $("m-addr").classList.toggle("hidden", !addr);
  if (addr) $("m-addr-short").textContent = `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  /* Zold Plus is a preview: the tier in the design (card, no-FX-margin, vault
     boost) is not built, so the tile carries no price. The Privacy Bundle that
     DOES ship is reported on the Plus screen itself. */
  const sub = u.privacyBundle;
  const active = sub && sub.status !== "canceled";
  const plan = active ? bundlePlan(sub.planId) : null;
  $("m-plus-tag").textContent = "SOON";
  $("m-plus-tag").className = "m-tag soon";
  $("m-plus-title").textContent = "Coming soon";
  $("m-plus-sub").textContent = "Card · VPN · eSIM";
  const page = u.paymentPage;
  $("m-paypage-tag").textContent = page?.handle ? "LIVE" : "SETUP";
  $("m-paypage-tag").className = `m-tag${page?.handle ? " on" : ""}`;
  $("m-paypage-title").textContent = page?.handle ? `/${page.handle}` : "Create link";
  $("m-paypage-sub").textContent = page?.handle
    ? `${page.settlementAsset || "USDC"} settlement`
    : "Get paid by QR";
  renderCardTile();
  applySegment();
  $("m-card-name").textContent = (u.name || "").toUpperCase() || "—";
  const cheapest = privacyCatalog?.plans?.[0];
  $("m-bundle-sub").textContent = active
    ? `${plan ? plan.name : "Subscribed"} · ${sub.status === "pending_fulfillment" ? "awaiting partner setup" : "active"}`
    : cheapest ? `eSIM and VPN, live today from €${cheapest.priceEur}` : "eSIM and VPN, live today";
}

/**
 * One transfer as an activity row.
 *
 * The dashboard's "recent" list and the Activity screen render the SAME
 * component. The design file draws them differently, but two row shapes show
 * one transfer two ways depending on which screen you are on.
 */
function mTxStatus(t) {
  const inFlight = !["PAID", "REFUNDED", "FAILED", "MANUAL_REVIEW"].includes(t.state);
  return {
    inFlight,
    label: t.state === "PAID" ? "PAID" : t.state === "REFUNDED" ? "REFUNDED"
      : t.state === "FAILED" ? "FAILED" : t.state === "MANUAL_REVIEW" ? "IN REVIEW" : "IN FLIGHT",
    colour: inFlight ? "var(--m-pink)" : t.state === "PAID" ? "var(--m-faint)" : "var(--m-amber)",
  };
}

function mTxRow(t) {
  if (t.kind === "funding") {
    const when = new Date(t.at || t.detectedAt).toLocaleDateString("en", { day: "numeric", month: "short" });
    const token = t.token === "USDC" ? "USDC" : "EURe";
    const amount = t.token === "USDC" ? `${fmt(t.amountUsdc || 0)} USDC` : `€${fmt(t.amountEur || 0)}`;
    const refused = t.state === "REFUSED";
    return `<div class="m-row">
    <span class="cc">IN</span>
    <span style="flex:1;min-width:0">
      <span class="who" style="display:block">${token} funding</span>
      <span class="sub" style="display:block">${esc(when)} · ${esc(shortAddr(t.txHash || ""))}</span>
    </span>
    <span style="text-align:right;flex:none">
      <span class="amt m-fig" style="display:block">+${esc(amount)}</span>
      <span class="st" style="display:block;color:${refused ? "var(--m-amber)" : "var(--m-mint)"}">${refused ? "REVIEW" : "RECEIVED"}</span>
    </span>
  </div>`;
  }
  const sepa = t.rail === "sepa";
  const st = mTxStatus(t);
  const when = new Date(t.createdAt).toLocaleDateString("en", { day: "numeric", month: "short" });
  const recv = sepa ? `€${fmt(t.receiveEur ?? 0)}` : `${fmt(t.receiveKes ?? 0)} KES`;
  return `<button class="m-row" data-mtx="${esc(t.id)}">
    <span class="cc">${sepa ? "EU" : "KE"}</span>
    <span style="flex:1;min-width:0">
      <span class="who" style="display:block">${esc(t.recipientName || "—")}</span>
      <span class="sub" style="display:block">${sepa ? "SEPA" : "MoneyGram cash"} · ${esc(when)} · ${esc(recv)}</span>
    </span>
    <span style="text-align:right;flex:none">
      <span class="amt m-fig" style="display:block">−€${fmt(t.sendEur)}</span>
      <span class="st" style="display:block;color:${st.colour}">${st.label}</span>
    </span>
  </button>`;
}

/** Wire every row in a container to open the transaction detail screen. */
function bindTxRows(el) {
  el.querySelectorAll("[data-mtx]").forEach((b) => {
    b.onclick = () => openTransferDetail(b.dataset.mtx);
  });
}

/** Recent activity on the dashboard, newest first. */
function renderMobileActivity() {
  const el = $("m-recent");
  if (!el) return;
  if (!hist.length) { el.innerHTML = '<div class="m-empty">No transfers yet</div>'; return; }
  el.innerHTML = hist.slice(0, 5).map(mTxRow).join("");
  bindTxRows(el);
}

/** Routing. `msub` names the sub-screen; tab switches clear it. */
function mobileNav(target) {
  const shell = $("dashboard");
  // "send" enters the flow at its first screen.
  const sub = { add: "add", bank: "bank", crypto: "crypto", send: "pay", pay: "pay", country: "country",
    method: "method", amount: "amount", recipient: "recipient", progress: "progress",
    plus: "plus", bundle: "bundle", payment: "payment", activity: "activity", detail: "detail",
    share: "share", profile: "profile", card: "card", monerium: "monerium", recovery: "recovery", documents: "documents",
    links: "links" }[target];
  shell.dataset.msub = sub || "home";
  if (!sub) switchView(target === "home" ? "dashboard" : target === "activity" ? "transactions" : "settings");
  else switchView("dashboard");
  // bank/crypto are inside Add, so the Add tab stays lit while they are open.
  const navFor = { add: "add", bank: "add", crypto: "add", send: "send", pay: "send", country: "send", method: "send",
    amount: "send", recipient: "send", progress: "send", plus: "home", bundle: "home", payment: "home",
    card: "home", home: "home", activity: "activity", detail: "activity", share: "activity",
    profile: "profile", monerium: "profile", recovery: "profile", documents: "profile", links: "home" }[target];
  document.querySelectorAll("#m-nav button").forEach((b) => b.classList.toggle("active", b.dataset.mnav === navFor));
  if (sub === "payment") { $("m-subtitle").textContent = "Payment page"; renderHandle(user?.paymentPage); }
  if (sub === "bundle") $("m-subtitle").textContent = "Zold Plus";
  if (sub === "bank") renderBankScreen();
  if (sub === "crypto") { renderCryptoScreen(); renderDeposits(); }
  if (sub === "card") renderCardScreen();
  if (sub === "pay") { $("m-pay-q").value = ""; renderPayScreen(); }
  if (sub === "country") { $("m-country-q").value = ""; renderCountryList(); }
  if (sub === "activity") renderActivityScreen();
  if (sub === "detail") renderDetailScreen();
  if (sub === "share") renderShareScreen();
  if (sub === "profile") renderProfileScreen();
  if (sub === "monerium") renderMoneriumScreen();
  if (sub === "recovery") renderRecoveryScreen();
  if (sub === "documents") renderDocumentsScreen();
  if (sub === "links") renderLinksScreen();
  $("dashboard").querySelector(".main").scrollTop = 0;
}

/**
 * The SEPA details to transfer to.
 *
 * No BIC row, unlike the design: Monerium does not give us one and inventing a
 * plausible-looking bank identifier is the kind of detail someone would try to
 * pay against. No reference row either — deposits are matched by IBAN, so
 * asking for a reference would imply a requirement that does not exist.
 */
function renderBankScreen() {
  const u = user || {};
  const rows = [
    { k: "IBAN", v: u.iban || "Not issued yet", copy: !!u.iban },
    { k: "Account holder", v: u.name || "—", copy: false },
    // Two institutions, named as Monerium's own terms name them (s. 5 and
    // s. 1.1): the IBAN and the SEPA rail belong to AS LHV Pank, the e-money
    // itself to Monerium. Calling Monerium "the bank" was wrong on both.
    { k: "IBAN & SEPA provided by", v: "AS LHV Pank · Tallinn, Estonia", copy: false },
    { k: "E-money issuer", v: "Monerium · Reykjavík, Iceland", copy: false },
  ];
  $("m-bank-rows").innerHTML = rows.map((r, i) => `
    <div class="m-detrow">
      <div style="flex:1;min-width:0">
        <div class="m-rowk">${esc(r.k)}</div>
        <div class="m-rowv">${esc(r.v)}</div>
      </div>
      ${r.copy ? `<button class="m-copybtn" data-mcopy="${i}">Copy</button>` : ""}
    </div>`).join("");
  $("m-bank-rows").querySelectorAll("[data-mcopy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(rows[Number(b.dataset.mcopy)].v); } catch { return; }
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy"; }, 1400);
    };
  });
  $("m-bank-note").textContent = u.iban
    ? "Deposits are real SEPA transfers to your Monerium IBAN. They are picked up automatically once Monerium has minted the euros to your wallet."
    : "Your IBAN appears here once your Monerium account is connected and the IBAN is activated.";
}


/** Deposit address for inbound USDC, with the payment-page QR when the account
 *  has claimed a handle (that endpoint is keyed by handle, and it encodes this
 *  same address). */
function renderCryptoScreen() {
  const u = user || {};
  const page = u.paymentPage || {};
  $("m-wallet").textContent = page.depositAddress || u.address || "—";
  const wrap = $("m-qr-wrap");
  wrap.innerHTML = page.handle
    ? `<div style="padding:16px;border-radius:12px;background:#efdfe1">
         <img src="/api/pay/${encodeURIComponent(page.handle)}/qr.svg" width="168" height="168" alt="Deposit address QR" style="display:block;width:168px;height:168px" />
       </div>`
    : `<div class="m-lede" style="font-size:13px;margin:0;text-align:center;max-width:280px">Claim a payment handle to get a scannable code. The address below works either way.</div>`;
  const settlesTo = page.settlementAsset || "USDC";
  $("m-crypto-warn").textContent = !page.autoConvert
    ? "Base network only. Auto-settlement is off, so USDC stays in your Safe."
    : settlesTo === "EURE"
      ? "Base network only. USDC is converted to EURe at the live mid rate on arrival."
      : "Base network only. USDC is forwarded to your Safe and recorded as USDC settlement.";
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
  const gate = user?.segment?.gate;

  // Send and the whole corridor need an on-chain balance to spend.
  for (const id of ["m-nav-send", "btn-send", "m-payment-page"]) {
    const el = $(id);
    if (el) el.classList.toggle("hidden", !HAS("onchain_balance"));
  }
  document.querySelectorAll('#m-nav button[data-mnav="send"]').forEach((b) => {
    b.classList.toggle("hidden", !HAS("onchain_balance"));
  });

  // The card tile is Gnosis Pay's, so it follows that capability.
  const cardTile = $("m-card-tile");
  if (cardTile) cardTile.classList.toggle("hidden", !HAS("gnosis_pay"));

  // Add-funds routes into Monerium (bank) and the Safe (crypto).
  for (const id of ["m-go-bank", "m-go-crypto"]) {
    const el = $(id);
    if (el) el.classList.toggle("hidden", !HAS("monerium") && !HAS("onchain_balance"));
  }

  let panel = $("segment-gate");
  if (gate) {
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "segment-gate";
      panel.className = "m-notice";
      const home = $("m-home");
      if (home) home.prepend(panel);
    }
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span class="m-tag soon">NOT OPEN</span>
        <div style="font-size:13.5px;font-weight:600">${esc(gate.reason)}</div>
      </div>
      <div class="body">${esc(gate.needs)}</div>
      <a class="cta" href="mailto:support@zoldhq.com">Ask us about it</a>`;
  } else if (panel) {
    panel.remove();
  }
}

/* ==========================================================================
   RECEIVED PAYMENTS — arrive automatically, convert on approval
   --------------------------------------------------------------------------
   "Auto-convert" cannot mean unattended. Moving the user's USDC is a
   UserOperation their passkey signs, and the poller that spots the deposit
   runs with nobody present. So deposits are detected automatically and
   converted when the account holder approves, and the screen says so.

   Pending conversions are surfaced prominently. A German company books crypto
   income at its EUR value on the day it arrives, and converting later realises
   a gain or loss against that value; converting promptly keeps it near zero.
   The UI does not explain the tax reasoning.
   ========================================================================== */
let depositsCache = [];

const dEur = (n) => (typeof n === "number" ? `€${n.toFixed(2)}` : "—");

async function renderDeposits() {
  const el = $("m-deposits");
  if (!el || !user?.id) return;
  let data;
  try {
    data = await api(`/api/users/${user.id}/crypto-deposits`);
  } catch (err) {
    el.innerHTML = `<div class="m-empty">${esc(err.message)}</div>`;
    return;
  }
  depositsCache = data.deposits ?? [];
  if (!depositsCache.length) {
    el.innerHTML = `<div class="m-empty">Nothing received yet. Payments show up here within a minute of arriving.</div>`;
    return;
  }

  el.innerHTML = depositsCache.map((d) => {
    const pending = d.state === "DETECTED";
    const refused = d.state === "REFUSED";
    const amount = d.token === "USDC" ? `${d.amountUsdc ?? 0} USDC` : dEur(d.amountEur);
    // Show what it was WORTH at receipt, not just what arrived — that figure is
    // the one the books are built on, and it is already recorded.
    const worth = d.receipt ? ` · worth ${dEur(d.receipt.amountEur)} on arrival` : "";
    const settled = d.state === "CONVERTED" && d.creditedEur !== undefined
      ? `<div class="m-row"><span class="k">Converted</span><span class="v">${esc(dEur(d.creditedEur))}</span></div>`
      : "";
    const gain = typeof d.realisedGainEur === "number"
      ? `<div class="m-row"><span class="k">Difference since arrival</span><span class="v">${esc(dEur(d.realisedGainEur))}</span></div>`
      : "";
    return `
      <div class="m-rows" style="margin-bottom:12px">
        <div class="m-row">
          <span class="k">${esc(amount)}${esc(worth)}</span>
          <span class="v">${pending ? "Awaiting approval" : refused ? "Needs attention" : "Settled"}</span>
        </div>
        ${settled}${gain}
        ${d.reason ? `<div class="m-row"><span class="k" style="line-height:1.45">${esc(d.reason)}</span></div>` : ""}
        ${pending ? `<button class="m-cta" data-convert="${esc(d.id)}" style="margin:12px">Convert to euro</button>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll("[data-convert]").forEach((b) => {
    b.onclick = () => convertDeposit(b.dataset.convert, b);
  });
}

/**
 * Convert one deposit: prepare the batch, sign its hash with the passkey,
 * submit.
 *
 * One deposit at a time. Each conversion is its own disposal with its own rate
 * and transaction, so each payment traces one-to-one to what it became. Don't
 * batch several into one swap to save a signature.
 */
async function convertDeposit(depositId, btn) {
  const label = btn?.textContent;
  const setBusy = (t) => { if (btn) { btn.disabled = true; btn.textContent = t; } };
  try {
    setBusy("Preparing…");
    const prep = await api(`/api/users/${user.id}/crypto-deposits/${depositId}/convert/prepare`, {});
    setBusy(`Approve ${dEur(prep.expectedEur)}…`);

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(prep.challenge),
        rpId: location.hostname,
        allowCredentials: prep.credentialId
          ? [{ type: "public-key", id: b64urlToBytes(prep.credentialId) }]
          : [],
        userVerification: "required",
      },
    });
    if (!assertion) throw new Error("no passkey response");

    setBusy("Converting…");
    const out = await api(`/api/users/${user.id}/crypto-deposits/${depositId}/convert`, {
      executionAssertion: {
        credentialId: prep.credentialId,
        // b64url and b64urlToBytes are declared further down the file. Safe:
        // both are only reached from a click or a navigation, long after the
        // script has finished evaluating.
        authenticatorData: b64url(assertion.response.authenticatorData),
        clientDataJSON: b64url(assertion.response.clientDataJSON),
        signature: b64url(assertion.response.signature),
      },
    });
    if (out.safeBalanceEur !== undefined) {
      user.safeBalanceEur = out.safeBalanceEur;
      user.balanceEur = out.balanceEur ?? out.safeBalanceEur;
      renderUser(user);
    }
    await renderDeposits();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = label || "Convert to euro"; }
    // The passkey being cancelled is not an error worth a red banner — the
    // user changed their mind, and the deposit is exactly where it was.
    if (err?.name === "NotAllowedError") return;
    alert(err.message || "could not convert this payment");
  }
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
      <div class="m-err hidden" id="m-card-err" style="margin-top:12px"></div>
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
    <div class="m-err hidden" id="m-card-err" style="margin-top:12px"></div>`;
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
    renderCardTile();
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
  renderCardTile();
}

/** The home tile. Shows connection state only — never a balance, because the
 *  home screen has no way to say how old it is. */
function renderCardTile() {
  const tag = $("m-card-tag"), title = $("m-card-title"), sub = $("m-card-sub");
  if (!tag) return;
  const c = user?.gnosisPay;
  if (gpToken && gpAccount) {
    tag.textContent = "ON";
    tag.className = "m-tag";
    title.textContent = (gpAccount.cards?.length ? `${gpAccount.cards.length} card` : "No card");
    sub.textContent = "Gnosis Pay · tap to view";
  } else if (c) {
    tag.textContent = "—";
    tag.className = "m-tag";
    title.textContent = "Sign in";
    sub.textContent = "Gnosis Pay · connected";
  } else {
    tag.textContent = "—";
    tag.className = "m-tag";
    title.textContent = "Connect";
    sub.textContent = "Gnosis Pay";
  }
}

/* ==========================================================================
   SEND FLOW — country → method → amount → recipient → progress
   --------------------------------------------------------------------------
   Quotes come from POST /api/quotes, the payment is signed by the device key
   as in the desktop flow, and the timeline follows the transfer's state. The
   design's 182 corridors and four rails are not here; the API prices two.
   ========================================================================== */
const M_DESTINATIONS = [
  { cc: "EU", name: "Europe", cur: "EUR", rail: "sepa", sub: "SEPA · EUR", eta: "Seconds – 1 day" },
  { cc: "KE", name: "Kenya", cur: "KES", rail: "cash", sub: "MoneyGram · KES", eta: "Minutes" },
];
const M_METHODS = {
  sepa: { icon: "account_balance", title: "Bank transfer (IBAN)", sub: "To any account in the SEPA zone" },
  cash: { icon: "payments", title: "Cash pickup (MoneyGram)", sub: "Collect at any agent" },
};
let mSend = { dest: null, quote: null, rec: { name: "", iban: "", phone: "" }, transfer: null, prefill: null };
let mQuoteTimer = null;

/* ==========================================================================
   PAY HUB
   --------------------------------------------------------------------------
   The design's four rails and its @zoldtag directory are not all here. What
   the API can do is send EUR over SEPA and cash to Kenya, so those two are
   live and the other two say so; and the only recipients this app knows about
   are the ones this account has paid, so that is what the search searches.
   Anything picked here lands on the amount step with the recipient carried,
   and the recipient step is still the one that validates it.
   ========================================================================== */

/** Recipients this account has actually paid, newest first, one per identity. */
function mPayees() {
  const seen = new Map();
  for (const t of hist) {
    const id = t.rail === "sepa" ? t.recipientIban : t.recipientPhone;
    const key = `${t.rail}:${(id || t.recipientName || "").toLowerCase()}`;
    if (!id || seen.has(key)) continue;
    seen.set(key, {
      key, rail: t.rail, name: t.recipientName || "—", id,
      masked: id.length > 12 ? `${id.slice(0, 4)} ···· ${id.slice(-4)}` : id,
      initials: (t.recipientName || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase(),
    });
  }
  return [...seen.values()];
}

const M_RAILS = [
  { id: "sepa", icon: "account_balance", t: "Bank", d: "SEPA to an IBAN", live: true, accent: true },
  { id: "cash", icon: "public", t: "International", d: "Cash pickup, Kenya", live: true },
  { id: "zold", icon: "bolt", t: "Zold", d: "No Zold-to-Zold transfer yet", live: false },
  { id: "crypto", icon: "currency_bitcoin", t: "Crypto", d: "USDC in only, never out", live: false },
];

function renderPayScreen() {
  // The cash corridor is only offered when the deployment can actually pay it
  // (Bridge live + an anchor); otherwise it reads as coming, not as a wall.
  const rails = M_RAILS.map((r) => r.id !== "cash" ? r
    : { ...r, live: caps.cashRail, d: caps.cashRail ? r.d : "Cash pickup opens with a payout partner" });
  $("m-rails").innerHTML = rails.map((r) => `
    <button class="m-rail${r.live ? (r.accent ? " go" : "") : " off"}" ${r.live ? `data-mrail="${r.id}"` : "disabled"}>
      ${r.live ? `<span class="material-symbols-rounded">${r.icon}</span>` : '<span class="m-tag soon">SOON</span>'}
      <span class="t">${esc(r.t)}</span>
      <span class="d">${esc(r.d)}</span>
    </button>`).join("");
  $("m-rails").querySelectorAll("[data-mrail]").forEach((b) => {
    b.onclick = () => startSend(b.dataset.mrail);
  });

  const payees = mPayees();
  $("m-pay-recent-sec").classList.toggle("hidden", !payees.length);
  $("m-pay-recent").innerHTML = payees.slice(0, 8).map((p) => `
    <button class="m-av" data-mpayee="${esc(p.key)}">
      <span class="sq">${esc(p.initials || "?")}</span>
      <span class="nm">${esc(p.name.split(/\s+/)[0])}</span>
    </button>`).join("");
  $("m-pay-saved").innerHTML = payees.length
    ? payees.map((p) => `<button class="m-row" data-mpayee="${esc(p.key)}">
        <span class="cc">${p.rail === "sepa" ? "EU" : "KE"}</span>
        <span style="flex:1;min-width:0">
          <span class="who" style="display:block">${esc(p.name)}</span>
          <span class="sub" style="display:block;font-family:var(--m-mono)">${esc(p.masked)}</span>
        </span>
        <span class="material-symbols-rounded" style="font-size:17px;color:var(--m-faint)">chevron_right</span>
      </button>`).join("")
    : '<div class="m-empty">Nobody yet — the people you pay are saved here.</div>';
  bindPayees();
  renderPayMatches();
}

function bindPayees() {
  const payees = mPayees();
  document.querySelectorAll("#m-pay-screen [data-mpayee]").forEach((b) => {
    b.onclick = () => {
      const p = payees.find((x) => x.key === b.dataset.mpayee);
      if (p) startSend(p.rail, p);
    };
  });
}

/** Matches shown above the fold while typing, as in the design. */
function renderPayMatches() {
  const q = ($("m-pay-q").value || "").trim().toLowerCase();
  const el = $("m-pay-matches");
  if (!q) { el.innerHTML = ""; return; }
  const hits = mPayees().filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  el.innerHTML = hits.length
    ? hits.map((p) => `<button class="m-row" data-mpayee="${esc(p.key)}">
        <span class="cc">${p.rail === "sepa" ? "EU" : "KE"}</span>
        <span style="flex:1;min-width:0">
          <span class="who" style="display:block">${esc(p.name)}</span>
          <span class="sub" style="display:block;font-family:var(--m-mono)">${esc(p.masked)}</span>
        </span>
        <span class="material-symbols-rounded" style="font-size:17px;color:var(--m-faint)">chevron_right</span>
      </button>`).join("")
    : '<div class="m-empty">Nobody you have paid matches that.</div>';
  bindPayees();
}

/**
 * Enter the send flow on a rail, optionally with a recipient already chosen.
 *
 * Kenya is picked from a list because more corridors open with partners; SEPA
 * has exactly one destination, so the design's "the Bank rail skips the method
 * step" applies to the country step too — there is nothing to choose.
 */
function startSend(rail, payee) {
  mSend.prefill = payee || null;
  if (rail === "cash" && !payee) return mobileNav("country");
  const d = M_DESTINATIONS.find((x) => x.rail === rail);
  if (!d) return mobileNav("country");
  toAmountStep(d, "pay");
}

function renderCountryList(filter = "") {
  const q = filter.trim().toLowerCase();
  // A cash destination is only listed when the deployment can pay it.
  const list = M_DESTINATIONS
    .filter((d) => d.rail !== "cash" || caps.cashRail)
    .filter((d) => !q || d.name.toLowerCase().includes(q) || d.cur.toLowerCase().includes(q) || d.cc.toLowerCase().includes(q));
  $("m-country-list").innerHTML = list.length
    ? list.map((d) => `<button class="m-optrow" data-mdest="${d.cc}">
        <span class="cc">${d.cc}</span>
        <span class="tx"><span class="t">${esc(d.name)}</span><span class="d">${esc(d.sub)}</span></span>
        <span class="material-symbols-rounded ch">chevron_right</span>
      </button>`).join("")
    : '<div class="m-empty" style="text-align:center;padding:32px 0">No match</div>';
  $("m-country-list").querySelectorAll("[data-mdest]").forEach((b) => {
    b.onclick = () => pickDestination(M_DESTINATIONS.find((d) => d.cc === b.dataset.mdest));
  });
}

/** Open the amount step for a destination. `from` is where its back button
 *  returns to, because the method step is skipped when there is nothing to
 *  choose and a back button that lands on a screen you never saw is worse than
 *  no back button. */
function toAmountStep(d, from) {
  mSend.dest = d;
  $("m-amount-kick").textContent = `${M_METHODS[d.rail].title} · ${d.name}`;
  $("m-amount-screen").querySelector("[data-mback]").dataset.mback = from;
  mobileNav("amount");
  requestQuote();
}

function pickDestination(d) {
  mSend.dest = d;
  $("m-method-dest").textContent = d.name;
  $("m-method-rail").textContent = d.rail === "sepa" ? "SEPA" : "MoneyGram";
  $("m-method-cur").textContent = d.cur;
  const m = M_METHODS[d.rail];
  $("m-method-list").innerHTML = `<button class="m-optrow" id="m-pick-method">
      <span class="material-symbols-rounded ic">${m.icon}</span>
      <span class="tx"><span class="t">${esc(m.title)}</span><span class="d">${esc(m.sub)}</span></span>
      <span style="text-align:right;flex:none"><span style="display:block;font-size:12px;font-weight:600">${esc(d.eta)}</span><span style="display:block;font-size:10px;color:var(--m-faint);margin-top:2px">fee with quote</span></span>
    </button>`;
  $("m-pick-method").onclick = () => toAmountStep(d, "method");
  mobileNav("method");
}

/** Price the corridor. Refuses to show a figure it did not get from the API. */
async function requestQuote() {
  const d = mSend.dest;
  const amount = Number($("m-amount").value);
  mSend.quote = null;
  $("m-amount-next").disabled = true;
  $("m-quote-total").classList.add("hidden");
  $("m-quote-note").classList.add("hidden");
  $("m-quote-rows").innerHTML = "";
  clearErr("m-amount-err");
  if (!d || !(amount > 0)) { $("m-quote-status").textContent = "Enter an amount to price it."; return; }
  $("m-quote-status").textContent = "Pricing…";
  try {
    const q = await api("/api/quotes", { userId: user.id, rail: d.rail, sendEur: amount });
    mSend.quote = q;
    renderQuote(q);
  } catch (e) {
    $("m-quote-status").textContent = "";
    showErr("m-amount-err", e);
  }
}

function renderQuote(q) {
  const d = mSend.dest;
  const cash = d.rail === "cash";
  const rows = cash
    ? [["Mid-market rate", `${fmt(q.midRate, 2)} ${d.cur}`],
       ["Your rate", `${fmt(q.fxRate, 2)} ${d.cur}`],
       ["FX margin", `${fmt((q.marginBps ?? 0) / 100, 2)}%`],
       ["Fee", `€${fmt(q.fixedFeeEur)}`]]
    : [["You send", `€${fmt(q.sendEur)}`], ...(q.fixedFeeEur > 0 ? [["Fee", `€${fmt(q.fixedFeeEur)}`]] : [["Fee", "None"]])];
  $("m-quote-status").textContent = "";
  $("m-quote-rows").innerHTML = rows.map(([k, v]) => `<div class="m-qrow"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  $("m-quote-recv").textContent = cash ? `${fmt(q.receiveKes)} ${d.cur}` : `€${fmt(q.receiveEur)}`;
  $("m-quote-total").classList.remove("hidden");
  $("m-quote-note").textContent = "Rate locked for ten minutes. The quote expires rather than repricing silently.";
  $("m-quote-note").classList.toggle("hidden", !cash);
  const bal = user?.balanceEur ?? 0;
  const over = q.sendEur > bal;
  $("m-balance-note").textContent = over
    ? `Your available balance is €${fmt(bal)} — this send is more than you hold.`
    : `Available €${fmt(bal)}`;
  $("m-amount-next").disabled = over;
}

function toRecipient() {
  const d = mSend.dest;
  const cash = d.rail === "cash";
  $("m-rec-hint").textContent = cash
    ? "The name must match the ID they collect with."
    : "The name and IBAN of the account you're paying.";
  /* A payee picked on the Pay hub arrives here already filled in. It is filled
     in, not hidden: the identifier is what the device signs a commitment over,
     so it stays on screen and editable rather than being carried invisibly. */
  const pre = mSend.prefill && mSend.prefill.rail === d.rail ? mSend.prefill : null;
  $("m-rec-fields").innerHTML = `
    <div class="m-field"><label>Full name</label><input id="m-rec-name" value="${esc(pre?.name || "")}" placeholder="${cash ? "Joseph Otieno" : "Elena Weber"}" /></div>
    ${cash
      ? `<div class="m-field"><label>Mobile number</label><input id="m-rec-phone" inputmode="tel" value="${esc(pre?.id || "")}" placeholder="+254 7xx xxx xxx" /></div>`
      : `<div class="m-field"><label>IBAN</label><input id="m-rec-iban" value="${esc(pre?.id || "")}" placeholder="DE89 3704 0044 0532 0130 00" /></div>`}
    ${!cash && pre?.reference
      ? `<div class="m-field"><label>Reference — the payee matches the payment on this</label><input id="m-rec-ref" value="${esc(pre.reference)}" maxlength="140" /></div>`
      : ""}`;
  const q = mSend.quote;
  $("m-sum-send").textContent = `€${fmt(q.sendEur)}`;
  $("m-sum-recv").textContent = cash ? `${fmt(q.receiveKes)} ${d.cur}` : `€${fmt(q.receiveEur)}`;
  $("m-sum-eta").textContent = d.eta;
  const validate = () => {
    const name = ($("m-rec-name").value || "").trim();
    const id = cash ? ($("m-rec-phone").value || "").trim() : ($("m-rec-iban").value || "").trim();
    $("m-rec-send").disabled = !(name && id);
  };
  $("m-rec-fields").querySelectorAll("input").forEach((i) => { i.oninput = validate; });
  validate();
  $("m-rec-send").textContent = `Send €${fmt(q.sendEur)}`;
  mobileNav("recipient");
}

/** Create, sign and submit. Identical guarantees to the desktop flow: the
 *  device recomputes the payout commitment and refuses to sign if the server's
 *  terms name a different recipient. */
async function submitMobileSend() {
  clearErr("m-rec-err");
  const btn = $("m-rec-send");
  btn.disabled = true;
  const d = mSend.dest;
  const cash = d.rail === "cash";
  try {
    if (!kycApproved(user)) throw new Error("identity review must be approved before sending");
    if (!user.authorizerAddress) await registerDeviceKey(user);
    const recipient = {
      recipientName: ($("m-rec-name").value || "").trim(),
      recipientPhone: cash ? ($("m-rec-phone").value || "").trim() : undefined,
      recipientIban: cash ? undefined : ($("m-rec-iban").value || "").trim(),
    };
    const reference = !cash ? ($("m-rec-ref")?.value || "").trim() : "";
    const created = await api("/api/transfers", { quoteId: mSend.quote.id, ...recipient, ...(reference ? { reference } : {}) });
    mSend.transfer = created;
    mSend.rec = recipient;
    renderProgress(created);
    mobileNav("progress");

    const dev = await deviceLib;
    const addr = await dev.deviceAddress(credId());
    if (created.authorization.authorizer.toLowerCase() !== addr.toLowerCase()) {
      throw new Error("this account's spending key was registered in a different browser — sign in there, or rotate the key from that device");
    }
    const expected = dev.destinationCommitment(d.rail, {
      phone: recipient.recipientPhone,
      iban: recipient.recipientIban,
      name: recipient.recipientName,
    });
    if (created.authorization.typedData.message.destination.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("the payout destination in the signed terms does not match the recipient you entered — not signing");
    }
    const signature = await dev.signTypedData(created.authorization.typedData, credId());
    const execution = await safeExecutionAssertion(created.authorization);
    const redeem = await moneriumRedeemAssertion(created.authorization);
    const t = await api(`/api/transfers/${created.id}/authorize`, {
      signature,
      ...(execution ? { executionAssertion: execution } : {}),
      ...(redeem ? { moneriumRedeemAssertion: redeem } : {}),
    });
    mSend.transfer = t;
    renderProgress(t);
    refresh();
    addHistory(t);
  } catch (e) {
    /* Report on whichever screen the user is actually looking at. A creation
       failure (insufficient balance, expired quote) happens before we leave
       the recipient step, and writing it to the progress screen's slot would
       have shown them nothing at all. */
    const onProgress = $("dashboard").dataset.msub === "progress";
    showErr(onProgress ? "m-prog-err" : "m-rec-err", e);
    if (onProgress) $("m-prog-done").classList.remove("hidden");
    btn.disabled = false;
  }
}

/**
 * The settlement timeline, from the transfer's real state.
 *
 * Shared by the send progress screen and the transaction detail screen so a
 * transfer tells the same story while it is moving and after it has landed.
 * The handoff draws detail with four steps and progress with five; showing a
 * user a different number of steps for the same transfer depending on which
 * screen they opened would be the confusing half of that, so both use five.
 */
function mTimeline(t) {
  const cash = t.rail === "cash";
  const steps = [
    { t: "Quote locked", d: `quote ${String(t.quoteId || "").slice(0, 8)}` },
    /* One funding source: the move out of the user's own Safe. DEBIT_STEP in
       orchestrator.ts is the list — if another source is ever added there, it
       has to be matched here too. */
    { t: "Debited from your safe", d: t.txs?.find((x) => x.step.startsWith("safe.transfer"))?.hash?.slice(0, 18) || "waiting" },
    { t: cash ? "Anchor session opened" : "Redeem order placed", d: cash ? (t.pickup?.anchorTransactionId || "—") : (t.sepa?.orderId || t.sepa?.state || "—") },
    { t: cash ? "Converted and funded" : "Sent over SEPA", d: t.txs?.find((x) => x.step.startsWith("liquidity") || x.step.startsWith("bridge."))?.step || (t.sepa?.state ?? "—") },
    { t: cash ? "Collected" : "Paid", d: t.state },
  ];
  const reached = { CREATED: 1, DEBITED: 2, SWAPPED: 3, BRIDGED: 3, PAYOUT_DETAILS_PENDING: 3,
    PAYOUT_FUNDING_PENDING: 4, PAYOUT_FUNDED: 4, PAYOUT_READY: 4, PAYOUT_SUBMITTED: 4, PAID: 5 }[t.state] ?? 1;
  const stalled = ["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state);
  const html = steps.map((s, i) => {
    const cls = stalled && i >= reached ? "" : i < reached ? "done" : i === reached ? "active" : "";
    const icon = i < reached ? "check" : stalled && i === reached ? "priority_high" : "more_horiz";
    return `<div class="m-step ${cls}" style="opacity:${i <= reached ? 1 : .45}">
      <div class="tl"><div class="node"><span class="material-symbols-rounded" style="font-size:18px">${icon}</span></div><div class="line"></div></div>
      <div class="body"><div class="t">${esc(s.t)}</div><div class="d">${esc(String(s.d))}</div></div>
    </div>`;
  }).join("");
  return { html, stalled, reached };
}

/** Timeline driven by the transfer's real state, not a timer. */
function renderProgress(t) {
  const d = mSend.dest || { rail: t.rail, name: t.rail === "sepa" ? "Europe" : "Kenya", cur: t.rail === "sepa" ? "EUR" : "KES" };
  const cash = d.rail === "cash";
  const { html, stalled } = mTimeline(t);
  $("m-prog-kicker").textContent = stalled ? t.state.replace("_", " ") : t.state === "PAID" ? "Sent" : "Sending";
  $("m-prog-amount").textContent = cash ? `${fmt(t.receiveKes)} ${d.cur}` : `€${fmt(t.receiveEur ?? t.sendEur)}`;
  $("m-prog-to").textContent = `to ${mSend.rec?.recipientName || t.recipientName || "—"} · ${d.name}`;
  $("m-timeline").innerHTML = html;
  const ref = t.pickup?.referenceCode;
  $("m-prog-ref").classList.toggle("hidden", !(cash && ref));
  if (ref) $("m-prog-code").textContent = ref;
  if (t.error) showErr("m-prog-err", new Error(t.error));
  $("m-prog-done").classList.toggle("hidden", !(t.state === "PAID" || stalled || t.pickup));
}
