/**
 * The phone app: Send (payee, amount, review, progress).
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Send
   ========================================================================== */

/* The send in progress. The IBAN is what the device signs a commitment over,
   so it is always on screen before the approval. */
let phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };

/* People this account has paid, newest first, one per IBAN. */
function phPayees() {
  const seen = new Map();
  for (const t of hist) {
    if (t.kind === "funding" || t.rail !== "sepa" || !t.recipientIban) continue;
    const key = String(t.recipientIban).replace(/\s+/g, "").toUpperCase();
    if (!seen.has(key)) seen.set(key, { key, name: t.recipientName || "", iban: key, count: 0, payments: [] });
    const p = seen.get(key);
    p.count += 1;
    p.payments.push(t);
  }
  return [...seen.values()];
}

/* Why sending is closed, and the one thing that opens it. null: open. */
function phSendBlocked(u = user) {
  if (!HAS("onchain_balance")) return { text: "Sending is not part of this account.", action: null };
  // Send is a bank transfer today; sending to a crypto wallet is not built.
  if (!bankOffered(u) && !kycApproved(u)) return { text: "Sending here is a bank transfer, and this account has no bank account. Sending to a crypto wallet isn’t built yet.", action: null };
  if (!kycApproved(u) || !u?.iban) return { text: "Sending opens once Monerium has verified you and your IBAN is active.", action: { id: "ph-send-verify", label: "Verify with Monerium" } };
  return null;
}

function phPayeeRow(p, href) {
  return Z.row({ lead: Z.avatar({ name: p.name }), title: p.name || "Payee", sub: phMaskIban(p.iban), href });
}

PH.send = {
  title: "Send",
  tab: "send",
  live: () => `${user?.kycStatus}|${user?.iban}|${phHistSig()}`,
  html() {
    const blocked = phSendBlocked();
    const payees = phPayees();
    const q = phQuery;
    return `${phTop("Send")}${phMain(`
      ${blocked ? `${Z.note({ tone: "a", text: blocked.text })}${blocked.action ? Z.button({ variant: "primary", full: true, label: blocked.action.label, id: blocked.action.id }) : ""}` : `
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-sq">Search people you’ve paid</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-sq" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Name or IBAN…" value="">
      </form>
      <div id="ph-send-matches"></div>
      ${payees.length ? `<section class="z-group" aria-labelledby="ph-recent"><div class="z-group__head"><h2 class="z-eyebrow" id="ph-recent">Recent</h2></div>
        <div class="z-rail">${payees.slice(0, 6).map((p) => `<a class="z-rail__item" href="${phHref("send/amount", p.key)}">${Z.avatar({ name: p.name })}<span>${esc(phFirst(p.name) || "Payee")}</span></a>`).join("")}</div></section>` : ""}
      ${Z.listGroup({
        label: "New payment",
        rows: [
          Z.row({ lead: Z.iconTile({ icon: "account_balance", tone: "p" }), title: "Bank transfer", sub: "To any IBAN in Europe, no Zold fee", right: Z.tag("Beta"), href: "#send/new" }),
          Z.soonRow({ lead: Z.iconTile({ icon: "account_balance_wallet" }), title: "Crypto wallet", sub: `Send digital dollars (${usdSym()}) to a wallet` }),
        ],
      })}
      ${Z.listGroup({
        label: "People you’ve paid",
        rows: payees.map((p) => phPayeeRow(p, phHref("send/amount", p.key))),
        empty: { text: "The people you pay appear here." },
      })}`}
    `)}`;
  },
  bind(root) {
    // A new send starts clean; the amount screen fills in from the payee.
    phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };
    const v = root.querySelector("#ph-send-verify");
    if (v) v.onclick = () => enterKycReview(user?.name || "Account");
    const q = root.querySelector("#ph-sq");
    if (!q) return;
    q.oninput = () => {
      const needle = q.value.trim().toLowerCase().replace(/\s+/g, "");
      const out = root.querySelector("#ph-send-matches");
      if (!needle) { out.innerHTML = ""; return; }
      const hits = phPayees().filter((p) => p.name.toLowerCase().replace(/\s+/g, "").includes(needle) || p.iban.toLowerCase().includes(needle));
      const looksIban = /^[a-z]{2}\d{2}[a-z0-9]{8,}$/i.test(needle);
      out.innerHTML = Z.listGroup({
        rows: [
          ...hits.map((p) => phPayeeRow(p, phHref("send/amount", p.key))),
          ...(looksIban && !hits.length ? [Z.row({ lead: Z.iconTile({ icon: "add" }), title: "Pay a new IBAN", sub: Z.groupIban(needle.toUpperCase()), href: `#send/new/${encodeURIComponent(needle.toUpperCase())}` })] : []),
        ],
        empty: { text: "Nobody you’ve paid matches that.", action: { href: "#send/new", label: "New bank transfer" } },
      });
    };
  },
};

