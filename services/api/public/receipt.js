/* The slug is the last path segment of /r/<slug>. It is the only credential
   this page has, so it is never echoed into the DOM — a receipt that printed
   its own link would put it into any screenshot of itself. */
const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
/* The glyphs are drawn for the eye; a screen reader hears "withheld" instead
   of five block characters. */
const BLOCK = '<span aria-hidden="true">&#9618;&#9618;&#9618;&#9618;&#9618;</span><span class="sr-only">withheld</span>';

function showState(h, p) {
  $("state").classList.remove("hidden");
  $("receipt").classList.add("hidden");
  $("state-h").textContent = h;
  $("state-p").textContent = p || "";
}

const CHECK = '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';
const CLOCK = '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>';

/** A name arrives in parts so the page — not the server — decides how a
 *  withheld half is drawn. `redact` names the missing half; there is no value
 *  in the payload for it to leak. */
function nameHtml(n) {
  if (!n || n.withheld) return `<span class="redact">${BLOCK}</span>`;
  const first = n.redact === "first" ? `<span class="redact">${BLOCK}</span>` : esc(n.first || "");
  const last = n.redact === "last" ? `<span class="redact">${BLOCK}</span>` : esc(n.last || "");
  return [first, last].filter(Boolean).join(" ");
}

function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* Time of day on its own, formatted directly rather than cut out of the
   string above — the separator between date and time is a locale detail. */
const TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
function timeOnly(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : TIME_FMT.format(d);
}

function render(r) {
  $("state").classList.add("hidden");
  $("receipt").classList.remove("hidden");

  $("amount").textContent = r.hero.amount;
  const tone = `tone-${r.status.tone}`;
  $("status-icon").className = tone;
  $("status-icon").innerHTML = r.status.settled ? CHECK : CLOCK;
  $("status-lab").className = `lab ${tone}`;
  $("status-lab").textContent = r.status.label;
  $("status-at").textContent = r.hero.at ? `· ${when(r.hero.at)}` : "";

  $("from").innerHTML = nameHtml(r.parties.from);
  $("to").innerHTML = nameHtml(r.parties.to);

  $("rows").innerHTML = (r.rows || []).map((row) => {
    const cls = ["v", row.mono ? "mono" : "", row.tone === "mint" ? "mint" : row.tone === "muted" ? "muted" : ""].join(" ");
    const v = row.withheld ? `<span class="redact">${BLOCK}</span>` : esc(row.value);
    return `<div class="row"><span class="k">${esc(row.key)}</span><span class="${cls}">${v}</span></div>`;
  }).join("");

  $("steps").innerHTML = (r.steps || []).map((s) => `
    <div class="step ${s.done ? "" : "todo"}">
      <div class="node"><div class="dot ${s.done ? "done" : ""}" aria-hidden="true"></div><div class="line" aria-hidden="true"></div></div>
      <div class="sbody">
        <span class="t">${esc(s.title)}<span class="sr-only"> (${s.done ? "done" : "pending"})</span></span>
        <span class="time">${s.time ? esc(timeOnly(s.time)) : ""}</span>
      </div>
    </div>`).join("");

  const route = r.route || [];
  $("nerds").classList.toggle("hidden", route.length === 0);
  $("hops").innerHTML = route.map((h, i) => {
    /* The Base mark only appears when the deployment really is on Base — the
       server sets `base`, the page never assumes it from the badge text. */
    const icon = h.base
      ? '<svg width="12" height="12" viewBox="0 0 639 639" aria-hidden="true"><path fill="#0052FF" d="M318.3,639c176.4,0,319.5-143,319.5-319.5C637.8,143.1,494.8,0,318.3,0C151,0,13.6,128.8,0,292.6h422.2v53.7H0C13.6,510.2,151,639,318.3,639L318.3,639z"/></svg>'
      : esc(String(i + 1).padStart(2, "0"));
    const ref = h.withheld
      ? `<div class="href redact"><span aria-hidden="true">&#9618;&#9618;&#9618;&#9618;&#9618;&#9618;&#9618;&#9618;&#9618;&#9618; · </span>withheld by sender</div>`
      : h.ref ? `<div class="href">${esc(h.ref)}</div>` : "";
    const sim = h.simulated ? '<span class="badge sim">simulated</span>' : "";
    return `<div class="hop">
      <div class="hicon"><div class="hbox">${icon}</div><div class="line"></div></div>
      <div class="hbody">
        <div class="htop"><span class="hrail">${esc(h.rail)}</span><span class="badge">${esc(h.badge)}</span>${sim}</div>
        <div class="hvia">${esc(h.via)}</div>
        ${ref}
      </div>
    </div>`;
  }).join("");

  $("withheld-note").classList.toggle("hidden", !r.anyWithheld);
}

$("disc").onclick = () => {
  const btn = $("disc");
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  $("hops").classList.toggle("hidden", open);
  $("disc-hint").textContent = open ? "show full route" : "hide route";
};

(async () => {
  if (!slug) return showState("No receipt here", "This link is missing its receipt code.");
  try {
    const res = await fetch(`/api/r/${encodeURIComponent(slug)}`, { headers: { accept: "application/json" } });
    if (res.ok) return render(await res.json());
    const body = await res.json().catch(() => ({}));
    /* Revoked and expired are distinguished on purpose: someone holding a real
       link that stopped working is owed the reason, and neither answer tells a
       scanner anything a bare 404 did not. */
    if (body.revoked) {
      return showState("This receipt was revoked", "The sender turned this link off. Ask them for a new one.");
    }
    if (body.expired) {
      return showState("This receipt has expired", "Receipt links stay live for 30 days. Ask the sender for a new one.");
    }
    if (res.status === 429) {
      return showState("Too many requests", "Give it a minute and reload the page.");
    }
    showState("Receipt not found", "This link is wrong, or the sender never shared it.");
  } catch {
    showState("Could not load this receipt", "Check your connection and reload the page.");
  }
})();
