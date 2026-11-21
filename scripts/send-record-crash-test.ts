/**
 * A send went out and the write recording it failed. A failed write exits the
 * process (store/db.ts), so the restart sees only what reached db.json. Can
 * that restart refund money that left, or send it again?
 *
 * Each scenario is two real processes: `send` runs the real executor until the
 * named store write fails, and the process really exits; `restart` loads what
 * is on disk, tries to claim the authorization again and runs the sweeps twice.
 * The chain is hardhat, reverted between scenarios so one's balances cannot pay
 * for another's refund. Partners are stubbed and their money-moving calls are
 * logged, so a resend is counted across both processes. A chain resend or refund
 * shows in the Safe's balance or ends the transfer anywhere but review.
 *
 * The passkey debit is the harness's fake operation: a hardhat node has no
 * bundler. The scenario mints what the debit would have delivered.
 *
 *   npm run send-record-crash:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Account, Horizon, Keypair, WebAuth } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT_V9 } from "abstractionkit";
import { hardhatNode } from "./_free-port.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const DEPOSIT = "0x00000000000000000000000000000000000d3b05" as const;
const IBAN = "DE89370400440532013000";
const SEND_EUR = 40;

type Row = { state: string; txs: { step: string }[]; pickup?: { anchorPaymentHash?: string } };
const hasStep = (r: Row, step: string) => r.txs.some((x) => x.step === step);

interface Scenario {
  kind: "sepa" | "cash" | "batch" | "refund" | "reverse-refund" | "anchor" | "anchor-ready";
  /** The write that fails, seen with the change already in memory. `n` counts earlier writes that matched `seen`. */
  crashOn: (r: Row, n: number) => boolean;
  seen?: (r: Row) => boolean;
  /** Monerium answers the redeem with this status, and nothing crashes. */
  redeemStatus?: number;
  /** Nothing crashes: the executor's own end state is the result. */
  noCrash?: boolean;
  /** USDC the batch delivers to the recipient, and another deposit's USDC
   *  reaching the same address while it runs. Default 10 and 0. */
  batchUsdc?: { delivered: number; coInflow: number };
  /** The venue's pre-swap balance read is one unit high, so its delta falls
   *  short of the swap's logged output and the venue refuses to settle. */
  venueShortDelta?: boolean;
  /** The venue's quote expected 1 USDC more than the swap delivered: a fill
   *  between minOut and expectedOut. */
  venueQuoteAbove?: boolean;
  /** The redeem message was stamped this long before the send started. */
  redeemIssuedAgoSec?: number;
  /** The fee debit takes this long: the clock moves on once its step is written. */
  feeDebitSec?: number;
  /** Monerium refuses the access-token request, before any order is sent. */
  moneriumTokenStatus?: number;
  /** Steps that must be on record with a transaction hash. `refundEur` is the
   *  exact refund, `orderCalls` the redeem orders that reached Monerium in both
   *  processes, `absent` steps that must not be on record. */
  expect: {
    state: string; refunded: boolean; sends: string[]; usdcOut?: number; error?: RegExp; hashed?: string[];
    refundEur?: number; orderCalls?: number; absent?: string[];
  };
}

