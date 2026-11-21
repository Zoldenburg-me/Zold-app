const $ = (s) => document.querySelector(s);
const TOKEN = decodeURIComponent(location.pathname.split("/")[2] || "");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));
let run = 0, state = { pending: null };
let PAYER = "", PAYER_FIRST = "", CHAIN = null;

const fmt = (n) => n.toFixed(2);
function parseAmount(s) {
  const t = s.replace(/[€\s]/g, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}
function ibanOk(s) {
  const t = s.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(t)) return null;
  const digits = (t.slice(4) + t.slice(0, 4)).replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55);
  let r = 0;
  for (const d of digits) r = (r * 10 + Number(d)) % 97;
  return r === 1 ? t : null;
}
const maskIban = (i) => `${i.slice(0, 4)} •••• ${i.slice(-4)}`;
const maskAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Same-origin credentials: behind Cloudflare Access (app.zoldhq.com) a request
// without its cookie is redirected to the Access login and fails as "offline".
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}), referrerPolicy: "no-referrer" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "Something went wrong. Try again."); e.status = res.status; e.body = data; throw e; }
  return data;
}

/* Sound and vibration: Narwhal.sfx (narwhal/narwhal.js), silent until the first tap or key press. */
Narwhal.sound.start("zold-send-sound");
const { sfx, buzz } = Narwhal;

/* ---------- the narwhal's body language ---------- */
$("#host").insertAdjacentHTML("afterbegin", Narwhal.html({ state: "away", id: "nw" }));
const nw = $("#nw");
const react = (kind, ms) => Narwhal.react(nw, kind, ms);
/* Quiet for a while: a small lap, until the receipt is up. */
const idle = () => Narwhal.idle(nw, () => !document.getElementById("finale"));

async function say(text, tip) {
  const my = ++run, el = $("#say-text");
  $("#say").classList.remove("is-hidden");
  react("nod", 500);
  if (!(await Narwhal.type(el, text, { alive: () => my === run }))) return;
  if (tip) { const t = document.createElement("span"); t.className = "nw-say__tip"; t.textContent = tip; el.append(t); }
}

/* An answer rises from the chat box in a bubble and pops where it belongs. */
const floatUp = (text, target) => Narwhal.floatUp(text, $("#composer"), target);
/* The burst before the receipt. */
const burst = (ms) => Narwhal.burst($("#app"), ms);

