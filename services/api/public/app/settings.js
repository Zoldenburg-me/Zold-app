/**
 * Settings from design/ui-v2 (build step 7): Settings, Security, Plan and
 * Coming soon. Recovery, documents, signers and Monerium keys are still the
 * older #dashboard screens; these rows open them by route.
 *
 * Declarations only: phone.js draws these through the PH registry, and
 * nothing here runs at load. app/main.js stays last.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4, AGENTS.md):
 * - The storage warning shows only when this browser's payment key is kept
 *   without hardware protection (no PRF), as device.js reports it.
 * - There is no list of devices: the API knows one sign-in (the passkey) and
 *   whether this browser holds the payment key. Nothing more is drawn.
 * - Plan has no upgrade button: paid plans are not on sale. The one trial is
 *   offered while it is unused, to whoever may start it (an owner).
 * - Coming soon lists only what this deployment really can't do yet.
 */

/* This browser's payment key: undefined until device.js answers. */
let phKey;
function phLoadKey(name) {
  if (phKey !== undefined) return;
  deviceLib.then((dev) => {
    try { phKey = dev.keyStatus() || { present: false, protection: null }; } catch { phKey = { present: false, protection: null }; }
    if (phRoute?.name === name) phRender();
  });
}
const phKeyUnprotected = () => !!user?.authorizerAddress && phKey?.present && phKey.protection === "none";

/* Recovery as the account records it. */
function phRecovery(u) {
  const safe = u?.passkeySafe || {};
  const zold = safe.recovery?.status === "active";
  const cr = safe.candideRecovery;
  const codes = cr?.guardianStatus === "active";
  const offered = (caps.emailSmsRecovery || caps.zoldenburgRecovery) && recoveryOfferedFor(u);
  // Zoldenburg added but its 1 € bank check not done: on chain, but no
  // operator may sign for it yet (recovery.js zoldEnrolHtml).
  const zoldUnarmed = zold && caps.zoldenburgEnrolment && !u?.zoldenburgArmed;
  return { zold, zoldUnarmed, cr, codes, on: (zold && !zoldUnarmed) || codes, offered, pending: !zold && cr?.guardianStatus === "pending_setup" };
}

/* What Security would flag: an unprotected key, or no way back in. */
function phSecurityChecks() {
  const r = phRecovery(user);
  return (phKeyUnprotected() ? 1 : 0) + (r.offered && !r.on ? 1 : 0);
}

/* The account the plan belongs to: the company the phone acts for, or the
   personal one. */
const phPlanOrg = () => phPersonalOrg();
const phPlanName = (id) => ({ starter: "Starter", premium: "Premium", business: "Business" }[id] || id);
function phTrialLeft(org) {
  const t = org?.trial;
  if (!t?.endsAt || t.endedAt) return 0;
  const ms = Date.parse(t.endsAt) - Date.now();
  return ms > 0 ? Math.ceil(ms / 86400000) : 0;
}
function phPlanWords(org) {
  if (!org) return "";
  const left = phTrialLeft(org);
  if (left) return `${phPlanName(org.trial.grantsPlan)} trial, ${left === 1 ? "1 day" : `${left} days`} left`;
  return org.plan === "starter" ? "Starter, free" : phPlanName(org.effectivePlan || org.plan);
}

/* ==========================================================================
   Settings
   ========================================================================== */

