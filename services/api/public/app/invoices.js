/**
 * Invoices on the phone (design/ui-v2 build step 6): the list, issuing one,
 * an issued invoice, your invoice details, asking a supplier for one, and
 * accounting connections.
 *
 * Declarations and listeners only, loaded after phone.js (whose router,
 * caches and helpers it uses) and before main.js. phone.js reaches these
 * screens by URL only, so nothing calls forward.
 *
 * Honesty rules that shape this file (design/ui-v2/RULES.md §4):
 * - Invoices belong to the personal organisation and need its plan's
 *   "invoices" capability. Without it the screen says why, in the plan's words.
 * - An open invoice is not money. Its amount is drawn neutral; only a paid one
 *   is mint with a plus.
 * - The invoice link is a bearer credential the API returns once, at issue,
 *   and keeps only as a hash. It is shown right after issuing and never again.
 * - Drafts live only on this phone (localStorage). The API has none.
 * - Zold sends nothing: the user shares the link or the PDF.
 * - GetMyInvoices has only met a stand-in (Beta). sevDesk and DATEV are not
 *   built (Soon).
 */

/* ==========================================================================
   Data
   ========================================================================== */

/* The editor's last check and its timers. The one-time links the API returns
   (an issued invoice's, a supplier request's) are held in phCache, which a
   sign-out clears. */
const phInv = { check: null, checkSeq: 0, checkTimer: null, saveTimer: null, loadedAt: 0 };

/* The organisation whose invoices these are, when its plan includes them:
   for a login that signed up as a company, its company (an invoice issued in
   the founder's own name would be the wrong issuer); otherwise the personal
   one. A company the login only belongs to invoices from the web app. */
const phInvOrg = () => {
  const o = user?.accountType === "company"
    ? (phCache.orgs || []).find((x) => x.type === "business") || null
    : phPersonalOrg();
  return o && phCan(o, "invoices") ? o : null;
};
const phOrgPath = (org, rest) => `/api/orgs/${encodeURIComponent(org.id)}${rest}`;

async function phLoadInvoices() {
  await phLoadOrgs();
  const org = phInvOrg();
  if (!org) { phCache.invoices = []; return; }
  try {
    phCache.invoices = (await api(phOrgPath(org, "/invoices"))).invoices || [];
    phCache.invError = null;
    phInv.loadedAt = Date.now();
  } catch (e) {
    phCache.invoices = phCache.invoices || [];
    phCache.invError = e.message;
  }
}

/* A payment can mark an invoice paid at any time (the bank matcher, a
   converted deposit), so an open list older than this is read again. */
const PH_INV_FRESH_MS = 20_000;
function phInvFreshen(name) {
  if (phCache.invoices === null || Date.now() - phInv.loadedAt < PH_INV_FRESH_MS) return;
  phInv.loadedAt = Date.now();
  phLoadInvoices().then(() => { if (phRoute?.name === name) phRefresh(); });
}

async function phLoadInvProfile() {
  await phLoadOrgs();
  const org = phInvOrg();
  if (!org) return null;
  try {
    phCache.invProfile = await api(phOrgPath(org, "/invoicing/profile"));
    phCache.invError = null;
  } catch (e) {
    phCache.invError = e.message;
  }
  return phCache.invProfile;
}

/* The status words of SYSTEM.md, from the invoice's own state. */
function phInvWord(i) {
  if (i.state === "PAID" || i.state === "RECONCILED") return "PAID";
  if (i.state === "PAYING") return "IN FLIGHT";
  if (i.state === "LINK_CREATED") return "WAITING";
  return i.overdue ? "OVERDUE" : "OPEN";
}

/* What the document says it is for: the frozen gross of an issued invoice,
   the supplier's total of an incoming one. */
function phInvAmount(i) {
  if (i.issued && Number.isFinite(i.issued.grossCents)) return { value: i.issued.grossCents / 100, currency: i.issued.currency || "EUR" };
  return { value: Number(i.total) || 0, currency: i.currency || "EUR" };
}

/* A date-only string ("2026-10-08") read as that calendar day. */
const phDate = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || "")) ? `${ymd}T12:00:00` : ymd);

function phInvRow(i) {
  const out = i.direction === "outgoing";
  const w = phInvWord(i);
  const who = out ? i.issued?.recipient?.name : i.supplier?.orgName;
  const num = out ? i.issued?.number : i.supplier?.invoiceNumber;
  const when = w === "PAID"
    ? (i.payment?.paidAt ? `paid ${phDay(i.payment.paidAt)}` : "paid")
    : i.dueDate ? `${w === "OVERDUE" ? "was due" : "due"} ${phDay(phDate(i.dueDate))}` : "";
  const a = phInvAmount(i);
  const fig = w === "WAITING"
    ? ""
    : w === "PAID"
      ? Z.amount({ value: a.value, currency: a.currency, direction: out ? "in" : "out" })
      : `<span class="z-amount">${esc(Z.formatMoney(a.value, a.currency))}</span>`;
  return Z.row({
    lead: Z.iconTile({ icon: out ? "receipt_long" : "move_to_inbox" }),
    title: who || (out ? "Invoice" : "Waiting for your supplier"),
    sub: w === "WAITING" ? "Link created, not filled in yet" : [num, when].filter(Boolean).join(" · "),
    right: `${fig}${Z.tag(w)}`,
    href: phHref("invoice", i.id),
    chevron: false,
  });
}

/* ==========================================================================
   Invoices list
   ========================================================================== */

const PH_INV_FILTERS = [["open", "Open"], ["paid", "Paid"], ["overdue", "Overdue"]];
const PH_INV_SIDES = [["issued", "Issued by you"], ["suppliers", "From suppliers"]];

function phInvArgs(arg) {
  // phGo encodes the argument, so "issued/paid" can arrive as "issued%2Fpaid".
  let raw = String(arg || "");
  try { raw = decodeURIComponent(raw); } catch { /* keep it as typed */ }
  const [side, filter] = raw.split("/");
  return {
    side: side === "suppliers" ? "suppliers" : "issued",
    filter: PH_INV_FILTERS.some(([k]) => k === filter) ? filter : "open",
  };
}
const phInvIn = (filter, i) => {
  const w = phInvWord(i);
  return filter === "paid" ? w === "PAID" : filter === "overdue" ? w === "OVERDUE" : w !== "PAID";
};

/* A trial is a grant with an end date (plans.ts). There is no plan screen on
   the phone yet, so the chip says how long is left and links nowhere. */
function phTrialChip(org) {
  const t = org?.trial;
  const days = t?.endsAt ? Math.ceil((Date.parse(t.endsAt) - Date.now()) / 86400000) : 0;
  if (!(days > 0)) return "";
  const plan = t.grantsPlan === "business" ? "Business" : "Premium";
  return `<p class="z-planchip">${Z.icon("workspace_premium")}<span>${plan} trial · ${days === 1 ? "1 day" : `${days} days`} left</span></p>`;
}

/* No invoices on this plan: the plan's own reason, and the one trial when it
   is still unused. */
function phInvGate(back) {
  const org = phPersonalOrg();
  const cap = org?.capabilities?.invoices;
  const trial = org && !org.trial && cap?.requiresPlan?.includes("premium");
  return `${phTop("Invoices", back)}${phMain(`
    ${Z.note({ text: cap?.reason || "Invoices are not part of this account." })}
    ${cap?.upgradeHint ? `<p class="z-sub">${esc(cap.upgradeHint)}</p>` : ""}
    ${trial ? `${Z.button({ variant: "primary", full: true, icon: "workspace_premium", label: "Start the 30-day trial", id: "ph-inv-trial" })}
      <p class="z-hint">Premium for 30 days, invoices included. No payment is taken. Each account gets one trial.</p>` : ""}
    <p class="z-err" id="ph-inv-err" role="alert" hidden></p>
  `)}`;
}
function phBindGate(root) {
  const b = root.querySelector("#ph-inv-trial");
  if (!b) return;
  b.onclick = async () => {
    if (Z.isDisabled(b)) return;
    Z.setLoading(b, true);
    try {
      await api(phOrgPath(phPersonalOrg(), "/plan/trial"), {});
      phCache.orgs = null; phCache.invoices = null; phCache.invProfile = null;
      await phLoadOrgs();
      phRender();
    } catch (e) {
      Z.setLoading(b, false);
      const err = root.querySelector("#ph-inv-err");
      err.textContent = e.message; err.hidden = false;
    }
  };
}

