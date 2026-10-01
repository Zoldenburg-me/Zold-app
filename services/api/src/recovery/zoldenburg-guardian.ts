/**
 * Zoldenburg as a recovery guardian, with the key on an operator's hardware
 * wallet.
 *
 * The user chooses it (onboarding step 3 or Profile → Recovery) and adds the
 * guardian with a passkey-signed operation; nothing adds it silently. When
 * they lose the passkey they ask Zoldenburg, an operator checks the person
 * against the identity Monerium verified, and signs the recovery on the
 * hardware wallet. The API never holds the guardian key: it hands the
 * operator EIP-712 typed data, checks the returned signature against the
 * digest the MODULE computes, and relays it from the deployer key, which has
 * no authority of its own.
 *
 * What this means, said plainly because the onboarding warning repeats it:
 * - Zoldenburg alone can START a recovery of any Safe that opted in. The
 *   module's grace period (3 days on the production module) is the owner's
 *   window to cancel it with their passkey; that window is the protection.
 * - A recovery replaces the WHOLE owner set with the new passkey at threshold
 *   1, so a second owner added in Signers & rules does not survive it.
 *
 * Two ways to sign, both from the operator's own wallet:
 * - Safe Cover, Candide's open-source recovery UI (`safeCoverRecoveryLink`):
 *   the guardian confirms and executes on chain and pays that gas itself.
 *   It lists Base but NOT Base Sepolia.
 * - The admin dashboard: eth_signTypedData_v4, and the API relays. Works on
 *   every chain the module is on; the guardian account needs no ETH.
 * Either way the request only moves when the CHAIN shows the recovery
 * (`syncFromChain` in the router), never on the operator's say-so.
 *
 * Domain verified on chain (Sep 2026): Candide's deployed modules on Base and
 * Base Sepolia hash with name "Social Recovery Module", version "0.0.1". The
 * GitHub source reads "0.2.0" — a newer, undeployed revision — so the API
 * compares its typed-data hash with the module's getRecoveryHash on every
 * signature and refuses on any difference rather than trusting either.
 */
import { SocialRecoveryModule, type MetaTransaction } from "abstractionkit";
import lzString from "lz-string";
import { getAddress, hashTypedData, isAddress, recoverAddress, type Hex } from "viem";
import { CANDIDE, recoveryGuardianSetupTransactions } from "../wallet/candide.js";
import { candideRpc } from "../wallet/candide.js";
import { CHAIN_ID, HARNESS } from "../config.js";
import { relayReader, relayWallet } from "./recovered-passkey.js";

export class ZoldenburgRecoveryError extends Error {
  constructor(message: string, readonly status = 409, readonly code?: string) {
    super(message);
  }
}

/** The guardian address: the operator hardware wallet's account. */
export function zoldenburgGuardianAddress(): `0x${string}` | undefined {
  const a = CANDIDE.recoveryGuardianAddress;
  return a && isAddress(a) ? getAddress(a) : undefined;
}

export const zoldenburgRecoveryEnabled = (): boolean => Boolean(zoldenburgGuardianAddress());

export function assertZoldenburgRecoveryEnabled(): `0x${string}` {
  const g = zoldenburgGuardianAddress();
  if (!g) {
    throw new ZoldenburgRecoveryError(
      "Zoldenburg recovery is not available on this deployment — CANDIDE_RECOVERY_GUARDIAN_ADDRESS is unset",
      503,
      "RECOVERY_UNAVAILABLE",
    );
  }
  return g;
}

/**
 * Safe Cover (github.com/candidelabs/safecover, run by Bleu). Configurable
 * because it is a static site anyone can host — self-hosting a pinned build is
 * the safer choice for a page that asks the guardian's hardware wallet to
 * sign; the default is the deployment its repository names.
 */
export const SAFE_COVER_URL = (process.env.SAFE_COVER_URL ?? "https://candide-account-recovey.vercel.app").replace(/\/+$/, "");
/** Chains Safe Cover's wallet config lists (src/providers/Web3Provider.tsx). */
const SAFE_COVER_CHAINS = new Set([1, 10, 42161, 43114, 8453, 137, 11155111]);

/** Safe Cover's own link format (src/utils/recovery-link.ts): the dashboard
 *  route with an lz-string payload {s, o, t, c} in the fragment. */
