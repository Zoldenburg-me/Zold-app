/** Profile (Settings) and account documents. Payment links are app/phone.js. */
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
      ${r.copy ? `<button class="m-copybtn" data-pfcopy="${i}" aria-label="Copy ${esc(r.k)}">Copy</button>` : ""}
    </div>`).join("");
  $("m-pf-account").querySelectorAll("[data-pfcopy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(account[Number(b.dataset.pfcopy)].copy); } catch { return; }
      b.textContent = "Copied";
      announce("Copied");
      setTimeout(() => { b.textContent = "Copy"; }, 1400);
    };
  });

  /* Every row here reports real state. "Not set" on the passkey row means an
     account whose registration never completed; funding refuses without one. */
  const safe = u.passkeySafe;
  const security = [
    { icon: "fingerprint", t: "Passkey", d: "Signs in and approves payments", st: u.passkey?.credentialId ? "Registered" : "Not set" },
    { id: "device", icon: "key", t: "Device spending key", d: "Signs the amount and the payee before anything moves", st: u.authorizerAddress ? "Bound" : "Not bound" },
    { icon: "health_and_safety", t: "Managed recovery", d: "Guardian can restore a lost passkey", st: safe?.recovery?.status === "active" ? "Active" : "Not enabled" },
  ];
  $("m-pf-security").innerHTML = security.map((r) => `
    <div class="m-secrow"${r.id ? ` data-sec="${r.id}"` : ""}${r.action ? ` data-sec-action="${r.action}" style="cursor:pointer"` : ""}>
      <span class="material-symbols-rounded" aria-hidden="true">${r.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="t">${esc(r.t)}</div>
        <div class="d">${esc(r.d)}</div>
      </div>
      <span class="st" style="color:${/Registered|Bound|Enabled|Active/.test(r.st) ? "var(--m-mint)" : "var(--m-faint)"}">${esc(r.st)}</span>
    </div>`).join("");

  /* PRF is per authenticator. Without it the device key sits unencrypted in
     localStorage, and "Bound" in green was all this screen said about it. */
  if (u.authorizerAddress) {
    deviceLib.then((dev) => {
      if (dev.keyStatus().protection !== "none") return;
      const row = $("m-pf-security").querySelector('[data-sec="device"]');
      if (!row) return;
      row.querySelector(".d").textContent =
        "Stored unencrypted in this browser: this passkey cannot encrypt it (no PRF support), so anything that can read this browser's storage can sign with it";
      const st = row.querySelector(".st");
      st.textContent = "Unprotected";
      st.style.color = "var(--m-amber)";
    });
  }

  renderAdvancedToggle();

  const sub = u.privacyBundle;
  $("m-pf-plus-sub").textContent = sub && sub.status !== "canceled" ? "Privacy Bundle active" : "Coming soon";

  const cr = safe?.candideRecovery;
  const zr = safe?.recovery?.status === "active";
  $("m-pf-recovery").classList.toggle("hidden", !caps.emailSmsRecovery && !caps.zoldenburgRecovery && !cr && !zr);
  $("m-pf-recovery-sub").textContent = zr ? "Zoldenburg is your guardian"
    : cr?.guardianStatus === "active" ? `Email / SMS · ${cr.channels.length} channel${cr.channels.length === 1 ? "" : "s"}`
      : !caps.emailSmsRecovery && !caps.zoldenburgRecovery ? "Unavailable on this deployment"
        : cr ? "Guardian not on your smart account yet"
          : "No guardian — a lost passkey is a lost account";

  /* Own Monerium keys: show the current state. A deployment without an
     encryption key shows "Unavailable". */
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
  catch (e) { el.innerHTML = `<div class="m-err" role="alert">${esc(e.message)}</div>`; return; }
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
    <div class="m-err hidden" role="alert" id="m-doc-err" style="margin-top:12px"></div>
    <div class="m-seclabel" style="margin-top:24px">Issued</div>
    <div class="m-rows" id="m-doc-list">${docs.length ? docs.map((d) => `
      <button class="m-secrow" data-doc-url="${esc(d.url)}" style="width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;cursor:pointer">
        <span class="material-symbols-rounded" aria-hidden="true">${d.kind === "receipt" ? "receipt_long" : d.kind === "balance" ? "account_balance" : d.kind === "ownership" ? "verified_user" : "description"}</span>
        <div style="flex:1;min-width:0"><div class="t">${esc(DOC_KIND_LABEL[d.kind] || d.kind)}</div><div class="d">${esc(d.summary || "")} · ${esc(new Date(d.createdAt).toLocaleDateString())}${d.revokedAt ? " · revoked" : ""}</div></div>
        <span class="material-symbols-rounded" aria-hidden="true" style="color:var(--m-faint)">open_in_new</span>
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