PH.invoices = {
  title: "Invoices",
  tab: "more",
  live: (arg) => JSON.stringify([arg, phCache.orgs === null, phCache.invoices?.map((i) => `${i.id}:${i.state}:${i.overdue}`), phCache.invError]),
  html(arg) {
    if (phCache.orgs === null) return `${phTop("Invoices", "more")}${phMain(Z.skeletonRows(3, "Loading your invoices…"))}`;
    const org = phInvOrg();
    if (!org) return phInvGate("more");
    const { side, filter } = phInvArgs(arg);
    const all = (phCache.invoices || []).filter((i) => (side === "issued") === (i.direction === "outgoing"));
    const count = (k) => all.filter((i) => phInvIn(k, i)).length;
    const shown = all.filter((i) => phInvIn(filter, i));
    const draft = phInvStored(org);
    const empty = side === "issued"
      ? { text: filter === "open" ? "No open invoices." : filter === "paid" ? "No paid invoices yet." : "Nothing overdue." }
      : { text: filter === "open" ? "Nothing from suppliers to pay." : filter === "paid" ? "No supplier invoices paid yet." : "Nothing overdue." };
    return `${phTop("Invoices", "more")}${phMain(`
      ${phTrialChip(org)}
      <div class="z-pair">
        ${Z.button({ variant: "primary", icon: "add", label: "Issue invoice", href: "#invoice/new" })}
        ${Z.button({ icon: "move_to_inbox", label: "Request one", href: "#invoice/request" })}
      </div>
      <div class="z-pills" role="group" aria-label="Show">
        ${PH_INV_FILTERS.map(([k, label]) => `<a class="z-pill" href="#invoices/${side}/${k}" aria-current="${k === filter ? "true" : "false"}">${esc(label)}${phCache.invoices ? ` <span class="z-fig z-pill__n">${count(k)}</span>` : ""}</a>`).join("")}
      </div>
      <div class="z-pills" role="group" aria-label="Whose invoices">
        ${PH_INV_SIDES.map(([k, label]) => `<a class="z-pill" href="#invoices/${k}/${filter}" aria-current="${k === side ? "true" : "false"}">${esc(label)}</a>`).join("")}
      </div>
      ${side === "issued" && draft ? Z.listGroup({ rows: [Z.row({ lead: Z.iconTile({ icon: "edit_note" }), title: draft.recipient?.name || "New invoice", sub: "Draft on this phone", right: Z.tag("Draft"), href: "#invoice/new", chevron: false })] }) : ""}
      ${phCache.invoices === null ? Z.skeletonRows(3, "Loading your invoices…") : Z.listGroup({ rows: shown.map(phInvRow), empty })}
      ${phCache.invError ? Z.note({ tone: "a", text: `We couldn’t load your invoices: ${phPlain(phCache.invError)}` }) : ""}
    `)}`;
  },
  bind(root) {
    if (phCache.orgs === null) { phLoadOrgs().then(() => { if (phRoute?.name === "invoices") phRender(); }); return; }
    if (!phInvOrg()) return phBindGate(root);
    // A request link is shown once; "Request one" makes a new one.
    phCache.invRequest = null;
    if (phCache.invoices === null) phLoadInvoices().then(() => { if (phRoute?.name === "invoices") phRender(); });
    else phInvFreshen("invoices");
  },
};

/* Server wording can carry dashes, arrows and straight apostrophes; the app's
   copy uses none of them. */
