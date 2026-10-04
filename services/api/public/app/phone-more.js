/**
 * The phone app: Contacts and More.
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
   More
   ========================================================================== */

const PH_ROLE = { owner: "Owner", admin: "Admin", payer: "Payer", accountant: "Accountant", viewer: "Viewer" };
const phRoleWord = (role) => PH_ROLE[role] || String(role || "");

/* A row into the web app for a company. */
const phWebRow = (org, o) => Z.row(o).replace('<a class="z-row"', `<a class="z-row" data-ph-org="${esc(org.id)}"`);

/* Who the phone acts for: the personal account or one company. */
function phSwitchSheet(trigger) {
  const u = user || {};
  const companies = (phCache.orgs || []).filter((o) => o.type !== "personal");
  const choice = (id, name, sub) => {
    const here = (id || null) === phCompanyId;
    return `<li><button type="button" class="z-row z-row--btn" data-ph-switch="${esc(id || "")}"${here ? ' aria-current="true"' : ""}>${Z.avatar({ name, tone: here ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(name)}</span><span class="z-row__sub">${esc(sub)}</span></span>${here ? `<span class="z-row__right">${Z.icon("check")}<span class="z-sr">(current)</span></span>` : ""}</button></li>`;
  };
  document.getElementById("ph-switch")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-switch", title: "Switch account",
    body: `<ul class="z-list z-card">${choice(null, ownAccountName(u) || ownAccountKind(u), `${ownAccountKind(u)} account`)}${companies.map((o) => choice(o.id, o.name, `Business · you are ${phRoleWord(o.role).toLowerCase()}`)).join("")}</ul>`,
  }));
  const scrim = $("ph-switch");
  scrim.dataset.ph = "1";
  scrim.querySelectorAll("[data-ph-switch]").forEach((b) => {
    b.onclick = () => {
      Z.closeOverlay("ph-switch");
      phUseCompany(b.dataset.phSwitch || null);
      phGo(phCompanyId ? "company" : "home");
    };
  });
  Z.openOverlay("ph-switch", trigger);
}

PH.more = {
  title: "More",
  tab: "more",
  live: () => JSON.stringify([phCache.orgs?.map((o) => o.id), phCompanyId]),
  html() {
    const u = user || {};
    const orgs = phCache.orgs || [];
    const companies = orgs.filter((o) => o.type !== "personal");
    const co = phCompany();
    const has = (cap) => orgs.some((o) => phCan(o, cap));
    const who = co
      ? { name: co.name, sub: `Business · you are ${phRoleWord(co.role).toLowerCase()}` }
      : { name: ownAccountName(u), sub: companies.length ? `${ownAccountKind(u)} · switch to ${companies.map((o) => o.name).join(", ")}` : `${ownAccountKind(u)} account` };
    const switcher = companies.length
      ? `<button type="button" class="z-card z-switch" id="ph-switch-btn" aria-haspopup="dialog">${Z.avatar({ name: who.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(who.name)}</span><span class="z-row__sub">${esc(who.sub)}</span></span>${Z.icon("unfold_more", "z-row__chev")}</button>`
      : `<div class="z-card z-switch">${Z.avatar({ name: who.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(who.name)}</span><span class="z-row__sub">${esc(who.sub)}</span></span></div>`;
    const work = co
      ? [
        ...(phCan(co, "invoices") ? [phWebRow(co, { lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "In the web app", href: phWebHref("invoices") })] : []),
        phWebRow(co, { lead: Z.iconTile({ icon: "contacts" }), title: "Contacts", sub: "In the web app", href: phWebHref("contacts") }),
        ...(phCan(co, "ledger.transactions") ? [phWebRow(co, { lead: Z.iconTile({ icon: "menu_book" }), title: "Books", sub: "Memos, categories, receipts, exports", href: phWebHref("ledger") })] : []),
        Z.row({ lead: Z.iconTile({ icon: "inbox" }), title: "Approvals", sub: "Payments waiting for a second person", href: "#approvals" }),
        Z.row({ lead: Z.iconTile({ icon: "group" }), title: "Members", sub: "Who is in this company and what they can do", href: "#members" }),
      ]
      : [
        ...(phPersonalOrg()
          ? [Z.row({ lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "Issue, request and pay invoices", href: "#invoices" })]
          : has("invoices") ? [Z.row({ lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "In your company account", href: "/business" })] : []),
        Z.row({ lead: Z.iconTile({ icon: "contacts" }), title: "Contacts", sub: "People and companies you pay", href: "#contacts" }),
        ...(has("ledger.transactions") ? [Z.row({ lead: Z.iconTile({ icon: "menu_book" }), title: "Books", sub: "Memos, categories, receipts, exports", href: "/business" })] : []),
        companies.length
          ? Z.row({ lead: Z.iconTile({ icon: "inbox" }), title: "Approvals", sub: `In ${companies.map((o) => o.name).join(", ")}`, right: Z.tag("Business"), href: "#approvals" })
          : `<div class="z-row z-row--soon" aria-disabled="true">${Z.iconTile({ icon: "inbox" })}<span class="z-row__main"><span class="z-row__title">Approvals</span><span class="z-row__sub">Only in company accounts</span></span><span class="z-row__right">${Z.tag("Business")}</span></div>`,
      ];
    const other = [
      Z.row({ lead: Z.iconTile({ icon: "settings" }), title: "Settings", sub: "Account, security, plan", href: "#settings" }),
      Z.row({ lead: Z.iconTile({ icon: "hourglass_top" }), title: "Coming soon", sub: "What this account can’t do yet, and why", href: "#soon" }),
      ...(!co && HAS("gnosis_pay") ? [Z.row({ lead: Z.iconTile({ icon: "credit_card" }), title: "Gnosis Pay card", sub: "A card you already have, connected", right: Z.tag("Beta"), href: "#card" })] : []),
      Z.row({ lead: Z.iconTile({ icon: "help" }), title: "Help", sub: "support@zoldhq.com", href: "mailto:support@zoldhq.com" }),
    ];
    return `<header class="z-app__head">${Z.largeTitle({ title: "More" })}</header>${phMain(`
      ${phCache.orgs === null ? `<div class="z-card">${Z.skeletonRows(1, "Loading…")}</div>` : switcher}
      ${Z.listGroup({ rows: work })}
      ${Z.listGroup({ rows: other })}
    `)}`;
  },
  bind(root) {
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "more") phRender(); });
    const sw = root.querySelector("#ph-switch-btn");
    if (sw) sw.onclick = () => phSwitchSheet(sw);
  },
};

/* Reset the per-account caches (sign-out, a different account). */
function phReset() {
  phCache.deposits = null; phCache.links = null; phCache.methods = null; phCache.orgs = null;
  phCache.invoices = null; phCache.invProfile = null; phCache.invError = null; phCache.integrations = null;
  phCache.invIssued = null; phCache.invRequest = null;
  phCache.co = null; phCache.approvalsWaiting = 0; phCache.inviteLinks = {}; phCache.plans = {}; phCache.signers = undefined; phCache.soon = null;
  phCompanyId = null; ownCompanyOrg = null;
  phCache.contacts = null; phCache.bic = undefined; phCache.bicFor = ""; phCache.linksError = null;
  phSend = { payee: null, amount: "", reference: "", quote: null, transferId: null, error: null };
  phQuery = "";
}
