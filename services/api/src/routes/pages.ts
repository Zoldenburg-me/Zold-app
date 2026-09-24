/**
 * The HTML the browser is handed, and the static assets beside it.
 *
 * These are declared BEFORE express.static, which would otherwise answer / with
 * index.html and never reach them. The app's own assets are absolute
 * (/device.js, /vendor/...), so it serves correctly from any path — but the
 * import map depends on that, so do not make them relative.
 *
 * Every page whose URL carries a credential — a receipt slug, a payment-request
 * code — is served for ANY shape of that credential, because the client fetches
 * the data and draws its own expired / revoked / not-found state. A dead link
 * still gets a real page rather than a bare 404.
 *
 * /landing.html still resolves, because links to it exist in the wild.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");

export function createPageRouter() {
  const router = express.Router();

  router.get("/", (_req, res) => res.sendFile(path.join(pub, "landing.html")));
  router.get(["/app", "/app/"], (_req, res) => res.sendFile(path.join(pub, "index.html")));
  router.get(["/admin", "/admin/"], (_req, res) => res.sendFile(path.join(pub, "admin.html")));
  /** The org dashboard — business and premium personal accounts. */
  router.get(["/business", "/business/"], (_req, res) =>
    res.sendFile(path.join(pub, "business.html")),
  );
  /** The supplier's invoice view, reached with a one-time link and no account. */
  router.get("/invoice/:token", (_req, res) => res.sendFile(path.join(pub, "invoice.html")));
  /** An account document, re-verified on every visit. */
  router.get("/v/:code", (_req, res) => res.sendFile(path.join(pub, "document.html")));
  /** A payment page, and a payment request against it. */
  router.get("/pay/:handle", (_req, res) => res.sendFile(path.join(pub, "pay.html")));
  router.get("/pay/:handle/:code", (_req, res) => res.sendFile(path.join(pub, "pay-request.html")));
  /** A shared receipt. */
  router.get("/r/:slug", (_req, res) => res.sendFile(path.join(pub, "receipt.html")));

  router.use(express.static(pub));

  return router;
}
