import { API_HOST, API_PORT } from "./env.js";

/**
 * Monerium integration — PRODUCTION by default (api.monerium.app). There is no
 * mock mode any more: every account is a real Monerium account, connected
 * either by OAuth (the user signs up / signs in at Monerium) or by the user's
 * own API keys. The app's client credentials, when set, only re-read webhook
 * orders and reconcile; they never provision profiles for users.
 * Point MONERIUM_BASE_URL at https://api.monerium.dev for the sandbox.
 */
const MONERIUM_BASE_URL = process.env.MONERIUM_BASE_URL ?? "https://api.monerium.app";
export const MONERIUM = {
  clientId: process.env.MONERIUM_CLIENT_ID ?? "",
  clientSecret: process.env.MONERIUM_CLIENT_SECRET ?? "",
  oauthClientId: process.env.MONERIUM_OAUTH_CLIENT_ID ?? process.env.MONERIUM_CLIENT_ID ?? "",
  baseUrl: MONERIUM_BASE_URL,
  // Chain identifier Monerium should associate linked addresses with. Their
  // production names are ethereum/gnosis/polygon/base/arbitrum/linea; the
  // sandbox uses testnet names (basesepolia, sepolia, ...).
  chain: process.env.MONERIUM_CHAIN ?? "base",
  // How often to poll for incoming EURe issue orders (webhooks need a public
  // URL; polling works for local dev).
  pollMs: Number(process.env.MONERIUM_POLL_MS ?? 15_000),
  // User-owned account connect (Authorization Code + PKCE). Redirect URI must
  // exactly match the OAuth app registration.
  authUrl: process.env.MONERIUM_AUTH_URL ?? `${MONERIUM_BASE_URL}/auth`,
  redirectUri:
    process.env.MONERIUM_REDIRECT_URI ??
    `http://${API_HOST}:${API_PORT}/api/monerium/oauth/callback`,
  tokenEncryptionKey: process.env.MONERIUM_TOKEN_ENCRYPTION_KEY ?? "",
};

export const moneriumSandboxEnabled = () =>
  Boolean(MONERIUM.clientId && MONERIUM.clientSecret);

export const moneriumOAuthEnabled = () => Boolean(MONERIUM.oauthClientId);
