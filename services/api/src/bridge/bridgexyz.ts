/**
 * Bridge.xyz orchestration adapter.
 *
 * Bridge replaces the direct burn/mint worker in the cash rail. The API
 * creates a transfer, Bridge returns source deposit instructions, and once the
 * deposit lands Bridge moves funds to the destination rail.
 *
 * Dry-run mode is the default so the local demo can still record the exact
 * Bridge-shaped funding leg without requiring partner credentials.
 */
import { BRIDGE } from "../config.js";

export interface BridgeTransferDestination {
  paymentRail: string;
  currency: string;
  toAddress: string;
  blockchainMemo?: string;
}

export interface BridgeDepositInstructions {
  payment_rail?: string;
  amount?: string;
  currency?: string;
  from_address?: string;
  to_address?: string;
  blockchain_memo?: string;
  deposit_message?: string;
  [key: string]: unknown;
}

export interface BridgeTransferPlan {
  mode: "dry-run" | "live";
  amountUsdc: number;
  source: {
    payment_rail: string;
    currency: "usdc";
    from_address?: string;
  };
  destination: {
    payment_rail: string;
    currency: string;
    to_address: string;
    blockchain_memo?: string;
  };
  idempotencyKey: string;
  transferId?: string;
  state?: string;
  sourceDepositInstructions?: BridgeDepositInstructions;
  destinationTxHash?: string;
  raw?: unknown;
}

export class BridgeTransferError extends Error {
  constructor(message: string, public readonly plan?: BridgeTransferPlan) {
    super(message);
    this.name = "BridgeTransferError";
  }
}

function amountString(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bridge transfer amount must be positive");
  // Floor, never round: toFixed rounds half-up, which could state an amount
  // LARGER than the USDC actually delivered (measured at 6dp) — a transfer
  // Bridge would then wait on forever, short by a fraction of a cent.
  return (Math.floor(amount * 100) / 100).toFixed(2);
}

function apiPath(path: string): string {
  return `${BRIDGE.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function transferState(data: any): string | undefined {
  return typeof data?.state === "string" ? data.state : undefined;
}

function destinationHash(data: any): string | undefined {
  const hash = data?.receipt?.destination_tx_hash ?? data?.destination_tx_hash;
  return typeof hash === "string" && hash ? hash : undefined;
}

export async function createBridgeTransfer(
  zoldTransferId: string,
  amountUsdc: number,
  destination: BridgeTransferDestination,
  opts: { sourceAddress?: string } = {},
): Promise<BridgeTransferPlan> {
  const idempotencyKey = `zold-${zoldTransferId}-bridge`;
  const source = {
    payment_rail: BRIDGE.sourceRail,
    currency: "usdc" as const,
    ...(opts.sourceAddress ? { from_address: opts.sourceAddress } : {}),
  };
  const dest = {
    payment_rail: destination.paymentRail,
    currency: destination.currency,
    to_address: destination.toAddress,
    ...(destination.blockchainMemo ? { blockchain_memo: destination.blockchainMemo } : {}),
  };
  const plan: BridgeTransferPlan = {
    mode: BRIDGE.live ? "live" : "dry-run",
    amountUsdc,
    source,
    destination: dest,
    idempotencyKey,
  };

  if (!BRIDGE.live) {
    plan.transferId = `bridge_dry_${zoldTransferId}`;
    plan.state = "dry_run";
    plan.sourceDepositInstructions = {
      payment_rail: source.payment_rail,
      amount: amountString(amountUsdc),
      currency: "usdc",
      from_address: source.from_address,
      to_address: "bridge-dry-run-deposit-address",
    };
    return plan;
  }

  if (!BRIDGE.apiKey) throw new BridgeTransferError("BRIDGE_API_KEY is required when BRIDGE_LIVE=1", plan);
  if (!BRIDGE.onBehalfOf) throw new BridgeTransferError("BRIDGE_ON_BEHALF_OF is required when BRIDGE_LIVE=1", plan);

  const body = {
    amount: amountString(amountUsdc),
    on_behalf_of: BRIDGE.onBehalfOf,
    source,
    destination: dest,
  };
  const res = await fetch(apiPath("/v0/transfers"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": BRIDGE.apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
  if (!res.ok) {
    throw new BridgeTransferError(`Bridge transfer create failed (${res.status}): ${JSON.stringify(data)}`, plan);
  }

  plan.transferId = data.id;
  plan.state = transferState(data);
  plan.sourceDepositInstructions = data.source_deposit_instructions;
  plan.destinationTxHash = destinationHash(data);
  plan.raw = data;
  return plan;
}

export async function getBridgeTransfer(bridgeTransferId: string): Promise<{
  id: string;
  state?: string;
  destinationTxHash?: string;
  sourceDepositInstructions?: BridgeDepositInstructions;
  raw: unknown;
}> {
  if (!BRIDGE.apiKey) throw new Error("BRIDGE_API_KEY is required to read Bridge transfers");
  const res = await fetch(apiPath(`/v0/transfers/${encodeURIComponent(bridgeTransferId)}`), {
    headers: { "Api-Key": BRIDGE.apiKey },
  });
  const data = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
  if (!res.ok) throw new Error(`Bridge transfer read failed (${res.status}): ${JSON.stringify(data)}`);
  return {
    id: data.id ?? bridgeTransferId,
    state: transferState(data),
    destinationTxHash: destinationHash(data),
    sourceDepositInstructions: data.source_deposit_instructions,
    raw: data,
  };
}
