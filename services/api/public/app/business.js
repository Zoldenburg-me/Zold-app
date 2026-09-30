/**
 * The company screens from design/ui-v2 (build step 7): a company's Home, its
 * account details, Send and Get paid, Approvals, Members and the invite.
 *
 * The phone acts for a company once one is chosen in More (`phCompanyId` in
 * app/phone.js). Declarations only: phone.js draws these through the PH
 * registry, and nothing here runs at load. app/main.js stays last.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4, AGENTS.md):
 * - A company has no balance of its own. Its euro account spends from one
 *   member's account (`backingUserId`), so a balance is shown only to that
 *   member, labelled as their own account.
 * - Four eyes: whoever drafted a payment can't approve it, whatever their
 *   role (the API refuses it too). The button stays, disabled, with the reason.
 * - Approve and Send back happen here. Drafting a payment and sending an
 *   approved one happen in the web app, which signs with Face ID or
 *   fingerprint; no signing code is copied into the phone.
 * - There is no mail transport. An invite is a link the inviter shares
 *   themselves; the API returns it once, and this visit keeps it so it can be
 *   copied again until sign-out.
 */

/* ==========================================================================
   Company data
   ========================================================================== */

const phCoPath = (org, rest) => `/api/orgs/${encodeURIComponent(org.id)}${rest}`;

/* Accounts, members and payment drafts of the company the phone acts for.
   Each read fails on its own: a role that can't read one still sees the rest. */
async function phLoadCompany({ force = false } = {}) {
  await phLoadOrgs();
  const co = phCompany();
  if (!co) return null;
  if (!force && phCache.co?.id === co.id) return phCache.co;
  const [acc, mem, dr] = await Promise.allSettled([
    api(phCoPath(co, "/accounts")), api(phCoPath(co, "/members")), api(phCoPath(co, "/drafts")),
  ]);
  if (phCompany()?.id !== co.id) return null;          // switched meanwhile
  phCache.co = {
    id: co.id,
    accounts: acc.status === "fulfilled" ? acc.value.accounts || [] : null,
    members: mem.status === "fulfilled" ? mem.value.members || [] : null,
    drafts: dr.status === "fulfilled" ? dr.value.drafts || [] : null,
    error: [acc, mem, dr].find((r) => r.status === "rejected")?.reason?.message || null,
    at: Date.now(),
  };
  phCache.approvalsWaiting = (phCache.co.drafts || []).filter((d) => d.state === "PENDING_REVIEW" && phMayReview(co, d).allowed).length;
  return phCache.co;
}

/* Load once, then again when older than 20 seconds; redraw the named screen. */
function phCoFreshen(name) {
  const stale = !phCache.co || phCache.co.id !== phCompanyId || Date.now() - phCache.co.at > 20000;
  if (stale) phLoadCompany({ force: true }).then(() => { if (phRoute?.name === name) phRender(); });
}

const phCoSig = () => JSON.stringify([phCompanyId, phCache.orgs === null, phCache.co?.id, phCache.co?.error,
  phCache.co?.accounts?.map((a) => `${a.id}:${a.status}:${a.profile?.status}`),
  phCache.co?.members?.map((m) => `${m.id}:${m.role}:${m.status}`),
  phCache.co?.drafts?.map((d) => `${d.id}:${d.state}:${d.updatedAt}`)]);

/* The company's euro account: the one a bank transfer reaches. */
const phCoAccount = () => (phCache.co?.accounts || []).find((a) => a.currency === "EUR") || null;

/* What a role may do with payments, as domain/roles.ts grants it. */
const PH_ROLE_CAN = {
  owner: { propose: true, approve: true, send: true, invite: true },
  admin: { propose: true, approve: true, send: true, invite: true },
  payer: { propose: true, approve: false, send: true, invite: false },
  accountant: { propose: true, approve: false, send: false, invite: false },
  viewer: { propose: false, approve: false, send: false, invite: false },
};
const phRoleCan = (role, what) => !!PH_ROLE_CAN[role]?.[what];

/* Four eyes, as canReviewDraft says it. */
function phMayReview(co, d) {
  if (!phRoleCan(co.role, "approve")) return { allowed: false, reason: `As ${phRoleWord(co.role).toLowerCase()} you can’t approve payments. An owner or admin can.` };
  if (d.createdByMemberId === co.memberId) return { allowed: false, reason: "You drafted this, so someone else has to approve it." };
  return { allowed: true };
}

const phMemberName = (id) => {
  const co = phCompany();
  if (id && id === co?.memberId) return "you";
  const m = (phCache.co?.members || []).find((x) => x.id === id);
  return m?.name || m?.email || "another member";
};

/* An amount in a draft: a decimal string in the line's asset. */
function phDraftMoney(amount, asset) {
  const n = Number(amount);
  return /^EUR/i.test(String(asset || "")) ? phEur(n) : Z.formatMoney(n, asset);
}

/* ==========================================================================
   Company Home
   ========================================================================== */

const phInitialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

