/**
 * Server errors, by reference.
 *
 * Every 500 the error handler answers carries a short `ref`, the same ref is
 * printed in the log line with the stack, and the last MAX entries are kept in
 * memory for the operator's dashboard (GET /api/admin/errors). A tester or a
 * user quotes the ref; the operator finds the stack without grepping logs.
 *
 * In memory only: a restart empties the list (the log keeps the lines). What
 * is kept is chosen so it holds no credential: the route PATTERN, never the
 * URL (an invoice-link or pay-link path is a bearer token, and a query string
 * may carry one), and no request body.
 */
import { randomBytes } from "node:crypto";
import type express from "express";
import { ROUTE_PATTERN } from "./async-errors.js";

export interface ServerErrorEntry {
  ref: string;
  at: string;
  method: string;
  route: string;
  status: number;
  name: string;
  message: string;
  stack: string[];
}

const MAX = 200;
const entries: ServerErrorEntry[] = [];

/** `E-` and eight characters a person can read out over the phone. */
export function newErrorRef(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `E-${s}`;
}

/** The matched route pattern ("/api/orgs/:orgId/invoicing/issue"), or the
 *  mount path when no route matched. Never the concrete URL. */
export function routePattern(req: express.Request): string {
  const noted = (req as unknown as Record<symbol, unknown>)[ROUTE_PATTERN];
  if (typeof noted === "string") return noted;
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return `${req.baseUrl || ""}${typeof path === "string" ? path : ""}` || "(unmatched)";
}

export function recordServerError(err: unknown, req: express.Request, status = 500): ServerErrorEntry {
  const e = err as { name?: unknown; message?: unknown; shortMessage?: unknown; stack?: unknown } | undefined;
  const entry: ServerErrorEntry = {
    ref: newErrorRef(),
    at: new Date().toISOString(),
    method: req.method,
    route: routePattern(req),
    status,
    name: typeof e?.name === "string" ? e.name : typeof err,
    message: String(e?.shortMessage ?? e?.message ?? err).slice(0, 500),
    stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(1, 9).map((l) => l.trim()) : [],
  };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;
  console.error(`[${entry.ref}] ${entry.method} ${entry.route} -> ${status}: ${e?.stack ?? entry.message}`);
  return entry;
}

export function recentServerErrors(): ServerErrorEntry[] {
  return entries.slice();
}