const SCENARIOS: Record<string, Scenario> = {
  "sepa fee debit landed, DEBITED write fails": {
    kind: "sepa",
    crashOn: (r) => r.state === "DEBITED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "sepa redeem intent write fails, nothing sent": {
    kind: "sepa",
    crashOn: (r) => hasStep(r, "monerium.redeem.pending"),
    expect: { state: "REFUNDED", refunded: true, sends: [] },
  },
  "sepa redeem placed, PAYOUT_SUBMITTED write fails": {
    kind: "sepa",
    crashOn: (r) => r.state === "PAYOUT_SUBMITTED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: ["monerium.redeem"] },
  },
  "cash debit landed, DEBITED write fails": {
    kind: "cash",
    crashOn: (r) => r.state === "DEBITED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "cash swap intent write fails, nothing sent": {
    kind: "cash",
    crashOn: (r) => hasStep(r, "liquidity.swap.pending"),
    expect: { state: "REFUNDED", refunded: true, sends: [] },
  },
  "cash swap landed, SWAPPED write fails": {
    kind: "cash",
    crashOn: (r) => r.state === "SWAPPED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "cash deposit intent write fails, nothing sent": {
    kind: "cash",
    crashOn: (r) => hasStep(r, "bridge.xyz.deposit.pending"),
    expect: { state: "REFUNDED", refunded: true, sends: [] },
  },
  "cash Bridge deposit landed, BRIDGED write fails": {
    kind: "cash",
    crashOn: (r) => r.state === "BRIDGED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "batch debit+swap landed, DEBITED write fails": {
    kind: "batch",
    crashOn: (r) => r.state === "DEBITED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "batch debit+swap landed, the next write fails": {
    kind: "batch",
    seen: (r) => r.state === "DEBITED",
    crashOn: (_r, n) => n >= 1,
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "batch funded, BRIDGED write fails": {
    kind: "batch",
    crashOn: (r) => r.state === "BRIDGED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  // Not a crash: the recipient is Bridge's deposit address, which other
  // deposits reach too. The batch settles what its own logs delivered.
  "batch delivers 10 while 5 more reaches the recipient": {
    kind: "batch",
    noCrash: true,
    batchUsdc: { delivered: 10, coInflow: 5 },
    crashOn: () => false,
    // The stub anchor then refuses the payout, after Bridge holds the deposit.
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [], usdcOut: 10, error: /funds already reached Bridge/ },
  },
  "batch delivers 8 of the 10 Bridge needs, a co-inflow covers the gap": {
    kind: "batch",
    noCrash: true,
    batchUsdc: { delivered: 8, coInflow: 5 },
    crashOn: () => false,
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [], error: /delivered 8000000 USDC units to Bridge, below the 10000000/ },
  },
  // Not a crash: the venue refuses to settle a swap that landed. Its hash is
  // still on record, and with no usdcOut there is nothing to reverse.
  "cash swap landed, the venue refuses to settle it": {
    kind: "cash",
    noCrash: true,
    venueShortDelta: true,
    crashOn: () => false,
    expect: {
      state: "MANUAL_REVIEW", refunded: false, sends: [], error: /balance shows only/,
      hashed: ["liquidity.fx-swapper.eure-usdc"],
    },
  },
  // Not a crash: the fill lands under the quote's expectedOut (above minOut).
  // usdcOut is what the swap delivered, so a reverse swap takes back no more.
  "cash swap fills under the quote's expected output": {
    kind: "cash",
    noCrash: true,
    venueQuoteAbove: true,
    crashOn: () => false,
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [], usdcOut: 44.3781 },
  },
  "refund landed, its record write fails": {
    kind: "refund",
    crashOn: (r) => hasStep(r, "safe.refundTransfer"),
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  "reverse swap landed, its fee refund's record write fails": {
    kind: "reverse-refund",
    crashOn: (r) => hasStep(r, "safe.refundTransfer"),
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [] },
  },
  // The refund step is on disk: the restart closes the transfer and pays nothing more.
  "reverse swap landed, REFUNDED write fails": {
    kind: "reverse-refund",
    crashOn: (r) => r.state === "REFUNDED",
    expect: { state: "REFUNDED", refunded: false, sends: [] },
  },
  "anchor payment sent, its hash write fails": {
    kind: "anchor",
    crashOn: (r) => Boolean(r.pickup?.anchorPaymentHash),
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: ["stellar.payment"] },
  },
  "anchor payment in PAYOUT_READY sent, its hash write fails": {
    kind: "anchor-ready",
    crashOn: (r) => Boolean(r.pickup?.anchorPaymentHash),
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: ["stellar.payment"] },
  },
  // Not a crash: Monerium's answer alone decides. See the refusal rule in executeSepaTransfer.
  ...Object.fromEntries([401, 403].map((status) => [`sepa redeem answered ${status}`, {
    kind: "sepa",
    redeemStatus: status,
    crashOn: () => false,
    expect: { state: "REFUNDED", refunded: true, sends: [], refundEur: 0.99, orderCalls: 1 },
  } satisfies Scenario])),
  ...Object.fromEntries([400, 404, 408, 409, 422, 429].map((status) => [`sepa redeem answered ${status}`, {
    kind: "sepa",
    redeemStatus: status,
    crashOn: () => false,
    // Sent, and the answer does not prove it was refused: review, with the fee held.
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [], orderCalls: 1, error: /outcome unknown/ },
  } satisfies Scenario])),
  // The signed redeem went stale while the fee debit ran: no order may go out,
  // and the fee comes back once. A fresh one with a short debit still pays.
  "sepa redeem goes stale during the fee debit": {
    kind: "sepa",
    noCrash: true,
    redeemIssuedAgoSec: 230,
    feeDebitSec: 20,
    crashOn: () => false,
    expect: {
      state: "REFUNDED", refunded: true, sends: [], refundEur: 0.99, orderCalls: 0,
      absent: ["monerium.redeem.pending", "monerium.redeem.placed"], error: /expired before it could go to Monerium, so no payment was sent/,
    },
  },
  "sepa redeem goes stale during the fee debit, FAILED write fails": {
    kind: "sepa",
    redeemIssuedAgoSec: 230,
    feeDebitSec: 20,
    crashOn: (r) => r.state === "FAILED",
    expect: { state: "REFUNDED", refunded: true, sends: [], refundEur: 0.99, orderCalls: 0 },
  },
  "sepa redeem still fresh after the fee debit": {
    kind: "sepa",
    noCrash: true,
    redeemIssuedAgoSec: 200,
    feeDebitSec: 10,
    crashOn: () => false,
    expect: { state: "PAYOUT_SUBMITTED", refunded: false, sends: ["monerium.redeem"], orderCalls: 1 },
  },
  // Monerium refuses the token before POST /orders: no order was sent.
  "sepa Monerium access refused before the order": {
    kind: "sepa",
    noCrash: true,
    moneriumTokenStatus: 401,
    crashOn: () => false,
    expect: {
      state: "REFUNDED", refunded: true, sends: [], refundEur: 0.99, orderCalls: 0,
      absent: ["monerium.redeem.placed"], error: /refused Zold's access .* so no payment was sent/,
    },
  },
  // The refusal is in memory only when the process dies: the restart cannot
  // tell it from a sent order, so review, and never a refund.
  "sepa Monerium access refused, FAILED write fails": {
    kind: "sepa",
    moneriumTokenStatus: 401,
    crashOn: (r) => r.state === "FAILED",
    expect: { state: "MANUAL_REVIEW", refunded: false, sends: [], orderCalls: 0 },
  },
  // Nothing went out, so the restart pays once and finishes.
  "anchor payment intent write fails, nothing sent": {
    kind: "anchor",
    crashOn: (r) => hasStep(r, "anchor.payment.pending"),
    expect: { state: "PAID", refunded: false, sends: ["stellar.payment"] },
  },
};

