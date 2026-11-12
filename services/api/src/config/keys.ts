import { RPC_URL, USING_LOCAL_RPC } from "./env.js";
import { urlForLog } from "../http/log-safe.js";

// Hardhat's well-known dev accounts — public knowledge, fine on 31337 only.
const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  relay: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;

type Role = keyof typeof DEV_KEYS;

/** The names a role's key is read from, first wins. The deploy's DEPLOY_*_KEY
 *  names are accepted so one .env serves the deploy and a local server; the
 *  relay key belongs to the server alone. */
const NAMES: Record<Role, string[]> = {
  deployer: ["DEPLOYER_KEY", "DEPLOY_DEPLOYER_KEY"],
  orchestrator: ["ORCHESTRATOR_KEY", "DEPLOY_ORCHESTRATOR_KEY"],
  ramp: ["RAMP_KEY", "DEPLOY_RAMP_KEY"],
  relay: ["RELAY_KEY"],
};

const fromEnv = (role: Role) => NAMES[role].map((n) => process.env[n]?.trim()).find(Boolean);

/**
 * The keys this server signs with, from the environment.
 *
 * The operator roles can move test liquidity, submit payout steps, and
 * perform administrative actions. Hardhat's public development keys must
 * never hold those powers on a public chain, so off a local RPC they are
 * refused unless explicitly allowed.
 */
function operatorKey(role: Role): `0x${string}` {
  const upper = role.toUpperCase();
  const key = fromEnv(role);
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(`${upper}_KEY is not a 32-byte hex private key`);
    }
    return key as `0x${string}`;
  }
  if (!USING_LOCAL_RPC && process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC !== "1") {
    throw new Error(
      `refusing to hold the ${role} role with hardhat's public development key on ${urlForLog(RPC_URL)} — ` +
        `set ${NAMES[role].join(" or ")} to a key this deployment actually controls`,
    );
  }
  return DEV_KEYS[role];
}

/**
 * The deployer key deploys the contracts and administers them, so off the
 * local chain the server never holds it: it belongs to the deploy, run from
 * the operator's machine. Locally it mints the harness's MockToken.
 */
function deployerKey(): `0x${string}` | undefined {
  return USING_LOCAL_RPC ? operatorKey("deployer") : undefined;
}

/** What server.ts notes at start: a deployer key the server does not read.
 *  Not printed here, since the deploy scripts load this file too and need
 *  the key. */
export const UNREAD_DEPLOYER_KEYS: string[] = USING_LOCAL_RPC ? [] : NAMES.deployer.filter((name) => process.env[name]?.trim());

/**
 * The relay key pays gas for calls anyone may make: a passkey verifier
 * deployment, a guardian-signed recovery, a finalisation. It holds no
 * authority over any contract or Safe, so a leak costs its ETH and nothing
 * else — which holds only while it is no other role's key.
 */
function relayKey(): `0x${string}` {
  const key = operatorKey("relay");
  const others = [...NAMES.deployer, ...NAMES.orchestrator, ...NAMES.ramp, "FAUCET_KEY", "ENS_GATEWAY_KEY"];
  const shared = others.find((name) => process.env[name]?.trim().toLowerCase() === key.toLowerCase());
  if (shared) throw new Error(`RELAY_KEY must not be the same key as ${shared} — it pays relay gas and holds nothing else`);
  return key;
}

export const KEYS = {
  deployer: deployerKey(),
  orchestrator: operatorKey("orchestrator"),
  ramp: operatorKey("ramp"),
  relay: relayKey(),
} as const;
