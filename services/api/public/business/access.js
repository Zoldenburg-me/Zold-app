/**
 * Settings → Access, one screen: who approves payments (every member; owners
 * turn the second approval on and off here), then who can sign for the
 * company login's account and who can recover it, read from the chain on
 * every visit (access-model.js). Those two only the company login sees, and
 * only in its own company; another member is told who does. Signer and
 * recovery changes open the app's own screen on the same sign-in (APP_LINKS).
 */
import { Z, api, cap, day, deviceLib, ensureMe, esc, org, readHealth, reviewOn, roleCan, ROLE_WORD } from "./core.js";
import { META, RENDER } from "./views.js";
import { render } from "./shell.js";
import { APP_LINKS, approvalView, deviceKeyView, isCompanyLogin, isCompanyOrg, isOwnCompanyOrg, loadAccess, loadOrgRecovery, loadOrgSafe, ORG_RECOVERY, ORG_RECOVERY_NOT_OFFERED, ORG_RECOVERY_UNARMED } from "./access-model.js";

const settingsBack = `<a class="z-btn z-btn--secondary" href="?view=settings" data-view-link="settings">${Z.icon("arrow_back")}<span>Settings</span></a>`;
const appBtn = (label, href, variant = "secondary") =>
  `<a class="z-btn z-btn--${variant} z-btn--sm" href="${esc(href)}">${esc(label)}${Z.icon("open_in_new")}<span class="z-sr"> (the app)</span></a>`;
const fullDate = (d) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);

function card(id, title, body, action = "") {
  return `<section class="z-card zb-pad zb-stack" style="gap:14px" aria-labelledby="${id}">
    <div class="zb-side-card__head"><h2 id="${id}">${esc(title)}</h2>${action}</div>${body}</section>`;
}
/* An address shortened, the whole of it in the tooltip and on the copy button. */
const short = (a) => (String(a).length > 14 ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : String(a));
const addrChip = (a) => `<span class="zb-acc-addr"><span class="z-mono" title="${esc(a)}" translate="no">${esc(short(a))}</span><button type="button" class="zb-acc-copy" data-act="copy-text" data-text="${esc(a)}" data-said="Address copied" aria-label="Copy the address ${esc(a)}">${Z.icon("content_copy")}</button></span>`;
/* One named thing on the account: an icon, what it is, what it means, and its state. `title`, `sub` and `right` are HTML. */
const item = ({ icon, tone = "n", title, sub = "", right = "" }) => `<li class="zb-acc-item">${Z.iconTile({ icon, tone })}
  <span class="z-row__main"><span class="zb-acc-item__title">${title}</span>${sub ? `<span class="z-row__sub">${sub}</span>` : ""}</span>${right ? `<span class="zb-acc-item__right">${right}</span>` : ""}</li>`;
const items = (list) => `<ul class="zb-acc-items">${list.join("")}</ul>`;
const safeLink = (url, label = "Open in Safe{Wallet}") => (url ? `<a class="z-btn z-btn--secondary z-btn--sm" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}${Z.icon("open_in_new")}</a>` : "");

/* This browser's payment key (device.js), the way the app's Security screen says it. */
async function deviceKeyRow(me) {
  let status = null;
  try {
    status = (await deviceLib()).keyStatus(me.passkey?.credentialId, me.authorizerAddress);
  } catch { /* unread: said as unknown */ }
  return {
    none: "Not set up yet",
    unknown: "Couldn’t check this browser",
    elsewhere: "On another device",
    encrypted: `In this browser, protected by your ${esc(Z.passkeyName())}`,
    plain: `<b>In this browser, not encrypted.</b> Your ${esc(Z.passkeyName())} here can’t encrypt it. Don’t use Zold in this browser on a shared computer.`,
  }[deviceKeyView(me, status)];
}

