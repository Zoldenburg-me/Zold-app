/**
 * What every recovery does once the chain agrees: the new passkey becomes the
 * account's credential. Shared by the Candide (email/SMS) and Zoldenburg
 * (operator-signed) guardians, so the two cannot drift on what "recovered"
 * means — in particular that every old session dies with the old device.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, HARNESS, KEYS } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { revokeOtherSessions } from "../http/sessions.js";
import {
  CANDIDE,
  deployWebAuthnVerifierTransaction,
  isDeployed,
  passkeyAccountAddress,
  webauthnOwnerFromJwk,
  webauthnOwnerFromStore,
  webauthnOwnerToStore,
} from "../wallet/candide.js";
import { describeCause } from "../http/log-cause.js";

type NewPasskey = NonNullable<NonNullable<RecoveryRequest["candide"]>["newPasskey"]>;

const relayChain = () => ({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CANDIDE.rpcUrl] } },
});

/** The relay key (`RELAY_KEY`), on the smart-account chain. It pays gas for
 *  calls anyone may make (a verifier deployment, a signed recovery, a
 *  finalisation); it holds no authority over any contract or Safe. */
export function relayWallet() {
  return createWalletClient({
    account: privateKeyToAccount(KEYS.relay),
    chain: relayChain(),
    transport: http(CANDIDE.rpcUrl),
  });
}

export function relayReader() {
  return createPublicClient({ chain: relayChain(), transport: http(CANDIDE.rpcUrl) });
}

/**
 * Deploy the new passkey's signer verifier so the recovered Safe's owner is
 * a contract that can validate signatures. Permissionless factory call from
 * the relay key, on the app chain — skipped (and said so) when the
 * smart-account chain is not the app chain, which only happens locally.
 */
export interface VerifierChain {
  enabled(): boolean;
  isDeployed(address: string): Promise<boolean>;
  send(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<`0x${string}`>;
  /** Resolves "success" or "reverted"; rejects when the wait times out. */
  receipt(hash: `0x${string}`): Promise<string>;
}

const VERIFIER_RECEIPT_TIMEOUT_MS = 120_000;
const chainIo: VerifierChain = {
  enabled: () => !HARNESS.enabled && BigInt(CHAIN_ID) === BigInt(CANDIDE.chainId),
  isDeployed,
  send: (tx) => relayWallet().sendTransaction(tx),
  receipt: async (hash) =>
    (await relayReader().waitForTransactionReceipt({ hash, timeout: VERIFIER_RECEIPT_TIMEOUT_MS })).status,
};

/** Verifiers with a deploy sent and not yet answered: one send each, from any path. */
const inFlight = new Map<string, Promise<string>>();

export async function deployVerifierForOwner(owner: { x: bigint; y: bigint }, io: VerifierChain = chainIo): Promise<string | undefined> {
  if (!io.enabled()) return undefined;
  const verifier = passkeyAccountAddress(owner).toLowerCase();
  if (inFlight.has(verifier)) return undefined;
  if (await io.isDeployed(verifier)) return undefined;
  if (inFlight.has(verifier)) return undefined; // another path sent it during the read
  const tx = deployWebAuthnVerifierTransaction(owner);
  const sending = io.send({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value });
  // Held until the chain answers or the wait times out, so a dropped tx is retried by a later sweep.
  const answered = sending.then((hash) => io.receipt(hash));
  inFlight.set(verifier, answered);
  answered.catch(() => {}).finally(() => inFlight.delete(verifier));
  return sending;
}

/** Sent is not deployed: a revert or a dropped tx leaves the Safe's owner without code. */
async function confirmVerifier(owner: { x: bigint; y: bigint }, hash: string, io: VerifierChain): Promise<void> {
  const verifier = passkeyAccountAddress(owner);
  const status = await (inFlight.get(verifier.toLowerCase()) ?? io.receipt(hash as `0x${string}`));
  if (status !== "success" || !(await io.isDeployed(verifier))) {
    throw new Error(`verifier ${verifier} deploy ${hash} did not leave code at the address`);
  }
}

let sweeping = false;

/**
 * Deploy the verifier of every recovered or imported Safe whose owner has no
 * code yet: a deploy that failed at recovery time would otherwise make every
 * signature fail (AA24) forever. Permissionless; the relay key pays gas. Only
 * here does anything wait for the receipt: nobody is waiting on the sweep.
 */
export async function sweepMissingVerifiers(users: User[] = store.users, io: VerifierChain = chainIo): Promise<number> {
  if (sweeping) return 0; // the last run is still waiting on a receipt
  sweeping = true;
  let deployed = 0;
  try {
    for (const u of users) {
      const plan = u.passkeySafe;
      if (plan?.status !== "active" || (!plan.recoveredAt && !plan.importedAt)) continue;
      const owner = webauthnOwnerFromStore(plan.passkeyPublicKey);
      try {
        const hash = await deployVerifierForOwner(owner, io);
        if (!hash) continue;
        await confirmVerifier(owner, hash, io);
        deployed++;
        console.log(`verifier sweep: deployed ${passkeyAccountAddress(owner)} for Safe ${plan.address} (${hash})`);
      } catch (err) {
        console.error(`verifier sweep: Safe ${plan.address}: ${describeCause(err)}`);
      }
    }
  } finally {
    sweeping = false;
  }
  return deployed;
}

/**
 * The chain says the new passkey owns the Safe: bind it to the account, drop
 * the lost device's spending key (only the CURRENT authorizer may rotate it,
 * and that device is gone) and revoke every session the old device held.
 * Callers check the chain first; this function trusts them.
 */
export function bindRecoveredPasskey(user: User, np: NewPasskey, now: Date): User {
  const owner = webauthnOwnerFromJwk(np.publicKey.jwk)!;
  const updated = store.updateUser(user.id, {
    passkey: {
      credentialId: np.credentialId,
      publicKey: np.publicKey,
      signCount: np.signCount,
      rpId: np.rpId,
      attestation: np.attestation,
      createdAt: np.createdAt,
    },
    passkeySafe: {
      ...user.passkeySafe!,
      passkeyPublicKey: webauthnOwnerToStore(owner),
      recoveredAt: now.toISOString(),
      threshold: 1 as const,
    },
    authorizerAddress: undefined,
  });
  revokeOtherSessions(user.id);
  return updated;
}
