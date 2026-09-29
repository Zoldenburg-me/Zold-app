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
import {
  CANDIDE,
  deployWebAuthnVerifierTransaction,
  isDeployed,
  passkeyAccountAddress,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "../wallet/candide.js";

type NewPasskey = NonNullable<NonNullable<RecoveryRequest["candide"]>["newPasskey"]>;

const relayChain = () => ({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CANDIDE.rpcUrl] } },
});

/** The deployer key, on the smart-account chain. It pays gas for calls anyone
 *  may make (a verifier deployment, a signed recovery, a finalisation); it
 *  holds no authority over any Safe. */
export function relayWallet() {
  return createWalletClient({
    account: privateKeyToAccount(KEYS.deployer),
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
 * the deployer key, on the app chain — skipped (and said so) when the
 * smart-account chain is not the app chain, which only happens locally.
 */
export async function deployVerifierForOwner(owner: { x: bigint; y: bigint }): Promise<string | undefined> {
  if (HARNESS.enabled) return undefined;
  if (BigInt(CHAIN_ID) !== BigInt(CANDIDE.chainId)) return undefined;
  const verifier = passkeyAccountAddress(owner);
  if (await isDeployed(verifier)) return undefined;
  const tx = deployWebAuthnVerifierTransaction(owner);
  return relayWallet().sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value });
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
  for (const s of store.sessions) {
    if (s.userId === user.id && !s.revokedAt) store.revokeSession(s.id);
  }
  return updated;
}
