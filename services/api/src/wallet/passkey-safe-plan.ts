/**
 * The counterfactual passkey Safe: what its address and owner set would be for
 * a given credential, and what changes when it is actually deployed.
 *
 * Pure derivation — no chain reads, no store writes — which is why it sits
 * beside the Candide wrapper rather than inside a route. The plan is recorded
 * on the user before deployment so the address money can reach is known before
 * a UserOperation exists.
 */
import type { User } from "../store.js";
import { bufToB64url } from "../webauthn.js";
import {
  smartAccountForPasskey,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "./candide.js";

export function passkeySafePlan(
  user: User,
  publicKey: NonNullable<NonNullable<User["passkey"]>["publicKey"]>,
): User["passkeySafe"] | undefined {
  if (!publicKey || publicKey.alg !== "ES256") return undefined;
  const owner = webauthnOwnerFromJwk(publicKey.jwk);
  if (!owner) return undefined;
  // The passkey is the ONLY owner: nothing Zold holds can take part in, or
  // block, a movement of the user's funds.
  const account = smartAccountForPasskey(owner);
  return {
    address: account.accountAddress as `0x${string}`,
    status: "planned",
    threshold: 1,
    // No allowance module, no delegate, no spend amounts: nothing moves from
    // the Safe except UserOperations the user's own passkey signs.
    passkeyPublicKey: webauthnOwnerToStore(owner),
    // No recovery guardian: adding Zoldenburg is the user's choice, made after
    // deployment with its own passkey-signed operation (recovery-zoldenburg.ts).
    createdAt: new Date().toISOString(),
    previousAddress: user.address,
  };
}

export function activatePasskeySafePlan(plan: NonNullable<User["passkeySafe"]>): User["passkeySafe"] {
  return {
    ...plan,
    status: "active",
    ...(plan.recovery
      ? {
          recovery: {
            ...plan.recovery,
            status: "active",
            enabledAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

/** Whether this user's debit is a Safe operation their own passkey signs: an
 *  active passkey Safe that is the account's address. */
export function signsSafeDebit(
  user: User,
): user is User & { passkey: NonNullable<User["passkey"]>; passkeySafe: NonNullable<User["passkeySafe"]> } {
  return (
    !!user.passkey?.credentialId &&
    user.passkeySafe?.status === "active" &&
    user.address.toLowerCase() === user.passkeySafe.address.toLowerCase()
  );
}

/**
 * Why a bank run of `lines` payees cannot be sent as one run, or null.
 *
 * Each line's fee debit is its own Safe operation, and draft execution
 * prepares them all before the first is signed: every one would carry the
 * Safe's next nonce, so only the first could execute and the later payees
 * would not be paid. With no fee, or one under half a cent (a quote rounds it
 * away), there is no Safe debit and nothing to refuse.
 */
export function sharedNonceRunProblem(user: User, lines: number, feeEur: number): string | null {
  if (lines < 2 || !(Math.round(feeEur * 100) > 0) || !signsSafeDebit(user)) return null;
  return `Each bank transfer carries a €${feeEur} fee that is signed on its own, so a payment with a fee is sent to one payee at a time. Save each payee as its own payment.`;
}

export function passkeySafeChallenge(challenge: `0x${string}`): string {
  return bufToB64url(Buffer.from(challenge.slice(2), "hex"));
}