PH.settings = {
  title: "Settings",
  live: () => JSON.stringify([user?.name, user?.email, user?.monerium?.method, user?.paymentPage?.settlementAsset, user?.paymentPage?.autoConvert,
    phKey?.protection, phSecurityChecks(), phCache.orgs?.map((o) => `${o.id}:${o.plan}:${o.trial?.endsAt}`), user?.privacyBundle?.status]),
  html() {
    const u = user || {};
    const checks = phSecurityChecks();
    const mon = u.monerium?.method === "api_keys" ? "Connected with your own keys" : hasConnectedMonerium(u) ? "Connected" : "Not connected";
    const plus = u.privacyBundle && u.privacyBundle.status !== "canceled";
    const account = [
      Z.row({ lead: Z.iconTile({ icon: "person" }), title: "Account", sub: [ownAccountName(u), u.email].filter(Boolean).join(" · "), href: "#account-details" }),
      Z.row({ lead: Z.iconTile({ icon: "shield_lock" }), title: "Security", sub: "Recovery, sign-in, who can sign and spend", right: checks ? Z.tag(`${checks} to check`, "amber") : "", href: "#security" }),
      Z.row({ lead: Z.iconTile({ icon: "currency_exchange" }), title: "Currency and auto-convert", sub: phCurrencyWords(u.paymentPage), href: "#settings/currency" }),
      Z.row({ lead: Z.iconTile({ icon: "description" }), title: "Documents", sub: "Statements and verifiable documents", href: "#documents" }),
    ];
    // Accounting software connects to a space in Zold Business, not here.
    const connections = HAS("monerium") ? [Z.row({ lead: Z.iconTile({ icon: "account_balance" }), title: "Monerium", sub: mon, href: "#monerium-settings" })] : [];
    const plan = [
      Z.row({ lead: Z.iconTile({ icon: "workspace_premium" }), title: "Plan", sub: phCache.orgs === null ? "Loading…" : phPlanWords(phPlanOrg()) || "No plan", href: "#plan" }),
      ...(plus ? [Z.row({ lead: Z.iconTile({ icon: "stars" }), title: "Zold Plus", sub: "Privacy Bundle active", href: "#plus" })] : []),
    ];
    return `${phTop("Settings", "more")}${phMain(`
      ${Z.listGroup({ rows: account })}
      ${connections.length ? `<section class="z-group"><h2 class="z-eyebrow">Connections</h2>${Z.listGroup({ rows: connections })}</section>` : ""}
      ${Z.listGroup({ rows: plan })}
      ${Z.button({ full: true, icon: "logout", label: "Sign out", id: "ph-signout" })}
    `)}`;
  },
  bind(root) {
    phLoadKey("settings");
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "settings") phRender(); });
    root.querySelector("#ph-signout").onclick = () => $("btn-signout").click();
  },
};

/* ==========================================================================
   Security
   ========================================================================== */

async function phLoadSigners() {
  try { phCache.signers = await api(`/api/users/${user.id}/safe/signers`); }
  catch (e) { phCache.signers = { error: e.message }; }
  if (phRoute?.name === "security") phRender();
}

function phSignerRows() {
  const s = phCache.signers;
  if (s === undefined) return Z.skeletonRows(3, "Reading your account’s signers…");
  // The reason comes from a chain read and names internals; the screen says
  // what failed and where the full view is.
  if (s.error) {
    return Z.listGroup({ rows: [
      `<div class="z-row z-row--empty"><span>We couldn’t read who approves payments right now.</span><button type="button" class="z-link-btn" id="ph-sg-retry">Try again</button></div>`,
      Z.row({ lead: Z.iconTile({ icon: "key" }), title: "Who approves payments", sub: "Owners, signatures and spending limits", href: "#signers" }),
    ] });
  }
  const owners = s.owners || [];
  const limits = s.allowance?.limits || [];
  const spenders = new Set(limits.map((l) => String(l.delegate).toLowerCase())).size;
  const sig = `${s.threshold} of ${owners.length}${owners.length === 1 ? ": you alone" : ""}`;
  // Letting someone else spend is offered to people who work with a business
  // (app/signers.js); a spender already on the account is always shown.
  if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "security") phRender(); });
  const offerSpenders = spenders > 0 || (phCache.orgs || []).some((o) => o.type === "business");
  return `<ul class="z-list z-card">${[
    Z.row({ lead: Z.iconTile({ icon: "draw" }), title: "Signatures needed", sub: sig, href: "#signers" }),
    ...(offerSpenders ? [Z.row({ lead: Z.iconTile({ icon: "person_add" }), title: "People who can spend from your account",
      sub: spenders ? `${spenders} ${spenders === 1 ? "person" : "people"} · ${limits.length} limit${limits.length === 1 ? "" : "s"}` : "None", href: "#signers" })] : []),
  ].map((r) => `<li>${r}</li>`).join("")}</ul>`;
}

