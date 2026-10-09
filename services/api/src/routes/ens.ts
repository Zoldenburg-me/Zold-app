/**
 * ENS routes.
 *
 * - GET /ens/gateway/:sender/:callData.json: the CCIP-Read gateway the L1
 *   OffchainResolver points wallets at (ens.ts holds the encoding). No
 *   session, because any wallet may resolve `alice.zoldhq.com`. It answers
 *   only what GET /pay/:handle already publishes: the deposit address and
 *   the page URL, and nothing for a closed page.
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
import { createPublicClient, getAddress, http, isHex, toCoinType, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { CHAIN_ID, ENS_GATEWAY, ENS_LOOKUP, PUBLIC_URL } from "../config.js";
import { answerResolveCall, EnsGatewayError, NO_RECORDS, signGatewayResponse, type EnsRecords } from "../ens.js";
import { publicPayee } from "../pay.js";
import { store, type User } from "../store.js";
import { livePaymentPage, payChain } from "./payment-page.js";
import { wrap } from "./util.js";

/** requireSession is injected — server.ts owns authentication. */
export interface EnsDeps {
  requireSession: (req: express.Request, res: express.Response) => unknown;
  /** Defaults to livePaymentPage. */
  livePage?: LivePage;
}

/** A resolve(bytes,bytes) call is a few hundred bytes; this bounds the work a
 *  stranger can ask for. Hex characters, prefix included. */
const MAX_CALL_DATA_HEX = 4_096;

/** How long the gateway waits for a page's forwarder renewal before it
 *  answers "no records". A wallet gives up on a slow gateway; the renewal
 *  carries on and the next lookup sees its result. */
const PAGE_CHECK_TIMEOUT_MS = 2_000;

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

/** How a gateway answer came about, which decides how long it may be reused. */
interface Lookup {
  /** The page check ran out of time: the answer is "nothing" for now only. */
  timedOut: boolean;
  /** The answer carries an address. */
  found: boolean;
}

/** What `<handle>.<parent>` resolves to: the page's deposit address on each
 *  chain the page takes payments on, and the page's URL. */
async function handleRecords(handle: string | undefined, livePage: LivePage, lookup: Lookup): Promise<EnsRecords> {
  if (!handle) return NO_RECORDS;
  const user = store.findUserByHandle(handle);
  // findUserByHandle trims and lowercases; the label must be the handle as stored.
  if (!user?.paymentPage?.handle || user.paymentPage.handle !== handle) return NO_RECORDS;
  const live = await liveWithin(livePage(user), PAGE_CHECK_TIMEOUT_MS);
  if (live === undefined) lookup.timedOut = true;
  if (!live) return NO_RECORDS;
  const payee = publicPayee(store.findUser(user.id) ?? user, payChain());
  const chainIds = new Set([payee.chainId, ...(payee.supportedTokens ?? []).map((t) => t.chainId)]);
  const base = PUBLIC_URL.replace(/\/+$/, "");
  const addresses = new Map([...chainIds].flatMap((id) => coinTypeOf(id)).map((coin) => [coin, payee.address]));
  lookup.found = addresses.size > 0;
  return { addresses, texts: base ? { url: `${base}/pay/${payee.handle}` } : {} };
}

/** Is the page live? `livePaymentPage`, injectable so a test can make it slow. */
export type LivePage = (user: User) => Promise<boolean>;

/** The page check's answer, or undefined once `ms` pass. */
function liveWithin(check: Promise<boolean>, ms: number): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([check, late]).finally(() => clearTimeout(timer));
}

/** ENSIP-11 coin type for a chain id, or none for an id it cannot express
 *  (one bad token entry must not fail the page's other records). */
function coinTypeOf(chainId: number): bigint[] {
  try {
    return [toCoinType(chainId)];
  } catch {
    return [];
  }
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
 *  it has none (a handle claimed a moment later should show soon), and not
 *  at all if the page check timed out (the renewal may finish any second). */
function rememberAnswer(key: string, data: Hex, expires: bigint, lookup: Lookup) {
  if (lookup.timedOut) return;
  const reuseS = lookup.found ? ENS_GATEWAY.ttlSeconds / 2 : Math.min(NOT_FOUND_REUSE_S, ENS_GATEWAY.ttlSeconds / 2);
  const oldest = signedAnswers.keys().next();
  if (signedAnswers.size >= SIGNED_CACHE_MAX && !oldest.done) signedAnswers.delete(oldest.value);
  signedAnswers.set(key, { data, expires, reuseUntil: Date.now() + reuseS * 1000 });
}

/** HTTP caching for an answer: never past its signed expiry, and none for an
 *  answer given because the page check timed out. */
function cacheControl(expires: bigint, lookup?: Lookup): string {
  if (lookup?.timedOut) return "no-store";
  const left = Math.floor(Number(expires) - Date.now() / 1000);
  return `public, max-age=${Math.max(0, Math.min(HTTP_MAX_AGE_S, left))}`;
}

export function createEnsRouter({ requireSession, livePage = livePaymentPage }: EnsDeps) {
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
        const lookup: Lookup = { timedOut: false, found: false };
        const { result } = await answerResolveCall(callData as Hex, ENS_GATEWAY.parent, (handle) => handleRecords(handle, livePage, lookup));
        const expires = BigInt(Math.floor(Date.now() / 1000) + ENS_GATEWAY.ttlSeconds);
        const data = await signGatewayResponse({
          resolver: ENS_GATEWAY.resolver,
          request: callData as Hex,
          result,
          expires,
          key: ENS_GATEWAY.key,
        });
        rememberAnswer(key, data, expires, lookup);
        res.setHeader("cache-control", cacheControl(expires, lookup));
        return res.json({ data });
      } catch (e) {
        if (e instanceof EnsGatewayError) return res.status(400).json({ message: e.message });
        throw e;
      }
    }),
  );

  const client = ENS_LOOKUP.enabled
    ? createPublicClient({
        chain: ENS_LOOKUP.chainId === 1 ? mainnet : sepolia,
        transport: http(ENS_LOOKUP.rpcUrl, { timeout: ENS_RPC_TIMEOUT_MS }),
        ccipRead: { request: ccipFetch },
      })
    : undefined;

  router.get(
    "/ens/lookup",
    wrap(async (req, res) => {
      if (!requireSession(req, res)) return;
      const raw = String(req.query.name ?? "").trim();
      if (raw.length > MAX_NAME_LENGTH) return res.status(400).json({ error: "not a valid ENS name", code: "BAD_NAME" });
      let name: string;
      try {
        name = normalize(raw);
      } catch {
        return res.status(400).json({ error: "not a valid ENS name", code: "BAD_NAME" });
      }
      if (!name.includes(".")) return res.status(400).json({ error: "not a valid ENS name", code: "BAD_NAME" });
      if (!client) return res.status(503).json({ error: "ENS lookups are not configured on this deployment", code: "ENS_LOOKUP_OFF" });
      let address: string | null;
      try {
        address = await client.getEnsAddress({ name, coinType: toCoinType(CHAIN_ID) });
      } catch {
        return res.status(502).json({ error: "the ENS lookup failed — try again", code: "ENS_UNAVAILABLE" });
      }
      if (!address) {
        return res.status(404).json({ error: `${name} has no address for this network`, code: "NO_ADDRESS" });
      }
      res.setHeader("cache-control", "private, no-store");
      res.json({ name, address: getAddress(address), chainId: CHAIN_ID });
    }),
  );

  return router;
}
