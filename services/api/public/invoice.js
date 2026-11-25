import { lineNetCents, formTotalCents, formatCents } from "/invoice-totals.js";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const token = location.pathname.split("/").filter(Boolean).pop();
// /invoice/own?org=…&id=… is the issuer reading their own issued invoice
// again (Zold Business): their session, not the link, which is shown once.
const own = token === "own" ? new URLSearchParams(location.search) : null;
let session = "";
try { session = localStorage.getItem("zold-session") || localStorage.getItem("zoll-session") || ""; } catch { /* signed out */ }
let password = "";
/** The chains a wallet payout may be on, from the server: [{ chainId, name }]. */
let chains = [];

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(password ? { "x-invoice-password": password } : {}),
        ...(own && session ? { authorization: `Bearer ${session}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // A network failure reads as "Failed to fetch", which tells nobody anything.
    throw new Error("Couldn’t reach Zold. Check your connection, then reload the page.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); Object.assign(e, data, { status: res.status }); throw e; }
  return data;
}

// Numbers and dates are written the way the invoice's language writes them.
const LOCALES = { de: "de-DE", en: "en-GB", fr: "fr-FR", es: "es-ES" };
const money = (cents, currency = "EUR", locale = "en-GB") =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format((cents ?? 0) / 100);
const date = (iso, locale = "en-GB") =>
  (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: locale === "de-DE" ? "2-digit" : "short", year: "numeric" }) : "");

// Labels live in one place so a bilingual invoice stays consistent.
const L = {
  de: { invoice: "Rechnung", number: "Rechnungsnummer", issueDate: "Rechnungsdatum",
        supplyDate: "Leistungsdatum", supplyPeriod: "Leistungszeitraum", vatId: "USt-IdNr.",
        taxNumber: "Steuernummer", description: "Bezeichnung", qty: "Menge", unit: "Einzelpreis",
        rate: "USt.", amount: "Betrag", net: "Nettobetrag", vat: "Umsatzsteuer", gross: "Gesamtbetrag",
        terms: "Zahlungsbedingungen", bank: "Bankverbindung", po: "Bestellnummer", due: "Fällig am",
        from: "Rechnungssteller", to: "Rechnungsempfänger",
        converted: "Umrechnungskurs:", payIn: "Zahlbar in",
        convBasis: "Der Steuerbetrag ist gemäß § 16 Abs. 6 UStG zusätzlich in Euro angegeben." },
  en: { invoice: "Invoice", number: "Invoice number", issueDate: "Invoice date",
        supplyDate: "Date of supply", supplyPeriod: "Period of supply", vatId: "VAT ID",
        taxNumber: "Tax number", description: "Description", qty: "Qty", unit: "Unit price",
        rate: "VAT", amount: "Amount", net: "Net", vat: "VAT", gross: "Total",
        terms: "Payment terms", bank: "Bank details", po: "Purchase order", due: "Due",
        from: "From", to: "To",
        converted: "Rate of exchange:", payIn: "Payable in",
        convBasis: "The tax amount is also stated in euro, as § 16 Abs. 6 UStG requires." },
  fr: { invoice: "Facture", number: "Numéro de facture", issueDate: "Date de facture",
        supplyDate: "Date de livraison", supplyPeriod: "Période de prestation", vatId: "N° de TVA",
        taxNumber: "Numéro fiscal", description: "Désignation", qty: "Qté", unit: "Prix unitaire",
        rate: "TVA", amount: "Montant", net: "Net HT", vat: "TVA", gross: "Total TTC",
        terms: "Conditions de paiement", bank: "Coordonnées bancaires", po: "N° de commande", due: "Échéance",
        from: "Émetteur", to: "Destinataire",
        converted: "Taux de change :", payIn: "Payable en",
        convBasis: "Le montant de la taxe est également indiqué en euros, conformément au § 16 Abs. 6 UStG." },
  es: { invoice: "Factura", number: "Número de factura", issueDate: "Fecha de factura",
        supplyDate: "Fecha de prestación", supplyPeriod: "Período de prestación", vatId: "NIF-IVA",
        taxNumber: "NIF", description: "Descripción", qty: "Cant.", unit: "Precio unitario",
        rate: "IVA", amount: "Importe", net: "Base imponible", vat: "IVA", gross: "Total",
        terms: "Condiciones de pago", bank: "Datos bancarios", po: "N.º de pedido", due: "Vencimiento",
        from: "Emisor", to: "Destinatario",
        converted: "Tipo de cambio:", payIn: "Pagadero en",
        convBasis: "El importe del impuesto también se indica en euros, conforme al § 16 Abs. 6 UStG." },
};

// The country is printed unless it is the issuer's own: a cross-border
// invoice names both, a domestic one neither.
const addressOf = (p, home) => [
  p?.addressLine,
  [p?.postalCode, p?.city].filter(Boolean).join(" "),
  p?.country && p.country !== home ? p.country : "",
].filter(Boolean);

/** Render an issued invoice as the printable document. */
function renderIssued(inv) {
  const d = inv.issued;
  const sheetLang = L[d.language] ? d.language : "en";
  const t = L[sheetLang];
  const loc = LOCALES[sheetLang];
  const home = d.issuer?.country;
  const amount = (c, cu) => money(c, cu, loc);
  const day = (iso) => date(iso, loc);
  const decimal = (v) => Number(v).toLocaleString(loc, { minimumFractionDigits: 2 });
  const settled = inv.state === "PAID" || inv.state === "RECONCILED";
  // The issuer reading their own invoice is not the one to pay it.
  const pay = !settled && !own && inv.payPath ? inv.payPath : "";
  const show = d.display ?? {};
  const bilingual = show.bilingual;
  const lab = (k) => (bilingual && L.de[k] !== L.en[k] ? `${L.de[k]} / ${L.en[k]}` : t[k]);

  const issuerLines = [
    d.issuer.name,
    ...addressOf(d.issuer, home),
    show.issuerVatId !== false && d.issuer.vatId ? `${t.vatId} ${d.issuer.vatId}` : "",
    show.issuerTaxNumber !== false && d.issuer.taxNumber ? `${t.taxNumber} ${d.issuer.taxNumber}` : "",
  ].filter(Boolean);

  const metaRows = [
    [lab("number"), d.number],
    [lab("issueDate"), day(d.issueDate)],
    d.supplyPeriod && show.supplyPeriod !== false
      ? [lab("supplyPeriod"), `${day(d.supplyPeriod.from)} – ${day(d.supplyPeriod.to)}`]
      : d.supplyDate ? [lab("supplyDate"), day(d.supplyDate)] : null,
    inv.dueDate ? [lab("due"), day(inv.dueDate)] : null,
    show.purchaseOrder && d.purchaseOrder ? [lab("po"), d.purchaseOrder] : null,
    show.recipientVatId !== false && d.recipient.vatId ? [lab("vatId"), d.recipient.vatId] : null,
    ...(d.customFields ?? []).map((f) => [f.label, f.value]),
  ].filter(Boolean);

  const exempt = d.vatTreatment?.kind === "exempt";
  /** The document's own currency, and its euro restatement when it has one.
   *  Rows issued before invoices could be denominated in anything are EUR. */
  const cur = d.currency ?? "EUR";
  const conv = d.conversion;

  // The sheet is typeset in the invoice's language; the chrome around it stays
  // English, so the language is declared on the sheet rather than on <html>.
  return `
  <div class="sheet" id="sheet" lang="${sheetLang}">
    <div class="sheet-head">
      <div>
        <h1>${esc(bilingual ? "Rechnung / Invoice" : t.invoice)}</h1>
        <div class="sub">${esc(d.number)}</div>
      </div>
      <div class="issuer-block">
        ${issuerLines.map((l, i) => (i === 0 ? `<strong>${esc(l)}</strong>` : esc(l))).join("<br>")}
      </div>
    </div>

    <div class="sender-line">${esc([d.issuer.name, ...addressOf(d.issuer, home)].join(" · "))}</div>

    <div class="parties">
      <div class="addr">
        <div class="who">${esc(d.recipient.name ?? "")}</div>
        ${addressOf(d.recipient, home).map(esc).join("<br>")}
      </div>
      <div class="meta">
        ${metaRows.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
      </div>
    </div>

    <table class="items">
      <thead><tr>
        <th>${esc(lab("description"))}</th>
        <th class="num">${esc(lab("qty"))}</th>
        <th class="num">${esc(lab("unit"))}</th>
        ${exempt ? "" : `<th class="num">${esc(lab("rate"))}</th>`}
        <th class="num">${esc(lab("amount"))}</th>
      </tr></thead>
      <tbody>
        ${inv.lines.map((l) => `<tr>
          <td>${esc(l.description)}</td>
          <td class="num">${esc(l.quantity)}</td>
          <td class="num">${esc(decimal(l.unitPrice))}</td>
          ${exempt ? "" : `<td class="num">${esc(d.vatTreatment.rate)} %</td>`}
          <td class="num">${esc(decimal(l.amount))}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <div class="totals"><table>
      <tr><td>${esc(lab("net"))}</td><td class="num">${amount(d.netCents, cur)}</td></tr>
      ${(d.buckets ?? []).filter((b) => b.rate > 0).map((b) =>
        `<tr><td>${esc(lab("vat"))} ${b.rate} % ${esc(bilingual ? "auf / on" : { de: "auf", fr: "sur", es: "sobre" }[sheetLang] || "on")} ${amount(b.netCents, cur)}</td>
             <td class="num">${amount(b.vatCents, cur)}</td></tr>`).join("")}
      <tr class="grand"><td>${esc(lab("gross"))}</td><td class="num">${amount(d.grossCents, cur)}</td></tr>
      ${conv ? `
      <tr class="conv"><td colspan="2">${esc(lab("converted"))} 1 ${esc(conv.to)} = ${esc(conv.rate.toLocaleString(loc, { maximumFractionDigits: 6 }))} ${esc(conv.from)}
        <span class="basis">${esc(conv.rateProvider)}${conv.rateAsOf && conv.rateAsOf !== "unknown" ? `, ${esc(conv.rateAsOf)}` : ""}</span></td></tr>
      ${(conv.buckets ?? []).filter((b) => b.rate > 0).map((b) =>
        `<tr><td>${esc(lab("vat"))} ${b.rate} % ${esc(bilingual ? "in / in" : sheetLang === "de" ? "in" : "en")} ${esc(conv.to)}</td>
             <td class="num">${amount(b.vatCents, conv.to)}</td></tr>`).join("")}
      <tr><td>${esc(lab("gross"))} ${esc(bilingual ? "in / in" : sheetLang === "de" ? "in" : "en")} ${esc(conv.to)}</td><td class="num">${amount(conv.grossCents, conv.to)}</td></tr>
      ` : ""}
    </table></div>
    ${conv ? `<div class="vat-note"><div>${esc(lab("payIn"))} ${amount(conv.grossCents, conv.to)}.</div>
      ${d.jurisdiction?.ruleSet === "DE" ? `<div class="basis">${esc(lab("convBasis"))}</div>` : ""}</div>` : ""}

    ${d.vatNote ? `<div class="vat-note"><div>${esc(d.vatNote)}</div>
      ${d.vatTreatment?.reason ? `<div class="basis">${esc(reasonBasis(d.vatTreatment.reason, d.jurisdiction?.ruleSet))}</div>` : ""}</div>` : ""}

    <div class="blocks">
      ${show.paymentTerms !== false && d.paymentTerms
        ? `<div><h3>${esc(lab("terms"))}</h3>${esc(d.paymentTerms)}</div>` : ""}
      ${show.bankDetails !== false && inv.bank
        ? `<div><h3>${esc(lab("bank"))}</h3>${[inv.bank.holder, inv.bank.iban, inv.bank.bic, inv.bank.bankName].filter(Boolean).map(esc).join("<br>")}</div>` : ""}
      ${show.notes !== false && d.notes ? `<div><h3>&nbsp;</h3>${esc(d.notes)}</div>` : ""}
    </div>

    ${show.footer !== false && inv.footerNote
      ? `<div class="sheet-footer">${esc(inv.footerNote)}</div>` : ""}
  </div>

  <div class="panel no-print">
    <h2>${esc(settled ? "Paid" : "Awaiting payment")}</h2>
    ${pay ? `<p style="margin:.6rem 0 1rem"><a class="pay-btn" href="${esc(pay)}">Pay ${esc(amount(conv ? conv.grossCents : d.grossCents, conv ? conv.to : cur))}</a></p>
      <div class="note">You choose how to pay on the next page. This invoice is marked paid when the money arrives.</div>` : ""}
    ${!settled && !own && !pay && inv.payLinkLapsed ? `<div class="note">The Pay link for this invoice has expired. ${inv.bank ? "You can still pay by bank transfer to the details on the invoice, or ask" : "Ask"} ${esc(d.issuer?.name || "the issuer")} for a new link.</div>` : ""}
    <div class="note">${esc(complianceNote(d.jurisdiction))} Zold is not a tax
      adviser — whether a supply is exempt, and which exemption applies, is the issuer's determination.${d.jurisdiction?.ruleSet === "DE" ? `
      Zold does not yet produce an EN 16931 e-invoice (XRechnung / ZUGFeRD).` : ""}</div>
  </div>`;
}

// Citations follow the rule set the invoice was issued under. A German
// paragraph printed at a Polish or Indian entity is confidently wrong, so
// EU invoices cite the Directive and GENERIC ones cite nothing.
const BASES = {
  DE: {
    kleinunternehmer: "§ 19 UStG",
    reverse_charge_eu: "§ 3a Abs. 2 UStG, Art. 196 MwStSystRL",
    reverse_charge_domestic: "§ 13b UStG",
    intra_community_supply: "§ 4 Nr. 1b i. V. m. § 6a UStG",
    export_third_country: "§ 4 Nr. 1a i. V. m. § 6 UStG",
    not_taxable_place_of_supply: "§ 3a Abs. 2 UStG",
  },
  EU: {
    reverse_charge_eu: "Art. 196 VAT Directive (2006/112/EC)",
    intra_community_supply: "Art. 138 VAT Directive (2006/112/EC)",
    export_third_country: "Art. 146 VAT Directive (2006/112/EC)",
    not_taxable_place_of_supply: "Art. 44 VAT Directive (2006/112/EC)",
  },
};
const reasonBasis = (r, ruleSet) => BASES[ruleSet]?.[r] ?? "";
const complianceNote = (j) =>
  j?.ruleSet === "DE"
    ? "This document was generated by Zold against §§ 14, 14a UStG."
    : j?.ruleSet === "EU"
      ? `This document was generated by Zold against the VAT Directive baseline (Art. 226); ${j.countryName || j.country}'s national additions were not checked.`
      : "This document was generated by Zold with structural checks only — no tax law of the issuer's country was applied.";

// ── the incoming "Invoice-Me" flow, unchanged in behaviour ─────────────────

let lines = [{ description: "", quantity: "1", unitPrice: "" }];
const lineRows = () => lines.map((l, i) => `<tr>
  <td><input data-i="${i}" data-f="description" value="${esc(l.description)}" placeholder="What you did" aria-label="Line ${i + 1} description" /></td>
  <td style="width:80px"><input data-i="${i}" data-f="quantity" value="${esc(l.quantity)}" inputmode="decimal" aria-label="Line ${i + 1} quantity" /></td>
  <td style="width:110px"><input data-i="${i}" data-f="unitPrice" value="${esc(l.unitPrice)}" placeholder="0.00" inputmode="decimal" aria-label="Line ${i + 1} unit price" /></td>
  <td style="width:100px" class="num">${lineAmount(l)}</td>
</tr>`).join("");
const lineAmount = (l) => formatCents(lineNetCents(l.quantity, l.unitPrice));
const total = () => formatCents(formTotalCents(lines));

function renderForm(inv) {
  $("#content").innerHTML = `
    <div class="panel"><h2>Invoice requested by ${esc(inv.payor.name)}</h2>
      <div class="note">Fill this in and submit — no account and no wallet needed. Once submitted it is
        timestamped and locked.</div>
      <label for="f-org">Your organisation</label><input id="f-org" autocomplete="organization" />
      <label for="f-email">Email</label><input id="f-email" type="email" autocomplete="email" />
      <label for="f-num">Invoice number</label><input id="f-num" />
      <label for="f-vat">VAT ID (optional)</label><input id="f-vat" placeholder="DE123456789" />
      <label for="f-addr">Address (optional)</label><input id="f-addr" autocomplete="street-address" />
    </div>
    <div class="panel"><h2>Lines</h2>
      <table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
        <tbody id="lines">${lineRows()}</tbody></table>
      <div style="margin-top:.7rem"><button class="ghost" id="add-line">Add line</button></div>
      <div style="margin-top:1rem; text-align:right; font-size:1.1rem; font-weight:600" id="total">${total()} ${esc(inv.currency)}</div>
    </div>
    <div class="panel"><h2>How to pay you</h2>
      <div class="note">Your bank account lets ${esc(inv.payor.name)} pay this invoice by SEPA transfer with your invoice number as the reference.</div>
      <label for="f-holder">Account holder</label><input id="f-holder" placeholder="Name on the account" />
      <label for="f-iban">IBAN</label><input id="f-iban" placeholder="DE89 3704 0044 0532 0130 00" />
      <label for="f-bic">BIC (optional)</label><input id="f-bic" placeholder="COBADEFFXXX" />
      <details style="margin-top:.8rem"><summary style="cursor:pointer;color:var(--muted)">Or a wallet address instead</summary>
        <label for="f-wallet">Wallet address</label><input id="f-wallet" placeholder="0x…" />
        <label for="f-chain">Network</label><select id="f-chain">${chains.map((c) =>
          `<option value="${esc(c.chainId)}">${esc(c.name)}</option>`).join("")}</select>
      </details>
    </div>
    <div style="margin-top:1.2rem"><button id="submit">Submit invoice</button></div>
    <div id="err" role="alert"></div>`;

  $("#lines").addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset.f) return;
    lines[Number(el.dataset.i)][el.dataset.f] = el.value;
    $("#total").textContent = `${total()} ${inv.currency}`;
    $("#lines").querySelectorAll("tr").forEach((tr, i) => {
      tr.lastElementChild.textContent = lineAmount(lines[i]);
    });
  });
  $("#add-line").onclick = () => {
    lines.push({ description: "", quantity: "1", unitPrice: "" });
    $("#lines").innerHTML = lineRows();
  };
  $("#submit").onclick = async () => {
    $("#err").innerHTML = ""; $("#submit").disabled = true;
    try {
      const wallet = $("#f-wallet").value.trim();
      const iban = $("#f-iban").value.trim();
      const payTo = iban
        ? { kind: "bank", bank: { holderName: $("#f-holder").value.trim() || $("#f-org").value.trim(), iban, bic: $("#f-bic").value.trim() || undefined } }
        : wallet ? { kind: "wallet", address: wallet, chainId: Number($("#f-chain").value) } : undefined;
      const r = await api(`/api/invoice-links/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        body: {
          supplier: { orgName: $("#f-org").value, email: $("#f-email").value,
            invoiceNumber: $("#f-num").value, taxId: $("#f-vat").value, address: $("#f-addr").value },
          lines,
          payTo,
        },
      });
      render(r.invoice);
    } catch (e) {
      $("#err").innerHTML = `<div class="err">${esc(e.message)}</div>`;
      $("#submit").disabled = false;
    }
  };
}

/** A submitted incoming invoice, shown as a plain summary. */
function renderSubmitted(inv) {
  $("#content").innerHTML = `<div class="panel">
    <div style="display:flex; justify-content:space-between; align-items:center">
      <h2 style="margin:0">${esc(inv.supplier?.orgName ?? "")}</h2>
      <span class="pill ${inv.state === "PAID" || inv.state === "RECONCILED" ? "ok" : "mut"}">${esc(inv.state)}</span>
    </div>
    <table class="items" style="margin-top:1rem"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
      <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td>
        <td class="num">${esc(l.unitPrice)}</td><td class="num">${esc(l.amount)}</td></tr>`).join("")}</tbody></table>
    <div style="margin-top:1rem; text-align:right; font-size:1.2rem; font-weight:600">${esc(inv.total)} ${esc(inv.currency)}</div>
    ${inv.txHash ? `<div class="note">Paid — ${esc(inv.txHash)}</div>` : ""}
    <div class="note">Submitted ${esc((inv.submittedAt || "").slice(0, 10))}. Keep this link — reopen it any
      time to see the payment status.</div>
  </div>`;
}

function render(inv) {
  if (inv.issued) {
    const settled = inv.state === "PAID" || inv.state === "RECONCILED";
    document.title = `${inv.issued.number} · ${(L[inv.issued.language] || L.en).invoice}`;
    $("#actions").innerHTML = `${!settled && !own && inv.payPath ? `<a class="pay-btn" href="${esc(inv.payPath)}">Pay</a> ` : ""}<button class="ghost" id="print">Print / PDF</button>`;
    $("#print").addEventListener("click", () => window.print());
    $("#content").innerHTML = renderIssued(inv);
    return;
  }
  $("#actions").innerHTML = "";
  if (inv.editable) renderForm(inv);
  else renderSubmitted(inv);
}

function renderPassword(message) {
  $("#content").innerHTML = `<div class="panel">
    <h2>This link is password protected</h2>
    <form id="pw-form" novalidate>
      <label for="f-pw">Password</label><input id="f-pw" type="password" autocomplete="current-password" aria-describedby="err" />
      <div style="margin-top:1rem"><button id="pw-go" type="submit">Open</button></div>
    </form>
    <div id="err" role="alert">${password && message ? `<div class="err">${esc(message)}</div>` : ""}</div></div>`;
  // A wrong password re-renders this form; put the cursor back in the field.
  if (password) $("#f-pw").focus();
  $("#pw-form").onsubmit = async (e) => {
    e.preventDefault();
    const go = $("#pw-go");
    if (go.disabled) return; // already checking
    go.disabled = true;
    password = $("#f-pw").value;
    try { await boot(); } catch (err) { $("#err").innerHTML = `<div class="err">${esc(err.message)}</div>`; }
    finally { go.disabled = false; }
  };
}

async function boot() {
  let data;
  try {
    data = await api(own
      ? `/api/orgs/${encodeURIComponent(own.get("org") || "")}/invoices/${encodeURIComponent(own.get("id") || "")}/document`
      : `/api/invoice-links/${encodeURIComponent(token)}`);
  } catch (e) {
    if (e.passwordRequired) return renderPassword(e.message);
    // Only the server's 404 means the link is wrong; a dropped connection
    // says nothing about it.
    const msg = own
      ? (e.status === 401 ? "Sign in to Zold Business in this browser, then open the invoice again." : e.status === 404 ? "This invoice isn’t in this organisation, or it hasn’t been issued." : e.message)
      : e.status === 404
      ? "This link doesn’t work. It may have expired, been closed, or been typed wrong. Ask the person who sent it for a new one."
      : e.message;
    $("#content").innerHTML = `<div class="err" role="alert">${esc(msg)}</div>`;
    return;
  }
  chains = data.payoutChains || [];
  render(data.invoice);
}

boot();