PH.security = {
  title: "Security",
  live: () => JSON.stringify([phKey, user?.passkey?.credentialId, user?.authorizerAddress, user?.passkeySafe?.recovery?.status, user?.zoldenburgArmed,
    user?.passkeySafe?.candideRecovery, !!phCache.signers, phCache.signers?.threshold, phCache.signers?.error]),
  html() {
    const u = user || {};
    const r = phRecovery(u);
    const recoveryRows = [];
    if (r.offered || r.on || r.cr) {
      recoveryRows.push(Z.row({
        lead: Z.iconTile({ icon: "settings_backup_restore" }),
        title: "Recovery",
        sub: r.zoldUnarmed ? "Zoldenburg added. Confirm your bank account to finish." : r.zold ? "Zoldenburg is your guardian" : r.codes ? "Codes to your email or phone" : r.pending ? "Set up, not on your account yet" : "Not set up. A lost phone means a lost account.",
        right: Z.tag(r.on ? "Active" : r.zoldUnarmed ? "1 step left" : r.pending ? "Waiting" : "Off", r.on ? "mint" : r.zoldUnarmed ? "amber" : undefined),
        chevron: false,
      }));
      for (const c of r.cr?.channels || []) {
        recoveryRows.push(Z.row({
          lead: Z.iconTile({ icon: c.channel === "sms" ? "sms" : "mail" }),
          title: c.channel === "sms" ? "Text message code" : "Email code",
          sub: c.target,
          right: Z.tag(r.codes ? "Active" : "Off", r.codes ? "mint" : undefined),
          chevron: false,
        }));
      }
    }
    const keyHere = phKey?.present;
    const keyRow = !u.authorizerAddress
      ? Z.row({ lead: Z.iconTile({ icon: "key" }), title: "Payment key", sub: "Not set up yet", right: Z.tag("Off"), chevron: false })
      : Z.row({
        lead: Z.iconTile({ icon: "smartphone" }),
        title: "Payment key",
        sub: phKey === undefined ? "Checking this phone…" : keyHere ? (phKey.protection === "none" ? "On this phone, not encrypted" : "On this phone, encrypted by your passkey") : "On another device",
        right: keyHere ? Z.tag(phKey.protection === "none" ? "Not encrypted" : "This device", phKey.protection === "none" ? "amber" : "pink") : "",
        chevron: false,
      });
    return `${phSecurityTop()}${phMain(`
      ${phKeyUnprotected() ? Z.note({ tone: "a", text: "Your payment key is stored unencrypted in this browser: the passkey here can’t encrypt it. The key signs what a payment is (amount and payee). On its own it moves nothing: every payment also needs your Face ID or fingerprint, which your account checks on the chain. Someone with a copy could still sign payment terms. Don’t use Zold in this browser on a shared computer, and remove extensions you don’t trust." }) : ""}
      ${recoveryRows.length ? Z.listGroup({ label: "Recovery", action: { href: "#recovery-settings", label: r.on ? "Change" : r.zoldUnarmed ? "Finish" : "Set up" }, rows: recoveryRows }) : ""}
      ${Z.listGroup({ label: "Sign-in and keys", rows: [
        Z.row({ lead: Z.iconTile({ icon: "fingerprint" }), title: "Face ID or fingerprint", sub: u.passkey?.createdAt ? `Signs you in and approves payments. Added ${phDay(u.passkey.createdAt)} ${new Date(u.passkey.createdAt).getFullYear()}` : "Not set up", right: Z.tag(u.passkey?.credentialId ? "Active" : "Off", u.passkey?.credentialId ? "mint" : undefined), chevron: false }),
        keyRow,
      ] })}
      <section class="z-group"><div class="z-group__head"><h2 class="z-eyebrow">Who approves payments</h2></div>${phSignerRows()}</section>
    `)}`;
  },
  bind(root) {
    phLoadKey("security");
    if (phCache.signers === undefined && user?.id) phLoadSigners();
    const retry = root.querySelector("#ph-sg-retry");
    if (retry) retry.onclick = () => { phCache.signers = undefined; phRender(); phLoadSigners(); };
  },
};

