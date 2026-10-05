/**
 * The payment page settings, the destination-first send flow, the
 * animated transfer timeline, and history.
 */
/* ---------- payment page ---------- */
function renderHandle(page) {
  const row = $("paylink-row");
  const addrRow = $("payaddr-row");
  if (!page?.handle) {
    row.style.display = "none";
    addrRow.style.display = "none";
    return;
  }
  $("handle-input").value = page.handle;
  // Shown as an absolute URL because the whole point is pasting it elsewhere.
  $("paylink").textContent = `${location.origin}/pay/${page.handle}`;
  $("payaddr").textContent = page.depositAddress || "—";
  row.style.display = "flex";
  addrRow.style.display = "flex";
  $("btn-handle").textContent = "Update";
}

$("btn-handle").onclick = async () => {
  clearErr("handle-err");
  try {
    const handle = $("handle-input").value.trim().toLowerCase();
    // Main currency owns the asset; a rename keeps it (the route defaults
    // an absent one to EURE).
    const settlementAsset = user.paymentPage?.settlementAsset;
    const r = await api(`/api/users/${user.id}/handle`, {
      handle,
      ...(user.paymentPage?.displayName ? { displayName: user.paymentPage.displayName } : {}),
      ...(settlementAsset ? { settlementAsset } : {}),
    });
    user.paymentPage = r.paymentPage;
    renderHandle(r.paymentPage);
    renderMobile(user);
  } catch (e) { showErr("handle-err", e); }
};

document.querySelectorAll(".copybtn").forEach((b) => {
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      b.textContent = "Copied";
      announce("Copied");
      setTimeout(() => (b.textContent = "copy"), 1200);
    } catch {}
  };
});

document.querySelectorAll(".nav a").forEach((a) => {
  a.onclick = (ev) => {
    ev.preventDefault();
    switchView(a.dataset.view || "dashboard");
  };
});

$("btn-refresh-tx").onclick = () => loadTransfers();
document.querySelectorAll("[data-tx-filter]").forEach((b) => {
  b.onclick = () => {
    txFilter = b.dataset.txFilter;
    document.querySelectorAll("[data-tx-filter]").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    renderTransactionPage();
  };
});

$("btn-add-contact").onclick = () => {
  const name = $("contact-name").value.trim();
  const destination = $("contact-dest").value.trim();
  if (!name || !destination) return;
  contacts.unshift({ id: Date.now().toString(36), name, destination, createdAt: new Date().toISOString() });
  localStorage.setItem("zoll-contacts", JSON.stringify(contacts));
  $("contact-name").value = "";
  $("contact-dest").value = "";
  renderContacts();
};

function signOut() {
  localStorage.removeItem("zold-session");
  localStorage.removeItem("zoll-session");
  location.reload();
}
$("btn-signout").onclick = signOut;

/* ---------- destination-first send flow ---------- */
let rail = "cash";
let dest = null;
const RAILS = {
  cash: { icon: "💵", label: "Cash pickup", desc: "Collect at any MoneyGram agent", eta: "~10 min" },
  sepa: { icon: "🏦", label: "Bank transfer", desc: "Any IBAN · SEPA", eta: "seconds – 1 day" },
};
/**
 * Only destinations with a live rail are listed. One without would land the
 * user on an empty options screen with no way forward, so a country appears
 * when a licensed partner does.
 */
const DESTS = [
  { code: "KE", flag: "🇰🇪", name: "Kenya", cur: "KES", rails: ["cash"], soon: [["📱", "M-Pesa wallet", "straight to their phone"]] },
  { code: "EU", flag: "🇪🇺", name: "Europe", cur: "EUR", rails: ["sepa"], soon: [] },
];
const recvOf = (q) => (q.rail === "sepa" ? `€${fmt(q.receiveEur)}` : `KES ${fmt(q.receiveKes)}`);

