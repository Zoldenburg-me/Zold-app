/**
 * The phone app: Get paid (links, account details, your page, one link).
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Get paid
   ========================================================================== */

const PH_GP_TABS = [["get-paid", "Links"], ["get-paid/details", "Account details"], ["get-paid/page", "Your page"]];
const phTabs = (active) => `<nav class="z-pills" aria-label="Get paid">${PH_GP_TABS.map(([r, l]) => `<a class="z-pill" href="#${r}" aria-current="${r === active ? "page" : "false"}">${esc(l)}</a>`).join("")}</nav>`;

async function phLoadLinks() {
  try {
    const d = await api(`/api/users/${user.id}/payment-requests`);
    phCache.links = d.requests || [];
    phCache.methods = d.methods || [];
  } catch (e) {
    phCache.links = phCache.links || [];
    phCache.linksError = e.message;
  }
}

function phLinkWord(r) {
  return { OPEN: ["OPEN"], PAID: ["PAID"], EXPIRED: ["Expired", "dim"], CANCELLED: ["Closed", "dim"] }[r.state] || [r.state, "dim"];
}
function phLinkSub(r) {
  const amt = r.amountEur == null ? "Any amount" : phEur(r.amountEur);
  if (r.state === "PAID") return `${amt} · paid ${phDay(r.paidAt || r.updatedAt)}`;
  if (r.state === "OPEN") {
    const days = Math.ceil((new Date(r.expiresAt) - Date.now()) / 86400000);
    return `${amt} · ${days > 1 ? `expires in ${days} days` : "expires today"}`;
  }
  return amt;
}

/* The button says what the plan allows, in the plan's own words. Invoices are
   written in Zold Business, for the personal space or a company. */
function phInvoiceButton() {
  if (phCache.orgs === null) return Z.button({ icon: "receipt_long", label: "Invoice", disabledReason: "Checking your plan…" });
  const org = phCan(phPersonalOrg(), "invoices") ? phPersonalOrg() : (phCache.orgs || []).find((o) => phCan(o, "invoices"));
  if (org) return Z.button({ icon: "receipt_long", label: "Invoice", href: phWebHref("invoice-new") }).replace("<a ", `<a data-ph-org="${esc(org.id)}" `);
  const reason = phPersonalOrg()?.capabilities?.invoices?.reason || "Invoices are not part of this account.";
  return Z.button({ icon: "receipt_long", label: "Invoice", disabledReason: reason });
}

PH["get-paid"] = {
  title: "Get paid",
  tab: "get-paid",
  live: () => JSON.stringify([phCache.links?.map((r) => `${r.id}:${r.state}`), phCache.orgs === null]),
  html() {
    const links = phCache.links;
    return `${phTop("Get paid")}${phMain(`
      ${phTabs("get-paid")}
      <div class="z-pair">
        ${Z.button({ variant: "primary", icon: "add_link", label: "Payment link", href: "#link/new" })}
        ${phInvoiceButton()}
      </div>
      ${links === null ? Z.skeletonRows(3, "Loading your links…") : `<section class="z-group">
        <div class="z-group__head"><h2 class="z-eyebrow">Your links</h2>${Z.tag("Beta")}</div>
        <ul class="z-list z-card">${links.length ? links.map((r) => { const [w, tone] = phLinkWord(r); return `<li>${Z.row({
          lead: Z.iconTile({ icon: "link", tone: r.state === "OPEN" ? "p" : "n" }), title: r.description || "Any amount", sub: phLinkSub(r), right: Z.tag(w, tone), href: phHref("link", r.id),
        })}</li>`; }).join("") : `<li><div class="z-row z-row--empty"><span>No links yet. A link asks for an amount and shows how to pay it.</span></div></li>`}</ul></section>`}
      ${phCache.linksError ? Z.note({ tone: "a", text: phCache.linksError }) : ""}
    `)}`;
  },
  bind() {
    if (phCache.links === null) phLoadLinks().then(() => { if (phRoute?.name === "get-paid") phRender(); });
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "get-paid") phRender(); });
  },
};

