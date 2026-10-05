/**
 * Invoices from wallet receipts, as the business screens show them: the
 * payer rule on a contact, and what a collection run did. The draft itself
 * is drawn with the other invoices (screens.js); the actions that start a
 * run or issue a draft are in actions.js.
 */
import { $, Z, api, cap, dialog, esc, eur, org, toast } from "./core.js";

const field = (id, label, extra = "") => `<label for="${id}">${label}</label><input id="${id}" name="${id}" autocomplete="off" ${extra} />`;

const vatWord = (vat) => (vat.kind === "standard" ? `${vat.rate}% VAT` : `No VAT (${vat.reason.replace(/_/g, " ")})`);

/* The contact's payer rule, in its drawer: what the rule says, or what one
   would do. Shown only where the plan includes invoices. */
export function payerRuleSection(c) {
  if (!cap("invoices").allowed) return "";
  const r = c.payerRule;
  return `<section><h3 class="z-eyebrow" style="margin-bottom:8px">Invoices from receipts</h3>
    ${r ? `<dl class="z-kv z-card">
        <div><dt>Invoiced as</dt><dd>${esc(r.serviceDescription)}</dd></div>
        <div><dt>Addressed to</dt><dd>${esc(r.recipient?.name || "")}</dd></div>
        <div><dt>Tax line</dt><dd>${esc(vatWord(r.vat))}</dd></div>
        <div><dt>Pays from</dt><dd>${c.wallets.length} address${c.wallets.length === 1 ? "" : "es"}</dd></div></dl>`
      : `<p class="zb-hint">Not set. With a payer rule, what this contact pays into your imported wallets is collected into one draft invoice a month.</p>`}
    <div class="zb-actions"><button type="button" class="z-btn z-btn--secondary" id="ct-rule">${Z.icon("receipt_long")}<span>${r ? "Edit payer rule" : "Set payer rule"}</span></button></div></section>`;
}

/* "1 0xabc…" per line. A line that names an address the contact already has
   keeps that wallet's id and label. */
function payerAddresses(text, existing) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const m = /^(\d+)\s+(0x[0-9a-fA-F]{40})$/.exec(line);
    if (!m) throw new Error(`Address line ${i + 1}: write the network id, a space, then the address (for example “1 0x…” for Ethereum).`);
    const chainId = Number(m[1]);
    const address = m[2].toLowerCase();
    const known = existing.find((w) => w.chainId === chainId && w.address.toLowerCase() === address);
    return known || { chainId, address };
  });
}

export async function payerRuleDialog(c) {
  const profile = await api(`/api/orgs/${org.id}/invoicing/profile`);
  const reasons = [...(profile.reference.exemptionReasons || []), ...(profile.reference.customReasons || [])];
  const r = c.payerRule;
  const rec = r?.recipient || {};
  const chosen = r ? (r.vat.kind === "standard" ? "standard" : `exempt:${r.vat.reason}`) : "";
  const opt = (value, label) => `<option value="${esc(value)}"${value === chosen ? " selected" : ""}>${esc(label)}</option>`;
  dialog(`Invoice ${c.name} from receipts`,
    `<p class="desc">Each month, what this contact pays into your imported wallets becomes one draft invoice: one line per receipt, at its euro value on arrival. Nothing is issued until you issue it.</p>
     ${field("pr-desc", "What you invoice", `maxlength="200" value="${esc(r?.serviceDescription || "")}" placeholder="Delegate services…"`)}
     <label for="pr-addr">Addresses it pays from <span class="desc">(network id, then address; one per line)</span></label>
     <textarea id="pr-addr" name="pr-addr" rows="3" spellcheck="false" autocomplete="off" placeholder="1 0x…">${esc(c.wallets.map((w) => `${w.chainId} ${w.address}`).join("\n"))}</textarea>
     ${field("pr-name", "Invoice addressed to", `autocomplete="organization" value="${esc(rec.name || c.name)}"`)}
     ${field("pr-line", "Street and number", `value="${esc(rec.addressLine || "")}"`)}
     ${field("pr-zip", "Postal code", `value="${esc(rec.postalCode || "")}"`)}
     ${field("pr-city", "City", `value="${esc(rec.city || "")}"`)}
     ${field("pr-country", "Country", `maxlength="2" value="${esc(rec.country || "")}" placeholder="KY…"`)}
     ${field("pr-vatid", 'Their VAT ID <span class="desc">(optional)</span>', `spellcheck="false" value="${esc(rec.vatId || "")}"`)}
     <label for="pr-vat">Tax line</label>
     <select id="pr-vat" name="pr-vat"><option value="">Choose…</option>${opt("standard", "Charge VAT at the rate below")}${reasons.map((x) => opt(`exempt:${x.id}`, `No VAT: ${x.label}`)).join("")}</select>
     ${field("pr-rate", 'VAT rate, % <span class="desc">(when you charge VAT)</span>', `inputmode="decimal" value="${esc(r?.vat.kind === "standard" ? r.vat.rate : "")}"`)}
     ${field("pr-note", 'Note printed on the invoice <span class="desc">(when the reason needs one)</span>', `value="${esc(r?.vat.kind === "exempt" ? r.vat.note || "" : "")}"`)}
     <label for="pr-lang">Language</label>
     <select id="pr-lang" name="pr-lang"><option value="en"${r?.language === "de" ? "" : " selected"}>English</option><option value="de"${r?.language === "de" ? " selected" : ""}>German</option></select>
     <p class="desc" style="margin-top:12px">You choose the tax line; Zold doesn’t. How a payment from a DAO is taxed is a question for your Steuerberater.</p>`,
    async () => {
      const wallets = payerAddresses($("#pr-addr").value, c.wallets);
      const pick = $("#pr-vat").value;
      if (!pick) throw new Error("Choose the tax line.");
      const note = $("#pr-note").value.trim();
      const vat = pick === "standard"
        ? { kind: "standard", rate: Number($("#pr-rate").value.replace(",", ".")) }
        : { kind: "exempt", reason: pick.slice("exempt:".length), ...(note ? { note } : {}) };
      if (vat.kind === "standard" && !$("#pr-rate").value.trim()) throw new Error("Enter the VAT rate you charge.");
      const text = (id) => $(id).value.trim() || undefined;
      await api(`/api/orgs/${org.id}/contacts/${c.id}/payer-rule`, {
        method: "PUT",
        body: {
          serviceDescription: $("#pr-desc").value,
          vat,
          recipient: { name: $("#pr-name").value, addressLine: text("#pr-line"), postalCode: text("#pr-zip"), city: text("#pr-city"), country: text("#pr-country"), vatId: text("#pr-vatid"), isBusiness: true },
          supplyKind: "services",
          language: $("#pr-lang").value,
          // Saved with the rule, or not at all.
          wallets,
        },
      });
      toast("Payer rule saved.");
    }, {
      okLabel: "Save rule",
      secondary: r ? {
        label: "Stop invoicing",
        onSubmit: async () => {
          await api(`/api/orgs/${org.id}/contacts/${c.id}/payer-rule`, { method: "DELETE" });
          toast("Payer rule removed. Drafts and invoices already made stay.");
        },
      } : null,
    });
}

