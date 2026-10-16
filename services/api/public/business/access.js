/**
 * Settings → Access, one screen: who approves payments (every member; owners
 * turn the second approval on and off here), then who can sign for the
 * company login's account and who can recover it, read from the chain on
 * every visit (access-model.js). Those two only the company login sees, and
 * only in its own company; another member is told who does. Signer and
 * recovery changes open the app's own screen on the same sign-in (APP_LINKS).
 */
import { Z, api, cap, day, ensureMe, esc, org, reviewOn, ROLE_CAN, ROLE_WORD } from "./core.js";
import { META, RENDER } from "./views.js";
import { render } from "./shell.js";
import { APP_LINKS, approvalView, deviceKeyView, isCompanyLogin, isOwnCompanyOrg, loadAccess } from "./access-model.js";

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

/* This browser's payment key (device.js), the way the app's Security screen says it. */
async function deviceKeyRow(me) {
  let status = null;
  try { status = (await window.__deviceLib).keyStatus(me.passkey?.credentialId, me.authorizerAddress); } catch { /* unread: said as not here */ }
  return {
    none: "Not set up yet",
    elsewhere: "On another device",
    encrypted: `In this browser, encrypted by your ${esc(Z.passkeyName())}`,
    plain: `<b>In this browser, not encrypted.</b> Your ${esc(Z.passkeyName())} here can’t encrypt it. Don’t use Zold in this browser on a shared computer.`,
  }[deviceKeyView(me, status)];
}

function signersCard(a, keyRow) {
  const change = appBtn("Change in the app", APP_LINKS.signers);
  if (!a.signers) {
    return card("acc-sign", "Who can sign for the account", `<p class="zb-hint">Couldn’t read who can sign for the account (${esc(a.signersError.replace(/[.\s]+$/, ""))}). Open Access again to retry.</p>`, change);
  }
  const s = a.signers;
  const list = [
    ["Account", addr(s.safeAddress)],
    ["This sign-in", s.passkeyIsOwner ? "Signs for the account" : "Doesn’t sign for the account"],
    [s.otherOwners.length > 1 ? "Other signers" : "Backup key", s.otherOwners.length ? s.otherOwners.map(addr).join("<br>") : "None"],
    ["Signatures needed", esc(s.needed)],
    ["Payment key", keyRow],
  ];
  const why = !s.passkeyIsOwner
    ? "This sign-in no longer signs for the account, so it can’t send anything."
    : `It needs ${esc(s.needed)} signatures, and Zold never collects another signer’s.`;
  const locked = s.zoldCanSend ? "" : `<div class="banner warn">${Z.icon("lock")}<span><b>Zold can’t send from this account.</b> ${why} Send from Safe{Wallet} instead.</span></div>`;
  const safe = s.safeAppUrl ? `<p class="zb-hint"><a href="${esc(s.safeAppUrl)}" target="_blank" rel="noopener">Open the account in Safe{Wallet}</a></p>` : "";
  return card("acc-sign", "Who can sign for the account", `${locked}${rows(list)}${safe}`, change);
}

const guardianRow = (g) => {
  if (g.kind === "zoldenburg") return ["Zoldenburg UG", "Checks the person against Monerium’s identity check, and approves from a hardware wallet. Zold’s servers never hold that key."];
  if (g.kind === "codes") return ["Email or phone codes", esc(g.channels.map((c) => `${c.channel === "sms" ? "Phone" : "Email"} ${c.target}`).join(", ") || "Codes sent to the registered contacts")];
  return ["Not set up in Zold", addr(g.address)];
};
const guardianRows = (guardians) => rows(guardians.map(guardianRow));
/* A guardian Zold did not set up can start a recovery like any other. */
const strangers = (guardians) => guardians.some((g) => g.kind === "other")
  ? `<div class="banner warn">${Z.icon("warning")}<span><b>A recovery helper Zold didn’t set up is on this account.</b> It can start a recovery that would replace this sign-in. If no one at the company added it, remove it in Safe{Wallet}.</span></div>`
  : "";

