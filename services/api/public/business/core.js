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

/** A country picker over every country (window.Z.countries). `name` stays
 *  "country" so the browser's address autofill fills it. */
export const countrySelect = (id, current) =>
  `<select id="${id}" name="country" autocomplete="country">${Z.countries(current).map((o) =>
    `<option value="${esc(o.value)}"${o.value === (current || "") ? " selected" : ""}${o.disabled ? " disabled" : ""}>${esc(o.label)}</option>`).join("")}</select>`;

export let token = localStorage.getItem("zold-session") || localStorage.getItem("zoll-session");
export let invoiceInputListener = null;
export let orgs = [];
export let org = null;   // the full org payload, including `capabilities`
export let view = "overview";
/** The signed-in person (GET /api/session): their name, and the balance of
 *  their own account, which a company account may spend from. */
export let me = null;
/** Test mode: the chain moves no real money (GET /api/health). undefined until read. */
export let testMode = undefined;

/** The UI v2 components (ui.js, a classic script loaded before this module). */
export const Z = window.Z;

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
    // A 5xx without JSON came from in front of the API (Cloudflare, the
    // tunnel): the API never answers an error without a body.
    const ray = res.headers.get("cf-ray");
    const gateway = res.status >= 500 && !data.error
      ? `Zold's server did not answer (HTTP ${res.status}${ray ? `, ray ${ray}` : ""}). The request may or may not have gone through: check before you try it again.`
      : "";
    const err = new Error(data.error || gateway || `${res.status} ${res.statusText}`);
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
    return `<div class="gate"><h3>${esc(v.label)} ${Z.tag("Soon")}</h3>
      <p>${esc(v.unavailable)}</p>
      <div class="needs">Not a plan limit: this isn’t built yet.</div></div>`;
  }
  const plans = (v.requiresPlan || []).join(" or ");
  return `<div class="gate"><h3>${esc(v.label)}</h3>
    <p>${esc(v.upgradeHint || v.reason || "")}</p>
    ${plans ? `<div class="zb-actions">${org.trial ? "" : `<button class="z-btn z-btn--primary z-btn--sm" data-act="trial">Start 30-day trial</button>`}
      <button class="z-btn z-btn--secondary z-btn--sm" data-act="upgrade" data-plan="${esc(v.requiresPlan[0])}">Choose ${esc(plans)}</button></div>` : ""}
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

/** Money in the app's words (English UI): "€1,480.00", real minus sign. */
export const eur = (value, currency = "EUR") => Z.formatMoney(Number(value) || 0, currency);

/** "26 Sep", "Today 09:14". */
export function day(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).formatToParts(d);
  return `${parts.find((p) => p.type === "day").value} ${parts.find((p) => p.type === "month").value}`;
}
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === new Date().toDateString()) {
    return `Today ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d)}`;
  }
  const y = new Date(); y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString() ? "Yesterday" : day(iso);
}
/** A date-only string ("2026-10-08") read as that calendar day. */
export const ymd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? `${s}T12:00:00` : s);

/** "DE12 5001 •••• 4410": enough to recognise. */
export function maskIban(iban) {
  const s = String(iban || "").replace(/\s+/g, "");
  return s.length > 12 ? `${s.slice(0, 4)} ${s.slice(4, 8)} •••• ${s.slice(-4)}` : Z.groupIban(s);
}

/* What each role may do, as the API's permission table has it. */
export const ROLE_WORD = { owner: "Owner", admin: "Admin", payer: "Payer", accountant: "Accountant", viewer: "Viewer" };
export const ROLE_CAN = {
  owner: { propose: true, approve: true, send: true },
  admin: { propose: true, approve: true, send: true },
  payer: { propose: true, approve: false, send: true },
  accountant: { propose: true, approve: false, send: false },
  viewer: { propose: false, approve: false, send: false },
};
export const roleCan = (role, what) => !!ROLE_CAN[role]?.[what];

/** Server text for people: the API's words for a few chain and passkey
 *  errors, said plainly. */
export const plain = (msg) => String(msg || "")
  .replace(/\bpasskey\b/gi, "Face ID or fingerprint")
  .replace(/\bEURe\b/g, "euros")
  .replace(/\bSEPA\b/g, "bank transfer")
  .replace(/\s+—\s+/g, ": ")
  .replace(/(\w)'(\w)/g, "$1’$2");

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
  $("#dlg-body").innerHTML = `<h2 id="dlg-title">${esc(title)}</h2>${bodyHtml}
    <div id="dlg-err" class="dlg-err" role="alert"></div>
    <div class="dlg-actions">${closeOnly
      ? `<button class="z-btn z-btn--secondary" id="dlg-cancel">Close</button>`
      : `<button class="z-btn z-btn--secondary" id="dlg-cancel">Cancel</button>
    ${secondary ? `<button class="z-btn z-btn--secondary${secondary.cls?.includes("danger") ? " zb-danger" : ""}" id="dlg-alt">${esc(secondary.label)}</button>` : ""}
    <button class="z-btn z-btn--primary" id="dlg-ok">${esc(okLabel)}</button>`}</div>`;
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
export const setMe = (v) => { me = v; };
export const setTestMode = (v) => { testMode = v; };
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
