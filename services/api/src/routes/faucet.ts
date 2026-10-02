/**
 * Testnet faucet routes (faucet.ts holds the rules).
 *
 * - POST /users/:id/faucet: an account claims its one EURe grant. The grant
 *   also fires on its own when a passkey Safe is deployed (routes/auth.ts);
 *   this is for accounts deployed before the faucet existed, and for a retry
 *   after a dry faucet. Signed-in, own account only.
 * - GET /faucet and POST /faucet/drip: the public /faucet page. No session —
 *   it funds any address, including a payer's own wallet — so the limits in
 *   faucet.ts (per address and token, per IP, per token) are the guard.
 */
import express from "express";
import { store } from "../store.js";
import { TESTNET_FAUCET } from "../config.js";
import { drip, dripTokens, faucetFundSafe } from "../faucet.js";
import { clientKey } from "../http/policy.js";
import { publicUser } from "../users/public-user.js";
import { wrap } from "./util.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface FaucetDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const STATUS = { FAUCET_OFF: 404, NO_SAFE: 409, ALREADY_GRANTED: 409, FAUCET_DRY: 503, FAUCET_FAILED: 502 } as const;
const DRIP_STATUS = {
  FAUCET_OFF: 404, BAD_ADDRESS: 400, UNKNOWN_TOKEN: 400, COOLDOWN: 429, IP_LIMIT: 429, TOKEN_LIMIT: 429, FAUCET_DRY: 503, FAUCET_FAILED: 502,
} as const;

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
  router.get("/faucet", (_req, res) => {
    const tokens = dripTokens();
    if (!tokens.length) return res.status(404).json({ error: "no faucet on this deployment", code: "FAUCET_OFF" });
    res.json({ tokens, cooldownHours: TESTNET_FAUCET.cooldownMs / 3600_000 });
  });

  router.post(
    "/faucet/drip",
    wrap(async (req, res) => {
      const { address, token } = req.body ?? {};
      const result = await drip(String(address ?? ""), String(token ?? ""), clientKey(req.ip));
      if (!result.ok) return res.status(DRIP_STATUS[result.code]).json({ error: result.error, code: result.code, retryAt: result.retryAt });
      res.status(201).json(result);
    }),
  );
  return router;
}
