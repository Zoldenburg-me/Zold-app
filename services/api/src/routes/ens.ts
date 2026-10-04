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
 * refuses private, loopback and link-local addresses when connecting, does not
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
import { store } from "../store.js";
import { livePaymentPage, payChain } from "./payment-page.js";
import { wrap } from "./util.js";

/** requireSession is injected — server.ts owns authentication. */
export interface EnsDeps {
  requireSession: (req: express.Request, res: express.Response) => unknown;
}

/** A resolve(bytes,bytes) call is a few hundred bytes; this bounds the work a
 *  stranger can ask for. Hex characters, prefix included. */
const MAX_CALL_DATA_HEX = 4_096;

const CCIP_TIMEOUT_MS = 3_000;
const CCIP_MAX_BYTES = 64 * 1024;
const CCIP_MAX_URLS = 2;
const ENS_RPC_TIMEOUT_MS = 10_000;

/** Is `ip` reachable on the public internet? Loopback, private, link-local,
 *  CGNAT, multicast and documentation ranges are not. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return !(x === "::" || x === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(x));
  }
  return false;
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

function fetchPublic(url: string, body?: string): Promise<string> {
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

/** What `<handle>.<parent>` resolves to: the page's deposit address on each
 *  chain the page takes payments on, and the page's URL. */
async function handleRecords(handle: string | undefined): Promise<EnsRecords> {
  if (!handle) return NO_RECORDS;
  const user = store.findUserByHandle(handle);
  if (!user?.paymentPage?.handle) return NO_RECORDS;
  if (!(await livePaymentPage(user))) return NO_RECORDS;
  const payee = publicPayee(store.findUser(user.id) ?? user, payChain());
  const chainIds = new Set([payee.chainId, ...(payee.supportedTokens ?? []).map((t) => t.chainId)]);
  return {
    addresses: new Map([...chainIds].map((id) => [toCoinType(id), payee.address])),
    texts: PUBLIC_URL ? { url: `${PUBLIC_URL}/pay/${payee.handle}` } : {},
  };
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
      try {
        const { result } = await answerResolveCall(callData as Hex, ENS_GATEWAY.parent, handleRecords);
        const data = await signGatewayResponse({
          resolver: ENS_GATEWAY.resolver,
          request: callData as Hex,
          result,
          expires: BigInt(Math.floor(Date.now() / 1000) + ENS_GATEWAY.ttlSeconds),
          key: ENS_GATEWAY.key,
        });
        res.setHeader("cache-control", "public, max-age=60");
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
      if (!client) return res.status(503).json({ error: "ENS lookups are not configured on this deployment", code: "ENS_LOOKUP_OFF" });
      let name: string;
      try {
        name = normalize(String(req.query.name ?? "").trim());
      } catch {
        return res.status(400).json({ error: "not a valid ENS name", code: "BAD_NAME" });
      }
      if (!name.includes(".")) return res.status(400).json({ error: "not a valid ENS name", code: "BAD_NAME" });
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
