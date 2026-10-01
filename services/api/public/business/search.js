/**
 * Search (Cmd or Ctrl K) over this organisation's contacts, payment runs and
 * invoices. There is no search route: it reads those three lists once when it
 * opens, and searches what the API returned. Esc closes it, the arrows move,
 * Enter opens.
 */
import { $, Z, api, cap, day, esc, eur, maskIban, org, setView } from "./core.js";
import { draftTitle, draftTotal, invAmount, invWord } from "./screens.js";
import { render } from "./shell.js";

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const st = { q: "", results: [], active: 0, data: null, orgId: null };

async function load() {
  const id = org.id;
  const [c, d, i] = await Promise.allSettled([
    api(`/api/orgs/${id}/contacts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${id}/drafts`) : Promise.resolve({ drafts: [] }),
    cap("invoices").allowed ? api(`/api/orgs/${id}/invoices`) : Promise.resolve({ invoices: [] }),
  ]);
  if (org.id !== id) return;
  st.orgId = id;
  st.data = {
    contacts: c.status === "fulfilled" ? c.value.contacts : [],
    drafts: d.status === "fulfilled" ? d.value.drafts : [],
    invoices: i.status === "fulfilled" ? i.value.invoices : [],
  };
}

function mark(text, q) {
  const s = String(text || "");
  const i = q ? s.toLowerCase().indexOf(q) : -1;
  if (i < 0) return esc(s);
  return `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
}

function results(raw) {
  const q = raw.trim().toLowerCase();
  if (!q || !st.data) return [];
  const hit = (...xs) => xs.some((x) => String(x || "").toLowerCase().includes(q));
  const compact = q.replace(/\s+/g, "");
  const contacts = st.data.contacts
    .filter((c) => hit(c.name, c.email) || (compact.length > 3 && c.bankAccounts.some((b) => String(b.iban || "").toLowerCase().includes(compact))))
    .slice(0, 4).map((c) => {
      const iban = c.bankAccounts.find((b) => b.iban)?.iban;
      return { group: "Contacts", go: { view: "contacts" }, lead: Z.avatar({ name: c.name }), title: mark(c.name, q), right: iban ? esc(maskIban(iban)) : "" };
    });
  const invoices = st.data.invoices
    .filter((i) => hit(i.issued?.recipient?.name, i.supplier?.orgName, i.issued?.number, i.supplier?.invoiceNumber))
    .slice(0, 4).map((i) => {
      const out = i.direction === "outgoing";
      const who = (out ? i.issued?.recipient?.name : i.supplier?.orgName) || "";
      const num = (out ? i.issued?.number : i.supplier?.invoiceNumber) || "";
      const a = invAmount(i);
      return { group: "Invoices", go: { view: "invoices" }, lead: Z.iconTile({ icon: out ? "receipt_long" : "move_to_inbox" }), title: mark(`Invoice ${num} ${out ? "to" : "from"} ${who}`.replace(/\s+/g, " "), q), right: `${esc(Z.formatMoney(a.value, a.currency))} · ${esc(invWord(i).toLowerCase())}` };
    });
  const payments = st.data.drafts
    .filter((d) => d.lines.some((l) => hit(l.destination?.displayName, l.note)))
    .slice(0, 5).map((d) => ({
      group: "Payments", go: { view: "payments" }, lead: Z.iconTile({ icon: "arrow_outward" }),
      title: mark([draftTitle(d), d.lines.find((l) => l.note)?.note].filter(Boolean).join(" · "), q),
      right: `−${esc(draftTotal(d))} · ${esc(day(d.createdAt))}`,
    }));
  return [...contacts, ...invoices, ...payments];
}

function draw() {
  const box = $("#zb-results");
  const input = $("#zb-q");
  if (!box || !input) return;
  const q = st.q.trim();
  const r = st.results;
  if (!q) box.innerHTML = `<p class="z-cmdk__hint">Search contacts, payments and invoices of ${esc(org.name)}.</p>`;
  else if (!r.length) box.innerHTML = `<p class="z-cmdk__hint" role="status">${st.data ? `Nothing matches “${esc(q)}”.` : "Still loading, one moment…"}</p>`;
  else {
    let html = "", group = "";
    r.forEach((x, i) => {
      if (x.group !== group) {
        if (group) html += "</div>";
        group = x.group;
        html += `<div role="group" aria-labelledby="zb-g-${i}"><h3 class="z-eyebrow z-cmdk__group" id="zb-g-${i}">${esc(group)}</h3>`;
      }
      html += `<div class="z-cmdk__opt" role="option" id="zb-o-${i}" data-i="${i}" aria-selected="${i === st.active}">${x.lead}<span class="z-cmdk__title">${x.title}</span><span class="z-cmdk__right">${x.right}</span></div>`;
    });
    box.innerHTML = `${html}</div>`;
  }
  input.setAttribute("aria-expanded", String(r.length > 0));
  if (r.length) { input.setAttribute("aria-activedescendant", `zb-o-${st.active}`); $(`#zb-o-${st.active}`)?.scrollIntoView({ block: "nearest" }); }
  else input.removeAttribute("aria-activedescendant");
}

