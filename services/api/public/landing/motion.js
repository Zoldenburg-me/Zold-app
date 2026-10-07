/*
 * Landing motion: word-by-word reveals, things that settle once they scroll
 * into view (the flow dashes, the who-can-move
 * columns, the who-signs bars), and the Pause motion button.
 *
 * Every hidden-until-visible state in landing.css is scoped to html.l-js;
 * the <noscript> block in landing.html shows everything when JS is off.
 *
 * Pause motion sets html.l-paused (CSS pauses every animation) and sends a
 * "l-motion" event that wave.js, graphics.js and narwhal.js listen for.
 */
(function () {
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var VISIBLE_AT = 0.15;
  var root = document.documentElement;

  /* Wrap each word in span.w with a stagger index. Screen-reader text is left
     whole; an element marked data-word is revealed as one word. */
  function splitWords(el) {
    var i = 0;
    function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.classList.contains("s-sr")) return;
          if (child.hasAttribute("data-word")) { child.classList.add("w"); child.style.setProperty("--i", i++); return; }
          walk(child);
          return;
        }
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) return;
        var frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          var w = document.createElement("span");
          w.className = "w";
          w.style.setProperty("--i", i++);
          w.textContent = part;
          frag.appendChild(w);
        });
        child.parentNode.replaceChild(frag, child);
      });
    }
    walk(el);
    el.setAttribute("data-split", "");
  }
  document.querySelectorAll("[data-reveal]").forEach(splitWords);

  // One observer adds .in once.
  var once = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      once.unobserve(e.target);
    });
  }, { threshold: VISIBLE_AT });
  document.querySelectorAll("[data-reveal], .l-flow, .l-lat, .l-who").forEach(function (el) { once.observe(el); });
  // What is on screen at load (the hero) reveals on the first frame, without
  // waiting for the observer's first report.
  requestAnimationFrame(function () {
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) { el.classList.add("in"); once.unobserve(el); }
    });
  });

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
