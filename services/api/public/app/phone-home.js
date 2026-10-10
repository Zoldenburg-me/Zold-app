/**
 * The phone app's Home: balance, recovery alert and account details.
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Home
   ========================================================================== */

let phHidden = (() => { try { return localStorage.getItem("zold-hide-balance") === "1"; } catch { return false; } })();

function phBalance(value, label) {
  const s = phEur(value);                       // "€2,318.47"
  const m = /^€([\d,]+)(\.\d{2})$/.exec(s);
  const whole = m ? m[1] : s.replace("€", "");
  const cents = m ? m[2] : "";
  const long = (whole + cents).length > 9;
  const fig = phHidden
    ? `<span class="z-balance__fig" aria-label="Balance hidden"><span class="z-balance__cur" aria-hidden="true">€</span><span aria-hidden="true">••••</span></span>`
    : `<span class="z-balance__fig${long ? " z-balance__fig--long" : ""}"><span class="z-balance__cur">€</span>${esc(whole)}<span class="z-balance__cents">${esc(cents)}</span></span>`;
  return `<section class="z-balance" aria-labelledby="ph-bal-label">
    <div class="z-balance__head"><h2 class="z-balance__label" id="ph-bal-label">${esc(label)}</h2>
      <button type="button" class="z-iconbtn z-iconbtn--bare" id="ph-hide" aria-pressed="${phHidden}" aria-label="${phHidden ? "Show balance" : "Hide balance"}">${Z.icon(phHidden ? "visibility_off" : "visibility")}</button></div>
    <p class="z-fig">${fig}</p>
  </section>`;
}

/* The set-up list for a new account. Only what the API confirms is ticked. */
function phChecklist(u) {
  const recoveryOffered = (caps.emailSmsRecovery || caps.zoldenburgRecovery || caps.turnkeyGuardians) && recoveryOfferedFor(u);
  const safe = u.passkeySafe || {};
  const recoveryOn = safe.recovery?.status === "active" || safe.candideRecovery?.guardianStatus === "active"
    || (safe.socialGuardians || []).some((g) => g.status === "active");
  const connected = hasConnectedMonerium(u);
  const approved = kycApproved(u);
  const wait = ibanWait(u);
  const items = [
    { title: "Face ID sign-in", sub: "This phone approves payments.", done: !!u.passkey?.credentialId },
    { title: "Account created", sub: safe.status === "active" ? "Your account is live." : "Finish setting up your account.",
      done: safe.status === "active", action: { id: "ph-ck-account", label: "Finish" } },
    ...(caps.emailVerification && u.email
      ? [{ title: "Confirm your email", sub: u.emailVerifiedAt ? "Confirmed." : "A 6-digit code to your email.",
          done: !!u.emailVerifiedAt, action: { id: "ph-ck-email", label: "Confirm" } }]
      : []),

    { title: "Verify with Monerium", sub: approved || connected ? "Connected." : "ID check, a few minutes.",
      done: approved || connected, action: { id: "ph-ck-verify", label: "Start" } },
    { title: "IBAN active",
      sub: u.iban && approved ? "Ready to receive bank transfers."
        : wait ? (wait.support ? "Needs Monerium support. Tap for details." : `Requested. ${wait.idCheck ? "Monerium is checking your ID." : "Monerium is issuing it."} Nothing to do.`)
        : "Follows your verification.",
      done: !!u.iban && approved,
      // While Monerium works there is nothing to press: the row shows Waiting.
      // A support case keeps a button to the screen that explains it.
      action: connected && !approved && (!wait || wait.support) ? { id: "ph-ck-verify2", label: wait ? "Details" : "Activate" } : null },
  ];
  const open = items.some((i) => !i.done);
  // Recovery is optional, so it is not a set-up step: a skipped choice is an
  // answer, and an unset recovery is one line the user may close. Security
  // keeps saying it is off.
  const declined = u.passkeySafe?.recoveryChoice?.choice === "declined";
  if (!recoveryOn && (recoveryOffered || declined) && !open && !phRecoveryBannerHidden(u)) {
    return `<div class="z-banner" role="note">${Z.icon("shield")}<span>Recovery isn’t set up. If you lose this phone, no one can get you back in. <a href="#recovery-settings">Set up</a></span>
      <button type="button" class="z-iconbtn z-iconbtn--bare" id="ph-rec-x" aria-label="Hide this">${Z.icon("close")}</button></div>`;
  }
  return phChecklistCard("Finish setting up", items);
}

