import "./_test-env.js";
/**
 * Pin a test run to the local hardhat chain. Import this FIRST, before
 * anything else, in any script that spins up its own node.
 *
 *     import "./_local-chain.js";   // must be the first import
 *     import { ... } from "...";
 *
 * Why a module rather than a few lines at the top of each test: ES module
 * imports are hoisted and evaluated before the importing module's body runs.
 * Setting these in the body is too late — config.js has already read the
 * environment and frozen CHAIN_ID, so an in-process import quietly keeps
 * whatever .env said. Spawned child processes get the corrected values and
 * in-process code does not, which shows up as a test deploying locally and
 * then calling contract addresses from a completely different chain.
 *
 * What it defends against: deploy.ts loads .env now, so a developer's real
 * settings — a testnet chain id, a remote RPC, funded operator keys — would
 * otherwise leak into tests that run their own chain. Tests must not depend
 * on .env being empty.
 */

import path from "node:path";
import os from "node:os";

process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:8545";

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
