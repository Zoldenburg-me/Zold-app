/**
 * GET /api/orgs/:orgId/safe: a company org's own Safe, read from chain on
 * every visit (wallet/org-signers.ts). Every member who may read accounts
 * sees its owners, the threshold, and each owner member's signer status; only
 * this org's members are named.
 *
 * Answers:
 *  - 200 { state: "not_set_up" } before the Safe is deployed;
 *  - 200 { state: "set_up", safeAddress, chainId, threshold, owners,
 *    unknown, members } (domain/org-signers.ts);
 *  - 409 NOT_A_COMPANY for a personal or sole_trader org, whose account is a
 *    member's own Safe (/users/:id/safe/signers), and ORG_SAFE_UNREADABLE;
 *  - 502 SAFE_UNREADABLE when the chain cannot be read: never an empty
 *    owner set.
 */
import express from "express";
import { OrgSafePlanRefusal } from "../../domain/org-safe-plan.js";
import { CANDIDE } from "../../wallet/candide.js";
import { liveOrgSafeReader, readOrgSafe, type OrgSafeReader } from "../../wallet/org-signers.js";
import { requirePermission } from "../org-context.js";
import { wrap } from "../util.js";
import { redactedMessage } from "../../http/log-cause.js";
import type { OrgRoutes } from "./drafts.js";

export function createOrgSafeRoutes(deps: OrgRoutes, reader: OrgSafeReader = liveOrgSafeReader): express.Router {
  const r = express.Router();

  r.get(
    "/:orgId/safe",
    wrap(async (req, res) => {
      const ctx = await deps.ctxOf(req, res);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "accounts.read")) return;
      let view;
      try {
        view = await readOrgSafe(ctx.org, reader);
      } catch (err) {
        if (err instanceof OrgSafePlanRefusal) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error(`org Safe read failed for ${ctx.org.id}: ${redactedMessage(err)}`);
        return res.status(502).json({ error: "Couldn’t check the company’s Safe on chain, so Zold can’t say who signs for it. This is not the same as no one.", code: "SAFE_UNREADABLE" });
      }
      res.json(view.state === "set_up" ? { ...view, chainId: Number(CANDIDE.chainId) } : view);
    }),
  );

  return r;
}