/* A new payee: name and IBAN. No design of its own; built from the field and
   the pinned action, like the onboarding forms. */
PH["send/new"] = {
  title: "New bank transfer",
  html(prefill) {
    const p = phSend.payee && !phSend.payee.fromHistory ? phSend.payee : null;
    return `${phTop("New bank transfer", "send")}<form id="ph-new" class="z-app__form" novalidate>${phMain(`
      <div class="z-form">
        ${Z.field({ id: "ph-new-name", label: "Their full name", name: "name", autocomplete: "off", placeholder: "Name on their account…", value: p?.name || "", required: true })}
        ${Z.field({ id: "ph-new-iban", label: "IBAN", name: "iban", autocomplete: "off", spellcheck: false, placeholder: "DE89 3704 0044 0532 0130 00…", value: p?.iban ? Z.groupIban(p.iban) : prefill ? Z.groupIban(prefill) : "", required: true })}
      </div>
      ${Z.note({ text: "Check the name and IBAN with them. Your Face ID approves the payment to exactly this IBAN." })}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Continue", type: "submit" }))}</form>`;
  },
  bind(root) {
    root.querySelector("#ph-new").onsubmit = (e) => {
      e.preventDefault();
      const name = root.querySelector("#ph-new-name");
      const iban = root.querySelector("#ph-new-iban");
      const clean = iban.value.replace(/\s+/g, "").toUpperCase();
      Z.setFieldError(name, name.value.trim() ? "" : "Enter the name on their account.");
      Z.setFieldError(iban, /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(clean) ? "" : "Enter an IBAN, like DE89 3704 0044 0532 0130 00.");
      if (Z.focusFirstError(root)) return;
      phSend = { payee: { name: name.value.trim(), iban: clean }, amount: "", reference: "", quote: null, transferId: null, error: null };
      phGo("send/amount", "new");
    };
  },
};

/** The payee for the amount step: from history by IBAN, or the one typed. */
function phPayeeFor(arg) {
  if (arg && arg !== "new") {
    const p = phPayees().find((x) => x.key === String(arg).toUpperCase());
    if (p) return { name: p.name, iban: p.iban, fromHistory: true };
  }
  return phSend.payee;
}

let phQuoteSeq = 0, phQuoteTimer = null;

/* The key-value rows without the card, as the amount screen draws them. */
const phFlatKv = (rows) => Z.kv(rows).replace('class="z-kv z-card"', 'class="z-kv z-kv--flat"');

function phQuoteRows(q, payee) {
  const first = phFirst(payee?.name) || "They";
  return phFlatKv([
    { key: "Zold fee", value: q ? phEur(q.fixedFeeEur) : phEur(0) },
    { key: "Exchange", value: "None, euro to euro" },
    { key: "Sent as", value: "Bank transfer" },
    { key: `${first} receives`, value: q ? phEur(q.receiveEur) : "Enter an amount" },
  ]);
}

