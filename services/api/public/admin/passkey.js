/**
 * The operator's passkey in the browser: the WebAuthn calls and the
 * base64url conversions around them. First file: it calls nothing later.
 *
 * The server sends options with base64url strings; the browser wants
 * ArrayBuffers, and answers with ArrayBuffers the server wants as base64url.
 */

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const credentialList = (list) => (list || []).map((c) => ({ type: 'public-key', id: b64urlToBytes(c.id) }));

/** Creates a passkey from the server's creation options. */
async function createOperatorPasskey(o) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(o.challenge),
      rp: o.rp,
      user: { id: b64urlToBytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: credentialList(o.excludeCredentials),
      timeout: o.timeout,
      attestation: 'none',
    },
  });
  if (!cred) throw new Error('No passkey was created.');
  return {
    attestationObject: bytesToB64url(cred.response.attestationObject),
    clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
  };
}

/** Signs a challenge with one of the passkeys the server offers. */
async function assertOperatorPasskey(o) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(o.challenge),
      rpId: o.rpId,
      allowCredentials: credentialList(o.allowCredentials),
      userVerification: 'required',
      timeout: o.timeout,
    },
  });
  if (!cred) throw new Error('No passkey answered.');
  return {
    credentialId: bytesToB64url(cred.rawId),
    authenticatorData: bytesToB64url(cred.response.authenticatorData),
    clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
    signature: bytesToB64url(cred.response.signature),
  };
}