export function safeCoverRecoveryLink(args: {
  safeAddress: `0x${string}`;
  newOwners: `0x${string}`[];
  newThreshold: number;
  chainId?: number;
}): string | null {
  const chainId = args.chainId ?? CHAIN_ID;
  if (!SAFE_COVER_CHAINS.has(chainId)) return null;
  const payload = { s: args.safeAddress, o: args.newOwners, t: args.newThreshold, c: String(chainId) };
  return `${SAFE_COVER_URL}/manage-recovery/dashboard#${lzString.compressToEncodedURIComponent(JSON.stringify(payload))}`;
}

export const RECOVERY_EIP712_DOMAIN = { name: "Social Recovery Module", version: "0.0.1" } as const;
const EXECUTE_RECOVERY_TYPES = {
  ExecuteRecovery: [
    { type: "address", name: "wallet" },
    { type: "address[]", name: "newOwners" },
    { type: "uint256", name: "newThreshold" },
    { type: "uint256", name: "nonce" },
  ],
} as const;

export interface RecoveryTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: typeof EXECUTE_RECOVERY_TYPES;
  primaryType: "ExecuteRecovery";
  message: { wallet: `0x${string}`; newOwners: `0x${string}`[]; newThreshold: bigint; nonce: bigint };
}

export function recoveryTypedData(args: {
  moduleAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  newOwners: `0x${string}`[];
  newThreshold: number;
  nonce: bigint;
  chainId?: number;
}): RecoveryTypedData {
  return {
    domain: { ...RECOVERY_EIP712_DOMAIN, chainId: args.chainId ?? CHAIN_ID, verifyingContract: getAddress(args.moduleAddress) },
    types: EXECUTE_RECOVERY_TYPES,
    primaryType: "ExecuteRecovery",
    message: {
      wallet: getAddress(args.safeAddress),
      newOwners: args.newOwners.map((o) => getAddress(o)),
      newThreshold: BigInt(args.newThreshold),
      nonce: args.nonce,
    },
  };
}

/** JSON for eth_signTypedData_v4: uint256 as decimal strings, EIP712Domain
 *  spelled out, which wallets need to render the domain on the device. */
export function typedDataForWallet(td: RecoveryTypedData) {
  return {
    domain: td.domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    message: { ...td.message, newThreshold: td.message.newThreshold.toString(), nonce: td.message.nonce.toString() },
  };
}

export const recoveryDigest = (td: RecoveryTypedData): Hex => hashTypedData(td as any);

/** The guardian's signature must recover to the guardian, over exactly this
 *  digest. A contract-wallet guardian (ERC-1271) is not supported here. */
export async function assertGuardianSignature(digest: Hex, signature: string, guardian: `0x${string}`): Promise<Hex> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new ZoldenburgRecoveryError("signature must be a 65-byte hex string from eth_signTypedData_v4", 400, "BAD_SIGNATURE");
  }
  // Some signers (QR flows among them) return v as 0/1. viem recovers either
  // way, but the module's ECDSA check wants 27/28 — normalise before relaying
  // so a signature that passes here cannot revert there.
  const v = parseInt(signature.slice(130, 132), 16);
  if (v === 0 || v === 1) signature = `${signature.slice(0, 130)}${(v + 27).toString(16)}`;
  else if (v !== 27 && v !== 28) {
    throw new ZoldenburgRecoveryError(`unexpected signature v=${v}`, 400, "BAD_SIGNATURE");
  }
  let signer: `0x${string}`;
  try {
    signer = await recoverAddress({ hash: digest, signature: signature as Hex });
  } catch {
    throw new ZoldenburgRecoveryError("the signature does not recover to any address", 400, "BAD_SIGNATURE");
  }
  if (signer.toLowerCase() !== guardian.toLowerCase()) {
    throw new ZoldenburgRecoveryError(
      `the signature is from ${signer}, not the Zoldenburg guardian ${guardian} — sign with the guardian account`,
      400,
      "WRONG_SIGNER",
    );
  }
  return signature as Hex;
}

/**
 * A harmless EIP-712 message for testing the guardian wallet end to end
 * (Keycard Shell → MetaMask/Rabby → this API) before a real recovery depends
 * on it. Its domain is not the module's, so the signature cannot be replayed
 * as a recovery approval.
 */
export function guardianCheckTypedData(issuedAt: string, chainId = CHAIN_ID) {
  return {
    domain: { name: "Zoldenburg guardian check", version: "1", chainId },
    types: { GuardianCheck: [{ name: "statement", type: "string" }, { name: "issuedAt", type: "string" }] },
    primaryType: "GuardianCheck" as const,
    message: { statement: "Testing the Zoldenburg recovery guardian. This approves nothing.", issuedAt },
  };
}

