/**
 * /api/orgs/:orgId/crypto-deposits: USDC and EURe that landed on a company's
 * own Safe (adapters/crypto-deposits.ts records them under the account).
 *
 *  - GET lists them, for members who may read accounts;
 *  - POST .../:depositId/invoice ties one to an invoice the company issued
 *    (invoices.manage), settled by the same code as a person's;
 *  - POST .../:depositId/convert queues the USDC→EURe swap on the org Safe
 *    queue (transfers.queue). Nobody's signature comes with it: the owners
 *    sign it at /orgs/:orgId/safe-ops, and companyConversionSignRefusal
 *    re-checks the price before each signature. followCompanyConversions
 *    then hands a relayed op to settleUnconfirmedConversions, which measures
 *    what arrived from the swap's own logs, as for a person.
 *
 * Nothing converts a company's USDC unattended: there is no auto-convert,
 * because only an owner's signature moves the company's money.
 */
import express from "express";
import { FX } from "../../config.js";
import { addrs, eur, orchestratorAddress, usd } from "../../chain.js";
import { prepareDepositConversion } from "../../liquidity.js";
import {
  assertRateSane,
  companyDepositBlocker,
  heldUsdcBlocker,
  linkDepositInvoice,
  unconvertedUnits,
} from "../../adapters/crypto-deposits.js";
import { conversionReverted } from "../../transfers/activity.js";
import { store, type CryptoDeposit, type PendingSafeOp } from "../../store.js";
import { transferSwapBatchTransactions, SafeVerifierMissingError } from "../../wallet/candide.js";
import { OrgDebitRefusal, orgDebitSource, prepareOrgDebit, type OrgDebitPrepare } from "../../wallet/org-debit.js";
import { SafeOpRefusal, assertQueueOpen, queueSafeOp } from "../../wallet/org-safe-queue.js";
import type { OrgSafeReader } from "../../wallet/org-signers.js";
import { describeCause, redactedMessage } from "../../http/log-cause.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import type { OrgRoutes } from "./drafts.js";

export const CONVERT_KIND = "crypto-in-convert";

/** The chain and the venue, injected so a suite can play them. */
export interface OrgConversionDeps {
  reader?: OrgSafeReader;
  prepareOrg?: OrgDebitPrepare;
  swapPlan?: typeof prepareDepositConversion;
  heldBlocker?: typeof heldUsdcBlocker;
  usdc?: () => `0x${string}`;
}

/** This org's deposit: on one of its accounts, never a person's. */
async function orgDeposit(orgId: string, depositId: string): Promise<CryptoDeposit | undefined> {
  const d = (await store.list("cryptoDeposits")).find((x) => x.id === depositId);
  if (!d || d.userId || !d.accountId) return undefined;
  return (await store.findAccount(d.accountId))?.orgId === orgId ? d : undefined;
}

type SignRefusal = { status: number; code: string; error: string; invalidate?: string };

/**
 * Before an owner signs a conversion: the deposit still waits on this op,
 * from this org's Safe, and the price is still the market's. The quote's
 * minimum out is in the calldata; this keeps an op that waited from being
 * signed at a price older than a quote lives, or one the mid has left.
 */
export async function companyConversionSignRefusal(op: PendingSafeOp, now = Date.now()): Promise<SignRefusal | undefined> {
  if (op.kind !== CONVERT_KIND) return undefined;
  const d = (await store.list("cryptoDeposits")).find((x) => x.conversionIntent?.safeOpId === op.id);
  const account = d?.accountId ? await store.findAccount(d.accountId) : undefined;
  if (!d || !account || account.orgId !== op.orgId || account.address?.toLowerCase() !== op.safeAddress.toLowerCase()) {
    return { status: 409, code: "DEPOSIT_MISSING", error: "This conversion's deposit is no longer waiting on it, so it cannot be signed.", invalidate: "its deposit is no longer waiting on it" };
  }
  const org = await store.findOrganisation(op.orgId);
  try {
    if (!org) throw new OrgDebitRefusal(409, "NOT_THE_ORG_SAFE", "missing");
    orgDebitSource(org, account);
  } catch (err) {
    if (!(err instanceof OrgDebitRefusal)) throw err;
    return { status: 409, code: err.code, error: err.message, invalidate: "the company may no longer convert on this account" };
  }
  const intent = d.conversionIntent!;
  if (Date.parse(intent.at) + FX.QUOTE_TTL_MS < now) {
    return { status: 409, code: "QUOTE_EXPIRED", error: "This price has expired. Nothing was converted; start the conversion again for a fresh price.", invalidate: "its price expired before it was signed" };
  }
  try {
    await assertRateSane(BigInt(intent.quote.rate));
  } catch (err) {
    return { status: 503, code: "RATE_UNCHECKED", error: `Nothing was signed: ${redactedMessage(err)}` };
  }
  return undefined;
}

