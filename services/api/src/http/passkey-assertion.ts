/**
 * Check a passkey approval of a prepared Safe operation before it goes to the
 * bundler. The chain verifies the signature anyway; checking here first means
 * a wrong or malformed approval is a 400/401 the browser can act on, not a
 * bundler rejection that reads as our failure (500). Same rule as transfer
 * execution: the challenge is the one handed out, user verification required.
 */
import type express from "express";
import { SECURITY } from "../config.js";
import { store, type User } from "../store.js";
import { verifyAssertionForChallenge } from "../webauthn.js";
import { redactedMessage } from "./log-cause.js";

export async function checkOpAssertion(
  user: User,
  body: unknown,
  challenge: string,
  res: express.Response,
): Promise<User | undefined> {
  const b = (body ?? {}) as Record<string, unknown>;
  const { authenticatorData, clientDataJSON, signature } = b;
  if (typeof authenticatorData !== "string" || typeof clientDataJSON !== "string" || typeof signature !== "string" ||
      !authenticatorData || !clientDataJSON || !signature) {
    res.status(400).json({ error: "authenticatorData, clientDataJSON and signature are required, as base64url strings" });
    return undefined;
  }
  const passkey = user.passkey;
  if (!passkey?.publicKey) {
    res.status(409).json({ error: "this account has no passkey to approve with" });
    return undefined;
  }
  try {
    const { signCount } = await verifyAssertionForChallenge(
      authenticatorData,
      clientDataJSON,
      signature,
      passkey.publicKey,
      passkey.signCount ?? 0,
      passkey.rpId ?? SECURITY.rpId,
      SECURITY.origins,
      challenge,
      true,
    );
    const updated = store.recordPasskeyUse(user.id, passkey.credentialId, signCount);
    if (!updated) throw new Error("this passkey is no longer the account's passkey");
    return updated;
  } catch (err: any) {
    res.status(401).json({ error: `That passkey approval did not check out (${redactedMessage(err, { keepHosts: true })}). Start again.`, code: "BAD_ASSERTION" });
    return undefined;
  }
}
