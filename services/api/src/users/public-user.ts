/**
 * The account projection sent to the browser.
 *
 * THE ALLOWLIST IS THE POINT. Every key sent, nested keys included, is named
 * here, so a field added to User later is not published by accident.
 */
import { capabilitiesFor } from "../domain/segments.js";
import { connectionMethod, publicApiKeys } from "../adapters/monerium-connection.js";
import { maskTarget } from "../recovery/candide-guardian.js";
import { zoldenburgArmed } from "../recovery/enrolment-key.js";
import { issueSession } from "../http/sessions.js";
import { reportedBic } from "../sepa.js";
import type { User } from "../store.js";
import { carriesMoneriumIdentity } from "../domain/monerium-identity.js";
import { moneriumVerifiedName, personKey } from "./verified-name.js";

/** The named keys of `obj` that are set, and nothing else. */
function pick<T extends object, K extends keyof T>(obj: T | undefined, keys: readonly K[]): Pick<T, K> | undefined {
  if (!obj) return undefined;
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** The account fields sent as they are stored. Everything else is either
 *  projected below or not sent at all. */
const TOP_LEVEL = [
  "id", "name", "email", "country", "kycStatus", "iban", "ibanSince", "emailVerifiedAt", "address",
  "authorizerAddress", "citizenships", "accountType", "companyIncorporationCountry", "handle",
  "payDisplayName", "autoConvert", "createdAt",
] as const satisfies readonly (keyof User)[];

function nameVerifiedByMonerium(u: User): boolean {
  const verified = moneriumVerifiedName(u);
  return verified !== undefined && personKey(verified) === personKey(u.name ?? "");
}

/** The Safe plan, recovery channel targets masked. */
function publicPasskeySafe(plan: NonNullable<User["passkeySafe"]>) {
  return {
    ...pick(plan, ["address", "status", "threshold", "passkeyPublicKey", "createdAt", "previousAddress", "recoveredAt", "importedAt"] as const),
    ...(plan.recovery
      ? { recovery: pick(plan.recovery, ["moduleAddress", "guardianAddress", "threshold", "status", "enabledAt", "opHash"] as const) }
      : {}),
    ...(plan.recoveryChoice ? { recoveryChoice: pick(plan.recoveryChoice, ["choice", "at"] as const) } : {}),
    ...(plan.candideRecovery
      ? {
          candideRecovery: {
            ...pick(plan.candideRecovery, ["moduleAddress", "guardianAddress", "guardianStatus", "guardianOpHash", "activatedAt"] as const),
            channels: plan.candideRecovery.channels.map((c) => ({
              registrationId: c.registrationId,
              channel: c.channel,
              target: maskTarget(c.channel, c.target),
              verifiedAt: c.verifiedAt,
            })),
          },
        }
      : {}),
  };
}

/**
 * The account as the browser (and the admin user list) sees it.
 *
 * Payment-page deposit keys, OAuth state, the email code and Monerium tokens
 * are never in it. Every key and every nested key is named here, so a field
 * added to User later is not published until someone adds it on purpose.
 */
export const publicUser = (u: User) => ({
  ...pick(u, TOP_LEVEL),
  ...(u.kyc ? { kyc: pick(u.kyc, ["provider", "onboardingPath", "applicantId", "checkedAt", "reason"] as const) } : {}),
  ...(u.wallet ? { wallet: pick(u.wallet, ["type", "deployed", "deployOpHash"] as const) } : {}),
  ...(u.faucet ? { faucet: pick(u.faucet, ["grantedEur", "txHash", "at"] as const) } : {}),
  ...(u.funding ? { funding: pick(u.funding, ["mode", "status", "moneriumProfileId", "detail", "addressUnlinkable"] as const) } : {}),
  ...(u.softSignals
    ? { softSignals: pick(u.softSignals, ["usPhoneCode", "usMailingAddress", "usIpAtSignup", "flaggedAt", "reconfirmationPending"] as const) }
    : {}),
  ...(u.gnosisPay
    ? { gnosisPay: pick(u.gnosisPay, ["connectedAddress", "userId", "safeAddress", "kycStatus", "accountStatus", "cardCount", "asOf"] as const) }
    : {}),
  ...(u.moneriumRefusal ? { moneriumRefusal: pick(u.moneriumRefusal, ["code", "error", "at"] as const) } : {}),
  ...(u.moneriumIbanMoves
    ? {
        moneriumIbanMoves: u.moneriumIbanMoves.map((m) =>
          pick(m, ["iban", "profileId", "fromAddress", "fromChain", "toAddress", "toChain", "requestedAt", "confirmedAt"] as const),
        ),
      }
    : {}),
  ...(u.privacyBundle
    ? {
        privacyBundle: {
          ...pick(u.privacyBundle, ["planId", "status", "startedAt", "renewsAt", "canceledAt"] as const),
          ...(u.privacyBundle.esim ? { esim: pick(u.privacyBundle.esim, ["provider", "status", "dataGb", "region"] as const) } : {}),
          ...(u.privacyBundle.vpn ? { vpn: pick(u.privacyBundle.vpn, ["provider", "status", "bandwidthGb", "devices"] as const) } : {}),
          usage: pick(u.privacyBundle.usage, ["esimGb", "vpnGb", "periodStartedAt"] as const),
        },
      }
    : {}),
  // Whether replacing the Monerium connection needs the passkey: the app asks
  // for it up front rather than after a 401 (routes/monerium.ts
  // approvesMoneriumChange).
  moneriumChangeNeedsPasskey: carriesMoneriumIdentity(u),
  // Whether Monerium reported this same name for the account. The name is
  // locked at approval either way; only this says it was checked.
  nameVerified: nameVerifiedByMonerium(u),
  // Whether the 1 € enrolment armed Zoldenburg as guardian. The enrolled
  // account itself (HMAC, last 4) is only on the recovery screen.
  zoldenburgArmed: zoldenburgArmed(u),
  // The BIC Monerium listed for this IBAN, and only for this IBAN: one read
  // before a move belongs to the old IBAN and is not sent.
  ...(reportedBic(u) ? { bic: reportedBic(u) } : {}),
  // Consent rows written before Sep 2026 carry the caller's IP. It is never
  // sent: the admin user list renders this same projection for every account.
  ...(u.consents ? { consents: u.consents.map((c) => pick(c, ["kind", "partner", "version", "at"] as const)) } : {}),
  // Recovery channel targets are masked on every surface, this one included:
  // the raw phone number and email exist to receive codes, not to be read
  // back by whoever holds a session.
  ...(u.passkeySafe ? { passkeySafe: publicPasskeySafe(u.passkeySafe) } : {}),
  ...(u.segment
    ? {
        segment: {
          value: u.segment.value,
          capabilities: capabilitiesFor(u.segment.value),
          ...(u.segment.gate ? { gate: pick(u.segment.gate, ["reason", "needs"] as const) } : {}),
        },
      }
    : {}),
  ...(u.paymentPage
    ? {
        paymentPage: {
          handle: u.paymentPage!.handle,
          displayName: u.paymentPage!.displayName,
          depositAddress: u.paymentPage!.depositAddress,
          recipientAddress: u.paymentPage!.recipientAddress,
          forwarder: u.paymentPage!.forwarder
            ? {
                provider: u.paymentPage!.forwarder.provider,
                destinationChainId: u.paymentPage!.forwarder.destinationChainId,
                sourceChainIds: u.paymentPage!.forwarder.sourceChainIds,
                active: u.paymentPage!.forwarder.active,
                expiresAt: u.paymentPage!.forwarder.expiresAt,
              }
            : undefined,
          supportedTokens: u.paymentPage!.supportedTokens,
          settlementAsset: u.paymentPage!.settlementAsset,
          autoConvert: u.paymentPage!.autoConvert,
          createdAt: u.paymentPage!.createdAt,
          updatedAt: u.paymentPage!.updatedAt,
        },
      }
    : {}),
  ...(u.passkey
    ? {
        passkey: {
          credentialId: u.passkey!.credentialId,
          rpId: u.passkey!.rpId,
          createdAt: u.passkey!.createdAt,
        },
      }
    : {}),
  ...(u.monerium
    ? {
        monerium: {
          connectedAt: u.monerium!.connectedAt,
          method: connectionMethod(u) ?? undefined,
          profileId: u.monerium!.profileId,
          // Which Monerium login this is: the user's own email, shown back to them.
          accountEmail: u.monerium!.accountEmail ?? u.monerium!.apiKeys?.accountEmail,
          profiles: u.monerium!.profiles,
          ibans: u.monerium!.ibans,
          addresses: u.monerium!.addresses,
          // Client id, environment and when it was verified. Never the secret,
          // and never its ciphertext.
          ...(u.monerium!.apiKeys ? { apiKeys: publicApiKeys(u.monerium!.apiKeys) } : {}),
        },
      }
    : {}),
});
export const withSession = (user: User) => ({ ...publicUser(user), sessionToken: issueSession(user.id) });
