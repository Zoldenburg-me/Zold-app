import express from "express";
import { API_HOST, API_PORT, BRIDGE, CRYPTO_IN, CUSTODY, LIQUIDITY, PAYMENT_REQUESTS, RECOVERY, moneriumSandboxEnabled, SECURITY } from "./config.js";
import { initStore } from "./store.js";
import {
  moneriumApiKeysAvailable,
  moneriumEnvironment,
  } from "./adapters/monerium-connection.js";
import {
  checkConnection,
  startDepositPoller,
} from "./adapters/monerium-sandbox.js";
import {
  sweepAnchorPayouts,
  sweepStrandedTransfers,
  } from "./orchestrator.js";
import {
  startCryptoDepositPoller,
  } from "./adapters/crypto-deposits.js";
import { buildTransferFromQuote } from "./transfers/build.js";
import { createAuthRouter } from "./routes/auth.js";
import { createTransferRouter } from "./routes/transfers.js";
import { createMoneriumWebhookRouter } from "./routes/monerium-webhook.js";
import { createMoneriumRouter } from "./routes/monerium.js";
import { createAdminRouter } from "./routes/admin.js";
import { createManagedRecoveryRouter } from "./routes/recovery-managed.js";
import { createPageRouter } from "./routes/pages.js";
import { createUserRouter } from "./routes/users.js";
import { createCryptoDepositRouter } from "./routes/crypto-deposits.js";
import { createPaymentPageRouter } from "./routes/payment-page.js";
import { createReceiptShareRouter } from "./routes/receipt-shares.js";
import { capabilities } from "./capabilities.js";
import { publicUser } from "./users/public-user.js";
import { apiRateLimit, originPolicy, securityHeaders } from "./http/policy.js";
import {
  requireSession,
  requireUserSession,
  } from "./http/sessions.js";
import { createOrgRouter } from "./routes/orgs.js";
import { createBusinessRouter, createInvoiceLinkRouter } from "./routes/business.js";
import { createGnosisPayRouter } from "./routes/gnosis-pay.js";
import { formatReport, reconcile } from "./reconcile.js";
import { createCandideRecoveryRouter, sweepCandideRecoveries } from "./routes/recovery-candide.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createPaymentRequestRouter, onPaymentRequestPaid, sweepPaymentRequests } from "./routes/payment-requests.js";
import { createShopifyRouter, resolveShopifyRequest } from "./routes/shopify.js";
import { candideRecoveryEnabled } from "./recovery/candide-guardian.js";
import {
  addrs,
  assertChainMatches,
  warnIfSmartAccountChainDiffers,
  publicClient,
  } from "./chain.js";
import {
  CANDIDE,
  } from "./wallet/candide.js";
const app = express();
// Keep the raw body around for webhook signature checks — HMAC has to run
// over the exact bytes sent, not a re-serialised object.
app.use(express.json({
  limit: SECURITY.jsonBodyLimit,
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

// FP1: origin policy + per-IP rate limiting live in http/policy.ts — the
// outermost thing every request passes through, readable in one place.
app.use(securityHeaders);
app.use(originPolicy);

// Where the client address comes from. Default 0 = the socket peer, correct
// only with nothing in front; behind a proxy that address is the proxy, so every
// caller shares one bucket and one client can rate-limit the whole service.
app.set("trust proxy", SECURITY.trustedProxyHops);

app.use("/api", apiRateLimit);
// Pages and static assets, declared before the API routers so nothing under
// /api can be shadowed by a file on disk.
app.use(createPageRouter());

/**
 * The organisation domain (docs/business-accounts.md).
 *
 * Mounted as routers taking `requireSession` rather than importing the app, so
 * this file stays the single owner of authentication — a route module cannot
 * quietly acquire a second way to decide who is calling. Both sit under /api,
 * so they inherit the rate limiting and the auth-window middleware above.
 *
 * The invoice-link router is deliberately NOT session-guarded: it is reached by
 * a supplier who has no account, holding only the one-time token. Its
 * responses go through an allowlist view for that reason.
 */
app.use("/api/orgs", createOrgRouter(requireSession));
app.use("/api/orgs", createBusinessRouter(requireSession, buildTransferFromQuote));
app.use("/api/invoice-links", createInvoiceLinkRouter());
app.use("/api/gnosis-pay", createGnosisPayRouter(requireSession));

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);


app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const block = await publicClient.getBlockNumber();
    res.json({ ok: true, block: Number(block), contracts: addrs(), capabilities: capabilities() });
  }),
);

