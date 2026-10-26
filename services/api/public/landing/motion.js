/*
 * Landing motion:
 *   - blocks marked .l-rv (and the closing phone) settle once they scroll
 *     into view;
 *   - the story: the chapter crossing the middle of the screen is the one
 *     being read, and the sticky phone shows that chapter's screen;
 *   - the Pause motion button.
 *
 * Every hidden-until-visible state in landing.css is scoped to html.l-js;
 * the <noscript> block in landing.html shows everything when JS is off.
 *
 * Pause motion sets html.l-paused (CSS pauses every animation) and sends a
 * "l-motion" event that narwhal.js listens for.
 */
(function () {
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var VISIBLE_AT = 0.15;
  var root = document.documentElement;

  /* ---- settle once in view ---- */
  var once = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      once.unobserve(e.target);
    });
  }, { threshold: VISIBLE_AT });
  document.querySelectorAll(".l-rv, .l-launch__stage").forEach(function (el) { once.observe(el); });

  /* ---- story: the phone follows the chapter being read ---- */
  var chapters = Array.prototype.slice.call(document.querySelectorAll(".l-ch"));
  var screens = Array.prototype.slice.call(document.querySelectorAll(".l-device--story img"));
  function show(n) {
    chapters.forEach(function (c) { c.classList.toggle("is-on", c.getAttribute("data-chapter") === n); });
    screens.forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-screen") === n); });
  }
  if (chapters.length) {
    show("0");
    var band = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) show(e.target.closest(".l-ch").getAttribute("data-chapter"));
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    chapters.forEach(function (c) { var main = c.querySelector(".l-ch__main"); if (main) band.observe(main); });
  }

  /* ---- Pause motion. Hidden under reduced motion, where nothing loops anyway. ---- */
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
