/**
 * Everything a [data-act] button does, keyed by action name.
 *
 * A map rather than a chain of ifs, for the same reason RENDER is one: the
 * shell dispatches on the attribute, so an action exists by being named here
 * and nowhere else.
 */
import { $, api, cap, dialog, esc, fmtEur, org, orgs, setView, toast, token } from "./core.js";
import { invoiceDraft, readInvoiceEditor, refreshInvoiceCheck, setInvoiceDraft } from "./views.js";
import { loadOrg, render } from "./shell.js";

export const ACTIONS = {
  async "shopify-connect"() {
    const shop = ($("#sh-shop").value || "").trim().toLowerCase();
    const r = await api(`/api/orgs/${org.id}/shopify/install`, { method: "POST", body: { shop } });
    if (!/^https:\/\//i.test(String(r.authorizeUrl))) return toast("Shopify returned an unusable install address", true);
    location.href = r.authorizeUrl;
  },
  async "shopify-disconnect"(el) {
    if (!confirm("Disconnect this store? Customers can no longer pick Zold at its checkout.")) return;
    await api(`/api/orgs/${org.id}/shopify/${el.dataset.id}`, { method: "DELETE" });
    toast("Store disconnected.");
    render();
  },
  async upgrade(el) {
    const r = await api(`/api/orgs/${org.id}/plan`, { method: "POST", body: { plan: el.dataset.plan } });
    if (r.note) toast(r.note);
    await loadOrg(org.id);
  },
  async trial() {
    await api(`/api/orgs/${org.id}/plan/trial`, { method: "POST" });
    toast("Trial started — 30 days.");
    await loadOrg(org.id);
  },
  "open-account": () => dialog("Open an account",
    `<label>Currency</label><select id="d-cur">
      <option value="EUR">EUR — SEPA</option><option value="USD">USD — ACH / SWIFT</option>
      <option value="GBP">GBP — Faster Payments</option><option value="KES">KES — M-Pesa</option>
      <option value="INR">INR — UPI</option></select>
     <label>Label (optional)</label><input id="d-label" placeholder="Operating account" />`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/accounts`, {
        method: "POST",
        body: { currency: $("#d-cur").value, label: $("#d-label").value },
      });
      toast(r.note || `${r.account.currency} account opened.`);
    }),
  "new-contact": () => dialog("Add contact",
    `<label>Name</label><input id="d-name" />
     <label>Email</label><input id="d-email" />
     <label>IBAN (optional)</label><input id="d-iban" placeholder="DE89 3704 0044 0532 0130 00" />
     <label>Account holder</label><input id="d-holder" />
     <label>Country</label><input id="d-country" maxlength="2" placeholder="DE" />`,
    async () => {
      const iban = $("#d-iban").value.trim();
      await api(`/api/orgs/${org.id}/contacts`, {
        method: "POST",
        body: {
          name: $("#d-name").value, email: $("#d-email").value,
          bankAccounts: iban ? [{
            currency: "EUR", country: $("#d-country").value || "DE",
            holderName: $("#d-holder").value || $("#d-name").value, iban,
          }] : [],
        },
      });
    }),
  async "del-contact"(el) {
    await api(`/api/orgs/${org.id}/contacts/${el.dataset.id}`, { method: "DELETE" });
  },
  "import-wallet": () => dialog("Import a wallet",
    `<div class="desc" style="margin-bottom:.6rem">Read-only. We never hold a key for an imported wallet.</div>
     <label>Address</label><input id="d-addr" placeholder="0x…" />
     <label>Chain ID</label><input id="d-chain" value="8453" />
     <label>Type</label><select id="d-kind"><option value="eoa">EOA</option>
       <option value="safe">Safe</option><option value="mpc">MPC</option></select>
     <label>Label</label><input id="d-label" />`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/wallets`, {
        method: "POST",
        body: { address: $("#d-addr").value, chainId: Number($("#d-chain").value),
          kind: $("#d-kind").value, label: $("#d-label").value },
      });
      toast(r.note);
    }),
  async "fund-account"(el) {
    const r = await api(`/api/orgs/${org.id}/accounts/${el.dataset.id}/fund`, { method: "POST" });
    toast(r.note);
  },
  async "del-wallet"(el) {
    await api(`/api/orgs/${org.id}/wallets/${el.dataset.id}`, { method: "DELETE" });
  },
  invite: () => dialog("Invite a member",
    `<label>Email</label><input id="d-email" />
     <label>Role</label><select id="d-role">
       <option value="viewer">Viewer — read only</option>
       <option value="accountant">Accountant — books, not money</option>
       <option value="payer">Payer — can send</option>
       <option value="admin">Admin — can approve</option>
       <option value="owner">Owner</option></select>`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/members`, {
        method: "POST", body: { email: $("#d-email").value, role: $("#d-role").value },
      });
      // No mail transport here, so hand the link over rather than pretend.
      prompt(r.note, `${location.origin}/app?invite=${r.inviteToken}`);
    }),
  async deactivate(el) {
    await api(`/api/orgs/${org.id}/members/${el.dataset.id}`, {
      method: "PATCH", body: { status: "deactivated" },
    });
  },
  async reactivate(el) {
    await api(`/api/orgs/${org.id}/members/${el.dataset.id}`, {
      method: "PATCH", body: { status: "active" },
    });
  },
  "invoicing-settings"() { setView("invoicing-settings"); },
  "goto-settings"() { setView("settings"); },
  "issue-invoice"() { setInvoiceDraft(null); setView("invoice-new"); },
  "inv-cancel"() { setInvoiceDraft(null); setView("invoices"); },
  "inv-add-line"() {
    readInvoiceEditor();
    invoiceDraft.lines.push({ description: "", quantity: "1", unitPriceNet: "" });
  },
  "inv-del-line"(el) {
    readInvoiceEditor();
    invoiceDraft.lines.splice(Number(el.dataset.i), 1);
  },
  "inv-vat-mode"(el) {
    readInvoiceEditor();
    // Switching mode REPLACES the treatment rather than merging: carrying a
    // rate across into the exempt arm is precisely the § 14c mistake.
    // The first available reason, not a German one — see the jurisdiction split.
    invoiceDraft.vat = el.dataset.mode === "exempt"
      ? { kind: "exempt", reason: invoiceDraft._reasons?.[0] ?? "other" }
      : { kind: "standard", rate: invoiceDraft._defaultRate ?? "" };
  },
  async "inv-issue"() {
    readInvoiceEditor();
    let r;
    try {
      r = await api(`/api/orgs/${org.id}/invoicing/issue`, { method: "POST", body: invoiceDraft });
    } catch (e) {
      if (e.status === 409 && e.warnings?.length) {
        const ok = confirm(
          "This invoice has warnings:\n\n" + e.warnings.map((w) => "• " + w.message).join("\n") +
          "\n\nIssue it anyway? Your acceptance is recorded on the document.",
        );
        if (!ok) return;
        r = await api(`/api/orgs/${org.id}/invoicing/issue`, {
          method: "POST", body: { ...invoiceDraft, acceptWarnings: true },
        });
      } else throw e;
    }
    setInvoiceDraft(null);
    setView("invoices");
    prompt(`Invoice ${r.invoice.issued.number} issued. Send your customer this link:`,
      location.origin + r.linkPath);
  },
  "add-custom-reason": () => dialog("Add your own rule",
    `<div class="desc" style="margin-bottom:.6rem">For something your country requires that Zold does
       not encode. The note is printed on the invoice exactly as you write it, and is not checked.</div>
     <label>Id</label><input id="cr-id" placeholder="gst_rcm" />
     <label>Label</label><input id="cr-label" placeholder="GST reverse charge" />
     <label>Legal basis (optional)</label><input id="cr-basis" placeholder="Section 9(3) CGST Act" />
     <label>Note printed on the invoice</label><input id="cr-note" placeholder="Tax payable under reverse charge mechanism" />
     <label style="display:flex; gap:.5rem; align-items:center; margin-top:.8rem">
       <input type="checkbox" id="cr-vat" style="width:auto" />
       <span style="color:var(--text); font-size:.85rem">Requires the customer's tax identifier</span></label>`,
    async () => {
      const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
      const existing = d.profile.customReasons ?? [];
      await api(`/api/orgs/${org.id}/invoicing/profile`, {
        method: "PATCH",
        body: {
          customReasons: [...existing, {
            id: $("#cr-id").value, label: $("#cr-label").value,
            legalBasis: $("#cr-basis").value, invoiceNote: $("#cr-note").value,
            requiresRecipientVatId: $("#cr-vat").checked,
          }],
        },
      });
    }),
  async "del-custom-reason"(el) {
    const d = await api(`/api/orgs/${org.id}/invoicing/profile`);
    await api(`/api/orgs/${org.id}/invoicing/profile`, {
      method: "PATCH",
      body: { customReasons: (d.profile.customReasons ?? []).filter((c) => c.id !== el.dataset.id) },
    });
  },
  async "save-invoicing"() {
    const val = (id) => $("#" + id)?.value?.trim() ?? "";
    const display = {};
    document.querySelectorAll("[data-display]").forEach((el) => {
      display[el.dataset.display] = el.checked;
    });
    await api(`/api/orgs/${org.id}/invoicing/profile`, {
      method: "PATCH",
      body: {
        vatId: val("i-vatid"), taxNumber: val("i-taxno"),
        smallBusiness: $("#i-klein")?.checked === true,
        defaultVatRate: $("#i-rate")?.value ? Number($("#i-rate").value) : undefined,
        paymentTermsDays: val("i-terms-days") ? Number(val("i-terms-days")) : undefined,
        paymentTermsNote: val("i-terms"),
        registerCourt: val("i-court"), registerNumber: val("i-reg"),
        managingDirector: val("i-gf"), footerNote: val("i-footer"),
        bank: { holder: val("i-bank-holder"), iban: val("i-bank-iban"), bic: val("i-bank-bic") },
        numberSeries: { prefix: val("i-prefix"), next: Number(val("i-next") || 1), padding: 4 },
        display,
      },
    });
    toast("Invoicing profile saved.");
  },
  "pay-invoice": async (el) => {
    const r = await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/pay`, { method: "POST", body: {} });
    toast(r.note || "Payment drafted.");
  },
  "reconcile-invoice": (el) => dialog("Mark this invoice as paid",
    `<label>Note (optional)</label><input id="d-note" placeholder="e.g. paid from the company bank account on 3 Sept" />`,
    async () => {
      await api(`/api/orgs/${org.id}/invoices/${el.dataset.id}/reconcile`, { method: "POST", body: { note: $("#d-note").value || undefined } });
      toast("Invoice reconciled.");
    }),
  "new-invoice": () => dialog("Create an invoice link",
    `<label>Currency</label><input id="d-cur" value="${esc(org.reporting.currency)}" />
     <label>Due date</label><input id="d-due" type="date" />
     <label>Password (optional)</label><input id="d-pw" type="password" autocomplete="new-password" minlength="12" placeholder="12+ characters — send it separately from the link" />`,
    async () => {
      const r = await api(`/api/orgs/${org.id}/invoices`, {
        method: "POST",
        body: { currency: $("#d-cur").value, dueDate: $("#d-due").value || undefined,
          password: $("#d-pw").value || undefined },
      });
      prompt(r.note, location.origin + r.linkPath);
    }),
  "new-coa": () => dialog("Add an account",
    `<label>Code</label><input id="d-code" placeholder="6400" />
     <label>Name</label><input id="d-name" />
     <label>Type</label><select id="d-type"><option>expense</option><option>revenue</option>
       <option>asset</option><option>liability</option><option>equity</option></select>`,
    async () => {
      await api(`/api/orgs/${org.id}/chart-of-accounts`, {
        method: "POST",
        body: { code: $("#d-code").value, name: $("#d-name").value, type: $("#d-type").value },
      });
    }),
  async "apply-rules"() {
    const r = await api(`/api/orgs/${org.id}/account-rules/apply`, { method: "POST" });
    toast(`${r.changed} transaction(s) re-mapped. ${r.note}`);
  },
  async "export-ledger"() {
    // The route reads the bearer header, which a navigation cannot carry.
    const res = await fetch(`/api/orgs/${org.id}/export/ledger.csv`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return toast("Export failed", true);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "transactions.csv" });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },
  async "save-org"() {
    const body = {
      name: $("#s-name").value, legalName: $("#s-legal").value,
      taxId: $("#s-tax").value, notificationEmail: $("#s-notify").value,
      address: {
        line1: $("#s-addr1").value, line2: $("#s-addr2").value,
        postalCode: $("#s-zip").value, city: $("#s-city").value,
        country: $("#s-country").value,
      },
    };
    const cur = $("#s-currency");
    if (cur && !cur.disabled && cur.value !== org.reporting.currency) {
      body.reporting = { currency: cur.value };
    }
    await api(`/api/orgs/${org.id}`, { method: "PATCH", body });
    toast("Saved.");
    await loadOrg(org.id);
  },
  async "new-draft"() {
    const [{ contacts }, { accounts }] = await Promise.all([
      api(`/api/orgs/${org.id}/contacts`),
      api(`/api/orgs/${org.id}/accounts`),
    ]);
    const payable = contacts.filter((c) => c.bankAccounts.length);
    const fundable = accounts.filter((a) => a.status === "active" && a.backingUserId);
    if (!payable.length) return toast("Add a contact with bank details first.", true);
    if (!fundable.length) {
      return toast(
        "No account can fund a payment yet. Open an account and fund it from your own balance.",
        true,
      );
    }
    dialog("New payment",
      `<label>From</label><select id="d-acct">${fundable
        .map((a) => `<option value="${esc(a.id)}">${esc(a.label)} · ${esc(a.currency)}</option>`)
        .join("")}</select>
       <label>To</label><select id="d-con">${payable
        .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.bankAccounts[0].iban || "")}</option>`)
        .join("")}</select>
       <label>Amount (EUR)</label><input id="d-amt" placeholder="250.00" />
       <label>Note</label><input id="d-note" />`,
      async () => {
        const c = payable.find((x) => x.id === $("#d-con").value);
        await api(`/api/orgs/${org.id}/drafts`, {
          method: "POST",
          body: {
            source: { kind: "account", accountId: $("#d-acct").value },
            lines: [{
              contactId: c.id,
              destination: {
                kind: "bank",
                bankAccountId: c.bankAccounts[0].id,
                displayName: c.bankAccounts[0].holderName,
              },
              asset: "EUR",
              amount: $("#d-amt").value.trim(),
              note: $("#d-note").value || undefined,
            }],
          },
        });
      });
  },
  async "submit-draft"(el) {
    await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/submit`, { method: "POST" });
    toast("Submitted for review.");
  },
  async "review-draft"(el) {
    await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/review`, {
      method: "POST", body: { approve: true },
    });
    toast("Approved.");
  },
  /**
   * Send: create one transfer per line, then sign each on this device.
   *
   * Execution and signing are deliberately separate round trips. The server
   * never holds the key, so the batch exists as unsigned transfers until the
   * device signs them — and if signing is abandoned halfway, the rest simply
   * expire without moving anything.
   */
  async "exec-draft"(el) {
    const r = await api(`/api/orgs/${org.id}/drafts/${el.dataset.id}/execute`, { method: "POST" });

    if (r.unsigned) {
      return dialog("Sign in your own wallet",
        `<p class="desc">${esc(r.note)}</p>
         <table><thead><tr><th>To</th><th>Amount</th></tr></thead><tbody>${r.lines
           .map((l) => `<tr><td>${esc(l.destination.displayName)}</td>
             <td class="mono">${esc(l.amount)} ${esc(l.asset)}</td></tr>`).join("")}</tbody></table>`,
        async () => {});
    }
    if (!r.authorizations?.length) return toast(r.note || "Nothing to sign.");

    const lib = await window.__deviceLib;
    // The passkey that wraps this browser's device key, from the session —
    // nothing writes it to storage.
    const me = await api("/api/session");
    const credentialId = me.passkey?.credentialId || undefined;
    let signed = 0;
    const failures = [];
    for (const a of r.authorizations) {
      try {
        const signature = await lib.signTypedData(a.authorization.typedData, credentialId);
        await api(a.authorization.submitTo, { method: "POST", body: { signature } });
        signed++;
        toast(`Signed ${signed}/${r.authorizations.length}…`);
      } catch (e) {
        // Reported per line rather than aborting silently: the ones already
        // signed are real payments and the user must know which.
        failures.push(`${a.recipient}: ${e.message}`);
      }
    }
    toast(
      failures.length
        ? `${signed} of ${r.authorizations.length} sent. Unsent: ${failures.join("; ")}`
        : `All ${signed} payment(s) signed and submitted.`,
      failures.length > 0,
    );
  },
};
