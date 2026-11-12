/*! Zold vendor bundle: @turnkey/indexed-db-stamper@1.3.11, @turnkey/webauthn-stamper@0.6.0, @turnkey/crypto@2.13.2, esbuild 0.28.1. Built by scripts/build-turnkey-bundle.ts; do not edit. */
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@turnkey/encoding/dist/hex.mjs
function uint8ArrayToHexString(input) {
  return input.reduce((result, x) => result + x.toString(16).padStart(2, "0"), "");
}
var uint8ArrayFromHexString = (hexString, length) => {
  const hexRegex = /^[0-9A-Fa-f]+$/;
  if (!hexString || hexString.length % 2 != 0 || !hexRegex.test(hexString)) {
    throw new Error(`cannot create uint8array from invalid hex string: "${hexString}"`);
  }
  const buffer = new Uint8Array(hexString.match(/../g).map((h) => parseInt(h, 16)));
  if (!length) {
    return buffer;
  }
  if (hexString.length / 2 > length) {
    throw new Error("hex value cannot fit in a buffer of " + length + " byte(s)");
  }
  let paddedBuffer = new Uint8Array(length);
  paddedBuffer.set(buffer, length - buffer.length);
  return paddedBuffer;
};
var normalizePadding = (byteArray, targetLength) => {
  const paddingLength = targetLength - byteArray.length;
  if (paddingLength > 0) {
    const padding = new Uint8Array(paddingLength).fill(0);
    return new Uint8Array([...padding, ...byteArray]);
  }
  if (paddingLength < 0) {
    const expectedZeroCount = paddingLength * -1;
    let zeroCount = 0;
    for (let i = 0; i < expectedZeroCount && i < byteArray.length; i++) {
      if (byteArray[i] === 0) {
        zeroCount++;
      }
    }
    if (zeroCount !== expectedZeroCount) {
      throw new Error(`invalid number of starting zeroes. Expected number of zeroes: ${expectedZeroCount}. Found: ${zeroCount}.`);
    }
    return byteArray.slice(expectedZeroCount, expectedZeroCount + targetLength);
  }
  return byteArray;
};

