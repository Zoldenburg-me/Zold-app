/**
 * The operator dashboard's read side.
 *
 * Read only and masked: recipient phone numbers and IBANs are masked before
 * they leave, and there is no write route (KYC review and IBAN issue belong to
 * Monerium).
 *
 * Authentication is the operator bearer token, never a user session, so a user
 * cannot act as the operator on their own account. It fails closed when no
 * token is configured.
 */
import express from "express";
import { wrap } from "./util.js";
import { abis, addrs, deployerWallet, eur, orchestratorAddress, publicClient } from "../chain.js";
import { publicUser } from "../users/public-user.js";
import { store, type CryptoDeposit, type Transfer } from "../store.js";
import { operatorLabel, requireOperator } from "../http/guards.js";
import { recentServerErrors } from "../http/error-log.js";
import { plansFor, trialIsActive } from "../domain/plans.js";
import type { PlanId } from "../domain/types.js";
import { onboardingOf, recoveryEnrolment } from "../admin/onboarding.js";
import { issues, overview } from "../admin/overview.js";
import { liveMonerium, moneriumOverview, storedMonerium } from "../admin/monerium.js";
import { maskIdentifier } from "../admin/mask.js";

function adminUserSummary(userId: string) {
  const u = store.findUser(userId);
  if (!u) return undefined;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    country: u.country,
    kycStatus: u.kycStatus,
    kycProvider: u.kyc?.provider,
    funding: u.funding,
    safeAddress: u.address,
    iban: u.iban,
  };
}

function lastHash(txs: { step: string; hash: string }[] = []) {
  return txs.at(-1)?.hash;
}

function adminTransfer(transfer: Transfer) {
  const quote = store.findQuote(transfer.quoteId);
  const route = [
    ...transfer.txs.map((tx) => ({ kind: "chain" as const, ...tx })),
    ...(transfer.liquidity?.txHash
      ? [{ kind: "liquidity" as const, step: `liquidity.${transfer.liquidity.provider}`, hash: transfer.liquidity.txHash }]
      : []),
    ...(transfer.pickup?.anchorPaymentHash
      ? [{ kind: "payout" as const, step: "moneygram.anchor.payment", hash: transfer.pickup.anchorPaymentHash }]
      : []),
  ];
  return {
    kind: "transfer" as const,
    id: transfer.id,
    user: adminUserSummary(transfer.userId),
    quote,
    rail: transfer.rail,
    state: transfer.state,
    statusDetail:
      transfer.error ??
      transfer.sepa?.detail ??
      transfer.pickup?.anchorStatus ??
      transfer.pickup?.status ??
      transfer.sepa?.state,
    sendEur: transfer.sendEur,
    receiveEur: transfer.receiveEur,
    receiveKes: transfer.receiveKes,
    recipientName: transfer.recipientName,
    // Masked in the ops list: the dashboard needs to distinguish payees, not
    // hold their full identifiers on every poll.
    recipientPhone: maskIdentifier(transfer.recipientPhone),
    recipientIban: maskIdentifier(transfer.recipientIban),
    fundingSource: transfer.fundingSource,
    payout:
      transfer.rail === "sepa"
        ? {
            provider: transfer.sepa?.mode === "sandbox" ? "Monerium" : "Mock SEPA",
            orderId: transfer.sepa?.orderId,
            state: transfer.sepa?.state,
            detail: transfer.sepa?.detail,
            redeemSignedAt: transfer.moneriumRedeem?.signedAt,
            memo: transfer.moneriumRedeem?.memo,
          }
        : {
            provider: transfer.pickup?.provider ?? "MoneyGram",
            referenceCode: transfer.pickup?.referenceCode,
            status: transfer.pickup?.status,
            anchorStatus: transfer.pickup?.anchorStatus,
            anchorTransactionId: transfer.pickup?.anchorTransactionId,
            anchorReferenceNumber: transfer.pickup?.anchorReferenceNumber,
            anchorAsset: transfer.pickup?.anchorAsset,
            anchorAmount: transfer.pickup?.anchorAmount,
            anchorAmountIn: transfer.pickup?.anchorAmountIn,
            moreInfoUrl: transfer.pickup?.moreInfoUrl,
          },
    liquidity: transfer.liquidity,
    bridge: route.filter((x) => x.step.startsWith("bridge.")),
    route,
    lastHash: lastHash(transfer.txs),
    refund: transfer.refund,
    error: transfer.error,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  };
}

