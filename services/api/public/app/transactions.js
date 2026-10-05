/**
 * The share-receipt composer for one transfer. The payment screen itself and
 * Activity are app/phone.js.
 */
/* ---------- Share receipt ----------
   The composer picks what a public receipt exposes. The server builds the
   payload and never sends a withheld value, so these controls set what the
   server publishes. A change to a live link is saved immediately, so closing
   the screen after narrowing a selection narrows the real link. */
const SHARE_GROUPS = [
  { key: "sender", label: "Your name", options: [["full", "Full"], ["first", "First"], ["last", "Last"], ["hidden", "None"]] },
  { key: "recipient", label: "Recipient name", options: [["full", "Full"], ["first", "First"], ["last", "Last"], ["hidden", "None"]] },
  { key: "account", label: "Payout account", options: [["full", "Full"], ["short", "Short"], ["hidden", "Hide"]] },
  { key: "fx", label: "Amounts shown", options: [["both", "Both"], ["sender", "What you sent"], ["recipient", "What they got"]] },
];

/* "Reference & purpose" in the handoff. There is no purpose field on a
   transfer — only the SEPA remittance reference a sender can type — so the
   toggle governs what exists and is labelled for it. */
const SHARE_TOGGLES = [
  { key: "showRate", label: "Rate, fee & margin", sub: "The rate you got and what Zold charged" },
  { key: "showRef", label: "Your reference", sub: "The note that rides on the payment" },
  { key: "route", label: "Settlement route", sub: "Every hop the money took, with its references" },
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

/* paintShare redraws the controls; put focus back on the one in use, so arrow
   keys keep moving through a radio group and a switch stays focused. */
function shareFocusKey() {
  const el = document.activeElement;
  if (el?.dataset?.sgroup) return `input[data-sgroup="${el.dataset.sgroup}"][value="${el.value}"]`;
  if (el?.dataset?.stoggle) return `[data-stoggle="${el.dataset.stoggle}"]`;
  return null;
}

function paintShare() {
  const refocus = shareFocusKey();
  paintShareControls();
  if (refocus) document.querySelector(refocus)?.focus();
}

function paintShareControls() {
  const f = mShare.fields;
  // One radio group per choice (arrow keys move within it), then the extras
  // as switches: each control says what it is to a screen reader.
  $("m-share-groups").innerHTML = SHARE_GROUPS.map((g) => `
    <fieldset class="m-shfield"><legend>${esc(g.label)}</legend>
      <div class="z-seg">${g.options.map(([id, label]) =>
        `<label><input type="radio" name="m-sg-${g.key}" value="${id}" data-sgroup="${g.key}"${f[g.key] === id ? " checked" : ""} />${esc(label)}</label>`
      ).join("")}</div>
    </fieldset>`).join("");

  $("m-share-toggles").innerHTML = `<h3 class="m-shhead">Also show</h3><ul class="z-list z-card">${SHARE_TOGGLES.map((t) => `
    <li><button type="button" class="z-row z-row--btn m-shswitch" role="switch" data-stoggle="${t.key}" aria-checked="${!!f[t.key]}">
      <span class="z-row__main"><span class="z-row__title">${esc(t.label)}</span><span class="z-row__sub">${esc(t.sub)}</span></span>
      <span class="m-track" aria-hidden="true"><span class="knob"></span></span>
    </button></li>`).join("")}</ul>`;

  paintSharePreview();
  $("m-share-revoke").classList.toggle("hidden", !mShare.link);
  const foot = $("m-share-foot");
  if (mShare.link) {
    const days = Math.max(0, Math.ceil((Date.parse(mShare.expiresAt) - Date.now()) / 86400000));
    foot.textContent = `${mShare.link.replace(/^https?:\/\//, "")} · expires in ${days} day${days === 1 ? "" : "s"}`;
  } else {
    foot.textContent = "A link is created when you copy it, and stays live for 30 days.";
  }

  $("m-share-groups").querySelectorAll("input[data-sgroup]").forEach((r) => {
    r.onchange = () => setShare(r.dataset.sgroup, r.value);
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
      <span class="material-symbols-rounded" aria-hidden="true">${off ? "visibility_off" : "visibility"}</span>
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
  announce("Link copied");
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
