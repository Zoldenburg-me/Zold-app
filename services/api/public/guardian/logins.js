/**
 * The email and passkey logins for a Turnkey guardian, shared by /guardian
 * (adding one), /recovery (approving with one) and signup in /app.
 *
 * Email: Turnkey emails a code; the browser seals it to Turnkey's enclave
 * with a fresh key (`encryptOtpCodeToBundle`), so our API relays a bundle it
 * cannot read, and the verification token that comes back is bound to that
 * key. Logging in also needs the key's signature over the token's use, which
 * only this browser can make.
 *
 * Passkey: a new WebAuthn credential on this site; Turnkey checks its
 * attestation when the sub-org is made, and the passkey stamps its own
 * requests later. No DOM; scripts/turnkey-guardian-page-test.ts runs it.
 */
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TRANSPORTS = { internal: "INTERNAL", usb: "USB", nfc: "NFC", ble: "BLE", hybrid: "HYBRID" };

/** Turnkey emails a 6-digit code to `email`: {otpId, otpEncryptionTargetBundle}. */
export const sendEmailCode = (api, email) => api("/api/recovery/turnkey/email/code", { email });

/** The code the person typed, sealed in this browser, for a verification token. */
export async function emailCodeToToken({ api, stamper, encrypt, otp, code }) {
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6 digits from the email.");
  await stamper.init();
  await stamper.resetKeyPair();
  const publicKey = stamper.getPublicKey();
  if (!publicKey) throw new Error("This browser could not make a key; try another browser.");
  const encryptedOtpBundle = await encrypt(code, otp.otpEncryptionTargetBundle, publicKey);
  const { verificationToken } = await api("/api/recovery/turnkey/email/verify", { otpId: otp.otpId, encryptedOtpBundle });
  return verificationToken;
}

/**
 * The browser key's signature that turns a verification token into a login,
 * built as Turnkey's own SDK builds it (getClientSignatureMessageForLogin):
 * the JSON of {login: {publicKey}, tokenId, type}, in that key order, signed
 * raw (r||s hex) over its SHA-256.
 */
export async function emailLoginSignature(stamper, verificationToken) {
  const part = verificationToken.split(".")[1] || "";
  const { id, public_key: publicKey } = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
  if (!id || !publicKey) throw new Error("That code came back without a usable token. Start again.");
  const message = JSON.stringify({ login: { publicKey }, tokenId: id, type: "USAGE_TYPE_LOGIN" });
  return { publicKey, scheme: "CLIENT_SIGNATURE_SCHEME_API_P256", message, signature: await stamper.sign(message, "raw") };
}

/** A new passkey for the guardian: {challenge, attestation} in Turnkey's shape. */
export async function createGuardianPasskey({ credentials = navigator.credentials, rpId = location.hostname, random = (n) => crypto.getRandomValues(new Uint8Array(n)) } = {}) {
  const challenge = random(32);
  const cred = await credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: "Zold recovery" },
      user: { id: random(16), name: "Zold recovery passkey", displayName: "Zold recovery passkey" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 120_000,
    },
  });
  return {
    challenge: b64url(challenge),
    attestation: {
      credentialId: b64url(cred.rawId),
      clientDataJson: b64url(cred.response.clientDataJSON),
      attestationObject: b64url(cred.response.attestationObject),
      transports: (cred.response.getTransports?.() ?? []).filter((t) => TRANSPORTS[t]).map((t) => `AUTHENTICATOR_TRANSPORT_${TRANSPORTS[t]}`),
    },
  };
}

/** Which passkey the person picks, so the API can name its sub-org: one
 *  prompt over a random challenge that nothing else uses. */
export async function pickPasskey({ credentials = navigator.credentials, rpId = location.hostname, random = (n) => crypto.getRandomValues(new Uint8Array(n)) } = {}) {
  const cred = await credentials.get({ publicKey: { challenge: random(32), rpId, userVerification: "required", timeout: 120_000 } });
  return b64url(cred.rawId);
}
