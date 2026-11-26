/**
 * The Bridge.xyz leg of the cash rail, offline: every answer Bridge could give
 * to a create, and what the orchestrator does with it.
 *
 * Part 1 drives createBridgeTransfer against a stub fetch: timeouts on the
 * request and on the body, empty, non-JSON, null and oversized bodies,
 * refusals and ambiguous errors, an idempotent replay, a replay that answers
 * with a different order, and a re-send whose body differs from the one
 * already sent under the transfer's Idempotency-Key.
 *
 * Part 2 runs the real executor on a local hardhat chain with Bridge and the
 * anchor stubbed. The passkey debit is the harness's fake operation (a hardhat
 * node has no bundler), so the scenario mints what the debit would deliver.
 * Part 3 hands compensation and the stranded sweep the rows each failure
 * point leaves behind.
 *
 * The rule under test: once USDC may be at Bridge, nothing refunds and nothing
 * is sent again; uncertain means review. While the USDC is still ours (the
 * orchestrator holds it and no deposit went out), a refused Bridge create
 * refunds.
 *
 * Nothing here reaches Bridge, an anchor or any network: an unexpected host
 * throws. `create/status`: there is no Bridge status call or callback in the
 * code; the create answer (and its idempotent replay) is the only Bridge state
 * the API reads.
 *
 *   npm run bridge:harness:test
 */
// Must be first: pins chain and keys.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRYPOINT_V9 } from "abstractionkit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hardhatNode } from "./_free-port.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPOSIT = "0x00000000000000000000000000000000000d3b05" as const;
const OTHER_DEPOSIT = "0x00000000000000000000000000000000000d3b06" as const;
const STELLAR_DEST = "GATESTDESTINATION";
const SEND_EUR = 40;

Object.assign(process.env, {
  LIQUIDITY_PROVIDER: "fx-swapper",
  DEPLOY_EURUSD_RATE: "1137900",
  CASH_FEE_EUR: "1",
  BRIDGE_LIVE: "1",
  BRIDGE_API_KEY: "bridge-test-key-SECRET",
  BRIDGE_ON_BEHALF_OF: "cust_test",
  BRIDGE_BASE_URL: "https://bridge.test",
  BRIDGE_DESTINATION_ADDRESS: STELLAR_DEST,
  BRIDGE_DESTINATION_MEMO: "",
  MG_ANCHOR_DOMAIN: "anchor.test",
  MG_ANCHOR_ASSET: "native",
  STELLAR_PASSPHRASE: "Test SDF Network ; September 2015",
  // Short, so the timeout cases finish quickly. Read once, at import.
  PARTNER_HTTP_TIMEOUT_MS: "300",
});

// The database lives in a directory this run created, whatever
// TRANSF_DB_PATH was on entry: the cleanup removes only that directory, so an
// exported path to a working database is never touched. Set before the deploy
// child and before any store import.
const inheritedDb = process.env.TRANSF_DB_PATH;
const inheritedDbBefore = inheritedDb && existsSync(inheritedDb) ? readFileSync(inheritedDb) : undefined;
const DB_DIR = mkdtempSync(path.join(os.tmpdir(), "zold-bridge-harness-"));
process.env.TRANSF_DB_PATH = path.join(DB_DIR, "db.json");

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`   ok  ${label}`);
};

// ── stub network ────────────────────────────────────────────────────────────
type BridgeCall = { url: string; headers: Record<string, string>; body: any };
type BridgeAnswer = (call: BridgeCall, signal: AbortSignal | undefined) => Promise<Response> | Response;
let bridgeAnswer: BridgeAnswer = () => {
  throw new Error("no Bridge answer armed");
};
const bridgeCalls: BridgeCall[] = [];
let anchorCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input?.url ?? input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "bridge.test") {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: BridgeCall = {
      url: url.toString(),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    bridgeCalls.push(call);
    return bridgeAnswer(call, init?.signal);
  }
  if (url.hostname === "anchor.test") {
    // The anchor is down: the payout leg fails after Bridge holds the deposit.
    anchorCalls++;
    throw new TypeError("fetch failed (anchor stub is down)");
  }
  throw new Error(`offline suite tried to reach ${url.hostname}`);
}) as typeof fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What Bridge answers for exactly the order `call` asked for. */
function echo(call: BridgeCall, over: Record<string, any> = {}) {
  const b = call.body;
  return {
    id: "tr_1",
    state: "awaiting_funds",
    on_behalf_of: b.on_behalf_of,
    amount: b.amount,
    currency: "usd",
    source: { ...b.source },
    destination: { ...b.destination },
    source_deposit_instructions: {
      payment_rail: b.source.payment_rail,
      amount: b.amount,
      currency: b.source.currency,
      ...(b.source.from_address ? { from_address: b.source.from_address } : {}),
      to_address: DEPOSIT,
    },
    ...over,
  };
}

