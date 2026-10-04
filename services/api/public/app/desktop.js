/**
 * The app from 1024px (design/ui-v2 build step 8): a 256px sidebar next to
 * the open screen, Home laid out for a wide window, and Search (Cmd or Ctrl
 * K) over payments and contacts. Sheets turn into right drawers in
 * ui.css. Screens without a desktop layout keep their phone column, centred.
 *
 * It fills in PH_DESK and adds a `desk` layout to Home (both declared in
 * app/phone.js). A company's desktop is the web app (/business): picking a
 * company here opens it there. Declarations and listeners only; app/main.js
 * stays last.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - Search reads only what this page already loaded from the API (payments,
 *   contacts); there is no search route, and nothing is guessed.
 * - The payment page QR the API draws holds the wallet address, not the page
 *   link, so the Get paid card shows the link without a QR next to it.
 */

const PH_DESK_MQ = window.matchMedia("(min-width: 1024px)");
PH_DESK.on = () => PH_DESK_MQ.matches;

/* Crossing 1024px redraws the open screen in the other layout. */
PH_DESK_MQ.addEventListener("change", () => {
  if (!phRoute || $("phone")?.hidden) return;
  // An open sheet belongs to the layout it was opened in.
  document.querySelectorAll("body > .z-scrim[data-ph]:not([hidden])").forEach((el) => Z.closeOverlay(el.id));
  phRender();
});

const phMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/* ==========================================================================
   Sidebar
   ========================================================================== */

/* Which sidebar item a screen belongs to. */
function phSideActive(name) {
  if (name === "contacts") return "contacts";
  if (name === "soon") return "soon";
  if (["more", "settings", "security", "plan", "settings/currency"].includes(name)) return "settings";
  if (/^(tx|send)/.test(name)) return name.startsWith("tx") ? "activity" : "send";
  if (/^(get-paid|link)/.test(name)) return "get-paid";
  if (/^(add|convert|account-details)/.test(name)) return "home";
  return PH[name]?.tab || "";
}

function phSideLink(it, active) {
  const here = it.id === active;
  const org = it.org ? ` data-ph-org="${esc(it.org)}"` : "";
  return `<a class="z-side__link" href="${esc(it.href)}"${org}${here ? ' aria-current="page"' : ""}>${Z.icon(it.icon)}<span>${esc(it.label)}</span>`
    + `${it.badge ? `<span class="z-side__badge"><span class="z-sr">, </span>${esc(it.badge)}<span class="z-sr"> waiting</span></span>` : ""}`
    + `${it.web ? `${Z.icon("open_in_new", "z-side__out")}<span class="z-sr"> (web app)</span>` : ""}</a>`;
}

/* The sidebar's items: the person's own. Invoices and books are kept in
   Zold Business, for the personal space and each company. */
function phSideItems() {
  const orgs = phCache.orgs || [];
  const has = (cap) => orgs.some((o) => phCan(o, cap));
  const personal = phPersonalOrg();
  return [
    { id: "home", href: "#home", icon: "home", label: "Home" },
    { id: "send", href: "#send", icon: "arrow_outward", label: "Send" },
    { id: "get-paid", href: "#get-paid", icon: "south_west", label: "Get paid" },
    { id: "activity", href: "#activity", icon: "swap_vert", label: "Activity" },
    { id: "contacts", href: "#contacts", icon: "contacts", label: "Contacts" },
    ...(has("invoices") ? [{ id: "invoices", href: phWebHref("invoices"), icon: "receipt_long", label: "Invoices", web: true, ...(personal ? { org: personal.id } : {}) }] : []),
    ...(has("ledger.transactions") ? [{ id: "books", href: phWebHref("books"), icon: "menu_book", label: "Books", web: true, ...(personal ? { org: personal.id } : {}) }] : []),
  ];
}

