/*
 * Landing graphic panels: the incoming-payments ticker and the payment link
 * being typed. The typing runs only while its panel is on screen and stops
 * while motion is paused (motion.js); reduced motion leaves the full link.
 * All names and figures are illustration, and the page says so under the cards.
 */
(function () {
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function whileVisible(el, start, stop) {
    new IntersectionObserver(function (entries) { entries[0].isIntersecting ? start() : stop(); }, { threshold: 0.1 }).observe(el);
  }
  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  /* ---- Ticker: rows rendered twice so the CSS -50% loop is seamless ---- */
  var ticker = document.querySelector("[data-l-ticker]");
  if (ticker) {
    var ROWS = [
      { dir: "in", name: "Salary, Lindner Holzbau", via: "Bank transfer", amt: "+€2,850.00" },
      { dir: "in", name: "Rent refund", via: "Bank transfer", amt: "+€120.00" },
      { dir: "out", name: "Anna Schmidt", via: "Bank transfer", amt: "−€250.00" },
      { dir: "in", name: "Invoice 1042, Druckerei Kessler", via: "Bank transfer", amt: "+€1,180.00" },
      { dir: "in", name: "Café Ostwind, payment link", via: "USDC", amt: "+€60.00" }
    ];
    var row = function (r) {
      var li = el("li", "l-row");
      var ico = el("span", "l-row__ico" + (r.dir === "out" ? " l-row__ico--out" : ""));
      ico.appendChild(el("i", "ph " + (r.dir === "in" ? "ph-arrow-down-left" : "ph-arrow-up-right")));
      var nm = el("span", "l-row__nm");
      nm.appendChild(el("b", "", r.name));
      nm.appendChild(el("small", "", r.via));
      li.appendChild(ico);
      li.appendChild(nm);
      li.appendChild(el("span", "l-row__amt" + (r.dir === "in" ? " l-row__amt--in" : ""), r.amt));
      return li;
    };
    ROWS.concat(ROWS).forEach(function (r) { ticker.appendChild(row(r)); });
  }

  /* ---- Payment link: typed out, held, cleared, typed again ---- */
  var typed = document.querySelector("[data-l-type]");
  if (typed && !REDUCED) {
    var full = typed.getAttribute("data-l-type");
    var TYPE_MS = 70, HOLD_MS = 2600, PREFIX = "zoldhq.com/pay/".length;
    var n = full.length, typing = null, phase = "hold", wait = 0;
    var tick = function () {
      if (phase === "hold") { wait += TYPE_MS; if (wait >= HOLD_MS) { phase = "clear"; wait = 0; } return; }
      if (phase === "clear") { n = Math.max(PREFIX, n - 1); if (n === PREFIX) phase = "type"; }
      else { n = Math.min(full.length, n + 1); if (n === full.length) phase = "hold"; }
      typed.textContent = full.slice(0, n);
    };
    var onScreen = false;
    var run = function () {
      var go = onScreen && !document.documentElement.classList.contains("l-paused");
      if (go && !typing) typing = setInterval(tick, TYPE_MS);
      if (!go) { clearInterval(typing); typing = null; }
    };
    whileVisible(typed, function () { onScreen = true; run(); }, function () { onScreen = false; run(); });
    document.addEventListener("l-motion", run);
  }
})();
