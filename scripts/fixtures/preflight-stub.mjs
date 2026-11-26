/**
 * The whole outside world of scripts/mainnet-preflight.ts, for a child run
 * with `node --import`: a stub fetch that is the chain RPC, the bundler, the
 * paymaster and the recovery service, and refuses every other URL; and a
 * process.loadEnvFile that loads nothing, so no .env reaches the run.
 *
 * PREFLIGHT_STUB (JSON) says how each endpoint answers; PREFLIGHT_STUB_LOG is
 * where the calls are written at exit. Test-only.
 */
import { writeFileSync } from "node:fs";

const S = JSON.parse(process.env.PREFLIGHT_STUB ?? "{}");
const URLS = { rpc: S.rpcUrl, bundler: S.bundlerUrl, paymaster: S.paymasterUrl, recovery: S.recoveryUrl };
const EP = "0x433709009b8330fda32311df1c2afa402ed8d009";
const PAYMASTER = "0xca944fb73fa5191969014ded9bb075381d59c7de";
const hex = (n) => `0x${Number(n).toString(16)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const calls = [];
const envFileReads = [];

process.loadEnvFile = (file) => {
  envFileReads.push(String(file ?? ".env"));
  throw Object.assign(new Error("preflight-stub: no .env in this run"), { code: "ENOENT" });
};
process.on("exit", () => {
  if (process.env.PREFLIGHT_STUB_LOG) writeFileSync(process.env.PREFLIGHT_STUB_LOG, JSON.stringify({ calls, envFileReads }));
});

/** A JSON-RPC error carrying `text`, as a provider that echoes the request might send. */
const rpcError = (text) => ({ __error: { code: -32000, message: text } });

function answer(who, method, params) {
  const fault = S.faults?.[`${who}.${method}`];
  if (fault === "echo-url") return rpcError(`unauthorized request to ${URLS[who]}`);
  // Padded so the script's 200-character cut of the error body falls 6 characters before the URL ends: inside the key.
  if (fault === "echo-url-at-cut") return rpcError(`unauthorized request to ${"x".repeat(200 - 51 - URLS[who].length + 6)}${URLS[who]}`);
  if (fault === "error") return rpcError("stub refused");
  switch (method) {
    case "eth_chainId": return hex(who === "rpc" ? S.rpcChain : S.bundlerChain);
    case "eth_getCode": {
      const a = String(params[0]).toLowerCase();
      if (a === EP) return S.entryPointCode === false ? "0x" : "0x6080";
      if (a === String(S.recoveryModule ?? "").toLowerCase()) return "0x6080";
      return "0x";
    }
    case "eth_supportedEntryPoints": return S.bundlerEntryPoints ?? [EP];
    case "eth_call": {
      const data = String(params[0]?.data ?? "");
      if (data.startsWith("0x35567e1a")) return word(0); // EntryPoint getNonce
      return word(0);
    }
    case "eth_getStorageAt": return word(0);
    case "eth_getBalance": return "0x0";
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
    case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1" };
    case "eth_estimateUserOperationGas": return { preVerificationGas: "0xc350", verificationGasLimit: "0x61a80", callGasLimit: "0x186a0" };
    case "pm_chainId": return hex(S.paymasterChain);
    case "pm_supportedEntryPoints": return S.paymasterEntryPoints ?? [EP];
    case "pm_getPaymasterStubData":
    case "pm_getPaymasterData":
      if (S.sponsor === false) return rpcError("the operation does not qualify for any publicly available gas policy");
      return { paymaster: PAYMASTER, paymasterData: "0x01", paymasterVerificationGasLimit: "0x7530", paymasterPostOpGasLimit: "0x4e20" };
    default: return rpcError(`stub has no answer for ${method}`);
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (S.throwWithUrl && url.startsWith(URLS[S.throwWithUrl])) throw new TypeError(`${S.throwPrefix ?? ""}Failed to parse URL from ${url}`);
  if (URLS.recovery && url.startsWith(`${URLS.recovery}/`)) {
    calls.push({ who: "recovery", url });
    return Response.json({ moduleAddress: S.recoveryServiceModule ?? S.recoveryModule });
  }
  const who = Object.keys(URLS).find((k) => k !== "recovery" && URLS[k] === url);
  if (!who) throw new TypeError("preflight-stub: refused a request to an unstubbed URL (offline run)");
  const msg = JSON.parse(String(init.body ?? "{}"));
  // One URL may serve several roles (Candide's public endpoint is bundler and paymaster).
  const role = String(msg.method).startsWith("pm_") && url === URLS.paymaster ? "paymaster" : who;
  calls.push({ who: role, method: msg.method });
  const out = answer(role, msg.method, msg.params ?? []);
  if (out && typeof out === "object" && "__error" in out) return Response.json({ jsonrpc: "2.0", id: msg.id, error: out.__error });
  return Response.json({ jsonrpc: "2.0", id: msg.id, result: out });
};