/** A response whose headers arrive and whose body never does, until the caller's signal fires. */
function hangingBody(signal: AbortSignal | undefined) {
  const stream = new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

function hangingRequest(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
}

const chainNode = await hardhatNode(ROOT);
process.env.TRANSF_RPC_URL = chainNode.url;
try {
  const deploy = spawnSync(process.execPath, [path.join(ROOT, "node_modules/.bin/tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(deploy.status, 0, `deploy failed\n${deploy.stderr}`);

  const bridge = await import("../services/api/src/bridge/bridgexyz.js");
  const { BRIDGE } = await import("../services/api/src/config.js");
  const { createBridgeTransfer, BridgeTransferError, bridgeRequestHash } = bridge;

  // ── Part 1: the adapter ───────────────────────────────────────────────────
  console.log("1/3 createBridgeTransfer against a stub Bridge");
  const DEST = { paymentRail: "stellar", currency: "usdc", toAddress: STELLAR_DEST };
  const SAFE = `0x${"ab".repeat(20)}`;
  const create = (id = "t1", amount = 12.345, dest: typeof DEST & { blockchainMemo?: string } = DEST, opts: any = { sourceAddress: SAFE }) =>
    createBridgeTransfer(id, amount, dest, opts);
  /** The call refuses with a BridgeTransferError whose message matches, never
   *  resolves, and never leaks the API key. Returns the error. */
  async function refuses(label: string, run: () => Promise<unknown>, message: RegExp) {
    let err: any;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${label}: resolved instead of refusing`);
    assert.ok(err instanceof BridgeTransferError, `${label}: threw ${err?.name}: ${err?.message}`);
    assert.match(err.message, message, label);
    assert.ok(!err.message.includes(BRIDGE.apiKey), `${label}: the error carries the API key`);
    assert.ok(err.plan, `${label}: no plan on the error, so the attempt is not on record`);
    assert.equal(err.plan.idempotencyKey, "zold-t1-bridge", label);
    ok(label);
    return err as InstanceType<typeof BridgeTransferError>;
  }

  {
    bridgeCalls.length = 0;
    bridgeAnswer = (c) => json(echo(c));
    const plan = await create();
    const [c] = bridgeCalls;
    assert.equal(bridgeCalls.length, 1);
    assert.equal(c.url, "https://bridge.test/v0/transfers");
    assert.equal(c.headers["idempotency-key"], "zold-t1-bridge");
    assert.equal(c.headers["api-key"], BRIDGE.apiKey);
    assert.equal(c.body.amount, "12.34", "the amount is floored to cents, never rounded up");
    assert.deepEqual(c.body.source, { payment_rail: "base", currency: "usdc", from_address: SAFE });
    assert.deepEqual(c.body.destination, { payment_rail: "stellar", currency: "usdc", to_address: STELLAR_DEST });
    assert.equal(plan.transferId, "tr_1");
    assert.equal(plan.sourceDepositInstructions?.to_address, DEPOSIT);
    ok("a create carries the transfer's Idempotency-Key and the floored amount; a matching answer is the plan");
  }

  {
    BRIDGE.live = false;
    bridgeCalls.length = 0;
    await refuses("a closed rail refuses before any request", () => create(), /cash rail is closed/);
    assert.equal(bridgeCalls.length, 0);
    BRIDGE.live = true;
  }

  // Timeouts: the request may have reached Bridge. The adapter refuses (the
  // caller decides review vs refund from where the money is) and the attempt
  // is on record with its idempotency key.
  bridgeAnswer = (_c, signal) => hangingRequest(signal);
  await refuses("a create with no answer times out and refuses, outcome unknown", () => create(), /outcome unknown/);
  bridgeAnswer = (_c, signal) => hangingBody(signal);
  await refuses("a create whose body never arrives times out and refuses", () => create(), /outcome unknown/);
  bridgeAnswer = () => {
    throw new TypeError("fetch failed");
  };
  await refuses("a connection failure refuses, outcome unknown", () => create(), /outcome unknown/);

  // Bodies a 2xx must not be taken from.
  bridgeAnswer = () => new Response("", { status: 200 });
  await refuses("a 200 with an empty body refuses", () => create(), /no transfer id|not a JSON object/);
  bridgeAnswer = () => new Response("<html>ok</html>", { status: 200 });
  await refuses("a 200 with a non-JSON body refuses", () => create(), /not a JSON object|no transfer id/);
  bridgeAnswer = () => new Response("null", { status: 200 });
  await refuses("a 200 with a JSON null refuses", () => create(), /not a JSON object/);
  bridgeAnswer = () => json([echo({ body: { source: {}, destination: {} } } as any)]);
  await refuses("a 200 with a JSON array refuses", () => create(), /not a JSON object/);
  bridgeAnswer = (c) => json({ ...echo(c), padding: "x".repeat(2 * 1024 * 1024) });
  await refuses("a 200 with an oversized body refuses without parsing it", () => create(), /larger than/);
  bridgeAnswer = (c) => json(echo(c, { id: "" }));
  await refuses("a 200 with no transfer id refuses", () => create(), /no transfer id/);

  // Refusals and ambiguous errors: all refuse, none resolves into a plan.
  for (const status of [400, 401, 409, 422, 429, 500, 502, 503]) {
    bridgeAnswer = () => json({ code: "x", message: `status ${status}` }, status);
    await refuses(`a ${status} refuses`, () => create(), new RegExp(`\\(${status}\\)`));
  }
  bridgeAnswer = () => new Response("y".repeat(1024 * 1024), { status: 500 });
  {
    const e = await refuses("a 500 with an oversized body refuses without reading it all", () => create(), /larger than/);
    assert.ok(e.message.length < 2048, `the error message carries ${e.message.length} chars of upstream body`);
  }

  // An idempotent replay: the same order, answered twice (a duplicate answer).
  {
    bridgeCalls.length = 0;
    bridgeAnswer = (c) => json(echo(c));
    const one = await create();
    const two = await create();
    assert.equal(bridgeCalls.length, 2);
    assert.equal(bridgeCalls[0].headers["idempotency-key"], bridgeCalls[1].headers["idempotency-key"]);
    assert.deepEqual(bridgeCalls[0].body, bridgeCalls[1].body, "a replay sends the same body");
    assert.equal(one.transferId, two.transferId);
    assert.equal(one.sourceDepositInstructions?.to_address, two.sourceDepositInstructions?.to_address);
    ok("a replay of the same order sends the same body under the same key and matches");
  }
  {
    // Bridge's amounts drop trailing zeros; "12.3" is the order for "12.30".
    bridgeAnswer = (c) => json(echo(c, { amount: "12.3", source_deposit_instructions: { ...echo(c).source_deposit_instructions, amount: "12.30" } }));
    await create("t1", 12.3);
    ok("an amount Bridge writes without trailing zeros still matches");
  }

  // A replay that answers with a different order than the one sent: Bridge
  // holds another body under this key. The plan carries what Bridge said, so
  // the caller records it, and it must not be used.
  const mismatches: [string, (c: BridgeCall) => any, RegExp][] = [
    ["amount", (c) => echo(c, { amount: "99.00" }), /amount/],
    ["customer", (c) => echo(c, { on_behalf_of: "cust_other" }), /customer/],
    ["(missing) customer", (c) => echo(c, { on_behalf_of: undefined }), /customer/],
    ["customer, by case", (c) => echo(c, { on_behalf_of: "CUST_TEST" }), /customer/],
    ["source chain", (c) => echo(c, { source: { ...c.body.source, payment_rail: "ethereum" } }), /source/],
    ["source asset", (c) => echo(c, { source: { ...c.body.source, currency: "usdt" } }), /source/],
    ["source address", (c) => echo(c, { source: { ...c.body.source, from_address: `0x${"cd".repeat(20)}` } }), /source/],
    ["destination address", (c) => echo(c, { destination: { ...c.body.destination, to_address: "GOTHER" } }), /destination/],
    ["destination rail", (c) => echo(c, { destination: { ...c.body.destination, payment_rail: "solana" } }), /destination/],
    ["destination memo", (c) => echo(c, { destination: { ...c.body.destination, blockchain_memo: "m2" } }), /destination/],
    ["deposit amount", (c) => echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, amount: "1.00" } }), /deposit/],
    ["deposit asset", (c) => echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, currency: "eurc" } }), /deposit/],
    ["deposit chain", (c) => echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, payment_rail: "ethereum" } }), /deposit/],
    ["deposit from-address", (c) => echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, from_address: `0x${"cd".repeat(20)}` } }), /deposit/],
    ["deposit address", (c) => echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, to_address: "not-an-address" } }), /deposit/],
    ["no deposit instructions", (c) => echo(c, { source_deposit_instructions: undefined }), /deposit/],
  ];
  for (const [what, answer, message] of mismatches) {
    bridgeAnswer = (c) => json(answer(c));
    const e = await refuses(`a replay answering a different ${what} refuses`, () => create(), message);
    assert.equal(e.plan?.transferId, "tr_1", `${what}: the refused plan names Bridge's transfer`);
  }
  {
    // Paid, and broken: the plan still carries the destination hash, which
    // tells the caller the money moved.
    bridgeAnswer = (c) =>
      json(echo(c, { state: "payment_processed", receipt: { destination_tx_hash: "stellar-tx-1" }, source_deposit_instructions: undefined }));
    const e = await refuses("a paid answer with broken deposit instructions refuses, destination hash kept", () => create(), /deposit/);
    assert.equal(e.plan?.destinationTxHash, "stellar-tx-1");
  }

  // The same zoldTransferId with a changed body is a LOCAL conflict: refused
  // before a request goes out under the key of a different order.
  {
    const sent = bridgeRequestHash("t1", 12.34, DEST, { sourceAddress: SAFE });
    const changed: [string, string][] = [
      ["amount", bridgeRequestHash("t1", 12.35, DEST, { sourceAddress: SAFE })],
      ["recipient", bridgeRequestHash("t1", 12.34, { ...DEST, toAddress: "GOTHER" }, { sourceAddress: SAFE })],
      ["memo", bridgeRequestHash("t1", 12.34, { ...DEST, blockchainMemo: "m" }, { sourceAddress: SAFE })],
      ["target rail", bridgeRequestHash("t1", 12.34, { ...DEST, paymentRail: "solana" }, { sourceAddress: SAFE })],
      ["source", bridgeRequestHash("t1", 12.34, DEST, { sourceAddress: `0x${"cd".repeat(20)}` })],
      ["transfer", bridgeRequestHash("t2", 12.34, DEST, { sourceAddress: SAFE })],
    ];
    for (const [what, h] of changed) assert.notEqual(h, sent, `a changed ${what} hashes the same`);
    assert.equal(bridgeRequestHash("t1", 12.345, DEST, { sourceAddress: SAFE }), sent, "the hash is over the floored amount Bridge is sent");
    assert.equal(bridgeRequestHash("t1", 12.34, DEST, { sourceAddress: SAFE.toUpperCase().replace("0X", "0x") }), sent, "an address's case is not a different order");
    ok("the request hash changes with amount, recipient, memo, rail, source and transfer");

    bridgeAnswer = (c) => json(echo(c));
    for (const [what, amount, dest, src] of [
      ["amount", 12.35, DEST, SAFE],
      ["recipient", 12.34, { ...DEST, toAddress: "GOTHER" }, SAFE],
      ["target", 12.34, { ...DEST, paymentRail: "solana" }, SAFE],
      ["source", 12.34, DEST, `0x${"cd".repeat(20)}`],
    ] as const) {
      bridgeCalls.length = 0;
      await refuses(
        `a re-send with a changed ${what} is a local conflict, nothing sent`,
        () => create("t1", amount, dest, { sourceAddress: src, expectRequest: sent }),
        /already sent a different order/,
      );
      assert.equal(bridgeCalls.length, 0, `${what}: a request went out under the key of a different order`);
    }
    bridgeCalls.length = 0;
    await create("t1", 12.34, DEST, { sourceAddress: SAFE, expectRequest: sent });
    assert.equal(bridgeCalls.length, 1);
    ok("a re-send of the recorded order goes out");
  }

  // ── Part 2: the executor ──────────────────────────────────────────────────
  console.log("2/3 executeTransfer with a stub Bridge and a down anchor");
  const { initStore, store } = await import("../services/api/src/store.js");
  const chain = await import("../services/api/src/chain.js");
  const orch = await import("../services/api/src/orchestrator.js");
  const { liquidityProvider } = await import("../services/api/src/liquidity.js");
  const { abis, addrs, deployerWallet, eur, orchestratorAddress, publicClient, usd, writeAndWait } = chain;
  initStore();

  const mint = (token: `0x${string}`, to: `0x${string}`, amount: bigint) =>
    writeAndWait(deployerWallet!, { address: token, abi: abis.MockToken, functionName: "mint", args: [to, amount] });
  const balance = (token: `0x${string}`, who: `0x${string}`) =>
    publicClient.readContract({ address: token, abi: abis.MockToken, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  // The fake batch's receipt is the delivery mint's, with the fake userOp's
  // event, as an EntryPoint bundle carries it. The mint happens on the first
  // receipt read, after the executor read the recipient's balance.
  const { HARNESS_SAFE_EXECUTION } = orch;
  const realReceipt = publicClient.getTransactionReceipt.bind(publicClient);
  let batchDelivery: { to: `0x${string}`; usdc: number } | undefined;
  let batchTx: Promise<`0x${string}`> | undefined;
  (publicClient as any).getTransactionReceipt = async ({ hash }: { hash: `0x${string}` }) => {
    if (hash !== HARNESS_SAFE_EXECUTION.txHash || !batchDelivery) return realReceipt({ hash });
    batchTx ??= mint(addrs().usdc, batchDelivery.to, usd.toUnits(batchDelivery.usdc));
    const r = await realReceipt({ hash: await batchTx });
    const userOpEvent = {
      address: ENTRYPOINT_V9, data: "0x", logIndex: r.logs.length,
      topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", HARNESS_SAFE_EXECUTION.userOpHash],
    };
    return { ...r, logs: [...r.logs, userOpEvent] };
  };

  const { raw: lockedRate } = await liquidityProvider().indicativeRate("EURE_TO_USDC");
  const bridgeDest = { paymentRail: BRIDGE.destinationRail, currency: BRIDGE.destinationCurrency, toAddress: BRIDGE.destinationAddress };

  /** A user, a quote and a CREATED transfer as /api/transfers leaves them, claimed and signed. */
  async function seed(kind: "batch" | "plain", over: { bridgeRequest?: (id: string, safe: string) => string; bridgeAmountUsdc?: number } = {}) {
    const device = privateKeyToAccount(generatePrivateKey());
    const address = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    const now = new Date().toISOString();
    const user: any = {
      id: `8${randomBytes(3).readUIntBE(0, 3)}`, name: "Bridge Harness", country: "DE", kycStatus: "approved", iban: "",
      address, authorizerAddress: device.address, passkeySafe: { status: "active", address }, createdAt: now,
    };
    store.addUser(user);
    const quoteId = randomUUID();
    store.addQuote({
      id: quoteId, userId: user.id, rail: "cash", status: "OPEN", sendEur: SEND_EUR, fixedFeeEur: 1, fxRate: 1,
      receiveKes: 1000, receiveEur: 0, midRate: 1, marginBps: 0, effectiveRate: 1, lockedSwapRate: String(lockedRate),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now,
    } as any);
    const id = randomUUID();
    const deadline = Math.floor(Date.now() / 1000) + 900;
    const amountWei = eur.toWei(SEND_EUR);
    const destination = chain.destinationCommitment("cash", { phone: "+254700000000", name: "Recipient" });
    const t: any = {
      id, userId: user.id, quoteId, rail: "cash", recipientName: "Recipient", recipientPhone: "+254700000000",
      state: "CREATED", sendEur: SEND_EUR, receiveKes: 1000, fundingSource: "safe", txs: [],
      auth: { to: orchestratorAddress, amountWei: amountWei.toString(), destination, deadline },
      createdAt: now, updatedAt: now,
    };
    if (kind === "batch") {
      const bridgeAmountUsdc = over.bridgeAmountUsdc ?? 10;
      t.safeSwap = { recipient: DEPOSIT, mode: "live", bridgeAmountUsdc };
      t.liquidity = {
        provider: "dex", side: "EURE_TO_USDC", quoteId, tokenIn: "EURe", tokenOut: "USDC",
        amountIn: "1", expectedOut: "1", minOut: "0", rate: "1000000", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      // What build.ts records before its create goes out.
      t.bridgeRequest = over.bridgeRequest
        ? over.bridgeRequest(id, address)
        : bridgeRequestHash(id, bridgeAmountUsdc, bridgeDest, { sourceAddress: address });
    } else {
      // The plain debit delivers the EURe to the orchestrator; mint it, plus
      // other users' money a wrong refund would be paid from.
      await mint(addrs().eure, orchestratorAddress, eur.toWei(SEND_EUR * 2));
      if (over.bridgeRequest) t.bridgeRequest = over.bridgeRequest(id, address);
    }
    store.addTransfer(t);
    assert.ok(store.claimAuthorization(id));
    const signature = await device.signTypedData(
      chain.paymentAuthorizationTypedData({
        account: address, amountWei, to: orchestratorAddress, transferId: chain.transferIdHash(id), destination, deadline,
      }) as any,
    );
    return { id, user, auth: { deadline, signature } };
  }

  interface Expect {
    state: string;
    /** EURe back in the Safe. */
    refunded: boolean;
    /** Creates that reached the stub Bridge. */
    bridgeCalls: number;
    /** USDC that reached Bridge's deposit address (the orchestrator's deposit, or the batch's
     *  delivery); "some" is any amount above 0. Nothing ever reaches OTHER_DEPOSIT. */
    deposited: number | "some";
    error?: RegExp;
    steps?: string[];
    absent?: string[];
  }
  async function scenario(
    label: string,
    kind: "batch" | "plain",
    answer: BridgeAnswer,
    expect: Expect,
    over: Parameters<typeof seed>[1] & { recipient?: `0x${string}`; deliver?: number } = {},
  ) {
    const { id, user, auth } = await seed(kind, over);
    bridgeAnswer = answer;
    bridgeCalls.length = 0;
    batchTx = undefined;
    batchDelivery = kind === "batch" ? { to: over.recipient ?? DEPOSIT, usdc: over.deliver ?? 10 } : undefined;
    const safeBefore = await balance(addrs().eure, user.address);
    const depositBefore = await balance(addrs().usdc, DEPOSIT);
    const otherBefore = await balance(addrs().usdc, OTHER_DEPOSIT);
    const execution: any = kind === "batch" ? { batch: { recipient: over.recipient ?? DEPOSIT, mode: "live" } } : {};
    await orch.executeTransfer(store.findTransfer(id)!, user, auth, execution);
    // Two sweeps, as a restart would run them: neither may refund or resend.
    store.findTransfer(id)!.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await orch.sweepStrandedTransfers();
    await orch.sweepStrandedTransfers();
    const end = store.findTransfer(id)!;
    const refunded = (await balance(addrs().eure, user.address)) - safeBefore;
    const steps = end.txs.map((x) => x.step);
    const deposited = usd.fromUnits((await balance(addrs().usdc, DEPOSIT)) - depositBefore);
    const other = usd.fromUnits((await balance(addrs().usdc, OTHER_DEPOSIT)) - otherBefore);
    const detail = `${label}: ended ${end.state}, refunded ${refunded}, Bridge calls ${bridgeCalls.length}, deposited ${deposited}, steps [${steps}], error ${end.error}`;
    assert.equal(end.state, expect.state, detail);
    assert.equal(refunded > 0n, expect.refunded, detail);
    assert.equal(bridgeCalls.length, expect.bridgeCalls, detail);
    assert.equal(other, 0, `${detail}: ${other} USDC reached another deposit address`);
    if (expect.deposited === "some") assert.ok(deposited > 0, detail);
    else assert.equal(deposited, expect.deposited, detail);
    if (expect.error) assert.match(end.error ?? "", expect.error, detail);
    for (const s of expect.steps ?? []) assert.ok(steps.includes(s), `${detail}: missing ${s}`);
    for (const s of expect.absent ?? []) assert.ok(!steps.includes(s), `${detail}: has ${s}`);
    if (!expect.refunded) assert.ok(!end.refund || end.refund.amountEur === 0, `${detail}: a refund is on record`);
    ok(label);
    return end;
  }
  const atBridge = /reached Bridge|delivered USDC to Bridge deposit|reconcile/;

  // Batched send: the user-signed batch delivers straight to Bridge's deposit
  // address, so after the debit the money is at Bridge whatever Bridge says.
  await scenario("batch: the replay matches, the anchor is down → review, no refund", "batch", (c) => json(echo(c)), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge,
    steps: ["bridge.xyz.live.transfer", "bridge.xyz.deposit.funded"],
  });
  await scenario("batch: the replay times out → review, no refund, no second create", "batch", (_c, s) => hangingRequest(s), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge,
    steps: ["bridge.xyz.live.transfer"], absent: ["bridge.xyz.deposit.funded"],
  });
  await scenario("batch: the replay answers 500 → review", "batch", () => json({ message: "boom" }, 500), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge,
  });
  await scenario("batch: the replay answers an empty 200 → review", "batch", () => new Response("", { status: 200 }), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge,
  });
  await scenario("batch: the replay names another deposit address → review", "batch",
    (c) => json(echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, to_address: OTHER_DEPOSIT } })), {
      state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge, absent: ["bridge.xyz.deposit.funded"],
    });
  await scenario("batch: the replay answers another order's amount → review", "batch", (c) => json(echo(c, { amount: "99.00" })), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge, absent: ["bridge.xyz.deposit.funded"],
  });
  await scenario("batch: the replay answers another customer's order → review", "batch", (c) => json(echo(c, { on_behalf_of: "cust_other" })), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, error: atBridge, absent: ["bridge.xyz.deposit.funded"],
  });
  await scenario("batch: paid, with broken deposit instructions → review, destination hash on record", "batch",
    (c) => json(echo(c, { state: "payment_processed", receipt: { destination_tx_hash: "stellar-tx-2" }, source_deposit_instructions: {} })), {
      state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 10, steps: ["bridge.xyz.destination_tx"],
    });
  // The local conflict, before the debit: nothing moves, nothing is sent.
  await scenario("batch: the recorded order's amount differs from the one execute would send → refused before the debit", "batch",
    (c) => json(echo(c)), {
      state: "FAILED", refunded: false, bridgeCalls: 0, deposited: 0, error: /different order|nothing was debited/, absent: [orch.DEBIT_STEP.safe],
    }, { bridgeRequest: (id, safe) => bridgeRequestHash(id, 11, bridgeDest, { sourceAddress: safe }) });
  await scenario("batch: the recorded order went to another recipient → refused before the debit", "batch",
    (c) => json(echo(c)), {
      state: "FAILED", refunded: false, bridgeCalls: 0, deposited: 0, error: /different order|nothing was debited/, absent: [orch.DEBIT_STEP.safe],
    }, { bridgeRequest: (id, safe) => bridgeRequestHash(id, 10, { ...bridgeDest, toAddress: "GOTHER" }, { sourceAddress: safe }) });
  await scenario("batch: the signed batch's recipient is not the persisted deposit address → refused before the debit", "batch",
    (c) => json(echo(c)), {
      state: "FAILED", refunded: false, bridgeCalls: 0, deposited: 0, error: /recipient|nothing was debited/, absent: [orch.DEBIT_STEP.safe],
    }, { recipient: OTHER_DEPOSIT });
  await scenario("batch: delivered 8 of the 10 Bridge was created for → review", "batch", (c) => json(echo(c)), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 0, deposited: 8, error: /below the 10000000/,
  }, { deliver: 8 });

  // Plain send: the orchestrator holds the USDC until its own deposit write.
  // A Bridge create that fails before that write leaves the money ours, so it
  // refunds; once the deposit is sent, it is review.
  await scenario("plain: the create matches, deposit sent, the anchor is down → review, no refund", "plain", (c) => json(echo(c)), {
    state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: "some", error: atBridge,
    steps: ["bridge.xyz.deposit.transfer"],
  });
  await scenario("plain: the create times out (accepted, maybe) → no deposit, refunded", "plain", (_c, s) => hangingRequest(s), {
    state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, steps: ["bridge.xyz.live.transfer"], absent: ["bridge.xyz.deposit.pending"],
  });
  await scenario("plain: the create answers 502 → no deposit, refunded", "plain", () => json({ message: "bad gateway" }, 502), {
    state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, absent: ["bridge.xyz.deposit.pending"],
  });
  await scenario("plain: the create answers a non-JSON 200 → no deposit, refunded", "plain", () => new Response("ok", { status: 200 }), {
    state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, absent: ["bridge.xyz.deposit.pending"],
  });
  await scenario("plain: the create answers another order (amount) → no deposit, refunded", "plain", (c) => json(echo(c, { amount: "1.00" })), {
    state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, absent: ["bridge.xyz.deposit.pending"],
  });
  await scenario("plain: the create answers another customer's order → no deposit, refunded", "plain", (c) => json(echo(c, { on_behalf_of: "cust_other" })), {
    state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, absent: ["bridge.xyz.deposit.pending"],
  });
  await scenario("plain: the create answers another deposit chain → no deposit, refunded", "plain",
    (c) => json(echo(c, { source_deposit_instructions: { ...echo(c).source_deposit_instructions, payment_rail: "ethereum" } })), {
      state: "REFUNDED", refunded: true, bridgeCalls: 1, deposited: 0, absent: ["bridge.xyz.deposit.pending"],
    });
  await scenario("plain: paid, with broken deposit instructions → review, never refunded", "plain",
    (c) => json(echo(c, { state: "payment_processed", receipt: { destination_tx_hash: "stellar-tx-3" }, source_deposit_instructions: undefined })), {
      state: "MANUAL_REVIEW", refunded: false, bridgeCalls: 1, deposited: 0, steps: ["bridge.xyz.destination_tx"],
    });
  // A batched send's create went out at /api/transfers, then build fell back
  // to the plain debit. Execute would re-send under the same key with the
  // orchestrator as source and the swap's output as amount: a different order.
  await scenario("plain: a batched create is already on record → refused before the debit, nothing sent", "plain",
    (c) => json(echo(c)), {
      state: "FAILED", refunded: false, bridgeCalls: 0, deposited: 0, error: /different order|nothing was debited/, absent: [orch.DEBIT_STEP.safe],
    }, { bridgeRequest: (id, safe) => bridgeRequestHash(id, 10, bridgeDest, { sourceAddress: safe }) });

  {
    // A second execute of a transfer that already paid into Bridge: no second
    // debit, no second create, no refund.
    const { id, user, auth } = await seed("batch");
    bridgeAnswer = (c) => json(echo(c));
    bridgeCalls.length = 0;
    batchTx = undefined;
    batchDelivery = { to: DEPOSIT, usdc: 10 };
    const execution: any = { batch: { recipient: DEPOSIT, mode: "live" } };
    await orch.executeTransfer(store.findTransfer(id)!, user, auth, execution);
    const safeBefore = await balance(addrs().eure, user.address);
    await orch.executeTransfer(store.findTransfer(id)!, user, auth, execution);
    const end = store.findTransfer(id)!;
    assert.equal(bridgeCalls.length, 1, "the second execute reached Bridge");
    assert.equal(end.txs.filter((x) => x.step === orch.DEBIT_STEP.safe).length, 1, "debited twice");
    assert.equal(end.state, "MANUAL_REVIEW");
    assert.equal(await balance(addrs().eure, user.address), safeBefore);
    ok("a duplicate execute after Bridge holds the deposit: one debit, one create, no refund");
  }

  {
    // CoW prices but cannot settle a swap for anyone, so a cash send on it
    // (alone, or as one of best's venues: it may win the price) would debit
    // and then strand in review. /api/transfers refuses it before the debit:
    // no quote spent, no row, no prepared operation, no Bridge order.
    const { LIQUIDITY } = await import("../services/api/src/config.js");
    const { buildTransferFromQuote } = await import("../services/api/src/transfers/build.js");
    const { pendingTransferExecutions } = await import("../services/api/src/http/pending.js");
    const configured = { provider: LIQUIDITY.PROVIDER, venues: [...LIQUIDITY.VENUES] };
    const recipient = { recipientName: "Recipient", recipientPhone: "+254700000000" };
    const freshQuote = async () => {
      const { id, user } = await seed("batch");
      // seed() wrote the transfer its quote became; this copy is still open.
      const quote = { ...store.findQuote(store.findTransfer(id)!.quoteId)!, id: randomUUID(), status: "OPEN" } as any;
      store.addQuote(quote);
      return { user, quote };
    };
    try {
      for (const [provider, venues] of [["cow", configured.venues], ["best", ["dex", "cow"]]] as const) {
        (LIQUIDITY as any).PROVIDER = provider;
        (LIQUIDITY as any).VENUES = venues;
        const { user, quote } = await freshQuote();
        const rowsBefore = store.transfers.filter((x) => x.userId === user.id).length;
        const pendingBefore = pendingTransferExecutions.size;
        bridgeCalls.length = 0;
        const r: any = await buildTransferFromQuote(quote, recipient);
        const label = `${provider} over ${venues.join(",")}`;
        assert.equal(r.ok, false, `${label}: a cash transfer was built`);
        assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "VENUE_CANNOT_SETTLE", label);
        assert.equal(store.findQuote(quote.id)!.status, "OPEN", `${label}: the quote was spent`);
        assert.equal(store.transfers.filter((x) => x.userId === user.id).length, rowsBefore, `${label}: a row was written`);
        assert.equal(pendingTransferExecutions.size, pendingBefore, `${label}: a debit was prepared`);
        assert.equal(bridgeCalls.length, 0, `${label}: Bridge was called`);
        ok(`a cash send on ${label} is refused before the debit: no quote spent, no row, no Bridge order`);
      }
      // Control: a venue that settles gets past this check (it stops later, at
      // the empty Safe's balance, before anything is debited).
      (LIQUIDITY as any).PROVIDER = "fx-swapper";
      const { quote } = await freshQuote();
      const r: any = await buildTransferFromQuote(quote, recipient);
      assert.notEqual(r.body?.code, "VENUE_CANNOT_SETTLE", "fx-swapper settles; it must not be refused as a quote-only venue");
      ok("a venue that settles is not refused as quote-only");
    } finally {
      (LIQUIDITY as any).PROVIDER = configured.provider;
      (LIQUIDITY as any).VENUES = configured.venues;
    }
  }

  // ── Part 3: rows each failure point leaves, handed to compensation ────────
  console.log("3/3 compensation and the stranded sweep on the rows each failure leaves");
  async function row(label: string, state: string, txs: { step: string; hash: string }[], extra: Record<string, any>, expect: { state: string; refund: boolean }) {
    const { id, user } = await seed(extra.safeSwap ? "batch" : "plain");
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    store.updateTransfer(id, { state: state as any, txs, ...extra });
    const t = store.findTransfer(id)!;
    t.updatedAt = old;
    if (t.auth) t.auth.authorizedAt = old;
    const safeBefore = await balance(addrs().eure, user.address);
    bridgeCalls.length = 0;
    await orch.sweepStrandedTransfers();
    await orch.sweepStrandedTransfers();
    if (store.findTransfer(id)!.state === "FAILED") await orch.compensateTransfer(id);
    const end = store.findTransfer(id)!;
    const refunded = (await balance(addrs().eure, user.address)) - safeBefore > 0n;
    const detail = `${label}: ended ${end.state}, refunded ${refunded}: ${end.error}`;
    assert.equal(end.state, expect.state, detail);
    assert.equal(refunded, expect.refund, detail);
    assert.equal(bridgeCalls.length, 0, `${detail}: the sweep called Bridge`);
    ok(label);
  }
  const debit = { step: orch.DEBIT_STEP.safe, hash: "0x11" };
  const batchSwap = { step: "liquidity.dex.eure-usdc", hash: "0x11" };
  const plainSwap = { step: "liquidity.fx-swapper.eure-usdc", hash: "0x22" };
  const live = { safeSwap: { recipient: DEPOSIT, mode: "live", bridgeAmountUsdc: 10 } };
  // Before create: nothing went to Bridge. The batch case has the money there already.
  await row("batch, debited, stopped before the create → review", "SWAPPED", [debit, batchSwap], { ...live, usdcOut: 10 }, { state: "MANUAL_REVIEW", refund: false });
  // After create, before its record persisted: an order may exist at Bridge.
  // Plain: the USDC is still the orchestrator's and no deposit intent exists,
  // so the reverse swap refunds. That needs USDC at the orchestrator.
  await mint(addrs().usdc, orchestratorAddress, usd.toUnits(30));
  await row("plain, swapped, stopped after the create before its record → refunded (no deposit sent)", "SWAPPED", [debit, plainSwap], { usdcOut: 30 }, { state: "REFUNDED", refund: true });
  await row("plain, create recorded, deposit intent without outcome → review", "SWAPPED",
    [debit, plainSwap, { step: "bridge.xyz.live.transfer", hash: "tr_1" }, { step: "bridge.xyz.deposit.address", hash: DEPOSIT }, { step: "bridge.xyz.deposit.pending", hash: "0x" }],
    { usdcOut: 30 }, { state: "MANUAL_REVIEW", refund: false });
  await row("plain, deposit sent, BRIDGED not written → review", "SWAPPED",
    [debit, plainSwap, { step: "bridge.xyz.live.transfer", hash: "tr_1" }, { step: "bridge.xyz.deposit.pending", hash: "0x" }, { step: "bridge.xyz.deposit.transfer", hash: "0x33" }],
    { usdcOut: 30 }, { state: "MANUAL_REVIEW", refund: false });
  await row("FAILED with Bridge's destination hash on record → review", "FAILED",
    [debit, plainSwap, { step: "bridge.xyz.live.transfer", hash: "tr_1" }, { step: "bridge.xyz.destination_tx", hash: "stellar-tx" }],
    { usdcOut: 30, error: "late" }, { state: "MANUAL_REVIEW", refund: false });
  await row("FAILED after a batch funded Bridge → review", "FAILED",
    [debit, batchSwap, { step: "bridge.xyz.live.transfer", hash: "tr_1" }, { step: "bridge.xyz.deposit.funded", hash: "0x11" }],
    { ...live, usdcOut: 10, error: "anchor payout failed" }, { state: "MANUAL_REVIEW", refund: false });
  await row("BRIDGED, stranded by a restart → review, never refunded", "BRIDGED",
    [debit, plainSwap, { step: "bridge.xyz.live.transfer", hash: "tr_1" }, { step: "bridge.xyz.deposit.transfer", hash: "0x33" }],
    { usdcOut: 30 }, { state: "MANUAL_REVIEW", refund: false });

  {
    // /api/transfers cannot run here (no Safe-executable venue on hardhat), so
    // its half is read from source: the hash is on the transfer before the
    // create is awaited, so a create that times out still binds the key.
    const src = readFileSync(path.join(ROOT, "services/api/src/transfers/build.ts"), "utf8");
    const recorded = src.indexOf("transfer.bridgeRequest = bridgeRequestHash(transfer.id, bridgeAmountUsdc, bridgeDest");
    const sent = src.indexOf("await createBridgeTransfer(transfer.id, bridgeAmountUsdc, bridgeDest");
    assert.ok(recorded > 0 && sent > recorded, "build.ts records bridgeRequest before its Bridge create goes out");
    assert.ok(src.indexOf("store.addTransferUnderHold(transfer") > sent, "the row is written after the create, carrying the hash");
    ok("/api/transfers records the order's hash on the transfer before its create goes out");
    const venueCheck = src.indexOf('transfer.rail === "cash" && !venueServesSafe()');
    assert.ok(venueCheck > 0 && venueCheck < recorded, "build.ts asks whether the venue serves a Safe before it orders from Bridge");
    ok("/api/transfers orders from Bridge only when the venue can build the Safe batch");
  }

  console.log(`\nbridge harness: ${passed} checks passed`);
} finally {
  chainNode.child.kill();
  rmSync(DB_DIR, { recursive: true, force: true });
}
if (inheritedDb) {
  // Compared as digests: a failing compare of the bytes themselves would
  // print the operator's database into the test output.
  const digest = (b?: Buffer) => (b ? createHash("sha256").update(b).digest("hex") : "absent");
  const after = existsSync(inheritedDb) ? readFileSync(inheritedDb) : undefined;
  assert.ok(digest(after) === digest(inheritedDbBefore), `the run touched ${inheritedDb}`);
  console.log(`   ok  TRANSF_DB_PATH on entry (${inheritedDb}) is untouched`);
}
process.exit(0);
