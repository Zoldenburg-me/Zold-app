import { CANDIDE_FORWARDING } from "../config.js";

export interface ForwardingAddressParams {
  recipient: `0x${string}`;
  custodialWithdrawer: `0x${string}`;
  destinationChainId: number;
  sourceChainIds?: number[];
  salt?: `0x${string}`;
}

export interface ForwardingActivation {
  address: `0x${string}`;
  active: boolean;
  expiresAt: number;
}

async function forwardingRpc<T>(method: string, params: unknown, apiKey?: string): Promise<T> {
  if (!CANDIDE_FORWARDING.rpcUrl) throw new Error("CANDIDE_FORWARDING_RPC_URL is required");
  const res = await fetch(CANDIDE_FORWARDING.rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: [params] }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `Candide forwarding ${method} failed (${res.status})`);
  }
  return body.result as T;
}

export async function getForwardingAddress(
  params: ForwardingAddressParams,
): Promise<{ address: `0x${string}` }> {
  return forwardingRpc("forwarding_getAddress", {
    recipient: params.recipient,
    custodialWithdrawer: params.custodialWithdrawer,
    destinationChainId: params.destinationChainId,
    ...(params.salt ? { salt: params.salt } : {}),
  });
}

export async function activateForwardingAddress(
  params: ForwardingAddressParams & { sourceChainIds: number[] },
): Promise<ForwardingActivation> {
  return forwardingRpc(
    "account_activateForwardingAddress",
    {
      recipient: params.recipient,
      custodialWithdrawer: params.custodialWithdrawer,
      destinationChainId: params.destinationChainId,
      sourceChainIds: params.sourceChainIds,
      ...(params.salt ? { salt: params.salt } : {}),
    },
    CANDIDE_FORWARDING.apiKey,
  );
}
