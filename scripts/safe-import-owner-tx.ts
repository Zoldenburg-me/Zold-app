/**
 * The owner change an existing Safe's EOA owner sends so the Safe can be
 * imported into Zold (routes/safe-import.ts). Takes no key and sends nothing:
 * it reads the Safe and prints what to sign.
 *
 *   npm run safe:import-tx -- --chain 8453 --safe 0x… --verifier 0x…
 *   npm run safe:import-tx -- --chain 84532 --safe 0x… --x 0x… --y 0x… [--mode swap]
 *
 * --verifier   the address POST /api/users/:id/safe/import/prepare returned, or
 * --x / --y    the passkey's P-256 public key (needed to deploy the verifier)
 * --mode       add (default): addOwnerWithThreshold(verifier, 1); the EOA stays
 *                as the user's own backup owner, 1 of 2.
 *              swap: swapOwner(prev, EOA, verifier); the EOA is removed.
 * --replace    swap only: which owner to replace, when there is more than one
 * --rpc        defaults to the chain's public RPC
 * --out        where to write the Transaction Builder JSON
 *
 * Output:
 * (a) a Safe Transaction Builder batch to load in app.safe.global → Apps →
 *     Transaction Builder and sign with the owner's hardware wallet;
 * (b) the raw to/data/value of each step, including an execTransaction the
 *     owner can send directly (a pre-validated signature: msg.sender is the
 *     owner, so no off-chain signature is involved).
 *
 * Refuses a Safe Zold could not sign for after the change: wrong singleton,
 * 4337 module or fallback handler missing, another module, a guard, a
 * threshold other than 1, or more than two owners.
 */
import { writeFileSync } from "node:fs";
import { getAddress, keccak256, toBytes } from "viem";
import {
  SafeImportRefusal,
  assertImportableShape,
  execTransactionByOwner,
  jsonRpcReader,
  ownerChangeTransaction,
  passkeyVerifierAddress,
  readSafeForImport,
  verifierDeploymentTransaction,
  type OwnerChangeMode,
} from "../services/api/src/wallet/safe-import.js";

type Hex = `0x${string}`;
const RPC: Record<string, string> = { "8453": "https://mainnet.base.org", "84532": "https://sepolia.base.org" };

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
    out[k.slice(2)] = v;
    i++;
  }
  return out;
}

/**
 * Transaction Builder's own checksum (safe-react-apps, tx-builder
 * src/lib/checksum.ts): keccak256 over its key-sorted serialisation with
 * meta.name nulled. Written from that source, not tested against the app; a
 * mismatch only makes the app warn that the file was edited.
 */
