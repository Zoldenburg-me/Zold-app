/**
 * Encryption at rest v2: format, row binding, key ring, the v1 reader, the
 * blind index and the re-encrypt job.
 *
 * Offline. Every key is generated here at run time, so no key-shaped literal
 * is in source; the job runs as a child process against a throwaway db.
 *
 *   npm run crypto:test
 */
// Must be first: pins the chain and the test posture before config loads.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootB64 = () => randomBytes(32).toString("base64url");
const K1 = rootB64();
const K2 = rootB64();
const V1_SECRET = `fake-v1-secret-for-tests-${randomUUID()}`;
const BLIND = rootB64();

const DB_PATH = path.join(os.tmpdir(), `zold-crypto-test-${process.pid}.json`);
rmSync(DB_PATH, { force: true });
process.env.TRANSF_DB_PATH = DB_PATH;
process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
process.env.BLIND_INDEX_KEY = BLIND;
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = V1_SECRET;

const {
  blindIndex,
  decryptField,
  encryptField,
  EncryptionUnavailableError,
  fieldKeyId,
  openField,
  parseBlindIndexKey,
  parseKeyring,
  sealField,
} = await import("../services/api/src/crypto-at-rest.js");
const { dataKeyring, emailIndex } = await import("../services/api/src/config/data-keys.js");
const { STORED_SECRETS, SECRETS } = await import("../services/api/src/stored-secrets.js");
const { initStore, store } = await import("../services/api/src/store.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).stack}`); }
}

const ring1 = parseKeyring(`k1:${K1}`);
const ring21 = parseKeyring(`k2:${K2},k1:${K1}`);
const ROW = { table: "shopifyConnections", rowId: "row-a", field: "accessToken" };
const v1Keys = { keyring: ring1, v1Secret: V1_SECRET };

console.log("\nv2 format and round trip");

await check("seals as v2.<keyId>.<iv>.<tag>.<ct> and opens again", () => {
  const enc = sealField("shopify", ROW, "shpat_fake_token", ring1);
  const parts = enc.split(".");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "v2");
  assert.equal(parts[1], "k1");
  assert.equal(Buffer.from(parts[2], "base64url").length, 12, "96-bit IV");
  assert.equal(Buffer.from(parts[3], "base64url").length, 16, "128-bit tag");
  assert.ok(!enc.includes("shpat_fake_token"));
  assert.equal(openField("shopify", ROW, enc, v1Keys), "shpat_fake_token");
});

await check("two seals of one value differ (random IV)", () => {
  assert.notEqual(sealField("shopify", ROW, "same", ring1), sealField("shopify", ROW, "same", ring1));
});

console.log("\nAAD binds the ciphertext to purpose|table|rowId|field");

await check("moved to another row, it does not decrypt", () => {
  const enc = sealField("shopify", ROW, "user A's token", ring1);
  assert.throws(() => openField("shopify", { ...ROW, rowId: "row-b" }, enc, v1Keys));
});
await check("moved to another field of the same row, it does not decrypt", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  assert.throws(() => openField("shopify", { ...ROW, field: "orderLinkSecret" }, enc, v1Keys));
});
await check("moved to another table, it does not decrypt", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  assert.throws(() => openField("shopify", { ...ROW, table: "organisations" }, enc, v1Keys));
});
await check("read under another purpose (another data key), it does not decrypt", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  assert.throws(() => openField("getmyinvoices", ROW, enc, v1Keys));
});
await check("a tampered ciphertext or tag does not decrypt", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  const [v, id, iv, tag, ct] = enc.split(".");
  const flip = (s: string) => { const b = Buffer.from(s, "base64url"); b[0] ^= 1; return b.toString("base64url"); };
  assert.throws(() => openField("shopify", ROW, [v, id, iv, tag, flip(ct)].join("."), v1Keys));
  assert.throws(() => openField("shopify", ROW, [v, id, iv, flip(tag), ct].join("."), v1Keys));
});
await check("a truncated tag or a short IV is refused, in v2 and in v1", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  const [v, id, iv, tag, ct] = enc.split(".");
  const short = (s: string, n: number) => Buffer.from(s, "base64url").subarray(0, n).toString("base64url");
  assert.throws(() => openField("shopify", ROW, [v, id, iv, short(tag, 4), ct].join("."), v1Keys), /tag/);
  assert.throws(() => openField("shopify", ROW, [v, id, short(iv, 8), tag, ct].join("."), v1Keys), /IV/);
  const [iv1, tag1, ct1] = encryptField("shopify", V1_SECRET, "legacy").split(".");
  assert.throws(() => decryptField("shopify", V1_SECRET, [iv1, short(tag1, 4), ct1].join(".")), /tag/);
});
await check("a binding component holding the separator is refused, so two bindings never share an AAD", () => {
  assert.throws(() => sealField("shopify", { ...ROW, rowId: "a|b" }, "x", ring1), /separator/);
  assert.throws(() => sealField("shopify", { ...ROW, rowId: "" }, "x", ring1), /empty/);
});

