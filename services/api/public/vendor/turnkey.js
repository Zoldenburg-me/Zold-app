/*! Zold vendor bundle: @turnkey/indexed-db-stamper@1.3.11, esbuild 0.28.1. Built by scripts/build-turnkey-bundle.ts; do not edit. */
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@turnkey/encoding/dist/hex.mjs
function uint8ArrayToHexString(input) {
  return input.reduce((result, x) => result + x.toString(16).padStart(2, "0"), "");
}

// node_modules/@turnkey/encoding/dist/base64.mjs
function stringToBase64urlString(input) {
  const base64String = btoa(input);
  return base64StringToBase64UrlEncodedString(base64String);
}
function base64StringToBase64UrlEncodedString(input) {
  return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function btoa(s) {
  if (arguments.length === 0) {
    throw new TypeError("1 argument required, but only 0 present.");
  }
  let i;
  s = `${s}`;
  for (i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) {
      throw new Error(`InvalidCharacterError: found code point greater than 255:${s.charCodeAt(i)} at position ${i}`);
    }
  }
  let out = "";
  for (i = 0; i < s.length; i += 3) {
    const groupsOfSix = [
      void 0,
      void 0,
      void 0,
      void 0
    ];
    groupsOfSix[0] = s.charCodeAt(i) >> 2;
    groupsOfSix[1] = (s.charCodeAt(i) & 3) << 4;
    if (s.length > i + 1) {
      groupsOfSix[1] |= s.charCodeAt(i + 1) >> 4;
      groupsOfSix[2] = (s.charCodeAt(i + 1) & 15) << 2;
    }
    if (s.length > i + 2) {
      groupsOfSix[2] |= s.charCodeAt(i + 2) >> 6;
      groupsOfSix[3] = s.charCodeAt(i + 2) & 63;
    }
    for (let j = 0; j < groupsOfSix.length; j++) {
      if (typeof groupsOfSix[j] === "undefined") {
        out += "=";
      } else {
        out += btoaLookup(groupsOfSix[j]);
      }
    }
  }
  return out;
}
function btoaLookup(index) {
  const keystr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (index >= 0 && index < 64) {
    return keystr[index];
  }
  return void 0;
}

// node_modules/@turnkey/encoding/dist/encode.mjs
function pointEncode(raw) {
  if (raw.length !== 65 || raw[0] !== 4) {
    throw new Error("Invalid uncompressed P-256 key");
  }
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid x or y length");
  }
  const prefix = (y[31] & 1) === 0 ? 2 : 3;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

// node_modules/bs58/src/esm/index.js
var esm_exports = {};
__export(esm_exports, {
  default: () => esm_default2
});

// node_modules/base-x/src/esm/index.js
function base(ALPHABET2) {
  if (ALPHABET2.length >= 255) {
    throw new TypeError("Alphabet too long");
  }
  const BASE_MAP = new Uint8Array(256);
  for (let j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (let i = 0; i < ALPHABET2.length; i++) {
    const x = ALPHABET2.charAt(i);
    const xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) {
      throw new TypeError(x + " is ambiguous");
    }
    BASE_MAP[xc] = i;
  }
  const BASE = ALPHABET2.length;
  const LEADER = ALPHABET2.charAt(0);
  const FACTOR = Math.log(BASE) / Math.log(256);
  const iFACTOR = Math.log(256) / Math.log(BASE);
  function encode(source) {
    if (source instanceof Uint8Array) {
    } else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source);
    }
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    if (source.length === 0) {
      return "";
    }
    let zeroes = 0;
    let length = 0;
    let pbegin = 0;
    const pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    const size = (pend - pbegin) * iFACTOR + 1 >>> 0;
    const b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      let carry = source[pbegin];
      let i = 0;
      for (let it1 = size - 1; (carry !== 0 || i < length) && it1 !== -1; it1--, i++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length = i;
      pbegin++;
    }
    let it2 = size - length;
    while (it2 !== size && b58[it2] === 0) {
      it2++;
    }
    let str = LEADER.repeat(zeroes);
    for (; it2 < size; ++it2) {
      str += ALPHABET2.charAt(b58[it2]);
    }
    return str;
  }
  function decodeUnsafe(source) {
    if (typeof source !== "string") {
      throw new TypeError("Expected String");
    }
    if (source.length === 0) {
      return new Uint8Array();
    }
    let psz = 0;
    let zeroes = 0;
    let length = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    const size = (source.length - psz) * FACTOR + 1 >>> 0;
    const b256 = new Uint8Array(size);
    while (psz < source.length) {
      const charCode = source.charCodeAt(psz);
      if (charCode > 255) {
        return;
      }
      let carry = BASE_MAP[charCode];
      if (carry === 255) {
        return;
      }
      let i = 0;
      for (let it3 = size - 1; (carry !== 0 || i < length) && it3 !== -1; it3--, i++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length = i;
      psz++;
    }
    let it4 = size - length;
    while (it4 !== size && b256[it4] === 0) {
      it4++;
    }
    const vch = new Uint8Array(zeroes + (size - it4));
    let j = zeroes;
    while (it4 !== size) {
      vch[j++] = b256[it4++];
    }
    return vch;
  }
  function decode(string) {
    const buffer = decodeUnsafe(string);
    if (buffer) {
      return buffer;
    }
    throw new Error("Non-base" + BASE + " character");
  }
  return {
    encode,
    decodeUnsafe,
    decode
  };
}
var esm_default = base;

