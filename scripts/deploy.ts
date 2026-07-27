/**
 * Deploys the contract set, wires roles, seeds FX inventory, and records the
 * addresses under this chain's id in deployments.json.
 *
 * Chain comes from TRANSF_CHAIN_ID (default 31337 = hardhat). Real keys come
 * from the environment; the hardhat defaults are refused on any non-local RPC
 * unless explicitly overridden, so a testnet deploy needs real funded keys.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { hardhat, polygon, polygonAmoy } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load .env before anything reads process.env.
 *
 * This script used to read the environment directly while only the API loaded
 * .env, so a chain and RPC configured there were silently ignored here: you
 * could set TRANSF_CHAIN_ID=84532, run the deploy, and have it go to the local
 * hardhat default instead — the one outcome that looks like success while
 * being completely wrong. config.js does this too, but it is imported lazily
 * further down, which is far too late.
 */
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — shell environment or defaults
}

const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.TRANSF_CHAIN_ID ?? 31337);

const chain = (() => {
  switch (CHAIN_ID) {
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
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

function key(name: "deployer" | "orchestrator" | "ramp"): `0x${string}` {
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
  orchestrator: key("orchestrator"),
  ramp: key("ramp"),
} as const;

/**
 * Never put hardhat's published keys on a chain anyone else can reach.
 *
 * Checked against the keys we actually resolved, not against the RPC alone.
 * The old form refused every non-local RPC outright, so a deployment with
 * three real keys was blocked, and the documented way past it
 * (ALLOW_DEV_KEYS_ON_EXTERNAL_RPC=1) would also have waved through the real
 * dev keys — the exact thing being guarded against.
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
const orchestratorAddr = privateKeyToAccount(KEYS.orchestrator).address;
const rampAddr = privateKeyToAccount(KEYS.ramp).address;

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

async function call(address: `0x${string}`, name: string, functionName: string, args: any[]) {
  const { abi } = artifact(name);
  const { request } = await publicClient.simulateContract({
    account: deployer.account,
    address,
    abi,
    functionName,
    args,
  });
  const hash = await deployer.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
}

const DAILY_CAP_EUR = parseUnits("2500", 18);
// Governance: admin actions run through an M-of-N timelock, so no single key
// can raise the cap, grant itself a role, or drain the swapper. Local dev uses
// a short delay and the hardhat accounts; a real deployment sets these from
// env and the owners are hardware/multisig keys held by different people.
const TIMELOCK_DELAY = BigInt(process.env.TIMELOCK_DELAY_SECONDS ?? 60);
const TIMELOCK_THRESHOLD = Number(process.env.TIMELOCK_THRESHOLD ?? 2);
/**
 * Seed the swapper at the live EUR/USD mid rather than a constant.
 *
 * This was hardcoded 1_080_000 (1.08) and by July 2026 the real rate was
 * 1.1379, so every fresh deploy was born ~5% stale — and because the quote
 * engine now reads its EUR leg from this contract, a stale seed prices every
 * corridor. DEPLOY_EURUSD_RATE pins it for a reproducible/offline deploy.
 *
 * Note the swapper's owner becomes the AdminTimelock below, so changing this
 * afterwards is a governed action, not a redeploy.
 */
async function eurUsdSeed(): Promise<bigint> {
  const pinned = process.env.DEPLOY_EURUSD_RATE;
  if (pinned) return BigInt(pinned);
  const { eurPer } = await import("../services/api/src/rates.js");
  const rate = await eurPer("USD");
  return BigInt(Math.round(rate * 1e6));
}
const SWAP_INVENTORY_EURE = parseUnits("1000000", 18);
const SWAP_INVENTORY_USDC = parseUnits("1000000", 6);

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
   * mints Monerium's real EURe into the user's Safe, so a vault backed by our
   * token is backed by something no deposit can produce — and both tokens
   * would sit on the same chain calling themselves EURe. The mock exists so
   * that a hardhat node can have EURe at all, not as a stand-in for the real
   * one where the real one is available.
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
  const usdc = await deploy("MockToken", ["USD Coin (mock)", "USDC", 6]);
  const vault = await deploy("RemitVault", [eure, DAILY_CAP_EUR]);
  const eurUsdRate = await eurUsdSeed();
  console.log(`swapper seeded at EUR/USD ${(Number(eurUsdRate) / 1e6).toFixed(4)}`);
  const swapper = await deploy("FxSwapper", [eure, usdc, eurUsdRate]);
  const bridge = await deploy("BridgeEscrow", [usdc]);

  // Hardhat accounts #0/#1/#2 stand in for three separate signers.
  const timelockOwners = [
    deployer.account.address,
    privateKeyToAccount(KEYS.orchestrator).address,
    privateKeyToAccount(KEYS.ramp).address,
  ];
  const timelock = await deploy("AdminTimelock", [
    timelockOwners,
    TIMELOCK_THRESHOLD,
    TIMELOCK_DELAY,
  ]);

  await call(vault, "RemitVault", "setRamp", [rampAddr, true]);
  await call(vault, "RemitVault", "setOrchestrator", [orchestratorAddr, true]);
  await call(swapper, "FxSwapper", "setTrader", [orchestratorAddr, true]);
  await call(bridge, "BridgeEscrow", "setOrchestrator", [orchestratorAddr, true]);
  /**
   * Seed the swapper's inventory.
   *
   * USDC here is our own mock, so it can be minted. EURe cannot be when it is
   * Monerium's — we are not its owner, and the mint reverts. That only starves
   * the USDC->EURe direction, which is the refund/compensation path; the
   * outbound EUR->USDC leg every transfer uses needs USDC inventory, which we
   * do have. Funding the reverse side means sending real EURe to the swapper.
   */
  if (real) {
    console.log(
      `EURe inventory   skipped — ${eure} is Monerium's token and cannot be minted.\n` +
        `                 USDC->EURe swaps (refunds) have no inventory until it is funded.`,
    );
  } else {
    await call(eure, "MockToken", "mint", [swapper, SWAP_INVENTORY_EURE]);
  }
  await call(usdc, "MockToken", "mint", [swapper, SWAP_INVENTORY_USDC]);

  // A guardian can halt the system instantly without waiting out the timelock.
  await call(vault, "RemitVault", "setGuardian", [rampAddr]);
  await call(swapper, "FxSwapper", "setGuardian", [rampAddr]);

  // Roles are wired BEFORE ownership moves — afterwards every admin call has
  // to be queued, confirmed and waited out, which is the point.
  await call(vault, "RemitVault", "transferOwnership", [timelock]);
  await call(swapper, "FxSwapper", "transferOwnership", [timelock]);
  await call(bridge, "BridgeEscrow", "transferOwnership", [timelock]);

  const out = { eure, usdc, vault, swapper, bridge, timelock };
  const file = path.join(ROOT, "deployments.json");
  let all: Record<string, unknown> = {};
  try {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    // Migrate a legacy flat file into its chain slot rather than dropping it.
    all = typeof existing.vault === "string" ? { "31337": existing } : existing;
  } catch {
    all = {};
  }
  all[String(CHAIN_ID)] = out;
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  console.log(
    `\nroles wired, swapper seeded with ${real ? "0" : "1,000,000"} EURe and 1,000,000 USDC` +
      `\nadmin ownership -> AdminTimelock ${timelock} (${TIMELOCK_THRESHOLD}-of-${timelockOwners.length}, ${TIMELOCK_DELAY}s delay)`,
  );
  console.log(`wrote deployments.json entry for chain ${CHAIN_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
