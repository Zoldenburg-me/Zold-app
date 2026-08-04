/**
 * Base mainnet fork, for exercising liquidity venues that only exist on mainnet.
 *
 * WHY THIS FILE. LI.FI, Bebop and CoW are all mainnet-only, so `execute()` on
 * every venue adapter has never run — the same gap that left Bebop's adapter
 * correct and unrun for a month. A fork closes it: the QUOTE comes from the
 * real API against real liquidity, and only settlement is local.
 *
 * The hardfork history is not optional. Hardhat only ships activation
 * histories for Ethereum, so forking Base fails every eth_call with
 * "No known hardfork for execution on historical block N in chain with id
 * 8453" — which reads like a broken RPC rather than missing config.
 *
 * Separate from hardhat.config.js on purpose: that one is used for compiling
 * and the local dev chain, and this must not change either.
 *
 *   npx hardhat node --config hardhat.fork.config.js --port 8555
 */
export default {
  // Hardhat only ships hardfork histories for Ethereum, so forking Base fails
  // every eth_call without this. Hardhat 3 reads it here, top-level — the
  // Hardhat 2 `networks.hardhat.chains` form is silently ignored.
  chainDescriptors: {
    8453: {
      name: "Base",
      chainType: "op",
      // OP-stack chains have their OWN hardfork names — hardhat rejects
      // "cancun" here and lists bedrock|regolith|canyon|ecotone|fjord|granite|
      // holocene|isthmus. Activating the newest at block 0 is right for any
      // recent fork point, and each entry must be {blockNumber} or {timestamp}.
      hardforkHistory: { isthmus: { blockNumber: 0 } },
    },
  },
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: {
    sources: "./contracts/src",
    artifacts: "./contracts/artifacts",
    cache: "./contracts/cache",
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
      forking: {
        url: process.env.FORK_RPC_URL ?? "https://mainnet.base.org",
        ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
      },
    },
  },
};
