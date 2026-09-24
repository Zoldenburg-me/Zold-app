/**
 * The shell: one click delegate, the screen renderer, and boot.
 *
 * ONE DELEGATED LISTENER for the whole dashboard rather than a handler per
 * button — rows are redrawn constantly, and per-element handlers would either
 * leak or be lost on the next render.
 */
import {
  $, api, esc, invoiceInputListener, org, orgs, setInvoiceInputListener, setOrg,
  setOrgs, setView, toast, token, view,
} from "./core.js";
import { VIEWS, planBanner, renderNav } from "./nav.js";
import { RENDER, refreshInvoiceCheck } from "./views.js";
import { ACTIONS } from "./actions.js";

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  try { await fn(el); if (!$("#dlg").open) render(); }
  catch (e) { toast(e.message, true); }
});

// ── boot ───────────────────────────────────────────────────────────────────

export async function render() {
  if (!org) return;
  renderNav();
  $("#plan-banner").innerHTML = planBanner();
  const def = VIEWS.find((v) => v.id === view);
  const extraTitles = { "invoice-new": "New invoice", "invoicing-settings": "Invoicing profile" };
  $("#view-title").textContent = def?.label ?? extraTitles[view] ?? "Overview";
  $("#view-sub").textContent = `${org.name} · ${org.type} · ${org.effectivePlan}`;
  $("#view").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    $("#view").innerHTML = await (RENDER[view] ?? RENDER.overview)();
    if (view === "invoice-new") {
      refreshInvoiceCheck();
      // Debounced so typing an address is not a request per keystroke, and
      // re-armed per render so listeners do not pile up on the persistent
      // #view element.
      let t;
      invoiceInputListener?.abort();
      setInvoiceInputListener(new AbortController());
      $("#view").addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(refreshInvoiceCheck, 400);
      }, { signal: invoiceInputListener.signal });
      $("#inv-contact")?.addEventListener("change", async (e) => {
        if (!e.target.value) return;
        const { contacts } = await api(`/api/orgs/${org.id}/contacts`);
        const c = contacts.find((x) => x.id === e.target.value);
        if (!c) return;
        const b = c.bankAccounts[0];
        $("#inv-r-name").value = c.name;
        if (b?.country) $("#inv-r-country").value = b.country;
        refreshInvoiceCheck();
      });
    }
  } catch (e) {
    // A 402 here means the plan gate fired server-side. Show the same prompt
    // rather than an error, so the two agree.
    $("#view").innerHTML = e.status === 402 || e.status === 409
      ? `<div class="gate"><h3>${esc(e.capability || "Not available")}</h3>
         <p>${esc(e.error)}</p>${e.requiresPlan
           ? `<button data-act="upgrade" data-plan="${esc(e.requiresPlan[0])}">Upgrade</button>` : ""}</div>`
      : `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

export async function loadOrg(id) {
  const r = await api(`/api/orgs/${id}`);
  setOrg(r.organisation);
  localStorage.setItem("zold-org", org.id);
}

export async function boot() {
  if (!token) { $("#signed-out").classList.remove("hidden"); return; }
  let list;
  try {
    list = await api("/api/orgs");
  } catch (e) {
    if (e.status === 401) { $("#signed-out").classList.remove("hidden"); return; }
    throw e;
  }
  setOrgs(list.organisations);
  if (!orgs.length) {
    $("#no-orgs").classList.remove("hidden");
    $("#new-org-go").onclick = async () => {
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
      } catch (e) { toast(e.message, true); }
    };
    return;
  }
  const wanted = localStorage.getItem("zold-org");
  setOrg(orgs.find((o) => o.id === wanted) ?? orgs[0]);
  $("#org-select").innerHTML = orgs
    .map((o) => `<option value="${esc(o.id)}" ${o.id === org.id ? "selected" : ""}>${esc(o.name)}</option>`)
    .join("");
  $("#org-select").onchange = async (e) => { await loadOrg(e.target.value); setView("overview"); render(); };
  await loadOrg(org.id);
  // Deep links: /business?view=shopify after a store install, with the
  // outcome in the query so the redirect from Shopify lands on an answer.
  const qs = new URLSearchParams(location.search);
  if (qs.get("view") && (VIEWS.some((v) => v.id === qs.get("view")) || RENDER[qs.get("view")])) setView(qs.get("view"));
  if (qs.get("error")) toast(qs.get("error"), true);
  if (qs.get("shop")) toast(`Connected ${qs.get("shop")}.`);
  if (qs.toString()) history.replaceState(null, "", location.pathname);
  $("#app").classList.remove("hidden");
  render();
}