console.log("\nKey ring and rotation");

await check("the first key in the ring encrypts; older keys still decrypt", () => {
  const old = sealField("shopify", ROW, "old", ring1);
  const fresh = sealField("shopify", ROW, "new", ring21);
  assert.equal(fieldKeyId(old), "k1");
  assert.equal(fieldKeyId(fresh), "k2");
  assert.equal(openField("shopify", ROW, old, { keyring: ring21, v1Secret: "" }), "old");
  assert.equal(openField("shopify", ROW, fresh, { keyring: ring21, v1Secret: "" }), "new");
});
await check("a key id the ring no longer holds is refused by name", () => {
  const fresh = sealField("shopify", ROW, "new", ring21);
  assert.throws(() => openField("shopify", ROW, fresh, v1Keys), /key k2 is not in DATA_ENCRYPTION_KEYS/);
});
await check("a malformed ring is refused, and the error never echoes a root", () => {
  const bad = [
    "",
    "k1",
    `k1:${K1.slice(0, 20)}`,
    "k1:a-human-passphrase-that-is-long-enough-to-pass-a-length-check",
    `k1:${K1},k1:${K2}`,
    `K-1!:${K1}`,
    `k1:${K1},k2:${K1}`,
    `v1:${K1}`,
    `v3:${K1}`,
  ];
  for (const spec of bad) {
    let msg = "";
    try { parseKeyring(spec); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg, `accepted ${JSON.stringify(spec.slice(0, 12))}…`);
    assert.ok(!msg.includes(K1) && !msg.includes(K2) && !msg.includes(K1.slice(0, 20)), `error echoed a root: ${msg}`);
  }
});

console.log("\nFail closed");

await check("sealing refuses without a key ring, and never returns the plaintext", () => {
  assert.throws(() => sealField("shopify", ROW, "token", null), EncryptionUnavailableError);
});
await check("opening a v2 value without a key ring refuses", () => {
  const enc = sealField("shopify", ROW, "token", ring1);
  assert.throws(() => openField("shopify", ROW, enc, { keyring: null, v1Secret: V1_SECRET }), EncryptionUnavailableError);
});
await check("something that is neither v1 nor v2 is refused, never returned as is", () => {
  assert.throws(() => openField("shopify", ROW, "plaintext-token", v1Keys));
});

console.log("\nThe v1 reader");

await check("v1 ciphertext still opens, with the v1 secret, whatever the binding", () => {
  const v1 = encryptField("shopify", V1_SECRET, "legacy");
  assert.equal(fieldKeyId(v1), "v1");
  assert.equal(openField("shopify", ROW, v1, v1Keys), "legacy");
  assert.equal(decryptField("shopify", V1_SECRET, v1), "legacy");
});
await check("v1 ciphertext without the v1 secret refuses", () => {
  const v1 = encryptField("shopify", V1_SECRET, "legacy");
  assert.throws(() => openField("shopify", ROW, v1, { keyring: ring1, v1Secret: "" }), EncryptionUnavailableError);
});

console.log("\nBlind index");

