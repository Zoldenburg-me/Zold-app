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
  CANDIDE,
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
  // The passkey is the ONLY owner. A Zold co-signer as second owner (2-of-2)
  // was retired: it could not start a debit, but it meant the user could not
  // move their own funds without Zold's counter-signature.
  const account = smartAccountForPasskey(owner);
  const recoveryGuardianAddress = /^0x[0-9a-fA-F]{40}$/.test(CANDIDE.recoveryGuardianAddress)
    ? (CANDIDE.recoveryGuardianAddress as `0x${string}`)
    : undefined;
  return {
    address: account.accountAddress as `0x${string}`,
    status: "planned",
    threshold: 1,
    // No allowance module, no delegate, no spend amounts: nothing moves from
    // the Safe except UserOperations the user's own passkey signs.
    passkeyPublicKey: webauthnOwnerToStore(owner),
    ...(recoveryGuardianAddress
      ? {
          recovery: {
            moduleAddress: CANDIDE.recoveryModuleAddress,
            guardianAddress: recoveryGuardianAddress,
            threshold: 1,
            status: "planned",
          },
        }
      : {}),
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
