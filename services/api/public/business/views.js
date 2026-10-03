/**
 * The renderer registry, and the views without a module of their own:
 * Accounts, Wallets, Transactions, Assets, Chart of accounts, the month's
 * statement lines, Connections, Organisation, Plan and the invoicing profile.
 * The other screens (screens.js, home.js, getpaid.js, send.js, settings.js,
 * apps.js, invoice.js and the rest) register here.
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
        ${mine && a.currency === "EUR" && a.status === "active" ? `<p style="margin-top:6px"><a href="?view=documents" data-view-link="documents">Statements and documents</a></p>` : ""}
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
   Books: wallets, transactions, assets, chart of accounts, statement lines
   ========================================================================== */

const booksBack = () => linkBtn("Books", "books", "arrow_back");

/** What the sync has done with a wallet, in words. An error names its cause. */
const walletSyncCell = (s = {}) => {
  const skipped = s.skipped ? `<span class="zb-sub2">${esc(String(s.skipped))} transfer${s.skipped === 1 ? "" : "s"} not booked: ${esc(plain(s.lastSkipReason || ""))}</span>` : "";
  if (s.status === "error") return `${Z.tag("Not syncing", "amber")}<span class="zb-sub2">${esc(plain(s.error || ""))}</span>${skipped}`;
  if (s.status === "pending") return `<span class="z-dim">Waiting${s.from ? `, from ${esc(day(s.from))}` : ""}</span>`;
  const when = s.lastSyncedAt ? `<span class="zb-sub2">checked ${esc(day(s.lastSyncedAt))}</span>` : "";
  return `${s.status === "syncing" ? "Catching up" : "Up to date"}${when}${skipped}`;
};

/** Whether the wallet is proven to be the organisation's, in words. */
export const PROOF_WORD = { proven: "Proven", lapsed: "Proof lapsed", unproven: "Not proven", removed: "No longer imported" };
const walletProofCell = (w) => {
  const o = w.ownership;
  if (w.proofState === "proven") return `${Z.tag("Proven", "mint")}<span class="zb-sub2">checked ${esc(day(o.checkedAt))}</span>`;
  if (w.proofState === "lapsed") return `${Z.tag("Proof lapsed", "amber")}<span class="zb-sub2">${esc(plain(o.lapseReason || ""))}, ${esc(day(o.lapsedAt || o.checkedAt))}</span>`;
  return `${Z.tag("Not proven", "amber")}<span class="zb-sub2">receipts are not invoiced</span>`;
};

