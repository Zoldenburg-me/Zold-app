/**
 * Deploy ZoldUSD (zUSD), the staging dollar, from the faucet wallet.
 *
 *   npm run deploy:zusd          report the faucet wallet and what exists
 *   npm run deploy:zusd -- --send deploy, mint the supply, record it
 *
 * ZUSD_SALT=0x… deploys through CreateX with CREATE3, so the address comes
 * from the salt alone (mine one for a vanity address). The salt must start
 * with the faucet address and a 0x00 byte: CreateX then lets only that wallet
 * use it, on any chain. Without ZUSD_SALT it is a plain CREATE.
 *
 * The faucet wallet (FAUCET_KEY) deploys it, so it owns it: it mints the
 * supply, drips it through FAUCET_DRIPS, and seeds the zUSD/EURe pool
 * (`npm run dex:setup` with DEX_USDC set to zUSD). Refused on a real-money
 * chain here and again in the constructor. Writes `zusd` into this chain's
 * deployments.json entry and touches nothing else there.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, formatUnits, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — shell environment
}

const { CHAIN_ID, IS_REAL_MONEY_CHAIN } = await import("../services/api/src/config.js");
const { chain } = await import("../services/api/src/chain.js");

const SEND = process.argv.includes("--send");
const SUPPLY = parseUnits(process.env.ZUSD_SUPPLY ?? "1000000", 6);
const RPC_URL = process.env.TRANSF_RPC_URL;
const FILE = path.join(ROOT, "deployments.json");
const SALT = process.env.ZUSD_SALT as `0x${string}` | undefined;
/** CreateX, at the same address on every chain it is deployed to. */
const CREATEX = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
const createxAbi = parseAbi(["function deployCreate3(bytes32 salt, bytes initCode) payable returns (address)"]);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
]);

function faucetAccount() {
  const key = process.env.FAUCET_KEY;
  if (!key) throw new Error("FAUCET_KEY is not set — zUSD is deployed and owned by the faucet wallet");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("FAUCET_KEY is not a 32-byte hex private key");
  return privateKeyToAccount(key as `0x${string}`);
}

function readAll(): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(FILE, "utf8"));
}

async function main() {
  if (IS_REAL_MONEY_CHAIN) throw new Error(`refusing: chain ${CHAIN_ID} carries real money and zUSD is a test token`);
  if (!RPC_URL) throw new Error("TRANSF_RPC_URL is not set");
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const actual = await pub.getChainId();
  if (actual !== CHAIN_ID) throw new Error(`RPC is chain ${actual}, but TRANSF_CHAIN_ID is ${CHAIN_ID}`);

  const account = faucetAccount();
  const entry = readAll()[String(CHAIN_ID)];
  if (!entry) throw new Error(`deployments.json has no entry for chain ${CHAIN_ID} — run npm run deploy first`);

  const [eth, eure] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: entry.eure as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`chain ${CHAIN_ID}  faucet wallet ${account.address}`);
  console.log(`  ETH  ${formatUnits(eth, 18)}`);
  console.log(`  EURe ${formatUnits(eure as bigint, 18)}  (${entry.eure})`);

  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const art = JSON.parse(readFileSync(path.join(ROOT, "contracts/artifacts/contracts/src/ZoldUSD.sol/ZoldUSD.json"), "utf8"));

  let zusd = entry.zusd as `0x${string}` | undefined;
  if (zusd) {
    const code = await pub.getCode({ address: zusd });
    if (!code || code === "0x") throw new Error(`deployments.json names zUSD ${zusd}, but it has no code on chain ${CHAIN_ID}`);
    const owner = (await pub.readContract({ address: zusd, abi: erc20, functionName: "owner" })) as string;
    console.log(`\n✓ zUSD deployed: ${zusd}  owner ${owner}`);
    if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error("the faucet wallet does not own this zUSD, so it cannot mint");
  } else {
    if (eth === 0n) throw new Error("the faucet wallet has no ETH for gas");
    if (!SEND) {
      console.log(`\nno zUSD on this chain. Re-run with --send to deploy it and mint ${formatUnits(SUPPLY, 6)} zUSD to the faucet wallet.`);
      return;
    }
    zusd = SALT ? await deployCreate3(pub, wallet, account.address, art) : await deployPlain(pub, wallet, account.address, art);
    // Record before minting, so a failed mint never leaves a deployed token unrecorded.
    const all = readAll();
    all[String(CHAIN_ID)] = { ...all[String(CHAIN_ID)], zusd };
    writeFileSync(FILE, JSON.stringify(all, null, 2) + "\n");
    console.log(`  recorded as deployments.json["${CHAIN_ID}"].zusd`);
  }

  const have = (await pub.readContract({ address: zusd, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`  faucet holds ${formatUnits(have, 6)} zUSD, target ${formatUnits(SUPPLY, 6)}`);
  if (have >= SUPPLY) return;
  if (!SEND) {
    console.log(`  re-run with --send to mint the ${formatUnits(SUPPLY - have, 6)} zUSD shortfall`);
    return;
  }
  await waitForCode(pub, zusd);
  // Simulate first: a load-balanced public RPC can estimate gas on a node that
  // has not seen the new contract yet, and the mint then ships with ~23k gas
  // and runs out.
  const { request } = await pub.simulateContract({ account, address: zusd, abi: art.abi, functionName: "mint", args: [account.address, SUPPLY - have] });
  const mintHash = await wallet.writeContract(request);
  const minted = await pub.waitForTransactionReceipt({ hash: mintHash });
  if (minted.status !== "success") throw new Error(`mint reverted: ${mintHash}`);
  console.log(`✓ minted ${formatUnits(SUPPLY - have, 6)} zUSD to ${account.address}  (${mintHash})`);
}

async function deployPlain(pub: any, wallet: any, owner: `0x${string}`, art: any): Promise<`0x${string}`> {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [owner] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`zUSD deploy failed: ${hash}`);
  console.log(`\n✓ ZoldUSD ${receipt.contractAddress}  (${hash})`);
  return receipt.contractAddress;
}

/** CREATE3 through CreateX; the simulated address is checked against the code that lands. */
async function deployCreate3(pub: any, wallet: any, owner: `0x${string}`, art: any): Promise<`0x${string}`> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(SALT!)) throw new Error("ZUSD_SALT is not 32 bytes of hex");
  if (!SALT!.toLowerCase().startsWith(owner.toLowerCase() + "00")) {
    throw new Error(`ZUSD_SALT must start with the faucet address ${owner} and a 0x00 byte, so only it can deploy there`);
  }
  const initCode = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [owner] });
  const { request, result } = await pub.simulateContract({
    account: wallet.account, address: CREATEX, abi: createxAbi, functionName: "deployCreate3", args: [SALT, initCode],
  });
  console.log(`\nCreateX CREATE3 -> ${result}`);
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`CreateX deploy reverted: ${hash}`);
  await waitForCode(pub, result);
  console.log(`✓ ZoldUSD ${result}  (${hash})`);
  return result;
}

const CODE_WAIT_MS = 30_000;

/** Poll until the RPC serves the contract's code, so the next call is estimated against it. */
async function waitForCode(pub: { getCode: (a: { address: `0x${string}` }) => Promise<string | undefined> }, address: `0x${string}`) {
  const until = Date.now() + CODE_WAIT_MS;
  while (Date.now() < until) {
    const code = await pub.getCode({ address });
    if (code && code !== "0x") return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`the RPC still serves no code at ${address} after ${CODE_WAIT_MS / 1000}s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
