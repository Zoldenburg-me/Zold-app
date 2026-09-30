/**
 * Bringing an existing Safe into Zold: the checks a Safe must pass before an
 * account may be bound to it, and the owner change its current owner sends to
 * make the user's passkey an owner.
 *
 * The passkey signs through its own WebAuthn verifier contract (the address
 * `SafeAccount.createWebAuthnSignerVerifierAddress` derives), exactly as on a
 * Safe Zold deployed itself once its first operation has swapped the shared
 * signer out. So an imported Safe is addressed like a recovered one (the
 * address does not derive from the owner) and signed for like any deployed one.
 *
 * Pure apart from the reader passed in: the route and the EOA script
 * (scripts/safe-import-owner-tx.ts) share it, and the test feeds it canned
 * chain answers. Nothing here holds or asks for a key.
 */
import { SafeMultiChainSigAccountV1 as SafeAccount, type MetaTransaction } from "abstractionkit";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, toHex } from "viem";

type Hex = `0x${string}`;

/** Safe L2 v1.4.1, the singleton SafeMultiChainSigAccountV1 deploys. */
export const SAFE_L2_V141_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Hex;
/** The ERC-4337 module SafeMultiChainSigAccountV1 installs as module AND fallback handler. */
export const SAFE_4337_MODULE = SafeAccount.DEFAULT_SAFE_4337_MODULE_ADDRESS as Hex;
/** keccak256("fallback_manager.handler.address") — Safe's FallbackManager slot. */
export const FALLBACK_HANDLER_SLOT = keccak256(toHex("fallback_manager.handler.address"));
/** keccak256("guard_manager.guard.address") — Safe's GuardManager slot. */
export const GUARD_SLOT = keccak256(toHex("guard_manager.guard.address"));
const SENTINEL = "0x0000000000000000000000000000000000000001" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const MODULE_PAGE = 10n;