const phRecoveryBannerKey = (u) => `zold-hide-recovery-banner:${u.id}`;
function phRecoveryBannerHidden(u) {
  try { return localStorage.getItem(phRecoveryBannerKey(u)) === "1"; } catch { return false; }
}

/* A set-up card: a row per open item; the finished ones are a count in the
   head, never rows. An item with an `action` ({ id } for a button, { href }
   for a link) offers it; one without waits on someone else. Nothing left to
   do: no card. */
function phChecklistCard(title, items) {
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return "";
  const rows = items.filter((i) => !i.done).map((i) => {
    const mark = `<span class="z-check-mark${i.done ? " is-done" : i.action ? "" : " is-wait"}" aria-hidden="true">${Z.icon(i.done ? "check" : i.action ? "radio_button_unchecked" : "schedule")}</span>`;
    const right = i.done ? Z.tag("Done")
      : i.action ? (i.action.href
        ? `<a class="z-btn z-btn--secondary z-btn--sm" href="${esc(i.action.href)}"${i.action.org ? ` data-ph-org="${esc(i.action.org)}"` : ""}>${esc(i.action.label)}<span class="z-sr">: ${esc(i.title)}</span></a>`
        : `<button type="button" class="z-btn z-btn--secondary z-btn--sm" id="${esc(i.action.id)}">${esc(i.action.label)}<span class="z-sr">: ${esc(i.title)}</span></button>`)
        : Z.tag("Waiting");
    return `<div class="z-row z-row--check${i.done ? " is-done" : ""}">${mark}<span class="z-row__main"><span class="z-row__title">${esc(i.title)}${i.done ? '<span class="z-sr"> (done)</span>' : ""}</span><span class="z-row__sub">${esc(i.sub)}</span></span><span class="z-row__right">${right}</span></div>`;
  });
  return `<section class="z-card z-checklist" aria-labelledby="ph-ck-title">
    <div class="z-checklist__head"><h2 id="ph-ck-title">${esc(title)}</h2><span class="z-fig">${done} of ${items.length} done</span></div>
    <ul class="z-list">${rows.map((r) => `<li>${r}</li>`).join("")}</ul></section>`;
}