PH_DESK.side = (route) => {
  // Loaded once; the sidebar is drawn again when the organisations arrive.
  if (phCache.orgs === null) phLoadOrgs().then(() => { if (PH_DESK.on() && !$("phone")?.hidden) phRender(); });
  const u = user || {};
  const companies = (phCache.orgs || []).filter((o) => o.type !== "personal");
  const who = { name: ownAccountName(u) || "Account", sub: ownAccountKind(u) };
  const card = `${Z.avatar({ name: who.name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(who.name)}</span><span class="z-row__sub">${esc(who.sub)}</span></span>`;
  const switcher = companies.length
    ? `<button type="button" class="z-side__org" id="dk-switch-btn" aria-haspopup="dialog" aria-label="Switch account. Current: ${esc(who.name)}">${card}${Z.icon("unfold_more", "z-row__chev")}</button>`
    : `<div class="z-side__org">${card}</div>`;
  const active = phSideActive(route.name);
  // Search reads the person's own payments and contacts.
  const search = `<button type="button" class="z-side__search" id="dk-search-btn" aria-haspopup="dialog" aria-keyshortcuts="${phMac ? "Meta+K" : "Control+K"}">${Z.icon("search")}<span>Search</span><kbd class="z-kbd">${phMac ? "⌘K" : "Ctrl K"}</kbd></button>`;
  return `<aside class="z-side" aria-label="Sidebar">
    <a class="z-side__brand" href="#home"><span class="z-brand-tri" aria-hidden="true">▽</span>Zold</a>
    ${phCache.orgs === null ? `<div class="z-side__org">${Z.skeletonRows(1, "Loading…")}</div>` : switcher}
    ${search}
    <nav class="z-side__nav" aria-label="Main">${phSideItems().map((it) => phSideLink(it, active)).join("")}</nav>
    <div class="z-side__foot">
      ${phSideLink({ id: "soon", href: "#soon", icon: "hourglass_top", label: "Coming soon" }, active)}
      ${phSideLink({ id: "settings", href: "#more", icon: "person", label: "Profile" }, active)}
      ${Z.testModePill(!realMoney)}
    </div>
  </aside>`;
};

/* Switching on a desktop: the person's own account is this app; a company
   opens in Zold Business. */
function phDeskSwitch(trigger) {
  const u = user || {};
  const companies = (phCache.orgs || []).filter((o) => o.type !== "personal");
  const here = (id) => !id;
  const mark = (id) => (here(id) ? `<span class="z-row__right">${Z.icon("check")}<span class="z-sr">(current)</span></span>` : "");
  document.getElementById("dk-switch")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "dk-switch", title: "Switch account",
    body: `<div class="z-sheet__body"><ul class="z-list z-card">
      <li><button type="button" class="z-row z-row--btn" data-dk-personal${here(null) ? ' aria-current="true"' : ""}>${Z.avatar({ name: ownAccountName(u) || "Personal", tone: here(null) ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(ownAccountName(u) || "Personal")}</span><span class="z-row__sub">${ownAccountKind(u)} account</span></span>${mark(null)}</button></li>
      ${companies.map((o) => `<li><a class="z-row" href="/business" data-ph-org="${esc(o.id)}">${Z.avatar({ name: o.name, tone: here(o.id) ? "p" : "n" })}<span class="z-row__main"><span class="z-row__title">${esc(o.name)}</span><span class="z-row__sub">Business · opens the web app</span></span>${mark(o.id) || Z.icon("open_in_new", "z-row__chev")}</a></li>`).join("")}
    </ul></div>`,
  }));
  const scrim = $("dk-switch");
  scrim.dataset.ph = "1";
  scrim.querySelector("[data-dk-personal]").onclick = () => {
    Z.closeOverlay("dk-switch");
    phGo("home");
  };
  Z.openOverlay("dk-switch", trigger);
}

document.addEventListener("click", (e) => {
  const sw = e.target.closest?.("#dk-switch-btn");
  if (sw) { phDeskSwitch(sw); return; }
  const s = e.target.closest?.("#dk-search-btn");
  if (s) phSearchOpen(s);
});

/* ==========================================================================
   Home, desktop
   ========================================================================== */

function phGreeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return phFirst(name) ? `${part}, ${phFirst(name)}` : part;
}