// node_modules/@turnkey/encoding/dist/base64.mjs
function stringToBase64urlString(input) {
  const base64String = btoa2(input);
  return base64StringToBase64UrlEncodedString(base64String);
}
function base64StringToBase64UrlEncodedString(input) {
  return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function btoa2(s) {
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
function setBigUint64(view, byteOffset, value, isLE3) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE3);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE3 ? 4 : 0;
  const l = isLE3 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE3);
  view.setUint32(byteOffset + l, wl, isLE3);
}
var Chi = (a, b, c) => a & b ^ ~a & c;
var Maj = (a, b, c) => a & b ^ a & c ^ b & c;
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE3) {
    super();
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE3;
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
    const { buffer, view, blockLen, isLE: isLE3 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    this.buffer.subarray(pos).fill(0);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE3);
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
      oview.setUint32(4 * i, state[i], isLE3);
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
      const sigma12 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma12 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma02 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma02 + Maj(A, B, C) | 0;
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

// node_modules/@turnkey/webauthn-stamper/dist/webauthn-json/base64url.mjs
function bufferToBase64url(buffer) {
  const byteView = new Uint8Array(buffer);
  let str = "";
  for (const charCode of byteView) {
    str += String.fromCharCode(charCode);
  }
  const base64String = btoa(str);
  const base64urlString = base64String.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return base64urlString;
}

// node_modules/@turnkey/webauthn-stamper/dist/webauthn-json/convert.mjs
var copyValue = "copy";
var convertValue = "convert";
function convert(conversionFn, schema, input) {
  if (schema === copyValue) {
    return input;
  }
  if (schema === convertValue) {
    return conversionFn(input);
  }
  if (schema instanceof Array) {
    return input.map((v) => convert(conversionFn, schema[0], v));
  }
  if (schema instanceof Object) {
    const output2 = {};
    for (const [key, schemaField] of Object.entries(schema)) {
      if (schemaField.derive) {
        const v = schemaField.derive(input);
        if (v !== void 0) {
          input[key] = v;
        }
      }
      if (!(key in input)) {
        if (schemaField.required) {
          throw new Error(`Missing key: ${key}`);
        }
        continue;
      }
      if (input[key] == null) {
        output2[key] = null;
        continue;
      }
      output2[key] = convert(conversionFn, schemaField.schema, input[key]);
    }
    return output2;
  }
}
function derived(schema, derive) {
  return {
    required: true,
    schema,
    derive
  };
}
function required(schema) {
  return {
    required: true,
    schema
  };
}
function optional(schema) {
  return {
    required: false,
    schema
  };
}

// node_modules/@turnkey/webauthn-stamper/dist/webauthn-json/schema.mjs
var simplifiedClientExtensionResultsSchema = {
  appid: optional(copyValue),
  appidExclude: optional(copyValue),
  credProps: optional(copyValue)
};
var publicKeyCredentialWithAssertion = {
  type: required(copyValue),
  id: required(copyValue),
  rawId: required(convertValue),
  authenticatorAttachment: optional(copyValue),
  response: required({
    clientDataJSON: required(convertValue),
    authenticatorData: required(convertValue),
    signature: required(convertValue),
    userHandle: required(convertValue)
  }),
  clientExtensionResults: derived(simplifiedClientExtensionResultsSchema, (pkc) => pkc.getClientExtensionResults())
};

// node_modules/@turnkey/webauthn-stamper/dist/webauthn-json/api.mjs
function getResponseToJSON(credential) {
  return convert(bufferToBase64url, publicKeyCredentialWithAssertion, credential);
}

// node_modules/@turnkey/webauthn-stamper/dist/webauthn-json/index.mjs
async function get(options) {
  const response = await navigator.credentials.get(options);
  response.toJSON = () => getResponseToJSON(response);
  return response;
}

// node_modules/sha256-uint8array/dist/sha256-uint8array.mjs
var K = [
  1116352408 | 0,
  1899447441 | 0,
  3049323471 | 0,
  3921009573 | 0,
  961987163 | 0,
  1508970993 | 0,
  2453635748 | 0,
  2870763221 | 0,
  3624381080 | 0,
  310598401 | 0,
  607225278 | 0,
  1426881987 | 0,
  1925078388 | 0,
  2162078206 | 0,
  2614888103 | 0,
  3248222580 | 0,
  3835390401 | 0,
  4022224774 | 0,
  264347078 | 0,
  604807628 | 0,
  770255983 | 0,
  1249150122 | 0,
  1555081692 | 0,
  1996064986 | 0,
  2554220882 | 0,
  2821834349 | 0,
  2952996808 | 0,
  3210313671 | 0,
  3336571891 | 0,
  3584528711 | 0,
  113926993 | 0,
  338241895 | 0,
  666307205 | 0,
  773529912 | 0,
  1294757372 | 0,
  1396182291 | 0,
  1695183700 | 0,
  1986661051 | 0,
  2177026350 | 0,
  2456956037 | 0,
  2730485921 | 0,
  2820302411 | 0,
  3259730800 | 0,
  3345764771 | 0,
  3516065817 | 0,
  3600352804 | 0,
  4094571909 | 0,
  275423344 | 0,
  430227734 | 0,
  506948616 | 0,
  659060556 | 0,
  883997877 | 0,
  958139571 | 0,
  1322822218 | 0,
  1537002063 | 0,
  1747873779 | 0,
  1955562222 | 0,
  2024104815 | 0,
  2227730452 | 0,
  2361852424 | 0,
  2428436474 | 0,
  2756734187 | 0,
  3204031479 | 0,
  3329325298 | 0
];
var algorithms = {
  sha256: 1
};
function createHash(algorithm) {
  if (algorithm && !algorithms[algorithm] && !algorithms[algorithm.toLowerCase()]) {
    throw new Error("Digest method not supported");
  }
  return new Hash2();
}
var Hash2 = class {
  constructor() {
    this.A = 1779033703 | 0;
    this.B = 3144134277 | 0;
    this.C = 1013904242 | 0;
    this.D = 2773480762 | 0;
    this.E = 1359893119 | 0;
    this.F = 2600822924 | 0;
    this.G = 528734635 | 0;
    this.H = 1541459225 | 0;
    this._size = 0;
    this._sp = 0;
    if (!sharedBuffer || sharedOffset >= 8e3) {
      sharedBuffer = new ArrayBuffer(
        8e3
        /* N.allocTotal */
      );
      sharedOffset = 0;
    }
    this._byte = new Uint8Array(
      sharedBuffer,
      sharedOffset,
      80
      /* N.allocBytes */
    );
    this._word = new Int32Array(
      sharedBuffer,
      sharedOffset,
      20
      /* N.allocWords */
    );
    sharedOffset += 80;
  }
  update(data) {
    if ("string" === typeof data) {
      return this._utf8(data);
    }
    if (data == null) {
      throw new TypeError("Invalid type: " + typeof data);
    }
    const byteOffset = data.byteOffset;
    const length = data.byteLength;
    let blocks = length / 64 | 0;
    let offset = 0;
    if (blocks && !(byteOffset & 3) && !(this._size % 64)) {
      const block = new Int32Array(
        data.buffer,
        byteOffset,
        blocks * 16
        /* N.inputWords */
      );
      while (blocks--) {
        this._int32(block, offset >> 2);
        offset += 64;
      }
      this._size += offset;
    }
    const BYTES_PER_ELEMENT = data.BYTES_PER_ELEMENT;
    if (BYTES_PER_ELEMENT !== 1 && data.buffer) {
      const rest = new Uint8Array(data.buffer, byteOffset + offset, length - offset);
      return this._uint8(rest);
    }
    if (offset === length)
      return this;
    return this._uint8(data, offset);
  }
  _uint8(data, offset) {
    const { _byte, _word } = this;
    const length = data.length;
    offset = offset | 0;
    while (offset < length) {
      const start = this._size % 64;
      let index = start;
      while (offset < length && index < 64) {
        _byte[index++] = data[offset++];
      }
      if (index >= 64) {
        this._int32(_word);
      }
      this._size += index - start;
    }
    return this;
  }
  _utf8(text) {
    const { _byte, _word } = this;
    const length = text.length;
    let surrogate = this._sp;
    for (let offset = 0; offset < length; ) {
      const start = this._size % 64;
      let index = start;
      while (offset < length && index < 64) {
        let code = text.charCodeAt(offset++) | 0;
        if (code < 128) {
          _byte[index++] = code;
        } else if (code < 2048) {
          _byte[index++] = 192 | code >>> 6;
          _byte[index++] = 128 | code & 63;
        } else if (code < 55296 || code > 57343) {
          _byte[index++] = 224 | code >>> 12;
          _byte[index++] = 128 | code >>> 6 & 63;
          _byte[index++] = 128 | code & 63;
        } else if (surrogate) {
          code = ((surrogate & 1023) << 10) + (code & 1023) + 65536;
          _byte[index++] = 240 | code >>> 18;
          _byte[index++] = 128 | code >>> 12 & 63;
          _byte[index++] = 128 | code >>> 6 & 63;
          _byte[index++] = 128 | code & 63;
          surrogate = 0;
        } else {
          surrogate = code;
        }
      }
      if (index >= 64) {
        this._int32(_word);
        _word[0] = _word[
          16
          /* N.inputWords */
        ];
      }
      this._size += index - start;
    }
    this._sp = surrogate;
    return this;
  }
  _int32(data, offset) {
    let { A, B, C, D, E, F, G, H } = this;
    let i = 0;
    offset = offset | 0;
    while (i < 16) {
      W[i++] = swap32(data[offset++]);
    }
    for (i = 16; i < 64; i++) {
      W[i] = gamma1(W[i - 2]) + W[i - 7] + gamma0(W[i - 15]) + W[i - 16] | 0;
    }
    for (i = 0; i < 64; i++) {
      const T1 = H + sigma1(E) + ch(E, F, G) + K[i] + W[i] | 0;
      const T2 = sigma0(A) + maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    this.A = A + this.A | 0;
    this.B = B + this.B | 0;
    this.C = C + this.C | 0;
    this.D = D + this.D | 0;
    this.E = E + this.E | 0;
    this.F = F + this.F | 0;
    this.G = G + this.G | 0;
    this.H = H + this.H | 0;
  }
  digest(encoding) {
    const { _byte, _word } = this;
    let i = this._size % 64 | 0;
    _byte[i++] = 128;
    while (i & 3) {
      _byte[i++] = 0;
    }
    i >>= 2;
    if (i > 14) {
      while (i < 16) {
        _word[i++] = 0;
      }
      i = 0;
      this._int32(_word);
    }
    while (i < 16) {
      _word[i++] = 0;
    }
    const bits64 = this._size * 8;
    const low32 = (bits64 & 4294967295) >>> 0;
    const high32 = (bits64 - low32) / 4294967296;
    if (high32)
      _word[
        14
        /* N.highIndex */
      ] = swap32(high32);
    if (low32)
      _word[
        15
        /* N.lowIndex */
      ] = swap32(low32);
    this._int32(_word);
    return encoding === "hex" ? this._hex() : this._bin();
  }
  _hex() {
    const { A, B, C, D, E, F, G, H } = this;
    return hex32(A) + hex32(B) + hex32(C) + hex32(D) + hex32(E) + hex32(F) + hex32(G) + hex32(H);
  }
  _bin() {
    const { A, B, C, D, E, F, G, H, _byte, _word } = this;
    _word[0] = swap32(A);
    _word[1] = swap32(B);
    _word[2] = swap32(C);
    _word[3] = swap32(D);
    _word[4] = swap32(E);
    _word[5] = swap32(F);
    _word[6] = swap32(G);
    _word[7] = swap32(H);
    return _byte.slice(0, 32);
  }
};
var W = new Int32Array(
  64
  /* N.workWords */
);
var sharedBuffer;
var sharedOffset = 0;
var hex32 = (num) => (num + 4294967296).toString(16).substr(-8);
var swapLE = ((c) => c << 24 & 4278190080 | c << 8 & 16711680 | c >> 8 & 65280 | c >> 24 & 255);
var swapBE = ((c) => c);
var swap32 = isBE() ? swapBE : swapLE;
var ch = (x, y, z) => z ^ x & (y ^ z);
var maj = (x, y, z) => x & y | z & (x | y);
var sigma0 = (x) => (x >>> 2 | x << 30) ^ (x >>> 13 | x << 19) ^ (x >>> 22 | x << 10);
var sigma1 = (x) => (x >>> 6 | x << 26) ^ (x >>> 11 | x << 21) ^ (x >>> 25 | x << 7);
var gamma0 = (x) => (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
var gamma1 = (x) => (x >>> 17 | x << 15) ^ (x >>> 19 | x << 13) ^ x >>> 10;
function isBE() {
  const buf = new Uint8Array(new Uint16Array([65279]).buffer);
  return buf[0] === 254;
}

// node_modules/@turnkey/webauthn-stamper/dist/index.mjs
var stampHeaderName2 = "X-Stamp-Webauthn";
var defaultTimeout = 5 * 60 * 1e3;
var defaultUserVerification = "preferred";
var WebauthnStamper = class {
  constructor(config) {
    this.rpId = config.rpId;
    this.timeout = config.timeout || defaultTimeout;
    this.userVerification = config.userVerification || defaultUserVerification;
    this.allowCredentials = config.allowCredentials || [];
  }
  async stamp(payload) {
    const challenge = getChallengeFromPayload(payload);
    const signingOptions = {
      publicKey: {
        rpId: this.rpId,
        challenge,
        allowCredentials: this.allowCredentials,
        timeout: this.timeout,
        userVerification: this.userVerification
      }
    };
    const clientGetResult = await get(signingOptions);
    const assertion = clientGetResult.toJSON();
    const stamp = {
      authenticatorData: assertion.response.authenticatorData,
      clientDataJson: assertion.response.clientDataJSON,
      credentialId: assertion.id,
      signature: assertion.response.signature
    };
    return {
      stampHeaderName: stampHeaderName2,
      stampHeaderValue: JSON.stringify(stamp)
    };
  }
};
function getChallengeFromPayload(payload) {
  const hexString = createHash().update(payload).digest("hex");
  return new TextEncoder().encode(hexString);
}

// node_modules/@turnkey/crypto/dist/constants.mjs
var SUITE_ID_1 = new Uint8Array([75, 69, 77, 0, 16]);
var SUITE_ID_2 = new Uint8Array([72, 80, 75, 69, 0, 16, 0, 1, 0, 2]);
var HPKE_VERSION = new Uint8Array([72, 80, 75, 69, 45, 118, 49]);
var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
var LABEL_EAE_PRK = new Uint8Array([101, 97, 101, 95, 112, 114, 107]);
var LABEL_SHARED_SECRET = new Uint8Array([
  115,
  104,
  97,
  114,
  101,
  100,
  95,
  115,
  101,
  99,
  114,
  101,
  116
]);
var AES_KEY_INFO = new Uint8Array([
  0,
  32,
  72,
  80,
  75,
  69,
  45,
  118,
  49,
  72,
  80,
  75,
  69,
  0,
  16,
  0,
  1,
  0,
  2,
  107,
  101,
  121,
  0,
  143,
  195,
  174,
  184,
  50,
  73,
  10,
  75,
  90,
  179,
  228,
  32,
  35,
  40,
  125,
  178,
  154,
  31,
  75,
  199,
  194,
  34,
  192,
  223,
  34,
  135,
  39,
  183,
  10,
  64,
  33,
  18,
  47,
  63,
  4,
  233,
  32,
  108,
  209,
  36,
  19,
  80,
  53,
  41,
  180,
  122,
  198,
  166,
  48,
  185,
  46,
  196,
  207,
  125,
  35,
  69,
  8,
  208,
  175,
  151,
  113,
  201,
  158,
  80
]);
var IV_INFO = new Uint8Array([
  0,
  12,
  72,
  80,
  75,
  69,
  45,
  118,
  49,
  72,
  80,
  75,
  69,
  0,
  16,
  0,
  1,
  0,
  2,
  98,
  97,
  115,
  101,
  95,
  110,
  111,
  110,
  99,
  101,
  0,
  143,
  195,
  174,
  184,
  50,
  73,
  10,
  75,
  90,
  179,
  228,
  32,
  35,
  40,
  125,
  178,
  154,
  31,
  75,
  199,
  194,
  34,
  192,
  223,
  34,
  135,
  39,
  183,
  10,
  64,
  33,
  18,
  47,
  63,
  4,
  233,
  32,
  108,
  209,
  36,
  19,
  80,
  53,
  41,
  180,
  122,
  198,
  166,
  48,
  185,
  46,
  196,
  207,
  125,
  35,
  69,
  8,
  208,
  175,
  151,
  113,
  201,
  158,
  80
]);
var QOS_ENCRYPTION_HMAC_MESSAGE = new Uint8Array([
  113,
  111,
  115,
  95,
  101,
  110,
  99,
  114,
  121,
  112,
  116,
  105,
  111,
  110,
  95,
  104,
  109,
  97,
  99,
  95,
  109,
  101,
  115,
  115,
  97,
  103,
  101
]);
var PRODUCTION_SIGNER_SIGN_PUBLIC_KEY = "04cf288fe433cc4e1aa0ce1632feac4ea26bf2f5a09dcfe5a42c398e06898710330f0572882f4dbdf0f5304b8fc8703acd69adca9a4bbf7f5d00d20a5e364b2569";
var PRODUCTION_TLS_FETCHER_SIGN_PUBLIC_KEY = "046b4f88421f76b6ba418afc2ea1d8ced671337d7db6b80478a60d8531bf8f17fa9a512f0fef96fc0c9b4cd9dff70b34992e520ce04c79d931f6ff6296b547d201";

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/crypto.js
var crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/utils.js
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes2(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr2(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function utf8ToBytes2(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes2(data) {
  if (typeof data === "string")
    data = utf8ToBytes2(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var Hash3 = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/abstract/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes2(item) {
  if (!isBytes3(item))
    throw new Error("Uint8Array expected");
}
function abool(title, value) {
  if (typeof value !== "boolean")
    throw new Error(title + " boolean expected, got " + value);
}
function numberToHexUnpadded(num) {
  const hex = num.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
var hasHexBuiltin = (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
);
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes2) {
  abytes2(bytes2);
  if (hasHexBuiltin)
    return bytes2.toHex();
  let hex = "";
  for (let i = 0; i < bytes2.length; i++) {
    hex += hexes[bytes2[i]];
  }
  return hex;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch2) {
  if (ch2 >= asciis._0 && ch2 <= asciis._9)
    return ch2 - asciis._0;
  if (ch2 >= asciis.A && ch2 <= asciis.F)
    return ch2 - (asciis.A - 10);
  if (ch2 >= asciis.a && ch2 <= asciis.f)
    return ch2 - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function bytesToNumberBE(bytes2) {
  return hexToNumber(bytesToHex(bytes2));
}
function bytesToNumberLE(bytes2) {
  abytes2(bytes2);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes2).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes3(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
var u8n = (len) => new Uint8Array(len);
var u8fr = (arr) => Uint8Array.from(arr);
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n(0)) => {
    k = h(u8fr([0]), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8fr([1]), seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
var validatorFns = {
  bigint: (val) => typeof val === "bigint",
  function: (val) => typeof val === "function",
  boolean: (val) => typeof val === "boolean",
  string: (val) => typeof val === "string",
  stringOrUint8Array: (val) => typeof val === "string" || isBytes3(val),
  isSafeInteger: (val) => Number.isSafeInteger(val),
  array: (val) => Array.isArray(val),
  field: (val, object) => object.Fp.isValid(val),
  hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
};
function validateObject(object, validators, optValidators = {}) {
  const checkField = (fieldName, type, isOptional) => {
    const checkVal = validatorFns[type];
    if (typeof checkVal !== "function")
      throw new Error("invalid validator function");
    const val = object[fieldName];
    if (isOptional && val === void 0)
      return;
    if (!checkVal(val, object)) {
      throw new Error("param " + String(fieldName) + " is invalid. Expected " + type + ", got " + val);
    }
  };
  for (const [fieldName, type] of Object.entries(validators))
    checkField(fieldName, type, false);
  for (const [fieldName, type] of Object.entries(optValidators))
    checkField(fieldName, type, true);
  return object;
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = BigInt(0);
var _1n2 = BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function tonelliShanks(P) {
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (Z < P && FpIsSquare(_Fp, Z)) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1) {
    const p1div4 = (P + _1n2) / _4n;
    return function tonelliFast(Fp, n) {
      const root = Fp.pow(n, p1div4);
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (!FpIsSquare(Fp, n))
      throw new Error("Cannot find square root");
    let r = S;
    let g = Fp.pow(Fp.mul(Fp.ONE, Z), Q);
    let x = Fp.pow(n, Q1div2);
    let b = Fp.pow(n, Q);
    while (!Fp.eql(b, Fp.ONE)) {
      if (Fp.eql(b, Fp.ZERO))
        return Fp.ZERO;
      let m = 1;
      for (let t2 = Fp.sqr(b); m < r; m++) {
        if (Fp.eql(t2, Fp.ONE))
          break;
        t2 = Fp.sqr(t2);
      }
      const ge = Fp.pow(g, _1n2 << BigInt(r - m - 1));
      g = Fp.sqr(ge);
      x = Fp.mul(x, ge);
      b = Fp.mul(b, g);
      r = m;
    }
    return x;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n) {
    return function sqrt3mod4(Fp, n) {
      const p1div4 = (P + _1n2) / _4n;
      const root = Fp.pow(n, p1div4);
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  if (P % _8n === _5n) {
    return function sqrt5mod8(Fp, n) {
      const n2 = Fp.mul(n, _2n);
      const c1 = (P - _5n) / _8n;
      const v = Fp.pow(n2, c1);
      const nv = Fp.mul(n, v);
      const i = Fp.mul(Fp.mul(nv, _2n), v);
      const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  if (P % _16n === _9n) {
  }
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "isSafeInteger",
    BITS: "isSafeInteger"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  return validateObject(field, opts);
}
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const legc = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, legc);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("Cannot find square root: probably non-prime P");
  return yes ? 1 : zero ? 0 : -1;
}
function FpIsSquare(Fp, n) {
  const l = FpLegendre(Fp, n);
  return l === 0 || l === 1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLen2, isLE3 = false, redef = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE3,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: redef.sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE3 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes2) => {
      if (bytes2.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes2.length);
      return isLE3 ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE3 = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE3 ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE3 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/_md.js
function setBigUint642(view, byteOffset, value, isLE3) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE3);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE3 ? 4 : 0;
  const l = isLE3 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE3);
  view.setUint32(byteOffset + l, wl, isLE3);
}
function Chi2(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj2(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD2 = class extends Hash3 {
  constructor(blockLen, outputLen, padOffset, isLE3) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE3;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView2(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes2(data);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView2(data);
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
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE3 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint642(view, blockLen - 8, BigInt(this.length * 8), isLE3);
    this.process(view, 0);
    const oview = createView2(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE3);
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
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV2 = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA384_IV = /* @__PURE__ */ Uint32Array.from([
  3418070365,
  3238371032,
  1654270250,
  914150663,
  2438529370,
  812702999,
  355462360,
  4144912697,
  1731405415,
  4290775857,
  2394180231,
  1750603025,
  3675008525,
  1694076839,
  1203062813,
  3204075428
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K2 = /* @__PURE__ */ Uint32Array.from([
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
var SHA256_W2 = /* @__PURE__ */ new Uint32Array(64);
var SHA2562 = class extends HashMD2 {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV2[0] | 0;
    this.B = SHA256_IV2[1] | 0;
    this.C = SHA256_IV2[2] | 0;
    this.D = SHA256_IV2[3] | 0;
    this.E = SHA256_IV2[4] | 0;
    this.F = SHA256_IV2[5] | 0;
    this.G = SHA256_IV2[6] | 0;
    this.H = SHA256_IV2[7] | 0;
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
      SHA256_W2[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W2[i - 15];
      const W2 = SHA256_W2[i - 2];
      const s0 = rotr2(W15, 7) ^ rotr2(W15, 18) ^ W15 >>> 3;
      const s1 = rotr2(W2, 17) ^ rotr2(W2, 19) ^ W2 >>> 10;
      SHA256_W2[i] = s1 + SHA256_W2[i - 7] + s0 + SHA256_W2[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma12 = rotr2(E, 6) ^ rotr2(E, 11) ^ rotr2(E, 25);
      const T1 = H + sigma12 + Chi2(E, F, G) + SHA256_K2[i] + SHA256_W2[i] | 0;
      const sigma02 = rotr2(A, 2) ^ rotr2(A, 13) ^ rotr2(A, 22);
      const T2 = sigma02 + Maj2(A, B, C) | 0;
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
    clean(SHA256_W2);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA512 = class extends HashMD2 {
  constructor(outputLen = 64) {
    super(128, outputLen, 16, false);
    this.Ah = SHA512_IV[0] | 0;
    this.Al = SHA512_IV[1] | 0;
    this.Bh = SHA512_IV[2] | 0;
    this.Bl = SHA512_IV[3] | 0;
    this.Ch = SHA512_IV[4] | 0;
    this.Cl = SHA512_IV[5] | 0;
    this.Dh = SHA512_IV[6] | 0;
    this.Dl = SHA512_IV[7] | 0;
    this.Eh = SHA512_IV[8] | 0;
    this.El = SHA512_IV[9] | 0;
    this.Fh = SHA512_IV[10] | 0;
    this.Fl = SHA512_IV[11] | 0;
    this.Gh = SHA512_IV[12] | 0;
    this.Gl = SHA512_IV[13] | 0;
    this.Hh = SHA512_IV[14] | 0;
    this.Hl = SHA512_IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var SHA384 = class extends SHA512 {
  constructor() {
    super(48);
    this.Ah = SHA384_IV[0] | 0;
    this.Al = SHA384_IV[1] | 0;
    this.Bh = SHA384_IV[2] | 0;
    this.Bl = SHA384_IV[3] | 0;
    this.Ch = SHA384_IV[4] | 0;
    this.Cl = SHA384_IV[5] | 0;
    this.Dh = SHA384_IV[6] | 0;
    this.Dl = SHA384_IV[7] | 0;
    this.Eh = SHA384_IV[8] | 0;
    this.El = SHA384_IV[9] | 0;
    this.Fh = SHA384_IV[10] | 0;
    this.Fl = SHA384_IV[11] | 0;
    this.Gh = SHA384_IV[12] | 0;
    this.Gl = SHA384_IV[13] | 0;
    this.Hh = SHA384_IV[14] | 0;
    this.Hl = SHA384_IV[15] | 0;
  }
};
var sha2562 = /* @__PURE__ */ createHasher(() => new SHA2562());
var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());
var sha384 = /* @__PURE__ */ createHasher(() => new SHA384());

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash3 {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes2(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
function constTimeNegate(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function validateW(W2, bits) {
  if (!Number.isSafeInteger(W2) || W2 <= 0 || W2 > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W2);
}
function calcWOpts(W2, scalarBits) {
  validateW(W2, scalarBits);
  const windows = Math.ceil(scalarBits / W2) + 1;
  const windowSize = 2 ** (W2 - 1);
  const maxNumber = 2 ** W2;
  const mask = bitMask(W2);
  const shiftBy = BigInt(W2);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window2, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window2 * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window2 % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function wNAF(c, bits) {
  return {
    constTimeNegate,
    hasPrecomputes(elm) {
      return getW(elm) !== 1;
    },
    // non-const time multiplication ladder
    unsafeLadder(elm, n, p = c.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    },
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param elm Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(elm, W2) {
      const { windows, windowSize } = calcWOpts(W2, bits);
      const points = [];
      let p = elm;
      let base2 = p;
      for (let window2 = 0; window2 < windows; window2++) {
        base2 = p;
        points.push(base2);
        for (let i = 1; i < windowSize; i++) {
          base2 = base2.add(p);
          points.push(base2);
        }
        p = base2.double();
      }
      return points;
    },
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @returns real and fake (for const-time) points
     */
    wNAF(W2, precomputes, n) {
      let p = c.ZERO;
      let f = c.BASE;
      const wo = calcWOpts(W2, bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          f = f.add(constTimeNegate(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(constTimeNegate(isNeg, precomputes[offset]));
        }
      }
      return { p, f };
    },
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W2, precomputes, n, acc = c.ZERO) {
      const wo = calcWOpts(W2, bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      return acc;
    },
    getPrecomputes(W2, P, transform) {
      let comp = pointPrecomputes.get(P);
      if (!comp) {
        comp = this.precomputeWindow(P, W2);
        if (W2 !== 1)
          pointPrecomputes.set(P, transform(comp));
      }
      return comp;
    },
    wNAFCached(P, n, transform) {
      const W2 = getW(P);
      return this.wNAF(W2, this.getPrecomputes(W2, P, transform), n);
    },
    wNAFCachedUnsafe(P, n, transform, prev) {
      const W2 = getW(P);
      if (W2 === 1)
        return this.unsafeLadder(P, n, prev);
      return this.wNAFUnsafe(W2, this.getPrecomputes(W2, P, transform), n, prev);
    },
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    setWindowSize(P, W2) {
      validateW(W2, bits);
      pointWindowSizes.set(P, W2);
      pointPrecomputes.delete(P);
    }
  };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(points.length));
  const windowSize = wbits > 12 ? wbits - 3 : wbits > 4 ? wbits - 2 : wbits ? 2 : 1;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < scalars.length; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function validateBasic(curve) {
  validateField(curve.Fp);
  validateObject(curve, {
    n: "bigint",
    h: "bigint",
    Gx: "field",
    Gy: "field"
  }, {
    nBitLength: "isSafeInteger",
    nByteLength: "isSafeInteger"
  });
  return Object.freeze({
    ...nLength(curve.n, curve.nBitLength),
    ...curve,
    ...{ p: curve.Fp.ORDER }
  });
}

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/abstract/weierstrass.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function validateSigVerOpts(opts) {
  if (opts.lowS !== void 0)
    abool("lowS", opts.lowS);
  if (opts.prehash !== void 0)
    abool("prehash", opts.prehash);
}
function validatePointOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    a: "field",
    b: "field"
  }, {
    allowedPrivateKeyLengths: "array",
    wrapPrivateKey: "boolean",
    isTorsionFree: "function",
    clearCofactor: "function",
    allowInfinityPoint: "boolean",
    fromBytes: "function",
    toBytes: "function"
  });
  const { endo, Fp, a } = opts;
  if (endo) {
    if (!Fp.eql(a, Fp.ZERO)) {
      throw new Error("invalid endomorphism, can only be defined for Koblitz curves that have a=0");
    }
    if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error("invalid endomorphism, expected beta: bigint and splitScalar: function");
    }
  }
  return Object.freeze({ ...opts });
}
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
var DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num) {
      const { Err: E } = DER;
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(hex) {
    const { Err: E, _int: int, _tlv: tlv } = DER;
    const data = ensureBytes("signature", hex);
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = DER;
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrassPoints(opts) {
  const CURVE = validatePointOpts(opts);
  const { Fp } = CURVE;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  const toBytes4 = CURVE.toBytes || ((_c, point, _isCompressed) => {
    const a = point.toAffine();
    return concatBytes2(Uint8Array.from([4]), Fp.toBytes(a.x), Fp.toBytes(a.y));
  });
  const fromBytes = CURVE.fromBytes || ((bytes2) => {
    const tail = bytes2.subarray(1);
    const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
    const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
    return { x, y };
  });
  function weierstrassEquation(x) {
    const { a, b } = CURVE;
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, a)), b);
  }
  if (!Fp.eql(Fp.sqr(CURVE.Gy), weierstrassEquation(CURVE.Gx)))
    throw new Error("bad generator point: equation left != right");
  function isWithinCurveOrder(num) {
    return inRange(num, _1n4, CURVE.n);
  }
  function normPrivateKeyToScalar(key) {
    const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: N } = CURVE;
    if (lengths && typeof key !== "bigint") {
      if (isBytes3(key))
        key = bytesToHex(key);
      if (typeof key !== "string" || !lengths.includes(key.length))
        throw new Error("invalid private key");
      key = key.padStart(nByteLength * 2, "0");
    }
    let num;
    try {
      num = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
    } catch (error) {
      throw new Error("invalid private key, expected hex or " + nByteLength + " bytes, got " + typeof key);
    }
    if (wrapPrivateKey)
      num = mod(num, N);
    aInRange("private key", num, _1n4, N);
    return num;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ProjectivePoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp.eql(z, Fp.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(z);
    const ax = Fp.mul(x, iz);
    const ay = Fp.mul(y, iz);
    const zz = Fp.mul(z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (CURVE.allowInfinityPoint && !Fp.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not FE");
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    if (!Fp.eql(left, right))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  class Point {
    constructor(px, py, pz) {
      if (px == null || !Fp.isValid(px))
        throw new Error("x required");
      if (py == null || !Fp.isValid(py) || Fp.is0(py))
        throw new Error("y required");
      if (pz == null || !Fp.isValid(pz))
        throw new Error("z required");
      this.px = px;
      this.py = py;
      this.pz = pz;
      Object.freeze(this);
    }
    // Does not validate if the point is on-curve.
    // Use fromHex instead, or call assertValidity() later.
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      const is0 = (i) => Fp.eql(i, Fp.ZERO);
      if (is0(x) && is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     * Takes a bunch of Projective Points but executes only one
     * inversion on all of them. Inversion is very slow operation,
     * so this improves performance massively.
     * Optimization: converts a list of projective points to a list of identical points with Z=1.
     */
    static normalizeZ(points) {
      const toInv = FpInvertBatch(Fp, points.map((p) => p.pz));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
    }
    /**
     * Converts hash string or Uint8Array to Point.
     * @param hex short/long ECDSA hex
     */
    static fromHex(hex) {
      const P = Point.fromAffine(fromBytes(ensureBytes("pointHex", hex)));
      P.assertValidity();
      return P;
    }
    // Multiplies generator point by privateKey.
    static fromPrivateKey(privateKey) {
      return Point.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      wnaf.setWindowSize(this, windowSize);
    }
    // A point on curve is valid if it conforms to equation.
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (Fp.isOdd)
        return !Fp.isOdd(y);
      throw new Error("Field doesn't support isOdd");
    }
    /**
     * Compare one point to another.
     */
    equals(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /**
     * Flips point to one corresponding to (x, -y) in Affine coordinates.
     */
    negate() {
      return new Point(this.px, Fp.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point.normalizeZ);
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo, n: N } = CURVE;
      aInRange("scalar", sc, _0n4, N);
      const I = Point.ZERO;
      if (sc === _0n4)
        return I;
      if (this.is0() || sc === _1n4)
        return this;
      if (!endo || wnaf.hasPrecomputes(this))
        return wnaf.wNAFCachedUnsafe(this, sc, Point.normalizeZ);
      let { k1neg, k1, k2neg, k2 } = endo.splitScalar(sc);
      let k1p = I;
      let k2p = I;
      let d = this;
      while (k1 > _0n4 || k2 > _0n4) {
        if (k1 & _1n4)
          k1p = k1p.add(d);
        if (k2 & _1n4)
          k2p = k2p.add(d);
        d = d.double();
        k1 >>= _1n4;
        k2 >>= _1n4;
      }
      if (k1neg)
        k1p = k1p.negate();
      if (k2neg)
        k2p = k2p.negate();
      k2p = new Point(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
      return k1p.add(k2p);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo, n: N } = CURVE;
      aInRange("scalar", scalar, _1n4, N);
      let point, fake;
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = endo.splitScalar(scalar);
        let { p: k1p, f: f1p } = this.wNAF(k1);
        let { p: k2p, f: f2p } = this.wNAF(k2);
        k1p = wnaf.constTimeNegate(k1neg, k1p);
        k2p = wnaf.constTimeNegate(k2neg, k2p);
        k2p = new Point(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
        point = k1p.add(k2p);
        fake = f1p.add(f2p);
      } else {
        const { p, f } = this.wNAF(scalar);
        point = p;
        fake = f;
      }
      return Point.normalizeZ([point, fake])[0];
    }
    /**
     * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
     * Not using Strauss-Shamir trick: precomputation tables are faster.
     * The trick could be useful if both P and Q are not G (not in our case).
     * @returns non-zero affine point
     */
    multiplyAndAddUnsafe(Q, a, b) {
      const G = Point.BASE;
      const mul3 = (P, a2) => a2 === _0n4 || a2 === _1n4 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
      const sum = mul3(this, a).add(mul3(Q, b));
      return sum.is0() ? void 0 : sum;
    }
    // Converts Projective point to affine (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    // (x, y, z) ∋ (x=x/z, y=y/z)
    toAffine(iz) {
      return toAffineMemo(this, iz);
    }
    isTorsionFree() {
      const { h: cofactor, isTorsionFree } = CURVE;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      throw new Error("isTorsionFree() has not been declared for the elliptic curve");
    }
    clearCofactor() {
      const { h: cofactor, clearCofactor } = CURVE;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(CURVE.h);
    }
    toRawBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes4(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      abool("isCompressed", isCompressed);
      return bytesToHex(this.toRawBytes(isCompressed));
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point.ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
  const _bits = CURVE.nBitLength;
  const wnaf = wNAF(Point, CURVE.endo ? Math.ceil(_bits / 2) : _bits);
  return {
    CURVE,
    ProjectivePoint: Point,
    normPrivateKeyToScalar,
    weierstrassEquation,
    isWithinCurveOrder
  };
}
function validateOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    hash: "hash",
    hmac: "function",
    randomBytes: "function"
  }, {
    bits2int: "function",
    bits2int_modN: "function",
    lowS: "boolean"
  });
  return Object.freeze({ lowS: true, ...opts });
}
function weierstrass(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { Fp, n: CURVE_ORDER } = CURVE;
  const compressedLen = Fp.BYTES + 1;
  const uncompressedLen = 2 * Fp.BYTES + 1;
  function modN(a) {
    return mod(a, CURVE_ORDER);
  }
  function invN(a) {
    return invert(a, CURVE_ORDER);
  }
  const { ProjectivePoint: Point, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
    ...CURVE,
    toBytes(_c, point, isCompressed) {
      const a = point.toAffine();
      const x = Fp.toBytes(a.x);
      const cat = concatBytes2;
      abool("isCompressed", isCompressed);
      if (isCompressed) {
        return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
      } else {
        return cat(Uint8Array.from([4]), x, Fp.toBytes(a.y));
      }
    },
    fromBytes(bytes2) {
      const len = bytes2.length;
      const head = bytes2[0];
      const tail = bytes2.subarray(1);
      if (len === compressedLen && (head === 2 || head === 3)) {
        const x = bytesToNumberBE(tail);
        if (!inRange(x, _1n4, Fp.ORDER))
          throw new Error("Point is not on curve");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const suffix = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("Point is not on curve" + suffix);
        }
        const isYOdd = (y & _1n4) === _1n4;
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp.neg(y);
        return { x, y };
      } else if (len === uncompressedLen && head === 4) {
        const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
        const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
        return { x, y };
      } else {
        const cl = compressedLen;
        const ul = uncompressedLen;
        throw new Error("invalid Point, expected length of " + cl + ", or uncompressed " + ul + ", got " + len);
      }
    }
  });
  const numToNByteHex = (num) => bytesToHex(numberToBytesBE(num, CURVE.nByteLength));
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? modN(-s) : s;
  }
  const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
  class Signature {
    constructor(r, s, recovery) {
      aInRange("r", r, _1n4, CURVE_ORDER);
      aInRange("s", s, _1n4, CURVE_ORDER);
      this.r = r;
      this.s = s;
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex) {
      const l = CURVE.nByteLength;
      hex = ensureBytes("compactSignature", hex, l * 2);
      return new Signature(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex));
      return new Signature(r, s);
    }
    /**
     * @todo remove
     * @deprecated
     */
    assertValidity() {
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(msgHash) {
      const { r, s, recovery: rec } = this;
      const h = bits2int_modN(ensureBytes("msgHash", msgHash));
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
      if (radj >= Fp.ORDER)
        throw new Error("recovery id 2 or 3 invalid");
      const prefix = (rec & 1) === 0 ? "02" : "03";
      const R = Point.fromHex(prefix + numToNByteHex(radj));
      const ir = invN(radj);
      const u1 = modN(-h * ir);
      const u2 = modN(s * ir);
      const Q = Point.BASE.multiplyAndAddUnsafe(R, u1, u2);
      if (!Q)
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, modN(-this.s), this.recovery) : this;
    }
    // DER-encoded
    toDERRawBytes() {
      return hexToBytes(this.toDERHex());
    }
    toDERHex() {
      return DER.hexFromSig(this);
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return hexToBytes(this.toCompactHex());
    }
    toCompactHex() {
      return numToNByteHex(this.r) + numToNByteHex(this.s);
    }
  }
  const utils = {
    isValidPrivateKey(privateKey) {
      try {
        normPrivateKeyToScalar(privateKey);
        return true;
      } catch (error) {
        return false;
      }
    },
    normPrivateKeyToScalar,
    /**
     * Produces cryptographically secure private key from random of size
     * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
     */
    randomPrivateKey: () => {
      const length = getMinHashLength(CURVE.n);
      return mapHashToField(CURVE.randomBytes(length), CURVE.n);
    },
    /**
     * Creates precompute table for an arbitrary EC point. Makes point "cached".
     * Allows to massively speed-up `point.multiply(scalar)`.
     * @returns cached point
     * @example
     * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
     * fast.multiply(privKey); // much faster ECDH now
     */
    precompute(windowSize = 8, point = Point.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  function getPublicKey2(privateKey, isCompressed = true) {
    return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed);
  }
  function isProbPub(item) {
    const arr = isBytes3(item);
    const str = typeof item === "string";
    const len = (arr || str) && item.length;
    if (arr)
      return len === compressedLen || len === uncompressedLen;
    if (str)
      return len === 2 * compressedLen || len === 2 * uncompressedLen;
    if (item instanceof Point)
      return true;
    return false;
  }
  function getSharedSecret(privateA, publicB, isCompressed = true) {
    if (isProbPub(privateA))
      throw new Error("first arg must be private key");
    if (!isProbPub(publicB))
      throw new Error("second arg must be public key");
    const b = Point.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
  }
  const bits2int = CURVE.bits2int || function(bytes2) {
    if (bytes2.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes2);
    const delta = bytes2.length * 8 - CURVE.nBitLength;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = CURVE.bits2int_modN || function(bytes2) {
    return modN(bits2int(bytes2));
  };
  const ORDER_MASK = bitMask(CURVE.nBitLength);
  function int2octets(num) {
    aInRange("num < 2^" + CURVE.nBitLength, num, _0n4, ORDER_MASK);
    return numberToBytesBE(num, CURVE.nByteLength);
  }
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash, randomBytes: randomBytes2 } = CURVE;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes2(Fp.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!isWithinCurveOrder(k))
        return;
      const ik = invN(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = modN(q.x);
      if (r === _0n4)
        return;
      const s = modN(ik * modN(m + r * d));
      if (s === _0n4)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = normalizeS(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
  const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
  function sign(msgHash, privKey, opts = defaultSigOpts) {
    const { seed, k2sig } = prepSig(msgHash, privKey, opts);
    const C = CURVE;
    const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
    return drbg(seed, k2sig);
  }
  Point.BASE._setWindowSize(8);
  function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
    const sg = signature;
    msgHash = ensureBytes("msgHash", msgHash);
    publicKey = ensureBytes("publicKey", publicKey);
    const { lowS, prehash, format } = opts;
    validateSigVerOpts(opts);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    if (format !== void 0 && format !== "compact" && format !== "der")
      throw new Error("format must be compact or der");
    const isHex = typeof sg === "string" || isBytes3(sg);
    const isObj = !isHex && !format && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P;
    try {
      if (isObj)
        _sig = new Signature(sg.r, sg.s);
      if (isHex) {
        try {
          if (format !== "compact")
            _sig = Signature.fromDER(sg);
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!_sig && format !== "der")
          _sig = Signature.fromCompact(sg);
      }
      P = Point.fromHex(publicKey);
    } catch (error) {
      return false;
    }
    if (!_sig)
      return false;
    if (lowS && _sig.hasHighS())
      return false;
    if (prehash)
      msgHash = CURVE.hash(msgHash);
    const { r, s } = _sig;
    const h = bits2int_modN(msgHash);
    const is = invN(s);
    const u1 = modN(h * is);
    const u2 = modN(r * is);
    const R = Point.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
    if (!R)
      return false;
    const v = modN(R.x);
    return v === r;
  }
  return {
    CURVE,
    getPublicKey: getPublicKey2,
    getSharedSecret,
    sign,
    verify,
    ProjectivePoint: Point,
    Signature,
    utils
  };
}

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/_shortw_utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function getHash(hash) {
  return {
    hash,
    hmac: (key, ...msgs) => hmac(hash, key, concatBytes(...msgs)),
    randomBytes
  };
}
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, ...getHash(hash) });
  return { ...create(defHash), create };
}

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/nist.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var Fp256 = Field(BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"));
var p256_a = Fp256.create(BigInt("-3"));
var p256_b = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
var p256 = createCurve({
  a: p256_a,
  b: p256_b,
  Fp: Fp256,
  n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
  Gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  Gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
  h: BigInt(1),
  lowS: false
}, sha2562);
var Fp384 = Field(BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff"));
var p384_a = Fp384.create(BigInt("-3"));
var p384_b = BigInt("0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef");
var p384 = createCurve({
  a: p384_a,
  b: p384_b,
  Fp: Fp384,
  n: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973"),
  Gx: BigInt("0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7"),
  Gy: BigInt("0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f"),
  h: BigInt(1),
  lowS: false
}, sha384);
var Fp521 = Field(BigInt("0x1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
var p521_a = Fp521.create(BigInt("-3"));
var p521_b = BigInt("0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00");
var p521 = createCurve({
  a: p521_a,
  b: p521_b,
  Fp: Fp521,
  n: BigInt("0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409"),
  Gx: BigInt("0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66"),
  Gy: BigInt("0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650"),
  h: BigInt(1),
  lowS: false,
  allowedPrivateKeyLengths: [130, 131, 132]
  // P521 keys are variable-length. Normalize to 132b
}, sha512);

// node_modules/@turnkey/crypto/node_modules/@noble/curves/esm/p256.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var p2562 = p256;

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/hkdf.js
function extract(hash, ikm, salt) {
  ahash(hash);
  if (salt === void 0)
    salt = new Uint8Array(hash.outputLen);
  return hmac(hash, toBytes2(salt), toBytes2(ikm));
}
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.from([0]);
var EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32) {
  ahash(hash);
  anumber(length);
  const olen = hash.outputLen;
  if (length > 255 * olen)
    throw new Error("Length should be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === void 0)
    info = EMPTY_BUFFER;
  const okm = new Uint8Array(blocks * olen);
  const HMAC2 = hmac.create(hash, prk);
  const HMACTmp = HMAC2._cloneInto();
  const T = new Uint8Array(HMAC2.outputLen);
  for (let counter = 0; counter < blocks; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    HMACTmp.update(counter === 0 ? EMPTY_BUFFER : T).update(info).update(HKDF_COUNTER).digestInto(T);
    okm.set(T, olen * counter);
    HMAC2._cloneInto(HMACTmp);
  }
  HMAC2.destroy();
  HMACTmp.destroy();
  clean(T, HKDF_COUNTER);
  return okm.slice(0, length);
}

// node_modules/@turnkey/crypto/node_modules/@noble/hashes/esm/sha256.js
var sha2563 = sha2562;

// node_modules/@noble/ciphers/esm/utils.js
/*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) */
function isBytes4(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool2(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function abytes3(b, ...lengths) {
  if (!isBytes4(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput2(out, instance) {
  abytes3(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView3(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE2 = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function utf8ToBytes3(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes3(data) {
  if (typeof data === "string")
    data = utf8ToBytes3(data);
  else if (isBytes4(data))
    data = copyBytes(data);
  else
    throw new Error("Uint8Array expected, got " + typeof data);
  return data;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes3(key);
    if (!isLE2)
      throw new Error("Non little-endian hardware is not yet supported");
    if (params.nonceLength !== void 0) {
      const nonce = args[0];
      if (!nonce)
        throw new Error("nonce / iv required");
      if (params.varSizeNonce)
        abytes3(nonce);
      else
        abytes3(nonce, params.nonceLength);
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== void 0) {
      abytes3(args[1]);
    }
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output2) => {
      if (output2 !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes3(output2);
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output2) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes3(data);
        checkOutput(cipher.encrypt.length, output2);
        return cipher.encrypt(data, output2);
      },
      decrypt(data, output2) {
        abytes3(data);
        if (tagl && data.length < tagl)
          throw new Error("invalid ciphertext length: smaller than tagLength=" + tagl);
        checkOutput(cipher.decrypt.length, output2);
        return cipher.decrypt(data, output2);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength)
    throw new Error("invalid output length, expected " + expectedLength + ", got: " + out.length);
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function setBigUint643(view, byteOffset, value, isLE3) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE3);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE3 ? 4 : 0;
  const l = isLE3 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE3);
  view.setUint32(byteOffset + l, wl, isLE3);
}
function u64Lengths(dataLength, aadLength, isLE3) {
  abool2(isLE3);
  const num = new Uint8Array(16);
  const view = createView3(num);
  setBigUint643(view, 0, BigInt(aadLength), isLE3);
  setBigUint643(view, 8, BigInt(dataLength), isLE3);
  return num;
}
function isAligned32(bytes2) {
  return bytes2.byteOffset % 4 === 0;
}
function copyBytes(bytes2) {
  return Uint8Array.from(bytes2);
}

// node_modules/@noble/ciphers/esm/_polyval.js
var BLOCK_SIZE = 16;
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var ZEROS32 = u32(ZEROS16);
var POLY = 225;
var mul2 = (s0, s1, s2, s3) => {
  const hiBit = s3 & 1;
  return {
    s3: s2 << 31 | s3 >>> 1,
    s2: s1 << 31 | s2 >>> 1,
    s1: s0 << 31 | s1 >>> 1,
    s0: s0 >>> 1 ^ POLY << 24 & -(hiBit & 1)
    // reduce % poly
  };
};
var swapLE2 = (n) => (n >>> 0 & 255) << 24 | (n >>> 8 & 255) << 16 | (n >>> 16 & 255) << 8 | n >>> 24 & 255 | 0;
function _toGHASHKey(k) {
  k.reverse();
  const hiBit = k[15] & 1;
  let carry = 0;
  for (let i = 0; i < k.length; i++) {
    const t = k[i];
    k[i] = t >>> 1 | carry;
    carry = (t & 1) << 7;
  }
  k[0] ^= -hiBit & 225;
  return k;
}
var estimateWindow = (bytes2) => {
  if (bytes2 > 64 * 1024)
    return 8;
  if (bytes2 > 1024)
    return 4;
  return 2;
};
var GHASH = class {
  // We select bits per window adaptively based on expectedLength
  constructor(key, expectedLength) {
    this.blockLen = BLOCK_SIZE;
    this.outputLen = BLOCK_SIZE;
    this.s0 = 0;
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.finished = false;
    key = toBytes3(key);
    abytes3(key, 16);
    const kView = createView3(key);
    let k0 = kView.getUint32(0, false);
    let k1 = kView.getUint32(4, false);
    let k2 = kView.getUint32(8, false);
    let k3 = kView.getUint32(12, false);
    const doubles = [];
    for (let i = 0; i < 128; i++) {
      doubles.push({ s0: swapLE2(k0), s1: swapLE2(k1), s2: swapLE2(k2), s3: swapLE2(k3) });
      ({ s0: k0, s1: k1, s2: k2, s3: k3 } = mul2(k0, k1, k2, k3));
    }
    const W2 = estimateWindow(expectedLength || 1024);
    if (![1, 2, 4, 8].includes(W2))
      throw new Error("ghash: invalid window size, expected 2, 4 or 8");
    this.W = W2;
    const bits = 128;
    const windows = bits / W2;
    const windowSize = this.windowSize = 2 ** W2;
    const items = [];
    for (let w = 0; w < windows; w++) {
      for (let byte = 0; byte < windowSize; byte++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let j = 0; j < W2; j++) {
          const bit = byte >>> W2 - j - 1 & 1;
          if (!bit)
            continue;
          const { s0: d0, s1: d1, s2: d2, s3: d3 } = doubles[W2 * w + j];
          s0 ^= d0, s1 ^= d1, s2 ^= d2, s3 ^= d3;
        }
        items.push({ s0, s1, s2, s3 });
      }
    }
    this.t = items;
  }
  _updateBlock(s0, s1, s2, s3) {
    s0 ^= this.s0, s1 ^= this.s1, s2 ^= this.s2, s3 ^= this.s3;
    const { W: W2, t, windowSize } = this;
    let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
    const mask = (1 << W2) - 1;
    let w = 0;
    for (const num of [s0, s1, s2, s3]) {
      for (let bytePos = 0; bytePos < 4; bytePos++) {
        const byte = num >>> 8 * bytePos & 255;
        for (let bitPos = 8 / W2 - 1; bitPos >= 0; bitPos--) {
          const bit = byte >>> W2 * bitPos & mask;
          const { s0: e0, s1: e1, s2: e2, s3: e3 } = t[w * windowSize + bit];
          o0 ^= e0, o1 ^= e1, o2 ^= e2, o3 ^= e3;
          w += 1;
        }
      }
    }
    this.s0 = o0;
    this.s1 = o1;
    this.s2 = o2;
    this.s3 = o3;
  }
  update(data) {
    aexists2(this);
    data = toBytes3(data);
    abytes3(data);
    const b32 = u32(data);
    const blocks = Math.floor(data.length / BLOCK_SIZE);
    const left = data.length % BLOCK_SIZE;
    for (let i = 0; i < blocks; i++) {
      this._updateBlock(b32[i * 4 + 0], b32[i * 4 + 1], b32[i * 4 + 2], b32[i * 4 + 3]);
    }
    if (left) {
      ZEROS16.set(data.subarray(blocks * BLOCK_SIZE));
      this._updateBlock(ZEROS32[0], ZEROS32[1], ZEROS32[2], ZEROS32[3]);
      clean2(ZEROS32);
    }
    return this;
  }
  destroy() {
    const { t } = this;
    for (const elm of t) {
      elm.s0 = 0, elm.s1 = 0, elm.s2 = 0, elm.s3 = 0;
    }
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { s0, s1, s2, s3 } = this;
    const o32 = u32(out);
    o32[0] = s0;
    o32[1] = s1;
    o32[2] = s2;
    o32[3] = s3;
    return out;
  }
  digest() {
    const res = new Uint8Array(BLOCK_SIZE);
    this.digestInto(res);
    this.destroy();
    return res;
  }
};
var Polyval = class extends GHASH {
  constructor(key, expectedLength) {
    key = toBytes3(key);
    abytes3(key);
    const ghKey = _toGHASHKey(copyBytes(key));
    super(ghKey, expectedLength);
    clean2(ghKey);
  }
  update(data) {
    data = toBytes3(data);
    aexists2(this);
    const b32 = u32(data);
    const left = data.length % BLOCK_SIZE;
    const blocks = Math.floor(data.length / BLOCK_SIZE);
    for (let i = 0; i < blocks; i++) {
      this._updateBlock(swapLE2(b32[i * 4 + 3]), swapLE2(b32[i * 4 + 2]), swapLE2(b32[i * 4 + 1]), swapLE2(b32[i * 4 + 0]));
    }
    if (left) {
      ZEROS16.set(data.subarray(blocks * BLOCK_SIZE));
      this._updateBlock(swapLE2(ZEROS32[3]), swapLE2(ZEROS32[2]), swapLE2(ZEROS32[1]), swapLE2(ZEROS32[0]));
      clean2(ZEROS32);
    }
    return this;
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { s0, s1, s2, s3 } = this;
    const o32 = u32(out);
    o32[0] = s0;
    o32[1] = s1;
    o32[2] = s2;
    o32[3] = s3;
    return out.reverse();
  }
};
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key, msg.length).update(toBytes3(msg)).digest();
  const tmp = hashCons(new Uint8Array(16), 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key, expectedLength) => hashCons(key, expectedLength);
  return hashC;
}
var ghash = wrapConstructorWithKey((key, expectedLength) => new GHASH(key, expectedLength));
var polyval = wrapConstructorWithKey((key, expectedLength) => new Polyval(key, expectedLength));

// node_modules/@noble/ciphers/esm/aes.js
var BLOCK_SIZE2 = 16;
var BLOCK_SIZE32 = 4;
var EMPTY_BLOCK = /* @__PURE__ */ new Uint8Array(BLOCK_SIZE2);
var POLY2 = 283;
function mul22(n) {
  return n << 1 ^ POLY2 & -(n >> 7);
}
function mul(a, b) {
  let res = 0;
  for (; b > 0; b >>= 1) {
    res ^= a & -(b & 1);
    a = mul22(a);
  }
  return res;
}
var sbox = /* @__PURE__ */ (() => {
  const t = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++, x ^= mul22(x))
    t[i] = x;
  const box = new Uint8Array(256);
  box[0] = 99;
  for (let i = 0; i < 255; i++) {
    let x = t[255 - i];
    x |= x << 8;
    box[t[i]] = (x ^ x >> 4 ^ x >> 5 ^ x >> 6 ^ x >> 7 ^ 99) & 255;
  }
  clean2(t);
  return box;
})();
var rotr32_8 = (n) => n << 24 | n >>> 8;
var rotl32_8 = (n) => n << 8 | n >>> 24;
function genTtable(sbox2, fn) {
  if (sbox2.length !== 256)
    throw new Error("Wrong sbox length");
  const T0 = new Uint32Array(256).map((_, j) => fn(sbox2[j]));
  const T1 = T0.map(rotl32_8);
  const T2 = T1.map(rotl32_8);
  const T3 = T2.map(rotl32_8);
  const T01 = new Uint32Array(256 * 256);
  const T23 = new Uint32Array(256 * 256);
  const sbox22 = new Uint16Array(256 * 256);
  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 256; j++) {
      const idx = i * 256 + j;
      T01[idx] = T0[i] ^ T1[j];
      T23[idx] = T2[i] ^ T3[j];
      sbox22[idx] = sbox2[i] << 8 | sbox2[j];
    }
  }
  return { sbox: sbox2, sbox2: sbox22, T0, T1, T2, T3, T01, T23 };
}
var tableEncoding = /* @__PURE__ */ genTtable(sbox, (s) => mul(s, 3) << 24 | s << 16 | s << 8 | mul(s, 2));
var xPowers = /* @__PURE__ */ (() => {
  const p = new Uint8Array(16);
  for (let i = 0, x = 1; i < 16; i++, x = mul22(x))
    p[i] = x;
  return p;
})();
function expandKeyLE(key) {
  abytes3(key);
  const len = key.length;
  if (![16, 24, 32].includes(len))
    throw new Error("aes: invalid key size, should be 16, 24 or 32, got " + len);
  const { sbox2 } = tableEncoding;
  const toClean = [];
  if (!isAligned32(key))
    toClean.push(key = copyBytes(key));
  const k32 = u32(key);
  const Nk = k32.length;
  const subByte = (n) => applySbox(sbox2, n, n, n, n);
  const xk = new Uint32Array(len + 28);
  xk.set(k32);
  for (let i = Nk; i < xk.length; i++) {
    let t = xk[i - 1];
    if (i % Nk === 0)
      t = subByte(rotr32_8(t)) ^ xPowers[i / Nk - 1];
    else if (Nk > 6 && i % Nk === 4)
      t = subByte(t);
    xk[i] = xk[i - Nk] ^ t;
  }
  clean2(...toClean);
  return xk;
}
function apply0123(T01, T23, s0, s1, s2, s3) {
  return T01[s0 << 8 & 65280 | s1 >>> 8 & 255] ^ T23[s2 >>> 8 & 65280 | s3 >>> 24 & 255];
}
function applySbox(sbox2, s0, s1, s2, s3) {
  return sbox2[s0 & 255 | s1 & 65280] | sbox2[s2 >>> 16 & 255 | s3 >>> 16 & 65280] << 16;
}
function encrypt(xk, s0, s1, s2, s3) {
  const { sbox2, T01, T23 } = tableEncoding;
  let k = 0;
  s0 ^= xk[k++], s1 ^= xk[k++], s2 ^= xk[k++], s3 ^= xk[k++];
  const rounds = xk.length / 4 - 2;
  for (let i = 0; i < rounds; i++) {
    const t02 = xk[k++] ^ apply0123(T01, T23, s0, s1, s2, s3);
    const t12 = xk[k++] ^ apply0123(T01, T23, s1, s2, s3, s0);
    const t22 = xk[k++] ^ apply0123(T01, T23, s2, s3, s0, s1);
    const t32 = xk[k++] ^ apply0123(T01, T23, s3, s0, s1, s2);
    s0 = t02, s1 = t12, s2 = t22, s3 = t32;
  }
  const t0 = xk[k++] ^ applySbox(sbox2, s0, s1, s2, s3);
  const t1 = xk[k++] ^ applySbox(sbox2, s1, s2, s3, s0);
  const t2 = xk[k++] ^ applySbox(sbox2, s2, s3, s0, s1);
  const t3 = xk[k++] ^ applySbox(sbox2, s3, s0, s1, s2);
  return { s0: t0, s1: t1, s2: t2, s3: t3 };
}
function ctr32(xk, isLE3, nonce, src, dst) {
  abytes3(nonce, BLOCK_SIZE2);
  abytes3(src);
  dst = getOutput(src.length, dst);
  const ctr = nonce;
  const c32 = u32(ctr);
  const view = createView3(ctr);
  const src32 = u32(src);
  const dst32 = u32(dst);
  const ctrPos = isLE3 ? 0 : 12;
  const srcLen = src.length;
  let ctrNum = view.getUint32(ctrPos, isLE3);
  let { s0, s1, s2, s3 } = encrypt(xk, c32[0], c32[1], c32[2], c32[3]);
  for (let i = 0; i + 4 <= src32.length; i += 4) {
    dst32[i + 0] = src32[i + 0] ^ s0;
    dst32[i + 1] = src32[i + 1] ^ s1;
    dst32[i + 2] = src32[i + 2] ^ s2;
    dst32[i + 3] = src32[i + 3] ^ s3;
    ctrNum = ctrNum + 1 >>> 0;
    view.setUint32(ctrPos, ctrNum, isLE3);
    ({ s0, s1, s2, s3 } = encrypt(xk, c32[0], c32[1], c32[2], c32[3]));
  }
  const start = BLOCK_SIZE2 * Math.floor(src32.length / BLOCK_SIZE32);
  if (start < srcLen) {
    const b32 = new Uint32Array([s0, s1, s2, s3]);
    const buf = u8(b32);
    for (let i = start, pos = 0; i < srcLen; i++, pos++)
      dst[i] = src[i] ^ buf[pos];
    clean2(b32);
  }
  return dst;
}
function computeTag(fn, isLE3, key, data, AAD) {
  const aadLength = AAD ? AAD.length : 0;
  const h = fn.create(key, data.length + aadLength);
  if (AAD)
    h.update(AAD);
  const num = u64Lengths(8 * data.length, 8 * aadLength, isLE3);
  h.update(data);
  h.update(num);
  const res = h.digest();
  clean2(num);
  return res;
}
var gcm = /* @__PURE__ */ wrapCipher({ blockSize: 16, nonceLength: 12, tagLength: 16, varSizeNonce: true }, function aesgcm(key, nonce, AAD) {
  if (nonce.length < 8)
    throw new Error("aes/gcm: invalid nonce length");
  const tagLength = 16;
  function _computeTag(authKey, tagMask, data) {
    const tag = computeTag(ghash, false, authKey, data, AAD);
    for (let i = 0; i < tagMask.length; i++)
      tag[i] ^= tagMask[i];
    return tag;
  }
  function deriveKeys() {
    const xk = expandKeyLE(key);
    const authKey = EMPTY_BLOCK.slice();
    const counter = EMPTY_BLOCK.slice();
    ctr32(xk, false, counter, counter, authKey);
    if (nonce.length === 12) {
      counter.set(nonce);
    } else {
      const nonceLen = EMPTY_BLOCK.slice();
      const view = createView3(nonceLen);
      setBigUint643(view, 8, BigInt(nonce.length * 8), false);
      const g = ghash.create(authKey).update(nonce).update(nonceLen);
      g.digestInto(counter);
      g.destroy();
    }
    const tagMask = ctr32(xk, false, counter, EMPTY_BLOCK);
    return { xk, authKey, counter, tagMask };
  }
  return {
    encrypt(plaintext) {
      const { xk, authKey, counter, tagMask } = deriveKeys();
      const out = new Uint8Array(plaintext.length + tagLength);
      const toClean = [xk, authKey, counter, tagMask];
      if (!isAligned32(plaintext))
        toClean.push(plaintext = copyBytes(plaintext));
      ctr32(xk, false, counter, plaintext, out.subarray(0, plaintext.length));
      const tag = _computeTag(authKey, tagMask, out.subarray(0, out.length - tagLength));
      toClean.push(tag);
      out.set(tag, plaintext.length);
      clean2(...toClean);
      return out;
    },
    decrypt(ciphertext) {
      const { xk, authKey, counter, tagMask } = deriveKeys();
      const toClean = [xk, authKey, tagMask, counter];
      if (!isAligned32(ciphertext))
        toClean.push(ciphertext = copyBytes(ciphertext));
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = _computeTag(authKey, tagMask, data);
      toClean.push(tag);
      if (!equalBytes(tag, passedTag))
        throw new Error("aes/gcm: invalid ghash tag");
      const out = ctr32(xk, false, counter, data);
      clean2(...toClean);
      return out;
    }
  };
});

// node_modules/borsh/lib/esm/types.js
var integers = ["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "f32", "f64"];

// node_modules/borsh/lib/esm/buffer.js
var EncodeBuffer = (
  /** @class */
  (function() {
    function EncodeBuffer2() {
      this.offset = 0;
      this.buffer_size = 256;
      this.buffer = new ArrayBuffer(this.buffer_size);
      this.view = new DataView(this.buffer);
    }
    EncodeBuffer2.prototype.resize_if_necessary = function(needed_space) {
      if (this.buffer_size - this.offset < needed_space) {
        this.buffer_size = Math.max(this.buffer_size * 2, this.buffer_size + needed_space);
        var new_buffer = new ArrayBuffer(this.buffer_size);
        new Uint8Array(new_buffer).set(new Uint8Array(this.buffer));
        this.buffer = new_buffer;
        this.view = new DataView(new_buffer);
      }
    };
    EncodeBuffer2.prototype.get_used_buffer = function() {
      return new Uint8Array(this.buffer).slice(0, this.offset);
    };
    EncodeBuffer2.prototype.store_value = function(value, type) {
      var bSize = type.substring(1);
      var size = parseInt(bSize) / 8;
      this.resize_if_necessary(size);
      var toCall = type[0] === "f" ? "setFloat".concat(bSize) : type[0] === "i" ? "setInt".concat(bSize) : "setUint".concat(bSize);
      this.view[toCall](this.offset, value, true);
      this.offset += size;
    };
    EncodeBuffer2.prototype.store_bytes = function(from) {
      this.resize_if_necessary(from.length);
      new Uint8Array(this.buffer).set(new Uint8Array(from), this.offset);
      this.offset += from.length;
    };
    return EncodeBuffer2;
  })()
);
var DecodeBuffer = (
  /** @class */
  (function() {
    function DecodeBuffer2(buf) {
      this.offset = 0;
      this.buffer_size = buf.length;
      this.buffer = new ArrayBuffer(buf.length);
      new Uint8Array(this.buffer).set(buf);
      this.view = new DataView(this.buffer);
    }
    DecodeBuffer2.prototype.assert_enough_buffer = function(size) {
      if (this.offset + size > this.buffer.byteLength) {
        throw new Error("Error in schema, the buffer is smaller than expected");
      }
    };
    DecodeBuffer2.prototype.consume_value = function(type) {
      var bSize = type.substring(1);
      var size = parseInt(bSize) / 8;
      this.assert_enough_buffer(size);
      var toCall = type[0] === "f" ? "getFloat".concat(bSize) : type[0] === "i" ? "getInt".concat(bSize) : "getUint".concat(bSize);
      var ret = this.view[toCall](this.offset, true);
      this.offset += size;
      return ret;
    };
    DecodeBuffer2.prototype.consume_bytes = function(size) {
      this.assert_enough_buffer(size);
      var ret = this.buffer.slice(this.offset, this.offset + size);
      this.offset += size;
      return ret;
    };
    return DecodeBuffer2;
  })()
);

// node_modules/borsh/lib/esm/utils.js
var __extends = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
function isArrayLike(value) {
  return Array.isArray(value) || !!value && typeof value === "object" && "length" in value && typeof value.length === "number" && (value.length === 0 || value.length > 0 && value.length - 1 in value);
}
function expect_type(value, type, fieldPath) {
  if (typeof value !== type) {
    throw new Error("Expected ".concat(type, " not ").concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
  }
}
function expect_bigint(value, fieldPath) {
  var basicType = ["number", "string", "bigint", "boolean"].includes(typeof value);
  var strObject = typeof value === "object" && value !== null && "toString" in value;
  if (!basicType && !strObject) {
    throw new Error("Expected bigint, number, boolean or string not ".concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
  }
}
function expect_same_size(length, expected, fieldPath) {
  if (length !== expected) {
    throw new Error("Array length ".concat(length, " does not match schema length ").concat(expected, " at ").concat(fieldPath.join(".")));
  }
}
function expect_enum(value, fieldPath) {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected object not ".concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
  }
}
var VALID_STRING_TYPES = integers.concat(["bool", "string"]);
var ErrorSchema = (
  /** @class */
  (function(_super) {
    __extends(ErrorSchema2, _super);
    function ErrorSchema2(schema, expected) {
      var message = "Invalid schema: ".concat(JSON.stringify(schema), " expected ").concat(expected);
      return _super.call(this, message) || this;
    }
    return ErrorSchema2;
  })(Error)
);

// node_modules/borsh/lib/esm/serialize.js
var BorshSerializer = (
  /** @class */
  (function() {
    function BorshSerializer2(checkTypes) {
      this.encoded = new EncodeBuffer();
      this.fieldPath = ["value"];
      this.checkTypes = checkTypes;
    }
    BorshSerializer2.prototype.encode = function(value, schema) {
      this.encode_value(value, schema);
      return this.encoded.get_used_buffer();
    };
    BorshSerializer2.prototype.encode_value = function(value, schema) {
      if (typeof schema === "string") {
        if (integers.includes(schema))
          return this.encode_integer(value, schema);
        if (schema === "string")
          return this.encode_string(value);
        if (schema === "bool")
          return this.encode_boolean(value);
      }
      if (typeof schema === "object") {
        if ("option" in schema)
          return this.encode_option(value, schema);
        if ("enum" in schema)
          return this.encode_enum(value, schema);
        if ("array" in schema)
          return this.encode_array(value, schema);
        if ("set" in schema)
          return this.encode_set(value, schema);
        if ("map" in schema)
          return this.encode_map(value, schema);
        if ("struct" in schema)
          return this.encode_struct(value, schema);
      }
    };
    BorshSerializer2.prototype.encode_integer = function(value, schema) {
      var size = parseInt(schema.substring(1));
      if (size <= 32 || schema == "f64") {
        this.checkTypes && expect_type(value, "number", this.fieldPath);
        this.encoded.store_value(value, schema);
      } else {
        this.checkTypes && expect_bigint(value, this.fieldPath);
        this.encode_bigint(BigInt(value), size);
      }
    };
    BorshSerializer2.prototype.encode_bigint = function(value, size) {
      var buffer_len = size / 8;
      var buffer = new Uint8Array(buffer_len);
      for (var i = 0; i < buffer_len; i++) {
        buffer[i] = Number(value & BigInt(255));
        value = value >> BigInt(8);
      }
      this.encoded.store_bytes(new Uint8Array(buffer));
    };
    BorshSerializer2.prototype.encode_string = function(value) {
      this.checkTypes && expect_type(value, "string", this.fieldPath);
      var _value = value;
      var utf8Bytes = [];
      for (var i = 0; i < _value.length; i++) {
        var charCode = _value.charCodeAt(i);
        if (charCode < 128) {
          utf8Bytes.push(charCode);
        } else if (charCode < 2048) {
          utf8Bytes.push(192 | charCode >> 6, 128 | charCode & 63);
        } else if (charCode < 55296 || charCode >= 57344) {
          utf8Bytes.push(224 | charCode >> 12, 128 | charCode >> 6 & 63, 128 | charCode & 63);
        } else {
          i++;
          charCode = 65536 + ((charCode & 1023) << 10 | _value.charCodeAt(i) & 1023);
          utf8Bytes.push(240 | charCode >> 18, 128 | charCode >> 12 & 63, 128 | charCode >> 6 & 63, 128 | charCode & 63);
        }
      }
      this.encoded.store_value(utf8Bytes.length, "u32");
      this.encoded.store_bytes(new Uint8Array(utf8Bytes));
    };
    BorshSerializer2.prototype.encode_boolean = function(value) {
      this.checkTypes && expect_type(value, "boolean", this.fieldPath);
      this.encoded.store_value(value ? 1 : 0, "u8");
    };
    BorshSerializer2.prototype.encode_option = function(value, schema) {
      if (value === null || value === void 0) {
        this.encoded.store_value(0, "u8");
      } else {
        this.encoded.store_value(1, "u8");
        this.encode_value(value, schema.option);
      }
    };
    BorshSerializer2.prototype.encode_enum = function(value, schema) {
      this.checkTypes && expect_enum(value, this.fieldPath);
      var valueKey = Object.keys(value)[0];
      for (var i = 0; i < schema["enum"].length; i++) {
        var valueSchema = schema["enum"][i];
        if (valueKey === Object.keys(valueSchema.struct)[0]) {
          this.encoded.store_value(i, "u8");
          return this.encode_struct(value, valueSchema);
        }
      }
      throw new Error("Enum key (".concat(valueKey, ") not found in enum schema: ").concat(JSON.stringify(schema), " at ").concat(this.fieldPath.join(".")));
    };
    BorshSerializer2.prototype.encode_array = function(value, schema) {
      if (isArrayLike(value))
        return this.encode_arraylike(value, schema);
      if (value instanceof ArrayBuffer)
        return this.encode_buffer(value, schema);
      throw new Error("Expected Array-like not ".concat(typeof value, "(").concat(value, ") at ").concat(this.fieldPath.join(".")));
    };
    BorshSerializer2.prototype.encode_arraylike = function(value, schema) {
      if (schema.array.len) {
        expect_same_size(value.length, schema.array.len, this.fieldPath);
      } else {
        this.encoded.store_value(value.length, "u32");
      }
      for (var i = 0; i < value.length; i++) {
        this.encode_value(value[i], schema.array.type);
      }
    };
    BorshSerializer2.prototype.encode_buffer = function(value, schema) {
      if (schema.array.len) {
        expect_same_size(value.byteLength, schema.array.len, this.fieldPath);
      } else {
        this.encoded.store_value(value.byteLength, "u32");
      }
      this.encoded.store_bytes(new Uint8Array(value));
    };
    BorshSerializer2.prototype.encode_set = function(value, schema) {
      this.checkTypes && expect_type(value, "object", this.fieldPath);
      var isSet = value instanceof Set;
      var values = isSet ? Array.from(value.values()) : Object.values(value);
      this.encoded.store_value(values.length, "u32");
      for (var _i = 0, values_1 = values; _i < values_1.length; _i++) {
        var value_1 = values_1[_i];
        this.encode_value(value_1, schema.set);
      }
    };
    BorshSerializer2.prototype.encode_map = function(value, schema) {
      this.checkTypes && expect_type(value, "object", this.fieldPath);
      var isMap = value instanceof Map;
      var keys = isMap ? Array.from(value.keys()) : Object.keys(value);
      this.encoded.store_value(keys.length, "u32");
      for (var _i = 0, keys_1 = keys; _i < keys_1.length; _i++) {
        var key = keys_1[_i];
        this.encode_value(key, schema.map.key);
        this.encode_value(isMap ? value.get(key) : value[key], schema.map.value);
      }
    };
    BorshSerializer2.prototype.encode_struct = function(value, schema) {
      this.checkTypes && expect_type(value, "object", this.fieldPath);
      for (var _i = 0, _a = Object.keys(schema.struct); _i < _a.length; _i++) {
        var key = _a[_i];
        this.fieldPath.push(key);
        this.encode_value(value[key], schema.struct[key]);
        this.fieldPath.pop();
      }
    };
    return BorshSerializer2;
  })()
);

// node_modules/borsh/lib/esm/deserialize.js
var BorshDeserializer = (
  /** @class */
  (function() {
    function BorshDeserializer2(bufferArray) {
      this.buffer = new DecodeBuffer(bufferArray);
    }
    BorshDeserializer2.prototype.decode = function(schema) {
      return this.decode_value(schema);
    };
    BorshDeserializer2.prototype.decode_value = function(schema) {
      if (typeof schema === "string") {
        if (integers.includes(schema))
          return this.decode_integer(schema);
        if (schema === "string")
          return this.decode_string();
        if (schema === "bool")
          return this.decode_boolean();
      }
      if (typeof schema === "object") {
        if ("option" in schema)
          return this.decode_option(schema);
        if ("enum" in schema)
          return this.decode_enum(schema);
        if ("array" in schema)
          return this.decode_array(schema);
        if ("set" in schema)
          return this.decode_set(schema);
        if ("map" in schema)
          return this.decode_map(schema);
        if ("struct" in schema)
          return this.decode_struct(schema);
      }
      throw new Error("Unsupported type: ".concat(schema));
    };
    BorshDeserializer2.prototype.decode_integer = function(schema) {
      var size = parseInt(schema.substring(1));
      if (size <= 32 || schema == "f64") {
        return this.buffer.consume_value(schema);
      }
      return this.decode_bigint(size, schema.startsWith("i"));
    };
    BorshDeserializer2.prototype.decode_bigint = function(size, signed) {
      if (signed === void 0) {
        signed = false;
      }
      var buffer_len = size / 8;
      var buffer = new Uint8Array(this.buffer.consume_bytes(buffer_len));
      var bits = buffer.reduceRight(function(r, x) {
        return r + x.toString(16).padStart(2, "0");
      }, "");
      if (signed && buffer[buffer_len - 1]) {
        return BigInt.asIntN(size, BigInt("0x".concat(bits)));
      }
      return BigInt("0x".concat(bits));
    };
    BorshDeserializer2.prototype.decode_string = function() {
      var len = this.decode_integer("u32");
      var buffer = new Uint8Array(this.buffer.consume_bytes(len));
      var codePoints = [];
      for (var i = 0; i < len; ++i) {
        var byte = buffer[i];
        if (byte < 128) {
          codePoints.push(byte);
        } else if (byte < 224) {
          codePoints.push((byte & 31) << 6 | buffer[++i] & 63);
        } else if (byte < 240) {
          codePoints.push((byte & 15) << 12 | (buffer[++i] & 63) << 6 | buffer[++i] & 63);
        } else {
          var codePoint = (byte & 7) << 18 | (buffer[++i] & 63) << 12 | (buffer[++i] & 63) << 6 | buffer[++i] & 63;
          codePoints.push(codePoint);
        }
      }
      return String.fromCodePoint.apply(String, codePoints);
    };
    BorshDeserializer2.prototype.decode_boolean = function() {
      return this.buffer.consume_value("u8") > 0;
    };
    BorshDeserializer2.prototype.decode_option = function(schema) {
      var option = this.buffer.consume_value("u8");
      if (option === 1) {
        return this.decode_value(schema.option);
      }
      if (option !== 0) {
        throw new Error("Invalid option ".concat(option));
      }
      return null;
    };
    BorshDeserializer2.prototype.decode_enum = function(schema) {
      var _a;
      var valueIndex = this.buffer.consume_value("u8");
      if (valueIndex > schema["enum"].length) {
        throw new Error("Enum option ".concat(valueIndex, " is not available"));
      }
      var struct = schema["enum"][valueIndex].struct;
      var key = Object.keys(struct)[0];
      return _a = {}, _a[key] = this.decode_value(struct[key]), _a;
    };
    BorshDeserializer2.prototype.decode_array = function(schema) {
      var result = [];
      var len = schema.array.len ? schema.array.len : this.decode_integer("u32");
      for (var i = 0; i < len; ++i) {
        result.push(this.decode_value(schema.array.type));
      }
      return result;
    };
    BorshDeserializer2.prototype.decode_set = function(schema) {
      var len = this.decode_integer("u32");
      var result = /* @__PURE__ */ new Set();
      for (var i = 0; i < len; ++i) {
        result.add(this.decode_value(schema.set));
      }
      return result;
    };
    BorshDeserializer2.prototype.decode_map = function(schema) {
      var len = this.decode_integer("u32");
      var result = /* @__PURE__ */ new Map();
      for (var i = 0; i < len; ++i) {
        var key = this.decode_value(schema.map.key);
        var value = this.decode_value(schema.map.value);
        result.set(key, value);
      }
      return result;
    };
    BorshDeserializer2.prototype.decode_struct = function(schema) {
      var result = {};
      for (var key in schema.struct) {
        result[key] = this.decode_value(schema.struct[key]);
      }
      return result;
    };
    return BorshDeserializer2;
  })()
);

// node_modules/@turnkey/crypto/dist/math.mjs
var modSqrt = (x, p) => {
  if (p <= BigInt(0)) {
    throw new Error("p must be positive");
  }
  const base2 = x % p;
  if (testBit(p, 0) && testBit(p, 1)) {
    const q = p + BigInt(1) >> BigInt(2);
    const squareRoot = modPow(base2, q, p);
    if (squareRoot * squareRoot % p !== base2) {
      throw new Error("could not find a modular square root");
    }
    return squareRoot;
  }
  throw new Error("unsupported modulus value");
};
var testBit = (n, i) => {
  const m = BigInt(1) << BigInt(i);
  return (n & m) !== BigInt(0);
};
var modPow = (b, exp, p) => {
  if (exp === BigInt(0)) {
    return BigInt(1);
  }
  let result = b % p;
  const exponentBitString = exp.toString(2);
  for (let i = 1; i < exponentBitString.length; ++i) {
    result = result * result % p;
    if (exponentBitString[i] === "1") {
      result = result * b % p;
    }
  }
  return result;
};

// node_modules/@turnkey/crypto/dist/crypto.mjs
var getPublicKey = (privateKey, isCompressed = true) => {
  return p2562.getPublicKey(privateKey, isCompressed);
};
var hpkeEncrypt = ({ plainTextBuf, targetKeyBuf }) => {
  try {
    const ephemeralKeyPair = generateP256KeyPair();
    const senderPrivBuf = uint8ArrayFromHexString(ephemeralKeyPair.privateKey);
    const senderPubBuf = uint8ArrayFromHexString(ephemeralKeyPair.publicKeyUncompressed);
    const aad = buildAdditionalAssociatedData(senderPubBuf, targetKeyBuf);
    const ss = deriveSS(targetKeyBuf, uint8ArrayToHexString(senderPrivBuf));
    const kemContext = getKemContext(senderPubBuf, uint8ArrayToHexString(targetKeyBuf));
    let ikm = buildLabeledIkm(LABEL_EAE_PRK, ss, SUITE_ID_1);
    let info = buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, SUITE_ID_1, 32);
    const sharedSecret = extractAndExpand(new Uint8Array([]), ikm, info, 32);
    ikm = buildLabeledIkm(LABEL_SECRET, new Uint8Array([]), SUITE_ID_2);
    info = AES_KEY_INFO;
    const key = extractAndExpand(sharedSecret, ikm, info, 32);
    info = IV_INFO;
    const iv = extractAndExpand(sharedSecret, ikm, info, 12);
    const encryptedData = aesGcmEncrypt(plainTextBuf, key, iv, aad);
    const compressedSenderBuf = compressRawPublicKey(senderPubBuf);
    const result = new Uint8Array(compressedSenderBuf.length + encryptedData.length);
    result.set(compressedSenderBuf, 0);
    result.set(encryptedData, compressedSenderBuf.length);
    return result;
  } catch (error) {
    throw new Error(`Unable to perform hpkeEncrypt: ${error}`);
  }
};
var formatHpkeBuf = (encryptedBuf) => {
  const compressedSenderBuf = encryptedBuf.slice(0, 33);
  const encryptedData = encryptedBuf.slice(33);
  const encappedKeyBufHex = uint8ArrayToHexString(uncompressRawPublicKey(compressedSenderBuf));
  const ciphertextHex = uint8ArrayToHexString(encryptedData);
  return JSON.stringify({
    encappedPublic: encappedKeyBufHex,
    ciphertext: ciphertextHex
  });
};
var generateP256KeyPair = () => {
  const privateKey = randomBytes(32);
  const publicKey = getPublicKey(privateKey, true);
  const publicKeyUncompressed = uint8ArrayToHexString(uncompressRawPublicKey(publicKey));
  return {
    privateKey: uint8ArrayToHexString(privateKey),
    publicKey: uint8ArrayToHexString(publicKey),
    publicKeyUncompressed
  };
};
var buildAdditionalAssociatedData = (senderPubBuf, receiverPubBuf) => {
  return new Uint8Array([
    ...Array.from(senderPubBuf),
    ...Array.from(receiverPubBuf)
  ]);
};
var compressRawPublicKey = (rawPublicKey) => {
  const len = rawPublicKey.byteLength;
  var compressedBytes = rawPublicKey.slice(0, 1 + len >>> 1);
  compressedBytes[0] = 2 | rawPublicKey[len - 1] & 1;
  return compressedBytes;
};
var uncompressRawPublicKey = (rawPublicKey, curve = "CURVE_P256") => {
  if (rawPublicKey.length !== 33) {
    throw new Error("failed to uncompress raw public key: invalid length");
  }
  if (!(rawPublicKey[0] === 2 || rawPublicKey[0] === 3)) {
    throw new Error("failed to uncompress raw public key: invalid prefix");
  }
  const lsb = rawPublicKey[0] === 3;
  const x = BigInt("0x" + uint8ArrayToHexString(rawPublicKey.subarray(1)));
  let p, a, b;
  if (curve === "CURVE_P256") {
    p = BigInt("115792089210356248762697446949407573530086143415290314195533631308867097853951");
    b = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
    a = p - BigInt(3);
  } else {
    p = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
    a = BigInt(0);
    b = BigInt(7);
  }
  const rhs = ((x * x + a) * x + b) % p;
  let y = modSqrt(rhs, p);
  if (lsb !== testBit(y, 0)) {
    y = (p - y) % p;
  }
  if (x < BigInt(0) || x >= p) {
    throw new Error("x is out of range");
  }
  if (y < BigInt(0) || y >= p) {
    throw new Error("y is out of range");
  }
  var uncompressedHexString = "04" + bigIntToHex(x, 64) + bigIntToHex(y, 64);
  return uint8ArrayFromHexString(uncompressedHexString);
};
var buildLabeledIkm = (label, ikm, suiteId) => {
  const combinedLength = HPKE_VERSION.length + suiteId.length + label.length + ikm.length;
  const ret = new Uint8Array(combinedLength);
  let offset = 0;
  ret.set(HPKE_VERSION, offset);
  offset += HPKE_VERSION.length;
  ret.set(suiteId, offset);
  offset += suiteId.length;
  ret.set(label, offset);
  offset += label.length;
  ret.set(ikm, offset);
  return ret;
};
var buildLabeledInfo = (label, info, suiteId, len) => {
  const suiteIdStartIndex = 9;
  const ret = new Uint8Array(suiteIdStartIndex + suiteId.byteLength + label.byteLength + info.byteLength);
  ret.set(new Uint8Array([0, len]), 0);
  ret.set(HPKE_VERSION, 2);
  ret.set(suiteId, suiteIdStartIndex);
  ret.set(label, suiteIdStartIndex + suiteId.byteLength);
  ret.set(info, suiteIdStartIndex + suiteId.byteLength + label.byteLength);
  return ret;
};
var extractAndExpand = (sharedSecret, ikm, info, len) => {
  const prk = extract(sha2563, ikm, sharedSecret);
  const resp = expand(sha2563, prk, info, len);
  return new Uint8Array(resp);
};
var deriveSS = (encappedKeyBuf, priv) => {
  const ss = p2562.getSharedSecret(uint8ArrayFromHexString(priv), encappedKeyBuf);
  return ss.slice(1);
};
var aesGcmEncrypt = (plainTextData, key, iv, aad) => {
  const aes = gcm(key, iv, aad);
  const data = aes.encrypt(plainTextData);
  return data;
};
var getKemContext = (encappedKeyBuf, publicKey) => {
  const encappedKeyArray = new Uint8Array(encappedKeyBuf);
  const publicKeyArray = uint8ArrayFromHexString(publicKey);
  const kemContext = new Uint8Array(encappedKeyArray.length + publicKeyArray.length);
  kemContext.set(encappedKeyArray);
  kemContext.set(publicKeyArray, encappedKeyArray.length);
  return kemContext;
};
var bigIntToHex = (num, length) => {
  const hexString = num.toString(16);
  if (hexString.length > length) {
    throw new Error(`number cannot fit in a hex string of ${length} characters`);
  }
  return hexString.padStart(length, "0");
};
var fromDerSignature = (derSignature) => {
  const derSignatureBuf = uint8ArrayFromHexString(derSignature);
  if (derSignatureBuf.length < 2) {
    throw new Error("failed to convert DER-encoded signature: insufficient length");
  }
  if (derSignatureBuf[0] !== 48) {
    throw new Error("failed to convert DER-encoded signature: invalid format (missing SEQUENCE tag)");
  }
  let index = 1;
  const lengthByte = derSignatureBuf[index];
  if (lengthByte <= 127) {
    if (derSignatureBuf.length < 1 + 1 + lengthByte) {
      throw new Error("failed to convert DER-encoded signature: inconsistent message length header");
    }
    index += 1;
  } else {
    throw new Error("failed to convert DER-encoded signature: unexpectedly large or invalid signature length");
  }
  if (derSignatureBuf[index] !== 2) {
    throw new Error("failed to convert DER-encoded signature: invalid tag for r");
  }
  index++;
  const rLength = derSignatureBuf[index];
  if (rLength > 33) {
    throw new Error("failed to convert DER-encoded signature: unexpected length for r");
  }
  index++;
  const r = derSignatureBuf.slice(index, index + rLength);
  index += rLength;
  if (derSignatureBuf[index] !== 2) {
    throw new Error("failed to convert DER-encoded signature: invalid tag for s");
  }
  index++;
  const sLength = derSignatureBuf[index];
  if (sLength > 33) {
    throw new Error("failed to convert DER-encoded signature: unexpected length for s");
  }
  index++;
  const s = derSignatureBuf.slice(index, index + sLength);
  const rPadded = normalizePadding(r, 32);
  const sPadded = normalizePadding(s, 32);
  return new Uint8Array([...rPadded, ...sPadded]);
};

// node_modules/@turnkey/crypto/dist/turnkey.mjs
var Enclave;
(function(Enclave2) {
  Enclave2["NOTARIZER"] = "notarizer";
  Enclave2["SIGNER"] = "signer";
  Enclave2["EVM_PARSER"] = "evm-parser";
  Enclave2["TLS_FETCHER"] = "tls-fetcher";
  Enclave2["UMP"] = "ump";
})(Enclave || (Enclave = {}));
var verifyEnclaveSignature = async (enclaveQuorumPublic, publicSignature, signedData, dangerouslyOverrideSignerPublicKey) => {
  const expectedSignerPublicKey = dangerouslyOverrideSignerPublicKey || PRODUCTION_SIGNER_SIGN_PUBLIC_KEY;
  if (enclaveQuorumPublic != expectedSignerPublicKey) {
    throw new Error(`expected signer key ${dangerouslyOverrideSignerPublicKey ?? PRODUCTION_SIGNER_SIGN_PUBLIC_KEY} does not match signer key from bundle: ${enclaveQuorumPublic}`);
  }
  const encryptionQuorumPublicBuf = new Uint8Array(uint8ArrayFromHexString(enclaveQuorumPublic));
  const quorumKey = loadPublicKey(encryptionQuorumPublicBuf);
  if (!quorumKey) {
    throw new Error("failed to load quorum key");
  }
  const publicSignatureBuf = fromDerSignature(publicSignature);
  const signedDataBuf = uint8ArrayFromHexString(signedData);
  const hashedData = sha2563(signedDataBuf);
  return p2562.verify(publicSignatureBuf, hashedData, quorumKey.toHex());
};
var loadPublicKey = (publicKey) => {
  return p2562.ProjectivePoint.fromHex(uint8ArrayToHexString(publicKey));
};
var encryptOtpCodeToBundle = async (otpCode, otpEncryptionTargetBundle, publicKey, dangerouslyOverrideSignerPublicKey) => {
  const parsedBundle = JSON.parse(otpEncryptionTargetBundle);
  const verified = await verifyEnclaveSignature(parsedBundle.enclaveQuorumPublic, parsedBundle.dataSignature, parsedBundle.data, dangerouslyOverrideSignerPublicKey ?? PRODUCTION_TLS_FETCHER_SIGN_PUBLIC_KEY);
  if (!verified) {
    throw new Error("OTP encryption target bundle signature verification failed");
  }
  const signedData = JSON.parse(new TextDecoder().decode(uint8ArrayFromHexString(parsedBundle.data)));
  const targetKeyBuf = uint8ArrayFromHexString(signedData.targetPublic);
  const plainTextBuf = new TextEncoder().encode(JSON.stringify({ otp_code: otpCode, public_key: publicKey }));
  const encryptedBuf = hpkeEncrypt({ plainTextBuf, targetKeyBuf });
  return formatHpkeBuf(encryptedBuf);
};
export {
  IndexedDbStamper,
  WebauthnStamper,
  encryptOtpCodeToBundle
};
