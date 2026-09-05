/**
 * User-signed Safe execution — the meta-transactions of one transfer's debit,
 * signed by the user's passkey as a UserOperation. There is no delegate and
 * no standing spend authority, so the property under test is that the batch
 * contains EXACTLY the movement the user approves — token, destination and
 * amount chain-enforced — plus, at most, the revocation of a standing
 * allowance left on an older Safe.
 *
 * No chain, no bundler: the builder is pure. The bundler/paymaster wrapper and
 * the authorize-route flow are exercised against Base Sepolia, not here.
 */
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import {
  CANDIDE,
  transferExecutionTransactions,
  transferSwapBatchTransactions,
} from "../services/api/src/wallet/candide.js";

const TOKEN = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const DEST = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const DELEGATE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const MODULE = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const AMOUNT = 12_345_000_000_000_000_000n; // €12.345 in wei — deliberately not round

const ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "deleteAllowance",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const decode = (data: string) => decodeFunctionData({ abi: ABI, data: data as `0x${string}` });

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
};

// ---- the normal case: one ERC-20 transfer, nothing else ----
const plain = transferExecutionTransactions(TOKEN, DEST, AMOUNT);

check("a debit is ONE transfer call on the token, nothing else", () => {
  assert.equal(plain.length, 1);
  assert.equal(plain[0].to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(decode(plain[0].data).functionName, "transfer");
});

check("the transfer encodes the EXACT destination and amount", () => {
  const { args } = decode(plain[0].data);
  assert.equal(String(args![0]).toLowerCase(), DEST.toLowerCase());
  assert.equal(args![1], AMOUNT);
});

check("no allowance-module call appears in a plain debit", () => {
  for (const t of plain) assert.notEqual(t.to.toLowerCase(), MODULE.toLowerCase());
});

// ---- cleanup: a standing allowance is revoked in the same operation ----
check("a standing allowance is revoked BEFORE the transfer", () => {
  const revoking = transferExecutionTransactions(TOKEN, DEST, AMOUNT, {
    revokeLegacyAllowance: { delegate: DELEGATE, moduleAddress: MODULE },
  });
  assert.equal(revoking.length, 2);
  assert.equal(revoking[0].to.toLowerCase(), MODULE.toLowerCase());
  const del = decode(revoking[0].data);
  assert.equal(del.functionName, "deleteAllowance");
  assert.equal(String(del.args![0]).toLowerCase(), DELEGATE.toLowerCase());
  assert.equal(String(del.args![1]).toLowerCase(), TOKEN.toLowerCase());
  assert.equal(decode(revoking[1].data).functionName, "transfer");
});

check("the revoke module address defaults to the configured CANDIDE module", () => {
  const revoking = transferExecutionTransactions(TOKEN, DEST, AMOUNT, {
    revokeLegacyAllowance: { delegate: DELEGATE },
  });
  assert.equal(revoking[0].to.toLowerCase(), CANDIDE.allowanceModuleAddress.toLowerCase());
});

// ---- refusals ----
check("a zero-amount execution refuses", () => {
  assert.throws(() => transferExecutionTransactions(TOKEN, DEST, 0n), /positive amount/);
});

check("a negative-amount execution refuses", () => {
  assert.throws(() => transferExecutionTransactions(TOKEN, DEST, -1n), /positive amount/);
});

// ---- the fee+approve+swap batch (Change 2, windows 1-3) ----
const FEE_TO = "0x5555555555555555555555555555555555555555" as `0x${string}`;
const SPENDER = "0x6666666666666666666666666666666666666666" as `0x${string}`;
const VENUE = "0x7777777777777777777777777777777777777777" as `0x${string}`;
const FEE = 500_000_000_000_000_000n; // €0.50
const CONVERT = 11_845_000_000_000_000_000n; // AMOUNT - FEE, still exact
const SWAP_DATA = "0xdeadbeef01" as `0x${string}`;

const batch = transferSwapBatchTransactions({
  token: TOKEN,
  feeTo: FEE_TO,
  feeAmount: FEE,
  approval: { spender: SPENDER, amount: CONVERT },
  call: { to: VENUE, data: SWAP_DATA, value: 0n },
});

check("batch is fee transfer, venue approval, swap call — in that order", () => {
  assert.equal(batch.length, 3);
  assert.equal(decode(batch[0].data).functionName, "transfer");
  assert.equal(decode(batch[1].data).functionName, "approve");
  assert.equal(batch[2].to.toLowerCase(), VENUE.toLowerCase());
  assert.equal(batch[2].data, SWAP_DATA);
});

check("the fee moves to the named collector, exactly", () => {
  const { args } = decode(batch[0].data);
  assert.equal(String(args![0]).toLowerCase(), FEE_TO.toLowerCase());
  assert.equal(args![1], FEE);
});

check("the approval names the venue's spender for exactly the convert amount", () => {
  assert.equal(batch[1].to.toLowerCase(), TOKEN.toLowerCase());
  const { args } = decode(batch[1].data);
  assert.equal(String(args![0]).toLowerCase(), SPENDER.toLowerCase());
  assert.equal(args![1], CONVERT);
});

check("an allowance revoke is prepended to the batch", () => {
  const revoking = transferSwapBatchTransactions({
    token: TOKEN,
    feeTo: FEE_TO,
    feeAmount: FEE,
    approval: { spender: SPENDER, amount: CONVERT },
    call: { to: VENUE, data: SWAP_DATA, value: 0n },
    revokeLegacyAllowance: { delegate: DELEGATE, moduleAddress: MODULE },
  });
  assert.equal(revoking.length, 4);
  assert.equal(decode(revoking[0].data).functionName, "deleteAllowance");
  assert.equal(revoking[0].to.toLowerCase(), MODULE.toLowerCase());
});

check("a zero fee drops the fee leg but keeps approval and swap", () => {
  const noFee = transferSwapBatchTransactions({
    token: TOKEN,
    feeTo: FEE_TO,
    feeAmount: 0n,
    approval: { spender: SPENDER, amount: CONVERT },
    call: { to: VENUE, data: SWAP_DATA, value: 0n },
  });
  assert.equal(noFee.length, 2);
  assert.equal(decode(noFee[0].data).functionName, "approve");
});

check("a zero convert amount refuses; a negative fee refuses", () => {
  assert.throws(
    () =>
      transferSwapBatchTransactions({
        token: TOKEN,
        feeTo: FEE_TO,
        feeAmount: FEE,
        approval: { spender: SPENDER, amount: 0n },
        call: { to: VENUE, data: SWAP_DATA, value: 0n },
      }),
    /positive convert amount/,
  );
  assert.throws(
    () =>
      transferSwapBatchTransactions({
        token: TOKEN,
        feeTo: FEE_TO,
        feeAmount: -1n,
        approval: { spender: SPENDER, amount: CONVERT },
        call: { to: VENUE, data: SWAP_DATA, value: 0n },
      }),
    /negative fee/,
  );
});

console.log(`\nsafe-execution-test: ${checks}/13 checks passed`);
