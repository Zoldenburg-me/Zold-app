/**
 * Express 4 does not catch a rejected promise from a handler, and server.ts
 * exits the process on an unhandled rejection. So one `async (req, res)`
 * handler that throws took the whole API down, and Cloudflare answered every
 * caller with a 502 until the supervisor restarted it.
 *
 * `routeAsyncRejections` walks every layer mounted on the app, nested routers
 * included, and makes each handler pass a rejection to `next`, so it reaches
 * the error handler as a 500 like any synchronous throw. It runs once, after
 * the last route is mounted. Each route's own `wrap` stays; a second catch on
 * an already-caught promise does nothing.
 */
import type express from "express";

type Layer = {
  handle: (...args: any[]) => unknown;
  route?: { stack: Layer[] };
  __routesRejections?: true;
};

const isThenable = (v: unknown): v is Promise<unknown> =>
  Boolean(v) && typeof (v as { then?: unknown }).then === "function";

/** Where a route handler runs, the request still knows its mount path and
 *  route; by the time the app-level error handler runs, Express has reset
 *  `baseUrl`. So the pattern is noted on the way in, for error-log.ts. */
export const ROUTE_PATTERN = Symbol("zold.routePattern");

function patch(layer: Layer, inRoute = false) {
  if (layer.__routesRejections) return;
  const fn = layer.handle;
  if (typeof fn !== "function") return;
  // Express tells an error handler from a request handler by its arity, so
  // the replacement keeps it.
  if (fn.length === 4) {
    layer.handle = function (this: unknown, err: unknown, req: unknown, res: unknown, next: (e?: unknown) => void) {
      const out = fn.call(this, err, req, res, next);
      if (isThenable(out)) out.catch(next);
      return out;
    };
  } else {
    layer.handle = function (this: unknown, req: any, res: unknown, next: (e?: unknown) => void) {
      if (inRoute && typeof req?.route?.path === "string") req[ROUTE_PATTERN] = `${req.baseUrl || ""}${req.route.path}`;
      const out = fn.call(this, req, res, next);
      if (isThenable(out)) out.catch(next);
      return out;
    };
  }
  layer.__routesRejections = true;
}

function walk(stack: Layer[] | undefined) {
  for (const layer of stack ?? []) {
    if (layer.route) {
      for (const inner of layer.route.stack) patch(inner, true);
      continue;
    }
    // A mounted router is itself a function with a `stack`: patch what it
    // holds, not the router.
    const nested = (layer.handle as { stack?: Layer[] }).stack;
    if (Array.isArray(nested)) walk(nested);
    else patch(layer);
  }
}

/** Returns how many layers it saw, for the test that it found the routers. */
export function routeAsyncRejections(app: express.Express): number {
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack;
  walk(stack);
  let n = 0;
  const count = (s: Layer[] | undefined) => {
    for (const l of s ?? []) {
      if (l.route) n += l.route.stack.length;
      else if (Array.isArray((l.handle as { stack?: Layer[] }).stack)) count((l.handle as { stack?: Layer[] }).stack);
      else n++;
    }
  };
  count(stack);
  return n;
}