/* The company's name, as the switcher. */
function phCoHead(co) {
  return `<h1 class="z-sr">${esc(co.name)}</h1><header class="z-apphead">
    <button type="button" class="z-apphead__switch" id="ph-co-switch" aria-haspopup="dialog">
      <span class="z-tile z-tile--txt" aria-hidden="true">${esc(phInitialsOf(co.name))}</span>
      <span class="z-row__main"><span class="z-row__title">${esc(co.name)}</span><span class="z-row__sub">Business · you are ${esc(phRoleWord(co.role).toLowerCase())}</span></span>
      ${Z.icon("expand_more", "z-row__chev")}<span class="z-sr">Switch account</span>
    </button>
  </header>`;
}

function phCoChecklist(co) {
  const acct = phCoAccount();
  const members = (phCache.co?.members || []).filter((m) => m.status !== "deactivated");
  const verified = acct?.profile?.status === "verified";
  const ibanLive = acct?.status === "active" && !!acct.identifier?.iban;
  const canInvite = phRoleCan(co.role, "invite") && phCan(co, "members.manage");
  const items = [
    { title: "Company account created", sub: co.role === "owner" ? "You’re an owner." : `You joined as ${phRoleWord(co.role).toLowerCase()}.`, done: true },
    { title: "Your Face ID sign-in", sub: "This phone approves payments.", done: !!user?.passkey?.credentialId },
    { title: "Verify the company", sub: verified ? "Monerium confirmed the company." : "Register extract and owners, with Monerium.",
      done: verified, action: phRoleCan(co.role, "invite") ? { href: phWebHref("accounts"), org: co.id, label: "Start" } : null },
    ...(phCache.co?.members
      ? [{ title: "Invite your team", sub: members.length > 1 ? `${members.length} people, invited or joined.` : "You share the invite link yourself.",
        done: members.length > 1, action: canInvite ? { id: "ph-co-invite", label: "Invite" } : null }]
      : []),
    { title: "Approval rules", sub: phCan(co, "transfers.approvals") ? "Someone other than the drafter approves each payment." : "Needs the Business plan.",
      done: phCan(co, "transfers.approvals"), action: { href: "#plan", label: "Plan" } },
    { title: "Company IBAN active", sub: ibanLive ? "Ready to receive bank transfers." : "Follows company verification.", done: ibanLive },
  ];
  return phChecklistCard(`Finish setting up ${co.name}`, items);
}

/* Recent payment runs: the company's own record of what was drafted and sent. */
function phCoRuns() {
  const drafts = phCache.co?.drafts;
  if (drafts === null) return Z.note({ text: "Payment runs are not shown to your role." });
  const recent = [...(drafts || [])].filter((d) => d.state !== "DRAFT").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  return Z.listGroup({
    label: "Recent payment runs",
    action: recent.length ? { href: "#approvals", label: "See all" } : undefined,
    rows: recent.map((d) => Z.row({
      lead: Z.iconTile({ icon: "payments" }),
      title: phDraftTitle(d),
      sub: `${phDraftTotal(d)} · ${phWhen(d.updatedAt)}`,
      right: phDraftTag(d),
      href: `#approvals/${phApTabOf(d)}`,
      chevron: false,
    })),
    empty: { text: "No payments yet. Once the company IBAN is live, share it to get paid." },
  });
}

PH.company = {
  title: () => phCompany()?.name || "Company",
  tab: "home",
  live: () => JSON.stringify([phCoSig(), user?.balanceEur, phHidden, realMoney]),
  html() {
    const co = phCompany();
    if (phCache.orgs === null || !phCache.co) {
      return `<h1 class="z-sr">Company</h1>${phMain(`${Z.skeletonRows(1, "Loading the company…")}${Z.skeletonRows(4, "Loading the company…")}`)}`;
    }
    if (!co) return "";
    const acct = phCoAccount();
    const ibanLive = acct?.status === "active" && !!acct.identifier?.iban;
    const mine = ibanLive && acct.backingUserId === user?.id;
    const ibanRight = ibanLive
      ? `<span class="z-mono z-dim" translate="no">•••• ${esc(String(acct.identifier.iban).replace(/\s+/g, "").slice(-4))}</span>`
      : `<span class="z-dim">IBAN after verification</span>`;
    return `${phCoHead(co)}${phMain(`
      ${mine ? `${phBalance(user.balanceEur ?? user.safeBalanceEur ?? 0, "Balance of your account")}
        <p class="z-hint">Your own account pays for ${esc(co.name)}, so its payments come from here.</p>` : ""}
      <a class="z-card z-acctrow" href="#company/account">${Z.icon("account_balance", "z-acctrow__ic")}<span class="z-acctrow__label">Account details</span>${ibanRight}${Z.icon("chevron_right", "z-row__chev")}</a>
      <div class="z-actions">
        ${Z.button({ variant: "primary", icon: "arrow_outward", label: "Send", href: "#company/send" })}
        ${Z.button({ icon: "add", label: "Add money", href: "#company/account" })}
        ${phCan(co, "invoices") ? Z.button({ icon: "receipt_long", label: "Invoice", href: phWebHref("invoices") }).replace("<a ", `<a data-ph-org="${esc(co.id)}" `) : ""}
      </div>
      ${phCache.co.error ? Z.note({ tone: "a", text: `Part of the company didn’t load: ${phPlain(phCache.co.error)}` }) : ""}
      ${phCoChecklist(co)}
      ${phCoRuns()}
    `)}`;
  },
  bind(root) {
    if (!phCompanyId) return phGo("home", null, { replace: true });
    if (phCache.orgs === null || !phCache.co || phCache.co.id !== phCompanyId) {
      phLoadCompany({ force: true }).then(() => {
        if (phRoute?.name !== "company") return;
        if (!phCompany()) return phGo("home", null, { replace: true });
        phRender();
      });
      return;
    }
    phCoFreshen("company");
    const sw = root.querySelector("#ph-co-switch");
    if (sw) sw.onclick = () => phSwitchSheet(sw);
    const hide = root.querySelector("#ph-hide");
    if (hide) hide.onclick = () => {
      phHidden = !phHidden;
      try { localStorage.setItem("zold-hide-balance", phHidden ? "1" : "0"); } catch { /* hidden for this visit */ }
      phRender();
      $("ph-hide")?.focus();
    };
    const inv = root.querySelector("#ph-co-invite");
    if (inv) inv.onclick = () => phInviteDialog(inv);
  },
};

