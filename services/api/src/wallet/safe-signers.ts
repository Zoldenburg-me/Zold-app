/**
 * Advanced Safe settings the account holder controls themselves: a second
 * owner they hold (a hardware wallet), the signature threshold, and spending
 * limits through Safe's Allowance module.
 *
 * Everything here is read FROM THE CHAIN and changed only by an operation the
 * passkey signs. Zold holds no owner key and never becomes a delegate: the
 * second owner is the user's, and an allowance is spent by its delegate on
 * app.safe.global (Safe{Wallet} → Spending limits), never through Zold.
 *
 * What Zold cannot do, stated here because the UI repeats it:
 * - It cannot collect the second owner's signature. At threshold 2 every
 *   operation Zold builds is refused (SafeThresholdError in candide.ts), and
 *   the Safe needs a signature the passkey cannot give on app.safe.global
 *   either: the passkey's RP ID is Zold's domain. Only a guardian recovery
 *   resets it, which is why raising the threshold needs a guardian on chain.
 * - Recovery replaces the WHOLE owner set. Candide's SocialRecoveryModule
 *   finalizeRecovery removes every current owner and installs the recovery's
 *   newOwners at its newThreshold; Zold's recoveries name only the new passkey
 *   at threshold 1. A second owner does not survive a recovery.
 * - Recovery does not touch other modules. Allowance delegates and their
 *   limits outlive it and must be removed separately.
 */
import { AllowanceModule, type MetaTransaction } from "abstractionkit";
import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { candideRpc, ethCall, passkeyAccountAddress, safeOwners, safeThreshold, webauthnOwnerFromStore, isDeployed } from "./candide.js";

/** Safe's official AllowanceModule v0.1.1 (safe-modules-deployments), the one
 *  Safe{Wallet} reads for Spending limits on Base. abstractionkit labels this
 *  address v0.1.0 and defaults to another deployment; we name it explicitly.
 *  Code verified on Base (8453) and Base Sepolia (84532), Sep 2026. */
export const ALLOWANCE_MODULE_ADDRESS = (process.env.SAFE_ALLOWANCE_MODULE_ADDRESS ??
  "0xAA46724893dedD72658219405185Fb0Fc91e091C") as `0x${string}`;

const SENTINEL_OWNERS = "0x0000000000000000000000000000000000000001" as const;

