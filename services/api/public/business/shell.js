/**
 * The shell: one click delegate, the screen renderer, and boot.
 *
 * ONE DELEGATED LISTENER for the whole dashboard rather than a handler per
 * button: rows are redrawn constantly, and per-element handlers would either
 * leak or be lost on the next render.
 */
import {
  $, api, esc, invoiceInputListener, org, orgs, readRecovery, setInvoiceInputListener, ensureMe, setOrg,
  setOrgs, setTestMode, setView, toast, token, view,
} from "./core.js";
import { KNOWN, planBanner, refreshSide, renderNav, setMenu } from "./nav.js";
import { META, RENDER, setExportMonth } from "./views.js";
import { checkCustomerVatId, refreshInvoiceCheck } from "./invoice.js";
import { ACTIONS } from "./actions.js";
import { initSearch } from "./search.js";

// Elements whose action is still running. The element is also disabled, but
// the set covers anything without a `disabled` property and a click that
// lands before the attribute takes effect.
const busy = new WeakSet();

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  if (busy.has(el) || el.getAttribute("aria-disabled") === "true") return;
  busy.add(el);
  const canDisable = "disabled" in el;
  if (canDisable) el.disabled = true;
  try {
    const keep = await fn(el);
    // An action that opened a dialog or drawer draws again when it closes.
    if (keep !== "keep" && !$("#dlg").open && !document.querySelector("body > .z-scrim.is-open")) render();
  } catch (e) { toast(e.message, true); }
  finally {
    busy.delete(el);
    // The render may already have replaced it; only a live element is re-armed.
    if (canDisable && el.isConnected) el.disabled = false;
  }
});

// A link to another view stays in the page (a modifier-click still opens a tab).
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-view-link]");
  if (!a || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  if (a.closest(".z-scrim")) window.Z.closeOverlay(a.closest(".z-scrim").id);
  setView(a.dataset.viewLink);
  render({ focus: true });
});

// Back and Forward move between views: the URL is the source of truth there.
window.addEventListener("popstate", () => {
  if (!org) return;
  // Back from the open Menu closes it; the view underneath is unchanged.
  if (document.querySelector(".zb.is-menu")) { setMenu(false, { viaHistory: false }); return; }
  const wanted = new URLSearchParams(location.search).get("view") || "overview";
  setView(KNOWN.has(wanted) ? wanted : "overview", { push: false });
  render({ focus: true });
});

// ── render ─────────────────────────────────────────────────────────────────

let seq = 0;

export async function render({ focus = false } = {}) {
  if (!org) return;
  const mine = ++seq;
  renderNav();
  refreshSide().catch(() => { /* the sidebar keeps what it had */ });
  $("#plan-banner").innerHTML = planBanner();
  const meta = (META[view] ?? META.overview)();
  $("#view-title").textContent = meta.title;
  $("#view-sub").textContent = meta.sub || "";
  $("#view-actions").innerHTML = meta.actions || "";
  document.title = `${meta.title} · Zold`;
  const box = $("#view");
  box.innerHTML = `<div class="z-card">${window.Z.skeletonRows(4, "Loading…")}</div>`;
  box.setAttribute("aria-busy", "true");
  try {
    const out = await (RENDER[view] ?? RENDER.overview)();
    if (mine !== seq) return;   // a later render owns the page
    const r = typeof out === "string" ? { html: out } : out;
    box.innerHTML = r.html;
    r.bind?.(box);
    if (view === "export") {
      $("#x-month")?.addEventListener("change", (e) => { setExportMonth(e.target.value); render(); });
    }
    if (view === "invoice-new") {
      refreshInvoiceCheck();
      // Debounced so typing an address is not a request per keystroke, and
      // re-armed per render so listeners do not pile up on the persistent
      // #view element.
      let t;
      invoiceInputListener?.abort();
      setInvoiceInputListener(new AbortController());
      box.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(refreshInvoiceCheck, 400);
      }, { signal: invoiceInputListener.signal });
      box.addEventListener("change", (e) => {
        // Leaving the VAT ID field looks it up in VIES (which then checks
        // again); any other change just checks again.
        if (e.target?.id === "inv-r-vat") checkCustomerVatId();
        else refreshInvoiceCheck();
      }, { signal: invoiceInputListener.signal });
    }
  } catch (e) {
    if (mine !== seq) return;
    // A 402 here means the plan gate fired server-side. Show the same prompt
    // rather than an error, so the two agree.
    box.innerHTML = e.status === 402 || e.status === 409
      ? `<div class="gate"><h3>${esc(e.capability || "Not available")}</h3>
         <p>${esc(e.error)}</p>${e.requiresPlan && !org.trial
           ? `<div class="zb-actions"><button class="z-btn z-btn--primary z-btn--sm" data-act="trial">Start 30-day trial</button></div>` : ""}</div>`
      : e.status === 403
        ? `<div class="gate"><h3>Not for your role</h3><p>${esc(e.error || "Your role in this organisation can’t open this.")}</p></div>`
        : `<div class="banner warn">${window.Z.icon("warning")}<span>${esc(e.message)}</span></div>`;
  } finally {
    if (mine === seq) box.setAttribute("aria-busy", "false");
  }
  if (focus && mine === seq) {
    window.scrollTo(0, 0);
    $("#view-title").setAttribute("tabindex", "-1");
    $("#view-title").focus({ preventScroll: true });
  }
}

