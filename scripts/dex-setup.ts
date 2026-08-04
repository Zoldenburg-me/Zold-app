/**
 * Operator step: create and seed a EURe/USDC pool so the DEX provider has
 * something to trade against on a testnet.
 *
 * THIS IS A TEST FIXTURE, NOT A TREASURY. On mainnet the counterparty is
 * everyone else's liquidity and we carry nothing — that is the entire point of
 * moving off the FxSwapper. But nobody has made a EURe market on Base Sepolia
 * (checked: no pool at any fee tier, while WETH/USDC has real depth), so the
 * only way to exercise a real swap here is to post both sides ourselves. Every
 * number the DEX provider reports on this chain is therefore ours, not a
 * market's. Do not read a testnet quote as evidence of real pricing.
 *
 *   npm run dex:setup          report what exists and what is missing
 *   npm run dex:setup -- --fix create the pool and mint a full-range position
 *
 * Mirrors `npm run stellar:setup`: read-only unless asked to change anything.
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LIQUIDITY } from "../services/api/src/config.js";
import { chain } from "../services/api/src/chain.js";
import { eurPer } from "../services/api/src/rates.js";
import { bestPool } from "../services/api/src/dex.js";

process.loadEnvFile?.(".env");

const FIX = process.argv.includes("--fix");
const POSITION_MANAGER = (process.env.DEX_POSITION_MANAGER ??
  "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2") as `0x${string}`;
/** fee -> tickSpacing, from the v3 factory defaults. */
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const FEE = Number(process.env.DEX_SETUP_FEE ?? 500);
/** How much of each side to post. Small on purpose — enough to quote, not a book. */
const SEED_EUR = Number(process.env.DEX_SEED_EUR ?? 5);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const npmAbi = parseAbi([
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
]);

/** Integer square root (Newton). Needed because sqrtPriceX96 must be exact. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/**
 * sqrt(price) * 2^96, where price is token1-raw per token0-raw.
 *
 * Decimals are the trap here: EURe is 18dp and USDC 6dp, so the raw ratio is
 * ~1e12 away from the human rate. Getting this wrong initialises the pool at an
 * absurd price and the first trade through it is a donation.
 */
function sqrtPriceX96For(amount0Raw: bigint, amount1Raw: bigint): bigint {
  return isqrt((amount1Raw << 192n) / amount0Raw);
}

async function main() {
  const rpc = process.env.TRANSF_RPC_URL!;
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const key = (process.env.DEPLOY_DEPLOYER_KEY ?? process.env.DEPLOYER_KEY) as `0x${string}` | undefined;
  if (!key) throw new Error("DEPLOY_DEPLOYER_KEY is required to seed a pool");
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const eure = (process.env.DEX_EURE ?? "0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85") as `0x${string}`;
  const usdc = (process.env.CCTP_USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;

  console.log(`chain ${chain.id}  deployer ${account.address}  fee tier ${FEE}`);

  const existing = await bestPool(eure, usdc);
  if (existing) {
    console.log(`\n✓ pool already seeded: ${existing.address} (fee ${existing.fee}, liquidity ${existing.liquidity})`);
    console.log("  nothing to do — the DEX provider can quote against this.");
    return;
  }
  console.log("\n✗ no EURe/USDC pool with liquidity on this chain");

  // --- prerequisites, reported together rather than one failure at a time ---
  const [eDec, uDec] = await Promise.all([
    pub.readContract({ address: eure, abi: erc20, functionName: "decimals" }) as Promise<number>,
    pub.readContract({ address: usdc, abi: erc20, functionName: "decimals" }) as Promise<number>,
  ]);
  const mid = await eurPer("USD");
  const needEure = parseUnits(String(SEED_EUR), eDec);
  const needUsdc = parseUnits((SEED_EUR * mid).toFixed(uDec), uDec);
  const [haveEure, haveUsdc, haveGas] = await Promise.all([
    pub.readContract({ address: eure, abi: erc20, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>,
    pub.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>,
    pub.getBalance({ address: account.address }),
  ]);

  const gaps: string[] = [];
  console.log(`\nlive mid ${mid.toFixed(4)} USD/EUR — seeding ${SEED_EUR} EURe against ${formatUnits(needUsdc, uDec)} USDC`);
  console.log(`  EURe  have ${formatUnits(haveEure, eDec)}  need ${formatUnits(needEure, eDec)}`);
  console.log(`  USDC  have ${formatUnits(haveUsdc, uDec)}  need ${formatUnits(needUsdc, uDec)}`);
  console.log(`  gas   have ${formatUnits(haveGas, 18)} ETH`);
  if (haveEure < needEure) {
    gaps.push(
      `EURe short by ${formatUnits(needEure - haveEure, eDec)}. EURe is only minted by Monerium against a real ` +
        `SEPA deposit to a user IBAN — there is no faucet. Fund an account, then transfer EURe to the deployer.`,
    );
  }
  if (haveUsdc < needUsdc) gaps.push(`USDC short by ${formatUnits(needUsdc - haveUsdc, uDec)} — faucet.circle.com`);
  if (haveGas === 0n) gaps.push("no ETH for gas");

  if (gaps.length) {
    console.log("\nREFUSING to seed:");
    for (const g of gaps) console.log(`  - ${g}`);
    process.exitCode = 1;
    return;
  }
  if (!FIX) {
    console.log("\nprerequisites met. Re-run with --fix to create and seed the pool.");
    return;
  }

  // --- create + seed ---
  const [token0, token1] = eure.toLowerCase() < usdc.toLowerCase() ? [eure, usdc] : [usdc, eure];
  const [amount0, amount1] = token0 === eure ? [needEure, needUsdc] : [needUsdc, needEure];
  const sqrtPriceX96 = sqrtPriceX96For(amount0, amount1);
  const spacing = TICK_SPACING[FEE] ?? 60;
  const tickLower = -Math.floor(887272 / spacing) * spacing;
  const tickUpper = -tickLower;

  console.log(`\ncreating pool token0=${token0} token1=${token1} sqrtPriceX96=${sqrtPriceX96}`);
  const createHash = await wallet.writeContract({
    address: POSITION_MANAGER, abi: [...npmAbi], functionName: "createAndInitializePoolIfNecessary",
    args: [token0, token1, FEE, sqrtPriceX96], chain, account,
  });
  await pub.waitForTransactionReceipt({ hash: createHash });
  console.log(`  ✓ ${createHash}`);

  for (const [t, amt, sym] of [[token0, amount0, "token0"], [token1, amount1, "token1"]] as const) {
    const h = await wallet.writeContract({
      address: t as `0x${string}`, abi: [...erc20], functionName: "approve",
      args: [POSITION_MANAGER, amt as bigint], chain, account,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ✓ approve ${sym} ${h}`);
  }

  const mintHash = await wallet.writeContract({
    address: POSITION_MANAGER, abi: [...npmAbi], functionName: "mint",
    args: [{
      token0, token1, fee: FEE, tickLower, tickUpper,
      amount0Desired: amount0, amount1Desired: amount1,
      // Full-range and we are the only LP, so slippage floors are 0 here on
      // purpose: there is no one to front-run an empty pool's first mint.
      amount0Min: 0n, amount1Min: 0n,
      recipient: account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    }], chain, account,
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  console.log(`  ✓ mint ${mintHash}`);

  const now = await bestPool(eure, usdc);
  console.log(now ? `\n✓ seeded: ${now.address} liquidity ${now.liquidity}` : "\n✗ pool still reads empty — check the mint receipt");
  if (!now) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
