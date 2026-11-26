/**
 * What wallet/candide.ts does with a Safe operation after the passkey signed
 * it, and what a later answer may change in it.
 *
 * Submission: only the bundler's own JSON-RPC refusal reads as "nothing was
 * sent". A send that times out, a dropped connection, an unreadable reply, a
 * receipt read that hangs or errs, and a bundler that names another op's hash
 * are all uncertain, under the hash computed from the signed op, so the
 * caller reconciles by that hash and never refunds or re-sends. A reverted op
 * is reported as reverted. The answer of a later receipt read
 * (userOperationOutcome) is pending, landed, reverted or an error: never
 * "failed safely".
 *
 * Construction: chain, Safe, nonce, token, recipient, amount, approval and gas
 * come from the plan and the pre-signing reads; a paymaster answer that names
 * callData, sender or nonce changes nothing, and the op the bundler receives
 * is the op whose digest was signed.
 *
 * An org op whose sponsorship lapsed while it waited for signatures: the
 * bundler's refusal stops it, nothing re-quotes it under the old signatures,
 * and a re-quoted op (new paymaster data, new digest) cannot borrow them.
 *
 * Offline: one stub JSON-RPC server is the chain RPC, the bundler and the
 * paymaster. What this cannot show is how Candide's live bundler words a
 * refusal or a duplicate; `npm run preflight` asks the live endpoints.
 *
 * Run: npm run candide:matrix:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { makeSoftwarePasskey } from "./_software-passkey.js";

// Before any import reads them: a short partner timeout so a hang fails fast,
// a non-local chain so the hardhat harness is off, sponsored gas.
process.env.PARTNER_HTTP_TIMEOUT_MS = "300";
// The app on the local chain with the harness OFF (as safe-op-queue-test), Safes
// on Base Sepolia: no submission may take the harness's fake receipts.
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
// Set, not deleted: loadEnvFile would put an operator's .env value back.
process.env.SAFE_GAS_PAYMENT = "sponsored";
process.env.SAFE_GAS_TOKEN = "";
process.env.CANDIDE_SPONSORSHIP_POLICY_ID = "";

type Answer = unknown | typeof HANG | typeof DROP | typeof HTML | { __error: { code: number; message: string } };
const HANG = Symbol("hang");
const DROP = Symbol("drop");
const HTML = Symbol("html");
const ZERO32 = `0x${"0".repeat(64)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

const calls: { method: string; params: any[] }[] = [];
const stub = {
  nonce: 7n,
  threshold: 1n,
  /** pm_getPaymasterStubData / pm_getPaymasterData answers. */
  paymasterExtra: {} as Record<string, unknown>,
  paymasterData: "0x01",
  send: (_params: any[]): Answer => ({ __error: { code: -32500, message: "no send answer set" } }),
  receipt: (_hash: string): Answer => null,
};
const PAYMASTER = "0xca944fb73fa5191969014ded9bb075381d59c7de";

function answer(method: string, params: any[]): Answer {
  switch (method) {
    case "eth_chainId": return "0x14a34";
    case "eth_supportedEntryPoints": return ["0x433709009B8330FDa32311DF1C2AFA402eD8D009"];
    case "eth_getCode": return "0x6080";
    case "eth_call": {
      const data = String(params[0]?.data ?? "");
      if (data.startsWith("0xe75235b8")) return word(stub.threshold); // getThreshold()
      if (data.startsWith("0x35567e1a")) return word(stub.nonce); // EntryPoint getNonce(address,uint192)
      return ZERO32;
    }
    case "eth_getStorageAt": return ZERO32;
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
    case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1" };
    case "eth_estimateUserOperationGas":
      return { preVerificationGas: "0xc350", verificationGasLimit: "0x61a80", callGasLimit: "0x186a0" };
    case "pm_getPaymasterStubData":
    case "pm_getPaymasterData":
      return {
        paymaster: PAYMASTER,
        paymasterData: stub.paymasterData,
        paymasterVerificationGasLimit: "0x7530",
        paymasterPostOpGasLimit: "0x4e20",
        ...stub.paymasterExtra,
      };
    case "eth_sendUserOperation": return stub.send(params);
    case "eth_getUserOperationReceipt": return stub.receipt(String(params[0]));
    default: return null;
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    calls.push({ method: msg.method, params: msg.params ?? [] });
    const out = answer(msg.method, msg.params ?? []);
    if (out === HANG) return; // never answer: the partner timeout aborts it
    if (out === DROP) return void req.socket.destroy(); // read, then the connection drops
    if (out === HTML) {
      res.writeHead(502, { "content-type": "text/html" });
      return void res.end("<html><body>502 Bad Gateway</body></html>");
    }
    res.setHeader("content-type", "application/json");
    if (out && typeof out === "object" && "__error" in (out as any)) {
      return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: (out as any).__error }));
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: out }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const URL_ = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.CANDIDE_RPC_URL = URL_;
process.env.CANDIDE_BUNDLER_URL = URL_;
process.env.CANDIDE_PAYMASTER_URL = URL_;

