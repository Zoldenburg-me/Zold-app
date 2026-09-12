/**
 * Pin the live Stellar harnesses to TESTNET.
 *
 * config.ts defaults to the PUBLIC network, so a harness that submits
 * changeTrust operations or an on-ledger payment would, with a real treasury
 * secret in .env, do so on mainnet. This sets the testnet endpoints where
 * nothing set them and REFUSES to continue if the passphrase still resolves
 * to the public network — a harness must never be one env var away from
 * real money. Import it before config.js.
 */
process.env.STELLAR_HORIZON ??= "https://horizon-testnet.stellar.org";
process.env.STELLAR_PASSPHRASE ??= "Test SDF Network ; September 2015";
process.env.STELLAR_FRIENDBOT ??= "https://friendbot.stellar.org";
if (/Public Global Stellar Network/i.test(process.env.STELLAR_PASSPHRASE ?? "")) {
  console.error("REFUSING: this harness runs against Stellar TESTNET only, and STELLAR_PASSPHRASE names the public network.");
  process.exit(1);
}
export {};