function signersCard(a, keyRow) {
  const change = appBtn("Change in the app", APP_LINKS.signers);
  const title = "Who signs for the account";
  if (!a.signers) {
    return card("acc-sign", title, `<p class="zb-hint">Couldn’t read who signs for the account (${esc(a.signersError.replace(/[.\s]+$/, ""))}). Open Access again to retry.</p>`, change);
  }
  const s = a.signers;
  const pass = esc(Z.passkeyName());
  const mine = s.owners.find((o) => o.kind === "passkey");
  const others = s.owners.filter((o) => o.kind !== "passkey");
  const why = !s.passkeyIsOwner
    ? "This sign-in no longer signs for the account, so it can’t send anything."
    : `It needs ${esc(s.needed)} signatures, and Zold never collects another signer’s.`;
  const locked = s.zoldCanSend ? "" : `<div class="banner warn">${Z.icon("lock")}<span><b>Zold can’t send from this account.</b> ${why} Send from Safe{Wallet} instead.</span></div>`;
  const list = [
    item({ icon: "account_balance", title: "Company Zold account", sub: `The account itself. Money sits here; the keys below sign for it. ${addrChip(s.safeAddress)}`, right: safeLink(s.safeAppUrl) }),
    mine
      ? item({ icon: "fingerprint", tone: "m", title: `Your ${pass}`, sub: `This sign-in, on your device. It approves every payment. ${addrChip(mine.address)}`, right: Z.tag("Signs", "mint") })
      : item({ icon: "fingerprint", tone: "a", title: `Your ${pass}`, sub: "This sign-in no longer signs for the account.", right: Z.tag("Not a signer", "amber") }),
    ...(others.length
      ? others.map((o, i) => item({ icon: "key", tone: "m", title: others.length > 1 ? `Other signer ${i + 1}` : "Backup key", sub: `A key added in Safe{Wallet}. ${addrChip(o.address)}`, right: Z.tag("Signs", "mint") }))
      : [item({ icon: "key", tone: "a", title: "No backup key", sub: `A second key you keep somewhere safe, so the account isn’t lost with this ${pass}.`, right: appBtn("Add", APP_LINKS.signers) })]),
    item({ icon: "devices", title: "Payment key in this browser", sub: keyRow }),
  ];
  const head = `<div class="zb-actions" style="margin-top:0">${Z.tag(`${s.needed} to sign`)}${change}</div>`;
  return card("acc-sign", title, `${locked}${items(list)}`, head);
}

/* A company org's own Safe, read from chain on every visit. */
const OWNER_NOTE = {
  passkey_changed: "This login’s passkey changed; the Safe still lists the old signer",
  not_an_owner: "No longer an owner here; the Safe still lists their key",
  added_outside_zold: "Added outside Zold",
};
function orgSignersCard(s) {
  const title = "Who can sign for the account";
  if (s.status === "not_set_up") return card("acc-sign", title, `<p class="zb-hint">The company’s Safe isn’t set up yet, so no one signs for it.</p>`);
  if (s.status === "unknown") {
    return card("acc-sign", title, `<div class="banner warn">${Z.icon("help")}<span><b>Couldn’t check who can sign.</b> ${esc(s.error.replace(/[.\s]+$/, ""))}. This is not the same as no one.</span></div>`,
      `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`);
  }
  const owner = (o) => o.memberId
    ? item({ icon: "fingerprint", tone: o.note ? "a" : "m", title: esc(o.name || "A member"), sub: `${o.note ? `${esc(OWNER_NOTE[o.note] || o.note)}. ` : "Signs with their passkey. "}${addrChip(o.address)}`, right: Z.tag("Signs", o.note ? "amber" : "mint") })
    : item({ icon: "warning", tone: "a", title: "Unknown signer", sub: `Not added in Zold, and it signs like any other. If no one at the company added it, remove it in Safe{Wallet}. ${addrChip(o.address)}`, right: Z.tag("Signs", "amber") });
  const waiting = s.members.filter((m) => !m.onChain).map((m) => item({ icon: "person", title: esc(m.name || "An owner"), sub: m.passkey ? "Not a signer yet" : "No passkey yet", right: Z.tag("Waiting") }));
  const account = item({ icon: "account_balance", title: "Company account", sub: `The company’s own Safe. ${addrChip(s.safeAddress)}` });
  return card("acc-sign", title, items([account, ...s.owners.map(owner), ...waiting]), Z.tag(`${s.needed} to sign`));
}

