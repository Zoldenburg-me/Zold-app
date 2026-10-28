/**
 * ENS routes: the CCIP-Read gateway that answers `<handle>.zoldhq.com`, and
 * the signed-in ENS lookup.
 *
 * Covers:
 *   - a page's name answers the owner's passkey Safe for the pay chain's coin
 *     type, never the page's Candide forwarder, signed by the gateway key for
 *     the configured resolver, whoever relays it;
 *   - no Safe that is active and the account's address, no answer;
 *   - the session's ensName names exactly the accounts the gateway answers
 *     for, and nothing when the deployment runs no gateway;
 *   - no other chain is claimed: not Ethereum (coin type 60), not the
 *     forwarder's source chains;
 *   - contenthash, name, pubkey and ABI answer empty rather than refuse;
 *   - org pages, unknown handles, deeper names and labels not in normalised
 *     form answer nothing;
 *   - a repeated request reuses its signed answer for half its validity (30 s
 *     when it has no address);
 *   - malformed calls, names under another parent, a node that does not match
 *     its name are refused;
 *   - a resolver answer that is not an address is refused (ENS_UNAVAILABLE);
 *   - the lookup needs a session, says when it is not configured, and never
 *     fetches a gateway URL on a private or loopback address.
 *
 * The contract side (that the resolver accepts these signatures) is in
 * contracts/test/run.ts. No chain. Run: npm run ens:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import {
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  namehash,
  parseAbi,
  recoverAddress,
  toCoinType,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";

// Derived, not a literal: a fixed throwaway key for this test only.
const GATEWAY_KEY = keccak256(toHex("zold ens-test gateway key"));
const RESOLVER = "0x00000000000000000000000000000000000e45e5";
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-ens-")), "db.json");
process.env.ENS_PARENT_NAME = "zoldhq.com";
process.env.ENS_RESOLVER_ADDRESS = RESOLVER;
process.env.ENS_GATEWAY_KEY = GATEWAY_KEY;
process.env.ENS_NAMES_LIVE = "1";
// With a trailing slash on purpose: the url record must not read `//pay/`.
process.env.TRANSF_PUBLIC_URL = "https://zoldhq.com/";
delete process.env.ENS_RPC_URL;

const { store, initStore } = await import("../services/api/src/store.js");
const { CHAIN_ID } = await import("../services/api/src/config.js");
const { createEnsRouter, ccipFetch, ensAnswer, fetchPublic, isPublicAddress } = await import("../services/api/src/routes/ens.js");
const { gatewaySignatureHash } = await import("../services/api/src/ens.js");
const { HandleError, normaliseHandle } = await import("../services/api/src/pay.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { ensNameOf, shownParent } = await import("../services/api/src/users/ens-name.js");
initStore();

const PAGE = "0x2222222222222222222222222222222222222222";
const safeOf = (address: string, status = "active") => ({ address, status, threshold: 1, passkeyPublicKey: { x: "0x1", y: "0x2" } });
const ALICE = "0x1111111111111111111111111111111111111111";
store.addUser({
  id: "u-alice", name: "Alice", country: "DE", kycStatus: "approved",
  address: ALICE, passkeySafe: safeOf(ALICE),
  createdAt: new Date().toISOString(),
  paymentPage: { handle: "alice", depositAddress: ALICE, autoConvert: true, settlementAsset: "EURE" },
} as any);
// A forwarder that takes tokens on other chains too.
const BOB = "0x3333333333333333333333333333333333333333";
store.addUser({
  id: "u-bob", name: "Bob", country: "DE", kycStatus: "approved",
  address: BOB, passkeySafe: safeOf(BOB),
  createdAt: new Date().toISOString(),
  paymentPage: {
    handle: "bob", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE",
    routesReadAt: new Date().toISOString(),
    supportedTokens: [10, 42161].map((chainId) => ({ chainId, symbol: "USDC", address: PAGE, decimals: 6 })),
  },
} as any);
store.addOrganisation({ id: "o-acme", name: "Acme", createdAt: new Date().toISOString(), paymentPage: { handle: "acme" } } as any, false);
// Carol's Safe is only planned; Frank's account address is not his Safe.
store.addUser({
  id: "u-carol", name: "Carol", country: "DE", kycStatus: "approved",
  address: "0x4444444444444444444444444444444444444444", passkeySafe: safeOf("0x4444444444444444444444444444444444444444", "planned"),
  createdAt: new Date().toISOString(),
  paymentPage: { handle: "carol", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE" },
} as any);
store.addUser({
  id: "u-frank", name: "Frank", country: "DE", kycStatus: "approved",
  address: "0x9999999999999999999999999999999999999999", passkeySafe: safeOf("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  createdAt: new Date().toISOString(),
  paymentPage: { handle: "frank", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE" },
} as any);
store.addUser({
  id: "u-gina", name: "Gina", country: "DE", kycStatus: "approved",
  address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  createdAt: new Date().toISOString(),
  paymentPage: { handle: "gina", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE" },
} as any);

const app = express().use(
  "/api",
  createEnsRouter({
    requireSession: (req, res) => (req.header("x-session") ? true : (res.status(401).json({ error: "authorization required" }), false)),
  }),
);

/** Run `fn` with the clock moved `ms` ahead. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;

const profile = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);
const outer = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const callFor = (name: string, data: Hex) =>
  encodeFunctionData({ abi: outer, functionName: "resolve", args: [toHex(packetToBytes(name)), data] });
const addrCall = (name: string, coinType = toCoinType(CHAIN_ID)) =>
  callFor(name, encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash(name), coinType] }));
const gateway = (callData: Hex, resolver = RESOLVER) => fetch(`${base}/ens/gateway/${resolver}/${callData}.json`);

/** Decode a gateway answer and check its signature like the resolver would. */
async function answer(callData: Hex): Promise<Hex> {
  const r = await gateway(callData);
  assert.equal(r.status, 200, await r.clone().text());
  const { data } = await r.json();
  const [result, expires, sig] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], data);
  const signer = await recoverAddress({ hash: gatewaySignatureHash(RESOLVER, expires, callData, result), signature: sig });
  assert.equal(signer, privateKeyToAccount(GATEWAY_KEY).address, "signed by the gateway key");
  assert.ok(expires > BigInt(Math.floor(Date.now() / 1000)), "not already expired");
  return result;
}

