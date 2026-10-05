/**
 * The phone app: Contacts and Profile.
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Contacts
   ========================================================================== */

/* The personal organisation's address book when there is one; otherwise the
   people this account has paid. */
async function phLoadContacts() {
  phCache.contacts = [];
  try {
    await phLoadOrgs();
    const org = phPersonalOrg();
    if (org && phCan(org, "contacts.manage")) {
      const d = await api(`/api/orgs/${encodeURIComponent(org.id)}/contacts`);
      phCache.contacts = (d.contacts || []).flatMap((c) => (c.bankAccounts || []).filter((b) => b.iban).slice(0, 1)
        .map((b) => ({ key: String(b.iban).replace(/\s+/g, "").toUpperCase(), name: c.name, iban: String(b.iban).replace(/\s+/g, "").toUpperCase(), kind: "Contact" })));
    }
  } catch { /* fall back to the people paid */ }
}

function phContactList() {
  const byIban = new Map();
  for (const c of phCache.contacts || []) byIban.set(c.key, { ...c, payments: [] });
  for (const p of phPayees()) {
    const had = byIban.get(p.key);
    if (had) had.payments = p.payments; else byIban.set(p.key, { key: p.key, name: p.name, iban: p.iban, payments: p.payments });
  }
  return [...byIban.values()].sort((a, b) => a.name.localeCompare(b.name));
}

PH.contacts = {
  title: "Contacts",
  tab: "more",
  live: () => `${phHistSig()}|${(phCache.contacts || []).length}`,
  html(key) {
    const list = phContactList();
    const loading = phCache.orgs === null && !histLoaded;
    return `${phTop("Contacts", "more")}${phMain(`
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-cq">Search contacts</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-cq" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Search people and companies…">
      </form>
      <div id="ph-contacts">${loading ? Z.skeletonRows(4, "Loading contacts…") : Z.listGroup({
        rows: list.map((c) => phPayeeRow(c, phHref("contacts", c.key))),
        empty: { text: "Contacts appear after your first payment.", action: { href: "#send", label: "Send money" } },
      })}</div>
    `)}`;
  },
  bind(root, key) {
    const q = root.querySelector("#ph-cq");
    q.oninput = () => {
      const needle = q.value.trim().toLowerCase();
      const list = phContactList().filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.iban.toLowerCase().includes(needle.replace(/\s+/g, "")));
      root.querySelector("#ph-contacts").innerHTML = Z.listGroup({ rows: list.map((c) => phPayeeRow(c, phHref("contacts", c.key))), empty: { text: "Nobody matches that." } });
    };
    if (phCache.contacts === null || phCache.orgs === null) phLoadContacts().then(() => { if (phRoute?.name === "contacts") phRender(); });
    if (key) phOpenContact(key, root);
  },
};

function phOpenContact(key, root) {
  const c = phContactList().find((x) => x.key === key);
  if (!c) return;
  const pays = c.payments || [];
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-contact", title: c.name,
    body: `<div class="z-sheet__body"><p class="z-sub">${pays.length ? `${pays.length} payment${pays.length === 1 ? "" : "s"}` : "No payments yet"}</p>
      <div class="z-card">${Z.copyRow({ label: "IBAN", value: c.iban, display: Z.groupIban(c.iban), mono: true })}</div>
      ${pays.length ? `<section class="z-group"><h3 class="z-eyebrow">Past payments</h3><dl class="z-kv z-kv--flat">${pays.slice(0, 5).map((t) => `<div><dt>${esc(phDay(t.createdAt))}</dt><dd class="z-fig">${phOut(t) ? "−" : ""}${esc(phEur(t.sendEur))}</dd></div>`).join("")}</dl></section>` : ""}
      ${phSendBlocked() ? "" : Z.button({ variant: "primary", full: true, icon: "arrow_outward", label: "Pay", href: phHref("send/amount", c.key), id: "ph-contact-pay" })}</div>`,
  }));
  const scrim = $("ph-contact");
  scrim.dataset.ph = "1";
  const pay = scrim.querySelector("#ph-contact-pay");
  if (pay) pay.onclick = (e) => {
    e.preventDefault();
    phSend = { payee: { name: c.name, iban: c.iban }, amount: "", reference: "", quote: null, transferId: null, error: null };
    Z.closeOverlay("ph-contact");
    phGo("send/amount", "new");
  };
  Z.openOverlay("ph-contact", root.querySelector(`a[href="${phHref("contacts", key)}"]`));
  const watch = new MutationObserver(() => {
    if (!scrim.classList.contains("is-open")) {
      watch.disconnect();
      // Removed by a redraw, which opens the sheet again: not a close.
      if (!scrim.isConnected) return;
      if (phRoute?.name === "contacts" && phRoute.arg) history.replaceState({ ph: true }, "", `${location.pathname}${location.search}#contacts`), (phRoute = { name: "contacts", arg: null });
    }
  });
  watch.observe(scrim, { attributes: true, attributeFilter: ["class"] });
}