await check("an email index is stable across case and whitespace and never holds the address", () => {
  const key = parseBlindIndexKey(BLIND);
  const a = blindIndex("email", "  Lena@Example.com ", key);
  assert.equal(a, blindIndex("email", "lena@example.com", key));
  assert.notEqual(a, blindIndex("email", "lena2@example.com", key));
  assert.ok(!a.toLowerCase().includes("lena"));
  assert.match(a, /^bi1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(emailIndex("LENA@example.com"), a, "config-bound helper uses BLIND_INDEX_KEY");
});
await check("another key or another kind gives another index", () => {
  const key = parseBlindIndexKey(BLIND);
  const other = parseBlindIndexKey(rootB64());
  assert.notEqual(blindIndex("email", "a@example.com", key), blindIndex("email", "a@example.com", other));
  assert.notEqual(blindIndex("email", "a@example.com", key), blindIndex("phone", "a@example.com", key));
});
await check("no index without a key", () => {
  assert.throws(() => blindIndex("email", "a@example.com", null), EncryptionUnavailableError);
  assert.throws(() => parseBlindIndexKey("short"));
});

console.log("\nStored secrets are bound to their row");

await check("each stored-secret site seals under DATA_ENCRYPTION_KEYS and opens only in its own row", () => {
  assert.ok(dataKeyring());
  const enc = SECRETS.gmiApiKey.seal("org_1", "gmi_fake_key");
  assert.equal(fieldKeyId(enc), "k1");
  assert.equal(SECRETS.gmiApiKey.open("org_1", enc), "gmi_fake_key");
  assert.throws(() => SECRETS.gmiApiKey.open("org_2", enc));
});
await check("Monerium credentials are bound to the user row, and the API secret has its own data key", () => {
  const tok = SECRETS.moneriumAccessToken.seal("user-a", "fake-access");
  assert.equal(SECRETS.moneriumAccessToken.open("user-a", tok), "fake-access");
  assert.throws(() => SECRETS.moneriumAccessToken.open("user-b", tok), "another user's row");
  assert.throws(() => SECRETS.moneriumRefreshToken.open("user-a", tok), "another field");
  const sec = SECRETS.moneriumApiSecret.seal("user-a", "fake-secret");
  assert.equal(SECRETS.moneriumApiSecret.purpose, "monerium-api-secret");
  assert.throws(() => openField("monerium", { table: "users", rowId: "user-a", field: "monerium.apiKeys.clientSecret" }, sec, { keyring: dataKeyring(), v1Secret: "" }), "the API secret's data key is not the token key");
});
await check("v1 Monerium values, all written under purpose `monerium`, still open through their sites", () => {
  assert.equal(SECRETS.moneriumAccessToken.open("any-user", encryptField("monerium", V1_SECRET, "old-access")), "old-access");
  assert.equal(SECRETS.moneriumApiSecret.open("any-user", encryptField("monerium", V1_SECRET, "old-secret")), "old-secret");
});
await check("without a key ring a Monerium token refresh refuses before it spends the refresh token", async () => {
  const { moneriumAccessToken } = await import("../services/api/src/adapters/monerium-connection.js");
  const user = { id: "user-refresh", monerium: {
    connectedAt: new Date().toISOString(), method: "oauth",
    accessTokenEnc: encryptField("monerium", V1_SECRET, "old-access"),
    refreshTokenEnc: encryptField("monerium", V1_SECRET, "old-refresh"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  } } as any;
  const ring = process.env.DATA_ENCRYPTION_KEYS;
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => { called++; return new Response("{}", { status: 500 }); }) as typeof fetch;
  process.env.DATA_ENCRYPTION_KEYS = "";
  try {
    await assert.rejects(() => moneriumAccessToken(user), EncryptionUnavailableError);
    assert.equal(called, 0, "Monerium was asked to refresh with nowhere to store the result");
  } finally {
    process.env.DATA_ENCRYPTION_KEYS = ring;
    globalThis.fetch = realFetch;
  }
});
await check("a refresh that finishes after the user disconnected does not bring the connection back", async () => {
  const { moneriumAccessToken } = await import("../services/api/src/adapters/monerium-connection.js");
  initStore();
  store.addUser({ id: "user-race", monerium: {
    connectedAt: new Date().toISOString(), method: "oauth",
    accessTokenEnc: SECRETS.moneriumAccessToken.seal("user-race", "old-access"),
    refreshTokenEnc: SECRETS.moneriumRefreshToken.seal("user-race", "old-refresh"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  } } as any);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    store.updateUser("user-race", { monerium: undefined }); // disconnected while Monerium answered
    return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => moneriumAccessToken(store.findUser("user-race")!));
    assert.equal(store.findUser("user-race")!.monerium, undefined, "the stale connection was written back");
  } finally {
    globalThis.fetch = realFetch;
  }
});
await check("every registered site names a distinct (table, field)", () => {
  const seen = new Set(STORED_SECRETS.map((s) => `${s.site.table}|${s.site.field}`));
  assert.equal(seen.size, STORED_SECRETS.length);
});

