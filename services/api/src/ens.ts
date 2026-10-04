/**
 * ENS gateway: answers for `<handle>.<parent>` names, signed for the L1
 * OffchainResolver (contracts/src/OffchainResolver.sol).
 *
 * The flow is CCIP-Read (ERC-3668) under ENSIP-10 wildcard resolution. A
 * wallet calls `resolve(name, data)` on the resolver, and the resolver reverts
 * with OffchainLookup, pointing at our gateway URL. The wallet then fetches
 * `/api/ens/gateway/{resolver}/{callData}.json`, and we return
 * `abi.encode(result, expires, signature)`. The wallet hands that back to the
 * resolver's `resolveWithProof`, which checks the signer and the expiry.
 *
 * Pure: no config, no store. The router decides which records a handle has,
 * and this file only encodes and signs them, so the contract test can run it
 * against a real resolver without the API.
 *
 * An address is only ever answered for a coin type whose chain the page
 * actually takes payments on. Answering coin type 60 (Ethereum) with a Base
 * address would send a mainnet payment to an address that may not exist
 * there.
 */
import {
  bytesToString,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  hexToBytes,
  keccak256,
  namehash,
  parseAbi,
  type Hex,
} from "viem";
import { sign } from "viem/accounts";

export class EnsGatewayError extends Error {}

/** `resolve(bytes name, bytes data)`: what the resolver forwards to us. */
const RESOLVER_SERVICE_ABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);

/** The resolver profiles we answer. Anything else is refused, not guessed. */
const PROFILE_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

/** ENSIP-9: coin type 60 is Ethereum, the coin type of legacy `addr(node)`. */
const ETH_COIN_TYPE = 60n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A DNS name on the wire is at most 255 bytes. */
const MAX_DNS_NAME_BYTES = 255;

/** What a handle resolves to. Empty means it resolves to nothing. */
export interface EnsRecords {
  /** Address per ENSIP-11 coin type. */
  addresses: Map<bigint, `0x${string}`>;
  texts: Record<string, string>;
}

export const NO_RECORDS: EnsRecords = { addresses: new Map(), texts: {} };

/** DNS wire format (`\x05alice\x06zoldhq\x03com\x00`) to `alice.zoldhq.com`. */
export function decodeDnsName(wire: Hex): string {
  const bytes = hexToBytes(wire);
  if (bytes.length > MAX_DNS_NAME_BYTES) throw new EnsGatewayError("name too long");
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) {
      if (i !== bytes.length - 1) throw new EnsGatewayError("bytes after the end of the name");
      return labels.join(".");
    }
    const label = bytesToString(bytes.slice(i + 1, i + 1 + len));
    if (i + 1 + len > bytes.length || label.includes(".")) throw new EnsGatewayError("malformed name");
    labels.push(label);
    i += 1 + len;
  }
  throw new EnsGatewayError("name has no terminator");
}

/** The handle in `<handle>.<parent>`, or undefined for the parent itself or a
 *  deeper name (`a.b.zoldhq.com` is no handle). */
export function handleFromName(name: string, parent: string): string | undefined {
  const suffix = `.${parent}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  return label && !label.includes(".") ? label : undefined;
}

/** Is `name` under `parent` at all (the parent included)? A gateway signs for
 *  its own names only. */
export function isUnderParent(name: string, parent: string): boolean {
  return name === parent || name.endsWith(`.${parent}`);
}

/**
 * Decode the call the resolver forwarded and encode the answer from `records`.
 *
 * `lookup` is called with the handle, or with undefined for the parent name
 * itself. The node inside the profile call must be the namehash of the name
 * it travels with: a mismatched pair is refused rather than answered for
 * either name.
 */
export async function answerResolveCall(
  callData: Hex,
  parent: string,
  lookup: (handle: string | undefined) => Promise<EnsRecords>,
): Promise<{ name: string; result: Hex }> {
  let outer;
  try {
    outer = decodeFunctionData({ abi: RESOLVER_SERVICE_ABI, data: callData });
  } catch {
    throw new EnsGatewayError("not a resolve(bytes,bytes) call");
  }
  const [wireName, inner] = outer.args;
  const name = decodeDnsName(wireName);
  if (!isUnderParent(name, parent)) throw new EnsGatewayError(`not a name under ${parent}`);

  let call;
  try {
    call = decodeFunctionData({ abi: PROFILE_ABI, data: inner });
  } catch {
    throw new EnsGatewayError("unsupported record type");
  }
  if (call.args[0] !== namehash(name)) throw new EnsGatewayError("node does not match the name");

  const records = name === parent ? await lookup(undefined) : await lookupHandle(name, parent, lookup);
  if (call.args.length === 1) {
    const address = records.addresses.get(ETH_COIN_TYPE) ?? ZERO_ADDRESS;
    return { name, result: encodeAbiParameters([{ type: "address" }], [address]) };
  }
  if (call.functionName === "addr") {
    const address = records.addresses.get(call.args[1] as bigint);
    return { name, result: encodeAbiParameters([{ type: "bytes" }], [address ?? "0x"]) };
  }
  const key = call.args[1] as string;
  const text = Object.hasOwn(records.texts, key) ? records.texts[key] : "";
  return { name, result: encodeAbiParameters([{ type: "string" }], [text]) };
}

async function lookupHandle(
  name: string,
  parent: string,
  lookup: (handle: string | undefined) => Promise<EnsRecords>,
): Promise<EnsRecords> {
  const handle = handleFromName(name, parent);
  return handle ? lookup(handle) : NO_RECORDS;
}

/** The hash the resolver recovers the signer from. It must match
 *  `OffchainResolver.makeSignatureHash` byte for byte. */
export function gatewaySignatureHash(resolver: `0x${string}`, expires: bigint, request: Hex, result: Hex): Hex {
  return keccak256(
    encodePacked(
      ["bytes2", "address", "uint64", "bytes32", "bytes32"],
      ["0x1900", resolver, expires, keccak256(request), keccak256(result)],
    ),
  );
}

/** `abi.encode(result, expires, signature)`, the response body's `data`. */
export async function signGatewayResponse(args: {
  resolver: `0x${string}`;
  request: Hex;
  result: Hex;
  expires: bigint;
  key: `0x${string}`;
}): Promise<Hex> {
  const signature = await sign({
    hash: gatewaySignatureHash(args.resolver, args.expires, args.request, args.result),
    privateKey: args.key,
    to: "hex",
  });
  return encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [args.result, args.expires, signature]);
}