/* The balance card: figure, the three actions, then the account details. */
function phDeskBalance(u) {
  const live = u.iban && kycApproved(u);
  const known = phCache.bicFor === u.iban && phCache.bic !== undefined;
  const details = live
    ? `<div class="z-dhome__ids">
        <div><span class="z-dhome__k">IBAN</span><span class="z-mono" translate="no">${esc(Z.groupIban(u.iban))}</span></div>
        <div><span class="z-dhome__k">BIC</span>${known
          ? `<span class="z-mono" translate="no">${esc(phCache.bic || "Not listed")}</span>`
          : '<span class="z-skel z-skel--line" style="width:90px;margin-top:4px" aria-hidden="true"></span><span class="z-sr">Loading</span>'}</div>
        <div class="z-dhome__idact">
          ${Z.button({ icon: "content_copy", label: "Copy", id: "ph-det-copy", className: "z-btn--sm" })}
          ${Z.button({ icon: "ios_share", label: "Share", id: "ph-det-share", className: "z-btn--sm" })}
        </div>
      </div>`
    : `<div class="z-dhome__ids z-dhome__ids--none"><p class="z-sub">Your IBAN appears here once Monerium has verified you and issued it.</p>
        ${Z.button({ label: "Verify with Monerium", id: "ph-det-verify", className: "z-btn--sm" })}</div>`;
  return `<section class="z-card z-dhome__bal">
    ${phBalance(u.balanceEur ?? u.safeBalanceEur ?? 0, "Balance")}
    <div class="z-dhome__acts">
      ${Z.button({ variant: "primary", icon: "arrow_outward", label: "Send", href: "#send" })}
      ${Z.button({ icon: "add", label: "Add money", href: "#add" })}
      ${Z.button({ icon: "south_west", label: "Request", href: "#get-paid" })}
    </div>
    ${details}
  </section>`;
}

/* The payment on its way, with the same steps as its progress screen. */
function phDeskInFlight(t) {
  return `<section class="z-card z-dhome__side" aria-labelledby="dk-fl-title">
    <div class="z-dhome__sidehead"><h2 id="dk-fl-title">In flight</h2>${Z.tag("IN FLIGHT")}</div>
    <a class="z-row" href="${phHref("send/progress", t.id)}">${Z.avatar({ name: t.recipientName })}<span class="z-row__main"><span class="z-row__title">${esc(t.recipientName || "Payment")}</span><span class="z-row__sub">Bank transfer</span></span><span class="z-row__right">${Z.amount({ value: t.sendEur, direction: "out" })}</span></a>
    ${phTimeline(t)}
  </section>`;
}

/* Get paid: the public page and the open links. */
function phDeskGetPaid(u) {
  const page = u.paymentPage;
  const open = (phCache.links || []).filter((r) => r.state === "OPEN").length;
  const links = phCache.links === null ? "Loading links…" : `${open} open link${open === 1 ? "" : "s"}`;
  return `<a class="z-card z-dhome__side z-dhome__gp" href="#get-paid">
    ${Z.iconTile({ icon: "south_west", tone: "p" })}
    <span class="z-row__main"><span class="z-row__title">Get paid</span>
      ${page?.handle ? `<span class="z-row__sub z-mono" translate="no">${esc(`${location.host}/pay/${page.handle}`)}</span>` : '<span class="z-row__sub">Payment links and your page</span>'}
      <span class="z-row__sub">${esc(links)}</span></span>
    ${Z.icon("chevron_right", "z-row__chev")}
  </a>`;
}