function adminFunding(deposit: CryptoDeposit) {
  return {
    kind: "funding" as const,
    id: deposit.id,
    user: adminUserSummary(deposit.userId),
    chainId: deposit.chainId,
    token: deposit.token,
    state: deposit.state,
    statusDetail: deposit.reason,
    txHash: deposit.txHash,
    logIndex: deposit.logIndex,
    amountEur: deposit.amountEur ?? deposit.creditedEur,
    amountUsdc: deposit.amountUsdc ?? deposit.creditedUsdc,
    settlementAsset: deposit.settlementAsset,
    paymentAddress: deposit.paymentAddress,
    provider: deposit.provider,
    rate: deposit.rate,
    txs: deposit.txs,
    route: [
      { kind: "chain" as const, step: `erc20.${deposit.token}.transfer.in`, hash: deposit.txHash },
      ...deposit.txs.map((tx) => ({ kind: "chain" as const, ...tx })),
    ],
    reason: deposit.reason,
    detectedAt: deposit.detectedAt,
    createdAt: deposit.detectedAt,
    updatedAt: deposit.updatedAt,
  };
}


/**
 * Deployer float for the ops dashboard: the address that pays deployments and
 * verifier setups, and runs dry silently. 60s cache: the dashboard polls every
 * 10s and two RPC reads per tick would be rude.
 */
let deployerFloatCache: { at: number; value: { address: string; eur: number; eth: number } } | null = null;
async function deployerFloat() {
  if (deployerFloatCache && Date.now() - deployerFloatCache.at < 60_000) return deployerFloatCache.value;
  const address = deployerWallet.account.address;
  const [eth, eure] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>,
  ]);
  const value = { address, eur: eur.fromWei(eure), eth: Number(eth) / 1e18 };
  deployerFloatCache = { at: Date.now(), value };
  return value;
}

/**
 * Gas balances of every EOA that sends transactions for the platform. Each is
 * a distinct outage when dry, and the errors do not say which wallet is empty:
 * a dry orchestrator fails swaps and the fee leg; a dry deployer fails Safe
 * verifier deployments. Name them, so the dashboard can too.
 */
let operatorGasCache: { at: number; value: { role: string; address: string; eth: number }[] } | null = null;
async function operatorGas() {
  if (operatorGasCache && Date.now() - operatorGasCache.at < 60_000) return operatorGasCache.value;
  const wallets: { role: string; address: `0x${string}` }[] = [
    { role: "orchestrator (swaps, fees)", address: orchestratorAddress },
    { role: "deployer (gas)", address: deployerWallet.account.address },
  ];
  const value = await Promise.all(
    wallets
      .filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address))
      .map(async (w) => ({
        role: w.role,
        address: w.address,
        eth: Number(await publicClient.getBalance({ address: w.address })) / 1e18,
      })),
  );
  operatorGasCache = { at: Date.now(), value };
  return value;
}

