/** Minimal Hardhat config, used only for compiling and the local dev chain. */
export default {
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
    hardhat: { type: "edr-simulated", chainId: 31337 },
  },
};