PH.home = {
  title: "Home",
  tab: "home",
  live: () => JSON.stringify([user?.balanceEur, user?.iban, user?.kycStatus, user?.monerium?.connectedAt, user?.passkeySafe?.status,
    user?.passkeySafe?.recovery?.status, user?.passkeySafe?.candideRecovery?.guardianStatus, user?.passkeySafe?.recoveryChoice?.choice, user?.emailVerifiedAt, caps.emailVerification, user?.segment?.gate, caps.emailSmsRecovery, caps.zoldenburgRecovery, realMoney, phHistSig()]),
  html() {
    const u = user || {};
    const name = ownAccountName(u) || "Account";
    const checklist = phChecklist(u);
    const gate = u.segment?.gate;
    const inflight = hist.find(phInFlight);
    const ibanRight = u.iban && kycApproved(u)
      ? `<span class="z-mono z-dim" translate="no">•••• ${esc(String(u.iban).replace(/\s+/g, "").slice(-4))}</span>`
      : `<span class="z-dim">IBAN after verification</span>`;
    return `<h1 class="z-sr">Home</h1><header class="z-apphead">
        ${Z.avatar({ name, tone: "p" })}
        <span class="z-apphead__name">${esc(phFirst(name) || name)}</span>
        ${checklist ? Z.tag(ownAccountKind(u)) : ""}
      </header>
      ${phMain(`
        ${gate ? Z.note({ tone: "a", html: `<strong>${esc(gate.reason)}</strong> ${esc(gate.needs)} <a href="mailto:support@zoldhq.com">Ask us about it</a>` }) : ""}
        ${phBalance(u.balanceEur ?? u.safeBalanceEur ?? 0, "Balance")}
        <a class="z-card z-acctrow" href="#account-details">${Z.icon("account_balance", "z-acctrow__ic")}<span class="z-acctrow__label">Account details</span>${ibanRight}${Z.icon("chevron_right", "z-row__chev")}</a>
        <div class="z-actions">
          ${Z.button({ variant: "primary", icon: "arrow_outward", label: "Send", href: "#send" })}
          ${Z.button({ icon: "add", label: "Add money", href: "#add" })}
          ${Z.button({ icon: "south_west", label: "Request", href: "#get-paid" })}
        </div>
        ${inflight ? `<a class="z-inflight" href="${phHref("send/progress", inflight.id)}">
            <span class="z-inflight__dot" aria-hidden="true"></span>
            <span class="z-row__main"><span class="z-row__title">${esc(phEur(inflight.sendEur))} to ${esc(inflight.recipientName || "")}</span>
            <span class="z-row__sub">Waiting for the bank to confirm</span></span>${Z.icon("chevron_right", "z-row__chev")}</a>` : ""}
        ${checklist}
        ${phActivityList(hist.slice(0, 5), {
          label: "Recent activity",
          action: hist.length ? { href: "#activity", label: "See all" } : undefined,
          empty: { text: u.iban ? "No payments yet. Share your account details to get paid." : "No payments yet. Once your IBAN is live, share it to get paid." },
        })}
      `)}`;
  },
  bind(root) {
    root.querySelector("#ph-hide").onclick = () => {
      phHidden = !phHidden;
      try { localStorage.setItem("zold-hide-balance", phHidden ? "1" : "0"); } catch { /* hidden for this visit */ }
      phRender();
      $("ph-hide")?.focus();
    };
    for (const id of ["ph-ck-verify", "ph-ck-verify2", "ph-ck-account"]) {
      const b = root.querySelector(`#${id}`);
      if (b) b.onclick = () => enterKycReview(user?.name || "Account");
    }
    const emailBtn = root.querySelector("#ph-ck-email");
    if (emailBtn) emailBtn.onclick = () => enterEmailConfirm();
    const recX = root.querySelector("#ph-rec-x");
    if (recX) recX.onclick = () => {
      try { localStorage.setItem(phRecoveryBannerKey(user), "1"); } catch { /* shown again next visit */ }
      recX.closest(".z-banner")?.remove();
    };
    phBindRetry(root);
    phRecoveryCheck();
  },
};

/* ==========================================================================
   Recovery under way (the old phone's alert)
   ========================================================================== */

/* What the guardians report: { chain: pendingRecovery|null, request: a
   Zoldenburg request nobody has signed yet|null, method: words|null }.
   null until the first read; `none` when nothing is under way; `failed`
   when a read did not work. */
let phRec = null;
let phRecReadAt = 0;
let phRecDone = false;       // this phone just cancelled it
let phRecRun = null;         // the read in flight; a second caller shares it
let phRecAnnounced = "";     // the warning a screen reader was last told
let phRecOpened = "";        // the recovery the alert screen opened for
const PH_REC_SEEN = "zold-recovery-seen";
const PH_REC_OPEN = ["PASSKEY_PENDING", "OTP_PENDING", "KYC_PENDING", "REVIEW_PENDING"];
const phRecSig = (r) => (r?.chain ? `chain:${r.chain.executeAfter}` : r?.request ? `req:${r.request.id}` : "");

/* Has "It was me" hidden this very recovery in this tab? */
function phRecSeen(r) {
  let seen = "";
  try { seen = sessionStorage.getItem(PH_REC_SEEN) || ""; } catch { /* no storage: always show */ }
  return Boolean(phRecSig(r)) && seen === phRecSig(r);
}

/* When the module lets a recovery finish, or null when the chain's number
   is not a usable time: the warning still shows, without a date. */
function phRecUntil(chain) {
  const t = Number(chain?.executeAfter);
  return Number.isFinite(t) && t > 0 ? new Date(t * 1000) : null;
}

/* Which warning the strip shows: "" for none, "failed", or the recovery's
   signature. Not on the alert screen itself, and not for a recovery "It was
   me" hid; a failed check is never hidden. */
function phRecBarKey() {
  if (!phRec || phRoute?.name === "recovery-alert") return "";
  if (phRec.failed && !(phRec.chain || phRec.request)) return "failed";
  if (!(phRec.chain || phRec.request) || phRecSeen(phRec)) return "";
  return phRecSig(phRec);
}

/* The strip above every app screen, the redesigned ones and the older ones
   alike (#ph-recbar in index.html sits outside both), while a recovery is
   under way or the check failed: the grace period plus the owner's cancel
   is the only defence, so the warning does not wait for Home. */
