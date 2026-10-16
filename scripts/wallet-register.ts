/**
 * The wallet register (wallets.json, read with docs/wallets.md): every wallet
 * a deployment configures, keyed by chain id, with its role and who holds its
 * key. Never the key, never where it is kept.
 *
 * `walletRegisterProblems` is what preflight refuses a deploy on: a configured
 * wallet that is not in the register, is registered under another setting, or
 * whose key holder is unknown.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

/** server: the key is in the deployment's encrypted env. owner: the owner holds
 *  it outside the server. unknown: nobody can sign for it — refused. */
export type KeyHolder = "server" | "owner" | "unknown";
export interface RegisteredWallet {
  role: string;
  env: string[];
  keyHolder: KeyHolder;
}
export type WalletRegister = Record<string, Record<string, RegisteredWallet>>;

/** Every setting that names a wallet, first name wins. Contract addresses
 *  (recovery module, ENS resolver) live in deployments.json or code. */
export const WALLET_SETTINGS: { names: string[]; kind: "address" | "key" }[] = [
  { names: ["CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER"], kind: "address" },
  { names: ["CANDIDE_RECOVERY_GUARDIAN_ADDRESS"], kind: "address" },
  { names: ["BRIDGE_DESTINATION_ADDRESS"], kind: "address" },
  { names: ["ORCHESTRATOR_KEY", "DEPLOY_ORCHESTRATOR_KEY"], kind: "key" },
  { names: ["RAMP_KEY", "DEPLOY_RAMP_KEY"], kind: "key" },
  { names: ["RELAY_KEY"], kind: "key" },
  { names: ["DEPLOYER_KEY", "DEPLOY_DEPLOYER_KEY"], kind: "key" },
  { names: ["ENS_GATEWAY_KEY"], kind: "key" },
  { names: ["FAUCET_KEY"], kind: "key" },
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadWalletRegister(file = path.join(ROOT, "wallets.json")): WalletRegister {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The wallets this environment configures. A malformed value is a problem,
 *  never skipped; a key is turned into its address and goes no further. */
function configuredWallets(env: Record<string, string | undefined>) {
  const wallets: { setting: string; address?: string; problem?: string }[] = [];
  for (const { names, kind } of WALLET_SETTINGS) {
    const setting = names.find((n) => env[n]?.trim());
    if (!setting) continue;
    const value = env[setting]!.trim();
    if (kind === "address") {
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) wallets.push({ setting, address: value });
      else wallets.push({ setting, problem: `${setting} is not an address` });
    } else if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
      wallets.push({ setting, address: privateKeyToAccount(value as `0x${string}`).address });
    } else {
      wallets.push({ setting, problem: `${setting} is not a 32-byte hex private key` });
    }
  }
  return wallets;
}

export function walletRegisterProblems(env: Record<string, string | undefined>, chainId: number | bigint, register: WalletRegister): string[] {
  const entries = Object.entries(register[String(chainId)] ?? {});
  const problems: string[] = [];
  for (const { setting, address, problem } of configuredWallets(env)) {
    if (problem) {
      problems.push(problem);
      continue;
    }
    const entry = entries.find(([a]) => a.toLowerCase() === address!.toLowerCase())?.[1];
    if (!entry) problems.push(`${setting} is ${address}, which is not in wallets.json for chain ${chainId}`);
    else if (!entry.env.includes(setting)) problems.push(`${setting} is ${address}, registered as ${entry.role} (${entry.env.join(", ")}), not for ${setting}`);
    else if (entry.keyHolder !== "server" && entry.keyHolder !== "owner") problems.push(`${setting} is ${address} (${entry.role}), whose key holder is ${entry.keyHolder} — replace it (docs/wallets.md)`);
  }
  return problems;
}