const phPlain = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/\s*→\s*/g, ", then ").replace(/(\w)'(\w)/g, "$1’$2");

/* ==========================================================================
   The editor
   ========================================================================== */

const phInvKey = (org) => `zold-invoice-draft:${org.id}`;
function phInvStored(org) {
  try { return JSON.parse(localStorage.getItem(phInvKey(org)) || "null"); } catch { return null; }
}
function phInvStore(org, d) {
  try { localStorage.setItem(phInvKey(org), JSON.stringify(d)); return true; } catch { return false; }
}
function phInvForget(org) {
  try { localStorage.removeItem(phInvKey(org)); } catch { /* nothing stored */ }
}

let phInvDraft = null;   // the open editor's state

const phYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* The next number in the series, as the API will write it. */
function phNextNumber(series, when) {
  const s = series || { prefix: "RE-{YYYY}-", next: 1, padding: 4 };
  const prefix = String(s.prefix)
    .replace(/\{YYYY\}/g, String(when.getFullYear()))
    .replace(/\{YY\}/g, String(when.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(when.getMonth() + 1).padStart(2, "0"));
  return `${prefix}${String(s.next).padStart(s.padding, "0")}`;
}

function phInvFresh(org, prof) {
  const today = new Date();
  const terms = prof.profile.paymentTermsDays;
  const due = new Date(today); due.setDate(due.getDate() + (Number.isFinite(terms) ? terms : 14));
  const rates = prof.reference.vatRates;
  return {
    recipient: { name: "", addressLine: "", postalCode: "", city: "", country: org.address?.country || "", vatId: "" },
    number: phNextNumber(prof.profile.numberSeries, today),
    // German where the issuer is in a German-speaking country, else English,
    // unless the profile chose.
    language: prof.profile.language || (["DE", "AT", "CH", "LI"].includes(org.address?.country) ? "de" : "en"),
    issueDate: phYmd(today),
    dueDate: phYmd(due),
    period: phYmd(today).slice(0, 7),
    lines: [{ description: "", quantity: "1", price: "" }],
    vat: prof.profile.smallBusiness ? "exempt" : String(prof.profile.defaultVatRate ?? (rates ? rates[0] : "")),
  };
}

/* The profile is complete enough to issue: § 14 Abs. 4 Nr. 1 and 2. */
const phIssuerAddress = (p) => !!(p.issuer?.addressLine && p.issuer?.postalCode && p.issuer?.city && p.issuer?.country);
const phIssuerTaxId = (p) => !!(p.issuer?.taxNumber || p.issuer?.vatId);

/* A month ("2026-09") as the supply period the API takes. */
function phPeriod(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  if (!m) return undefined;
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

/* A typed amount ("850,00", "850.5") as the API's decimal string. */
function phPrice(raw) {
  const v = String(raw ?? "").trim().replace(/\s/g, "");
  if (v === "") return null;
  if (!/^\d+([.,]\d{0,2})?$/.test(v)) return NaN;
  return Number(v.replace(",", "."));
}
const phQty = (raw) => {
  const v = String(raw ?? "").trim().replace(",", ".");
  return /^\d+(\.\d{1,3})?$/.test(v) && Number(v) > 0 ? Number(v) : NaN;
};

/* The request body for check and issue. The number is left out while it is
   still the series' own, so issuing advances the series. */
function phInvBody(d, prof) {
  const vat = d.vat === "exempt"
    ? { kind: "exempt", ...(prof.jurisdiction.ruleSet === "DE" ? { reason: "kleinunternehmer" } : {}) }
    : { kind: "standard", rate: Number(d.vat) };
  const own = phNextNumber(prof.profile.numberSeries, new Date(`${d.issueDate}T12:00:00`));
  return {
    ...(d.number.trim() && d.number.trim() !== own ? { number: d.number.trim() } : {}),
    language: d.language,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    ...(phPeriod(d.period) ? { supplyPeriod: phPeriod(d.period) } : {}),
    recipient: {
      name: d.recipient.name.trim(), addressLine: d.recipient.addressLine.trim(), postalCode: d.recipient.postalCode.trim(),
      city: d.recipient.city.trim(), country: d.recipient.country, ...(d.recipient.vatId.trim() ? { vatId: d.recipient.vatId.trim() } : {}),
    },
    lines: d.lines.map((l) => {
      const p = phPrice(l.price), q = phQty(l.quantity);
      return { description: l.description.trim(), quantity: Number.isFinite(q) ? String(q) : String(l.quantity).trim(), unitPriceNet: Number.isFinite(p) && p !== null ? p.toFixed(2) : "" };
    }),
    vat,
  };
}

/* Countries to pick from: all of them. The issuer's decides which rules
   apply, and a customer can be anywhere. */
const phCountries = (current) => Z.countries(current);

const phNum = (html) => html.replace('class="z-input"', 'class="z-input z-input--num"');

function phLineCard(l, i, n) {
  const p = phPrice(l.price), q = phQty(l.quantity);
  const total = Number.isFinite(p) && p !== null && Number.isFinite(q) ? phEur(Math.round(p * q * 100) / 100) : "";
  return `<fieldset class="z-invline" data-line="${i}">
    <legend class="z-sr">Line ${i + 1}</legend>
    ${n > 1 ? `<button type="button" class="z-iconbtn z-iconbtn--bare z-invline__rm" data-rm="${i}" aria-label="Remove line ${i + 1}">${Z.icon("close")}</button>` : ""}
    ${Z.field({ id: `ph-l${i}-d`, label: "Description", name: `line-${i}-description`, value: l.description, maxlength: 200, placeholder: "Logo design…" })}
    <div class="z-invline__nums">
      ${phNum(Z.field({ id: `ph-l${i}-q`, label: "Qty", name: `line-${i}-qty`, value: l.quantity, inputmode: "decimal" }))}
      ${phNum(Z.field({ id: `ph-l${i}-p`, label: "Price, €", name: `line-${i}-price`, value: l.price, inputmode: "decimal", placeholder: "0,00…" }))}
      <span class="z-invline__sum z-fig" id="ph-l${i}-sum" aria-live="polite">${esc(total)}</span>
    </div>
  </fieldset>`;
}

/* VAT choices this issuer may use. A small business charges none (§ 19), and
   the API refuses a rate for it; outside Germany Zold names no rates. */
function phVatChoices(prof, d) {
  const j = prof.jurisdiction, p = prof.profile;
  if (p.smallBusiness) {
    return `<div class="z-invvat">${Z.kv([{ key: "VAT", value: j.ruleSet === "DE" ? "No VAT, § 19" : "No VAT, small business" }]).replace('class="z-kv z-card"', 'class="z-kv z-kv--flat"')}
      <p class="z-hint">${j.ruleSet === "DE" ? "Small-business rule (Kleinunternehmer). The invoice says why no VAT is charged." : "Small-business scheme. The invoice has to say why no VAT is charged."} <a href="#invoice/profile/new">Change</a></p></div>`;
  }
  const rates = prof.reference.vatRates;
  if (!rates) {
    return Z.field({ id: "ph-inv-rate", label: "VAT rate, %", name: "vat", value: d.vat, inputmode: "decimal", hint: `Zold keeps no rate table for ${j.countryName}. Enter the rate you charge.` });
  }
  return `<fieldset class="z-fieldset"><legend class="z-eyebrow">VAT</legend>
    <div class="z-seg">${rates.map((r) => `<label><input type="radio" name="vat" value="${r}"${String(r) === d.vat ? " checked" : ""}><span>${r} %</span></label>`).join("")}</div>
  </fieldset>`;
}

function phTotals(check) {
  if (!check?.totals) return `<div class="z-invtotals" aria-busy="true"><span class="z-skel z-skel--line" style="width:100%"></span><span class="z-skel z-skel--line" style="width:100%"></span></div>`;
  const t = check.totals, cur = check.preview?.currency || "EUR";
  return Z.kv([
    { key: "Net", value: Z.formatMoney(t.netCents / 100, cur) },
    { key: "VAT", value: Z.formatMoney(t.vatCents / 100, cur) },
    { key: "Total", value: Z.formatMoney(t.grossCents / 100, cur), strong: true },
  ]).replace('class="z-kv z-card"', 'class="z-kv z-kv--flat z-invtotals"');
}

/* What still stops the invoice, from the API's own check. */
function phIssues(check) {
  if (!check) return "";
  if (check.refused) return Z.note({ tone: "a", text: phPlain(check.refused) });
  const errs = check.errors || [];
  if (!errs.length) return "";
  return Z.note({ tone: "a", html: `Before you can create it:<br>${errs.map((e) => `· ${esc(phPlain(e.message))}`).join("<br>")}` });
}

PH["invoice/new"] = {
  title: "New invoice",
  html() {
    if (phCache.orgs === null || (phInvOrg() && !phCache.invProfile)) {
      return `${phTop("New invoice", "invoices")}${phMain(Z.skeletonRows(4, "Loading your invoice details…"))}`;
    }
    const org = phInvOrg();
    if (!org) return phInvGate("invoices");
    const prof = phCache.invProfile;
    if (!phInvDraft || phInvDraft.orgId !== org.id) { phInvDraft = { orgId: org.id, ...(phInvStored(org) || phInvFresh(org, prof)) }; phInv.check = null; }
    const d = phInvDraft;
    // The profile may have changed since the draft was saved: a small business
    // charges no VAT, and anyone else needs a rate this issuer can use.
    const rates = prof.reference.vatRates;
    if (prof.profile.smallBusiness) d.vat = "exempt";
    else if (d.vat === "exempt" || (rates && !rates.map(String).includes(String(d.vat)))) {
      d.vat = String(prof.profile.defaultVatRate ?? (rates ? rates[0] : ""));
    }
    const missing = !phIssuerTaxId(prof);
    const bank = prof.profile.bank?.iban;
    const matchable = String(d.number).replace(/[^A-Za-z0-9]/g, "").length >= 6;
    return `${phTop("New invoice", "invoices", `<span class="z-hint" id="ph-inv-saved" aria-live="polite">${phInvStored(org) ? "Draft saved on this phone" : ""}</span>`)}
    <form id="ph-inv" class="z-app__form" novalidate>${phMain(`
      ${missing ? `<a class="z-banner" href="#invoice/profile/new">${Z.icon("badge")}<span>Add your tax number once. It goes on every invoice.</span>${Z.icon("chevron_right", "z-row__chev")}</a>` : ""}
      <fieldset class="z-fieldset z-form--tight"><legend class="z-eyebrow">Bill to</legend>
        ${Z.field({ id: "ph-r-name", label: "Customer", name: "organization", autocomplete: "organization", value: d.recipient.name, maxlength: 120, placeholder: "Café Ostwind…" })}
        ${Z.field({ id: "ph-r-addr", label: "Street and number", name: "address-line1", autocomplete: "address-line1", value: d.recipient.addressLine, maxlength: 120, placeholder: "Ostengasse 4…" })}
        <div class="z-cols">
          ${Z.field({ id: "ph-r-zip", label: "Postcode", name: "postal-code", autocomplete: "postal-code", value: d.recipient.postalCode, maxlength: 12, spellcheck: false })}
          ${Z.field({ id: "ph-r-city", label: "City", name: "address-level2", autocomplete: "address-level2", value: d.recipient.city, maxlength: 80 })}
        </div>
        ${Z.select({ id: "ph-r-country", label: "Country", name: "country", autocomplete: "country", value: d.recipient.country, options: phCountries(d.recipient.country) })}
        ${Z.field({ id: "ph-r-vat", label: "Customer’s VAT ID", optional: true, name: "vat-id", value: d.recipient.vatId, maxlength: 20, spellcheck: false, hint: "For business customers in another EU country." })}
      </fieldset>
      <fieldset class="z-fieldset z-form--tight"><legend class="z-eyebrow">Details</legend>
        <div class="z-cols">
          ${Z.field({ id: "ph-i-num", label: "Number", name: "number", value: d.number, maxlength: 40, spellcheck: false })}
          ${Z.select({ id: "ph-i-lang", label: "Language", name: "language", value: d.language, options: [{ value: "de", label: "Deutsch" }, { value: "en", label: "English" }] })}
        </div>
        <div class="z-cols">
          ${Z.field({ id: "ph-i-date", label: "Date", name: "date", type: "date", value: d.issueDate })}
          ${Z.field({ id: "ph-i-due", label: "Due", name: "due", type: "date", value: d.dueDate })}
        </div>
        ${Z.field({ id: "ph-i-period", label: "Service period", name: "service-period", type: "month", value: d.period })}
      </fieldset>
      <fieldset class="z-fieldset z-form--tight"><legend class="z-eyebrow">Lines</legend>
        <div class="z-stack" id="ph-lines">${d.lines.map((l, i) => phLineCard(l, i, d.lines.length)).join("")}</div>
        <button type="button" class="z-addline" id="ph-add-line">${Z.icon("add")}<span>Add line</span></button>
      </fieldset>
      ${phVatChoices(prof, d)}
      <div id="ph-inv-totals">${phTotals(phInv.check)}</div>
      <div id="ph-inv-issues" aria-live="polite">${phIssues(phInv.check)}</div>
      ${Z.listGroup({ rows: [Z.soonRow({ title: "Repeat monthly", sub: "A new draft on the 1st, for you to check and send" })] })}
      <p class="z-hint">${bank
        ? `Your customer pays by bank transfer to ${esc(Z.groupIban(bank))}.${matchable ? " When a transfer names the invoice number, the invoice marks itself paid." : ""}`
        : `Your invoice details have no IBAN yet, so the invoice shows no bank details. <a href="#invoice/profile/new">Add it</a>`}</p>
      <p class="z-err" id="ph-inv-err" role="alert" hidden></p>
      ${phInvStored(org) ? `<button type="button" class="z-link-btn z-link-btn--small" id="ph-inv-discard">Discard this draft</button>` : ""}
    `)}${phFoot(`<div class="z-pair">${Z.button({ icon: "visibility", label: "Preview", id: "ph-inv-preview" })}${Z.button({ variant: "primary", label: "Create", type: "submit", id: "ph-inv-create" })}</div>`)}</form>`;
  },
  bind(root) {
    if (phCache.orgs === null || (phInvOrg() && !phCache.invProfile)) {
      phLoadInvProfile().then(() => { if (phRoute?.name === "invoice/new") phRender(); });
      return;
    }
    const org = phInvOrg();
    if (!org) return phBindGate(root);
    const prof = phCache.invProfile;
    // First invoice: your details come first (SCREENS.md, Invoice-Profile).
    if (!phIssuerAddress(prof)) return phGo("invoice/profile", "new", { replace: true });
    const d = phInvDraft;
    const form = root.querySelector("#ph-inv");
    const val = (id) => root.querySelector(`#${id}`)?.value ?? "";

    const read = () => {
      d.recipient = {
        name: val("ph-r-name"), addressLine: val("ph-r-addr"), postalCode: val("ph-r-zip"),
        city: val("ph-r-city"), country: val("ph-r-country"), vatId: val("ph-r-vat"),
      };
      d.number = val("ph-i-num"); d.language = val("ph-i-lang");
      d.issueDate = val("ph-i-date"); d.dueDate = val("ph-i-due"); d.period = val("ph-i-period");
      d.lines = d.lines.map((l, i) => ({ description: val(`ph-l${i}-d`), quantity: val(`ph-l${i}-q`), price: val(`ph-l${i}-p`) }));
      const rate = root.querySelector('input[name="vat"]:checked') || root.querySelector("#ph-inv-rate");
      if (rate) d.vat = rate.value;
    };
    const save = () => {
      clearTimeout(phInv.saveTimer);
      phInv.saveTimer = setTimeout(() => {
        const { orgId, ...rest } = d;
        const ok = phInvStore(org, rest);
        const el = root.querySelector("#ph-inv-saved");
        if (el) el.textContent = ok ? "Draft saved on this phone" : "";
      }, 400);
    };
    const check = () => {
      clearTimeout(phInv.checkTimer);
      phInv.checkTimer = setTimeout(async () => {
        const seq = ++phInv.checkSeq;
        try {
          const r = await api(phOrgPath(org, "/invoicing/check"), phInvBody(d, prof));
          if (seq !== phInv.checkSeq) return;
          phInv.check = r;
        } catch (e) {
          if (seq !== phInv.checkSeq) return;
          phInv.check = { refused: e.message };
        }
        if (phRoute?.name !== "invoice/new") return;
        const t = root.querySelector("#ph-inv-totals"), s = root.querySelector("#ph-inv-issues");
        if (t) t.innerHTML = phTotals(phInv.check);
        if (s) s.innerHTML = phIssues(phInv.check);
      }, 350);
    };
    const sums = () => d.lines.forEach((l, i) => {
      const p = phPrice(l.price), q = phQty(l.quantity);
      const el = root.querySelector(`#ph-l${i}-sum`);
      if (el) el.textContent = Number.isFinite(p) && p !== null && Number.isFinite(q) ? phEur(Math.round(p * q * 100) / 100) : "";
    });
    form.addEventListener("input", () => { read(); sums(); save(); check(); });
    form.addEventListener("change", () => { read(); save(); check(); });
    check();

    const redraw = () => {
      const y = window.scrollY;
      phRender();
      window.scrollTo(0, y);
    };
    root.querySelector("#ph-add-line").onclick = () => {
      read();
      d.lines.push({ description: "", quantity: "1", price: "" });
      save(); redraw();
      $("ph-root").querySelector(`#ph-l${d.lines.length - 1}-d`)?.focus();
    };
    root.querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = () => {
        read();
        d.lines.splice(Number(b.dataset.rm), 1);
        save(); redraw(); check();
      };
    });
    const discard = root.querySelector("#ph-inv-discard");
    if (discard) discard.onclick = () => phConfirm({
      id: "ph-inv-discard-dlg", title: "Discard this draft?", text: "It is only on this phone, so it can’t be brought back.",
      confirm: "Discard", cancel: "Keep it", trigger: discard,
      onConfirm: async () => { phInvForget(org); phInvDraft = null; phInv.check = null; redraw(); },
    });

    root.querySelector("#ph-inv-preview").onclick = (e) => { read(); phInvPreview(d, prof, e.currentTarget); };

    const err = root.querySelector("#ph-inv-err");
    const create = root.querySelector("#ph-inv-create");
    const issue = async (acceptWarnings) => {
      err.hidden = true;
      Z.setLoading(create, true);
      try {
        const r = await api(phOrgPath(org, "/invoicing/issue"), { ...phInvBody(d, prof), ...(acceptWarnings ? { acceptWarnings: true } : {}) });
        phCache.invIssued = { id: r.invoice.id, url: `${location.origin}${r.linkPath}` };
        phInvForget(org); phInvDraft = null; phInv.check = null;
        phCache.invoices = null; phCache.invProfile = null;
        await Promise.all([phLoadInvoices(), phLoadInvProfile()]);
        phGo("invoice", r.invoice.id, { replace: true });
      } catch (x) {
        Z.setLoading(create, false);
        if (x.status === 409 && x.body?.warnings?.length) {
          return phConfirm({
            id: "ph-inv-warn", title: "Create it anyway?", trigger: create,
            text: x.body.warnings.map((w) => phPlain(w.message)).join(" "),
            confirm: "Create", cancel: "Go back",
            onConfirm: () => issue(true),
          });
        }
        if (x.status === 422) {
          phInv.check = x.body;
          root.querySelector("#ph-inv-issues").innerHTML = phIssues(x.body);
          err.textContent = "Not created. Fix what’s listed above first.";
        } else err.textContent = phPlain(x.message);
        err.hidden = false;
        err.scrollIntoView({ block: "center" });
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (Z.isDisabled(create)) return;
      read();
      // What the API cannot tell apart from a typo, said at the field.
      Z.setFieldError(root.querySelector("#ph-r-name"), d.recipient.name.trim() ? "" : "Who is the invoice for?");
      d.lines.forEach((l, i) => {
        Z.setFieldError(root.querySelector(`#ph-l${i}-d`), l.description.trim() ? "" : "Say what you did or sold.");
        Z.setFieldError(root.querySelector(`#ph-l${i}-q`), Number.isFinite(phQty(l.quantity)) ? "" : "A number above 0.");
        const p = phPrice(l.price);
        Z.setFieldError(root.querySelector(`#ph-l${i}-p`), Number.isFinite(p) && p !== null ? "" : "Euros and cents, like 850 or 850,00.");
      });
      if (Z.focusFirstError(form)) return;
      issue(false);
    };
  },
};

/* ==========================================================================
   The document
   ========================================================================== */

const PH_PAPER = {
  de: { invoice: "Rechnung", date: "Datum", period: "Leistung", supply: "Leistungsdatum", due: "Fällig", item: "Position", qty: "Menge", amount: "Betrag", net: "Netto", vat: "USt.", total: "Gesamt", taxNo: "St.-Nr.", vatId: "USt-IdNr.", to: "bis", pay: "Bitte überweisen an IBAN", ref: "Verwendungszweck" },
  en: { invoice: "Invoice", date: "Date", period: "Service", supply: "Service date", due: "Due", item: "Item", qty: "Qty", amount: "Amount", net: "Net", vat: "VAT", total: "Total", taxNo: "Tax no.", vatId: "VAT ID", to: "to", pay: "Please transfer to IBAN", ref: "Reference" },
};
const phPaperMoney = (cents, cur, lang) => new Intl.NumberFormat(lang === "en" ? "en-IE" : "de-DE", { style: "currency", currency: cur || "EUR" }).format(cents / 100);
const phPaperDate = (ymd, lang) => {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return lang === "en"
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d)
    : new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
};
function phPaperPeriod(p, lang) {
  if (!p?.from || !p?.to) return "";
  const f = new Date(`${p.from}T12:00:00`), t = new Date(`${p.to}T12:00:00`);
  const whole = f.getDate() === 1 && f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()
    && new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate() === t.getDate();
  if (whole) return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "de-DE", { month: "long", year: "numeric" }).format(f);
  return `${phPaperDate(p.from, lang)} ${PH_PAPER[lang].to} ${phPaperDate(p.to, lang)}`;
}
/* The country is printed when it differs from the issuer's: a domestic
   invoice reads without it, a cross-border one needs it. */
