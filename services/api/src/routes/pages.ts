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
 *
 * A share preview needs ABSOLUTE urls (og:image, og:url, canonical), and only
 * TRANSF_PUBLIC_URL says what they are — never the Host header, which the
 * caller writes. A page marks the spot with <!--zold:abs-->; without a public
 * url, og:image falls back to a relative path and canonical is left out.
 *
 * The website pages (landing, legal notes, partner terms, cookies, 404) share one nav and one
 * footer, kept in ../../site/ and filled in at <!--zold:site-nav--> and
 * <!--zold:site-footer--> so they are not six copies that drift apart.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_URL } from "../config.js";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const site = path.join(pub, "../site");
const base = PUBLIC_URL.replace(/\/+$/, "");

/** The pages search engines are invited to: the landing and the legal pages.
 *  Everything else is an app screen or a credential-bearing link. */
const INDEXABLE = ["/", "/legal", "/partner-terms", "/privacy"];

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function absTags(canonicalPath?: string): string {
  const tags = [
    `<meta property="og:image" content="${attr(`${base}/og-image.png`)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:image" content="${attr(`${base}/og-image.png`)}" />`,
  ];
  if (base && canonicalPath) {
    tags.push(`<link rel="canonical" href="${attr(base + canonicalPath)}" />`);
    tags.push(`<meta property="og:url" content="${attr(base + canonicalPath)}" />`);
  }
  return tags.join("\n");
}

/** Read once, fill the marker, serve from memory. */
function page(file: string, canonicalPath?: string): express.RequestHandler {
  let html: string | undefined;
  return (_req, res) => {
    html ??= fs
      .readFileSync(path.join(pub, file), "utf8")
      .replace("<!--zold:abs-->", absTags(canonicalPath))
      .replace("<!--zold:site-nav-->", () => fs.readFileSync(path.join(site, "nav.html"), "utf8"))
      .replace("<!--zold:site-footer-->", () => fs.readFileSync(path.join(site, "footer.html"), "utf8"));
    res.type("html").send(html);
  };
}

/** Served after every router: an unknown path gets the site's own page, not
 *  express's "Cannot GET", and an unknown API path gets JSON. */
export function notFound(): express.RequestHandler {
  const html = page("404.html");
  return (req, res, next) => {
    res.status(404);
    if (req.path.startsWith("/api/") || req.path === "/api") return res.json({ error: "not found" });
    if (req.method !== "GET" && req.method !== "HEAD") return res.type("text").send("Not found");
    return html(req, res, next);
  };
}

export function createPageRouter() {
  const router = express.Router();

  router.get(["/", "/landing.html"], page("landing.html", "/"));
  router.get("/legal", page("legal.html", "/legal"));
  router.get("/partner-terms", page("partner-terms.html", "/partner-terms"));
  router.get("/privacy", page("privacy.html", "/privacy"));

  router.get("/robots.txt", (_req, res) => {
    const lines = [
      "User-agent: *",
      "Allow: /$",
      // App screens and links that carry a credential. Each page also says
      // noindex itself; this keeps well-behaved crawlers from fetching them.
      "Disallow: /app",
      "Disallow: /admin",
      "Disallow: /business",
      "Disallow: /api/",
      "Disallow: /pay/",
      "Disallow: /r/",
      "Disallow: /v/",
      "Disallow: /invoice/",
    ];
    if (base) lines.push("", `Sitemap: ${base}/sitemap.xml`);
    res.type("text/plain").send(lines.join("\n") + "\n");
  });

  router.get("/sitemap.xml", (_req, res, next) => {
    // A sitemap of relative urls is invalid, and the Host header is the
    // caller's to write — no public url, no sitemap.
    if (!base) return next();
    const urls = INDEXABLE.map((p) => `  <url><loc>${attr(base + p)}</loc></url>`).join("\n");
    res
      .type("application/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  router.get("/favicon.ico", (_req, res) => res.redirect(301, "/icons/icon-192.png"));
  router.get(["/app", "/app/"], (_req, res) => res.sendFile(path.join(pub, "index.html")));
  /** The operator dashboard; each section has its own path (the page reads
   *  it), and its scripts are under /admin/*.js. */
  router.get(
    ["/admin", "/admin/", "/admin/:view(overview|users|monerium|transactions|recoveries|errors)"],
    (_req, res) => res.sendFile(path.join(pub, "admin.html")),
  );
  /** The org dashboard — business and premium personal accounts. */
  router.get(["/business", "/business/"], (_req, res) =>
    res.sendFile(path.join(pub, "business.html")),
  );
  /** The supplier's invoice view, reached with a one-time link and no account. */
  router.get("/invoice/:token", (_req, res) => res.sendFile(path.join(pub, "invoice.html")));
  /** An account document, re-verified on every visit. */
  router.get("/v/:code", (_req, res) => res.sendFile(path.join(pub, "document.html")));
  /** A payment page, and a payment request against it. */
  router.get("/pay/:handle", page("pay.html"));
  router.get("/pay/:handle/:code", page("pay-request.html"));
  /** A shared receipt. */
  router.get("/r/:slug", page("receipt.html"));

  router.use(express.static(pub));

  return router;
}
