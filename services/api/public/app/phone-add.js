/**
 * The phone app: Add money, main currency and digital dollars to euros.
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Add money
   ========================================================================== */

PH.add = {
  title: "Add money",
  tab: "home",
  html() {
    const rows = [];
    if (HAS("monerium")) rows.push(Z.row({ lead: Z.iconTile({ icon: "account_balance", tone: "p" }), title: "Bank transfer", sub: "To your IBAN, from any bank in Europe", href: "#account-details" }));
    if (HAS("onchain_balance")) rows.push(Z.row({ lead: Z.iconTile({ icon: "account_balance_wallet", tone: "p" }), title: "Crypto wallet", sub: `Digital dollars (${usdSym()}) from any wallet or exchange`, right: Z.tag("Beta"), href: "#add/wallet" }));
    rows.push(Z.soonRow({ lead: Z.iconTile({ icon: "attach_money" }), title: "USD account", sub: "ACH and wire in" }));
    return `${phTop("Add money")}${phMain(`<p class="z-sub">Both land in the same account.</p>${Z.listGroup({ rows })}${phFaucetCard()}`)}`;
  },
  bind(root) {
    const b = root.querySelector("#ph-faucet");
    if (!b) return;
    b.onclick = async () => {
      const err = root.querySelector("#ph-faucet-err");
      err.hidden = true;
      b.disabled = true;
      try {
        const r = await api(`/api/users/${user.id}/faucet`, {});
        if (r.user) user = r.user;
        Z.announce(`${phEur(r.grantedEur)} test EURe sent.`);
        phRender();
      } catch (e) {
        err.textContent = e?.message || "The test faucet could not send.";
        err.hidden = false;
        b.disabled = false;
      }
    };
  },
};

/* The testnet faucet: only where /api/health offers one (never on a chain
   where EURe is real money), once per account, after the Safe exists. The
   grant is a real token transfer on the test chain, so it shows in Activity
   like any deposit. */
function phFaucetCard() {
  const grant = caps.faucetEur || 0;
  const tokens = caps.faucetTokens || [];
  if (user?.passkeySafe?.status !== "active" || (!grant && !tokens.length)) return "";
  // The public faucet page funds any address, this account's included, and a
  // test payer's own wallet for paying an invoice or a link.
  const more = tokens.length
    ? Z.note({ icon: "water_drop", html: `More test tokens (${esc(tokens.join(", "))}), for this account or a payer’s wallet: <a href="/faucet?address=${encodeURIComponent(user.address)}" target="_blank" rel="noopener">open the faucet</a>` })
    : "";
  if (!grant || user.faucet?.txHash) {
    return `${grant ? Z.note({ icon: "science", text: `This account received its ${phEur(user.faucet.grantedEur)} of test EURe.` }) : ""}${more}`;
  }
  return `<div class="z-card">
      ${Z.row({ lead: Z.iconTile({ icon: "science", tone: "p" }), title: "Test EURe", sub: `${phEur(grant)} to try the app with. Test chain only, not real money.`, right: Z.tag("Testnet") })}
      ${Z.button({ variant: "primary", full: true, label: `Get ${phEur(grant)} test EURe`, id: "ph-faucet" })}
      <p class="z-err" id="ph-faucet-err" role="alert" hidden></p>
    </div>${more}`;
}