const phase = process.argv[2];
if (phase) await child(phase, process.argv[3]);
else await parent();

/** Partners, faked at the edge. Anything else that is not the local chain is refused: this suite is offline. */
async function stubPartners(logSend: (what: string) => void) {
  const { MoneriumApiError, MoneriumClient } = await import("../services/api/src/adapters/monerium-client.js");
  const { redeemStatus, moneriumTokenStatus } = SCENARIOS[process.argv[3]] ?? {};
  const logOrderCall = () => appendFileSync(`${process.env.SEND_LOG}.orders`, "order\n");
  // With a token refusal the real client runs, so an order would have to come
  // through fetch below; the token request fails first.
  if (!moneriumTokenStatus) {
    (MoneriumClient.prototype as any).placeOrder = async () => {
      logOrderCall();
      if (redeemStatus) throw new MoneriumApiError("stubbed answer", redeemStatus);
      logSend("monerium.redeem");
      return { id: "order-1", state: "placed" };
    };
  }

  // A real anchor takes a while to notice a payment, so the first status read
  // of a process still asks for it.
  let paid = false;
  const anchorKey = Keypair.random();
  const passphrase = process.env.STELLAR_PASSPHRASE!;
  const proto = Horizon.Server.prototype as any;
  proto.loadAccount = async (id: string) => new Account(id, "1");
  proto.submitTransaction = async () => {
    logSend("stellar.payment");
    paid = true;
    return { hash: "ab".repeat(32) };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input?.url ?? input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.hostname === "api.monerium.app" && moneriumTokenStatus) {
      if (url.pathname === "/auth/token") return new Response("{}", { status: moneriumTokenStatus });
      if (url.pathname === "/orders") logOrderCall();
      return new Response("{}", { status: 500 });
    }
    if (url.hostname === "bridge.test") {
      return json({ id: "bridge-1", state: "awaiting_funds", source_deposit_instructions: { to_address: DEPOSIT } });
    }
    if (url.hostname === "anchor.test") {
      if (url.pathname.endsWith("stellar.toml")) {
        return new Response(
          `SIGNING_KEY="${anchorKey.publicKey()}"\nWEB_AUTH_ENDPOINT="https://anchor.test/auth"\nTRANSFER_SERVER_SEP0024="https://anchor.test/sep24"\n`,
        );
      }
      if (url.pathname === "/auth" && init?.method === "POST") return json({ token: "h.e30.s" });
      if (url.pathname === "/auth") {
        return json({
          transaction: WebAuth.buildChallengeTx(
            anchorKey, url.searchParams.get("account")!, "anchor.test", 300, passphrase, "anchor.test",
            url.searchParams.get("memo"),
          ),
        });
      }
      return json({
        transaction: {
          id: "anchor-tx",
          status: paid ? "completed" : "pending_user_transfer_start",
          withdraw_anchor_account: Keypair.random().publicKey(),
        },
      });
    }
    throw new Error(`offline suite tried to reach ${url.hostname}`);
  }) as typeof fetch;
}