let n = 0;
const check = async (label: string, fn: () => Promise<void> | void) => {
  await fn();
  console.log(`  ${++n}. ${label}`);
};

// Erin's page is a live Candide forwarder, a different address from her Safe:
// production on Base mainnet.
const ERIN_SAFE = "0x6666666666666666666666666666666666666666";
const FORWARDER = "0x7777777777777777777777777777777777777777";
store.addUser({
  id: "u-erin", name: "Erin", country: "DE", kycStatus: "approved",
  address: ERIN_SAFE,
  createdAt: new Date().toISOString(),
  passkeySafe: safeOf(ERIN_SAFE),
  paymentPage: {
    handle: "erin", depositAddress: FORWARDER, recipientAddress: ERIN_SAFE, autoConvert: true, settlementAsset: "EURE",
    routesReadAt: new Date().toISOString(),
    supportedTokens: [{ chainId: CHAIN_ID, symbol: "USDC", address: "0x8888888888888888888888888888888888888888", decimals: 6 }],
    forwarder: {
      provider: "candide", recipient: ERIN_SAFE, destinationChainId: CHAIN_ID, sourceChainIds: [CHAIN_ID],
      custodialWithdrawer: ERIN_SAFE, active: true, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      activatedAt: new Date().toISOString(),
    },
  },
} as any);

