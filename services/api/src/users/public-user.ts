/**
 * The account projection sent to the browser.
 *
 * THE ALLOWLIST IS THE POINT. Payment-page deposit keys, OAuth state and
 * encrypted Monerium tokens are stripped by destructuring them out of the row
 * first, so a field added to User later is not published by accident — it has
 * to be named here to be sent.
 */
import { capabilitiesFor } from "../domain/segments.js";
import { publicApiKeys } from "../adapters/monerium-connection.js";
import { maskTarget } from "../recovery/candide-guardian.js";
import { issueSession } from "../http/sessions.js";
import type { User } from "../store.js";

/** Never send payment-page deposit keys, OAuth state, or encrypted tokens to the client. */
export const publicUser = (
  { moneriumConnect, monerium, passkey, paymentPage, segment, usPersonAnswers, ...u }:
    User & { [k: string]: any },
) => ({
  ...u,
  // Recovery channel targets are masked on every surface, this one included:
  // the raw phone number and email exist to receive codes, not to be read
  // back by whoever holds a session.
  ...(u.passkeySafe?.candideRecovery
    ? {
        passkeySafe: {
          ...u.passkeySafe,
          candideRecovery: {
            ...u.passkeySafe.candideRecovery,
            channels: u.passkeySafe.candideRecovery.channels.map((c) => ({ ...c, target: maskTarget(c.channel, c.target) })),
          },
        },
      }
    : {}),
  /**
   * The client is told its capabilities, NOT the rule that produced them.
   *
   * `reasonCode` and the raw US answers are stripped: the first tells someone
   * which answer to change, and the second is theirs but has no business being
   * echoed back on every read. `gate` IS sent, because a gated segment must be
   * able to say what is missing.
   */
  ...(segment
    ? {
        segment: {
          value: segment.value,
          capabilities: capabilitiesFor(segment.value),
          ...(segment.gate ? { gate: segment.gate } : {}),
        },
      }
    : {}),
  ...(paymentPage
    ? {
        paymentPage: {
          handle: paymentPage.handle,
          displayName: paymentPage.displayName,
          depositAddress: paymentPage.depositAddress,
          recipientAddress: paymentPage.recipientAddress,
          forwarder: paymentPage.forwarder
            ? {
                provider: paymentPage.forwarder.provider,
                destinationChainId: paymentPage.forwarder.destinationChainId,
                sourceChainIds: paymentPage.forwarder.sourceChainIds,
                active: paymentPage.forwarder.active,
                expiresAt: paymentPage.forwarder.expiresAt,
              }
            : undefined,
          supportedTokens: paymentPage.supportedTokens,
          settlementAsset: paymentPage.settlementAsset,
          autoConvert: paymentPage.autoConvert,
          createdAt: paymentPage.createdAt,
          updatedAt: paymentPage.updatedAt,
        },
      }
    : {}),
  ...(passkey
    ? {
        passkey: {
          credentialId: passkey.credentialId,
          rpId: passkey.rpId,
          createdAt: passkey.createdAt,
        },
      }
    : {}),
  ...(monerium
    ? {
        monerium: {
          connectedAt: monerium.connectedAt,
          method: monerium.method ?? (monerium.accessTokenEnc ? "oauth" : undefined),
          profileId: monerium.profileId,
          profiles: monerium.profiles,
          ibans: monerium.ibans,
          addresses: monerium.addresses,
          // Client id, environment and when it was verified. Never the secret,
          // and never its ciphertext.
          ...(monerium.apiKeys ? { apiKeys: publicApiKeys(monerium.apiKeys) } : {}),
        },
      }
    : {}),
});
export const withSession = (user: User) => ({ ...publicUser(user), sessionToken: issueSession(user.id) });
