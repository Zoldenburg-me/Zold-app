/**
 * Pin the live Stellar harnesses to testnet.
 *
 * config.ts defaults to the public network, so with a real treasury secret in
 * .env a harness submitting changeTrust or a payment would do so on mainnet.
 * This sets the testnet endpoints where unset and exits if the passphrase
 * still names the public network. Import it before config.js.
 */
process.env.STELLAR_HORIZON ??= "https://horizon-testnet.stellar.org";
process.env.STELLAR_PASSPHRASE ??= "Test SDF Network ; September 2015";
process.env.STELLAR_FRIENDBOT ??= "https://friendbot.stellar.org";
if (/Public Global Stellar Network/i.test(process.env.STELLAR_PASSPHRASE ?? "")) {
  console.error("REFUSING: this harness runs against Stellar TESTNET only, and STELLAR_PASSPHRASE names the public network.");
  process.exit(1);
}
export {};
