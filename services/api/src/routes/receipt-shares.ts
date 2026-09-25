/**
 * Shareable receipts.
 *
 * Redaction happens server-side. A withheld field comes back as
 * `{withheld:true}` with no value, so it cannot be recovered in devtools.
 *
 * Unlike /pay/<handle>, this link is the credential, so the slug is 15
 * Crockford characters and /api/r/ sits on the tight rate bucket.
 *
 * One share per transfer. Re-posting edits it, so narrowing a selection
 * narrows the live link. An edit does not extend the 30-day window.
 */
import express from "express";
import { wrap } from "./util.js";
import { randomBytes, randomUUID } from "node:crypto";
import { PUBLIC_URL, SECURITY } from "../config.js";
import {
  buildReceipt,
  DEFAULT_SHARE_FIELDS,
  parseShareFields,
  receiptSlug,
  SHARE_TTL_DAYS,
} from "../receipt.js";
import { store, type ReceiptShare } from "../store.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface ReceiptShareDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


/* ---------------------------------------------------------------------------
 * Shareable receipts
 *
 * The slug is the only thing between a stranger and someone's transfer, so it
 * carries real entropy and the route shares the auth rate bucket.
 * ------------------------------------------------------------------------- */

/** The sender's own view of the share, with the URL to hand out. */
function shareResponse(req: express.Request, share: ReceiptShare) {
  // The Host header is caller-controlled; the first trusted origin is not.
  const base = PUBLIC_URL || SECURITY.origins[0] || `${req.protocol}://${req.get("host")}`;
  return {
    slug: share.slug,
    url: `${base}/r/${share.slug}`,
    fields: share.fields,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
  };
}

/**
 * Create or re-scope the share for a transfer.
 *
 * Re-posting edits the existing share and keeps its slug, so narrowing a
 * selection narrows what is public and links already sent keep working.
 *
 * An edit does not extend the expiry: a share is a 30-day window opened once.
 */
/** Kill the link. The slug stays recorded so a later visitor is told it was
 *  revoked rather than getting the same 404 as a typo. */
/**
 * The public payload. No session, and no user record beyond the sender's name
 * at the granularity the sender chose.
 *
 * Every refusal is a 404 of the same shape, except that a revoked or expired
 * share says which. That tells a link holder why it stopped working and tells
 * a scanner nothing new.
 */

export function createReceiptShareRouter(deps: ReceiptShareDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/transfers/:id/share",
    wrap(async (req, res) => {
      const transfer = store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, transfer.userId)) return;
      // Nothing has settled or moved before CREATED clears, and a receipt for a
      // transfer that may still be refused would publish an outcome that has not
      // happened yet.
      if (transfer.state === "CREATED") {
        return res.status(409).json({ error: "this transfer has not been authorised yet — nothing to share" });
      }
      const existing = store.findReceiptShareByTransfer(transfer.id);
      const fields = parseShareFields(req.body, existing?.fields ?? DEFAULT_SHARE_FIELDS);
      if (existing && !existing.revokedAt) {
        return res.json(shareResponse(req, store.updateReceiptShare(existing.id, { fields })));
      }
      const now = new Date();
      const share: ReceiptShare = {
        id: randomUUID(),
        slug: receiptSlug((n) => randomBytes(n)),
        transferId: transfer.id,
        userId: transfer.userId,
        fields,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      };
      // A revoked share is replaced rather than resurrected: the old slug stays
      // recorded as revoked, so a later visitor gets 410 rather than a typo-like
      // 404 while the new share gets a fresh unguessable slug.
      store.addReceiptShare(share);
      res.status(201).json(shareResponse(req, share));
    }),
  );

  router.get(
    "/transfers/:id/share",
    wrap(async (req, res) => {
      const transfer = store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, transfer.userId)) return;
      const share = store.findReceiptShareByTransfer(transfer.id);
      if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
      res.json(shareResponse(req, share));
    }),
  );

  router.delete(
    "/transfers/:id/share",
    wrap(async (req, res) => {
      const transfer = store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, transfer.userId)) return;
      const share = store.findReceiptShareByTransfer(transfer.id);
      if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
      res.json(shareResponse(req, store.revokeReceiptShare(share.id)));
    }),
  );

  router.get(
    "/r/:slug",
    wrap(async (req, res) => {
      res.setHeader("cache-control", "no-store");
      // A receipt names people and amounts; keeping it out of search indexes is
      // as much a part of "share only what's needed" as the field pickers.
      res.setHeader("x-robots-tag", "noindex, nofollow");
      const share = store.findReceiptShareBySlug(String(req.params.slug));
      if (!share) return res.status(404).json({ error: "no such receipt" });
      if (share.revokedAt) return res.status(410).json({ error: "the sender revoked this receipt", revoked: true });
      if (Date.parse(share.expiresAt) < Date.now()) {
        return res.status(410).json({ error: "this receipt link has expired", expired: true });
      }
      const transfer = store.findTransfer(share.transferId);
      const sender = store.findUser(share.userId);
      if (!transfer || !sender) return res.status(404).json({ error: "no such receipt" });
      res.json(
        buildReceipt({
          slug: share.slug,
          transfer,
          sender,
          quote: store.findQuote(transfer.quoteId),
          fields: share.fields,
          expiresAt: share.expiresAt,
        }),
      );
    }),
  );

  return router;
}
