/**
 * Crypto sends (routes/crypto-sends.ts): EURe or USDC from the Safe to an ENS
 * name or a 0x address.
 *
 * Covers:
 *   - a name is resolved, shown, confirmed and resolved again before submit;
 *     a name that moved between the check and the signature sends nothing;
 *   - an address other than the one the user confirmed is refused at create;
 *   - a name with no address on the pay chain, a bad checksum, the account's
 *     own address and token contracts are refused;
 *   - the balance and the daily cap (EURe at face, USDC at the mid) bound it,
 *     no rate means no send, and an expired unsigned send stops counting;
 *   - a wrong passkey, and a second submit of the same signature, are refused;
 *   - a name starting with 0x is resolved, and ENS down at approval leaves
 *     the send approvable;
 *   - a Zold page's forwarder (by its address, or any name under our ENS
 *     parent we cannot place) takes only its listed tokens: EURe is refused;
 *   - off unless CRYPTO_SEND_ENABLED=1.
 *
 * Offline: the ENS resolver, balance and rate are injected; the Safe operation
 * is the hardhat harness stand-in. Run: npm run crypto-send:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-crypto-send-")), "db.json");
process.env.CRYPTO_SEND_ENABLED = "1";
// The ENS gateway on, so names under zoldhq.com are known to be page names.
// Derived, not a literal: a throwaway key for this test only.
process.env.ENS_PARENT_NAME = "zoldhq.com";
process.env.ENS_RESOLVER_ADDRESS = "0x00000000000000000000000000000000000e45e5";
process.env.ENS_GATEWAY_KEY = (await import("viem")).keccak256((await import("viem")).toHex("zold crypto-send-test gateway key"));

const { store, initStore } = await import("../services/api/src/store.js");
const { addrs } = await import("../services/api/src/chain.js");
const { FX } = await import("../services/api/src/config.js");
const { safeFundedEurToday } = await import("../services/api/src/orchestrator.js");
const { createCryptoSendsRouter } = await import("../services/api/src/routes/crypto-sends.js");
initStore();

const SAFE = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222" as const;
const MALLORY = "0x3333333333333333333333333333333333333333" as const;
// A real checksummed address, and the same with one letter's case flipped.
const GOOD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BAD_SUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";

const FWD = "0x4444444444444444444444444444444444444444" as const;
const KIM_SAFE = "0x5555555555555555555555555555555555555555" as const;
const names: Record<string, `0x${string}` | null | "down"> = {
  "alice.eth": ALICE, "nobase.eth": null, "0xsplits.eth": ALICE,
  // A Zold user's page name, and the same page under a plain .eth name.
  "kim.zoldhq.com": FWD, "kim.eth": FWD, "lee.zoldhq.com": KIM_SAFE, "gone.zoldhq.com": MALLORY,
};
let balance = 1_000n * 10n ** 18n;
let rate: number | undefined = 1.25; // USD per EUR

const ORIGIN = "http://localhost:3000";
const passkey = await makeSoftwarePasskey("cs", ORIGIN);
const other = await makeSoftwarePasskey("cs-other", ORIGIN);
const hex = (b64: string) => "0x" + Buffer.from(b64, "base64url").toString("hex");
const now = new Date().toISOString();
store.addUser({
  id: "u-cs", name: "Kim", country: "DE", kycStatus: "approved", address: SAFE,
  wallet: { type: "candide-safe", deployed: true },
  passkey: { credentialId: passkey.credentialId, publicKey: { alg: "ES256", jwk: passkey.jwk }, signCount: 0, rpId: "localhost" },
  passkeySafe: { status: "active", address: SAFE, threshold: 1, importedAt: now, passkeyPublicKey: { x: hex(passkey.jwk.x!), y: hex(passkey.jwk.y!) } },
  createdAt: now,
} as any);

// Kim's page forwards through a Candide address that takes USDC only; Lee's
// page has no forwarder, so its address is Lee's Safe.
store.addUser({
  id: "u-kim", name: "Kim", country: "DE", kycStatus: "approved", address: KIM_SAFE, createdAt: now,
  paymentPage: { handle: "kim", depositAddress: FWD, forwarder: { provider: "candide", recipient: KIM_SAFE, destinationChainId: 31337, sourceChainIds: [31337], custodialWithdrawer: KIM_SAFE, active: true, activatedAt: now },
    supportedTokens: [{ chainId: 31337, symbol: "USDC", address: addrs().usdc, decimals: 6 }], settlementAsset: "USDC", autoConvert: false, createdAt: now },
} as any);
store.addUser({
  id: "u-lee", name: "Lee", country: "DE", kycStatus: "approved", address: KIM_SAFE.replace("5555", "5556"), createdAt: now,
  paymentPage: { handle: "lee", depositAddress: KIM_SAFE.replace("5555", "5556"), settlementAsset: "EURE", autoConvert: false, createdAt: now },
} as any);
names["lee.zoldhq.com"] = KIM_SAFE.replace("5555", "5556") as `0x${string}`;
// Ann's page address is her passkey Safe, which differs from her stored address.
const ANN_SAFE = "0x6666666666666666666666666666666666666666" as const;
store.addUser({
  id: "u-ann", name: "Ann", country: "DE", kycStatus: "approved", address: "0x6666666666666666666666666666666666666667", createdAt: now,
  passkeySafe: { status: "active", address: ANN_SAFE, threshold: 1, importedAt: now },
  paymentPage: { handle: "ann", depositAddress: ANN_SAFE, settlementAsset: "EURE", autoConvert: false, createdAt: now },
} as any);
names["ann.zoldhq.com"] = ANN_SAFE;
// A name under our parent that resolves to a user's Safe with no page there.
names["kimsafe.zoldhq.com"] = KIM_SAFE;

const app = express();
app.use(express.json());
app.use("/api", createCryptoSendsRouter({
  requireUserSession: () => ({ id: "s" }),
  resolveName: async (n) => {
    if (!(n in names)) return { ok: false, status: 400, code: "BAD_NAME", error: "not a valid ENS name" };
    const a = names[n];
    if (a === "down") return { ok: false, status: 502, code: "ENS_UNAVAILABLE", error: "the ENS lookup failed — try again" };
    return a ? { ok: true, name: n, address: a } : { ok: false, status: 404, code: "NO_ADDRESS", error: `${n} has no address for this network` };
  },
  balanceOf: async () => balance,
  usdPerEur: async () => { if (rate === undefined) throw new Error("no rate"); return rate; },
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const post = async (p: string, body: unknown) => {
  const res = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const create = (b: Record<string, unknown>) => post("/users/u-cs/crypto-sends", { token: "EURE", amount: "10", ...b });

let pass = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); pass++; console.log(`  ok  ${name}`); };
let failed = false;
try {
  await t("a name resolves, is confirmed, re-checked and sent; the signature is used once", async () => {
    const c = await create({ to: "alice.eth", confirmedAddress: ALICE });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(c.data.to, ALICE);
    assert.equal(c.data.name, "alice.eth");
    assert.equal(c.data.amount, "10");
    assert.equal(c.data.userId, undefined, "the response carries no user id");
    const executionAssertion = await passkey.assert(c.data.safeExecution.challenge);
    const both = await Promise.all([1, 2].map(() => post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both));
    const s = store.findCryptoSend(c.data.id)!;
    assert.equal(s.state, "SENT");
    assert.ok(s.txHash, "the tx hash is recorded");
  });

  await t("a name that moved after the check sends nothing and frees the cap", async () => {
    const c = await create({ to: "alice.eth", confirmedAddress: ALICE });
    assert.equal(c.status, 201);
    names["alice.eth"] = MALLORY;
    const r = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(c.data.safeExecution.challenge) });
    names["alice.eth"] = ALICE;
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "ADDRESS_CHANGED");
    const s = store.findCryptoSend(c.data.id)!;
    assert.equal(s.state, "FAILED");
    assert.ok(!s.txHash);
    const used = safeFundedEurToday("u-cs");
    assert.equal(used, 10, `only the sent €10 counts, got ${used}`);
  });

  await t("a name starting with 0x is a name, not a bad address", async () => {
    const c = await create({ to: "0xsplits.eth", confirmedAddress: ALICE, amount: "1" });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(c.data.name, "0xsplits.eth");
  });

  await t("ENS down at approval sends nothing and the send can be approved again", async () => {
    const c = await create({ to: "alice.eth", confirmedAddress: ALICE, amount: "1" });
    names["alice.eth"] = "down";
    const r = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(c.data.safeExecution.challenge) });
    names["alice.eth"] = ALICE;
    assert.equal(r.status, 502);
    assert.equal(store.findCryptoSend(c.data.id)!.state, "CREATED");
    const again = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(c.data.safeExecution.challenge) });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(store.findCryptoSend(c.data.id)!.state, "SENT");
  });

  await t("a Zold page's forwarder takes USDC only: EURe is refused, USDC goes through", async () => {
    for (const to of ["kim.zoldhq.com", "kim.eth", FWD]) {
      const e = await create({ to, confirmedAddress: FWD, amount: "1" });
      assert.equal(e.status, 409, `${to}: ${JSON.stringify(e.data)}`);
      assert.equal(e.data.code, "PAGE_TOKEN_REFUSED");
      assert.match(e.data.error, /Send USDC/);
    }
    const u = await create({ to: "kim.eth", confirmedAddress: FWD, token: "USDC", amount: "1" });
    assert.equal(u.status, 201, JSON.stringify(u.data));
  });

  await t("a page without a forwarder is the Safe and takes EURe; an unknown page name does not", async () => {
    const lee = await create({ to: "lee.zoldhq.com", confirmedAddress: names["lee.zoldhq.com"], amount: "1" });
    assert.equal(lee.status, 201, JSON.stringify(lee.data));
    assert.equal((await create({ to: "ann.zoldhq.com", confirmedAddress: ANN_SAFE, amount: "1" })).status, 201, "a page whose address is the passkey Safe takes EURe");
    assert.equal((await create({ to: "kimsafe.zoldhq.com", confirmedAddress: KIM_SAFE, amount: "1" })).status, 201, "a name pointing at a user's Safe takes EURe");
    const held = safeFundedEurToday("u-cs");
    const gone = await create({ to: "gone.zoldhq.com", confirmedAddress: MALLORY, amount: "1" });
    assert.equal(gone.data.code, "PAGE_TOKEN_REFUSED", "a name under our parent we cannot place fails closed");
    assert.equal(safeFundedEurToday("u-cs"), held, "a refusal holds nothing against the cap");
    assert.equal((await create({ to: "gone.zoldhq.com", confirmedAddress: MALLORY, token: "USDC", amount: "1" })).status, 201, "USDC to it goes through");
  });

  await t("an address other than the one confirmed is refused at create", async () => {
    const r = await create({ to: "alice.eth", confirmedAddress: MALLORY });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "ADDRESS_CHANGED");
    assert.equal(r.data.address, ALICE, "the client is told the address to check again");
  });

  await t("no address on the pay chain, a bad checksum, own address and token contracts are refused", async () => {
    assert.equal((await create({ to: "nobase.eth", confirmedAddress: ALICE })).data.code, "NO_ADDRESS");
    assert.equal((await create({ to: BAD_SUM, confirmedAddress: BAD_SUM })).data.code, "BAD_ADDRESS");
    assert.equal((await create({ to: "0x123", confirmedAddress: "0x123" })).data.code, "BAD_ADDRESS");
    assert.equal((await create({ to: SAFE, confirmedAddress: SAFE })).data.code, "OWN_ADDRESS");
    assert.equal((await create({ to: addrs().eure, confirmedAddress: addrs().eure })).data.code, "BURN_ADDRESS");
    const plain = await create({ to: GOOD.toLowerCase(), confirmedAddress: GOOD });
    assert.equal(plain.status, 201, "an all-lowercase 0x address has no checksum to break");
    assert.equal(plain.data.to, GOOD);
  });

  await t("token, amount and balance are checked", async () => {
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, token: "DAI" })).data.code, "BAD_TOKEN");
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, amount: "0" })).data.code, "BAD_AMOUNT");
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, amount: "1.1234567" })).data.code, "BAD_AMOUNT");
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, amount: "-1" })).data.code, "BAD_AMOUNT");
    balance = 5n * 10n ** 18n;
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE })).data.code, "INSUFFICIENT_BALANCE");
    balance = 10n ** 30n;
  });

  await t("the daily cap counts USDC at the mid, and no rate means no send", async () => {
    const before = safeFundedEurToday("u-cs");
    const u = await create({ to: ALICE, confirmedAddress: ALICE, token: "USDC", amount: "125" });
    assert.equal(u.status, 201, JSON.stringify(u.data));
    assert.equal(u.data.capEur, 100, "125 USDC at 1.25 USD per EUR is €100");
    assert.equal(safeFundedEurToday("u-cs") - before, 100);
    const left = FX.DAILY_CAP_EUR - safeFundedEurToday("u-cs");
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, amount: String(Math.floor(left) + 1) })).data.code, "DAILY_CAP");
    rate = undefined;
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE, token: "USDC", amount: "1" })).data.code, "NO_RATE");
    rate = 1.25;
  });

  await t("an expired unsigned send stops counting and cannot be approved", async () => {
    const c = await create({ to: ALICE, confirmedAddress: ALICE, amount: "1" });
    const before = safeFundedEurToday("u-cs");
    store.findCryptoSend(c.data.id)!.deadline = Math.floor(Date.now() / 1000) - 1;
    assert.equal(before - safeFundedEurToday("u-cs"), 1);
    const r = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(c.data.safeExecution.challenge) });
    assert.equal(r.status, 410);
  });

  await t("another passkey, or a signature over another challenge, is refused", async () => {
    const c = await create({ to: ALICE, confirmedAddress: ALICE, amount: "1" });
    const wrongKey = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await other.assert(c.data.safeExecution.challenge) });
    assert.equal(wrongKey.status, 403);
    const wrongChallenge = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(Buffer.from("other").toString("base64url")) });
    assert.equal(wrongChallenge.status, 401);
    assert.equal(store.findCryptoSend(c.data.id)!.state, "CREATED", "a refused signature does not consume the send");
  });

  await t("with CRYPTO_SEND_ENABLED off, create and approve both refuse", async () => {
    const c = await create({ to: ALICE, confirmedAddress: ALICE, amount: "1" });
    process.env.CRYPTO_SEND_ENABLED = "0";
    const made = await create({ to: ALICE, confirmedAddress: ALICE, amount: "1" });
    const approve = await post(`/crypto-sends/${c.data.id}/authorize`, { executionAssertion: await passkey.assert(c.data.safeExecution.challenge) });
    process.env.CRYPTO_SEND_ENABLED = "1";
    assert.equal(made.data.code, "CRYPTO_SEND_OFF");
    assert.equal(approve.data.code, "CRYPTO_SEND_OFF");
    assert.equal(store.findCryptoSend(c.data.id)!.state, "CREATED");
  });

  await t("a KYC-pending account cannot send", async () => {
    store.findUser("u-cs")!.kycStatus = "pending";
    assert.equal((await create({ to: ALICE, confirmedAddress: ALICE })).status, 409);
    store.findUser("u-cs")!.kycStatus = "approved";
  });
} catch (err: any) {
  failed = true;
  console.error(`  FAIL ${err?.stack ?? err}`);
} finally {
  server.close();
}
if (failed) process.exit(1);
console.log(`\nCRYPTO SEND TEST PASSED — ${pass} checks`);
process.exit(0);