console.log("\nRe-encrypt job");

// Rows as the store held them before v2: two v1 values, one v2 under the old key.
initStore();
const now = new Date().toISOString();
const shopRow = (id: string, shop: string) => ({
  id, orgId: "org_1", shop, payeeUserId: "u1", scope: "write_orders",
  installedByUserId: "u1", installedAt: now, updatedAt: now,
});
store.addShopifyConnection({ ...shopRow("conn-1", "one.myshopify.com"), accessTokenEnc: encryptField("shopify", V1_SECRET, "shpat_one"), orderLinkSecretEnc: encryptField("shopify-link", V1_SECRET, "link_one") });
store.addShopifyConnection({ ...shopRow("conn-2", "two.myshopify.com"), accessTokenEnc: sealField("shopify", { table: "shopifyConnections", rowId: "conn-2", field: "accessToken" }, "shpat_two", ring1) });
store.addUser({ id: "user-1", monerium: {
  connectedAt: now,
  accessTokenEnc: encryptField("monerium", V1_SECRET, "mon_access"),
  refreshTokenEnc: encryptField("monerium", V1_SECRET, "mon_refresh"),
  apiKeys: { clientId: "client-id-1", clientSecretEnc: encryptField("monerium", V1_SECRET, "mon_secret"), baseUrl: "https://api.monerium.dev", verifiedAt: now },
} } as any);
store.addOrganisation({ id: "org_1", name: "Test GmbH", createdAt: now, updatedAt: now, integrations: { getmyinvoices: { apiKeyEnc: encryptField("getmyinvoices", V1_SECRET, "gmi_one"), connectedAt: now, connectedByMemberId: "m1" } } } as any, false);

const JOB = path.join(path.dirname(fileURLToPath(import.meta.url)), "reencrypt-fields.ts");
const TSX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tsx", "dist", "cli.mjs");
const PLAINTEXTS = ["shpat_one", "link_one", "shpat_two", "gmi_one", "mon_access", "mon_refresh", "mon_secret"];
function job(args: string[], keys: string) {
  const r = spawnSync(process.execPath, [TSX, JOB, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATA_ENCRYPTION_KEYS: keys },
  });
  const out = `${r.stdout}${r.stderr}`;
  for (const p of PLAINTEXTS) assert.ok(!out.includes(p), `the job printed a plaintext value`);
  for (const k of [K1, K2, V1_SECRET]) assert.ok(!out.includes(k), "the job printed a key");
  return { status: r.status, out };
}
const onDisk = () => JSON.parse(readFileSync(DB_PATH, "utf8"));

