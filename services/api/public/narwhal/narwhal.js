/*
 * The animated Zold narwhal, for any page: the drawing, its moods, typing what
 * it says, blowhole puffs, an answer floating up, the bubble burst, the receipt
 * printer it taps, and the synthesized sound and vibration that go with them.
 * Styles: narwhal.css.
 *
 * A classic script: it declares one global, Narwhal, and does nothing until a
 * page calls it. Decoration only: Narwhal.html() is aria-hidden, and with
 * prefers-reduced-motion every effect is skipped or ends at once.
 *
 * Sound stays off until a page calls Narwhal.sound.start(storageKey), and even
 * then browsers keep it silent until the first tap or key press.
 */
const Narwhal = (() => {
  const reduced = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));

  /* ---------- the drawing ---------- */
  let clips = 0;
  // Each copy gets its own clipPath id: two on one page must not share one.
  function svg() {
    const clip = `nw-tusk-${++clips}`;
    return `<svg viewBox="-10 -60 410 380" focusable="false">
  <defs><clipPath id="${clip}"><path d="M150 105L80-45 167 98Z"/></clipPath></defs>
  <path d="M150 105L80-45 167 98Z" fill="#f6f2e8"/>
  <g clip-path="url(#${clip})" stroke="#8c8578" stroke-width="2.5" stroke-linecap="round"><path d="M139 89L156 72M131 74L148 57M123 60L140 43M115 45L132 28M108 30L125 14M100 16L117-1M92 1L109-15"/></g>
  <g stroke="#141217" stroke-width="4.5" stroke-linejoin="round">
    <path d="M150 105L80-45 167 98Z" fill="none" stroke-width="4" stroke-linejoin="miter" stroke-miterlimit="12"/>
    <path class="nw__tail" d="M310 180C345 160 380 145 390 160 395 168 385 185 365 190 388 202 392 220 382 228 370 235 340 215 305 200Z" fill="#f4f4f6"/>
    <path d="M85 175C85 110 140 90 220 90 295 90 330 135 330 195 330 255 270 275 195 275 115 275 85 240 85 175Z" fill="#faf9f6"/>
    <path d="M150 220C140 250 120 262 105 255 95 248 102 230 125 212Z" fill="#faf9f6"/>
  </g>
  <g class="nw__look"><circle class="nw__eye" cx="132" cy="165" r="5" fill="#141217"/><circle class="nw__eye" cx="182" cy="165" r="5" fill="#141217"/></g>
  <g class="nw__blush" opacity=".8"><ellipse cx="118" cy="178" rx="8" ry="5" fill="#f4bacd"/><ellipse cx="196" cy="178" rx="8" ry="5" fill="#f4bacd"/></g>
  <path class="nw__smile" d="M150 174Q157 184 164 174" stroke="#141217" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  <path class="nw__open" d="M147 173Q157 192 167 173Z" fill="#141217" stroke="#141217" stroke-width="2.5" stroke-linejoin="round"/>
  <path class="nw__frown" d="M150 182Q157 173 164 182" stroke="#141217" stroke-width="3.5" stroke-linecap="round" fill="none"/>
</svg>`;
  }

  /* The narwhal's markup. state: "away" (off screen until swimIn), "in" (swims
     in as it is drawn) or "" (already here). mood: a reaction to play on arrival. */
  function html({ state = "", mood = "", id = "", cls = "" } = {}) {
    const c = ["nw", state && `is-${state}`, mood && `is-${mood}`, cls].filter(Boolean).join(" ");
    return `<div class="${c}"${id ? ` id="${id}"` : ""} aria-hidden="true"><div class="nw__move"><div class="nw__act">${svg()}</div></div></div>`;
  }

  /* ---------- sound and vibration ----------
     Synthesized with Web Audio, so nothing is loaded. Vibration works on
     Android; iPhones have none. */
  let ac = null, started = false, unlocked = false, on = true, key = "";
  function audio() {
    if (!started || !on || !unlocked) return null;
    try { ac ??= new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    if (ac.state === "suspended") ac.resume();
    return ac;
  }
  function tone(f0, f1, ms, type = "sine", vol = .12, delay = 0) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay / 1000, end = t + ms / 1000;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, end);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + .006); g.gain.exponentialRampToValueAtTime(.0001, end);
    o.connect(g).connect(a.destination); o.start(t); o.stop(end + .02);
  }
  function noise(ms, vol, delay = 0, freq = 2000, q = 1) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay / 1000, len = Math.ceil(a.sampleRate * ms / 1000);
    const buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = buf; f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + ms / 1000);
    s.connect(f).connect(g).connect(a.destination); s.start(t);
  }
  function buzz(pattern) {
    // Like sound, only after a tap or key press: browsers refuse it before one.
    if (!started || !on || !unlocked) return;
    try { navigator.vibrate?.(pattern); } catch { /* not allowed here */ }
  }
  /* The print animation moves in four feeds with short pauses (@keyframes nw-print, 2.6s). */
  const PRINT_FEEDS = [[0, 572], [728, 624], [1508, 676], [2340, 260]];
  const sfx = {
    blip: () => tone(1300 + Math.random() * 500, 900, 45, "sine", .035),
    pop: (p = 1) => { tone(700 * p, 260 * p, 80, "sine", .16); noise(25, .05, 0, 4000, 2); },
    tick: (i) => tone(880 + i * 60, 880 + i * 60, 30, "triangle", .05),
    good: () => { tone(660, 660, 90, "triangle", .09); tone(990, 990, 160, "triangle", .09, 90); buzz(12); },
    bad: () => { tone(200, 130, 220, "square", .05); buzz([30, 50, 30]); },
    tap: () => { noise(35, .3, 0, 1600, 1.5); tone(180, 120, 60, "sine", .12); buzz(15); },
    print: () => {
      const pulses = [];
      let at = 0;
      for (const [start, len] of PRINT_FEEDS) {
        // on/off pairs always end on an "off", so a pause stretches that last off
        if (start > at && pulses.length) { pulses[pulses.length - 1] += start - at; at = start; }
        for (let k = 0; k + 50 <= len; k += 50) {
          noise(28, .07, start + k, 900, .8); tone(70, 70, 28, "sawtooth", .03, start + k);
          pulses.push(20, 30);
        }
        at = start + len - (len % 50);
      }
      buzz(pulses);
    },
    done: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 260, "triangle", .08, i * 110)); buzz([20, 80, 40]); },
  };
  const sound = {
    /* Turn sound on for this page; the reader's choice is kept under storageKey. */
    start(storageKey) {
      if (started) return;
      started = true; key = storageKey;
      try { on = localStorage.getItem(key) !== "off"; } catch { /* private mode: default on */ }
      const unlock = () => { unlocked = true; audio(); };
      addEventListener("pointerdown", unlock, { once: true, capture: true });
      addEventListener("keydown", unlock, { once: true, capture: true });
    },
    get on() { return on; },
    set on(v) {
      on = !!v;
      try { localStorage.setItem(key, on ? "on" : "off"); } catch { /* not kept: fine */ }
      if (!on) try { navigator.vibrate?.(0); } catch { /* not allowed here */ }
    },
  };

  /* ---------- body language ---------- */
  const MOODS = ["is-nod", "is-happy", "is-spin", "is-sad", "is-lap"];
  const timers = new WeakMap();
  /* kind: nod | happy | spin | sad | lap. Happy and spin chime. */
  function react(nw, kind, ms = 900) {
    if (!nw) return;
    const t = timers.get(nw) || {};
    clearTimeout(t.react);
    nw.classList.remove(...MOODS);
    void nw.offsetWidth;
    nw.classList.add(`is-${kind}`);
    if (kind === "happy" || kind === "spin") sfx.good();
    t.react = setTimeout(() => nw.classList.remove(`is-${kind}`), ms);
    timers.set(nw, t);
  }
  /* Quiet for a while: a small lap, every `every` ms while ok() says so. Call again to restart the wait. */
  function idle(nw, ok = () => true, every = 7000) {
    const t = timers.get(nw) || {};
    clearTimeout(t.idle);
    t.idle = setTimeout(() => { if (ok()) { react(nw, "lap", 1700); idle(nw, ok, every); } }, every);
    timers.set(nw, t);
  }
  function still(nw) { clearTimeout(timers.get(nw)?.idle); }
  function look(nw, yes) { nw?.classList.toggle("is-looking", !!yes); }
  /* From off screen (state "away"): swims in; resolves once it has arrived. */
  async function swimIn(nw) {
    nw.classList.remove("is-away");
    nw.classList.add("is-in");
    await wait(1300);
  }

  /* ---------- puffs ---------- */
  function blowhole(nw) {
    const r = nw?.querySelector("svg")?.getBoundingClientRect();
    return r ? { x: r.left + r.width * 0.585, y: r.top + r.height * 0.38 } : null;
  }
  function puff(x, y, size, dx, dy, ms) {
    if (reduced()) return;
    const p = document.createElement("div");
    p.className = "nw-puff";
    Object.assign(p.style, { left: `${x - size / 2}px`, top: `${y - size / 2}px`, width: `${size}px`, height: `${size}px` });
    document.body.append(p);
    p.animate([{ transform: "translate(0,0) scale(.4)", opacity: 0 }, { opacity: .7, offset: .2 }, { transform: `translate(${dx}px,${dy}px) scale(1)`, opacity: 0 }],
      { duration: ms, easing: "cubic-bezier(.2,.6,.4,1)" }).onfinish = () => p.remove();
  }
  /* Hello: four puffs rising from the blowhole. */
  async function spout(nw) {
    for (let i = 0; i < 4; i++) {
      const o = blowhole(nw);
      if (o) puff(o.x, o.y, 8 + i * 3, 6 - i * 4, -60 - i * 12, 1100);
      await wait(110);
    }
  }
  /* Typing in a chat bar: a blip and one small puff, at most every 90 ms. */
  let lastBlow = 0;
  function blow(nw) {
    const t = performance.now();
    if (t - lastBlow < 90) return;
    lastBlow = t;
    sfx.blip();
    const o = blowhole(nw);
    if (o) puff(o.x + (Math.random() - .5) * 6, o.y, 5 + Math.random() * 7, (Math.random() - .5) * 24, -50 - Math.random() * 30, 900);
  }
  /* Typing on every input event of `input`, plus looking at it while it has focus. */
  function watch(nw, input, onInput) {
    if (!input) return;
    input.addEventListener("focus", () => look(nw, true));
    input.addEventListener("blur", () => look(nw, false));
    input.addEventListener("input", () => { onInput?.(); blow(nw); });
  }

  /* ---------- what it says ----------
     Types text into el a letter at a time. Stops early once alive() says no
     (a newer line has started). Resolves false if it was stopped. */
  async function type(el, text, { ms = 24, alive = () => true } = {}) {
    el.textContent = "";
    if (reduced()) { el.textContent = text; return true; }
    for (let i = 1; i <= text.length; i++) {
      if (!alive()) return false;
      el.textContent = text.slice(0, i);
      await wait(ms);
    }
    return alive();
  }

  /* An answer rises from `from` (an element) in a bubble and pops on `to`. */
  async function floatUp(text, from, to, { ms = 900, puffs = 10 } = {}) {
    if (reduced() || !from || !to) return;
    const a = from.getBoundingClientRect(), z = to.getBoundingClientRect();
    const b = document.createElement("div");
    b.className = "nw-answer"; b.textContent = text;
    document.body.append(b);
    const w = b.offsetWidth, h = b.offsetHeight;
    const x0 = a.left + 16, y0 = a.top, x1 = z.left + z.width / 2 - w / 2, y1 = z.top + z.height / 2 - h / 2;
    await b.animate([
      { transform: `translate(${x0}px,${y0}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${x0}px,${y0 - 30}px) scale(1)`, opacity: 1, offset: .2 },
      { transform: `translate(${(x0 + x1) / 2 + 18}px,${(y0 + y1) / 2}px) scale(1.04)`, offset: .6 },
      { transform: `translate(${x1}px,${y1}px) scale(1.08)` },
    ], { duration: ms, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" }).finished;
    const cx = x1 + w / 2, cy = y1 + h / 2;
    sfx.pop(); buzz(8);
    b.animate([{ transform: `translate(${x1}px,${y1}px) scale(1.08)`, opacity: 1 }, { transform: `translate(${x1}px,${y1}px) scale(1.5)`, opacity: 0 }],
      { duration: 220, fill: "forwards" }).onfinish = () => b.remove();
    for (let i = 0; i < puffs; i++) {
      const r = (i / puffs) * Math.PI * 2;
      puff(cx + Math.cos(r) * w * .35, cy + Math.sin(r) * h * .5, 6 + Math.random() * 8, Math.cos(r) * 40, Math.sin(r) * 30 - 20, 600);
    }
    await wait(120);
  }
  /* A bubble still flying from an earlier screen (a background tab never finishes it). */
  function clearAnswers() { document.querySelectorAll(".nw-answer").forEach((b) => b.remove()); }

  /* A burst of bubbles rising through `box` (positioned); resolves after ms. */
  function burst(box, ms) {
    if (reduced()) return Promise.resolve();
    const c = document.createElement("canvas"); c.className = "nw-burst"; box.append(c);
    const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.scale(dpr, dpr);
    const ink = getComputedStyle(c).getPropertyValue("--nw-ink").trim() || getComputedStyle(c).color;
    for (let i = 0; i < 14; i++) setTimeout(() => sfx.pop(.7 + Math.random() * .9), 150 + i * 85 + Math.random() * 60);
    buzz([10, 60, 10, 60, 10, 60, 10]);
    const bs = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: H + Math.random() * H * .6, r: 4 + Math.random() * 22, v: 3 + Math.random() * 4, p: Math.random() * 6.28 }));
    const t0 = performance.now();
    return new Promise((done) => (function frame(t) {
      g.clearRect(0, 0, W, H);
      let alive = 0;
      for (const b of bs) {
        b.y -= b.v; b.p += .05;
        if (b.y + b.r < 0) continue;
        alive++;
        const x = b.x + Math.sin(b.p) * 6;
        g.beginPath(); g.arc(x, b.y, b.r, 0, 6.283); g.lineWidth = 2; g.strokeStyle = ink; g.globalAlpha = .55; g.stroke();
        g.beginPath(); g.arc(x - b.r * .35, b.y - b.r * .35, b.r * .22, 0, 6.283); g.fillStyle = ink; g.globalAlpha = .35; g.fill();
      }
      g.globalAlpha = 1;
      if (t - t0 > ms) done();
      if (alive && t - t0 < 5000) requestAnimationFrame(frame); else { c.remove(); done(); }
    })(t0));
  }

  /* ---------- the receipt printer ---------- */
  function printerHtml() {
    return `<div class="nw-printer"><div class="nw-printer__row"><span>Zold</span><span class="nw-printer__dot" aria-hidden="true"></span></div><div class="nw-printer__slot"></div></div>`;
  }
  /* The narwhal swims to the printer, taps it twice, and the paper feeds out;
     resolves once it has printed. With reduced motion the paper is just there. */
  async function print(nw, printer, paper) {
    const move = nw.querySelector(".nw__move");
    if (reduced() || !move) { paper.classList.add("is-shown"); return; }
    const n = move.getBoundingClientRect(), p = printer.getBoundingClientRect();
    const dx = p.left + 30 - n.left, dy = p.top - n.top - n.height * 0.72;
    await move.animate([{ transform: "none" }, { transform: `translate(${dx * .6}px,${dy * .4 - 30}px) rotate(-10deg)`, offset: .5 }, { transform: `translate(${dx}px,${dy}px) rotate(14deg)` }],
      { duration: 1100, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).finished;
    for (let i = 0; i < 2; i++) {
      await move.animate([{ transform: `translate(${dx}px,${dy}px) rotate(14deg)` }, { transform: `translate(${dx}px,${dy + 10}px) rotate(24deg)` }, { transform: `translate(${dx}px,${dy}px) rotate(14deg)` }],
        { duration: 260, fill: "forwards" }).finished;
      printer.classList.remove("is-tapped"); void printer.offsetWidth; printer.classList.add("is-tapped");
      sfx.tap();
    }
    move.animate([{ transform: `translate(${dx}px,${dy}px) rotate(14deg)` }, { transform: `translate(${dx - 8}px,${dy - 6}px) rotate(0deg)` }], { duration: 500, fill: "forwards" });
    printer.classList.add("is-on");
    paper.classList.add("is-printing");
    sfx.print();
    await wait(2600);
    react(nw, "happy", 1000);
    sfx.done();
  }

  return { reduced, wait, svg, html, sound, sfx, buzz, react, idle, still, look, swimIn, blowhole, puff, spout, blow, watch, type, floatUp, clearAnswers, burst, printerHtml, print };
})();
