/**
 * Asking a wallet's own chain whether it signed its ownership challenge.
 *
 * The chain is the wallet's (`ImportedWallet.chainId`), read through the RPC
 * the operator configured for it (WALLET_SYNC_RPC_<chainId>), the same one
 * sync reads. The request never names an RPC. Before the signature is
 * checked, the node must report the wallet's chain id: a proof is never
 * checked on a chain other than the one it names.
 *
 * Fails closed: no RPC for the chain, a node that errors, times out or
 * reports another chain is `unverified`, never valid.
 */
import { createPublicClient, http } from "viem";
import { WALLET_SYNC } from "../config.js";
import type { ImportedWallet } from "../domain/types.js";
import { checkSignedMessage, type SignatureCheck, type SignatureClient } from "../wallet/signature-check.js";

const TIMEOUT_MS = 15_000;

type OwnershipClient = SignatureClient & { getChainId(): Promise<number> };
const clients = new Map<number, OwnershipClient>();

function clientFor(chainId: number): OwnershipClient | undefined {
  const rpc = WALLET_SYNC.rpcs[chainId];
  if (!rpc) return undefined;
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({ transport: http(rpc, { timeout: TIMEOUT_MS, retryCount: 0 }) });
    clients.set(chainId, client);
  }
  return client;
}

export async function verifyOwnership(
  wallet: Pick<ImportedWallet, "address" | "chainId">,
  message: string,
  signature: `0x${string}`,
  /** On a re-check: the method the proof was made with. */
  expect?: "eip1271" | "ecdsa",
): Promise<SignatureCheck> {
  const client = clientFor(wallet.chainId);
  if (!client) {
    return { verdict: "unverified", reason: `Zold has no connection to network ${wallet.chainId}, so it cannot ask that chain` };
  }
  let reported: number;
  let timer: NodeJS.Timeout | undefined;
  try {
    reported = await Promise.race([
      client.getChainId(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { verdict: "unverified", reason: "the network did not answer" };
  } finally {
    clearTimeout(timer);
  }
  if (reported !== wallet.chainId) {
    return { verdict: "unverified", reason: `the connection for network ${wallet.chainId} answers for chain ${reported}` };
  }
  return checkSignedMessage(client, { address: wallet.address, message, signature }, { timeoutMs: TIMEOUT_MS, expect });
}