function recoveryCard(r) {
  const setUp = appBtn("Set up recovery", APP_LINKS.recovery, "primary");
  const manage = appBtn("Manage in the app", APP_LINKS.recovery);
  if (r.status === "pending") {
    const until = r.pending?.executeAfter ? ` It can complete after ${esc(fullDate(new Date(r.pending.executeAfter * 1000)))}.` : "";
    return card("acc-rec", "Recovery", `<div class="banner warn">${Z.icon("warning")}<span><b>A recovery is under way on this sign-in.</b> It would replace the sign-in that approves for the company’s account.${until} If no one at the company started it, stop it now.</span></div>`,
      appBtn("Check it", APP_LINKS.alert, "primary"));
  }
  if (r.status === "unknown") {
    const read = r.guardians.length ? `${strangers(r.guardians)}<p class="zb-hint">Found on the account:</p>${guardianRows(r.guardians)}` : "";
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
  return card("acc-rec", "Recovery", `${strangers(r.guardians)}<p class="zb-hint">If the sign-in key is lost, a recovery helper can move the account to a new one, after a waiting period in which this sign-in can stop it.</p>${guardianRows(r.guardians)}`, manage);
}

/* What each role may do with a payment, said from ROLE_CAN, the table the
   rest of the console reads. */
const VERBS = [["propose", "drafts", "draft"], ["approve", "approves", "approve"], ["send", "sends", "send"]];
const joined = (ws, conj) => (ws.length > 1 ? `${ws.slice(0, -1).join(", ")} ${conj} ${ws.at(-1)}` : ws[0] || "");
function roleSentence(role) {
  const can = ROLE_CAN[role] || {};
  const yes = joined(VERBS.filter(([k]) => can[k]).map(([, does]) => does), "and");
  const no = joined(VERBS.filter(([k]) => !can[k]).map(([, , verb]) => verb), "or");
  const first = yes ? `${yes.charAt(0).toUpperCase()}${yes.slice(1)} payments.` : "Sees payments.";
  return `${first}${no ? ` Can’t ${no}.` : ""}`;
}

/* Second approval is Zold's rule, checked by Zold's API: the Safe itself
   needs only the passkey, so the words never claim more. */
function approvalsCard(members) {
  const on = reviewOn();
  const offered = cap("transfers.approvals").allowed;
  const pr = org.paymentReview || {};
  const v = approvalView(members, (r) => Boolean(ROLE_CAN[r]?.approve));
  const second = on
    ? `<b>On.</b> Zold won’t send a payment until someone other than its drafter approves it, whatever their role. Editing someone’s draft makes you its drafter. This is a Zold rule. On chain the account needs only its passkey.`
    : offered
      ? `<b>Off.</b> A payment is saved, then sent with the sender’s ${esc(Z.passkeyName())}, without a second approval.`
      : "A payment is saved, then sent with the sender’s passkey. A second approval is part of a business account.";
  const notes = [
    pr.source === "owner" && pr.changedAt ? `${on ? "Turned on" : "Turned off"} by an owner on ${day(pr.changedAt)}.` : "",
    !on && pr.source === "owner" ? "Payments already waiting for review still wait until someone approves them." : "",
  ].filter(Boolean).map((t) => `<p class="zb-hint">${esc(t)}</p>`).join("");
  const who = (m) => `${esc(m.id === org.memberId ? "You" : m.name || m.email || "A member")} (${esc(ROLE_WORD[m.role] || m.role)})`;
  const list = [
    ["Second approval", second],
    ["Can approve", !v ? "Couldn’t read the members. Open Access again to retry." : v.approvers.length ? v.approvers.map(who).join("<br>") : "No one"],
    ["Owners", !v ? "" : `${v.owners} active. An organisation always keeps at least one owner.`],
    ...Object.keys(ROLE_WORD).map((r) => [ROLE_WORD[r], esc(roleSentence(r))]),
  ].filter(([, x]) => x);
  const toggle = org.role !== "owner" ? ""
    : on ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="review-off">Turn off</button>`
      : offered ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="review-on">Turn on</button>` : "";
  const membersLink = cap("members.manage").allowed ? `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=members" data-view-link="members">Members</a>` : "";
  return card("acc-pay", "Who approves payments", `${rows(list)}${notes}`, `<div class="zb-actions" style="margin-top:0">${toggle}${membersLink}</div>`);
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
  // Every role reads the accounts, so a failed read is a failure, not a no.
  if (isCompanyLogin(me) && org.type === "business" && !acc) {
    return {
      html: stack([pay, card("acc-err", "Sign-in and recovery", `<p class="zb-hint">Couldn’t read this organisation’s accounts, so Zold can’t tell whether they spend from this sign-in’s account.</p>`,
        `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="access-retry">Try again</button>`)]),
      bind: retry,
    };
  }
  if (!isOwnCompanyOrg(me, org, acc)) {
    return stack([pay, card("acc-member", "Sign-in and recovery", `<p>Only the company’s own sign-in can see and change who can sign for the company’s account and who can recover it. Ask the person who holds it.</p>
      <p class="zb-hint">Your own sign-in and recovery are in the app.</p>`,
      `<a class="z-btn z-btn--secondary z-btn--sm" href="/app?from=business#security">Your sign-in and recovery${Z.icon("open_in_new")}<span class="z-sr"> (the app)</span></a>`)]);
  }
  const [a, keyRow] = await Promise.all([loadAccess(me, api), deviceKeyRow(me)]);
  if (a.noSafe) return stack([pay, card("acc-none", "No account yet", `<p class="zb-hint">This sign-in’s account isn’t set up yet, so there are no signers or recovery helpers to show. Finish setting it up in the app.</p>`, appBtn("Open the app", "/app"))]);
  return { html: stack([pay, signersCard(a, keyRow), recoveryCard(a.recovery)]), bind: retry };
};