/* ==========================================================================
   Company account details, Send and Get paid
   ========================================================================== */

/* Screens that need the company: loading, or back to the personal Home. */
function phCoNeed(name, title, back) {
  if (phCompanyId && phCache.orgs !== null && phCache.co?.id === phCompanyId) return null;
  return `${phTop(title, back)}${phMain(Z.skeletonRows(3, "Loading the company…"))}`;
}
function phCoBindNeed(name) {
  if (!phCompanyId) { phGo("home", null, { replace: true }); return true; }
  if (phCache.orgs === null || phCache.co?.id !== phCompanyId) {
    phLoadCompany({ force: true }).then(() => {
      if (phRoute?.name !== name) return;
      if (!phCompany()) return phGo("home", null, { replace: true });
      phRender();
    });
    return true;
  }
  phCoFreshen(name);
  return false;
}

const phCoHolder = (co, acct) => acct?.profile?.name || co.legalName || co.name;
const phCoDetailsText = (co, acct) => [`Account holder: ${phCoHolder(co, acct)}`, `IBAN: ${Z.groupIban(acct.identifier.iban)}`,
  ...(acct.identifier.bic ? [`BIC: ${acct.identifier.bic}`] : [])].join("\n");

PH["company/account"] = {
  title: "Account details",
  live: () => phCoSig(),
  html() {
    const wait = phCoNeed("company/account", "Account details", "company");
    if (wait) return wait;
    const co = phCompany();
    const acct = phCoAccount();
    const ibanLive = acct?.status === "active" && !!acct.identifier?.iban;
    if (!ibanLive) {
      const why = !phCache.co.accounts ? "Your role can’t see the company’s accounts."
        : !acct ? "The company has no euro account yet."
          : phPlain(acct.gate?.reason || acct.profile?.reason || "The company account isn’t active yet.");
      return `${phTop("Account details", "company")}${phMain(`
        <p class="z-sub">The company IBAN appears here once Monerium has verified the company and issued it.</p>
        ${Z.note({ text: why })}
        ${phRoleCan(co.role, "invite") ? Z.button({ full: true, icon: "open_in_new", label: "Set it up in the web app", href: phWebHref("accounts") }).replace("<a ", `<a data-ph-org="${esc(co.id)}" `) : ""}
      `)}`;
    }
    return `${phTop("Account details", "company")}${phMain(`
      <p class="z-sub">Share these to get paid by bank transfer into ${esc(co.name)}.</p>
      <ul class="z-list z-card">
        <li>${Z.copyRow({ label: "Account holder", value: phCoHolder(co, acct) })}</li>
        <li>${Z.copyRow({ label: "IBAN", value: String(acct.identifier.iban).replace(/\s+/g, ""), display: Z.groupIban(acct.identifier.iban), mono: true })}</li>
        ${acct.identifier.bic ? `<li>${Z.copyRow({ label: "BIC", value: acct.identifier.bic, mono: true })}</li>` : ""}
      </ul>
      ${acct.profile?.warning ? Z.note({ tone: "a", text: phPlain(acct.profile.warning) }) : ""}
      <div class="z-pair">
        ${Z.button({ icon: "content_copy", label: "Copy all", id: "ph-co-copy" })}
        ${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-co-share" })}
      </div>
    `)}`;
  },
  bind(root) {
    if (phCoBindNeed("company/account")) return;
    const co = phCompany();
    const acct = phCoAccount();
    const copy = root.querySelector("#ph-co-copy");
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(phCoDetailsText(co, acct)); Z.announce("Copied"); }
      catch { Z.announce("Could not copy. Select the text and copy it yourself."); }
    };
    const share = root.querySelector("#ph-co-share");
    if (share) share.onclick = () => phShare(`${co.name}: account details`, phCoDetailsText(co, acct));
  },
};