/* ==========================================================================
   Plan
   ========================================================================== */

async function phLoadPlans(type) {
  try { phCache.plans[type] = (await api(`/api/orgs/plans?type=${encodeURIComponent(type)}`)).plans || []; }
  catch { phCache.plans[type] = []; }
}

PH.plan = {
  title: "Plan",
  live: () => JSON.stringify([phCache.orgs?.map((o) => `${o.id}:${o.plan}:${o.effectivePlan}:${o.trial?.endsAt}`), Object.keys(phCache.plans)]),
  html() {
    const org = phPlanOrg();
    if (phCache.orgs === null || (org && !phCache.plans[org.type])) return `${phTop("Plan", "settings")}${phMain(Z.skeletonRows(2, "Loading your plan…"))}`;
    if (!org) return `${phTop("Plan", "settings")}${phMain(Z.note({ tone: "a", text: "We couldn’t load your plan. Try again later." }))}`;
    const plans = phCache.plans[org.type] || [];
    const current = plans.find((p) => p.id === org.plan);
    const paid = org.type === "business" ? "business" : "premium";
    const upgrade = plans.find((p) => p.id === paid);
    const left = phTrialLeft(org);
    const ended = org.trial && !left;
    const owner = org.role === "owner";
    const card = (p, head, tag, extra = "") => `<section class="z-card z-plan${tag ? "" : " z-plan--offer"}" aria-labelledby="ph-plan-${esc(p.id)}">
      <div class="z-plan__head"><span>${esc(head)}</span>${tag || ""}</div>
      <h2 class="z-plan__name" id="ph-plan-${esc(p.id)}">${esc(p.name)}${p.id === "starter" ? ' <span class="z-plan__price">free</span>' : ""}</h2>
      <p class="z-plan__blurb">${esc(phPlain(p.blurb))}</p>${extra}</section>`;
    const who = org.type === "business" ? org.name : "your personal account";
    const trialCard = !upgrade || org.plan === paid ? ""
      : left ? card(upgrade, `Trial for ${who}`, Z.tag(`${left === 1 ? "1 day" : `${left} days`} left`, "pink"),
        `<p class="z-hint">Ends ${esc(phFull(org.trial.endsAt))}. Then paid features pause and nothing is deleted.</p>`)
        : ended ? card(upgrade, "Trial used", "", `<p class="z-hint">The trial ended ${esc(phDay(org.trial.endedAt || org.trial.endsAt))}. Paid plans aren’t on sale during the beta; paid features are paused and nothing was deleted.</p>`)
          : card(upgrade, "Try it free for 30 days", "", `<p class="z-hint">Paid plans aren’t on sale during the beta. When the trial ends, paid features pause and nothing is deleted.</p>`);
    const offer = upgrade && !org.trial && org.plan !== paid;
    return `${phTop("Plan", "settings")}${phMain(`
      ${current ? card(current, "Current plan", Z.tag("Active", "mint")) : ""}
      ${trialCard}
      <p class="z-err" id="ph-plan-err" role="alert" hidden></p>
    `)}${offer ? phFoot(owner
      ? Z.button({ variant: "primary", full: true, label: "Start 30-day trial", id: "ph-plan-trial" })
      : Z.button({ variant: "primary", full: true, label: "Start 30-day trial", disabledReason: "Only an owner can start the trial." })) : ""}`;
  },
  bind(root) {
    if (phCache.orgs === null) { phLoadOrgs().then(() => { if (phRoute?.name === "plan") phRender(); }); return; }
    const org = phPlanOrg();
    if (org && !phCache.plans[org.type]) { phLoadPlans(org.type).then(() => { if (phRoute?.name === "plan") phRender(); }); return; }
    const b = root.querySelector("#ph-plan-trial");
    if (b) b.onclick = async () => {
      if (Z.isDisabled(b)) return;
      Z.setLoading(b, true);
      try {
        await api(`/api/orgs/${encodeURIComponent(org.id)}/plan/trial`, {});
        phCache.orgs = null;
        await phLoadOrgs();
        phRender();
        Z.announce("Trial started");
      } catch (e) {
        Z.setLoading(b, false);
        const err = $("ph-plan-err");
        err.textContent = phPlain(e.message); err.hidden = false;
      }
    };
  },
};

