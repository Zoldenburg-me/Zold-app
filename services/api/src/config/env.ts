/**
 * The environment and the chain: loads .env, then the flags every other
 * config file derives from. First in config.ts, so .env is read before any
 * other file reads process.env.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../../..");

const initialPort = process.env.TRANSF_API_PORT ?? process.env.PORT;
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — every setting comes from the environment
}
if (initialPort) process.env.TRANSF_API_PORT = initialPort;

// Base mainnet by default. The local hardhat stack sets its own RPC and chain
// id (scripts/_local-chain.ts); nothing else should ever land here by accident.
export const RPC_URL = process.env.TRANSF_RPC_URL ?? "https://mainnet.base.org";
const PORT_RANGE = { min: 0, max: 65_535, integer: true };
export const API_PORT = envNumber(process.env.TRANSF_API_PORT ? "TRANSF_API_PORT" : "PORT", 3000, PORT_RANGE);
export const API_HOST = process.env.TRANSF_API_HOST ?? "127.0.0.1";
export const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.TRANSF_PRODUCTION === "1";
export const PUBLIC_URL = process.env.TRANSF_PUBLIC_URL ?? "";

export const USING_LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(RPC_URL);

/**
 * Which chain we settle on. Wallet deployment, signatures and token balances
 * all need the same chain id, so it is derived from this one place.
 *
 * 8453 = Base mainnet (default — the production chain, where Monerium issues
 * the real EURe and Circle the real USDC), 31337 = the local hardhat stack the
 * test harnesses pin themselves to. Unknown ids are synthesized by chain.ts.
 */
export const CHAIN_ID = envNumber("TRANSF_CHAIN_ID", 8453, { min: 1, integer: true });
/** Chains where the tokens are real money. Anything test-only refuses here. */
export const REAL_MONEY_CHAINS = new Set([1, 100, 137, 8453, 42161, 59144]);
export const IS_REAL_MONEY_CHAIN = REAL_MONEY_CHAINS.has(CHAIN_ID);
export const IS_LOCAL_CHAIN = CHAIN_ID === 31337;
export const USING_LOCAL_API_HOST = API_HOST === "127.0.0.1" || API_HOST === "localhost" || API_HOST === "::1";

/**
 * Whether this process looks like a developer laptop.
 *
 * A loopback bind alone does not mean local: a hosted deploy usually runs a
 * reverse proxy on :443 forwarding to 127.0.0.1:3000. Anything that relaxes a
 * control for local dev (auto-KYC, internal error text) needs all three:
 * loopback API, local RPC and the hardhat chain id. That way a hosted testnet
 * deploy without NODE_ENV set does not get dev-only defaults.
 */
export const LOOKS_LOCAL = USING_LOCAL_API_HOST && USING_LOCAL_RPC && IS_LOCAL_CHAIN;

/**
 * A number from the environment, or a refusal naming the variable.
 *
 * `Number("two")` is NaN and `Number("")` is 0: a typo would surface as a
 * NaN session expiry or a 0 ms poll loop, several layers from the cause.
 * Boot is the place to say it. Only a short plain decimal is ever echoed back,
 * in case a secret landed in the wrong variable.
 */
export function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  // Plain decimal only: Number() also takes "0x10", "1e3" and "  ", none of which is a setting.
  if (!/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) throw new Error(`${name} must be a number`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  // Only a short plain decimal is echoed: "0x…" parses too, and a key's magnitude is still a leak.
  const got = /^\s*-?\d{1,12}(\.\d{1,12})?\s*$/.test(raw) ? `, got ${n}` : "";
  if (opts.integer && !Number.isInteger(n)) throw new Error(`${name} must be a whole number${got}`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${name} must be at least ${opts.min}${got}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${name} must be at most ${opts.max}${got}`);
  return n;
}