PH["company/send"] = {
  title: "Send",
  tab: "send",
  live: () => phCoSig(),
  html() {
    const co = phCompany();
    if (!co || !phCache.co) return `<header class="z-app__head">${Z.largeTitle({ title: "Send" })}</header>${phMain(Z.skeletonRows(2, "Loading the company…"))}`;
    const ready = (phCache.co.drafts || []).filter((d) => d.state === "REVIEWED").length;
    const approvals = phCan(co, "transfers.approvals");
    return `<header class="z-app__head">${Z.largeTitle({ title: "Send", sub: `From ${co.name}` })}</header>${phMain(`
      <p class="z-sub">${approvals
        ? "A company payment starts as a draft. Someone other than the drafter approves it, then it’s sent from the web app with Face ID or fingerprint."
        : "A company payment starts as a draft in the web app and is sent from there with Face ID or fingerprint."}</p>
      ${phRoleCan(co.role, "propose")
        ? Z.button({ variant: "primary", full: true, icon: "open_in_new", label: "Draft a payment in the web app", href: phWebHref("payments") }).replace("<a ", `<a data-ph-org="${esc(co.id)}" `)
        : Z.note({ text: `As ${phRoleWord(co.role).toLowerCase()} you can’t draft payments.` })}
      ${approvals ? Z.listGroup({ rows: [
        Z.row({ lead: Z.iconTile({ icon: "inbox" }), title: "Approvals", sub: "Payments waiting for a second person", right: phCache.approvalsWaiting ? `<span class="z-fig">${phCache.approvalsWaiting}</span>` : "", href: "#approvals" }),
        Z.row({ lead: Z.iconTile({ icon: "task_alt" }), title: "Ready to send", sub: ready ? `${ready} approved` : "Nothing approved yet", href: "#approvals/ready" }),
      ] }) : ""}
    `)}`;
  },
  bind() { phCoBindNeed("company/send"); },
};

PH["company/get-paid"] = {
  title: "Get paid",
  tab: "get-paid",
  live: () => phCoSig(),
  html() {
    const co = phCompany();
    if (!co || !phCache.co) return `<header class="z-app__head">${Z.largeTitle({ title: "Get paid" })}</header>${phMain(Z.skeletonRows(2, "Loading the company…"))}`;
    const acct = phCoAccount();
    const ibanLive = acct?.status === "active" && !!acct.identifier?.iban;
    return `<header class="z-app__head">${Z.largeTitle({ title: "Get paid", sub: `Into ${co.name}` })}</header>${phMain(Z.listGroup({ rows: [
      Z.row({ lead: Z.iconTile({ icon: "account_balance" }), title: "Account details", sub: ibanLive ? "IBAN and BIC to share" : "IBAN after verification", href: "#company/account" }),
      ...(phCan(co, "invoices") ? [phWebRow(co, { lead: Z.iconTile({ icon: "receipt_long" }), title: "Invoices", sub: "Issue and track them in the web app", href: phWebHref("invoices") })] : []),
    ] }))}`;
  },
  bind() { phCoBindNeed("company/get-paid"); },
};

/* ==========================================================================
   Approvals
   ========================================================================== */

const PH_AP_TABS = [["waiting", "Waiting"], ["ready", "Ready to send"], ["sent", "Sent"]];
const PH_AP_STATES = {
  waiting: ["PENDING_REVIEW", "INVALID_DATA", "REJECTED"],
  ready: ["REVIEWED", "EXECUTING"],
  sent: ["EXECUTED", "FAILED"],
};
const phApTabOf = (d) => Object.keys(PH_AP_STATES).find((k) => PH_AP_STATES[k].includes(d.state)) || "waiting";

/* The status words of SYSTEM.md, per draft state. */
function phDraftTag(d) {
  return {
    PENDING_REVIEW: Z.tag("Waiting for review"), INVALID_DATA: Z.tag("Needs fixing"), REJECTED: Z.tag("Sent back", "amber"),
    REVIEWED: Z.tag("Approved"), EXECUTING: Z.tag("Sending", "pink"), EXECUTED: Z.tag("Sent"), FAILED: Z.tag("Failed"), DRAFT: Z.tag("Draft"),
  }[d.state] || "";
}
const phDraftTitle = (d) => (d.lines.length === 1 ? d.lines[0].destination?.displayName || "1 payment" : `${d.lines.length} payments`);
const phDraftTotal = (d) => Object.entries(d.totals || {}).map(([asset, v]) => phDraftMoney(v, asset)).join(" + ") || "";
const phActAt = (d, action) => [...(d.activity || [])].reverse().find((a) => a.action === action);