export async function loadOrg(id) {
  const r = await api(`/api/orgs/${id}`);
  setOrg(r.organisation);
  try { localStorage.setItem("zold-org", org.id); } catch { /* this visit only */ }
}

// ── boot ───────────────────────────────────────────────────────────────────

/* One of the three states is the page; the other two leave the DOM, so the
   page has one h1. */
function only(sel) {
  for (const id of ["#signed-out", "#no-orgs", "#app"]) {
    if (id === sel) $(id).classList.remove("hidden"); else $(id)?.remove();
  }
}

export async function boot() {
  // Test mode follows the chain (GET /api/health realMoney), as in the app.
  api("/api/health").then((h) => { setTestMode(!h.realMoney); renderNav(); }).catch(() => { /* no pill */ });
  if (!token) { only("#signed-out"); return; }
  let list;
  try {
    list = await api("/api/orgs");
  } catch (e) {
    if (e.status === 401) { only("#signed-out"); return; }
    throw e;
  }
  const session = ensureMe().then((u) => {
    renderNav();
    // The personal-space banner needs to know who this is.
    if (org && $("#plan-banner")) $("#plan-banner").innerHTML = planBanner();
    readRecovery().then(() => { if (org && $("#plan-banner")) $("#plan-banner").innerHTML = planBanner(); }).catch(() => { /* no banner */ });
    return u;
  }).catch(() => null);
  setOrgs(list.organisations);
  if (!orgs.length) {
    // A person starts with their personal space, named and placed from the
    // account; a company login has none (routes/orgs.ts refuses it).
    const u = await session;
    only("#no-orgs");
    if (u?.accountType === "company") $("#new-org-type option[value=personal]")?.remove();
    else if (u?.name) $("#new-org-name").value = u.name;
    if (u?.country) $("#new-org-country").value = u.country;
    $("#new-org").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/orgs", {
          method: "POST",
          body: {
            name: $("#new-org-name").value,
            type: $("#new-org-type").value,
            country: $("#new-org-country").value,
          },
        });
        location.reload();
      } catch (err) { toast(err.message, true); }
    };
    return;
  }
  let wanted = null;
  try { wanted = localStorage.getItem("zold-org"); } catch { /* the first one */ }
  setOrg(orgs.find((o) => o.id === wanted) ?? orgs[0]);
  await loadOrg(org.id);
  // Deep links: /business?view=shopify after a store install, with the
  // outcome in the query so the redirect from Shopify lands on an answer.
  const qs = new URLSearchParams(location.search);
  if (qs.get("view") && KNOWN.has(qs.get("view"))) setView(qs.get("view"), { push: false });
  if (qs.get("error")) toast(qs.get("error"), true);
  if (qs.get("shop")) toast(`Connected ${qs.get("shop")}.`);
  // Keep ?view= (it is the address of this screen); drop the one-shot
  // outcome parameters so a reload does not repeat the toast.
  if (qs.toString()) {
    history.replaceState({ view }, "", qs.get("view") ? `${location.pathname}?view=${encodeURIComponent(view)}` : location.pathname);
  }
  only("#app");
  initSearch();
  render();
}
