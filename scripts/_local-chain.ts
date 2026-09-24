import "./_test-env.js";
/**
 * Pin a test run to the local hardhat chain. Import this first, before
 * anything else, in any script that spins up its own node.
 *
 *     import "./_local-chain.js";   // must be the first import
 *     import { ... } from "...";
 *
 * It is a module because ES imports are hoisted: setting these in the test
 * body is too late, since config.js has already read the environment and
 * frozen CHAIN_ID. Child processes would then see the local values while
 * in-process code calls contract addresses from another chain.
 *
 * deploy.ts loads .env, so without this a developer's testnet chain id,
 * remote RPC and funded operator keys would leak into tests that run their
 * own chain.
 */

import path from "node:path";
import os from "node:os";

process.env.TRANSF_CHAIN_ID = "31337";
// The hardhat-only harness seam (fake Safe ceremonies, minted EURe, up-front
// approval). Inert on any other chain id; see HARNESS in config.ts.
process.env.LOCAL_HARNESS = "1";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:8545";

/**
 * LIQUIDITY_PROVIDER defaults to `best` (over lifi,dex), the venues a user's
 * Safe can execute. Neither exists on local hardhat: LI.FI answers 404 on
 * testnets and there is no EURe/USDC pool until `dex:setup` seeds one. So the
 * local chain opts into FxSwapper here.
 *
 * Keep the opt-in local: production must inherit the non-custodial default.
 * ??= lets a harness that wants a specific venue (dex/lifi/rfq tests) win.
 */
process.env.LIQUIDITY_PROVIDER ??= "fx-swapper";

/**
 * Hardhat's well-known funded accounts. SET, never deleted: deploy.ts calls
 * process.loadEnvFile, which fills in anything unset but leaves existing
 * values alone — so deleting a key just invites .env to put it back, while
 * setting one wins.
 */
const DEV_KEYS = {
  DEPLOYER: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ORCHESTRATOR: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  RAMP: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

for (const [role, key] of Object.entries(DEV_KEYS)) {
  process.env[`DEPLOY_${role}_KEY`] = key;
  process.env[`${role}_KEY`] = key;
}

// A real Monerium chain name would send provisioning at the wrong network.
process.env.MONERIUM_CHAIN = "sepolia";



/**
 * Keep tests away from the working database.
 *
 * Every harness resets the store on startup. While that was data/db.json —
 * the file the running app uses — a test run destroyed live accounts, and on
 * a real chain that is unrecoverable: the Safe owner key lives in this file.
 * A suite run ate one such account on Base Sepolia.
 */
process.env.TRANSF_DB_PATH ??= path.join(
  os.tmpdir(),
  `zold-test-db-${process.pid}.json`,
);
