/**
 * Deploys the ENS OffchainResolver (contracts/src/OffchainResolver.sol) to
 * Ethereum mainnet or Sepolia, where ENS lives. Base is never the target.
 *
 *   ENS_RPC_URL, ENS_CHAIN_ID   the L1 to deploy on (1 or 11155111)
 *   ENS_DEPLOYER_KEY            pays the gas and becomes the resolver's owner
 *   ENS_GATEWAY_URL             ERC-3668 template, e.g.
 *                               https://zoldhq.com/api/ens/gateway/{sender}/{data}.json
 *   ENS_GATEWAY_SIGNER          the ADDRESS of ENS_GATEWAY_KEY (the key itself
 *                               stays on the API host and is not read here)
 *
 * The owner can repoint every name. Move it to a hardware wallet afterwards
 * (`transferOwnership`, then `acceptOwnership` from that wallet). Use a
 * different ENS_GATEWAY_KEY per chain: the signature does not bind the chain.
 * Prints the address to set as ENS_RESOLVER_ADDRESS and in the DNS TXT record
 * (docs/ens.md). Run: npm run deploy:ens-resolver
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — shell environment only
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see the header of this script)`);
  return v;
}

const chainId = Number(need("ENS_CHAIN_ID"));
const chain = chainId === 1 ? mainnet : chainId === 11155111 ? sepolia : undefined;
if (!chain) throw new Error("ENS_CHAIN_ID must be 1 (mainnet) or 11155111 (Sepolia)");
const key = need("ENS_DEPLOYER_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ENS_DEPLOYER_KEY is not a 32-byte hex private key");
const url = need("ENS_GATEWAY_URL");
if (!url.startsWith("https://") || !url.includes("{data}")) {
  throw new Error("ENS_GATEWAY_URL must be an https URL containing {data} (a GET gateway)");
}
const signer = need("ENS_GATEWAY_SIGNER");
if (!isAddress(signer)) throw new Error("ENS_GATEWAY_SIGNER is not an address");

const transport = http(need("ENS_RPC_URL"));
const pub = createPublicClient({ chain, transport });
if ((await pub.getChainId()) !== chainId) throw new Error(`ENS_RPC_URL is not chain ${chainId}`);
const wallet = createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain, transport });

const { abi, bytecode } = JSON.parse(
  readFileSync(path.join(ROOT, "contracts/artifacts/contracts/src/OffchainResolver.sol/OffchainResolver.json"), "utf8"),
);
const hash = await wallet.deployContract({ abi, bytecode, args: [url, [signer]] });
console.log(`deploying on ${chain.name}: ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed: ${hash}`);
console.log(`OffchainResolver: ${receipt.contractAddress}`);
console.log(`owner: ${wallet.account.address} — move it to a hardware wallet: transferOwnership, then acceptOwnership from it`);