PH["add/wallet"] = {
  title: "From a crypto wallet",
  live: () => JSON.stringify([phCache.deposits?.map((d) => `${d.id}:${d.state}`), user?.paymentPage?.handle, phCache.settlementAsset, phCache.autoConvert]),
  html() {
    const u = user || {};
    const page = u.paymentPage || {};
    // Always the Safe itself: the payment page's address may be a forwarder,
    // and one screen never shows two addresses (or a QR of another one).
    const address = u.passkeySafe?.status === "active" ? u.address : "";
    const deps = phCache.deposits;
    const waiting = (deps || []).filter((d) => d.state === "DETECTED" && d.token === "USDC");
    // Refused, or sent with no confirmed result (UNCONFIRMED: the swap may
    // still land). Neither gets a Convert button: a second try could spend
    // other USDC in the account.
    const refused = (deps || []).filter((d) => d.state === "REFUSED" && d.token === "USDC");
    const checking = (deps || []).filter((d) => d.state === "UNCONFIRMED" && d.token === "USDC");
    const asset = phCache.settlementAsset || page.settlementAsset;
    const autoConvert = phCache.autoConvert ?? page.autoConvert;
    const change = page.handle ? ` <a href="#settings/currency/wallet">Change</a>` : "";
    return `${phTop("From a crypto wallet", "add", Z.tag("Beta"))}${phMain(`
      ${address ? `<div class="z-qr"><img id="ph-wallet-qr" ${phCache.walletQr?.key === `${u.id}:${address}` ? `src="${phCache.walletQr.url}"` : "hidden"} width="168" height="168" alt="QR code of your wallet address"></div>` : ""}
      ${address ? `<div class="z-card">${Z.copyRow({ label: "Your wallet address", value: address, mono: true })}</div>`
        : Z.note({ tone: "a", text: "Your account is not set up yet, so it has no wallet address." })}
      ${Z.note({ tone: "a", text: `Only ${usdSym()} on the Base network. Anything else sent here is lost.` })}
      ${!address ? "" : caps.paymentPageForwarding
        ? Z.note({ icon: "link", html: page.handle
          ? `Your payment page takes more tokens from other chains. <a href="/pay/${encodeURIComponent(page.handle)}" target="_blank" rel="noopener">See the list</a>`
          : `Set up a payment page to take more tokens from other chains. <a href="#get-paid/page">Set it up</a>` })
        : page.handle ? "" : Z.note({ icon: "link", html: `Set up a payment page: a link and QR anyone can pay. <a href="#get-paid/page">Set it up</a>` })}
      ${Z.note({ icon: "currency_exchange", html: `${asset === "USDC" || !autoConvert
        ? `Digital dollars that arrive stay as ${usdSym()}.`
        : "Your main currency is euro, so we ask before converting dollars."}${change}` })}
      ${deps === null ? Z.skeletonRows(1, "Loading payments…") : Z.listGroup({
        label: "Waiting to convert",
        rows: waiting.map((d) => `<div class="z-row">${Z.iconTile({ icon: "currency_exchange", tone: "m" })}<span class="z-row__main"><span class="z-row__title z-fig">${esc(Z.formatMoney(d.amountUsdc ?? 0, usdSym()))}</span><span class="z-row__sub">Arrived ${esc(phDay(d.detectedAt))}${d.receipt ? ` · worth ${esc(phEur(d.receipt.amountEur))} then` : ""}</span></span><span class="z-row__right"><a class="z-btn z-btn--primary z-btn--sm" href="${phHref("convert", d.id)}" aria-label="Convert ${esc(Z.formatMoney(d.amountUsdc ?? 0, usdSym()))}">Convert</a></span></div>`),
        empty: { text: "Nothing waiting. Payments show up here within a minute of arriving." },
      })}
      ${refused.length ? Z.listGroup({
        label: "Not converted",
        rows: refused.map((d) => Z.row({
          lead: Z.iconTile({ icon: "currency_exchange" }),
          title: Z.formatMoney(d.amountUsdc ?? 0, usdSym()),
          // The reason is the server's wording (it says EURe); plain words here.
          sub: `Arrived ${phDay(d.detectedAt)}. Not converted: check your balance, or write to support@zoldhq.com.`,
          right: Z.tag("IN REVIEW"),
        })),
      }) : ""}
      ${checking.length ? Z.listGroup({
        label: "Being checked",
        rows: checking.map((d) => Z.row({
          lead: Z.iconTile({ icon: "hourglass_top" }),
          title: Z.formatMoney(d.amountUsdc ?? 0, usdSym()),
          sub: `Arrived ${phDay(d.detectedAt)}. The conversion was sent and its result isn’t confirmed yet. Nothing to do: we’re checking it.`,
          right: Z.tag("CHECKING"),
        })),
      }) : ""}
    `)}`;
  },
  bind(root) {
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "add/wallet") phRender(); });
    const img = root.querySelector("#ph-wallet-qr");
    if (img?.hidden) phLoadWalletQr(img);
  },
};

