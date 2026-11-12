/**
 * Cloudflare Access, checked by the server: the second gate in front of the
 * admin dashboard. Access signs a JWT for every request it lets through and
 * sends it as `Cf-Access-Jwt-Assertion`; the server verifies it itself, so a
 * request that reaches the API some other way (another tunnel hostname, a
 * process inside the container) carries no valid token and is refused.
 *
 * Never trusted on its own: the `Cf-Access-Authenticated-User-Email` header,
 * which any client can send.
 */
import { webcrypto } from "node:crypto";
import { OPERATOR } from "../config.js";
import { redactedMessage } from "../http/log-cause.js";

export class AccessRefusal extends Error {
  constructor(message: string, public status: 401 | 403 | 503 = 401) {
    super(message);
    this.name = "AccessRefusal";
  }
}

export const accessConfigured = () => Boolean(OPERATOR.accessTeamHost && OPERATOR.accessAud);

/** A hosted deployment never runs the admin dashboard without Access in front. */
export const accessRequired = () => OPERATOR.hardened || accessConfigured();

const certsUrl = () => OPERATOR.accessCertsUrl || `https://${OPERATOR.accessTeamHost}/cdn-cgi/access/certs`;
const issuer = () => `https://${OPERATOR.accessTeamHost}`;

/** A key id the server has never seen refetches the keys, at most this often,
 *  so a forged `kid` cannot turn every request into a fetch. */
const REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** Clock skew allowed on `nbf`. */
const SKEW_S = 60;

let keys = new Map<string, CryptoKey>();
let fetchedAt = 0;

async function refreshKeys(): Promise<void> {
  fetchedAt = Date.now();
  let body: any;
  try {
    const res = await fetch(certsUrl(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`certs answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new AccessRefusal(`Cloudflare Access keys could not be read: ${redactedMessage(err)}`, 503);
  }
  const next = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    const key = await webcrypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    next.set(jwk.kid, key);
  }
  keys = next;
}

async function keyFor(kid: string): Promise<CryptoKey | undefined> {
  if (!keys.has(kid) && Date.now() - fetchedAt >= REFETCH_MIN_MS) await refreshKeys();
  return keys.get(kid);
}

function decodePart(part: string): any {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new AccessRefusal("Cloudflare Access token is malformed");
  }
}

/**
 * The email of the identity Access let through. Refuses a missing, malformed,
 * unsigned, foreign, expired or email-less token (an Access service token
 * carries no email and never stands for an operator).
 */
export async function verifyAccessJwt(jwt: string | undefined): Promise<{ email: string }> {
  if (!accessConfigured()) {
    throw new AccessRefusal("Cloudflare Access is not configured: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD", 503);
  }
  if (!jwt) throw new AccessRefusal("this page is only reachable through Cloudflare Access");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new AccessRefusal("Cloudflare Access token is malformed");
  const [h, p, sig] = parts;
  const header = decodePart(h);
  if (header?.alg !== "RS256" || typeof header.kid !== "string") throw new AccessRefusal("Cloudflare Access token is not RS256");
  const key = await keyFor(header.kid);
  if (!key) throw new AccessRefusal("Cloudflare Access token is signed by an unknown key");
  const ok = await webcrypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(sig, "base64url"),
    Buffer.from(`${h}.${p}`, "utf8"),
  );
  if (!ok) throw new AccessRefusal("Cloudflare Access token signature does not verify");
  const claims = decodePart(p);
  const now = Math.floor(Date.now() / 1000);
  if (claims?.iss !== issuer()) throw new AccessRefusal("Cloudflare Access token is from another team");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(OPERATOR.accessAud)) throw new AccessRefusal("Cloudflare Access token is for another application");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new AccessRefusal("Cloudflare Access token has expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_S) throw new AccessRefusal("Cloudflare Access token is not valid yet");
  if (typeof claims.email !== "string" || !claims.email.includes("@")) {
    throw new AccessRefusal("Cloudflare Access token names no person (a service token is not an operator)");
  }
  return { email: claims.email.trim().toLowerCase() };
}

/** The offline suites rotate their stub keys between cases. */
export function forgetAccessKeysForTests(): void {
  keys = new Map();
  fetchedAt = 0;
}
