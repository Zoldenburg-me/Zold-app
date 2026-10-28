/**
 * ENS routes.
 *
 * - GET /ens/gateway/:sender/:callData.json: the CCIP-Read gateway the L1
 *   OffchainResolver points wallets at (ens.ts holds the encoding). No
 *   session, because any wallet may resolve `alice.zoldhq.com`. It answers
 *   the handle owner's passkey Safe and the page URL.
 * - GET /ens/lookup?name=: an ENS name to an address on this deployment's
 *   chain, for a signed-in user. There is no fallback to the Ethereum address
 *   record: a name with no record for this chain does not resolve, because a
 *   mainnet address may not be the same account on Base.
 *
 * A lookup can make this server fetch a URL that the name's owner chose: an
 * offchain resolver answers with OffchainLookup and a gateway URL. viem would
 * fetch that URL as given, so `ccipFetch` replaces it. It allows https only,
 * refuses private, loopback and link-local addresses (an IP literal in the
 * URL, and every address a hostname resolves to when connecting), does not
 * follow redirects, and caps both the time and the size of the response.
 */
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import express from "express";
import { createPublicClient, getAddress, http, isAddress, isHex, toCoinType, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { CHAIN_ID, ENS_GATEWAY, ENS_LOOKUP, PUBLIC_URL } from "../config.js";
import { answerResolveCall, EnsGatewayError, NO_RECORDS, signGatewayResponse, type EnsRecords } from "../ens.js";
import { store } from "../store.js";
import { wrap } from "./util.js";

/** requireSession is injected — server.ts owns authentication. */
export interface EnsDeps {
  requireSession: (req: express.Request, res: express.Response) => unknown;
}

/** A resolve(bytes,bytes) call is a few hundred bytes; this bounds the work a
 *  stranger can ask for. Hex characters, prefix included. */
const MAX_CALL_DATA_HEX = 4_096;

/** Signed answers kept per request, so repeat lookups cost no signature and
 *  no store scan. One with an address is reused for half its validity, one
 *  without for NOT_FOUND_REUSE_S (rememberAnswer). */
const SIGNED_CACHE_MAX = 2_000;
const NOT_FOUND_REUSE_S = 30;
/** HTTP max-age on an answer, capped by what is left of its signature. */
const HTTP_MAX_AGE_S = 60;

const CCIP_TIMEOUT_MS = 3_000;
const CCIP_MAX_BYTES = 64 * 1024;
const CCIP_MAX_URLS = 2;
const ENS_RPC_TIMEOUT_MS = 10_000;

/**
 * Ranges that are not the public internet (IANA special-purpose registries).
 * A BlockList compares numerically, so every spelling of an address matches:
 * "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1" and "::ffff:127.0.0.1" are all
 * checked as 127.0.0.1 against the IPv4 rules.
 */
const NON_PUBLIC = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of [
  // Unspecified, loopback and the IPv4-compatible ::a.b.c.d.
  ["::", 96],
  // NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) carry an IPv4
  // address inside; on a host that translates them, 64:ff9b::a9fe:a9fe
  // dials 169.254.169.254. No real gateway needs them. Teredo (2001::/32)
  // sits in the IETF protocol block 2001::/23.
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["2001::", 23],
  // Discard-only, documentation, unique-local, link-local, the deprecated
  // site-local, and multicast.
  ["100::", 64], ["2001:db8::", 32], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(prefix, bits, "ipv6");

/** Is `ip` reachable on the public internet? Loopback, private, link-local,
 *  CGNAT, multicast, documentation and IPv4-embedding ranges are not, and
 *  neither is anything that does not parse as an address. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : undefined;
  if (!family) return false;
  try {
    return !NON_PUBLIC.check(ip, family);
  } catch {
    return false;
  }
}

/** DNS lookup that refuses a host with any non-public address. It runs when
 *  the socket connects, so a DNS answer that changes between a check and the
 *  connection cannot slip a private address in. */
const publicLookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new Error(`${hostname} resolves to a non-public address`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}) as unknown as net.LookupFunction;

/** Name lookups bound the work: ENS names longer than this are not real. */
const MAX_NAME_LENGTH = 255;

export function fetchPublic(url: string, body?: string): Promise<string> {
  // Node skips the `lookup` hook for an IP literal (`https://10.0.0.5/`,
  // `https://[::1]/`), so a literal is checked here before connecting.
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return Promise.reject(new Error("not a URL"));
  }
  if (net.isIP(host) && !isPublicAddress(host)) return Promise.reject(new Error(`${host} is a non-public address`));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        lookup: publicLookup,
        signal: AbortSignal.timeout(CCIP_TIMEOUT_MS),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`gateway answered ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > CCIP_MAX_BYTES) return req.destroy(new Error("gateway answer too large"));
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** viem's CCIP-Read request (ERC-3668), with fetchPublic doing the fetching. */
export async function ccipFetch({ data, sender, urls }: { data: Hex; sender: Address; urls: readonly string[] }): Promise<Hex> {
  for (const template of urls.slice(0, CCIP_MAX_URLS)) {
    const url = template.replace("{sender}", sender.toLowerCase()).replace("{data}", data);
    if (!url.startsWith("https://")) continue;
    try {
      const text = await fetchPublic(url, template.includes("{data}") ? undefined : JSON.stringify({ data, sender }));
      const result = JSON.parse(text)?.data;
      if (isHex(result)) return result;
    } catch {
      // next gateway
    }
  }
  throw new Error("no usable CCIP-Read gateway");
}

/** Whether a gateway answer carries an address, which decides how long it may be reused. */
interface Lookup {
  found: boolean;
}

/**
 * What `<handle>.<parent>` resolves to: the handle owner's passkey Safe on the
 * chain it is deployed on (this deployment's), and the page's URL. Never the
 * page's deposit address: in production that is a Candide forwarder that
 * moves only USDC, so EURe sent to the name would strand there. No active
 * passkey Safe that is the account's address, no answer at all.
 *
 * The forwarder's liveness (livePaymentPage) is not asked: it is about the
 * forwarder only, and the Safe takes payments whatever its state.
 */
async function handleRecords(handle: string | undefined, lookup: Lookup): Promise<EnsRecords> {
  if (!handle) return NO_RECORDS;
  const user = store.findUserByHandle(handle);
  // findUserByHandle trims and lowercases; the label must be the handle as stored.
  if (!user?.paymentPage?.handle || user.paymentPage.handle !== handle) return NO_RECORDS;
  // The identity the page claim checks; "active" is set once the Safe is deployed.
  const safe = user.passkeySafe;
  if (safe?.status !== "active" || user.address.toLowerCase() !== safe.address.toLowerCase()) return NO_RECORDS;
  const base = PUBLIC_URL.replace(/\/+$/, "");
  lookup.found = true;
  return {
    addresses: new Map([[toCoinType(CHAIN_ID), getAddress(safe.address)]]),
    texts: base ? { url: `${base}/pay/${user.paymentPage.handle}` } : {},
  };
}

/** Signed answers by request (lowercase hex), oldest first (Map keeps
 *  insertion order). `reuseUntil` is in ms. */
const signedAnswers = new Map<string, { data: Hex; expires: bigint; reuseUntil: number }>();

/** A signed answer for this request that may still be reused. */
function cachedAnswer(key: string): { data: Hex; expires: bigint } | undefined {
  const hit = signedAnswers.get(key);
  if (!hit) return undefined;
  if (Date.now() < hit.reuseUntil) return hit;
  signedAnswers.delete(key);
  return undefined;
}

/** Keep an answer for reuse: half its validity if it has an address, less if
 *  it has none (a handle claimed a moment later should show soon). */
function rememberAnswer(key: string, data: Hex, expires: bigint, lookup: Lookup) {
  const reuseS = lookup.found ? ENS_GATEWAY.ttlSeconds / 2 : Math.min(NOT_FOUND_REUSE_S, ENS_GATEWAY.ttlSeconds / 2);
  const oldest = signedAnswers.keys().next();
  if (signedAnswers.size >= SIGNED_CACHE_MAX && !oldest.done) signedAnswers.delete(oldest.value);
  signedAnswers.set(key, { data, expires, reuseUntil: Date.now() + reuseS * 1000 });
}

/** HTTP caching for an answer: never past its signed expiry. */
function cacheControl(expires: bigint): string {
  const left = Math.floor(Number(expires) - Date.now() / 1000);
  return `public, max-age=${Math.max(0, Math.min(HTTP_MAX_AGE_S, left))}`;
}

const ensClient = ENS_LOOKUP.enabled
  ? createPublicClient({
      chain: ENS_LOOKUP.chainId === 1 ? mainnet : sepolia,
      transport: http(ENS_LOOKUP.rpcUrl, { timeout: ENS_RPC_TIMEOUT_MS }),
      ccipRead: { request: ccipFetch },
    })
  : undefined;

export type EnsResolution =
  | { ok: true; name: string; address: Address }
  | { ok: false; status: 400 | 404 | 502 | 503; code: "BAD_NAME" | "ENS_LOOKUP_OFF" | "ENS_UNAVAILABLE" | "NO_ADDRESS"; error: string };

/**
 * The address an ENS name holds for the pay chain's coin type (ENSIP-11), or
 * why there is none. A name with only an Ethereum record does not resolve:
 * money sent here goes out on the pay chain. The lookup and a crypto send both
 * use this, so what the user is shown is what gets signed.
 */
export async function resolveEnsName(raw: string): Promise<EnsResolution> {
  const typed = raw.trim();
  if (typed.length > MAX_NAME_LENGTH) return { ok: false, status: 400, code: "BAD_NAME", error: "not a valid ENS name" };
  let name: string;
  try {
    name = normalize(typed);
  } catch {
    return { ok: false, status: 400, code: "BAD_NAME", error: "not a valid ENS name" };
  }
  if (!name.includes(".")) return { ok: false, status: 400, code: "BAD_NAME", error: "not a valid ENS name" };
  if (!ensClient) return { ok: false, status: 503, code: "ENS_LOOKUP_OFF", error: "ENS lookups are not configured on this deployment" };
  let address: string | null;
  try {
    address = await ensClient.getEnsAddress({ name, coinType: toCoinType(CHAIN_ID) });
  } catch {
    return { ok: false, status: 502, code: "ENS_UNAVAILABLE", error: "the ENS lookup failed — try again" };
  }
  return ensAnswer(name, address);
}

/** What a resolver answered, as a resolution: a resolver may answer anything,
 *  and only an address goes on screen or into a send. */
export function ensAnswer(name: string, address: string | null | undefined): EnsResolution {
  if (!address) return { ok: false, status: 404, code: "NO_ADDRESS", error: `${name} has no address for this network` };
  if (!isAddress(address, { strict: false })) {
    return { ok: false, status: 502, code: "ENS_UNAVAILABLE", error: `${name}'s resolver did not answer with an address` };
  }
  return { ok: true, name, address: getAddress(address) };
}