/* A company org's own Safe's recovery, read from chain on every visit. */
function orgRecoveryCard(r, yours) {
  const lines = (ls) => ls.map((l) => `<p>${esc(l)}</p>`).join("");
  const others = r.otherGuardians?.length
    ? items(r.otherGuardians.map((a) => item({ icon: "warning", tone: "a", title: "Unknown recovery address", sub: `Not added in Zold. It can start a recovery that replaces every signer of the company’s Safe. If no one at the company added it, remove it in Safe{Wallet}. ${addrChip(a)}` })))
    : "";
  if (r.status === "unknown") {
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("help")}<span><b>Couldn’t check recovery.</b> ${esc(r.error.replace(/[.\s]+$/, ""))}. This is not the same as none.</span></div>`,
      `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`);
  }
  if (r.status === "pending") {
    const until = r.pending?.executeAfter ? ` It can complete after ${esc(fullDate(new Date(r.pending.executeAfter * 1000)))}.` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>A recovery is under way on the company’s Safe.</b> It would replace every signer.${until} If no one at the company started it, contact support@zoldhq.com now: Zold can’t cancel it from here yet.</span></div>${others}`, yours);
  }
  if (r.status === "unarmed") return card("acc-rec", "Recovery", `${others}${lines(ORG_RECOVERY_UNARMED)}`, yours);
  if (!r.offered) return card("acc-rec", "Recovery", `${others}${lines(ORG_RECOVERY_NOT_OFFERED)}`, yours);
  const queued = r.queued ? `<p class="zb-hint">Adding Zoldenburg UG as the guardian is queued and waiting for the owners’ signatures. Zold Business has no screen to sign it yet.</p>` : "";
  // Owners only, as the API refuses anyone else (POST …/recovery/guardian).
  const setUp = r.canSetUp && org.role === "owner"
    ? `<div class="zb-actions" style="margin-top:0"><button type="button" class="z-btn z-btn--primary z-btn--sm" data-act="org-recovery-setup">Set up recovery</button>${yours}</div>`
    : yours;
  return card("acc-rec", "Recovery", `${others}${lines(ORG_RECOVERY)}${queued}`, setUp);
}

const guardianItem = (g, safeUrl) => {
  if (g.kind === "zoldenburg") return item({ icon: "verified_user", tone: "m", title: "Zoldenburg UG", sub: "Checks the person against Monerium’s identity check, and approves from a hardware wallet. Zold’s servers never hold that key.", right: Z.tag("On") });
  if (g.kind === "social") return item({ icon: "account_circle", tone: "m", title: "Your recovery login", sub: `Sign in with the Google, Apple or email login you set up to move the account to a new ${esc(Z.passkeyName())}. ${addrChip(g.address)}`, right: Z.tag("On") });
  if (g.kind === "codes") return item({ icon: "sms", tone: "m", title: "Email or phone codes", sub: esc(g.channels.map((c) => `${c.channel === "sms" ? "Phone" : "Email"} ${c.target}`).join(", ") || "Codes sent to the registered contacts"), right: Z.tag("On") });
  return item({
    icon: "warning", tone: "a", title: "Unknown recovery address",
    sub: `Not added in Zold. It could start a recovery that replaces your ${esc(Z.passkeyName())}, and you could only stop it during the waiting period. If no one at the company added it, remove it. ${addrChip(g.address)}`,
    right: safeLink(safeUrl, "Remove in Safe{Wallet}"),
  });
};
const guardianItems = (guardians, safeUrl) => items(guardians.map((g) => guardianItem(g, safeUrl)));

