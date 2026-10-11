/*
 * Landing graphic panel: the payment link being typed. The typing runs only
 * while its panel is on screen and stops while motion is paused (motion.js);
 * reduced motion leaves the full link.
 * All names and figures are illustration, and the page says so under the cards.
 */
(function () {
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function whileVisible(el, start, stop) {
    new IntersectionObserver(function (entries) { entries[0].isIntersecting ? start() : stop(); }, { threshold: 0.1 }).observe(el);
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