function showSendStep(step) {
  $("send-dest").classList.toggle("hidden", step !== "dest");
  $("send-options").classList.toggle("hidden", step !== "options");
  $("send-details").classList.toggle("hidden", step !== "details");
}

$("dest-grid").innerHTML = DESTS.map(
  (d, i) => `<button class="dest-btn" data-i="${i}"><span class="df" aria-hidden="true">${d.flag}</span>${d.name}</button>`,
).join("");
document.querySelectorAll(".dest-btn").forEach((b) => {
  b.onclick = () => selectDest(DESTS[Number(b.dataset.i)]);
});

async function selectDest(d) {
  clearErr("dest-err");
  if (!kycApproved(user)) return showErr("dest-err", new Error("identity review must be approved before sending"));
  const amt = Number($("send-amount").value);
  if (!(amt > 0)) return showErr("dest-err", new Error("enter an amount first"));
  dest = d;
  $("opt-title").textContent = `€${fmt(amt)} to ${d.flag} ${d.name}`;
  $("opt-list").innerHTML = `<div class="empty">Finding your best options…</div>`;
  showSendStep("options");
  try {
    const quotes = await Promise.all(
      d.rails.map((r) => api("/api/quotes", { userId: user.id, rail: r, sendEur: amt })),
    );
    // Best payout first — within one destination all quotes share a currency.
    quotes.sort((a, b) => b.fxRate - a.fxRate);
    $("opt-list").innerHTML = "";
    quotes.forEach((q, i) => {
      const m = RAILS[q.rail];
      const el = document.createElement("button");
      el.className = "opt-card";
      el.innerHTML = `
        <span class="oi" aria-hidden="true">${m.icon}</span>
        <span class="om">
          <span class="ol">${m.label} ${i === 0 ? '<span class="badge">RECOMMENDED</span>' : ""}</span>
          <span class="od">${m.desc} · ${m.eta} · ${q.fixedFeeEur > 0 ? `fee €${fmt(q.fixedFeeEur)}` : "no fee"}</span>
        </span>
        <span class="ov"><span class="oa">${recvOf(q)}</span><br/><span class="of">recipient gets</span></span>`;
      el.onclick = () => selectOption(q);
      $("opt-list").appendChild(el);
    });
    for (const [icon, label, desc] of d.soon) {
      const el = document.createElement("div");
      el.className = "opt-card disabled";
      el.innerHTML = `<span class="oi" aria-hidden="true">${icon}</span>
        <span class="om"><span class="ol">${label} <span class="badge soon">COMING SOON</span></span>
        <span class="od">${desc}</span></span>`;
      $("opt-list").appendChild(el);
    }
  } catch (e) {
    showSendStep("dest");
    showErr("dest-err", e);
  }
}

function selectOption(q) {
  quote = q;
  rail = q.rail;
  clearErr("send-err");
  const m = RAILS[rail];
  $("det-title").textContent = `${m.icon} ${m.label} · ${dest.flag} ${dest.name}`;
  const sepa = rail === "sepa";
  $("row-mid").classList.toggle("hidden", sepa);
  $("row-rate").classList.toggle("hidden", sepa);
  if (!sepa) {
    $("q-mid").textContent = `1 EUR = ${fmt(q.midRate, 2)} KES`;
    $("q-rate").textContent = `1 EUR = ${fmt(q.fxRate, 2)} KES`;
    // Measured against the live mid, not a constant we assert.
    $("q-margin").textContent = `${fmt((q.marginBps ?? 0) / 100, 2)}% margin`;
  }
  $("q-fee").textContent = q.fixedFeeEur > 0 ? `€${fmt(q.fixedFeeEur)}` : "None";
  $("total-label").textContent = "Recipient gets";
  $("q-recv").textContent = recvOf(q);
  /* Effective rate = what actually arrives per EUR sent, fee included. Shown
     for every rail, and called out when the fixed fee eats a big share of a
     small send — that is the case where the row-by-row receipt looks correct
     and the result still is not worth sending. */
  const feeShare = q.sendEur > 0 ? q.fixedFeeEur / q.sendEur : 0;
  $("q-eff").textContent = sepa
    ? `€${fmt(q.effectiveRate ?? 0, 4)} per €1 sent`
    : `1 EUR = ${fmt(q.effectiveRate ?? 0, 2)} KES`;
  const heavy = feeShare >= 0.05;
  $("q-eff-label").textContent = heavy
    ? `Effective rate — the €${fmt(q.fixedFeeEur)} fee is ${fmt(feeShare * 100, 0)}% of this send`
    : "Effective rate";
  $("row-effective").style.color = heavy ? "var(--amber)" : "";
  $("field-phone").classList.toggle("hidden", rail !== "cash");
  $("field-iban").classList.toggle("hidden", rail !== "sepa");
  $("btn-send").textContent = `Send €${fmt(q.sendEur)} now`;
  showSendStep("details");
}

