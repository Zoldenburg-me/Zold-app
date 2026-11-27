/**
 * A deposit conversion was submitted and the write recording it failed. A
 * failed write exits the process (store/db.ts), so the restart sees only what
 * reached db.json. Can that restart offer the same deposit for a second swap,
 * which would spend other USDC in the Safe?
 *
 * Each scenario is two real processes: `convert` runs the real route through
 * prepare and a passkey-signed convert until the named store write fails, and
 * the process really exits; `restart` loads what is on disk and asks
 * depositConversionBlocker whether the deposit is convertible.
 *
 * The chain is hardhat. The Safe operation is stubbed (a hardhat node has no
 * bundler): it either lands or is uncertain, and each submit is logged so a
 * swap is counted across both processes. The venue plan is stubbed as in
 * convert-race.
 *
 *   npm run convert:crash:test
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
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hardhatNode } from "./_free-port.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SAFE = "0x1111111111111111111111111111111111111111" as const;
const ORIGIN = "http://localhost:3000";

type Row = { holding: string; txs: { step: string }[]; conversionIntent?: unknown };
const hasStep = (r: Row, step: string) => r.txs.some((x) => x.step === step);

interface Scenario {
  /** What the stubbed Safe operation does once submitted. */
  submit: "lands" | "uncertain";
  /** The deposit write that fails, seen with the change already in memory. */
  crashOn: (r: Row) => boolean;
  expect: { submits: number; blocked: boolean };
}

const SCENARIOS: Record<string, Scenario> = {
  "swap landed, the unconfirmed write fails": {
    submit: "lands",
    crashOn: (r) => r.holding === "unconfirmed" && hasStep(r, "safe.swap(usdc->eure)"),
    expect: { submits: 1, blocked: true },
  },
  "swap uncertain, the unconfirmed write fails": {
    submit: "uncertain",
    crashOn: (r) => r.holding === "unconfirmed" && hasStep(r, "safe.swap(usdc->eure).unconfirmed"),
    expect: { submits: 1, blocked: true },
  },
  // Nothing was sent, so the deposit is still convertible.
  "intent write fails, nothing submitted": {
    submit: "lands",
    crashOn: (r) => Boolean(r.conversionIntent),
    expect: { submits: 0, blocked: false },
  },
};

const phase = process.argv[2];
if (phase) await child(phase, process.argv[3]);
else await parent();

