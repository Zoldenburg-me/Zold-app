/**
 * Apps (design canvas "Desk-Apps"): tools that take payments for the
 * organisation. Shopify is the only one; accounting software is in Books,
 * Connections.
 *
 * Shopify: Zold as a payment method on a merchant's store. Crypto only, sale
 * only, refunds by hand: every one of those limits is printed here rather
 * than discovered by a customer at checkout.
 *
 * Two ways in. Where the deployment offers merchant links
 * (GET /api/orgs/:id/merchant-links says `available`), a store is linked
 * through the Zold checkout service, which holds the Shopify side. Otherwise
 * the store connects to this deployment directly (/api/orgs/:id/shopify).
 */
import { Z, api, day, esc, eur, org, plain, usdSymbol } from "./core.js";
import { META, RENDER } from "./views.js";

/** A reason from the API, closed with a full stop before the next sentence. */
const sentence = (s) => (s = String(s).trim()) && !/[.!?]$/.test(s) ? `${s}.` : s;
const table = (head, rows) => `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr>${head.map((h) =>
  `<th scope="col"${h.startsWith("#") ? ' class="num"' : ""}>${h.replace(/^#/, "") || '<span class="z-sr">Actions</span>'}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const heading = (id, text) => `<h2 class="zb-h2" id="${id}" style="margin:28px 0 12px">${esc(text)}</h2>`;

META.apps = () => ({ title: "Apps", sub: `Tools that take payments for ${org.name}. Accounting software is in Books, Connections.`, actions: "" });
META.shopify = META.apps;

function appCard(d, custom) {
  const connect = d.available
    ? `<form class="zb-app__form" onsubmit="return false"><label for="sh-shop">${d.connections.length ? "Connect another store" : "Store address"}</label>
        <div class="zb-app__row"><input id="sh-shop" name="shop" autocomplete="off" spellcheck="false" placeholder="my-store.myshopify.com…" />
        <button type="button" class="z-btn z-btn--primary" data-act="shopify-connect">Connect store</button></div>
        <p class="zb-hint">You approve the app at Shopify. The store’s access key is stored encrypted and never shown.${custom ? " Connecting subscribes Zold to the store’s new orders." : ""}</p></form>`
    : `<div class="banner warn">${Z.icon("info")}<span><b>Not available here.</b> ${esc(sentence(plain(d.reason || "")))} ${custom
        ? "A Shopify app has to be created in a Partner account, and its key set on this deployment."
        : "A Shopify payments app has to be approved into Shopify’s Payments Apps program first. Nobody has done that yet."}</span></div>`;
  return `<section class="z-card zb-pad zb-app" aria-labelledby="app-shopify">
      <div class="zb-app__head">${Z.iconTile({ icon: "storefront" })}<div><h2 class="zb-h2" id="app-shopify">Shopify ${Z.tag("Beta")}</h2>
        <p class="desc">Customers pay an order in digital dollars (${usdSymbol}), and Zold marks it paid in Shopify once the money arrives.</p></div></div>
      ${connect}</section>`;
}

function storesTable(d, title = "Connected stores", id = "app-stores") {
  if (!d.connections.length) return `${heading(id, title)}<div class="z-card"><p class="empty">No store connected.</p></div>`;
  return heading(id, title) + table(["Store", "Pays into", "Status", "Installed", ""], d.connections.map((c) => `<tr>
      <td><b>${esc(c.shop)}</b></td><td class="z-mono">@${esc(c.payeeHandle || "")}</td>
      <td>${c.ready ? Z.tag("Active") : `${Z.tag("Needs setup", "amber")}${c.configureError ? `<p class="desc">${esc(plain(c.configureError))}</p>` : ""}`}</td>
      <td class="z-dim">${esc(day(c.installedAt))}${c.lastSessionAt ? `, last order ${esc(day(c.lastSessionAt))}` : ""}</td>
      <td class="num"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="shopify-disconnect" data-id="${esc(c.id)}">Disconnect<span class="z-sr"> ${esc(c.shop)}</span></button></td></tr>`));
}

/** `viaCheckout`: the checkout service marks these orders paid, and this
 *  deployment does not see when, so there is no "marked paid" column. */
function ordersTable(d, custom, { viaCheckout = false, id = "app-orders" } = {}) {
  const title = custom ? "Orders" : "Checkouts";
  if (!d.requests.length) return `${heading(id, title)}<div class="z-card"><p class="empty">${custom ? "No orders yet." : "No checkouts yet."}</p></div>`;
  const many = new Set(d.requests.map((r) => r.shop)).size > 1;
  const told = (r) => r.resolvedAt ? Z.tag("Done")
    : r.state === "PAID" ? `${Z.tag("Not yet", "amber")}${r.resolveError ? `<p class="desc">${esc(plain(r.resolveError))}</p>` : ""}`
      : '<span class="z-dim">Not yet</span>';
  const paid = (r) => r.payments?.length
    ? r.payments.map((p) => `${esc(String(p.amountUsdc ?? ""))} ${usdSymbol}${p.settledEur !== undefined ? ` → ${esc(eur(p.settledEur))}` : ` (kept as ${usdSymbol})`}`).join("<br>")
    : r.state === "OPEN" ? "Waiting for payment" : "";
  return heading(id, title) + table(["When", "Order", "#Amount", "Paid", "Status", ...(viaCheckout ? [] : ["Marked paid in Shopify"]), ""], d.requests.map((r) => `<tr>
      <td class="z-dim">${esc(day(r.createdAt))}${r.test ? ` ${Z.tag("Test", "amber")}` : ""}</td>
      <td>${r.orderName ? `<span class="z-mono">${esc(r.orderName)}</span>` : ""}${many || !r.orderName ? `<span class="zb-sub2">${esc(r.shop)}</span>` : ""}</td>
      <td class="num">${esc(eur(r.amountEur ?? 0))}</td>
      <td class="z-dim">${paid(r)}</td>
      <td>${Z.tag(r.state === "PAID" ? "Paid" : r.state === "OPEN" ? "Open" : r.state.toLowerCase())}</td>
      ${viaCheckout ? "" : `<td>${told(r)}</td>`}
      <td class="num"><a class="z-btn z-btn--secondary z-btn--sm" href="${esc(r.url)}" target="_blank" rel="noopener">Page<span class="z-sr"> (opens in a new tab)</span></a></td></tr>`));
}

function payLinks(d) {
  const rows = d.connections.filter((c) => c.payLinkTemplate);
  if (!rows.length) return d.connections.length && !d.canManage ? `<p class="zb-hint">An owner or admin sees the pay link here.</p>` : "";
  return `<dl class="zb-set-rows">${rows.map((c) => `<div><dt>Pay link, ${esc(c.shop)}</dt><dd class="z-mono">${esc(c.payLinkTemplate)}</dd></div>`).join("")}</dl>`;
}

function setUp(d, custom) {
  const ttl = esc(String(d.orderTtlHours || 24));
  const endpoints = `<dl class="zb-set-rows">${Object.entries(d.endpoints).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="z-mono">${esc(v)}</dd></div>`).join("")}</dl>`;
  const limits = custom
    ? `Limits, plainly: the buyer pays after placing the order, so stock is held while it waits. Unpaid orders stay “payment pending” for ${ttl} hours and are yours to cancel. Refunds are made by you from Zold, and a payment that arrives after ${ttl} hours lands on your payment page without its order, so you mark that order paid yourself.`
    : "Limits, plainly: bank transfer isn’t offered at checkout (too slow for a session), refunds are made by you from Zold, and manual capture isn’t supported.";
  const steps = custom
    ? `<p class="desc">Four steps in Shopify, in this order. The app asks for: <span class="z-mono">${esc(d.scopes || "")}</span>.</p>
      <ol class="zb-steps">
        <li><b>Payment method.</b> Settings, Payments, Manual payment methods, Create custom payment method. Name it so it contains “<b>${esc(d.manualGateway || "zold")}</b>”: that’s how Zold recognises its orders. Keep the store’s checkout currency to euros; other orders are ignored.</li>
        <li><b>Connect the store</b> above. Zold subscribes to the store’s new and cancelled orders itself.</li>
        <li><b>Thank-you page</b> (recommended). Install the Zold checkout extension from the <span class="z-mono">shopify-app/</span> project and add its block to the Thank you page, pointing at this deployment.</li>
        <li><b>Confirmation email.</b> Settings, Notifications, Order confirmation: add the store’s pay link below. It is signed with a key for that store, so only someone who got the email can open the order’s payment; keep the template private. Place a test order and open the link before relying on it: Zold has not yet seen Shopify render this signature in an email.</li>
      </ol>${endpoints}${payLinks(d)}`
    : `<p class="desc">Paste these into the app’s payments extension. Currency: euros. Payment method type: offsite.</p>${endpoints}`;
  return `<p class="zb-hint" style="margin-top:12px">${limits}</p>
    <details class="z-card zb-pad zb-app__setup"><summary>${custom ? "How to set up the store" : "Partner Dashboard settings"}</summary>${steps}</details>`;
}

// ── Through the checkout service (merchant links) ──────────────────────

function linkCard(m) {
  const connect = m.canManage
    ? `<form class="zb-app__form" onsubmit="return false"><label for="ml-shop">${m.links.some((l) => !l.revokedAt) ? "Connect another store" : "Store address"}</label>
        <div class="zb-app__row"><input id="ml-shop" name="shop" autocomplete="off" spellcheck="false" placeholder="my-store.myshopify.com…" />
        <button type="button" class="z-btn z-btn--primary" data-act="merchant-link-connect">Connect store</button></div>
        <p class="zb-hint">You approve the app at Shopify on the Zold checkout. The store’s access key stays with the checkout, stored encrypted, and is never shown.</p></form>`
    : `<p class="zb-hint">An owner or admin connects stores.</p>`;
  return `<section class="z-card zb-pad zb-app" aria-labelledby="app-shopify">
      <div class="zb-app__head">${Z.iconTile({ icon: "storefront" })}<div><h2 class="zb-h2" id="app-shopify">Shopify ${Z.tag("Beta")}</h2>
        <p class="desc">Customers pay an order in digital dollars (${usdSymbol}), and the Zold checkout marks it paid in Shopify once the money arrives.</p></div></div>
      ${connect}</section>`;
}

function linksTable(m) {
  if (!m.links.length) return `${heading("app-stores", "Connected stores")}<div class="z-card"><p class="empty">No store connected.</p></div>`;
  return heading("app-stores", "Connected stores") + table(["Store", "Pays into", "Connected", ""], m.links.map((l) => `<tr>
      <td><b>${esc(l.shop)}</b>${l.revokedAt ? ` ${Z.tag("Disconnected", "amber")}` : ""}</td><td class="z-mono">@${esc(l.payeeHandle || "")}</td>
      <td class="z-dim">${esc(day(l.createdAt))}${l.createdBy ? ` by ${esc(l.createdBy)}` : ""}${l.lastRequestAt ? `, last order ${esc(day(l.lastRequestAt))}` : ""}${l.revokedAt ? `, disconnected ${esc(day(l.revokedAt))}` : ""}</td>
      <td class="num">${m.canManage && !l.revokedAt ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="merchant-link-disconnect" data-id="${esc(l.id)}">Disconnect<span class="z-sr"> ${esc(l.shop)}</span></button>` : ""}</td></tr>`));
}

