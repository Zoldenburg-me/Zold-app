/**
 * Advanced security (wallet/safe-signers.ts, routes/safe-signers.ts): the
 * owner and Allowance-module operations the passkey signs, and the refusals
 * that keep a user from locking Zold out with no way back. Offline.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import {
  ALLOWANCE_MODULE_ADDRESS,
  addOwnerTransaction,
  changeThresholdTransaction,
  removeDelegateTransaction,
  removeOwnerTransaction,
  spendingLimitTransactions,
} from "../services/api/src/wallet/safe-signers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE = getAddress("0x5afe000000000000000000000000000000000001");
const PASSKEY = getAddress("0xaaaa000000000000000000000000000000000001");
const HW = getAddress("0xbbbb000000000000000000000000000000000002");
const EURE = getAddress("0xe0e0000000000000000000000000000000000003");
const abi = parseAbi([
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function changeThreshold(uint256 _threshold)",
  "function enableModule(address module)",
  "function addDelegate(address delegate)",
  "function removeDelegate(address delegate, bool removeAllowances)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
]);
const decode = (data: string) => decodeFunctionData({ abi, data: data as `0x${string}` });

// ---- owners: self-calls on the Safe, threshold unchanged -------------------
{
  const tx = addOwnerTransaction(SAFE, HW, 1);
  assert.equal(tx.to, SAFE, "addOwner must be a call on the Safe itself");
  assert.equal(tx.value, 0n);
  const d = decode(tx.data);
  assert.equal(d.functionName, "addOwnerWithThreshold");
  assert.deepEqual(d.args, [HW, 1n], "adding the second owner keeps the threshold at 1");
}
{
  // Safe's owner list is linked: the head's predecessor is the sentinel.
  const head = decode(removeOwnerTransaction(SAFE, [HW, PASSKEY], HW, 1).data);
  assert.deepEqual(head.args, ["0x0000000000000000000000000000000000000001", HW, 1n]);
  const tail = decode(removeOwnerTransaction(SAFE, [PASSKEY, HW], HW, 1).data);
  assert.deepEqual(tail.args, [PASSKEY, HW, 1n]);
  assert.throws(() => removeOwnerTransaction(SAFE, [PASSKEY], HW, 1), /not an owner/);
}
{
  const d = decode(changeThresholdTransaction(SAFE, 2).data);
  assert.deepEqual([d.functionName, d.args], ["changeThreshold", [2n]]);
}

// ---- spending limits: enable + delegate only when missing ------------------
{
  const fresh = spendingLimitTransactions({
    safeAddress: SAFE, moduleEnabled: false, delegateKnown: false, delegate: HW, token: EURE, amount: 100n * 10n ** 18n, resetMinutes: 1440,
  });
  assert.equal(fresh.length, 3, "a first limit enables the module, adds the delegate, sets the allowance");
  assert.equal(fresh[0].to.toLowerCase(), SAFE.toLowerCase());
  assert.deepEqual(decode(fresh[0].data).args, [ALLOWANCE_MODULE_ADDRESS]);
  assert.equal(fresh[1].to.toLowerCase(), ALLOWANCE_MODULE_ADDRESS.toLowerCase());
  assert.equal(decode(fresh[1].data).functionName, "addDelegate");
  const set = decode(fresh[2].data);
  assert.equal(set.functionName, "setAllowance");
  assert.deepEqual(set.args, [HW, EURE, 100n * 10n ** 18n, 1440, 0], "resetBaseMin 0 means 'from now'");

  const again = spendingLimitTransactions({
    safeAddress: SAFE, moduleEnabled: true, delegateKnown: true, delegate: HW, token: EURE, amount: 5n, resetMinutes: 0,
  });
  assert.equal(again.length, 1, "an existing delegate on an enabled module needs only setAllowance");
  assert.deepEqual(decode(again[0].data).args, [HW, EURE, 5n, 0, 0], "resetTimeMin 0 is a one-time limit");

  const rm = decode(removeDelegateTransaction(HW).data);
  assert.deepEqual([rm.functionName, rm.args], ["removeDelegate", [HW, true]], "removing a delegate removes its allowances");
}
// Safe's official v0.1.1 deployment, the one Safe{Wallet} reads on Base.
assert.equal(ALLOWANCE_MODULE_ADDRESS, "0xAA46724893dedD72658219405185Fb0Fc91e091C");

// ---- source guards: the refusals that matter ------------------------------
const routes = readFileSync(path.join(ROOT, "services/api/src/routes/safe-signers.ts"), "utf8");
assert.match(routes, /guardians\.length === 0[\s\S]{0,200}NO_GUARDIAN/, "raising the threshold needs a guardian on chain");
assert.match(routes, /threshold < 2[\s\S]{0,200}only raising/, "no route lowers the threshold (Zold could not sign it)");
assert.match(routes, /owners\.length >= 2[\s\S]{0,200}HAS_SECOND_OWNER/, "one extra owner at most through Zold");
assert.match(routes, /acknowledged !== true/, "adding an owner needs the warnings acknowledged");
const wallet = readFileSync(path.join(ROOT, "services/api/src/wallet/safe-signers.ts"), "utf8");
assert.ok(!wallet.includes("createAllowanceTransferMetaTransaction"), "Zold never spends through an allowance");
const candide = readFileSync(path.join(ROOT, "services/api/src/wallet/candide.ts"), "utf8");
assert.equal((candide.match(/await assertPasskeyAloneCanSign\(/g) ?? []).length, 2,
  "both the transfer and the setup path refuse a Safe the passkey alone cannot sign for");

console.log("safe-signers: ok");