PH["send/amount"] = {
  title: "Amount",
  // Redraw once, when a payee named in the URL is found in the loaded history.
  live: (arg) => `${!!phPayeeFor(arg)}|${histLoaded}`,
  html(arg) {
    const payee = phPayeeFor(arg);
    if (!payee && arg && arg !== "new" && !histLoaded && !histLoadFailed) return `${phTop("Amount", "send")}${phMain(Z.skeletonRows(2, "Loading…"))}`;
    if (!payee) return `${phTop("Amount", "send")}${phMain(Z.note({ text: "Pick who to pay first." }) + Z.button({ variant: "primary", full: true, label: "Choose a person", href: "#send" }))}`;
    const blocked = phSendBlocked();
    return `${phTop("Amount", "send")}<form id="ph-amt" class="z-app__form" novalidate>${phMain(`
      <div class="z-chip-payee">${Z.avatar({ name: payee.name })}<span class="z-row__title">${esc(payee.name)}</span><span class="z-mono z-dim" translate="no">•••• ${esc(payee.iban.slice(-4))}</span></div>
      ${blocked ? Z.note({ tone: "a", text: blocked.text }) : ""}
      <div class="z-amount-in">
        <label for="ph-amount" class="z-amount-in__label">You send</label>
        <div class="z-amount-in__box"><span class="z-amount-in__cur" aria-hidden="true">€</span>
          <input id="ph-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00…" value="${esc(phSend.amount)}" aria-describedby="ph-amount-hint ph-amount-err"></div>
        <p class="z-hint z-fig" id="ph-amount-hint">Available ${esc(phEur(user?.balanceEur ?? 0))}</p>
        <p class="z-err" id="ph-amount-err" role="alert" hidden></p>
      </div>
      <div id="ph-quote" aria-live="polite">${phQuoteRows(null, payee)}</div>
      ${Z.field({ id: "ph-ref", label: "Reference", optional: true, name: "reference", autocomplete: "off", placeholder: "What it’s for…", maxlength: 140, value: phSend.reference, hint: "Shown on their bank statement." })}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Enter an amount", type: "submit", id: "ph-amt-next", disabledReason: undefined }))}</form>`;
  },
  bind(root, arg) {
    const payee = phPayeeFor(arg);
    if (!payee) return;
    phSend.payee = payee;
    const input = root.querySelector("#ph-amount");
    const next = root.querySelector("#ph-amt-next");
    const err = root.querySelector("#ph-amount-err");
    const setNext = (label, ok) => {
      next.querySelector("span").textContent = label;
      if (ok) next.removeAttribute("aria-disabled"); else next.setAttribute("aria-disabled", "true");
    };
    const showErr = (msg) => { err.textContent = msg || ""; err.hidden = !msg; if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); };
    const price = async () => {
      const typed = input.value.trim();
      phSend.amount = typed;
      phSend.quote = null;
      const seq = ++phQuoteSeq;
      showErr("");
      root.querySelector("#ph-quote").innerHTML = phQuoteRows(null, payee);
      if (!typed) { setNext("Enter an amount", false); return; }
      const n = parseEurInput(typed);
      if (!(n > 0)) { setNext("Enter an amount", false); showErr(eurInputError(typed)); return; }
      if (phSendBlocked()) { setNext("Sending is not open yet", false); return; }
      if (n > (user?.balanceEur ?? 0)) { setNext("More than your balance", false); showErr(`You have ${phEur(user?.balanceEur ?? 0)}.`); return; }
      setNext("Pricing…", false);
      try {
        const q = await api("/api/quotes", { userId: user.id, rail: "sepa", sendEur: n });
        if (seq !== phQuoteSeq) return;
        phSend.quote = q;
        root.querySelector("#ph-quote").innerHTML = phQuoteRows(q, payee);
        setNext("Review", true);
      } catch (e) {
        if (seq !== phQuoteSeq) return;
        setNext("Enter an amount", false);
        showErr(e.message);
      }
    };
    input.oninput = () => { clearTimeout(phQuoteTimer); phQuoteTimer = setTimeout(price, 450); };
    root.querySelector("#ph-ref").oninput = (e) => { phSend.reference = e.target.value; };
    root.querySelector("#ph-amt").onsubmit = (e) => {
      e.preventDefault();
      if (Z.isDisabled(next) || !phSend.quote) { input.focus(); return; }
      phSend.reference = root.querySelector("#ph-ref").value.trim();
      phGo("send/review");
    };
    if (input.value) price(); else setNext("Enter an amount", false);
  },
};