async function child(which: string, name: string) {
  const scenario = SCENARIOS[name];
  const { initStore, store } = await import("../services/api/src/store.js");
  const dbm = await import("../services/api/src/store/db.js");
  const chain = await import("../services/api/src/chain.js");
  const orch = await import("../services/api/src/orchestrator.js");
  const { abis, addrs, deployerWallet, eur, orchestratorAddress, publicClient, usd, writeAndWait } = chain;
  await stubPartners((what) => appendFileSync(process.env.SEND_LOG!, `${what}\n`));
  initStore();

  const mint = (token: `0x${string}`, to: `0x${string}`, amount: bigint) =>
    writeAndWait(deployerWallet!, { address: token, abi: abis.MockToken, functionName: "mint", args: [to, amount] });
  const balance = (token: `0x${string}`, who: `0x${string}`) =>
    publicClient.readContract({ address: token, abi: abis.MockToken, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  if (which === "restart") {
    const t = dbm.db.transfers[0];
    // The sweep leaves anything younger than ten minutes alone.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    t.updatedAt = old;
    if (t.auth?.authorizedAt) t.auth.authorizedAt = old;
    dbm.persist();
    const user = store.findUser(t.userId)!;
    const reclaimed = store.claimAuthorization(t.id);
    const safeBefore = await balance(addrs().eure, user.address as `0x${string}`);
    for (let i = 0; i < 2; i++) {
      await orch.sweepStrandedTransfers();
      await orch.sweepAnchorPayouts();
    }
    const after = store.findTransfer(t.id)!;
    const refundedWei = (await balance(addrs().eure, user.address as `0x${string}`)) - safeBefore;
    console.log(
      `RESULT ${JSON.stringify({ state: after.state, refundedEur: eur.fromWei(refundedWei), reclaimed, error: after.error })}`,
    );
    process.exit(0);
  }

  // ── send: seed what the route leaves, arm the failing write, run the executor.
  const key = generatePrivateKey();
  const device = privateKeyToAccount(key);
  const address = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
  const now = new Date().toISOString();
  const issuedAt = new Date(Date.now() - (scenario.redeemIssuedAgoSec ?? 0) * 1000).toISOString();
  const user: any = {
    id: `9${randomBytes(3).readUIntBE(0, 3)}`,
    name: "Crash Test",
    country: "DE",
    kycStatus: "approved",
    iban: "",
    address,
    authorizerAddress: device.address,
    passkeySafe: { status: "active", address },
    createdAt: now,
  };
  store.addUser(user);

  const rail = scenario.kind === "sepa" ? "sepa" : "cash";
  const fee = rail === "sepa" ? Number(process.env.SEPA_FEE_EUR) : Number(process.env.CASH_FEE_EUR);
  const payout = SEND_EUR - fee;
  const quoteId = randomUUID();
  const { liquidityProvider } = await import("../services/api/src/liquidity.js");
  if (rail === "cash") {
    const { raw } = await liquidityProvider().indicativeRate("EURE_TO_USDC");
    store.addQuote({
      id: quoteId, userId: user.id, rail, status: "OPEN", sendEur: SEND_EUR, fixedFeeEur: fee, fxRate: 1,
      receiveKes: 1000, receiveEur: 0, midRate: 1, marginBps: 0, effectiveRate: 1, lockedSwapRate: String(raw),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now,
    } as any);
  }
  const id = randomUUID();
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const amountWei = eur.toWei(SEND_EUR);
  const destination = chain.destinationCommitment(rail, { phone: "+254700000000", iban: IBAN, name: "Recipient" });
  const { paymentMemo, moneriumRedeemMessage, moneriumAmountString } = await import("../services/api/src/sepa.js");
  const memo = paymentMemo(id, undefined);
  const redeem = moneriumRedeemMessage(payout, IBAN, issuedAt);
  const base: any = {
    id, userId: user.id, quoteId, rail, recipientName: "Recipient", recipientPhone: "+254700000000",
    state: "CREATED", sendEur: SEND_EUR, receiveKes: 1000, fundingSource: "safe", txs: [],
    auth: { to: orchestratorAddress, amountWei: amountWei.toString(), destination, deadline },
    createdAt: now, updatedAt: now,
  };
  if (rail === "sepa") {
    Object.assign(base, {
      recipientIban: IBAN, receiveEur: payout,
      moneriumRedeem: { amount: moneriumAmountString(payout), iban: IBAN, issuedAt, message: redeem.message, memo, signature: "0x1234" },
    });
  }
  // What the user-signed debit would have delivered, plus other users' money a
  // wrong refund would be paid from.
  await mint(addrs().eure, orchestratorAddress, eur.toWei(SEND_EUR * 2));

  if (scenario.kind === "refund" || scenario.kind === "reverse-refund") {
    base.state = "FAILED";
    base.error = "forced failure";
    base.txs.push({ step: orch.DEBIT_STEP.safe, hash: "0x11" });
    if (scenario.kind === "reverse-refund") {
      base.txs.push({ step: "liquidity.fx-swapper.eure-usdc", hash: "0x22" });
      base.usdcOut = 30;
      await mint(addrs().usdc, orchestratorAddress, usd.toUnits(30));
    }
  }
  if (scenario.kind === "anchor" || scenario.kind === "anchor-ready") {
    base.state = scenario.kind === "anchor" ? "PAYOUT_FUNDING_PENDING" : "PAYOUT_READY";
    base.txs.push({ step: "bridge.xyz.deposit.transfer", hash: "0x33" });
    base.pickup = {
      referenceCode: "R1", provider: "anchor:test", status: "PENDING", anchorTransactionId: "anchor-tx",
      anchorAmount: 10, anchorAsset: "native", anchorStatus: "pending_user_transfer_start",
    };
  }
  if (scenario.kind === "batch") {
    base.safeSwap = { recipient: DEPOSIT, mode: "live", bridgeAmountUsdc: 10 };
    base.liquidity = {
      provider: "dex", side: "EURE_TO_USDC", quoteId, tokenIn: "EURe", tokenOut: "USDC",
      amountIn: "1", expectedOut: "1", minOut: "0", rate: "1000000", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  store.addTransfer(base);
  if (base.state === "CREATED") store.claimAuthorization(id);

  // Arm: the real persist fails on the chosen write and really exits.
  const realRename = fs.renameSync;
  let seen = 0;
  let delivered = false;
  const realNow = Date.now;
  let clockAhead = 0;
  Date.now = () => realNow() + clockAhead;
  let batchTx: Promise<`0x${string}`> | undefined;
  // The fake batch's receipt is the delivery mint's, inside the fake userOp's
  // own execution, as an EntryPoint bundle would carry it.
  const { HARNESS_SAFE_EXECUTION } = orch;
  const realReceipt = publicClient.getTransactionReceipt.bind(publicClient);
  (publicClient as any).getTransactionReceipt = async ({ hash }: { hash: `0x${string}` }) => {
    if (hash !== HARNESS_SAFE_EXECUTION.txHash || !batchTx) return realReceipt({ hash });
    const r = await realReceipt({ hash: await batchTx });
    const userOpEvent = {
      address: ENTRYPOINT_V9, data: "0x", logIndex: r.logs.length,
      topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", HARNESS_SAFE_EXECUTION.userOpHash],
    };
    return { ...r, logs: [...r.logs, userOpEvent] };
  };
  if (scenario.venueShortDelta) {
    const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");
    const realExecute = FxSwapperLiquidityProvider.prototype.execute;
    const realRead = publicClient.readContract.bind(publicClient);
    let skew = false;
    (publicClient as any).readContract = async (args: any) => {
      const v = await realRead(args);
      if (!skew || args.functionName !== "balanceOf") return v;
      skew = false; // the venue's first read is its pre-swap balance
      return (v as bigint) + 1n;
    };
    FxSwapperLiquidityProvider.prototype.execute = function (...args) {
      skew = true;
      return realExecute.apply(this, args);
    };
  }
  if (scenario.venueQuoteAbove) {
    const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");
    const realExecute = FxSwapperLiquidityProvider.prototype.execute;
    FxSwapperLiquidityProvider.prototype.execute = async function (...args) {
      const done = await realExecute.apply(this, args);
      return { ...done, quote: { ...done.quote, expectedOut: done.quote.expectedOut + 1_000_000n } };
    };
  }
  fs.renameSync = ((from: any, to: any) => {
    const r = dbm.db.transfers.find((x) => x.id === id) as unknown as Row;
    // The fake batch moves nothing, so its output lands here, after the executor read the balance before it.
    if (scenario.kind === "batch" && r.state === "DEBITED" && !delivered) {
      delivered = true;
      const { delivered: out, coInflow } = scenario.batchUsdc ?? { delivered: 10, coInflow: 0 };
      batchTx = mint(addrs().usdc, DEPOSIT, usd.toUnits(out)).then(async (hash) => {
        if (coInflow) await mint(addrs().usdc, DEPOSIT, usd.toUnits(coInflow));
        return hash;
      });
    }
    if (scenario.feeDebitSec && !clockAhead && hasStep(r, orch.DEBIT_STEP.safeFee)) clockAhead = scenario.feeDebitSec * 1000;
    const crash = scenario.crashOn(r, seen);
    if (scenario.seen?.(r)) seen++;
    if (crash) throw Object.assign(new Error("disk refused"), { code: "EIO" });
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  const safeBefore = await balance(addrs().eure, address);
  const t = store.findTransfer(id)!;
  if (scenario.kind === "refund" || scenario.kind === "reverse-refund") {
    await orch.compensateTransfer(id);
  } else if (scenario.kind === "anchor" || scenario.kind === "anchor-ready") {
    await orch.refreshPayout(t, { pollMs: 1, timeoutMs: 1 });
  } else {
    const signature = await device.signTypedData(
      chain.paymentAuthorizationTypedData({
        account: address, amountWei, to: orchestratorAddress, transferId: chain.transferIdHash(id), destination, deadline,
      }) as any,
    );
    const auth = { deadline, signature };
    const execution: any = scenario.kind === "batch" ? { batch: { recipient: DEPOSIT, mode: "live" } } : {};
    if (rail === "sepa") await orch.executeSepaTransfer(t, user, auth, execution);
    else await orch.executeTransfer(t, user, auth, execution);
  }
  const refundedEur = eur.fromWei((await balance(addrs().eure, address)) - safeBefore);
  const end = store.findTransfer(id);
  const hashed = (end?.txs ?? []).filter((x) => /^0x[0-9a-f]{64}$/i.test(x.hash)).map((x) => x.step);
  const steps = (end?.txs ?? []).map((x) => x.step);
  console.log(`NOCRASH the armed write never happened; the transfer ended ${end?.state}, refunded €${refundedEur}, usdcOut ${end?.usdcOut}, hashed [${hashed}], steps [${steps}]: ${end?.error}`);
  process.exit(0);
}

async function parent() {
  const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-send-crash-"));
  const node = await hardhatNode(ROOT);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRANSF_RPC_URL: node.url,
    LIQUIDITY_PROVIDER: "fx-swapper",
    DEPLOY_EURUSD_RATE: "1137900",
    SEPA_FEE_EUR: "0.99",
    CASH_FEE_EUR: process.env.CASH_FEE_EUR ?? "1",
    MONERIUM_CLIENT_ID: "crash-test-client",
    MONERIUM_CLIENT_SECRET: "crash-test-secret",
    BRIDGE_LIVE: "1",
    BRIDGE_API_KEY: "test",
    BRIDGE_ON_BEHALF_OF: "test",
    BRIDGE_BASE_URL: "https://bridge.test",
    BRIDGE_DESTINATION_ADDRESS: "GATEST",
    MG_ANCHOR_DOMAIN: "anchor.test",
    MG_ANCHOR_ASSET: "native",
    STELLAR_PASSPHRASE: "Test SDF Network ; September 2015",
    STELLAR_TREASURY_SECRET: Keypair.random().secret(),
  };
  const run = (args: string[], dbPath: string, sendLog: string) =>
    spawnSync(process.execPath, ["--import", "tsx", SELF, ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
      env: { ...env, TRANSF_DB_PATH: dbPath, SEND_LOG: sendLog },
    });
  const failures: string[] = [];
  try {
    const deploy = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(deploy.status, 0, `deploy failed\n${deploy.stderr}`);

    const rpc = async (method: string, params: unknown[] = []) =>
      (await (await fetch(node.url, {
        method: "POST",
        // A pooled socket goes stale while spawnSync blocks the loop; a fresh one per call avoids ECONNRESET.
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })).json()).result;
    let snapshot = await rpc("evm_snapshot");

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      assert.equal(await rpc("evm_revert", [snapshot]), true, "chain revert failed");
      snapshot = await rpc("evm_snapshot");
      const dbPath = path.join(dir, `${randomUUID()}.json`);
      const sendLog = path.join(dir, `${randomUUID()}.log`);
      appendFileSync(sendLog, "");
      appendFileSync(`${sendLog}.orders`, "");
      const orderCalls = () => readFileSync(`${sendLog}.orders`, "utf8").split("\n").filter(Boolean).length;
      const exact = (refundEur: number) =>
        (scenario.expect.refundEur === undefined || refundEur === scenario.expect.refundEur) &&
        (scenario.expect.orderCalls === undefined || orderCalls() === scenario.expect.orderCalls);
      const send = run(["send", name], dbPath, sendLog);
      if (scenario.redeemStatus || scenario.noCrash) {
        const [, state, refundedEur, usdcOut, hashed, steps, error] =
          send.stdout.match(/^NOCRASH .*ended (\w+), refunded €([\d.]+), usdcOut (\S+), hashed \[(.*?)\], steps \[(.*?)\]: (.*)$/m) ?? [];
        const sends = readFileSync(sendLog, "utf8").split("\n").filter(Boolean);
        const ok =
          state === scenario.expect.state &&
          Number(refundedEur) > 0 === scenario.expect.refunded &&
          JSON.stringify(sends) === JSON.stringify(scenario.expect.sends) &&
          (scenario.expect.usdcOut === undefined || Number(usdcOut) === scenario.expect.usdcOut) &&
          (!scenario.expect.error || scenario.expect.error.test(error ?? "")) &&
          (scenario.expect.hashed ?? []).every((step) => (hashed ?? "").split(",").includes(step)) &&
          (scenario.expect.absent ?? []).every((step) => !(steps ?? "").split(",").includes(step)) &&
          exact(Number(refundedEur));
        if (!ok) failures.push(name);
        console.log(`  ${ok ? "ok  " : "FAIL"} ${name} -> ${state}, refunded €${refundedEur}, usdcOut ${usdcOut}, orders ${orderCalls()}\n${ok ? "" : send.stdout + send.stderr}`.trimEnd());
        continue;
      }
      if (send.status !== 1 || !/FATAL store write failed \(EIO\)/.test(send.stderr)) {
        failures.push(name);
        console.log(`  FAIL ${name}: the send phase did not die on the failed write (exit ${send.status})\n${send.stdout}\n${send.stderr}`);
        continue;
      }
      const restart = run(["restart", name], dbPath, sendLog);
      const line = restart.stdout.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) {
        failures.push(name);
        console.log(`  FAIL ${name}: the restart gave no result (exit ${restart.status})\n${restart.stdout}\n${restart.stderr}`);
        continue;
      }
      const got = JSON.parse(line.slice("RESULT ".length));
      const sends = readFileSync(sendLog, "utf8").split("\n").filter(Boolean);
      const ok =
        got.state === scenario.expect.state &&
        got.refundedEur > 0 === scenario.expect.refunded &&
        JSON.stringify(sends) === JSON.stringify(scenario.expect.sends) &&
        exact(got.refundedEur) &&
        // Only a transfer that started CREATED has a claim to refuse.
        (!["sepa", "cash", "batch"].includes(scenario.kind) || got.reclaimed === false);
      if (!ok) failures.push(name);
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${name} -> ${got.state}, refunded €${got.refundedEur}, partner sends [${sends}], orders ${orderCalls()}, re-claim ${got.reclaimed}` +
          (ok ? "" : `\n       wanted ${JSON.stringify(scenario.expect)}; error: ${got.error}`),
      );
    }
  } finally {
    node.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `${failures.length} path(s) can refund or resend after a lost record`);
  console.log("SEND-RECORD CRASH TEST PASSED — no path refunds or resends money that left");
  process.exit(0);
}