/* What a run did, said in full: every valued receipt of the month is on a
   draft, or named here as left out. */
export function runSummary(r) {
  const month = new Date(`${r.month}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const cents = (c) => eur(c / 100);
  const plural = (n) => `${n} receipt${n === 1 ? "" : "s"}`;
  // "2 receipts, €70.00, and 1 with no value".
  const uninvoiced = (u) => [u.receipts ? `${plural(u.receipts)}, ${cents(u.eurCents)}` : "", u.unvalued ? `${u.unvalued} with no value` : ""].filter(Boolean).join(", and ");
  const drafted = r.contacts.filter((c) => c.invoiceId);
  const li = [
    ...drafted.map((c) => `<li><b>${esc(c.name)}</b>: ${c.lines} receipt${c.lines === 1 ? "" : "s"}, ${esc(cents(c.eurCents))} on a draft${c.excluded.length ? `; ${c.excluded.length} not included (open the draft to see why)` : ""}${c.mismatchCents ? "; the total can’t be split into net and VAT, so it can’t be issued from here" : ""}</li>`),
    ...r.contacts.filter((c) => !c.invoiceId).map((c) => `<li><b>${esc(c.name)}</b>: nothing to invoice; ${c.excluded.length} receipt${c.excluded.length === 1 ? "" : "s"} not included (${esc(c.excluded[0].reason)})</li>`),
    ...r.withoutRule.map((c) => `<li><b>${esc(c.name)}</b>: ${esc(uninvoiced(c))}, not invoiced because the contact has no payer rule</li>`),
    ...(r.withoutContact.receipts || r.withoutContact.unvalued ? [`<li>${esc(uninvoiced(r.withoutContact))}, from addresses that are in no contact, or in more than one</li>`] : []),
    ...(r.alreadyInvoiced.receipts ? [`<li>${plural(r.alreadyInvoiced.receipts)} already on an issued invoice</li>`] : []),
    ...r.onOtherDrafts.map((d) => `<li>${plural(d.receipts)} held by a draft whose contact has no payer rule any more: issue it after setting the rule again, or discard it</li>`),
  ];
  const behind = r.syncWarnings.length
    ? `<div class="zb-note zb-note--a">${Z.icon("warning")}<span>This month may be incomplete: ${r.syncWarnings.map(esc).join(" ")}</span></div>`
    : "";
  return li.length
    ? `${behind}<p class="desc">Receipts of ${esc(month)}:</p><ul class="desc" style="margin:8px 0 0 18px">${li.join("")}</ul>
       <p class="desc" style="margin-top:12px">Drafts are not invoices yet. Open one to check it and issue it.</p>`
    : `${behind}<p class="desc">The ledger holds no receipts into your imported wallets for ${esc(month)}.</p>`;
}