/* Same IBAN, however it is spaced or cased. */
const phSameIban = (a, b) => Boolean(a && b) && String(a).replace(/\s+/g, "").toUpperCase() === String(b).replace(/\s+/g, "").toUpperCase();

PH["send/review"] = {
  title: "Review payment",
  html() {
    const { payee, quote: q } = phSend;
    if (!payee || !q) return `${phTop("Review payment", "send")}${phMain(Z.note({ text: "This payment has no price yet. Enter the amount again." }) + Z.button({ variant: "primary", full: true, label: "Back to Send", href: "#send" }))}`;
    const first = phFirst(payee.name) || "They";
    return `${phTop("Review payment", "send/amount")}${phMain(`
      <div><p class="z-eyebrow">You send</p>${phBalanceFig(q.sendEur)}</div>
      <div class="z-card z-payee">${Z.avatar({ name: payee.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(payee.name)}</span><span class="z-mono z-dim" translate="no">${esc(Z.groupIban(payee.iban))}</span></span>${Z.tag("Beta")}</div>
      ${Z.kv([
        { key: "From", value: `${ownAccountKind()} account` },
        { key: "Zold fee", value: phEur(q.fixedFeeEur) },
        { key: "Exchange", value: "None, euro to euro" },
        { key: "Sent as", value: "Bank transfer" },
        ...(phSend.reference ? [{ key: "Reference", value: phSend.reference }] : []),
        { key: `${first} receives`, value: phEur(q.receiveEur), strong: true },
      ])}
      ${phSameIban(payee.iban, user?.iban) ? Z.note({ tone: "a", icon: "sync_alt", text: "This is your own IBAN. The money leaves and comes back to this account, minus the Zold fee." }) : ""}
      ${Z.note({ icon: "verified_user", text: "Your Face ID approves this amount to this IBAN only. If either changes, nothing is sent." })}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        { key: "Price", value: q.id, mono: true },
        { key: "Price valid until", value: phFull(q.expiresAt) },
      ])}</details>
      <p class="z-err" id="ph-rev-err" role="alert" hidden></p>
    `)}${phFoot(Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Approve with Face ID", id: "ph-approve" }))}`;
  },
  bind(root) {
    const b = root.querySelector("#ph-approve");
    if (b) b.onclick = () => phSubmit(b, root.querySelector("#ph-rev-err"));
  },
};

/* The display figure for a single amount (review, results). */
function phBalanceFig(value) {
  const m = /^€([\d,]+)(\.\d{2})$/.exec(phEur(value));
  return `<p class="z-balance__fig z-fig"><span class="z-balance__cur">€</span>${esc(m ? m[1] : "")}<span class="z-balance__cents">${esc(m ? m[2] : "")}</span></p>`;
}

/**
 * Create, sign, authorise. The same guarantees as before this redesign: the
 * device recomputes the payout commitment and refuses to sign when the
 * server's terms name a different recipient, and the passkey signs the Safe
 * operation that is the debit.
 */
