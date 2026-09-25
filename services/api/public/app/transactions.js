/**
 * A single transfer: the detail screen, the share-receipt composer, and the
 * Activity list.
 *
 * The dashboard's recent list and Activity render the SAME row component, and
 * the send progress screen and the detail screen share one timeline. They were
 * two functions drawing two shapes, so one transfer looked like two different
 * things depending on which screen you were on.
 */
/* ---------- transaction detail ---------- */
let mDetailId = null;

function openTransferDetail(id) {
  mDetailId = id;
  mobileNav("detail");
}

/**
 * One settled or in-flight transfer, in full.
 *
 * Reads the copy of the transfer already in `hist`, then re-reads it from the
 * API so an open detail screen is not a snapshot from whenever the list was
 * last loaded. A transfer that has since disappeared says so instead of
 * showing the stale row.
 */
async function renderDetailScreen() {
  const t = hist.find((x) => x.id === mDetailId);
  if (!t) {
    $("m-det-rows").innerHTML = '<div class="m-detrow"><div class="m-rowv">This transfer is no longer on your account.</div></div>';
    $("m-det-timeline").innerHTML = "";
    return;
  }
  paintDetail(t);
  try {
    const fresh = await api(`/api/transfers/${t.id}`);
    if (mDetailId !== fresh.id) return; // the user moved on while we were loading
    updateHistory(fresh);
    paintDetail(fresh);
  } catch {
    /* keep the row we already have — it is the last state the API gave us */
  }
}

function paintDetail(t) {
  const sepa = t.rail === "sepa";
  const st = mTxStatus(t);
  const dest = sepa ? "Europe" : "Kenya";
  $("m-det-amount").textContent = `−€${fmt(t.sendEur)}`;
  $("m-det-who").textContent = `to ${t.recipientName || "—"} · ${dest}`;
  const tag = $("m-det-status");
  tag.textContent = st.label;
  tag.className = `m-tag${t.state === "PAID" ? " on" : ""}`;
  if (t.state !== "PAID") tag.style.color = st.colour;
  else tag.style.color = "";

  const mask = (v) => (v && v.length > 12 ? `${v.slice(0, 4)} ···· ${v.slice(-4)}` : v);
  const rows = [
    ["Rail", sepa ? "SEPA transfer" : "MoneyGram cash pickup"],
    ["Destination", dest],
    ["They receive", sepa ? `€${fmt(t.receiveEur ?? 0)}` : `${fmt(t.receiveKes ?? 0)} KES`],
    ["Recipient", t.recipientName || "—"],
    [sepa ? "IBAN" : "Mobile", mask(sepa ? t.recipientIban : t.recipientPhone) || "—"],
    ...(t.reference ? [["Your reference", t.reference]] : []),
    ...(t.refund ? [["Refunded", `€${fmt(t.refund.amountEur)} · ${t.refund.deductions}`]] : []),
    ["Sent", new Date(t.createdAt).toLocaleString("en", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })],
    ["Transfer ID", t.id],
  ];
  $("m-det-rows").innerHTML = rows.map(([k, v]) => `
    <div class="m-detrow kv">
      <div class="m-rowk">${esc(k)}</div>
      <div class="m-rowv">${esc(String(v))}</div>
    </div>`).join("");

  const ref = t.pickup?.referenceCode;
  $("m-det-ref").classList.toggle("hidden", !(!sepa && ref));
  if (ref) $("m-det-code").textContent = ref;
  $("m-det-timeline").innerHTML = mTimeline(t).html;
  // CREATED means the device signature has not arrived, so nothing has moved
  // and there is no outcome to publish. The API refuses a share there too.
  const shareBtn = $("m-det-share");
  shareBtn.classList.toggle("hidden", t.state === "CREATED");
  shareBtn.onclick = () => openShare(t.id);
  // The printable receipt is a proof of payment, so it exists only for a
  // SEPA payout Monerium has processed. The share page covers in-flight ones.
  $("m-det-receipt").classList.toggle("hidden", !(t.rail === "sepa" && t.state === "PAID"));
  const err = $("m-det-error");
  err.classList.toggle("hidden", !t.error);
  if (t.error) err.innerHTML = `<span class="material-symbols-rounded" style="font-size:20px;flex:none">warning</span><div>${esc(t.error)}</div>`;
}