PH["get-paid/details"] = {
  title: "Get paid",
  tab: "get-paid",
  html() {
    const u = user || {};
    const known = phCache.bicFor === u.iban && phCache.bic !== undefined;
    return `${phTop("Get paid")}${phMain(`${phTabs("get-paid/details")}<div id="ph-gp-details" class="z-stack">${phDetailsBody(u, known ? phCache.bic : null, { loadingBic: !!u.iban && kycApproved(u) && !known })}</div>`)}`;
  },
  bind(root) {
    phBindDetails(root);
    const u = user || {};
    if (u.iban && kycApproved(u) && !(phCache.bicFor === u.iban && phCache.bic !== undefined)) {
      phLoadBic().then(() => {
        const el = $("ph-gp-details");
        if (!el) return;
        el.innerHTML = phDetailsBody(user, phCache.bic);
        phBindDetails(el);
      });
    }
  },
};

/* What the page's address takes, as the API read it from the forwarder's
   routes at the last activation. */
function phAcceptsList(page) {
  const list = page?.supportedTokens || [];
  if (!list.length) return "";
  const unitsOf = (raw, dec) => {
    const v = BigInt(raw), d = 10n ** BigInt(dec);
    const frac = (v % d).toString().padStart(dec, "0").replace(/0+$/, "");
    return `${v / d}${frac ? `.${frac}` : ""}`;
  };
  return Z.listGroup({
    label: "Your page takes",
    rows: list.map((t) => Z.row({
      lead: Z.iconTile({ icon: "currency_exchange" }),
      title: `${t.symbol} on ${t.chainName || phChainName(t.chainId)}`,
      sub: t.minAmount ? `At least ${unitsOf(t.minAmount, t.decimals)} ${t.symbol}` : "Arrives directly",
    })),
  });
}

function phChainName(id) {
  return { 1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis", 137: "Polygon", 8453: "Base", 42161: "Arbitrum", 84532: "Base Sepolia", 31337: "local chain" }[id] || `chain ${id}`;
}

PH["get-paid/page"] = {
  title: "Your page",
  tab: "get-paid",
  html() {
    const u = user || {};
    const page = u.paymentPage;
    const url = page?.handle ? `${location.host}/pay/${page.handle}` : "";
    const body = page?.handle
      ? `<div class="z-card z-page">
          <div class="z-page__head">${Z.avatar({ name: page.displayName || ownAccountName(u), tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(page.displayName || ownAccountName(u))}</span><span class="z-row__sub z-mono" translate="no">${esc(url)}</span></span></div>
          <p class="z-hint">Anyone with this link can pay you in digital dollars (${usdSym()}). They see your name, never your balance. The page is public.</p>
        </div>
        ${phAcceptsList(page)}
        <div class="z-pair">
          ${Z.button({ icon: "tune", label: "Page settings", href: "#page-settings" })}
          ${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-page-share" })}
        </div>`
      : u.passkeySafe?.status !== "active"
        ? Z.note({ tone: "a", text: "Your page opens once your account is set up." })
        : `<form id="ph-claim" class="z-form" novalidate>
            <p class="z-sub">Pick the name for your page. People pay you at ${esc(location.host)}/pay/<em>name</em>.</p>
            ${Z.field({ id: "ph-handle", label: "Page name", name: "handle", autocomplete: "off", spellcheck: false, placeholder: "yourname…", maxlength: 30, hint: "Lower-case letters, numbers and hyphens." })}
            ${Z.button({ variant: "primary", full: true, label: "Create my page", type: "submit" })}
          </form>`;
    return `${phTop("Get paid")}${phMain(`${phTabs("get-paid/page")}${body}`)}`;
  },
  bind(root) {
    const share = root.querySelector("#ph-page-share");
    if (share) share.onclick = () => phShare("Pay me", "You can pay me here:", `${location.origin}/pay/${user.paymentPage.handle}`);
    const form = root.querySelector("#ph-claim");
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const input = root.querySelector("#ph-handle");
      const btn = form.querySelector('button[type="submit"]');
      Z.setFieldError(input, input.value.trim() ? "" : "Enter a name for your page.");
      if (Z.focusFirstError(form)) return;
      Z.setLoading(btn, true);
      try {
        const r = await api(`/api/users/${user.id}/handle`, {
          handle: input.value.trim().toLowerCase(),
          ...(user.paymentPage?.settlementAsset ? { settlementAsset: user.paymentPage.settlementAsset } : {}),
        });
        user.paymentPage = r.paymentPage;
        phRender({ focus: true });
      } catch (err) {
        Z.setLoading(btn, false);
        Z.setFieldError(input, err.message);
        input.focus();
      }
    };
  },
};