async function child(which: string, name: string) {
  const scenario = SCENARIOS[name];
  process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, KES: 147.53, INR: 109.87 });
  process.env.ALLOW_FIXED_RATES = "1";

  // The Safe operation, stubbed before the route imports it.
  const { mock } = await import("node:test");
  const candideUrl = new URL("../services/api/src/wallet/candide.ts", import.meta.url).href;
  const candide = await import(candideUrl);
  mock.module(candideUrl, {
    namedExports: {
      ...candide,
      submitPasskeySafeOperationWithReceipt: async () => {
        appendFileSync(process.env.SEND_LOG!, "safe.submit\n");
        if (scenario.submit === "uncertain") throw new candide.SafeOperationUncertainError(`0x${"cd".repeat(32)}`, "no receipt");
        return { userOpHash: `0x${"0".repeat(63)}1`, txHash: `0x${"0".repeat(64)}`, blockNumber: 0, gasCostWei: "0", gasPaidBy: "sponsored", success: true };
      },
    },
  });

  const { initStore, store } = await import("../services/api/src/store.js");
  const dbm = await import("../services/api/src/store/db.js");
  const { depositConversionBlocker } = await import("../services/api/src/adapters/crypto-deposits.js");
  await initStore();

  if (which === "restart") {
    const d = (await store.list("cryptoDeposits")).find((x) => x.id === "d-crash")!;
    const blocker = depositConversionBlocker((await store.findUser(d.userId!))!, d);
    console.log(`RESULT ${JSON.stringify({ blocker, holding: d.holding })}`);
    process.exit(0);
  }

  // ── convert: seed a held deposit, prepare, sign, arm the failing write, convert.
  const express = (await import("express")).default;
  const { abis, addrs, deployerWallet, writeAndWait } = await import("../services/api/src/chain.js");
  const { createCryptoDepositRouter } = await import("../services/api/src/routes/crypto-deposits.js");
  const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");
  const { makeSoftwarePasskey } = await import("./_software-passkey.js");

  (FxSwapperLiquidityProvider.prototype as any).safeSwapPlan = async (
    side: string, amountIn: bigint, quoteId: string, expiresAt: string,
  ) => ({
    quote: { provider: "fx-swapper", side, quoteId, expiresAt, amountIn, rate: 1_137_900n, expectedOut: 400n * 10n ** 18n, minOut: 1n },
    approval: { token: addrs().usdc, spender: "0x000000000000000000000000000000000000dEaD", amount: amountIn },
    call: { to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 0n },
  });
  // The Safe holds the deposit's USDC, so prepare's balance check passes.
  await writeAndWait(deployerWallet!, { address: addrs().usdc, abi: abis.MockToken, functionName: "mint", args: [SAFE, 500n * 10n ** 6n] });

  const passkey = await makeSoftwarePasskey("crash", ORIGIN);
  const hex = (b64: string) => "0x" + Buffer.from(b64, "base64url").toString("hex");
  const now = new Date().toISOString();
  await store.addUser({
    id: "u-crash", name: "Crash GmbH", country: "DE", kycStatus: "approved", address: SAFE,
    wallet: { type: "candide-safe", deployed: true },
    passkey: { credentialId: passkey.credentialId, publicKey: { alg: "ES256", jwk: passkey.jwk }, signCount: 0, rpId: "localhost" },
    passkeySafe: {
      status: "active", address: SAFE, threshold: 1, importedAt: now,
      passkeyPublicKey: { x: hex(passkey.jwk.x!), y: hex(passkey.jwk.y!) },
    },
    paymentPage: { handle: "crash", autoConvert: false, settlementAsset: "EURE" },
    createdAt: now,
  } as any);
  await store.addCryptoDeposit({
    id: "d-crash", userId: "u-crash", chainId: 31337, token: "USDC",
    txHash: "0x" + "ab".repeat(32), logIndex: 0, amountUnits: "500000000", amountUsdc: 500,
    holding: "held", settlementAsset: "USDC", creditedUsdc: 500, settledAt: now, txs: [],
    detectedAt: now, updatedAt: now,
  } as any);

  const app = express();
  app.use(express.json());
  app.use("/api", createCryptoDepositRouter({ requireUserSession: async () => ({ id: "s" }) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const api = `http://127.0.0.1:${(server.address() as any).port}/api/users/u-crash/crypto-deposits/d-crash`;
  const post = async (p: string, body: unknown = {}) => {
    const res = await fetch(api + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  };
  const prep = await post("/convert/prepare");
  if (prep.status !== 200) {
    console.log(`PREPARE FAILED ${prep.status} ${JSON.stringify(prep.data)}`);
    process.exit(2);
  }
  const executionAssertion = await passkey.assert(prep.data.challenge);

  // Arm: the real persist fails on the chosen write and really exits.
  const realRename = fs.renameSync;
  fs.renameSync = ((from: any, to: any) => {
    const r = dbm.db.cryptoDeposits.find((x) => x.id === "d-crash") as unknown as Row;
    if (scenario.crashOn(r)) throw Object.assign(new Error("disk refused"), { code: "EIO" });
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  const res = await post("/convert", { executionAssertion });
  console.log(`NOCRASH the armed write never happened; convert answered ${res.status} ${JSON.stringify(res.data)}`);
  process.exit(0);
}

async function parent() {
  const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-convert-crash-"));
  const node = await hardhatNode(ROOT);
  const env: NodeJS.ProcessEnv = { ...process.env, TRANSF_RPC_URL: node.url, DEPLOY_EURUSD_RATE: "1137900" };
  const run = (args: string[], dbPath: string, sendLog: string) =>
    spawnSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", "--import", "tsx", SELF, ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
      env: { ...env, TRANSF_DB_PATH: dbPath, SEND_LOG: sendLog },
    });
  const failures: string[] = [];
  try {
    const deploy = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(deploy.status, 0, `deploy failed\n${deploy.stderr}`);

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const dbPath = path.join(dir, `${randomUUID()}.json`);
      const sendLog = path.join(dir, `${randomUUID()}.log`);
      appendFileSync(sendLog, "");
      const convert = run(["convert", name], dbPath, sendLog);
      if (convert.status !== 1 || !/FATAL store write failed \(EIO\)/.test(convert.stderr)) {
        failures.push(name);
        console.log(`  FAIL ${name}: the convert phase did not die on the failed write (exit ${convert.status})\n${convert.stdout}\n${convert.stderr}`);
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
      const submits = readFileSync(sendLog, "utf8").split("\n").filter(Boolean).length;
      const ok = submits === scenario.expect.submits && (got.blocker !== null) === scenario.expect.blocked;
      if (!ok) failures.push(name);
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${name} -> ${submits} submit(s), restart holding ${got.holding}, ` +
          `${got.blocker ? `blocked: ${got.blocker}` : "convertible"}` +
          (ok ? "" : `\n       wanted ${JSON.stringify(scenario.expect)}`),
      );
    }
  } finally {
    node.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `${failures.length} path(s) offer a deposit again after a lost conversion record`);
  console.log("CONVERT CRASH TEST PASSED — no lost record offers a deposit for a second swap");
  process.exit(0);
}
