/**
 * Google and Apple login for /guardian: a full-page redirect that comes back
 * with an ID token in the URL fragment. The fragment never reaches a server
 * (ours included) or a log; the page reads it and strips it at once.
 *
 * The nonce is sha256 over the browser key's public half, so the token is
 * good only together with that key (Turnkey and the API both check it). The
 * state is a one-time random value kept in sessionStorage for ten minutes, so
 * a token handed to this page by anyone else's link is refused.
 *
 * Shared by /guardian (adding the login) and /recovery (approving with it).
 * No DOM: the storage, key and navigation are handed in, so
 * scripts/turnkey-guardian-page-test.ts can run it.
 */
export const OAUTH_STATE_KEY = "zold-guardian-oauth";
export const RETURN_WINDOW_MS = 10 * 60_000;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** sha256 over the compressed public key's hex string, as hex. */
export async function nonceFor(publicKey) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey))));
}

export const newState = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Where to send the browser. Google: implicit ID token, openid only. Apple:
 * `code id_token` in the fragment with no scope, so Apple asks for neither
 * name nor email (the code is ignored).
 */
export function authorizeUrl(provider, { clientId, redirectUri, nonce, state }) {
  if (provider === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({
      client_id: clientId, redirect_uri: redirectUri, response_type: "id_token", scope: "openid",
      nonce, state, prompt: "select_account",
    })) u.searchParams.set(k, v);
    return u.toString();
  }
  if (provider === "apple") {
    const u = new URL("https://appleid.apple.com/auth/authorize");
    for (const [k, v] of Object.entries({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code id_token", response_mode: "fragment",
      nonce, state,
    })) u.searchParams.set(k, v);
    return u.toString();
  }
  throw new Error(`unknown login provider: ${provider}`);
}

/**
 * The provider's answer in `hash`, checked against the state stored when the
 * login started. null when there is no answer to handle; otherwise
 * {ok: true, provider, idToken} or {ok: false, reason}.
 */
export function readReturn(hash, storedJson, now) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (![...params.keys()].length) return null;
  let stored = null;
  try {
    stored = storedJson ? JSON.parse(storedJson) : null;
  } catch {
    stored = null;
  }
  if (!stored || typeof stored.state !== "string") return { ok: false, reason: "This login was not started on this page. Start again." };
  if (params.get("state") !== stored.state) return { ok: false, reason: "This login does not match the one started here. Start again." };
  if (!(now - stored.at <= RETURN_WINDOW_MS)) return { ok: false, reason: "This login took too long. Start again." };
  const error = params.get("error");
  if (error) return { ok: false, reason: error === "access_denied" || error === "user_cancelled_authorize" ? "The login was cancelled." : `The login was refused (${error}).` };
  const idToken = params.get("id_token");
  if (!idToken) return { ok: false, reason: "The login came back without an ID token. Start again." };
  return { ok: true, provider: stored.provider, idToken };
}

const PROVIDER_NAMES = { google: "Google", apple: "Apple" };

/**
 * Leave for the provider: a fresh browser key, its hash as the nonce, a
 * one-time state. The login comes back to `returnPath` on this origin.
 */
export async function startLogin(provider, { stamper, storage, origin, logins, go, returnPath = "/guardian", now = Date.now }) {
  const clientId = logins?.[provider];
  if (!clientId) throw new Error(`${PROVIDER_NAMES[provider] ?? provider} login is not set up on this deployment`);
  await stamper.init();
  await stamper.resetKeyPair();
  const publicKey = stamper.getPublicKey();
  if (!publicKey) throw new Error("this browser could not make a key; try another browser");
  const state = newState();
  storage.setItem(OAUTH_STATE_KEY, JSON.stringify({ state, provider, at: now() }));
  go(authorizeUrl(provider, { clientId, redirectUri: `${origin}${returnPath}`, nonce: await nonceFor(publicKey), state }));
}