/* The wallet QR route is signed-in only, and an <img> request carries no
   bearer header, so the SVG is fetched with the session and shown from a
   blob URL. Kept per user and address so a redraw does not refetch. */
async function phLoadWalletQr(img) {
  const key = `${user.id}:${user.address}`;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/address/qr.svg`, {
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    if (phCache.walletQr) URL.revokeObjectURL(phCache.walletQr.url);
    phCache.walletQr = { key, url };
    if (img.isConnected) { img.src = url; img.hidden = false; }
  } catch {
    // No QR is better than a broken image; the address is copyable below it.
  }
}

async function phLoadDeposits() {
  if (!user?.id) return;
  try {
    const d = await api(`/api/users/${user.id}/crypto-deposits`);
    phCache.deposits = d.deposits || [];
    phCache.settlementAsset = d.settlementAsset;
    phCache.autoConvert = d.autoConvert;
  } catch {
    phCache.deposits = phCache.deposits || [];
  }
}

/* ==========================================================================
   Digital dollars to euros
   --------------------------------------------------------------------------
   What the API does, and so what these screens may say:
   - Nothing converts without the holder's Face ID or fingerprint. The poller
     spots a payment to the page and leaves it waiting (DETECTED) only when
     the page settles in euros and "ask me" (autoConvert) is on.
   - Otherwise the poller settles the payment as USDC, and a payment settled
     as USDC cannot be converted through this route later. That includes
     payments already waiting when the setting changes.
   - The price is a quote with a floor (minEur). What arrives is measured
     (creditedEur) and is the only euro figure called "arrived".
   - "Your dollars didn't move" is said only for a refusal the server gave
     before it submitted anything. A 502, a 503 (also what the service worker
     answers offline), a lost connection or an UNCONFIRMED deposit (sent, the
     API answered SAFE_OP_UNCONFIRMED) can each hide a swap that landed, so
     those say "not confirmed" and never offer the payment again.
   ========================================================================== */

/* The open conversion: its price, and the outcome of the last approval. */
const phConv = { id: null, prep: null, error: null, pricing: false, refusal: null, priced: null, outcome: null };

const phUsdc = (n) => Z.formatMoney(n ?? 0, usdSym());
const phDeposit = (id) => (phCache.deposits || []).find((d) => d.id === id) || null;
/* A price the server still holds. Its expiry is the server's, not ours. */
const phPriceLive = (id) => phConv.id === id && phConv.prep && Date.parse(phConv.prep.expiresAt) > Date.now();
const phRate = (p) => (p.amountUsdc ? p.expectedEur / p.amountUsdc : 0);

/* The main currency, in the words of the Settings row. */
function phCurrencyWords(page) {
  if (!page?.handle) return "Set up your page first";
  if (page.settlementAsset === "USDC") return "Digital dollars (USDC)";
  return page.autoConvert ? "Euro, ask before converting dollars" : `Euro, keep dollars as ${usdSym()}`;
}

PH["settings/currency"] = {
  title: "Main currency",
  live: () => JSON.stringify([user?.paymentPage?.settlementAsset, user?.paymentPage?.autoConvert, phCache.deposits?.filter((d) => d.state === "DETECTED").length]),
  html(from) {
    const page = user?.paymentPage;
    const back = from === "wallet" ? "add/wallet" : "settings";
    if (!page?.handle) {
      return `${phTop("Main currency", back)}${phMain(`
        <p class="z-sub">Your main currency decides what happens when someone pays your page in digital dollars (${usdSym()}).</p>
        ${Z.note({ text: "It applies to your page, so set that up first." })}
        ${Z.button({ variant: "primary", full: true, label: "Set up your page", href: "#get-paid/page" })}`)}`;
    }
    const usdc = page.settlementAsset === "USDC";
    const pending = phCache.currencyPending;       // a "keep" choice waiting for confirmation
    const ask = pending ? false : !!page.autoConvert;
    const waiting = (phCache.deposits || []).filter((d) => d.state === "DETECTED").length;
    const choice = (name, value, checked, title, text) =>
      `<label class="z-choice"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}><span class="z-choice__main"><span class="z-choice__title">${esc(title)}</span><span class="z-choice__text">${esc(text)}</span></span></label>`;
    const waitingWord = waiting === 1 ? "1 payment is" : `${waiting} payments are`;
    return `${phTop("Main currency", back)}${phMain(`
      <p class="z-sub">Pick what your account keeps when someone pays you in digital dollars (${usdSym()}).</p>
      <fieldset class="z-fieldset" id="ph-cur-main" aria-describedby="ph-cur-err">
        <legend class="z-eyebrow">Keep my money in</legend>
        <div class="z-choices">
          ${choice("main", "EURE", !usdc && pending !== "USDC", "Euros", "Your balance stays in euros. Below, pick what happens to dollar payments.")}
          ${choice("main", "USDC", usdc || pending === "USDC", "Digital dollars (USDC)", "Dollar payments stay as dollars. Nothing is converted.")}
        </div>
      </fieldset>
      ${usdc || pending === "USDC" ? "" : `<fieldset class="z-fieldset" id="ph-cur-ask">
        <legend class="z-eyebrow">When dollars arrive</legend>
        <div class="z-choices">
          ${choice("ask", "ask", ask, "Ask me to convert", "We spot the payment and show you the price. It converts only after you approve with Face ID or fingerprint.")}
          ${choice("ask", "keep", !ask, "Keep them as dollars", `They stay as ${usdSym()} in your account.`)}
        </div>
      </fieldset>`}
      ${pending ? `<div class="z-confirm" role="group" aria-labelledby="ph-cur-warn">
          ${Z.note({ tone: "a", icon: "warning", html: `<span id="ph-cur-warn">${esc(waitingWord)} waiting to convert. ${waiting === 1 ? "It stays" : "They stay"} as ${usdSym()} too, and can’t be converted here later.</span>` })}
          <div class="z-pair">${Z.button({ label: "Cancel", id: "ph-cur-cancel" })}${Z.button({ variant: "primary", label: "Keep as dollars", id: "ph-cur-confirm" })}</div>
        </div>` : ""}
      <p class="z-err" id="ph-cur-err" role="alert" hidden></p>
      ${Z.note({ text: "This covers dollar payments to your page and your payment links. Zold charges no fee for converting." })}
    `)}`;
  },
  bind(root) {
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "settings/currency") phRender(); });
    const save = async (change) => {
      root.querySelector("#ph-cur-err").hidden = true;
      // One change at a time: the controls wait for the answer.
      root.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
      try {
        const current = user.paymentPage;
        if (change.settlementAsset && change.settlementAsset !== current.settlementAsset) {
          // The page's own route stores the asset. Same name and display
          // name, so the page and its wallet address stay as they are.
          const r = await api(`/api/users/${user.id}/handle`, {
            handle: current.handle,
            ...(current.displayName ? { displayName: current.displayName } : {}),
            settlementAsset: change.settlementAsset,
          });
          user.paymentPage = r.paymentPage;
        }
        if (change.autoConvert !== undefined && change.autoConvert !== !!user.paymentPage.autoConvert) {
          const u = await api(`/api/users/${user.id}/auto-convert`, { enabled: change.autoConvert });
          if (u.paymentPage) user.paymentPage = u.paymentPage;
        }
        phCache.currencyPending = null;
        await phLoadDeposits();
        Z.announce("Saved.");
        phRender();
      } catch (e) {
        // Redraw from what the server holds, then say why it refused.
        phCache.currencyPending = null;
        phRender();
        const el = $("ph-root").querySelector("#ph-cur-err");
        el.textContent = e.message;
        el.hidden = false;
      }
    };
    const waiting = () => (phCache.deposits || []).filter((d) => d.state === "DETECTED").length;
    root.querySelectorAll('input[name="main"]').forEach((i) => {
      i.onchange = () => {
        if (i.value === "USDC" && waiting() > 0) { phCache.currencyPending = "USDC"; return phRender(); }
        save({ settlementAsset: i.value });
      };
    });
    root.querySelectorAll('input[name="ask"]').forEach((i) => {
      i.onchange = () => {
        if (i.value === "keep" && waiting() > 0) { phCache.currencyPending = "keep"; return phRender(); }
        save({ autoConvert: i.value === "ask" });
      };
    });
    const cancel = root.querySelector("#ph-cur-cancel");
    if (cancel) cancel.onclick = () => { phCache.currencyPending = null; phRender(); };
    const confirm = root.querySelector("#ph-cur-confirm");
    if (confirm) confirm.onclick = () => save(phCache.currencyPending === "USDC" ? { settlementAsset: "USDC" } : { autoConvert: false });
  },
};

/* Review the price for one payment, and approve it. */
PH.convert = {
  title: "Convert to euros",
  live: (id) => { const d = phDeposit(id); return `${phCache.deposits === null}|${d?.state}|${phConv.id === id ? phConv.prep?.challenge || phConv.error || "" : ""}`; },
  html(id) {
    const top = phTop("Convert to euros", "add/wallet", Z.tag("Beta"));
    if (phCache.deposits === null) return `${top}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    const d = phDeposit(id);
    if (!d || d.token !== "USDC" || d.state !== "DETECTED") {
      const text = !d ? "We can’t find this payment in your account."
        : d.state === "CONVERTED" ? (d.settlementAsset === "EURE" ? "This payment is already converted." : `This payment was kept as ${usdSym()}.`)
          : d.state === "UNCONFIRMED" ? "A conversion of this payment was sent and its result isn’t confirmed yet. We’re checking it, so it can’t be converted again. Nothing to do for now."
            : "This payment isn’t waiting to convert.";
      return `${top}${phMain(`${Z.note({ text })}${Z.button({ variant: "primary", full: true, label: "Back to your wallet", href: "#add/wallet" })}`)}`;
    }
    const from = `Arrived ${phDay(d.detectedAt)}, in digital dollars`;
    const p = phConv.id === id ? phConv.prep : null;
    const head = `<div class="z-card">${Z.row({ lead: Z.iconTile({ icon: "currency_exchange", tone: "m" }), title: `${phUsdc(d.amountUsdc)} received`, sub: from })}</div>`;
    if (!p) {
      const e = phConv.id === id ? phConv.error : null;
      return `${top}${phMain(`${head}${e
        ? `${Z.note({ tone: "a", text: e })}`
        : Z.skeletonRows(4, "Getting a price…")}`)}${e ? phFoot(`${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Try again", id: "ph-conv-retry" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`) : ""}`;
    }
    const expired = !phPriceLive(id);
    return `${top}${phMain(`
      ${head}
      <section class="z-card z-conv" aria-label="The price">
        <div><p class="z-conv__label">You convert</p><p class="z-conv__usdc z-fig">${esc(Z.formatMoney(p.amountUsdc, "").trim())}<span class="z-conv__unit">${usdSym()}</span></p></div>
        <div class="z-conv__arrow" aria-hidden="true">${Z.icon("arrow_downward")}<span></span></div>
        <div><p class="z-conv__label">You get about</p>${phBalanceFig(p.expectedEur)}</div>
      </section>
      ${Z.kv([
        { key: "Rate", value: `1 ${usdSym()} = €${phRate(p).toFixed(4)}` },
        { key: "Zold fee", value: phEur(0) },
        { key: "At least", hint: "Or nothing converts", valueHtml: `<strong>${esc(phEur(p.minEur))}</strong>` },
        { key: "Price holds for", valueHtml: `<span id="ph-conv-left">${expired ? "Expired" : esc(phLeft(p.expiresAt))}</span>` },
      ])}
      ${Z.note({ icon: "verified_user", text: `If less than ${phEur(p.minEur)} would arrive, nothing converts and your dollars stay where they are. We credit what actually arrives.` })}
      <p class="z-err" id="ph-conv-err" role="alert" hidden></p>
    `)}${phFoot(`${expired
      ? Z.button({ variant: "primary", full: true, icon: "refresh", label: "Get a new price", id: "ph-conv-retry" })
      : Z.button({ variant: "primary", full: true, icon: "fingerprint", label: "Convert with Face ID", id: "ph-conv-go" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`)}`;
  },
  bind(root, id) {
    if (phCache.deposits === null) {
      phLoadDeposits().then(() => { if (phRoute?.name === "convert" && phRoute.arg === id) phRender(); });
      return;
    }
    const d = phDeposit(id);
    if (d?.state === "CONVERTED" && d.settlementAsset === "EURE") return phGo("convert/done", id, { replace: true });
    if (!d || d.state !== "DETECTED") return;
    if (!phConv.pricing && (phConv.id !== id || (!phConv.prep && !phConv.error))) phPrice(id);
    const retry = root.querySelector("#ph-conv-retry");
    if (retry) retry.onclick = () => phPrice(id, retry);
    const go = root.querySelector("#ph-conv-go");
    if (go) go.onclick = () => phConvert(id, go, root.querySelector("#ph-conv-err"));
    phTick(id);
  },
};

/* "14:32" left on the price, or "15 minutes" when it has just been given. */
function phLeft(iso) {
  const s = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
  if (s >= 14 * 60 + 55) return `${Math.round(s / 60)} minutes`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
let phTickTimer = null;
function phTick(id) {
  clearInterval(phTickTimer);
  phTickTimer = setInterval(() => {
    const el = document.getElementById("ph-conv-left");
    if (!el || phRoute?.name !== "convert" || phRoute.arg !== id || !phConv.prep) return clearInterval(phTickTimer);
    if (!phPriceLive(id)) { clearInterval(phTickTimer); return phRender(); }
    el.textContent = phLeft(phConv.prep.expiresAt);
  }, 1000);
}

/* Ask for a price. Nothing is signed here; a refusal names its reason. */
async function phPrice(id, btn) {
  if (btn) Z.setLoading(btn, true);
  Object.assign(phConv, { id, prep: null, error: null, pricing: true, refusal: null });
  try {
    const p = await api(`/api/users/${user.id}/crypto-deposits/${encodeURIComponent(id)}/convert/prepare`, {});
    if (phConv.id !== id) return;
    phConv.prep = p;
  } catch (e) {
    if (phConv.id !== id) return;
    // The server's own words, which name what to do; its dashes read as commas here.
    const why = String(e.message || "").replace(/\s*—\s*/g, ", ").replace(/\.$/, "");
    phConv.error = e.status === 409
      ? `This payment can’t be converted: ${why}.`
      : `No price right now, so nothing was converted. ${why}.`;
  } finally {
    if (phConv.id === id) phConv.pricing = false;
  }
  if (phRoute?.name === "convert" && phRoute.arg === id) phRender({ focus: false });
}

/**
 * Approve the price. Face ID or fingerprint signs the Safe operation that
 * swaps this payment's USDC into euros in the user's own Safe.
 */
async function phConvert(id, btn, errEl) {
  if (Z.isDisabled(btn)) return;
  const p = phConv.prep;
  if (!p || !phPriceLive(id)) return phRender();
  errEl.hidden = true;
  Z.setLoading(btn, true);
  let assertion;
  try {
    assertion = await passkeyPrompt("get", {
      challenge: b64urlToBytes(p.challenge),
      rpId: location.hostname,
      allowCredentials: p.credentialId ? [{ type: "public-key", id: b64urlToBytes(p.credentialId) }] : [],
      userVerification: "required",
    });
    if (!assertion) throw new Error("No response from Face ID or fingerprint.");
  } catch (e) {
    // Nothing has been sent to the server yet: the payment is where it was.
    Z.setLoading(btn, false);
    errEl.textContent = e?.name === "NotAllowedError" ? "Face ID or fingerprint was cancelled. Nothing was converted." : e.message;
    errEl.hidden = false;
    return;
  }
  phConv.priced = { id, expectedEur: p.expectedEur, minEur: p.minEur };
  try {
    const out = await api(`/api/users/${user.id}/crypto-deposits/${encodeURIComponent(id)}/convert`, {
      executionAssertion: {
        credentialId: p.credentialId,
        authenticatorData: b64url(assertion.response.authenticatorData),
        clientDataJSON: b64url(assertion.response.clientDataJSON),
        signature: b64url(assertion.response.signature),
      },
    });
    phConv.prep = null;
    if (out.safeBalanceEur !== undefined) {
      user.safeBalanceEur = out.safeBalanceEur;
      user.balanceEur = out.balanceEur ?? out.safeBalanceEur;
    }
    await phLoadDeposits();
    renderUser(user);
    const d = phDeposit(id) || out.deposit;
    phGo(d?.state === "CONVERTED" && d.settlementAsset === "EURE" ? "convert/done" : "convert/check", id, { replace: true });
  } catch (e) {
    phConv.prep = null;
    // SAFE_OP_UNCONFIRMED: sent, may still land. SAFE_OP_REVERTED: included
    // and undone by the chain. The check screen words each from this code
    // until the reloaded deposit says more.
    phConv.outcome = { id, code: e.code || null };
    // 400, 401, 403 and 409 are answered before the operation is submitted,
    // and the service worker never makes them up: nothing moved.
    if ([400, 401, 403, 409].includes(e.status)) {
      phConv.refusal = { id, expired: e.status === 409 };
      await phLoadDeposits();
      return phGo("convert/refused", id, { replace: true });
    }
    await phLoadDeposits();
    phGo("convert/check", id, { replace: true });
  }
}

/* Converted: what arrived, measured, never the price that was shown. */
PH["convert/done"] = {
  title: "Converted to euros",
  live: (id) => `${phCache.deposits === null}|${phDeposit(id)?.state}`,
  html(id) {
    const d = phDeposit(id);
    const top = Z.topbar({ srTitle: "Converted to euros", back: { href: "#home", label: "Back to Home" } });
    if (phCache.deposits === null) return `${top}${phMain(Z.skeletonRows(3, "Loading the payment…"))}`;
    if (!d || d.state !== "CONVERTED" || d.settlementAsset !== "EURE" || typeof d.creditedEur !== "number") {
      return `${top}${phMain(`${Z.note({ text: "This payment isn’t converted to euros." })}${Z.button({ variant: "primary", full: true, label: "Back to your wallet", href: "#add/wallet" })}`)}`;
    }
    const shown = phConv.priced?.id === id ? phConv.priced : null;
    const diff = shown ? Math.round((shown.expectedEur - d.creditedEur) * 100) / 100 : 0;
    const why = !shown || Math.abs(diff) < 0.01 ? ""
      : diff > 0
        ? `${phEur(diff)} less than the price shown, because markets move while it converts. It stayed above your ${phEur(shown.minEur)} floor. Your records use the ${phEur(d.creditedEur)} that arrived.`
        : `${phEur(-diff)} more than the price shown, because markets move while it converts. The extra is yours. Your records use the ${phEur(d.creditedEur)} that arrived.`;
    return `${top}${phMain(`
      <div>${Z.tag("RECEIVED")}<p class="z-balance__fig z-balance__fig--in z-fig"><span class="z-balance__cur">+€</span>${esc(phEur(d.creditedEur).replace(/^€/, ""))}</p><p class="z-sub">Now in euros in your account.</p></div>
      ${Z.kv([
        { key: "Converted", value: phUsdc(d.amountUsdc) },
        ...(shown ? [{ key: "Price shown", value: `about ${phEur(shown.expectedEur)}` }] : []),
        { key: "Arrived", valueHtml: `<strong>${esc(phEur(d.creditedEur))}</strong>` },
      ])}
      ${why ? Z.note({ text: why }) : ""}
      ${d.conversion?.txHash || d.provider ? `<details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([
        ...(d.provider ? [{ key: "Converted by", value: d.provider }] : []),
        ...(d.conversion?.txHash ? [{ key: "Transaction", value: d.conversion.txHash, mono: true }] : []),
      ])}</details>` : ""}
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Done", href: "#home" }))}`;
  },
  bind(root, id) {
    if (phCache.deposits === null || !phDeposit(id)) phLoadDeposits().then(() => { if (phRoute?.name === "convert/done") phRender(); });
  },
};

/* Refused before anything was submitted: the dollars did not move. Only
   reachable straight from an approval; a reload goes back to the price. */
PH["convert/refused"] = {
  title: "Nothing was converted",
  html(id) {
    const r = phConv.refusal?.id === id ? phConv.refusal : null;
    const d = phDeposit(id);
    const top = Z.topbar({ srTitle: "Nothing was converted", back: { href: "#add/wallet", label: "Back to your wallet" } });
    if (!r) return `${top}${phMain(Z.skeletonRows(2, "Loading the payment…"))}`;
    const lede = r.expired
      ? "The price ran out before your approval reached us, so we stopped. Your dollars didn’t move."
      : "We stopped before anything was sent. Your dollars didn’t move.";
    return `${top}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("currency_exchange")}</span>
      <div class="z-intro"><h2 class="z-title">Nothing was converted</h2><p class="z-sub">${esc(lede)}</p></div>
      ${d ? `<div class="z-card z-held"><p class="z-held__main"><span class="z-held__label">Still in your account</span><span class="z-held__fig z-fig">${esc(phUsdc(d.amountUsdc))}</span></p>${Z.iconTile({ icon: "account_balance_wallet" })}</div>` : ""}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([{ key: "Payment ID", value: id, mono: true }])}</details>
    `)}${phFoot(`${Z.button({ variant: "primary", full: true, icon: "refresh", label: "Get a new price", id: "ph-conv-new" })}<a class="z-link-btn" href="#add/wallet">Keep as dollars for now</a>`)}`;
  },
  bind(root, id) {
    if (phConv.refusal?.id !== id) return phGo("convert", id, { replace: true });
    const b = root.querySelector("#ph-conv-new");
    if (b) b.onclick = () => { Object.assign(phConv, { id: null, prep: null, error: null, refusal: null }); phGo("convert", id, { replace: true }); };
  },
};

/* Submitted, but the outcome is not known. Says nothing about the dollars. */
PH["convert/check"] = {
  title: "Conversion not confirmed",
  live: (id) => `${phCache.deposits === null}|${phDeposit(id)?.state}`,
  html(id) {
    const d = phDeposit(id);
    const code = phConv.outcome?.id === id ? phConv.outcome.code : null;
    const checking = d?.state === "UNCONFIRMED" || (!d && code === "SAFE_OP_UNCONFIRMED");
    const reverted = !checking && code === "SAFE_OP_REVERTED";
    const lede = checking
      ? "Your approval was sent, and its result isn’t confirmed yet. We’re checking it, so this payment isn’t offered for conversion again. Nothing to do: your balance shows the outcome once it’s clear. If it stays unclear, write to support@zoldhq.com."
      : reverted
        ? "Your approval was sent, and the network undid the conversion, so nothing was converted. Check your balance, or write to support@zoldhq.com."
        : "Your approval was sent, but no clear result came back, so we can’t say yet whether it converted. Check your balance in a few minutes. If it still isn’t clear, write to support@zoldhq.com.";
    return `${Z.topbar({ srTitle: "Conversion not confirmed", back: { href: "#home", label: "Back to Home" } })}${phMain(`
      <span class="z-tile z-tile--a z-tile--lg" aria-hidden="true">${Z.icon("hourglass_top")}</span>
      <div class="z-intro"><h2 class="z-title">${reverted ? "Nothing was converted" : checking ? "We’re checking this conversion" : "We couldn’t confirm this conversion"}</h2><p class="z-sub">${esc(lede)}</p></div>
      ${d ? `<div class="z-card">${Z.row({ lead: Z.iconTile({ icon: "currency_exchange" }), title: phUsdc(d.amountUsdc), sub: `Arrived ${phDay(d.detectedAt)}`, right: Z.tag(checking ? "CHECKING" : "IN REVIEW") })}</div>` : ""}
      <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv([{ key: "Payment ID", value: id, mono: true }])}</details>
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Back to Home", href: "#home" }))}`;
  },
  bind(root, id) {
    const d = phDeposit(id);
    // The swap landed after all: say so with the measured figure.
    if (d?.state === "CONVERTED" && d.settlementAsset === "EURE") return phGo("convert/done", id, { replace: true });
    if (phCache.deposits === null) phLoadDeposits().then(() => { if (phRoute?.name === "convert/check") phRender(); });
  },
};