/* ---------- Share receipt ----------
   The composer picks what a public receipt exposes. The server builds the
   payload and never sends a withheld value, so these controls set what the
   server publishes. A change to a live link is saved immediately, so closing
   the screen after narrowing a selection narrows the real link. */
const SHARE_GROUPS = [
  { key: "sender", label: "Your name", options: [["full", "Full"], ["first", "First"], ["last", "Last"], ["hidden", "None"]] },
  { key: "recipient", label: "Recipient name", options: [["full", "Full"], ["first", "First"], ["last", "Last"], ["hidden", "None"]] },
  { key: "account", label: "Payout account", options: [["full", "Full"], ["short", "Short"], ["hidden", "Hide"]] },
  { key: "fx", label: "Currency shown", options: [["both", "Both"], ["sender", "EUR only"], ["recipient", "They get"]] },
];

/* "Reference & purpose" in the handoff. There is no purpose field on a
   transfer — only the SEPA remittance reference a sender can type — so the
   toggle governs what exists and is labelled for it. */
const SHARE_TOGGLES = [
  { key: "showRate", label: "Rate, fee & margin", sub: "The rate you got and what Zold charged" },
  { key: "showRef", label: "Your reference", sub: "The note that rides on the payment" },
  { key: "route", label: "Stats for nerds", sub: "Every settlement hop, with references" },
];

const SHARE_DEFAULTS = { sender: "last", recipient: "full", account: "short", fx: "both", showRate: true, showRef: true, route: false };
let mShare = { transferId: null, fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false };

function openShare(id) {
  mShare = { transferId: id, fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false };
  mobileNav("share");
}

async function renderShareScreen() {
  paintShare();
  if (!mShare.transferId) return;
  try {
    // An existing live share is the truth about what is already public; the
    // screen must open showing that, not the defaults.
    const s = await api(`/api/transfers/${mShare.transferId}/share`, undefined, "GET");
    mShare.fields = { ...SHARE_DEFAULTS, ...s.fields };
    mShare.link = s.url;
    mShare.expiresAt = s.expiresAt;
  } catch {
    /* No live share yet — the defaults stand and the CTA will create one. */
  }
  paintShare();
}

function paintShare() {
  const f = mShare.fields;
  $("m-share-groups").innerHTML = SHARE_GROUPS.map((g) => `
    <div class="m-sharegroup">
      <div class="lab">${esc(g.label)}</div>
      <div class="m-segs">${g.options.map(([id, label]) =>
        `<button data-sgroup="${g.key}" data-sval="${id}" class="${f[g.key] === id ? "on" : ""}">${esc(label)}</button>`
      ).join("")}</div>
    </div>`).join("");

  $("m-share-toggles").innerHTML = SHARE_TOGGLES.map((t) => `
    <button class="m-shtoggle" data-stoggle="${t.key}" aria-pressed="${!!f[t.key]}">
      <span class="lab">${esc(t.label)}<span class="sub">${esc(t.sub)}</span></span>
      <span class="m-track"><span class="knob"></span></span>
    </button>`).join("");

  paintSharePreview();
  $("m-share-revoke").classList.toggle("hidden", !mShare.link);
  const foot = $("m-share-foot");
  if (mShare.link) {
    const days = Math.max(0, Math.ceil((Date.parse(mShare.expiresAt) - Date.now()) / 86400000));
    foot.textContent = `${mShare.link.replace(/^https?:\/\//, "")} · expires in ${days} day${days === 1 ? "" : "s"}`;
  } else {
    foot.textContent = "A link is created when you copy it, and stays live for 30 days.";
  }

  $("m-share-groups").querySelectorAll("button").forEach((b) => {
    b.onclick = () => setShare(b.dataset.sgroup, b.dataset.sval);
  });
  $("m-share-toggles").querySelectorAll("button").forEach((b) => {
    b.onclick = () => setShare(b.dataset.stoggle, !mShare.fields[b.dataset.stoggle]);
  });
}

/**
 * What the link will carry, in words.
 *
 * The handoff renders a live 520px copy of the public page beside the pickers.
 * At 412px that would be a preview too small to read, which answers none of
 * the question the composer asks — so this lists each field and whether it
 * survives, which is the same information at the size available.
 */