function phRecBar() {
  const key = phRecBarKey();
  if (!key) return "";
  const go = (label, variant) => `<a class="z-btn z-btn--${variant} z-btn--sm" href="#recovery-alert">${esc(label)}</a>`;
  if (key === "failed") {
    return `<div class="z-banner" role="note">${Z.icon("help")}<span><b>We couldn’t check for a recovery.</b> If someone started one, it would replace your passkey.</span>${go("Check now", "secondary")}</div>`;
  }
  const until = phRec.chain ? phRecUntil(phRec.chain) : null;
  const text = phRec.chain
    ? `<b>Someone is moving your account to a new phone.</b> ${until ? `It completes on ${esc(rcWhenText(until))} unless you cancel.` : "It completes after the waiting period unless you cancel."}`
    : "<b>Someone asked to move your account to a new phone.</b> Nothing has been signed yet.";
  return `<div class="z-banner z-banner--alert" role="note">${Z.icon("gpp_maybe")}<span>${text}</span>${go("Review", "primary")}</div>`;
}

/* Redraw only the strip, so a check never closes a sheet or eats typing.
   Each warning is announced once per page, however often the strip is
   redrawn or the person changes screen. */
function phRecBarSync() {
  const el = $("ph-recbar");
  if (!el) return;
  const key = phRecBarKey();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = phRecBar();
  el.hidden = !key;
  if (key && key !== phRecAnnounced) {
    phRecAnnounced = key;
    Z.announce(el.textContent);
  }
}

/* No guardian can run a recovery here, or the account has no Safe: nothing
   to find, and nothing from an earlier read stays up. */
function phRecNone() {
  phRec = { none: true };
  phRecBarSync();
  if (phRoute?.name === "recovery-alert") phRender();
}

/* A read that did not work. A recovery an earlier read found stays up, so a
   flaky (or provoked) error cannot turn "someone is moving your account"
   into the vaguer "couldn't check"; with nothing known it says it could not
   check, never that nothing is under way. */
function phRecFailed() {
  phRec = phRec?.chain || phRec?.request ? { ...phRec, failed: true } : { failed: true };
  phRecBarSync();
  if (phRoute?.name === "recovery-alert") phRender();
}

/* Read both guardians, at most once a minute. The account poll calls this
   (app/monerium.js refresh), as do Home, a tab coming back into view, and a
   company login on its way to /business (app/phone.js phCompanyLeave). Only
   one read runs at a time, so an older answer can never land after a newer
   one. A recovery found here shows the strip, and the first time it is
   found while Home is open (no sheet over it) it opens the alert. */
function phRecoveryCheck({ force = false } = {}) {
  if (phRecRun) return phRecRun;
  if (!force && Date.now() - phRecReadAt < 60000) return Promise.resolve();
  phRecReadAt = Date.now();
  phRecRun = phRecRead()
    .catch(() => {
      // A bug here must not read as "nothing under way", and is asked
      // again at the next poll rather than in a minute.
      phRecReadAt = 0;
      try { phRecFailed(); } catch { /* phRec already says failed; the next render draws it */ }
    })
    .finally(() => { phRecRun = null; });
  return phRecRun;
}