function pick(i) {
  const x = st.results[i];
  if (!x) return;
  Z.closeOverlay("zb-search");
  setView(x.go.view);
  render({ focus: true });
}

function open(trigger) {
  if (!org) return;
  if (!$("#zb-search")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="z-scrim z-scrim--dialog z-scrim--top" id="zb-search" hidden>
      <div class="z-dialog z-cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <div class="z-cmdk__bar">${Z.icon("search")}
          <label class="z-sr" for="zb-q">Search contacts, payments and invoices</label>
          <input id="zb-q" class="z-cmdk__input" type="search" name="q" role="combobox" aria-expanded="false" aria-controls="zb-results" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search contacts, payments, invoices…">
          <kbd class="z-kbd">esc</kbd></div>
        <div class="z-cmdk__list" id="zb-results" role="listbox" aria-label="Results"></div>
        <div class="z-cmdk__foot" aria-hidden="true"><span><kbd class="z-kbd">↑</kbd><kbd class="z-kbd">↓</kbd> to move</span><span><kbd class="z-kbd">↵</kbd> to open</span></div>
      </div></div>`);
    const input = $("#zb-q");
    input.oninput = () => { st.q = input.value; st.results = results(input.value); st.active = 0; draw(); };
    input.onkeydown = (e) => {
      const n = st.results.length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); st.active = (st.active + 1) % n; draw(); }
      else if (e.key === "ArrowUp" && n) { e.preventDefault(); st.active = (st.active - 1 + n) % n; draw(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(st.active); }
    };
    const box = $("#zb-results");
    box.onclick = (e) => { const o = e.target.closest("[data-i]"); if (o) pick(Number(o.dataset.i)); };
    box.onmousemove = (e) => {
      const o = e.target.closest("[data-i]");
      if (!o || Number(o.dataset.i) === st.active) return;
      st.active = Number(o.dataset.i);
      box.querySelectorAll("[data-i]").forEach((el) => el.setAttribute("aria-selected", String(el === o)));
      input.setAttribute("aria-activedescendant", o.id);
    };
  }
  if (st.orgId !== org.id) { st.data = null; st.q = ""; }
  const input = $("#zb-q");
  input.value = st.q;
  st.results = results(st.q);
  st.active = 0;
  draw();
  Z.openOverlay("zb-search", trigger);
  input.select();
  // Read fresh on every open: a run approved a minute ago should show so.
  load().then(() => { if (!$("#zb-search").hidden) { st.results = results(input.value); draw(); } }).catch(() => { /* searched what it had */ });
}

export function initSearch() {
  const btn = $("#search-btn");
  btn.hidden = false;
  btn.setAttribute("aria-keyshortcuts", mac ? "Meta+K" : "Control+K");
  $("#search-kbd").textContent = mac ? "⌘K" : "Ctrl K";
  btn.onclick = () => open(btn);
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "k" || !(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
    if ($("#dlg").open) return;
    e.preventDefault();
    const s = $("#zb-search");
    if (s && !s.hidden) Z.closeOverlay("zb-search"); else open(document.activeElement);
  });
}