/**
 * Public mid rates, so the marketing page can show the same number the product
 * would quote instead of baking its own constants in — a hardcoded figure
 * under a "real exchange rate" label goes stale in the shop window. No auth:
 * this is a public reference rate, not per-user pricing, and it carries no
 * spread or fee.
 */
app.get(
  "/api/rates",
  wrap(async (_req, res) => {
    const { midRates } = await import("./rates.js");
    try {
      const r = await midRates();
      res.json({ eur: r.eur, asOf: r.asOf, provider: r.provider });
    } catch (e: any) {
      // Say so rather than serving a number nobody can stand behind.
      res.status(503).json({ error: e?.message ?? "rates unavailable" });
    }
  }),
);

// --- Users ------------------------------------------------------------------

const sandbox = moneriumSandboxEnabled();

// Email/SMS recovery through Candide's guardian. Mounted at /api so its
// no-session half sits under /recovery, which the limiter above already
// treats as an auth route.
app.use("/api", createCandideRecoveryRouter({ requireUserSession, publicUser }));
// Account documents: receipts, statements, balance and ownership letters, each
// verifiable at /v/<code>. The page is the record; the PDF is its print.
app.use("/api", createDocumentsRouter({ requireUserSession }));
// Payment requests (pay links): an amount asked for at /pay/<handle>/<code>,
// payable by USDC, by SEPA with the code as reference, or from another Zold
// account. Shopify rides on the same requests as a payments app.
app.use("/api", createPaymentRequestRouter(requireUserSession));
app.use("/api", createShopifyRouter(requireSession));
onPaymentRequestPaid(resolveShopifyRequest);








// Accounts: signup, the account read, KYC state and the privacy bundle.
app.use("/api", createUserRouter({ requireUserSession }));
// Crypto in: what arrived at the payment page, and converting it to euros.
app.use("/api", createCryptoDepositRouter({ requireUserSession }));
// The payment page: claiming a handle, and the public payee read.
app.use("/api", createPaymentPageRouter({ requireUserSession }));
// Shareable receipts. The slug IS the credential, hence the tight bucket.
app.use("/api", createReceiptShareRouter({ requireUserSession }));
// Monerium: connect by OAuth or by your own API keys, and activate the IBAN.
// Connecting is not approval — an address-matched IBAN is.
app.use("/api", createMoneriumRouter({ requireUserSession }));
// The operator dashboard's read side, behind the operator bearer token.
app.use("/api", createAdminRouter());
// Managed recovery: the operator-plus-external-signer mode.
app.use("/api", createManagedRecoveryRouter({ requireUserSession }));
// Sessions and passkeys: the WebAuthn ceremonies, and the passkey Safe whose
// owner those credentials are.
app.use("/api", createAuthRouter({ requireUserSession }));
// Quotes, transfers and the send-time authorization.
app.use("/api", createTransferRouter({ requireUserSession }));
// Monerium's deposit webhook: an order id and nothing else is believed.
app.use("/api", createMoneriumWebhookRouter());

app.use(((err, _req, res, next) => {
  console.error(err);
  // A handler that already began answering cannot be given a 500 body: setting
  // headers twice throws inside the error handler itself, which express can
  // only answer by destroying the socket — the caller sees a truncated
  // response and no error at all. Hand those to express's default handler,
  // which closes the connection properly.
  if (res.headersSent) return next(err);
  const detail = String(err?.shortMessage ?? err?.message ?? err);
  res.status(500).json({ error: SECURITY.exposeInternalErrors ? detail : "internal server error" });
}) as express.ErrorRequestHandler);