/* ---------- questions ---------- */
function ask({ label, placeholder = "", mode = "text", autocomplete = "off" }) {
  $("#choices").hidden = true;
  $("#composer").hidden = false;
  const input = $("#answer");
  // Asked again after a refusal: keep what they typed and why it was refused, so they can fix it.
  const again = state.refused;
  state.refused = false;
  if (!again) { input.value = ""; $("#err").textContent = ""; }
  input.placeholder = placeholder; input.setAttribute("aria-label", label);
  input.inputMode = mode; input.autocomplete = autocomplete;
  $("#send").disabled = false;
  $("#dock").classList.add("on");
  setTimeout(() => input.focus({ preventScroll: true }), REDUCED ? 0 : 350);
  idle();
  return new Promise((resolve) => (state.pending = resolve));
}
function choose(options) {
  $("#composer").hidden = true;
  $("#err").textContent = "";
  const box = $("#choices");
  box.innerHTML = "";
  options.forEach((o, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "choice"; b.style.animationDelay = `${i * 80}ms`;
    b.innerHTML = `${esc(o.label)}<span>${esc(o.sub)}</span>`;
    b.onclick = () => state.pending(o.id);
    b.onmouseenter = () => Narwhal.look(nw, true);
    b.onmouseleave = () => Narwhal.look(nw, false);
    box.append(b);
  });
  box.hidden = false;
  $("#dock").classList.add("on");
  idle();
  return new Promise((resolve) => (state.pending = resolve));
}
function refuse(msg) {
  state.refused = true;
  $("#err").textContent = msg;
  react("sad", 1400);
  sfx.bad();
  const c = $("#composer"); c.classList.remove("shake"); void c.offsetWidth; c.classList.add("shake");
}
function fact(html) { const f = document.createElement("span"); f.className = "fact"; f.innerHTML = html; $("#facts").append(f); }
function countUp(to) {
  const el = $("#amount"); el.classList.remove("empty");
  const t0 = performance.now(), dur = REDUCED ? 1 : 700;
  let ticks = 0;
  (function tick(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    if (k < 1 && k * 10 >= ticks) sfx.tick(ticks++);
    el.innerHTML = `<small>€</small>${fmt(to * e)}`;
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}
async function until(prompt, check) {
  for (;;) {
    const v = (await prompt()).trim();
    const out = check(v);
    if (out.ok) return out.value;
    refuse(out.msg);
  }
}

/* ---------- the conversation ---------- */
// The limit is never sent to this page (it would read as the amount to ask for); the server refuses above it.
async function askAmount() {
  const n = await until(() => ask({ label: "Amount in euro", placeholder: "e.g. 11.45", mode: "decimal" }), (v) => {
    const n = parseAmount(v);
    if (n === null) return { msg: "Type an amount like 11.45." };
    if (n <= 0) return { msg: "The amount has to be more than €0." };
    return { ok: true, value: n };
  });
  react("spin", 1000);
  countUp(n);
  return n;
}

async function flow(link) {
  await Narwhal.swimIn(nw);
  react("happy");
  await Narwhal.spout(nw);
  await say(`Hey! ${PAYER_FIRST} wants to send you money.`, link.note ? `${PAYER_FIRST}’s note: “${link.note}”` : undefined);
  await sleep(link.note ? 1600 : 900);
  await say("How much should it be?");
  let amount = await askAmount();
  await sleep(500);

  await say("Nice. What was it for?");
  const forWhat = await until(() => ask({ label: "What it was for", placeholder: "e.g. Dinner at Lotti" }), (v) =>
    !v ? { msg: "Say in a few words what it was for." } : v.length > 80 ? { msg: "Keep it under 80 characters." } : { ok: true, value: v });
  react("happy");
  await floatUp(forWhat, $("#facts"));
  fact(`For <b>${esc(forWhat)}</b>`);
  await sleep(300);

  const options = [];
  if (CHAIN) options.push({ id: "wallet", label: "Crypto wallet", sub: `Arrives in seconds · EURe on ${CHAIN.name}` });
  options.push({ id: "iban", label: "Bank account", sub: "IBAN · SEPA transfer" });
  await say("How do you want to receive it?", CHAIN ? "Tip: a crypto wallet gets the money in seconds. A bank account (IBAN) goes by SEPA transfer." : undefined);
  const method = options.length > 1 ? await choose(options) : "iban";
  Narwhal.look(nw, false);
  react("happy");

  let payTo, show, kind, name;
  if (method === "wallet") {
    await say("Paste your wallet address.", `It has to be an address on ${CHAIN.name}. The money arrives as EURe.`);
    const a = await until(() => ask({ label: "Wallet address", placeholder: "0x…" }), (v) =>
      /^0x[0-9a-fA-F]{40}$/.test(v) ? { ok: true, value: v } : { msg: "A wallet address starts with 0x and has 40 more characters." });
    payTo = { kind: "wallet", chainId: CHAIN.chainId, address: a };
    kind = `Wallet on ${CHAIN.name}`; show = maskAddr(a);
    react("happy");
    await say(`And your name, so ${PAYER_FIRST} knows who it’s for?`, `${PAYER_FIRST} sees what you enter here, and Zold keeps it with this request.`);
  } else {
    await say("What’s your IBAN?");
    const i = await until(() => ask({ label: "IBAN", placeholder: "DE89 3704 0044 0532 0130 00" }), (v) => {
      const ok = ibanOk(v);
      return ok ? { ok: true, value: ok } : { msg: "That IBAN doesn’t check out. Look for a missing or swapped digit." };
    });
    payTo = { kind: "bank", bank: { iban: i } };
    kind = "Bank account"; show = maskIban(i);
    react("happy");
    await say("And the name on that account?", `${PAYER_FIRST} sees what you enter here, and Zold keeps it with this request.`);
  }
  name = await until(() => ask({ label: method === "iban" ? "Account holder name" : "Your name", placeholder: "Bob Example", autocomplete: "name" }), (v) =>
    v.length >= 2 && v.length <= 70 ? { ok: true, value: v } : { msg: method === "iban" ? "Type the name as your bank shows it." : "Type your name, 2 to 70 characters." });

  react("happy");
  await floatUp(show, $("#facts"));
  fact(`To <b>${esc(show)}</b>`);

  // The server is the judge: the limit (only it knows it), the IBAN and the wallet.
  let done;
  for (;;) {
    $("#send").disabled = true;
    try {
      done = await api("POST", `/api/invoice-links/${encodeURIComponent(TOKEN)}/submit`, { amount: fmt(amount), forWhat, name, payTo });
      break;
    } catch (e) {
      if (e.status === 409) { $("#dock").classList.remove("on"); await say("This link was already filled in."); await printReceipt(e.body.invoice, { animate: false }); return; }
      if (e.body?.code === "OVER_LIMIT") {
        react("sad", 1400); sfx.bad();
        await say(e.message, "Type a smaller amount and it goes again.");
        amount = await askAmount();
        continue;
      }
      if (e.status === 429) { $("#dock").classList.remove("on"); react("sad", 1400); sfx.bad(); await say(e.message); return; }
      // Answers the server refused, or a dropped connection: say so and let them send again.
      refuse(e.message);
      await say("That didn’t go through.", `${e.message} Press the arrow to try again, or reload to start over.`);
      await ask({ label: "Press the arrow to try again", placeholder: "Press the arrow to try again" });
    }
  }
  // Sent: nothing below may say it failed.
  $("#dock").classList.remove("on");
  Narwhal.still(nw);
  await say(`That’s everything! ${PAYER_FIRST} can see it now.`);
  react("spin", 1000);
  await burst(1400);
  await printReceipt(done.invoice, { animate: true });
}

/* The narwhal swims to the printer, taps it, and the receipt feeds out. */
async function printReceipt(inv, { animate }) {
  if (!inv) return;
  const line = inv.lines?.[0];
  const to = inv.payTo?.kind === "wallet"
    ? { kind: "Wallet", show: maskAddr(inv.payTo.address || "") }
    : { kind: "Bank account", show: inv.payTo?.bank?.iban ? maskIban(inv.payTo.bank.iban) : "" };
  const when = new Date(inv.submittedAt || Date.now()).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const waiting = inv.state === "SUBMITTED";
  const paying = inv.state === "PAYING";
  const paid = inv.state === "PAID" || inv.state === "RECONCILED";
  const f = document.createElement("div");
  f.className = "finale"; f.id = "finale";
  f.innerHTML = `
    ${Narwhal.printerHtml()}
    <div class="nw-feed"><div class="nw-paper" id="paper">
      <div class="nw-paper__c nw-paper__logo">Zold</div>
      <div class="nw-paper__c">PAYMENT REQUEST</div>
      <div class="nw-paper__c">${esc(when)} · ${esc(inv.supplier?.invoiceNumber || "")}</div>
      <div class="nw-paper__hr"></div>
      <div class="nw-paper__kv"><span>FROM</span><span>${esc(PAYER)}</span></div>
      <div class="nw-paper__kv"><span>FOR</span><span>${esc(line?.description || "")}</span></div>
      <div class="nw-paper__kv"><span>TO</span><span>${esc(inv.supplier?.orgName || "")}</span></div>
      <div class="nw-paper__kv"><span>${esc(to.kind.toUpperCase())}</span><span>${esc(to.show)}</span></div>
      <div class="nw-paper__hr"></div>
      <div class="nw-paper__kv nw-paper__big"><span>AMOUNT</span><span>€${esc(inv.total)}</span></div>
      <div class="nw-paper__hr"></div>
      <div class="nw-paper__c">${paid ? "PAID" : paying ? "ON ITS WAY" : waiting ? `WAITING FOR ${esc(PAYER_FIRST.toUpperCase())}` : esc(inv.state)}</div>
      ${waiting ? `<div class="nw-paper__c">No money has moved yet.</div>` : ""}
    </div></div>
    <p class="after" id="after">${paid ? `${esc(PAYER_FIRST)} has paid this.` : paying ? `${esc(PAYER_FIRST)} has started this payment. You’ll see the money once it arrives.` : `${esc(PAYER_FIRST)} approves it in Zold with biometrics. You’ll see the money once it’s sent.`}</p>`;
  $("#app").append(f);
  $("#say").classList.add("is-hidden");
  if (animate) await Narwhal.print(nw, f.querySelector(".nw-printer"), $("#paper"));
  else $("#paper").classList.add("is-shown");
  $("#after").classList.add("on");
}

/* ---------- wiring ---------- */
const input = $("#answer");
Narwhal.watch(nw, input, () => {
  idle();
  if ($("#err").textContent) $("#err").textContent = "";
});
$("#dock").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.pending && !$("#composer").hidden && !$("#send").disabled) state.pending(input.value);
});
const soundBtn = $("#sound");
const drawSound = () => { const on = Narwhal.sound.on; soundBtn.setAttribute("aria-pressed", String(on)); soundBtn.textContent = on ? "Sound on" : "Sound off"; };
drawSound();
soundBtn.onclick = () => { Narwhal.sound.on = !Narwhal.sound.on; drawSound(); };