/* A payment as a table row. The name is the link; the row takes its click. */
function phDeskTxRow(t) {
  if (t.kind === "funding") {
    const usdc = t.token === "USDC";
    const word = t.state === "REFUSED" ? "IN REVIEW" : "RECEIVED";
    const who = usdc ? "Digital dollars (USDC)" : "Euros received";
    return `<tr>
      <td class="z-dim">${esc(phWhen(t.at || t.detectedAt))}</td>
      <td><span class="z-tbl__who">${Z.iconTile({ icon: usdc ? "currency_exchange" : "euro" })}${usdc ? `<a class="z-tbl__link" href="#add/wallet">${esc(who)}</a>` : `<span>${esc(who)}</span>`}</span></td>
      <td>From a crypto wallet</td>
      <td>${Z.tag(word)}</td>
      <td class="z-tbl__num">${usdc ? `<span class="z-amount z-amount--in">+${esc(Z.formatMoney(t.amountUsdc || 0, "USDC"))}</span>` : Z.amount({ value: t.amountEur || 0, direction: "in" })}</td>
    </tr>`;
  }
  return `<tr>
    <td class="z-dim">${esc(phWhen(t.createdAt))}</td>
    <td><span class="z-tbl__who">${Z.avatar({ name: t.recipientName })}<a class="z-tbl__link" href="${phHref("tx", t.id)}">${esc(t.recipientName || "Payment")}</a></span></td>
    <td>${t.reference ? esc(t.reference) : `<span class="z-dim">${t.rail === "cash" ? "Cash pickup" : "Bank transfer"}</span>`}</td>
    <td>${Z.tag(phTxWord(t))}</td>
    <td class="z-tbl__num">${phOut(t) ? Z.amount({ value: t.sendEur, direction: "out" }) : `<span class="z-amount">${esc(phEur(t.sendEur))}</span>`}</td>
  </tr>`;
}

function phDeskActivity(rows, u) {
  const head = `<div class="z-group__head"><h2 class="z-dhome__h2">Recent activity</h2>${hist.length ? '<a class="z-group__action" href="#activity">See all</a>' : ""}</div>`;
  if (!histLoaded || histLoadFailed || !rows.length) {
    return phActivityList(rows, {
      label: "Recent activity",
      empty: { text: u.iban ? "No payments yet. Share your account details to get paid." : "No payments yet. Once your IBAN is live, share it to get paid." },
    });
  }
  return `<section class="z-group">${head}<div class="z-card z-tbl-wrap"><table class="z-tbl">
    <thead><tr><th scope="col">Date</th><th scope="col">Who</th><th scope="col">Memo</th><th scope="col">Status</th><th scope="col" class="z-tbl__num">Amount</th></tr></thead>
    <tbody>${rows.map(phDeskTxRow).join("")}</tbody></table></div></section>`;
}

PH.home.desk = {
  wide: true,
  live: () => `${PH.home.live()}|${phCache.bic}|${(phCache.links || []).map((r) => r.state).join(",")}|${phCache.links === null}`,
  html() {
    const u = user || {};
    const gate = u.segment?.gate;
    const inflight = hist.find(phInFlight);
    return phMain(`
      <h1 class="z-dhome__title">${esc(phGreeting(ownAccountName(u)))}</h1>
      ${gate ? Z.note({ tone: "a", html: `<strong>${esc(gate.reason)}</strong> ${esc(gate.needs)} <a href="mailto:support@zoldhq.com">Ask us about it</a>` }) : ""}
      <div class="z-dhome__grid">
        ${phDeskBalance(u)}
        <div class="z-dhome__col">
          ${inflight ? phDeskInFlight(inflight) : ""}
          ${phDeskGetPaid(u)}
          ${phChecklist(u)}
        </div>
      </div>
      ${phDeskActivity(hist.slice(0, 6), u)}
    `, "z-dhome");
  },
  bind(root) {
    PH.home.bind(root);
    phBindDetails(root);
    const u = user || {};
    if (u.iban && kycApproved(u) && !(phCache.bicFor === u.iban && phCache.bic !== undefined)) {
      phLoadBic().then(() => { if (phRoute?.name === "home") phRefresh(); });
    }
    if (phCache.links === null) phLoadLinks().then(() => { if (phRoute?.name === "home") phRefresh(); });
  },
};

/* ==========================================================================
   One payment, desktop: a drawer over Activity
   ========================================================================== */

