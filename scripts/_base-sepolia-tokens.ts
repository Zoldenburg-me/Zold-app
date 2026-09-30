/**
 * The EURe and USDC the running deployment (Base Sepolia, 84532) trades, as
 * constants, so venue suites send real token addresses without reading the
 * untracked deployments.json.
 *
 * USDC is Circle's (KNOWN_USDC[84532] in deploy.ts). EURe is Monerium's sandbox
 * token, as listed by Monerium's /tokens (EUR's `base-sepolia` contract in
 * services/api/src/domain/accounts.ts).
 */
export const BASE_SEPOLIA_TOKENS = {
  eure: "0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;
