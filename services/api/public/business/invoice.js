/**
 * The invoice editor (design/ui-v2 Desk-Invoice-Editor): the form on the
 * left, the invoice as paper on the right, drawn from the API's own check
 * (POST /invoicing/check) as you type. The paper is in the invoice's
 * language, never the app's.
 *
 * Two rules from the tax code shape it:
 *  - Everything § 14 UStG requires is always asked for and always printed.
 *  - Charging VAT or not is an either/or with a reason attached, never a rate
 *    box that can be zeroed (§ 14c UStG).
 *
 * "Save draft" keeps the draft in this browser only; nothing is sent until
 * "Create and share". There is no repeat-monthly invoice in the API, so the
 * editor offers none. Zold sends no emails: the link is shared by you.
 */
import { $, Z, api, esc, org } from "./core.js";
import { META, RENDER, jurisdictionBanner } from "./views.js";

export let invoiceDraft = null;
export const setInvoiceDraft = (v) => { invoiceDraft = v; };
let profile = null;          // GET /invoicing/profile, for the paper
let checkSeq = 0;

const draftKey = () => `zold-web-invoice-draft:${org.id}`;
export function storedDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { return null; }
}
export function storeDraft() {
  readInvoiceEditor();
  try {
    const { _reasons, _defaultRate, ...keep } = invoiceDraft;
    localStorage.setItem(draftKey(), JSON.stringify(keep));
    return true;
  } catch { return false; }
}
export function forgetDraft() { try { localStorage.removeItem(draftKey()); } catch { /* nothing kept */ } }

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (ymdStr, n) => { const d = new Date(`${ymdStr}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

META["invoice-new"] = () => ({
  title: "New invoice",
  sub: "The preview follows the invoice’s language, not the app’s.",
  actions: "",
});

RENDER["invoice-new"] = async () => {
  const [d, { contacts }] = await Promise.all([
    api(`/api/orgs/${org.id}/invoicing/profile`),
    api(`/api/orgs/${org.id}/contacts`),
  ]);
  profile = d;
  const p = d.profile;
  invoiceDraft ??= storedDraft() || {
    lines: [{ description: "", quantity: "1", unitPriceNet: "" }],
    language: p.language === "en" ? "en" : "de",
    issueDate: today(),
    supplyDate: today(),
    dueDate: plusDays(today(), Number.isFinite(p.paymentTermsDays) ? p.paymentTermsDays : 14),
    recipient: { country: d.jurisdiction.country },
    vat: p.smallBusiness
      ? { kind: "exempt", reason: d.jurisdiction.ruleSet === "DE" ? "kleinunternehmer" : "small_business_national" }
      : { kind: "standard", rate: p.defaultVatRate ?? (d.jurisdiction.ruleSet === "DE" ? 19 : "") },
  };
  const v = invoiceDraft.vat;
  invoiceDraft._reasons = d.reference.exemptionReasons.map((r) => r.id);
  invoiceDraft._defaultRate = p.defaultVatRate ?? (d.jurisdiction.ruleSet === "DE" ? 19 : "");
  const reasons = [
    ...d.reference.exemptionReasons,
    ...(d.reference.customReasons ?? []).map((c) => ({
      id: c.id, label: `${c.label} (your rule)`, legalBasis: c.legalBasis ?? "your own rule",
      invoiceNote: c.invoiceNote, hint: "You set this rule. Zold prints your note and doesn’t check it.",
    })),
  ];
  const r = invoiceDraft.recipient || {};
  const missing = [
    !(d.issuer.addressLine && d.issuer.postalCode && d.issuer.city) ? "your address" : "",
    !(d.issuer.taxNumber || d.issuer.vatId) ? "a tax number" : "",
  ].filter(Boolean);
  const f = (id, label, value, extra = "") => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}" autocomplete="off" value="${esc(value ?? "")}" ${extra} /></div>`;

  const html = `<div class="zb-editor">
    <form class="zb-editor__form" id="inv-form" novalidate onsubmit="return false">
      ${missing.length ? `<div class="zb-note zb-note--a" style="margin-bottom:6px">${Z.icon("badge")}<span>Your invoicing profile is missing ${esc(missing.join(" and "))}. Add it once and it goes on every invoice. <a href="?view=invoicing-settings" data-view-link="invoicing-settings">Invoicing profile</a></span></div>` : ""}
      <div class="zb-row zb-row--2">
        <div><label for="inv-r-name">Customer</label><input id="inv-r-name" name="customer" autocomplete="off" value="${esc(r.name || "")}" placeholder="Café Ostwind…" list="inv-contacts" /></div>
        <div><label for="inv-lang">Language</label><select id="inv-lang" name="language"><option value="de"${invoiceDraft.language !== "en" ? " selected" : ""}>Deutsch</option><option value="en"${invoiceDraft.language === "en" ? " selected" : ""}>English</option></select></div>
      </div>
      ${contacts.length ? `<datalist id="inv-contacts">${contacts.map((c) => `<option value="${esc(c.name)}"></option>`).join("")}</datalist>` : ""}
      <div class="zb-row zb-row--3">
        ${f("inv-r-addr", "Street and number", r.addressLine, 'placeholder="Ostengasse 4…"')}
        ${f("inv-r-zip", "Postcode", r.postalCode, 'inputmode="numeric" placeholder="93047…"')}
        ${f("inv-r-city", "City", r.city, 'placeholder="Regensburg…"')}
      </div>
      <div class="zb-row zb-row--3">
        ${f("inv-issue", "Invoice date", invoiceDraft.issueDate || today(), 'type="date"')}
        ${f("inv-supply", "Service date", invoiceDraft.supplyDate || today(), 'type="date"')}
        ${f("inv-due", "Due", invoiceDraft.dueDate || "", 'type="date"')}
      </div>
      <fieldset><legend>Lines</legend>
        <div id="inv-lines">${invoiceDraft.lines.map((l, i) => `<div class="zb-row zb-row--line">
          <div><label for="inv-l${i}-d" class="${i ? "z-sr" : ""}">Description</label><input id="inv-l${i}-d" name="line${i}-description" data-li="${i}" data-lf="description" autocomplete="off" value="${esc(l.description)}" placeholder="Eichenregal, Maßanfertigung…" /></div>
          <div><label for="inv-l${i}-q" class="${i ? "z-sr" : ""}">Qty</label><input id="inv-l${i}-q" name="line${i}-quantity" data-li="${i}" data-lf="quantity" inputmode="decimal" autocomplete="off" value="${esc(l.quantity)}" /></div>
          <div><label for="inv-l${i}-p" class="${i ? "z-sr" : ""}">Net price</label><input id="inv-l${i}-p" name="line${i}-price" data-li="${i}" data-lf="unitPriceNet" inputmode="decimal" autocomplete="off" value="${esc(l.unitPriceNet)}" placeholder="0.00…" /></div>
          <div>${invoiceDraft.lines.length > 1 ? `<button type="button" class="z-iconbtn" data-act="inv-del-line" data-i="${i}" aria-label="Remove line ${i + 1}">${Z.icon("close")}</button>` : ""}</div>
        </div>`).join("")}</div>
        <button type="button" class="z-link-btn" data-act="inv-add-line" style="margin-top:10px">${Z.icon("add")}Add line</button>
      </fieldset>
      <fieldset><legend>VAT</legend>
        <div class="zb-seg" role="group" aria-label="VAT">
          <button type="button" class="zb-pill" data-act="inv-vat-mode" data-mode="standard" aria-current="${v.kind === "standard"}"${p.smallBusiness ? ' aria-disabled="true" title="Kleinunternehmer: turn it off in the invoicing profile first"' : ""}>Charge VAT</button>
          <button type="button" class="zb-pill" data-act="inv-vat-mode" data-mode="exempt" aria-current="${v.kind === "exempt"}">Don’t charge VAT</button>
        </div>
        ${v.kind === "standard"
          ? (d.reference.vatRates
            ? `<label for="inv-rate">Rate</label><select id="inv-rate" name="rate" style="max-width:160px">${d.reference.vatRates.map((x) => `<option value="${x}" ${Number(v.rate) === x ? "selected" : ""}>${x} %</option>`).join("")}</select>`
            : `<label for="inv-rate">Rate (%)</label><input id="inv-rate" name="rate" type="number" min="0" max="100" step="0.1" value="${esc(v.rate ?? "")}" style="max-width:160px" />`)
          : `<label for="inv-reason">Why not</label>
             <select id="inv-reason" name="reason">${reasons.map((x) => `<option value="${esc(x.id)}" ${v.reason === x.id ? "selected" : ""}>${esc(x.label)}: ${esc(x.legalBasis)}</option>`).join("")}</select>
             <p class="zb-hint" style="margin-top:6px">${esc(reasons.find((x) => x.id === v.reason)?.hint || "")}</p>
             ${v.reason === "other" ? `<label for="inv-note">Exemption and legal basis</label><input id="inv-note" name="note" autocomplete="off" value="${esc(v.note || "")}" placeholder="Steuerfrei nach § 4 Nr. … UStG…" />` : ""}`}
      </fieldset>
      <details class="zb-more" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">More: customer’s VAT ID, currency, order number</summary>
        <div class="zb-row zb-row--3">
          ${f("inv-r-country", "Country", r.country || d.jurisdiction.country, 'maxlength="2"')}
          ${f("inv-r-vat", "Customer’s VAT ID", r.vatId, 'placeholder="For reverse charge…"')}
          ${f("inv-po", "Order number", invoiceDraft.purchaseOrder)}
        </div>
        ${f("inv-currency", "Currency", invoiceDraft.currency || "EUR", 'maxlength="3" style="max-width:120px;text-transform:uppercase"')}
        <p class="zb-hint" style="margin-top:6px">The invoice is written in this currency and still collected in euros, at the rate on the day it’s issued; the rate is printed on it.</p>
      </details>
      <div id="inv-check" class="zb-issues" aria-live="polite"></div>
      <div class="zb-actions">
        <button type="button" class="z-btn z-btn--secondary" data-act="inv-save">Save draft</button>
        <button type="button" class="z-btn z-btn--primary" data-act="inv-issue">${Z.icon("ios_share")}<span>Create and share</span></button>
        <button type="button" class="z-link-btn" data-act="inv-cancel">Cancel</button>
      </div>
      <p class="zb-hint" style="margin-top:12px">You share the invoice link yourself. Zold doesn’t send emails. A saved draft stays in this browser.</p>
      ${jurisdictionBanner(d.jurisdiction, d.disclaimer, d.notVerified)}
    </form>
    <div class="zb-editor__paper" id="inv-paper" aria-live="polite"><div class="zb-paper"><p>Add a customer and a line to see the invoice.</p></div></div>
  </div>`;
  return html;
};

/** Read the editor's inputs back into the draft. */
export function readInvoiceEditor() {
  if (!invoiceDraft || !$("#inv-form")) return;
  const val = (id) => $("#" + id)?.value?.trim() ?? "";
  invoiceDraft.recipient = {
    name: val("inv-r-name"), addressLine: val("inv-r-addr"), postalCode: val("inv-r-zip"),
    city: val("inv-r-city"), country: val("inv-r-country").toUpperCase(), vatId: val("inv-r-vat"),
  };
  invoiceDraft.language = val("inv-lang") === "en" ? "en" : "de";
  invoiceDraft.issueDate = val("inv-issue");
  invoiceDraft.supplyDate = val("inv-supply");
  invoiceDraft.dueDate = val("inv-due") || undefined;
  invoiceDraft.purchaseOrder = val("inv-po");
  invoiceDraft.currency = val("inv-currency").toUpperCase() || "EUR";
  $("#inv-lines")?.querySelectorAll("input").forEach((el) => {
    // A decimal comma ("980,00") in a number; the description keeps its own.
    invoiceDraft.lines[Number(el.dataset.li)][el.dataset.lf] = el.dataset.lf === "description" ? el.value : el.value.trim().replace(",", ".");
  });
  if (invoiceDraft.vat.kind === "standard") {
    // No silent default: a missing rate is refused by the check, never
    // quietly read as Germany's 19.
    const rate = $("#inv-rate")?.value;
    invoiceDraft.vat.rate = rate === undefined || rate === "" ? undefined : Number(rate);
  } else {
    invoiceDraft.vat.reason = $("#inv-reason")?.value ?? invoiceDraft.vat.reason;
    invoiceDraft.vat.note = $("#inv-note")?.value ?? invoiceDraft.vat.note;
  }
}

/* What the API needs: the draft without the editor's own keys. */
export const invoiceBody = () => { const { _reasons, _defaultRate, ...b } = invoiceDraft; return b; };

/* ── The paper ─────────────────────────────────────────────────────────── */

const PAPER = {
  de: { invoice: "Rechnung", date: "Rechnungsdatum", supply: "Leistung", due: "Fällig", item: "Position", qty: "Menge", unit: "Einzelpreis", amount: "Betrag", net: "Netto", vat: "USt.", total: "Gesamt", taxNo: "St.-Nr.", vatId: "USt-IdNr.", pay: "Bitte überweisen an IBAN", ref: "Verwendungszweck", missing: "[fehlt]" },
  en: { invoice: "Invoice", date: "Invoice date", supply: "Service", due: "Due", item: "Item", qty: "Qty", unit: "Unit price", amount: "Amount", net: "Net", vat: "VAT", total: "Total", taxNo: "Tax no.", vatId: "VAT ID", pay: "Please transfer to IBAN", ref: "Reference", missing: "[missing]" },
};
const pMoney = (cents, cur, lang) => new Intl.NumberFormat(lang === "en" ? "en-IE" : "de-DE", { style: "currency", currency: cur || "EUR" }).format(cents / 100);
const pDate = (s, lang) => {
  const d = new Date(`${String(s || "").slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return lang === "en"
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d)
    : new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
};
const addr = (x) => [x?.addressLine, [x?.postalCode, x?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");

function paper(check) {
  const pv = check.preview || {};
  const lang = pv.language === "en" ? "en" : "de";
  const t = PAPER[lang];
  const cur = pv.currency || "EUR";
  const money = (c) => pMoney(c, cur, lang);
  const iss = profile.issuer || {};
  const rec = invoiceDraft.recipient || {};
  const taxId = iss.taxNumber ? [t.taxNo, iss.taxNumber] : iss.vatId ? [t.vatId, iss.vatId] : [t.vatId, null];
  const totals = check.totals || pv.totals;
  const reason = invoiceDraft.vat.kind === "exempt"
    ? [...(profile.reference.exemptionReasons || []), ...(profile.reference.customReasons || [])].find((x) => x.id === invoiceDraft.vat.reason) : null;
  const vatNote = reason ? (lang === "en" && reason.invoiceNoteEn ? reason.invoiceNoteEn : reason.invoiceNote) : "";
  const bank = profile.profile.bank;
  const lines = invoiceDraft.lines;
  const qty = (q) => String(q || "").replace(".", lang === "de" ? "," : ".");
  // translate="no": a browser translating the document would change what the
  // customer is billed for.
  return `<article class="zb-paper" lang="${lang}" translate="no" aria-label="${esc(`${t.invoice} ${pv.number || ""}`)}">
    <header class="zb-paper__head">
      <div><p class="zb-paper__who">${esc(iss.name || "")}</p><p>${esc(addr(iss)) || `<span class="zb-paper__missing">${t.missing}</span>`}</p></div>
      <p class="zb-paper__tax">${esc(taxId[0])} ${taxId[1] ? esc(taxId[1]) : `<span class="zb-paper__missing">${t.missing}</span>`}</p>
    </header>
    <p class="zb-paper__to">${esc(rec.name || "")}<br>${esc(addr(rec))}</p>
    <h2 class="zb-paper__title">${esc(t.invoice)} ${esc(pv.number || "")}</h2>
    <div class="zb-paper__meta">
      <p><span>${esc(t.date)}</span>${esc(pDate(invoiceDraft.issueDate, lang))}</p>
      <p><span>${esc(t.supply)}</span>${esc(pDate(invoiceDraft.supplyDate, lang))}</p>
      ${pv.dueDate ? `<p><span>${esc(t.due)}</span>${esc(pDate(pv.dueDate, lang))}</p>` : ""}
    </div>
    <table><thead><tr><th scope="col">${esc(t.item)}</th><th scope="col">${esc(t.qty)}</th><th scope="col">${esc(t.unit)}</th><th scope="col">${esc(t.amount)}</th></tr></thead>
      <tbody>${(totals?.lines || []).map((l, i) => `<tr><td>${esc(l.description || lines[i]?.description || "")}</td><td>${esc(qty(lines[i]?.quantity ?? l.quantity))}</td><td>${esc(money(Math.round(Number(lines[i]?.unitPriceNet || 0) * 100)))}</td><td>${esc(money(l.netCents))}</td></tr>`).join("")}</tbody></table>
    <div class="zb-paper__sum">
      ${totals?.vatCents ? `<div><span>${esc(t.net)}</span><span>${esc(money(totals.netCents))}</span></div>${(totals.buckets || []).filter((b) => b.rate > 0).map((b) => `<div><span>${esc(t.vat)} ${b.rate} %</span><span>${esc(money(b.vatCents))}</span></div>`).join("")}` : ""}
      <div class="is-total"><span>${esc(t.total)}</span><span>${esc(money(totals?.grossCents || 0))}</span></div>
    </div>
    ${vatNote ? `<p class="zb-paper__foot">${esc(vatNote)}</p>` : ""}
    ${bank?.iban ? `<p class="zb-paper__foot">${esc(t.pay)} ${esc(Z.groupIban(bank.iban))}${bank.bic ? `, BIC ${esc(bank.bic)}` : ""}<br>${esc(t.ref)} ${esc(pv.number || "")}</p>` : ""}
  </article>`;
}

/** Ask the API, then draw what is missing and the paper. */
export async function refreshInvoiceCheck() {
  const box = $("#inv-check");
  if (!box || !invoiceDraft || !profile) return;
  readInvoiceEditor();
  const mine = ++checkSeq;
  try {
    const r = await api(`/api/orgs/${org.id}/invoicing/check`, { method: "POST", body: invoiceBody() });
    if (mine !== checkSeq) return;
    const conv = r.preview?.conversion;
    const issues = [
      ...r.errors.map((i) => `<div class="zb-note zb-note--a">${Z.icon("error")}<span>${esc(i.message)}${i.legalBasis ? ` <span class="desc">(${esc(i.legalBasis)})</span>` : ""}</span></div>`),
      ...r.warnings.map((i) => `<div class="zb-note">${Z.icon("info")}<span>${esc(i.message)}</span></div>`),
    ];
    box.innerHTML = `${r.ok ? `<p class="zb-hint">${Z.tag("Done")} Every required field is there.</p>` : `<p class="zb-hint" style="margin-top:6px"><b style="color:var(--z-text)">${r.errors.length} thing${r.errors.length === 1 ? "" : "s"} still needed</b></p>`}${issues.join("")}
      ${conv ? `<p class="zb-hint">Collected as ${esc(pMoney(conv.grossCents, conv.to, "en"))} · 1 ${esc(conv.to)} = ${esc(String(conv.rate))} ${esc(conv.from)}</p>` : ""}`;
    $("#inv-paper").innerHTML = paper(r);
  } catch (e) {
    if (mine !== checkSeq) return;
    box.innerHTML = `<div class="zb-note zb-note--a">${Z.icon("error")}<span>${esc(e.message)}</span></div>`;
  }
}
