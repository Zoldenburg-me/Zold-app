/**
 * The phone app: Activity and one payment.
 *
 * Classic script after app/phone.js, which holds the router (PH, phGo,
 * phRender) and the shared pieces these screens use. Declarations and wiring
 * only: nothing here runs at load. app/main.js stays last.
 */

/* ==========================================================================
   Activity and one payment
   ========================================================================== */

const PH_FILTERS = [["all", "All"], ["in", "Money in"], ["out", "Money out"], ["flight", "In flight"]];
let phQuery = "";

function phFiltered(filter, q) {
  const needle = q.trim().toLowerCase();
  return hist.filter((t) => {
    if (filter === "in" && t.kind !== "funding") return false;
    if (filter === "out" && t.kind === "funding") return false;
    if (filter === "flight" && !phInFlight(t)) return false;
    if (!needle) return true;
    const hay = [t.recipientName, t.reference, t.recipientIban, t.token === "USDC" ? "digital dollars usdc" : t.kind === "funding" ? "euros received" : ""]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

/* Grouped by when: today, this month, then one group per month. */
function phGroups(list) {
  const now = new Date();
  const groups = [];
  for (const t of list) {
    const d = new Date(t.at || t.createdAt || t.detectedAt);
    const label = d.toDateString() === now.toDateString() ? "Today"
      : d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? "Earlier this month"
        : new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(d);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.rows.push(t); else groups.push({ label, rows: [t] });
  }
  return groups;
}

function phActivityResults(filter) {
  if (!histLoaded && !histLoadFailed) return Z.skeletonRows(5, "Loading your payments…");
  if (histLoadFailed && !hist.length) return phActivityList([], {});
  const list = phFiltered(filter, phQuery);
  if (!list.length) {
    return Z.listGroup({ rows: [], empty: hist.length
      ? { text: "Nothing matches. Try another word or filter." }
      : { text: "No payments yet. Share your account details to get paid.", action: { href: "#account-details", label: "Account details" } } });
  }
  return phGroups(list).map((g) => Z.listGroup({ label: g.label, rows: g.rows.map(phActivityRow) })).join("");
}

PH.activity = {
  title: "Activity",
  tab: "activity",
  live: (arg) => `${arg}|${phHistSig()}`,
  html(arg) {
    const filter = PH_FILTERS.some(([k]) => k === arg) ? arg : "all";
    return `${phTop("Activity")}${phMain(`
      <form class="z-search" role="search" onsubmit="return false">
        <label class="z-sr" for="ph-q">Search payments</label>${Z.icon("search")}
        <input class="z-search__input" id="ph-q" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Search payments…" value="${esc(phQuery)}">
      </form>
      <div class="z-pills" role="group" aria-label="Show">
        ${PH_FILTERS.map(([k, label]) => `<a class="z-pill" href="#activity${k === "all" ? "" : `/${k}`}" aria-current="${k === filter ? "true" : "false"}">${esc(label)}</a>`).join("")}
      </div>
      <div id="ph-results" aria-live="polite">${phActivityResults(filter)}</div>
    `)}`;
  },
  bind(root, arg) {
    const filter = PH_FILTERS.some(([k]) => k === arg) ? arg : "all";
    const q = root.querySelector("#ph-q");
    q.oninput = () => {
      phQuery = q.value;
      root.querySelector("#ph-results").innerHTML = phActivityResults(filter);
      phBindRetry(root);
    };
    phBindRetry(root);
  },
};

/* One payment: its body and its actions, drawn as a screen on the phone and
   as a drawer over Activity on a desktop (app/desktop.js). */
function phTxParts(id) {
  const t = hist.find((x) => x.id === id && x.kind !== "funding");
  if (!t) {
    return { t: null, foot: "", body: histLoaded || histLoadFailed
      ? Z.note({ text: "This payment is not on your account." })
      : Z.skeletonRows(3, "Loading the payment…") };
  }
  const cash = t.rail === "cash";
  const fee = !cash && typeof t.receiveEur === "number" ? Math.max(0, (t.sendEur || 0) - t.receiveEur) : null;
  const rows = [
    { key: "Date", value: phFull(t.createdAt) },
    ...(cash ? [{ key: "To mobile", value: t.recipientPhone }] : [{ key: "To IBAN", value: phShortIban(t.recipientIban), mono: true }]),
    ...(fee !== null ? [{ key: "Zold fee", value: phEur(fee) }] : []),
    { key: "Sent as", value: cash ? "Cash pickup" : "Bank transfer" },
    ...(!cash ? [{ key: "Reference", value: t.reference || "", hint: "On their bank statement" }] : []),
    ...(t.refund ? [{ key: "Refunded", value: phEur(t.refund.amountEur) }] : []),
  ];
  const hashes = (t.txs || []).filter((x) => x.hash);
  const tech = [
    { key: "Payment ID", value: t.id, mono: true },
    ...(!cash && t.recipientIban ? [{ key: "Full IBAN", value: Z.groupIban(t.recipientIban), mono: true }] : []),
    ...(t.sepa?.orderId ? [{ key: "Monerium order", value: t.sepa.orderId, mono: true }] : []),
    ...hashes.map((x) => ({ key: x.step, value: x.hash, mono: true })),
  ];
  const receipt = t.rail === "sepa" && t.state === "PAID";
  return { t, body: `
    <div class="z-txhead">
      ${Z.avatar({ name: t.recipientName })}
      <p class="z-txhead__amt z-fig">${phOut(t) ? "−" : ""}${esc(phEur(t.sendEur))}</p>
      <p class="z-sub">to ${esc(t.recipientName || "")}</p>
      ${Z.tag(phTxWord(t))}
    </div>
    ${t.error ? Z.note({ tone: "a", text: t.error }) : ""}
    ${phInFlight(t) ? Z.note({ tone: "p", html: `On its way. <a href="${phHref("send/progress", t.id)}">See progress</a>` }) : ""}
    ${Z.kv(rows)}
    <details class="z-disclose"><summary>Technical details${Z.icon("expand_more")}</summary>${Z.kv(tech)}</details>
    <p class="z-err" id="ph-tx-err" role="alert" hidden></p>
  `, foot: t.state === "CREATED" ? "" : `<div class="z-pair">
      ${receipt ? Z.button({ icon: "receipt_long", label: "Receipt", id: "ph-tx-receipt" }) : ""}
      ${Z.button({ variant: receipt ? "secondary" : "primary", icon: "ios_share", label: "Share", href: phHref("share", t.id), className: receipt ? "" : "z-btn--full" })}
    </div>` };
}

PH.tx = {
  title: "Payment",
  live: (id) => { const t = hist.find((x) => x.id === id); return t ? `${t.state}|${t.updatedAt}` : `none|${histLoaded}`; },
  html(id) {
    const p = phTxParts(id);
    return `${phTop("Payment", "activity")}${phMain(p.body)}${p.foot ? phFoot(p.foot) : ""}`;
  },
  bind(root, id) {
    const b = root.querySelector("#ph-tx-receipt");
    if (b) b.onclick = async () => {
      Z.setLoading(b, true);
      try {
        const d = await api(`/api/users/${user.id}/documents/receipt`, { transferId: id });
        const u = safeUrl(d.url) || (typeof d.url === "string" && d.url.startsWith("/") ? d.url : null);
        if (u) window.open(u, "_blank", "noopener");
      } catch (e) {
        const err = root.querySelector("#ph-tx-err");
        err.textContent = e.message; err.hidden = false;
      } finally { Z.setLoading(b, false); }
    };
    // Re-read the transfer, so an open screen is not a snapshot of the list.
    if (id && hist.some((x) => x.id === id)) {
      api(`/api/transfers/${encodeURIComponent(id)}`).then((fresh) => {
        const old = hist.find((x) => x.id === id);
        if (old && (old.state !== fresh.state || old.updatedAt !== fresh.updatedAt)) updateHistory({ kind: "transfer", ...old, ...fresh });
      }).catch(() => { /* keep what the list had */ });
    }
  },
};

/* The older share composer, reached from one payment. */
PH_LEGACY.share = "share";