META.wallets = () => ({ title: "Wallets", sub: "Addresses you want counted in your books. Read only: Zold never holds a key for one.", actions: secondary("Import wallet", 'data-act="import-wallet"', "add") });
RENDER.wallets = async () => {
  const { wallets } = await api(`/api/orgs/${org.id}/wallets`);
  const unproven = wallets.filter((w) => w.proofState !== "proven").length;
  return wallets.length
    ? `${unproven ? `<div class="banner warn">${Z.icon("verified_user")}<span>Importing a wallet does not show it is yours. Prove it by signing a short message in the wallet itself: until then it is synced and counted in your books, but its receipts are not collected into invoices.</span></div>` : ""}
      <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Label</th><th scope="col">Address</th><th scope="col">Network</th><th scope="col">Sync</th><th scope="col">Ownership</th><th scope="col"><span class="z-sr">Actions</span></th></tr></thead><tbody>${wallets.map((w) => `<tr>
        <td>${esc(w.label)}<span class="zb-sub2">${esc(w.kind.toUpperCase())}</span></td><td class="z-mono" translate="no">${esc(w.address)}</td><td>${esc(String(w.chainId))}</td>
        <td>${walletSyncCell(w.sync)}</td>
        <td>${walletProofCell(w)}</td>
        <td><div class="zb-cellact">${w.proofState === "proven" || !roleCan(org.role, "wallets") ? "" : `<button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="prove-wallet" data-id="${esc(w.id)}">Prove<span class="z-sr">: ${esc(w.label)}</span></button>`}
          ${w.ownership && roleCan(org.role, "wallets") ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="recheck-wallet" data-id="${esc(w.id)}">Check again<span class="z-sr">: ${esc(w.label)}</span></button>` : ""}
          <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="del-wallet" data-id="${esc(w.id)}">Remove<span class="z-sr">: ${esc(w.label)}</span></button></div></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="z-card"><p class="empty">No wallets imported.</p></div>`;
};

/** A synced token with no feed price is booked as SYMBOL@chain:address, so it
 *  cannot merge into the real token's lots; show the symbol and the contract,
 *  and say why it has no value: on no token list, or listed but unpriced. */
const assetCell = (e) => {
  if (e.asset === "EURe") return "Euros";
  const m = /^(.*)@\d+:(0x[0-9a-f]{40})$/.exec(e.asset);
  if (!m) return esc(e.asset);
  const why = (e.tags || []).includes("unlisted") ? "not on a token list" : "no price";
  return `${esc(m[1])}<span class="zb-sub2 z-mono" translate="no">${esc(`${m[2].slice(0, 6)}…${m[2].slice(-4)}`)} · ${why}</span>`;
};

META.ledger = () => ({ title: "Every transaction", sub: "Every movement across your accounts and imported wallets.", actions: `${booksBack()}${cap("export.ledger").allowed ? secondary("Download CSV", 'data-act="export-ledger"', "download") : ""}` });
RENDER.ledger = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const { entries } = await api(`/api/orgs/${org.id}/ledger`);
  return entries.length
    ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Currency</th><th scope="col">Category</th><th scope="col">Tags</th><th scope="col" class="z-tbl__num">Amount</th></tr></thead><tbody>${entries.map((e) => `<tr>
        <td class="z-dim">${esc(day(e.at))}</td><td>${assetCell(e)}</td><td>${esc(e.accountCode || "None")}</td><td class="z-dim">${esc(e.tags.join(", ") || "None")}</td>
        <td class="z-tbl__num"><span class="z-amount${e.direction === "in" ? " z-amount--in" : ""}">${e.direction === "in" ? "+" : "−"}${esc(e.amount)}</span></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="z-card"><p class="empty">Nothing yet. Transactions appear once money moves or a wallet syncs.</p></div>`;
};

/** Euros from integer cents; a dash where the figure is unknown. */
const cents = (c) => (c === undefined || c === null ? "—" : eur(c / 100));
const shortHex = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "");
/** A holding: its symbol, and which contract on which chain it is. */
const holdingCell = (x) =>
  `${esc(x.asset)}${x.token ? `<span class="zb-sub2 z-mono" translate="no">${esc(shortHex(x.token))} · chain ${esc(String(x.chainId))}</span>` : ""}`;
const signedCents = (c) => (c === undefined ? "—" : `<span class="z-amount${c >= 0 ? " z-amount--in" : ""}">${c < 0 ? "−" : ""}${eur(Math.abs(c) / 100)}</span>`);
const booksNotes = (notes = []) => `<div class="zb-notes">${notes.map((n) => `<div class="zb-note">${Z.icon("info")}<span>${esc(n)}</span></div>`).join("")}</div>`;

META.assets = () => ({ title: "Holdings and tax lots", sub: "What your wallets hold per token, what it cost, and the lots it came from. First in, first out.", actions: `${booksBack()}${linkBtn("Realised gains", "gains", "trending_up")}` });
RENDER.assets = async () => {
  if (!cap("assets.costBasis").allowed) return gateHtml("assets.costBasis");
  const d = await api(`/api/orgs/${org.id}/assets`);
  const walletName = Object.fromEntries(d.wallets.map((w) => [w.id, w.label]));
  const unproven = d.wallets.filter((w) => w.proofState !== "proven");
  const lotRow = (l) => `<tr>
      <td class="z-dim">${esc(day(l.acquiredAt))}</td>
      <td>${esc(walletName[l.walletId] || l.walletId || "Account")}${l.walletProofState && l.walletProofState !== "proven" ? ` ${Z.tag(PROOF_WORD[l.walletProofState] || l.walletProofState, "amber")}` : ""}</td>
      <td class="z-tbl__num">${esc(l.quantity)}</td><td class="z-tbl__num">${esc(l.remaining)}</td>
      <td class="z-tbl__num">${l.costCents === undefined ? "no value" : cents(l.costCents)}</td>
      <td class="z-mono z-dim" translate="no">${esc(shortHex(l.txHash))}</td></tr>`;
  const positionsHtml = d.positions.length
    ? d.positions.map((p) => `<section class="z-card" style="margin-bottom:12px" aria-label="${esc(p.asset)}">
        <div class="z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Token</th><th scope="col" class="z-tbl__num">Held</th><th scope="col" class="z-tbl__num">Cost of what is held</th><th scope="col" class="z-tbl__num">Realised to date</th></tr></thead><tbody><tr>
          <td>${holdingCell(p)}</td><td class="z-tbl__num">${esc(p.quantity)}</td>
          <td class="z-tbl__num">${cents(p.costBasisCents)}${p.uncostedQuantity !== "0" ? `<span class="zb-sub2">and ${esc(p.uncostedQuantity)} with no known cost</span>` : ""}</td>
          <td class="z-tbl__num">${signedCents(p.realisedCents)}${p.unmeasured ? `<span class="zb-sub2">${p.unmeasured} sale${p.unmeasured === 1 ? "" : "s"} not measurable</span>` : ""}</td></tr></tbody></table></div>
        <details style="padding:0 16px 12px"><summary>${p.lots.length} lot${p.lots.length === 1 ? "" : "s"}</summary>
          <div class="z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Acquired</th><th scope="col">Wallet</th><th scope="col" class="z-tbl__num">Quantity</th><th scope="col" class="z-tbl__num">Left</th><th scope="col" class="z-tbl__num">Cost</th><th scope="col">Transaction</th></tr></thead><tbody>${p.lots.map(lotRow).join("")}</tbody></table></div></details>
      </section>`).join("")
    : `<div class="z-card"><p class="empty">No token with lots yet. A listed token a wallet receives opens one; EURe and tokens on no list do not.</p></div>`;
  const quantityOnly = d.quantityOnly.length
    ? `<h2 class="zb-h2" style="margin:28px 0 6px">Tokens on no list</h2><p class="zb-hint" style="margin-bottom:12px">Counted, never valued: anyone can send any token to a wallet.</p>
      <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Token</th><th scope="col" class="z-tbl__num">Held</th><th scope="col" class="z-tbl__num">Transfers</th></tr></thead><tbody>${d.quantityOnly.map((q) => `<tr><td>${holdingCell(q)}</td><td class="z-tbl__num">${esc(q.quantity)}</td><td class="z-tbl__num">${q.entryIds.length}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const mayRevalue = cap("ledger.transactions").allowed && roleCan(org.role, "categorise");
  const needs = d.needsValuation.length
    ? `<div class="zb-bar" style="margin:28px 0 12px"><div><h2 class="zb-h2">No value yet</h2><p class="zb-hint">The price feed had no price when these were synced. Asking again uses the same lookup for the same block time; a price cannot be typed in.</p></div>${mayRevalue ? secondary("Ask for all prices again", 'data-act="revalue-all"', "refresh") : ""}</div>
      <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Token</th><th scope="col" class="z-tbl__num">Quantity</th><th scope="col">Why</th><th scope="col"><span class="z-sr">Actions</span></th></tr></thead><tbody>${d.needsValuation.map((e) => `<tr>
        <td class="z-dim">${esc(day(e.at))}</td><td>${assetCell({ asset: e.asset, tags: [] })}</td>
        <td class="z-tbl__num"><span class="z-amount${e.direction === "in" ? " z-amount--in" : ""}">${e.direction === "in" ? "+" : "−"}${esc(e.amount)}</span></td>
        <td class="z-dim">${esc(plain(e.note || ""))}</td>
        <td><div class="zb-cellact">${mayRevalue ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="revalue-row" data-id="${esc(e.entryId)}">Ask again</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>`
    : "";
  const moved = d.moved.length
    ? `<h2 class="zb-h2" style="margin:28px 0 6px">Moved to your own addresses</h2><p class="zb-hint" style="margin-bottom:12px">Sent to your Zold account or to an address marked as your own: out of these holdings at cost, with no gain.</p>
      <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Token</th><th scope="col" class="z-tbl__num">Quantity</th><th scope="col">To</th><th scope="col" class="z-tbl__num">Cost</th></tr></thead><tbody>${d.moved.map((m) => `<tr>
        <td class="z-dim">${esc(day(m.at))}</td><td>${esc(m.asset)}</td><td class="z-tbl__num">${esc(m.quantity)}</td>
        <td>${m.to === "zold-account" ? "Your Zold account" : "An address marked as your own"}</td><td class="z-tbl__num">${cents(m.costBasisCents)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const unreadable = d.unreadable.length
    ? `<div class="banner warn" style="margin-top:16px">${Z.icon("error")}<span>${d.unreadable.length} transaction${d.unreadable.length === 1 ? " has" : "s have"} an amount or time Zold cannot read and ${d.unreadable.length === 1 ? "is" : "are"} left out of these figures (${esc(d.unreadable.slice(0, 5).join(", "))}${d.unreadable.length > 5 ? "…" : ""}).</span></div>`
    : "";
  const shortfalls = d.shortfalls.length
    ? `<div class="banner warn" style="margin-top:16px">${Z.icon("warning")}<span>${d.shortfalls.length} transfer${d.shortfalls.length === 1 ? "" : "s"} out moved more than was ever booked (${d.shortfalls.map((s) => `${esc(s.quantity)} ${esc(s.asset)} on ${esc(day(s.at))}${s.kind === "moved" ? ", to your own address" : ""}`).join("; ")}). Usually history before the wallet’s sync start is missing. No gain is shown rather than one at zero cost.</span></div>`
    : "";
  return `${unproven.length ? `<div class="banner warn">${Z.icon("verified_user")}<span>${esc(unproven.map((w) => `${w.label} (${PROOF_WORD[w.proofState]})`).join(", "))}: counted here, and labelled on its lots, but not proven to be yours. <a href="?view=wallets" data-view-link="wallets">Prove it</a>.</span></div>` : ""}
    ${positionsHtml}${unreadable}${shortfalls}${needs}${moved}${quantityOnly}${booksNotes(d.notes)}`;
};

META.gains = () => ({ title: "Realised gains", sub: "Per month, the EUR value of what left your wallets minus the first-in, first-out cost of what it was sold from.", actions: `${booksBack()}${linkBtn("Holdings", "assets", "account_balance_wallet")}` });
RENDER.gains = async () => {
  if (!cap("assets.costBasis").allowed) return gateHtml("assets.costBasis");
  const d = await api(`/api/orgs/${org.id}/reports/realised-gains`);
  if (!d.disposals.length) return `<div class="z-card"><p class="empty">No token with lots has left your wallets yet. EURe is money and a token on no list is only counted, so neither makes a gain or a loss.</p></div>${booksNotes(d.notes)}`;
  const months = `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Month</th><th scope="col" class="z-tbl__num">Gains</th><th scope="col" class="z-tbl__num">Losses</th><th scope="col" class="z-tbl__num">Net</th><th scope="col" class="z-tbl__num">Not measurable</th></tr></thead><tbody>${[...d.months].reverse().map((m) => `<tr>
      <td>${esc(m.month)}</td><td class="z-tbl__num">${cents(m.gainsCents)}</td><td class="z-tbl__num">${cents(m.lossesCents)}</td>
      <td class="z-tbl__num">${signedCents(m.realisedCents)}</td><td class="z-tbl__num">${m.unmeasured || ""}</td></tr>`).join("")}</tbody></table></div>`;
  const rows = [...d.disposals].reverse().map((x) => `<tr>
      <td class="zb-top z-dim">${esc(day(x.at))}</td><td class="zb-top">${holdingCell(x)}</td><td class="zb-top z-tbl__num">${esc(x.quantity)}</td>
      <td class="zb-top z-tbl__num">${cents(x.proceedsCents)}</td><td class="zb-top z-tbl__num">${cents(x.costBasisCents)}</td>
      <td class="zb-top z-tbl__num">${x.realisedCents === undefined ? `<span class="z-dim">not measurable</span><span class="zb-sub2">${esc(x.notMeasurable || "")}</span>` : signedCents(x.realisedCents)}</td>
      <td class="zb-top">${x.consumed.map((c) => `<span class="zb-sub2">${esc(c.quantity)} from ${esc(c.lotId.replace(/^lot_/, ""))}${c.costCents === undefined ? ", no cost" : `, ${cents(c.costCents)}`}</span>`).join("") || `<span class="z-dim">none</span>`}</td>
      <td class="zb-top z-mono z-dim" translate="no">${esc(shortHex(x.txHash))}${x.sameTransaction.length ? `<span class="zb-sub2">same transaction: ${esc(x.sameTransaction.join(", "))}</span>` : ""}</td></tr>`).join("");
  const unreadable = d.unreadable?.length
    ? `<div class="banner warn">${Z.icon("error")}<span>${d.unreadable.length} transaction${d.unreadable.length === 1 ? " has" : "s have"} an amount or time Zold cannot read and ${d.unreadable.length === 1 ? "is" : "are"} left out of these figures.</span></div>`
    : "";
  return `${unreadable}${months}
    <h2 class="zb-h2" style="margin:28px 0 12px">Every sale</h2>
    <div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Token</th><th scope="col" class="z-tbl__num">Quantity</th><th scope="col" class="z-tbl__num">Value when it left</th><th scope="col" class="z-tbl__num">Cost (FIFO)</th><th scope="col" class="z-tbl__num">Gain or loss</th><th scope="col">Lots used</th><th scope="col">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${booksNotes(d.notes)}`;
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

META.integrations = () => ({ title: "Connections", sub: "Get your books into the software your accountant already uses.", actions: "" });

const conn = (logo, title, sub, tag, text, act, wide = false) => `<section class="z-card zb-conn${wide ? " zb-conn--wide" : ""}" aria-label="${esc(title)}">
    <div class="zb-conn__head"><span class="zb-conn__logo" aria-hidden="true">${esc(logo)}</span><span class="z-row__main"><span class="z-row__title">${esc(title)}</span><span class="z-row__sub">${esc(sub)}</span></span>${tag}</div>
    <p>${text}</p><div class="zb-actions">${act}</div></section>`;

RENDER.integrations = async () => {
  if (!cap("integrations.accounting").allowed) return gateHtml("integrations.accounting");
  const r = await api(`/api/orgs/${org.id}/integrations`);
  const g = r.integrations.getmyinvoices;
  const gmi = g.connected
    ? conn("GMI", "GetMyInvoices", `Connected to ${g.accountName || "your account"}${g.accountEmail ? ` (${g.accountEmail})` : ""} since ${day(g.connectedAt)}`, Z.tag("Beta"),
      "Every Beleg of a month goes up as a paid document, numbered with its Beleg code. Sending twice uploads nothing twice. Your accountant takes it from there.",
      `${linkBtn("Send a month’s Belege", "export", "upload")}${secondary("Remove key", 'data-act="gmi-disconnect"')}`, true)
    : conn("GMI", "GetMyInvoices", "API key · sends Belege each month", Z.tag("Beta"),
      "Every Beleg of a month goes up as a paid document, numbered with its Beleg code. Sending twice uploads nothing twice. Your accountant takes it from there.",
      r.available ? primary("Connect", 'data-act="gmi-drawer"', "link") : `<p class="desc">Not available here: ${esc(plain(g.needs || ""))}.</p>`, true);
  return `<h2 class="z-eyebrow zb-conn__group zb-conn__group--first">Sends your books for you</h2>
    ${gmi}
    <h2 class="z-eyebrow zb-conn__group">File exports</h2>
    <div class="zb-grid3">
      ${conn("LO", "Lexware Office", "CSV import", "", "Download the month’s bank lines as a Lexware CSV and import them as an offline account.", linkBtn("Download from Books", "books", "download"))}
      ${conn("sev", "sevDesk", "Not built yet", Z.tag("Soon"), "Until it’s built, use the Lexware CSV and the Belege ZIP from Books. sevDesk imports both.", linkBtn("CSV and ZIP", "books", "folder_zip"))}
      ${conn("DATEV", "DATEV", "Not built yet", Z.tag("Soon"), "Your tax adviser can take the Belege ZIP for now.", linkBtn("Exports", "books", "download"))}
    </div>
    <div class="zb-notes"><div class="zb-note">${Z.icon("person")}<span>Or give your accountant read-only access as a member with the Accountant role. They can export on their own.</span>${cap("members.manage").allowed ? linkBtn("Members", "members") : ""}</div></div>`;
};

/* ==========================================================================
   Settings
   ========================================================================== */

/* ==========================================================================
   Documents: statements, balance confirmations, proofs of ownership and
   receipts. They belong to the account that backs the org's euro account
   (documents are a user's, routes/documents.ts), so they are offered here
   only to the member whose own account it is.
   ========================================================================== */

const DOC_LABEL = { statement: "Account statement", receipt: "Transfer receipt", balance: "Balance confirmation", ownership: "Proof of ownership" };
const DOC_ICON = { statement: "description", receipt: "receipt_long", balance: "account_balance", ownership: "verified_user" };
export const docMonth = { value: null };
/** Receipts list the most recent paid transfers only. */
const RECEIPT_ROWS = 50;
/** A document link from the API, opened only if it is ours or https. */
export const docHref = (url) => (typeof url === "string" && (url.startsWith("/") || /^https:\/\//i.test(url)) ? url : null);

META.documents = () => ({ title: "Statements and documents", sub: "Signed documents for this account. Anyone you give one to can check it at the address printed on it.", actions: linkBtn("Accounts", "accounts", "arrow_back") });

RENDER.documents = async () => {
  const { accounts } = await api(`/api/orgs/${org.id}/accounts`);
  const euro = accounts.find((a) => a.currency === "EUR" && a.status === "active");
  if (!euro) return `<div class="z-card"><p class="empty">The euro account isn’t open yet, so there is nothing to document. ${linkBtn("Accounts", "accounts")}</p></div>`;
  if (!me || euro.backingUserId !== me.id) {
    return `<div class="z-card"><p class="empty">This account spends from a member’s own account, and its documents are issued from there. Ask that member for a statement or proof of ownership.</p></div>`;
  }
  const [docs, tx] = await Promise.all([
    api(`/api/users/${me.id}/documents`).then((r) => r.documents || []),
    // The documents still render without the payment list; it says it failed.
    api(`/api/users/${me.id}/transfers`).then((r) => r.transfers || []).catch(() => null),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return { value: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) };
  });
  const chosen = docMonth.value || months[0].value;
  const paid = (tx || []).filter((t) => t.rail === "sepa" && t.state === "PAID").slice(0, RECEIPT_ROWS);
  const create = `<section class="card"><div class="h"><div><h2>Create</h2><p class="desc">Each one opens in a new tab, ready to print or save as PDF.</p></div></div>
    <div class="zb-doc-create">
      <div><label for="doc-month">Statement month</label><select id="doc-month">${months.map((m) => `<option value="${m.value}"${m.value === chosen ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select></div>
      ${primary("Statement", 'data-act="doc-statement"', "description")}
      ${secondary("Balance confirmation", 'data-act="doc-balance"', "account_balance")}
      ${secondary("Proof of ownership", 'data-act="doc-ownership"', "verified_user")}
    </div>
    <p class="desc" style="margin-top:12px">The proof of ownership asks for your Face ID or fingerprint: the account itself signs it, which shows you control it.</p></section>`;
  const issued = docs.length
    ? table([["Document"], ["Details"], ["Issued"], [""]], docs.map((d) => `<tr>
        <td>${Z.icon(DOC_ICON[d.kind] || "description")} ${esc(DOC_LABEL[d.kind] || d.kind)}</td>
        <td>${esc(d.summary || "")}${d.revokedAt ? ` ${Z.tag("Revoked")}` : ""}</td>
        <td class="mono">${esc(day(d.createdAt))}</td>
        <td class="num">${docHref(d.url) ? `<a class="z-btn z-btn--secondary z-btn--sm" href="${esc(docHref(d.url))}" target="_blank" rel="noopener">Open</a>` : ""}</td></tr>`))
    : `<div class="z-card"><p class="empty">Nothing issued yet.</p></div>`;
  const payments = tx === null
    ? `<div class="z-card"><p class="empty">Your payments could not be loaded, so their receipts aren’t listed. Reload to try again.</p></div>`
    : paid.length
    ? table([["Paid"], ["To"], ["Amount", "num"], [""]], paid.map((t) => `<tr>
        <td class="mono">${esc(day(t.updatedAt || t.createdAt))}</td>
        <td>${esc(t.recipientName || "—")}</td>
        <td class="num">${esc(eur(t.sendEur))}</td>
        <td class="num"><span class="zb-actions" style="justify-content:flex-end">${secondary("Receipt", `data-act="doc-receipt" data-id="${esc(t.id)}"`)}<a class="z-btn z-btn--secondary z-btn--sm" href="/app#share/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">Share</a></span></td></tr>`))
    : `<div class="z-card"><p class="empty">No bank transfer from this account has been paid yet.</p></div>`;
  return `${create}
    <h2 class="zb-h2" style="margin:28px 0 12px">Issued</h2>${issued}
    <h2 class="zb-h2" style="margin:28px 0 12px">Receipts for payments</h2>${payments}`;
};

const table = (head, rows) => `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr>${head.map(([h, cls]) => `<th scope="col"${cls ? ` class="${cls}"` : ""}>${h ? esc(h) : `<span class="z-sr">Actions</span>`}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

/* ==========================================================================
   Coming soon: what this organisation can't do yet, and why. The personal
   app has its own list; linking there showed a company its owner's account.
   ========================================================================== */

META.soon = () => ({ title: "Coming soon", sub: "What this organisation can’t do yet, and why. Each one switches on here as soon as it works.", actions: "" });

RENDER.soon = async () => {
  // Each list is read on its own; one that fails leaves its row out rather
  // than claiming something the API did not say.
  const [acc, cur] = await Promise.allSettled([api(`/api/orgs/${org.id}/accounts`), api("/api/orgs/currencies")]);
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : null;
  const later = (cur.status === "fulfilled" ? cur.value.currencies || [] : []).filter((c) => !c.available && c.code !== "EUR").map((c) => c.code);
  const lead = Z.iconTile({ icon: "hourglass_top", tone: "a" });
  const euroClosed = accounts !== null && !accounts.some((a) => a.currency === "EUR" && a.status === "active");
  const rows = [
    ...(euroClosed ? [Z.row({ lead, title: "Euro account", sub: org.type === "business" ? "Opens once the company’s IBAN is connected" : "Opens once your IBAN is connected", href: "?view=accounts" })] : []),
    ...(later.length ? [Z.row({ lead, title: "Accounts in other currencies", sub: `${later.length > 1 ? `${later.slice(0, -1).join(", ")} and ${later.at(-1)}` : later[0]}: waiting on an account provider`, soon: true })] : []),
    Z.row({ lead, title: "More countries", sub: "Bank transfers reach Europe only, for now", soon: true }),
    Z.row({ lead, title: "Paying a crypto wallet", sub: "Not built yet", soon: true }),
    Z.row({ lead, title: "sevDesk and DATEV", sub: "Use the Lexware CSV and the Belege ZIP until then", soon: true }),
  ];
  return Z.listGroup({ rows });
};

const settingsBack = () => linkBtn("Settings", "settings", "arrow_back");

META.organisation = () => ({ title: "Organisation", sub: "Printed on every invoice you issue. The country decides which invoicing rules apply.", actions: `${settingsBack()}${primary("Save", 'data-act="save-org"')}` });

RENDER.organisation = async () => {
  const reporting = cap("settings.reportingCurrency").allowed;
  return `<form class="card" id="org-form" onsubmit="return false">
      <div class="grid g2">
        <div><label for="s-name">Name</label><input id="s-name" name="organization" autocomplete="organization" value="${esc(org.name)}" /></div>
        <div><label for="s-legal">Legal name</label><input id="s-legal" name="legal" autocomplete="off" value="${esc(org.legalName || "")}" /></div>
      </div>
      <label for="s-addr1">Registered address</label>
      <input id="s-addr1" name="address-line1" autocomplete="address-line1" value="${esc(org.address?.line1 || "")}" placeholder="Street and number…" />
      <label for="s-addr2" class="z-sr">Address line 2</label>
      <input id="s-addr2" name="address-line2" autocomplete="address-line2" value="${esc(org.address?.line2 || "")}" placeholder="Address line 2 (optional)…" style="margin-top:8px" />
      <div class="zb-addr3">
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
    </form>`;
};

META.plan = () => ({ title: "Plan", sub: "Zold takes no payments yet: a paid plan comes with the trial, or Zold grants it. Switching down pauses features and deletes nothing.", actions: settingsBack() });

RENDER.plan = async () => {
  const plan = await api(`/api/orgs/${org.id}/plan`);
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
  return `${plan.trialAvailable && owner ? `<div class="zb-actions" style="margin-bottom:16px"><button type="button" class="z-btn z-btn--primary" data-act="trial">Start the ${plan.trialDays}-day trial</button></div>` : ""}
    <div class="grid g3">${plans}</div>`;
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
  if (i.state === "DRAFT") {
    // Issue only where the API would accept it: receipts on the draft, and a
    // total that net plus VAT can reach.
    const issuable = i.lines.length && !i.fromReceipts?.mismatchCents;
    return `${issuable ? `<button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="issue-receipt-draft" data-id="${esc(i.id)}">Issue invoice</button>` : ""}
      <button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="discard-receipt-draft" data-id="${esc(i.id)}">Discard draft</button>`;
  }
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
      </div></div>` : p.method === "wallet-receipt" ? `
      <div class="issue">${Z.tag(p.asset || "Token")}<div>
        <div>${esc(p.receivedAmount)} ${esc(p.asset)} received in your wallet · ${tx(p.txHash)}</div>
        <p class="desc">Worth ${esc(eur(p.amountEur))} when it arrived · ${esc(day(p.at))}</p>
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
