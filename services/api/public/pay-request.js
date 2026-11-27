const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const CHAINS = { 1: "Ethereum", 137: "Polygon", 100: "Gnosis", 8453: "Base", 84532: "Base Sepolia", 80002: "Polygon Amoy", 31337: "local chain" };
const chainName = (id) => CHAINS[id] || `chain ${id}`;
const eur = (n) => `€${Number(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const [, , handle, code] = location.pathname.split("/").map(decodeURIComponent);
const API = `/api/pay/${encodeURIComponent(handle)}/${encodeURIComponent(code)}`;
let req = null;
let amountEur = null; // for open-amount requests, what the payer typed
let tab = null;

function announce(msg) {
  const live = $("copy-live");
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 50);
}

function copyable() {
  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      const el = $(b.dataset.copy);
      const what = (b.getAttribute("aria-label") || "Copy").replace(/^Copy /, "");
      let ok = true;
      try { await navigator.clipboard.writeText(el.dataset.raw ?? el.textContent); } catch { ok = false; }
      // The visible swap is for the eye; the live region says the same thing
      // to a screen reader, which would not re-read a button's text.
      b.textContent = ok ? "Copied" : "Copy failed";
      announce(ok ? `${what} copied` : `Could not copy the ${what.toLowerCase()}. Select it and copy it by hand.`);
      clearTimeout(b._t);
      b._t = setTimeout(() => (b.textContent = "Copy"), ok ? 1200 : 2500);
    };
  });
}

const safeUrl = (u) => {
  if (typeof u !== "string" || u.trim() === "") return null;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch { return null; }
};

function render(p) {
  req = p;
  hide("loading"); show("req");
  const label = p.displayName || p.handle || "?";
  $("avatar").textContent = (label.trim()[0] || "?").toUpperCase();
  $("dn").textContent = label;
  $("hd").textContent = `@${p.handle}`;
  document.title = `Pay ${label} · Zold`;
  $("test").classList.toggle("hidden", !p.test);
  $("amt").textContent = p.amountEur !== undefined ? eur(p.amountEur) : (amountEur ? eur(amountEur) : "Any amount");
  $("desc").textContent = p.description || (p.merchantNote || "");
  if (p.description && p.merchantNote) $("desc").textContent = `${p.description} · ${p.merchantNote}`;

  const st = $("status");
  st.className = "status";
  const paid = p.paidEur || 0;
  // The status is a live region: only write it when the words change, or a
  // re-render (a tab switch) would announce "Awaiting payment" again.
  const setStatus = (t) => { if ($("status-text").textContent !== t) $("status-text").textContent = t; };
  if (p.state === "PAID") { st.classList.add("ok"); setStatus(`Paid ${eur(paid)}`); }
  else if (p.state === "EXPIRED") { st.classList.add("warn"); setStatus("Expired"); }
  else if (p.state === "CANCELLED") { st.classList.add("warn"); setStatus("Cancelled by the payee"); }
  else if (paid > 0 && p.outstandingEur > 0) { st.classList.add("warn", "live"); setStatus(`${eur(paid)} received · ${eur(p.outstandingEur)} outstanding`); }
  else if (paid > 0) { st.classList.add("ok"); setStatus(`${eur(paid)} received so far`); }
  else { st.classList.add("live"); setStatus("Awaiting payment"); }

  const open = p.state === "OPEN";
  $("open").classList.toggle("hidden", !open);
  $("paid").classList.toggle("hidden", !(p.payments || []).length);
  $("paylist").innerHTML = (p.payments || []).map((x) => `<div class="row">
      <span>${x.method === "crypto" ? `${p.methods?.crypto?.token?.symbol || "USDC"} ${x.amountUsdc ?? ""}` : "Bank transfer"} · ${new Date(x.at).toLocaleString()}</span>
      <b>${eur(x.amountEur)}${x.kind === "partial" ? " (partial)" : x.kind === "over" ? " (over)" : ""}</b></div>`).join("");
  // Same guard index.html applies to anchor links. Both of these come from
  // the merchant's store by way of Shopify, so "javascript:" in one is script
  // execution on a page a stranger opened to pay someone. The server now drops
  // a non-http(s) URL before storing it; this also covers rows stored before
  // that guard existed.
  // Opened from an invoice's Pay button (invoice.js remembers it for this tab): the way back to it.
  let from = [];
  try { from = JSON.parse(sessionStorage.getItem("zold-pay-from") || "[]"); } catch { /* none */ }
  // $("invoice-back") is missing from a cached pay-request.html.
  if (from[0] === location.pathname && /^\/invoice\/[\w-]+$/.test(from[1]) && $("invoice-back")) { $("invoice-back").href = from[1]; show("invoice-back"); }
  const back = safeUrl(p.returnUrl), off = safeUrl(p.cancelUrl);
  if (back && p.state === "PAID") { $("return").href = back; show("return"); } else hide("return");
  if (off && open) { $("cancel").href = off; show("cancel"); } else hide("cancel");
  if (!open) return;

  // Open-amount request with no amount yet: ask first.
  const needsAmount = p.amountEur === undefined && !amountEur;
  $("amount-ask").classList.toggle("hidden", !needsAmount);
  $("methods").classList.toggle("hidden", needsAmount);
  if (needsAmount) return;

  const tabs = [];
  if (p.methods.crypto) tabs.push(["crypto", `Crypto (${p.methods.crypto.token?.symbol || "USDC"})`]);
  if (p.methods.bank) tabs.push(["bank", "Bank transfer"], ["zold", "Zold account"]);
  if (!tab || !tabs.some(([id]) => id === tab)) tab = tabs[0]?.[0];
  $("tabs").innerHTML = tabs.map(([id, t]) => `<button class="tab${id === tab ? " on" : ""}" data-tab="${id}" aria-pressed="${id === tab}">${t}</button>`).join("");
  $("tabs").querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      render(req);
      // render() rebuilt the tab row; put focus back on the tab just chosen.
      $("tabs").querySelector(`[data-tab="${tab}"]`)?.focus();
    };
  });
  document.querySelectorAll(".pane").forEach((el) => el.classList.toggle("on", el.id === `pane-${tab}`));

  const c = p.methods.crypto;
  if (c) {
    $("qr").src = c.qrUrl;
    $("addr").textContent = c.address;
    $("tok").textContent = c.token.symbol;
    $("chain").textContent = chainName(c.chainId);
    if (c.amountUsdc !== undefined) {
      $("usdc").textContent = `${c.amountUsdc} ${c.token.symbol}`;
      $("usdc").dataset.raw = String(c.amountUsdc);
      $("open-wallet").href = c.uri;
      $("open-wallet").removeAttribute("aria-disabled");
      const until = new Date(c.validUntil);
      $("crypto-note").innerHTML = `Priced at <strong>${c.rate.toFixed(4)} USD/EUR</strong> (live mid) plus a <strong>${(c.allowanceBps / 100).toFixed(2)}%</strong> conversion allowance. This figure holds until ${until.toLocaleTimeString()}, then the page re-prices; any amount this page has shown still counts. The payee is credited what the conversion actually delivers.`;
    } else {
      $("usdc").textContent = "No live rate right now";
      delete $("usdc").dataset.raw;
      $("open-wallet").removeAttribute("href");
      $("open-wallet").setAttribute("aria-disabled", "true");
      $("crypto-note").textContent = "The EUR/USD rate feed is unavailable, so no crypto amount can be quoted. Pay by bank transfer, or try again shortly.";
    }
  }
  const b = p.methods.bank;
  if (b) {
    $("holder").textContent = b.holder;
    $("iban").textContent = b.iban.replace(/(.{4})/g, "$1 ").trim();
    $("iban").dataset.raw = b.iban;
    $("bic-row").classList.toggle("hidden", !b.bic);
    $("bic").textContent = b.bic || "";
    $("ref").textContent = b.reference;
    // The server refuses a QR it cannot encode whole; the fields below stand alone.
    $("sepa-qr").onerror = () => hide("sepa-qr-box");
    $("sepa-qr").onload = () => show("sepa-qr-box");
    $("sepa-qr").src = `/api/pay/${encodeURIComponent(p.handle)}/${encodeURIComponent(p.code)}/sepa-qr.svg`;
    const target = p.amountEur !== undefined ? p.outstandingEur : amountEur;
    $("bank-amt").textContent = target ? eur(target) : "Any amount";
    const u = new URL(b.appUrl);
    if (amountEur && p.amountEur === undefined) u.searchParams.set("amount", String(amountEur));
    $("zold-link").href = u.toString();
    show("zold-link");
  }
  copyable();
}

async function load() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw Object.assign(new Error("not found"), { status: res.status });
    render(await res.json());
  } catch (e) {
    // Only the server saying so means the link is wrong; a dropped
    // connection or an outage says nothing about it.
    hide("loading"); if (e?.status !== 404) {
      $("notfound").querySelector("h1").textContent = "Couldn’t load this page";
      $("notfound").querySelector("p").textContent = "Check your connection, then reload the page.";
    }
    show("notfound");
  }
}

$("amount-go").onclick = async () => {
  const go = $("amount-go");
  if (go.disabled) return; // a quote is already in flight
  hide("amount-err");
  const n = Number(($("amount-in").value || "").replace(",", "."));
  if (!(n > 0)) { $("amount-err").textContent = "Enter an amount."; show("amount-err"); return; }
  amountEur = Math.round(n * 100) / 100;
  if (req.methods.crypto) {
    go.disabled = true;
    try {
      const res = await fetch(`${API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountEur }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "could not quote");
      render(body);
    } catch (e) { $("amount-err").textContent = e.message; show("amount-err"); }
    finally { go.disabled = false; }
  } else render(req);
};

load();
// The page is the payer's receipt while they wait: re-read until the request
// leaves OPEN, and re-price the crypto amount when its window lapses.
setInterval(async () => {
  if (!req || req.state !== "OPEN") return;
  try {
    const res = await fetch(API);
    if (!res.ok) return;
    const p = await res.json();
    const changed = JSON.stringify(p.payments) !== JSON.stringify(req.payments) || p.state !== req.state
      || p.methods?.crypto?.amountUsdc !== req.methods?.crypto?.amountUsdc;
    if (changed) {
      if (amountEur && req.amountEur === undefined && req.methods.crypto) { return; } // keep the payer's own quote on screen
      render(p);
    }
  } catch { /* offline; try again next tick */ }
}, 5000);
