import { envNumber, IS_REAL_MONEY_CHAIN } from "./env.js";

/**
 * ENS: payment-page handles as names (`alice.zoldhq.com`), and ENS names as
 * something a user can look up.
 *
 * The gateway answers CCIP-Read (ERC-3668) lookups that the L1 OffchainResolver
 * (contracts/src/OffchainResolver.sol) sends here, and signs each answer
 * with ENS_GATEWAY_KEY. The contract accepts an answer only if that key's
 * address is one of its signers. Whoever holds the key can point every handle
 * at any address, so it is used for nothing else, and the gateway is off
 * until all three settings are present. Setting only some of them fails at
 * startup instead of serving lookups that the contract would refuse.
 */
export const ENS_GATEWAY = (() => {
  const parent = process.env.ENS_PARENT_NAME?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  const resolver = process.env.ENS_RESOLVER_ADDRESS?.trim() ?? "";
  const key = process.env.ENS_GATEWAY_KEY?.trim() ?? "";
  const set = [parent, resolver, key].filter(Boolean).length;
  if (set > 0 && set < 3) {
    throw new Error("ENS gateway needs ENS_PARENT_NAME, ENS_RESOLVER_ADDRESS and ENS_GATEWAY_KEY together — set all three or none");
  }
  if (parent && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parent)) throw new Error("ENS_PARENT_NAME must be a name like zoldhq.com");
  if (resolver && !/^0x[0-9a-fA-F]{40}$/.test(resolver)) throw new Error("ENS_RESOLVER_ADDRESS is not an address");
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ENS_GATEWAY_KEY is not a 32-byte hex private key");
  const otherKeys = ["FAUCET_KEY", "ORCHESTRATOR_KEY", "RAMP_KEY", "DEPLOYER_KEY", "DEPLOY_ORCHESTRATOR_KEY", "DEPLOY_RAMP_KEY", "DEPLOY_DEPLOYER_KEY"];
  const shared = otherKeys.find((name) => key && process.env[name]?.trim().toLowerCase() === key.toLowerCase());
  if (shared) throw new Error(`ENS_GATEWAY_KEY must not be the same key as ${shared} — it signs where every handle points, and nothing else`);
  return {
    enabled: set === 3,
    parent,
    resolver: resolver.toLowerCase() as `0x${string}`,
    key: (key || undefined) as `0x${string}` | undefined,
    /** How long a signed answer is valid. Short, because a repointed or
     *  closed page should stop resolving soon after. */
    ttlSeconds: envNumber("ENS_GATEWAY_TTL_S", 300, { min: 30 }),
  };
})();

/**
 * Where ENS names are looked up: an RPC endpoint for Ethereum mainnet (1) or
 * Sepolia (11155111), the two chains ENS's registry lives on. Off without
 * one. The pay chain is never used for this: ENS is not deployed on Base.
 */
export const ENS_LOOKUP = (() => {
  const rpcUrl = process.env.ENS_RPC_URL?.trim() ?? "";
  const chainId = Number(process.env.ENS_CHAIN_ID ?? (rpcUrl ? NaN : 0));
  if (rpcUrl && chainId !== 1 && chainId !== 11155111) {
    throw new Error("ENS_RPC_URL needs ENS_CHAIN_ID set to 1 (mainnet) or 11155111 (Sepolia)");
  }
  // Anyone can register any name on Sepolia, `vitalik.eth` included, so a
  // Sepolia answer must never become an address for real money.
  if (rpcUrl && chainId === 11155111 && IS_REAL_MONEY_CHAIN) {
    throw new Error("ENS_CHAIN_ID=11155111 (Sepolia) on a real-money chain — Sepolia names are free to take; use mainnet ENS");
  }
  return { enabled: Boolean(rpcUrl), rpcUrl, chainId };
})();
