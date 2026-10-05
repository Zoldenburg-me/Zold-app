/*
 * The Zold narwhal: swims down the page with the copy, settles beside the
 * heading of each section marked data-narwhal-say (or just below it when there
 * is no room on the right, clear of the section's links and buttons), and types that section's caption behind a ">".
 *
 * Decoration only: aria-hidden, no pointer events, and the captions are words
 * already on the page. Hidden on phones, with reduced motion, in a background
 * tab and while motion is paused (motion.js).
 *
 * Cost: an IntersectionObserver says which section the reader is on; the
 * animation frame loop runs only while the narwhal is moving, and a scroll or
 * resize wakes it. At rest it reads no layout.
 */
(function () {
  var fish = document.querySelector(".l-narwhal");
  var stops = Array.prototype.slice.call(document.querySelectorAll("[data-narwhal-say]"));
  if (!fish || !stops.length) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var WIDE = matchMedia("(min-width: 761px)");
  var root = document.documentElement;

  var TYPE_MS = 38, SPRING = 0.022, DAMPING = 0.84, SETTLED = 0.35, AT_REST = 0.5;
  var GAP = 24, TOP_MIN = 90, BOTTOM_PAD = 150, MAX_TILT = 18, PEEK = 0.4, CAPTION_H = 40;

  var sayText = fish.querySelector(".l-narwhal__say span");
  var body = fish.querySelector(".l-narwhal__body");

  /* ---- caption typing ---- */
  var typing = 0, shownFor = null;
  function say(stop) {
    if (stop === shownFor) return;
    shownFor = stop;
    clearInterval(typing);
    var full = stop.getAttribute("data-narwhal-say") || "";
    fish.classList.toggle("is-talking", Boolean(full));
    var i = 0;
    sayText.textContent = "";
    typing = setInterval(function () {
      sayText.textContent = full.slice(0, ++i);
      if (i >= full.length) clearInterval(typing);
    }, TYPE_MS);
  }

  /* ---- which section is the reader on: the one crossing a line 40% down ---- */
  var active = stops[0];
  var band = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) active = e.target; });
    wake();
  }, { rootMargin: "-40% 0px -59% 0px" });
  stops.forEach(function (s) { band.observe(s); });

  /* The box around a heading's visible words. Measures each text node, not
     the elements: a centred heading, or a block line inside one, spans the
     full width. A screen-reader copy (.s-sr) is skipped. */
  function textBox(el) {
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    var box = null, node;
    while ((node = walk.nextNode())) {
      if (!node.textContent.trim() || node.parentElement.closest(".s-sr")) continue;
      range.selectNodeContents(node);
      var r = range.getBoundingClientRect();
      if (!r.width) continue;
      box = box
        ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    var e = el.getBoundingClientRect();
    box = box || { left: e.left, top: e.top, right: e.right, bottom: e.bottom };
    box.height = box.bottom - box.top;
    return box;
  }

  /* Beside the heading's text when there is room on its right, otherwise just
     below the heading and the paragraph after it. */
  function targetFor(stop) {
    var w = fish.offsetWidth, h = body.offsetHeight;
    var heading = stop.querySelector("h1, h2") || stop;
    var a = textBox(heading);
    // Heading scrolled out of view: peek in from the right edge, clear of the copy.
    if (a.bottom < TOP_MIN || a.top > innerHeight - BOTTOM_PAD) {
      return { x: innerWidth - w * PEEK, y: innerHeight * 0.5, beside: true, peek: true };
    }
    var next = heading.nextElementSibling;
    var blockBottom = next && next.tagName === "P" ? next.getBoundingClientRect().bottom : a.bottom;
    var roomRight = innerWidth - a.right - GAP * 2 >= w;
    var x = roomRight ? a.right + GAP : Math.max(GAP, a.left);
    var y = roomRight ? a.top + a.height / 2 - h / 2 : blockBottom + GAP;
    y = Math.min(innerHeight - BOTTOM_PAD, Math.max(TOP_MIN, y));
    var spot = clearOfControls(stop, x, y, w, h);
    return { x: spot.x, y: spot.y, beside: roomRight };
  }

  /* Never settle on a link or button (the hero's Open an account): step to
     its right, or below it when there is no room on the right. The box
     includes the caption above the narwhal. */
  function clearOfControls(stop, x, y, w, h) {
    var controls = stop.querySelectorAll("a, button:not([hidden])");
    for (var i = 0; i < controls.length; i++) {
      var r = controls[i].getBoundingClientRect();
      var top = y - CAPTION_H, bottom = y + h;
      var overlaps = x < r.right + GAP && x + w > r.left - GAP && top < r.bottom + GAP && bottom > r.top - GAP;
      if (!overlaps) continue;
      if (r.right + GAP + w <= innerWidth - GAP) x = r.right + GAP * 2;
      else y = r.bottom + GAP + CAPTION_H;
    }
    return { x: x, y: y };
  }

  /* ---- spring motion toward the active section; sleeps once settled ---- */
  var x = innerWidth - 220, y = innerHeight, vx = 0, vy = 0, facing = -1, raf = 0;
  function frame() {
    var t = targetFor(active);
    vx = vx * DAMPING + (t.x - x) * SPRING;
    vy = vy * DAMPING + (t.y - y) * SPRING;
    x += vx; y += vy;
    var speed = Math.hypot(vx, vy);
    if (Math.abs(vx) > 0.6) facing = vx > 0 ? 1 : -1;      // swim the way it moves
    else if (speed < SETTLED) facing = t.beside ? -1 : 1;  // at rest, face the copy
    var tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, vy * 1.4)) * facing;
    fish.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px)";
    body.style.transform = "scaleX(" + facing + ") rotate(" + tilt.toFixed(1) + "deg)";
    fish.classList.toggle("is-left", !t.beside);
    if (t.peek) { fish.classList.remove("is-talking"); shownFor = null; }
    else if (speed < SETTLED) say(active);
    var resting = speed < AT_REST && Math.abs(t.x - x) < AT_REST && Math.abs(t.y - y) < AT_REST;
    raf = resting ? 0 : requestAnimationFrame(frame);
  }
  function canSwim() { return WIDE.matches && !document.hidden && !root.classList.contains("l-paused"); }
  function wake() { if (!raf && canSwim()) raf = requestAnimationFrame(frame); }
  function update() {
    fish.hidden = !canSwim();
    if (fish.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake();
  }
  addEventListener("scroll", wake, { passive: true });
  addEventListener("resize", wake, { passive: true });
  document.addEventListener("visibilitychange", update);
  document.addEventListener("l-motion", update);
  WIDE.addEventListener("change", update);
  update();
})();
