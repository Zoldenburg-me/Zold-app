/**
 * Zold UI v2 components: small render functions that return markup, plus the
 * two behaviours markup cannot carry (sheet/dialog focus handling, copy).
 * The contract is design/ui-v2/SYSTEM.md; the classes live in ui.css.
 *
 * A classic script, loaded before app/core.js and before the business ES
 * modules, and it calls into nothing: both sides read it as `window.Z`.
 *
 * Escaping: every plain-text option is escaped here. Options named `lead`,
 * `right`, `body`, `html` or `rows` take markup, and the caller escapes
 * anything user-typed that goes into them (usually by building it with
 * another Z helper).
 */
(() => {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = (name, v) => (v === undefined || v === null || v === false ? "" : v === true ? ` ${name}` : ` ${name}="${esc(v)}"`);
  let seq = 0;
  const uid = (p) => `z-${p}-${++seq}`;

  const icon = (name, cls = "") => `<span class="z-ic${cls ? ` ${cls}` : ""}" aria-hidden="true">${esc(name)}</span>`;

  /* Status words (SYSTEM.md, "Status words") pick their own tone, so a caller
     cannot draw PAID in mint or IN FLIGHT as done. */
  const TONES = {
    "in flight": "pink", open: "pink", active: "pink",
    received: "mint", approved: "mint", on: "mint", done: "mint",
    "in review": "amber", "waiting for review": "amber", "needs fixing": "amber", overdue: "amber",
    failed: "amber", refunded: "amber", soon: "amber", beta: "amber", waiting: "amber",
    paid: "dim", draft: "dim", sent: "dim", void: "dim", off: "dim", illustration: "dim", recommended: "dim",
  };
  function tag(word, tone) {
    const t = tone || TONES[String(word).toLowerCase()] || "dim";
    return `<span class="z-tag${t === "dim" ? "" : ` z-tag--${t}`}">${esc(word)}</span>`;
  }

  /**
   * Button. variant: primary | secondary | quiet. One primary per screen.
 * `autofocus` marks the button an open sheet or dialog focuses first.
   * `href` renders a link styled as a button (navigation is <a>).
   * `disabledReason` keeps it focusable with aria-disabled and prints the
   * reason under it; the caller's click handler must still check
   * Z.isDisabled(el), because aria-disabled does not stop a click.
   */
  function button(o) {
    const cls = ["z-btn", `z-btn--${o.variant || "secondary"}`, o.full && "z-btn--full", o.className].filter(Boolean).join(" ");
    const inner = `${o.icon ? icon(o.icon) : ""}<span>${esc(o.label)}</span>`;
    const rid = o.disabledReason ? uid("reason") : null;
    const common = `class="${cls}"${attr("id", o.id)}${o.autofocus ? " data-z-autofocus" : ""}${rid ? ` aria-disabled="true" aria-describedby="${rid}"` : ""}`;
    const el = o.href && !rid
      ? `<a ${common} href="${esc(o.href)}">${inner}</a>`
      : `<button ${common} type="${o.type || "button"}"${attr("name", o.name)}${attr("value", o.value)}>${inner}</button>`;
    return rid ? `${el}<p class="z-reason" id="${rid}">${esc(o.disabledReason)}</p>` : el;
  }
  const isDisabled = (el) => el?.getAttribute("aria-disabled") === "true" || el?.getAttribute("aria-busy") === "true";
  /** Loading: a spinner before the label, the label kept, clicks refused. */
  function setLoading(el, on) {
    if (!el) return;
    if (on) el.setAttribute("aria-busy", "true"); else el.removeAttribute("aria-busy");
  }

  function iconButton(o) {
    const a = `class="z-iconbtn${o.className ? ` ${o.className}` : ""}"${attr("id", o.id)} aria-label="${esc(o.label)}"`;
    return o.href
      ? `<a ${a} href="${esc(o.href)}">${icon(o.icon)}</a>`
      : `<button ${a} type="button">${icon(o.icon)}</button>`;
  }

  /** Back is a link when there is a URL for "back", else a button the caller wires. */
  function backButton(back) {
    if (!back) return "";
    return iconButton({ icon: "arrow_back", label: back.label || "Back", href: back.href, id: back.id, className: "z-topbar__back" });
  }

  /** Top bar of a pushed screen. An empty title renders a hidden h1. */
  function topbar(o) {
    const h1 = o.title ? `<h1>${esc(o.title)}</h1>` : `<h1 class="z-sr">${esc(o.srTitle || "")}</h1>`;
    return `<header class="z-topbar">${backButton(o.back)}${h1}${o.right ? `<div class="z-topbar__right">${o.right}</div>` : ""}</header>`;
  }

  function largeTitle(o) {
    return `<h1 class="z-title">${esc(o.title)}</h1>${o.sub ? `<p class="z-sub">${esc(o.sub)}</p>` : ""}`;
  }

  /** Onboarding progress: back, "Step i of n · Label" (plus an optional tag), a bar of n segments. */
  function progress(o) {
    const segs = Array.from({ length: o.of }, (_, i) => `<span${i < o.step ? ' class="is-done"' : ""}></span>`).join("");
    return `<div class="z-progress"><div class="z-progress__head">${o.back ? iconButton({ icon: "arrow_back", label: "Back", href: o.back.href, id: o.back.id }) : ""}<span>Step ${o.step} of ${o.of}${o.label ? ` · ${esc(o.label)}` : ""}${o.tag ? ` ${o.tag}` : ""}</span></div>`
      + `<div class="z-progress__bar" role="progressbar" aria-label="${esc(o.barLabel || "Setup progress")}" aria-valuemin="0" aria-valuemax="${o.of}" aria-valuenow="${o.step}" aria-valuetext="Step ${o.step} of ${o.of}">${segs}</div></div>`;
  }

  /**
   * Text field. Label above, hint and error below, both tied to the input by
   * aria-describedby. Placeholders must end with "…" and never replace the label.
   */
  function field(o) {
    const id = o.id || uid("f");
    const hid = o.hint ? `${id}-hint` : null, eid = `${id}-err`;
    const described = [hid, o.error ? eid : null].filter(Boolean).join(" ");
    const email = o.type === "email";
    return `<div class="z-field"><label for="${id}">${esc(o.label)}${o.optional ? ' <span class="z-opt">(optional)</span>' : ""}</label>`
      + `<input class="z-input" id="${id}" name="${esc(o.name)}" type="${esc(o.type || "text")}" autocomplete="${esc(o.autocomplete || "off")}"`
      + `${attr("inputmode", o.inputmode)}${attr("placeholder", o.placeholder)}${attr("value", o.value)}${attr("maxlength", o.maxlength)}`
      + `${email || o.spellcheck === false ? ' spellcheck="false"' : ""}${o.required ? " required" : ""}`
      + `${o.error ? ' aria-invalid="true"' : ""}${described ? ` aria-describedby="${described}"` : ""}>`
      + `${o.hint ? `<p class="z-hint" id="${hid}">${esc(o.hint)}</p>` : ""}`
      + `<p class="z-err" id="${eid}"${o.error ? "" : " hidden"}>${esc(o.error || "")}</p></div>`;
  }

  function select(o) {
    const id = o.id || uid("s");
    const hid = o.hint ? `${id}-hint` : null, eid = `${id}-err`;
    const described = [hid, o.error ? eid : null].filter(Boolean).join(" ");
    const opts = (o.options || []).map((x) =>
      `<option value="${esc(x.value)}"${String(x.value) === String(o.value ?? "") ? " selected" : ""}${x.disabled ? " disabled" : ""}>${esc(x.label)}</option>`).join("");
    return `<div class="z-field"><label for="${id}">${esc(o.label)}${o.optional ? ' <span class="z-opt">(optional)</span>' : ""}</label>`
      + `<div class="z-select-wrap"><select class="z-select" id="${id}" name="${esc(o.name)}"${attr("autocomplete", o.autocomplete)}${o.required ? " required" : ""}`
      + `${o.error ? ' aria-invalid="true"' : ""}${described ? ` aria-describedby="${described}"` : ""}>${opts}</select>${icon("expand_more")}</div>`
      + `${o.hint ? `<p class="z-hint" id="${hid}">${esc(o.hint)}</p>` : ""}`
      + `<p class="z-err" id="${eid}"${o.error ? "" : " hidden"}>${esc(o.error || "")}</p></div>`;
  }

  /** Mark a field invalid (or clear it with an empty message). */
  function setFieldError(input, message) {
    if (!input) return;
    const err = document.getElementById(`${input.id}-err`);
    const ids = (input.getAttribute("aria-describedby") || "").split(" ").filter((x) => x && x !== `${input.id}-err`);
    if (message) {
      input.setAttribute("aria-invalid", "true");
      ids.push(`${input.id}-err`);
      if (err) { err.textContent = message; err.hidden = false; }
    } else {
      input.removeAttribute("aria-invalid");
      if (err) { err.textContent = ""; err.hidden = true; }
    }
    if (ids.length) input.setAttribute("aria-describedby", ids.join(" ")); else input.removeAttribute("aria-describedby");
  }
  /** Focus the first invalid field in a form. Returns true if there was one. */
  function focusFirstError(root) {
    const bad = root?.querySelector('[aria-invalid="true"]');
    if (bad) bad.focus();
    return !!bad;
  }

  /* ---- Lists ------------------------------------------------------- */

  /**
   * One list row. A `soon` row is not a link and not focusable, whatever
   * `href` says: a feature that is not built cannot be pressed. Link rows get
   * a chevron unless `chevron: false` (activity rows, as the reference draws them).
   */
  function row(o) {
    const soon = !!o.soon;
    const right = soon ? tag("Soon") : o.right || "";
    const body = `${o.lead || ""}<span class="z-row__main"><span class="z-row__title">${esc(o.title)}</span>`
      + `${o.sub ? `<span class="z-row__sub">${esc(o.sub)}</span>` : ""}</span>`
      + `${right ? `<span class="z-row__right">${right}</span>` : ""}`
      + `${o.href && !soon && o.chevron !== false ? icon("chevron_right", "z-row__chev") : ""}`;
    if (soon) return `<div class="z-row z-row--soon" aria-disabled="true">${body}</div>`;
    return o.href ? `<a class="z-row"${attr("id", o.id)} href="${esc(o.href)}">${body}</a>` : `<div class="z-row"${attr("id", o.id)}>${body}</div>`;
  }
  const soonRow = (o) => row({ ...o, soon: true });

  /**
   * A list group: optional eyebrow and action link, then the rows in a card.
   * No rows and an `empty` message: one row with the sentence and one action.
   */
  function listGroup(o) {
    const head = o.label || o.action
      ? `<div class="z-group__head">${o.label ? `<h2 class="z-eyebrow"${attr("id", o.labelId)}>${esc(o.label)}</h2>` : "<span></span>"}`
        + `${o.action ? `<a class="z-group__action" href="${esc(o.action.href)}">${esc(o.action.label)}</a>` : ""}</div>`
      : "";
    const rows = o.rows && o.rows.length
      ? o.rows
      : o.empty
        ? [`<div class="z-row z-row--empty"><span>${esc(o.empty.text)}</span>${o.empty.action ? `<a href="${esc(o.empty.action.href)}">${esc(o.empty.action.label)}</a>` : ""}</div>`]
        : [];
    return `<section class="z-group">${head}<ul class="z-list z-card">${rows.map((r) => `<li>${r}</li>`).join("")}</ul></section>`;
  }

  /** Skeleton rows in the list-row shape. Never a blank screen while loading. */
  function skeletonRows(n = 3, label = "Loading…") {
    const one = `<div class="z-row z-row--skel" aria-hidden="true"><span class="z-skel z-skel--block"></span><span class="z-row__main"><span class="z-skel z-skel--line" style="width:55%"></span><span class="z-skel z-skel--line" style="width:35%"></span></span></div>`;
    return `<ul class="z-list z-card" aria-busy="true">${Array.from({ length: n }, () => `<li>${one}</li>`).join("")}</ul><span class="z-sr" role="status">${esc(label)}</span>`;
  }

  /* ---- Small pieces ------------------------------------------------ */

  /** Initials from a name; the name itself sits next to the avatar, so it is aria-hidden. */
  function avatar(o) {
    const initials = o.initials || String(o.name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return `<span class="z-avatar${o.tone && o.tone !== "n" ? ` z-avatar--${o.tone}` : ""}" aria-hidden="true">${esc(initials || "?")}</span>`;
  }
  const iconTile = (o) => `<span class="z-tile${o.tone && o.tone !== "n" ? ` z-tile--${o.tone}` : ""}" aria-hidden="true">${icon(o.icon)}</span>`;

  /**
   * An amount. `value` is a number of units (euros, USDC), never a string from
   * a quote. Money in is mint with "+", money out has a real minus sign.
   * Formatting goes through Intl, not string templates.
   */
  function formatMoney(value, currency = "EUR") {
    const n = Math.abs(Number(value));
    if (!Number.isFinite(n)) return "";
    if (currency === "EUR") return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
    return `${new Intl.NumberFormat("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${currency}`;
  }
  function amount(o) {
    const sign = o.direction === "in" ? "+" : o.direction === "out" ? "−" : "";
    return `<span class="z-amount${o.direction === "in" ? " z-amount--in" : ""}">${sign}${esc(formatMoney(o.value, o.currency))}</span>`;
  }

  /** Note. tone: n (neutral), a (amber, warnings), p (pink). */
  function note(o) {
    const text = o.html !== undefined ? o.html : esc(o.text);
    return `<div class="z-note${o.tone && o.tone !== "n" ? ` z-note--${o.tone}` : ""}"${o.role ? ` role="${esc(o.role)}"` : ""}>${icon(o.icon || (o.tone === "a" ? "error" : "info"))}<p>${text}</p></div>`;
  }

  /** Key-value table for review, result and detail screens. `value` is text; `valueHtml` is markup. */
  function kv(rows) {
    return `<dl class="z-kv z-card">${rows.map((r) =>
      `<div${r.strong ? ' class="is-strong"' : ""}><dt>${esc(r.key)}${r.hint ? `<small>${esc(r.hint)}</small>` : ""}</dt>`
      + `<dd class="z-fig${r.mono ? " z-mono" : ""}">${r.valueHtml !== undefined ? r.valueHtml : r.value == null || r.value === "" ? '<span class="z-hint">Not set</span>' : esc(r.value)}</dd></div>`).join("")}</dl>`;
  }

  /** IBANs group by four, as the reference and every bank statement do. */
  const groupIban = (s) => String(s || "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

  /** A label over a value with a 44px copy button. The value is what gets copied. */
  function copyRow(o) {
    return `<div class="z-copy"><span class="z-copy__main"><span class="z-copy__label">${esc(o.label)}</span>`
      + `<span class="z-copy__value${o.mono ? " z-mono" : ""}" translate="no">${esc(o.display ?? o.value)}</span></span>`
      + `<button class="z-iconbtn" type="button" data-z-copy="${esc(o.value)}" aria-label="Copy ${esc(o.label)}">${icon("content_copy")}</button></div>`;
  }

  /** Shown on every screen while /api/health says capabilities.sandbox. */
  const testModePill = (sandbox) =>
    sandbox ? `<div class="z-testmode" role="status"><span>${icon("science")}Test mode, no real money</span></div>` : "";

  /** Bottom nav, phone tab roots only (hidden from 1024px by ui.css). */
  function bottomNav(o) {
    return `<nav class="z-bnav" aria-label="Main">${o.items.map((it) =>
      `<a href="${esc(it.href)}"${it.id === o.active ? ' aria-current="page"' : ""}>${icon(it.icon)}<span>${esc(it.label)}</span>`
      + `${it.badge ? `<span class="z-bnav__badge"><span class="z-sr">, </span>${esc(it.badge)}<span class="z-sr"> waiting</span></span>` : ""}</a>`).join("")}</nav>`;
  }

  const skipLink = (target = "main") => `<a class="z-skip" href="#${esc(target)}">Skip to content</a>`;

  /* ---- Sheet and dialog -------------------------------------------- */

  /**
   * Markup for a sheet (bottom on phones, a right drawer from 1024px) or a
   * centred dialog. Starts hidden; open it with Z.openOverlay(id, trigger).
   */
  function overlay(o) {
    const hid = `${o.id}-title`;
    const kind = o.kind === "dialog" ? "dialog" : "sheet";
    return `<div class="z-scrim${kind === "dialog" ? " z-scrim--dialog" : ""}" id="${esc(o.id)}" hidden>`
      + `<div class="z-${kind}" role="dialog" aria-modal="true" aria-labelledby="${hid}">`
      + `${kind === "sheet" ? '<div class="z-sheet__grab" aria-hidden="true"></div>' : ""}`
      + `<div class="z-overlay__head"><h2 id="${hid}">${esc(o.title)}</h2>${iconButton({ icon: "close", label: "Close", className: "z-overlay__close" })}</div>`
      + `${o.body || ""}</div></div>`;
  }

  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const open = [];   // stack: { scrim, trigger, inerted }

  function openOverlay(id, trigger) {
    const scrim = typeof id === "string" ? document.getElementById(id) : id;
    if (!scrim || !scrim.hidden) return;
    if (scrim.parentElement !== document.body) document.body.appendChild(scrim);
    // Everything else on the page goes inert: no focus, no clicks, no reading.
    const inerted = [...document.body.children].filter((el) => el !== scrim && !el.inert && el.tagName !== "SCRIPT");
    inerted.forEach((el) => { el.inert = true; });
    open.push({ scrim, trigger: trigger || document.activeElement, inerted });
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add("is-open"));
    const panel = scrim.firstElementChild;
    // A destructive dialog marks its safe action with `autofocus`, so Enter does no harm.
    const first = panel.querySelector("[data-z-autofocus]") || [...panel.querySelectorAll(FOCUSABLE)].find((el) => !el.classList.contains("z-overlay__close")) || panel.querySelector(FOCUSABLE);
    (first || panel).focus();
  }

  function closeOverlay(id) {
    const i = id ? open.findIndex((x) => x.scrim.id === id || x.scrim === id) : open.length - 1;
    if (i < 0) return;
    const [{ scrim, trigger, inerted }] = open.splice(i, 1);
    scrim.classList.remove("is-open");
    // Reopened during the close transition: leave it shown.
    const done = () => { if (!scrim.classList.contains("is-open")) scrim.hidden = true; };
    if (reduceMotion()) done(); else setTimeout(done, 200);
    inerted.forEach((el) => { el.inert = false; });
    if (trigger && document.contains(trigger)) trigger.focus();
  }

  /* ---- Wiring (listeners only; nothing runs at load) ----------------- */

  let live = null;
  /** One polite live region, created on first use and filled a tick later so it is read. */
  function announce(msg) {
    if (!live) {
      live = document.createElement("div");
      live.className = "z-sr"; live.setAttribute("aria-live", "polite");
      document.body.appendChild(live);
    }
    live.textContent = "";
    setTimeout(() => { live.textContent = msg; }, 50);
  }

  document.addEventListener("click", async (e) => {
    const close = e.target.closest(".z-overlay__close");
    if (close) { closeOverlay(close.closest(".z-scrim").id); return; }
    const top = open[open.length - 1];
    if (top && e.target === top.scrim) { closeOverlay(top.scrim.id); return; }
    const copy = e.target.closest("[data-z-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.zCopy);
      } catch {
        announce("Could not copy. Select the text and copy it yourself.");
        return;
      }
      const ic = copy.querySelector(".z-ic");
      copy.classList.add("is-done"); if (ic) ic.textContent = "check";
      announce("Copied");
      setTimeout(() => { copy.classList.remove("is-done"); if (ic) ic.textContent = "content_copy"; }, 1500);
    }
    // aria-disabled does not stop a click: stop it here, before any handler on the element.
    const dis = e.target.closest('.z-btn[aria-disabled="true"], .z-btn[aria-busy="true"]');
    if (dis) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  document.addEventListener("keydown", (e) => {
    const top = open[open.length - 1];
    if (!top) return;
    if (e.key === "Escape") { e.preventDefault(); closeOverlay(top.scrim.id); return; }
    if (e.key !== "Tab") return;
    const items = [...top.scrim.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  window.Z = Object.freeze({
    esc, icon, tag, button, isDisabled, setLoading, iconButton, topbar, largeTitle, progress,
    field, select, setFieldError, focusFirstError,
    row, soonRow, listGroup, skeletonRows, avatar, iconTile, formatMoney, amount, note, kv, groupIban, copyRow,
    testModePill, bottomNav, skipLink, overlay, openOverlay, closeOverlay, announce,
  });
})();
