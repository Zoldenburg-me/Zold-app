/**
 * Recovery for Safe-funded transfers.
 *
 * A transfer takes EURe out of the user's own Safe. Compensation used to
 * decide "did any money move?" by looking for an old ledger step, which that
 * path never pushes —
 * so a failure recorded a €0 refund reading "nothing was debited" while the
 * euros sat at the orchestrator, and the sweep then skipped the transfer
 * forever because a set `refund` is what marks one as settled.
 *
 * Why this drives compensateTransfer directly instead of sending a transfer:
 * the debit leg itself now requires an active passkey Safe signing the debit, which a
 * hardhat node cannot provide. What CAN be tested locally is everything that
 * happens after it, which is where the money was being lost. The seeded state
 * is exactly what debitInputFunds writes on success.
 *
 * Runs its own chain on a shifted port. Run: npm run safe-funded:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InsufficientFundsError,
  InternalRpcError,
  LimitExceededRpcError,
  TransactionExecutionError,
  UnknownRpcError,
} from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8549";
process.env.TRANSF_RPC_URL = RPC;
// SEPA is free by default, so the fee leg this suite exercises would not exist.
// Pin a fee for the run: the property under test is that ONLY the fee comes
// back, which needs a fee to move in the first place.
process.env.SEPA_FEE_EUR ??= "0.99";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.MG_ANCHOR_DOMAIN = "";

const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const children: ChildProcess[] = [];
const bg = (cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: process.env });
  children.push(c);
  return c;
};

async function waitRpc(timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`   ok  ${label}`);
};

try {
  console.log("1/5 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8549"]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  // Imported after the deploy so config/chain read the right addresses.
  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, orchestratorAddress, orchestratorWallet, publicClient, writeAndWait, deployerWallet } =
    await import("../services/api/src/chain.js");
  const { compensateTransfer, sweepStrandedTransfers, dailyCapUsage, DEBIT_STEP, strandedAction } = await import(
    "../services/api/src/orchestrator.js"
  );
  initStore();

  const eureBalance = async (who: `0x${string}`) =>
    eur.fromWei(
      (await publicClient.readContract({
        address: addrs().eure,
        abi: abis.MockToken,
        functionName: "balanceOf",
        args: [who],
      })) as bigint,
    );

  /** A user whose EURe lives in the Safe, as a live Monerium deposit leaves it. */
  async function seedUser(name: string, safeEur: number) {
    const address = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address,
      createdAt: new Date().toISOString(),
      kyc: { status: "approved" as const, updatedAt: new Date().toISOString() },
    } as any;
    store.addUser(user);
    if (safeEur > 0) {
      await writeAndWait(deployerWallet, {
        address: addrs().eure,
        abi: abis.MockToken,
        functionName: "mint",
        args: [address, eur.toWei(safeEur)],
      });
    }
    return user;
  }

  /** The transfer record debitInputFunds leaves behind after a successful
   *  Safe move: state DEBITED, the safe step recorded, euros at the
   *  orchestrator. `extraSteps` simulates getting further down the flow. */
  async function seedSafeFundedTransfer(user: any, sendEur: number, extraSteps: string[] = []) {
    // The orchestrator ends up holding what left the Safe.
    await writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [orchestratorAddress, eur.toWei(sendEur)],
    });
    const t = {
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "cash" as const,
      recipientName: "Recipient",
      recipientPhone: "+254700000000",
      state: "FAILED" as const,
      error: "forced failure for test",
      sendEur,
      receiveKes: 0,
      fundingSource: "safe" as const,
      txs: [
        { step: DEBIT_STEP.safe, hash: `0x${"11".repeat(32)}` },
        ...extraSteps.map((step) => ({ step, hash: `0x${"22".repeat(32)}` })),
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.addTransfer(t);
    return t;
  }

  console.log("2/5 failed Safe-funded transfer refunds to the Safe…");
  {
    const user = await seedUser("Safe Refund", 0);
    const t = await seedSafeFundedTransfer(user, 100);
    const before = await eureBalance(user.address);
    const out = await compensateTransfer(t.id);

    check("state is REFUNDED", out.state === "REFUNDED", `got ${out.state} (${out.error ?? ""})`);
    check(
      "refund is the full amount, not €0",
      out.refund?.amountEur === 100,
      `got ${out.refund?.amountEur}`,
    );
    check(
      "refund names the Safe as the source",
      out.refund?.recoveredFrom === "Safe-funded EURe",
      `got ${out.refund?.recoveredFrom}`,
    );
    check(
      "a refund transfer was actually submitted",
      out.txs.some((x: any) => x.step === "safe.refundTransfer"),
      out.txs.map((x: any) => x.step).join(","),
    );
    const after = await eureBalance(user.address);
    check("EURe arrived back in the Safe", after - before === 100, `${before} -> ${after}`);
    check(
      "only the Safe refund step was recorded",
      !out.txs.some((x: any) => x.step.includes("vault")),
    );
  }

  console.log("3/5 already-swapped input goes to review, not a silent €0…");
  {
    const user = await seedUser("Safe Swapped", 0);
    const t = await seedSafeFundedTransfer(user, 60, ["swapper.swapExactIn"]);
    store.updateTransfer(t.id, {
      usdcOut: 50,
      liquidity: {
        provider: "dex",
        side: "EURE_TO_USDC",
        quoteId: t.quoteId,
        tokenIn: "EURe",
        tokenOut: "USDC",
        amountIn: eur.toWei(59.01).toString(),
        expectedOut: "50000000",
        minOut: "49000000",
        rate: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    } as any);
    const out = await compensateTransfer(t.id);
    check("state is MANUAL_REVIEW", out.state === "MANUAL_REVIEW", `got ${out.state}`);
    check(
      "the error explains the euros are no longer EURe",
      /reverse swap/.test(out.error ?? ""),
      out.error ?? "",
    );
    check(
      "refund estimate uses the persisted execution rate, not the mock swapper",
      /€50\.99/.test(out.error ?? ""),
      out.error ?? "",
    );
    check("no €0 refund record was written", !out.refund, JSON.stringify(out.refund));
  }

  console.log("3b/5 SEPA moved only the fee, so only the fee comes back…");
  {
    const { FX } = await import("../services/api/src/config.js");
    const user = await seedUser("Safe Sepa Fee", 0);
    const sendEur = 40;
    const payoutEur = sendEur - FX.SEPA_FEE_EUR;
    // Same rounding the orchestrator applies — 40 - 39.01 is not exactly 0.99 in floats.
    const feeEur = Math.round((sendEur - payoutEur) * 100) / 100;
    // Only the fee ever reaches the orchestrator on this rail.
    await writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [orchestratorAddress, eur.toWei(feeEur)],
    });
    const t = {
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "sepa" as const,
      recipientName: "Recipient",
      recipientIban: "DE89370400440532013000",
      state: "FAILED" as const,
      error: "redeem rejected",
      sendEur,
      receiveKes: 0,
      receiveEur: payoutEur,
      fundingSource: "safe" as const,
      txs: [{ step: DEBIT_STEP.safeFee, hash: `0x${"33".repeat(32)}` }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.addTransfer(t);
    const before = await eureBalance(user.address);
    const out = await compensateTransfer(t.id);
    check("state is REFUNDED", out.state === "REFUNDED", `got ${out.state} (${out.error ?? ""})`);
    check(
      "refund is the fee, not the whole send",
      out.refund?.amountEur === feeEur,
      `expected €${feeEur}, got ${out.refund?.amountEur}`,
    );
    check(
      "the untouched payout is itemised rather than silently dropped",
      /never left the Safe/.test(out.refund?.deductions ?? ""),
      out.refund?.deductions ?? "",
    );
    const after = await eureBalance(user.address);
    check("only the fee moved back", after - before === feeEur, `${before} -> ${after}`);
  }

  console.log("4/5 the sweep picks up Safe-funded failures…");
  {
    const user = await seedUser("Safe Sweep", 0);
    const t = await seedSafeFundedTransfer(user, 25);
    const n = await sweepStrandedTransfers();
    const out = store.findTransfer(t.id)!;
    check("sweep compensated at least one transfer", n >= 1, `n=${n}`);
    check("swept transfer reached REFUNDED", out.state === "REFUNDED", `got ${out.state}`);
    check("swept refund is €25", out.refund?.amountEur === 25, `got ${out.refund?.amountEur}`);
  }

  console.log("5/5 a genuinely pre-debit failure still owes nothing…");
  {
    const user = await seedUser("No Debit", 0);
    const t = {
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "cash" as const,
      recipientName: "Recipient",
      state: "FAILED" as const,
      sendEur: 10,
      receiveKes: 0,
      fundingSource: "safe" as const,
      txs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.addTransfer(t);
    const out = await compensateTransfer(t.id);
    check("nothing moved, so nothing is owed", out.refund?.amountEur === 0);
    check(
      "and it says so",
      out.refund?.deductions === "nothing was debited",
      out.refund?.deductions ?? "",
    );
  }

  console.log("   a refund runs once, and an outbound call of unknown outcome is never refunded…");
  {
    // Spare EURe at the orchestrator, so a second refund would have the
    // inventory to land and the balance check below would see it.
    await writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [orchestratorAddress, eur.toWei(100)],
    });
    const user = await seedUser("Single Flight", 0);
    const t = await seedSafeFundedTransfer(user, 30);
    const before = await eureBalance(user.address);
    // A sweep tick finds the same FAILED row while the first compensation's
    // refund is mined but not yet recorded: hold every receipt wait until the
    // sweep has started.
    const waitReceipt = publicClient.waitForTransactionReceipt;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (publicClient as any).waitForTransactionReceipt = async (args: any) => {
      await gate;
      return waitReceipt.call(publicClient, args);
    };
    try {
      const first = compensateTransfer(t.id);
      const deadline = Date.now() + 10_000;
      while ((await eureBalance(user.address)) === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const sweep = sweepStrandedTransfers();
      await new Promise((r) => setTimeout(r, 200));
      release();
      await Promise.all([first, sweep]);
    } finally {
      (publicClient as any).waitForTransactionReceipt = waitReceipt;
    }
    const out = store.findTransfer(t.id)!;
    const after = await eureBalance(user.address);
    check("the concurrent sweep did not refund a second time", after - before === 30, `${before} -> ${after}`);
    check(
      "one refund transaction on record",
      out.txs.filter((x: any) => x.step === "safe.refundTransfer").length === 1,
      out.txs.map((x: any) => x.step).join(","),
    );
    check("and it settled as REFUNDED", out.state === "REFUNDED", `got ${out.state}`);
  }
  {
    // The process stopped after recording the refund intent and before the
    // refund transaction was recorded: it may have been sent.
    const user = await seedUser("Refund Restart", 0);
    const t = await seedSafeFundedTransfer(user, 20, ["safe.refundTransfer.pending"]);
    const before = await eureBalance(user.address);
    const out = await compensateTransfer(t.id);
    const after = await eureBalance(user.address);
    check("a refund of unknown outcome goes to review", out.state === "MANUAL_REVIEW", `got ${out.state}`);
    check("and is not sent again", after === before, `${before} -> ${after}`);
    check("no refund record was written", !out.refund, JSON.stringify(out.refund));
    const again = await compensateTransfer(t.id);
    check("compensation leaves a MANUAL_REVIEW transfer alone", again.state === "MANUAL_REVIEW" && !again.refund);
    check("still nothing sent", (await eureBalance(user.address)) === before);
  }
  {
    // Stranded mid-flow after the redeem order went out or the Bridge deposit
    // was sent: the money may have left, so the sweep must not refund.
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const user = await seedUser("Stranded Outbound", 0);
    const sepa = await seedSafeFundedTransfer(user, 15, ["monerium.redeem.pending"]);
    store.updateTransfer(sepa.id, { state: "DEBITED", error: undefined });
    store.findTransfer(sepa.id)!.updatedAt = stale;
    const cash = await seedSafeFundedTransfer(user, 15, ["bridge.xyz.deposit.pending"]);
    store.updateTransfer(cash.id, { state: "SWAPPED", error: undefined });
    store.findTransfer(cash.id)!.updatedAt = stale;
    const before = await eureBalance(user.address);
    await sweepStrandedTransfers();
    const after = await eureBalance(user.address);
    const s = store.findTransfer(sepa.id)!;
    const c = store.findTransfer(cash.id)!;
    check("a stranded row with a redeem in flight goes to review", s.state === "MANUAL_REVIEW", `got ${s.state}`);
    check("a stranded row with a Bridge deposit in flight goes to review", c.state === "MANUAL_REVIEW", `got ${c.state}`);
    check("neither was refunded", after === before && !s.refund && !c.refund, `${before} -> ${after}`);
  }
  {
    // A stale CREATED row whose execute*() is still running is not stranded.
    const now = Date.now();
    const created = {
      id: "t-created",
      state: "CREATED",
      txs: [],
      updatedAt: new Date(now).toISOString(),
      auth: { authorizedAt: new Date(now - 60 * 60_000).toISOString() },
    } as any;
    check(
      "a stale claimed authorization goes to review when nothing is running",
      strandedAction(created, now, () => false) === "review-unrecorded-debit",
    );
    check("but not while its execution is in flight", strandedAction(created, now, () => true) === null);
    check(
      "a MANUAL_REVIEW transfer is never swept",
      strandedAction({ ...created, state: "MANUAL_REVIEW", updatedAt: created.auth.authorizedAt }, now, () => false) === null,
    );
  }

  console.log("   a refund that definitely did not go out is retried; an uncertain one is reviewed…");
  {
    const steps = (id: string) => store.findTransfer(id)!.txs.map((x: any) => x.step);
    const realWrite = orchestratorWallet.writeContract;
    const realWait = publicClient.waitForTransactionReceipt;
    const restore = () => {
      (orchestratorWallet as any).writeContract = realWrite;
      (publicClient as any).waitForTransactionReceipt = realWait;
    };

    // (a) The node refused the write before accepting it: nothing was sent.
    {
      const user = await seedUser("Refund Not Sent", 0);
      const t = await seedSafeFundedTransfer(user, 12);
      const before = await eureBalance(user.address);
      (orchestratorWallet as any).writeContract = async () => {
        throw new TransactionExecutionError(new InsufficientFundsError(), { account: orchestratorWallet.account } as any);
      };
      try {
        await assert.rejects(compensateTransfer(t.id));
      } finally {
        restore();
      }
      check(
        "a refund write that threw before a hash records not-sent after its intent",
        steps(t.id).join(",").endsWith("safe.refundTransfer.pending,safe.refundTransfer.not-sent"),
        steps(t.id).join(","),
      );
      check("and the transfer is still FAILED, not in review", store.findTransfer(t.id)!.state === "FAILED");
      const out = await compensateTransfer(t.id);
      check("the retried refund lands", out.state === "REFUNDED" && out.refund?.amountEur === 12, `got ${out.state} (${out.error ?? ""})`);
      check("exactly once", (await eureBalance(user.address)) - before === 12);
    }

    // (a2) A refund the node refuses every time (the orchestrator has no gas)
    // stops being retried after a bounded number of attempts.
    {
      const user = await seedUser("Refund Never Sent", 0);
      const t = await seedSafeFundedTransfer(user, 11);
      (orchestratorWallet as any).writeContract = async () => {
        throw new TransactionExecutionError(new InsufficientFundsError(), { account: orchestratorWallet.account } as any);
      };
      let out: any;
      try {
        for (let i = 0; i < 8; i++) {
          try {
            out = await compensateTransfer(t.id);
          } catch {
            out = store.findTransfer(t.id);
          }
        }
      } finally {
        restore();
      }
      const notSent = steps(t.id).filter((s) => s === "safe.refundTransfer.not-sent").length;
      const pending = steps(t.id).filter((s) => s === "safe.refundTransfer.pending").length;
      check("a refund refused every time is attempted a bounded number of times", notSent === 5 && pending === 5, steps(t.id).join(","));
      check(
        "and then goes to review with the reason",
        out.state === "MANUAL_REVIEW" && /5 refund attempts/.test(out.error ?? "") && !out.refund,
        `got ${out.state} (${out.error ?? ""})`,
      );
    }

    // (b) The receipt is a definite revert: nothing moved.
    {
      const user = await seedUser("Refund Reverted", 0);
      const t = await seedSafeFundedTransfer(user, 13);
      const before = await eureBalance(user.address);
      const fakeHash = `0x${"ee".repeat(32)}`;
      (orchestratorWallet as any).writeContract = async () => fakeHash;
      (publicClient as any).waitForTransactionReceipt = async () => ({ status: "reverted", transactionHash: fakeHash });
      try {
        await assert.rejects(compensateTransfer(t.id));
      } finally {
        restore();
      }
      const reverted = store.findTransfer(t.id)!.txs.find((x: any) => x.step === "safe.refundTransfer.reverted");
      check("a reverted refund records reverted with its hash", reverted?.hash === fakeHash, steps(t.id).join(","));
      const out = await compensateTransfer(t.id);
      check("the refund is retried and lands", out.state === "REFUNDED" && out.refund?.amountEur === 13, `got ${out.state} (${out.error ?? ""})`);
      check("exactly once after a revert", (await eureBalance(user.address)) - before === 13);
    }

    // (c) The transaction was sent and its receipt timed out: it may land.
    {
      const user = await seedUser("Refund Timeout", 0);
      const t = await seedSafeFundedTransfer(user, 14);
      const before = await eureBalance(user.address);
      (publicClient as any).waitForTransactionReceipt = async () => {
        throw new Error("Timed out while waiting for transaction");
      };
      try {
        await assert.rejects(compensateTransfer(t.id));
      } finally {
        restore();
      }
      check(
        "a post-hash timeout settles nothing",
        steps(t.id).at(-1) === "safe.refundTransfer.pending",
        steps(t.id).join(","),
      );
      const out = await compensateTransfer(t.id);
      check("and goes to review, not a second refund", out.state === "MANUAL_REVIEW" && !out.refund, `got ${out.state}`);
      check("the first refund landed once", (await eureBalance(user.address)) - before === 14);
    }

    // (d) The write threw a transport error: the node may have taken it.
    {
      const user = await seedUser("Refund Transport", 0);
      const t = await seedSafeFundedTransfer(user, 15);
      (orchestratorWallet as any).writeContract = async () => {
        const e = new Error("HTTP request failed. URL: http://rpc.invalid");
        e.name = "HttpRequestError";
        throw e;
      };
      try {
        await assert.rejects(compensateTransfer(t.id));
      } finally {
        restore();
      }
      const out = await compensateTransfer(t.id);
      check("a transport error on the write is uncertain and goes to review", out.state === "MANUAL_REVIEW", `got ${out.state}`);
    }

    // (e) A bare RPC error from the send proves nothing: viem's transport
    // retries eth_sendRawTransaction on these, and the first attempt may have
    // reached the mempool.
    for (const [label, make] of [
      ["an InternalRpcError (-32603)", () => new InternalRpcError(new Error("internal error"))],
      ["an UnknownRpcError (-1)", () => new UnknownRpcError(new Error("unknown"))],
      ["a plain Error", () => new Error("boom")],
    ] as const) {
      const user = await seedUser(`Refund Uncertain ${label}`, 0);
      const t = await seedSafeFundedTransfer(user, 16);
      const before = await eureBalance(user.address);
      (orchestratorWallet as any).writeContract = async () => {
        throw make();
      };
      try {
        await assert.rejects(compensateTransfer(t.id));
      } finally {
        restore();
      }
      check(`${label} on the write settles nothing`, steps(t.id).at(-1) === "safe.refundTransfer.pending", steps(t.id).join(","));
      const out = await compensateTransfer(t.id);
      check(`${label} goes to review without a second refund`, out.state === "MANUAL_REVIEW" && !out.refund, `got ${out.state}`);
      check(`${label}: nothing was paid twice`, (await eureBalance(user.address)) === before);
    }

    // The Bridge deposit settles the same way, by order: a later intent is
    // not settled by an earlier attempt's outcome.
    const now = Date.now();
    const stale = new Date(now - 60 * 60_000).toISOString();
    const swapped = (s: string[]) =>
      ({ id: "t-bridge", state: "SWAPPED", updatedAt: stale, txs: s.map((step) => ({ step, hash: "0x" })) }) as any;
    check(
      "a Bridge deposit that was not sent is compensated, not reviewed",
      strandedAction(swapped(["bridge.xyz.deposit.pending", "bridge.xyz.deposit.not-sent"]), now, () => false) ===
        "fail-and-compensate",
    );
    check(
      "a reverted Bridge deposit is compensated, not reviewed",
      strandedAction(swapped(["bridge.xyz.deposit.pending", "bridge.xyz.deposit.reverted"]), now, () => false) ===
        "fail-and-compensate",
    );
    check(
      "a second intent after a settled first one is unsettled",
      strandedAction(
        swapped(["bridge.xyz.deposit.pending", "bridge.xyz.deposit.not-sent", "bridge.xyz.deposit.pending"]),
        now,
        () => false,
      ) === "review-outbound",
    );

    // writeAndWait itself: the hooks fire only on a definite outcome.
    const calls: string[] = [];
    const hooks = {
      beforeSend: () => calls.push("before"),
      onNotSent: () => calls.push("not-sent"),
      onReverted: (h: string) => calls.push(`reverted:${h}`),
    };
    const args = {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "transfer",
      args: [orchestratorAddress, 0n],
    };
    (orchestratorWallet as any).writeContract = async () => {
      const e = new Error("nonce too low");
      throw e;
    };
    try {
      await assert.rejects(writeAndWait(orchestratorWallet, args, hooks));
    } finally {
      restore();
    }
    check("a nonce error (this tx may be the one mined) is not read as not-sent", calls.join(",") === "before", calls.join(","));
    for (const [label, err] of [
      ["an InternalRpcError", new InternalRpcError(new Error("internal error"))],
      ["a LimitExceededRpcError", new LimitExceededRpcError(new Error("limit"))],
      ["an already-known reply", new Error("already known")],
    ] as const) {
      calls.length = 0;
      (orchestratorWallet as any).writeContract = async () => {
        throw err;
      };
      try {
        await assert.rejects(writeAndWait(orchestratorWallet, args, hooks));
      } finally {
        restore();
      }
      check(`${label} is not read as not-sent`, calls.join(",") === "before", calls.join(","));
    }
    calls.length = 0;
    (orchestratorWallet as any).writeContract = async () => {
      throw new TransactionExecutionError(new InsufficientFundsError({ cause: new InternalRpcError(new Error("insufficient funds")) }), {
        account: orchestratorWallet.account,
      } as any);
    };
    try {
      await assert.rejects(writeAndWait(orchestratorWallet, args, hooks));
    } finally {
      restore();
    }
    check("insufficient funds is a definite refusal", calls.join(",") === "before,not-sent", calls.join(","));
  }

  console.log("   daily cap counts both pots…");
  {
    const user = await seedUser("Cap", 0);
    const usage = await dailyCapUsage(user);
    check("cap is read from the contract", usage.capEur > 0, `€${usage.capEur}`);
    check("nothing used yet", usage.usedEur === 0, `€${usage.usedEur}`);

    store.addTransfer({
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "cash",
      recipientName: "R",
      state: "CREATED",
      sendEur: 400,
      receiveKes: 0,
      fundingSource: "safe",
      txs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
    const after = await dailyCapUsage(user);
    check("Safe spending counts against the same budget", after.usedEur === 400, `€${after.usedEur}`);
    check("and is attributed to the Safe", after.fromSafeEur === 400, `€${after.fromSafeEur}`);
  }

  console.log(`\nsafe-funded recovery: ${passed}/${passed} checks passed`);
} finally {
  for (const c of children) c.kill();
}
