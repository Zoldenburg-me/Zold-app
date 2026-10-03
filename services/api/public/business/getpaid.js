/**
 * Get paid (design canvas "Desk-GetPaid"): the organisation's bank details,
 * its payment links, its public payment page, and the other ways in.
 *
 * A payment link pays into the Safe of the member whose account backs the
 * euro account, so only that member can make one (the API answers
 * NOT_THE_PAYEE to anyone else). Everyone else sees the button switched off
 * with that reason beside it, not a button that fails.
 */
import { $, Z, api, cap, day, esc, eur, me, org, view } from "./core.js";
import { META, RENDER } from "./views.js";

const MAKES_LINKS = new Set(["owner", "admin", "payer"]); // invoices.manage
const EDITS_PAGE = new Set(["owner", "admin"]); // org.update
const TABS = [["open", "Open"], ["paid", "Paid"], ["all", "All"]];
const DAY_MS = 86400000;

const gp = { tab: "open" };

/** Why this person cannot make a link, or "" when they can. */
function linkBlock(accounts) {
  if (!MAKES_LINKS.has(org.role)) return "";
  const backed = accounts.filter((a) => a.backingUserId && a.status === "active");
  if (!backed.length) return "The euro account isn’t open yet, so a link has nowhere to pay into.";
  if (backed.some((a) => a.backingUserId === me?.id)) return "";
  const who = backed[0].backingMemberName || "the member whose account it is";
  return `Only ${who} can make payment links: a link pays into their own account, which backs ${org.name}’s euro account.`;
}

function headerActions(block) {
  const invoice = cap("invoices").allowed
    ? `<button type="button" class="z-btn z-btn--secondary" data-act="issue-invoice">${Z.icon("receipt_long")}<span>Issue invoice</span></button>`
    : "";
  if (!MAKES_LINKS.has(org.role)) return invoice;
  const link = block
    ? `<button type="button" class="z-btn z-btn--secondary" disabled aria-describedby="gp-why">${Z.icon("add_link")}<span>New payment link</span></button>`
    : `<button type="button" class="z-btn z-btn--primary" data-act="new-pay-link">${Z.icon("add_link")}<span>New payment link</span></button>`;
  return link + invoice;
}

META["get-paid"] = () => ({ title: "Get paid", sub: "Your bank details, payment links and your payment page.", actions: "" });

function bankCards(accounts) {
  const live = accounts.filter((a) => a.status === "active" && a.identifier?.iban);
  if (!live.length) return `<div class="z-card"><p class="empty">No account has an IBAN yet. <a href="?view=accounts" data-view-link="accounts">Accounts</a></p></div>`;
  const holder = org.legalName || org.name;
  return `<div class="zb-grid2">${live.map((a) => `<section class="z-card zb-pad zb-stack" style="gap:12px" aria-label="${esc(a.label || a.currency)}">
      <h3 class="zb-h3">${esc(a.label || a.currency)}</h3>
      <ul class="z-list z-card">
        <li>${Z.copyRow({ label: "Account holder", value: holder })}</li>
        <li>${Z.copyRow({ label: "IBAN", value: String(a.identifier.iban).replace(/\s+/g, ""), display: Z.groupIban(a.identifier.iban), mono: true })}</li>
        ${a.identifier.bic ? `<li>${Z.copyRow({ label: "BIC", value: a.identifier.bic, mono: true })}</li>` : ""}
      </ul></section>`).join("")}</div>
    <p class="zb-hint" style="margin-top:10px">Monerium issues ${live.length === 1 ? "this IBAN" : "these IBANs"}. Money sent to ${live.length === 1 ? "it" : "one"} arrives as euros on that account.</p>`;
}

function linkTitle(r) {
  if (r.description) return r.description;
  if (r.externalInvoiceNumber) return `Invoice ${r.externalInvoiceNumber}`;
  return r.invoiceId ? "Invoice" : "Payment link";
}

function linkWhen(r) {
  if (r.state === "PAID") return `Paid ${day(r.paidAt || r.updatedAt)}`;
  if (r.state === "CANCELLED") return `Cancelled ${day(r.cancelledAt || r.updatedAt)}`;
  if (r.state === "EXPIRED") return `Ended ${day(r.expiresAt)}`;
  const days = Math.ceil((Date.parse(r.expiresAt) - Date.now()) / DAY_MS);
  return days <= 1 ? "Ends today" : `Ends in ${days} days`;
}

/* Z.tag picks the tone from the word (SYSTEM.md, "Status words"). */
const STATE_WORD = { OPEN: "Open", PAID: "Paid", EXPIRED: "Ended", CANCELLED: "Cancelled" };

