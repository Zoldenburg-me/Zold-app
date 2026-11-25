const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => `€${Number(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"; };
const day = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" }); };
const ibanFmt = (s) => String(s || "").replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();
const short = (a) => a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "—";
const code = location.pathname.split("/").pop();
// The holder's postal address for a statement printout. Page memory only:
// never fetched, never stored, never in the signed snapshot. Every line the
// textarea holds (its maxlength) prints; nothing is silently dropped.
let typedAddress = [];
const addressFrom = (text) => String(text).split("\n").map((l) => l.trim()).filter(Boolean);

function head(doc, title, sub) {
  return `<div class="head">
    <div><div class="zold"><b aria-hidden="true">▽</b> Zold</div><div class="sub">${esc(sub)}</div></div>
    <div class="right"><h1 style="margin:0;font-size:inherit;font-weight:700">${esc(title)}</h1><div>Generated ${esc(day(doc.createdAt))}</div><div>Verification ${esc(code)}</div></div>
  </div>`;
}
function holder(h, extra = [], typed = []) {
  const address = typed.length
    ? `${typed.map((l) => `<div>${esc(l)}</div>`).join("")}<div class="sub">Address as the holder entered it, not verified and not part of the signed document</div>`
    : h.addressLines.map((l) => `<div>${esc(l)}</div>`).join("");
  const rows = [
    ...(h.iban ? [["IBAN", ibanFmt(h.iban)]] : []),
    ...(h.bic ? [["BIC", h.bic]] : []),
    ["Currency", "EUR"],
    ["Account of record", short(h.safeAddress)],
    ["Chain", { 8453: "Base", 84532: "Base Sepolia", 31337: "local hardhat" }[h.chainId] ? `${{ 8453: "Base", 84532: "Base Sepolia", 31337: "local hardhat" }[h.chainId]} (${h.chainId})` : `chain ${h.chainId}`],
    ...extra,
  ];
  return `<div class="holder">
    <div class="addr"><div class="who">${esc(h.name)}</div>${h.nameSource === "monerium" ? `<div class="sub name-ok">✓ Verified by Monerium</div>` : h.nameSource === "self-declared" ? `<div class="sub name-warn">⚠ Not verified: name as the holder entered it</div>` : ""}${h.operatedBy ? `<div>Operated by ${esc(h.operatedBy)}</div>` : ""}${address}</div>
    <div class="meta">${rows.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
  </div>`;
}
function lineRows(lines) {
  return lines.map((l) => `<tr>
    <td class="mono">${esc(when(l.at))}</td>
    <td class="mono">${esc(l.counterpartyIban ? ibanFmt(l.counterpartyIban) : (l.txHash ? short(l.txHash) : "—"))}</td>
    <td>${esc(l.counterpartyName || "—")}</td>
    <td>${esc(l.memo || l.reference || "—")}</td>
    <td class="num ${l.direction === "out" ? "neg" : "pos"}">${l.direction === "out" ? "−" : "+"}${esc(eur(l.amountEur))}</td>
  </tr>`).join("");
}
const TABLE_HEAD = `<thead><tr><th>Date</th><th>IBAN / tx</th><th>Name</th><th>Memo / reference</th><th class="num">Amount</th></tr></thead>`;

function legal(doc, extra = []) {
  return `<div class="legal">
    ${extra.map((x) => `<div>${esc(x)}</div>`).join("")}
    <div>${esc((doc.parties || {}).footer || "")}</div>
  </div>
  <div class="foot"><div>Verify this document at <span class="code">${esc(location.origin)}/v/${esc(code)}</span></div><div>© ${new Date().getUTCFullYear()} Zold · Page 1 of 1</div></div>`;
}
function signatures(doc) {
  const z = doc.attestations.zold;
  const s = doc.attestations.safe;
  return `<div class="sig">
    <div><span class="k">Signed by Zold</span> · <span class="mono">${esc(short(z.signer))}</span> · ${esc(when(z.signedAt))}</div>
    ${s ? `<div><span class="k">Signed by the account holder's account</span> · <span class="mono">${esc(short(s.address))}</span> · ${esc(when(s.signedAt))}</div>` : ""}
  </div>`;
}

// The issuer's own portal for this statement. The snapshot records the
// Monerium environment at issue; statements from before it was recorded fall
// back to the chain (8453 is the production deployment, test chains the
// sandbox). A custom issuer host has no public portal to name.
function moneriumPortal(env, chainId) {
  if (env === "production") return "monerium.app";
  if (env === "sandbox") return "monerium.dev";
  if (env) return "";
  return chainId === 8453 ? "monerium.app" : "monerium.dev";
}
function statementLegal(s) {
  const lines = ["Balances are read from the Base ledger at the stated blocks. Transfer data is provided by the e-money issuer, Monerium."];
  if (s.holder.iban) {
    const portal = moneriumPortal(s.moneriumEnvironment, s.holder.chainId);
    lines.push(`The IBAN is issued by Monerium; your verified name and address, and the issuer's own record of this account, are in your Monerium account${portal ? ` at ${portal}` : ""}.`);
  }
  return lines;
}