async function phSubmit(btn, errEl) {
  if (Z.isDisabled(btn)) return;
  errEl.hidden = true;
  Z.setLoading(btn, true);
  const { payee, quote: q } = phSend;
  let created = null;
  try {
    if (phSendBlocked()) throw new Error(phSendBlocked().text);
    if (!user.authorizerAddress) await registerDeviceKey(user);
    const recipient = { recipientName: payee.name, recipientIban: payee.iban };
    created = await api("/api/transfers", { quoteId: q.id, ...recipient, ...(phSend.reference ? { reference: phSend.reference } : {}) });
    phSend.transferId = created.id;
    const dev = await deviceLib;
    const addr = await dev.deviceAddress(credId());
    if (created.authorization.authorizer.toLowerCase() !== addr.toLowerCase()) {
      throw new Error("This account’s approval key is on a different browser. Send from there, or change the key there first.");
    }
    const expected = dev.destinationCommitment("sepa", { iban: recipient.recipientIban, name: recipient.recipientName });
    if (created.authorization.typedData.message.destination.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("The payment terms name a different recipient from the one you entered. Nothing was signed.");
    }
    const signature = await dev.signTypedData(created.authorization.typedData, credId());
    const execution = await safeExecutionAssertion(created.authorization);
    const redeem = await moneriumRedeemAssertion(created.authorization);
    const t = await api(`/api/transfers/${created.id}/authorize`, {
      signature,
      ...(execution ? { executionAssertion: execution } : {}),
      ...(redeem ? { moneriumRedeemAssertion: redeem } : {}),
    });
    phPutTransfer(t);
    refresh();
    phGo("send/progress", t.id, { replace: true });
  } catch (e) {
    Z.setLoading(btn, false);
    if (!created) {
      // Nothing was created: say why here, on the screen the user is on.
      errEl.textContent = e?.name === "NotAllowedError" ? "Face ID or fingerprint was cancelled. Nothing was sent." : e.message;
      errEl.hidden = false;
      return;
    }
    // A transfer exists: its own state decides what the user is told.
    phSend.error = e?.name === "NotAllowedError" ? "You cancelled Face ID or fingerprint." : e.message;
    try {
      const fresh = await api(`/api/transfers/${created.id}`);
      phPutTransfer(fresh);
    } catch { phPutTransfer(created); }
    phGo("send/error", created.id, { replace: true });
  }
}

/* Put a transfer into the activity list, new or updated. */
function phPutTransfer(t) {
  const row = { kind: "transfer", at: t.createdAt, ...t };
  if (hist.some((x) => x.id === t.id)) updateHistory(row); else addHistory(row);
}

/* Progress: approved, sent to the bank, paid. Paid only when the API says so. */
function phTimeline(t) {
  const approved = !!(t.auth?.authorizedAt || t.moneriumRedeem?.signedAt) || !["CREATED"].includes(t.state);
  const sent = ["PAYOUT_SUBMITTED", "PAID"].includes(t.state);
  const paid = t.state === "PAID";
  const time = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "");
  const steps = [
    { t: "Approved", d: approved ? `With Face ID${t.auth?.authorizedAt ? `, ${time(t.auth.authorizedAt)}` : ""}` : "Waiting for your approval", done: approved },
    { t: "Sent to their bank", d: sent ? "Left your account. Waiting for the bank to confirm." : "Next, once approved", done: sent },
    { t: "Paid", d: paid ? `Their bank confirmed${t.updatedAt ? `, ${time(t.updatedAt)}` : ""}` : "We mark it paid when the bank confirms", done: paid },
  ];
  const now = steps.findIndex((s) => !s.done);
  return `<ol class="z-timeline">${steps.map((s, i) => `<li class="${s.done ? "is-done" : i === now ? "is-now" : ""}">
      <span class="z-timeline__mark" aria-hidden="true">${s.done ? Z.icon("check") : ""}</span>
      <span class="z-timeline__main"><span class="z-timeline__title">${esc(s.t)}<span class="z-sr">${s.done ? ", done" : i === now ? ", in progress" : ", not yet"}</span></span><span class="z-timeline__sub">${esc(s.d)}</span></span></li>`).join("")}</ol>`;
}

