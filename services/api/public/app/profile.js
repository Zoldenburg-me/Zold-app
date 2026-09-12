/** Profile, account documents, and payment links. */
/* ---------- Profile ---------- */
function renderProfileScreen() {
  const u = user || {};
  const name = u.name || "Account";
  $("m-pf-name").textContent = name;
  $("m-pf-email").textContent = u.email || "No email on file";
  $("m-pf-initials").textContent = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "—";
  const approved = kycApproved(u);
  const chip = $("m-pf-kyc");
  chip.textContent = approved ? "VERIFIED" : (u.kycStatus || "pending").replace("_", " ").toUpperCase();
  chip.className = `m-tag${approved ? " on" : ""}`;

  const shorten = (v) => (v && v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);
  const account = [
    { k: "IBAN", v: u.iban || "Not issued yet", copy: u.iban },
    { k: "Smart account", v: shorten(u.address) || "—", copy: u.address },
    ...(u.paymentPage?.handle
      ? [{ k: "Payment page", v: `/pay/${u.paymentPage.handle}`, copy: `${location.origin}/pay/${u.paymentPage.handle}` }]
      : []),
  ];
  $("m-pf-account").innerHTML = account.map((r, i) => `
    <div class="m-detrow">
      <div style="flex:1;min-width:0">
        <div class="m-rowk">${esc(r.k)}</div>
        <div class="m-rowv">${esc(r.v)}</div>
      </div>
      ${r.copy ? `<button class="m-copybtn" data-pfcopy="${i}">Copy</button>` : ""}
    </div>`).join("");
  $("m-pf-account").querySelectorAll("[data-pfcopy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(account[Number(b.dataset.pfcopy)].copy); } catch { return; }
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy"; }, 1400);
    };
  });

  /* Every row here reports real state. "Not set" on the passkey row means an
     account whose registration never completed; funding refuses without one. */
  const safe = u.passkeySafe;
  const security = [
    { icon: "fingerprint", t: "Passkey", d: "Signs in and approves payments", st: u.passkey?.credentialId ? "Registered" : "Not set" },
    { icon: "key", t: "Device spending key", d: "Signs the amount and the payee before anything moves", st: u.authorizerAddress ? "Bound" : "Not bound" },
    { icon: "group", t: "2-of-2 co-signer", d: "Second owner on your smart account", st: safe?.cosignerAddress ? "Enabled" : "Not enabled" },
    { icon: "health_and_safety", t: "Managed recovery", d: "Guardian can restore a lost passkey", st: safe?.recovery?.status === "active" ? "Active" : "Not enabled" },
  ];
  $("m-pf-security").innerHTML = security.map((r) => `
    <div class="m-secrow">
      <span class="material-symbols-rounded">${r.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="t">${esc(r.t)}</div>
        <div class="d">${esc(r.d)}</div>
      </div>
      <span class="st" style="color:${/Registered|Bound|Enabled|Active/.test(r.st) ? "var(--m-mint)" : "var(--m-faint)"}">${esc(r.st)}</span>
    </div>`).join("");

  const sub = u.privacyBundle;
  $("m-pf-plus-sub").textContent = sub && sub.status !== "canceled" ? "Privacy Bundle active" : "Coming soon";

  const cr = safe?.candideRecovery;
  $("m-pf-recovery").classList.toggle("hidden", !caps.emailSmsRecovery && !cr);
  $("m-pf-recovery-sub").textContent = !caps.emailSmsRecovery
    ? "Unavailable on this deployment"
    : !cr ? "Not set up"
      : cr.guardianStatus === "active" ? `Active · ${cr.channels.length} channel${cr.channels.length === 1 ? "" : "s"}`
        : "Guardian not on your smart account yet";

  /* Own Monerium keys: state, never a promise. "Unavailable" is what a
     deployment without an encryption key honestly is. */
  const mon = $("m-pf-monerium");
  mon.classList.toggle("hidden", !HAS("monerium"));
  const keys = u.monerium?.method === "api_keys" ? u.monerium.apiKeys : null;
  $("m-pf-monerium-sub").textContent = keys
    ? `Connected · ${keys.environment}${keys.accountEmail ? ` · ${keys.accountEmail}` : ""}`
    : !caps.moneriumApiKeys ? "Unavailable on this deployment"
      : u.monerium?.method === "oauth" ? "Connected by OAuth · keys not used"
        : "Use your own Monerium account for testing";
}

