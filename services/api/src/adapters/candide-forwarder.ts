import { createHash } from "node:crypto";
import { CHAIN_ID, FORWARDING, IS_PRODUCTION } from "../config.js";

const addressRe = /^0x[0-9a-fA-F]{40}$/;

export interface PaymentForwarderActivation {
  address: `0x${string}`;
  forwarder: {
    provider: "candide" | "local-safe";
    recipient: `0x${string}`;
    destinationChainId: number;
    sourceChainIds: number[];
    custodialWithdrawer: `0x${string}`;
    salt?: `0x${string}`;
    active: boolean;
    expiresAt?: string;
    activatedAt: string;
  };
}

function assertAddress(name: string, value: string): `0x${string}` {
  if (!addressRe.test(value)) throw new Error(`${name} must be an EVM address`);
  return value as `0x${string}`;
}

export function forwardingSalt(userId: string, handle: string): `0x${string}` {
  return `0x${createHash("sha256").update(`transf:payment-page:${userId}:${handle}`).digest("hex")}`;
}

async function forwardingRpc<T>(
  method: string,
  params: Record<string, unknown>,
  authenticated = false,
): Promise<T> {
  if (!FORWARDING.rpcUrl) throw new Error("CANDIDE_FORWARDING_RPC_URL is required");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authenticated) {
    if (!FORWARDING.accountApiKey) {
      throw new Error("CANDIDE_FORWARDING_ACCOUNT_API_KEY is required to activate forwarding addresses");
    }
    headers.authorization = `Bearer ${FORWARDING.accountApiKey}`;
  }
  const res = await fetch(FORWARDING.rpcUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: [params] }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const msg = body?.error?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`Candide forwarding ${method} failed: ${String(msg).slice(0, 240)}`);
  }
  return body.result as T;
}

/**
 * Activate the public receive address for a payment page.
 *
 * Production uses Candide Forwarding Address so the displayed address routes
 * supported deposits into the already-deployed merchant Safe. Local hardhat
 * runs without Candide credentials fall back to the Safe itself, making the
 * custody boundary explicit without blocking offline tests.
 */
export async function activatePaymentForwarder(params: {
  userId: string;
  handle: string;
  recipient: `0x${string}`;
}): Promise<PaymentForwarderActivation> {
  const recipient = assertAddress("recipient", params.recipient);
  const salt = forwardingSalt(params.userId, params.handle);
  const now = new Date().toISOString();

  if (!FORWARDING.rpcUrl) {
    if (IS_PRODUCTION) {
      throw new Error("Candide Forwarding Address API must be configured before activating payment pages");
    }
    return {
      address: recipient,
      forwarder: {
        provider: "local-safe",
        recipient,
        destinationChainId: CHAIN_ID,
        sourceChainIds: [CHAIN_ID],
        custodialWithdrawer: recipient,
        salt,
        active: true,
        activatedAt: now,
      },
    };
  }

  if (!FORWARDING.recoveryConfigured) {
    throw new Error("CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER is required for payment-page recovery");
  }
  const custodialWithdrawer = assertAddress("custodialWithdrawer", FORWARDING.custodialWithdrawer);
  const sourceChainIds = FORWARDING.sourceChainIds.length ? FORWARDING.sourceChainIds : [CHAIN_ID];
  const baseParams = {
    recipient,
    custodialWithdrawer,
    destinationChainId: CHAIN_ID,
    salt,
  };
  const computed = await forwardingRpc<{ address: string }>("forwarding_getAddress", baseParams);
  const address = assertAddress("forwarding address", computed.address);
  const activation = await forwardingRpc<{ address: string; active: boolean; expiresAt?: number }>(
    "account_activateForwardingAddress",
    { ...baseParams, sourceChainIds },
    true,
  );
  const activatedAddress = assertAddress("activated forwarding address", activation.address);
  if (activatedAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Candide activated ${activatedAddress}, but computed ${address}`);
  }

  return {
    address,
    forwarder: {
      provider: "candide",
      recipient,
      destinationChainId: CHAIN_ID,
      sourceChainIds,
      custodialWithdrawer,
      salt,
      active: !!activation.active,
      ...(activation.expiresAt ? { expiresAt: new Date(activation.expiresAt * 1000).toISOString() } : {}),
      activatedAt: now,
    },
  };
}
