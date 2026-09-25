/**
 * Ask every Candide endpoint this deployment depends on whether it will
 * actually do its job, BEFORE a user's Safe depends on it.
 *
 *   npm run preflight                          # the chain and gas mode in .env
 *   npm run preflight -- --chain 8453          # Base mainnet, public endpoints
 *   npm run preflight -- --chain 8453 --gas token
 *
 * Nothing is signed or submitted and nothing costs gas. The gas check builds a
 * real deployment UserOperation for a throwaway passkey owner — a Safe nobody
 * will ever deploy — and asks the configured paymaster to pay for it. That is
 * the one question the docs do not answer: whether the keyless public endpoint
 * sponsors on this chain. It does count as paymaster requests against a plan.
 *
 * Exit code 1 if any check FAILs; WARN lines do not fail.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Flags set the environment BEFORE .env loads: loadEnvFile never overrides a
// variable that is already set, so an explicit --chain wins over .env.
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const chainFlag = flag("chain");
if (chainFlag) {
  if (!/^\d+$/.test(chainFlag)) throw new Error(`--chain needs a chain id, got ${chainFlag}`);
  const publicUrl = `https://api.candide.dev/public/v3/${chainFlag}`;
  const knownRpc: Record<string, string> = { "8453": "https://mainnet.base.org", "84532": "https://sepolia.base.org" };
  process.env.CANDIDE_CHAIN_ID = chainFlag;
  process.env.TRANSF_CHAIN_ID = chainFlag;
  process.env.CANDIDE_BUNDLER_URL = publicUrl;
  process.env.CANDIDE_PAYMASTER_URL = publicUrl;
  if (knownRpc[chainFlag]) process.env.CANDIDE_RPC_URL = knownRpc[chainFlag];
  else if (!process.env.CANDIDE_RPC_URL) throw new Error(`--chain ${chainFlag} has no known public RPC; set CANDIDE_RPC_URL`);
}
const gasFlag = flag("gas");
if (gasFlag) process.env.SAFE_GAS_PAYMENT = gasFlag;
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env: the shell environment and defaults
}
// Never the hardhat harness: this script only means anything against a chain.
delete process.env.LOCAL_HARNESS;

const {
  CANDIDE,
  SafeGasError,
  isDeployed,
  preparePasskeySafeDeployment,
  smartAccountForPasskey,
  webauthnOwnerToStore,
} = await import("../services/api/src/wallet/candide.js");
const { ENTRYPOINT_V9, calculateUserOperationMaxGasCost } = await import("abstractionkit");
const { partnerTimeout } = await import("../services/api/src/http.js");

let failures = 0;
const ok = (msg: string) => console.log(`  PASS  ${msg}`);
const warn = (msg: string) => console.log(`  WARN  ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const info = (msg: string) => console.log(`        ${msg}`);

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(url, {
    signal: partnerTimeout(),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error(`${method} → ${res.status} ${JSON.stringify(body?.error ?? body ?? "").slice(0, 200)}`);
  }
  return body.result;
}
const hexChain = `0x${CANDIDE.chainId.toString(16)}`;
const errMsg = (e: any) => String(e?.cause?.message ? `${e.message} (${e.cause.message})` : e?.message ?? e).slice(0, 300);

console.log(`Candide preflight — chain ${CANDIDE.chainId}, gas ${CANDIDE.gas.mode}${CANDIDE.gas.mode === "token" ? ` (${CANDIDE.gas.token})` : ""}`);
console.log(`  rpc       ${CANDIDE.rpcUrl}`);
console.log(`  bundler   ${CANDIDE.bundlerUrl}`);
console.log(`  paymaster ${CANDIDE.paymasterUrl}${CANDIDE.gas.mode === "native" ? " (not used: native gas)" : ""}\n`);

console.log("chain");
try {
  const id = await rpc(CANDIDE.rpcUrl, "eth_chainId");
  if (BigInt(id) === CANDIDE.chainId) ok(`RPC is chain ${CANDIDE.chainId}`);
  else fail(`RPC is chain ${BigInt(id)}, but CANDIDE_CHAIN_ID is ${CANDIDE.chainId}`);
} catch (e) {
  fail(`RPC unreachable: ${errMsg(e)}`);
}
try {
  if (await isDeployed(ENTRYPOINT_V9)) ok(`EntryPoint v0.9 ${ENTRYPOINT_V9} has code`);
  else fail(`EntryPoint v0.9 ${ENTRYPOINT_V9} has no code on this chain`);
} catch (e) {
  fail(`could not read EntryPoint code: ${errMsg(e)}`);
}

console.log("bundler");
try {
  const id = await rpc(CANDIDE.bundlerUrl, "eth_chainId");
  if (id.toLowerCase() === hexChain) ok(`answers for chain ${CANDIDE.chainId}`);
  else fail(`answers for chain ${BigInt(id)}, not ${CANDIDE.chainId}`);
  const eps: string[] = await rpc(CANDIDE.bundlerUrl, "eth_supportedEntryPoints");
  if (eps.some((e) => e.toLowerCase() === ENTRYPOINT_V9.toLowerCase())) ok("supports EntryPoint v0.9");
  else fail(`does not list EntryPoint v0.9 (lists ${eps.join(", ")})`);
} catch (e) {
  fail(`unreachable: ${errMsg(e)}`);
}

console.log(`gas (${CANDIDE.gas.mode})`);
if (CANDIDE.gas.mode === "token") {
  try {
    const r = await rpc(CANDIDE.paymasterUrl, "pm_supportedERC20Tokens", [ENTRYPOINT_V9]);
    const tokens: { symbol: string; address: string }[] = r?.tokens ?? [];
    const token = CANDIDE.gas.token.toLowerCase();
    if (tokens.some((t) => t.address.toLowerCase() === token)) ok(`paymaster accepts ${CANDIDE.gas.token}`);
    else fail(`paymaster does not accept ${CANDIDE.gas.token}; it lists ${tokens.map((t) => t.symbol).join(", ") || "nothing"}`);
  } catch (e) {
    fail(`pm_supportedERC20Tokens failed: ${errMsg(e)}`);
  }
}
// A throwaway owner: random coordinates give a Safe address nobody holds a
// key for, so the op built here can never be signed or deployed.
const owner = { x: BigInt(`0x${randomBytes(32).toString("hex")}`), y: BigInt(`0x${randomBytes(32).toString("hex")}`) };
const plan = {
  address: smartAccountForPasskey(owner).accountAddress as `0x${string}`,
  threshold: 1 as const,
  passkeyPublicKey: webauthnOwnerToStore(owner),
};
try {
  const prepared = await preparePasskeySafeDeployment(plan);
  const op: any = prepared.userOperation;
  const maxCost = calculateUserOperationMaxGasCost(op);
  if (CANDIDE.gas.mode === "native") {
    ok("an unsponsored deployment op was built (this throwaway Safe happens to hold ETH)");
  } else if (op.paymaster) {
    ok(`the paymaster ${CANDIDE.gas.mode === "token" ? "quoted" : "sponsored"} a deployment op (paymaster ${op.paymaster})`);
  } else {
    fail("the op came back without a paymaster");
  }
  info(`max gas cost of a Safe deployment: ${(Number(maxCost) / 1e18).toFixed(8)} ETH`);
} catch (e: any) {
  if (CANDIDE.gas.mode === "native" && e instanceof SafeGasError) {
    // Expected: the throwaway Safe holds nothing. What matters is that the op
    // was built without a paymaster and priced.
    ok("an unsponsored deployment op was built and priced; a real Safe must hold the ETH below first");
    info(e.message.replace(/ — send ETH to .*/, ""));
  } else if (CANDIDE.gas.mode === "token" && e instanceof SafeGasError && /needs at least/.test(e.message)) {
    // Expected too: the paymaster quoted and got as far as the balance check,
    // which a throwaway Safe with no tokens fails.
    ok("the token paymaster quoted a deployment op and stopped only at the throwaway Safe's empty balance");
    info(e.message.replace(/ — send some to .*/, "").replace(/^the Safe/, "a real Safe"));
  } else if (CANDIDE.gas.mode === "sponsored") {
    fail(`the paymaster would not sponsor: ${errMsg(e)}`);
    info("fix: SAFE_GAS_PAYMENT=native (Safe pays ETH), =token (Safe pays USDC), or a Candide API key with a funded gas policy");
  } else {
    fail(`could not build a ${CANDIDE.gas.mode}-paid op: ${errMsg(e)}`);
  }
}

