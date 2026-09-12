/**
 * One renderer per screen, keyed by view id, plus the invoice editor.
 *
 * RENDER is a map rather than a switch so a screen is added by naming it, and
 * so the shell can dispatch without knowing what exists. Every renderer reads
 * the live `org` from core.js and writes only the DOM.
 */
import { $, api, cap, esc, fmtEur, gateHtml, org, orgs, toast, token, view } from "./core.js";
import { render } from "./shell.js";


// ── views ──────────────────────────────────────────────────────────────────

export const RENDER = {};

RENDER.overview = async () => {
  const { accounts, currencies } = await api(`/api/orgs/${org.id}/accounts`);
  const open = accounts.filter((a) => a.status === "active");
  const live = currencies.filter((c) => c.available).map((c) => c.code);

  let html = `<div class="grid g3" style="margin-bottom:1rem">
    <div class="stat"><div class="k">Accounts</div><div class="v">${accounts.length}</div>
      <div class="n">${open.length} open, ${accounts.length - open.length} waiting on a partner</div></div>
    <div class="stat"><div class="k">Plan</div><div class="v" style="text-transform:capitalize">${esc(org.effectivePlan)}</div>
      <div class="n">${org.effectivePlan !== org.plan ? "on trial" : esc(org.type) + " organisation"}</div></div>
    <div class="stat"><div class="k">Live rails</div><div class="v">${live.length}</div>
      <div class="n">${live.join(", ") || "none configured"}</div></div>
  </div>`;

  html += cap("dashboard.insights").allowed
    ? `<div class="card"><div class="h"><div><h2>Recent activity</h2>
        <div class="desc">Profit and loss, top assets and recent transactions.</div></div></div>
        <div class="empty">No transactions yet. They appear here once money moves or a wallet syncs.</div></div>`
    : gateHtml("dashboard.insights");
  return html;
};

RENDER.accounts = async () => {
  const { accounts, currencies } = await api(`/api/orgs/${org.id}/accounts`);
  let html = `<div class="card"><div class="h"><div><h2>Your accounts</h2>
    <div class="desc">An account holds one currency and pays out on that currency's local rail.</div></div>
    <button data-act="open-account">Open an account</button></div>`;

  html += accounts.length ? `<table><thead><tr>
      <th>Currency</th><th>Identifier</th><th>Status</th><th>Provider</th></tr></thead><tbody>` +
    accounts.map((a) => {
      const ident = a.identifier?.iban || a.identifier?.accountNumber || a.identifier?.mobile || "—";
      const pill = a.status === "active" ? "ok" : a.status === "gated" ? "mut" : "warn";
      return `<tr>
        <td><b>${esc(a.currency)}</b><div class="desc">${esc(a.label)}</div></td>
        <td class="mono">${esc(ident)}</td>
        <td><span class="pill ${pill}">${esc(a.status)}</span>
          ${a.gate ? `<div class="desc" style="margin-top:.35rem">${esc(a.gate.reason)}<br>
            <span style="color:var(--faint)">Needs: ${esc(a.gate.needs)}</span></div>` : ""}
          ${a.backingUserId ? `<div class="desc" style="margin-top:.3rem">Funded from your account</div>` : ""}</td>
        <td>${esc(a.provider || "—")}
          ${!a.backingUserId && a.currency === "EUR"
            ? `<div style="margin-top:.4rem"><button class="ghost sm" data-act="fund-account"
                 data-id="${esc(a.id)}">Fund from my account</button></div>` : ""}</td></tr>`;
    }).join("") + `</tbody></table>`
    : `<div class="empty">No accounts yet.</div>`;
  html += `</div>`;

  html += `<div class="card"><div class="h"><div><h2>Currencies</h2>
    <div class="desc">What each rail needs before it can open. Nothing here is simulated.</div></div></div>
    <table><thead><tr><th>Currency</th><th>Rail</th><th>Settlement token</th><th>Status</th></tr></thead><tbody>` +
    currencies.map((c) => `<tr>
      <td><b>${esc(c.code)}</b> <span class="desc">${esc(c.name)}</span></td>
      <td>${esc(c.railName)} <span class="desc">· ${esc(c.provider === "none" ? "no provider identified" : c.provider)}</span></td>
      <td>${c.token
        ? `<b class="mono">${esc(c.token.symbol)}</b>
           <span class="pill mut">${c.token.heldByUs ? "held" : "not held"}</span>
           <div class="desc" style="margin-top:.3rem">${esc(c.token.issuer)}</div>
           <div class="desc" style="margin-top:.3rem">${esc(c.token.backing)}</div>
           ${c.token.liquidityNote ? `<div class="desc" style="margin-top:.3rem">${esc(c.token.liquidityNote)}</div>` : ""}
           <div class="desc mono" style="margin-top:.3rem">${Object.entries(c.token.contracts)
             .map(([ch, a]) => `${esc(ch)} ${esc(a.slice(0, 10))}…${esc(a.slice(-4))}`).join("<br>")}</div>`
        : `<span class="desc">—</span>`}</td>
      <td>${c.available
        ? `<span class="pill ok">live</span>`
        : `<span class="pill mut">not open</span><div class="desc" style="margin-top:.3rem">${esc(c.needs)}</div>`}</td>
    </tr>`).join("") + `</tbody></table>
    <div class="desc" style="margin-top:.7rem">A settlement token existing is not the same as an
    account being open. Where a token is listed and the rail is not, the token is real and we hold
    none of it — the Status column says what is still missing.</div></div>`;
  return html;
};

