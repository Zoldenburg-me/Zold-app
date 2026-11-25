/**
 * Settings (design canvas "Desk-Settings"): a grouped menu on the left, the
 * chosen section on the right. Organisation and Monerium open in place; the
 * other entries are their own screens.
 */
import { Z, api, cap, ensureMe, esc, issuerFieldNames, issuerIds, me, org, plain, roleCan } from "./core.js";
import { META, RENDER, moneriumLink } from "./views.js";
import { isOwnCompanyOrg } from "./access-model.js";
import { mayChangeEntity, settingsSecFrom } from "./settings-model.js";
import { companyKeysHere, ibanPanel, keyHint, keyRows, payoutRows } from "./org-monerium-model.js";
import { shown } from "./nav.js";

const ss = { sec: "org" };
// A link that opens Settings at one section (Home's set-up card): it picks the
// section before the view link renders Settings. Capture phase, so it runs
// ahead of the shell's view-link handler.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest?.("a[data-settings-sec]");
  if (a && ["org", "monerium"].includes(a.dataset.settingsSec)) ss.sec = a.dataset.settingsSec;
}, true);
META.settings = () => ({ title: "Settings", sub: `${org.name}.`, actions: "" });

function menu(accounts) {
  const here = (id, label) => `<button type="button" class="zb-set-menu__item" data-ss="${id}"${ss.sec === id ? ' aria-current="true"' : ""}>${esc(label)}</button>`;
  const away = (v, label) => `<a class="zb-set-menu__item" href="?view=${v}" data-view-link="${v}">${esc(label)}${Z.icon("arrow_forward", "zb-set-menu__out")}</a>`;
  const own = isOwnCompanyOrg(me, org, accounts);
  const groups = [
    ["Company", [here("org", "Business profile"), cap("invoices").allowed ? away("invoicing-settings", "Invoicing profile") : ""]],
    // Members only where the sidebar lists it; Access is one screen, for approvals and, in its own company, the login's sign-in.
    ["Team", [shown({ capability: "members.manage" }) ? away("members", "Members and access") : "", away("access", own ? "Approvals, sign-in and recovery" : "Who approves payments")]],
    ["Account", [here("monerium", "Monerium"), own
      ? `<a class="zb-set-menu__item" href="/app?from=business#page-settings">Payment page${Z.icon("open_in_new", "zb-set-menu__out")}<span class="z-sr"> (the app)</span></a>`
      : `<a class="zb-set-menu__item" href="/app?from=business#security">Your sign-in and recovery${Z.icon("open_in_new", "zb-set-menu__out")}<span class="z-sr"> (the app)</span></a>`]],
    ["Connected", [away("apps", "Apps"), away("integrations", "Accounting connections")]],
  ];
  return `<nav class="zb-set-menu" aria-label="Settings">${groups.map(([title, items]) =>
    `<h2 class="z-eyebrow">${title}</h2>${items.join("")}`).join("")}</nav>`;
}

const rows = (list) => `<dl class="zb-set-rows">${list.filter(([, v]) => v).map(([k, v, mono]) =>
  `<div><dt>${esc(k)}</dt><dd${mono ? ' class="z-mono"' : ""}>${esc(v)}</dd></div>`).join("")}</dl>`;

function section(title, sub, body, action = "") {
  return `<section class="z-card zb-pad zb-stack" style="gap:14px" aria-labelledby="set-h">
    <div class="zb-side-card__head"><h2 id="set-h">${esc(title)}</h2>${action}</div>
    ${sub ? `<p class="desc">${esc(sub)}</p>` : ""}${body}</section>`;
}