async function phRecRead() {
  // Which guardians exist here comes from /api/health. Unread, nothing says
  // there is none: ask again, and say it could not check if that fails too.
  if (!capsLoaded) await loadCapabilities();
  if (!capsLoaded) return phRecFailed();
  if (!user?.id || user.passkeySafe?.status !== "active" || (!caps.emailSmsRecovery && !caps.zoldenburgRecovery && !caps.turnkeyGuardians)) return phRecNone();
  const [c, z, t] = await Promise.all([
    caps.emailSmsRecovery ? api(`/api/users/${user.id}/recovery/candide`).catch(() => null) : undefined,
    caps.zoldenburgRecovery ? api(`/api/users/${user.id}/recovery/zoldenburg`).catch(() => null) : undefined,
    caps.turnkeyGuardians ? api(`/api/users/${user.id}/recovery/turnkey/requests`).catch(() => null) : undefined,
  ]);
  const chain = z?.onChain?.pendingRecovery || c?.onChain?.pendingRecovery || t?.onChain?.pendingRecovery || null;
  const reqs = [...(Array.isArray(z?.requests) ? z.requests : []), ...(Array.isArray(t?.requests) ? t.requests : [])];
  const request = chain ? null : reqs.find((r) => PH_REC_OPEN.includes(r?.status)) || null;
  // Nothing found is only "none" when every read worked, by the same rule
  // as /business (access-model.js recoveryStatus): a guardian switched on
  // that did not answer (null; undefined is one not asked), a chain read
  // that failed, or an answer without its chain reading is "couldn't check".
  // The Zoldenburg route reads the module for any active Safe, so its chain
  // error counts whether or not Zoldenburg is the guardian.
  const unread = c === null || z === null || t === null
    || Boolean(z && (z.onChainError || !z.onChain))
    || Boolean(t && (t.onChainError || !t.onChain))
    || Boolean(c && (c.onChain?.error || (c.guardianStatus === "active" && !c.onChain)));
  if (!chain && !request && unread) return phRecFailed();
  // Which guardian is moving it, where the reads say so; otherwise left out.
  const kinds = [...new Set((Array.isArray(c?.channels) ? c.channels : []).map((x) => (x.channel === "sms" ? "phone" : "email")))];
  const codes = kinds.length ? `${kinds.join(" and ").replace(/^./, (x) => x.toUpperCase())} ${kinds.length > 1 ? "codes" : "code"}` : "Email or phone codes";
  const byLogin = (r) => r?.mode === "turnkey";
  const method = !chain ? (byLogin(request) ? "Your Google or Apple guardian" : "Zoldenburg ID check")
    : reqs.some((r) => r?.status === "GRACE_PERIOD") ? (reqs.some((r) => r?.status === "GRACE_PERIOD" && byLogin(r)) ? "Your Google or Apple guardian" : "Zoldenburg ID check")
      : c?.guardianStatus === "active" && !z?.active ? codes : null;
  phRec = chain || request ? { chain, request, method } : { none: true };
  phRecBarSync();
  if (phRoute?.name === "recovery-alert") return phRender();
  if (phRec.none) return;
  const sig = phRecSig(phRec);
  const sheetOpen = Boolean(document.querySelector("body > .z-scrim[data-ph]:not([hidden])"));
  if (phRoute?.name === "home" && !phRecSeen(phRec) && sig !== phRecOpened && !sheetOpen) {
    phRecOpened = sig;
    phGo("recovery-alert");
  }
}

/* Back on the tab after a while away: ask now, not at the next minute. */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && phRoute) phRecoveryCheck({ force: Date.now() - phRecReadAt > 15000 });
});

