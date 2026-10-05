/**
 * The payment page: claiming a handle, and what a stranger may read about one.
 *
 * Handles are discoverable: 200 versus 404 tells a caller whether one is
 * claimed, and handles are short and readable. That cannot change while the
 * link is meant to be shared, so the page tells the payee.
 *
 * Claiming is gated on the passkey Safe, not on KYC: a public page may exist
 * before review, but only once the Safe exists on-chain and is the account of
 * record. Settlement and conversion apply their own gates later.
 */
import express from "express";
import { usdToken } from "../usd-token.js";
import { wrap } from "./util.js";
import { CHAIN_ID } from "../config.js";
import { addrs } from "../chain.js";
import { isDeployed } from "../wallet/candide.js";
import { activatePaymentForwarder } from "../adapters/candide-forwarder.js";
import { HandleError, normaliseDisplayName, normaliseHandle, publicOrgPayee, publicPayee } from "../pay.js";
import { orgPageAccount } from "./business/org-payment-page.js";
import { qrSvg } from "../qr.js";
import { store, type User } from "../store.js";
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
export function payChain() {
  return {
    chainId: CHAIN_ID,
    token: { symbol: usdToken().symbol, address: addrs().usdc, decimals: 6 },
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
 * Public payee lookup. No session, since a payment link is for strangers.
 *
 * The response comes from publicPayee, which is an allowlist (see pay.ts).
 *
 * Handles are enumerable (see the header). The page tells the payee that
 * anyone who knows or guesses the handle can find the address.
 */
/** The QR image, rendered server-side. Carries the bare address: see the note
 *  in pay.ts on why the EIP-681 URI is a link instead. */

/** Renew a Candide activation this long before it lapses. */
const RENEW_BEFORE_MS = 24 * 3600 * 1000;
/** After a failed renewal, wait this long before asking Candide again. Every
 *  public GET lands here, so without it a Candide outage is retried per hit. */
export const RENEW_RETRY_MS = 5 * 60 * 1000;
const renewing = new Map<string, Promise<boolean>>();
/** Per user: until when not to retry, and whether the last renewal moved the
 *  address (then the page stays closed, whatever the old activation says). */
const renewFailed = new Map<string, { until: number; addressMoved: boolean }>();

/**
 * May this page's deposit address be shown to a payer right now? A Candide
 * activation lapses after a TTL, and an address shown past it takes deposits
 * that are never forwarded. So it is renewed (idempotent at Candide, same
 * address) when close to lapsing, which also refreshes the token list.
 *
 * A page whose token list was not read from Candide's routes (no
 * `routesReadAt`: the hard-coded EURe + USDC of older pages) is renewed on
 * first read, because Candide forwards only what its routes list and an EURe
 * deposit to the forwarder is stranded. Until that renewal succeeds the page
 * is closed.
 *
 * A failed renewal still answers yes while the old activation runs and its
 * list came from the routes; once it has lapsed the answer is no, and the
 * caller shows no address. Failures back off for RENEW_RETRY_MS.
 */
export async function livePaymentPage(user: User): Promise<boolean> {
  const page = user.paymentPage;
  const f = page?.forwarder;
  if (!page || !f || f.provider !== "candide") return true;
  const listed = !!page.routesReadAt;
  const expires = f.expiresAt ? Date.parse(f.expiresAt) : Number.POSITIVE_INFINITY;
  if (listed && expires - Date.now() > RENEW_BEFORE_MS) return true;
  const failed = renewFailed.get(user.id);
  if (failed && failed.until > Date.now()) return !failed.addressMoved && listed && expires > Date.now();
  let run = renewing.get(user.id);
  if (!run) {
    run = (async () => {
      try {
        const next = await activatePaymentForwarder({ userId: user.id, handle: page.handle, recipient: f.recipient, token: addrs().usdc });
        if (next.address.toLowerCase() !== page.depositAddress.toLowerCase()) {
          console.error(`payment page: renewal for ${user.id} gave ${next.address}, page shows ${page.depositAddress}`);
          renewFailed.set(user.id, { until: Date.now() + RENEW_RETRY_MS, addressMoved: true });
          return false;
        }
        renewFailed.delete(user.id);
        const fresh = store.findUser(user.id);
        if (fresh?.paymentPage?.handle !== page.handle) return false;
        const now = new Date().toISOString();
        store.updateUser(user.id, {
          paymentPage: { ...fresh.paymentPage, forwarder: next.forwarder, supportedTokens: next.accepts, routesReadAt: now, updatedAt: now },
        });
        return true;
      } catch (err: any) {
        console.error(`payment page: renewing forwarder for ${user.id} failed: ${err?.message ?? err}`);
        renewFailed.set(user.id, { until: Date.now() + RENEW_RETRY_MS, addressMoved: false });
        return listed && expires > Date.now();
      } finally {
        renewing.delete(user.id);
      }
    })();
    renewing.set(user.id, run);
  }
  return run;
}

const PAGE_CLOSED = {
  error: "This payment page can't take payments just now. Try again in a few minutes.",
  code: "PAGE_UNAVAILABLE",
};

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
      if ((taken && taken.id !== user.id) || store.findOrgByHandle(handle)) {
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
      const now = new Date().toISOString();
      const existing = user.paymentPage;
      let forwarder: Awaited<ReturnType<typeof activatePaymentForwarder>>;
      try {
        forwarder = await activatePaymentForwarder({
          userId: user.id,
          handle,
          recipient: user.address,
          token: addrs().usdc,
        });
      } catch (err: any) {
        // The forwarding address is set up at a partner and on chain: its
        // failure is "try again", not ours to report as a 500.
        console.error(`payment page: forwarder for ${user.id} failed: ${err?.message ?? err}`);
        return res.status(503).json({
          error: `The address that receives ${usdToken().symbol} for your page could not be set up just now. Nothing was saved; try again in a minute.`,
          code: "FORWARDER_UNAVAILABLE",
        });
      }
      // The partner round trip above yields the event loop, so another claim
      // of the same handle can land while this one waits. Handle uniqueness
      // is a check-then-write invariant: re-assert it in the same synchronous
      // window as the write (the claimAuthorization / holdDailyCap pattern).
      const takenNow = store.findUserByHandle(handle);
      if ((takenNow && takenNow.id !== user.id) || store.findOrgByHandle(handle)) {
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
          supportedTokens: forwarder.accepts,
          routesReadAt: now,
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
      if (!user?.paymentPage?.handle) {
        // An organisation's page: bank details of its euro account, or closed
        // while no active account has an IBAN on the company's own profile.
        const org = store.findOrgByHandle(req.params.handle);
        if (!org) return res.status(404).json({ error: "no such payment page" });
        const page = orgPageAccount(org);
        if ("reason" in page) return res.status(503).json(PAGE_CLOSED);
        return res.json(publicOrgPayee(org, page.account, page.holder));
      }
      if (!(await livePaymentPage(user))) return res.status(503).json(PAGE_CLOSED);
      res.json(publicPayee(store.findUser(user.id) ?? user, payChain()));
    }),
  );

  /** The account's own Safe address as a QR, for the in-app receive screen.
   *  Signed-in only: unlike a payment page, this address is not published. */
  router.get(
    "/users/:id/address/qr.svg",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (user.passkeySafe?.status !== "active") return res.status(409).json({ error: "this account has no wallet address yet" });
      res.type("image/svg+xml");
      res.setHeader("cache-control", "private, no-store");
      res.send(qrSvg(user.address));
    }),
  );

  router.get(
    "/pay/:handle/qr.svg",
    wrap(async (req, res) => {
      const user = store.findUserByHandle(req.params.handle);
      if (!user?.paymentPage?.handle) return res.status(404).json({ error: "no such payment page" });
      if (!(await livePaymentPage(user))) return res.status(503).json(PAGE_CLOSED);
      res.type("image/svg+xml");
      res.setHeader("cache-control", "public, max-age=300");
      res.send(qrSvg(publicPayee(user, payChain()).address));
    }),
  );

  return router;
}
