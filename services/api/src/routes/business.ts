/**
 * /api/orgs/:orgId — the business surface, composed from four route modules.
 *
 * ONE ROUTER PER SUBJECT, mounted on the same path: drafts, incoming invoices,
 * issued invoices, and bookkeeping. They share the derived-state helpers in
 * ./business/state.ts and the request helpers in ./business/shared.ts, so the
 * rules that cut across them — four eyes, INVALID_DATA, gating as a read-time
 * filter — have one home each rather than four copies.
 *
 * requireSession and the transfer factory are INJECTED. server.ts owns
 * authentication, and one code path builds transfers, so this surface cannot
 * acquire its own way of doing either.
 *
 * The public invoice-link endpoints are exported here but mounted separately
 * at /api/invoice-links: they are reached by a supplier who has no account and
 * no session.
 */
import express from "express";
import { resolveOrg, type SessionResolver } from "./org-context.js";
import { createDraftRoutes } from "./business/drafts.js";
import { createInvoiceRoutes } from "./business/invoices.js";
import { createInvoicingRoutes } from "./business/invoicing.js";
import { createBookkeepingRoutes } from "./business/bookkeeping.js";
import type { TransferFactory } from "./business/shared.js";

export type { TransferFactory } from "./business/shared.js";
export { createInvoiceLinkRouter } from "./business/invoice-links.js";

export function createBusinessRouter(
  requireSession: SessionResolver,
  buildTransferFromQuote: TransferFactory,
): express.Router {
  const r = express.Router();
  const deps = {
    ctxOf: (req: express.Request, res: express.Response) => resolveOrg(req, res, requireSession),
  };

  r.use(createDraftRoutes(deps, buildTransferFromQuote));
  r.use(createInvoiceRoutes(deps));
  r.use(createInvoicingRoutes(deps));
  r.use(createBookkeepingRoutes(deps));

  return r;
}