/* ---------- Statements & documents ---------- */
const DOC_KIND_LABEL = { statement: "Account statement", receipt: "Transfer receipt", balance: "Balance confirmation", ownership: "Proof of ownership" };

function monthOptions() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ value: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  return out;
}

async function renderDocumentsScreen() {
  const el = $("m-doc-body");
  el.innerHTML = `<div class="m-lede" style="font-size:13px">Loading…</div>`;
  let docs = [];
  try { docs = (await api(`/api/users/${user.id}/documents`)).documents || []; }
  catch (e) { el.innerHTML = `<div class="m-err">${esc(e.message)}</div>`; return; }
  const months = monthOptions();
  el.innerHTML = `
    <div class="m-seclabel">Create</div>
    <div class="m-field"><label>Statement month</label>
      <select id="m-doc-month" style="width:100%;background:var(--m-surface);color:inherit;border:1px solid var(--m-line);border-radius:10px;padding:12px;font:inherit">
        ${months.map((m) => `<option value="${m.value}">${esc(m.label)}</option>`).join("")}
      </select></div>
    <button class="m-cta" id="m-doc-statement" style="margin-top:12px">Create statement</button>
    <button class="m-cta quiet" id="m-doc-balance" style="margin-top:8px">Balance confirmation (now)</button>
    <button class="m-cta quiet" id="m-doc-ownership" style="margin-top:8px">Proof of ownership (sign with passkey)</button>
    <div class="m-err hidden" id="m-doc-err" style="margin-top:12px"></div>
    <div class="m-seclabel" style="margin-top:24px">Issued</div>
    <div class="m-rows" id="m-doc-list">${docs.length ? docs.map((d) => `
      <button class="m-secrow" data-doc-url="${esc(d.url)}" style="width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;cursor:pointer">
        <span class="material-symbols-rounded">${d.kind === "receipt" ? "receipt_long" : d.kind === "balance" ? "account_balance" : d.kind === "ownership" ? "verified_user" : "description"}</span>
        <div style="flex:1;min-width:0"><div class="t">${esc(DOC_KIND_LABEL[d.kind] || d.kind)}</div><div class="d">${esc(d.summary || "")} · ${esc(new Date(d.createdAt).toLocaleDateString())}${d.revokedAt ? " · revoked" : ""}</div></div>
        <span class="material-symbols-rounded" style="color:var(--m-faint)">open_in_new</span>
      </button>`).join("") : `<div class="m-lede" style="font-size:13px">Nothing issued yet.</div>`}</div>
    `;
  el.querySelectorAll("[data-doc-url]").forEach((b) => { b.onclick = () => window.open(b.dataset.docUrl, "_blank", "noopener"); });
  const busy = (on) => ["m-doc-statement", "m-doc-balance", "m-doc-ownership"].forEach((id) => { $(id).disabled = on; });
  const open = (d) => { window.open(d.url, "_blank", "noopener"); renderDocumentsScreen(); };
  $("m-doc-statement").onclick = async () => {
    clearErr("m-doc-err"); busy(true);
    try {
      const [y, m] = $("m-doc-month").value.split("-").map(Number);
      const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
      const to = new Date(Date.UTC(y, m, 1) - 1).toISOString();
      open(await api(`/api/users/${user.id}/documents/statement`, { from, to }));
    } catch (e) { showErr("m-doc-err", e); } finally { busy(false); }
  };
  $("m-doc-balance").onclick = async () => {
    clearErr("m-doc-err"); busy(true);
    try { open(await api(`/api/users/${user.id}/documents/balance`, {})); }
    catch (e) { showErr("m-doc-err", e); } finally { busy(false); }
  };
  $("m-doc-ownership").onclick = async () => {
    clearErr("m-doc-err"); busy(true);
    try {
      let d = await api(`/api/users/${user.id}/documents/ownership`, {});
      if (d.safeSignature) {
        // The part a screenshot cannot fake: the account's own signature.
        const sig = await passkeySignPrepared(d.safeSignature);
        d = await api(d.safeSignature.submitTo, sig);
      }
      open(d);
    } catch (e) { showErr("m-doc-err", e); } finally { busy(false); }
  };
}

