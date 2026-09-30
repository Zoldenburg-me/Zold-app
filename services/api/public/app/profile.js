/** Account documents. Settings is app/settings.js; payment links are app/phone.js. */
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