function phDraftCard(co, d) {
  const hid = `ph-d-${d.id}`;
  const invalid = new Set(d.invalidLineIds || []);
  const lines = d.lines.map((l) => `<li${invalid.has(l.id) ? ' class="is-invalid"' : ""}><span>${invalid.has(l.id) ? `${Z.icon("warning")}<span class="z-sr">Changed: </span>` : ""}${esc(l.destination?.displayName || "Payee")}</span><span class="z-fig">${esc(phDraftMoney(l.amount, l.asset))}</span></li>`).join("");
  const drafted = `Drafted by ${phMemberName(d.createdByMemberId)}`;
  const reviewed = d.reviewedByMemberId ? phMemberName(d.reviewedByMemberId) : "";
  const web = (label, view = "payments", variant = "secondary") =>
    Z.button({ variant, full: true, icon: "open_in_new", label, href: phWebHref(view) }).replace("<a ", `<a data-ph-org="${esc(co.id)}" `);
  let foot = "";
  if (d.state === "PENDING_REVIEW") {
    const may = phMayReview(co, d);
    foot = may.allowed
      ? `<div class="z-pair">${Z.button({ label: "Send back", className: "", id: `ph-ap-back-${d.id}` })}${Z.button({ variant: "primary", label: "Approve", id: `ph-ap-ok-${d.id}` })}</div>`
      : Z.button({ full: true, label: "Approve", disabledReason: may.reason });
  } else if (d.state === "INVALID_DATA") {
    const names = d.lines.filter((l) => invalid.has(l.id)).map((l) => l.destination?.displayName).filter(Boolean);
    foot = `${Z.note({ tone: "a", text: `${names.length ? names.join(", ") : "A payee"}: bank details changed after this was drafted. Check them before anyone approves it.` })}${web("Check bank details in the web app")}`;
  } else if (d.state === "REJECTED") {
    foot = `${Z.note({ tone: "a", text: `Sent back by ${reviewed || "a reviewer"}${d.rejectedReason ? `: “${phPlain(d.rejectedReason)}”` : "."}` })}${d.createdByMemberId === co.memberId ? web("Change it in the web app") : ""}`;
  } else if (d.state === "REVIEWED") {
    const acct = d.source?.kind === "account" ? (phCache.co?.accounts || []).find((a) => a.id === d.source.accountId) : null;
    const mine = acct?.backingUserId === user?.id;
    foot = d.source?.kind === "wallet"
      ? `<p class="z-hint">It pays from an imported wallet: sign it in that wallet.</p>${web("Open in the web app")}`
      : mine && phRoleCan(co.role, "send")
        ? `<p class="z-hint">Your account pays for it: send it from the web app with Face ID or fingerprint.</p>${web("Send in the web app", "payments", "primary")}`
        : `<p class="z-hint">The member whose account pays for the company sends it from the web app.</p>`;
  } else if (d.state === "EXECUTING") {
    foot = `<p class="z-hint">Being sent. Each payment shows in the web app until the bank confirms it.</p>`;
  } else if (d.state === "EXECUTED") {
    foot = `<p class="z-hint">Sent ${esc(phFull(phActAt(d, "executing")?.at || d.updatedAt))}.</p>`;
  } else if (d.state === "FAILED") {
    foot = Z.note({ tone: "a", text: phPlain(d.failureReason || "Sending failed. Nothing further moved; check each payment in the web app.") });
  }
  return `<article class="z-card z-draft" aria-labelledby="${hid}">
    <div class="z-draft__head"><h2 id="${hid}">${esc(phDraftTitle(d))}</h2>${phDraftTag(d)}</div>
    <p class="z-draft__by">${esc(drafted)} on ${esc(phDay(d.createdAt))}${reviewed && d.state !== "REJECTED" && d.state !== "PENDING_REVIEW" ? ` · approved by ${esc(reviewed)}` : ""}</p>
    <ul class="z-draft__lines">${lines}</ul>
    <p class="z-draft__total"><span>Total</span><span class="z-fig">${esc(phDraftTotal(d))}</span></p>
    ${foot}
    <p class="z-err" id="ph-ap-err-${esc(d.id)}" role="alert" hidden></p>
  </article>`;
}

/* Not acting for a company: say where approvals live. */
function phApNoCompany() {
  const companies = (phCache.orgs || []).filter((o) => o.type !== "personal");
  return `${phTop("Approvals", "more")}${phMain(`
    <p class="z-sub">Approvals are for company accounts: a second person checks each payment before it’s sent.</p>
    ${companies.length
      ? Z.listGroup({ label: "Switch to", rows: companies.map((o) => `<button type="button" class="z-row z-row--btn" data-ph-ap-co="${esc(o.id)}">${Z.avatar({ name: o.name })}<span class="z-row__main"><span class="z-row__title">${esc(o.name)}</span><span class="z-row__sub">Business · you are ${esc(phRoleWord(o.role).toLowerCase())}</span></span>${Z.icon("chevron_right", "z-row__chev")}</button>`) })
      : Z.note({ text: "You aren’t a member of a company account." })}
  `)}`;
}

/* No approvals on this plan: the plan's own reason, and the one trial. */
function phApGate(co) {
  const cap = co.capabilities?.["transfers.approvals"];
  const trial = !co.trial && cap?.requiresPlan?.includes("business");
  const owner = co.role === "owner";
  return `${phTop("Approvals", "more")}${phMain(`
    ${Z.note({ text: phPlain(cap?.reason || "Payment approvals are not part of this plan.") })}
    <p class="z-sub">Without approvals, a payment drafted in the web app is sent without a second person checking it.</p>
    ${trial ? `${owner
      ? Z.button({ variant: "primary", full: true, icon: "workspace_premium", label: "Start the 30-day trial", id: "ph-ap-trial" })
      : Z.button({ full: true, icon: "workspace_premium", label: "Start the 30-day trial", disabledReason: "Only an owner can start the trial." })}
      <p class="z-hint">Business for 30 days, approvals included. No payment is taken. Each company gets one trial.</p>` : ""}
    <p class="z-err" id="ph-ap-err" role="alert" hidden></p>
  `)}`;
}

