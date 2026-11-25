/**
 * The share-receipt composer for one transfer. The payment screen itself and
 * Activity are app/phone.js.
 */
/* ---------- Share receipt ----------
   The composer picks what a public receipt exposes. The server builds the
   payload and never sends a withheld value, so these controls set what the
   server publishes. A change to a live link is saved immediately, so closing
   the screen after narrowing a selection narrows the real link. Until the
   saved choices have loaded, nothing on the screen can be changed or
   published: the defaults painted first are not what the sender chose. */
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
/* One object per opened composer: a request answers only the object it was
   started for, so a reply that lands after another receipt opened is dropped
   rather than written into that receipt's screen. `published` is what the
   live link carries, as the server last said; an edit Zold refuses goes back
   to it, and one whose outcome is unknown re-reads it. */
let mShare = { transferId: null, fields: { ...SHARE_DEFAULTS }, published: null, link: null, expiresAt: null, expired: false, busy: false, again: false, loaded: false };

function openShare(id) {
  mShare = { transferId: id, fields: { ...SHARE_DEFAULTS }, published: null, link: null, expiresAt: null, expired: false, busy: false, again: false, loaded: false };
  mobileNav("share");
}

async function renderShareScreen() {
  const m = mShare;
  m.loaded = false;
  clearErr("m-share-err");
  paintShare();
  if (!m.transferId) return;
  try {
    await loadShare(m);
  } catch (e) {
    if (mShare !== m) return;
    // Anything but Zold's own 404 leaves the screen locked: we do not know
    // what the sender chose.
    showErr("m-share-err", e);
  }
  if (mShare !== m) return;
  paintShare();
}

/* Read what the live link carries and adopt it as both the screen and
   `published`. An existing live share is the truth about what is already
   public; the screen must show that, not the defaults. No share yet (Zold's
   own 404) is an answer too: the CTA will create one. An expired one sends
   back its choices (never its URL), so the new link starts from them. Any
   other failure throws and leaves `loaded` false. */
