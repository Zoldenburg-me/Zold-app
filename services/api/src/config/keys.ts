import { RPC_URL, USING_LOCAL_RPC } from "./env.js";

// Hardhat's well-known dev accounts — public knowledge, fine on 31337 only.
const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

/**
 * The keys this server signs with, from the environment.
 *
 * The operator roles can move test liquidity, submit payout steps, and
 * perform administrative actions. Hardhat's public development keys must
 * never hold those powers on a public chain, so off a local RPC they are
 * refused unless explicitly allowed.
 *
 * Accepts ORCHESTRATOR_KEY / RAMP_KEY / DEPLOYER_KEY, falling back to the
 * DEPLOY_*_KEY names so one .env serves both the deploy and the server.
 */
function operatorKey(role: "deployer" | "orchestrator" | "ramp"): `0x${string}` {
  const upper = role.toUpperCase();
  const fromEnv = process.env[`${upper}_KEY`] ?? process.env[`DEPLOY_${upper}_KEY`];
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(`${upper}_KEY is not a 32-byte hex private key`);
    }
    return fromEnv as `0x${string}`;
  }
  if (!USING_LOCAL_RPC && process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC !== "1") {
    throw new Error(
      `refusing to hold the ${role} role with hardhat's public development key on ${RPC_URL} — ` +
        `set ${upper}_KEY (or DEPLOY_${upper}_KEY) to a key this deployment actually controls`,
    );
  }
  return DEV_KEYS[role];
}

export const KEYS = {
  deployer: operatorKey("deployer"),
  orchestrator: operatorKey("orchestrator"),
  ramp: operatorKey("ramp"),
} as const;