initStore();
// Fail fast on a chain mismatch: signatures built for the wrong chain id are
// rejected as "bad authorization", which reads like a signing bug.
assertChainMatches().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
// Same class of problem, quieter symptom: the smart-account chain can differ
// from the app chain without anything throwing.
warnIfSmartAccountChainDiffers();
// FP3: compensate anything stranded by a crash or failed payout, then keep
// sweeping in the background.
sweepStrandedTransfers()
  .then((n) => n && console.log(`FP3 sweep: compensated ${n} stranded transfer(s)`))
  .catch((e) => console.error(`FP3 sweep failed: ${e?.message ?? e}`));
setInterval(() => sweepStrandedTransfers().catch(() => {}), 5 * 60_000).unref();
// Candide recoveries finalize themselves once the grace period has run, so a
// user who lost their phone on a Friday is not waiting for a click on Monday.
if (candideRecoveryEnabled()) {
  const runRecoverySweep = () =>
    sweepCandideRecoveries()
      .then((n) => n && console.log(`recovery sweep: finalized ${n} recover${n === 1 ? "y" : "ies"}`))
      .catch((e) => console.error(`recovery sweep failed: ${e?.message ?? e}`));
  setTimeout(runRecoverySweep, 5_000).unref();
  setInterval(runRecoverySweep, RECOVERY.sweepMs).unref();
  console.log(`RECOVERY: email/SMS guardian via ${RECOVERY.serviceUrl} (chain ${CANDIDE.chainId}, module ${CANDIDE.recoveryModuleAddress})`);
}
// Pay links: expire what is past its date, book our own SEPA payouts that
// carry a code, retry telling a merchant about a paid checkout.
setInterval(
  () =>
    sweepPaymentRequests()
      .then((r) => (r.expired || r.matched) && console.log(`pay-request sweep: ${r.expired} expired, ${r.matched} matched`))
      .catch((e) => console.error(`pay-request sweep failed: ${e?.message ?? e}`)),
  PAYMENT_REQUESTS.sweepMs,
).unref();
sweepAnchorPayouts()
  .then((n) => n && console.log(`anchor sweep: refreshed ${n} payout(s)`))
  .catch((e) => console.error(`anchor sweep failed: ${e?.message ?? e}`));
setInterval(
  () =>
    sweepAnchorPayouts()
      .then((n) => n && console.log(`anchor sweep: refreshed ${n} payout(s)`))
      .catch((e) => console.error(`anchor sweep failed: ${e?.message ?? e}`)),
  30_000,
).unref();

// Reconciler: log-only, never repairs. Drift between Monerium's ledger and
// local receipt state should be loud rather than discovered later by a user
// missing money. `npm run reconcile` runs the same check on demand.
const runReconcile = () =>
  reconcile()
    .then((r) => {
      if (!r.ok) console.warn(`LEDGER DRIFT\n${formatReport(r)}`);
    })
    .catch((e) => console.error(`reconcile failed: ${e?.message ?? e}`));
setTimeout(runReconcile, 10_000).unref();
setInterval(runReconcile, 15 * 60_000).unref();
if (sandbox) {
  checkConnection()
    .then((ctx) => {
      console.log(`monerium sandbox connected (${ctx?.email ?? ctx?.userId ?? "ok"})`);
      startDepositPoller();
    })
    .catch((err) => {
      console.error(`monerium sandbox auth FAILED — check .env credentials: ${err.message}`);
    });
} else {
  console.log("monerium: no app credentials (MONERIUM_CLIENT_SECRET unset) — accounts connect by OAuth or their own API keys");
  if (moneriumApiKeysAvailable()) {
    // Users may still connect their OWN Monerium keys; their deposits and
    // redeem orders are polled on those. The poller does nothing until
    // someone has.
    console.log(`monerium: per-user API-key connections enabled (${moneriumEnvironment()}) — polling connected accounts on their own credentials`);
    startDepositPoller();
  }
}
/**
 * Inbound crypto is a chain concern, not a Monerium one, so this runs whether
 * or not the sandbox is configured. It costs nothing until an account opts in:
 * with no watched users the poller returns before it ever calls getLogs.
 */