export function guardianCheckForWallet(td: ReturnType<typeof guardianCheckTypedData>) {
  return {
    ...td,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      ...td.types,
    },
  };
}

// ---------------------------------------------------------------------------
// chain access — one object so a test can substitute it; under the harness
// (hardhat, no recovery module) it answers without a chain.

export const zoldenburgChain = {
  /** The module's recovery nonce for this Safe. */
  async nonce(moduleAddress: `0x${string}`, safeAddress: `0x${string}`): Promise<bigint> {
    if (HARNESS.enabled) return 0n;
    return new SocialRecoveryModule(moduleAddress).nonce(candideRpc(), safeAddress);
  },
  /** The digest the module itself computes — the one it will verify. */
  async onChainDigest(td: RecoveryTypedData): Promise<Hex> {
    if (HARNESS.enabled) return recoveryDigest(td);
    const m = td.message;
    return (await new SocialRecoveryModule(td.domain.verifyingContract).getRecoveryHash(
      candideRpc(),
      m.wallet,
      m.newOwners,
      Number(m.newThreshold),
      m.nonce,
    )) as Hex;
  },
  /** Relay the guardian's signature and execute: the grace period starts now. */
  async relayRecovery(td: RecoveryTypedData, guardian: `0x${string}`, signature: Hex): Promise<{ txHash: `0x${string}` }> {
    if (HARNESS.enabled) return { txHash: `0x${"5a".repeat(32)}` };
    const m = td.message;
    const tx = new SocialRecoveryModule(td.domain.verifyingContract).createMultiConfirmRecoveryMetaTransaction(
      m.wallet,
      m.newOwners,
      Number(m.newThreshold),
      [{ signer: guardian, signature }],
      true,
    );
    return { txHash: await sendAndConfirm(tx, "execute the recovery") };
  },
  /** After the grace period anyone may finalise; the deployer pays the gas. */
  async relayFinalize(moduleAddress: `0x${string}`, safeAddress: `0x${string}`): Promise<{ txHash: `0x${string}` }> {
    if (HARNESS.enabled) return { txHash: `0x${"f1".repeat(32)}` };
    const tx = new SocialRecoveryModule(moduleAddress).createFinalizeRecoveryMetaTransaction(safeAddress);
    return { txHash: await sendAndConfirm(tx, "finalize the recovery") };
  },
};

async function sendAndConfirm(tx: MetaTransaction, what: string): Promise<`0x${string}`> {
  if (BigInt(CHAIN_ID) !== BigInt(CANDIDE.chainId)) {
    throw new ZoldenburgRecoveryError(`cannot ${what}: the app chain ${CHAIN_ID} is not the Safe chain ${CANDIDE.chainId}`, 409, "NO_CHAIN");
  }
  const hash = await relayWallet().sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value });
  const receipt = await relayReader().waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") {
    throw new ZoldenburgRecoveryError(`the transaction to ${what} reverted (${hash})`, 502, "REVERTED");
  }
  return hash;
}

/** Add Zoldenburg's guardian (enabling the module first if needed). The
 *  guardian threshold stays 1: any one guardian may start a recovery. */
export function zoldenburgGuardianSetupTransactions(
  safeAddress: `0x${string}`,
  moduleAddress: `0x${string}`,
  guardian: `0x${string}`,
  moduleEnabled: boolean,
): MetaTransaction[] {
  return recoveryGuardianSetupTransactions(safeAddress, moduleAddress, guardian, 1, moduleEnabled);
}

/** Remove Zoldenburg's guardian. With another guardian left the threshold
 *  stays 1; with none it becomes 0, the module's "no recovery" state. */
export async function zoldenburgGuardianRemoveTransaction(
  safeAddress: `0x${string}`,
  moduleAddress: `0x${string}`,
  guardian: `0x${string}`,
  guardians: `0x${string}`[],
): Promise<MetaTransaction> {
  const remaining = guardians.filter((g) => g.toLowerCase() !== guardian.toLowerCase()).length;
  const threshold = remaining > 0 ? 1n : 0n;
  const srm = new SocialRecoveryModule(moduleAddress);
  if (HARNESS.enabled) {
    // No chain to walk the guardian list on; the sentinel is the head.
    return srm.createStandardRevokeGuardianWithThresholdMetaTransaction("0x0000000000000000000000000000000000000001", guardian, threshold);
  }
  return srm.createRevokeGuardianWithThresholdMetaTransaction(candideRpc(), safeAddress, guardian, threshold);
}
