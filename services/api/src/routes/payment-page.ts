/**
 * The payment page: claiming a handle, and what a stranger may read about one.
 *
 * A HANDLE IS DISCOVERABLE, AND THE PAGE SAYS SO. 200 versus 404 tells a
 * caller whether a handle is claimed, and handles are short and human-readable
 * by design. That is true of every username system and is not fixable while
 * the link is meant to be shared, so the honest response is to state it rather
 * than imply the link is a secret.
 *
 * Claiming is passkey-Safe gated, NOT KYC-gated: a public page may exist
 * before review, but only once the Safe exists on-chain and is the account of
 * record. Settlement and conversion apply their own gates later.
 */
import express from "express";
import { wrap } from "./util.js";
import { CHAIN_ID } from "../config.js";
import { addrs } from "../chain.js";
import { isDeployed } from "../wallet/candide.js";
import { activatePaymentForwarder } from "../adapters/candide-forwarder.js";
import { HandleError, normaliseDisplayName, normaliseHandle, publicPayee } from "../pay.js";
import { qrSvg } from "../qr.js";
import { store } from "../store.js";
import { publicUser } from "../users/public-user.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface PaymentPageDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


function normaliseSettlementAsset(raw: unknown): "EURE" | "USDC" {
  if (raw === undefined || raw === null || raw === "") return "EURE";
  if (typeof raw !== "string") throw new HandleError("settlementAsset must be EURE or USDC");
  const asset = raw.trim().toUpperCase();
  if (asset !== "EURE" && asset !== "USDC") throw new HandleError("settlementAsset must be EURE or USDC");
  return asset;
}

/** The chain and token a payment page asks payers to use. USDC because that is
 *  what the crypto-in converter knows how to turn into spendable euros. */
function payChain() {
  return {
    chainId: CHAIN_ID,
    token: { symbol: "USDC", address: addrs().usdc, decimals: 6 },
  };
}

/**
 * Claim or change the account's payment handle.
 *
 * Passkey-Safe gated, not KYC-gated. A user can activate a public payment page
 * before review, but only after their Safe exists on-chain and is the account
 * of record. Settlement/conversion can still apply its own compliance gates.
 */
/**
 * Public payee lookup. No session: this is the point of a payment link.
 *
 * The response comes from publicPayee, which is an allowlist — see pay.ts.
 *
 * Handles ARE enumerable, and pretending otherwise would be worse than the
 * fact: 200 versus 404 tells a caller whether a handle is claimed, and handles
 * are short and human-readable by design. That is true of every username
 * system and is not fixable while the link is meant to be shared, so the
 * honest response is to say it — the page tells the payee that anyone who
 * knows OR GUESSES the handle can find the address, rather than implying the
 * link is a secret.
 */
/** The QR image, rendered server-side. Carries the bare address: see the note
 *  in pay.ts on why the EIP-681 URI is a link instead. */

export function createPaymentPageRouter(deps: PaymentPageDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/users/:id/handle",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      let handle: string;
      let displayName: string | undefined;
      let settlementAsset: "EURE" | "USDC";
      try {
        handle = normaliseHandle(req.body?.handle);
        displayName = normaliseDisplayName(req.body?.displayName);
        settlementAsset = normaliseSettlementAsset(req.body?.settlementAsset);
      } catch (e: any) {
        if (e instanceof HandleError) return res.status(400).json({ error: e.message });
        throw e;
      }
      const taken = store.findUserByHandle(handle);
      if (taken && taken.id !== user.id) {
        return res.status(409).json({ error: `"${handle}" is already taken` });
      }
      if (
        user.passkeySafe?.status !== "active" ||
        user.address.toLowerCase() !== user.passkeySafe.address.toLowerCase() ||
        !(await isDeployed(user.address))
      ) {
        return res.status(409).json({
          error: "deploy and activate the passkey Safe before activating a payment page",
        });
      }
      const forwarder = await activatePaymentForwarder({ userId: user.id, handle, recipient: user.address });
      // The check above ran before two awaits. A second account can claim the
      // same handle in that window, and findUserByHandle returns the earlier
      // row — so the later write would silently lose /pay/:handle to whoever
      // got there first. Re-check with nothing awaited between here and the
      // write, which is the same synchronous-claim shape as claimAuthorization.
      const raced = store.findUserByHandle(handle);
      if (raced && raced.id !== user.id) {
        return res.status(409).json({ error: `"${handle}" is already taken` });
      }
      const now = new Date().toISOString();
      const fresh = store.findUser(user.id)!;
      const existing = fresh.paymentPage;
      const tokens = [
        { chainId: CHAIN_ID, symbol: "EURE" as const, address: addrs().eure, decimals: 18 },
        { chainId: CHAIN_ID, symbol: "USDC" as const, address: addrs().usdc, decimals: 6 },
      ];
      // The partner round trip above yields the event loop, so another claim
      // of the same handle can land while this one waits. Handle uniqueness
      // is a check-then-write invariant: re-assert it in the same synchronous
      // window as the write (the claimAuthorization / holdDailyCap pattern).
      const takenNow = store.findUserByHandle(handle);
      if (takenNow && takenNow.id !== user.id) {
        return res.status(409).json({ error: `"${handle}" is already taken` });
      }
      const updated = store.updateUser(user.id, {
        handle: undefined,
        payDisplayName: undefined,
        autoConvert: undefined,
        paymentPage: {
          handle,
          displayName,
          depositAddress: forwarder.address,
          recipientAddress: user.address,
          forwarder: forwarder.forwarder,
          supportedTokens: tokens,
          settlementAsset,
          autoConvert: existing?.autoConvert ?? false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
      });
      res.json({
        handle: updated.paymentPage!.handle,
        displayName: updated.paymentPage!.displayName,
        payUrl: `/pay/${handle}`,
        paymentPage: publicUser(updated).paymentPage,
      });
    }),
  );

  router.get(
    "/pay/:handle",
    wrap(async (req, res) => {
      const user = store.findUserByHandle(req.params.handle);
      if (!user?.paymentPage?.handle) return res.status(404).json({ error: "no such payment page" });
      res.json(publicPayee(user, payChain()));
    }),
  );

  router.get(
    "/pay/:handle/qr.svg",
    wrap(async (req, res) => {
      const user = store.findUserByHandle(req.params.handle);
      if (!user?.paymentPage?.handle) return res.status(404).json({ error: "no such payment page" });
      res.type("image/svg+xml");
      res.setHeader("cache-control", "public, max-age=300");
      res.send(qrSvg(publicPayee(user, payChain()).address));
    }),
  );

  return router;
}
