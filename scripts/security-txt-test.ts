/**
 * /.well-known/security.txt (RFC 9116) is served as text/plain with the
 * fields the policy names, ahead of the 404 page, and the service worker
 * leaves it to the network. Fails once Expires has passed: renew it in
 * routes/pages.ts.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPageRouter, notFound, SECURITY_TXT_EXPIRES } = await import("../services/api/src/routes/pages.js");

const app = express();
app.use(createPageRouter());
app.use(notFound());
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

try {
  const r = await fetch(`${base}/.well-known/security.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await r.text();
  assert.match(body, /^Contact: mailto:security@zoldhq\.com$/m);
  assert.match(body, /^Policy: https:\/\/github\.com\/Zoldenburg-me\/Zold-app\/blob\/main\/SECURITY\.md$/m);
  assert.match(body, /^Preferred-Languages: en, de$/m);
  assert.match(body, new RegExp(`^Expires: ${SECURITY_TXT_EXPIRES.replace(/\./g, "\\.")}$`, "m"));

  const expires = Date.parse(SECURITY_TXT_EXPIRES);
  assert.ok(expires > Date.now(), `security.txt expired on ${SECURITY_TXT_EXPIRES}: renew it`);
  assert.ok(expires - Date.now() <= 366 * 24 * 3600 * 1000, "Expires is more than a year out");

  assert.equal((await fetch(`${base}/.well-known/nothing`)).status, 404);

  const sw = readFileSync(path.join(ROOT, "services/api/public/sw.js"), "utf8");
  assert.match(sw, /url\.pathname\.startsWith\("\/\.well-known\/"\)\) return;/);
  console.log("security.txt: ok");
} finally {
  server.close();
}