function linksSection(links, block) {
  const shown = links.filter((r) => gp.tab === "all" || (gp.tab === "open" ? r.state === "OPEN" : r.state === "PAID"));
  const tabs = TABS.map(([id, text]) => `<button type="button" class="zb-h-chip" data-gt="${id}" aria-pressed="${gp.tab === id}">${text}</button>`).join("");
  const row = (r) => {
    const amount = typeof r.amountEur === "number" ? eur(r.amountEur) : "Any amount";
    const copy = r.state === "OPEN"
      ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="copy-text" data-text="${esc(r.url)}" data-said="Link copied">Copy link<span class="z-sr">: ${esc(linkTitle(r))}</span></button>`
      : "";
    return `<tr><td>${Z.icon("link", "z-dim")} <b>${esc(linkTitle(r))}</b></td><td class="z-dim">${esc(linkWhen(r))}</td>
      <td>${Z.tag(STATE_WORD[r.state] || r.state)}</td><td class="num">${esc(amount)}</td><td class="num">${copy}</td></tr>`;
  };
  const empty = gp.tab === "open" ? "No open links." : gp.tab === "paid" ? "No link has been paid yet." : "No payment links yet.";
  return `<div class="zb-side-card__head"><h2 class="zb-h2" id="gp-links-h">Payment links</h2><div class="zb-h-chips" role="group" aria-label="Show">${tabs}</div></div>
    ${block ? `<p class="zb-hint" id="gp-why" style="margin-bottom:10px">${esc(block)}</p>` : ""}
    ${shown.length
      ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">For</th><th scope="col">When</th><th scope="col">Status</th><th scope="col" class="num">Amount</th><th scope="col"><span class="z-sr">Actions</span></th></tr></thead><tbody>${shown.map(row).join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">${empty}</p></div>`}
    <p class="zb-hint" style="margin-top:10px">Share a link yourself. Zold sends no emails.</p>`;
}

function pageCard(page) {
  const mayEdit = EDITS_PAGE.has(org.role);
  if (!page) return "";
  const p = page.paymentPage;
  if (!p) {
    const body = !mayEdit
      ? "An owner or admin can set up a public page that shows this company’s bank details."
      : page.ready
        ? "A public page with this company’s name and bank details, for customers paying by bank transfer."
        : page.reason;
    const btn = mayEdit && page.ready ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" data-act="org-page">${Z.icon("add")}<span>Set up the page</span></button></div>` : "";
    return `<section class="z-card zb-pad zb-stack" style="gap:10px" aria-labelledby="gp-page-h"><h2 class="zb-h2" id="gp-page-h">Your payment page</h2><p class="desc">${esc(body)}</p>${btn}</section>`;
  }
  const name = p.displayName || org.legalName || org.name;
  const url = `${location.origin}${page.payUrl}`;
  return `<section class="z-card zb-pad zb-stack" style="gap:12px" aria-labelledby="gp-page-h">
      <h2 class="zb-h2" id="gp-page-h">Your payment page</h2>
      <div class="z-row">${Z.avatar({ name, tone: "p" })}<span class="z-row__main"><span class="z-row__title">${esc(name)}</span><span class="z-row__sub z-mono">${esc(url.replace(/^https?:\/\//, ""))}</span></span></div>
      <p class="desc">${page.ready
        ? "Anyone with this link can pay you by bank transfer. They see the company’s name and bank details, never a balance."
        : esc(page.reason)}</p>
      <div class="zb-actions">
        <button type="button" class="z-btn z-btn--secondary" data-act="copy-text" data-text="${esc(url)}" data-said="Link copied">${Z.icon("content_copy")}<span>Copy link</span></button>
        <a class="z-btn z-btn--secondary" href="${esc(page.payUrl)}" target="_blank" rel="noopener">${Z.icon("open_in_new")}<span>Open</span></a>
        ${mayEdit ? `<button type="button" class="z-btn z-btn--secondary" data-act="org-page">${Z.icon("tune")}<span>Edit page</span></button>` : ""}
      </div></section>`;
}

function otherWays(invoices) {
  const way = (icon, title, sub, v) => `<li><a class="z-row" href="?view=${v}" data-view-link="${v}">${Z.iconTile({ icon })}<span class="z-row__main"><span class="z-row__title">${esc(title)}</span><span class="z-row__sub">${esc(sub)}</span></span>${Z.icon("chevron_right", "z-row__chev")}</a></li>`;
  let invSub = "Issue one, or ask a supplier for theirs with a link";
  if (invoices) {
    const open = invoices.filter((i) => i.direction === "outgoing" && !["PAID", "RECONCILED", "DELETED"].includes(i.state));
    const late = open.filter((i) => i.overdue);
    if (open.length) invSub = `${open.length} open${late.length ? ` · ${late.length} overdue` : ""}`;
  }
  return `<h2 class="zb-h2" style="margin:28px 0 12px">Other ways</h2><ul class="z-list z-card">
    ${cap("invoices").allowed ? way("receipt_long", "Invoices", invSub, "invoices") : ""}
    ${way("storefront", "Shopify checkout", "In Apps", "apps")}</ul>`;
}

RENDER["get-paid"] = async () => {
  const [acc, links, page, inv] = await Promise.allSettled([
    api(`/api/orgs/${org.id}/accounts`),
    api(`/api/orgs/${org.id}/payment-requests`),
    api(`/api/orgs/${org.id}/payment-page`),
    cap("invoices").allowed ? api(`/api/orgs/${org.id}/invoices`) : Promise.resolve(null),
  ]);
  if (acc.status === "rejected") throw acc.reason;
  const accounts = acc.value.accounts;
  const list = links.status === "fulfilled" ? links.value.paymentRequests : null;
  const block = linkBlock(accounts);
  if (view === "get-paid") $("#view-actions").innerHTML = headerActions(block);

  const html = `<div id="gp-root"><h2 class="zb-h2" style="margin-bottom:12px">Bank details</h2>${bankCards(accounts)}
    <div class="zb-gp-split">
      <section class="zb-h-section" id="gp-links" aria-labelledby="gp-links-h">${list
        ? linksSection(list, block)
        : `<h2 class="zb-h2" id="gp-links-h">Payment links</h2><div class="z-card"><p class="empty">Payment links couldn’t load. Open Get paid again to retry.</p></div>`}</section>
      <div>${pageCard(page.status === "fulfilled" ? page.value : null)}</div>
    </div>
    ${otherWays(inv.status === "fulfilled" ? inv.value?.invoices : null)}</div>`;

  return {
    html,
    bind(box) {
      box.querySelector("#gp-root").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-gt]");
        if (!b || !list) return;
        gp.tab = b.dataset.gt;
        box.querySelector("#gp-links").innerHTML = linksSection(list, block);
        box.querySelector(`[data-gt="${gp.tab}"]`)?.focus();
      });
    },
  };
};
