/* The promise business/core.js awaits for the device key library. A classic
   script, so it runs during parsing and the resolver exists before the
   deferred /device.js module calls it. */
window.__deviceLib = new Promise((resolve) => { window.__deviceLibReady = resolve; });
