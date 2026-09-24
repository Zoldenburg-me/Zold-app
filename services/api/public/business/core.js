/**
 * What every screen on the dashboard needs: the DOM helpers, the escaping, the
 * session-bearing api(), the plan-capability lookup, and the shared state.
 *
 * Only this module writes the state. `org`, `view` and the rest are read
 * everywhere; an ES module export is a live binding, so reads stay a plain
 * `org` and the few places that reassign call a setter.
 */
import { render } from "./shell.js";

export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export let token = localStorage.getItem("zold-session") || localStorage.getItem("zoll-session");
export let invoiceInputListener = null;
export let orgs = [];
export let org = null;   // the full org payload, including `capabilities`
export let view = "overview";

export function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), bad ? 7000 : 3500);
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

/** Can the current org use this capability? Mirrors the server's verdict. */
export const cap = (id) => org?.capabilities?.[id] ?? { allowed: false, label: id };

/**
 * Render an upgrade / unavailable prompt in place of the feature.
 * Never hides the nav entry — a hidden feature reads as a missing one.
 */
export function gateHtml(id) {
  const v = cap(id);
  if (v.unavailable) {
    return `<div class="gate"><h3>${esc(v.label)}</h3>
      <p>${esc(v.unavailable)}</p>
      <div class="needs">Not a plan limit — this is not built yet.</div></div>`;
  }
  const plans = (v.requiresPlan || []).join(" or ");
  return `<div class="gate"><h3>${esc(v.label)}</h3>
    <p>${esc(v.upgradeHint || v.reason || "")}</p>
    ${plans ? `<button data-act="upgrade" data-plan="${esc(v.requiresPlan[0])}">Upgrade to ${esc(plans)}</button>
      ${org.trial ? "" : `<button class="ghost" data-act="trial">Start 30-day trial</button>`}` : ""}
    ${plans ? "" : `<div class="needs">${esc(v.reason || "")}</div>`}</div>`;
}

// ── navigation ─────────────────────────────────────────────────────────────


export const fmtMoney = (cents, currency = "EUR") => {
  try {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format((cents ?? 0) / 100);
  } catch {
    // An unknown code must not blank the panel while someone is still typing it.
    return `${((cents ?? 0) / 100).toFixed(2)} ${currency}`;
  }
};
export const fmtEur = (cents) => fmtMoney(cents, "EUR");

// ── actions ────────────────────────────────────────────────────────────────

export function dialog(title, bodyHtml, onSubmit) {
  $("#dlg-body").innerHTML = `<h3>${esc(title)}</h3>${bodyHtml}
    <div class="dlg-actions"><button class="ghost" id="dlg-cancel">Cancel</button>
    <button id="dlg-ok">Save</button></div>`;
  $("#dlg").showModal();
  $("#dlg-cancel").onclick = () => $("#dlg").close();
  $("#dlg-ok").onclick = async () => {
    try { await onSubmit(); $("#dlg").close(); render(); }
    catch (e) { toast(e.message, true); }
  };
}


/** The bindings other modules reassign. Every READ of them stays live. */
export const setOrg = (v) => { org = v; };
export const setOrgs = (v) => { orgs = v; };
export const setView = (v) => { view = v; };
export const setInvoiceInputListener = (v) => { invoiceInputListener = v; };
