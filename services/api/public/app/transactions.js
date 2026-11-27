/**
 * The share-receipt composer for one transfer. The payment screen itself and
 * Activity are app/phone.js.
 */
/* ---------- Share receipt ----------
   The composer picks what a public receipt exposes. The server builds the
   payload and never sends a withheld value, so these controls set what the
   server publishes. A link once sent never changes: changing a choice while
   a link is live offers "Make new link", which publishes the new choices
   under a new link and turns the old one off. Until the saved choices have
   loaded, nothing on the screen can be changed or published: the defaults
   painted first are not what the sender chose. */
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
   live link carries, as the server last said. `revokes` counts the times
   this link was turned off: a read that started before one answers a link
   that no longer exists, and is dropped. While a link is being made the
   choices, the button and Turn this link off are locked: the answer would
   undo a change tapped meanwhile, and a turn-off could land before the new
   link exists. */
let mShare = { transferId: null, fields: { ...SHARE_DEFAULTS }, published: null, link: null, expiresAt: null, expired: false, busy: false, loaded: false, revokes: 0 };

function openShare(id) {
  mShare = { transferId: id, fields: { ...SHARE_DEFAULTS }, published: null, link: null, expiresAt: null, expired: false, busy: false, loaded: false, revokes: 0 };
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
  const revokes = m.revokes;
  try {
    const s = await api(`/api/transfers/${m.transferId}/share`, undefined, "GET");
    if (mShare !== m || m.revokes !== revokes) return;
    m.fields = { ...SHARE_DEFAULTS, ...s.fields };
    m.published = { ...m.fields };
    m.link = s.url;
    m.expiresAt = s.expiresAt;
    m.expired = false;
  } catch (e) {
    if (mShare !== m || m.revokes !== revokes) return;
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
  const off = shareLocked() ? " disabled" : "";
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
  const changed = shareChanged();
  $("m-share-revoke").classList.toggle("hidden", !mShare.link);
  $("m-share-revoke").disabled = mShare.busy;
  // The link to send is drawn as the screen's result, with its own copy and
  // share buttons, so the address bar is not mistaken for it. Until what the
  // link carries is confirmed it is not drawn at all: the preview beside it
  // may not be what the recipient would see.
  const sendable = mShare.loaded && !changed && mShare.link;
  $("m-share-out").classList.toggle("hidden", !sendable);
  $("m-share-url").textContent = sendable || "";
  $("m-share-copy").textContent = shareCopyLabel();
  $("m-share-copy").disabled = shareLocked();
  // Share appears only with a link, so its tap opens the sheet at once: a
  // request first would spend the tap's activation and the sheet would refuse.
  $("m-share-native").classList.toggle("hidden", !sendable || typeof navigator.share !== "function");
  const foot = $("m-share-foot");
  if (mShare.link && !mShare.loaded) {
    foot.textContent = "The link is on, but what it shows is not confirmed";
  } else if (changed) {
    foot.textContent = "The live link still shows your earlier choices. Make new link to share these: the current link then stops working.";
  } else if (mShare.link) {
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

/* What the link shows is unconfirmed, or a link is being made. */
function shareLocked() {
  return !mShare.loaded || mShare.busy;
}

const sameShareFields = (a, b) => !!a && !!b && Object.keys(SHARE_DEFAULTS).every((k) => a[k] === b[k]);
/* A live link whose choices differ from the screen: sending it would send
   what the preview no longer shows. */
const shareChanged = () => !!mShare.link && !sameShareFields(mShare.fields, mShare.published);

/* A choice changes the screen only. Nothing is sent: a link that exists
   keeps what it shows, and only the button publishes. */
function setShare(key, value) {
  if (shareLocked()) return;
  mShare.fields = { ...mShare.fields, [key]: value };
  paintShare();
}

/* Make a link with the choices on screen. The server turns the previous one
   off in the same step. */
async function saveShare() {
  const m = mShare;
  if (m.busy || !m.loaded) return null;
  m.busy = true;
  const revokes = m.revokes;
  paintShare();
  let s = null;
  try {
    s = await api(`/api/transfers/${m.transferId}/share`, m.fields);
    if (mShare !== m || m.revokes !== revokes) return null;
    // The screen shows what the server published, not what it was sent.
    m.published = { ...SHARE_DEFAULTS, ...s.fields };
    m.fields = { ...m.published };
    m.link = s.url;
    m.expiresAt = s.expiresAt;
    m.expired = false;
    clearErr("m-share-err");
  } catch (e) {
    if (mShare !== m || m.revokes !== revokes) return null;
    if (e?.fromZold && e.status < 500) {
      // Refused: nothing was made, and any live link is as it was.
      showErr("m-share-err", e);
    } else {
      /* The route writes before it replies, so a lost answer or a gateway's
         5xx may have made the new link and turned the old one off. Which
         link is live is not known: lock the screen and ask. */
      m.loaded = false;
      m.busy = false;
      paintShare();
      try {
        await loadShare(m);
        if (mShare !== m || m.revokes !== revokes) return null;
        showErr("m-share-err", new Error("Zold's answer didn't arrive, so the screen now shows the link that is live"));
      } catch {
        if (mShare !== m || m.revokes !== revokes) return null;
        showErr("m-share-err", new Error("could not confirm which link is live. Reopen this receipt before you send it"));
      }
    }
  } finally {
    m.busy = false;
    if (mShare === m) paintShare();
  }
  return s;
}

const shareCopyLabel = () => (!mShare.link ? "Create link" : shareChanged() ? "Make new link" : "Copy link");

/* With no link, or choices the live link does not carry, the button only
   makes one: the clipboard, like the share sheet, wants the tap's
   activation, which the request would have spent. Copy and Share then work
   from their own taps. */
$("m-share-copy").onclick = async () => {
  const btn = $("m-share-copy");
  if (shareLocked()) return;
  if (dropExpiredShare()) return paintShare();
  if (!mShare.link || shareChanged()) {
    const replacing = !!mShare.link;
    if (await saveShare()) announce(replacing ? "New link created. The old link no longer works" : "Link created");
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
  if (!mShare.link || !mShare.loaded || shareChanged()) return;
  try {
    await navigator.share({ title: "Zold receipt", url: mShare.link });
  } catch (e) {
    if (e?.name === "AbortError") return;
    showErr("m-share-err", new Error("the share sheet did not open. Tap Copy link and paste it where you want it"));
  }
};

/* The reply answers the receipt it was sent for: one that lands after
   another receipt opened must not unlock that receipt before its own saved
   choices load. */
$("m-share-revoke").onclick = async () => {
  const m = mShare;
  // A link being made could land after the turn-off and be live unseen.
  if (m.busy) return;
  try {
    // Names the link on screen (the URL ends in its slug): if another tab
    // replaced it, the newer link is not turned off unseen.
    await api(`/api/transfers/${m.transferId}/share`, { slug: String(m.link).split("/r/").pop() }, "DELETE");
    if (mShare !== m) return;
    // No link is a known state, even after a confirmation that failed: the
    // composer is unlocked and Create link starts a new one. A read still in
    // flight answers the link just turned off, so its reply is dropped.
    m.revokes = (m.revokes || 0) + 1;
    m.link = null;
    m.expiresAt = null;
    m.published = null;
    m.loaded = true;
    clearErr("m-share-err");
    paintShare();
  } catch (e) {
    if (mShare !== m) return;
    if (e?.body?.code === "LINK_REPLACED") {
      // Show the link that is live; a failed read leaves the screen locked.
      m.loaded = false;
      await loadShare(m).catch(() => {});
      if (mShare !== m) return;
      paintShare();
    }
    showErr("m-share-err", e);
  }
};