export function createAdminRouter() {
  const router = express.Router();

  router.get(
    "/admin/stats",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const users = store.users;
      const transfers = store.transfers;
      const totalUsers = users.length;
      const kycPending = users.filter((u) => u.kycStatus === "pending" || u.kycStatus === "manual_review").length;
      const kycApproved = users.filter((u) => u.kycStatus === "approved").length;
      const activeSafes = users.filter((u) => u.passkeySafe?.status === "active" || u.wallet?.deployed).length;
      const totalTransfers = transfers.length;
      const totalVolumeEur = transfers.reduce((sum, t) => sum + (t.sendEur || 0), 0);
      res.json({
        totalUsers,
        kycPending,
        kycApproved,
        activeSafes,
        totalTransfers,
        totalVolumeEur,
        deployer: await deployerFloat().catch(() => null),
        operatorGas: await operatorGas().catch(() => null),
      });
    }),
  );

  /**
   * Grant an organisation a plan. Owners cannot buy a paid plan themselves —
   * there is no billing — so a paid plan is an operator decision, made here.
   * Like the owner's route, it only changes `plan`; nothing is deleted.
   */
  router.post(
    "/admin/orgs/:orgId/plan",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const org = store.findOrganisation(String(req.params.orgId));
      if (!org) return res.status(404).json({ error: "organisation not found" });
      const plan = String(req.body?.plan ?? "");
      const allowed: string[] = plansFor(org.type).map((p) => p.id);
      if (!allowed.includes(plan)) {
        return res.status(400).json({ error: `A ${org.type} organisation can hold ${allowed.join(" or ")}.` });
      }
      const updated = store.updateOrganisation(org.id, {
        plan: plan as PlanId,
        ...(trialIsActive(org) ? { trial: { ...org.trial!, endedAt: new Date().toISOString() } } : {}),
      });
      res.json({ id: updated.id, plan: updated.plan, trial: updated.trial });
    }),
  );

  /** The last server errors by reference (http/error-log.ts), newest first,
   *  so a ref a user quotes leads straight to its stack. */
  router.get("/admin/errors", (req, res) => {
    if (!requireOperator(req, res)) return;
    res.json({ errors: recentServerErrors() });
  });

  /** Counts for the dashboard's first screen, plus the gas wallets. */
  router.get(
    "/admin/overview",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      res.json({
        ...overview(),
        deployer: await deployerFloat().catch(() => null),
        operatorGas: await operatorGas().catch(() => null),
      });
    }),
  );

  /** Every open problem from every place one is recorded (admin/overview.ts). */
  router.get("/admin/issues", (req, res) => {
    if (!requireOperator(req, res)) return;
    res.json({ issues: issues() });
  });

  // The same allowlisted projection the app gets, plus where the account
  // stands. No token, secret or ciphertext is in either.
  const adminUser = (u: Parameters<typeof publicUser>[0]) => ({
    ...publicUser(u),
    onboarding: onboardingOf(u),
    recoveryEnrolment: recoveryEnrolment(u),
  });

  router.get(
    "/admin/users",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      res.json(store.users.map(adminUser));
    }),
  );

  /** One account and everything that hangs off it. */
  router.get(
    "/admin/users/:id",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const u = store.findUser(String(req.params.id));
      if (!u) return res.status(404).json({ error: "user not found" });
      res.json({
        user: adminUser(u),
        transactions: [
          ...store.transfers.filter((t) => t.userId === u.id).map(adminTransfer),
          ...store.cryptoDeposits.filter((d) => d.userId === u.id).map(adminFunding),
        ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        recoveries: store.recoveryRequestsForUser(u.id).map((r) => ({
          id: r.id, mode: r.mode, status: r.status, requestedAt: r.requestedAt,
          reference: r.zoldenburg?.reference, finalizedAt: r.finalizedAt, canceledAt: r.canceledAt,
        })),
        memberships: store.members
          .filter((m) => m.userId === u.id)
          .map((m) => ({ orgId: m.orgId, org: store.findOrganisation(m.orgId)?.name, role: m.role, status: m.status })),
        issues: issues().filter((i) => i.userId === u.id),
        audit: store.auditFor(u.id, 100),
      });
    }),
  );

  /**
   * Monerium for one account. Stored always; `?live=1` also asks Monerium now
   * on the account's own connection (admin/monerium.ts), stores nothing and
   * audits the read.
   */
  router.get(
    "/admin/users/:id/monerium",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const u = store.findUser(String(req.params.id));
      if (!u) return res.status(404).json({ error: "user not found" });
      res.json({
        stored: storedMonerium(u),
        ...(req.query.live === "1" ? { live: await liveMonerium(u, operatorLabel(req)) } : {}),
      });
    }),
  );

  /** Monerium across the deployment; `?live=1` also checks the app's own
   *  credentials against Monerium. */
  router.get(
    "/admin/monerium",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      res.json(await moneriumOverview(req.query.live === "1"));
    }),
  );

  router.get(
    "/admin/transactions",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      // Paginated, newest first: one leaked operator token should not dump the
      // whole ops ledger in a single request.
      const asInt = (v: unknown, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
      };
      const limit = Math.min(500, Math.max(1, asInt(req.query.limit, 200)));
      const offset = Math.max(0, asInt(req.query.offset, 0));
      const entries = [
        ...store.transfers.map(adminTransfer),
        ...store.cryptoDeposits.map(adminFunding),
      ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      res.json({
        total: entries.length,
        offset,
        transactions: entries.slice(offset, offset + limit),
      });
    }),
  );

  return router;
}
