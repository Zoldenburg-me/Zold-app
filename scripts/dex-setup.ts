/**
 * Operator step: create and seed a EURe/USDC pool so the DEX provider has
 * something to trade against on a testnet.
 *
 * A test fixture, not a treasury. On mainnet the counterparty is public
 * liquidity and we carry nothing. Base Sepolia has no EURe pool at any fee
 * tier, so to exercise a real swap we post both sides ourselves. Every price
 * the DEX provider reports on this chain is ours; a testnet quote says
 * nothing about real pricing.
 *
 *   npm run dex:setup          report what exists and what is missing
 *   npm run dex:setup -- --fix create the pool and mint a full-range position
 *
 * Read-only unless asked to change anything.
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IS_REAL_MONEY_CHAIN, LIQUIDITY } from "../services/api/src/config.js";
import { addrs, chain } from "../services/api/src/chain.js";
import { eurPer } from "../services/api/src/rates.js";
import { bestPool } from "../services/api/src/dex.js";

process.loadEnvFile?.(".env");

const FIX = process.argv.includes("--fix");
// Per chain: Uniswap's NonfungiblePositionManager differs between Base
// Sepolia and Base mainnet, and approving the wrong one hands tokens to an
// address that never mints anything.
const POSITION_MANAGERS: Record<number, `0x${string}`> = {
  84532: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
  8453: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};
const POSITION_MANAGER = (process.env.DEX_POSITION_MANAGER ?? POSITION_MANAGERS[chain.id] ?? "") as `0x${string}`;
if (!POSITION_MANAGER) {
  console.error(`no position manager known for chain ${chain.id} — set DEX_POSITION_MANAGER`);
  process.exit(1);
}
// A test fixture pool is seeded with tokens we mint; on a real-money chain the
// same command approves and deposits REAL EURe/USDC. Ask for that explicitly.
if (FIX && IS_REAL_MONEY_CHAIN && process.env.DEX_SETUP_ALLOW_MAINNET !== "1") {
  console.error(`REFUSING --fix on chain ${chain.id}: this mints a position with real tokens. Set DEX_SETUP_ALLOW_MAINNET=1 to do it deliberately.`);
  process.exit(1);
}
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
/** MockToken: ours on a testnet deploy, so a shortfall is mintable not fundable. */
const mockAbi = parseAbi([
  "function owner() view returns (address)",
  "function mint(address,uint256)",
]);

/** True only when this token is a mock WE own — never assume it of a real one. */
async function ownedMock(pub: any, token: `0x${string}`, me: `0x${string}`) {
  try {
    const o = (await pub.readContract({ address: token, abi: mockAbi, functionName: "owner" })) as string;
    return o.toLowerCase() === me.toLowerCase();
  } catch {
    return false; // no owner() -> a real token, not ours
  }
}

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

  /**
   * Seed the pair the PROVIDER trades, read from the same place it reads
   * (addrs().usdc). Circle's real testnet USDC is a different token from the
   * one the app is deployed against; a pool against it builds fine and the
   * provider correctly reports "no pool". Seeding a pair nobody trades is
   * worse than not seeding: it looks done.
   *
   * Note what this means on Base Sepolia: addrs().usdc is a MockToken we
   * minted, so a pool against it is as synthetic as the FxSwapper — real pool
   * contract, both tokens ours. It proves the code path, not a price.
   */
  const a = addrs();
  const eure = (process.env.DEX_EURE ?? a.eure) as `0x${string}`;
  const usdc = (process.env.DEX_USDC ?? a.usdc) as `0x${string}`;

  console.log(`chain ${chain.id}  deployer ${account.address}  fee tier ${FEE}`);

  const existing = await bestPool(eure, usdc);
  if (existing) {
    console.log(`\n✓ pool exists: ${existing.address} (fee ${existing.fee}, liquidity ${existing.liquidity})`);
    if (!FIX) {
      console.log("  --fix would ADD another full-range position, deepening it.");
      console.log("  Depth is the whole game here: a pool holding 5 EURe prices a 1 EURe");
      console.log("  trade 1670bps off mid, and the mid-deviation guard rightly refuses it.");
      return;
    }
    console.log("  --fix given: adding another position rather than stopping.");
  } else {
    console.log("\n✗ no EURe/USDC pool with liquidity on this chain");
  }

  // --- prerequisites, reported together rather than one failure at a time ---
  const [eDec, uDec] = await Promise.all([
    pub.readContract({ address: eure, abi: erc20, functionName: "decimals" }) as Promise<number>,
    pub.readContract({ address: usdc, abi: erc20, functionName: "decimals" }) as Promise<number>,
  ]);
  const mid = await eurPer("USD");
  const needEure = parseUnits(String(SEED_EUR), eDec);
  const needUsdc = parseUnits((SEED_EUR * mid).toFixed(uDec), uDec);
  let [haveEure, haveUsdc, haveGas] = await Promise.all([
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
  /**
   * addrs().usdc on a testnet deploy is our own MockToken, so mint the
   * shortfall. Circle's faucet gives a different token from the one the app
   * trades. The mint is logged as a fixture: our token, on our side of a pool
   * nobody else uses.
   */
  const mintable = FIX ? await ownedMock(pub, usdc, account.address) : false;
  if (haveUsdc < needUsdc && mintable) {
    const short = needUsdc - haveUsdc;
    console.log(`\n  minting ${formatUnits(short, uDec)} mock USDC — we own this token; it is a fixture, not liquidity`);
    const h = await wallet.writeContract({
      address: usdc, abi: [...mockAbi], functionName: "mint",
      args: [account.address, short], chain, account,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ✓ mint ${h}`);
    haveUsdc = needUsdc;
  }
  if (haveUsdc < needUsdc) {
    gaps.push(
      `USDC short by ${formatUnits(needUsdc - haveUsdc, uDec)}. ` +
        (mintable ? "" : `This token is not ours to mint — fund it, or re-run with --fix if it is a mock we own.`),
    );
  }
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
    // Approve MORE than amountDesired. mint() derives the liquidity, then
    // recomputes the amounts owed for it and ROUNDS UP, so an allowance set to
    // exactly the desired amount can come up a wei short and the position
    // manager reverts with a bare "STF". Costs nothing: the pull is still
    // capped at amountDesired.
    const h = await wallet.writeContract({
      address: t as `0x${string}`, abi: [...erc20], functionName: "approve",
      args: [POSITION_MANAGER, ((amt as bigint) * 12n) / 10n], chain, account,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ✓ approve ${sym} ${h}`);
  }

  const mintHash = await wallet.writeContract({
    address: POSITION_MANAGER, abi: [...npmAbi], functionName: "mint",
    args: [{
      token0, token1, fee: FEE, tickLower, tickUpper,
      amount0Desired: amount0, amount1Desired: amount1,
      // Zero floors only for an EMPTY pool's first mint, where nobody can
      // front-run. Adding to an existing pool takes a 0.5% floor, because a
      // pool anyone can trade against can move between quote and mint.
      amount0Min: existing ? (amount0 * 995n) / 1000n : 0n,
      amount1Min: existing ? (amount1 * 995n) / 1000n : 0n,
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