async function loadShare(m) {
  try {
    const s = await api(`/api/transfers/${m.transferId}/share`, undefined, "GET");
    if (mShare !== m) return;
    m.fields = { ...SHARE_DEFAULTS, ...s.fields };
    m.published = { ...m.fields };
    m.link = s.url;
    m.expiresAt = s.expiresAt;
    m.expired = false;
  } catch (e) {
    if (mShare !== m) return;
    if (!(e?.status === 404 && e.fromZold)) throw e;
    m.link = null;
    m.expiresAt = null;
    m.published = null;
    if (e.body?.expired) {
      m.fields = { ...SHARE_DEFAULTS, ...e.body.fields };
      m.expired = true;
    }
  }
  m.loaded = true;
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

/* A link that runs out while the screen is open is not offered any more: the
   recipient would get "expired". Checked on every paint and again at the
   Copy or Share tap, since the screen may sit open without redrawing. */
function dropExpiredShare() {
  if (!mShare.link || Date.parse(mShare.expiresAt) > Date.now()) return false;
  mShare.link = null;
  mShare.expiresAt = null;
  mShare.expired = true;
  return true;
}

function paintShareControls() {
  dropExpiredShare();
  const f = mShare.fields;
  const off = mShare.loaded ? "" : " disabled";
  // One radio group per choice (arrow keys move within it), then the extras
  // as switches: each control says what it is to a screen reader.
  $("m-share-groups").innerHTML = SHARE_GROUPS.map((g) => `
    <fieldset class="m-shfield"><legend>${esc(g.label)}</legend>
      <div class="z-seg">${g.options.map(([id, label]) =>
        `<label><input type="radio" name="m-sg-${g.key}" value="${id}" data-sgroup="${g.key}"${f[g.key] === id ? " checked" : ""}${off} />${esc(label)}</label>`
      ).join("")}</div>
    </fieldset>`).join("");

  $("m-share-toggles").innerHTML = `<h3 class="m-shhead">Also show</h3><ul class="z-list z-card">${SHARE_TOGGLES.map((t) => `
    <li><button type="button" class="z-row z-row--btn m-shswitch" role="switch" data-stoggle="${t.key}" aria-checked="${!!f[t.key]}"${off}>
      <span class="z-row__main"><span class="z-row__title">${esc(t.label)}</span><span class="z-row__sub">${esc(t.sub)}</span></span>
      <span class="m-track" aria-hidden="true"><span class="knob"></span></span>
    </button></li>`).join("")}</ul>`;

  paintSharePreview();
  $("m-share-revoke").classList.toggle("hidden", !mShare.link);
  // The link to send is drawn as the screen's result, with its own copy and
  // share buttons, so the address bar is not mistaken for it. Until what the
  // link carries is confirmed it is not drawn at all: the preview beside it
  // may not be what the recipient would see.
  const sendable = mShare.loaded && mShare.link;
  $("m-share-out").classList.toggle("hidden", !sendable);
  $("m-share-url").textContent = sendable || "";
  $("m-share-copy").textContent = shareCopyLabel();
  $("m-share-copy").disabled = !mShare.loaded;
  // Share appears only with a link, so its tap opens the sheet at once: a
  // request first would spend the tap's activation and the sheet would refuse.
  $("m-share-native").classList.toggle("hidden", !mShare.link || !mShare.loaded || typeof navigator.share !== "function");
  const foot = $("m-share-foot");
  if (mShare.link) {
    const days = Math.max(0, Math.ceil((Date.parse(mShare.expiresAt) - Date.now()) / 86400000));
    foot.textContent = `Live · expires in ${days} day${days === 1 ? "" : "s"}`;
  } else if (mShare.expired) {
    foot.textContent = "The last link expired and stays off. Create a new one; it stays live for 30 days.";
  } else {
    foot.textContent = "Nothing is public until you create the link. It stays live for 30 days.";
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
  if (!mShare.loaded) return;
  mShare.fields = { ...mShare.fields, [key]: value };
  paintShare();
  // Only a link that already exists needs pushing: narrowing an unpublished
  // selection has nothing to narrow yet, and creating one here would publish a
  // receipt the sender never asked to share.
  // It goes as an edit: if the link ran out on the way, the server refuses
  // rather than publishing a new one the sender did not ask for.
  if (!mShare.link) return;
  // A change made while a save is in flight is saved when that one lands, so
  // the tap is neither lost nor visibly undone by the earlier answer.
  if (mShare.busy) { mShare.again = true; return; }
  await saveShare({ silent: true, edit: true });
}

async function saveShare({ silent, edit } = {}) {
  const m = mShare;
  if (m.busy || !m.loaded) return null;
  m.busy = true;
  let s = null;
  try {
    s = await api(`/api/transfers/${m.transferId}/share`, edit ? { ...m.fields, edit: true } : m.fields);
    if (mShare !== m) return null;
    // The screen shows what the server saved, not what it was sent, unless a
    // newer change is queued: that save's answer replaces this one.
    m.published = { ...SHARE_DEFAULTS, ...s.fields };
    if (!m.again) m.fields = { ...m.published };
    m.link = s.url;
    m.expiresAt = s.expiresAt;
    m.expired = false;
    clearErr("m-share-err");
    paintShare();
  } catch (e) {
    if (mShare !== m) return null;
    if (e?.body?.expired) {
      m.link = null;
      m.expiresAt = null;
      m.expired = true;
      paintShare();
    } else if (edit && e?.fromZold && e.status < 500) {
      /* Zold refused the edit, so the live link still carries what it
         carried before: back to what is published, the queued change dropped
         with it, and said out loud. */
      m.fields = { ...m.published };
      m.again = false;
      paintShare();
      showErr("m-share-err", new Error(`that change was not saved (${e.message}). The live link still shows what is selected here`));
    } else if (edit) {
      /* The route writes before it replies, so a lost answer, a gateway's
         5xx or a drop mid-request may have saved the change. Neither the old
         nor the new choice is known to be live: lock the screen and ask. */
      m.again = false;
      m.loaded = false;
      paintShare();
      try {
        await loadShare(m);
        if (mShare !== m) return null;
        paintShare();
        showErr("m-share-err", new Error("Zold's answer to that change didn't arrive, so the screen now shows what the live link carries"));
      } catch {
        if (mShare !== m) return null;
        showErr("m-share-err", new Error("could not confirm what the link shows. Reopen this receipt before you change it or send it"));
      }
    }
    if (!silent) showErr("m-share-err", e);
  } finally {
    m.busy = false;
  }
  if (m.again && mShare === m) {
    m.again = false;
    if (m.link) await saveShare({ silent: true, edit: true });
  }
  return s;
}

const shareCopyLabel = () => (mShare.link ? "Copy link" : "Create link");

/* With no link, the button only creates one: the clipboard, like the share
   sheet, wants the tap's activation, which the request would have spent.
   Copy and Share then work from their own taps. */
$("m-share-copy").onclick = async () => {
  const btn = $("m-share-copy");
  if (!mShare.loaded) return;
  if (dropExpiredShare()) return paintShare();
  if (!mShare.link) {
    if (await saveShare()) announce("Link created");
    return;
  }
  try {
    await navigator.clipboard.writeText(mShare.link);
  } catch {
    // A denied clipboard must not read as a failure to create the link — the
    // link exists either way, and "Send this link" shows it.
    showErr("m-share-err", new Error("could not reach the clipboard — copy the link shown above"));
    return;
  }
  btn.textContent = "Link copied";
  announce("Link copied");
  setTimeout(() => { btn.textContent = shareCopyLabel(); }, 1800);
};

/* The phone's share sheet, where the browser has one, called straight from
   the tap. Closing the sheet is not an error. A sheet that fails points at
   Copy: copying here, without a fresh tap, would fail the same way. */
$("m-share-native").onclick = async () => {
  if (dropExpiredShare()) return paintShare();
  if (!mShare.link || !mShare.loaded) return;
  try {
    await navigator.share({ title: "Zold receipt", url: mShare.link });
  } catch (e) {
    if (e?.name === "AbortError") return;
    showErr("m-share-err", new Error("the share sheet did not open. Tap Copy link and paste it where you want it"));
  }
};

$("m-share-revoke").onclick = async () => {
  try {
    await api(`/api/transfers/${mShare.transferId}/share`, undefined, "DELETE");
    // No link is a known state, even after a confirmation that failed: the
    // composer is unlocked and Create link starts a new one.
    mShare.link = null;
    mShare.expiresAt = null;
    mShare.published = null;
    mShare.loaded = true;
    clearErr("m-share-err");
    paintShare();
  } catch (e) {
    showErr("m-share-err", e);
  }
};