const phAddr = (p, home) => [p?.addressLine, [p?.postalCode, p?.city].filter(Boolean).join(" "), p?.country && p.country !== home ? p.country : ""].filter(Boolean).join(", ");

/**
 * The invoice as paper, in the invoice's language, never the app's. The
 * printable original is the invoice link's page (invoice.html); this is the
 * same content at phone size.
 */
function phPaper(x) {
  const lang = x.language === "en" ? "en" : "de";
  const t = PH_PAPER[lang];
  const money = (c) => phPaperMoney(c, x.currency, lang);
  const meta = [
    [t.date, phPaperDate(x.issueDate, lang)],
    x.supplyPeriod ? [t.period, phPaperPeriod(x.supplyPeriod, lang)] : x.supplyDate ? [t.supply, phPaperDate(x.supplyDate, lang)] : null,
    x.dueDate ? [t.due, phPaperDate(x.dueDate, lang)] : null,
  ].filter(Boolean);
  const taxId = x.issuer.taxNumber ? [t.taxNo, x.issuer.taxNumber] : x.issuer.vatId ? [t.vatId, x.issuer.vatId] : null;
  // translate="no": a browser translating the document would change what the
  // customer is billed for.
  return `<article class="z-paper" lang="${lang}" translate="no" aria-label="${esc(`${t.invoice} ${x.number}`)}">
    <header class="z-paper__head">
      <div><p class="z-paper__who">${esc(x.issuer.name || "")}</p><p>${esc(phAddr(x.issuer, x.issuer.country))}</p></div>
      ${taxId ? `<p class="z-paper__tax">${esc(taxId[0])}<br>${esc(taxId[1])}</p>` : ""}
    </header>
    <p class="z-paper__to">${esc(x.recipient.name || "")}<br>${esc(phAddr(x.recipient, x.issuer.country))}</p>
    <h2 class="z-paper__title">${esc(t.invoice)} ${esc(x.number)}</h2>
    <p class="z-paper__meta">${meta.map(([k, v]) => `<span>${esc(k)} ${esc(v)}</span>`).join("")}</p>
    <table class="z-paper__lines">
      <thead><tr><th scope="col">${esc(t.item)}</th><th scope="col">${esc(t.qty)}</th><th scope="col">${esc(t.amount)}</th></tr></thead>
      <tbody>${x.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(String(l.quantity).replace(".", lang === "de" ? "," : "."))}</td><td>${esc(money(l.netCents))}</td></tr>`).join("")}</tbody>
    </table>
    <dl class="z-paper__sum">
      ${x.vatCents ? `<div><dt>${esc(t.net)}</dt><dd>${esc(money(x.netCents))}</dd></div>${(x.buckets || []).filter((b) => b.rate > 0).map((b) => `<div><dt>${esc(t.vat)} ${b.rate} %</dt><dd>${esc(money(b.vatCents))}</dd></div>`).join("")}` : ""}
      <div class="is-total"><dt>${esc(t.total)}</dt><dd>${esc(money(x.grossCents))}</dd></div>
    </dl>
    ${x.vatNote ? `<p class="z-paper__note">${esc(x.vatNote)}</p>` : ""}
    ${x.bank?.iban ? `<p class="z-paper__pay">${esc(t.pay)} ${esc(Z.groupIban(x.bank.iban))} · ${esc(t.ref)} ${esc(x.number)}</p>` : ""}
  </article>`;
}

/* Paper from an issued invoice: everything frozen at issue, except the bank
   details, which invoice.html also reads live from the profile. */
function phPaperIssued(i, prof) {
  const d = i.issued;
  return phPaper({
    language: d.language, currency: d.currency, number: d.number, issueDate: d.issueDate,
    supplyPeriod: d.supplyPeriod, supplyDate: d.supplyDate, dueDate: i.dueDate,
    issuer: d.issuer, recipient: d.recipient,
    lines: (i.lines || []).map((l) => ({ description: l.description, quantity: l.quantity, netCents: Math.round(Number(l.amount) * 100) })),
    netCents: d.netCents, vatCents: d.vatCents, grossCents: d.grossCents, buckets: d.buckets,
    vatNote: d.vatNote, bank: d.display?.bankDetails === false ? null : prof?.profile?.bank,
  });
}

/* The draft as paper, from the API's check, in a sheet. Nothing is issued. */
function phInvPreview(d, prof, trigger) {
  const c = phInv.check;
  const note = d.vat === "exempt" ? prof.reference.exemptionReasons?.find((r) => r.id === "kleinunternehmer") : null;
  const body = c?.totals
    ? phPaper({
      language: d.language, currency: c.preview?.currency, number: d.number, issueDate: d.issueDate,
      supplyPeriod: phPeriod(d.period), dueDate: d.dueDate, issuer: prof.issuer, recipient: d.recipient,
      lines: c.totals.lines.map((l) => ({ description: l.description, quantity: l.quantity, netCents: l.netCents })),
      netCents: c.totals.netCents, vatCents: c.totals.vatCents, grossCents: c.totals.grossCents, buckets: c.totals.buckets,
      vatNote: note ? (d.language === "en" ? note.invoiceNoteEn : note.invoiceNote) : "", bank: prof.profile.bank,
    })
    : Z.note({ tone: "a", text: phPlain(c?.refused || "Add at least one line with a price to see the invoice.") });
  document.getElementById("ph-inv-sheet")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-inv-sheet", title: "Preview",
    body: `<div class="z-sheet__body z-stack">${body}<p class="z-hint">Not created yet. Your customer gets the full document from the invoice link.</p></div>`,
  }));
  $("ph-inv-sheet").dataset.ph = "1";
  Z.openOverlay("ph-inv-sheet", trigger);
}

/* One invoice: an issued one as paper, a supplier's as its details. */
PH.invoice = {
  title: (id) => { const i = phCache.invoices?.find((x) => x.id === id); return i?.issued ? `Invoice ${i.issued.number}` : "Invoice"; },
  live: (id) => { const i = phCache.invoices?.find((x) => x.id === id); return `${phCache.invoices === null}|${i?.state}|${i?.overdue}|${(i?.settlements || []).length}`; },
  html(id) {
    const i = phCache.invoices?.find((x) => x.id === id);
    if (!i) {
      return `${phTop("Invoice", "invoices")}${phMain(phCache.invoices === null || phCache.orgs === null
        ? Z.skeletonRows(3, "Loading the invoice…")
        : Z.note({ text: "This invoice is not on your account." }))}`;
    }
    const w = phInvWord(i);
    if (i.direction !== "outgoing") return phSupplierInvoice(i, w);
    const fresh = phCache.invIssued?.id === i.id ? phCache.invIssued.url : null;
    const pays = (i.settlements || []).map((s) => Z.row({
      lead: Z.iconTile({ icon: s.method === "bank" ? "account_balance" : "currency_exchange", tone: "m" }),
      title: s.method === "bank" ? (s.counterpartyName ? `From ${s.counterpartyName}` : "Bank transfer") : "Digital dollars (USDC)",
      sub: [s.method === "bank" ? "Bank transfer" : "From a crypto wallet", s.at ? phDay(s.at) : ""].filter(Boolean).join(" · "),
      right: Z.amount({ value: s.amountEur, direction: "in" }),
    }));
    return `${phTop(`Invoice ${i.issued.number}`, "invoices", Z.tag(w))}${phMain(`
      ${phPaperIssued(i, phCache.invProfile)}
      ${pays.length ? Z.listGroup({ label: "Received", rows: pays }) : ""}
      ${fresh
        ? `<div class="z-card">${Z.copyRow({ label: "Invoice link", value: fresh, display: fresh.replace(/^https?:\/\//, ""), mono: true })}</div>
           ${Z.note({ text: "Send the link or the PDF yourself. Zold doesn’t email your customers. The link is shown only now." })}`
        : Z.note({ text: "The invoice link was shown once, when you created the invoice. Zold keeps no copy of it, so it can’t show it again." })}
      <p class="z-err" id="ph-inv-err" role="alert" hidden></p>
    `)}${fresh ? phFoot(`<div class="z-pair"><a class="z-btn z-btn--secondary" href="${esc(fresh)}" target="_blank" rel="noopener">${Z.icon("download")}<span>PDF</span></a>${Z.button({ variant: "primary", icon: "ios_share", label: "Share", id: "ph-inv-share" })}</div>`) : ""}`;
  },
  bind(root, id) {
    if (phCache.orgs === null || phCache.invoices === null) {
      Promise.all([phLoadInvoices(), phCache.invProfile ? null : phLoadInvProfile()]).then(() => { if (phRoute?.name === "invoice") phRender(); });
      return;
    }
    if (!phCache.invProfile && phInvOrg()) phLoadInvProfile().then(() => { if (phRoute?.name === "invoice") phRender(); });
    phInvFreshen("invoice");
    const i = phCache.invoices.find((x) => x.id === id);
    const share = root.querySelector("#ph-inv-share");
    if (share && i && phCache.invIssued?.id === id) {
      const a = phInvAmount(i);
      share.onclick = () => phShare(`Invoice ${i.issued.number}`, `Invoice ${i.issued.number}, ${Z.formatMoney(a.value, a.currency)}:`, phCache.invIssued.url);
    }
  },
};

function phSupplierInvoice(i, w) {
  const a = phInvAmount(i);
  const bank = i.payTo?.kind === "bank" ? i.payTo.bank : null;
  if (w === "WAITING") {
    return `${phTop("Invoice request", "invoices/suppliers", Z.tag(w))}${phMain(`
      ${Z.note({ text: "Your supplier hasn’t filled this in yet. The link was shown once, when you created it." })}
      ${Z.kv([{ key: "Created", value: phFull(i.createdAt) }, ...(i.dueDate ? [{ key: "Due", value: phDay(phDate(i.dueDate)) }] : [])])}
    `)}`;
  }
  return `${phTop(i.supplier?.orgName || "Supplier invoice", "invoices/suppliers", Z.tag(w))}${phMain(`
    <div class="z-txhead"><p class="z-txhead__amt z-fig">${esc(Z.formatMoney(a.value, a.currency))}</p>
      <p class="z-sub">${esc([i.supplier?.orgName, i.supplier?.invoiceNumber ? `No. ${i.supplier.invoiceNumber}` : ""].filter(Boolean).join(" · "))}</p></div>
    ${Z.kv([
      ...(i.dueDate ? [{ key: "Due", value: phDay(phDate(i.dueDate)) }] : []),
      ...(bank ? [{ key: "Pay to", value: `${bank.holderName || ""} ${phShortIban(bank.iban)}`.trim() }] : [{ key: "Pay to", value: "No bank details given" }]),
      { key: "Submitted", value: i.submittedAt ? phFull(i.submittedAt) : "" },
    ])}
    ${Z.listGroup({ label: "Lines", rows: (i.lines || []).map((l) => Z.row({ title: l.description, sub: `${l.quantity} × ${Z.formatMoney(Number(l.unitPrice), i.currency)}`, right: `<span class="z-amount">${esc(Z.formatMoney(Number(l.amount), i.currency))}</span>` })) })}
    ${w === "PAID" ? "" : Z.note({ text: "Supplier invoices are paid from the web app for now, through a payment you review first." })}
  `)}${w === "PAID" || w === "IN FLIGHT" ? "" : phFoot(Z.button({ variant: "primary", full: true, label: "Pay in the web app", href: "/business" }))}`;
}

/* ==========================================================================
   Your invoice details
   ========================================================================== */

PH["invoice/profile"] = {
  title: "Your invoice details",
  html(from) {
    const back = from === "new" ? "invoice/new" : "invoices";
    if (phCache.orgs === null || (phInvOrg() && !phCache.invProfile)) return `${phTop("Your invoice details", back)}${phMain(Z.skeletonRows(4, "Loading your invoice details…"))}`;
    const org = phInvOrg();
    if (!org) return phInvGate(back);
    const prof = phCache.invProfile;
    const de = prof.jurisdiction.ruleSet === "DE";
    const small = !!prof.profile.smallBusiness;
    const u = user || {};
    return `${phTop("Your invoice details", back)}<form id="ph-prof" class="z-app__form" novalidate>${phMain(`
      <p class="z-sub">Set these once. They go on every invoice you issue.</p>
      <div class="z-form z-form--tight">
        ${Z.field({ id: "ph-p-name", label: "Name on invoices", name: "name", autocomplete: org.type === "business" ? "organization" : "name", value: org.legalName || prof.suggested?.name || org.name || u.name || "", maxlength: 120,
          hint: !org.legalName && prof.suggested?.source === "monerium" ? "Filled in from your Monerium profile. Check it matches the register." : org.type === "business" ? "The company’s registered name." : "Your full name, or your business’s registered name." })}
        ${Z.field({ id: "ph-p-addr", label: "Street and number", name: "address-line1", autocomplete: "address-line1", value: org.address?.line1 || "", maxlength: 120, placeholder: "Franz-Josef-Str. 11…" })}
        <div class="z-cols">
          ${Z.field({ id: "ph-p-zip", label: "Postcode", name: "postal-code", autocomplete: "postal-code", value: org.address?.postalCode || "", maxlength: 12, spellcheck: false })}
          ${Z.field({ id: "ph-p-city", label: "City", name: "address-level2", autocomplete: "address-level2", value: org.address?.city || "", maxlength: 80 })}
        </div>
        ${Z.select({ id: "ph-p-country", label: "Country", name: "country", autocomplete: "country", value: org.address?.country || u.country || "", options: phCountries(org.address?.country || u.country), hint: "It decides which invoicing rules apply." })}
      </div>
      <fieldset class="z-fieldset"><legend class="z-eyebrow">Tax</legend>
        <div class="z-seg">
          <label><input type="radio" name="small" value="yes"${small ? " checked" : ""}><span>${de ? "Kleinunternehmer" : "Small business, no VAT"}</span></label>
          <label><input type="radio" name="small" value="no"${small ? "" : " checked"}><span>Charges VAT</span></label>
        </div>
      </fieldset>
      ${Z.field({ id: "ph-p-tax", label: de ? "Tax number (Steuernummer)" : "Tax number or VAT ID", name: "tax-number", value: prof.profile.taxNumber || prof.profile.vatId || "", maxlength: 20, spellcheck: false, placeholder: de ? "144/123/45678…" : "", hint: de ? "Or a VAT ID if you have one. German invoices need one of the two." : "Your invoices need one of the two." })}
      ${u.iban && kycApproved(u)
        ? `<div class="z-card">${Z.copyRow({ label: "Paid to", value: String(u.iban).replace(/\s+/g, ""), display: Z.groupIban(u.iban), mono: true })}</div>
           <p class="z-hint">Your IBAN goes on the invoice, so customers pay you by bank transfer.</p>`
        : Z.note({ text: "Your IBAN goes on your invoices once your account is verified. Until then they carry no bank details." })}
      <p class="z-err" id="ph-prof-err" role="alert" hidden></p>
    `)}${phFoot(Z.button({ variant: "primary", full: true, label: "Save", type: "submit" }))}</form>`;
  },
  bind(root, from) {
    if (phCache.orgs === null || (phInvOrg() && !phCache.invProfile)) {
      phLoadInvProfile().then(() => { if (phRoute?.name === "invoice/profile") phRender(); });
      return;
    }
    const org = phInvOrg();
    if (!org) return phBindGate(root);
    if (user?.iban && kycApproved(user)) phLoadBic();
    const form = root.querySelector("#ph-prof");
    const f = (id) => root.querySelector(`#${id}`);
    const err = root.querySelector("#ph-prof-err");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (Z.isDisabled(btn)) return;
      err.hidden = true;
      const name = f("ph-p-name").value.trim();
      const line1 = f("ph-p-addr").value.trim(), zip = f("ph-p-zip").value.trim(), city = f("ph-p-city").value.trim();
      Z.setFieldError(f("ph-p-name"), name.length >= 2 ? "" : "Your full name, as the tax office knows it.");
      Z.setFieldError(f("ph-p-addr"), line1 ? "" : "Invoices need your full address.");
      Z.setFieldError(f("ph-p-zip"), zip ? "" : "Add the postcode.");
      Z.setFieldError(f("ph-p-city"), city ? "" : "Add the city.");
      Z.setFieldError(f("ph-p-country"), f("ph-p-country").value ? "" : "Choose the country.");
      Z.setFieldError(f("ph-p-tax"), "");
      if (Z.focusFirstError(form)) return;
      const tax = f("ph-p-tax").value.trim();
      // A VAT ID starts with its country's two letters; anything else is a
      // Steuernummer. Only the one typed is sent, so the other is kept; an
      // emptied field clears the one it showed.
      const isVatId = /^[A-Za-z]{2}\s*[0-9A-Za-z]/.test(tax);
      const shown = phCache.invProfile.profile.taxNumber ? "taxNumber" : "vatId";
      Z.setLoading(btn, true);
      try {
        // The tax details first: they are what the API may refuse, and a
        // refusal then leaves the name and address unchanged too.
        const bic = user?.iban && kycApproved(user) ? await phLoadBic() : null;
        await api(phOrgPath(org, "/invoicing/profile"), {
          smallBusiness: root.querySelector('input[name="small"]:checked')?.value === "yes",
          ...(tax ? (isVatId ? { vatId: tax } : { taxNumber: tax }) : { [shown]: "" }),
          ...(user?.iban && kycApproved(user) ? { bank: { holder: name, iban: String(user.iban).replace(/\s+/g, ""), bic: bic || "" } } : {}),
        }, "PATCH");
        await api(phOrgPath(org, ""), { legalName: name, address: { line1, postalCode: zip, city, country: f("ph-p-country").value } }, "PATCH");
        phCache.orgs = null; phCache.invProfile = null; phInv.check = null;
        await phLoadInvProfile();
        Z.announce("Saved.");
        phGo(from === "new" ? "invoice/new" : "invoices", null, { replace: true });
      } catch (x) {
        Z.setLoading(btn, false);
        if (x.body?.field === "taxNumber" || x.body?.field === "vatId") {
          Z.setFieldError(f("ph-p-tax"), phPlain(x.message));
          f("ph-p-tax").focus();
          return;
        }
        err.textContent = phPlain(x.message); err.hidden = false;
      }
    };
  },
};

/* ==========================================================================
   Ask a supplier for an invoice
   ========================================================================== */

PH["invoice/request"] = {
  title: "Request an invoice",
  html() {
    if (phCache.orgs === null) return `${phTop("Request an invoice", "invoices")}${phMain(Z.skeletonRows(2, "Loading…"))}`;
    if (!phInvOrg()) return phInvGate("invoices");
    const made = phCache.invRequest;
    if (made) {
      return `${phTop("Request an invoice", "invoices/suppliers")}${phMain(`
        <div class="z-card">${Z.copyRow({ label: "Link for your supplier", value: made.url, display: made.url.replace(/^https?:\/\//, ""), mono: true })}</div>
        ${Z.note({ text: "Share the link yourself. Zold doesn’t email your supplier. The link is shown only now, so copy or share it before you leave." })}
      `)}${phFoot(Z.button({ variant: "primary", full: true, icon: "ios_share", label: "Share", id: "ph-req-share" }))}`;
    }
    return `${phTop("Request an invoice", "invoices")}${phMain(`
      <p class="z-sub">Get a link for a supplier. They fill in their invoice and bank details, and it appears here under From suppliers.</p>
      ${Z.note({ text: "Anyone with the link can fill it in once. After that it is locked." })}
      <p class="z-err" id="ph-req-err" role="alert" hidden></p>
    `)}${phFoot(Z.button({ variant: "primary", full: true, icon: "add_link", label: "Create link", id: "ph-req-create" }))}`;
  },
  bind(root) {
    if (phCache.orgs === null) { phLoadOrgs().then(() => { if (phRoute?.name === "invoice/request") phRender(); }); return; }
    const org = phInvOrg();
    if (!org) return phBindGate(root);
    const share = root.querySelector("#ph-req-share");
    if (share) share.onclick = () => phShare("Invoice request", "Please send your invoice through this link:", phCache.invRequest.url);
    const create = root.querySelector("#ph-req-create");
    if (create) create.onclick = async () => {
      if (Z.isDisabled(create)) return;
      Z.setLoading(create, true);
      try {
        const r = await api(phOrgPath(org, "/invoices"), {});
        phCache.invRequest = { id: r.invoice.id, url: `${location.origin}${r.linkPath}` };
        phCache.invoices = null;
        phLoadInvoices();
        phRender();
      } catch (x) {
        Z.setLoading(create, false);
        const err = root.querySelector("#ph-req-err");
        err.textContent = phPlain(x.message); err.hidden = false;
      }
    };
  },
};

/* ==========================================================================
   Accounting connections
   ========================================================================== */

/* GetMyInvoices is a company feature (plans.ts); the Lexware CSV needs a plan
   with exports. Each row uses the first organisation that has it. */
const phGmiOrg = () => (phCache.orgs || []).find((o) => phCan(o, "integrations.accounting")) || null;
const phCsvOrg = () => phGmiOrg() || (phCache.orgs || []).find((o) => phCan(o, "export.ledger")) || null;

async function phLoadIntegrations() {
  await phLoadOrgs();
  const org = phGmiOrg();
  if (!org) { phCache.integrations = { none: true }; return; }
  try {
    const r = await api(phOrgPath(org, "/integrations"));
    phCache.integrations = { orgId: org.id, ...r };
  } catch (e) {
    phCache.integrations = { orgId: org.id, error: e.message };
  }
}

/* Which account a sheet acts for, when there is more than one to confuse. */
const phForOrg = (org) => ((phCache.orgs || []).length > 1 ? `<p class="z-hint">For ${esc(org.legalName || org.name)}</p>` : "");

const phInitials = (s) => `<span class="z-tile z-tile--txt" aria-hidden="true">${esc(s)}</span>`;

PH.integrations = {
  title: "Accounting connections",
  tab: "more",
  live: () => JSON.stringify([phCache.orgs === null, phCache.integrations?.integrations?.getmyinvoices?.connected, phCache.integrations?.error]),
  html() {
    if (phCache.orgs === null || phCache.integrations === null) return `${phTop("Accounting connections", "settings")}${phMain(Z.skeletonRows(4, "Loading your connections…"))}`;
    const gmiOrg = phGmiOrg(), csvOrg = phCsvOrg();
    const g = phCache.integrations?.integrations?.getmyinvoices;
    const gmiRight = !gmiOrg
      ? Z.tag("Business")
      : `${Z.tag("Beta")}${g?.connected ? Z.tag("On") : ""}<button type="button" class="z-btn z-btn--secondary z-btn--sm" id="ph-gmi">${g?.connected ? "Manage" : "Connect"}</button>`;
    return `${phTop("Accounting connections", "settings")}${phMain(`
      <p class="z-sub">Send your receipts and bank lines to the software your accountant uses.</p>
      ${Z.listGroup({ rows: [
        Z.row({ lead: phInitials("GMI"), title: "GetMyInvoices", sub: gmiOrg ? (g?.connected ? `Connected${g.accountName ? ` as ${g.accountName}` : ""}` : "API key · pushes Belege monthly") : "For company accounts", right: gmiRight }),
        Z.row({ lead: phInitials("LO"), title: "Lexware Office", sub: csvOrg ? "CSV import, no connection needed" : "Needs Premium or Business", right: csvOrg ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" id="ph-csv">CSV</button>` : Z.tag("Premium") }),
        Z.soonRow({ lead: phInitials("sev"), title: "sevDesk", sub: "Use the Lexware CSV for now" }),
        Z.soonRow({ lead: phInitials("DAT"), title: "DATEV", sub: "Exports for your Steuerberater" }),
      ] })}
      ${phCache.integrations?.error ? Z.note({ tone: "a", text: phPlain(phCache.integrations.error) }) : ""}
      ${Z.note({ tone: "a", icon: "science", text: "GetMyInvoices is in beta: tested against a stand-in, not a live account yet." })}
    `)}`;
  },
  bind(root) {
    if (phCache.orgs === null || phCache.integrations === null) {
      phLoadIntegrations().then(() => { if (phRoute?.name === "integrations") phRender(); });
      return;
    }
    const gmi = root.querySelector("#ph-gmi");
    if (gmi) gmi.onclick = () => phGmiSheet(gmi);
    const csv = root.querySelector("#ph-csv");
    if (csv) csv.onclick = () => phCsvSheet(csv);
  },
};

function phGmiSheet(trigger) {
  const org = phGmiOrg();
  const g = phCache.integrations?.integrations?.getmyinvoices;
  const available = phCache.integrations?.available !== false;
  document.getElementById("ph-gmi-sheet")?.remove();
  const body = g?.connected
    ? `<div class="z-sheet__body z-stack">
        ${phForOrg(org)}
        ${Z.kv([{ key: "Account", value: g.accountName || "GetMyInvoices" }, ...(g.accountEmail ? [{ key: "Email", value: g.accountEmail }] : []), { key: "Since", value: phDay(g.connectedAt) }])}
        <p class="z-hint">Belege are pushed from the monthly export in the web app. Nothing is uploaded on its own.</p>
        <p class="z-err" id="ph-gmi-err" role="alert" hidden></p>
        ${Z.button({ full: true, label: "Disconnect", id: "ph-gmi-off" })}
      </div>`
    : `<form class="z-sheet__body z-stack" id="ph-gmi-form" novalidate>
        ${phForOrg(org)}
        ${available
          ? `${Z.field({ id: "ph-gmi-key", label: "API key", name: "api-key", type: "password", autocomplete: "off", spellcheck: false, hint: "In GetMyInvoices, open Settings, then API. Zold checks the key once, stores it encrypted and never shows it again." })}
             <p class="z-err" id="ph-gmi-err" role="alert" hidden></p>
             ${Z.button({ variant: "primary", full: true, label: "Check and connect", type: "submit" })}`
          : Z.note({ tone: "a", text: "This server can’t store an API key yet, so GetMyInvoices can’t be connected here." })}
      </form>`;
  document.body.insertAdjacentHTML("beforeend", Z.overlay({ id: "ph-gmi-sheet", title: "GetMyInvoices", body }));
  const sheet = $("ph-gmi-sheet");
  sheet.dataset.ph = "1";
  const err = sheet.querySelector("#ph-gmi-err");
  const done = async () => { Z.closeOverlay("ph-gmi-sheet"); phCache.integrations = null; await phLoadIntegrations(); phRender(); };
  const form = sheet.querySelector("#ph-gmi-form");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const key = sheet.querySelector("#ph-gmi-key");
    if (Z.isDisabled(btn)) return;
    Z.setFieldError(key, key.value.trim() ? "" : "Paste the key from GetMyInvoices.");
    if (Z.focusFirstError(form)) return;
    Z.setLoading(btn, true);
    try {
      await api(phOrgPath(org, "/integrations/getmyinvoices"), { apiKey: key.value.trim() });
      await done();
    } catch (x) {
      Z.setLoading(btn, false);
      Z.setFieldError(key, phPlain(x.message));
      key.focus();
    }
  };
  const off = sheet.querySelector("#ph-gmi-off");
  if (off) off.onclick = async () => {
    if (Z.isDisabled(off)) return;
    Z.setLoading(off, true);
    try {
      await api(phOrgPath(org, "/integrations/getmyinvoices"), null, "DELETE");
      await done();
    } catch (x) {
      Z.setLoading(off, false);
      err.textContent = phPlain(x.message); err.hidden = false;
    }
  };
  Z.openOverlay("ph-gmi-sheet", trigger);
}

/* The month's bank lines as Lexware's CSV. The route needs the session, so
   the file is fetched and handed over as a download. */
function phCsvSheet(trigger) {
  const org = phCsvOrg();
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, k) => {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    return { value: phYmd(d).slice(0, 7), label: new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(d) };
  });
  document.getElementById("ph-csv-sheet")?.remove();
  document.body.insertAdjacentHTML("beforeend", Z.overlay({
    id: "ph-csv-sheet", title: "Lexware Office CSV",
    body: `<form class="z-sheet__body z-stack" id="ph-csv-form" novalidate>
      ${phForOrg(org)}
      ${Z.select({ id: "ph-csv-month", label: "Month", name: "month", value: months[1].value, options: months })}
      <p class="z-hint">Import it in Lexware Office under bank transactions. Lines without a Beleg are marked in the file.</p>
      <p class="z-err" id="ph-csv-err" role="alert" hidden></p>
      ${Z.button({ variant: "primary", full: true, icon: "download", label: "Download CSV", type: "submit" })}
    </form>`,
  }));
  const sheet = $("ph-csv-sheet");
  sheet.dataset.ph = "1";
  const form = sheet.querySelector("#ph-csv-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (Z.isDisabled(btn)) return;
    const err = sheet.querySelector("#ph-csv-err");
    err.hidden = true;
    const month = sheet.querySelector("#ph-csv-month").value;
    Z.setLoading(btn, true);
    try {
      const res = await fetch(phOrgPath(org, `/bookkeeping/export/${month}/lexware.csv`), { headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {} });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "The file could not be made.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `zold-${month}-lexware.csv`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      Z.announce("Downloaded.");
      Z.closeOverlay("ph-csv-sheet");
    } catch (x) {
      err.textContent = phPlain(x.message); err.hidden = false;
    } finally {
      Z.setLoading(btn, false);
    }
  };
  Z.openOverlay("ph-csv-sheet", trigger);
}