function paintSharePreview() {
  const t = hist.find((x) => x.id === mShare.transferId) || {};
  const f = mShare.fields;
  const sepa = t.rail === "sepa";
  const nameSummary = (mode, full) => {
    const parts = String(full || "").trim().split(/\s+/);
    if (mode === "hidden" || !parts[0]) return null;
    if (mode === "full") return parts.join(" ");
    if (mode === "first") return `${parts[0]} ▒▒▒▒▒`;
    return parts.length > 1 ? `▒▒▒▒▒ ${parts.slice(1).join(" ")}` : null;
  };
  const acct = sepa ? t.recipientIban : t.recipientPhone;
  const acctSummary = () => {
    if (!acct || f.account === "hidden") return null;
    const c = String(acct).replace(/\s+/g, "");
    if (f.account === "full") return c.replace(/(.{4})/g, "$1 ").trim();
    return c.length > 8 ? `${c.slice(0, 4)} ···· ${c.slice(-4)}` : null;
  };
  const rows = [
    ["Your name", nameSummary(f.sender, user?.name)],
    ["Recipient", nameSummary(f.recipient, t.recipientName)],
    [sepa ? "Payout account" : "Mobile number", acctSummary()],
    ["Amount", f.fx === "both" ? "Both currencies" : f.fx === "sender" ? "What you sent" : "What they get"],
    ["Rate & fee", f.showRate ? "Shown" : null],
    ["Your reference", t.reference ? (f.showRef ? t.reference : null) : "—"],
    ["Settlement route", f.route ? "Shown" : null],
  ];
  $("m-share-preview").innerHTML = rows.map(([k, v]) => {
    const off = v === null;
    const shown = off ? "withheld" : v;
    return `<div class="r ${off ? "off" : "on"}">
      <span class="material-symbols-rounded">${off ? "visibility_off" : "visibility"}</span>
      <span>${esc(k)}</span><span class="v">${esc(shown)}</span>
    </div>`;
  }).join("");
}

async function setShare(key, value) {
  mShare.fields = { ...mShare.fields, [key]: value };
  paintShare();
  // Only a link that already exists needs pushing: narrowing an unpublished
  // selection has nothing to narrow yet, and creating one here would publish a
  // receipt the sender never asked to share.
  if (mShare.link) await saveShare({ silent: true });
}

async function saveShare({ silent } = {}) {
  if (mShare.busy) return null;
  mShare.busy = true;
  try {
    const s = await api(`/api/transfers/${mShare.transferId}/share`, mShare.fields);
    mShare.link = s.url;
    mShare.expiresAt = s.expiresAt;
    clearErr("m-share-err");
    paintShare();
    return s;
  } catch (e) {
    if (!silent) showErr("m-share-err", e);
    return null;
  } finally {
    mShare.busy = false;
  }
}

$("m-share-copy").onclick = async () => {
  const btn = $("m-share-copy");
  const s = mShare.link ? { url: mShare.link } : await saveShare();
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s.url);
  } catch {
    // A denied clipboard must not read as a failure to create the link — the
    // link exists either way, and the footer under the button shows it.
    showErr("m-share-err", new Error("could not reach the clipboard — the link is shown below"));
    return;
  }
  btn.textContent = "Link copied";
  setTimeout(() => { btn.textContent = "Copy share link"; }, 1800);
};

$("m-share-revoke").onclick = async () => {
  try {
    await api(`/api/transfers/${mShare.transferId}/share`, undefined, "DELETE");
    mShare.link = null;
    mShare.expiresAt = null;
    clearErr("m-share-err");
    paintShare();
  } catch (e) {
    showErr("m-share-err", e);
  }
};

/* ---------- Activity ---------- */
let mFilter = "all";

function renderActivityScreen() {
  const list = hist.filter((t) => mFilter === "all" || t.rail === mFilter);
  $("m-tx-list").innerHTML = list.length
    ? list.map(mTxRow).join("")
    : '<div class="m-empty" style="text-align:center;padding:32px 0">Nothing here yet</div>';
  document.querySelectorAll("#m-filters button").forEach((b) => {
    const on = b.dataset.mfilter === mFilter;
    b.classList.toggle("on", on);
    // The design puts a leading check on the selected chip only.
    const tick = b.querySelector(".material-symbols-rounded");
    if (on && !tick) b.insertAdjacentHTML("afterbegin", '<span class="material-symbols-rounded">check</span>');
    if (!on && tick) tick.remove();
  });
  bindTxRows($("m-tx-list"));
}
