/**
 * Settings → Access: who can sign for the company login's account and who can
 * recover it, read from the chain on every visit (access-model.js). Only the
 * company login sees it, and only in its own company; another member is told
 * who does. Every change opens
 * the app's own screen on the same sign-in (APP_LINKS).
 */
import { Z, api, ensureMe, esc, org } from "./core.js";
import { META, RENDER } from "./views.js";
import { render } from "./shell.js";
import { APP_LINKS, isCompanyLogin, isOwnCompanyOrg, loadAccess } from "./access-model.js";

const settingsBack = `<a class="z-btn z-btn--secondary" href="?view=settings" data-view-link="settings">${Z.icon("arrow_back")}<span>Settings</span></a>`;
const appBtn = (label, href, variant = "secondary") =>
  `<a class="z-btn z-btn--${variant} z-btn--sm" href="${esc(href)}">${esc(label)}${Z.icon("open_in_new")}<span class="z-sr"> (the app)</span></a>`;
const fullDate = (d) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);

function card(id, title, body, action = "") {
  return `<section class="z-card zb-pad zb-stack" style="gap:14px" aria-labelledby="${id}">
    <div class="zb-side-card__head"><h2 id="${id}">${esc(title)}</h2>${action}</div>${body}</section>`;
}
const rows = (list) => `<dl class="zb-set-rows">${list.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
const addr = (a) => `<span class="z-mono zb-access__addr">${esc(a)}</span>`;

function signersCard(a) {
  const change = appBtn("Change in the app", APP_LINKS.signers);
  if (!a.signers) {
    return card("acc-sign", "Who can sign", `<p class="zb-hint">Couldn’t read the account’s signers from the chain (${esc(a.signersError.replace(/[.\s]+$/, ""))}). Open Access again to retry.</p>`, change);
  }
  const s = a.signers;
  const list = [
    ["Account", addr(s.safeAddress)],
    ["Passkey", s.passkeyIsOwner ? "This sign-in’s passkey" : "Not an owner"],
    [s.otherOwners.length > 1 ? "Other owners" : "Second owner", s.otherOwners.length ? s.otherOwners.map(addr).join("<br>") : "None"],
    ["Signatures needed", esc(s.needed)],
  ];
  const why = !s.passkeyIsOwner
    ? "This sign-in’s passkey is no longer an owner of the account, so it can’t sign anything."
    : `It needs ${esc(s.needed)} signatures, and Zold never collects another owner’s.`;
  const locked = s.zoldCanSend ? "" : `<div class="banner warn">${Z.icon("lock")}<span><b>Zold can’t send from this account.</b> ${why} Send from Safe{Wallet} instead.</span></div>`;
  const safe = s.safeAppUrl ? `<p class="zb-hint"><a href="${esc(s.safeAppUrl)}" target="_blank" rel="noopener">Open the account in Safe{Wallet}</a></p>` : "";
  return card("acc-sign", "Who can sign", `${locked}${rows(list)}${safe}`, change);
}

const guardianRow = (g) => {
  if (g.kind === "zoldenburg") return ["Zoldenburg UG", "Checks the person against Monerium’s identity check, and signs from a hardware wallet. Zold’s servers never hold that key."];
  if (g.kind === "codes") return ["Email or phone codes", esc(g.channels.map((c) => `${c.channel === "sms" ? "Phone" : "Email"} ${c.target}`).join(", ") || "Codes sent to the registered contacts")];
  return ["Not set up in Zold", addr(g.address)];
};
const guardianRows = (guardians) => rows(guardians.map(guardianRow));
/* A guardian Zold did not set up can start a recovery like any other. */
const strangers = (guardians) => guardians.some((g) => g.kind === "other")
  ? `<div class="banner warn">${Z.icon("warning")}<span><b>A guardian Zold didn’t set up is on this account.</b> It can start a recovery that would replace the passkey. If no one at the company added it, remove it in Safe{Wallet}.</span></div>`
  : "";

function recoveryCard(r) {
  const setUp = appBtn("Set up recovery", APP_LINKS.recovery, "primary");
  const manage = appBtn("Manage in the app", APP_LINKS.recovery);
  if (r.status === "pending") {
    const until = r.pending?.executeAfter ? ` It can complete after ${esc(fullDate(new Date(r.pending.executeAfter * 1000)))}.` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>A recovery is under way on this sign-in.</b> It would replace the passkey that signs for the company’s account.${until} If no one at the company started it, stop it now.</span></div>`,
      appBtn("Check it", APP_LINKS.alert, "primary"));
  }
  if (r.status === "unknown") {
    const read = r.guardians.length ? `${strangers(r.guardians)}<p class="zb-hint">Read on chain:</p>${guardianRows(r.guardians)}` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("help")}<span><b>Couldn’t check recovery.</b> Zold couldn’t read every guardian, so it can’t say whether a recovery is under way. This is not the same as none.</span></div>${read}`,
      `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`);
  }
  if (r.status === "none") {
    const loss = "If this sign-in’s passkey is lost, Zoldenburg UG cannot recover the company’s account. Only the EURe balance can be reclaimed, from Monerium.";
    if (!r.offered) {
      return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>No one can recover this account.</b> ${loss}</span></div>
        <p class="zb-hint">This deployment doesn’t offer a recovery guardian yet.</p>`);
    }
    const declined = r.declined ? `<p class="zb-hint">This sign-in chose not to add a guardian${r.declinedAt ? ` on ${esc(fullDate(new Date(r.declinedAt)))}` : ""}. You can add one at any time.</p>` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>No one can recover this account.</b> ${loss}</span></div>${declined}`, setUp);
  }
  return card("acc-rec", "Recovery", `${strangers(r.guardians)}<p class="zb-hint">If the passkey is lost, a guardian can move the account to a new one, after a waiting period in which this sign-in can stop it.</p>${guardianRows(r.guardians)}`, manage);
}

META.access = () => ({
  title: "Access",
  sub: `Who can sign for ${org.name}’s account, and who can recover it.`,
  actions: settingsBack,
});

const retry = (box) => box.querySelector('[data-act="access-retry"]')?.addEventListener("click", () => render({ focus: true }));

RENDER.access = async () => {
  const [me, acc] = await Promise.all([ensureMe(), api(`/api/orgs/${org.id}/accounts`).then((r) => r.accounts, () => null)]);
  // Every role reads the accounts, so a failed read is a failure, not a no.
  if (isCompanyLogin(me) && org.type === "business" && !acc) {
    return {
      html: card("acc-err", "Access", `<p class="zb-hint">Couldn’t read this organisation’s accounts, so Zold can’t tell whether they spend from this sign-in’s account.</p>`,
        `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`),
      bind: retry,
    };
  }
  if (!isOwnCompanyOrg(me, org, acc)) {
    return card("acc-member", "Managed by the company’s sign-in", `<p>Only the company’s own sign-in can see and change who can sign for this account and who can recover it. Ask the person who holds it.</p>
      <p class="zb-hint">Your own passkey and recovery are in the app.</p>`,
      `<a class="z-btn z-btn--secondary z-btn--sm" href="/app?from=business#security">Your sign-in and recovery${Z.icon("open_in_new")}<span class="z-sr"> (the app)</span></a>`);
  }
  const a = await loadAccess(me, api);
  if (a.noSafe) return card("acc-none", "No account yet", `<p class="zb-hint">This sign-in’s account isn’t deployed yet, so there are no signers or guardians to show. Finish setting it up in the app.</p>`, appBtn("Open the app", "/app"));
  return {
    html: `<div class="zb-stack" style="gap:16px"><p class="zb-hint">Read from the chain on every visit.</p>${signersCard(a)}${recoveryCard(a.recovery)}</div>`,
    bind: retry,
  };
};
