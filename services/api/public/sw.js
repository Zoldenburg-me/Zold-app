/**
 * Service worker — app shell only.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nothing under /api/ is ever cached.
 *
 * Everything this product shows about money is time-sensitive in a way that
 * makes a stale copy worse than an error. A balance can have moved. A quote
 * locks a rate for ten minutes and binds to execution, so replaying a cached
 * one would show a price the server will refuse. A transfer's state is the
 * whole point of the state machine. So API requests go to the network or they
 * fail honestly — see the 503 below, which is what the UI renders as "can't
 * reach Zold" rather than showing a number nobody can stand behind.
 *
 * What IS cached is the shell: the HTML, the device-key module and the
 * vendored crypto. That is what makes the installed app open instantly, and
 * none of it says anything about anyone's money.
 *
 * Bump SHELL_CACHE when the shell changes; activate deletes every other cache
 * this origin owns, so an old shell cannot outlive a deploy.
 */
const SHELL_CACHE = "zold-shell-v1";

/**
 * The device key and the vendored crypto matter most here. If /device.js or
 * /vendor/* is missing the send flow cannot sign at all, so they are cached up
 * front rather than on first use.
 */
const SHELL = [
  "/app",
  "/",
  "/device.js",
  "/vendor/crypto-shim.js",
  "/vendor/secp256k1.js",
  "/vendor/hashes/sha3.js",
  "/vendor/hashes/utils.js",
  "/vendor/hashes/_assert.js",
  "/vendor/hashes/_u64.js",
  "/vendor/hashes/cryptoBrowser.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is all-or-nothing; one 404 would leave the worker uninstalled
      // and the app uncached with no clue why. Add individually and let a
      // missing optional file be visible in the log instead.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn(`sw: could not cache ${url}: ${err}`);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/** Offline answer for an API call. A JSON body in the shape the client already
 *  understands, so the existing error path prints a sentence rather than
 *  "Failed to fetch". */
function offlineApiResponse() {
  return new Response(
    JSON.stringify({ error: "you appear to be offline — Zold could not be reached" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch writes

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts/icons from a CDN: leave alone

  // Account state, quotes, transfers, rates: network or nothing.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(() => offlineApiResponse()));
    return;
  }

  // A page load: prefer the network so a deploy is picked up, fall back to the
  // cached shell for that path so the installed app still opens offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          /**
           * Refresh the stored shell on every successful load.
           *
           * Without this the cached copy is written once at install and then
           * frozen until SHELL_CACHE changes, so anyone who went offline after
           * a deploy would keep opening the previous build — and whoever
           * forgot to bump the version would never find out. Re-storing here
           * costs one cache write per navigation and removes that whole class
           * of staleness.
           */
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(url.pathname, response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match(url.pathname)) ??
            (await cache.match("/app")) ??
            offlineApiResponse()
          );
        }
      })(),
    );
    return;
  }

  // Shell assets: cache first, and keep whatever the network returns.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