/* ---------- payment links ---------- */
let linksOpen = null; // id of the link whose detail is expanded

async function renderLinksScreen() {
  const el = $("m-links-body");
  el.innerHTML = `<div class="m-lede" style="font-size:13px">Loading…</div>`;
  let data;
  try { data = await api(`/api/users/${user.id}/payment-requests`); }
  catch (e) { el.innerHTML = `<div class="m-err">${esc(e.message)}</div>`; return; }
  const methods = data.methods || [];
  const can = (m) => !!methods.find((x) => x.method === m)?.available;
  const needs = methods.filter((m) => !m.available).map((m) => `${m.method === "crypto" ? "USDC" : "Bank transfer"} is off until you ${m.needs}.`);
  const money = (n) => n === undefined || n === null ? "Any amount" : `€${fmt(n)}`;
  const icon = (r) => r.state === "PAID" ? "task_alt" : r.state === "OPEN" ? "schedule" : "block";
  const rows = data.requests || [];
  const check = (id, label, on) => `<label style="display:flex;gap:10px;align-items:center;padding:10px 0;font-size:13.5px;${on ? "" : "color:var(--m-faint)"}">
      <input type="checkbox" id="${id}" ${on ? "checked" : "disabled"} style="width:18px;height:18px;accent-color:var(--m-pink)" />${label}</label>`;
  el.innerHTML = `
    <div class="m-seclabel">New link</div>
    <div class="m-field"><label>Amount in EUR — leave empty and the payer chooses</label><input id="m-lk-amount" inputmode="decimal" placeholder="40.00" /></div>
    <div class="m-field"><label>What it is for</label><input id="m-lk-desc" maxlength="140" placeholder="Invoice 2026-014" /></div>
    <div class="m-seclabel" style="margin-top:12px">Ways to pay</div>
    ${check("m-lk-crypto", "USDC to your payment page", can("crypto"))}
    ${check("m-lk-bank", "Bank transfer with a reference, or from another Zold account", can("bank"))}
    ${needs.length ? `<div class="m-lede" style="font-size:12.5px">${needs.map(esc).join(" ")}</div>` : ""}
    <button class="m-cta" id="m-lk-create" style="margin-top:12px" ${can("crypto") || can("bank") ? "" : "disabled"}>Create link</button>
    <div class="m-err hidden" id="m-lk-err" style="margin-top:12px"></div>
    <div class="m-seclabel" style="margin-top:24px">Your links</div>
    <div class="m-rows" id="m-lk-list">${rows.length ? rows.map((r) => `
      <button class="m-secrow" data-lk="${esc(r.id)}" style="width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;cursor:pointer">
        <span class="material-symbols-rounded">${icon(r)}</span>
        <div style="flex:1;min-width:0"><div class="t">${esc(money(r.amountEur))}${r.description ? ` · ${esc(r.description)}` : ""}</div>
          <div class="d">${esc(r.state.toLowerCase())}${r.paidEur ? ` · €${fmt(r.paidEur)} received` : ""} · ${esc(new Date(r.createdAt).toLocaleDateString())}${r.source?.kind === "shopify" ? " · Shopify" : ""}</div></div>
        <span class="material-symbols-rounded" style="color:var(--m-faint)">${linksOpen === r.id ? "expand_less" : "expand_more"}</span>
      </button>
      ${linksOpen === r.id ? linkDetail(r) : ""}`).join("") : `<div class="m-lede" style="font-size:13px">No links yet.</div>`}</div>`;

  $("m-lk-create").onclick = async () => {
    clearErr("m-lk-err");
    const raw = ($("m-lk-amount").value || "").replace(",", ".").trim();
    const methodsWanted = [];
    if ($("m-lk-crypto").checked) methodsWanted.push("crypto");
    if ($("m-lk-bank").checked) methodsWanted.push("bank");
    try {
      const r = await api(`/api/users/${user.id}/payment-requests`, {
        ...(raw ? { amountEur: Number(raw) } : {}),
        description: $("m-lk-desc").value,
        methods: methodsWanted,
      });
      linksOpen = r.id;
      renderLinksScreen();
    } catch (e) { showErr("m-lk-err", e); }
  };
  el.querySelectorAll("[data-lk]").forEach((b) => {
    b.onclick = () => { linksOpen = linksOpen === b.dataset.lk ? null : b.dataset.lk; renderLinksScreen(); };
  });
  el.querySelectorAll("[data-lk-open]").forEach((b) => {
    b.onclick = () => { const u = safeUrl(b.dataset.lkOpen); if (u) window.open(u, "_blank", "noopener"); };
  });
  el.querySelectorAll("[data-lk-copy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.lkCopy); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy link"), 1200); } catch {}
    };
  });
  el.querySelectorAll("[data-lk-cancel]").forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/users/${user.id}/payment-requests/${b.dataset.lkCancel}/cancel`, {}); renderLinksScreen(); }
      catch (e) { showErr("m-lk-err", e); }
    };
  });
}

/** One link, expanded: the URL, its status and every payment against it. */
function linkDetail(r) {
  const pays = (r.payments || []).map((p) => `<div class="m-row"><span class="k">${p.method === "crypto" ? `${p.amountUsdc ?? ""} USDC` : "Bank transfer"}${p.payerName ? ` · ${esc(p.payerName)}` : ""}</span>
      <span class="v">€${fmt(p.amountEur)}${p.kind === "partial" ? " (partial)" : ""}${p.settledEur !== undefined ? ` · settled €${fmt(p.settledEur)}${p.settledAsset === "USDC" ? " held as USDC" : ""}` : p.method === "crypto" ? " · not converted yet" : ""}</span></div>`).join("");
  return `<div style="padding:8px 4px 16px">
    <div class="m-shlink" style="word-break:break-all;font-family:var(--m-mono);font-size:12px">${esc(r.url)}</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="m-cta" data-lk-copy="${esc(r.url)}" style="min-height:40px;font-size:13px">Copy link</button>
      <button class="m-cta quiet" data-lk-open="${esc(r.url)}" style="min-height:40px;font-size:13px;background:transparent;border:1px solid var(--m-line-strong)">Open</button>
    </div>
    <div class="m-lede" style="font-size:12.5px;margin-top:10px">Pays into ${r.methods.includes("crypto") ? "your payment page (USDC)" : ""}${r.methods.length === 2 ? " or " : ""}${r.methods.includes("bank") ? "your IBAN with reference " + esc(r.code) : ""}.
      ${r.state === "OPEN" ? `Open until ${esc(new Date(r.expiresAt).toLocaleString())}.` : ""}</div>
    ${pays ? `<div class="m-rows" style="margin-top:8px">${pays}</div>` : `<div class="m-lede" style="font-size:12.5px;margin-top:8px">Nothing received yet.</div>`}
    ${r.source?.kind === "shopify" ? `<div class="m-lede" style="font-size:12.5px;margin-top:8px">Shopify checkout at ${esc(r.source.shop || "")}${r.source.resolvedAt ? " — the store has been told." : r.source.resolveError ? ` — the store could not be told: ${esc(r.source.resolveError)}` : ""}</div>` : ""}
    ${r.state === "OPEN" && !(r.payments || []).length ? `<button class="m-cta quiet" data-lk-cancel="${esc(r.id)}" style="margin-top:10px;min-height:40px;font-size:13px;background:transparent;border:1px solid var(--m-line-strong);color:var(--m-pink)">Cancel this link</button>` : ""}
  </div>`;
}
