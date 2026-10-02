/**
 * Testnet faucet route: an account claims its one EURe grant. The grant also
 * fires on its own when a passkey Safe is deployed (routes/auth.ts); this
 * route is for accounts deployed before the faucet existed, and for a retry
 * after a dry faucet. Off on every deployment where faucetEnabled() is false.
 */
import express from "express";
import { store } from "../store.js";
import { faucetFundSafe } from "../faucet.js";
import { publicUser } from "../users/public-user.js";
import { wrap } from "./util.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface FaucetDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const STATUS = { FAUCET_OFF: 404, NO_SAFE: 409, ALREADY_GRANTED: 409, FAUCET_DRY: 503, FAUCET_FAILED: 502 } as const;

export function createFaucetRouter({ requireUserSession }: FaucetDeps) {
  const router = express.Router();
  router.post(
    "/users/:id/faucet",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const result = await faucetFundSafe(user.id);
      if (!result.ok) return res.status(STATUS[result.code]).json({ error: result.error, code: result.code });
      res.status(201).json({ ...result, user: publicUser(store.findUser(user.id)!) });
    }),
  );
  return router;
}
