/**
 * Records this chain's addresses under its id in deployments.json. On local
 * hardhat (31337) it deploys mock EURe and USDC; on a real chain it deploys
 * nothing and records only Monerium's EURe and Circle's USDC.
 *
 * Chain comes from TRANSF_CHAIN_ID (default 8453 = Base mainnet). Real keys come
 * from the environment; the hardhat defaults are refused on any non-local RPC
 * unless explicitly overridden, so a testnet deploy needs real funded keys.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { base, baseSepolia, hardhat, polygon, polygonAmoy } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load .env before anything reads process.env. Otherwise a chain and RPC
 * configured there are silently ignored here: TRANSF_CHAIN_ID=84532 in .env
 * and the deploy goes to the local hardhat default instead — the one outcome
 * that looks like success while being completely wrong. config.js does this
 * too, but it is imported lazily further down, which is far too late.
 */
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — shell environment or defaults
}

const RPC_URL = process.env.TRANSF_RPC_URL ?? "https://mainnet.base.org";
const CHAIN_ID = Number(process.env.TRANSF_CHAIN_ID ?? 8453);

/**
 * Circle's USDC, per chain, verified with eth_getCode + symbol() (Sep 2026).
 * On a real chain nothing is deployed for USDC — it is theirs. Other chains
 * need DEPLOY_USDC_ADDRESS.
 */
