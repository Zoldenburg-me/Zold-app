/**
 * The operator dashboard's read side.
 *
 * Read only and masked: recipient IBANs are masked before
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
import { requireOperator } from "../http/guards.js";

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

/** Keep enough to recognise a payee, never the whole identifier. */
function maskIdentifier(v?: string): string | undefined {
  if (!v) return v;
  const s = String(v).replace(/\s+/g, "");
  return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function adminTransfer(transfer: Transfer) {
  const quote = store.findQuote(transfer.quoteId);
  const route = transfer.txs.map((tx) => ({ kind: "chain" as const, ...tx }));
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
      transfer.sepa?.state,
    sendEur: transfer.sendEur,
    receiveEur: transfer.receiveEur,
    recipientName: transfer.recipientName,
    // Masked in the ops list: the dashboard needs to distinguish payees, not
    // hold their full identifiers on every poll.
    recipientIban: maskIdentifier(transfer.recipientIban),
    fundingSource: transfer.fundingSource,
    payout: {
      provider: transfer.sepa?.mode === "sandbox" ? "Monerium" : "Mock SEPA",
      orderId: transfer.sepa?.orderId,
      state: transfer.sepa?.state,
      detail: transfer.sepa?.detail,
      redeemSignedAt: transfer.moneriumRedeem?.signedAt,
      memo: transfer.moneriumRedeem?.memo,
    },
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

  router.get(
    "/admin/users",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const list = store.users.map((u) => publicUser(u));
      res.json(list);
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