/* ==========================================================================
   Profile
   ========================================================================== */

/* The name is the person's until Monerium verifies it; a company login is
   named after its company (server: users/display-name.ts). */
const phNameLocked = (u = user) => u?.accountType === "company" || kycApproved(u);

function phNameSheet(trigger) {
  const u = user || {};
  const name = ownAccountName(u);
  const why = u.accountType === "company"
    ? "This account is the company’s, so it carries the company’s name. Change it in Zold Business, under Settings."
    : "Verified by Monerium. It is the name your IBAN is held under, so it can’t be changed here.";
  document.getElementById("ph-name")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-name", title: "Your name",
    body: phNameLocked(u)
      ? `<div class="z-sheet__body"><div class="z-card">${Z.copyRow({ label: "Name", value: name })}</div>${Z.note({ text: why })}</div>`
      : `<form class="z-sheet__body z-form" id="ph-name-form" novalidate>
          ${Z.field({ id: "ph-name-input", label: "Name", name: "name", autocomplete: "name", value: u.name || "", maxlength: 80,
            hint: "Shown on your payment page, receipts and documents. Once Monerium verifies you, it is locked to your verified name." })}
          ${Z.button({ variant: "primary", full: true, label: "Save", type: "submit" })}
        </form>`,
  }));
  const scrim = $("ph-name");
  scrim.dataset.ph = "1";
  const form = scrim.querySelector("#ph-name-form");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const input = form.querySelector("#ph-name-input");
    const btn = form.querySelector('button[type="submit"]');
    Z.setFieldError(input, input.value.trim().length >= 2 ? "" : "Enter your name.");
    if (Z.focusFirstError(form)) return;
    Z.setLoading(btn, true);
    try {
      const updated = await api(`/api/users/${user.id}/name`, { name: input.value }, "PATCH");
      user.name = updated.name;
      Z.closeOverlay("ph-name");
      phRender();
    } catch (err) {
      Z.setLoading(btn, false);
      Z.setFieldError(input, err.message);
      input.focus();
    }
  };
  Z.openOverlay("ph-name", trigger);
}

/* Their own books live in /business: open it, or make the personal space
   first (one per person, none for a company login: routes/orgs.ts). */
async function phOpenBusiness(btn) {
  const err = $("ph-biz-err");
  err.hidden = true;
  Z.setLoading(btn, true);
  try {
    const r = await api("/api/orgs", { type: "personal", name: user.name || "Personal", country: user.country });
    try { localStorage.setItem("zold-org", r.organisation.id); } catch { /* opens the first org */ }
    location.assign("/business");
  } catch (e) {
    // Made meanwhile (another tab, a stale list): it is there to open.
    if (e.code === "PERSONAL_ORG_EXISTS") return location.assign("/business");
    Z.setLoading(btn, false);
    err.textContent = e.message;
    err.hidden = false;
  }
}

