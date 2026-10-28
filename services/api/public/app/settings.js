/**
 * Settings from design/ui-v2 (build step 7): Settings, Security and Coming
 * soon. Recovery, documents, signers and Monerium keys are still the
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
 * - Coming soon lists only what this deployment really can't do yet.
 */

/* This browser's payment key: undefined until device.js answers. */
let phKey;
/* Whose key phKey describes: a recovery or first bind changes the answer. */
let phKeyFor;
function phLoadKey(name) {
  const forWhom = `${credId()}|${user?.authorizerAddress ?? ""}`;
  if (phKeyFor === forWhom) return;
  phKeyFor = forWhom;
  phKey = undefined;
  deviceLib.then((dev) => {
    if (phKeyFor !== forWhom) return;
    try { phKey = dev.keyStatus(credId(), user?.authorizerAddress) || { present: false, protection: null }; } catch { phKey = { present: false, protection: null }; }
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
  const social = (safe.socialGuardians || []).some((g) => g.status === "active");
  const offered = (caps.emailSmsRecovery || caps.zoldenburgRecovery || caps.turnkeyGuardians) && recoveryOfferedFor(u);
  // Zoldenburg added but its 1 € bank check not done: on chain, but no
  // operator may sign for it yet (guardian/enrolment.js). Where the check
  // is not open on this server, no operator may sign for anyone.
  const zoldUnarmed = zold && !u?.zoldenburgArmed;
  return { zold, zoldUnarmed, cr, codes, social, on: (zold && !zoldUnarmed) || codes || social, offered, pending: !zold && cr?.guardianStatus === "pending_setup" };
}

/* Zoldenburg added, bank account not confirmed: can the user do that now?
   The 1 € goes to their Zold IBAN, so not before it is active. */
const phZoldCanFinish = (u) => Boolean(caps.zoldenburgEnrolment && kycApproved(u) && u?.iban);

function phZoldUnarmedText(u, r) {
  const what = !caps.zoldenburgEnrolment ? "Zoldenburg added. Not usable on this server yet."
    : phZoldCanFinish(u) ? "Zoldenburg added. Confirm your bank account to finish."
    : "Zoldenburg added. Your Zold IBAN comes first, then you confirm your bank account.";
  // Codes still protect the account: say so first, or "Active" reads as Zoldenburg's.
  return r.codes ? `Codes to your email or phone. ${what}` : what;
}

/* What Security would flag: an unprotected key, or no way back in. */
function phSecurityChecks() {
  const r = phRecovery(user);
  return (phKeyUnprotected() ? 1 : 0) + (r.offered && !r.on ? 1 : 0);
}

/* ==========================================================================
   Settings
   ========================================================================== */

PH.settings = {
  title: "Settings",
  live: () => JSON.stringify([user?.name, user?.email, user?.monerium?.method, user?.monerium?.connectedAt, user?.paymentPage?.handle, user?.paymentPage?.settlementAsset, user?.paymentPage?.autoConvert,
    phKey?.protection, phSecurityChecks(), user?.privacyBundle?.status, caps.privacyBundle, user?.kycStatus]),
  html() {
    const u = user || {};
    const checks = phSecurityChecks();
    const mon = u.monerium?.method === "api_keys" ? "Connected with your own keys" : hasConnectedMonerium(u) ? "Connected" : "Not connected";
    const bundle = bundleSubscribed(u);
    const account = [
      Z.row({ lead: Z.iconTile({ icon: "person" }), title: "Account", sub: [ownAccountName(u), u.email].filter(Boolean).join(" · "), href: "#account-details" }),
      Z.row({ lead: Z.iconTile({ icon: "shield_lock" }), title: "Security", sub: "Recovery, sign-in, who can approve and spend", right: checks ? Z.tag(`${checks} to check`, "amber") : "", href: "#security" }),
      Z.row({ lead: Z.iconTile({ icon: "currency_exchange" }), title: "Currency and auto-convert", sub: phCurrencyWords(u.paymentPage), href: "#settings/currency" }),
      Z.row({ lead: Z.iconTile({ icon: "description" }), title: "Documents", sub: "Statements and verifiable documents", href: "#documents" }),
    ];
    // Accounting software connects to a space in Zold Business, not here.
    const connections = HAS("monerium") ? [Z.row({ lead: Z.iconTile({ icon: "account_balance" }), title: "Monerium", sub: mon, href: "#monerium-settings" })] : [];
    // The bundle's only entry: where the offer is live and the account may subscribe
    // (the API needs approval), or for an account that holds one.
    const bundleRow = bundle || (caps.privacyBundle === true && kycApproved(u)) ? Z.listGroup({ rows: [Z.row({ lead: Z.iconTile({ icon: "vpn_lock" }), title: "Privacy Bundle", sub: !bundle ? "eSIM and VPN" : u.privacyBundle.status === "active" ? "Active" : "Awaiting partner setup", href: "#bundle" })] }) : "";
    return `${phTop("Settings", "more")}${phMain(`
      ${Z.listGroup({ rows: account })}
      ${connections.length ? `<section class="z-group"><h2 class="z-eyebrow">Connections</h2>${Z.listGroup({ rows: connections })}</section>` : ""}
      ${bundleRow}
      ${Z.button({ full: true, icon: "logout", label: "Sign out", id: "ph-signout" })}
    `)}`;
  },
  bind(root) {
    phLoadKey("settings");
    root.querySelector("#ph-signout").onclick = () => $("btn-signout").click();
  },
};

/* ==========================================================================
   Security
   ========================================================================== */

async function phLoadSigners() {
  // The signers screen's copy follows too, so Home never prefers an older read.
  try { phCache.signers = signersState = await api(`/api/users/${user.id}/safe/signers`); }
  catch (e) { phCache.signers = { error: e.message }; }
  if (phRoute?.name === "security") phRender();
}

function phSignerRows() {
  const s = phCache.signers;
  if (s === undefined) return Z.skeletonRows(3, "Reading who approves payments…");
  // The reason comes from a chain read and names internals; the screen says
  // what failed and where the full view is.
  if (s.error) {
    return Z.listGroup({ rows: [
      `<div class="z-row z-row--empty"><span>We couldn’t read who approves payments right now.</span><button type="button" class="z-link-btn" id="ph-sg-retry">Try again</button></div>`,
      Z.row({ lead: Z.iconTile({ icon: "key" }), title: "Who approves payments", sub: "Approvers, approvals and spending limits", href: "#signers" }),
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
    Z.row({ lead: Z.iconTile({ icon: "draw" }), title: "Approvals needed", sub: sig, href: "#signers" }),
    ...(offerSpenders ? [Z.row({ lead: Z.iconTile({ icon: "person_add" }), title: "People who can spend from your account",
      sub: spenders ? `${spenders} ${spenders === 1 ? "person" : "people"} · ${limits.length} limit${limits.length === 1 ? "" : "s"}` : "None", href: "#signers" })] : []),
  ].map((r) => `<li>${r}</li>`).join("")}</ul>`;
}

PH.security = {
  title: "Security",
  live: () => JSON.stringify([phKey, user?.passkey?.credentialId, user?.authorizerAddress, user?.passkeySafe?.recovery?.status, user?.passkeySafe?.socialGuardians, user?.zoldenburgArmed, caps.zoldenburgEnrolment, user?.iban, user?.kycStatus,
    user?.passkeySafe?.candideRecovery, !!phCache.signers, phCache.signers?.threshold, phCache.signers?.error]),
  html() {
    const u = user || {};
    const r = phRecovery(u);
    const recoveryRows = [];
    // The row goes where the group's action goes: tapping "Not finished"
    // should finish it, not only the small link beside the heading.
    const recoveryAction = r.zoldUnarmed && phZoldCanFinish(u) ? { href: "/guardian", label: "Finish" } : { href: "#recovery-settings", label: r.on || r.zold ? "Change" : "Set up" };
    if (r.offered || r.on || r.cr) {
      recoveryRows.push(Z.row({
        lead: Z.iconTile({ icon: "settings_backup_restore" }),
        title: "Recovery",
        sub: r.zoldUnarmed ? phZoldUnarmedText(u, r) : r.zold ? "Zoldenburg recovery" : r.social ? "Your Google or Apple login is your recovery helper" : r.codes ? "Codes to your email or phone" : r.pending ? "Set up, not on your account yet" : "Not set up. A lost phone means a lost account.",
        right: Z.tag(r.on ? "Active" : r.zoldUnarmed ? (phZoldCanFinish(u) ? "1 step left" : "Not finished") : r.pending ? "Waiting" : "Off", r.on ? "mint" : r.zoldUnarmed ? "amber" : undefined),
        href: recoveryAction.href,
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
        sub: phKey === undefined ? "Checking this phone…" : keyHere ? (phKey.protection === "none" ? "On this phone, not encrypted" : `On this phone, encrypted by your ${Z.passkeyName()}`) : "On another device",
        right: keyHere ? Z.tag(phKey.protection === "none" ? "Not encrypted" : "This device", phKey.protection === "none" ? "amber" : "pink") : "",
        chevron: false,
      });
    return `${phSecurityTop()}${phMain(`
      ${phKeyUnprotected() ? Z.note({ tone: "a", text: `Your payment key is stored unencrypted in this browser: your ${Z.passkeyName()} here can’t encrypt it. The key vouches for what a payment is (amount and payee). On its own it moves nothing: every payment also needs your ${Z.passkeyName()}, which your account checks. Someone with a copy could still vouch for payment terms. Don’t use Zold in this browser on a shared computer, and remove extensions you don’t trust.` }) : ""}
      ${recoveryRows.length ? Z.listGroup({ label: "Recovery", action: recoveryAction, rows: recoveryRows }) : ""}
      ${Z.listGroup({ label: "Sign-in and keys", rows: [
        Z.row({ lead: Z.iconTile({ icon: "fingerprint" }), title: Z.byDevice("Face ID or fingerprint", "Passkey"), sub: u.passkey?.createdAt ? `Signs you in and approves payments. Added ${phDay(u.passkey.createdAt)} ${new Date(u.passkey.createdAt).getFullYear()}` : "Not set up", right: Z.tag(u.passkey?.credentialId ? "Active" : "Off", u.passkey?.credentialId ? "mint" : undefined), chevron: false }),
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
   Coming soon
   ========================================================================== */

async function phLoadSoon() {
  try { phCache.soon = (await api("/api/orgs/currencies")).currencies || []; }
  catch { phCache.soon = []; }
  if (phRoute?.name === "soon") phRender();
}

PH.soon = {
  title: "Coming soon",
  live: () => JSON.stringify([user?.iban, user?.kycStatus, caps.cashRail, phCache.soon?.length]),
  html() {
    const u = user || {};
    const soonTile = Z.iconTile({ icon: "hourglass_top", tone: "a" });
    const later = (phCache.soon || []).filter((c) => !c.available && c.code !== "EUR").map((c) => c.code);
    const rows = [
      ...(!(u.iban && kycApproved(u)) && !bankOffered(u)
        ? [Z.row({ lead: soonTile, title: "IBAN", sub: u.kycStatus === "rejected" ? "Our banking partner can’t onboard you at the moment" : "Not available where you live yet", soon: true })]
        : []),
      ...(!(u.iban && kycApproved(u)) && bankOffered(u)
        ? [`<div class="z-row">${soonTile}<span class="z-row__main"><span class="z-row__title">IBAN</span><span class="z-row__sub">Waiting for Monerium to verify you</span></span><span class="z-row__right">${Z.button({ label: "Check", className: "z-btn--sm", id: "ph-soon-iban" })}</span></div>`]
        : []),
      ...(!caps.cashRail ? [Z.row({ lead: soonTile, title: "Cash pickup", sub: "Opens with a payout partner", soon: true })] : []),
      ...(later.length ? [Z.row({ lead: soonTile, title: "Accounts in other currencies", sub: `${later.length > 1 ? `${later.slice(0, -1).join(", ")} and ${later.at(-1)}` : later[0]}: waiting on an account provider`, soon: true })] : []),
      Z.row({ lead: soonTile, title: "More countries", sub: "Bank transfers reach Europe only, for now", soon: true }),
      Z.row({ lead: soonTile, title: "Sending to a crypto wallet", sub: "Not built yet", soon: true }),
    ];
    return `${phTop("Coming soon", "more")}${phMain(`
      <p class="z-sub">What this account can’t do yet, and why. Each one switches on here as soon as it works.</p>
      ${phCache.soon === null ? Z.skeletonRows(4, "Loading…") : Z.listGroup({ rows })}
    `)}`;
  },
  bind(root) {
    if (phCache.soon === null) phLoadSoon();
    const iban = root.querySelector("#ph-soon-iban");
    if (iban) iban.onclick = () => enterKycReview(user?.name || "Account");
  },
};
