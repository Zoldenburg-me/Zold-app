/**
 * Bridge.xyz orchestration adapter.
 *
 * Bridge replaces the direct burn/mint worker in the cash rail. The API
 * creates a transfer, Bridge returns source deposit instructions, and once the
 * deposit lands Bridge moves funds to the destination rail.
 *
 * There is no dry-run: without BRIDGE_LIVE=1 and credentials the cash rail is
 * closed and createBridgeTransfer refuses, so no transfer ever carries a
 * fabricated deposit address.
 */
// Every call carries a timeout: a Bridge request that hangs past the
// stranded-transfer sweep would let the sweep refund a transfer whose
// deposit is still being confirmed.
import { BRIDGE } from "../config.js";
import { createHash } from "node:crypto";
import { partnerTimeout } from "../http.js";
import { describeCause } from "../http/log-cause.js";

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

/** A create answer is a few hundred bytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** The body, read up to MAX_RESPONSE_BYTES under the request's own timeout. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`Bridge answered with a body larger than ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Decimal strings as 6dp units, so "12.3" and "12.30" are one amount. */
function amountUnits(v: unknown): bigint | undefined {
  if (typeof v !== "string" || !/^\d+(\.\d{1,6})?$/.test(v)) return undefined;
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** An EVM address is one address in any case; anything else compares exactly. */
const sameAddress = (a: unknown, b: string) =>
  typeof a === "string" && (b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);
const sameText = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

function requestParts(destination: BridgeTransferDestination, sourceAddress?: string) {
  return {
    source: {
      payment_rail: BRIDGE.sourceRail,
      currency: "usdc" as const,
      ...(sourceAddress ? { from_address: sourceAddress } : {}),
    },
    destination: {
      payment_rail: destination.paymentRail,
      currency: destination.currency,
      to_address: destination.toAddress,
      ...(destination.blockchainMemo ? { blockchain_memo: destination.blockchainMemo } : {}),
    },
  };
}

function requestBody(amountUsdc: number, destination: BridgeTransferDestination, sourceAddress?: string) {
  return { amount: amountString(amountUsdc), on_behalf_of: BRIDGE.onBehalfOf, ...requestParts(destination, sourceAddress) };
}

/**
 * The order a create sends under this transfer's Idempotency-Key, as a hash.
 * /api/transfers records it before its create goes out; a later create for the
 * same transfer must hash the same, or it would ask Bridge for a different
 * order under the key of the first.
 */
export function bridgeRequestHash(
  zoldTransferId: string,
  amountUsdc: number,
  destination: BridgeTransferDestination,
  opts: { sourceAddress?: string } = {},
): string {
  const body = requestBody(amountUsdc, destination, opts.sourceAddress?.toLowerCase());
  if (body.destination.to_address.startsWith("0x")) body.destination.to_address = body.destination.to_address.toLowerCase();
  return createHash("sha256").update(JSON.stringify([`zold-${zoldTransferId}-bridge`, body])).digest("hex");
}

/** Why Bridge's answer is not the order that was sent, or undefined if it is. */
function answerMismatch(data: any, body: ReturnType<typeof requestBody>): string | undefined {
  // Bridge's Transfer object always names its customer. Missing is refused
  // with different: another customer's order would hand us their deposit
  // address as the swap target. Neither id goes into the message.
  if (data.on_behalf_of !== body.on_behalf_of) return "a different or missing customer (on_behalf_of)";
  if (amountUnits(data.amount) !== amountUnits(body.amount)) return `amount ${JSON.stringify(data.amount)}, sent ${body.amount}`;
  const src = data.source;
  if (
    !sameText(src?.payment_rail, body.source.payment_rail) ||
    !sameText(src?.currency, body.source.currency) ||
    (body.source.from_address !== undefined && !sameAddress(src?.from_address, body.source.from_address))
  ) {
    return "a different source";
  }
  const dst = data.destination;
  if (
    !sameText(dst?.payment_rail, body.destination.payment_rail) ||
    !sameText(dst?.currency, body.destination.currency) ||
    !sameAddress(dst?.to_address, body.destination.to_address) ||
    (dst?.blockchain_memo || undefined) !== body.destination.blockchain_memo
  ) {
    return "a different destination";
  }
  const dep = data.source_deposit_instructions;
  if (
    !dep ||
    typeof dep !== "object" ||
    !sameText(dep.payment_rail, body.source.payment_rail) ||
    !sameText(dep.currency, body.source.currency) ||
    amountUnits(dep.amount) !== amountUnits(body.amount) ||
    (body.source.from_address !== undefined && dep.from_address !== undefined && !sameAddress(dep.from_address, body.source.from_address)) ||
    typeof dep.to_address !== "string" ||
    !/^0x[a-fA-F0-9]{40}$/.test(dep.to_address)
  ) {
    return "deposit instructions that are not this order's (chain, asset, amount, sender or address)";
  }
  return undefined;
}

export async function createBridgeTransfer(
  zoldTransferId: string,
  amountUsdc: number,
  destination: BridgeTransferDestination,
  /** `expectRequest`: the bridgeRequestHash recorded when this transfer's
   *  first create went out. A body that hashes differently is refused here. */
  opts: { sourceAddress?: string; expectRequest?: string } = {},
): Promise<BridgeTransferPlan> {
  const idempotencyKey = `zold-${zoldTransferId}-bridge`;
  const { source, destination: dest } = requestParts(destination, opts.sourceAddress);
  const plan: BridgeTransferPlan = {
    mode: "live",
    amountUsdc,
    source,
    destination: dest,
    idempotencyKey,
  };

  // No dry-run. A cash payout either goes through Bridge for real or it does
  // not happen; a fabricated deposit address on a real chain would send the
  // swap output nowhere while the transfer reported progress.
  if (!BRIDGE.live) {
    throw new BridgeTransferError(
      "the cash rail is closed: BRIDGE_LIVE=1 with BRIDGE_API_KEY and BRIDGE_ON_BEHALF_OF is required",
      plan,
    );
  }

  if (!BRIDGE.apiKey) throw new BridgeTransferError("BRIDGE_API_KEY is required when BRIDGE_LIVE=1", plan);
  if (!BRIDGE.onBehalfOf) throw new BridgeTransferError("BRIDGE_ON_BEHALF_OF is required when BRIDGE_LIVE=1", plan);

  if (opts.expectRequest !== undefined && bridgeRequestHash(zoldTransferId, amountUsdc, destination, opts) !== opts.expectRequest) {
    throw new BridgeTransferError(
      `this transfer already sent a different order to Bridge under ${idempotencyKey}; refusing to send another under the same key — nothing was sent`,
      plan,
    );
  }

  const body = requestBody(amountUsdc, destination, opts.sourceAddress);
  // Once the request is out, Bridge may hold an order whatever comes back: a
  // timeout or a broken body is an unknown outcome, and goes on record as one.
  let res: Response;
  let text: string;
  try {
    res = await fetch(apiPath("/v0/transfers"), {
      signal: partnerTimeout(),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Api-Key": BRIDGE.apiKey,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    text = await readCapped(res);
  } catch (err) {
    throw new BridgeTransferError(
      `Bridge transfer create outcome unknown (${describeCause(err)}) — an order may exist under ${idempotencyKey}`,
      plan,
    );
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    throw new BridgeTransferError(
      `Bridge transfer create failed (${res.status}): ${(data === undefined ? text : JSON.stringify(data)).slice(0, 500)}`,
      plan,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new BridgeTransferError(`Bridge answered ${res.status} with a body that is not a JSON object`, plan);
  }

  plan.transferId = typeof data.id === "string" && data.id ? data.id : undefined;
  plan.state = transferState(data);
  plan.sourceDepositInstructions = data.source_deposit_instructions;
  plan.destinationTxHash = destinationHash(data);
  plan.raw = data;
  if (!plan.transferId) throw new BridgeTransferError(`Bridge answered ${res.status} with no transfer id`, plan);
  // An idempotent replay answers with the order first sent under this key. If
  // that is not the order just sent, nothing in it describes this payout.
  const mismatch = answerMismatch(data, body);
  if (mismatch) {
    throw new BridgeTransferError(
      `Bridge answered ${idempotencyKey} with ${mismatch} — not the order sent; reconcile before any money moves`,
      plan,
    );
  }
  return plan;
}