// node_modules/bs58/src/esm/index.js
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var esm_default2 = esm_default(ALPHABET);

// node_modules/@turnkey/encoding/dist/bs58.mjs
function unwrap(obj) {
  let cur = obj;
  while (cur && !(cur.encode && cur.decode && cur.decodeUnsafe) && cur.default) {
    cur = cur.default;
  }
  return cur;
}
var bs58 = unwrap(esm_exports);

// node_modules/bs58check/src/esm/index.js
var esm_exports2 = {};
__export(esm_exports2, {
  default: () => esm_default3
});

// node_modules/@noble/hashes/esm/_assert.js
function isBytes(a) {
  return a instanceof Uint8Array || a != null && typeof a === "object" && a.constructor.name === "Uint8Array";
}
function bytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error(`Uint8Array expected of length ${lengths}, not of length=${b.length}`);
}
function exists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function output(out, instance) {
  bytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error(`digestInto() expects output buffer of length at least ${min}`);
  }
}

// node_modules/@noble/hashes/esm/utils.js
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
var rotr = (word, shift) => word << 32 - shift | word >>> shift;
var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  bytes(data);
  return data;
}
var Hash = class {
  // Safe version that clones internal state
  clone() {
    return this._cloneInto();
  }
};
var toStr = {}.toString;
function wrapConstructor(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

// node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
var Chi = (a, b, c) => a & b ^ ~a & c;
var Maj = (a, b, c) => a & b ^ a & c ^ b & c;
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    super();
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    exists(this);
    const { view, buffer, blockLen } = this;
    data = toBytes(data);
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    exists(this);
    output(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    this.buffer.subarray(pos).fill(0);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.length = length;
    to.pos = pos;
    to.finished = finished;
    to.destroyed = destroyed;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
};

// node_modules/@noble/hashes/esm/sha256.js
var SHA256_K = /* @__PURE__ */ new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_IV = /* @__PURE__ */ new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor() {
    super(64, 32, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    SHA256_W.fill(0);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    this.buffer.fill(0);
  }
};
var sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

// node_modules/bs58check/src/esm/base.js
function base_default(checksumFn) {
  function encode(payload) {
    var payloadU8 = Uint8Array.from(payload);
    var checksum = checksumFn(payloadU8);
    var length = payloadU8.length + 4;
    var both = new Uint8Array(length);
    both.set(payloadU8, 0);
    both.set(checksum.subarray(0, 4), payloadU8.length);
    return esm_default2.encode(both);
  }
  function decodeRaw(buffer) {
    var payload = buffer.slice(0, -4);
    var checksum = buffer.slice(-4);
    var newChecksum = checksumFn(payload);
    if (checksum[0] ^ newChecksum[0] | checksum[1] ^ newChecksum[1] | checksum[2] ^ newChecksum[2] | checksum[3] ^ newChecksum[3])
      return;
    return payload;
  }
  function decodeUnsafe(str) {
    var buffer = esm_default2.decodeUnsafe(str);
    if (buffer == null)
      return;
    return decodeRaw(buffer);
  }
  function decode(str) {
    var buffer = esm_default2.decode(str);
    var payload = decodeRaw(buffer);
    if (payload == null)
      throw new Error("Invalid checksum");
    return payload;
  }
  return {
    encode,
    decode,
    decodeUnsafe
  };
}

// node_modules/bs58check/src/esm/index.js
function sha256x2(buffer) {
  return sha256(sha256(buffer));
}
var esm_default3 = base_default(sha256x2);

// node_modules/@turnkey/encoding/dist/bs58check.mjs
function unwrap2(obj) {
  let cur = obj;
  while (cur && !(cur.encode && cur.decode && cur.decodeUnsafe) && cur.default) {
    cur = cur.default;
  }
  return cur;
}
var bs58check = unwrap2(esm_exports2);

// node_modules/@turnkey/sdk-types/dist/index.mjs
var SessionType;
(function(SessionType2) {
  SessionType2["READ_ONLY"] = "SESSION_TYPE_READ_ONLY";
  SessionType2["READ_WRITE"] = "SESSION_TYPE_READ_WRITE";
})(SessionType || (SessionType = {}));
var AuthAction;
(function(AuthAction2) {
  AuthAction2["LOGIN"] = "LOGIN";
  AuthAction2["SIGNUP"] = "SIGNUP";
})(AuthAction || (AuthAction = {}));
var TurnkeyErrorCodes;
(function(TurnkeyErrorCodes2) {
  TurnkeyErrorCodes2["UNKNOWN"] = "UNKNOWN";
  TurnkeyErrorCodes2["NETWORK_ERROR"] = "NETWORK_ERROR";
  TurnkeyErrorCodes2["KEY_PAIR_CLEANUP_ERROR"] = "KEY_PAIR_CLEANUP_ERROR";
  TurnkeyErrorCodes2["LOGOUT_ERROR"] = "LOGOUT_ERROR";
  TurnkeyErrorCodes2["CREATE_PASSKEY_ERROR"] = "CREATE_PASSKEY_ERROR";
  TurnkeyErrorCodes2["SELECT_PASSKEY_CANCELLED"] = "SELECT_PASSKEY_CANCELLED";
  TurnkeyErrorCodes2["CONNECT_WALLET_CANCELLED"] = "CONNECT_WALLET_CANCELLED";
  TurnkeyErrorCodes2["WALLET_CONNECT_INITIALIZATION_ERROR"] = "WALLET_CONNECT_INITIALIZATION_ERROR";
  TurnkeyErrorCodes2["WALLET_CONNECT_EXPIRED"] = "WALLET_CONNECT_EXPIRED";
  TurnkeyErrorCodes2["PASSKEY_SIGNUP_AUTH_ERROR"] = "PASSKEY_SIGNUP_AUTH_ERROR";
  TurnkeyErrorCodes2["PASSKEY_LOGIN_AUTH_ERROR"] = "PASSKEY_LOGIN_AUTH_ERROR";
  TurnkeyErrorCodes2["WALLET_BUILD_LOGIN_REQUEST_ERROR"] = "WALLET_BUILD_LOGIN_REQUEST_ERROR";
  TurnkeyErrorCodes2["WALLET_LOGIN_AUTH_ERROR"] = "WALLET_LOGIN_AUTH_ERROR";
  TurnkeyErrorCodes2["WALLET_SIGNUP_AUTH_ERROR"] = "WALLET_SIGNUP_AUTH_ERROR";
  TurnkeyErrorCodes2["WALLET_LOGIN_OR_SIGNUP_ERROR"] = "WALLET_LOGIN_OR_SIGNUP_ERROR";
  TurnkeyErrorCodes2["INIT_OTP_ERROR"] = "INIT_OTP_ERROR";
  TurnkeyErrorCodes2["VERIFY_OTP_ERROR"] = "VERIFY_OTP_ERROR";
  TurnkeyErrorCodes2["OTP_LOGIN_ERROR"] = "OTP_LOGIN_ERROR";
  TurnkeyErrorCodes2["OTP_SIGNUP_ERROR"] = "OTP_SIGNUP_ERROR";
  TurnkeyErrorCodes2["OTP_COMPLETION_ERROR"] = "OTP_COMPLETION_ERROR";
  TurnkeyErrorCodes2["OAUTH_LOGIN_ERROR"] = "OAUTH_LOGIN_ERROR";
  TurnkeyErrorCodes2["OAUTH_SIGNUP_ERROR"] = "OAUTH_SIGNUP_ERROR";
  TurnkeyErrorCodes2["ACCOUNT_FETCH_ERROR"] = "ACCOUNT_FETCH_ERROR";
  TurnkeyErrorCodes2["INVALID_OTP_CODE"] = "INVALID_OTP_CODE";
  TurnkeyErrorCodes2["FETCH_WALLETS_ERROR"] = "FETCH_WALLETS_ERROR";
  TurnkeyErrorCodes2["FETCH_WALLET_ACCOUNTS_ERROR"] = "FETCH_WALLET_ACCOUNTS_ERROR";
  TurnkeyErrorCodes2["FETCH_PRIVATE_KEYS_ERROR"] = "FETCH_PRIVATE_KEYS_ERROR";
  TurnkeyErrorCodes2["SIGN_MESSAGE_ERROR"] = "SIGN_MESSAGE_ERROR";
  TurnkeyErrorCodes2["SIGN_TRANSACTION_ERROR"] = "SIGN_TRANSACTION_ERROR";
  TurnkeyErrorCodes2["POLL_TRANSACTION_STATUS_ERROR"] = "POLL_TRANSACTION_STATUS_ERROR";
  TurnkeyErrorCodes2["SIGN_AND_SEND_TRANSACTION_ERROR"] = "SIGN_AND_SEND_TRANSACTION_ERROR";
  TurnkeyErrorCodes2["ETH_SEND_TRANSACTION_ERROR"] = "ETH_SEND_TRANSACTION_ERROR";
  TurnkeyErrorCodes2["SOL_SEND_TRANSACTION_ERROR"] = "SOL_SEND_TRANSACTION_ERROR";
  TurnkeyErrorCodes2["FETCH_USER_ERROR"] = "FETCH_USERS_ERROR";
  TurnkeyErrorCodes2["CREATE_WALLET_ERROR"] = "CREATE_WALLET_ERROR";
  TurnkeyErrorCodes2["CREATE_WALLET_ACCOUNT_ERROR"] = "CREATE_WALLET_ACCOUNT_ERROR";
  TurnkeyErrorCodes2["EXPORT_WALLET_ERROR"] = "EXPORT_WALLET_ERROR";
  TurnkeyErrorCodes2["EXPORT_PRIVATE_KEY_ERROR"] = "EXPORT_PRIVATE_KEY_ERROR";
  TurnkeyErrorCodes2["EXPORT_WALLET_ACCOUNT_ERROR"] = "EXPORT_WALLET_ACCOUNT_ERROR";
  TurnkeyErrorCodes2["IMPORT_WALLET_ERROR"] = "IMPORT_WALLET_ERROR";
  TurnkeyErrorCodes2["IMPORT_SECRET_ERROR"] = "IMPORT_SECRET_ERROR";
  TurnkeyErrorCodes2["EXPORT_SECRET_ERROR"] = "EXPORT_SECRET_ERROR";
  TurnkeyErrorCodes2["EXPORT_SECRET_CONSENSUS_NEEDED"] = "EXPORT_SECRET_CONSENSUS_NEEDED";
  TurnkeyErrorCodes2["DELETE_SUB_ORGANIZATION_ERROR"] = "DELETE_SUB_ORGANIZATION_ERROR";
  TurnkeyErrorCodes2["CREATE_SUB_ORGANIZATION_ERROR"] = "CREATE_SUB_ORGANIZATION_ERROR";
  TurnkeyErrorCodes2["CREATE_USERS_ERROR"] = "CREATE_USERS_ERROR";
  TurnkeyErrorCodes2["FETCH_BOOT_PROOF_ERROR"] = "FETCH_BOOT_PROOF_ERROR";
  TurnkeyErrorCodes2["VERIFY_APP_PROOFS_ERROR"] = "VERIFY_APP_PROOFS_ERROR";
  TurnkeyErrorCodes2["CREATE_POLICY_ERROR"] = "CREATE_POLICY_ERROR";
  TurnkeyErrorCodes2["STORE_SESSION_ERROR"] = "STORE_SESSION_ERROR";
  TurnkeyErrorCodes2["CLEAR_SESSION_ERROR"] = "CLEAR_SESSION_ERROR";
  TurnkeyErrorCodes2["CLEAR_ALL_SESSIONS_ERROR"] = "CLEAR_ALL_SESSIONS_ERROR";
  TurnkeyErrorCodes2["REFRESH_SESSION_ERROR"] = "REFRESH_SESSION_ERROR";
  TurnkeyErrorCodes2["GET_SESSION_ERROR"] = "GET_SESSION_ERROR";
  TurnkeyErrorCodes2["GET_WALLET_PROVIDERS_ERROR"] = "GET_WALLET_PROVIDERS_ERROR";
  TurnkeyErrorCodes2["GET_ALL_SESSIONS_ERROR"] = "GET_ALL_SESSIONS_ERROR";
  TurnkeyErrorCodes2["SET_ACTIVE_SESSION_ERROR"] = "SET_ACTIVE_SESSION_ERROR";
  TurnkeyErrorCodes2["GET_ACTIVE_SESSION_KEY_ERROR"] = "GET_ACTIVE_SESSION_KEY_ERROR";
  TurnkeyErrorCodes2["CLEAR_UNUSED_KEY_PAIRS_ERROR"] = "CLEAR_UNUSED_KEY_PAIRS_ERROR";
  TurnkeyErrorCodes2["CREATE_API_KEY_PAIR_ERROR"] = "CREATE_API_KEY_PAIR_ERROR";
  TurnkeyErrorCodes2["API_KEY_STORAGE_UNAVAILABLE"] = "API_KEY_STORAGE_UNAVAILABLE";
  TurnkeyErrorCodes2["DELETE_API_KEY_PAIR_ERROR"] = "DELETE_API_KEY_PAIR_ERROR";
  TurnkeyErrorCodes2["GET_PROXY_AUTH_CONFIG_ERROR"] = "GET_PROXY_AUTH_CONFIG_ERROR";
  TurnkeyErrorCodes2["UPDATE_USER_EMAIL_ERROR"] = "UPDATE_USER_EMAIL_ERROR";
  TurnkeyErrorCodes2["UPDATE_USER_NAME_ERROR"] = "UPDATE_USER_NAME_ERROR";
  TurnkeyErrorCodes2["UPDATE_USER_PHONE_NUMBER_ERROR"] = "UPDATE_USER_PHONE_NUMBER_ERROR";
  TurnkeyErrorCodes2["ADD_OAUTH_PROVIDER_ERROR"] = "ADD_OAUTH_PROVIDER_ERROR";
  TurnkeyErrorCodes2["REMOVE_OAUTH_PROVIDER_ERROR"] = "REMOVE_OAUTH_PROVIDER_ERROR";
  TurnkeyErrorCodes2["ADD_PASSKEY_ERROR"] = "ADD_PASSKEY_ERROR";
  TurnkeyErrorCodes2["REMOVE_PASSKEY_ERROR"] = "REMOVE_PASSKEY_ERROR";
  TurnkeyErrorCodes2["CONNECT_WALLET_ACCOUNT_ERROR"] = "CONNECT_WALLET_ACCOUNT_ERROR";
  TurnkeyErrorCodes2["DISCONNECT_WALLET_ACCOUNT_ERROR"] = "DISCONNECT_WALLET_ACCOUNT_ERROR";
  TurnkeyErrorCodes2["SWITCH_WALLET_CHAIN_ERROR"] = "SWITCH_WALLET_CHAIN_ERROR";
  TurnkeyErrorCodes2["ONRAMP_ERROR"] = "ONRAMP_ERROR";
  TurnkeyErrorCodes2["MAX_OTP_INITIATED_ERROR"] = "MAX_OTP_INITIATED_ERROR";
  TurnkeyErrorCodes2["CLIENT_NOT_INITIALIZED"] = "CLIENT_NOT_INITIALIZED";
  TurnkeyErrorCodes2["WALLET_MANAGER_COMPONENT_NOT_INITIALIZED"] = "WALLET_MANAGER_COMPONENT_NOT_INITIALIZED";
  TurnkeyErrorCodes2["CONFIG_NOT_INITIALIZED"] = "CONFIG_NOT_INITIALIZED";
  TurnkeyErrorCodes2["AUTH_METHOD_NOT_ENABLED"] = "AUTH_METHOD_NOT_ENABLED";
  TurnkeyErrorCodes2["FEATURE_NOT_ENABLED"] = "FEATURE_NOT_ENABLED";
  TurnkeyErrorCodes2["INITIALIZE_CLIENT_ERROR"] = "INITIALIZE_CLIENT_ERROR";
  TurnkeyErrorCodes2["INITIALIZE_SESSION_ERROR"] = "INITIALIZE_SESSION_ERROR";
  TurnkeyErrorCodes2["SCHEDULE_SESSION_EXPIRY_ERROR"] = "SCHEDULE_SESSION_EXPIRY_ERROR";
  TurnkeyErrorCodes2["HANDLE_POST_AUTH_ERROR"] = "HANDLE_POST_AUTH_ERROR";
  TurnkeyErrorCodes2["HANDLE_POST_LOGOUT_ERROR"] = "HANDLE_POST_LOGOUT_ERROR";
  TurnkeyErrorCodes2["CLEAR_SESSION_TIMEOUTS_ERROR"] = "CLEAR_SESSION_TIMEOUTS_ERROR";
  TurnkeyErrorCodes2["UPDATE_USER_ERROR"] = "UPDATE_USER_ERROR";
  TurnkeyErrorCodes2["ACCOUNT_ALREADY_EXISTS"] = "ACCOUNT_ALREADY_EXISTS";
  TurnkeyErrorCodes2["INITIALIZE_IFRAME_ERROR"] = "INITIALIZE_IFRAME_ERROR";
  TurnkeyErrorCodes2["PLATFORM_MISMATCH"] = "PLATFORM_MISMATCH";
  TurnkeyErrorCodes2["UNSUPPORTED_PLATFORM"] = "UNSUPPORTED_PLATFORM";
  TurnkeyErrorCodes2["INITIALIZE_API_KEY_STAMPER_ERROR"] = "INITIALIZE_API_KEY_STAMPER_ERROR";
  TurnkeyErrorCodes2["INITIALIZE_PASSKEY_STAMPER_ERROR"] = "INITIALIZE_PASSKEY_STAMPER_ERROR";
  TurnkeyErrorCodes2["INITIALIZE_WALLET_MANAGER_ERROR"] = "INITIALIZE_WALLET_MANAGER_ERROR";
  TurnkeyErrorCodes2["USER_CANCELED"] = "USER_CANCELED";
  TurnkeyErrorCodes2["BAD_RESPONSE"] = "BAD_RESPONSE";
  TurnkeyErrorCodes2["OIDC_TOKEN_ERROR"] = "OIDC_TOKEN_ERROR";
  TurnkeyErrorCodes2["MISSING_PARAMS"] = "MISSING_PARAMS";
  TurnkeyErrorCodes2["INVALID_CONFIGURATION"] = "INVALID_CONFIGURATION";
  TurnkeyErrorCodes2["INVALID_REQUEST"] = "INVALID_REQUEST";
  TurnkeyErrorCodes2["VALIDATION_ERROR"] = "VALIDATION_ERROR";
  TurnkeyErrorCodes2["SESSION_EXPIRED"] = "SESSION_EXPIRED";
  TurnkeyErrorCodes2["NO_SESSION_FOUND"] = "NO_SESSION_FOUND";
  TurnkeyErrorCodes2["NO_WALLET_FOUND"] = "NO_WALLET_FOUND";
  TurnkeyErrorCodes2["NO_WALLETS_FOUND"] = "NO_WALLETS_FOUND";
  TurnkeyErrorCodes2["NO_PKCE_VERIFIER_FOUND"] = "NO_PKCE_VERIFIER_FOUND";
  TurnkeyErrorCodes2["INVALID_OAUTH_STATE"] = "INVALID_OAUTH_STATE";
  TurnkeyErrorCodes2["NOT_FOUND"] = "NOT_FOUND";
  TurnkeyErrorCodes2["INTERNAL_ERROR"] = "INTERNAL_ERROR";
  TurnkeyErrorCodes2["UNAUTHORIZED"] = "UNAUTHORIZED";
  TurnkeyErrorCodes2["FORBIDDEN"] = "FORBIDDEN";
  TurnkeyErrorCodes2["BAD_REQUEST"] = "BAD_REQUEST";
  TurnkeyErrorCodes2["CONFLICT"] = "CONFLICT";
  TurnkeyErrorCodes2["TIMEOUT"] = "TIMEOUT";
  TurnkeyErrorCodes2["SERVICE_UNAVAILABLE"] = "SERVICE_UNAVAILABLE";
  TurnkeyErrorCodes2["GATEWAY_TIMEOUT"] = "GATEWAY_TIMEOUT";
})(TurnkeyErrorCodes || (TurnkeyErrorCodes = {}));
var FiatOnRampProvider;
(function(FiatOnRampProvider2) {
  FiatOnRampProvider2["COINBASE"] = "FIAT_ON_RAMP_PROVIDER_COINBASE";
  FiatOnRampProvider2["MOONPAY"] = "FIAT_ON_RAMP_PROVIDER_MOONPAY";
})(FiatOnRampProvider || (FiatOnRampProvider = {}));
var FiatOnRampCryptoCurrency;
(function(FiatOnRampCryptoCurrency2) {
  FiatOnRampCryptoCurrency2["BITCOIN"] = "FIAT_ON_RAMP_CRYPTO_CURRENCY_BTC";
  FiatOnRampCryptoCurrency2["ETHEREUM"] = "FIAT_ON_RAMP_CRYPTO_CURRENCY_ETH";
  FiatOnRampCryptoCurrency2["SOLANA"] = "FIAT_ON_RAMP_CRYPTO_CURRENCY_SOL";
  FiatOnRampCryptoCurrency2["USDC"] = "FIAT_ON_RAMP_CRYPTO_CURRENCY_USDC";
})(FiatOnRampCryptoCurrency || (FiatOnRampCryptoCurrency = {}));
var FiatOnRampCurrency;
(function(FiatOnRampCurrency2) {
  FiatOnRampCurrency2["AUD"] = "FIAT_ON_RAMP_CURRENCY_AUD";
  FiatOnRampCurrency2["BGN"] = "FIAT_ON_RAMP_CURRENCY_BGN";
  FiatOnRampCurrency2["BRL"] = "FIAT_ON_RAMP_CURRENCY_BRL";
  FiatOnRampCurrency2["CAD"] = "FIAT_ON_RAMP_CURRENCY_CAD";
  FiatOnRampCurrency2["CHF"] = "FIAT_ON_RAMP_CURRENCY_CHF";
  FiatOnRampCurrency2["COP"] = "FIAT_ON_RAMP_CURRENCY_COP";
  FiatOnRampCurrency2["CZK"] = "FIAT_ON_RAMP_CURRENCY_CZK";
  FiatOnRampCurrency2["DKK"] = "FIAT_ON_RAMP_CURRENCY_DKK";
  FiatOnRampCurrency2["DOP"] = "FIAT_ON_RAMP_CURRENCY_DOP";
  FiatOnRampCurrency2["EGP"] = "FIAT_ON_RAMP_CURRENCY_EGP";
  FiatOnRampCurrency2["EUR"] = "FIAT_ON_RAMP_CURRENCY_EUR";
  FiatOnRampCurrency2["GBP"] = "FIAT_ON_RAMP_CURRENCY_GBP";
  FiatOnRampCurrency2["HKD"] = "FIAT_ON_RAMP_CURRENCY_HKD";
  FiatOnRampCurrency2["IDR"] = "FIAT_ON_RAMP_CURRENCY_IDR";
  FiatOnRampCurrency2["ILS"] = "FIAT_ON_RAMP_CURRENCY_ILS";
  FiatOnRampCurrency2["JOD"] = "FIAT_ON_RAMP_CURRENCY_JOD";
  FiatOnRampCurrency2["KES"] = "FIAT_ON_RAMP_CURRENCY_KES";
  FiatOnRampCurrency2["KWD"] = "FIAT_ON_RAMP_CURRENCY_KWD";
  FiatOnRampCurrency2["LKR"] = "FIAT_ON_RAMP_CURRENCY_LKR";
  FiatOnRampCurrency2["MXN"] = "FIAT_ON_RAMP_CURRENCY_MXN";
  FiatOnRampCurrency2["NGN"] = "FIAT_ON_RAMP_CURRENCY_NGN";
  FiatOnRampCurrency2["NOK"] = "FIAT_ON_RAMP_CURRENCY_NOK";
  FiatOnRampCurrency2["NZD"] = "FIAT_ON_RAMP_CURRENCY_NZD";
  FiatOnRampCurrency2["OMR"] = "FIAT_ON_RAMP_CURRENCY_OMR";
  FiatOnRampCurrency2["PEN"] = "FIAT_ON_RAMP_CURRENCY_PEN";
  FiatOnRampCurrency2["PLN"] = "FIAT_ON_RAMP_CURRENCY_PLN";
  FiatOnRampCurrency2["RON"] = "FIAT_ON_RAMP_CURRENCY_RON";
  FiatOnRampCurrency2["SEK"] = "FIAT_ON_RAMP_CURRENCY_SEK";
  FiatOnRampCurrency2["THB"] = "FIAT_ON_RAMP_CURRENCY_THB";
  FiatOnRampCurrency2["TRY"] = "FIAT_ON_RAMP_CURRENCY_TRY";
  FiatOnRampCurrency2["TWD"] = "FIAT_ON_RAMP_CURRENCY_TWD";
  FiatOnRampCurrency2["USD"] = "FIAT_ON_RAMP_CURRENCY_USD";
  FiatOnRampCurrency2["VND"] = "FIAT_ON_RAMP_CURRENCY_VND";
  FiatOnRampCurrency2["ZAR"] = "FIAT_ON_RAMP_CURRENCY_ZAR";
})(FiatOnRampCurrency || (FiatOnRampCurrency = {}));
var FiatOnRampBlockchainNetwork;
(function(FiatOnRampBlockchainNetwork2) {
  FiatOnRampBlockchainNetwork2["BITCOIN"] = "FIAT_ON_RAMP_BLOCKCHAIN_NETWORK_BITCOIN";
  FiatOnRampBlockchainNetwork2["ETHEREUM"] = "FIAT_ON_RAMP_BLOCKCHAIN_NETWORK_ETHEREUM";
  FiatOnRampBlockchainNetwork2["SOLANA"] = "FIAT_ON_RAMP_BLOCKCHAIN_NETWORK_SOLANA";
  FiatOnRampBlockchainNetwork2["BASE"] = "FIAT_ON_RAMP_BLOCKCHAIN_NETWORK_BASE";
})(FiatOnRampBlockchainNetwork || (FiatOnRampBlockchainNetwork = {}));
var FiatOnRampPaymentMethod;
(function(FiatOnRampPaymentMethod2) {
  FiatOnRampPaymentMethod2["CREDIT_DEBIT_CARD"] = "FIAT_ON_RAMP_PAYMENT_METHOD_CREDIT_DEBIT_CARD";
  FiatOnRampPaymentMethod2["APPLE_PAY"] = "FIAT_ON_RAMP_PAYMENT_METHOD_APPLE_PAY";
  FiatOnRampPaymentMethod2["GBP_BANK_TRANSFER"] = "FIAT_ON_RAMP_PAYMENT_METHOD_GBP_BANK_TRANSFER";
  FiatOnRampPaymentMethod2["GBP_OPEN_BANKING_PAYMENT"] = "FIAT_ON_RAMP_PAYMENT_METHOD_GBP_OPEN_BANKING_PAYMENT";
  FiatOnRampPaymentMethod2["GOOGLE_PAY"] = "FIAT_ON_RAMP_PAYMENT_METHOD_GOOGLE_PAY";
  FiatOnRampPaymentMethod2["SEPA_BANK_TRANSFER"] = "FIAT_ON_RAMP_PAYMENT_METHOD_SEPA_BANK_TRANSFER";
  FiatOnRampPaymentMethod2["PIX_INSTANT_PAYMENT"] = "FIAT_ON_RAMP_PAYMENT_METHOD_PIX_INSTANT_PAYMENT";
  FiatOnRampPaymentMethod2["PAYPAL"] = "FIAT_ON_RAMP_PAYMENT_METHOD_PAYPAL";
  FiatOnRampPaymentMethod2["VENMO"] = "FIAT_ON_RAMP_PAYMENT_METHOD_VENMO";
  FiatOnRampPaymentMethod2["MOONPAY_BALANCE"] = "FIAT_ON_RAMP_PAYMENT_METHOD_MOONPAY_BALANCE";
  FiatOnRampPaymentMethod2["CRYPTO_ACCOUNT"] = "FIAT_ON_RAMP_PAYMENT_METHOD_CRYPTO_ACCOUNT";
  FiatOnRampPaymentMethod2["FIAT_WALLET"] = "FIAT_ON_RAMP_PAYMENT_METHOD_FIAT_WALLET";
  FiatOnRampPaymentMethod2["ACH_BANK_ACCOUNT"] = "FIAT_ON_RAMP_PAYMENT_METHOD_ACH_BANK_ACCOUNT";
})(FiatOnRampPaymentMethod || (FiatOnRampPaymentMethod = {}));
var SignatureFormat;
(function(SignatureFormat2) {
  SignatureFormat2["Der"] = "der";
  SignatureFormat2["Raw"] = "raw";
})(SignatureFormat || (SignatureFormat = {}));
var OAuthProviders;
(function(OAuthProviders2) {
  OAuthProviders2["DISCORD"] = "discord";
  OAuthProviders2["APPLE"] = "apple";
  OAuthProviders2["GOOGLE"] = "google";
  OAuthProviders2["FACEBOOK"] = "facebook";
  OAuthProviders2["X"] = "x";
})(OAuthProviders || (OAuthProviders = {}));
var ActivityStatus;
(function(ActivityStatus2) {
  ActivityStatus2["CREATED"] = "ACTIVITY_STATUS_CREATED";
  ActivityStatus2["PENDING"] = "ACTIVITY_STATUS_PENDING";
  ActivityStatus2["COMPLETED"] = "ACTIVITY_STATUS_COMPLETED";
  ActivityStatus2["FAILED"] = "ACTIVITY_STATUS_FAILED";
  ActivityStatus2["CONSENSUS_NEEDED"] = "ACTIVITY_STATUS_CONSENSUS_NEEDED";
  ActivityStatus2["REJECTED"] = "ACTIVITY_STATUS_REJECTED";
  ActivityStatus2["AUTHENTICATORS_NEEDED"] = "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED";
})(ActivityStatus || (ActivityStatus = {}));
var TERMINAL_ACTIVITY_STATUSES = [
  ActivityStatus.COMPLETED,
  ActivityStatus.FAILED,
  ActivityStatus.REJECTED,
  ActivityStatus.AUTHENTICATORS_NEEDED
];

// node_modules/@turnkey/indexed-db-stamper/dist/index.mjs
var DB_NAME = "TurnkeyStamperDB";
var DB_STORE = "KeyStore";
var DB_KEY = "turnkeyKeyPair";
var stampHeaderName = "X-Stamp";
function convertEcdsaIeee1363ToDer(ieee) {
  if (ieee.length % 2 != 0 || ieee.length == 0 || ieee.length > 132) {
    throw new Error("Invalid IEEE P1363 signature encoding. Length: " + ieee.length);
  }
  const r = toUnsignedBigNum(ieee.subarray(0, ieee.length / 2));
  const s = toUnsignedBigNum(ieee.subarray(ieee.length / 2, ieee.length));
  let offset = 0;
  const length = 1 + 1 + r.length + 1 + 1 + s.length;
  let der;
  if (length >= 128) {
    der = new Uint8Array(length + 3);
    der[offset++] = 48;
    der[offset++] = 128 + 1;
    der[offset++] = length;
  } else {
    der = new Uint8Array(length + 2);
    der[offset++] = 48;
    der[offset++] = length;
  }
  der[offset++] = 2;
  der[offset++] = r.length;
  der.set(r, offset);
  offset += r.length;
  der[offset++] = 2;
  der[offset++] = s.length;
  der.set(s, offset);
  return der;
}
function toUnsignedBigNum(bytes2) {
  let start = 0;
  while (start < bytes2.length && bytes2[start] == 0) {
    start++;
  }
  if (start == bytes2.length) {
    start = bytes2.length - 1;
  }
  let extraZero = 0;
  if ((bytes2[start] & 128) == 128) {
    extraZero = 1;
  }
  const res = new Uint8Array(bytes2.length - start + extraZero);
  res.set(bytes2.subarray(start), extraZero);
  return res;
}
var IndexedDbStamper = class {
  constructor() {
    this.publicKeyHex = null;
    this.privateKey = null;
    if (typeof window === "undefined") {
      throw new Error("IndexedDB is only available in the browser");
    }
  }
  async openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async storeKeyPair(publicKey, privateKey) {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.put(publicKey, `${DB_KEY}-pub`);
      store.put(privateKey, `${DB_KEY}-priv`);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async getStoredKeys() {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const getPub = store.get(`${DB_KEY}-pub`);
      const getPriv = store.get(`${DB_KEY}-priv`);
      let publicKey = null;
      let privateKey = null;
      getPub.onsuccess = () => publicKey = getPub.result || null;
      getPriv.onsuccess = () => privateKey = getPriv.result || null;
      tx.oncomplete = () => {
        db.close();
        resolve({ publicKey, privateKey });
      };
      tx.onerror = () => reject(tx.error);
    });
  }
  async init() {
    const { publicKey, privateKey } = await this.getStoredKeys();
    if (publicKey && privateKey) {
      this.publicKeyHex = publicKey;
      this.privateKey = privateKey;
    } else {
      await this.resetKeyPair();
    }
  }
  async resetKeyPair(externalKeyPair) {
    let privateKey;
    let publicKey;
    if (externalKeyPair) {
      const extractable = externalKeyPair.privateKey.extractable;
      if (extractable !== false) {
        throw new Error("Provided privateKey must be non-extractable.");
      }
      privateKey = externalKeyPair.privateKey;
      publicKey = externalKeyPair.publicKey;
    } else {
      const keyPair = await crypto.subtle.generateKey({
        name: "ECDSA",
        namedCurve: "P-256"
      }, false, ["sign", "verify"]);
      privateKey = keyPair.privateKey;
      publicKey = keyPair.publicKey;
    }
    const rawPubKey = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    const compressedPubKey = pointEncode(rawPubKey);
    const compressedHex = uint8ArrayToHexString(compressedPubKey);
    await this.storeKeyPair(compressedHex, privateKey);
    this.publicKeyHex = compressedHex;
    this.privateKey = privateKey;
  }
  getPublicKey() {
    return this.publicKeyHex;
  }
  async sign(payload, format = SignatureFormat.Der) {
    if (!this.privateKey) {
      throw new Error("Key not initialized. Call init() first.");
    }
    const encodedPayload = new TextEncoder().encode(payload);
    const signatureIeee1363 = new Uint8Array(await crypto.subtle.sign({
      name: "ECDSA",
      hash: { name: "SHA-256" }
    }, this.privateKey, encodedPayload));
    switch (format) {
      case SignatureFormat.Raw: {
        return uint8ArrayToHexString(signatureIeee1363);
      }
      case SignatureFormat.Der: {
        const signatureDer = convertEcdsaIeee1363ToDer(signatureIeee1363);
        return uint8ArrayToHexString(signatureDer);
      }
      default:
        throw new Error(`Unsupported signature format: ${format}`);
    }
  }
  async stamp(payload) {
    if (!this.publicKeyHex || !this.privateKey) {
      throw new Error("Key not initialized. Call init() first.");
    }
    const signature = await this.sign(payload);
    const stamp = {
      publicKey: this.publicKeyHex,
      scheme: "SIGNATURE_SCHEME_TK_API_P256",
      signature
    };
    return {
      stampHeaderName,
      stampHeaderValue: stringToBase64urlString(JSON.stringify(stamp))
    };
  }
  async clear() {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.delete(`${DB_KEY}-pub`);
      store.delete(`${DB_KEY}-priv`);
      tx.oncomplete = () => {
        db.close();
        this.publicKeyHex = null;
        this.privateKey = null;
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
};
export {
  IndexedDbStamper
};
