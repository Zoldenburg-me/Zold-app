/**
 * Every setting, read from the environment once at import. The values live in
 * config/*.ts by area; this file re-exports them so importers use one path.
 *
 * ORDER MATTERS. An ES module runs its imports in the order written, and each
 * file under config/ imports only from files above it here, so this list is
 * also the order the settings are read and their refusals thrown:
 * env.ts loads .env first, the operator-token and anchor-asset checks come
 * before production.ts, and production.ts runs after the values it checks and
 * before the signing keys and the partner settings are read.
 */
export * from "./config/env.js";
export * from "./config/monerium.js";
export * from "./config/security.js";
// Named, not *: cash-rail.ts also exports a helper only production.ts uses.
export { anchorModeEnabled, BRIDGE, STELLAR, STELLAR_PUBLIC_PASSPHRASE, STELLAR_TESTNET_PASSPHRASE } from "./config/cash-rail.js";
import "./config/production.js";
export * from "./config/keys.js";
export * from "./config/partners.js";
export * from "./config/deployments.js";
export * from "./config/liquidity.js";
export * from "./config/accounting.js";
export * from "./config/faucet.js";
export * from "./config/payments.js";
export * from "./config/wallet-sync.js";
export * from "./config/ens.js";
export * from "./config/checkout-service.js";
export * from "./config/turnkey.js";