const { createUserOperationHash } = await import("abstractionkit");
const { encodeFunctionData, erc20Abi } = await import("viem");
const {
  CANDIDE,
  BundlerRefusedError,
  SafeOperationUncertainError,
  prepareTransferExecution,
  prepareTransferBatchExecution,
  prepareMultiOwnerSafeOperation,
  safeOperationDigest,
  smartAccountForPasskey,
  submitMultiOwnerSafeOperation,
  submitPasskeySafeOperationWithReceipt,
  transferExecutionTransactions,
  userOperationOutcome,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} = await import("../services/api/src/wallet/candide.js");

const ENTRYPOINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const TOKEN = "0x00000000000000000000000000000000000e0e0e" as const;
const RECIPIENT = "0x00000000000000000000000000000000000d0d0d" as const;
const AMOUNT = 1_234_567n;

const key = await makeSoftwarePasskey("anna", "http://localhost:3000");
const owner = webauthnOwnerFromJwk(key.jwk)!;
const plan = {
  address: smartAccountForPasskey(owner).accountAddress as `0x${string}`,
  threshold: 1 as const,
  passkeyPublicKey: webauthnOwnerToStore(owner),
};
const assertionFor = async (challenge: string) => {
  const a = await key.assert(Buffer.from(challenge.slice(2), "hex").toString("base64url"));
  return {
    authenticatorData: Buffer.from(a.authenticatorData, "base64url"),
    clientDataJSON: Buffer.from(a.clientDataJSON, "base64url"),
    signature: Buffer.from(a.signature, "base64url"),
  };
};
const hashOf = (op: any) => createUserOperationHash(op, ENTRYPOINT, CANDIDE.chainId);
const receiptFor = (hash: string, success: boolean) => ({
  userOpHash: hash,
  sender: plan.address,
  nonce: "0x7",
  success,
  actualGasCost: "0x2386f26fc10000",
  actualGasUsed: "0x30d40",
  logs: [],
  receipt: {
    transactionHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x10",
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    transactionIndex: "0x0",
    effectiveGasPrice: "0x1",
    logs: [],
  },
});
const sent = () => calls.filter((c) => c.method === "eth_sendUserOperation");
const polled = () => calls.filter((c) => c.method === "eth_getUserOperationReceipt").map((c) => String(c.params[0]));

let passed = 0;
let failed = 0;
const todo = (name: string, why: string) => console.log(`  todo  ${name}\n        ${why}`);
async function check(name: string, fn: () => Promise<void>) {
  calls.length = 0;
  stub.paymasterExtra = {};
  stub.paymasterData = "0x01";
  stub.nonce = 7n;
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${(err as Error)?.stack ?? err}`);
  }
}

/** A freshly prepared and signed personal transfer, and the hash it lands under. */
async function signedTransfer() {
  const prepared = await prepareTransferExecution(plan, TOKEN, RECIPIENT, AMOUNT);
  return { prepared, hash: hashOf(prepared.userOperation), assertion: await assertionFor(prepared.challenge) };
}
const submit = (s: Awaited<ReturnType<typeof signedTransfer>>) =>
  submitPasskeySafeOperationWithReceipt(plan, s.prepared.userOperation, s.assertion);
const uncertainUnder = (hash: string) => (e: unknown) => {
  assert.ok(e instanceof SafeOperationUncertainError, `expected uncertain, got ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
  assert.equal(e.userOpHash.toLowerCase(), hash.toLowerCase(), "uncertain under the hash of the signed op");
  return true;
};