/* A new link, or one link. */
PH.link = {
  title: (id) => (id === "new" ? "New payment link" : "Payment link"),
  live: (id) => { const r = phCache.links?.find((x) => x.id === id); return r ? `${r.state}|${(r.payments || []).length}` : "none"; },
  html(id) {
    if (id === "new") {
      const methods = phCache.methods;
      if (methods === null) return `${phTop("New payment link", "get-paid")}${phMain(Z.skeletonRows(2, "Loading…"))}`;
      const can = (m) => !!methods.find((x) => x.method === m)?.available;
      const needs = methods.filter((m) => !m.available).map((m) => `${m.method === "crypto" ? "Digital dollars" : "Bank transfer"} opens once you ${m.needs}.`);
      const check = (idx, m, label) => `<label class="z-check"><input type="checkbox" id="${idx}" name="methods" value="${m}"${can(m) ? " checked" : " disabled"}><span>${esc(label)}</span></label>`;
      return `${phTop("New payment link", "get-paid", Z.tag("Beta"))}<form id="ph-link" class="z-app__form" novalidate>${phMain(`
        <div class="z-form">
          ${Z.field({ id: "ph-lk-amount", label: "Amount in euros", optional: true, name: "amount", inputmode: "decimal", autocomplete: "off", placeholder: "40.00…", hint: "Leave it empty and the payer chooses." })}
          ${Z.field({ id: "ph-lk-desc", label: "What it’s for", name: "description", autocomplete: "off", maxlength: 140, placeholder: "Concert tickets…" })}
          <fieldset class="z-fieldset"><legend class="z-label">Ways to pay</legend>
            ${check("ph-lk-bank", "bank", "Bank transfer, with the link’s code as reference")}
            ${check("ph-lk-crypto", "crypto", `Digital dollars (${usdSym()}) to your page`)}
          </fieldset>
          ${needs.length ? Z.note({ text: needs.join(" ") }) : ""}
          <p class="z-err" id="ph-lk-err" role="alert" hidden></p>
        </div>
      `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Create link", type: "submit", ...(can("bank") || can("crypto") ? {} : { disabledReason: "No way to pay is open on this account yet." }) }))}</form>`;
    }
    const r = phCache.links?.find((x) => x.id === id);
    if (!r) return `${phTop("Payment link", "get-paid")}${phMain(phCache.links === null ? Z.skeletonRows(2, "Loading the link…") : Z.note({ text: "This link is not on your account." }))}`;
    const [w, tone] = phLinkWord(r);
    const closable = r.state === "OPEN" && !(r.payments || []).length;
    const pays = (r.payments || []).map((p) => Z.row({
      title: p.method === "crypto" ? `${Z.formatMoney(p.amountUsdc ?? 0, usdSym())}` : "Bank transfer",
      sub: [p.payerName, p.kind === "partial" ? "part payment" : ""].filter(Boolean).join(" · ") || "Received",
      right: Z.amount({ value: p.amountEur, direction: "in" }),
    }));
    return `${phTop("Payment link", "get-paid")}${phMain(`
      <div class="z-txhead">
        <p class="z-txhead__amt z-fig">${esc(r.amountEur == null ? "Any amount" : phEur(r.amountEur))}</p>
        <p class="z-sub">${esc([r.description, r.state === "OPEN" ? `expires ${phDay(r.expiresAt)}` : ""].filter(Boolean).join(" · "))}</p>
        ${Z.tag(w, tone)}
      </div>
      <div class="z-card">${Z.copyRow({ label: "Link", value: r.url, display: r.url.replace(/^https?:\/\//, ""), mono: true })}</div>
      ${Z.note({ text: "Share this link yourself. Zold doesn’t send emails or messages for you." })}
      ${r.methods.includes("bank") ? Z.kv([{ key: "Bank reference", value: r.code, mono: true }]) : ""}
      ${Z.listGroup({ label: "Received", rows: pays, empty: { text: "Nothing received yet." } })}
      <p class="z-err" id="ph-lk-err" role="alert" hidden></p>
    `)}${phFoot(`<div class="z-pair">${closable ? Z.button({ icon: "link_off", label: "Close link", id: "ph-lk-close" }) : ""}${r.state === "OPEN" ? Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-lk-share", className: closable ? "" : "z-btn--full" }) : ""}</div>`)}`;
  },
  bind(root, id) {
    if (phCache.links === null || phCache.methods === null) {
      phLoadLinks().then(() => { if (phRoute?.name === "link") phRender(); });
      return;
    }
    if (id === "new") {
      const form = root.querySelector("#ph-link");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (Z.isDisabled(btn)) return;
        const amount = root.querySelector("#ph-lk-amount");
        const desc = root.querySelector("#ph-lk-desc");
        const raw = amount.value.trim();
        const n = raw ? parseEurInput(raw) : undefined;
        Z.setFieldError(amount, raw && !(n > 0) ? eurInputError(raw, "40,50") : "");
        Z.setFieldError(desc, desc.value.trim() ? "" : "Say what it’s for. The payer sees this.");
        if (Z.focusFirstError(form)) return;
        const methods = [...form.querySelectorAll('input[name="methods"]:checked')].map((i) => i.value);
        const err = root.querySelector("#ph-lk-err");
        if (!methods.length) { err.textContent = "Pick at least one way to pay."; err.hidden = false; return; }
        Z.setLoading(btn, true);
        try {
          const r = await api(`/api/users/${user.id}/payment-requests`, { ...(n ? { amountEur: n } : {}), description: desc.value.trim(), methods });
          phCache.links = [r, ...(phCache.links || [])];
          phGo("link", r.id, { replace: true });
        } catch (x) {
          Z.setLoading(btn, false);
          err.textContent = x.message; err.hidden = false;
        }
      };
      return;
    }
    const r = phCache.links.find((x) => x.id === id);
    const share = root.querySelector("#ph-lk-share");
    if (share && r) share.onclick = () => {
      const lead = [r.amountEur == null ? "" : phEur(r.amountEur), r.description || ""].filter(Boolean).join(" for ");
      phShare(r.description || "Payment link", `${lead ? `${lead}. ` : ""}You can pay me here:`, r.url);
    };
    const close = root.querySelector("#ph-lk-close");
    if (close && r) close.onclick = () => phConfirm({
      id: "ph-lk-confirm",
      title: "Close this link?",
      text: "Nobody can pay it after this. Payments already made stay on your account.",
      confirm: "Close link",
      trigger: close,
      onConfirm: async () => {
        try {
          await api(`/api/users/${user.id}/payment-requests/${encodeURIComponent(r.id)}/cancel`, {});
          await phLoadLinks();
          phRender();
        } catch (x) {
          const err = root.querySelector("#ph-lk-err");
          err.textContent = x.message; err.hidden = false;
        }
      },
    });
  },
};

/* A centred confirmation. The safe choice is focused first. */
function phConfirm(o) {
  document.getElementById(o.id)?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: o.id, kind: "dialog", title: o.title,
    body: `<p class="z-sub">${esc(o.text)}</p><div class="z-pair z-pair--dialog">${Z.button({ label: o.cancel || "Keep it", autofocus: true, className: "z-overlay__close-btn" })}${Z.button({ variant: "primary", label: o.confirm, id: `${o.id}-ok` })}</div>`,
  }));
  const scrim = $(o.id);
  scrim.dataset.ph = "1";
  scrim.querySelector(".z-overlay__close-btn").onclick = () => Z.closeOverlay(o.id);
  $(`${o.id}-ok`).onclick = async () => { Z.closeOverlay(o.id); await o.onConfirm(); };
  Z.openOverlay(o.id, o.trigger);
}