PH.approvals = {
  title: "Approvals",
  tab: "approvals",
  live: (arg) => JSON.stringify([arg, phCoSig()]),
  html(arg) {
    if (phCache.orgs === null) return `${phTop("Approvals", "more")}${phMain(Z.skeletonRows(3, "Loading approvals…"))}`;
    const co = phCompany();
    if (!co) return phApNoCompany();
    if (!phCache.co || phCache.co.id !== co.id) return `<header class="z-app__head">${Z.largeTitle({ title: "Approvals" })}</header>${phMain(Z.skeletonRows(3, "Loading approvals…"))}`;
    if (!phCan(co, "transfers.approvals")) return phApGate(co);
    const tab = PH_AP_STATES[decodeURIComponent(arg || "")] ? decodeURIComponent(arg) : "waiting";
    const drafts = phCache.co.drafts;
    if (drafts === null) {
      return `<header class="z-app__head">${Z.largeTitle({ title: "Approvals" })}</header>${phMain(Z.note({ tone: "a", text: `We couldn’t load the payment drafts: ${phPlain(phCache.co.error || "try again later.")}` }))}`;
    }
    const inTab = (k) => drafts.filter((d) => PH_AP_STATES[k].includes(d.state));
    const shown = inTab(tab).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const ready = inTab("ready").filter((d) => d.state === "REVIEWED").length;
    const mine = phCache.approvalsWaiting;
    const sub = [mine ? `${mine} ${mine === 1 ? "needs" : "need"} your review.` : "Nothing needs your review.", ready ? `${ready} approved, ready to send.` : ""].filter(Boolean).join(" ");
    const empty = { waiting: "Nothing is waiting for review.", ready: "Nothing approved is waiting to be sent.", sent: "Nothing sent yet." }[tab];
    return `<header class="z-app__head">${Z.largeTitle({ title: "Approvals", sub })}</header>${phMain(`
      <div class="z-pills" role="group" aria-label="Show">
        ${PH_AP_TABS.map(([k, label]) => `<a class="z-pill" href="#approvals/${k}" aria-current="${k === tab ? "true" : "false"}">${esc(label)} <span class="z-fig z-pill__n">${inTab(k).length}</span></a>`).join("")}
      </div>
      ${shown.length ? shown.map((d) => phDraftCard(co, d)).join("") : Z.listGroup({ rows: [], empty: { text: empty } })}
      ${tab === "waiting" && drafts.some((d) => d.state === "DRAFT") ? `<p class="z-hint">Drafts not yet submitted for review are in the web app.</p>` : ""}
    `)}`;
  },
  bind(root) {
    root.querySelectorAll("[data-ph-ap-co]").forEach((b) => {
      b.onclick = () => { phUseCompany(b.dataset.phApCo); phGo("approvals"); };
    });
    if (phCache.orgs === null) { phLoadOrgs().then(() => { if (phRoute?.name === "approvals") phRender(); }); return; }
    const co = phCompany();
    if (!co) return;
    if (!phCache.co || phCache.co.id !== co.id) { phLoadCompany({ force: true }).then(() => { if (phRoute?.name === "approvals") phRender(); }); return; }
    phCoFreshen("approvals");
    const trial = root.querySelector("#ph-ap-trial");
    if (trial) trial.onclick = async () => {
      if (Z.isDisabled(trial)) return;
      Z.setLoading(trial, true);
      try {
        await api(phCoPath(co, "/plan/trial"), {});
        phCache.orgs = null;
        await phLoadOrgs();
        await phLoadCompany({ force: true });
        phRender();
      } catch (e) {
        Z.setLoading(trial, false);
        const err = root.querySelector("#ph-ap-err");
        err.textContent = phPlain(e.message); err.hidden = false;
      }
    };
    for (const d of phCache.co.drafts || []) {
      const ok = root.querySelector(`#ph-ap-ok-${CSS.escape(d.id)}`);
      if (ok) ok.onclick = () => phReview(co, d, ok, { approve: true });
      const back = root.querySelector(`#ph-ap-back-${CSS.escape(d.id)}`);
      if (back) back.onclick = () => phSendBackDialog(co, d, back);
    }
  },
};

/* Approve, or send back with a reason. The API re-checks four eyes and the
   payees' bank details; a refusal is shown on the card. */
async function phReview(co, d, btn, body) {
  if (Z.isDisabled(btn)) return false;
  Z.setLoading(btn, true);
  const err = document.getElementById(`ph-ap-err-${d.id}`);
  if (err) err.hidden = true;
  try {
    await api(phCoPath(co, `/drafts/${encodeURIComponent(d.id)}/review`), body);
    await phLoadCompany({ force: true });
    phRender();
    Z.announce(body.approve === false ? "Sent back" : "Approved. It’s ready to send.");
    return true;
  } catch (e) {
    Z.setLoading(btn, false);
    // 409: a payee changed since it was drafted; the draft now needs fixing.
    if (e.status === 409) { await phLoadCompany({ force: true }); phRender(); }
    const el = document.getElementById(`ph-ap-err-${d.id}`);
    if (el) { el.textContent = phPlain(e.message); el.hidden = false; }
    return false;
  }
}