export function createOrgCryptoDepositRoutes(deps: OrgRoutes, conv: OrgConversionDeps = {}): express.Router {
  const r = express.Router();
  const swapPlan = conv.swapPlan ?? prepareDepositConversion;
  const heldBlocker = conv.heldBlocker ?? heldUsdcBlocker;
  const usdc = conv.usdc ?? (() => addrs().usdc);

  const load = async (req: express.Request, res: express.Response, permission: "accounts.read" | "invoices.manage" | "transfers.queue") => {
    const ctx = await deps.ctxOf(req, res);
    if (!ctx || !requirePermission(ctx, res, permission)) return undefined;
    if (!req.params.depositId) return { ctx };
    const deposit = await orgDeposit(ctx.org.id, String(req.params.depositId));
    if (!deposit) {
      res.status(404).json({ error: "deposit not found" });
      return undefined;
    }
    return { ctx, deposit };
  };

  r.get(
    "/:orgId/crypto-deposits",
    wrap(async (req, res) => {
      const loaded = await load(req, res, "accounts.read");
      if (!loaded) return;
      const accounts = new Set((await store.accountsOf(loaded.ctx.org.id)).map((a) => a.id));
      res.json({
        deposits: (await store.list("cryptoDeposits"))
          .filter((d) => !d.userId && !!d.accountId && accounts.has(d.accountId))
          .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
          .map((d) => ({ ...d, convertBlocker: companyDepositBlocker(d), ...(conversionReverted(d) ? { conversionReverted: true } : {}) })),
      });
    }),
  );

  r.post(
    "/:orgId/crypto-deposits/:depositId/invoice",
    wrap(async (req, res) => {
      const loaded = await load(req, res, "invoices.manage");
      if (!loaded) return;
      const { ctx, deposit } = loaded as { ctx: OrgContext; deposit: CryptoDeposit };
      const invoiceId = req.body?.invoiceId;
      if (invoiceId !== null) {
        // The id is not a capability: only this company's invoice is found.
        const invoice = await store.findInvoice(String(invoiceId ?? ""));
        if (!invoice || invoice.orgId !== ctx.org.id) return res.status(404).json({ error: "invoice not found" });
      }
      const out = await linkDepositInvoice(deposit.id, invoiceId === null ? null : String(invoiceId), () => store.lockOrganisation(ctx.org.id));
      res.status(out.status).json(out.body);
    }),
  );

  r.post(
    "/:orgId/crypto-deposits/:depositId/convert",
    wrap(async (req, res) => {
      const loaded = await load(req, res, "transfers.queue");
      if (!loaded) return;
      const { ctx, deposit } = loaded as { ctx: OrgContext; deposit: CryptoDeposit };
      const account = (await store.findAccount(deposit.accountId!))!;
      try {
        assertQueueOpen();
        const plan = orgDebitSource(ctx.org, account);
        const blocker = companyDepositBlocker(deposit);
        if (blocker) return res.status(409).json({ error: blocker });
        const spent = await heldBlocker({ address: plan.address }, deposit);
        if (spent) return res.status(409).json({ error: spent });
        const units = unconvertedUnits(deposit);
        const swap = await swapPlan(plan.address, units, `crypto-in-${deposit.id}`);
        if (!swap) return res.status(503).json({ error: "the configured liquidity venue cannot be executed by the company's Safe, so this deposit cannot be converted here" });
        const quote = swap.plan.quote;
        try {
          await assertRateSane(quote.rate);
        } catch (err) {
          return res.status(503).json({ error: redactedMessage(err) });
        }
        // No fee on a conversion: the company converts its own money and keeps it.
        const { prepared } = await prepareOrgDebit({
          org: ctx.org,
          account,
          txs: transferSwapBatchTransactions({
            token: usdc(),
            feeTo: orchestratorAddress,
            feeAmount: 0n,
            approval: { spender: swap.plan.approval.spender, amount: swap.plan.approval.amount },
            call: swap.plan.call,
          }),
          ...(conv.reader ? { reader: conv.reader } : {}),
          ...(conv.prepareOrg ? { prepare: conv.prepareOrg } : {}),
        });
        const paymaster = (prepared.userOperation as { paymaster?: string | null }).paymaster;
        const out = await store.tx(async () => {
          await store.lockOrganisation(ctx.org.id);
          // Read again under the lock: a link, an arrival or another queue
          // since the checks above.
          const current = (await store.list("cryptoDeposits")).find((d) => d.id === deposit.id)!;
          if (companyDepositBlocker(current) || unconvertedUnits(current) !== units) return undefined;
          const op = await queueSafeOp({
            org: ctx.org,
            member: ctx.member,
            safeAddress: plan.address,
            kind: CONVERT_KIND,
            summary: `Convert ${usd.fromUnits(units)} USDC to at least €${eur.fromWei(quote.minOut)} EURe via ${quote.provider}`,
            prepared,
          });
          // The CONVERTING reserve: no second conversion of this USDC while the op lives.
          await store.patchCryptoDeposit(deposit.id, () => ({
            conversionIntent: {
              at: new Date().toISOString(),
              amountUnits: units.toString(),
              safeAddress: plan.address,
              nonce: prepared.nonce.toString(),
              ...(paymaster ? { paymaster } : {}),
              quote: { provider: quote.provider, rate: quote.rate.toString(), minOut: quote.minOut.toString() },
              safeOpId: op.id,
            },
            reason: "waiting for the company's owners to sign the conversion",
          }));
          return op;
        });
        if (!out) return res.status(409).json({ error: "this deposit changed while the conversion was prepared — reload" });
        res.status(201).json({
          opId: out.id,
          amountUsdc: usd.fromUnits(units),
          expectedEur: eur.fromWei(quote.expectedOut),
          minEur: eur.fromWei(quote.minOut),
          provider: quote.provider,
        });
      } catch (err) {
        if (err instanceof SafeOpRefusal || err instanceof OrgDebitRefusal || err instanceof SafeVerifierMissingError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        console.error(`org crypto-in: preparing the conversion of ${deposit.id} failed: ${describeCause(err)}`);
        res.status(502).json({ error: `could not prepare the conversion: ${redactedMessage(err)}` });
      }
    }),
  );

  return r;
}
