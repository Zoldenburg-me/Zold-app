/*
 * The website's one script (landing, legal notes, cookies, 404).
 *
 * Everything it changes is drawn in its fail-closed state first, so a page
 * with no JS or no API still tells the truth:
 *   - the landing's "Test mode, no real money" pill is in the markup and is
 *     removed only when /api/health says realMoney. capabilities.sandbox is
 *     not used: it is true on every deployment.
 *   - the footer says cash pickup is not open until capabilities.cashRail.
 *   - the network name says plain "Base" until chainId names it.
 *
 * It also sends the old landing anchors (links in the wild) to where that
 * content lives now.
 */
(function () {
  var MOVED = { "#notes": "/legal", "#cookies": "/privacy#cookies", "#rails": "#get-paid", "#account": "#get-paid", "#approval": "#security", "#trust": "#security" };
  var onLanding = location.pathname === "/" || location.pathname === "/landing.html";
  if (onLanding && MOVED[location.hash]) {
    var to = MOVED[location.hash];
    if (to.charAt(0) === "/") { location.replace(to); return; }
    history.replaceState(null, "", to);
    var el = document.getElementById(to.slice(1));
    if (el) el.scrollIntoView();
  }

  // The phone menu is a <details>: a link to a section of this same page
  // scrolls but would leave it open over the content.
  document.querySelectorAll(".s-menu a").forEach(function (a) {
    a.addEventListener("click", function () { var d = a.closest("details"); if (d) d.open = false; });
  });

  var NETWORK = { 8453: "Base", 84532: "Base test network", 31337: "Local test network" };

  fetch("/api/health", { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
    .then(function (d) {
      if (!d) return;
      if (d.realMoney === true) {
        document.querySelectorAll("[data-test-mode]").forEach(function (n) { n.remove(); });
      }
      if (typeof d.chainId === "number" && NETWORK[d.chainId]) {
        document.querySelectorAll("[data-network]").forEach(function (n) { n.textContent = NETWORK[d.chainId]; });
      }
      if (d.capabilities && d.capabilities.cashRail === true) {
        document.querySelectorAll("[data-cash-rail]").forEach(function (n) {
          var dot = n.querySelector(".s-dot");
          if (dot) dot.classList.add("s-dot--on");
          var t = n.querySelector("[data-cash-rail-text]");
          if (t) t.textContent = "Cash pickup: open";
        });
      }
    })
    .catch(function () { /* keep the fail-closed defaults */ });
})();
