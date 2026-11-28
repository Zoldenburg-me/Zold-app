/**
 * Two operator actions on one user, for requests that reach support by mail.
 * The operator gate (operators/gate.ts) has already taken a fresh passkey
 * approval for the exact request and written its audit row.
 *
 * - Delete: a GDPR erasure (store.deleteUser). The Safe and its funds are on
 *   chain and stay the user's; the dashboard shows the Safe address before
 *   the operator confirms, so support can tell the user where the money is.
 * - Change email: takes effect at once and unconfirmed, so the user confirms
 *   it with the code flow (routes/email-verification.ts). The old address is
 *   told. The Candide recovery channel and the Monerium login keep their own
 *   addresses: those live at the providers.
 */
import express from "express";
import { wrap } from "./util.js";
import { store } from "../store.js";
import { requireOperator } from "../http/guards.js";
import { emailLockKey, emailLooksValid } from "../domain/email.js";
import { mailAvailable, sendEmailChangedNotice } from "../adapters/mailer.js";
import { describeCause } from "../http/log-cause.js";

export function createAdminUsersRouter() {
  const router = express.Router();

  router.delete(
    "/admin/users/:id",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const result = await store.deleteUser(String(req.params.id));
      if (result.ok) return res.json({ deleted: true });
      if (result.code === "NOT_FOUND") return res.status(404).json({ error: "user not found" });
      if (result.code === "IN_FLIGHT") {
        const { transferIds, cryptoSendIds, recoveryIds } = result;
        return res.status(409).json({
          error: "This user has work in flight that still reads the account: a signed or moving transfer (a MANUAL_REVIEW one is closed on the Transactions page), a submitted crypto send or an open recovery. Let it finish or resolve it first.",
          code: "IN_FLIGHT",
          transferIds, cryptoSendIds, recoveryIds,
        });
      }
      return res.status(409).json({
        error: "This user is the last owner of an organisation with other members. Make another member an owner first.",
        code: "LAST_OWNER",
        orgIds: result.orgIds,
      });
    }),
  );

  router.post(
    "/admin/users/:id/email",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!emailLooksValid(email)) return res.status(400).json({ error: "a valid email address is required" });
      // The lock and the duplicate check sit in one transaction with the
      // write, as at signup and first passkey (routes/auth.ts).
      const outcome = await store.tx(async () => {
        const user = await store.lockUser(String(req.params.id));
        if (!user) return { status: 404 as const };
        const before = user.email?.trim().toLowerCase();
        if (before === email) return { status: 409 as const, code: "SAME_EMAIL" };
        await store.lockKey(emailLockKey(email));
        if ((await store.usersByEmail(email)).some((u) => u.id !== user.id)) return { status: 409 as const, code: "EMAIL_IN_USE" };
        await store.updateUser(user.id, { email, emailVerifiedAt: undefined, emailCode: undefined });
        return { status: 200 as const, before };
      });
      if (outcome.status === 404) return res.status(404).json({ error: "user not found" });
      if (outcome.status === 409) {
        return res.status(409).json(
          outcome.code === "SAME_EMAIL"
            ? { error: "That is already this account's email.", code: "SAME_EMAIL" }
            : { error: "Another account already uses this email.", code: "EMAIL_IN_USE" },
        );
      }
      let noticeSent = false;
      if (outcome.before && mailAvailable()) {
        // The change stands either way; the dashboard says whether the notice went.
        noticeSent = await sendEmailChangedNotice(outcome.before).then(
          () => true,
          (err) => (console.error(`email-change notice failed: ${describeCause(err)}`), false),
        );
      }
      res.json({ email, noticeSent });
    }),
  );

  return router;
}