function recoveryCard(r, safeUrl) {
  const setUp = appBtn("Set up recovery", APP_LINKS.recovery, "primary");
  const manage = appBtn("Manage in the app", APP_LINKS.recovery);
  if (r.status === "pending") {
    const until = r.pending?.executeAfter ? ` It can complete after ${esc(fullDate(new Date(r.pending.executeAfter * 1000)))}.` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>A recovery is under way on this sign-in.</b> It would replace the sign-in that approves for the company’s account.${until} If no one at the company started it, stop it now.</span></div>`,
      appBtn("Check it", APP_LINKS.alert, "primary"));
  }
  if (r.status === "unknown") {
    const read = r.guardians.length ? `<p class="zb-hint">Found on the account:</p>${guardianItems(r.guardians, safeUrl)}` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("help")}<span><b>Couldn’t check recovery.</b> Zold couldn’t read every recovery helper, so it can’t say whether a recovery is under way. This is not the same as none.</span></div>${read}`,
      `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`);
  }
  if (r.status === "none") {
    const loss = "If this sign-in’s key is lost, Zoldenburg UG cannot recover the company’s account. Only the euro balance can be reclaimed, from Monerium.";
    if (!r.offered) {
      return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>No one can recover this account.</b> ${loss}</span></div>
        <p class="zb-hint">This deployment doesn’t offer a recovery helper yet.</p>`);
    }
    const declined = r.declined ? `<p class="zb-hint">This sign-in chose not to add a recovery helper${r.declinedAt ? ` on ${esc(fullDate(new Date(r.declinedAt)))}` : ""}. You can add one at any time.</p>` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>No one can recover this account.</b> ${loss}</span></div>${declined}`, setUp);
  }
  return card("acc-rec", "Recovery", `<p class="zb-hint">If your ${esc(Z.passkeyName())} is lost, a recovery helper can move the account to a new one, after a waiting period in which this sign-in can stop it.</p>${guardianItems(r.guardians, safeUrl)}`, manage);
}

/* What each role may do with a payment, said from roleCan, the table the
   rest of the console reads. A company's owners sign; elsewhere the payer sends. */
const verbs = () => [["propose", "drafts", "draft"], ["approve", "approves", "approve"],
  org?.entity === "company" ? ["sign", "signs", "sign"] : ["sign", "sends", "send"]];
const joined = (ws, conj) => (ws.length > 1 ? `${ws.slice(0, -1).join(", ")} ${conj} ${ws.at(-1)}` : ws[0] || "");
function roleSentence(role) {
  const vs = verbs();
  const yes = joined(vs.filter(([k]) => roleCan(role, k)).map(([, does]) => does), "and");
  const no = joined(vs.filter(([k]) => !roleCan(role, k)).map(([, , verb]) => verb), "or");
  const first = yes ? `${yes.charAt(0).toUpperCase()}${yes.slice(1)} payments.` : "Sees payments.";
  return `${first}${no ? ` Can’t ${no}.` : ""}`;
}

/* Second approval is Zold's rule, checked by Zold's API, not by the Safe,
   so the words never claim more. */