function render(doc) {
  const s = doc.snapshot;
  if (s.kind === "receipt") {
    return head(doc, "Transfer receipt", "Zold account document") + holder(s.holder) +
      `<table>${TABLE_HEAD}<tbody>${lineRows([s.line])}</tbody></table>` +
      (s.feeEur ? `<div class="totals"><div><span>Zold fee</span><span>${esc(eur(s.feeEur))}</span></div></div>` : "") +
      `<div class="prose">Paid from the account of <strong>${esc(s.holder.name)}</strong> and settled as a SEPA credit transfer${s.line.reference ? ` · issuer order ${esc(s.line.reference)}` : ""}.</div>` +
      signatures(doc) + legal(doc, ["This receipt is for informational purposes only. Transfer data is provided by the e-money issuer, Monerium."]);
  }
  if (s.kind === "statement") {
    const bal = (b) => b ? `${eur(b.amountEur)} (block ${b.number}, ${when(b.at)})` : "unavailable";
    return head(doc, "Account statement", `Statement period ${day(s.period.from)} to ${day(s.period.to)}`) +
      holder(s.holder, [["Opening balance", s.opening ? eur(s.opening.amountEur) : "—"], ["Closing balance", s.closing ? eur(s.closing.amountEur) : "—"]], typedAddress) +
      (s.lines.length ? `<table>${TABLE_HEAD}<tbody>${lineRows(s.lines)}</tbody></table>` : `<div class="prose sub">No movements in this period.</div>`) +
      `<div class="totals">
        <div><span>Opening balance</span><span>${esc(bal(s.opening))}</span></div>
        <div><span>Money in</span><span class="pos">+${esc(eur(s.totals.inEur))}</span></div>
        <div><span>Money out</span><span class="neg">−${esc(eur(s.totals.outEur))}</span></div>
        <div class="grand"><span>Closing balance</span><span>${esc(bal(s.closing))}</span></div>
      </div>` +
      (s.reconciliation.reconciles ? "" : `<div class="note">${s.opening && s.closing
        ? `This statement does not fully reconcile: ${esc(s.reconciliation.note || "")}. The opening and closing balances are read from the chain; the lines are what the issuer and Zold recorded, so a movement is missing from the lines, not from the balances.`
        : "The balances could not be read from the chain, so these lines could not be checked against them."}</div>`) +
      (s.sources.monerium !== "ok" ? `<div class="note">Counterparty names and memos are unavailable for this statement (${esc(s.sources.monerium)}); lines carry the ledger data only.</div>` : "") +
      signatures(doc) + legal(doc, statementLegal(s));
  }
  if (s.kind === "balance") {
    return head(doc, "Balance confirmation", "Zold account document") + holder(s.holder) +
      `<div class="prose">This confirms that on <strong>${esc(when(s.block.at))}</strong> the account of <strong>${esc(s.holder.name)}</strong> held <strong>${esc(eur(s.balanceEur))}</strong>, read from the Base ledger at block ${esc(String(s.block.number))}. The balance is e-money redeemable at par; it is not a bank deposit.</div>` +
      signatures(doc) + legal(doc);
  }
  if (s.kind === "beleg") {
    const TITLES = { sepa_in: "SEPA credit received", sepa_out: "SEPA payment sent", sepa_out_reversal: "Reversal of a failed payment", crypto_converted: "USDC received and converted to EURe", crypto_held: "USDC received and held", eure_in: "EURe received on chain", sweep: "Monthly conversion of leftover USDC" };
    const l = s.line;
    const row = (k, v) => v === undefined || v === null || v === "" ? "" : `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
    const block = (title, rows) => rows.join("") ? `<h3 class="bh">${esc(title)}</h3><div class="meta" style="min-width:0">${rows.join("")}</div>` : "";
    const gasPayer = { sponsored: "the paymaster (sponsored)", "safe-native": "the account, in ETH", "safe-token": "the account, in the gas token (USDC)" };
    const c = s.conversion || {};
    const b = s.bank || {};
    const r = s.receipt;
    // The movement once, as a bank statement prints it: who (named once, with
    // their IBAN or address), what it said, how much.
    const cp = l.counterparty || {};
    const name = cp.name || b.counterpartyName || "";
    const account = cp.iban || b.counterpartyIban ? ibanFmt(cp.iban || b.counterpartyIban) : (cp.address || r?.from) ? short(cp.address || r.from) : "";
    const memo = b.memo && b.memo !== l.reference ? b.memo : "";
    const out = l.amountCents < 0 || l.event === "sepa_out";
    const date = `${esc(day(l.valueDate))}${l.bookingDate !== l.valueDate ? `<div class="sub">booked ${esc(day(l.bookingDate))}</div>` : ""}`;
    const movement = `<table><thead><tr><th>Date</th><th>${out ? "To" : "From"}</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody><tr>
      <td>${date}</td>
      <td>${esc(name || "—")}${account ? `<div class="mono sub">${esc(account)}</div>` : ""}</td>
      <td>${esc(l.reference || "—")}${memo ? `<div class="sub">${esc(memo)}</div>` : ""}</td>
      <td class="num ${out ? "neg" : "pos"}">${out ? "−" : "+"}${esc(eur(Math.abs(l.amountCents) / 100))}</td></tr></tbody></table>`;
    const booking = block("Booked against", [
      row("Invoice", s.invoice ? `${s.invoice.number}${s.invoice.payer ? ` · ${s.invoice.payer}` : ""}${s.invoice.source === "external" ? " (issued outside Zold)" : ""}` : ""),
      row("Account code", l.accountCode),
      row("Booked as", l.ownTransfer ? "Between the holder’s own accounts, not income or an expense" : ""),
      row("Zold fee", b.feeEur !== undefined ? eur(b.feeEur) : ""),
      row("Refund", b.refund ? `${eur(b.refund.amountEur)} on ${day(b.refund.at)} — ${b.refund.deductions}` : ""),
    ]);
    const crypto = r ? block("Received on chain", [row("Received", `${r.amount} ${r.asset}`), row("Arrived", r.blockTime ? when(r.blockTime) : ""),
      row("Value at receipt", r.valueEur !== undefined ? `${eur(r.valueEur)} at ${r.rate} USD/EUR, ECB reference rate of ${r.rateAsOf}` : "not valued — no reference rate was available")]) : "";
    const conversion = s.conversion ? block(s.sweep ? "Sweep conversion" : "Conversion", [row("Leftovers from", s.sweep ? `${s.sweep.depositIds.length} conversion(s) in ${s.sweep.month}` : ""),
      row("Venue and rate", [c.venue, c.rate !== undefined ? `${c.rate} USD/EUR${c.midRate ? ` (mid ${c.midRate})` : ""}` : ""].filter(Boolean).join(" · ")),
      row("In → credited", c.amountInUsdc !== undefined && c.creditedEur !== undefined ? `${c.amountInUsdc} USDC → ${eur(c.creditedEur)}` : c.creditedEur !== undefined ? eur(c.creditedEur) : ""),
      row("Venue fee", c.venueFeeUsdc !== undefined ? `${c.venueFeeUsdc} USDC` : ""), row("Left in the account", c.leftoverUsdc !== undefined ? `${c.leftoverUsdc} USDC (swept monthly)` : ""),
      row("Receivable difference", c.receivableDifferenceEur !== undefined ? eur(c.receivableDifferenceEur) : ""), row("Gain / loss on conversion", c.gainEur !== undefined ? eur(c.gainEur) : ""),
      row("Gas", s.gas && (s.gas.costWei || s.gas.paidBy) ? [s.gas.costWei ? `${s.gas.costWei} wei` : "", gasPayer[s.gas.paidBy] ? `paid by ${gasPayer[s.gas.paidBy]}` : ""].filter(Boolean).join(", ") : "")]) : "";
    // Kept for an auditor tracing the line back; folded away for everyone else.
    const ids = [row("Monerium order", l.links.orderId || b.orderId), row("Transfer", l.links.transferId || b.transferId), row("Deposit", l.links.depositId), row("Payment link", l.links.paymentRequestId),
      ...l.links.txHashes.map((h) => row("Transaction", h)), row("UserOperation", c.userOpHash), row("Line", l.key)].join("");
    return head(doc, "Booking receipt (Beleg)", TITLES[l.event] || "Statement line") + holder(s.holder) + movement + booking + crypto + conversion +
      (s.unexecutedNote ? `<div class="note">${esc(s.unexecutedNote)}</div>` : "") +
      (ids ? `<details class="ids"><summary>Record IDs</summary><div class="meta" style="min-width:0">${ids}</div></details>` : "") +
      // No PDF where the server refuses one: revoked, or the records no longer match.
      (doc.revokedAt || doc.verification?.checks?.some((c) => c.name === "Records still match" && !c.ok) ? "" : `<div class="prose sub" style="margin-top:14px"><a href="/api/v/${esc(code)}/beleg.pdf">Download as PDF</a></div>`) +
      signatures(doc) + legal(doc, ["Statement lines are projected from the account's own records. Every verification re-reads those records and, for money received on chain, the receipt transaction itself."]);
  }
  if (s.kind === "ownership") {
    return head(doc, "Proof of account ownership", "Zold account document") + holder(s.holder) +
      `<div class="prose">${esc(s.statement)}</div>
      <div class="prose sub">Zold signed this document: if any word or number on it is changed, the check at the address below fails. ${doc.attestations.safe
        ? "The account itself also signed it, which only the holder can do. That shows whoever requested this document controls the account; the signature is checked against the account on every verification."
        : "The account’s own signature has not been added yet. The holder can add it from the app, to show they control the account."}</div>` +
      signatures(doc) + legal(doc);
  }
  return `<div class="err">Unknown document kind.</div>`;
}

function verdict(v) {
  const el = document.getElementById("verdict");
  const ok = Boolean(v.verification?.ok);
  el.className = `verdict ${ok ? "ok" : "bad"}`;
  el.innerHTML = `<div class="dot"></div><div><div class="t">${ok ? "This document verifies" : "This document does NOT verify"}</div>
    <div class="d">Checked ${esc(when(v.verifiedAt))} against the signature and the ledger.</div>
    <ul class="checks">${v.verification.checks.map((c) => `<li class="${c.ok ? "" : "bad"}">${esc(c.name)}${c.detail ? ` <span>— ${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul></div>`;
}

document.getElementById("btn-print").onclick = () => window.print();
(async () => {
  try {
    const res = await fetch(`/api/v/${encodeURIComponent(code)}`, { headers: { accept: "application/json" } });
    const doc = await res.json();
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`);
    document.title = `${doc.kind === "statement" ? "Account statement" : doc.kind === "receipt" ? "Transfer receipt" : doc.kind === "balance" ? "Balance confirmation" : doc.kind === "beleg" ? "Booking receipt" : "Proof of ownership"} · Zold`;
    document.getElementById("sheet").innerHTML = render(doc);
    verdict(doc);
    if (doc.snapshot.kind === "statement") {
      document.getElementById("addr-panel").hidden = false;
      document.getElementById("addr-input").oninput = (e) => {
        typedAddress = addressFrom(e.target.value);
        document.getElementById("sheet").innerHTML = render(doc);
      };
    }
  } catch (e) {
    document.getElementById("sheet").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    const el = document.getElementById("verdict");
    el.className = "verdict bad";
    el.innerHTML = `<div class="dot"></div><div><div class="t">Not found</div><div class="d">No document exists under this code, or it was mistyped.</div></div>`;
  }
})();
