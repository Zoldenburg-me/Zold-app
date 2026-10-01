/**
 * /api/orgs/:orgId: the business surface, composed from four route modules.
 *
 * One router per subject, mounted on the same path: drafts, incoming invoices,
 * issued invoices, and bookkeeping. They share the derived-state helpers in
 * ./business/state.ts and the request helpers in ./business/shared.ts, so the
 * cross-cutting rules (four eyes, INVALID_DATA, gating as a read-time filter)
 * each live in one place.
 *
 * requireSession and the transfer factory are injected: server.ts owns
 * authentication and one code path builds transfers.
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
import { createBookkeepingExportRoutes } from "./business/bookkeeping-export.js";
import { createIntegrationRoutes } from "./business/integrations.js";
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
  r.use(createBookkeepingExportRoutes(deps));
  r.use(createIntegrationRoutes(deps));

  return r;
}
