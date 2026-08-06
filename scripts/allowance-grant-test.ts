/**
 * Per-transfer one-time allowance grant — the meta-transaction batch a user's
 * passkey approves at send time, replacing the standing co-signer allowance.
 *
 * These checks pin the two properties the whole model rests on:
 *  - EXACTNESS: the grant is for this transfer's precise amount, one-time
 *    (resetTimeMin=0), to the configured delegate and token — nothing more is
 *    ever spendable.
 *  - CLEAN SLATE: deleteAllowance precedes setAllowance in every grant. The
 *    module's `spent` counter survives setAllowance, so without the delete a
 *    second transfer's grant of N on top of spent=M leaves remaining N-M and
 *    the debit refuses for no visible reason.
 *
 * No chain, no bundler: the builder is pure. The bundler/paymaster wrapper and
 * the authorize-route flow are exercised against Base Sepolia, not here.
 */
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import {
  CANDIDE,
  transferAllowanceGrantTransactions,
} from "../services/api/src/wallet/candide.js";

const SAFE = "0x00000000000000000000000000000000000a11ce" as `0x${string}`;
const DELEGATE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const TOKEN = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const MODULE = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const AMOUNT = 12_345_000_000_000_000_000n; // €12.345 in wei — deliberately not round

const SET_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "setAllowance",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
      { name: "allowanceAmount", type: "uint96" },
      { name: "resetTimeMin", type: "uint16" },
      { name: "resetBaseMin", type: "uint32" },
    ],
    outputs: [],
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
  {
    type: "function",
    name: "addDelegate",
    inputs: [{ name: "delegate", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const decode = (data: string) =>
  decodeFunctionData({ abi: SET_ALLOWANCE_ABI, data: data as `0x${string}` });

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
};

// ---- module already enabled: delegate + delete + set, all to the module ----
const grant = transferAllowanceGrantTransactions({ address: SAFE }, DELEGATE, TOKEN, AMOUNT, {
  moduleAddress: MODULE,
  moduleEnabled: true,
});

check("enabled module: exactly addDelegate, deleteAllowance, setAllowance", () => {
  assert.equal(grant.length, 3);
  assert.deepEqual(
    grant.map((t) => decode(t.data).functionName),
    ["addDelegate", "deleteAllowance", "setAllowance"],
  );
});

check("every grant call targets the allowance module, none the Safe", () => {
  for (const t of grant) assert.equal(t.to.toLowerCase(), MODULE.toLowerCase());
});

check("deleteAllowance wipes this delegate+token before the new grant", () => {
  const { args } = decode(grant[1].data);
  assert.equal(String(args![0]).toLowerCase(), DELEGATE.toLowerCase());
  assert.equal(String(args![1]).toLowerCase(), TOKEN.toLowerCase());
});

check("setAllowance grants the EXACT amount, one-time (resetTimeMin=0)", () => {
  const { args } = decode(grant[2].data);
  assert.equal(String(args![0]).toLowerCase(), DELEGATE.toLowerCase());
  assert.equal(String(args![1]).toLowerCase(), TOKEN.toLowerCase());
  assert.equal(args![2], AMOUNT);
  assert.equal(args![3], 0, "resetTimeMin must be 0 — recurring would be standing authority");
});

// ---- module missing: enableModule rides along, targeting the Safe ----
check("missing module: enableModule is prepended and targets the Safe", () => {
  const healing = transferAllowanceGrantTransactions({ address: SAFE }, DELEGATE, TOKEN, AMOUNT, {
    moduleAddress: MODULE,
    moduleEnabled: false,
  });
  assert.equal(healing.length, 4);
  assert.equal(healing[0].to.toLowerCase(), SAFE.toLowerCase());
  assert.deepEqual(
    healing.slice(1).map((t) => decode(t.data).functionName),
    ["addDelegate", "deleteAllowance", "setAllowance"],
  );
});

check("module address defaults to the configured CANDIDE module", () => {
  const defaulted = transferAllowanceGrantTransactions({ address: SAFE }, DELEGATE, TOKEN, AMOUNT, {
    moduleEnabled: true,
  });
  assert.equal(defaulted[0].to.toLowerCase(), CANDIDE.allowanceModuleAddress.toLowerCase());
});

// ---- refusals ----
check("a zero grant refuses — an empty grant must never look installed", () => {
  assert.throws(
    () =>
      transferAllowanceGrantTransactions({ address: SAFE }, DELEGATE, TOKEN, 0n, {
        moduleEnabled: true,
      }),
    /positive amount/,
  );
});

check("a negative grant refuses", () => {
  assert.throws(
    () =>
      transferAllowanceGrantTransactions({ address: SAFE }, DELEGATE, TOKEN, -1n, {
        moduleEnabled: true,
      }),
    /positive amount/,
  );
});

console.log(`\nallowance-grant-test: ${checks}/8 checks passed`);