if (CRYPTO_IN.enabled) startCryptoDepositPoller();
app.listen(API_PORT, API_HOST, () => {
  console.log(`Zold API listening on http://${API_HOST}:${API_PORT}`);
  /**
   * Say the custody posture out loud at startup.
   *
   * Whether the orchestrator ends up holding a user's funds is decided by the
   * interaction of the liquidity venue and whether Bridge is live, neither of
   * which announces itself. An operator who believes they are running a
   * non-custodial deployment should find out here, not from a regulator.
   */
  const safeExecutable = ["dex", "lifi", "rfq", "best"].includes(LIQUIDITY.PROVIDER);
  if (!safeExecutable) {
    console.warn(
      `CUSTODY: LIQUIDITY_PROVIDER=${LIQUIDITY.PROVIDER} cannot be executed by a user's Safe, so ` +
        "cash-rail transfers debit the full amount to the orchestrator and swap from there. " +
        "The non-custodial path needs dex, lifi, rfq or best.",
    );
  } else if (!BRIDGE.live) {
    console.warn(
      "CUSTODY: the Safe-executed swap batch is available, but BRIDGE_LIVE is not set — with no " +
        "external deposit address the batch delivers its output to the orchestrator. Cash-rail " +
        "transfers are recorded as custodial until Bridge is live.",
    );
  } else {
    console.log(
      "CUSTODY: cash-rail transfers run non-custodially — the user's Safe signs one batch that " +
        "delivers straight to Bridge. The SEPA rail moves only the fee.",
    );
  }
  if (CUSTODY.requireNonCustodial) {
    console.log("CUSTODY: REQUIRE_NON_CUSTODIAL=1 — a transfer that would use the orchestrator is refused.");
  }
  // There are no allowances: every debit is a UserOperation the user's
  // passkey signs for the exact amount and destination. An operator setting
  // these env knobs should hear that they do nothing — silently ignoring them
  // would read as authority that exists but doesn't.
  if (
    process.env.CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI ||
    process.env.CANDIDE_COSIGNER_USDC_ALLOWANCE_UNITS ||
    process.env.CANDIDE_COSIGNER_ALLOWANCE_PERIOD_MINUTES ||
    process.env.CANDIDE_COSIGNER_ALLOWANCE_AMOUNT
  ) {
    console.warn(
      "NOTE: CANDIDE_COSIGNER_*_ALLOWANCE_* env vars are set but co-signer allowances do not " +
        "exist — every Safe debit is a UserOperation the user's passkey signs at send time. " +
        "Standing allowances on older Safes are revoked automatically on the next send.",
    );
  }
});

/**
 * Last-resort diagnostics for the two ways this process dies silently.
 *
 * Node's default for an unhandled rejection is to terminate, which is the
 * right posture here — pending Safe executions live in memory and a process
 * in an unknown state must not keep signing — but the default report can be
 * a bare stack with no indication that a payments API just went down. These
 * handlers change nothing about WHETHER we exit; they make sure the reason is
 * in the log before we do, and that a supervisor sees a non-zero code.
 *
 * Deliberately NOT swallowing: an API that keeps serving after an unhandled
 * rejection in a money path is the failure mode this codebase refuses
 * everywhere else.
 */
process.on("unhandledRejection", (reason: any) => {
  console.error(
    `FATAL unhandled promise rejection — the API is exiting: ${reason?.stack ?? reason?.message ?? reason}`,
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(`FATAL uncaught exception — the API is exiting: ${err?.stack ?? err?.message ?? err}`);
  process.exit(1);
});
