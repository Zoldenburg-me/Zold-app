/**
 * Who pays a Safe UserOperation's gas, and what happens when a Candide or RPC
 * endpoint stops answering.
 *
 * Offline: a stub RPC and a stub bundler on localhost stand in for Base and
 * Candide, and the paymaster is replaced at the prototype. What this cannot
 * show is that a real paymaster sponsors or quotes on a real chain — that is
 * what `npm run preflight` asks the live endpoints.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Before any import reads them: a short partner timeout so a hang fails fast,
// a non-local chain so the hardhat harness is off, and endpoints we control.
process.env.PARTNER_HTTP_TIMEOUT_MS = "300";
process.env.CANDIDE_CHAIN_ID = "84532";
delete process.env.LOCAL_HARNESS;
delete process.env.SAFE_GAS_PAYMENT;
delete process.env.SAFE_GAS_TOKEN;

let pass = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  pass++;
  console.log(`${pass}. ${name}`);
}

type Handler = (method: string, params: any[]) => unknown | typeof HANG;
const HANG = Symbol("hang");
function jsonRpcServer(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const answer = (m: any) => {
        const result = handler(m.method, m.params ?? []);
        return result === HANG ? HANG : { jsonrpc: "2.0", id: m.id, result };
      };
      const out = Array.isArray(msg) ? msg.map(answer) : answer(msg);
      if (out === HANG || (Array.isArray(out) && out.includes(HANG))) return; // never answer
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    ),
  );
}

const ZERO32 = `0x${"0".repeat(64)}`;
let ethBalance = "0x0";
let rpcHangs = false;
const rpc = await jsonRpcServer((method) => {
  if (rpcHangs && method !== "eth_getCode") return HANG;
  switch (method) {
    case "eth_chainId": return "0x14a34";
    case "eth_getCode": return "0x"; // not deployed: every op is a deployment
    case "eth_getBalance": return ethBalance;
    case "eth_call": return ZERO32; // EntryPoint nonce 0
    case "eth_gasPrice": return "0x3b9aca00";
    case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
    case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1" };
    default: return null;
  }
});
let bundlerHangs = false;
const bundler = await jsonRpcServer((method) => {
  if (bundlerHangs) return HANG;
  switch (method) {
    case "eth_chainId": return "0x14a34";
    case "eth_supportedEntryPoints": return ["0x433709009B8330FDa32311DF1C2AFA402eD8D009"];
    case "eth_estimateUserOperationGas":
      return { preVerificationGas: "0xc350", verificationGasLimit: "0x61a80", callGasLimit: "0x186a0" };
    default: return null;
  }
});
process.env.CANDIDE_RPC_URL = rpc.url;
process.env.CANDIDE_BUNDLER_URL = bundler.url;
process.env.CANDIDE_PAYMASTER_URL = bundler.url;

const { Erc7677Paymaster } = await import("abstractionkit");
const {
  CANDIDE,
  SafeGasError,
  gasPaymentFromEnv,
  preparePasskeySafeDeployment,
  smartAccountForPasskey,
  webauthnOwnerToStore,
} = await import("../services/api/src/wallet/candide.js");

const owner = { x: 0x1111n, y: 0x2222n };
const plan = {
  address: smartAccountForPasskey(owner).accountAddress as `0x${string}`,
  threshold: 1 as const,
  passkeyPublicKey: webauthnOwnerToStore(owner),
};

try {
  console.log("─── (a) reading SAFE_GAS_PAYMENT ───");
  await check("unset means sponsored — the behaviour before this setting existed", () => {
    assert.deepEqual(gasPaymentFromEnv({}, "8453"), { mode: "sponsored" });
  });
  await check("native needs no token", () => {
    assert.deepEqual(gasPaymentFromEnv({ SAFE_GAS_PAYMENT: "native" }, "8453"), { mode: "native" });
  });
  await check("token defaults to Circle's USDC on Base mainnet", () => {
    assert.deepEqual(gasPaymentFromEnv({ SAFE_GAS_PAYMENT: "token" }, "8453"), {
      mode: "token",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
  });
  await check("token on a chain with no known default refuses at boot", () => {
    assert.throws(() => gasPaymentFromEnv({ SAFE_GAS_PAYMENT: "token" }, "84532"), /SAFE_GAS_TOKEN/);
  });
  await check("a malformed token address refuses at boot", () => {
    assert.throws(() => gasPaymentFromEnv({ SAFE_GAS_PAYMENT: "token", SAFE_GAS_TOKEN: "usdc" }, "8453"), /SAFE_GAS_TOKEN/);
  });
  await check("an unknown mode refuses rather than falling back to one nobody chose", () => {
    assert.throws(() => gasPaymentFromEnv({ SAFE_GAS_PAYMENT: "free" }, "8453"), /sponsored, native or token/);
  });

  console.log("─── (b) native: the Safe pays in ETH ───");
  (CANDIDE as any).gas = { mode: "native" };
  const paymasterCalls: unknown[] = [];
  const realCreate = Erc7677Paymaster.prototype.createPaymasterUserOperation;
  (Erc7677Paymaster.prototype as any).createPaymasterUserOperation = async function (...args: any[]) {
    paymasterCalls.push(args[3]);
    return this.__stub(...args);
  };
  await check("a Safe with no ETH is refused BEFORE the passkey signs, naming the address to fund", async () => {
    ethBalance = "0x0";
    await assert.rejects(preparePasskeySafeDeployment(plan), (e: any) => {
      assert.ok(e instanceof SafeGasError, String(e));
      assert.equal(e.status, 409);
      assert.match(e.message, new RegExp(plan.address));
      return true;
    });
  });
  await check("a funded Safe gets an op with no paymaster, and the paymaster is never asked", async () => {
    ethBalance = "0xde0b6b3a7640000"; // 1 ETH
    paymasterCalls.length = 0;
    const r = await preparePasskeySafeDeployment(plan);
    assert.match(r.challenge, /^0x[0-9a-f]{64}$/);
    assert.ok(!(r.userOperation as any).paymaster, "no paymaster on a self-paid op");
    assert.equal(paymasterCalls.length, 0);
  });

  console.log("─── (c) token and sponsored: the paymaster pays ───");
  (Erc7677Paymaster.prototype as any).__stub = async (_acct: any, op: any, _b: any, ctx: any) => ({
    userOperation: { ...op, paymaster: "0xca944fb73fa5191969014ded9bb075381d59c7de", paymasterData: "0x01" },
    ...(ctx?.token && (Erc7677Paymaster.prototype as any).__quote ? { tokenQuote: { token: ctx.token, exchangeRate: 1n, tokenCost: 1n } } : {}),
  });
  await check("token mode asks the paymaster with the token in the context", async () => {
    (CANDIDE as any).gas = { mode: "token", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
    (Erc7677Paymaster.prototype as any).__quote = true;
    paymasterCalls.length = 0;
    const r = await preparePasskeySafeDeployment(plan);
    assert.deepEqual(paymasterCalls[0], { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    assert.equal((r.userOperation as any).paymaster, "0xca944fb73fa5191969014ded9bb075381d59c7de");
  });
  await check("token mode with no quote refuses — abstractionkit would quietly fall back to sponsorship", async () => {
    (Erc7677Paymaster.prototype as any).__quote = false;
    await assert.rejects(preparePasskeySafeDeployment(plan), (e: any) => e instanceof SafeGasError && /no quote/.test(e.message));
  });
  await check("sponsored mode asks with an empty context and signs over the paymaster fields", async () => {
    (CANDIDE as any).gas = { mode: "sponsored" };
    paymasterCalls.length = 0;
    const r = await preparePasskeySafeDeployment(plan);
    assert.deepEqual(paymasterCalls[0], {});
    assert.equal((r.userOperation as any).paymasterData, "0x01");
  });
  // Candide's own wording, as its Base mainnet endpoint answered (Sep 2026).
  const refuse = (message: string) => {
    (Erc7677Paymaster.prototype as any).__stub = async () => {
      throw Object.assign(new Error("pm_getPaymasterData failed"), { cause: new Error(message) });
    };
  };
  await check("a paymaster with no public policy for the op is a 409 that names the alternatives", async () => {
    refuse("sponsored-validator: this user operation does not qualify for any publicly available gas policy");
    await assert.rejects(preparePasskeySafeDeployment(plan), (e: any) =>
      e instanceof SafeGasError && /will not sponsor/.test(e.message) && /SAFE_GAS_PAYMENT=native or =token/.test(e.message));
  });
  await check("a Safe short of the gas token is a 409 that says how much and where", async () => {
    (CANDIDE as any).gas = { mode: "token", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
    refuse("validator: token balance lower than the required `0x4670` allowance");
    await assert.rejects(preparePasskeySafeDeployment(plan), (e: any) =>
      e instanceof SafeGasError && /at least 18032 base units/.test(e.message) && e.message.includes(plan.address));
  });
  await check("any other paymaster failure stays the paymaster's own error", async () => {
    refuse("something else entirely");
    await assert.rejects(preparePasskeySafeDeployment(plan), (e: any) => !(e instanceof SafeGasError));
  });
  (Erc7677Paymaster.prototype as any).createPaymasterUserOperation = realCreate;

  console.log("─── (d) an endpoint that never answers ───");
  // The partner timeout, not some other failure: abstractionkit wraps the
  // AbortSignal.timeout error as the cause of its rpc-call error.
  const timedOut = (e: any) => /aborted due to timeout/.test(String(e?.cause?.message ?? e?.message ?? e));
  (CANDIDE as any).gas = { mode: "native" };
  ethBalance = "0xde0b6b3a7640000";
  await check("a hung bundler fails the prepare within the partner timeout", async () => {
    bundlerHangs = true;
    const t0 = Date.now();
    await assert.rejects(preparePasskeySafeDeployment(plan), timedOut);
    assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
    bundlerHangs = false;
  });
  await check("a hung RPC (nonce and gas-price reads) fails the prepare within the partner timeout", async () => {
    rpcHangs = true;
    const t0 = Date.now();
    await assert.rejects(preparePasskeySafeDeployment(plan), timedOut);
    assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
    rpcHangs = false;
  });

  console.log(`\nSAFE GAS TEST PASSED — ${pass}/${pass}`);
} finally {
  rpc.server.closeAllConnections();
  bundler.server.closeAllConnections();
  rpc.server.close();
  bundler.server.close();
}