PH.more = {
  title: "Profile",
  tab: "more",
  live: () => JSON.stringify([phCache.orgs?.map((o) => o.id), user?.name, user?.kycStatus, user?.email, user?.iban,
    user?.paymentPage?.handle, ownCompanyOrg?.id, phSecurityChecks()]),
  html() {
    const u = user || {};
    const orgs = phCache.orgs || [];
    const companies = orgs.filter((o) => o.type !== "personal");
    const name = ownAccountName(u) || "Your name";
    const handle = u.paymentPage?.handle;
    const checks = phSecurityChecks();
    const company = u.accountType === "company";
    const head = `<section class="z-card z-switch" aria-label="You">
        ${Z.avatar({ name, tone: "p" })}
        <span class="z-row__main"><span class="z-row__title">${esc(name)}</span>
          <span class="z-row__sub">${handle ? `<span translate="no">@${esc(handle)}</span>` : "No Zold tag yet"}</span></span>
        ${Z.iconButton({ icon: phNameLocked(u) ? "lock" : "edit", label: phNameLocked(u) ? "Why your name is locked" : "Change your name", id: "ph-name-btn" })}
      </section>`;
    const you = [
      handle
        ? Z.row({ lead: Z.iconTile({ icon: "link" }), title: "Your payment link", sub: `${location.host}/pay/${handle}`, href: "#get-paid/page" })
        : Z.row({ lead: Z.iconTile({ icon: "alternate_email" }), title: "Set your Zold tag", sub: `People pay you at ${location.host}/pay/you`, right: Z.tag("Do this", "amber"), href: "#get-paid/page" }),
      Z.row({ lead: Z.iconTile({ icon: "account_balance" }), title: "Account", sub: [u.iban && kycApproved(u) ? `IBAN •••• ${String(u.iban).replace(/\s+/g, "").slice(-4)}` : "", u.email].filter(Boolean).join(" · ") || "Details and email", href: "#account-details" }),
      Z.row({ lead: Z.iconTile({ icon: "shield_lock" }), title: "Security", sub: "Recovery, sign-in and this phone’s key", right: checks ? Z.tag(`${checks} to check`, "amber") : "", href: "#security" }),
      Z.row({ lead: Z.iconTile({ icon: "settings" }), title: "Settings", sub: "Currency, connections, documents, plan", href: "#settings" }),
      Z.row({ lead: Z.iconTile({ icon: "contacts" }), title: "Contacts", sub: "People and companies you pay", href: "#contacts" }),
    ];
    const business = company || phPersonalOrg() || phCache.orgs === null
      ? Z.row({ lead: Z.iconTile({ icon: "storefront" }), title: company ? "Company dashboard" : "Zold Business",
        sub: company ? "Payments, approvals, members and books" : companies.length ? `Invoices and books; ${companies.map((o) => o.name).join(", ")}` : "Invoices, books and apps",
        right: Z.icon("open_in_new", "z-row__chev"), href: "/business" })
      : `<button type="button" class="z-row z-row--btn" id="ph-biz-create">${Z.iconTile({ icon: "storefront" })}<span class="z-row__main"><span class="z-row__title">Create your personal space</span><span class="z-row__sub">Your own invoices and books, in Zold Business</span></span>${Z.icon("chevron_right", "z-row__chev")}</button>`;
    const other = [
      ...(HAS("gnosis_pay") ? [Z.row({ lead: Z.iconTile({ icon: "credit_card" }), title: "Gnosis Pay card", sub: "A card you already have, connected", right: Z.tag("Beta"), href: "#card" })] : []),
      Z.row({ lead: Z.iconTile({ icon: "hourglass_top" }), title: "Coming soon", sub: "What this account can’t do yet, and why", href: "#soon" }),
      Z.row({ lead: Z.iconTile({ icon: "help" }), title: "Help", sub: "support@zoldhq.com", href: "mailto:support@zoldhq.com" }),
    ];
    return `<header class="z-app__head">${Z.largeTitle({ title: "Profile" })}</header>${phMain(`
      ${head}
      ${Z.listGroup({ rows: you })}
      ${Z.listGroup({ rows: [business] })}<p class="z-err" id="ph-biz-err" role="alert" hidden></p>
      ${Z.listGroup({ rows: other })}
    `)}`;
  },
  bind(root) {
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "more") phRender(); });
    phLoadKey("more");
    const nm = root.querySelector("#ph-name-btn");
    if (nm) nm.onclick = () => phNameSheet(nm);
    const biz = root.querySelector("#ph-biz-create");
    if (biz) biz.onclick = () => phOpenBusiness(biz);
  },
};

/* Reset the per-account caches (sign-out, a different account). */
function phReset() {
  phCache.deposits = null; phCache.links = null; phCache.methods = null; phCache.orgs = null;
  phCache.plans = {}; phCache.signers = undefined; phCache.soon = null;
  ownCompanyOrg = null;
  phCache.contacts = null; phCache.bic = undefined; phCache.bicFor = ""; phCache.linksError = null;
  phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };
  phQuery = "";
}
