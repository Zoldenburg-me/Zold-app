const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
/* The payee comes from our own API, but it is rendered into the DOM as text
   rather than markup regardless — a display name is free text somebody chose. */
const CHAINS = { 1: "Ethereum", 137: "Polygon", 100: "Gnosis", 8453: "Base", 84532: "Base Sepolia", 80002: "Polygon Amoy", 31337: "local chain" };

function chainName(id) { return CHAINS[id] || `chain ${id}`; }

/* A smallest-unit amount as a decimal, without floating point. */
function units(raw, decimals) {
  const v = BigInt(raw), d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / d}${frac ? `.${frac}` : ""}`;
}

/* EIP-681, built here so the button reflects whatever the API returned rather
   than a second copy of the token address baked into the page. */
function paymentUri(p) {
  return `ethereum:${p.token.address}@${p.chainId}/transfer?address=${p.address}`;
}

/* An organisation's page: the company's euro account, bank transfer only.
   No QR or address, because no wallet address belongs to the company. */
function showBank(bank) {
  hide("crypto-pane");
  show("bank-pane");
  const say = (msg) => { $("bank-live").textContent = ""; setTimeout(() => { $("bank-live").textContent = msg; }, 50); };
  const group = (iban) => iban.replace(/(.{4})/g, "$1 ").trim();
  // A holder name Monerium did not report is the one the company typed: the
  // payer's bank may not match it, so the label says it is unverified.
  const holderNote = bank.holderVerified === false ? "As the company entered it, not verified by Monerium" : "";
  const rows = [["ACCOUNT HOLDER", bank.holder, bank.holder, false, holderNote], ["IBAN", group(bank.iban), bank.iban, true]];
  if (bank.bic) rows.push(["BIC", bank.bic, bank.bic, true]);
  $("bank").replaceChildren(...rows.map(([label, shown, value, mono, note]) => {
    const li = document.createElement("li");
    const f = document.createElement("div");
    f.className = "f";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = mono ? "v mono" : "v";
    v.textContent = shown;
    f.append(k, v);
    if (note) {
      const n = document.createElement("span");
      n.className = "k";
      n.textContent = note;
      f.append(n);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Copy";
    b.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    let t;
    b.onclick = async () => {
      clearTimeout(t);
      try {
        await navigator.clipboard.writeText(value);
        b.textContent = "Copied";
        say(`${label.toLowerCase()} copied`);
      } catch {
        b.textContent = "Select it";
        say("Could not copy. Select the text and copy it by hand.");
      }
      t = setTimeout(() => (b.textContent = "Copy"), 1400);
    };
    li.append(f, b);
    return li;
  }));
}

async function load() {
  const handle = decodeURIComponent(location.pathname.replace(/^\/pay\//, "")).trim();
  try {
    const res = await fetch(`/api/pay/${encodeURIComponent(handle)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || "not found"), { status: res.status, body });
    }
    const p = await res.json();
    hide("loading");
    show("payee");
    $("card").setAttribute("aria-busy", "false");

    const label = p.displayName || p.handle || "?";
    $("avatar").textContent = (label.trim()[0] || "?").toUpperCase();
    $("dn").textContent = label;
    $("hd").textContent = `@${p.handle}`;
    document.title = `Pay ${label} · Zold`;

    if (p.kind === "organisation") return showBank(p.bank);
    $("addr").textContent = p.address;
    $("qr").src = `/api/pay/${encodeURIComponent(p.handle)}/qr.svg`;
    // What the forwarder's routes accept, as the API read them. A page from
    // before the list existed falls back to the one token it always took.
    const accepts = Array.isArray(p.supportedTokens) && p.supportedTokens.length
      ? p.supportedTokens
      : [{ chainId: p.chainId, symbol: p.token.symbol, decimals: p.token.decimals }];
    $("accepts").replaceChildren(...accepts.map((t) => {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = `${t.symbol} on ${t.chainName || chainName(t.chainId)}`;
      li.append(name);
      const bits = [];
      if (t.minAmount) bits.push(`at least ${units(t.minAmount, t.decimals)} ${t.symbol}`);
      if (typeof t.feeBps === "number" && t.feeBps > 0) bits.push(`${(t.feeBps / 100).toFixed(2)}% bridge fee`);
      if (bits.length) {
        const sub = document.createElement("span");
        sub.textContent = bits.join(" · ");
        li.append(sub);
      }
      return li;
    }));
    if (accepts.length === 1) {
      $("accepts-lbl").textContent = "SEND ONLY";
      $("note-send").textContent = `Send only ${accepts[0].symbol} on ${accepts[0].chainName || chainName(accepts[0].chainId)}.`;
    }
    // Kept as sent: nothing to tell the payer about where it settles.
    // "?." and "manual": a cached pay.html has no such span.
    $("note-settle")?.toggleAttribute("hidden", !p.autoConvert);
    $("note-settlement").textContent = p.autoConvert
      ? (p.settlementAsset === "USDC" ? p.token.symbol : "EUR(e)")
      : "manual";

    // The visible swap is for the eye; the live region says it to a screen
    // reader, which would not re-read the button's text on its own.
    const say = (msg) => { $("copy-live").textContent = ""; setTimeout(() => { $("copy-live").textContent = msg; }, 50); };
    let copyTimer;
    $("copy").onclick = async () => {
      clearTimeout(copyTimer);
      try {
        await navigator.clipboard.writeText(p.address);
        $("copy").textContent = "Copied";
        say("Address copied");
        copyTimer = setTimeout(() => ($("copy").textContent = "Copy address"), 1400);
      } catch {
        // Clipboard refused; the address is on screen to select by hand.
        $("copy").textContent = "Could not copy — select the address above";
        say("Could not copy. Select the address and copy it by hand.");
        copyTimer = setTimeout(() => ($("copy").textContent = "Copy address"), 3000);
      }
    };
    $("open").href = paymentUri(p);
  } catch (e) {
    // Only the server saying so means the link is wrong; a dropped
    // connection or an outage says nothing about it.
    hide("loading");
    if (e?.body?.code === "PAGE_UNAVAILABLE") {
      $("notfound").querySelector("h1").textContent = "Not taking payments right now";
      $("notfound").querySelector("p").textContent = e.body.error;
    } else if (e?.status !== 404) {
      $("notfound").querySelector("h1").textContent = "Couldn’t load this page";
      $("notfound").querySelector("p").textContent = "Check your connection, then reload the page.";
    }
    show("notfound");
    $("card").setAttribute("aria-busy", "false");
  }
}
load();
