import { createHash } from "node:crypto";
import { CHAIN_ID, FORWARDING, IS_PRODUCTION } from "../config.js";
import { usdIsStaging, usdToken } from "../usd-token.js";
import { partnerTimeout } from "../http.js";
import { redactedMessage } from "../http/log-cause.js";

const addressRe = /^0x[0-9a-fA-F]{40}$/;

/** One token a payer may send to the deposit address, on one source chain.
 *  Only tokens whose route delivers the app's USDC on CHAIN_ID are listed:
 *  that is what the crypto-in converter turns into euros. */
export interface AcceptedToken {
  chainId: number;
  chainName?: string;
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Smallest unit. Below it no bridge forwards and the deposit sits in the
   *  forwarder until it is recovered. Absent on the destination chain. */
  minAmount?: string;
  feeBps?: number;
}

export interface PaymentForwarderActivation {
  address: `0x${string}`;
  accepts: AcceptedToken[];
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
    signal: partnerTimeout(),
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: [params] }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const msg = redactedMessage(body?.error?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
    throw new Error(`Candide forwarding ${method} failed: ${String(msg).slice(0, 240)}`);
  }
  return body.result as T;
}

interface ForwardingRoute {
  sourceChainId: number;
  sourceChainName?: string;
  destinationChainId: number;
  tokens: { address: string; symbol: string; decimals: number; destinationAddress: string; feeBps?: number }[];
}

/**
 * What a payer may send, read from Candide's routes: every token on every
 * configured source chain whose route delivers `token` (by its address on
 * CHAIN_ID), with the lowest bridge minimum. `forwarding_getAddress` is pure
 * computation and answers for any chain id, Base Sepolia included, so an
 * address from it proves nothing: without a route the relayer never forwards
 * and a payer's deposit sits in the forwarder. No accepted token refuses; a
 * minimum that cannot be read refuses too, rather than list a token without
 * the floor below which it gets stuck.
 */
async function acceptedTokens(sourceChainIds: number[], token: `0x${string}`): Promise<AcceptedToken[]> {
  const accepts: AcceptedToken[] = [];
  for (const sourceChainId of sourceChainIds) {
    const { routes } = await forwardingRpc<{ routes?: ForwardingRoute[] }>("forwarding_getRoutes", { sourceChainId });
    const route = routes?.find((r) => r.destinationChainId === CHAIN_ID);
    for (const t of route?.tokens ?? []) {
      if (t.destinationAddress?.toLowerCase() !== token.toLowerCase() || !addressRe.test(t.address)) continue;
      let minAmount: string | undefined;
      if (sourceChainId !== CHAIN_ID) {
        const { bridges } = await forwardingRpc<{ bridges?: Record<string, { minAmount?: string }> }>(
          "forwarding_getMinimumAmount",
          { sourceChainId, destinationChainId: CHAIN_ID, token: t.address },
        );
        const mins = Object.values(bridges ?? {})
          .map((b) => b?.minAmount)
          .filter((m): m is string => typeof m === "string" && /^\d+$/.test(m))
          .map((m) => BigInt(m));
        if (!mins.length) throw new Error(`Candide gave no minimum for ${t.symbol} from chain ${sourceChainId}`);
        minAmount = mins.reduce((a, b) => (b < a ? b : a)).toString();
      }
      accepts.push({
        chainId: sourceChainId,
        ...(route?.sourceChainName ? { chainName: route.sourceChainName } : {}),
        symbol: t.symbol,
        address: t.address as `0x${string}`,
        decimals: t.decimals,
        ...(minAmount ? { minAmount } : {}),
        ...(typeof t.feeBps === "number" ? { feeBps: t.feeBps } : {}),
      });
    }
  }
  if (!accepts.length) {
    throw new Error(`Candide has no route that delivers ${token} on chain ${CHAIN_ID}`);
  }
  return accepts;
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
  /** Destination-chain token every source route must deliver (the app's USDC). */
  token: `0x${string}`;
}): Promise<PaymentForwarderActivation> {
  const recipient = assertAddress("recipient", params.recipient);
  const salt = forwardingSalt(params.userId, params.handle);
  const now = new Date().toISOString();

  // Candide routes only to Circle's USDC, so the staging dollar (zUSD) is
  // taken straight into the Safe on this chain.
  if (!FORWARDING.rpcUrl || usdIsStaging()) {
    if (IS_PRODUCTION && !usdIsStaging()) {
      throw new Error("Candide Forwarding Address API must be configured before activating payment pages");
    }
    return {
      address: recipient,
      accepts: [{ chainId: CHAIN_ID, symbol: usdToken().symbol, address: assertAddress("token", params.token), decimals: 6 }],
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
  // The destination chain is always asked too: Candide forwards same-chain
  // deposits once an address is active, if its routes list that token.
  const configured = [...new Set([CHAIN_ID, ...FORWARDING.sourceChainIds])];
  const accepts = await acceptedTokens(configured, assertAddress("token", params.token));
  // Monitor only the chains a listed token comes from.
  const sourceChainIds = configured.filter((id) => accepts.some((t) => t.chainId === id));
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
    accepts,
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