RENDER.contacts = async () => {
  const { contacts } = await api(`/api/orgs/${org.id}/contacts`);
  return `<div class="card"><div class="h"><div><h2>Address book</h2>
    <div class="desc">A contact holds wallets and bank details. Payouts read from here.</div></div>
    <button data-act="new-contact">Add contact</button></div>` +
    (contacts.length ? `<table><thead><tr><th>Name</th><th>Wallets</th><th>Bank accounts</th><th></th></tr></thead><tbody>` +
      contacts.map((c) => `<tr>
        <td><b>${esc(c.name)}</b>${c.email ? `<div class="desc">${esc(c.email)}</div>` : ""}</td>
        <td class="mono">${c.wallets.map((w) => esc(w.address.slice(0, 10) + "…")).join("<br>") || "—"}</td>
        <td class="mono">${c.bankAccounts.map((b) =>
          `${esc(b.currency)} ${esc(b.iban || b.accountNumber || b.mobile || "")}`).join("<br>") || "—"}</td>
        <td class="row-actions"><button class="ghost sm" data-act="del-contact" data-id="${esc(c.id)}">Delete</button></td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No contacts yet.</div>`) + `</div>`;
};

RENDER.wallets = async () => {
  const { wallets } = await api(`/api/orgs/${org.id}/wallets`);
  return `<div class="banner info">Imported wallets are <b>read-only</b>. We never hold a key for one —
    balances and bookkeeping only, and any payment from it is built here and signed by you.</div>
    <div class="card"><div class="h"><div><h2>Imported wallets</h2>
    <div class="desc">EOA, MPC or Safe addresses you want counted in the treasury.</div></div>
    <button data-act="import-wallet">Import wallet</button></div>` +
    (wallets.length ? `<table><thead><tr><th>Label</th><th>Address</th><th>Chain</th><th>Custody</th><th></th></tr></thead><tbody>` +
      wallets.map((w) => `<tr>
        <td><b>${esc(w.label)}</b><div class="desc">${esc(w.kind.toUpperCase())}</div></td>
        <td class="mono">${esc(w.address)}</td>
        <td>${esc(w.chainId)}</td>
        <td><span class="pill mut">external</span></td>
        <td><button class="ghost sm" data-act="del-wallet" data-id="${esc(w.id)}">Remove</button></td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No wallets imported.</div>`) + `</div>`;
};

RENDER.payments = async () => {
  const { drafts } = await api(`/api/orgs/${org.id}/drafts`);
  const approvals = cap("transfers.approvals").allowed;
  let html = "";
  if (!approvals) html += gateHtml("transfers.approvals");
  html += `<div class="card"><div class="h"><div><h2>Payments</h2>
    <div class="desc">Draft, review, then send. A payment whose recipient changed is held, not retargeted.</div></div>
    <button data-act="new-draft">New draft</button></div>` +
    (drafts.length ? `<table><thead><tr><th>State</th><th>Lines</th><th>Total</th><th></th></tr></thead><tbody>` +
      drafts.map((d) => {
        const pill = d.state === "INVALID_DATA" ? "bad" : d.state === "REVIEWED" ? "ok"
          : d.state === "PENDING_REVIEW" ? "warn" : "mut";
        return `<tr>
          <td><span class="pill ${pill}">${esc(d.state)}</span>
            ${d.state === "INVALID_DATA" ? `<div class="desc" style="margin-top:.3rem">
              A recipient changed after this was saved. Re-point the flagged lines.</div>` : ""}</td>
          <td>${d.lines.length}<div class="desc">${esc(d.lines.map((l) => l.destination.displayName).join(", ").slice(0, 60))}</div></td>
          <td class="mono">${Object.entries(d.totals || {}).map(([a, v]) => `${esc(v)} ${esc(a)}`).join("<br>")}</td>
          <td class="row-actions">
            ${d.state === "DRAFT" ? `<button class="sm" data-act="submit-draft" data-id="${esc(d.id)}">Submit</button>` : ""}
            ${d.state === "PENDING_REVIEW" ? `<button class="sm" data-act="review-draft" data-id="${esc(d.id)}">Review</button>` : ""}
            ${d.state === "REVIEWED" ? `<button class="sm" data-act="exec-draft" data-id="${esc(d.id)}">Send</button>` : ""}
          </td></tr>`;
      }).join("") + `</tbody></table>`
      : `<div class="empty">No drafts.</div>`) + `</div>`;
  return html;
};

/* What can be done with an incoming invoice, by state. "Pay" only appears when
   the supplier gave an IBAN: a wallet-only invoice says so instead of offering
   a button that the API would refuse. */
export function invoiceActions(i) {
  if (i.direction === "outgoing") return "";
  if (i.state === "SUBMITTED") {
    if (i.payTo?.kind === "bank" && i.payTo.bank?.iban) return `<button class="sm" data-act="pay-invoice" data-id="${esc(i.id)}">Pay</button>`;
    return `<span class="desc">${i.payTo?.kind === "wallet" ? "wallet only — ask for an IBAN" : "no bank details given"}</span>
      <button class="ghost sm" data-act="reconcile-invoice" data-id="${esc(i.id)}">Mark paid elsewhere</button>`;
  }
  if (i.state === "PAYING") return `<span class="desc">payment drafted${i.payment?.transferId ? " · awaiting settlement" : " · awaiting review and signature"}</span>`;
  if (i.state === "PAID") return `<button class="ghost sm" data-act="reconcile-invoice" data-id="${esc(i.id)}">Reconcile</button>`;
  return "";
}

RENDER.invoices = async () => {
  if (!cap("invoices").allowed) return gateHtml("invoices");
  const { invoices } = await api(`/api/orgs/${org.id}/invoices`);
  return `<div class="card"><div class="h"><div><h2>Issue an invoice</h2>
    <div class="desc">A document you send a customer. Your details are filled in from your invoicing
      profile, and it is checked against your country's rules before it can be issued.</div></div>
    <div class="row-actions">
      <button data-act="issue-invoice">New invoice</button>
      <button class="ghost" data-act="invoicing-settings">Invoicing profile</button>
    </div></div></div>

    <div class="card"><div class="h"><div><h2>Request an invoice</h2>
    <div class="desc">Send a one-time link. Your supplier fills it in with no account and no wallet.</div></div>
    <button class="ghost" data-act="new-invoice">Create invoice link</button></div>` +
    (invoices.length ? `<table><thead><tr><th>State</th><th>Supplier</th><th>Total</th><th>Due</th><th></th></tr></thead><tbody>` +
      invoices.map((i) => `<tr>
        <td><span class="pill ${["PAID", "RECONCILED"].includes(i.state) ? "ok" : i.overdue ? "bad" : "mut"}">${esc(i.overdue && !["PAID", "RECONCILED"].includes(i.state) ? "OVERDUE" : i.state)}</span>
          <div class="desc">${i.direction === "outgoing" ? "issued by you" : "from a supplier"}</div></td>
        <td>${esc(i.issued?.recipient?.name || i.supplier?.orgName || "— not submitted yet")}
          ${i.supplier?.invoiceNumber ? `<div class="desc">#${esc(i.supplier.invoiceNumber)}</div>` : ""}</td>
        <td class="mono">${esc(i.total)} ${esc(i.currency)}</td>
        <td class="desc">${esc(i.dueDate || "—")}</td>
        <td class="row-actions">${invoiceActions(i)}</td></tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No invoices yet.</div>`) + `</div>`;
};

/**
 * Shopify — Zold as a payments app on the merchant's store.
 *
 * Crypto only, sale only, refunds by hand: every one of those limits is
 * printed here rather than discovered by a customer at checkout. The endpoint
 * list is what goes into the Partner Dashboard's payments-app configuration.
 */
RENDER.shopify = async () => {
  const d = await api(`/api/orgs/${org.id}/shopify`);
  const custom = d.mode === "custom-app";
  const pill = (r) => r.state === "PAID" ? "ok" : r.state === "OPEN" ? "warn" : "mut";
  let html = `<div class="card"><div class="h"><div><h2>Shopify</h2>
    <div class="desc">${custom
      ? `Your store offers a manual payment method named <b>${esc(d.manualGateway || "Zold")}</b>. When a customer places an order with it, Zold opens a crypto payment for the order total, shows it on the thank-you page (with the Zold extension installed) or by link, and marks the order paid in Shopify the moment the USDC deposit is seen. The order exists before the money does: unpaid orders stay "payment pending" for ${esc(String(d.orderTtlHours || 24))} hours and are yours to cancel.`
      : `Customers pay a EUR order in USDC on your payment page; the order is marked paid the moment the deposit is seen. Bank transfer is not offered at checkout (too slow for a session), refunds are made by you from Zold, and manual capture is not supported.`}</div></div></div>`;
  if (!d.available) {
    html += `<div class="banner warn"><b>Not available on this deployment.</b> ${esc(d.reason || "")}
      ${custom
        ? `A Shopify app (custom distribution is enough — no Shopify review) has to be created in a Partner account and its key and secret set on this deployment.`
        : `A Shopify payments app has to be registered in a Partner account and approved into Shopify's Payments Apps program before any store can install it; nobody has done that yet.`}</div>`;
  } else {
    html += `<label>Store domain</label>
      <div style="display:flex;gap:.6rem"><input id="sh-shop" placeholder="my-store.myshopify.com" style="flex:1" />
      <button data-act="shopify-connect">Connect store</button></div>
      <div class="desc" style="margin-top:.4rem">You are sent to Shopify to approve the app; the store's access token is stored encrypted and never shown.${custom ? " Connecting subscribes Zold to the store's new-order webhook." : ""}</div>`;
  }
  html += `</div>`;
  html += `<div class="card"><div class="h"><div><h2>Connected stores</h2></div></div>` +
    (d.connections.length ? `<table><thead><tr><th>Store</th><th>Pays into</th><th>Status</th><th>Installed</th><th></th></tr></thead><tbody>` +
      d.connections.map((c) => `<tr>
        <td><b>${esc(c.shop)}</b><div class="desc">${esc(c.mode)}</div></td>
        <td class="mono">@${esc(c.payeeHandle || "—")}</td>
        <td>${c.ready ? `<span class="pill ok">${c.mode === "custom-app" ? "webhook subscribed" : "ready"}</span>` : `<span class="pill warn">not configured</span>${c.configureError ? `<div class="desc">${esc(c.configureError)}</div>` : ""}`}</td>
        <td class="desc">${esc(new Date(c.installedAt).toLocaleDateString())}${c.lastSessionAt ? `<br>last order ${esc(new Date(c.lastSessionAt).toLocaleString())}` : ""}</td>
        <td class="row-actions"><button class="ghost sm" data-act="shopify-disconnect" data-id="${esc(c.id)}">Disconnect</button></td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No store connected.</div>`) + `</div>`;
  html += `<div class="card"><div class="h"><div><h2>${custom ? "Orders" : "Checkouts"}</h2><div class="desc">${custom ? `Every order a connected store sent on the Zold method. "Marked paid" means Zold pressed Mark as paid on the order in Shopify.` : `Every payment session a connected store has sent. "Told" means Shopify has marked the order paid.`}</div></div></div>` +
    (d.requests.length ? `<table><thead><tr><th>When</th><th>Store</th><th>Amount</th><th>State</th><th>${custom ? "Marked paid" : "Store told"}</th><th></th></tr></thead><tbody>` +
      d.requests.map((r) => `<tr>
        <td class="desc">${esc(new Date(r.createdAt).toLocaleString())}${r.test ? ` <span class="pill warn">test</span>` : ""}</td>
        <td>${esc(r.shop)}${r.orderName ? `<div class="mono">${esc(r.orderName)}</div>` : ""}</td>
        <td><b>€${Number(r.amountEur ?? 0).toFixed(2)}</b>${r.payments?.length ? `<div class="desc">${r.payments.map((p) => `${p.amountUsdc ?? ""} USDC${p.settledEur !== undefined ? ` → €${p.settledEur}` : " (not converted)"}`).join("<br>")}</div>` : ""}</td>
        <td><span class="pill ${pill(r)}">${esc(r.state.toLowerCase())}</span></td>
        <td>${r.resolvedAt ? `<span class="pill ok">yes</span>` : r.state === "PAID" ? `<span class="pill bad">no</span>${r.resolveError ? `<div class="desc">${esc(r.resolveError)}</div>` : ""}` : `<span class="pill mut">—</span>`}</td>
        <td class="row-actions"><a href="${esc(r.url)}" target="_blank" rel="noopener"><button class="ghost sm">Page</button></a></td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">${custom ? "No orders yet." : "No checkouts yet."}</div>`) + `</div>`;
  if (custom) {
    html += `<div class="card"><div class="h"><div><h2>Set up the store</h2><div class="desc">Three steps in Shopify, in this order. Scopes the app asks for: <span class="mono">${esc(d.scopes || "")}</span>.</div></div></div>
      <ol class="desc" style="line-height:1.7;padding-left:1.2rem">
        <li><b>Payment method.</b> Settings → Payments → Manual payment methods → Create custom payment method. Name it so that it contains "<b>${esc(d.manualGateway || "zold")}</b>" (that is how Zold recognises its orders). Restrict the store's checkout currency to EUR: a non-EUR order is ignored.</li>
        <li><b>Connect the store</b> above. Zold subscribes to the store's orders/create and orders/cancelled webhooks at the URL below; no manual webhook setup is needed.</li>
        <li><b>Thank-you page</b> (recommended). Install the Zold checkout extension from the <span class="mono">shopify-app/</span> project and add its block to the Thank you and Order status pages in the checkout editor, with its "Zold API origin" setting pointing at this deployment. Without it, add the pay link below to the order-confirmation email template instead.</li>
      </ol>
      <table><tbody>${Object.entries(d.endpoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join("")}</tbody></table>
      <div class="desc" style="margin-top:.6rem">Limits, stated plainly: the buyer pays after placing the order, so inventory is held while an order waits; refunds are made by you from Zold; a payment that arrives after ${esc(String(d.orderTtlHours || 24))} hours lands on your payment page unattributed and the order is marked paid by hand.</div></div>`;
  } else {
    html += `<div class="card"><div class="h"><div><h2>Partner Dashboard settings</h2><div class="desc">Paste these into the app's payments extension. Supported currency: EUR. Payment method type: offsite.</div></div></div>
      <table><tbody>${Object.entries(d.endpoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  return html;
};

RENDER.ledger = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const { entries } = await api(`/api/orgs/${org.id}/ledger`);
  return `<div class="card"><div class="h"><div><h2>Transactions</h2>
    <div class="desc">Every movement across your accounts and imported wallets.</div></div>
    ${cap("export.ledger").allowed ? `<button class="ghost" data-act="export-ledger">Export CSV</button>` : ""}</div>` +
    (entries.length ? `<table><thead><tr><th>Date</th><th>Asset</th><th>Amount</th><th>Account</th><th>Tags</th></tr></thead><tbody>` +
      entries.map((e) => `<tr>
        <td class="desc">${esc(e.at.slice(0, 10))}</td>
        <td>${esc(e.asset)}</td>
        <td class="mono" style="color:${e.direction === "in" ? "var(--green)" : "var(--text)"}">
          ${e.direction === "in" ? "+" : "−"}${esc(e.amount)}</td>
        <td>${esc(e.accountCode || "—")}</td>
        <td class="desc">${esc(e.tags.join(", "))}</td></tr>`).join("") + `</tbody></table>`
      : `<div class="empty">Nothing yet. Transactions appear once money moves or a wallet syncs.</div>`) + `</div>`;
};

RENDER.assets = async () => {
  if (!cap("assets.costBasis").allowed) return gateHtml("assets.costBasis");
  const d = await api(`/api/orgs/${org.id}/assets`);
  return `<div class="card"><div class="h"><div><h2>Assets and tax lots</h2>
    <div class="desc">Cost basis is ${esc(d.costBasisMethod)}. Only FIFO is implemented.</div></div></div>` +
    (d.positions.length ? `<table><thead><tr><th>Asset</th><th>Held</th><th>Cost basis</th><th>Realised</th></tr></thead><tbody>` +
      d.positions.map((p) => `<tr><td><b>${esc(p.asset)}</b></td>
        <td class="mono">${p.quantity.toFixed(6)}</td>
        <td class="mono">${p.costBasis.toFixed(2)}</td>
        <td class="mono" style="color:${p.realised >= 0 ? "var(--green)" : "var(--red)"}">${p.realised.toFixed(2)}</td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No positions yet.</div>`) +
    (d.shortfalls?.length ? `<div class="banner warn" style="margin:1rem 0 0">
      ${d.shortfalls.length} disposal(s) have no matching acquisition. They are reported rather than
      booked at zero cost, which would overstate income.</div>` : "") + `</div>`;
};

RENDER.coa = async () => {
  if (!cap("coa.manage").allowed) return gateHtml("coa.manage");
  const { accounts, rules } = await api(`/api/orgs/${org.id}/chart-of-accounts`);
  return `<div class="card"><div class="h"><div><h2>Chart of accounts</h2>
    <div class="desc">Your accounts, plus the rules that map transactions onto them.</div></div>
    <button data-act="new-coa">Add account</button></div>
    <table><thead><tr><th>Code</th><th>Name</th><th>Type</th></tr></thead><tbody>` +
    accounts.map((a) => `<tr><td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td>
      <td><span class="pill mut">${esc(a.type)}</span></td></tr>`).join("") +
    `</tbody></table></div>
    <div class="card"><div class="h"><div><h2>Account rules</h2>
      <div class="desc">Most specific wins: contact, then wallet and asset, then the transaction-type default.
      Re-running never overwrites a categorisation you set by hand.</div></div>
      <button class="ghost" data-act="apply-rules">Re-run rules</button></div>
      <table><thead><tr><th>Scope</th><th>Match</th><th>Direction</th><th>Account</th></tr></thead><tbody>` +
      rules.map((r) => `<tr><td><span class="pill mut">${esc(r.scope)}</span></td>
        <td class="desc">${esc(JSON.stringify(r.match).replace(/[{}"]/g, ""))}</td>
        <td>${esc(r.direction)}</td><td class="mono">${esc(r.accountCode)}</td></tr>`).join("") +
      `</tbody></table></div>`;
};

RENDER.members = async () => {
  if (!cap("members.manage").allowed) return gateHtml("members.manage");
  const { members } = await api(`/api/orgs/${org.id}/members`);
  return `<div class="card"><div class="h"><div><h2>Members</h2>
    <div class="desc">A role says what a person may do; the plan says what the organisation bought. Both apply.</div></div>
    <button data-act="invite">Invite</button></div>
    <table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>` +
    members.map((m) => `<tr>
      <td><b>${esc(m.name || m.email)}</b><div class="desc">${esc(m.email)}</div></td>
      <td><span class="pill mut">${esc(m.role)}</span></td>
      <td><span class="pill ${m.status === "active" ? "ok" : m.status === "invited" ? "warn" : "mut"}">${esc(m.status)}</span>
        ${m.status === "invited" && m.inviteExpiresAt ? `<div class="desc">expires ${esc(m.inviteExpiresAt.slice(0, 10))}</div>` : ""}</td>
      <td class="row-actions">${m.status === "active"
        ? `<button class="ghost sm" data-act="deactivate" data-id="${esc(m.id)}">Deactivate</button>`
        : m.status === "deactivated"
          ? `<button class="ghost sm" data-act="reactivate" data-id="${esc(m.id)}">Reactivate</button>` : ""}</td>
    </tr>`).join("") + `</tbody></table></div>`;
};

RENDER.settings = async () => {
  const plan = await api(`/api/orgs/${org.id}/plan`);
  return `<div class="card"><div class="h"><div><h2>Organisation</h2></div>
    <button data-act="save-org">Save</button></div>
    <label>Name</label><input id="s-name" value="${esc(org.name)}" />
    <label>Legal name</label><input id="s-legal" value="${esc(org.legalName || "")}" />
    <label>Registered address</label>
    <input id="s-addr1" value="${esc(org.address?.line1 || "")}" placeholder="Street and number" />
    <input id="s-addr2" value="${esc(org.address?.line2 || "")}" placeholder="Address line 2 (optional)" style="margin-top:.4rem" />
    <div style="display:flex;gap:.6rem;margin-top:.4rem">
      <div style="width:130px"><label>Postcode</label><input id="s-zip" value="${esc(org.address?.postalCode || "")}" /></div>
      <div style="flex:1"><label>City</label><input id="s-city" value="${esc(org.address?.city || "")}" /></div>
      <div style="width:90px"><label>Country</label><input id="s-country" value="${esc(org.address?.country || "")}" placeholder="DE" maxlength="2" /></div>
    </div>
    <div class="desc" style="margin-top:.3rem">Printed on every invoice you issue. The country decides which invoicing rules apply.</div>
    <label>Tax ID</label><input id="s-tax" value="${esc(org.taxId || "")}" />
    <label>Notification email</label><input id="s-notify" value="${esc(org.notificationEmail || "")}" />
    <label>Reporting currency ${cap("settings.reportingCurrency").allowed ? "" : "— included in a paid plan"}</label>
    <input id="s-currency" value="${esc(org.reporting.currency)}"
      ${cap("settings.reportingCurrency").allowed ? "" : "disabled"} />
    </div>

    <div class="card"><div class="h"><div><h2>Plan</h2>
      <div class="desc">Downgrading pauses features. Nothing is deleted, and upgrading brings it all back.</div></div></div>
      <div class="grid g2">` +
      plan.available.map((p) => `<div style="border:1px solid ${p.id === org.effectivePlan ? "var(--acc)" : "var(--border2)"};border-radius:10px;padding:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b style="font-family:var(--display)">${esc(p.name)}</b>
          <span class="pill ${p.id === org.effectivePlan ? "ok" : "mut"}">${esc(p.price)}</span></div>
        <div class="desc" style="margin:.5rem 0 .8rem">${esc(p.blurb)}</div>
        ${p.id === org.plan ? `<span class="pill mut">current</span>`
          : `<button class="sm" data-act="upgrade" data-plan="${esc(p.id)}">Choose ${esc(p.name)}</button>`}
      </div>`).join("") + `</div>
      ${plan.trialAvailable ? `<div style="margin-top:1rem"><button class="ghost" data-act="trial">
        Start the ${plan.trialDays}-day trial</button></div>` : ""}
    </div>`;
};


// ── Invoicing: profile and the issue editor ────────────────────────────────
//
// Two rules shape this screen, and both come from the tax code rather than from
// taste:
//  - You may choose which OPTIONAL blocks appear. Everything § 14 UStG requires
//    is always rendered; a settings screen that can switch off a mandatory
//    field is a trap, and it springs on the customer, who loses their
//    input-tax deduction.
//  - Charging VAT and not charging it are a single either/or with a REASON
//    attached, never a rate box you can zero out. Showing tax you do not owe
//    makes you liable for it (§ 14c UStG).

export let invoiceDraft = null;
export const setInvoiceDraft = (v) => { invoiceDraft = v; };

/**
 * What rules apply and how far we check them.
 *
 * The verification level is the honest part: "statutory" means we encoded the
 * paragraphs, "directive" means only the EU baseline and not the member state's
 * own rules, "structural" means no tax law at all. Rendered wherever an invoice
 * is issued so `ok` is never read as more than it is.
 */
export function jurisdictionBanner(j, disclaimer, notVerified) {
  const tone = { statutory: "ok", directive: "warn", structural: "bad" }[j.verification] ?? "mut";
  const what = {
    statutory: "Rules encoded to statute",
    directive: "EU baseline only — national rules not encoded",
    structural: "No tax rules applied — structural checks only",
  }[j.verification];
  return `<div class="card">
    <div class="h"><div><h2>${esc(j.countryName)}</h2>
      <div class="desc">${esc(j.basis)}</div></div>
    <span class="pill ${tone}">${esc(what)}</span></div>
    <div class="desc" style="margin-bottom:.7rem">${esc(disclaimer)}</div>
    <div style="font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); margin-bottom:.35rem">Not checked by Zold</div>
    <ul style="margin:0 0 0 1.1rem; padding:0; color:var(--muted); font-size:.82rem; line-height:1.6">
      ${(notVerified ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}
    </ul></div>`;
}

RENDER["invoicing-settings"] = async () => {
  const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
  const p = d.profile, iss = d.issuer, ref = d.reference, j = d.jurisdiction;
  const on = (k) => (p.display?.[k] !== false ? "checked" : "");
  return jurisdictionBanner(j, d.disclaimer, d.notVerified) + `

  <div class="card"><div class="h"><div><h2>Your details on an invoice</h2>
    <div class="desc">${esc(j.ruleSet === "DE"
      ? "§ 14 Abs. 4 UStG requires your full name, address and either a Steuernummer or a USt-IdNr. on every invoice."
      : j.ruleSet === "EU"
        ? "Art. 226 of the VAT Directive requires your full name, address and VAT identification number on every invoice."
        : `Almost every country requires your full name, address and a tax identifier on an invoice. Zold does not know which identifier ${j.countryName} wants — add it as a custom field if these do not fit.`)}
      Set them once and they fill in every time.</div></div>
    <button data-act="save-invoicing">Save</button></div>
    <div class="grid g2">
      <div>
        <label>USt-IdNr.</label><input id="i-vatid" value="${esc(p.vatId || "")}" placeholder="DE123456789" />
        <label>Steuernummer</label><input id="i-taxno" value="${esc(p.taxNumber || "")}" placeholder="123/456/78901" />
        <label>Default VAT rate</label>
        ${ref.vatRates
          ? `<select id="i-rate">${ref.vatRates.map((r) => `<option value="${r}" ${p.defaultVatRate === r ? "selected" : ""}>${r}%</option>`).join("")}</select>`
          : `<input id="i-rate" type="number" min="0" max="100" step="0.1" value="${esc(p.defaultVatRate ?? "")}" placeholder="e.g. 23" />
             <div class="desc" style="margin-top:.3rem">Zold does not maintain a rate table for
               ${esc(j.countryName)}, so it will not guess. Set the rate you charge.</div>`}
        <label style="display:flex; gap:.5rem; align-items:flex-start; margin-top:1rem">
          <input type="checkbox" id="i-klein" ${p.smallBusiness ? "checked" : ""} style="width:auto; margin-top:.2rem" />
          <span style="color:var(--text); font-size:.85rem; font-weight:500">${j.ruleSet === "DE" ? "Kleinunternehmer (§&nbsp;19 UStG)" : "Small business scheme"}
            <span class="desc" style="display:block; font-weight:400">New invoices will not charge VAT, and charging
              it is refused rather than allowed by mistake.${j.ruleSet === "DE" ? " The §&nbsp;19 note is printed." : " You supply the note your country requires."}</span></span>
        </label>
      </div>
      <div>
        <label>Payment terms (days)</label><input id="i-terms-days" type="number" min="0" value="${esc(p.paymentTermsDays ?? "")}" />
        <label>Payment terms note</label><input id="i-terms" value="${esc(p.paymentTermsNote || "")}" placeholder="Zahlbar innerhalb von 14 Tagen ohne Abzug." />
        <label>Invoice number series</label>
        <div style="display:flex; gap:.5rem">
          <input id="i-prefix" value="${esc(p.numberSeries.prefix)}" placeholder="RE-{YYYY}-" />
          <input id="i-next" type="number" min="1" value="${esc(p.numberSeries.next)}" style="width:110px" />
        </div>
        <div class="desc" style="margin-top:.3rem">Next: <b>${esc(p.numberSeries.prefix.replace("{YYYY}", new Date().getFullYear()))}${String(p.numberSeries.next).padStart(p.numberSeries.padding, "0")}</b>.
          A number must be used once; it does not have to be gapless${esc(j.ruleSet === "DE" ? " (§ 14 Abs. 4 Nr. 4 UStG)" : j.ruleSet === "EU" ? " (Art. 226(2) VAT Directive)" : "")}.</div>
      </div>
    </div>
  </div>

  <div class="card"><div class="h"><div><h2>Bank details and footer</h2>
    <div class="desc">Shown on the invoice when the matching block is switched on below.</div></div></div>
    <div class="grid g2">
      <div>
        <label>Account holder</label><input id="i-bank-holder" value="${esc(p.bank?.holder || "")}" />
        <label>IBAN</label><input id="i-bank-iban" value="${esc(p.bank?.iban || "")}" />
        <label>BIC</label><input id="i-bank-bic" value="${esc(p.bank?.bic || "")}" />
      </div>
      <div>
        <label>Amtsgericht</label><input id="i-court" value="${esc(p.registerCourt || "")}" placeholder="Amtsgericht Regensburg" />
        <label>Registernummer</label><input id="i-reg" value="${esc(p.registerNumber || "")}" placeholder="HRB 12345" />
        <label>Geschäftsführer</label><input id="i-gf" value="${esc(p.managingDirector || "")}" />
      </div>
    </div>
    <label>Footer note</label><input id="i-footer" value="${esc(p.footerNote || "")}" />
  </div>

  <div class="card"><div class="h"><div><h2>What appears on the invoice</h2>
    <div class="desc">Optional blocks only. Everything §&nbsp;14 UStG requires is always printed and is
      not listed here — a switch that can produce an invalid invoice is worse than no switch.</div></div></div>
    <div class="grid g3">
      ${ref.displayOptions.map((k) => `<label style="display:flex; gap:.5rem; align-items:center; margin:.3rem 0">
        <input type="checkbox" data-display="${esc(k)}" ${on(k)} style="width:auto" />
        <span style="color:var(--text); font-size:.85rem">${esc(k.replace(/([A-Z])/g, " $1").toLowerCase())}</span>
      </label>`).join("")}
    </div>
  </div>

  <div class="card"><div class="h"><div><h2>Your own rules</h2>
    <div class="desc">For anything ${esc(j.countryName)} requires that Zold does not encode. The note you
      write is printed on the invoice verbatim — we do not check it.</div></div>
    <button class="ghost sm" data-act="add-custom-reason">Add rule</button></div>
    ${(p.customReasons ?? []).length
      ? `<table><thead><tr><th>Id</th><th>Label</th><th>Printed note</th><th></th></tr></thead><tbody>
          ${p.customReasons.map((c) => `<tr>
            <td class="mono">${esc(c.id)}</td>
            <td>${esc(c.label)}${c.legalBasis ? `<div class="desc">${esc(c.legalBasis)}</div>` : ""}</td>
            <td class="desc">${esc(c.invoiceNote)}</td>
            <td><button class="ghost sm" data-act="del-custom-reason" data-id="${esc(c.id)}">Remove</button></td>
          </tr>`).join("")}
        </tbody></table>`
      : `<div class="empty">No custom rules.${j.ruleSet === "GENERIC" ? " You will probably need some — Zold applies no tax rules here." : ""}</div>`}
  </div>

  <div class="card"><div class="h"><div><h2>Prefilled from your organisation</h2></div>
    <button class="ghost sm" data-act="goto-settings">Edit</button></div>
    <table><tbody>
      ${[["Name", iss.name], ["Address", [iss.addressLine, [iss.postalCode, iss.city].filter(Boolean).join(" "), iss.country].filter(Boolean).join(", ")],
         ["USt-IdNr.", iss.vatId], ["Steuernummer", iss.taxNumber]]
        .map(([k, v]) => `<tr><td class="desc">${esc(k)}</td><td>${v ? esc(v) : `<span class="pill bad">missing</span>`}</td></tr>`).join("")}
    </tbody></table>
  </div>`;
};

RENDER["invoice-new"] = async () => {
  const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
  const { contacts } = await api(`/api/orgs/${org.id}/contacts`);
  invoiceDraft ??= {
    lines: [{ description: "", quantity: "1", unitPriceNet: "" }],
    vat: d.profile.smallBusiness
      ? { kind: "exempt", reason: d.jurisdiction.ruleSet === "DE" ? "kleinunternehmer" : "small_business_national" }
      : { kind: "standard", rate: d.profile.defaultVatRate ?? (d.jurisdiction.ruleSet === "DE" ? 19 : "") },
  };
  const v = invoiceDraft.vat;
  // Only what this jurisdiction offers, plus the org's own rules. A Swedish
  // entity must never see "§ 19 UStG".
  // Same rule as the server's basis(): a German paragraph is only quoted under
  // the German rule set, the Directive article under EU, nothing under GENERIC.
  const cite = (de, eu) =>
    d.jurisdiction.ruleSet === "DE" ? ` (${de})`
      : d.jurisdiction.ruleSet === "EU" ? ` (${eu})`
        : "";
  invoiceDraft._reasons = d.reference.exemptionReasons.map((r) => r.id);
  invoiceDraft._defaultRate = d.profile.defaultVatRate ?? (d.jurisdiction.ruleSet === "DE" ? 19 : "");
  const reasons = [
    ...d.reference.exemptionReasons,
    ...(d.reference.customReasons ?? []).map((c) => ({
      id: c.id,
      label: `${c.label} (your rule)`,
      legalBasis: c.legalBasis ?? "your own rule",
      invoiceNote: c.invoiceNote,
      hint: "You defined this rule. Zold prints your note and does not check it.",
    })),
  ];
  const today = new Date().toISOString().slice(0, 10);

  return jurisdictionBanner(d.jurisdiction, d.disclaimer, d.notVerified) + `
  <div class="card"><div class="h"><div><h2>Customer</h2>
    <div class="desc">Their full name and address are required${esc(cite("§ 14 Abs. 4 Nr. 1 UStG", "Art. 226(5) VAT Directive"))}.</div></div>
    ${contacts.length ? `<select id="inv-contact" style="max-width:240px">
      <option value="">From address book…</option>
      ${contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
    </select>` : ""}</div>
    <div class="grid g2">
      <div>
        <label>Name</label><input id="inv-r-name" value="${esc(invoiceDraft.recipient?.name || "")}" />
        <label>Street and number</label><input id="inv-r-addr" value="${esc(invoiceDraft.recipient?.addressLine || "")}" />
      </div>
      <div>
        <div style="display:flex; gap:.5rem">
          <div style="width:120px"><label>Postcode</label><input id="inv-r-zip" value="${esc(invoiceDraft.recipient?.postalCode || "")}" /></div>
          <div style="flex:1"><label>City</label><input id="inv-r-city" value="${esc(invoiceDraft.recipient?.city || "")}" /></div>
        </div>
        <div style="display:flex; gap:.5rem">
          <div style="width:120px"><label>Country</label><input id="inv-r-country" maxlength="2" value="${esc(invoiceDraft.recipient?.country || d.jurisdiction.country)}" /></div>
          <div style="flex:1"><label>VAT ID</label><input id="inv-r-vat" value="${esc(invoiceDraft.recipient?.vatId || "")}" placeholder="required for reverse charge" /></div>
        </div>
      </div>
    </div>
  </div>

  <div class="card"><div class="h"><div><h2>Dates</h2>
    <div class="desc">The date of supply is required even when it is the same day as the invoice${esc(cite("§ 14 Abs. 4 Nr. 6 UStG", "Art. 226(7) VAT Directive"))}.</div></div></div>
    <div class="grid g3">
      <div><label>Invoice date</label><input id="inv-issue" type="date" value="${esc(invoiceDraft.issueDate || today)}" /></div>
      <div><label>Date of supply</label><input id="inv-supply" type="date" value="${esc(invoiceDraft.supplyDate || today)}" /></div>
      <div><label>Purchase order (optional)</label><input id="inv-po" value="${esc(invoiceDraft.purchaseOrder || "")}" /></div>
    </div>
  </div>

  <div class="card"><div class="h"><div><h2>Lines</h2></div>
    <button class="ghost sm" data-act="inv-add-line">Add line</button></div>
    <table><thead><tr><th>Description</th><th style="width:90px">Qty</th><th style="width:130px">Unit price (net)</th><th style="width:90px"></th></tr></thead>
      <tbody id="inv-lines">
        ${invoiceDraft.lines.map((l, i) => `<tr>
          <td><input data-li="${i}" data-lf="description" value="${esc(l.description)}" /></td>
          <td><input data-li="${i}" data-lf="quantity" value="${esc(l.quantity)}" /></td>
          <td><input data-li="${i}" data-lf="unitPriceNet" value="${esc(l.unitPriceNet)}" placeholder="0.00" /></td>
          <td>${invoiceDraft.lines.length > 1 ? `<button class="ghost sm" data-act="inv-del-line" data-i="${i}">Remove</button>` : ""}</td>
        </tr>`).join("")}
      </tbody></table>
  </div>

  <div class="card"><div class="h"><div><h2>VAT</h2>
    <div class="desc">Charge it, or say why you are not. Both go on the document.</div></div></div>
    <div style="display:flex; gap:.6rem; flex-wrap:wrap; margin-bottom:.9rem">
      <button class="${v.kind === "standard" ? "" : "ghost"} sm" data-act="inv-vat-mode" data-mode="standard"
        ${d.profile.smallBusiness ? "disabled title='Kleinunternehmer — turn it off in the profile first'" : ""}>Charge VAT</button>
      <button class="${v.kind === "exempt" ? "" : "ghost"} sm" data-act="inv-vat-mode" data-mode="exempt">Do not charge VAT</button>
    </div>
    ${v.kind === "standard"
      ? (d.reference.vatRates
          ? `<label>Rate</label><select id="inv-rate">${d.reference.vatRates
              .map((r) => `<option value="${r}" ${v.rate === r ? "selected" : ""}>${r}%</option>`).join("")}</select>`
          : `<label>Rate (%)</label><input id="inv-rate" type="number" min="0" max="100" step="0.1" value="${esc(v.rate ?? "")}" />`)
      : `<label>Why not?</label>
         <select id="inv-reason">${reasons.map((r) => `<option value="${esc(r.id)}" ${v.reason === r.id ? "selected" : ""}>${esc(r.label)} — ${esc(r.legalBasis)}</option>`).join("")}</select>
         <div class="desc" style="margin-top:.4rem">${esc(reasons.find((r) => r.id === v.reason)?.hint || "")}</div>
         <div class="desc" style="margin-top:.4rem">Printed on the invoice:
           <b style="color:var(--text)">${esc(reasons.find((r) => r.id === v.reason)?.invoiceNote || "—")}</b></div>
         ${v.reason === "other"
           ? `<label>Exemption and legal basis</label><input id="inv-note" value="${esc(v.note || "")}"
                placeholder="Steuerfrei nach § 4 Nr. … UStG" />` : ""}`}
  </div>

  <div class="card" id="inv-check"><div class="desc">Checking…</div></div>

  <div class="row-actions" style="margin-bottom:2rem">
    <button data-act="inv-issue">Issue invoice</button>
    <button class="ghost" data-act="inv-cancel">Cancel</button>
  </div>`;
};

/** Read the editor's inputs back into the draft. */
export function readInvoiceEditor() {
  if (!invoiceDraft) return;
  const val = (id) => $("#" + id)?.value?.trim() ?? "";
  invoiceDraft.recipient = {
    name: val("inv-r-name"), addressLine: val("inv-r-addr"), postalCode: val("inv-r-zip"),
    city: val("inv-r-city"), country: val("inv-r-country").toUpperCase(), vatId: val("inv-r-vat"),
  };
  invoiceDraft.issueDate = val("inv-issue");
  invoiceDraft.supplyDate = val("inv-supply");
  invoiceDraft.purchaseOrder = val("inv-po");
  $("#inv-lines")?.querySelectorAll("input").forEach((el) => {
    invoiceDraft.lines[Number(el.dataset.li)][el.dataset.lf] = el.value;
  });
  if (invoiceDraft.vat.kind === "standard") {
    // No silent default: a missing rate is refused by the check, never
    // quietly read as Germany's 19.
    const rate = $("#inv-rate")?.value;
    invoiceDraft.vat.rate = rate === undefined || rate === "" ? undefined : Number(rate);
  } else {
    invoiceDraft.vat.reason = $("#inv-reason")?.value ?? invoiceDraft.vat.reason;
    invoiceDraft.vat.note = $("#inv-note")?.value ?? invoiceDraft.vat.note;
  }
}

/** Live compliance panel — the missing-field list while it can still be fixed. */
export async function refreshInvoiceCheck() {
  const box = $("#inv-check");
  if (!box || !invoiceDraft) return;
  readInvoiceEditor();
  try {
    const r = await api(`/api/orgs/${org.id}/invoicing/check`, { method: "POST", body: invoiceDraft });
    const t = r.totals;
    const rows = (list, cls) => list.map((i) => `<div class="issue">
      <span class="pill ${cls}">${cls === "bad" ? "required" : "check"}</span>
      <div><div>${esc(i.message)}</div>${i.legalBasis ? `<div class="desc">${esc(i.legalBasis)}</div>` : ""}</div></div>`).join("");
    box.innerHTML = `<div class="h"><div><h2>${r.ok ? "Ready to issue" : `${r.errors.length} thing(s) still needed`}</h2>
        <div class="desc">${esc(r.jurisdiction.countryName)} · ${esc({
          standard: r.jurisdiction.ruleSet === "DE" ? "Full § 14 UStG content"
            : r.jurisdiction.ruleSet === "EU" ? "Full Art. 226 content"
              : "Structural checks only",
          kleinbetrag: "Kleinbetragsrechnung (§ 33 UStDV, up to €250 gross)",
          kleinunternehmer: r.jurisdiction.ruleSet === "DE"
            ? "Kleinunternehmer (§ 19 UStG / § 34a UStDV)" : "Small business scheme",
        }[r.regime])}</div></div>
      <div style="text-align:right"><div class="desc">Total</div>
        <div style="font-size:1.3rem; font-weight:600">${fmtEur(t.grossCents)}</div>
        <div class="desc">net ${fmtEur(t.netCents)}${t.vatCents ? ` · VAT ${fmtEur(t.vatCents)}` : " · no VAT"}</div></div></div>
      ${rows(r.errors, "bad")}${rows(r.warnings, "warn")}
      ${r.ok && !r.warnings.length ? `<div class="desc">Every mandatory field is present.</div>` : ""}`;
  } catch (e) {
    box.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