PH.tx.desk = {
  live: (id) => `${PH.activity.live(null)}|${PH.tx.live(id)}`,
  html: () => PH.activity.html(null),
  bind(root, id) {
    PH.activity.bind(root, null);
    const p = phTxParts(id);
    document.body.insertAdjacentHTML("beforeend", Z.overlay({
      id: "ph-txd", title: "Payment",
      body: `<div class="z-sheet__body">${p.body}${p.foot}</div>`,
    }));
    const scrim = $("ph-txd");
    scrim.dataset.ph = "1";
    PH.tx.bind(scrim, id);
    Z.openOverlay(scrim, root.querySelector(`a[href="${phHref("tx", id)}"]`));
    // Closed: the address is Activity again, so back and reload agree.
    const watch = new MutationObserver(() => {
      if (scrim.classList.contains("is-open")) return;
      watch.disconnect();
      // Removed by a redraw, which drew its own drawer: not a close.
      if (!scrim.isConnected) return;
      if (phRoute?.name === "tx") {
        phRoute = { name: "activity", arg: null };
        history.replaceState({ ph: true }, "", `${location.pathname}${location.search}#activity`);
        document.title = "Activity · Zold";
      }
      // Opened from an address, not a row: focus the page, not the closed drawer.
      if (scrim.contains(document.activeElement)) {
        const h = $("ph-root").querySelector("h1");
        h?.setAttribute("tabindex", "-1");
        h?.focus({ preventScroll: true });
      }
    });
    watch.observe(scrim, { attributes: true, attributeFilter: ["class"] });
  },
  // The payment changed (or the list arrived) while the drawer is open.
  refresh(id) {
    const list = $("ph-results");
    if (list) { list.innerHTML = phActivityResults("all"); phBindRetry(list); }
    const scrim = $("ph-txd");
    const body = scrim?.querySelector(".z-sheet__body");
    if (!body) return;
    const had = body.contains(document.activeElement);
    const p = phTxParts(id);
    body.innerHTML = `${p.body}${p.foot}`;
    PH.tx.bind(scrim, id);
    if (had) scrim.querySelector(".z-overlay__close")?.focus();
  },
};

/* ==========================================================================
   Search (Cmd or Ctrl K)
   ========================================================================== */

const phFind = { q: "", results: [], active: 0 };