await check("a dry run (the default) reports v1 rows and old keys, and writes nothing", () => {
  const before = readFileSync(DB_PATH, "utf8");
  const mtime = statSync(DB_PATH).mtimeMs;
  const r = job([], `k2:${K2},k1:${K1}`);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dry run/i);
  assert.match(r.out, /shopifyConnections\.accessToken\s+v1=1\s+k1=1\s+k2=0/);
  assert.match(r.out, /shopifyConnections\.orderLinkSecret\s+v1=1/);
  assert.match(r.out, /organisations\.integrations\.getmyinvoices\.apiKey\s+v1=1/);
  assert.match(r.out, /users\.monerium\.accessToken\s+v1=1/);
  assert.match(r.out, /users\.monerium\.apiKeys\.clientSecret\s+v1=1/);
  assert.match(r.out, /7 to move/);
  assert.equal(readFileSync(DB_PATH, "utf8"), before);
  assert.equal(statSync(DB_PATH).mtimeMs, mtime, "the dry run rewrote the file");
});
await check("a dry run against a missing store refuses and creates nothing", () => {
  const missing = path.join(os.tmpdir(), `zold-crypto-missing-${process.pid}`, "db.json");
  const r = spawnSync(process.execPath, [TSX, JOB], { encoding: "utf8", env: { ...process.env, TRANSF_DB_PATH: missing } });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /no store at/);
  assert.equal(existsSync(path.dirname(missing)), false);
});
await check("--apply refuses without a key ring", () => {
  const r = job(["--apply"], "");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /DATA_ENCRYPTION_KEYS/);
});
await check("--apply moves every row to the active key, bound to its row, and the values survive", () => {
  const r = job(["--apply"], `k2:${K2},k1:${K1}`);
  assert.equal(r.status, 0, r.out);
  const db = onDisk();
  const c1 = db.shopifyConnections.find((c: any) => c.id === "conn-1");
  const c2 = db.shopifyConnections.find((c: any) => c.id === "conn-2");
  const g = db.organisations.find((o: any) => o.id === "org_1").integrations.getmyinvoices;
  for (const v of [c1.accessTokenEnc, c1.orderLinkSecretEnc, c2.accessTokenEnc, g.apiKeyEnc]) assert.equal(fieldKeyId(v), "k2");
  const keys = { keyring: ring21, v1Secret: "" };
  assert.equal(openField("shopify", { table: "shopifyConnections", rowId: "conn-1", field: "accessToken" }, c1.accessTokenEnc, keys), "shpat_one");
  assert.equal(openField("shopify-link", { table: "shopifyConnections", rowId: "conn-1", field: "orderLinkSecret" }, c1.orderLinkSecretEnc, keys), "link_one");
  assert.equal(openField("shopify", { table: "shopifyConnections", rowId: "conn-2", field: "accessToken" }, c2.accessTokenEnc, keys), "shpat_two");
  assert.equal(openField("getmyinvoices", { table: "organisations", rowId: "org_1", field: "integrations.getmyinvoices.apiKey" }, g.apiKeyEnc, keys), "gmi_one");
  const m = db.users.find((u: any) => u.id === "user-1").monerium;
  const userRow = (field: string) => ({ table: "users", rowId: "user-1", field });
  assert.equal(openField("monerium", userRow("monerium.accessToken"), m.accessTokenEnc, keys), "mon_access");
  assert.equal(openField("monerium", userRow("monerium.refreshToken"), m.refreshTokenEnc, keys), "mon_refresh");
  assert.equal(openField("monerium-api-secret", userRow("monerium.apiKeys.clientSecret"), m.apiKeys.clientSecretEnc, keys), "mon_secret");
  assert.equal(m.apiKeys.clientId, "client-id-1", "the rest of the connection is kept");
});
await check("after the move the report says k1 can retire", () => {
  const r = job([], `k2:${K2},k1:${K1}`);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /0 to move/);
  assert.match(r.out, /k1: no row uses it; it can be removed from DATA_ENCRYPTION_KEYS/);
  assert.match(r.out, /no v1 row in these sites/);
});
await check("a row already under the active key that does not decrypt fails the dry run", () => {
  const db = onDisk();
  const c1 = db.shopifyConnections.find((c: any) => c.id === "conn-1");
  initStore();
  const saved = store.shopifyConnections.find((c) => c.id === "conn-2")!.accessTokenEnc;
  store.updateShopifyConnection("conn-2", { accessTokenEnc: c1.accessTokenEnc });
  const r = job([], `k2:${K2},k1:${K1}`);
  store.updateShopifyConnection("conn-2", { accessTokenEnc: saved });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /shopifyConnections\.accessToken conn-2: does not decrypt/);
});
await check("a row that does not decrypt is reported and left as it was, and the job fails", () => {
  const db = onDisk();
  const c1 = db.shopifyConnections.find((c: any) => c.id === "conn-1");
  // Copy conn-1's token into conn-2: the row binding must refuse it.
  initStore();
  store.updateShopifyConnection("conn-2", { accessTokenEnc: c1.accessTokenEnc });
  const r = job(["--apply"], `k3:${rootB64()},k2:${K2}`);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /shopifyConnections\.accessToken conn-2: does not decrypt/);
  assert.equal(onDisk().shopifyConnections.find((c: any) => c.id === "conn-2").accessTokenEnc, c1.accessTokenEnc);
});

rmSync(DB_PATH, { force: true });
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall crypto-at-rest checks passed");
