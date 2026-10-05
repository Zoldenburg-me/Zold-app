/**
 * ENS routes: the CCIP-Read gateway that answers `<handle>.zoldhq.com`, and
 * the signed-in ENS lookup.
 *
 * Covers:
 *   - a live page answers its deposit address for the pay chain's coin type,
 *     signed by the gateway key for the configured resolver, whoever relays it;
 *   - no Ethereum (coin type 60) address unless the page takes payments there;
 *   - org pages, unknown handles and deeper names answer nothing;
 *   - malformed calls, names under another parent, a node that does not match
 *     its name are refused;
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
process.env.TRANSF_PUBLIC_URL = "https://zoldhq.com";
delete process.env.ENS_RPC_URL;

const { store, initStore } = await import("../services/api/src/store.js");
const { CHAIN_ID } = await import("../services/api/src/config.js");
const { createEnsRouter, ccipFetch, fetchPublic, isPublicAddress } = await import("../services/api/src/routes/ens.js");
const { gatewaySignatureHash } = await import("../services/api/src/ens.js");
const { HandleError, normaliseHandle } = await import("../services/api/src/pay.js");
initStore();

const PAGE = "0x2222222222222222222222222222222222222222";
store.addUser({
  id: "u-alice", name: "Alice", country: "DE", kycStatus: "approved",
  address: "0x1111111111111111111111111111111111111111",
  createdAt: new Date().toISOString(),
  paymentPage: { handle: "alice", depositAddress: PAGE, autoConvert: true, settlementAsset: "EURE" },
} as any);
store.addOrganisation({ id: "o-acme", name: "Acme", createdAt: new Date().toISOString(), paymentPage: { handle: "acme" } } as any, false);

const app = express().use(
  "/api",
  createEnsRouter({
    requireSession: (req, res) => (req.header("x-session") ? true : (res.status(401).json({ error: "authorization required" }), false)),
  }),
);
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

try {
  await check("a live page answers its deposit address for the pay chain, signed", async () => {
    const [address] = decodeAbiParameters([{ type: "bytes" }], await answer(addrCall("alice.zoldhq.com")));
    assert.equal(address, PAGE);
  });

  await check("no Ethereum address for a page that does not take payments on Ethereum", async () => {
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