/* The query's first match in `text`, marked. */
function phMark(text, q) {
  const s = String(text || "");
  const i = q ? s.toLowerCase().indexOf(q) : -1;
  if (i < 0) return esc(s);
  return `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
}

function phSearchResults(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const compact = q.replace(/\s+/g, "");
  const hit = (...xs) => xs.some((x) => String(x || "").toLowerCase().includes(q));
  const contacts = phContactList()
    .filter((c) => hit(c.name) || (compact.length > 3 && c.iban.toLowerCase().includes(compact)))
    .slice(0, 4)
    .map((c) => ({ group: "Contacts", go: ["contacts", c.key], lead: Z.avatar({ name: c.name }), title: phMark(c.name, q), right: esc(phMaskIban(c.iban)), label: c.name }));
  const payments = hist
    .filter((t) => (t.kind === "funding" ? hit("digital dollars usdc", "euros received") : hit(t.recipientName, t.reference)))
    .slice(0, 5)
    .map((t) => {
      if (t.kind === "funding") {
        const usdc = t.token === "USDC";
        const name = usdc ? "Digital dollars (USDC)" : "Euros received";
        return { group: "Payments", go: usdc ? ["add/wallet", null] : ["activity", null], lead: Z.iconTile({ icon: "south_west" }), title: phMark(name, q), right: `+${esc(usdc ? Z.formatMoney(t.amountUsdc || 0, "USDC") : phEur(t.amountEur))} · ${esc(phDay(t.at || t.detectedAt))}`, label: name };
      }
      const name = [t.recipientName || "Payment", t.reference].filter(Boolean).join(" · ");
      return { group: "Payments", go: ["tx", t.id], lead: Z.iconTile({ icon: "arrow_outward" }), title: phMark(name, q), right: `${phOut(t) ? "−" : ""}${esc(phEur(t.sendEur))} · ${esc(phDay(t.createdAt))}`, label: name };
    });
  return [...contacts, ...payments];
}

function phSearchDraw() {
  const box = $("dk-results");
  const input = $("dk-q");
  if (!box || !input) return;
  const r = phFind.results;
  const q = phFind.q.trim();
  const loading = phCache.contacts === null || (!histLoaded && !histLoadFailed);
  if (!q) {
    box.innerHTML = `<p class="z-cmdk__hint">Search your payments and contacts.</p>`;
  } else if (!r.length) {
    box.innerHTML = `<p class="z-cmdk__hint" role="status">${loading ? "Still loading, one moment…" : `Nothing matches “${esc(q)}”.`}</p>`;
  } else {
    let html = "";
    let group = "";
    r.forEach((x, i) => {
      if (x.group !== group) {
        if (group) html += "</div>";
        group = x.group;
        html += `<div role="group" aria-labelledby="dk-g-${i}"><h3 class="z-eyebrow z-cmdk__group" id="dk-g-${i}">${esc(group)}</h3>`;
      }
      html += `<div class="z-cmdk__opt" role="option" id="dk-o-${i}" data-i="${i}" aria-selected="${i === phFind.active}">${x.lead}<span class="z-cmdk__title">${x.title}</span><span class="z-cmdk__right">${x.right}</span></div>`;
    });
    box.innerHTML = `${html}</div>`;
  }
  input.setAttribute("aria-expanded", String(r.length > 0));
  if (r.length) {
    input.setAttribute("aria-activedescendant", `dk-o-${phFind.active}`);
    $(`dk-o-${phFind.active}`)?.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

function phSearchPick(i) {
  const x = phFind.results[i];
  if (!x) return;
  Z.closeOverlay("dk-search");
  phGo(x.go[0], x.go[1]);
}

function phSearchOpen(trigger) {
  if ($("phone")?.hidden) return;
  if (!$("dk-search")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="z-scrim z-scrim--dialog z-scrim--top" id="dk-search" data-ph="1" hidden>
      <div class="z-dialog z-cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <div class="z-cmdk__bar">${Z.icon("search")}
          <label class="z-sr" for="dk-q">Search payments and contacts</label>
          <input id="dk-q" class="z-cmdk__input" type="search" name="q" role="combobox" aria-expanded="false" aria-controls="dk-results" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search payments and contacts…">
          <kbd class="z-kbd">esc</kbd></div>
        <div class="z-cmdk__list" id="dk-results" role="listbox" aria-label="Results"></div>
        <div class="z-cmdk__foot" aria-hidden="true"><span><kbd class="z-kbd">↑</kbd><kbd class="z-kbd">↓</kbd> to move</span><span><kbd class="z-kbd">↵</kbd> to open</span></div>
      </div></div>`);
    const input = $("dk-q");
    input.oninput = () => {
      phFind.q = input.value;
      phFind.results = phSearchResults(input.value);
      phFind.active = 0;
      phSearchDraw();
    };
    input.onkeydown = (e) => {
      const n = phFind.results.length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); phFind.active = (phFind.active + 1) % n; phSearchDraw(); }
      else if (e.key === "ArrowUp" && n) { e.preventDefault(); phFind.active = (phFind.active - 1 + n) % n; phSearchDraw(); }
      else if (e.key === "Enter") { e.preventDefault(); phSearchPick(phFind.active); }
    };
    const box = $("dk-results");
    box.onclick = (e) => { const o = e.target.closest("[data-i]"); if (o) phSearchPick(Number(o.dataset.i)); };
    box.onmousemove = (e) => {
      const o = e.target.closest("[data-i]");
      if (!o || Number(o.dataset.i) === phFind.active) return;
      phFind.active = Number(o.dataset.i);
      box.querySelectorAll("[data-i]").forEach((el) => el.setAttribute("aria-selected", String(el === o)));
      $("dk-q").setAttribute("aria-activedescendant", o.id);
    };
  }
  const input = $("dk-q");
  input.value = phFind.q;
  phFind.results = phSearchResults(phFind.q);
  phFind.active = 0;
  phSearchDraw();
  Z.openOverlay("dk-search", trigger);
  input.select();
  // What search reads, loaded on first use and searched again when it lands.
  const again = () => { if ($("dk-search") && !$("dk-search").hidden) { phFind.results = phSearchResults(input.value); phSearchDraw(); } };
  if (phCache.contacts === null || phCache.orgs === null) phLoadContacts().then(again);
}

/* Cmd or Ctrl K opens Search anywhere in the app; again, it closes it. */
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "k" || !(phMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (!phRoute || obScreen || $("phone")?.hidden) return;
  e.preventDefault();
  const open = $("dk-search");
  if (open && !open.hidden) Z.closeOverlay("dk-search");
  else phSearchOpen(document.activeElement);
});