const KNOWN_USDC: Record<number, `0x${string}`> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const chain = (() => {
  switch (CHAIN_ID) {
    case base.id: return base;
    case baseSepolia.id: return baseSepolia;
    case hardhat.id: return hardhat;
    case polygonAmoy.id: return polygonAmoy;
    case polygon.id: return polygon;
    default:
      return defineChain({
        id: CHAIN_ID,
        name: `chain-${CHAIN_ID}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [RPC_URL] } },
      });
  }
})();

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(RPC_URL);

/** Hardhat's well-known accounts — fine locally, never off it. */
const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
} as const;

function key(name: "deployer"): `0x${string}` {
  const fromEnv = process.env[`DEPLOY_${name.toUpperCase()}_KEY`];
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(`DEPLOY_${name.toUpperCase()}_KEY is not a 32-byte hex private key`);
    }
    return fromEnv as `0x${string}`;
  }
  if (CHAIN_ID !== hardhat.id) {
    throw new Error(
      `deploying to chain ${CHAIN_ID} needs a real DEPLOY_${name.toUpperCase()}_KEY — ` +
        `the hardhat development keys are public and must not hold funds`,
    );
  }
  return DEV_KEYS[name];
}

const KEYS = {
  deployer: key("deployer"),
} as const;

/**
 * Never put hardhat's published keys on a chain anyone else can reach.
 *
 * Checked against the resolved keys, not the RPC alone. Refusing every
 * non-local RPC would block a deployment with real keys, and the override
 * (ALLOW_DEV_KEYS_ON_EXTERNAL_RPC=1) would then let the dev keys through too.
 */
if (!LOCAL_RPC) {
  const dev = Object.values(DEV_KEYS).map((k) => k.toLowerCase());
  const offenders = (Object.keys(KEYS) as (keyof typeof KEYS)[]).filter((r) =>
    dev.includes(KEYS[r].toLowerCase()),
  );
  if (offenders.length && process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC !== "1") {
    throw new Error(
      `refusing to deploy hardhat development keys to a non-local RPC: ${offenders.join(", ")} ` +
        `${offenders.length > 1 ? "are" : "is"} a published key anyone can spend from. ` +
        `Set DEPLOY_${offenders[0].toUpperCase()}_KEY to a key you control.`,
    );
  }
}

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const deployer = createWalletClient({
  account: privateKeyToAccount(KEYS.deployer),
  chain,
  transport: http(RPC_URL),
});

function artifact(name: string) {
  const p = path.join(ROOT, "contracts/artifacts/contracts/src", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function deploy(name: string, args: any[]): Promise<`0x${string}`> {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy failed: ${name}`);
  console.log(`${name.padEnd(14)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

function writeDeployments(out: Record<string, `0x${string}`>) {
  const file = path.join(ROOT, "deployments.json");
  let all: Record<string, unknown> = {};
  try {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    // Migrate a legacy flat file into its chain slot rather than dropping it.
    all = typeof existing.eure === "string" ? { "31337": existing } : existing;
  } catch {
    all = {};
  }
  all[String(CHAIN_ID)] = out;
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
}

async function main() {
  // Deploying to the wrong chain wastes gas and produces addresses the API will
  // silently use with a mismatched EIP-712 domain. Check before spending.
  const actual = await publicClient.getChainId();
  if (actual !== CHAIN_ID) {
    throw new Error(`RPC at ${RPC_URL} is chain ${actual}, but TRANSF_CHAIN_ID is ${CHAIN_ID}`);
  }
  console.log(`deploying to chain ${CHAIN_ID} via ${RPC_URL}`);

  /**
   * On a chain where Monerium really issues EURe, use THEIR token.
   *
   * Deploying our own MockToken there would be worse than pointless: a deposit
   * mints Monerium's real EURe into the user's Safe, so a mock token would be
   * something no deposit can produce. The mock exists so that a hardhat node can
   * have EURe at all, not as a stand-in for the real one where the real one is
   * available.
   */
  const { moneriumEure } = await import("../services/api/src/adapters/monerium-tokens.js");
  const { MONERIUM } = await import("../services/api/src/config.js");
  const real = await moneriumEure(MONERIUM.baseUrl, CHAIN_ID);
  let eure: `0x${string}`;
  if (real) {
    eure = real.address;
    console.log(`EURe   ${eure}  (Monerium's own on ${real.chain} — not deployed by us)`);
  } else if (CHAIN_ID === hardhat.id) {
    eure = await deploy("MockToken", ["Monerium EUR emoney (mock)", "EURe", 18]);
  } else {
    // Refuse rather than quietly minting a token nobody can deposit into.
    const { moneriumEvmChains } = await import("../services/api/src/adapters/monerium-tokens.js");
    const chains = await moneriumEvmChains(MONERIUM.baseUrl).catch(() => []);
    throw new Error(
      `chain ${CHAIN_ID} is not local, and Monerium issues no EURe there, so deposits ` +
        `could never arrive. Monerium issues on: ${chains.join(", ") || "(could not reach Monerium)"}`,
    );
  }
  /**
   * Off hardhat, the deployment is the two real token addresses and nothing
   * else. Liquidity comes from LI.FI / Uniswap through the user's own Safe.
   * Don't deploy mock USDC here: every rail would point at a token nobody
   * holds.
   */
  if (CHAIN_ID !== hardhat.id) {
    const usdcAddr = (process.env.DEPLOY_USDC_ADDRESS as `0x${string}` | undefined) ?? KNOWN_USDC[CHAIN_ID];
    if (!usdcAddr) {
      throw new Error(`no USDC address known for chain ${CHAIN_ID}; set DEPLOY_USDC_ADDRESS to Circle's USDC there`);
    }
    const code = await publicClient.getCode({ address: usdcAddr });
    if (!code || code === "0x") throw new Error(`USDC ${usdcAddr} has no code on chain ${CHAIN_ID}`);
    console.log(`USDC   ${usdcAddr}  (Circle's own — not deployed by us)`);
    writeDeployments({ eure, usdc: usdcAddr });
    console.log(`wrote deployments.json entry for chain ${CHAIN_ID}: token addresses only, nothing deployed`);
    return;
  }

  const usdc = await deploy("MockToken", ["USD Coin (mock)", "USDC", 6]);
  writeDeployments({ eure, usdc });
  console.log(`wrote deployments.json entry for chain ${CHAIN_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