/* What each role may do, as a table: one column per verb, from roleCan. */
function roleMatrix() {
  const vs = verbs();
  const mark = (yes) => (yes ? `${Z.icon("check", "zb-acc-yes")}<span class="z-sr">Yes</span>` : `<span class="zb-acc-no" aria-hidden="true">–</span><span class="z-sr">No</span>`);
  return `<table class="zb-acc-matrix"><caption class="z-sr">What each role can do with a payment</caption>
    <thead><tr><th scope="col">Role</th>${vs.map(([, , verb]) => `<th scope="col">${esc(verb.charAt(0).toUpperCase() + verb.slice(1))}</th>`).join("")}</tr></thead>
    <tbody>${Object.keys(ROLE_WORD).map((r) => `<tr><th scope="row">${esc(ROLE_WORD[r])}</th>${vs.map(([k]) => `<td>${mark(roleCan(r, k))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function approvalsCard(members) {
  const on = reviewOn();
  const offered = cap("transfers.approvals").allowed;
  const pr = org.paymentReview || {};
  const v = approvalView(members, (r) => roleCan(r, "approve"));
  const second = on
    ? "A payment isn’t sent until someone other than its drafter approves it, whatever their role. Editing someone’s draft makes you its drafter. Zold checks this rule; the account on chain does not."
    : offered
      ? `Payments are sent with the sender’s ${Z.passkeyName()}, without a second approval.`
      : "Payments are sent with the sender’s passkey. A second approval is part of a business account.";
  const notes = [
    pr.source === "owner" && pr.changedAt ? `${on ? "Turned on" : "Turned off"} by an owner on ${day(pr.changedAt)}.` : "",
    !on && pr.source === "owner" ? "Payments already waiting for review still wait until someone approves them." : "",
  ].filter(Boolean).map((t) => `<p class="zb-hint">${esc(t)}</p>`).join("");
  const name = (m) => (m.id === org.memberId ? "You" : m.name || m.email || "A member");
  const person = (m) => `<li class="zb-acc-person">${Z.avatar({ name: m.name || m.email || "?" })}<span><b>${esc(name(m))}</b><small>${esc(ROLE_WORD[m.role] || m.role)}</small></span></li>`;
  const approvers = !v ? `<p class="zb-hint">Couldn’t read the members. Open Access again to retry.</p>`
    : v.approvers.length ? `<ul class="zb-acc-people">${v.approvers.map(person).join("")}</ul>` : `<p class="zb-hint">No one</p>`;
  const toggle = org.role !== "owner" ? ""
    : on ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="review-off">Turn off</button>`
      : offered ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="review-on">Turn on</button>` : "";
  const membersLink = cap("members.manage").allowed ? `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=members" data-view-link="members">Members</a>` : "";
  const body = `<div class="zb-acc-switch">${Z.iconTile({ icon: on ? "group" : "person", tone: on ? "m" : "n" })}
      <div class="z-row__main"><span class="zb-acc-item__title">Second approval ${Z.tag(on ? "On" : "Off")}</span><span class="z-row__sub">${esc(second)}</span></div>${toggle}</div>
    ${notes}
    <h3 class="zb-acc-sub">Can approve</h3>${approvers}
    ${v ? `<p class="zb-hint">${v.owners} active owner${v.owners === 1 ? "" : "s"}. An organisation always keeps at least one owner.</p>` : ""}
    <h3 class="zb-acc-sub">What each role can do</h3>${roleMatrix()}`;
  return card("acc-pay", "Who approves payments", body, membersLink);
}

META.access = () => ({
  title: "Access",
  sub: `Who approves payments from ${org.name}’s account, who can sign for it, and who can recover it.`,
  actions: settingsBack,
});

const retry = (box) => box.querySelector('[data-act="access-retry"]')?.addEventListener("click", () => render({ focus: true }));

const stack = (cards) => `<div class="zb-stack" style="gap:16px">${cards.join("")}</div>`;

RENDER.access = async () => {
  const [me, acc, members] = await Promise.all([
    ensureMe(),
    api(`/api/orgs/${org.id}/accounts`).then((r) => r.accounts, () => null),
    api(`/api/orgs/${org.id}/members`).then((r) => r.members, () => null),
  ]);
  const pay = approvalsCard(members);
  const yours = `<a class="z-btn z-btn--secondary z-btn--sm" href="/app?from=business#security">Your sign-in and recovery${Z.icon("open_in_new")}<span class="z-sr"> (the app)</span></a>`;
  if (isCompanyOrg(org)) {
    const [safe, rec] = await Promise.all([loadOrgSafe(org.id, api), loadOrgRecovery(org.id, api)]);
    return { html: stack([pay, orgSignersCard(safe), orgRecoveryCard(rec, yours)]), bind: retry };
  }
  // Every role reads the accounts, so a failed read is a failure, not a no.
  if (isCompanyLogin(me) && org.type === "business" && !acc) {
    return {
      html: stack([pay, card("acc-err", "Sign-in and recovery", `<p class="zb-hint">Couldn’t read this organisation’s accounts, so Zold can’t tell whether they spend from this sign-in’s account.</p>`,
        `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`)]),
      bind: retry,
    };
  }
  if (org.type === "personal") return stack([pay, card("acc-member", "Sign-in and recovery", `<p class="zb-hint">Your sign-in and recovery are in the app.</p>`, yours)]);
  if (!isOwnCompanyOrg(me, org, acc)) {
    return stack([pay, card("acc-member", "Sign-in and recovery", `<p>Only the company’s own sign-in can see and change who can sign for the company’s account and who can recover it. Ask the person who holds it.</p>
      <p class="zb-hint">Your own sign-in and recovery are in the app.</p>`, yours)]);
  }
  const [a, keyRow] = await Promise.all([loadAccess(me, api, readHealth), deviceKeyRow(me)]);
  if (a.noSafe) return stack([pay, card("acc-none", "No account yet", `<p class="zb-hint">This sign-in’s account isn’t set up yet, so there are no signers or recovery helpers to show. Finish setting it up in the app.</p>`, appBtn("Open the app", "/app"))]);
  return { html: stack([pay, signersCard(a, keyRow), recoveryCard(a.recovery, a.signers?.safeAppUrl)]), bind: retry };
};
