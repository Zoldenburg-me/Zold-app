/*
 * Landing motion: things that settle once they scroll into view (the flow
 * dashes, the who-can-move columns, the who-signs bars), and the Pause motion
 * button.
 *
 * Every hidden-until-visible state in landing.css is scoped to html.l-js;
 * the <noscript> block in landing.html shows everything when JS is off.
 *
 * Pause motion sets html.l-paused (CSS pauses every animation) and sends a
 * "l-motion" event that graphics.js and narwhal.js listen for.
 */
(function () {
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var VISIBLE_AT = 0.15;
  var root = document.documentElement;

  // One observer adds .in once.
  var once = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      once.unobserve(e.target);
    });
  }, { threshold: VISIBLE_AT });
  document.querySelectorAll(".l-flow, .l-lat, .l-who").forEach(function (el) { once.observe(el); });

  /* Pause motion. Hidden under reduced motion, where nothing loops anyway. */
  var pause = document.querySelector(".l-motion");
  if (pause && !REDUCED) {
    pause.hidden = false;
    pause.addEventListener("click", function () {
      var paused = !root.classList.contains("l-paused");
      root.classList.toggle("l-paused", paused);
      pause.setAttribute("aria-pressed", String(paused));
      pause.textContent = paused ? "Play motion" : "Pause motion";
      document.dispatchEvent(new CustomEvent("l-motion", { detail: { paused: paused } }));
    });
  }
})();