function phSendBackDialog(co, d, trigger) {
  document.getElementById("ph-sendback")?.remove();
  const who = phMemberName(d.createdByMemberId);
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-sendback", kind: "dialog", title: "Send it back?",
    body: `<p class="z-sub">It goes back to ${esc(who)} to change. Nothing is sent.</p>
      <div class="z-field"><label for="ph-sb-reason">What needs fixing <span class="z-opt">(optional)</span></label>
        <textarea class="z-input z-textarea" id="ph-sb-reason" name="reason" rows="3" maxlength="500" autocomplete="off"></textarea></div>
      <div class="z-pair z-pair--dialog">${Z.button({ label: "Cancel", className: "z-overlay__close-btn" })}${Z.button({ variant: "primary", label: "Send back", id: "ph-sb-ok" })}</div>`,
  }));
  const scrim = $("ph-sendback");
  scrim.dataset.ph = "1";
  scrim.querySelector(".z-overlay__close-btn").onclick = () => Z.closeOverlay("ph-sendback");
  $("ph-sb-ok").onclick = async () => {
    const reason = $("ph-sb-reason").value.trim();
    Z.closeOverlay("ph-sendback");
    await phReview(co, d, $("ph-sb-ok"), { approve: false, ...(reason ? { reason } : {}) });
  };
  Z.openOverlay("ph-sendback", trigger);
}

/* ==========================================================================
   Members and the invite
   ========================================================================== */

/* What each role says in the role picker. */
const PH_ROLE_SAYS = {
  viewer: "Viewer: sees everything, changes nothing",
  accountant: "Accountant: books, and can propose payments",
  payer: "Payer: propose and send",
  admin: "Admin: everything but the plan",
  owner: "Owner: everything",
};

/* The roles the caller may hand out: only an owner makes an owner. */
const phRolesFor = (co) => ["viewer", "accountant", "payer", "admin", ...(co.role === "owner" ? ["owner"] : [])];