(async () => {
  let r;
  try {
    r = await api("GET", `/api/invoice-links/${encodeURIComponent(TOKEN)}`);
  } catch (e) {
    await Narwhal.swimIn(nw);
    react("sad", 1400);
    await say(e.status === 404 ? "This link doesn’t work." : "I couldn’t open this link just now.",
      e.status === 404 ? "Ask the person who sent it for a new one." : `${e.message} Reload the page to try again.`);
    return;
  }
  const inv = r.invoice;
  if (!inv.sendLink) { location.replace(`/invoice/${encodeURIComponent(TOKEN)}`); return; }
  PAYER = inv.payor?.name || "Someone";
  PAYER_FIRST = PAYER.split(/\s+/)[0];
  CHAIN = (r.payoutChains || [])[0] || null;
  document.title = `${PAYER_FIRST} wants to pay you · Zold`;
  if (inv.state !== "LINK_CREATED") {
    await Narwhal.swimIn(nw);
    await say("This link was already filled in.");
    await printReceipt(inv, { animate: false });
    return;
  }
  await flow(inv.sendLink);
})().catch(async (e) => {
  console.error(e);
  $("#dock").classList.remove("on");
  await say("Something went wrong on this page.", "Reload it to try again. If you already sent your details, the link says so.");
});