function linkSetUp(m) {
  const rows = m.links.filter((l) => l.payLinkTemplate);
  const copies = rows.map((l) => `<ul class="z-list z-card" style="margin-top:12px">
      <li>${Z.copyRow({ label: `Pay link, ${l.shop}`, value: l.payLinkTemplate, mono: true })}</li>
      <li>${Z.copyRow({ label: "Zold Checkout origin", value: l.extensionOrigin, mono: true })}</li></ul>`).join("");
  return `<p class="zb-hint" style="margin-top:12px">Limits, plainly: the buyer pays after placing the order, so stock is held while it waits. Unpaid orders stay “payment pending” until their payment window ends and are yours to cancel. Refunds are made by you from Zold.</p>
    <details class="z-card zb-pad zb-app__setup"><summary>How to set up the store</summary>
      <ol class="zb-steps">
        <li><b>Payment method.</b> Settings, Payments, Manual payment methods, Create custom payment method. Name it so it contains “<b>zold</b>”: that’s how the checkout recognises its orders. Keep the store’s checkout currency to euros; other orders are ignored.</li>
        <li><b>Connect the store</b> above. The checkout subscribes to the store’s new and cancelled orders itself.</li>
        <li><b>Thank-you page</b> (recommended). Add the Zold checkout block to the Thank you page and set its Zold Checkout origin to the one below.</li>
        <li><b>Confirmation email.</b> Settings, Notifications, Order confirmation: add the store’s pay link below. It is signed with a key for that store, so only someone who got the email can open the order’s payment; keep the template private. Place a test order and open the link before relying on it.</li>
      </ol>${rows.length ? copies : `<p class="zb-hint">${m.canManage ? "The pay link and origin appear here once a store is connected." : "An owner or admin sees the pay link and origin here."}</p>`}</details>`;
}

async function renderLinked(m) {
  // A store still connected directly stays listed, so it can be disconnected.
  const core = await api(`/api/orgs/${org.id}/shopify`);
  const direct = core.connections.length
    ? `${storesTable(core, "Connected directly", "app-direct")}${ordersTable(core, core.mode === "custom-app", { id: "app-direct-orders" })}`
    : "";
  return `${linkCard(m)}${linksTable(m)}${ordersTable(m, true, { viaCheckout: true })}${linkSetUp(m)}${direct}`;
}

RENDER.apps = async () => {
  const m = await api(`/api/orgs/${org.id}/merchant-links`);
  if (m.available) return renderLinked(m);
  const d = await api(`/api/orgs/${org.id}/shopify`);
  const custom = d.mode === "custom-app";
  return `${appCard(d, custom)}${storesTable(d)}${ordersTable(d, custom)}${setUp(d, custom)}`;
};
RENDER.shopify = RENDER.apps;