console.log("recovery");
try {
  if (await isDeployed(CANDIDE.recoveryModuleAddress)) ok(`recovery module ${CANDIDE.recoveryModuleAddress} has code`);
  else if (CANDIDE.recoveryGuardianAddress) fail(`recovery module ${CANDIDE.recoveryModuleAddress} has no code, and deployment would enable it`);
  else warn(`recovery module ${CANDIDE.recoveryModuleAddress} has no code here (only matters once recovery is configured)`);
} catch (e) {
  fail(`could not read the recovery module: ${errMsg(e)}`);
}
const serviceUrl = process.env.RECOVERY_SERVICE_URL;
if (!serviceUrl) {
  warn("RECOVERY_SERVICE_URL unset: email/SMS recovery is off, so a lost passkey means a lost Safe");
} else {
  try {
    const res = await fetch(
      `${serviceUrl}/v1/config/getNetworkConfig?${new URLSearchParams({ chainId: String(Number(CANDIDE.chainId)) })}`,
      { signal: partnerTimeout() },
    );
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && typeof body?.moduleAddress === "string") {
      if (body.moduleAddress.toLowerCase() === CANDIDE.recoveryModuleAddress.toLowerCase()) {
        ok(`recovery service answers and uses our module ${body.moduleAddress}`);
      } else {
        fail(`recovery service uses module ${body.moduleAddress}, but CANDIDE_RECOVERY_MODULE_ADDRESS is ${CANDIDE.recoveryModuleAddress}`);
      }
    } else {
      fail(`recovery service network config failed (${res.status}): ${JSON.stringify(body).slice(0, 160)}`);
    }
  } catch (e) {
    fail(`recovery service unreachable: ${errMsg(e)}`);
  }
}

console.log("forwarding");
if (process.env.CANDIDE_FORWARDING_API_KEY && !process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY) {
  fail("CANDIDE_FORWARDING_API_KEY is set but never read — rename it to CANDIDE_FORWARDING_ACCOUNT_API_KEY");
}
if (!(process.env.CANDIDE_FORWARDING_RPC_URL ?? process.env.FORWARDING_ADDRESS_RPC_URL)) {
  warn("CANDIDE_FORWARDING_RPC_URL unset: payment pages show the Safe address, and refuse in production");
} else if (!process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY) {
  fail("CANDIDE_FORWARDING_RPC_URL is set without CANDIDE_FORWARDING_ACCOUNT_API_KEY, so activation will fail");
} else {
  ok("forwarding is configured (not called: activation is per payment page)");
}

console.log("retired settings");
const stale = Object.keys(process.env).filter((k) => k.startsWith("CANDIDE_COSIGNER_") || k === "CANDIDE_ALLOWANCE_MODULE_ADDRESS");
if (stale.length) warn(`${stale.join(", ")} set but no longer read — remove ${stale.length > 1 ? "them" : "it"}`);
else ok("no co-signer or allowance settings left");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