PH["send/progress"] = {
  title: "Payment progress",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? `${t.state}|${t.sepa?.state}` : "none"; },
  html(id) {
    const t = hist.find((x) => x.id === id);
    if (!t) return `${phTop("", "home")}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    if (["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state)) return PH["send/error"].html(id);
    return `${Z.topbar({ srTitle: "Payment progress", back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <div>${Z.tag(phTxWord(t))}${phBalanceFig(t.sendEur)}<p class="z-sub">to ${esc(t.recipientName || "")}</p></div>
      <div aria-live="polite">${phTimeline(t)}</div>
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        { key: "Payment ID", value: t.id, mono: true },
        ...(t.sepa?.orderId ? [{ key: "Monerium order", value: t.sepa.orderId, mono: true }, { key: "Order state", value: t.sepa.state || "" }] : []),
      ])}</details>
    `)}${phFoot(`<div class="z-pair">${t.state !== "CREATED" ? Z.button({ icon: "ios_share", label: "Share receipt", href: phHref("share", t.id) }) : ""}${Z.button({ variant: "primary", label: "Done", href: "#home", className: t.state === "CREATED" ? "z-btn--full" : "" })}</div>`)}`;
  },
  bind(root, id) {
    if (!hist.some((x) => x.id === id) && id) {
      api(`/api/transfers/${encodeURIComponent(id)}`).then((t) => { phPutTransfer(t); phRender(); }).catch(() => {});
    }
  },
};

/* Nothing was sent, or we do not know yet: words from the real state. */
PH["send/error"] = {
  title: "Payment not sent",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? t.state : "none"; },
  html(id) {
    const t = hist.find((x) => x.id === id) || {};
    const review = t.state === "MANUAL_REVIEW";
    const refunded = t.state === "REFUNDED";
    // FAILED after money left the Safe is on its way back (the server
    // compensates it); FAILED before that moved nothing. The debit steps are
    // the server's DEBIT_STEP: an intent step ("0x") is not money that left.
    const returning = t.state === "FAILED" && (t.txs || []).some((x) => x.step === "safe.transfer(orchestrator)" || x.step === "safe.transfer(fee)");
    const title = review ? "We’re checking this payment" : returning ? "This payment failed" : "Nothing was sent";
    const lede = review
      ? "We can’t tell yet whether it reached the bank, so nothing is refunded automatically. Write to support@zoldhq.com and we’ll look into it."
      : refunded ? `It was refused, and ${phEur(t.refund?.amountEur ?? t.sendEur)} is back in your account.`
        : returning ? "The money that left your account is being returned. It shows as refunded once it is back."
          : phSend.error || t.error || "The payment was stopped before any money left your account.";
    const word = review ? "IN REVIEW" : refunded ? "REFUNDED" : t.state === "FAILED" ? "FAILED" : null;
    const sub = review ? "outcome not known yet" : refunded ? "refunded" : returning ? "being returned" : "not debited";
    return `${Z.topbar({ srTitle: title, back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon(review ? "hourglass_top" : "sync_problem")}</span>
      <div class="z-intro"><h2 class="z-title">${esc(title)}</h2><p class="z-sub">${esc(lede)}</p></div>
      ${t.recipientName ? `<div class="z-card">${Z.row({ lead: Z.avatar({ name: t.recipientName }), title: t.recipientName, sub: `${phEur(t.sendEur)} · ${sub}`, right: word ? Z.tag(word) : "" })}</div>` : ""}
    `)}${phFoot(review
      ? Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" })
      : `${Z.button({ variant: "primary", full: true, label: "Review again", id: "ph-again" })}<a class="z-link-btn" href="#home">Back to Home</a>`)}`;
  },
  bind(root, id) {
    const b = root.querySelector("#ph-again");
    if (!b) return;
    b.onclick = () => {
      const t = hist.find((x) => x.id === id);
      // A new approval needs a new price: back to the amount, filled in.
      if (t?.recipientIban) phSend.payee = { name: t.recipientName, iban: String(t.recipientIban).replace(/\s+/g, "").toUpperCase() };
      if (t?.sendEur) phSend.amount = String(t.sendEur);
      if (t?.reference) phSend.reference = t.reference;
      phSend.error = null;
      phGo("send/amount", "new");
    };
  },
};

