/**
 * Device-key tests (headless).
 *
 * Covers the parts of services/api/public/device.js that don't need a real
 * authenticator: EIP-712 digest parity with viem, signature recovery, and
 * the passkey-PRF wrapping of the key at rest. The PRF secret is injected
 * directly here — a real authenticator produces it, but the AES-GCM/HKDF
 * envelope it feeds is exactly this code path.
 *
 * What this canNOT prove, and needs a real browser: that the authenticator
 * returns a PRF result at all, and that it returns the SAME 32 bytes across
 * ceremonies (if it didn't, the key would be unrecoverable after reload).
 *
 * Run: npm run device-key:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Browser globals device.js expects. localStorage is the only real stand-in;
// crypto.subtle and crypto.getRandomValues come from node's WebCrypto.
const slots = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => slots.get(k) ?? null,
  setItem: (k: string, v: string) => slots.set(k, v),
  removeItem: (k: string) => slots.delete(k),
};
// Default: a WebAuthn browser whose authenticator answers without PRF. Tests
// that need another answer swap `get` with withAuthenticator.
const noPrf = () => Promise.resolve({ getClientExtensionResults: () => ({}) });
(globalThis as any).window = { PublicKeyCredential: function () {} };
const setGet = (get: (opts: any) => Promise<unknown>) =>
  Object.defineProperty(globalThis, "navigator", { value: { credentials: { get } }, configurable: true, writable: true });
setGet(noPrf);
const withAuthenticator = async (get: (opts: any) => Promise<unknown>, fn: () => Promise<void>) => {
  setGet(get);
  try { await fn(); } finally { setGet(noPrf); }
};
(globalThis as any).btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
(globalThis as any).atob = (s: string) => Buffer.from(s, "base64").toString("binary");

const dev = await import(path.join(ROOT, "services/api/public/device.js"));

const CRED = "Y3JlZC1h"; // base64url credential id
const CRED_B = "Y3JlZC1i";
const SLOT = `zold-device-key:${CRED}`;

let pass = 0;
const t = async (label: string, fn: () => Promise<void> | void) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

const TYPED_DATA = {
  domain: {
    name: "TransF Safe Transfer",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x1111111111111111111111111111111111111111",
  },
  types: {
    PaymentAuthorization: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
      { name: "transferId", type: "bytes32" },
      { name: "destination", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "PaymentAuthorization",
  message: {
    account: "0x1111111111111111111111111111111111111111",
    amount: "100000000000000000000",
    to: "0x2222222222222222222222222222222222222222",
    transferId: `0x${"ab".repeat(32)}`,
    destination: `0x${"cd".repeat(32)}`,
    deadline: 1790000000,
  },
} as const;

const viemDigest = hashTypedData({
  ...(TYPED_DATA as any),
  message: { ...TYPED_DATA.message, amount: 100000000000000000000n, deadline: 1790000000n },
});

console.log("EIP-712:");
await t("digest matches viem byte for byte", () => {
  const ours = `0x${Buffer.from(dev.eip712Digest(TYPED_DATA)).toString("hex")}`;
  assert.equal(ours, viemDigest);
});

console.log("device key — unprotected fallback (no PRF authenticator):");
await t("createKey mints a key and reports protection: none", async () => {
  const { address, protection } = await dev.createKey(CRED);
  assert.equal(protection, "none");
  assert.match(address, /^0x[0-9a-f]{40}$/);
});

await t("signature recovers to the device address", async () => {
  const address = await dev.deviceAddress(CRED);
  const sig = await dev.signTypedData(TYPED_DATA, CRED);
  assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), address);
});

await t("address derivation matches viem for the same key", async () => {
  const blob = JSON.parse(slots.get(SLOT)!);
  assert.equal(privateKeyToAccount(blob.key).address.toLowerCase(), (await dev.deviceAddress(CRED)).toLowerCase());
});

console.log("device key — passkey-wrapped at rest (PRF):");
const PRF_SECRET = new Uint8Array(32).fill(7);
const WRONG_SECRET = new Uint8Array(32).fill(9);

await t("wrap/unwrap round-trips with the same PRF secret", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const blob = await dev.wrapKey(priv, PRF_SECRET);
  assert.equal(blob.protection, "prf");
  assert.equal(await dev.unwrapKey(blob, PRF_SECRET), priv);
});

await t("the wrapped blob does not contain the key", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const blob = await dev.wrapKey(priv, PRF_SECRET);
  assert.ok(!JSON.stringify(blob).includes("11".repeat(32)), "plaintext key leaked into storage blob");
  assert.equal(blob.key, undefined);
});

await t("a different PRF secret cannot unwrap it", async () => {
  const blob = await dev.wrapKey(`0x${"11".repeat(32)}`, PRF_SECRET);
  await assert.rejects(() => dev.unwrapKey(blob, WRONG_SECRET));
});

await t("each wrap uses a fresh IV", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const a = await dev.wrapKey(priv, PRF_SECRET);
  const b = await dev.wrapKey(priv, PRF_SECRET);
  assert.notEqual(a.iv, b.iv, "IV reused across wraps");
  assert.notEqual(a.ct, b.ct, "identical ciphertext implies a fixed IV");
});

await t("a PRF-wrapped key refuses to sign without the passkey", async () => {
  const priv = `0x${"11".repeat(32)}`;
  slots.set(SLOT, JSON.stringify({
    ...(await dev.wrapKey(priv, PRF_SECRET)),
    address: privateKeyToAccount(priv as `0x${string}`).address.toLowerCase(),
  }));
  // The default authenticator answers without PRF, so prfSecret() returns null — the
  // same path a browser takes when the ceremony is cancelled or unavailable.
  await assert.rejects(
    () => dev.signTypedData(TYPED_DATA, CRED),
    /passkey is needed/,
    "a locked key must not sign without the authenticator",
  );
});

await t("the cached address is readable while the key stays locked", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const expected = privateKeyToAccount(priv as `0x${string}`).address.toLowerCase();
  assert.equal(await dev.deviceAddress(CRED), expected);
});

console.log("device key — strict mode and damaged records:");
await t("strict createKey refuses a key the passkey cannot protect, and stores nothing", async () => {
  slots.clear();
  await assert.rejects(() => dev.createKey(CRED, { requirePrf: true }), /PRF/);
  assert.equal(dev.keyStatus(CRED).present, false);
});

await t("strict deviceAddress never mints an unprotected key just to report an address", async () => {
  slots.clear();
  await assert.rejects(() => dev.deviceAddress(CRED, { requirePrf: true }), /PRF/);
  assert.equal(dev.keyStatus(CRED).present, false);
});

await t("a damaged record is reported present and unusable, and left exactly as it was", async () => {
  slots.clear();
  slots.set(SLOT, "{not json");
  assert.deepEqual(dev.keyStatus(CRED), { present: true, protection: null, damaged: true });
  await assert.rejects(() => dev.createKey(CRED), /already/);
  await assert.rejects(() => dev.deviceAddress(CRED), /damaged/);
  await assert.rejects(() => dev.signTypedData(TYPED_DATA, CRED), /damaged/);
  assert.equal(slots.get(SLOT), "{not json");
});

await t("a damaged record is replaced only when the caller says no key is bound", async () => {
  const { address } = await dev.createKey(CRED, { replaceDamaged: true });
  assert.match(address, /^0x[0-9a-f]{40}$/);
  assert.equal(dev.keyStatus(CRED).damaged, undefined);
});

await t("a readable stored key is never replaced", async () => {
  const before = slots.get(SLOT);
  await assert.rejects(() => dev.createKey(CRED), /already/);
  await assert.rejects(() => dev.createKey(CRED, { replaceDamaged: true }), /already/);
  assert.equal(slots.get(SLOT), before);
});

await t("onboarding makes a key only when this browser lacks the bound one, and replaces a damaged record", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(path.join(ROOT, "services/api/public/app/onboarding.js"), "utf8");
  const fn = src.slice(src.indexOf("async function registerDeviceKey"), src.indexOf("async function registerDeviceKey") + 1200);
  assert.match(fn, /bound = u\.authorizerAddress/);
  assert.match(fn, /if \(dev\.holdsKey\(credId\(\), bound\)\) return u;/);
  assert.match(fn, /keyStatus\(credId\(\), bound\)/);
  assert.match(fn, /replaceDamaged = !!status\.damaged;/);
  assert.match(fn, /status\.present && !replaceDamaged && !bound/);
  assert.match(fn, /createKey\(credId\(\), \{ replaceDamaged, staleFor: bound \}\)/);
  assert.match(fn, /if \(bound && address\.toLowerCase\(\) === bound\.toLowerCase\(\)\) return u;/);
  // Send makes sure of the key before the transfer exists.
  for (const file of ["send.js", "phone-send.js"]) {
    const send = readFileSync(path.join(ROOT, "services/api/public/app", file), "utf8");
    const ensure = send.indexOf("await registerDeviceKey(user);");
    assert.ok(ensure > 0 && ensure < send.indexOf('api("/api/transfers"'), file);
  }
});

await t("createKey without a passkey credential refuses and stores nothing", async () => {
  slots.clear();
  await assert.rejects(() => dev.createKey(null), /passkey is needed/);
  assert.equal(slots.size, 0);
});

console.log("device key — one slot per passkey credential:");
await t("two credentials in one browser keep two keys", async () => {
  slots.clear();
  const a = await dev.createKey(CRED);
  const b = await dev.createKey(CRED_B);
  assert.notEqual(a.address, b.address);
  assert.equal(await dev.deviceAddress(CRED), a.address);
  assert.equal(await dev.deviceAddress(CRED_B), b.address);
  assert.equal(JSON.parse(slots.get(`zold-device-key:${CRED_B}`)!).credentialId, CRED_B);
  const sig = await dev.signTypedData(TYPED_DATA, CRED_B);
  assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), b.address);
});

const LEGACY_PRIV = `0x${"22".repeat(32)}`;
const LEGACY_ADDR = privateKeyToAccount(LEGACY_PRIV as `0x${string}`).address;

await t("a legacy unscoped key loads for the account bound to it, and is carried forward", async () => {
  slots.clear();
  slots.set("zoll-device-key", JSON.stringify({ v: 1, protection: "none", key: LEGACY_PRIV, address: LEGACY_ADDR.toLowerCase() }));
  assert.equal(dev.keyStatus(CRED, LEGACY_ADDR).present, true);
  assert.equal(JSON.parse(slots.get(SLOT)!).key, LEGACY_PRIV);
  assert.equal(await dev.deviceAddress(CRED), LEGACY_ADDR.toLowerCase());
  const sig = await dev.signTypedData(TYPED_DATA, CRED);
  assert.equal(await recoverAddress({ hash: viemDigest, signature: sig }), LEGACY_ADDR);
  // Copied, not moved: another account this browser bound to the same key keeps it.
  assert.ok(slots.get("zold-device-key"));
  assert.equal(slots.get("zoll-device-key"), undefined);
});

await t("a pre-PRF plaintext legacy key loads for its bound account", async () => {
  slots.clear();
  slots.set("zold-device-key", LEGACY_PRIV);
  assert.equal(await dev.deviceAddress(CRED, { bound: LEGACY_ADDR }), LEGACY_ADDR.toLowerCase());
});

await t("a new account in the same browser never picks up the legacy key", async () => {
  slots.clear();
  slots.set("zold-device-key", JSON.stringify({ v: 1, protection: "none", key: LEGACY_PRIV, address: LEGACY_ADDR.toLowerCase() }));
  assert.equal(dev.keyStatus(CRED_B).present, false);
  assert.equal(dev.keyStatus(CRED_B, `0x${"33".repeat(20)}`).present, false);
  const { address } = await dev.createKey(CRED_B);
  assert.notEqual(address, LEGACY_ADDR.toLowerCase());
  // The first account still finds its key.
  assert.equal(await dev.deviceAddress(CRED, { bound: LEGACY_ADDR }), LEGACY_ADDR.toLowerCase());
});

await t("a legacy key is refused for an account bound to a different address", async () => {
  slots.clear();
  slots.set("zold-device-key", JSON.stringify({ v: 1, protection: "none", key: LEGACY_PRIV, address: LEGACY_ADDR.toLowerCase() }));
  const other = `0x${"44".repeat(20)}`;
  assert.equal(dev.keyStatus(CRED, other).present, false);
  await assert.rejects(() => dev.signTypedData(TYPED_DATA, CRED, other), /no device key/);
  assert.equal(slots.get(SLOT), undefined);
});

await t("a bound account with no key here is refused, and no stray key is minted", async () => {
  slots.clear();
  await assert.rejects(() => dev.deviceAddress(CRED, { bound: LEGACY_ADDR }), /not set up in this browser/);
  slots.set("zold-device-key", "{not json");
  await assert.rejects(() => dev.deviceAddress(CRED, { bound: LEGACY_ADDR }), /not set up in this browser/);
  assert.equal(slots.get(SLOT), undefined);
});

await t("a malformed legacy key reads as absent", async () => {
  slots.clear();
  slots.set("zold-device-key", JSON.stringify({ v: 1, protection: "none", key: "not hex" }));
  assert.equal(dev.keyStatus(CRED, LEGACY_ADDR).present, false);
});

await t("a damaged legacy record reads as absent for a bound account", async () => {
  slots.clear();
  slots.set("zold-device-key", "{not json");
  assert.deepEqual(dev.keyStatus(CRED, LEGACY_ADDR), { present: false, protection: null });
  assert.equal(slots.get(SLOT), undefined);
  assert.equal(slots.get("zold-device-key"), "{not json");
});

await t("a legacy record with neither key nor address reads as absent", async () => {
  slots.clear();
  slots.set("zold-device-key", JSON.stringify({ v: 1, protection: "prf", iv: "AA==", ct: "AA==" }));
  assert.equal(dev.keyStatus(CRED, LEGACY_ADDR).present, false);
});

await t("a browser without WebAuthn stores no key at all", async () => {
  slots.clear();
  const pkc = (globalThis as any).window.PublicKeyCredential;
  delete (globalThis as any).window.PublicKeyCredential;
  try {
    await assert.rejects(() => dev.createKey(CRED), /cannot use passkeys/);
    await assert.rejects(() => dev.deviceAddress(CRED), /cannot use passkeys/);
  } finally {
    (globalThis as any).window.PublicKeyCredential = pkc;
  }
  assert.equal(slots.size, 0);
});

await t("the PRF prompt allows as long as the app's other passkey prompts", async () => {
  slots.clear();
  let timeout = 0;
  await withAuthenticator((opts) => { timeout = opts.publicKey.timeout; return noPrf(); }, async () => { await dev.createKey(CRED); });
  assert.equal(timeout, 120000);
});

console.log("device key — a cancelled or timed-out passkey prompt:");
const realSetTimeout = globalThis.setTimeout;
const CANCELLED = /cancelled or timed out\. Nothing was stored/;
const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

await t("cancel (NotAllowedError) rethrows and stores nothing", async () => {
  slots.clear();
  await withAuthenticator(
    () => Promise.reject(new DOMException("The operation was cancelled.", "NotAllowedError")),
    async () => {
      await assert.rejects(() => dev.createKey(CRED), (e: any) => CANCELLED.test(e.message) && e.cause?.name === "NotAllowedError");
      await assert.rejects(() => dev.deviceAddress(CRED), CANCELLED);
    },
  );
  assert.equal(slots.size, 0);
});

await t("timeout aborts the pending prompt, rethrows and stores nothing", async () => {
  slots.clear();
  let signal: AbortSignal | undefined;
  (globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
  try {
    await withAuthenticator(
      // Like a browser: pending until aborted, then rejects with AbortError.
      (opts) => {
        signal = opts.signal;
        return new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      },
      async () => { await assert.rejects(() => dev.createKey(CRED), CANCELLED); },
    );
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }
  await new Promise((r) => realSetTimeout(r, 10));
  assert.equal(signal?.aborted, true);
  assert.equal(slots.size, 0);
  assert.deepEqual(unhandled, [], "the aborted prompt's rejection went unhandled");
});

await t("an assertion that succeeds without PRF still stores the key unprotected", async () => {
  slots.clear();
  await withAuthenticator(
    () => Promise.resolve({ getClientExtensionResults: () => ({}) }),
    async () => { assert.equal((await dev.createKey(CRED)).protection, "none"); },
  );
  assert.equal(dev.keyStatus(CRED).protection, "none");
});

await t("an assertion with PRF stores the key wrapped", async () => {
  slots.clear();
  await withAuthenticator(
    () => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: PRF_SECRET.buffer } } }) }),
    async () => {
      const { address, protection } = await dev.createKey(CRED);
      assert.equal(protection, "prf");
      const sig = await dev.signTypedData(TYPED_DATA, CRED);
      assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), address);
    },
  );
});

await t("two credentials with PRF keep two keys, and B's secret cannot unwrap A's", async () => {
  slots.clear();
  const SECRET_B = new Uint8Array(32).fill(5);
  const secretFor = (opts: any) => (Buffer.from(opts.publicKey.allowCredentials[0].id).toString() === "cred-a" ? PRF_SECRET : SECRET_B);
  await withAuthenticator(
    (opts) => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: secretFor(opts).buffer } } }) }),
    async () => {
      const a = await dev.createKey(CRED);
      const b = await dev.createKey(CRED_B);
      assert.equal(a.protection, "prf");
      assert.equal(b.protection, "prf");
      assert.notEqual(a.address, b.address);
      assert.equal(JSON.parse(slots.get(SLOT)!).ct, undefined, "a derived key stores no key material");
      const sigB = await dev.signTypedData(TYPED_DATA, CRED_B);
      assert.equal((await recoverAddress({ hash: viemDigest, signature: sigB })).toLowerCase(), b.address);
    },
  );
});

await t("a derived key comes back from the same passkey after the browser forgets it", async () => {
  slots.clear();
  const answer = (secret: Uint8Array) => () => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: secret.buffer } } }) });
  let first = "";
  await withAuthenticator(answer(PRF_SECRET), async () => {
    first = (await dev.createKey(CRED)).address;
    const stored = JSON.parse(slots.get(SLOT)!);
    assert.deepEqual([stored.v, stored.derived, stored.key, stored.ct], [2, true, undefined, undefined]);
    assert.equal(dev.holdsKey(CRED, first), true);
    assert.equal(dev.holdsKey(CRED, `0x${"44".repeat(20)}`), false);
    slots.clear();
    assert.equal(dev.holdsKey(CRED, first), false);
    assert.equal((await dev.createKey(CRED)).address, first, "same passkey, same key");
    const sig = await dev.signTypedData(TYPED_DATA, CRED, first);
    assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), first);
  });
  await withAuthenticator(answer(new Uint8Array(32).fill(9)), async () => {
    await assert.rejects(() => dev.signTypedData(TYPED_DATA, CRED, first), /could not unlock/);
  });
});

await t("the app's device-lib calls all exist on the object device.js hands it", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const lib = readFileSync(path.join(ROOT, "services/api/public/device.js"), "utf8");
  const handed = new Set(lib.match(/__deviceLibReady\(\{([^}]*)\}\)/)![1].split(",").map((s) => s.trim()));
  const dir = path.join(ROOT, "services/api/public/app");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    for (const [, name] of readFileSync(path.join(dir, file), "utf8").matchAll(/\bdev\.(\w+)\(/g)) {
      assert.ok(handed.has(name), `${file} calls dev.${name}, which device.js does not hand over`);
    }
  }
});

await t("a stale key here is replaced by the passkey's key, never the bound one", async () => {
  slots.clear();
  const answer = () => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: PRF_SECRET.buffer } } }) });
  const old = (await dev.createKey(CRED)).address; // random, unprotected: not the bound key
  await withAuthenticator(answer, async () => {
    const bound = `0x${"55".repeat(20)}`;
    const { address } = await dev.createKey(CRED, { staleFor: bound });
    assert.notEqual(address, old);
    assert.equal(JSON.parse(slots.get(SLOT)!).derived, true);
    await assert.rejects(() => dev.createKey(CRED, { staleFor: address }), /already/, "the bound key itself is never replaced");
  });
});

await t("a PRF-wrapped legacy key is carried forward only once this passkey unwraps it", async () => {
  slots.clear();
  slots.set("zold-device-key", JSON.stringify({ ...(await dev.wrapKey(LEGACY_PRIV, PRF_SECRET)), address: LEGACY_ADDR.toLowerCase() }));
  assert.deepEqual(dev.keyStatus(CRED, LEGACY_ADDR), { present: true, protection: "prf" });
  assert.equal(slots.get(SLOT), undefined, "copied before this passkey proved it can open it");
  const prfAnswer = (secret: Uint8Array) => () => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: secret.buffer } } }) });
  // Another passkey on the same account: cannot open it, so nothing is copied.
  await withAuthenticator(prfAnswer(new Uint8Array(32).fill(5)), async () => {
    await assert.rejects(() => dev.signTypedData(TYPED_DATA, CRED, LEGACY_ADDR), /could not unlock/);
  });
  assert.equal(slots.get(SLOT), undefined);
  await withAuthenticator(prfAnswer(PRF_SECRET), async () => {
    const sig = await dev.signTypedData(TYPED_DATA, CRED, LEGACY_ADDR);
    assert.equal(await recoverAddress({ hash: viemDigest, signature: sig }), LEGACY_ADDR);
  });
  const copied = JSON.parse(slots.get(SLOT)!);
  assert.equal(copied.credentialId, CRED);
  assert.equal(copied.key, undefined);
  assert.equal(slots.get("zold-device-key"), undefined, "the unscoped copy is deleted once the scoped slot holds it");
});

await t("a cancelled prompt at signing time keeps the key locked", async () => {
  await withAuthenticator(
    () => Promise.reject(new DOMException("cancelled", "NotAllowedError")),
    async () => { await assert.rejects(() => dev.signTypedData(TYPED_DATA, CRED), /passkey is needed/); },
  );
});

console.log(`\nDEVICE-KEY TEST PASSED — ${pass}/${pass}`);
console.log("note: PRF availability and cross-ceremony stability need a real browser");