$("back-dest").onclick = () => showSendStep("dest");
$("back-options").onclick = () => showSendStep("options");


/* ---------- transfer + animated timeline ---------- */
const STEP_LABELS = {
  "safe.transfer(orchestrator)": ["Moving EURe from your Safe", "💶"],
  "safe.transfer(fee)": ["Collecting the transfer fee", "💶"],
  "bridge.xyz.dry-run.transfer": ["Planning Bridge.xyz transfer", "🌉"],
  "bridge.xyz.deposit.funded": ["Bridge deposit funded by your signed batch", "🌉"],
  "bridge.xyz.live.transfer": ["Creating Bridge.xyz transfer", "🌉"],
  "bridge.xyz.deposit.address": ["Bridge deposit address ready", "🏦"],
  "bridge.xyz.deposit.memo": ["Bridge deposit memo ready", "🏦"],
  "bridge.xyz.deposit.transfer": ["Funding Bridge.xyz transfer", "💵"],
  "bridge.xyz.destination_tx": ["Bridge destination funded", "✅"],
  "safe.refundTransfer": ["Refunding your Safe", "💶"],
};

/** Synthetic (off-chain) steps appended after the tx steps per rail. */
function sepaSteps(t) {
  const s = t.sepa || {};
  if (!s.mode) return [];
  return [["Monerium redeem order placed", `order ${s.orderId || "…"} · ${s.state}`, "🔥"]];
}
function stepEl(title, detail, icon) {
  const el = document.createElement("div");
  el.className = "tstep";
  el.innerHTML = `
    <div class="rail2" aria-hidden="true"><div class="node">${esc(icon)}</div><div class="line"></div></div>
    <div class="body"><div class="t">${esc(title)}</div><div class="d">${esc(detail)}</div></div>`;
  return el;
}

/** Replay executed steps with stagger so the pipeline is legible. */
function playTimeline(t, { onDone } = {}) {
  const tl = $("timeline");
  tl.innerHTML = "";
  const steps = t.txs.map((x) => {
    const [label, icon] = STEP_LABELS[x.step] || [x.step, "⚙️"];
    return stepEl(label, `tx ${x.hash}`, icon);
  });
  if (t.rail === "sepa") {
    for (const [label, detail, icon] of sepaSteps(t)) steps.push(stepEl(label, detail, icon));
  }
  steps.forEach((el) => tl.appendChild(el));
  steps.forEach((el, i) => {
    setTimeout(() => {
      el.classList.add("show", "active");
      if (i > 0) { steps[i - 1].classList.remove("active"); steps[i - 1].classList.add("done"); }
      if (i === steps.length - 1) {
        setTimeout(() => {
          el.classList.remove("active"); el.classList.add("done");
          if (onDone) onDone();
        }, 450);
      }
    }, 380 * (i + 1));
  });
}

/* A transfer that failed, refunded, or landed in manual review must never be
   shown as a pending pickup — the recipient is NOT getting the money. */