/* ==========================================================================
   Coming soon
   ========================================================================== */

async function phLoadSoon() {
  try { phCache.soon = (await api("/api/orgs/currencies")).currencies || []; }
  catch { phCache.soon = []; }
  if (phRoute?.name === "soon") phRender();
}

PH.soon = {
  title: "Coming soon",
  live: () => JSON.stringify([user?.iban, user?.kycStatus, caps.cashRail, phCache.soon?.length, phCache.orgs?.map((o) => o.effectivePlan), user?.privacyBundle?.status]),
  html() {
    const u = user || {};
    const soonTile = Z.iconTile({ icon: "hourglass_top", tone: "a" });
    const later = (phCache.soon || []).filter((c) => !c.available && c.code !== "EUR").map((c) => c.code);
    const personal = phPersonalOrg();
    const rows = [
      ...(!(u.iban && kycApproved(u))
        ? [`<div class="z-row">${soonTile}<span class="z-row__main"><span class="z-row__title">IBAN</span><span class="z-row__sub">Waiting for Monerium to verify you</span></span><span class="z-row__right">${Z.button({ label: "Check", className: "z-btn--sm", id: "ph-soon-iban" })}</span></div>`]
        : []),
      ...(!caps.cashRail ? [Z.row({ lead: soonTile, title: "Cash pickup", sub: "Opens with a payout partner", soon: true })] : []),
      ...(later.length ? [Z.row({ lead: soonTile, title: "Accounts in other currencies", sub: `${later.length > 1 ? `${later.slice(0, -1).join(", ")} and ${later.at(-1)}` : later[0]}: waiting on an account provider`, soon: true })] : []),
      Z.row({ lead: soonTile, title: "More countries", sub: "Bank transfers reach Europe only, for now", soon: true }),
      Z.row({ lead: soonTile, title: "Sending to a crypto wallet", sub: "Not built yet", soon: true }),
      ...(personal && !phCan(personal, "invoices")
        ? [`<a class="z-row" href="#plan">${soonTile}<span class="z-row__main"><span class="z-row__title">Premium features</span><span class="z-row__sub">Trial only during the beta</span></span><span class="z-row__right"><span class="z-btn z-btn--secondary z-btn--sm" aria-hidden="true">Plan</span></span></a>`]
        : []),
      ...(!(u.privacyBundle && u.privacyBundle.status !== "canceled") ? [Z.row({ lead: soonTile, title: "Zold Plus", sub: "Card, VPN and eSIM in one plan, not on sale yet", href: "#plus" })] : []),
    ];
    return `${phTop("Coming soon", "more")}${phMain(`
      <p class="z-sub">What this account can’t do yet, and why. Each one switches on here as soon as it works.</p>
      ${phCache.soon === null ? Z.skeletonRows(4, "Loading…") : Z.listGroup({ rows })}
    `)}`;
  },
  bind(root) {
    if (phCache.soon === null) phLoadSoon();
    if (phCache.orgs === null) phLoadOrgs().then(() => { if (phRoute?.name === "soon") phRender(); });
    const iban = root.querySelector("#ph-soon-iban");
    if (iban) iban.onclick = () => enterKycReview(user?.name || "Account");
  },
};
