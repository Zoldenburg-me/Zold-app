/**
 * The Safe{Wallet} Transaction Builder file for an import's owner change: the
 * batch the Safe's current owner loads at app.safe.global → Apps →
 * Transaction Builder and signs with their own wallet.
 *
 * One copy, so the file the app offers for download and the one
 * `npm run safe:import-tx` writes are the same bytes for the same input
 * (scripts/safe-import-test.ts compares them). Pure: no chain reads, no key.
 */
import { keccak256, toBytes } from "viem";
import type { MetaTransaction } from "abstractionkit";
import type { OwnerChangeMode } from "./safe-import.js";

type Hex = `0x${string}`;

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

/** The owner who sends the change: the one being replaced, or the only one. */
export function ownerChangeSender(mode: OwnerChangeMode, owners: Hex[], resultOwners: Hex[]): Hex | null {
  if (mode === "swap") return owners.find((o) => !resultOwners.includes(o)) ?? null;
  return owners.length === 1 ? owners[0] : null;
}

export function txBuilderFileName(safe: Hex, chainId: number | string): string {
  return `safe-import-${safe}-${chainId}.json`;
}

/**
 * The finished file, as text. `deploy` is the verifier's factory deployment
 * when it has no code yet; `createdAt` is a parameter so the same input gives
 * the same bytes (the checksum covers it).
 */
export function ownerChangeTxBuilderJson(args: {
  chainId: number | string;
  safe: Hex;
  owners: Hex[];
  verifier: Hex;
  mode: OwnerChangeMode;
  change: MetaTransaction & { resultOwners: Hex[] };
  deploy: MetaTransaction | null;
  createdAt: number;
}): string {
  const { chainId, safe, owners, verifier, mode, change, deploy, createdAt } = args;
  const sender = ownerChangeSender(mode, owners, change.resultOwners);
  const steps = [
    ...(deploy ? [{ to: deploy.to, value: deploy.value.toString(), data: deploy.data }] : []),
    { to: change.to, value: change.value.toString(), data: change.data },
  ];
  const batch = withChecksum({
    version: "1.0",
    chainId: String(chainId),
    createdAt,
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
  return JSON.stringify(batch, null, 2) + "\n";
}
