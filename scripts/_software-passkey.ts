/**
 * A software P-256 passkey for offline tests: a "none" attestation to
 * register with, and assertions signed with WebCrypto. RP id "localhost";
 * the origin is the caller's (it must be in WEBAUTHN_ORIGINS, which
 * _test-env.ts sets for the harness ports).
 *
 * The same helper is written out inside several older suites
 * (zoldenburg-recovery-test.ts among them); new suites import this one.
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Minimal CBOR: unsigned/negative ints, byte and text strings, maps. */
function enc(v: any): Buffer {
  const head = (major: number, len: number) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(len, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(enc(k), enc(val));
    return Buffer.concat(parts);
  }
  throw new Error("enc: unsupported");
}

/** WebCrypto signs P1363 (r||s); WebAuthn wants DER. */
function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

export async function makeSoftwarePasskey(label: string, origin: string) {
  const clientData = (type: string, challenge: string) => b64url(Buffer.from(JSON.stringify({ type, challenge, origin }), "utf8"));
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = enc(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
  const credId = Buffer.from(`${label}-${randomBytes(4).toString("hex")}`);
  const authData = (flags: number, count: number, includeAttestation = false) => {
    const base = Buffer.alloc(37);
    sha256("localhost").copy(base, 0);
    base[32] = flags;
    base.writeUInt32BE(count, 33);
    if (!includeAttestation) return base;
    const cred = Buffer.alloc(18 + credId.length);
    cred.writeUInt16BE(credId.length, 16);
    credId.copy(cred, 18);
    return Buffer.concat([base, cred, cose]);
  };
  let count = 0;
  return {
    credentialId: b64url(credId),
    jwk,
    register: (challenge: string) => ({
      credentialId: b64url(credId),
      attestation: b64url(enc(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, 0, true)]]))),
      clientDataJSON: clientData("webauthn.create", challenge),
    }),
    assert: async (challenge: string) => {
      count += 1;
      const clientDataJSON = clientData("webauthn.get", challenge);
      const authenticatorData = authData(0x05, count);
      const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([authenticatorData, sha256(unb64url(clientDataJSON))])));
      return { credentialId: b64url(credId), authenticatorData: b64url(authenticatorData), clientDataJSON, signature: b64url(rawToDer(raw)) };
    },
  };
}
