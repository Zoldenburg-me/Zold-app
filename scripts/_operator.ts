/**
 * An operator for the offline suites: a software passkey that builds the same
 * registration and assertion payloads a platform authenticator does, and a
 * kit that enrols it, signs in and approves each admin change over HTTP. The
 * server is not changed and has no test login: enrolment goes through the
 * host-side enrolment file, and every check (Access, challenge, origin, rpId,
 * user verification, sign counter, signature, binding) runs as usual.
 *
 * For a suite that starts the API as its own process, `dataDir` names that
 * process's store directory; the file is written here in the format of
 * services/api/src/operators/enrolment.ts, so this module never loads the
 * API's config into the suite.
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

function cbor(v: any): Buffer {
  const head = (major: number, len: number) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(cbor(k), cbor(val));
    return Buffer.concat(parts);
  }
  throw new Error("cbor: unsupported");
}

function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

const UP_UV = 0x01 | 0x04;

export class SoftPasskey {
  private counter = 0;
  private constructor(
    private keys: CryptoKeyPair,
    private pub: JsonWebKey,
    public readonly credentialId: string,
    /** The flags its assertions carry; a suite clears UV to test the refusal. */
    public flags = UP_UV,
  ) {}

  static async create(): Promise<SoftPasskey> {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    return new SoftPasskey(keys, pub, b64url(randomBytes(32)));
  }

  private authData(rpId: string, flags: number, attested: boolean): Buffer {
    const base = Buffer.alloc(37);
    sha256(rpId).copy(base, 0);
    base[32] = flags | (attested ? 0x40 : 0);
    base.writeUInt32BE(++this.counter, 33);
    if (!attested) return base;
    const id = fromB64url(this.credentialId);
    const cred = Buffer.alloc(18 + id.length);
    cred.writeUInt16BE(id.length, 16);
    id.copy(cred, 18);
    const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(this.pub.x!)], [-3, fromB64url(this.pub.y!)]]));
    return Buffer.concat([base, cred, cose]);
  }

  attest(challenge: string, origin: string, rpId: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const att = cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(rpId, UP_UV, true)]]));
    return { attestationObject: b64url(att), clientDataJSON: b64url(clientDataJSON) };
  }

  async assert(challenge: string, origin: string, rpId: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData(rpId, this.flags, false);
    const sig = Buffer.from(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    ));
    return {
      credentialId: this.credentialId,
      authenticatorData: b64url(authenticatorData),
      clientDataJSON: b64url(clientDataJSON),
      signature: b64url(rawToDer(sig)),
    };
  }
}

/** Writes an enrolment into a store directory, as `npm run operator:enrol` does. */
export function writeEnrolment(dataDir: string, name: string, email: string, ttlMs = 15 * 60_000): string {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path.join(dataDir, "operator-enrolment.json"), JSON.stringify({
    id: `enr_${randomBytes(8).toString("hex")}`,
    name,
    email: email.toLowerCase(),
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }), { mode: 0o600 });
  return token;
}

export interface OperatorKitOptions {
  /** The API's base, e.g. http://127.0.0.1:3000 */
  base: string;
  /** The admin origin the server verifies ceremonies against. */
  origin: string;
  rpId: string;
  dataDir: string;
  name?: string;
  email?: string;
  /** Sent as Cf-Access-Jwt-Assertion when the server expects Access. */
  accessJwt?: () => string;
}

export interface OperatorKit {
  passkey: SoftPasskey;
  sessionToken: string;
  operator: { id: string; name: string; email: string };
  headers(extra?: Record<string, string>): Record<string, string>;
  /** The step-up header for one change. */
  stepUp(method: string, path: string, body?: unknown): Promise<Record<string, string>>;
  /** An admin request as the operator; a change is approved first. */
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

async function json(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function operatorKit(o: OperatorKitOptions): Promise<OperatorKit> {
  const name = o.name ?? "Test Operator";
  const email = o.email ?? "operator@example.com";
  const access = (): Record<string, string> => (o.accessJwt ? { "cf-access-jwt-assertion": o.accessJwt() } : {});
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${o.base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: o.origin, ...access(), ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await json(res) };
  };
  const passkey = await SoftPasskey.create();
  const token = writeEnrolment(o.dataDir, name, email);
  const options = await post("/api/admin/auth/enrol/challenge", { token });
  if (options.status !== 200) throw new Error(`enrol challenge -> ${options.status}: ${JSON.stringify(options.body)}`);
  const enrolled = await post("/api/admin/auth/enrol", { token, label: "Soft key", ...passkey.attest(options.body.challenge, o.origin, o.rpId) });
  if (enrolled.status !== 200) throw new Error(`enrol -> ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);
  const sessionToken: string = enrolled.body.sessionToken;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${sessionToken}`, origin: o.origin, ...access(), ...extra });
  const stepUp = async (method: string, p: string, body?: unknown) => {
    const c = await post("/api/admin/auth/step-up/challenge", { method, path: p, body }, { authorization: `Bearer ${sessionToken}` });
    if (c.status !== 200) throw new Error(`step-up challenge -> ${c.status}: ${JSON.stringify(c.body)}`);
    const a = await passkey.assert(c.body.challenge, o.origin, o.rpId);
    return { "x-operator-step-up": Buffer.from(JSON.stringify(a)).toString("base64url") };
  };
  const call = async (method: string, p: string, body?: unknown) => {
    const isRead = method === "GET" || method === "HEAD";
    const extra = isRead ? {} : await stepUp(method, p.split("?")[0], body);
    const res = await fetch(`${o.base}${p}`, {
      method,
      headers: { ...headers(extra), ...(isRead ? {} : { "content-type": "application/json" }) },
      ...(isRead ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    return { status: res.status, body: await json(res) };
  };
  return { passkey, sessionToken, operator: enrolled.body.operator, headers, stepUp, call };
}
