/**
 * Managed recovery — the operator-plus-external-signer path.
 *
 * Separate from the Candide email/SMS guardian (routes/recovery-candide.ts):
 * the two are different modes on the same RecoveryRequest, and this one needs
 * a human to approve. A request may be read by its owner OR by the operator,
 * which is why both checks appear side by side rather than one standing in
 * for the other.
 */
import express from "express";
import { wrap } from "./util.js";
import { randomUUID } from "node:crypto";
import { RECOVERY } from "../config.js";
import { store } from "../store.js";
import { isOperator, operatorLabel, requireOperator } from "../http/guards.js";
import {
  approveRecoveryRequest,
  assertRecoveryAvailable,
  buildRecoveryRequest,
  isEvmAddress,
  publicRecoveryRequest,
  readinessStatus,
} from "../recovery.js";
import { submitGuardianRecovery } from "../recovery-signer.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface SessionGuard {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


function recoveryPublicList(userId: string) {
  const now = new Date();
  return store.recoveryRequestsForUser(userId)
    .map((r) => {
      const status = readinessStatus(r, now);
      if (status !== r.status) store.updateRecoveryRequest(r.id, { status });
      return publicRecoveryRequest({ ...r, status });
    })
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
}

export function createManagedRecoveryRouter(deps: SessionGuard) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.get(
    "/users/:id/recovery",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const blocked = assertRecoveryAvailable(user);
      res.json({
        managedKycGuardian: RECOVERY.managedKycGuardian,
        available: !blocked,
        blocked,
        delayHours: RECOVERY.delayHours,
        guardianAddress: user.passkeySafe?.recovery?.guardianAddress,
        recoveryModuleAddress: user.passkeySafe?.recovery?.moduleAddress,
        requests: recoveryPublicList(user.id),
      });
    }),
  );

  router.post(
    "/users/:id/recovery/requests",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const newOwnerAddress = req.body?.newOwnerAddress;
      if (newOwnerAddress !== undefined && !isEvmAddress(newOwnerAddress)) {
        return res.status(400).json({ error: "newOwnerAddress must be a 0x address" });
      }
      try {
        const request = buildRecoveryRequest(
          user,
          randomUUID(),
          new Date(),
          newOwnerAddress,
          user.email,
        );
        store.addRecoveryRequest(request);
        res.status(201).json(publicRecoveryRequest(request));
      } catch (err: any) {
        res.status(409).json({ error: String(err?.message ?? err) });
      }
    }),
  );

  router.post(
    "/recovery/requests",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const user = store.findUser(req.body?.userId);
      if (!user) return res.status(404).json({ error: "user not found" });
      const newOwnerAddress = req.body?.newOwnerAddress;
      if (newOwnerAddress !== undefined && !isEvmAddress(newOwnerAddress)) {
        return res.status(400).json({ error: "newOwnerAddress must be a 0x address" });
      }
      const contact = typeof req.body?.contact === "string" ? req.body.contact.slice(0, 120) : user.email;
      try {
        const request = buildRecoveryRequest(user, randomUUID(), new Date(), newOwnerAddress, contact);
        store.addRecoveryRequest(request);
        console.log(`RECOVERY: request ${request.id} opened for ${user.id} by ${operatorLabel(req)}`);
        res.status(201).json(publicRecoveryRequest(request));
      } catch (err: any) {
        res.status(409).json({ error: String(err?.message ?? err) });
      }
    }),
  );

  router.post(
    "/recovery/requests/:id/approve",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const request = store.findRecoveryRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "recovery request not found" });
      const user = store.findUser(request.userId);
      if (!user) return res.status(404).json({ error: "user not found" });
      const blocked = assertRecoveryAvailable(user);
      if (blocked) return res.status(409).json({ error: blocked });
      try {
        const approved = approveRecoveryRequest(
          request,
          new Date(),
          operatorLabel(req),
          typeof req.body?.reason === "string" ? req.body.reason : undefined,
        );
        const updated = store.updateRecoveryRequest(request.id, approved);
        console.log(`RECOVERY: request ${request.id} approved; ready at ${updated.readyAt}`);
        res.json(publicRecoveryRequest(updated));
      } catch (err: any) {
        res.status(409).json({ error: String(err?.message ?? err) });
      }
    }),
  );

  router.post(
    "/recovery/requests/:id/cancel",
    wrap(async (req, res) => {
      const request = store.findRecoveryRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "recovery request not found" });
      if (!isOperator(req) && !requireUserSession(req, res, request.userId)) return;
      if (["FINALIZED", "CANCELED", "EXPIRED", "GUARDIAN_SUBMITTED"].includes(request.status)) {
        return res.status(409).json({ error: `recovery request is ${request.status}` });
      }
      const updated = store.updateRecoveryRequest(request.id, {
        status: "CANCELED",
        canceledAt: new Date().toISOString(),
        cancelReason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
      });
      res.json(publicRecoveryRequest(updated));
    }),
  );

  router.post(
    "/recovery/requests/:id/guardian-submit",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      let request = store.findRecoveryRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "recovery request not found" });
      const status = readinessStatus(request, new Date());
      if (status !== request.status) request = store.updateRecoveryRequest(request.id, { status });
      try {
        const guardianSubmission = await submitGuardianRecovery(request, new Date());
        const updated = store.updateRecoveryRequest(request.id, {
          status: "GUARDIAN_SUBMITTED",
          guardianSubmission,
        });
        console.log(`RECOVERY: guardian signer accepted request ${request.id}`);
        res.json(publicRecoveryRequest(updated));
      } catch (err: any) {
        const message = String(err?.message ?? err);
        const statusCode = message.includes("RECOVERY_GUARDIAN_SIGNER_URL") ? 503 : 409;
        const updated = store.updateRecoveryRequest(request.id, {
          guardianSubmission: {
            mode: "external_signer",
            requestedAt: new Date().toISOString(),
            error: message.slice(0, 240),
          },
        });
        res.status(statusCode).json({ ...publicRecoveryRequest(updated), error: message });
      }
    }),
  );

  router.get(
    "/recovery/requests/:id",
    wrap(async (req, res) => {
      const request = store.findRecoveryRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "recovery request not found" });
      if (!isOperator(req) && !requireUserSession(req, res, request.userId)) return;
      const status = readinessStatus(request, new Date());
      const latest = status === request.status ? request : store.updateRecoveryRequest(request.id, { status });
      res.json({
        ...publicRecoveryRequest(latest),
        guardianAction:
          latest.status === "READY_FOR_GUARDIAN"
            ? "POST /api/recovery/requests/:id/guardian-submit to hand off to the isolated guardian signer"
            : latest.status === "GUARDIAN_SUBMITTED"
              ? "guardian signer accepted the recovery handoff; watch the on-chain SocialRecoveryModule recovery state"
            : undefined,
      });
    }),
  );

  return router;
}
