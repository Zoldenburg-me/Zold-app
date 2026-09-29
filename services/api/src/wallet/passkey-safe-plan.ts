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

export function passkeySafeChallenge(challenge: `0x${string}`): string {
  return bufToB64url(Buffer.from(challenge.slice(2), "hex"));
}
