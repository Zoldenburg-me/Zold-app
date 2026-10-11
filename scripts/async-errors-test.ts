/**
 * An async handler that throws answers 500 with a reference; it does not end
 * the process. Express 4 drops a handler's rejected promise and server.ts
 * exits on an unhandled rejection, so without the guard one throwing route
 * takes the API down and Cloudflare answers every caller with a 502.
 *
 *   npm run async-errors:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { routeAsyncRejections } from "../services/api/src/http/async-errors.js";
import { recentServerErrors, recordServerError } from "../services/api/src/http/error-log.js";

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

let unhandled = 0;
process.on("unhandledRejection", () => {
  unhandled++;
});

const app = express();
const nested = express.Router();
nested.post("/orgs/:orgId/boom", async () => {
  throw new Error("thrown inside a nested router");
});
app.use("/api", nested);
app.get("/api/direct", async () => {
  throw new Error("thrown on the app");
});
app.get("/api/sync", () => {
  throw new Error("thrown synchronously");
});
app.use(((err, req, res, _next) => {
  const logged = recordServerError(err, req);
  res.status(500).json({ error: "internal", ref: logged.ref });
}) as express.ErrorRequestHandler);
const layers = routeAsyncRejections(app);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

await check("the walk reaches the nested router's routes", () => {
  assert.ok(layers >= 4, `saw only ${layers} layers`);
});

for (const [method, path] of [["POST", "/api/orgs/o1/boom"], ["GET", "/api/direct"], ["GET", "/api/sync"]] as const) {
  await check(`${method} ${path} answers 500 with a reference`, async () => {
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.ref, /^E-[A-Z2-9]{8}$/);
  });
}

await check("no rejection went unhandled", async () => {
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(unhandled, 0);
});

await check("the log keeps the route pattern, never the concrete URL", () => {
  const routes = recentServerErrors().map((e) => e.route);
  assert.ok(routes.includes("/api/orgs/:orgId/boom"), routes.join(", "));
  assert.ok(!routes.some((r) => r.includes("o1")), "a concrete id leaked into the log");
});

await check("server.ts applies it after the last route", () => {
  const src = readFileSync(new URL("../services/api/src/server.ts", import.meta.url), "utf8");
  const handler = src.indexOf("as express.ErrorRequestHandler);");
  const applied = src.indexOf("routeAsyncRejections(app);");
  assert.ok(handler > 0 && applied > handler, "routeAsyncRejections(app) must run after the error handler is mounted");
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