function orgSection() {
  const a = org.address || {};
  const address = [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const country = a.country ? (new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) || a.country) : "";
  const edit = `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=organisation" data-view-link="organisation">Edit</a>`;
  const ids = issuerIds(org);
  const names = issuerFieldNames(a.country);
  const d = org.issuerDetails || {};
  return section("Business profile", "Who you are on every invoice you issue. The country decides which invoicing rules apply.",
    rows([["Name", org.name], ["Legal name", org.legalName],
      ["Legal form", org.entity === "company" ? "Company" : org.entity === "sole_trader" ? "Sole trader" : ""],
      ["Address", address], ["Country", country],
      [names.vatId, ids.vatId, true], [names.taxNumber, ids.taxNumber, true],
      ["Registration", [d.registerCourt, d.registerNumber].filter(Boolean).join(" ")], ["Notification email", org.notificationEmail]])
    + (address ? "" : `<p class="zb-hint">No address yet. Invoices need one.</p>`)
    + (mayChangeEntity(org) ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="org-entity">Change legal form</button></div>
      <p class="zb-hint">It can’t change once the euro account is set up.</p>` : ""), edit);
}

/** The company's IBAN on its Safe, and its latest deposits once issued
 *  (routes/business/org-monerium-iban.ts). */
function companyIbanPart(keys, deposits, payoutsOn) {
  const p = ibanPanel(keys, roleCan(org.role, "sign"), payoutsOn);
  const btn = p.action === "issue"
    ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="org-iban-issue">Issue the company’s IBAN</button></div>`
    : p.action === "check" ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="org-iban-check">Check again</button></div>` : "";
  return (p.iban ? rows([["Company IBAN", Z.groupIban(p.iban), true]]) : "") + `<p class="zb-hint">${esc(p.text)}</p>` + btn + (p.iban ? depositsHtml(deposits) : "");
}

/** Bank payouts from the company's IBAN (routes/business/org-monerium-payouts.ts).
 *  `payouts` is undefined while loading, null when unread, [] none. The form is
 *  drawn only where the deployment has switched payouts on and this member is
 *  an owner who can sign; the history stays readable either way. */
function payoutsHtml(payouts, on) {
  const add = on && roleCan(org.role, "sign")
    ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="org-payout-new">Pay a bank account</button></div>`
    : "";
  const off = on ? "" : `<p class="zb-hint">Bank payouts from the company’s IBAN are switched off on this deployment.</p>`;
  const body = payouts === undefined
    ? `<p class="zb-hint">Loading payouts…</p>`
    : payouts === null
      ? `<p class="zb-hint">Payouts couldn’t be read just now.</p>`
      : payoutRows(payouts).length
        ? `<div class="z-list z-card">${payoutRows(payouts).map((p) => `<div class="z-row" style="display:block">
            <div style="display:flex;justify-content:space-between;gap:12px"><span class="z-row__title">${esc(p.title)}</span><b>${esc(p.state)}</b></div>
            <span class="z-row__sub z-mono">${esc(p.sub)}</span>
            ${p.note ? `<span class="z-row__sub">${esc(p.note)}</span>` : ""}</div>`).join("")}</div>`
        : `<p class="zb-hint">No payouts yet.</p>`;
  return `<div id="om-payouts"><p class="zb-hint">Bank payouts from the company’s IBAN, newest first. Only “Sent” means Monerium carried it out.</p>${off}${add}${body}</div>`;
}

/** The latest deposits: undefined while loading, null when unread, [] none. */
function depositsHtml(deposits) {
  const body = deposits === undefined
    ? `<p class="zb-hint">Loading deposits…</p>`
    : deposits === null
      ? `<p class="zb-hint">Deposits couldn’t be read from Monerium just now.</p>`
      : deposits.length
        ? `<p class="zb-hint">Latest deposits, as Monerium lists them:</p>${rows(deposits.map((d) => [`${d.from || "Bank transfer"} · ${String(d.at).slice(0, 10)}`, `€${d.amountEur.toFixed(2)} (${d.state})`]))}`
        : `<p class="zb-hint">No deposits yet.</p>`;
  return `<div id="om-deposits">${body}</div>`;
}

/** A company's own Monerium keys (routes/business/org-monerium.ts). `keys`
 *  is GET .../monerium, null when it could not be read. */
function companyMoneriumSection(keys, deposits, payouts, payoutsOn) {
  if (!roleCan(org.role, "accounts")) {
    return section("Monerium", "The company connects its own Monerium account with API keys. An owner or admin does this.", "");
  }
  const connected = keys && keys.status !== "not_connected";
  const hint = keyHint(keys);
  const actions = !keys ? "" : connected
    ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="org-monerium-check">Check keys again</button><button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="org-monerium-drawer" data-replace="1">Replace keys</button><button type="button" class="z-btn z-btn--secondary z-btn--sm zb-danger" data-act="org-monerium-remove">Remove keys</button></div>`
    : keys.available ? `<div class="zb-actions"><button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="org-monerium-drawer">Add Monerium keys</button></div>` : "";
  const issued = keys?.companyIban?.state === "issued";
  return section("Monerium", "The company’s own Monerium account, connected with API keys from its Monerium developer section. Monerium issues the IBANs and the euros; Zold is the software you use them with.",
    rows(keyRows(keys)) + (hint ? `<p class="zb-hint">${esc(plain(hint))}</p>` : "")
    + actions + companyIbanPart(keys, deposits, payoutsOn)
    + (issued ? payoutsHtml(payouts, payoutsOn) : ""));
}

function moneriumSection(accounts) {
  if (!accounts) return section("Monerium", "", `<p class="empty">Accounts couldn’t load. Open Settings again to retry.</p>`);
  const euro = accounts.filter((a) => a.currency === "EUR");
  const live = euro.filter((a) => a.status === "active" && a.identifier?.iban);
  const p = euro.map((a) => a.profile).find((x) => x && x.status !== "not_applicable");
  const status = !live.length ? "Not connected" : p?.status === "needs_check" ? "Needs a check" : "Connected";
  const profile = p?.name ? `${p.name} (${p.kind === "corporate" ? "company" : "personal"} profile)` : "";
  const mine = live.some((a) => a.backingUserId === me?.id);
  const backer = live.find((a) => a.backingUserId)?.backingMemberName;
  const own = org.type === "personal" || isOwnCompanyOrg(me, org, accounts);
  return section("Monerium", "Monerium issues the IBANs and the euros. Zold is the software you use them with.",
    rows([["Status", status], ["Profile", profile], ["Through the account of", mine ? "You" : backer], ["Accounts", live.map((a) => a.label || a.currency).join(", ")]])
    + (p?.status === "needs_check" && p.reason ? `<p class="zb-hint">${esc(plain(p.reason))}</p>` : ""),
    own ? moneriumLink(live.length ? "Manage" : "Connect Monerium")
      : `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=accounts" data-view-link="accounts">Accounts</a>`);
}

RENDER.settings = async () => {
  // A link that names its section in the URL (opened in a new tab, or reloaded).
  ss.sec = settingsSecFrom(location.search) || ss.sec;
  // The menu offers Access only to the company login in its own company, so
  // it waits for who that is and reads whose account backs this one.
  const company = companyKeysHere(org, roleCan(org.role, "accounts"));
  const [acc, , ks, hs] = await Promise.allSettled([api(`/api/orgs/${org.id}/accounts`), ensureMe(),
    company ? api(`/api/orgs/${org.id}/monerium`) : Promise.resolve(null),
    api("/api/health").catch(() => null)]);
  // The company's deposits, read live from Monerium once its IBAN is issued.
  // Not awaited: the screen draws first and the list fills in, whichever
  // section is open (switching sections reuses it).
  const issued = ks.status === "fulfilled" && ks.value?.monerium?.companyIban?.state === "issued";
  let deposits = issued ? undefined : [];
  const depositsLoad = issued ? api(`/api/orgs/${org.id}/monerium/deposits`).then((r) => r.deposits, () => null) : null;
  // The company's bank payouts: stored rows, so they show even after the keys go.
  const payoutsOn = hs.status === "fulfilled" && hs.value?.capabilities?.orgBankPayouts === true;
  let payouts = issued && company ? undefined : [];
  const payoutsLoad = issued && company ? api(`/api/orgs/${org.id}/monerium/payouts`).then((r) => r.payouts, () => null) : null;
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : null;
  const keys = ks.status === "fulfilled" ? ks.value?.monerium ?? null : null;
  // A company's account is its own Safe: its Monerium is its own keys, never a login's connection.
  const SECTIONS = { org: orgSection, monerium: () => (org.entity === "company" ? companyMoneriumSection(keys, deposits, payouts, payoutsOn) : moneriumSection(accounts)) };
  return {
    html: `<div class="zb-set" id="set-root">${menu(accounts)}<div id="set-body">${SECTIONS[ss.sec]()}</div></div>`,
    bind(box) {
      const root = box.querySelector("#set-root");
      depositsLoad?.then((d) => {
        deposits = d;
        const el = root.querySelector("#om-deposits");
        if (el) el.outerHTML = depositsHtml(d);
      });
      payoutsLoad?.then((p) => {
        payouts = p;
        const el = root.querySelector("#om-payouts");
        if (el) el.outerHTML = payoutsHtml(p, payoutsOn);
      });
      root.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-ss]");
        if (!b) return;
        ss.sec = b.dataset.ss;
        root.querySelector(".zb-set-menu").outerHTML = menu(accounts);
        root.querySelector("#set-body").innerHTML = SECTIONS[ss.sec]();
        root.querySelector(`[data-ss="${ss.sec}"]`)?.focus();
        // Stacked under the menu on a narrow screen: bring the section into view.
        if (matchMedia("(max-width: 1023px)").matches) root.querySelector("#set-body").scrollIntoView({ block: "start" });
      });
    },
  };
};
