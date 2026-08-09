/**
 * User-signed Safe execution — the meta-transactions of one transfer's debit,
 * signed by the user's passkey as a UserOperation. This replaced the co-signer
 * allowance entirely: there is no delegate and no standing spend authority,
 * so the property under test is that the batch contains EXACTLY the movement
 * the user approves — token, destination and amount chain-enforced — plus, at
 * most, the revocation of a legacy standing allowance.
 *
 * No chain, no bundler: the builder is pure. The bundler/paymaster wrapper and
 * the authorize-route flow are exercised against Base Sepolia, not here.
 */
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import {
  CANDIDE,
  transferExecutionTransactions,
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

// ---- legacy cleanup: a standing allowance is revoked in the same operation ----
check("a legacy standing allowance is revoked BEFORE the transfer", () => {
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

console.log(`\nsafe-execution-test: ${checks}/7 checks passed`);
