/**
 * The renderer registry, and the views without a design/ui-v2 reference:
 * Accounts, Send, Get paid, Shopify, Wallets, Transactions, Assets, Chart of
 * accounts, the month's statement lines, Connections, Settings and the
 * invoicing profile. The reference screens are in screens.js, the invoice
 * editor in invoice.js; both register here.
 *
 * RENDER maps a view id to its body (an HTML string, or { html, bind });
 * META to its title, subtitle and header actions. A map rather than a switch,
 * so a screen is added by naming it and the shell dispatches without knowing
 * what exists. Every renderer reads the live `org` from core.js.
 */
import { $, Z, api, cap, countrySelect, day, esc, eur, gateHtml, maskIban, me, org, plain, roleCan, ymd } from "./core.js";

export const RENDER = {};
export const META = {};

const primary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--primary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const secondary = (label, attrs, icon) => `<button type="button" class="z-btn z-btn--secondary" ${attrs}>${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></button>`;
const linkBtn = (label, view, icon, variant = "secondary") => `<a class="z-btn z-btn--${variant}" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const card = (title, desc, inner, right = "") => `<section class="card"><div class="h"><div><h2>${esc(title)}</h2>${desc ? `<p class="desc">${desc}</p>` : ""}</div>${right}</div>${inner}</section>`;
const statusTag = (s) => Z.tag(s === "active" ? "Active" : s === "gated" ? "Not open" : "Waiting");

/* ==========================================================================
   Accounts
   ========================================================================== */

/** Whose IBAN it is at Monerium, from the server's read-time verdict. The
 *  "Check again" control is drawn only for a role the API would accept. */
const profileHtml = (a, mayManage) => {
  const p = a.profile;
  if (!p || p.status === "not_applicable") return "";
  if (p.status === "needs_check") {
    return `<p class="desc" style="margin-top:6px">${Z.tag("Needs a check", "amber")} ${esc(plain(p.reason))}</p>
      ${mayManage ? `<div style="margin-top:8px"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="check-profile" data-id="${esc(a.id)}">Check again</button></div>` : ""}`;
  }
  const who = p.kind === "corporate" ? "Company profile at Monerium" : "Personal profile at Monerium";
  return `<p class="desc" style="margin-top:6px">${who}${p.name ? `: <b>${esc(p.name)}</b>` : ""}</p>
    ${p.warning ? `<p class="desc" style="margin-top:6px">${Z.tag(p.name ? "Name differs" : "Name not compared", "amber")} ${esc(plain(p.warning))}</p>` : ""}`;
};

META.accounts = () => ({
  title: "Accounts",
  sub: "An account holds one currency and pays out on that currency’s own bank network.",
  actions: secondary("Open an account", 'data-act="open-account"', "add"),
});

RENDER.accounts = async () => {
  const { accounts, currencies, adoption, profileWait, mayManageAccounts } = await api(`/api/orgs/${org.id}/accounts`);
  const who = org.type === "business" ? "the company profile" : "your profile";
  const waitHtml = profileWait
    ? `<p class="desc" style="margin-top:6px">${Z.tag("Waiting for Monerium", "amber")} Monerium had ${who} as ${esc(plain(profileWait.state))} on ${esc(new Date(profileWait.at).toLocaleString())}.</p>`
    : "";
  const rows = accounts.map((a) => {
    const ident = a.identifier?.iban || a.identifier?.accountNumber || a.identifier?.mobile || "";
    const mine = a.backingUserId && me && a.backingUserId === me.id;
    return `<tr>
      <td class="zb-top"><b>${esc(a.label || a.currency)}</b><span class="zb-sub2">${esc(a.currency)}</span></td>
      <td class="zb-top z-mono" translate="no">${ident ? esc(Z.groupIban(ident)) : '<span class="z-dim">None yet</span>'}</td>
      <td class="zb-top">${statusTag(a.status)}
        ${a.gate ? `<p class="desc" style="margin-top:6px">${esc(plain(a.gate.reason))}<br>Needs: ${esc(plain(a.gate.needs))}</p>` : ""}
        ${!a.backingUserId && a.currency === "EUR" ? waitHtml : ""}
        ${a.backingUserId ? `<p class="desc" style="margin-top:6px">${mine ? "Spends from your own account" : "Spends from a member’s own account"}</p>` : ""}
        ${profileHtml(a, mayManageAccounts)}</td>
      <td class="zb-top">${!a.backingUserId && a.currency === "EUR"
        ? adoption?.allowed
          ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="fund-account" data-id="${esc(a.id)}">${profileWait ? "Check with Monerium again" : org.type === "business" ? "Connect the company’s IBAN" : "Fund from my account"}</button>`
          : adoption?.reason ? `<p class="desc">${esc(plain(adoption.reason))}</p>` : ""
        : ""}</td></tr>`;
  });
  const cur = currencies.map((c) => `<tr>
      <td class="zb-top"><b>${esc(c.code)}</b><span class="zb-sub2">${esc(plain(c.name))}</span></td>
      <td class="zb-top">${esc(plain(c.railName))}<span class="zb-sub2">${esc(c.provider === "none" ? "No provider yet" : c.provider)}</span></td>
      <td class="zb-top">${c.token
        ? `<span class="z-mono">${esc(plain(c.token.symbol))}</span> ${Z.tag(c.token.heldByUs ? "Held" : "Not held")}
           <p class="desc" style="margin-top:6px">${esc(plain(c.token.issuer))}. ${esc(plain(c.token.backing))}</p>
           ${c.token.liquidityNote ? `<p class="desc" style="margin-top:6px">${esc(plain(c.token.liquidityNote))}</p>` : ""}`
        : '<span class="z-dim">None</span>'}</td>
      <td class="zb-top">${c.available ? Z.tag("Available on Zold", "mint") : `${Z.tag("Soon")}<p class="desc" style="margin-top:6px">${esc(plain(c.needs))}</p>`}</td></tr>`);
  return `${accounts.length
      ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Account</th><th scope="col">IBAN</th><th scope="col">Status</th><th scope="col"><span class="z-sr">Actions</span></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">No accounts yet.</p></div>`}
    <h2 class="zb-h2" style="margin:28px 0 6px">Currencies</h2>
    <p class="zb-hint" style="margin-bottom:12px">Which currencies Zold supports, for every organisation. Whether your own account in one is open is shown in the table above.</p>
    <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Currency</th><th scope="col">Network</th><th scope="col">Settles in</th><th scope="col">Status</th></tr></thead><tbody>${cur.join("")}</tbody></table></div>`;
};

/* ==========================================================================
   Send: a new payment run
   ========================================================================== */

export const sendState = { contactId: null };

META.send = () => ({
  title: "New payment",
  sub: cap("transfers.approvals").allowed
    ? "It goes to Approvals: someone other than you approves it, then it’s sent with Face ID or fingerprint."
    : "Save it, then send it from Payments with Face ID or fingerprint.",
  actions: "",
});

RENDER.send = async () => {
  if (!cap("transfers.drafts").allowed) return gateHtml("transfers.drafts");
  if (!roleCan(org.role, "propose")) return `<div class="gate"><h3>Not for your role</h3><p>As a viewer you can see payments, not propose them.</p></div>`;
  const [{ contacts }, { accounts }] = await Promise.all([
    api(`/api/orgs/${org.id}/contacts`),
    api(`/api/orgs/${org.id}/accounts`),
  ]);
  const payable = contacts.filter((c) => c.bankAccounts.some((b) => b.iban));
  const fundable = accounts.filter((a) => a.status === "active" && a.backingUserId && a.profile?.status !== "needs_check");
  if (!fundable.length) {
    return `<div class="gate"><h3>No account can pay yet</h3><p>${org.type === "business"
      ? "Connect the company’s Monerium profile to an account first."
      : "Open an account and fund it from your own account first."}</p><div class="zb-actions">${linkBtn("Accounts", "accounts")}</div></div>`;
  }
  if (!payable.length) {
    return `<div class="gate"><h3>Add who you’re paying</h3><p>A payment goes to a contact with bank details, so a later change to them is caught before sending.</p><div class="zb-actions">${primary("Add contact", 'data-act="new-contact"', "person_add")}</div></div>`;
  }
  const chosen = payable.find((c) => c.id === sendState.contactId) || null;
  return `<form class="z-card zb-pad" id="send-form" style="max-width:560px" novalidate>
      <label for="d-acct">From</label><select id="d-acct" name="account">${fundable.map((a) => `<option value="${esc(a.id)}">${esc(a.label || a.currency)} (${esc(maskIban(a.identifier?.iban || ""))})</option>`).join("")}</select>
      <label for="d-con">To</label><select id="d-con" name="contact">${payable.map((c) => `<option value="${esc(c.id)}"${chosen?.id === c.id ? " selected" : ""}>${esc(c.name)} (${esc(maskIban(c.bankAccounts.find((b) => b.iban).iban))})</option>`).join("")}</select>
      <label for="d-amt">Amount in euros</label><input id="d-amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="250.00…" />
      <label for="d-note">Reference <span class="desc">(on their bank statement)</span></label><input id="d-note" name="reference" autocomplete="off" maxlength="140" placeholder="Invoice 2026-114…" />
      <p class="zb-err" id="send-err" role="alert"></p>
      <div class="zb-actions">${primary(cap("transfers.approvals").allowed ? "Submit for approval" : "Save payment", 'data-act="send-create"', "")}${linkBtn("Cancel", "payments")}</div>
    </form>`;
};

/* ==========================================================================
   Get paid
   ========================================================================== */

META["get-paid"] = () => ({
  title: "Get paid",
  sub: "Your bank details, invoices and a shop checkout.",
  actions: cap("invoices").allowed ? primary("Issue invoice", 'data-act="issue-invoice"', "receipt_long") : "",
});

RENDER["get-paid"] = async () => {
  const { accounts } = await api(`/api/orgs/${org.id}/accounts`);
  const live = accounts.filter((a) => a.status === "active" && a.identifier?.iban);
  const holder = org.legalName || org.name;
  const details = live.length
    ? `<div class="zb-grid2">${live.map((a) => `<section class="z-card zb-pad zb-stack" style="gap:12px" aria-label="${esc(a.label || a.currency)}">
        <h2 class="zb-h2">${esc(a.label || a.currency)}</h2>
        <ul class="z-list z-card">
          <li>${Z.copyRow({ label: "Account holder", value: holder })}</li>
          <li>${Z.copyRow({ label: "IBAN", value: String(a.identifier.iban).replace(/\s+/g, ""), display: Z.groupIban(a.identifier.iban), mono: true })}</li>
          ${a.identifier.bic ? `<li>${Z.copyRow({ label: "BIC", value: a.identifier.bic, mono: true })}</li>` : ""}
        </ul></section>`).join("")}</div>`
    : `<div class="z-card"><p class="empty">No account has an IBAN yet. ${linkBtn("Accounts", "accounts")}</p></div>`;
  const way = (icon, title, sub, v, tag = "") => `<li><a class="z-row" href="?view=${v}" data-view-link="${v}">${Z.iconTile({ icon })}<span class="z-row__main"><span class="z-row__title">${esc(title)}</span><span class="z-row__sub">${esc(sub)}</span></span>${tag ? `<span class="z-row__right">${tag}</span>` : ""}${Z.icon("chevron_right", "z-row__chev")}</a></li>`;
  const ways = [
    cap("invoices").allowed ? way("receipt_long", "Invoices", "Issue one, or ask a supplier for theirs with a link", "invoices") : "",
    way("storefront", "Shopify", "Customers pay an order in digital dollars (USDC)", "shopify", Z.tag("Beta")),
  ].join("");
  return `<h2 class="zb-h2" style="margin-bottom:12px">Bank details</h2>${details}
    <h2 class="zb-h2" style="margin:28px 0 12px">Other ways</h2><ul class="z-list z-card">${ways}</ul>`;
};

/* ==========================================================================
   Shopify: Zold as a payment method on a merchant's store.
   Crypto only, sale only, refunds by hand: every one of those limits is
   printed here rather than discovered by a customer at checkout.
   ========================================================================== */

META.shopify = () => ({ title: "Shopify", sub: "Customers pay an order in digital dollars (USDC).", actions: Z.tag("Beta") });

RENDER.shopify = async () => {
  const d = await api(`/api/orgs/${org.id}/shopify`);
  const custom = d.mode === "custom-app";
  let html = card("How it works", custom
    ? `Your store offers a manual payment method named <b>${esc(d.manualGateway || "Zold")}</b>. When a customer places an order with it, Zold opens a payment in digital dollars (USDC) for the order total, shows it on the thank-you page (with the Zold extension installed) or by link, and marks the order paid in Shopify once the money arrives. The order exists before the money does: unpaid orders stay “payment pending” for ${esc(String(d.orderTtlHours || 24))} hours and are yours to cancel.`
    : "Customers pay a euro order in digital dollars (USDC) on your payment page, and the order is marked paid once the money arrives. Bank transfer isn’t offered at checkout (too slow for a session), refunds are made by you from Zold, and manual capture isn’t supported.",
  d.available
    ? `<form class="zb-form" onsubmit="return false"><label for="sh-shop">Store address</label>
        <div style="display:flex;gap:10px"><input id="sh-shop" name="shop" autocomplete="off" spellcheck="false" placeholder="my-store.myshopify.com…" style="flex:1" />
        <button type="button" class="z-btn z-btn--primary" data-act="shopify-connect">Connect store</button></div>
        <p class="desc" style="margin-top:8px">You approve the app at Shopify. The store’s access key is stored encrypted and never shown.${custom ? " Connecting subscribes Zold to the store’s new orders." : ""}</p></form>`
    : `<div class="banner warn">${Z.icon("info")}<span><b>Not available here.</b> ${esc(plain(d.reason || ""))} ${custom
        ? "A Shopify app has to be created in a Partner account, and its key set on this deployment."
        : "A Shopify payments app has to be approved into Shopify’s Payments Apps program first. Nobody has done that yet."}</span></div>`);
  html += card("Connected stores", "", d.connections.length
    ? `<table><thead><tr><th>Store</th><th>Pays into</th><th>Status</th><th>Installed</th><th></th></tr></thead><tbody>${d.connections.map((c) => `<tr>
        <td><b>${esc(c.shop)}</b></td><td class="mono">@${esc(c.payeeHandle || "")}</td>
        <td>${c.ready ? Z.tag("Active") : `${Z.tag("Needs setup", "amber")}${c.configureError ? `<p class="desc">${esc(plain(c.configureError))}</p>` : ""}`}</td>
        <td class="desc">${esc(day(c.installedAt))}${c.lastSessionAt ? `<br>last order ${esc(day(c.lastSessionAt))}` : ""}</td>
        <td><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="shopify-disconnect" data-id="${esc(c.id)}">Disconnect</button></td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">No store connected.</p>`);
  html += card(custom ? "Orders" : "Checkouts", custom ? "Every order a connected store sent with the Zold method." : "Every payment a connected store started.", d.requests.length
    ? `<table><thead><tr><th>When</th><th>Store</th><th class="num">Amount</th><th>Status</th><th>Shopify told</th><th></th></tr></thead><tbody>${d.requests.map((r) => `<tr>
        <td class="desc">${esc(day(r.createdAt))}${r.test ? ` ${Z.tag("Test", "amber")}` : ""}</td>
        <td>${esc(r.shop)}${r.orderName ? `<div class="mono">${esc(r.orderName)}</div>` : ""}</td>
        <td class="num">${esc(eur(r.amountEur ?? 0))}${r.payments?.length ? `<div class="desc">${r.payments.map((p) => `${esc(String(p.amountUsdc ?? ""))} USDC${p.settledEur !== undefined ? ` → ${esc(eur(p.settledEur))}` : " (kept as USDC)"}`).join("<br>")}</div>` : ""}</td>
        <td>${Z.tag(r.state === "PAID" ? "Paid" : r.state === "OPEN" ? "Open" : r.state.toLowerCase())}</td>
        <td>${r.resolvedAt ? Z.tag("Done") : r.state === "PAID" ? `${Z.tag("Not yet", "amber")}${r.resolveError ? `<p class="desc">${esc(plain(r.resolveError))}</p>` : ""}` : '<span class="desc">Not yet</span>'}</td>
        <td><a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Page<span class="z-sr"> (opens in a new tab)</span></a></td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">${custom ? "No orders yet." : "No checkouts yet."}</p>`);
  const endpoints = `<table><tbody>${Object.entries(d.endpoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  html += custom
    ? card("Set up the store", `Three steps in Shopify, in this order. The app asks for: <span class="mono">${esc(d.scopes || "")}</span>.`,
      `<ol class="zb-steps">
        <li><b>Payment method.</b> Settings, Payments, Manual payment methods, Create custom payment method. Name it so it contains “<b>${esc(d.manualGateway || "zold")}</b>”: that’s how Zold recognises its orders. Keep the store’s checkout currency to euros; other orders are ignored.</li>
        <li><b>Connect the store</b> above. Zold subscribes to the store’s new and cancelled orders itself.</li>
        <li><b>Thank-you page</b> (recommended). Install the Zold checkout extension from the <span class="mono">shopify-app/</span> project and add its block to the Thank you and Order status pages, pointing at this deployment. Without it, put the pay link in the order confirmation email.</li>
      </ol>${endpoints}
      <p class="desc" style="margin-top:12px">Limits, plainly: the buyer pays after placing the order, so stock is held while it waits; refunds are made by you from Zold; a payment that arrives after ${esc(String(d.orderTtlHours || 24))} hours lands on your payment page without its order, and you mark the order paid yourself.</p>`)
    : card("Partner Dashboard settings", "Paste these into the app’s payments extension. Currency: euros. Payment method type: offsite.", endpoints);
  return html;
};

/* ==========================================================================
   Books: wallets, transactions, assets, chart of accounts, statement lines
   ========================================================================== */

const booksBack = () => linkBtn("Books", "books", "arrow_back");

META.wallets = () => ({ title: "Imported wallets", sub: "Addresses you want counted in your books. Read only: Zold never holds a key for one.", actions: `${booksBack()}${secondary("Import wallet", 'data-act="import-wallet"', "add")}` });
RENDER.wallets = async () => {
  const { wallets } = await api(`/api/orgs/${org.id}/wallets`);
  return wallets.length
    ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Label</th><th scope="col">Address</th><th scope="col">Network</th><th scope="col"><span class="z-sr">Actions</span></th></tr></thead><tbody>${wallets.map((w) => `<tr>
        <td>${esc(w.label)}<span class="zb-sub2">${esc(w.kind.toUpperCase())}</span></td><td class="z-mono" translate="no">${esc(w.address)}</td><td>${esc(String(w.chainId))}</td>
        <td><div class="zb-cellact"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="del-wallet" data-id="${esc(w.id)}">Remove<span class="z-sr">: ${esc(w.label)}</span></button></div></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="z-card"><p class="empty">No wallets imported.</p></div>`;
};

META.ledger = () => ({ title: "Every transaction", sub: "Every movement across your accounts and imported wallets.", actions: `${booksBack()}${cap("export.ledger").allowed ? secondary("Download CSV", 'data-act="export-ledger"', "download") : ""}` });
RENDER.ledger = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const { entries } = await api(`/api/orgs/${org.id}/ledger`);
  return entries.length
    ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Currency</th><th scope="col">Category</th><th scope="col">Tags</th><th scope="col" class="z-tbl__num">Amount</th></tr></thead><tbody>${entries.map((e) => `<tr>
        <td class="z-dim">${esc(day(e.at))}</td><td>${esc(e.asset === "EURe" ? "Euros" : e.asset)}</td><td>${esc(e.accountCode || "None")}</td><td class="z-dim">${esc(e.tags.join(", ") || "None")}</td>
        <td class="z-tbl__num"><span class="z-amount${e.direction === "in" ? " z-amount--in" : ""}">${e.direction === "in" ? "+" : "−"}${esc(e.amount)}</span></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="z-card"><p class="empty">Nothing yet. Transactions appear once money moves or a wallet syncs.</p></div>`;
};

META.assets = () => ({ title: "Assets and tax lots", sub: "First in, first out: the only cost-basis method built.", actions: booksBack() });
RENDER.assets = async () => {
  if (!cap("assets.costBasis").allowed) return gateHtml("assets.costBasis");
  const d = await api(`/api/orgs/${org.id}/assets`);
  return `${d.positions.length
      ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Asset</th><th scope="col" class="z-tbl__num">Held</th><th scope="col" class="z-tbl__num">Cost basis</th><th scope="col" class="z-tbl__num">Realised</th></tr></thead><tbody>${d.positions.map((p) => `<tr>
          <td>${esc(p.asset === "EURe" ? "Euros" : p.asset)}</td><td class="z-tbl__num">${p.quantity.toFixed(6)}</td><td class="z-tbl__num">${p.costBasis.toFixed(2)}</td>
          <td class="z-tbl__num"><span class="z-amount${p.realised >= 0 ? " z-amount--in" : ""}">${p.realised >= 0 ? "" : "−"}${Math.abs(p.realised).toFixed(2)}</span></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">No positions yet.</p></div>`}
    ${d.shortfalls?.length ? `<div class="banner warn" style="margin-top:16px">${Z.icon("warning")}<span>${d.shortfalls.length} disposal${d.shortfalls.length === 1 ? " has" : "s have"} no matching purchase. They’re reported rather than booked at zero cost, which would overstate income.</span></div>` : ""}`;
};

META.coa = () => ({ title: "Chart of accounts", sub: "Your categories, and the rules that sort transactions into them.", actions: `${booksBack()}${secondary("Add a category", 'data-act="new-coa"', "add")}` });
RENDER.coa = async () => {
  if (!cap("coa.manage").allowed) return gateHtml("coa.manage");
  const { accounts, rules } = await api(`/api/orgs/${org.id}/chart-of-accounts`);
  return `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Type</th></tr></thead><tbody>${accounts.map((a) => `<tr><td class="z-mono">${esc(a.code)}</td><td>${esc(plain(a.name))}</td><td>${Z.tag(a.type)}</td></tr>`).join("")}</tbody></table></div>
    <div class="zb-bar" style="margin:28px 0 12px"><div><h2 class="zb-h2">Rules</h2><p class="zb-hint">Most specific wins: contact, then wallet and currency, then the transaction type. Running them again never overwrites a category you set by hand.</p></div>${secondary("Run the rules again", 'data-act="apply-rules"', "refresh")}</div>
    ${rules.length ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Scope</th><th scope="col">Match</th><th scope="col">Direction</th><th scope="col">Category</th></tr></thead><tbody>${rules.map((r) => `<tr><td>${Z.tag(r.scope)}</td><td class="z-dim">${esc(JSON.stringify(r.match).replace(/[{}"]/g, ""))}</td><td>${esc(r.direction)}</td><td class="z-mono">${esc(r.accountCode)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="z-card"><p class="empty">No rules yet.</p></div>`}`;
};

/**
 * The accountant's month: one line per economic event, a Beleg per line, the
 * Lexware CSV and the ZIP. Figures from a conversion carry the rule-2 label
 * until a swap has moved real money.
 */
const EVENT_LABEL = {
  sepa_in: "Bank transfer in", sepa_out: "Bank transfer out", sepa_out_reversal: "Returned transfer",
  crypto_converted: "Digital dollars to euros", crypto_held: "Digital dollars kept", sweep: "Exchange difference",
};
export let exportMonth = null;
export const setExportMonth = (v) => { exportMonth = v; };

META.export = () => ({ title: "Statement lines", sub: "One line per event on the euro account, the way a PayPal or Stripe account appears in the books. Each line gets one Beleg.", actions: booksBack() });
RENDER.export = async () => {
  if (!cap("export.ledger").allowed) return gateHtml("export.ledger");
  const first = await api(`/api/orgs/${org.id}/bookkeeping/statement`);
  const months = first.months.length ? first.months : [new Date().toISOString().slice(0, 7)];
  if (!exportMonth || !months.includes(exportMonth)) setExportMonth(months[0]);
  const d = await api(`/api/orgs/${org.id}/bookkeeping/statement?month=${encodeURIComponent(exportMonth)}`);
  const integrations = cap("integrations.accounting").allowed
    ? (await api(`/api/orgs/${org.id}/integrations`).catch(() => null))?.integrations : null;
  const withBeleg = d.lines.filter((l) => l.documentCode).length;
  const dis = withBeleg ? "" : " disabled";
  return `${d.swapsHaveExecuted ? "" : `<div class="banner warn">${Z.icon("science")}<span>${esc(plain(d.note || ""))}</span></div>`}
    <div class="zb-bar"><div style="display:flex;align-items:center;gap:10px"><label for="x-month" style="margin:0">Month</label>
      <select id="x-month" style="width:auto">${months.map((m) => `<option ${m === exportMonth ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
      <div class="row-actions">
        <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="export-rebuild">Rebuild lines</button>
        <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="export-prepare">Issue Belege for ${esc(exportMonth)}</button>
        <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="export-csv"${dis}>Lexware CSV</button>
        <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="export-zip"${dis}>Belege as ZIP</button>
        ${integrations?.getmyinvoices?.connected ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="gmi-push"${dis}>Send Belege to GetMyInvoices</button>` : ""}
      </div></div>
    <p class="zb-hint" style="margin-bottom:12px">${d.lines.length} line${d.lines.length === 1 ? "" : "s"}, ${withBeleg} with a Beleg.${integrations && !integrations.getmyinvoices?.connected ? ` <a href="?view=integrations" data-view-link="integrations">Connect GetMyInvoices</a> to send the Belege there.` : ""}</p>
    ${d.lines.length ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Value date</th><th scope="col">Event</th><th scope="col">Who</th><th scope="col">Reference</th><th scope="col" class="z-tbl__num">Euros</th><th scope="col">Beleg</th></tr></thead><tbody>${d.lines.map((l) => `<tr>
        <td class="zb-top z-dim">${esc(day(ymd(l.valueDate)))}${l.bookingDate !== l.valueDate ? `<span class="zb-sub2">booked ${esc(day(ymd(l.bookingDate)))}</span>` : ""}</td>
        <td class="zb-top">${esc(EVENT_LABEL[l.event] || l.event)}${l.unexecuted ? ` ${Z.tag("Unproven", "amber")}` : ""}</td>
        <td class="zb-top">${esc(l.counterparty?.name || "")}<span class="zb-sub2 z-mono">${esc(l.counterparty?.iban ? maskIban(l.counterparty.iban) : l.counterparty?.address ? `${l.counterparty.address.slice(0, 10)}…` : "")}</span></td>
        <td class="zb-top">${esc(l.reference)}${l.links?.invoiceNumber ? `<span class="zb-sub2">Invoice ${esc(l.links.invoiceNumber)}</span>` : ""}</td>
        <td class="zb-top z-tbl__num">${Z.amount({ value: Math.abs(l.amountCents) / 100, direction: l.amountCents >= 0 ? "in" : "out" })}</td>
        <td class="zb-top">${l.documentCode ? `<a class="zb-beleg" href="${esc(l.documentUrl)}" target="_blank" rel="noopener">${Z.icon("attach_file")}${esc(l.documentCode)}<span class="z-sr"> (opens in a new tab)</span></a>` : `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="line-beleg" data-line="${esc(l.id)}">Issue</button>`}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">No statement lines in ${esc(exportMonth)}. Lines appear once money moves on an account backed by a member’s own account.</p></div>`}`;
};

/* ==========================================================================
   Connections
   ========================================================================== */

META.integrations = () => ({ title: "Connections", sub: "Get your books into the software your accountant already uses.", actions: booksBack() });

RENDER.integrations = async () => {
  if (!cap("integrations.accounting").allowed) return gateHtml("integrations.accounting");
  const r = await api(`/api/orgs/${org.id}/integrations`);
  const g = r.integrations.getmyinvoices;
  const conn = (logo, title, sub, tag, text, act) => `<section class="z-card zb-conn" aria-label="${esc(title)}">
      <div class="zb-conn__head"><span class="zb-conn__logo" aria-hidden="true">${esc(logo)}</span><span class="z-row__main"><span class="z-row__title">${esc(title)}</span><span class="z-row__sub">${esc(sub)}</span></span>${tag}</div>
      <p>${text}</p><div class="zb-actions">${act}</div></section>`;
  const gmi = g.connected
    ? conn("GMI", "GetMyInvoices", `Connected to ${g.accountName || "your account"}${g.accountEmail ? ` (${g.accountEmail})` : ""} since ${day(g.connectedAt)}`, Z.tag("Beta"),
      "Every Beleg of a month goes up as a paid document, numbered with its Beleg code. Sending twice uploads nothing twice. Your accountant takes it from there.",
      `${linkBtn("Send a month’s Belege", "export", "upload")}${secondary("Remove key", 'data-act="gmi-disconnect"')}`)
    : conn("GMI", "GetMyInvoices", "API key · sends Belege each month", Z.tag("Beta"),
      "Every Beleg of a month goes up as a paid document, numbered with its Beleg code. Sending twice uploads nothing twice. Your accountant takes it from there.",
      r.available ? primary("Connect", 'data-act="gmi-drawer"', "link") : `<p class="desc">Not available here: ${esc(plain(g.needs || ""))}.</p>`);
  return `<div class="zb-grid2">
      ${gmi}
      ${conn("LO", "Lexware Office", "CSV import", "", "Download the month’s bank lines as a Lexware CSV and import them as an offline account.", linkBtn("Download from Books", "books", "download"))}
      ${conn("sev", "sevDesk", "Not built yet", Z.tag("Soon"), "Until it’s built, use the Lexware CSV and the Belege ZIP from Books. sevDesk imports both.", linkBtn("CSV and ZIP", "books", "folder_zip"))}
      ${conn("DATEV", "DATEV", "Not built yet", Z.tag("Soon"), "Your tax adviser can take the Belege ZIP for now.", linkBtn("Exports", "books", "download"))}
    </div>
    <div class="zb-notes"><div class="zb-note">${Z.icon("person")}<span>Or give your accountant read-only access as a member with the Accountant role. They can export on their own.</span>${cap("members.manage").allowed ? linkBtn("Members", "members") : ""}</div></div>`;
};

/* ==========================================================================
   Settings
   ========================================================================== */

META.settings = () => ({ title: "Settings", sub: `${org.name}, on the ${org.effectivePlan.charAt(0).toUpperCase()}${org.effectivePlan.slice(1)} plan${org.effectivePlan !== org.plan ? " (trial)" : ""}.`, actions: "" });

RENDER.settings = async () => {
  const plan = await api(`/api/orgs/${org.id}/plan`);
  const reporting = cap("settings.reportingCurrency").allowed;
  const owner = org.role === "owner";
  const plans = plan.available.map((p) => {
    const current = p.id === org.effectivePlan;
    // There is no billing: a paid plan comes by trial or by asking Zold.
    const free = p.price === "Free";
    const act = p.id === org.plan ? Z.tag("Current")
      : current ? Z.tag("On trial")
        : free && owner ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="upgrade" data-plan="${esc(p.id)}">Switch to ${esc(p.name)}</button>`
          : free ? "" : '<span class="desc">By trial, or ask Zold</span>';
    return `<div class="zb-plan${current ? " is-current" : ""}"><div class="zb-plan__head"><b>${esc(p.name)}</b><span class="desc">${esc(p.price)}</span></div><p>${esc(p.blurb)}</p><div>${act}</div></div>`;
  }).join("");
  return `<form class="card" id="org-form" onsubmit="return false"><div class="h"><div><h2>Organisation</h2><p class="desc">Printed on every invoice you issue. The country decides which invoicing rules apply.</p></div>
      <button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="save-org">Save</button></div>
      <div class="grid g2">
        <div><label for="s-name">Name</label><input id="s-name" name="organization" autocomplete="organization" value="${esc(org.name)}" /></div>
        <div><label for="s-legal">Legal name</label><input id="s-legal" name="legal" autocomplete="off" value="${esc(org.legalName || "")}" /></div>
      </div>
      <label for="s-addr1">Registered address</label>
      <input id="s-addr1" name="address-line1" autocomplete="address-line1" value="${esc(org.address?.line1 || "")}" placeholder="Street and number…" />
      <label for="s-addr2" class="z-sr">Address line 2</label>
      <input id="s-addr2" name="address-line2" autocomplete="address-line2" value="${esc(org.address?.line2 || "")}" placeholder="Address line 2 (optional)…" style="margin-top:8px" />
      <div style="display:grid;grid-template-columns:140px 1fr 200px;gap:12px">
        <div><label for="s-zip">Postcode</label><input id="s-zip" name="postal-code" autocomplete="postal-code" spellcheck="false" value="${esc(org.address?.postalCode || "")}" /></div>
        <div><label for="s-city">City</label><input id="s-city" name="city" autocomplete="address-level2" value="${esc(org.address?.city || "")}" /></div>
        <div><label for="s-country">Country</label>${countrySelect("s-country", org.address?.country)}</div>
      </div>
      <div class="grid g2">
        <div><label for="s-tax">Tax ID</label><input id="s-tax" name="tax" autocomplete="off" value="${esc(org.taxId || "")}" /></div>
        <div><label for="s-notify">Notification email</label><input id="s-notify" name="email" type="email" autocomplete="email" spellcheck="false" value="${esc(org.notificationEmail || "")}" /></div>
      </div>
      <label for="s-currency">Reporting currency${reporting ? "" : ' <span class="desc">(in a paid plan)</span>'}</label>
      <input id="s-currency" name="currency" autocomplete="off" value="${esc(org.reporting.currency)}" style="max-width:140px"${reporting ? "" : " disabled"} />
    </form>
    ${cap("invoices").allowed ? `<section class="card"><div class="h"><div><h2>Invoicing profile</h2><p class="desc">Your tax numbers, bank details and number series, set once for every invoice.</p></div>${linkBtn("Open", "invoicing-settings")}</div></section>` : ""}
    ${cap("integrations.accounting").allowed ? `<section class="card"><div class="h"><div><h2>Connections</h2><p class="desc">GetMyInvoices, Lexware, sevDesk and DATEV.</p></div>${linkBtn("Open", "integrations")}</div></section>` : ""}
    <section class="card"><div class="h"><div><h2>Plan</h2><p class="desc">Zold takes no payments yet: a paid plan comes with the trial, or Zold grants it. Switching down pauses features and deletes nothing.</p></div>
      ${plan.trialAvailable && owner ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="trial">Start the ${plan.trialDays}-day trial</button>` : ""}</div>
      <div class="grid g3">${plans}</div></section>`;
};

/* ==========================================================================
   The invoicing profile
   Two rules from the tax code shape this screen:
    - Only optional blocks can be toggled. Everything § 14 UStG requires is
      always rendered; if a mandatory field could be switched off, the
      customer would lose their input-tax deduction.
    - Charging VAT or not is an either/or with a reason attached, never a rate
      box that can be zeroed. Showing tax you do not owe makes you liable for
      it (§ 14c UStG).
   ========================================================================== */

/**
 * What rules apply and how far we check them. "statutory": we encoded the
 * paragraphs; "directive": only the EU baseline; "structural": no tax law.
 * Rendered wherever an invoice is issued so `ok` is not over-read.
 */
export function jurisdictionBanner(j, disclaimer, notVerified) {
  const what = {
    statutory: ["Rules encoded to statute", "Active"],
    directive: ["EU baseline only: national rules aren’t encoded", "Beta"],
    structural: ["No tax rules applied: structural checks only", "Waiting"],
  }[j.verification] || [j.verification, "Draft"];
  return `<details class="card zb-juris"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;list-style:none">
      <span><b>${esc(j.countryName)}</b> <span class="desc">${esc(what[0])}</span></span>${Z.icon("expand_more")}</summary>
    <p class="desc" style="margin:10px 0">${esc(plain(j.basis))} ${esc(plain(disclaimer))}</p>
    <p class="z-eyebrow" style="margin:10px 0 6px">Not checked by Zold</p>
    <ul class="desc" style="margin:0 0 0 18px">${(notVerified ?? []).map((x) => `<li>${esc(plain(x))}</li>`).join("")}</ul></details>`;
}

/* Which IBAN invoices print, and whether payments to it are matched. Only the
   org account's own IBAN is one Zold sees money arrive on. */
function bankNote(set, account) {
  const same = (a, b) => String(a || "").replace(/\s+/g, "").toUpperCase() === String(b || "").replace(/\s+/g, "").toUpperCase();
  if (!account) {
    return `<p class="desc" style="margin-top:-4px">${set
      ? "No Zold account with an IBAN yet, so payments to this IBAN are not matched to invoices automatically."
      : "Empty: invoices print no bank details until your Zold account has an IBAN or you enter one."}</p>`;
  }
  if (!set) return `<p class="desc" style="margin-top:-4px">Empty: invoices show your Zold account’s IBAN, ${esc(Z.groupIban(account.iban))}. Payments to it mark invoices paid.</p>`;
  if (same(set, account.iban)) return `<p class="desc" style="margin-top:-4px">Your Zold account’s IBAN. Payments to it mark invoices paid.</p>`;
  return `<p class="desc" style="margin-top:-4px">${Z.tag("Not matched", "amber")} This is not your Zold account’s IBAN (${esc(Z.groupIban(account.iban))}). Zold doesn’t see payments to it, so invoices paid there have to be marked paid by hand. Clear the field to use the Zold account.</p>`;
}

META["invoicing-settings"] = () => ({ title: "Invoicing profile", sub: "Set once, filled in on every invoice.", actions: `${linkBtn("Invoices", "invoices", "arrow_back")}<button type="button" class="z-btn z-btn--primary" data-act="save-invoicing">Save</button>` });

RENDER["invoicing-settings"] = async () => {
  const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
  const p = d.profile, iss = d.issuer, ref = d.reference, j = d.jurisdiction;
  const on = (k) => (p.display?.[k] !== false ? "checked" : "");
  const f = (id, label, value, extra = "") => `<label for="${id}">${label}</label><input id="${id}" name="${id}" autocomplete="off" value="${esc(value ?? "")}" ${extra} />`;
  const sug = d.suggested || {};
  const de = j.ruleSet === "DE";
  return jurisdictionBanner(j, d.disclaimer, d.notVerified) + `
  ${card(org.type === "business" ? "Your company" : "You", "Printed at the top of every invoice. The country decides which invoicing rules apply.",
    `<div class="grid g2"><div>
        ${f("i-legal", org.type === "business" ? "Registered name" : "Name on invoices", org.legalName || sug.name || org.name,)}
        ${!org.legalName && sug.source === "monerium" ? '<p class="desc" style="margin-top:6px">Filled in from your Monerium profile. Check it matches the register, then save.</p>' : ""}
        <label for="i-country">Country</label>${countrySelect("i-country", org.address?.country)}
      </div><div>
        ${f("i-addr1", "Street and number", org.address?.line1, 'placeholder="Gartenstraße 11…"')}
        ${f("i-addr2", "Address line 2 (optional)", org.address?.line2)}
        <div style="display:grid;grid-template-columns:120px 1fr;gap:12px">
          <div>${f("i-zip", "Postcode", org.address?.postalCode, 'spellcheck="false"')}</div>
          <div>${f("i-city", "City", org.address?.city)}</div>
        </div>
      </div></div>`)}
  ${card("Your details on an invoice", esc(j.ruleSet === "DE"
      ? "§ 14 Abs. 4 UStG requires your full name, address and either a Steuernummer or a USt-IdNr. on every invoice."
      : j.ruleSet === "EU"
        ? "Art. 226 of the VAT Directive requires your full name, address and VAT number on every invoice."
        : `Almost every country requires your full name, address and a tax number on an invoice. Zold doesn’t know which one ${j.countryName} wants: add it as your own rule if these don’t fit.`),
    `<div class="grid g2"><div>
        ${f("i-vatid", de ? "USt-IdNr." : "VAT ID", p.vatId, 'placeholder="DE123456789…"')}
        ${f("i-taxno", de ? "Steuernummer" : "Tax number", p.taxNumber, 'placeholder="123/456/78901…"')}
        <label for="i-rate">Usual VAT rate</label>
        ${ref.vatRates
          ? `<select id="i-rate" name="i-rate">${ref.vatRates.map((r) => `<option value="${r}" ${p.defaultVatRate === r ? "selected" : ""}>${r} %</option>`).join("")}</select>`
          : `<input id="i-rate" name="i-rate" type="number" min="0" max="100" step="0.1" value="${esc(p.defaultVatRate ?? "")}" placeholder="23…" />
             <p class="desc" style="margin-top:6px">Zold keeps no rate table for ${esc(j.countryName)}, so it won’t guess. Set the rate you charge.</p>`}
        <label class="zb-check"><input type="checkbox" id="i-klein" ${p.smallBusiness ? "checked" : ""} />
          <span><b>${j.ruleSet === "DE" ? "Kleinunternehmer (§ 19 UStG)" : "Small business scheme"}</b>New invoices don’t charge VAT, and charging it is refused.${j.ruleSet === "DE" ? " The § 19 note is printed." : " You supply the note your country requires."}</span></label>
      </div><div>
        ${f("i-terms-days", "Days to pay", p.paymentTermsDays, 'type="number" min="0" inputmode="numeric"')}
        ${f("i-terms", "Payment terms note", p.paymentTermsNote, 'placeholder="Zahlbar innerhalb von 14 Tagen ohne Abzug…"')}
        <label for="i-prefix">Invoice number series</label>
        <div style="display:flex;gap:8px"><input id="i-prefix" name="i-prefix" autocomplete="off" value="${esc(p.numberSeries.prefix)}" placeholder="RE-{YYYY}-…" />
          <label for="i-next" class="z-sr">Next number</label><input id="i-next" name="i-next" autocomplete="off" type="number" min="1" inputmode="numeric" value="${esc(p.numberSeries.next)}" style="width:110px" /></div>
        <p class="desc" style="margin-top:6px">Next: <b>${esc(p.numberSeries.prefix.replace("{YYYY}", new Date().getFullYear()))}${String(p.numberSeries.next).padStart(p.numberSeries.padding, "0")}</b>. A number is used once; it doesn’t have to be gapless${esc(j.ruleSet === "DE" ? " (§ 14 Abs. 4 Nr. 4 UStG)" : j.ruleSet === "EU" ? " (Art. 226(2) VAT Directive)" : "")}.</p>
      </div></div>`)}
  ${card("Bank details and footer", "Shown on the invoice when the matching block is switched on below.",
    `<div class="grid g2"><div>
        ${f("i-bank-holder", "Account holder", p.bank?.holder, d.accountBank ? `placeholder="${esc(d.accountBank.holder)}…"` : "")}
        ${f("i-bank-iban", "IBAN", p.bank?.iban, `spellcheck="false"${d.accountBank ? ` placeholder="${esc(Z.groupIban(d.accountBank.iban))}…"` : ""}`)}
        ${bankNote(p.bank?.iban, d.accountBank)}
        ${f("i-bank-bic", "BIC", p.bank?.bic, 'spellcheck="false"')}
      </div><div>
        ${f("i-court", de ? "Amtsgericht" : "Register court", p.registerCourt, 'placeholder="Amtsgericht Kassel…"')}
        ${f("i-reg", de ? "Registernummer" : "Register number", p.registerNumber, 'placeholder="HRB 12345…"')}
        ${f("i-gf", de ? "Geschäftsführer" : "Managing director", p.managingDirector)}
      </div></div>
      ${f("i-footer", "Footer note", p.footerNote)}`)}
  ${card("What appears on the invoice", "Optional blocks only. Everything § 14 UStG requires is always printed: a switch that can produce an invalid invoice is worse than no switch.",
    `<div class="grid g3">${ref.displayOptions.map((k) => `<label class="zb-check" style="margin:4px 0"><input type="checkbox" data-display="${esc(k)}" ${on(k)} /><span style="color:var(--z-text)">${esc(k.replace(/([A-Z])/g, " $1").toLowerCase())}</span></label>`).join("")}</div>`)}
  ${card("Your own rules", `For anything ${esc(j.countryName)} requires that Zold doesn’t encode. The note you write is printed on the invoice word for word; Zold doesn’t check it.`,
    (p.customReasons ?? []).length
      ? `<table><thead><tr><th>Id</th><th>Label</th><th>Printed note</th><th></th></tr></thead><tbody>${p.customReasons.map((c) => `<tr>
          <td class="mono">${esc(c.id)}</td><td>${esc(c.label)}${c.legalBasis ? `<p class="desc">${esc(c.legalBasis)}</p>` : ""}</td><td class="desc">${esc(c.invoiceNote)}</td>
          <td><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="del-custom-reason" data-id="${esc(c.id)}">Remove</button></td></tr>`).join("")}</tbody></table>`
      : `<p class="empty">No rules of your own.${j.ruleSet === "GENERIC" ? " You’ll probably need some: Zold applies no tax rules here." : ""}</p>`,
    secondary("Add rule", 'data-act="add-custom-reason"', "add"))}`;
};

/* ==========================================================================
   Pieces the screens share
   ========================================================================== */

/* What can be done with an invoice, by state. An issued one still open gets a
   payment link. For an incoming one, "Pay" only appears
   when the supplier gave an IBAN: a wallet-only invoice says so instead of
   offering a button that the API would refuse. */
export function invoiceActions(i) {
  if (i.direction === "outgoing") {
    return i.state === "SUBMITTED"
      ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="invoice-pay-link" data-id="${esc(i.id)}">Payment link</button>`
      : "";
  }
  if (i.state === "SUBMITTED") {
    if (i.payTo?.kind === "bank" && i.payTo.bank?.iban) return `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="pay-invoice" data-id="${esc(i.id)}">Pay</button>`;
    return `<span class="desc">${i.payTo?.kind === "wallet" ? "Wallet only: ask for an IBAN" : "No bank details given"}</span>
      <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="reconcile-invoice" data-id="${esc(i.id)}">Mark paid</button>`;
  }
  if (i.state === "PAYING") return `<span class="desc">${i.payment?.transferId ? "Sent, waiting for the bank" : "In Approvals"}</span>`;
  if (i.state === "PAID") return `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="reconcile-invoice" data-id="${esc(i.id)}">Reconcile</button>`;
  return "";
}

/**
 * How an invoice was actually paid, for the books. Every figure here is one
 * recorded at the time it happened, not recomputed: the wallet transaction,
 * the euro value at receipt with the rate and whose feed it came from, the
 * conversion with the venue's rate against the mid, and the spread. An asset
 * still held shows a receipt and no conversion, which is the true position.
 * Shown to the ORG only; the supplier's view of an invoice is a separate
 * allowlist and none of this is in it.
 */
export function settlementRows(list) {
  if (!list?.length) return "";
  const n = (v, d = 2) => (v === undefined || v === null ? "unknown" : Number(v).toFixed(d));
  const tx = (h) => (h ? `<span class="mono" title="${esc(h)}">${esc(h.slice(0, 10))}…${esc(h.slice(-6))}</span>` : "none");
  return `<section class="card"><h2>How it was paid</h2>
    <p class="desc">Recorded when it happened. These are the figures your accountant books, not recalculated from today’s rates.</p>
    ${list.map((p) => p.method === "bank" ? `
      <div class="issue">${Z.tag("Bank")}<div>
        <div>${esc(eur(p.amountEur))} from ${esc(p.counterpartyName || "a payer without a name")}</div>
        <p class="desc">${esc(p.counterpartyIban ? maskIban(p.counterpartyIban) : "No IBAN given")}${p.memo ? ` · “${esc(p.memo)}”` : ""}</p>
        <p class="desc">Matched on ${esc(p.matchedOn === "payment-link" ? "the payment link code" : "the invoice number")} · ${esc(day(p.at))}</p>
      </div></div>` : `
      <div class="issue">${Z.tag(p.receivedAsset || "Crypto")}<div>
        <div>${esc(n(p.receivedAmount, 6))} ${esc(p.receivedAsset)} received · ${tx(p.receiptTxHash)}</div>
        <p class="desc">Worth ${esc(eur(p.receiptAmountEur))} when it arrived${p.receiptRate ? ` · 1 EUR = ${esc(n(p.receiptRate, 4))} USD` : ""}${p.receiptRateProvider ? ` · ${esc(p.receiptRateProvider)}` : ""}</p>
        ${p.conversion ? `<p class="desc">Converted at ${esc(n(p.conversion.rate, 4))}${p.conversion.midRate ? ` against a mid of ${esc(n(p.conversion.midRate, 4))}` : ""}${p.conversion.spreadEur === undefined ? "" : ` · spread ${esc(eur(p.conversion.spreadEur))}`}</p>
          <p class="desc">Credited ${esc(eur(p.conversion.creditedEur))}${p.realisedGainEur === undefined ? " · gain not measurable, so none is claimed" : ` · realised ${p.realisedGainEur >= 0 ? "gain" : "loss"} ${esc(eur(Math.abs(p.realisedGainEur)))}`}</p>`
          : `<p class="desc">Still held as ${esc(p.receivedAsset)}: bought, not yet sold, so there is no gain to report yet.</p>`}
      </div></div>`).join("")}
    <p class="desc" style="margin-top:10px">Network fees aren’t taken from what you receive, so they aren’t shown as a cost here.</p></section>`;
}
