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
  // Shown first and filled a frame later: a live region that is display:none
  // when its text changes is not reliably announced.
  t.className = bad ? "bad" : "";
  t.textContent = "";
  requestAnimationFrame(() => { t.textContent = msg; });
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

/**
 * The one modal. `opts.okLabel` names the primary action ("Invite", not
 * "Save"); `opts.secondary` adds a second action ({ label, onSubmit, cls })
 * for a real either/or such as Approve / Reject; `opts.closeOnly` shows a
 * single Close for a dialog that only informs.
 *
 * Errors are shown INSIDE the dialog: a toast renders under the modal
 * backdrop, and the dialog stays open so the input is not lost. The action
 * buttons are disabled while a submit is in flight, so a double click cannot
 * send twice.
 */
export function dialog(title, bodyHtml, onSubmit, opts = {}) {
  const { okLabel = "Save", secondary = null, closeOnly = false } = opts;
  $("#dlg-body").innerHTML = `<h3 id="dlg-title">${esc(title)}</h3>${bodyHtml}
    <div id="dlg-err" class="dlg-err" role="alert"></div>
    <div class="dlg-actions">${closeOnly
      ? `<button id="dlg-cancel">Close</button>`
      : `<button class="ghost" id="dlg-cancel">Cancel</button>
    ${secondary ? `<button class="${esc(secondary.cls ?? "ghost")}" id="dlg-alt">${esc(secondary.label)}</button>` : ""}
    <button id="dlg-ok">${esc(okLabel)}</button>`}</div>`;
  $("#dlg").showModal();
  $("#dlg-cancel").onclick = () => $("#dlg").close();
  if (closeOnly) return;
  const run = (fn) => async () => {
    const actions = [$("#dlg-ok"), $("#dlg-alt")].filter(Boolean);
    const err = $("#dlg-err");
    if (actions.some((b) => b.disabled)) return;
    err.textContent = "";
    actions.forEach((b) => { b.disabled = true; });
    try { await fn(); $("#dlg").close(); render(); }
    catch (e) { err.textContent = e.message; }
    finally { actions.forEach((b) => { b.disabled = false; }); }
  };
  $("#dlg-ok").onclick = run(onSubmit);
  if (secondary) $("#dlg-alt").onclick = run(secondary.onSubmit);
}


/** The bindings other modules reassign. Every READ of them stays live. */
export const setOrg = (v) => { org = v; };
export const setOrgs = (v) => { orgs = v; };
/** Changing the view is a navigation: it gets a history entry, so Back works
 *  and the URL can be bookmarked or opened in a new tab. `push: false` is for
 *  popstate, where the browser has already moved the URL. */
export const setView = (v, { push = true } = {}) => {
  view = v;
  if (push && new URLSearchParams(location.search).get("view") !== v) {
    history.pushState({ view: v }, "", `${location.pathname}?view=${encodeURIComponent(v)}`);
  }
};
export const setInvoiceInputListener = (v) => { invoiceInputListener = v; };
