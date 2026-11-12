/**
 * Bridge.xyz orchestration — the cash rail's exit to Stellar.
 *
 * Without BRIDGE_LIVE=1 the cash rail is CLOSED (no dry-run, no local escrow);
 * BRIDGE_LIVE=1 calls Bridge's Transfer API and waits for the
 * user/orchestrator-side deposit to fund it.
 */
export const BRIDGE = {
  live: process.env.BRIDGE_LIVE === "1",
  apiKey: process.env.BRIDGE_API_KEY ?? "",
  baseUrl: process.env.BRIDGE_BASE_URL ?? "https://api.bridge.xyz",
  onBehalfOf: process.env.BRIDGE_ON_BEHALF_OF ?? "",
  sourceRail: process.env.BRIDGE_SOURCE_RAIL ?? "base",
  destinationRail: process.env.BRIDGE_DESTINATION_RAIL ?? "stellar",
  destinationCurrency: process.env.BRIDGE_DESTINATION_CURRENCY ?? "usdc",
  destinationAddress: process.env.BRIDGE_DESTINATION_ADDRESS ?? "",
  destinationMemo: process.env.BRIDGE_DESTINATION_MEMO ?? "",
};

const configuredAnchorDomain = process.env.MG_ANCHOR_DOMAIN ?? "";
const configuredAnchorAsset = process.env.MG_ANCHOR_ASSET?.trim();

export function isMoneyGramAnchorDomain(domain: string): boolean {
  return /(^|\.)moneygram\.com$/i.test(domain.trim());
}

function defaultAnchorAsset(domain: string): string {
  return isMoneyGramAnchorDomain(domain) ? "USDC" : "SRT";
}

const anchorAsset = configuredAnchorAsset || defaultAnchorAsset(configuredAnchorDomain);
if (isMoneyGramAnchorDomain(configuredAnchorDomain) && anchorAsset !== "USDC") {
  throw new Error(
    `MG_ANCHOR_ASSET=${anchorAsset} is incompatible with MoneyGram anchor ${configuredAnchorDomain}; use USDC`,
  );
}

export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const STELLAR_PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Stellar treasury + MoneyGram-style anchor (SEP-10/SEP-24). */
export const STELLAR = {
  // Public network by default. The Stellar testnet (horizon-testnet, the test
  // passphrase, friendbot) is opt-in for the anchor harnesses.
  horizon: process.env.STELLAR_HORIZON ?? "https://horizon.stellar.org",
  networkPassphrase: process.env.STELLAR_PASSPHRASE ?? STELLAR_PUBLIC_PASSPHRASE,
  friendbot: process.env.STELLAR_FRIENDBOT ?? "",
  // Anchor home domain for SEP-10/24. Stellar's public test anchor works
  // without any signup; MoneyGram production is the same protocol at their
  // domain with a partner-onboarded account.
  anchorDomain: configuredAnchorDomain,
  anchorAsset,
  // MoneyGram production may require SEP-10 custodial auth to include a
  // positive integer memo identifying the end user behind a shared account.
  authMemo: process.env.MG_AUTH_MEMO ?? "",
  clientDomain: process.env.MG_CLIENT_DOMAIN ?? "",
  clientDomainSigningSecret: process.env.MG_CLIENT_DOMAIN_SIGNING_SECRET ?? "",
  treasurySecret: process.env.STELLAR_TREASURY_SECRET ?? "",
};

export const anchorModeEnabled = () => Boolean(STELLAR.anchorDomain);
