import { readFileSync } from "node:fs";
import path from "node:path";
import { CHAIN_ID, ROOT } from "./env.js";

export interface Deployments {
  eure: `0x${string}`;
  usdc: `0x${string}`;
  /** Test chains only: ZoldUSD, the staging dollar the faucet wallet mints
   *  (`npm run deploy:zusd`). */
  zusd?: `0x${string}`;
  /** Present in older entries, never read. */
  bridge?: `0x${string}`;
  timelock?: `0x${string}`;
  swapper?: `0x${string}`;
}

/**
 * Contract addresses, keyed by chain id, so `npm run dev` and a testnet stack
 * can coexist and a stale file cannot point the app at addresses on the wrong
 * chain. Flat single-chain files are still read, treated as the local chain.
 */
export function loadDeployments(chainId: number = CHAIN_ID): Deployments {
  const p = path.join(ROOT, "deployments.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  // Flat single-chain shape: addresses at the top level.
  if (typeof raw.eure === "string") {
    if (chainId !== 31337) {
      throw new Error(
        `deployments.json is in the old single-chain format and has no entry for chain ${chainId} — ` +
          `re-run the deploy for this chain`,
      );
    }
    const { vault: _unused, ...rest } = raw; // older files carry a vault address; nothing reads it
    return rest as Deployments;
  }
  const forChain = raw[String(chainId)];
  if (!forChain) {
    throw new Error(
      `deployments.json has no addresses for chain ${chainId} (has: ${Object.keys(raw).join(", ") || "none"}) — ` +
        `run the deploy against that chain first`,
    );
  }
  return forChain as Deployments;
}

export function loadAbi(contract: string): any[] {
  const p = path.join(
    ROOT,
    "contracts/artifacts/contracts/src",
    `${contract}.sol`,
    `${contract}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")).abi;
}
