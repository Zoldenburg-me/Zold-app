/**
 * /api/orgs/:orgId/recovery: Zoldenburg as the recovery guardian of a
 * company's own Safe (wallet/org-recovery.ts).
 *
 *  - GET: every member who may read accounts. The module read from chain on
 *    every visit: { state, available, guardian, moduleEnabled, guardians,
 *    guardianOnChain, otherGuardians, pendingRecovery, armed: false,
 *    setupOp, queueOpen, ... }.
 *    502 RECOVERY_UNREADABLE when the chain cannot be read: never "none".
 *  - POST /guardian: an owner queues the setup op for the owners to sign at
 *    /orgs/:orgId/safe-ops. 201 with the op when queued; 200 with the open op,
 *    or with no op when the guardian is already on chain.
 *
 * 409 NOT_A_COMPANY for a personal or sole_trader org, whose recovery is a
 * member's own (/users/:id/recovery/zoldenburg).
 */
import express from "express";
import { OrgSafePlanRefusal } from "../../domain/org-safe-plan.js";
import { SafeVerifierMissingError } from "../../wallet/candide.js";
import { OrgRecoveryRefusal, liveOrgRecoveryChain, queueOrgGuardianSetup, readOrgRecovery, type OrgRecoveryChain } from "../../wallet/org-recovery.js";
import type { OrgDebitPrepare } from "../../wallet/org-debit.js";
import type { OrgSafeReader } from "../../wallet/org-signers.js";
import { requirePermission } from "../org-context.js";
import { wrap } from "../util.js";
import { redactedMessage } from "../../http/log-cause.js";
import { publicSafeOp } from "./safe-ops.js";
import type { OrgRoutes } from "./drafts.js";

const UNREADABLE = { error: "Couldn’t check the company’s Safe’s recovery on chain. This is not the same as no guardian.", code: "RECOVERY_UNREADABLE" };

export function createOrgRecoveryRoutes(
  deps: OrgRoutes,
  opts: { chain?: OrgRecoveryChain; orgSafeReader?: OrgSafeReader; prepare?: OrgDebitPrepare } = {},
): express.Router {
  const r = express.Router();
  const chain = opts.chain ?? liveOrgRecoveryChain;

  r.get(
    "/:orgId/recovery",
    wrap(async (req, res) => {
      const ctx = await deps.ctxOf(req, res);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "accounts.read")) return;
      try {
        res.json(await readOrgRecovery(ctx.org, chain));
      } catch (err) {
        if (err instanceof OrgSafePlanRefusal) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error(`org recovery read failed for ${ctx.org.id}: ${redactedMessage(err)}`);
        res.status(502).json(UNREADABLE);
      }
    }),
  );

  r.post(
    "/:orgId/recovery/guardian",
    wrap(async (req, res) => {
      const ctx = await deps.ctxOf(req, res);
      if (!ctx) return;
      let out;
      try {
        out = await queueOrgGuardianSetup({ org: ctx.org, member: ctx.member, chain, ...(opts.orgSafeReader ? { orgSafeReader: opts.orgSafeReader } : {}), ...(opts.prepare ? { prepare: opts.prepare } : {}) });
      } catch (err) {
        if (err instanceof OrgRecoveryRefusal || err instanceof OrgSafePlanRefusal || err instanceof SafeVerifierMissingError) {
          return res.status((err as OrgRecoveryRefusal).status).json({ error: err.message, code: (err as OrgRecoveryRefusal).code });
        }
        console.error(`org recovery setup failed for ${ctx.org.id}: ${redactedMessage(err)}`);
        return res.status(502).json({ error: "Couldn’t prepare adding the guardian. Nothing was queued.", code: "PREPARE_FAILED" });
      }
      res.status(out.created ? 201 : 200).json({
        op: out.op ? (await publicSafeOp(out.op)) : null,
        ...(out.created ? { note: "Queued: adding Zoldenburg as the guardian is waiting for the owners’ signatures." } : {}),
      });
    }),
  );

  return r;
}
