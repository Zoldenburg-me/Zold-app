/**
 * The service worker, and telling the truth about the network.
 *
 * LAST, and self-contained. Everything here is wrapped so that a failure to
 * register — an insecure origin, a browser without service workers, a private
 * window — leaves the app working exactly as it did, just without offline
 * start-up.
 */
(function () {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function (err) {
        console.warn("service worker registration failed: " + err);
      });
    });
  }

  /* A standing, unmissable statement of network state. Balances and quotes
     are refused rather than served stale while this is up, so the user needs
     to know why the numbers stopped moving. The interface going away is only
     half of it — api() also flips this when a call cannot reach us on a
     perfectly good connection. */
  function render() {
    if (window.setReachable) window.setReachable(navigator.onLine);
  }
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  render();
})();
