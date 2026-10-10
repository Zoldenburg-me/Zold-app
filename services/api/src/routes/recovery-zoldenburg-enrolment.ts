/**
 * The 1 € enrolment that arms Zoldenburg as guardian
 * (recovery/zoldenburg-enrolment.ts), for the account holder.
 *
 * GET   /users/:id/recovery/zoldenburg/enrolment        what is armed or open
 * POST  /users/:id/recovery/zoldenburg/enrolment        a new code (passkey step-up)
 * POST  /users/:id/recovery/zoldenburg/enrolment/check  look for the payment now
 *
 * All three sit on the auth rate bucket (http/policy.ts). A new code needs a
 * fresh passkey approval every time: re-enrolling changes the bank account a
 * recovery must be paid from, which a stolen session must not be able to do.
 */
import express from "express";
import { store, type User } from "../store.js";
import { verifyPasskeyStepUp } from "./auth.js";
import { hasZoldenburgGuardian } from "./recovery-zoldenburg.js";
import {
  ENROLMENT,
  checkEnrolment,
  enrolmentAvailable,
  enrolmentView,
  issueEnrolmentCode,
} from "../recovery/zoldenburg-enrolment.js";

export interface ZoldenburgEnrolmentDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

export function createZoldenburgEnrolmentRouter(deps: ZoldenburgEnrolmentDeps) {
  const router = express.Router();
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

  const userFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!deps.requireUserSession(req, res, user.id)) return undefined;
    return user;
  };

  /** Why this account cannot enrol yet, or null. */
  const refusal = (user: User): [number, string, string] | null => {
    if (!enrolmentAvailable()) return [503, "ENROLMENT_UNAVAILABLE", "Zoldenburg recovery cannot be finished on this server yet."];
    if (!hasZoldenburgGuardian(user)) return [409, "NO_GUARDIAN", "Add Zoldenburg as your recovery guardian first."];
    if (user.kycStatus !== "approved" || !user.iban) return [409, "IBAN_NOT_ACTIVE", "Activate your IBAN first: the 1 € is sent to it."];
    return null;
  };

  router.get(
    "/users/:id/recovery/zoldenburg/enrolment",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      res.json(enrolmentView(user));
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/enrolment",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const no = refusal(user);
      if (no) return res.status(no[0]).json({ error: no[2], code: no[1] });
      if (!(await verifyPasskeyStepUp(user, req.body, res, "recovery.enrolment"))) return;
      const { code, memo } = issueEnrolmentCode(user);
      const fresh = store.findUser(user.id)!;
      res.status(201).json({ ...enrolmentView(fresh), code, memo, payTo: { iban: fresh.iban, name: fresh.name } });
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/enrolment/check",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const last = user.zoldenburgEnrolment?.lastCheck?.at;
      // Monerium is asked at most every checkEveryMs per account; a faster
      // click gets the last answer.
      if (!last || Date.now() - Date.parse(last) >= ENROLMENT.checkEveryMs) await checkEnrolment(user.id);
      res.json(enrolmentView(store.findUser(user.id)!));
    }),
  );

  return router;
}