try {
  console.log("candide submission: before and after the bundler takes the op");

  await check("a JSON-RPC refusal (AA24) is the one answer that reads as nothing sent, and nothing is polled", async () => {
    const s = await signedTransfer();
    stub.send = () => ({ __error: { code: -32507, message: "AA24 signature error" } });
    await assert.rejects(submit(s), (e: any) => e instanceof BundlerRefusedError && /AA24/.test(e.message));
    assert.equal(sent().length, 1);
    assert.deepEqual(polled(), []);
  });

  await check("a send that times out (the bundler may have taken it) is uncertain, not refused", async () => {
    const s = await signedTransfer();
    stub.send = () => HANG;
    await assert.rejects(submit(s), uncertainUnder(s.hash));
    assert.equal(sent().length, 1, "sent once, never re-sent");
  });

  await check("a connection dropped after the bundler read the op is uncertain", async () => {
    const s = await signedTransfer();
    stub.send = () => DROP;
    await assert.rejects(submit(s), uncertainUnder(s.hash));
    assert.equal(sent().length, 1);
  });

  await check("an unreadable reply (a 502 page) is uncertain", async () => {
    const s = await signedTransfer();
    stub.send = () => HTML;
    await assert.rejects(submit(s), uncertainUnder(s.hash));
  });

  await check("-32603, which also stands for an unparseable reply, is uncertain", async () => {
    const s = await signedTransfer();
    stub.send = () => ({ __error: { code: -32603, message: "internal error" } });
    await assert.rejects(submit(s), uncertainUnder(s.hash));
  });

  await check("accepted, then the receipt read hangs: uncertain under the accepted hash", async () => {
    const s = await signedTransfer();
    stub.send = () => s.hash;
    stub.receipt = () => HANG;
    await assert.rejects(submit(s), uncertainUnder(s.hash));
    assert.equal(sent().length, 1);
  });

  await check("accepted, then the receipt read errs: uncertain, never read as the bundler's refusal", async () => {
    const s = await signedTransfer();
    stub.send = () => s.hash;
    stub.receipt = () => ({ __error: { code: -32601, message: "method not found" } });
    await assert.rejects(submit(s), uncertainUnder(s.hash));
    assert.equal(sent().length, 1);
  });

  await check("a bundler that answers another op's hash is uncertain under ours, and that hash is never polled", async () => {
    const s = await signedTransfer();
    const other = `0x${"99".repeat(32)}`;
    stub.send = () => other;
    stub.receipt = (h) => receiptFor(h, true);
    await assert.rejects(submit(s), uncertainUnder(s.hash));
    assert.ok(!polled().includes(other), "the foreign hash's receipt would have been reported as ours");
  });

  await check("included but reverted is reported as reverted, under the signed op's hash", async () => {
    const s = await signedTransfer();
    stub.send = () => s.hash;
    stub.receipt = (h) => receiptFor(h, false);
    const out = await submit(s);
    assert.equal(out.success, false);
    assert.equal(out.userOpHash, s.hash);
  });

  await check("included: the receipt's tx, block and gas, under the signed op's hash", async () => {
    const s = await signedTransfer();
    stub.send = () => s.hash;
    stub.receipt = (h) => receiptFor(h, true);
    const out = await submit(s);
    assert.deepEqual(
      { ...out },
      { userOpHash: s.hash, txHash: `0x${"cd".repeat(32)}`, blockNumber: 16, gasCostWei: "10000000000000000", success: true, gasPaidBy: "sponsored" },
    );
    assert.deepEqual(polled(), [s.hash]);
  });

  console.log("candide reconciliation by userOpHash (a lost answer, a restart)");

  await check("a later read of the hash: pending is null, landed and reverted are named, an error throws", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    stub.receipt = () => null;
    assert.equal(await userOperationOutcome(hash), null, "no receipt yet is pending, not failed");
    stub.receipt = (h) => receiptFor(h, true);
    assert.deepEqual(await userOperationOutcome(hash), { success: true, txHash: `0x${"cd".repeat(32)}` });
    stub.receipt = (h) => receiptFor(h, false);
    assert.deepEqual(await userOperationOutcome(hash), { success: false, txHash: `0x${"cd".repeat(32)}` });
    for (const bad of [() => ({ __error: { code: -32000, message: "boom" } }), () => HTML, () => HANG, () => ({ success: "yes" })]) {
      stub.receipt = bad as any;
      await assert.rejects(userOperationOutcome(hash), "an unreadable or failed read is an error, never an outcome");
    }
    assert.ok(polled().every((h) => h === hash));
  });

  await check("the hash an uncertain send names is the one the op lands under, signature or not", async () => {
    const s = await signedTransfer();
    stub.send = () => HANG;
    const err = await submit(s).catch((e) => e);
    assert.ok(err instanceof SafeOperationUncertainError);
    const wire = sent()[0].params[0];
    assert.match(wire.signature, /^0x[0-9a-f]{130,}$/i, "the op went out signed");
    assert.equal(err.userOpHash, s.hash, "known before the send: the hash leaves the signature out");
  });

  console.log("candide construction: what the passkey signs comes from the plan");

  await check("transfer: sender, nonce, token, recipient and amount are the plan's; the digest is this chain's", async () => {
    stub.nonce = 41n;
    const prepared = await prepareTransferExecution(plan, TOKEN, RECIPIENT, AMOUNT);
    const op: any = prepared.userOperation;
    assert.equal(op.sender.toLowerCase(), plan.address.toLowerCase());
    assert.equal(op.nonce, 41n, "the EntryPoint's nonce, read before signing");
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, AMOUNT] });
    assert.ok(op.callData.toLowerCase().includes(transfer.slice(2).toLowerCase()), "transfer(recipient, amount)");
    assert.ok(op.callData.toLowerCase().includes(TOKEN.slice(2)), "on the plan's token");
    assert.equal(prepared.challenge, safeOperationDigest(plan.address, op));
    const realChain = CANDIDE.chainId;
    try {
      (CANDIDE as any).chainId = 8453n;
      assert.notEqual(safeOperationDigest(plan.address, op), prepared.challenge, "another chain's digest differs");
    } finally {
      (CANDIDE as any).chainId = realChain;
    }
  });

  await check("a paymaster answer naming callData, sender, nonce or gas changes none of them", async () => {
    const clean: any = (await prepareTransferExecution(plan, TOKEN, RECIPIENT, AMOUNT)).userOperation;
    stub.paymasterExtra = {
      callData: "0xdeadbeef",
      sender: "0x000000000000000000000000000000000000bad1",
      nonce: "0x63",
      callGasLimit: "0xffffffff",
      maxFeePerGas: "0xffffffff",
    };
    const prepared = await prepareTransferExecution(plan, TOKEN, RECIPIENT, AMOUNT);
    const op: any = prepared.userOperation;
    for (const f of ["callData", "sender", "nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"]) {
      assert.deepEqual(op[f], clean[f], `${f} came from the paymaster`);
    }
    assert.equal(op.paymaster.toLowerCase(), PAYMASTER, "only the paymaster's own fields are taken");
    assert.equal(prepared.challenge, safeOperationDigest(plan.address, op), "and the passkey signs over them");
  });

  await check("swap batch: the fee, the approval (spender and amount) and the call are exactly the arguments", async () => {
    const feeTo = "0x00000000000000000000000000000000000f0f0f" as const;
    const spender = "0x00000000000000000000000000000000000a0a0a" as const;
    const call = { to: "0x00000000000000000000000000000000000c0c0c" as const, data: "0xc0ffee00" as const, value: 0n };
    const prepared = await prepareTransferBatchExecution(plan, { token: TOKEN, feeTo, feeAmount: 500n, approval: { spender, amount: 9_000n }, call });
    const data = String((prepared.userOperation as any).callData).toLowerCase();
    const fee = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [feeTo, 500n] });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 9_000n] });
    assert.ok(data.includes(fee.slice(2)), "fee transfer");
    assert.ok(data.includes(approve.slice(2)), "approve exactly the convert amount to the named spender");
    assert.ok(data.includes("c0ffee00") && data.includes(call.to.slice(2)), "the swap call");
  });

  await check("the bundler receives exactly the op whose digest was signed: no field is re-read at send", async () => {
    const s = await signedTransfer();
    calls.length = 0;
    stub.send = () => s.hash;
    stub.receipt = (h) => receiptFor(h, true);
    stub.nonce = 99n; // the chain moved on between signing and sending
    stub.paymasterData = "0x02"; // and the paymaster would quote differently now
    await submit(s);
    const wire = sent()[0].params[0];
    const op: any = s.prepared.userOperation;
    for (const f of ["sender", "nonce", "callData", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]) {
      const want = typeof op[f] === "bigint" ? `0x${op[f].toString(16)}` : op[f];
      assert.equal(String(wire[f]).toLowerCase(), String(want).toLowerCase(), `${f} changed between signing and sending`);
    }
    assert.ok(!calls.some((c) => c.method.startsWith("pm_")), "the paymaster is not asked again at send");
  });

  console.log("candide org op: sponsorship lapses while it waits for signatures");

  const second = await makeSoftwarePasskey("bert", "http://localhost:3000");
  const ownerB = webauthnOwnerFromJwk(second.jwk)!;
  const ORG_SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
  const signAll = async (digest: string) => {
    const b64 = Buffer.from(digest.slice(2), "hex").toString("base64url");
    return Promise.all([[key, owner], [second, ownerB]].map(async ([k, pub]: any) => {
      const a = await k.assert(b64);
      return {
        publicKey: pub,
        assertion: {
          authenticatorData: Buffer.from(a.authenticatorData, "base64url"),
          clientDataJSON: Buffer.from(a.clientDataJSON, "base64url"),
          signature: Buffer.from(a.signature, "base64url"),
        },
      };
    }));
  };

  await check("the expired sponsorship's refusal stops the op: sent once, not re-quoted, not re-sent", async () => {
    const txs = transferExecutionTransactions(TOKEN, RECIPIENT, AMOUNT);
    const op = await prepareMultiOwnerSafeOperation(ORG_SAFE, txs, [owner, ownerB]);
    assert.equal(op.nonce, 7n);
    const signed = await signAll(op.challenge);
    calls.length = 0;
    stub.send = () => ({ __error: { code: -32503, message: "AA32 paymaster expired or not due" } });
    await assert.rejects(
      submitMultiOwnerSafeOperation(ORG_SAFE, op.userOperation, op.challenge, signed),
      (e: any) => e instanceof BundlerRefusedError && /AA32|expired/.test(e.message),
    );
    assert.equal(sent().length, 1);
    assert.ok(!calls.some((c) => c.method.startsWith("pm_")), "no re-quote at relay");
  });

  await check("a re-quoted op has a new digest, and the old signatures cannot carry it", async () => {
    const txs = transferExecutionTransactions(TOKEN, RECIPIENT, AMOUNT);
    const old = await prepareMultiOwnerSafeOperation(ORG_SAFE, txs, [owner, ownerB]);
    const signed = await signAll(old.challenge);
    stub.paymasterData = "0x02"; // a fresh sponsorship window
    const fresh = await prepareMultiOwnerSafeOperation(ORG_SAFE, txs, [owner, ownerB]);
    assert.notEqual(fresh.challenge, old.challenge, "new paymaster data is a new digest");
    calls.length = 0;
    await assert.rejects(
      submitMultiOwnerSafeOperation(ORG_SAFE, fresh.userOperation, old.challenge, signed),
      /does not match the digest its owners signed/,
    );
    assert.equal(sent().length, 0, "refused before the bundler");
  });

  await check("an org relay that times out is uncertain under the signed op's hash", async () => {
    const txs = transferExecutionTransactions(TOKEN, RECIPIENT, AMOUNT);
    const op = await prepareMultiOwnerSafeOperation(ORG_SAFE, txs, [owner, ownerB]);
    const signed = await signAll(op.challenge);
    stub.send = () => HANG;
    await assert.rejects(
      submitMultiOwnerSafeOperation(ORG_SAFE, op.userOperation, op.challenge, signed),
      uncertainUnder(hashOf(op.userOperation)),
    );
  });
  // Needs a decision, so not asserted here (board #229):
  todo(
    "a crash between the claim and the bundler's answer leaves no userOpHash on record",
    "the orchestrator's review-unrecorded-debit and a SUBMITTED crypto send carry no hash to reconcile by, though " +
      "the hash is known before the send (it leaves the signature out); where to persist it pre-send is open",
  );
  todo(
    "an org op is not re-quoted when its sponsorship lapses",
    "the bundler's refusal ends it FAILED and the owners sign a new op; re-quoting and re-collecting signatures is a product call",
  );
} finally {
  server.close();
}

console.log(`\ncandide-matrix: ${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
