/**
 * Shareable receipts.
 *
 * Redaction happens server-side. A withheld field comes back as
 * `{withheld:true}` with no value, so it cannot be recovered in devtools.
 *
 * Unlike /pay/<handle>, this link is the credential, so the slug is 15
 * Crockford characters and /api/r/ sits on the tight rate bucket.
 *
 * One live share per transfer. A link once sent never changes: sharing again
 * makes a new link with the chosen fields and turns the previous one off.
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
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;
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

/** Live: not revoked and inside its window. Only a live share is handed to
 *  the composer; an expired one keeps its slug and its 410. */
const isLive = (share: ReceiptShare): boolean =>
  !share.revokedAt && Date.parse(share.expiresAt) >= Date.now();

/**
 * Create the share for a transfer: a new slug and a new 30-day window with
 * the chosen fields. The previous unrevoked share, live or expired, is
 * revoked in the same step, so a visitor with its slug gets 410 and what a
 * sent link shows never changes. There is no edit: `edit: true` is refused.
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
      const transfer = await store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!(await requireUserSession(req, res, transfer.userId))) return;
      // Nothing has settled or moved before CREATED clears, and a receipt for a
      // transfer that may still be refused would publish an outcome that has not
      // happened yet.
      if (transfer.state === "CREATED") {
        return res.status(409).json({ error: "this transfer has not been authorised yet — nothing to share" });
      }
      // A composer from before links stopped changing sends its choice
      // changes as edits: refused, so a link already sent keeps what it shows.
      if (req.body?.edit === true) {
        return res.status(409).json({ code: "LINK_NOT_EDITABLE", error: "a link once sent does not change — create a new link with these choices; it replaces the old one" });
      }
      // Choices left out of the body are the last link's.
      const fields = parseShareFields(req.body, (await store.findReceiptShareByTransfer(transfer.id))?.fields ?? DEFAULT_SHARE_FIELDS);
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
      // The old slug stays recorded, so a later visitor gets 410 rather than a
      // typo-like 404. Read and replaced under the transfer's lock: two posts
      // at once run one after the other, and the second turns off the first's
      // link, so there is one unrevoked share per transfer (Postgres's
      // receipt_shares_live index refuses a second).
      await store.tx(async () => {
        await store.lockKey(`receipt-share:${transfer.id}`);
        const current = await store.findReceiptShareByTransfer(transfer.id);
        if (current && !current.revokedAt) await store.revokeReceiptShare(current.id);
        await store.addReceiptShare(share);
      });
      res.status(201).json(shareResponse(req, share));
    }),
  );

  router.get(
    "/transfers/:id/share",
    wrap(async (req, res) => {
      const transfer = await store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!(await requireUserSession(req, res, transfer.userId))) return;
      const share = await store.findReceiptShareByTransfer(transfer.id);
      if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
      // The dead URL is not sent: the composer would offer it as the link to
      // send. The choices are, so a new link starts from them.
      if (!isLive(share)) {
        return res.status(404).json({ error: "the link for this payment has expired", expired: true, fields: share.fields });
      }
      res.json(shareResponse(req, share));
    }),
  );

  router.delete(
    "/transfers/:id/share",
    wrap(async (req, res) => {
      const transfer = await store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!(await requireUserSession(req, res, transfer.userId))) return;
      const share = await store.findReceiptShareByTransfer(transfer.id);
      if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
      // A composer names the link it shows: one opened before a newer link
      // replaced it must not turn off a link it never showed.
      if (typeof req.body?.slug === "string" && req.body.slug !== share.slug) {
        return res.status(409).json({ code: "LINK_REPLACED", error: "that link was already replaced by a newer one, which is still on" });
      }
      res.json(shareResponse(req, await store.revokeReceiptShare(share.id)));
    }),
  );

  router.get(
    "/r/:slug",
    wrap(async (req, res) => {
      res.setHeader("cache-control", "no-store");
      // A receipt names people and amounts; keeping it out of search indexes is
      // as much a part of "share only what's needed" as the field pickers.
      res.setHeader("x-robots-tag", "noindex, nofollow");
      const share = await store.findReceiptShareBySlug(String(req.params.slug));
      if (!share) return res.status(404).json({ error: "no such receipt" });
      // Revoked before it ran out: the sender's act. One revoked only when a new
      // link replaced it after it expired reads as expired, as it was.
      if (share.revokedAt && Date.parse(share.revokedAt) < Date.parse(share.expiresAt)) {
        return res.status(410).json({ error: "the sender revoked this receipt", revoked: true });
      }
      if (share.revokedAt || Date.parse(share.expiresAt) < Date.now()) {
        return res.status(410).json({ error: "this receipt link has expired", expired: true });
      }
      const transfer = await store.findTransfer(share.transferId);
      const sender = await store.findUser(share.userId);
      if (!transfer || !sender) return res.status(404).json({ error: "no such receipt" });
      res.json(
        buildReceipt({
          slug: share.slug,
          transfer,
          sender,
          quote: await store.findQuote(transfer.quoteId),
          fields: share.fields,
          expiresAt: share.expiresAt,
        }),
      );
    }),
  );

  return router;
}
