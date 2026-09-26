/**
 * Recovery for Safe-funded transfers.
 *
 * A SEPA transfer takes its fee out of the user's own Safe; the payout is
 * burned from the Safe by Monerium. Compensation used to decide "did any
 * money move?" by looking for an old ledger step, which that path never
 * pushes — so a failure recorded a €0 refund reading "nothing was debited"
 * while the euros sat at the orchestrator, and the sweep then skipped the
 * transfer forever because a set `refund` is what marks one as settled.
 *
 * Why this drives compensateTransfer directly instead of sending a transfer:
 * the debit leg itself now requires an active passkey Safe signing the debit, which a
 * hardhat node cannot provide. What CAN be tested locally is everything that
 * happens after it, which is where the money was being lost. The seeded state
 * is exactly what debitSafeFundedSepaFee writes on success.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8549";
process.env.TRANSF_RPC_URL = RPC;
// SEPA is free by default, so the fee leg this suite exercises would not exist.
// Pin a fee for the run: the property under test is that ONLY the fee comes
// back, which needs a fee to move in the first place.
process.env.SEPA_FEE_EUR ??= "0.99";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";

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
  console.log("1/4 chain + deploy…");
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
  const { abis, addrs, eur, orchestratorAddress, publicClient, writeAndWait, deployerWallet } =
    await import("../services/api/src/chain.js");
  const { compensateTransfer, sweepStrandedTransfers, dailyCapUsage, DEBIT_STEP } = await import(
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

  /** The transfer record debitSafeFundedSepaFee leaves behind after a
   *  successful fee move, then failed: the fee step recorded, the fee at the
   *  orchestrator, the payout still in the Safe. */
  async function seedFeeDebitedTransfer(user: any, sendEur: number, feeEur: number) {
    // The orchestrator ends up holding what left the Safe: the fee.
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
      error: "forced failure for test",
      sendEur,
      receiveEur: sendEur - feeEur,
      fundingSource: "safe" as const,
      txs: [{ step: DEBIT_STEP.safeFee, hash: `0x${"11".repeat(32)}` }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.addTransfer(t);
    return t;
  }

  console.log("2/4 a failed transfer refunds its fee to the Safe…");
  {
    const user = await seedUser("Safe Refund", 0);
    const t = await seedFeeDebitedTransfer(user, 100, 2);
    const before = await eureBalance(user.address);
    const out = await compensateTransfer(t.id);

    check("state is REFUNDED", out.state === "REFUNDED", `got ${out.state} (${out.error ?? ""})`);
    check(
      "refund is the fee that moved, not €0",
      out.refund?.amountEur === 2,
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
    check("EURe arrived back in the Safe", after - before === 2, `${before} -> ${after}`);
    check(
      "only the Safe refund step was recorded",
      !out.txs.some((x: any) => x.step.includes("vault")),
    );
  }

  console.log("3/4 the configured SEPA fee is what comes back, never the payout…");
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

  console.log("4/4 the sweep picks up Safe-funded failures…");
  {
    const user = await seedUser("Safe Sweep", 0);
    const t = await seedFeeDebitedTransfer(user, 25, 1);
    const n = await sweepStrandedTransfers();
    const out = store.findTransfer(t.id)!;
    check("sweep compensated at least one transfer", n >= 1, `n=${n}`);
    check("swept transfer reached REFUNDED", out.state === "REFUNDED", `got ${out.state}`);
    check("swept refund is the €1 fee", out.refund?.amountEur === 1, `got ${out.refund?.amountEur}`);
  }

  console.log("   a genuinely pre-debit failure still owes nothing…");
  {
    const user = await seedUser("No Debit", 0);
    const t = {
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "sepa" as const,
      recipientName: "Recipient",
      recipientIban: "DE89370400440532013000",
      state: "FAILED" as const,
      sendEur: 10,
      receiveEur: 10,
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

  console.log("   daily cap counts Safe-funded sends…");
  {
    const user = await seedUser("Cap", 0);
    const usage = await dailyCapUsage(user);
    check("cap is read from the contract", usage.capEur > 0, `€${usage.capEur}`);
    check("nothing used yet", usage.usedEur === 0, `€${usage.usedEur}`);

    store.addTransfer({
      id: randomUUID(),
      userId: user.id,
      quoteId: randomUUID(),
      rail: "sepa",
      recipientName: "R",
      recipientIban: "DE89370400440532013000",
      state: "CREATED",
      sendEur: 400,
      receiveEur: 400,
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