function phMemberRow(co, m, mayEdit) {
  const me = m.id === co.memberId;
  // A company's first owner is stored with no name or email of its own.
  const name = m.name || m.email || (me ? user?.name : "") || "A member";
  const chips = [["propose", "Propose"], ["approve", "Approve"], ["send", "Send"]].map(([k, label]) => {
    const on = phRoleCan(m.role, k);
    return `<li class="z-chip${on ? "" : " is-off"}">${esc(label)}<span class="z-sr">${on ? ": yes" : ": no"}</span></li>`;
  }).join("");
  const invited = m.status === "invited";
  const expired = invited && m.inviteExpiresAt && Date.parse(m.inviteExpiresAt) < Date.now();
  const sub = invited
    ? expired ? `Invited · the link expired ${phDay(m.inviteExpiresAt)}` : `Invited · link works until ${phDay(m.inviteExpiresAt)}`
    : m.name && m.email ? m.email : phRoleWord(m.role);
  // An owner's role is changed only by an owner; nobody edits their own here.
  const editable = mayEdit && !me && !invited && (m.role !== "owner" || co.role === "owner");
  const sid = `ph-role-${m.id}`;
  const picker = editable
    ? `<div class="z-select-wrap z-select-wrap--sm"><label class="z-sr" for="${esc(sid)}">Role of ${esc(name)}</label><select class="z-select" id="${esc(sid)}" data-ph-role="${esc(m.id)}">${phRolesFor(co).map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${esc(phRoleWord(r))}</option>`).join("")}</select>${Z.icon("expand_more")}</div>`
    : `<span class="z-member__role">${esc(phRoleWord(m.role))}</span>`;
  const link = phCache.inviteLinks[m.id];
  return `<div class="z-member">
    <div class="z-member__top">${Z.avatar({ name })}<span class="z-row__main"><span class="z-row__title">${esc(name)}${me ? " (you)" : ""}</span><span class="z-row__sub">${esc(sub)}</span></span>${invited ? Z.tag(expired ? "Expired" : "Invited", expired ? "dim" : "amber") : picker}</div>
    <ul class="z-chips" aria-label="What ${esc(name)} can do">${chips}</ul>
    ${link && !expired ? Z.copyRow({ label: "Invite link", value: link, mono: true }) : ""}
    <p class="z-err" id="ph-m-err-${esc(m.id)}" role="alert" hidden></p>
  </div>`;
}

PH.members = {
  title: "Members",
  tab: "more",
  live: () => JSON.stringify([phCoSig(), Object.keys(phCache.inviteLinks)]),
  html() {
    const wait = phCoNeed("members", "Members", "more");
    if (wait) return wait;
    const co = phCompany();
    const all = phCache.co.members;
    if (all === null) return `${phTop("Members", "more")}${phMain(Z.note({ tone: "a", text: `We couldn’t load the members: ${phPlain(phCache.co.error || "try again later.")}` }))}`;
    const members = all.filter((m) => m.status !== "deactivated")
      .sort((a, b) => (a.status === "invited") - (b.status === "invited") || (a.id === co.memberId ? -1 : b.id === co.memberId ? 1 : 0));
    const managed = phCan(co, "members.manage");
    const canInvite = managed && phRoleCan(co.role, "invite");
    const add = canInvite ? Z.iconButton({ icon: "person_add", label: "Invite someone", id: "ph-m-invite", className: "z-iconbtn--primary" }) : "";
    const joined = members.filter((m) => m.status === "active").length;
    return `${phTop("Members", "more", add)}${phMain(`
      <p class="z-sub">${esc(co.name)} · ${joined} ${joined === 1 ? "member" : "members"}${members.length > joined ? `, ${members.length - joined} invited` : ""}. Whoever proposes a payment can’t approve it.</p>
      ${!managed ? Z.note({ text: phPlain(co.capabilities?.["members.manage"]?.reason || "Members can’t be changed on this plan.") }) : ""}
      <section class="z-card z-members" aria-label="Members">${members.map((m) => phMemberRow(co, m, canInvite)).join("")}</section>
    `)}`;
  },
  bind(root) {
    if (phCoBindNeed("members")) return;
    const co = phCompany();
    const inv = root.querySelector("#ph-m-invite");
    if (inv) inv.onclick = () => phInviteDialog(inv);
    root.querySelectorAll("[data-ph-role]").forEach((sel) => {
      sel.onchange = async () => {
        const id = sel.dataset.phRole;
        const before = (phCache.co.members || []).find((m) => m.id === id)?.role;
        const err = document.getElementById(`ph-m-err-${id}`);
        err.hidden = true;
        sel.disabled = true;
        try {
          await api(phCoPath(co, `/members/${encodeURIComponent(id)}`), { role: sel.value }, "PATCH");
          await phLoadCompany({ force: true });
          phRender();
          Z.announce("Role changed");
          document.getElementById(`ph-role-${id}`)?.focus();
        } catch (e) {
          // The last owner stays an owner; the API says so.
          sel.disabled = false;
          sel.value = before;
          err.textContent = phPlain(e.message); err.hidden = false;
        }
      };
    });
  },
};

/* Invite: an email and a role, then a link to share. The API requires the
   email; the invitee signs in with it to join. */
function phInviteDialog(trigger) {
  const co = phCompany();
  if (!co) return;
  document.getElementById("ph-invite")?.remove();
  const roles = phRolesFor(co).map((r) => ({ value: r, label: PH_ROLE_SAYS[r] }));
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-invite", kind: "dialog", title: `Invite to ${co.name}`,
    body: `<div id="ph-inv-body"><p class="z-sub">You get a link to send them yourself. Zold doesn’t send emails. It works once, for this email address, and expires in 3 days.</p>
      <form id="ph-inv-form" class="z-stack z-invite" novalidate>
        ${Z.field({ id: "ph-inv-email", name: "email", label: "Their email", type: "email", autocomplete: "off", required: true })}
        ${Z.select({ id: "ph-inv-role", name: "role", label: "Role", value: "payer", options: roles })}
        <p class="z-err" id="ph-inv-err" role="alert" hidden></p>
        <div class="z-pair z-pair--dialog">${Z.button({ label: "Cancel", className: "z-overlay__close-btn" })}${Z.button({ variant: "primary", label: "Create link", type: "submit", id: "ph-inv-ok" })}</div>
      </form></div>`,
  }));
  const scrim = $("ph-invite");
  scrim.dataset.ph = "1";
  scrim.querySelector(".z-overlay__close-btn").onclick = () => Z.closeOverlay("ph-invite");
  $("ph-inv-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("ph-inv-ok");
    if (Z.isDisabled(btn)) return;
    const input = $("ph-inv-email");
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { Z.setFieldError(input, "Enter their email address, like name@company.de."); input.focus(); return; }
    Z.setFieldError(input, "");
    Z.setLoading(btn, true);
    try {
      const r = await api(phCoPath(co, "/members"), { email, role: $("ph-inv-role").value });
      const link = `${location.origin}/app?invite=${encodeURIComponent(r.inviteToken)}`;
      phCache.inviteLinks[r.member.id] = link;
      const until = r.member.inviteExpiresAt ? phFull(r.member.inviteExpiresAt) : "in 3 days";
      $("ph-inv-body").innerHTML = `<p class="z-sub">Send this link to ${esc(email)} yourself. It works once and expires ${r.member.inviteExpiresAt ? `on ${esc(until)}` : esc(until)}. They sign in with this email address to join.</p>
        <div class="z-card">${Z.copyRow({ label: "Invite link", value: link, mono: true })}</div>
        <div class="z-pair z-pair--dialog">${Z.button({ label: "Done", className: "z-overlay__close-btn" })}${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-inv-share", autofocus: true })}</div>`;
      scrim.querySelector(".z-overlay__close-btn").onclick = () => Z.closeOverlay("ph-invite");
      $("ph-inv-share").onclick = () => phShare(`Join ${co.name} on Zold`, `You’re invited to ${co.name} on Zold. Sign in with ${email} to join:`, link);
      $("ph-inv-share").focus();
      // The list redraws once this dialog closes (the poll sees the new member).
      phLoadCompany({ force: true });
    } catch (err) {
      Z.setLoading(btn, false);
      const el = $("ph-inv-err");
      el.textContent = phPlain(err.message); el.hidden = false;
    }
  };
  Z.openOverlay("ph-invite", trigger);
}
