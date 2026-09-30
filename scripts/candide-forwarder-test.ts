/**
 * Candide forwarding-address activation tests.
 *
 * `forwarding_getAddress` is pure computation and returns an address for any
 * destination chain id, Base Sepolia included, although Candide routes nothing
 * to or from any testnet. So activation must ask `forwarding_getRoutes` first
 * and refuse, before computing or activating anything, unless every source
 * chain routes the app's USDC to the app chain.
 *
 * Runs against a stub shaped like the live responses from
 * forward-api-alpha.candidelabs.com. No chain needed.
 *
 * Run: npm run forwarder:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const PORT = Number(process.env.TRANSF_FORWARDER_STUB_PORT ?? 8554);
const APP_CHAIN = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const SAFE = "0x1111111111111111111111111111111111111111";
const WITHDRAWER = "0x2222222222222222222222222222222222222222";
const FORWARDER = "0x3333333333333333333333333333333333333333";

process.env.TRANSF_CHAIN_ID = String(APP_CHAIN);
process.env.CANDIDE_FORWARDING_RPC_URL = `http://127.0.0.1:${PORT}`;
process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY = "test-key";
process.env.CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER = WITHDRAWER;
process.env.CANDIDE_FORWARDING_SOURCE_CHAIN_IDS = "8453,42161";

const { activatePaymentForwarder } = await import("../services/api/src/adapters/candide-forwarder.js");

/** Routes per source chain; a missing key answers `{ routes: [] }`, as testnets do live. */
let routes: Record<number, { destinationChainId: number; tokens: { destinationAddress: string }[] }[]> = {};
let calls: string[] = [];

function route(destinationChainId: number, ...destinationAddresses: string[]) {
  return {
    destinationChainId,
    tokens: destinationAddresses.map((destinationAddress) => ({ address: destinationAddress, symbol: "USDC", destinationAddress })),
  };
}

const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(raw);
    calls.push(method);
    const p = params[0];
    const result =
      method === "forwarding_getRoutes"
        ? { routes: (routes[p.sourceChainId] ?? []).map((r) => ({ sourceChainId: p.sourceChainId, ...r })) }
        : method === "forwarding_getAddress"
          ? { address: FORWARDER }
          : { address: FORWARDER, active: true, expiresAt: 2_000_000_000 };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  calls = [];
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`);
  }
}

const activate = () => activatePaymentForwarder({ userId: "u1", handle: "anna", recipient: SAFE, token: USDC });

console.log("candide forwarder");

await check("activates when every source chain routes USDC to the app chain", async () => {
  routes = { 8453: [route(APP_CHAIN, USDC)], 42161: [route(1), route(APP_CHAIN, OTHER, USDC)] };
  const out = await activate();
  assert.equal(out.address, FORWARDER);
  assert.equal(out.forwarder.provider, "candide");
  assert.deepEqual(out.forwarder.sourceChainIds, [8453, 42161]);
  assert.deepEqual(calls, [
    "forwarding_getRoutes",
    "forwarding_getRoutes",
    "forwarding_getAddress",
    "account_activateForwardingAddress",
  ]);
});

await check("refuses a destination chain Candide does not serve, before computing an address", async () => {
  routes = {}; // what every testnet source answers live
  await assert.rejects(activate, /no forwarding route from chain 8453 to chain 8453/);
  assert.deepEqual(calls, ["forwarding_getRoutes"]);
});

await check("refuses when one source chain has no route to the app chain", async () => {
  routes = { 8453: [route(APP_CHAIN, USDC)], 42161: [route(1, USDC)] };
  await assert.rejects(activate, /no forwarding route from chain 42161 to chain 8453/);
  assert.ok(!calls.includes("account_activateForwardingAddress"));
});

await check("refuses a route that does not deliver the app's USDC", async () => {
  routes = { 8453: [route(APP_CHAIN, USDC)], 42161: [route(APP_CHAIN, OTHER)] };
  await assert.rejects(activate, /route from chain 42161 to chain 8453 does not deliver/);
  assert.ok(!calls.includes("forwarding_getAddress"));
});

server.close();
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