function serialize(json: unknown): string {
  const replacer = (_: string, v: unknown) => (v === undefined ? null : v);
  if (Array.isArray(json)) return `[${json.map(serialize).join(",")}]`;
  if (json && typeof json === "object") {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, replacer)}`;
    for (const k of keys) acc += `${serialize((json as any)[k])},`;
    return `${acc}}`;
  }
  return JSON.stringify(json, replacer);
}
function withChecksum(batch: any) {
  const checksum = keccak256(toBytes(serialize({ ...batch, meta: { ...batch.meta, name: null } })));
  return { ...batch, meta: { ...batch.meta, checksum } };
}

async function main() {
  const a = args();
  const chain = a.chain;
  if (!chain) throw new Error("--chain is required (8453 Base, 84532 Base Sepolia)");
  const rpcUrl = a.rpc ?? RPC[chain];
  if (!rpcUrl) throw new Error(`no default RPC for chain ${chain}; pass --rpc`);
  if (!a.safe) throw new Error("--safe is required");
  const safe = getAddress(a.safe) as Hex;
  const mode = (a.mode ?? "add") as OwnerChangeMode;
  if (mode !== "add" && mode !== "swap") throw new Error("--mode must be add or swap");

  let verifier: Hex;
  let xy: { x: bigint; y: bigint } | null = null;
  if (a.x || a.y) {
    if (!a.x || !a.y) throw new Error("--x and --y go together");
    xy = { x: BigInt(a.x), y: BigInt(a.y) };
    verifier = passkeyVerifierAddress(xy.x, xy.y);
    if (a.verifier && getAddress(a.verifier) !== verifier) {
      throw new Error(`--verifier ${a.verifier} is not the verifier of that key (${verifier})`);
    }
  } else if (a.verifier) {
    verifier = getAddress(a.verifier) as Hex;
  } else {
    throw new Error("pass --verifier (from /safe/import/prepare) or --x and --y");
  }

  const reader = jsonRpcReader(rpcUrl);
  const chainId = BigInt(await (await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  })).json().then((b: any) => b.result));
  if (chainId !== BigInt(chain)) throw new Error(`the RPC answers chain ${chainId}, not ${chain}`);

  const state = await readSafeForImport(reader, safe);
  console.error(`Safe ${safe} on chain ${chain}: owners ${state.owners.join(", ")}, threshold ${state.threshold}`);
  assertImportableShape(state);
  const change = ownerChangeTransaction({
    safe,
    owners: state.owners,
    threshold: state.threshold,
    verifier,
    mode,
    ...(a.replace ? { replace: getAddress(a.replace) as Hex } : {}),
  });

  const verifierCode = await reader.getCode(verifier);
  const needsVerifier = !verifierCode || verifierCode === "0x";
  if (needsVerifier && !xy) {
    throw new Error(`the verifier ${verifier} has no code yet; pass --x and --y so its deployment can be included`);
  }
  const deploy = needsVerifier && xy ? verifierDeploymentTransaction(xy.x, xy.y) : null;

  // The owner who sends it: the one being replaced, or the only one.
  const sender = mode === "swap"
    ? state.owners.find((o) => !change.resultOwners.includes(o))!
    : state.owners.length === 1 ? state.owners[0] : null;
  const exec = sender ? execTransactionByOwner(safe, sender, change) : null;

  const steps = [
    ...(deploy ? [{ to: deploy.to, value: deploy.value.toString(), data: deploy.data }] : []),
    { to: change.to, value: change.value.toString(), data: change.data },
  ];
  const batch = withChecksum({
    version: "1.0",
    chainId: chain,
    createdAt: Date.now(),
    meta: {
      name: `Zold import: ${mode === "add" ? "add" : "swap in"} passkey verifier`,
      description: `${deploy ? "Deploy the passkey's WebAuthn verifier, then " : ""}${
        mode === "add" ? `add ${verifier} as owner (threshold 1)` : `replace ${sender} with ${verifier}`}. Owners after: ${change.resultOwners.join(", ")}.`,
      txBuilderVersion: "1.18.0",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
    },
    transactions: steps.map((s) => ({ ...s, contractMethod: null, contractInputsValues: null })),
  });
  const out = a.out ?? `safe-import-${safe}-${chain}.json`;
  writeFileSync(out, JSON.stringify(batch, null, 2) + "\n");

  const print = (label: string, t: { to: string; value: bigint | string; data: string }) =>
    console.log(`\n${label}\n  to:    ${t.to}\n  value: ${t.value.toString()}\n  data:  ${t.data}`);
  console.log(`(a) Transaction Builder batch: ${out}\n    app.safe.global → ${safe} → Apps → Transaction Builder → load the file, sign with the owner.`);
  console.log(`\n(b) Raw, in order. Owners after: ${change.resultOwners.join(", ")} (threshold 1).`);
  if (deploy) print("1. Deploy the verifier (factory call; any funded key may send it):", deploy);
  print(`${deploy ? "2" : "1"}. The owner change as a Safe self-call (what the batch above executes):`, change);
  if (exec) print(`   …or send this from ${sender} directly (execTransaction with a pre-validated signature):`, exec);
  console.log(`\nThen: POST /api/users/:id/safe/import/confirm {"address":"${safe}"}`);
}

main().catch((err) => {
  if (err instanceof SafeImportRefusal) console.error(`refused (${err.code}): ${err.message}`);
  else console.error(err?.message ?? err);
  process.exit(1);
});