const SAFE_OWNER_ABI = [
  {
    type: "function",
    name: "addOwnerWithThreshold",
    inputs: [{ name: "owner", type: "address" }, { name: "_threshold", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "removeOwner",
    inputs: [{ name: "prevOwner", type: "address" }, { name: "owner", type: "address" }, { name: "_threshold", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "changeThreshold",
    inputs: [{ name: "_threshold", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isModuleEnabled",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface SpendingLimit {
  delegate: `0x${string}`;
  token: `0x${string}`;
  /** Base units. */
  amount: string;
  spent: string;
  /** 0 = one-time; otherwise the limit refills every this many minutes. */
  resetTimeMin: number;
  lastResetMin: number;
}

export interface SafeSignerState {
  safeAddress: `0x${string}`;
  owners: { address: `0x${string}`; kind: "passkey" | "other" }[];
  threshold: number;
  passkeyAddress: `0x${string}`;
  allowance: { moduleAddress: `0x${string}`; moduleDeployed: boolean; enabled: boolean; limits: SpendingLimit[] };
}

export function passkeyOwnerAddress(passkeyPublicKey: { x: string; y: string }): `0x${string}` {
  return getAddress(passkeyAccountAddress(webauthnOwnerFromStore(passkeyPublicKey)));
}

export async function allowanceModuleEnabled(safeAddress: string): Promise<boolean> {
  const raw = await ethCall(
    safeAddress,
    encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "isModuleEnabled", args: [ALLOWANCE_MODULE_ADDRESS] }),
  );
  return decodeFunctionResult({ abi: SAFE_OWNER_ABI, functionName: "isModuleEnabled", data: raw }) as boolean;
}

/** Owners, threshold and every spending limit, as the chain holds them now. */
export async function readSafeSignerState(
  safeAddress: `0x${string}`,
  passkeyPublicKey: { x: string; y: string },
): Promise<SafeSignerState> {
  const passkeyAddress = passkeyOwnerAddress(passkeyPublicKey);
  const [owners, threshold, moduleDeployed] = await Promise.all([
    safeOwners(safeAddress),
    safeThreshold(safeAddress),
    isDeployed(ALLOWANCE_MODULE_ADDRESS),
  ]);
  const enabled = moduleDeployed ? await allowanceModuleEnabled(safeAddress) : false;
  const limits: SpendingLimit[] = [];
  if (enabled) {
    const am = new AllowanceModule(ALLOWANCE_MODULE_ADDRESS);
    const delegates = await am.getDelegates(candideRpc(), safeAddress);
    for (const delegate of delegates) {
      const tokens = await am.getTokens(candideRpc(), safeAddress, delegate);
      for (const token of tokens) {
        const a = await am.getTokensAllowance(candideRpc(), safeAddress, delegate, token);
        limits.push({
          delegate: getAddress(delegate),
          token: getAddress(token),
          amount: a.amount.toString(),
          spent: a.spent.toString(),
          resetTimeMin: Number(a.resetTimeMin),
          lastResetMin: Number(a.lastResetMin),
        });
      }
      // A delegate with no token allowance is still listed: it can be given one
      // on app.safe.global, and removing it is the user's call.
      if (!tokens.length) {
        limits.push({ delegate: getAddress(delegate), token: "0x0000000000000000000000000000000000000000", amount: "0", spent: "0", resetTimeMin: 0, lastResetMin: 0 });
      }
    }
  }
  return {
    safeAddress,
    owners: owners.map((o) => ({
      address: getAddress(o),
      kind: o.toLowerCase() === passkeyAddress.toLowerCase() ? "passkey" : "other",
    })),
    threshold,
    passkeyAddress,
    allowance: { moduleAddress: ALLOWANCE_MODULE_ADDRESS, moduleDeployed, enabled, limits },
  };
}

// ---------------------------------------------------------------------------
// the operations — each a self-call the passkey signs as a UserOperation

/** Add an owner and keep the threshold where it is. */
export function addOwnerTransaction(safeAddress: `0x${string}`, owner: `0x${string}`, threshold: number): MetaTransaction {
  return {
    to: safeAddress,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "addOwnerWithThreshold", args: [owner, BigInt(threshold)] }),
  };
}

/** Remove an owner. Safe's owner list is linked, so the previous entry is named. */
export function removeOwnerTransaction(
  safeAddress: `0x${string}`,
  owners: `0x${string}`[],
  owner: `0x${string}`,
  threshold: number,
): MetaTransaction {
  const i = owners.findIndex((o) => o.toLowerCase() === owner.toLowerCase());
  if (i < 0) throw new Error(`${owner} is not an owner of ${safeAddress}`);
  const prevOwner = i === 0 ? SENTINEL_OWNERS : owners[i - 1];
  return {
    to: safeAddress,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "removeOwner", args: [prevOwner, owner, BigInt(threshold)] }),
  };
}

export function changeThresholdTransaction(safeAddress: `0x${string}`, threshold: number): MetaTransaction {
  return {
    to: safeAddress,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "changeThreshold", args: [BigInt(threshold)] }),
  };
}

/**
 * Give `delegate` a limit on `token`: enable the module and add the delegate
 * if needed, then set the allowance. `resetMinutes` 0 is a one-time limit.
 * Setting an allowance that exists replaces its amount and period.
 */
export function spendingLimitTransactions(args: {
  safeAddress: `0x${string}`;
  moduleEnabled: boolean;
  delegateKnown: boolean;
  delegate: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  resetMinutes: number;
}): MetaTransaction[] {
  const am = new AllowanceModule(ALLOWANCE_MODULE_ADDRESS);
  return [
    ...(args.moduleEnabled ? [] : [am.createEnableModuleMetaTransaction(args.safeAddress)]),
    ...(args.delegateKnown ? [] : [am.createAddDelegateMetaTransaction(args.delegate)]),
    args.resetMinutes > 0
      ? am.createRecurringAllowanceMetaTransaction(args.delegate, args.token, args.amount, BigInt(args.resetMinutes), 0n)
      : am.createOneTimeAllowanceMetaTransaction(args.delegate, args.token, args.amount, 0n),
  ];
}

/** Remove a delegate and every allowance it holds. */
export function removeDelegateTransaction(delegate: `0x${string}`): MetaTransaction {
  return new AllowanceModule(ALLOWANCE_MODULE_ADDRESS).createRemoveDelegateMetaTransaction(delegate, true);
}