const isTerminalFailure = (t) => ["REFUNDED", "FAILED", "MANUAL_REVIEW"].includes(t.state);

function revealRefund(t) {
  $("refund-box").classList.remove("hidden");
  const reason = (t.error || "").replace(/^.*?:\s*/, "").split(" (set ")[0] || "the payout could not be completed";
  if (t.state === "REFUNDED") {
    const amt = t.refund ? fmt(t.refund.amountEur) : fmt(t.sendEur);
    $("refund-title").textContent = "Refunded — nothing was sent";
    $("refund-title").style.color = "var(--muted)";
    $("refund-note").innerHTML =
      `€${esc(amt)} is back in your account.<br><span style="color:var(--muted)">Why: ${esc(reason)}</span>` +
      (t.refund && t.refund.deductions && t.refund.deductions !== "none"
        ? `<br><span style="color:var(--muted)">Deductions: ${esc(t.refund.deductions)}</span>` : "");
  } else if (t.state === "MANUAL_REVIEW") {
    $("refund-title").textContent = "Under review";
    $("refund-title").style.color = "var(--amber)";
    $("refund-note").innerHTML =
      `This transfer needs manual review before it settles — a payment may already be in flight, so it was not auto-refunded.` +
      `<br><span style="color:var(--muted)">${esc(reason)}</span>`;
  } else {
    $("refund-title").textContent = "Payout failed";
    $("refund-title").style.color = "var(--red)";
    $("refund-note").innerHTML = `<span style="color:var(--muted)">${esc(reason)}</span>`;
  }
  $("btn-again").classList.remove("hidden");
  $("refund-box").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function revealPickup(t) {
  const p = t.pickup || {};
  $("pickup-box").classList.remove("hidden");
  $("t-ref").textContent = p.anchorReferenceNumber || p.referenceCode || "PENDING";
  $("p-kes").textContent = `KES ${fmt(t.receiveKes)}`;
  let note = `${t.recipientName} shows this code + ID at any agent · gets `;
  if (t.state === "PAYOUT_DETAILS_PENDING") note = `${t.recipientName} completes MoneyGram details before the pickup reference is issued · gets `;
  if (t.state === "PAYOUT_FUNDING_PENDING") note = `${t.recipientName}'s details are accepted; funding is waiting for on-ledger payment · gets `;
  if (t.state === "PAYOUT_FUNDED") note = `${t.recipientName}'s payout is funded and waiting for MoneyGram confirmation · gets `;
  $("p-note-text").textContent = note;
  $("p-links").innerHTML = "";
  const anchorPage = safeUrl(p.interactiveUrl);
  if (anchorPage) {
    $("p-links").insertAdjacentHTML("beforeend",
      ` · <a href="${esc(anchorPage)}" target="_blank" rel="noreferrer" style="color:var(--amber)">anchor page ↗</a>`);
  }
  const moreInfo = safeUrl(p.moreInfoUrl);
  if (moreInfo) {
    $("p-links").insertAdjacentHTML("beforeend",
      ` · <a href="${esc(moreInfo)}" target="_blank" rel="noreferrer" style="color:var(--amber)">details ↗</a>`);
  }
  $("btn-refresh-payout").classList.toggle("hidden", !p.anchorTransactionId);
  $("pickup-box").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderSepaResult(t) {
  const s = t.sepa || {};
  $("sepa-box").classList.remove("hidden");
  if (t.state === "PAID") {
    $("sepa-status").textContent = "SEPA payout processed";
    $("sepa-note").textContent =
      `${t.recipientName} receives €${fmt(t.receiveEur)} → ${t.recipientIban}` +
      (s.detail ? ` · ${s.detail}` : "");
    $("btn-again").classList.remove("hidden");
  } else if (t.state === "FAILED") {
    $("sepa-status").textContent = "Payout failed";
    $("sepa-note").textContent = t.error || "Monerium did not give a reason. Check Activity for this transfer's status.";
    $("btn-again").classList.remove("hidden");
  } else {
    $("sepa-status").textContent = "Awaiting SEPA settlement…";
    $("sepa-note").textContent = `Monerium order ${s.orderId || ""} · ${s.state || "in flight"}`;
  }
}

async function pollSepaTransfer(id) {
  let t;
  try { t = await api(`/api/transfers/${id}`); } catch { t = null; }
  if (t) {
    transfer = t;
    renderSepaResult(t);
    updateHistory(t);
    if (t.state !== "PAYOUT_SUBMITTED") { refresh(); return; }
  }
  setTimeout(() => pollSepaTransfer(id), 5000);
}

$("btn-send").onclick = async () => {
  clearErr("send-err");
  /* Every field the device will sign a commitment over must have been typed;
     never fill a blank with a placeholder and sign it. Checked before any API call
     or device-key work, so a refusal costs nothing. Only the rail's own
     identifier is sent, as the mobile flow does. */
  const recipient = {
    recipientName: $("rec-name").value.trim(),
    recipientPhone: rail === "cash" ? $("rec-phone").value.trim() : undefined,
    recipientIban: rail === "sepa" ? $("rec-iban").value.trim() : undefined,
  };
  const missing = !recipient.recipientName ? ["rec-name", "enter the recipient's name"]
    : rail === "cash" && !recipient.recipientPhone ? ["rec-phone", "enter the recipient's phone number"]
    : rail === "sepa" && !recipient.recipientIban ? ["rec-iban", "enter the recipient's IBAN"]
    : null;
  if (missing) {
    showErr("send-err", new Error(missing[1]));
    $(missing[0]).focus();
    return;
  }
  const btn = $("btn-send");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    if (!kycApproved(user)) throw new Error("identity review must be approved before sending");
    // Late binding for accounts that skipped registration at onboarding.
    if (!user.authorizerAddress) await registerDeviceKey(user);

    // 1. Propose: the server fixes the terms and returns them unexecuted.
    const created = await api("/api/transfers", { quoteId: quote.id, ...recipient });

    // 2. Authorize: unlock the device key with the passkey and sign the exact
    //    terms. With a PRF-capable authenticator the ceremony IS the gate —
    //    the stored key is ciphertext until Face ID / fingerprint unwraps it.
    const dev = await deviceLib;
    const addr = await dev.deviceAddress(credId());
    if (created.authorization.authorizer.toLowerCase() !== addr.toLowerCase()) {
      throw new Error("this account's spending key was registered in a different browser — sign in there, or rotate the key from that device");
    }
    // Recompute the payout commitment from what WE typed and refuse to sign if
    // the server's signed terms name a different destination — this is what
    // stops a tampered server redirecting the payment to another recipient.
    const expectedDestination = dev.destinationCommitment(rail, {
      phone: recipient.recipientPhone,
      iban: recipient.recipientIban,
      name: recipient.recipientName,
    });
    if (created.authorization.typedData.message.destination.toLowerCase() !== expectedDestination.toLowerCase()) {
      throw new Error("the payout destination in the signed terms does not match the recipient you entered — not signing");
    }
    const signature = await dev.signTypedData(created.authorization.typedData, credId());
    const execution = await safeExecutionAssertion(created.authorization);
    const redeem = await moneriumRedeemAssertion(created.authorization);

    // 3. Submit: the server can only relay the movement the passkey just
    //    signed — the debit is a Safe operation, not a server action.
    const t = await api(`/api/transfers/${created.id}/authorize`, {
      signature,
      ...(execution ? { executionAssertion: execution } : {}),
      ...(redeem ? { moneriumRedeemAssertion: redeem } : {}),
    });
    transfer = t;
    $("step-quote").classList.add("hidden");
    $("step-progress").classList.remove("hidden");
    // The timeline still animates every step it took — including the refund
    // legs — but the outcome panel must match the real terminal state, not
    // assume the rail succeeded. A fail-closed anchor payout comes back
    // REFUNDED, not FAILED, and must not read as a pending pickup.
    playTimeline(t, { onDone: () => {
      if (isTerminalFailure(t)) { revealRefund(t); return; }
      if (t.rail === "sepa") {
        renderSepaResult(t);
        if (t.state === "PAYOUT_SUBMITTED") pollSepaTransfer(t.id);
      } else {
        revealPickup(t);
      }
    } });
    refresh();
    addHistory(t);
  } catch (e) { showErr("send-err", e); }
  finally { btn.disabled = false; btn.textContent = label; }
};

async function refreshCashPayout() {
  try {
    const t = await api(`/api/transfers/${transfer.id}/refresh-payout`, {});
    transfer = t;
    revealPickup(t);
    updateHistory(t);
    if (t.state === "PAID") {
      $("pickup-box").classList.add("hidden");
      $("paid-box").classList.remove("hidden");
      $("paid-note").textContent = `${t.recipientName} collected KES ${fmt(t.receiveKes)} · ref ${t.pickup.referenceCode}`;
      $("btn-again").classList.remove("hidden");
    }
  } catch (e) { showErr("send-err", e); }
}

$("btn-refresh-payout").onclick = refreshCashPayout;


$("btn-again").onclick = () => {
  $("step-progress").classList.add("hidden");
  $("paid-box").classList.add("hidden");
  $("btn-again").classList.add("hidden");
  $("pickup-box").classList.add("hidden");
  $("sepa-box").classList.add("hidden");
  $("refund-box").classList.add("hidden");
  $("step-quote").classList.remove("hidden");
  showSendStep("dest");
};

/* ---------- history ---------- */
const hist = [];
/* Set when the last activity load failed. An empty `hist` then means "we could
   not ask", not "nothing happened": an outage must not read as an empty
   account. Rows already loaded stay on screen; only the empty state changes. */
let histLoadFailed = false;
/* Set once the first activity load answered, so an empty list before then
   draws as loading rather than as "No payments yet". */
let histLoaded = false;
/** The empty state for a transfer list, or the load failure in its place.
 *  The retry calls loadTransfers() (app/monerium.js) on click, never at parse. */
function histEmptyHtml(cls, emptyText, style = "") {
  const st = style ? ` style="${style}"` : "";
  if (!histLoadFailed) return `<div class="${cls}"${st}>${emptyText}</div>`;
  return `<div class="${cls}"${st}>Couldn't load your transfers. Check your connection and try again.
    <button type="button" class="linkbtn" data-hist-retry style="text-decoration:underline">Try again</button></div>`;
}
function bindHistRetry(el) {
  el.querySelectorAll("[data-hist-retry]").forEach((b) => { b.onclick = () => loadTransfers(); });
}
function histRow(t) {
  if (t.kind === "funding") {
    const token = t.token === "USDC" ? usdSym() : "EURe";
    const amount = t.token === "USDC" ? `${fmt(t.amountUsdc || 0)} ${usdSym()}` : `€${fmt(t.amountEur || 0)}`;
    const color = t.state === "REFUSED" ? "var(--amber)" : "var(--green)";
    return `
    <div class="hic">IN</div>
    <div class="hmain">
      <div class="hn">${token} funding</div>
      <div class="hs">${esc(shortAddr(t.txHash || ""))}</div>
    </div>
    <div>
      <div class="hamt">+${esc(amount)}</div>
      <div class="hst" style="color:${color}">${t.state === "REFUSED" ? "REVIEW" : "RECEIVED"}</div>
    </div>`;
  }
  const paid = t.state === "PAID";
  const sepa = t.rail === "sepa";
  const sub = sepa
    ? `${esc((t.recipientIban || "").slice(0, 9))}… · €${fmt(t.receiveEur)}`
    : `ref ${esc(t.pickup ? t.pickup.referenceCode : "—")} · KES ${fmt(t.receiveKes)}`;
  const status = paid ? "PAID" : t.state === "REFUNDED" ? "REFUNDED" : t.state === "FAILED" ? "FAILED"
    : t.state === "PAYOUT_DETAILS_PENDING" ? "DETAILS PENDING"
    : t.state === "PAYOUT_FUNDING_PENDING" ? "FUNDING PENDING"
    : t.state === "PAYOUT_FUNDED" ? "FUNDED"
    : sepa ? "SEPA IN FLIGHT" : "READY FOR PICKUP";
  const color = paid ? "var(--green)" : t.state === "REFUNDED" ? "var(--muted)"
    : t.state === "FAILED" ? "var(--red)" : "var(--amber)";
  return `
    <div class="hic" aria-hidden="true">${sepa ? "🏦" : "🇰🇪"}</div>
    <div class="hmain">
      <div class="hn">${esc(t.recipientName)}</div>
      <div class="hs">${sub}</div>
    </div>
    <div>
      <div class="hamt">${txAmountLabel(t)}</div>
      <div class="hst" style="color:${color}">${status}</div>
    </div>`;
}
function addHistory(t) {
  // The activity endpoint tags entries with kind; a raw POST /api/transfers
  // response has none, and the filters below would drop the just-sent one.
  hist.unshift(t.kind ? t : { kind: "transfer", ...t });
  renderHistory();
}
function updateHistory(t) {
  const i = hist.findIndex((x) => x.id === t.id);
  if (i >= 0) hist[i] = t;
  renderHistory();
}
function renderHistory() {
  const h = $("history");
  h.innerHTML = hist.length
    ? hist.map((t) => `<div class="hitem">${histRow(t)}</div>`).join("")
    : histEmptyHtml("empty", "No transfers yet");
  bindHistRetry(h);
  renderTransactionPage();
  phRefresh();
}

function renderTransactionPage() {
  const list = $("tx-page-list");
  if (!list) return;
  const transfers = txFilter === "all" ? hist : hist.filter((t) => t.kind === "transfer" && t.rail === txFilter);
  const totalSent = hist.reduce((sum, t) => sum + (Number(t.sendEur) || 0), 0);
  const paid = hist.filter((t) => t.kind === "transfer" && t.state === "PAID").length;
  const open = hist.filter((t) => t.kind === "transfer" && !["PAID", "FAILED", "REFUNDED"].includes(t.state)).length;
  $("tx-total-sent").textContent = `€${fmt(totalSent)}`;
  $("tx-total-paid").textContent = String(paid);
  $("tx-total-open").textContent = String(open);
  list.innerHTML = transfers.length
    ? transfers.map((t) => `<div class="hitem">${histRow(t)}</div>`).join("")
    : hist.length ? '<div class="empty">No transfers match this filter</div>' : histEmptyHtml("empty", "No transfers yet");
  bindHistRetry(list);
}

function renderContacts() {
  const list = $("contact-list");
  if (!list) return;
  list.innerHTML = contacts.length
    ? contacts.map((c) => `<div class="contact-card">
        <div><div class="cn">${esc(c.name)}</div><div class="cd">${esc(c.destination)}</div></div>
        <button class="ghost" data-contact="${esc(c.id)}">Remove</button>
      </div>`).join("")
    : '<div class="empty">No saved contacts yet</div>';
  document.querySelectorAll("[data-contact]").forEach((b) => {
    b.onclick = () => {
      contacts = contacts.filter((c) => c.id !== b.dataset.contact);
      localStorage.setItem("zoll-contacts", JSON.stringify(contacts));
      renderContacts();
    };
  });
}

/* ---------- progressive web app ---------- */
/**
 * Install the shell worker, and tell the truth about the network.
 *
 * The worker caches the app shell only — see sw.js for why nothing under
 * /api/ is ever stored. Everything here is wrapped so that a failure to
 * register (an insecure origin, a browser without service workers, a private
 * window) leaves the app working exactly as it did before, just without
 * offline start-up.
 *
 */