PH["recovery-alert"] = {
  title: "Recovery under way",
  html() {
    if (phRecDone) {
      return phMain(`
        <span class="z-tile z-tile--m z-tile--lg" aria-hidden="true">${Z.icon("verified_user")}</span>
        <div class="z-intro"><h1 class="z-title">Recovery cancelled</h1><p class="z-sub">Your account stays with this phone. If you didn’t start that recovery, someone may know your email. Check your recovery settings.</p></div>
      `, "z-app__main--state")
        + phFoot(`${Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" })}<a class="z-link-btn" href="#recovery-settings">Recovery settings</a>`);
    }
    if (!phRec) return `${Z.topbar({ srTitle: "Recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(Z.skeletonRows(2, "Checking for a recovery…"))}`;
    if (phRec.failed && !(phRec.chain || phRec.request)) {
      return `${Z.topbar({ srTitle: "Recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(`
        <div class="z-intro"><h2 class="z-title">Couldn’t check for a recovery</h2><p class="z-sub">Zold couldn’t read whether someone is moving your account to another phone. Try again, or open Recovery settings.</p></div>`)}${phFoot(`${Z.button({ variant: "primary", full: true, label: "Try again", id: "ph-rec-retry" })}<a class="z-link-btn" href="#recovery-settings">Recovery settings</a>${user?.accountType === "company" ? `<a class="z-link-btn" href="${esc(phWebHref())}">Continue to Zold Business without checking</a>` : ""}`)}`;
    }
    if (phRec.none) {
      return `${Z.topbar({ srTitle: "No recovery under way", back: { href: "#home", label: "Back to Home" } })}${phMain(`
        <div class="z-intro"><h2 class="z-title">No recovery under way</h2><p class="z-sub">Nobody is moving your account to another phone.</p></div>`)}${phFoot(Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" }))}`;
    }
    const { chain, request, method } = phRec;
    const until = chain ? phRecUntil(chain) : null;
    const left = until ? until.getTime() - Date.now() : 0;
    const title = chain ? "Someone is moving your account to a new phone" : "Someone asked to move your account to a new phone";
    const asked = request?.requestedAt ? new Date(request.requestedAt) : null;
    const lede = chain
      ? (until ? `It completes on ${rcWhenText(until)} unless you cancel.` : "It completes after the waiting period unless you cancel.")
      : `They asked Zoldenburg support${asked && Number.isFinite(asked.getTime()) ? ` on ${rcWhenText(asked)}` : ""}. Nothing has been signed yet.`;
    const rows = [
      ...(method ? [{ key: "Recovery method", value: method }] : []),
      ...(chain && until ? [{ key: "Time left to cancel", valueHtml: `<span class="z-warn-fig">${esc(left > 0 ? rcLeftText(left) : "Finishing…")}</span>` }] : []),
      ...(phRec.failed ? [{ key: "Last check", value: "Failed. This is what the previous check found." }] : []),
      ...(request?.zoldenburg?.reference ? [{ key: "Their reference", value: request.zoldenburg.reference, mono: true }] : []),
    ];
    return phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("gpp_maybe")}</span>
      <div class="z-intro"><h1 class="z-title">${esc(title)}</h1><p class="z-sub">${esc(lede)}</p></div>
      ${rows.length ? Z.kv(rows) : ""}
      <p class="z-sub">If this wasn’t you, cancel now. Nothing moves while you decide, and your money stays in your account.</p>
      <div class="z-alert hidden" role="alert" id="ph-rec-err"></div>
    `, "z-app__main--state")
      + phFoot(`${Z.button({ variant: "primary", full: true, icon: chain ? "passkey" : "block", label: chain ? "Cancel with Face ID" : "Cancel the request", id: "ph-rec-cancel" })}
        ${Z.button({ variant: "secondary", full: true, label: "It was me", id: "ph-rec-mine" })}
        <p class="z-screen__fine z-screen__fine--flush">“It was me” only hides this on this phone. ${chain ? "The move goes ahead." : "The request stays open."}</p>`);
  },
  bind(root) {
    if (!phRec) phRecoveryCheck({ force: true });
    const retry = root.querySelector("#ph-rec-retry");
    if (retry) retry.onclick = () => { phRec = null; phRender({ focus: true }); };
    const cancel = root.querySelector("#ph-rec-cancel");
    if (cancel) cancel.onclick = async () => {
      if (Z.isDisabled(cancel)) return;
      clearErr("ph-rec-err");
      Z.setLoading(cancel, true);
      try {
        if (phRec.chain) await recoveryCancelRun();
        else await api(`/api/users/${user.id}/recovery/${phRec.request.mode === "turnkey" ? "turnkey" : "zoldenburg"}/requests/${phRec.request.id}/cancel`, {});
        phRec = null;
        phRecBarSync();
        phRecDone = true;
        phRender({ focus: true });
        phRecDone = false;
      } catch (e) {
        showErr("ph-rec-err", e?.name === "NotAllowedError" ? new Error("Face ID or fingerprint was cancelled. The recovery is still under way.") : e);
      } finally { if (cancel.isConnected) Z.setLoading(cancel, false); }
    };
    const mine = root.querySelector("#ph-rec-mine");
    if (mine) mine.onclick = () => {
      // Hides the alert and the strip for this recovery, in this tab only.
      try { sessionStorage.setItem(PH_REC_SEEN, phRecSig(phRec)); } catch { /* shows again next time */ }
      phRecOpened = phRecSig(phRec);
      phGo("home", null, { replace: true });
    };
  },
};

/* ==========================================================================
   Account details (a sheet over Home)
   ========================================================================== */

/* The BIC Monerium lists for this IBAN. Read once per IBAN. */
async function phLoadBic() {
  const iban = user?.iban || "";
  if (!iban || !user?.id) return null;
  if (phCache.bicFor === iban && phCache.bic !== undefined) return phCache.bic;
  if (user.bic) { phCache.bic = user.bic; phCache.bicFor = iban; return user.bic; }
  try {
    const r = await api(`/api/users/${user.id}/bic`);
    phCache.bic = r.bic || null;
  } catch {
    phCache.bic = null;
  }
  phCache.bicFor = iban;
  return phCache.bic;
}

function phDetailsText(u, bic) {
  return [`Account holder: ${ownAccountName(u)}`, `IBAN: ${Z.groupIban(u.iban)}`, ...(bic ? [`BIC: ${bic}`] : [])].join("\n");
}

/* The account details body, used by the sheet and by Get paid. */
function phDetailsBody(u, bic, { loadingBic = false } = {}) {
  if (!u.iban || !kycApproved(u)) {
    return `<p class="z-sub">Your IBAN appears here once Monerium has verified you and issued it.</p>
      ${Z.button({ variant: "primary", full: true, label: "Verify with Monerium", id: "ph-det-verify" })}`;
  }
  const bicRow = loadingBic
    ? `<li><div class="z-copy" aria-hidden="true"><span class="z-copy__main"><span class="z-copy__label">BIC</span><span class="z-skel z-skel--line" style="width:40%;margin-top:6px"></span></span></div></li>`
    : bic ? `<li>${Z.copyRow({ label: "BIC", value: bic, mono: true })}</li>` : "";
  const wallet = u.address && u.passkeySafe?.status === "active"
    ? `<details class="z-disclose"><summary>Crypto wallet address${Z.icon("expand_more")}</summary>
        <div class="z-card">${Z.copyRow({ label: "Your wallet address", value: u.address, mono: true })}</div>
        ${Z.note({ tone: "a", text: `Only ${usdSym()} on the Base network. Anything else sent here is lost.` })}</details>`
    : "";
  return `<p class="z-sub">Share these to get paid by bank transfer.</p>
    <ul class="z-list z-card">
      <li>${Z.copyRow({ label: "Account holder", value: ownAccountName(u) })}</li>
      <li>${Z.copyRow({ label: "IBAN", value: String(u.iban).replace(/\s+/g, ""), display: Z.groupIban(u.iban), mono: true })}</li>
      ${bicRow}
    </ul>
    ${wallet}
    <div class="z-pair">
      ${Z.button({ icon: "content_copy", label: "Copy all", id: "ph-det-copy" })}
      ${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-det-share" })}
    </div>`;
}

function phBindDetails(root) {
  const verify = root.querySelector("#ph-det-verify");
  if (verify) verify.onclick = () => { Z.closeOverlay(); enterKycReview(user?.name || "Account"); };
  const copy = root.querySelector("#ph-det-copy");
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(phDetailsText(user, phCache.bic)); Z.announce("Copied"); }
    catch { Z.announce("Could not copy. Select the text and copy it yourself."); }
  };
  const share = root.querySelector("#ph-det-share");
  if (share) share.onclick = () => phShare("My account details", phDetailsText(user, phCache.bic));
}

PH["account-details"] = {
  title: "Account details",
  tab: "home",
  html: () => PH.home.html(),
  bind(root) {
    PH.home.bind(root);
    const u = user || {};
    const ready = u.iban && kycApproved(u);
    const known = phCache.bicFor === u.iban && phCache.bic !== undefined;
    const sheetHtml = Z.overlay({
      id: "ph-details",
      title: "Account details",
      body: `<div class="z-sheet__body" id="ph-details-body">${phDetailsBody(u, known ? phCache.bic : null, { loadingBic: ready && !known })}</div>`,
    });
    document.body.insertAdjacentHTML("beforeend", sheetHtml);
    const scrim = $("ph-details");
    scrim.dataset.ph = "1";
    if (ready) scrim.querySelector(".z-overlay__head h2").insertAdjacentHTML("afterend", Z.tag("Active"));
    phBindDetails(scrim);
    Z.openOverlay("ph-details", root.querySelector('a[href="#account-details"]'));
    // Closing the sheet is going back to Home.
    const watch = new MutationObserver(() => {
      if (!scrim.classList.contains("is-open")) {
        watch.disconnect();
        if (phRoute?.name === "account-details") {
          if (history.state?.ph && history.length > 1) history.back(); else phGo("home", null, { replace: true });
        }
      }
    });
    watch.observe(scrim, { attributes: true, attributeFilter: ["class"] });
    if (ready && !known) {
      phLoadBic().then(() => {
        const body = $("ph-details-body");
        if (!body || phRoute?.name !== "account-details") return;
        body.innerHTML = phDetailsBody(user, phCache.bic);
        phBindDetails(scrim);
      });
    }
  },
};