try {
  await check("with Candide forwarding on, the name answers the Safe, never the forwarder", async () => {
    const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("erin.zoldhq.com")));
    assert.equal(address, ERIN_SAFE, "EURe sent to the forwarder would strand");
  });

  await check("a page without forwarding answers the same Safe, signed", async () => {
    const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("alice.zoldhq.com")));
    assert.equal(address, ALICE);
  });

  await check("no active Safe that is the account's address, or no Safe at all: no answer and no url", async () => {
    for (const name of ["carol.zoldhq.com", "frank.zoldhq.com", "gina.zoldhq.com"]) {
      const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall(name)));
      assert.equal(address, "0x", name);
      const url = await answer(callFor(name, encodeFunctionData({ abi: profile, functionName: "text", args: [namehash(name), "url"] })));
      assert.equal(decodeAbiParameters([{ type: "string" }], url)[0], "", name);
    }
  });

  await check("the session's ensName is the name the gateway answers for, and only that", async () => {
    const nameOf = (id: string) => publicUser(store.findUser(id)!).ensName;
    assert.equal(nameOf("u-alice"), "alice.zoldhq.com");
    assert.equal(nameOf("u-bob"), "bob.zoldhq.com", "a page with a forwarder still names the Safe");
    for (const id of ["u-carol", "u-frank", "u-gina"]) assert.equal(nameOf(id), null, `${id}: the gateway gives no answer, so Home shows no name`);
    assert.equal(ensNameOf({ ...store.findUser("u-alice")!, paymentPage: undefined }, "zoldhq.com"), null, "no page handle: no name");
    assert.equal(ensNameOf(store.findUser("u-alice")!, null), null, "no gateway on this deployment: no name");
    assert.equal(shownParent({ enabled: true, namesLive: false, parent: "zoldhq.com" }), null, "the gateway answers but no wallet has resolved a name yet: no name on Home");
    assert.equal(shownParent({ enabled: false, namesLive: true, parent: "" }), null);
    assert.equal(shownParent({ enabled: true, namesLive: true, parent: "zoldhq.com" }), "zoldhq.com");
  });

  await check("no Ethereum (coin type 60) address unless this deployment is on Ethereum", async () => {
    const [legacy] = decodeAbiParameters(
      [{ type: "address" }],
      await answer(callFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("alice.zoldhq.com")] }))),
    );
    assert.equal(legacy, "0x0000000000000000000000000000000000000000");
    const [eth] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("alice.zoldhq.com", 60n)));
    assert.equal(eth, "0x");
  });

  await check("the url text record is the page; other keys are empty", async () => {
    const text = (key: string) =>
      answer(callFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "text", args: [namehash("alice.zoldhq.com"), key] })));
    assert.equal(decodeAbiParameters([{ type: "string" }], await text("url"))[0], "https://zoldhq.com/pay/alice");
    assert.equal(decodeAbiParameters([{ type: "string" }], await text("email"))[0], "");
  });

  await check("contenthash, name, pubkey and ABI answer empty instead of failing the lookup", async () => {
    const node = namehash("alice.zoldhq.com");
    const extra = parseAbi([
      "function contenthash(bytes32 node) view returns (bytes)",
      "function name(bytes32 node) view returns (string)",
      "function pubkey(bytes32 node) view returns (bytes32 x, bytes32 y)",
      "function ABI(bytes32 node, uint256 contentTypes) view returns (uint256, bytes)",
    ]);
    const ask = (data: Hex) => answer(callFor("alice.zoldhq.com", data));
    assert.equal(decodeAbiParameters([{ type: "bytes" }], await ask(encodeFunctionData({ abi: extra, functionName: "contenthash", args: [node] })))[0], "0x");
    assert.equal(decodeAbiParameters([{ type: "string" }], await ask(encodeFunctionData({ abi: extra, functionName: "name", args: [node] })))[0], "");
    const [x, y] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], await ask(encodeFunctionData({ abi: extra, functionName: "pubkey", args: [node] })));
    assert.equal(BigInt(x) + BigInt(y), 0n);
    const [types, abiData] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], await ask(encodeFunctionData({ abi: extra, functionName: "ABI", args: [node, 1n] })));
    assert.equal(types, 0n);
    assert.equal(abiData, "0x");
  });

  await check("a label not in normalised form answers nothing, even if it lowercases to a handle", async () => {
    // "K" is the Kelvin sign; it lowercases to "k".
    for (const name of ["ALICE.zoldhq.com", "Alice.zoldhq.com", "Kate.zoldhq.com", " alice.zoldhq.com"]) {
      const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall(name)));
      assert.equal(address, "0x", name);
    }
  });

  await check("the forwarder's source chains are not claimed: the Safe is deployed on the pay chain only", async () => {
    const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("bob.zoldhq.com")));
    assert.equal(address, BOB);
    for (const chainId of [10, 42161]) {
      const [other] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("bob.zoldhq.com", toCoinType(chainId))));
      assert.equal(other, "0x", `chain ${chainId}`);
    }
    const url = await answer(callFor("bob.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "text", args: [namehash("bob.zoldhq.com"), "url"] })));
    assert.equal(decodeAbiParameters([{ type: "string" }], url)[0], "https://zoldhq.com/pay/bob");
  });

  await check("a repeated request reuses the signed answer for half its validity, whatever its hex case", async () => {
    // Signing is deterministic and `expires` is in whole seconds, so only a
    // later clock tells a reused answer from a fresh one.
    const call = callFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "text", args: [namehash("alice.zoldhq.com"), "url"] }));
    const first = await gateway(call);
    const data = (await first.json()).data;
    assert.match(first.headers.get("cache-control") ?? "", /max-age=60$/);
    const reused = await later(5_000, async () => (await (await gateway(call)).json()).data);
    assert.equal(reused, data, "reused, not re-signed");
    const upper = await later(5_000, async () => (await (await gateway(`0x${call.slice(2).toUpperCase()}` as Hex)).json()).data);
    assert.equal(upper, data, "the same request in upper-case hex is the same entry");
    const fresh = await later(151_000, async () => (await (await gateway(call)).json()).data);
    assert.notEqual(fresh, data, "re-signed once half the 300 s validity has passed");
  });

  await check("a handle with no page is cached for 30 s only, so a page claimed now shows soon", async () => {
    const call = addrCall("dave.zoldhq.com");
    assert.equal(decodeAbiParameters([{ type: "bytes" }], await answer(call))[0], "0x");
    store.addUser({
      id: "u-dave", name: "Dave", country: "DE", kycStatus: "approved",
      address: "0x5555555555555555555555555555555555555555", passkeySafe: safeOf("0x5555555555555555555555555555555555555555"),
      createdAt: new Date().toISOString(),
      paymentPage: { handle: "dave", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE" },
    } as any);
    const soon = await later(10_000, async () => (await (await gateway(call)).json()).data);
    const [stillEmpty] = decodeAbiParameters([{ type: "bytes" }], decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], soon)[0]);
    assert.equal(stillEmpty, "0x", "within 30 s the cached empty answer stands");
    const after = await later(31_000, async () => (await (await gateway(call)).json()).data);
    const [found] = decodeAbiParameters([{ type: "bytes" }], decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], after)[0]);
    assert.equal(found, "0x5555555555555555555555555555555555555555");
  });

  await check("unknown handles, org pages, deeper names and the parent answer nothing", async () => {
    for (const name of ["nobody.zoldhq.com", "acme.zoldhq.com", "x.alice.zoldhq.com", "zoldhq.com"]) {
      const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall(name)));
      assert.equal(address, "0x", name);
    }
  });

  await check("another sender still gets an answer signed for our resolver (the DNS path)", async () => {
    const r = await gateway(addrCall("alice.zoldhq.com"), "0x0000000000000000000000000000000000000bad");
    const { data } = await r.json();
    const [result, expires, sig] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], data);
    const signer = await recoverAddress({ hash: gatewaySignatureHash(RESOLVER, expires, addrCall("alice.zoldhq.com"), result), signature: sig });
    assert.equal(signer, privateKeyToAccount(GATEWAY_KEY).address);
  });

  await check("refused: another parent, a mismatched node, junk", async () => {
    assert.equal((await gateway(addrCall("alice.evil.com"))).status, 400);
    const mismatched = callFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("bob.zoldhq.com"), toCoinType(CHAIN_ID)] }));
    assert.equal((await gateway(mismatched)).status, 400);
    assert.equal((await gateway("0xdeadbeef")).status, 400);
    assert.equal((await gateway(callFor("alice.zoldhq.com", "0x12345678"))).status, 400, "unsupported record type");
    const r = await fetch(`${base}/ens/gateway/${RESOLVER}/nothex.json`);
    assert.equal(r.status, 400);
  });

  await check("browsers may read the gateway from any origin", async () => {
    const r = await gateway(addrCall("alice.zoldhq.com"));
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  await check("a resolver answer that is not an address is refused, not thrown", async () => {
    for (const bad of ["0x1234", "not-an-address", "0x" + "zz".repeat(20)]) {
      const r = ensAnswer("odd.eth", bad);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.code, "ENS_UNAVAILABLE");
    }
    const none = ensAnswer("none.eth", null);
    assert.equal(!none.ok && none.code, "NO_ADDRESS");
    const good = ensAnswer("alice.eth", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    assert.deepEqual(good, { ok: true, name: "alice.eth", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, "checksummed");
  });

  await check("the lookup needs a session, and says when it is not configured", async () => {
    assert.equal((await fetch(`${base}/ens/lookup?name=vitalik.eth`)).status, 401);
    assert.equal((await fetch(`${base}/ens/lookup?name=${"a".repeat(300)}.eth`, { headers: { "x-session": "1" } })).status, 400);
    const r = await fetch(`${base}/ens/lookup?name=vitalik.eth`, { headers: { "x-session": "1" } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "ENS_LOOKUP_OFF");
  });

  await check("a lookup never fetches a private, loopback or plain-http gateway", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1", "2002:a9fe:a9fe::1",
      // IPv4-compatible, site-local, discard-only, documentation, Teredo, and
      // mapped IPv4 in every spelling.
      "::", "::127.0.0.1", "::a9fe:a9fe", "fec0::1", "feff::1", "100::1", "2001:db8::1", "2001:0:4136:e378::1",
      "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:ffff:a00:1", "::FFFF:10.0.0.1",
      "192.0.2.1", "198.51.100.7", "203.0.113.9", "255.255.255.255", "fe80::1%eth0", "not-an-ip"]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001::1"]) assert.equal(isPublicAddress(ip), true, ip);
    // A gateway on our own loopback: refused over http, and over https because
    // localhost resolves to a loopback address.
    let hits = 0;
    const local = express().use((_req, res) => { hits++; res.json({ data: "0x01" }); }).listen(0);
    const port = (local.address() as any).port;
    try {
      for (const url of [`http://127.0.0.1:${port}/{sender}/{data}.json`, `https://localhost:${port}/{data}`, `https://127.0.0.1:${port}/{data}`]) {
        await assert.rejects(ccipFetch({ data: "0x1234", sender: RESOLVER as any, urls: [url] }), /no usable CCIP-Read gateway/, url);
      }
      assert.equal(hits, 0, "the loopback server was never reached");
      // Refused by the guard itself, not by a failed TLS handshake: an IP
      // literal skips Node's lookup hook, so it is checked on its own.
      for (const url of ["https://127.0.0.1:1/x", "https://10.0.0.5/x", "https://169.254.169.254/x", "https://[::1]:1/x", "https://[::ffff:7f00:1]/x", "https://localhost:1/x"]) {
        await assert.rejects(fetchPublic(url), /non-public address/, url);
      }
    } finally {
      local.close();
    }
  });

  await check("a handle ENS would refuse is refused at claim time", async () => {
    assert.throws(() => normaliseHandle("ab--cd"), (e: any) => e instanceof HandleError && /third and fourth/.test(e.message));
    assert.equal(normaliseHandle("a--bcd"), "a--bcd");
  });

  console.log(`\n${n} ens checks passed`);
} finally {
  server.close();
}