const SAFE_ABI = [
  { type: "function", name: "getOwners", inputs: [], outputs: [{ type: "address[]" }], stateMutability: "view" },
  { type: "function", name: "getThreshold", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "getModulesPaginated",
    inputs: [{ name: "start", type: "address" }, { name: "pageSize", type: "uint256" }],
    outputs: [{ name: "array", type: "address[]" }, { name: "next", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "addOwnerWithThreshold",
    inputs: [{ name: "owner", type: "address" }, { name: "_threshold", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "swapOwner",
    inputs: [{ name: "prevOwner", type: "address" }, { name: "oldOwner", type: "address" }, { name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execTransaction",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "payable",
  },
] as const;

/** The chain reads the checks need. Any failure must throw: a failed read is
 *  never an answer. */
export interface ChainReader {
  getCode(address: Hex): Promise<Hex>;
  getBalance(address: Hex): Promise<bigint>;
  getStorageAt(address: Hex, slot: Hex): Promise<Hex>;
  call(to: Hex, data: Hex): Promise<Hex>;
}

export function jsonRpcReader(url: string, signal?: () => AbortSignal): ChainReader {
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<Hex> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      ...(signal ? { signal: signal() } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error || typeof body.result !== "string") {
      throw new Error(`${method} failed (${res.status}): ${JSON.stringify(body?.error ?? body ?? "").slice(0, 160)}`);
    }
    return body.result as Hex;
  };
  return {
    getCode: (address) => rpc("eth_getCode", [address, "latest"]),
    getBalance: async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"])),
    getStorageAt: (address, slot) => rpc("eth_getStorageAt", [address, slot, "latest"]),
    call: (to, data) => rpc("eth_call", [{ to, data }, "latest"]),
  };
}

export type SafeImportRefusalCode =
  | "NO_CODE"
  | "WRONG_SINGLETON"
  | "THRESHOLD_NOT_ONE"
  | "VERIFIER_NOT_OWNER"
  | "TOO_MANY_OWNERS"
  | "MODULE_4337_DISABLED"
  | "EXTRA_MODULES"
  | "WRONG_FALLBACK_HANDLER"
  | "GUARD_SET"
  | "VERIFIER_NO_CODE";

export class SafeImportRefusal extends Error {
  readonly status = 409;
  constructor(readonly code: SafeImportRefusalCode, message: string) {
    super(message);
    this.name = "SafeImportRefusal";
  }
}

export interface SafeImportState {
  address: Hex;
  singleton: Hex;
  owners: Hex[];
  threshold: number;
  /** Every enabled module, when the list fit one page; `modulesComplete` false otherwise. */
  modules: Hex[];
  modulesComplete: boolean;
  fallbackHandler: Hex;
  guard: Hex;
}

const slotAddress = (word: Hex): Hex => getAddress(`0x${word.replace(/^0x/, "").padStart(64, "0").slice(-40)}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Read everything the import checks look at. Throws NO_CODE for an address
 *  with no contract, and passes any RPC failure through. */
export async function readSafeForImport(reader: ChainReader, address: Hex): Promise<SafeImportState> {
  const code = await reader.getCode(address);
  if (!code || code === "0x") throw new SafeImportRefusal("NO_CODE", `${address} has no contract code on this chain`);
  const [singletonWord, fallbackWord, guardWord, ownersRaw, thresholdRaw, modulesRaw] = await Promise.all([
    reader.getStorageAt(address, toHex(0, { size: 32 })),
    reader.getStorageAt(address, FALLBACK_HANDLER_SLOT),
    reader.getStorageAt(address, GUARD_SLOT),
    reader.call(address, encodeFunctionData({ abi: SAFE_ABI, functionName: "getOwners" })),
    reader.call(address, encodeFunctionData({ abi: SAFE_ABI, functionName: "getThreshold" })),
    reader.call(address, encodeFunctionData({ abi: SAFE_ABI, functionName: "getModulesPaginated", args: [SENTINEL, MODULE_PAGE] })),
  ]);
  const owners = (decodeFunctionResult({ abi: SAFE_ABI, functionName: "getOwners", data: ownersRaw }) as readonly Hex[]).map((o) => getAddress(o));
  const threshold = Number(decodeFunctionResult({ abi: SAFE_ABI, functionName: "getThreshold", data: thresholdRaw }));
  const [modules, next] = decodeFunctionResult({ abi: SAFE_ABI, functionName: "getModulesPaginated", data: modulesRaw }) as readonly [readonly Hex[], Hex];
  return {
    address: getAddress(address),
    singleton: slotAddress(singletonWord),
    owners,
    threshold,
    modules: modules.map((m) => getAddress(m)),
    modulesComplete: same(next, SENTINEL),
    fallbackHandler: slotAddress(fallbackWord),
    guard: slotAddress(guardWord),
  };
}

/**
 * The shape a Safe must have for Zold's signing path to work on it, apart
 * from who owns it: the singleton and 4337 wiring SafeMultiChainSigAccountV1
 * builds UserOperations for, no module that could move funds past the
 * passkey, and no guard that could refuse what the passkey signed.
 */
export function assertImportableShape(s: SafeImportState): void {
  if (!same(s.singleton, SAFE_L2_V141_SINGLETON)) {
    throw new SafeImportRefusal("WRONG_SINGLETON", `the Safe's singleton is ${s.singleton}; only Safe L2 v1.4.1 (${SAFE_L2_V141_SINGLETON}) is supported`);
  }
  if (!s.modules.some((m) => same(m, SAFE_4337_MODULE))) {
    throw new SafeImportRefusal("MODULE_4337_DISABLED", `the ERC-4337 module ${SAFE_4337_MODULE} is not enabled on this Safe`);
  }
  const others = s.modules.filter((m) => !same(m, SAFE_4337_MODULE));
  if (others.length || !s.modulesComplete) {
    throw new SafeImportRefusal("EXTRA_MODULES",
      `the Safe has other modules enabled (${others.join(", ") || "more than one page"}); disable them before importing — a module can move funds without the passkey`);
  }
  if (!same(s.fallbackHandler, SAFE_4337_MODULE)) {
    throw new SafeImportRefusal("WRONG_FALLBACK_HANDLER", `the fallback handler is ${s.fallbackHandler}, not the ERC-4337 module ${SAFE_4337_MODULE}`);
  }
  if (!same(s.guard, ZERO)) {
    throw new SafeImportRefusal("GUARD_SET", `a transaction guard (${s.guard}) is set; remove it before importing`);
  }
}

/** Threshold 1, the verifier an owner, at most one other owner. */
export function assertImportableOwners(s: SafeImportState, verifier: Hex): void {
  if (s.threshold !== 1) {
    throw new SafeImportRefusal("THRESHOLD_NOT_ONE", `the Safe's threshold is ${s.threshold}; Zold collects only the passkey's signature, so it must be 1`);
  }
  if (!s.owners.some((o) => same(o, verifier))) {
    throw new SafeImportRefusal("VERIFIER_NOT_OWNER", `the passkey's verifier ${verifier} is not an owner of this Safe yet — send the owner change first`);
  }
  if (s.owners.length > 2) {
    throw new SafeImportRefusal("TOO_MANY_OWNERS", `the Safe has ${s.owners.length} owners; Zold allows the passkey plus at most one of your own`);
  }
}

/**
 * Every check the confirm step runs, in order. Returns the chain state when
 * the Safe may be bound to this passkey; throws a SafeImportRefusal naming
 * the first failed check, or the reader's own error.
 */
export async function checkSafeForImport(reader: ChainReader, address: Hex, verifier: Hex): Promise<SafeImportState> {
  const state = await readSafeForImport(reader, address);
  assertImportableShape(state);
  assertImportableOwners(state, verifier);
  const code = await reader.getCode(verifier);
  if (!code || code === "0x") {
    throw new SafeImportRefusal("VERIFIER_NO_CODE", `the passkey's verifier ${verifier} has no code yet`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// the owner change the Safe's current owner sends

export type OwnerChangeMode = "add" | "swap";

export function passkeyVerifierAddress(x: bigint, y: bigint): Hex {
  return getAddress(SafeAccount.createWebAuthnSignerVerifierAddress(x, y)) as Hex;
}

/** Deploys the verifier through the public factory. Anyone may send it. */
export function verifierDeploymentTransaction(x: bigint, y: bigint): MetaTransaction {
  return SafeAccount.createDeployWebAuthnVerifierMetaTransaction(x, y);
}

/**
 * The self-call that makes the verifier an owner.
 *
 * - `add`: addOwnerWithThreshold(verifier, 1). The current owner stays as the
 *   user's own backup owner (1 of 2).
 * - `swap`: swapOwner(prev, owner, verifier). The named owner is removed.
 *
 * Refuses anything that would leave more than two owners or a threshold other
 * than 1 — the rules routes/safe-signers.ts holds a live Safe to.
 */
export function ownerChangeTransaction(args: {
  safe: Hex;
  owners: Hex[];
  threshold: number;
  verifier: Hex;
  mode: OwnerChangeMode;
  /** For `swap`: the owner to replace. Defaults to the only owner. */
  replace?: Hex;
}): MetaTransaction & { resultOwners: Hex[] } {
  const { safe, owners, threshold, verifier, mode } = args;
  if (owners.some((o) => same(o, verifier))) {
    throw new SafeImportRefusal("TOO_MANY_OWNERS", `${verifier} is already an owner of ${safe}; nothing to change`);
  }
  if (threshold !== 1) {
    throw new SafeImportRefusal("THRESHOLD_NOT_ONE", `the Safe's threshold is ${threshold}; lower it to 1 first (Zold collects only the passkey's signature)`);
  }
  if (mode === "add") {
    const resultOwners = [verifier, ...owners];
    if (resultOwners.length > 2) {
      throw new SafeImportRefusal("TOO_MANY_OWNERS", `adding the passkey would leave ${resultOwners.length} owners; Zold allows at most 2 — use swap`);
    }
    return {
      to: safe,
      value: 0n,
      data: encodeFunctionData({ abi: SAFE_ABI, functionName: "addOwnerWithThreshold", args: [verifier, 1n] }),
      resultOwners,
    };
  }
  let old = args.replace;
  if (!old) {
    if (owners.length !== 1) throw new Error(`the Safe has ${owners.length} owners; name the one to replace`);
    old = owners[0];
  }
  const i = owners.findIndex((o) => same(o, old!));
  if (i < 0) throw new Error(`${old} is not an owner of ${safe}`);
  const prev = i === 0 ? SENTINEL : owners[i - 1];
  const resultOwners = owners.map((o, j) => (j === i ? verifier : o));
  if (resultOwners.length > 2) {
    throw new SafeImportRefusal("TOO_MANY_OWNERS", `the Safe would keep ${resultOwners.length} owners; Zold allows at most 2`);
  }
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: "swapOwner", args: [prev, owners[i], verifier] }),
    resultOwners,
  };
}

/**
 * execTransaction for a 1-of-n Safe, sent BY the owner itself: Safe accepts a
 * "pre-validated" signature (r = owner, s = 0, v = 1) when msg.sender is that
 * owner, so no off-chain signature is needed. This is the raw transaction a
 * hardware wallet can sign and send without Safe{Wallet}.
 */
export function execTransactionByOwner(safe: Hex, owner: Hex, tx: MetaTransaction): { to: Hex; value: bigint; data: Hex } {
  const signature = `0x${owner.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01` as Hex;
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [tx.to as Hex, tx.value, tx.data as Hex, 0, 0n, 0n, 0n, ZERO, ZERO, signature],
    }),
  };
}