export function createEnsRouter({ requireSession }: EnsDeps) {
  const router = express.Router();

  router.get(
    // `{sender}` is not checked against our resolver: under a DNS name, ENS's
    // OffchainDNSResolver re-raises the lookup as its own, so the sender is
    // that contract. The answer is always signed for our resolver, and only
    // our resolver's resolveWithProof accepts it.
    "/ens/gateway/:sender/:file",
    wrap(async (req, res) => {
      // Wallets in a browser fetch this from their own origin.
      res.setHeader("access-control-allow-origin", "*");
      if (!ENS_GATEWAY.enabled || !ENS_GATEWAY.key) return res.status(404).json({ message: "no ENS gateway on this deployment" });
      const callData = req.params.file.replace(/\.json$/, "");
      if (!isHex(callData) || callData.length > MAX_CALL_DATA_HEX) return res.status(400).json({ message: "callData must be hex" });
      // The signature covers the request's bytes, not its spelling, so hex
      // case does not change the answer and the key ignores it.
      const key = callData.toLowerCase();
      const cached = cachedAnswer(key);
      if (cached) {
        res.setHeader("cache-control", cacheControl(cached.expires));
        return res.json({ data: cached.data });
      }
      try {
        const lookup: Lookup = { found: false };
        const { result } = await answerResolveCall(callData as Hex, ENS_GATEWAY.parent, (handle) => handleRecords(handle, lookup));
        const expires = BigInt(Math.floor(Date.now() / 1000) + ENS_GATEWAY.ttlSeconds);
        const data = await signGatewayResponse({
          resolver: ENS_GATEWAY.resolver,
          request: callData as Hex,
          result,
          expires,
          key: ENS_GATEWAY.key,
        });
        rememberAnswer(key, data, expires, lookup);
        res.setHeader("cache-control", cacheControl(expires));
        return res.json({ data });
      } catch (e) {
        if (e instanceof EnsGatewayError) return res.status(400).json({ message: e.message });
        throw e;
      }
    }),
  );

  router.get(
    "/ens/lookup",
    wrap(async (req, res) => {
      if (!requireSession(req, res)) return;
      const found = await resolveEnsName(String(req.query.name ?? ""));
      if (!found.ok) return res.status(found.status).json({ error: found.error, code: found.code });
      res.setHeader("cache-control", "private, no-store");
      res.json({ name: found.name, address: found.address, chainId: CHAIN_ID });
    }),
  );

  return router;
}
