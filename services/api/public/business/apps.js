/**
 * Apps (design canvas "Desk-Apps"): tools that take payments for the
 * organisation. Shopify is the only one; accounting software is in Books,
 * Connections.
 *
 * Shopify: Zold as a payment method on a merchant's store. Crypto only, sale
 * only, refunds by hand: every one of those limits is printed here rather
 * than discovered by a customer at checkout.
 */
import { Z, api, day, esc, eur, org, plain } from "./core.js";
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
        <p class="desc">Customers pay an order in digital dollars (USDC), and Zold marks it paid in Shopify once the money arrives.</p></div></div>
      ${connect}</section>`;
}

function storesTable(d) {
  if (!d.connections.length) return `${heading("app-stores", "Connected stores")}<div class="z-card"><p class="empty">No store connected.</p></div>`;
  return heading("app-stores", "Connected stores") + table(["Store", "Pays into", "Status", "Installed", ""], d.connections.map((c) => `<tr>
      <td><b>${esc(c.shop)}</b></td><td class="z-mono">@${esc(c.payeeHandle || "")}</td>
      <td>${c.ready ? Z.tag("Active") : `${Z.tag("Needs setup", "amber")}${c.configureError ? `<p class="desc">${esc(plain(c.configureError))}</p>` : ""}`}</td>
      <td class="z-dim">${esc(day(c.installedAt))}${c.lastSessionAt ? `, last order ${esc(day(c.lastSessionAt))}` : ""}</td>
      <td class="num"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="shopify-disconnect" data-id="${esc(c.id)}">Disconnect<span class="z-sr"> ${esc(c.shop)}</span></button></td></tr>`));
}

function ordersTable(d, custom) {
  const title = custom ? "Orders" : "Checkouts";
  if (!d.requests.length) return `${heading("app-orders", title)}<div class="z-card"><p class="empty">${custom ? "No orders yet." : "No checkouts yet."}</p></div>`;
  const many = new Set(d.requests.map((r) => r.shop)).size > 1;
  const told = (r) => r.resolvedAt ? Z.tag("Done")
    : r.state === "PAID" ? `${Z.tag("Not yet", "amber")}${r.resolveError ? `<p class="desc">${esc(plain(r.resolveError))}</p>` : ""}`
      : '<span class="z-dim">Not yet</span>';
  const paid = (r) => r.payments?.length
    ? r.payments.map((p) => `${esc(String(p.amountUsdc ?? ""))} USDC${p.settledEur !== undefined ? ` → ${esc(eur(p.settledEur))}` : " (kept as USDC)"}`).join("<br>")
    : r.state === "OPEN" ? "Waiting for payment" : "";
  return heading("app-orders", title) + table(["When", "Order", "#Amount", "Paid", "Status", "Marked paid in Shopify", ""], d.requests.map((r) => `<tr>
      <td class="z-dim">${esc(day(r.createdAt))}${r.test ? ` ${Z.tag("Test", "amber")}` : ""}</td>
      <td>${r.orderName ? `<span class="z-mono">${esc(r.orderName)}</span>` : ""}${many || !r.orderName ? `<span class="zb-sub2">${esc(r.shop)}</span>` : ""}</td>
      <td class="num">${esc(eur(r.amountEur ?? 0))}</td>
      <td class="z-dim">${paid(r)}</td>
      <td>${Z.tag(r.state === "PAID" ? "Paid" : r.state === "OPEN" ? "Open" : r.state.toLowerCase())}</td>
      <td>${told(r)}</td>
      <td class="num"><a class="z-btn z-btn--secondary z-btn--sm" href="${esc(r.url)}" target="_blank" rel="noopener">Page<span class="z-sr"> (opens in a new tab)</span></a></td></tr>`));
}

function setUp(d, custom) {
  const ttl = esc(String(d.orderTtlHours || 24));
  const endpoints = `<dl class="zb-set-rows">${Object.entries(d.endpoints).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="z-mono">${esc(v)}</dd></div>`).join("")}</dl>`;
  const limits = custom
    ? `Limits, plainly: the buyer pays after placing the order, so stock is held while it waits. Unpaid orders stay “payment pending” for ${ttl} hours and are yours to cancel. Refunds are made by you from Zold, and a payment that arrives after ${ttl} hours lands on your payment page without its order, so you mark that order paid yourself.`
    : "Limits, plainly: bank transfer isn’t offered at checkout (too slow for a session), refunds are made by you from Zold, and manual capture isn’t supported.";
  const steps = custom
    ? `<p class="desc">Three steps in Shopify, in this order. The app asks for: <span class="z-mono">${esc(d.scopes || "")}</span>.</p>
      <ol class="zb-steps">
        <li><b>Payment method.</b> Settings, Payments, Manual payment methods, Create custom payment method. Name it so it contains “<b>${esc(d.manualGateway || "zold")}</b>”: that’s how Zold recognises its orders. Keep the store’s checkout currency to euros; other orders are ignored.</li>
        <li><b>Connect the store</b> above. Zold subscribes to the store’s new and cancelled orders itself.</li>
        <li><b>Thank-you page</b> (recommended). Install the Zold checkout extension from the <span class="z-mono">shopify-app/</span> project and add its block to the Thank you and Order status pages, pointing at this deployment. Without it, put the pay link in the order confirmation email.</li>
      </ol>${endpoints}`
    : `<p class="desc">Paste these into the app’s payments extension. Currency: euros. Payment method type: offsite.</p>${endpoints}`;
  return `<p class="zb-hint" style="margin-top:12px">${limits}</p>
    <details class="z-card zb-pad zb-app__setup"><summary>${custom ? "How to set up the store" : "Partner Dashboard settings"}</summary>${steps}</details>`;
}

RENDER.apps = async () => {
  const d = await api(`/api/orgs/${org.id}/shopify`);
  const custom = d.mode === "custom-app";
  return `${appCard(d, custom)}${storesTable(d)}${ordersTable(d, custom)}${setUp(d, custom)}`;
};
RENDER.shopify = RENDER.apps;
