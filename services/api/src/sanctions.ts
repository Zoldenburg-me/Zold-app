/**
 * Address screening before a send to an address the user chose: Chainalysis's
 * sanctions oracle, read on chain, so it needs no key and nothing about the
 * user leaves us. It answers for sanctions lists only, not for wider risk.
 *
 * Test chains have no oracle and no real money. A real chain with no oracle,
 * or a read that fails, throws: no answer, no send.
 */
import { CHAIN_ID, REAL_MONEY_CHAINS } from "./config.js";
import { publicClient } from "./chain.js";

const ORACLES: Record<number, `0x${string}`> = {
  8453: "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",
};

const ORACLE_ABI = [
  { type: "function", name: "isSanctioned", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export async function isSanctioned(
  address: `0x${string}`,
  chainId = CHAIN_ID,
  read: (oracle: `0x${string}`, address: `0x${string}`) => Promise<boolean> = (oracle, a) =>
    publicClient.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "isSanctioned", args: [a] }),
): Promise<boolean> {
  if (!REAL_MONEY_CHAINS.has(chainId)) return false;
  const oracle = ORACLES[chainId];
  if (!oracle) throw new Error(`no sanctions oracle on chain ${chainId}`);
  return read(oracle, address);
}
