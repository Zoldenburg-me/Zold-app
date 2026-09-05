/**
 * Candide smart wallets (AbstractionKit, Safe-based ERC-4337 accounts).
 *
 * Every user gets a Safe smart account whose address is computed offline and
 * deterministically from their owner key — the same address on every EVM
 * chain. That address is the user's identity and token balance account, and
 * the address Monerium links the IBAN to.
 *
 * For Monerium to verify ownership of a contract wallet it calls EIP-1271 on
 * the address, so the Safe must actually be deployed on the chain Monerium
 * checks (Sepolia in sandbox). Deployment is gasless via Candide's public
 * bundler + paymaster and is centralized in the passkey Safe deployment route.
 */
import {
  AllowanceModule,
  SafeMultiChainSigAccountV1 as SafeAccount,
  Erc7677Paymaster,
  SocialRecoveryModule,
  SocialRecoveryModuleGracePeriodSelector,
  fromPrivateKey,
  fromSafeWebauthn,
  getSafeMessageEip712Data,
  webauthnSignatureFromAssertion,
  type MetaTransaction,
  type SignerSignaturePair,
  type UserOperationV9,
  type WebauthnPublicKey,
} from "abstractionkit";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionResult, encodeFunctionData, hashTypedData } from "viem";

/**
 * The only shortcuts left are the HARNESS ones (config.ts): fake challenges
 * and a fake UserOperation hash on the hardhat chain, where no bundler
 * exists. Do not add a looser gate here: one keyed on NODE_ENV alone is TRUE
 * on the hosted testnet and would report PAID while no money had left the
 * user's Safe. HARNESS.enabled cannot be true on any chain where money is
 * real.
 */
import { HARNESS } from "../config.js";
const allowSimulation = () => HARNESS.enabled;

const COSIGNER_ENABLED =
  process.env.CANDIDE_COSIGNER_ENABLED === "1" ||
  (process.env.CANDIDE_COSIGNER_ENABLED !== "0" &&
    Boolean(process.env.CANDIDE_COSIGNER_ADDRESS && process.env.CANDIDE_COSIGNER_KEY));

/** The smart-account chain follows the app chain unless told otherwise, and
 *  Candide's public endpoints are addressed by that id (their v3 bundler and
 *  paymaster answer for 8453 — checked with eth_supportedEntryPoints). */
const CANDIDE_CHAIN_ID = process.env.CANDIDE_CHAIN_ID ?? process.env.TRANSF_CHAIN_ID ?? "8453";
export const CANDIDE = {
  chainId: BigInt(CANDIDE_CHAIN_ID),
  bundlerUrl: process.env.CANDIDE_BUNDLER_URL ?? `https://api.candide.dev/public/v3/${CANDIDE_CHAIN_ID}`,
  paymasterUrl: process.env.CANDIDE_PAYMASTER_URL ?? `https://api.candide.dev/public/v3/${CANDIDE_CHAIN_ID}`,
  rpcUrl: process.env.CANDIDE_RPC_URL ?? process.env.TRANSF_RPC_URL ?? "https://mainnet.base.org",
  cosignerEnabled: COSIGNER_ENABLED,
  cosignerAddress: (process.env.CANDIDE_COSIGNER_ADDRESS ?? "") as `0x${string}` | "",
  cosignerKey: (process.env.CANDIDE_COSIGNER_KEY ?? "") as `0x${string}` | "",
  recoveryGuardianAddress: (process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS ?? "") as `0x${string}` | "",
  recoveryModuleAddress: (process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ??
    SocialRecoveryModuleGracePeriodSelector.After3Days) as `0x${string}`,
  /** Used ONLY to read and revoke standing allowances left on older Safes.
   *  Nothing installs an allowance — debits are user-signed UserOperations. */
  allowanceModuleAddress: (process.env.CANDIDE_ALLOWANCE_MODULE_ADDRESS ??
    (BigInt(CANDIDE_CHAIN_ID) === 84532n
      ? "0xAA46724893dedD72658219405185Fb0Fc91e091C"
      : AllowanceModule.DEFAULT_ALLOWANCE_MODULE_ADDRESS)) as `0x${string}`,
};

function b64urlToBigInt(value: string): bigint {
  const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return BigInt(`0x${buf.toString("hex")}`);
}

export function webauthnOwnerFromJwk(jwk: JsonWebKey): WebauthnPublicKey | null {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    return null;
  }
  return { x: b64urlToBigInt(jwk.x), y: b64urlToBigInt(jwk.y) };
}

export function webauthnOwnerToStore(owner: WebauthnPublicKey): { x: string; y: string } {
  return {
    x: `0x${owner.x.toString(16).padStart(64, "0")}`,
    y: `0x${owner.y.toString(16).padStart(64, "0")}`,
  };
}

export function webauthnOwnerFromStore(owner: { x: string; y: string }): WebauthnPublicKey {
  return { x: BigInt(owner.x), y: BigInt(owner.y) };
}

export function smartAccountForPasskeyCosigner(
  passkeyOwner: WebauthnPublicKey,
  cosignerAddress: `0x${string}`,
): SafeAccount {
  return SafeAccount.initializeNewAccount([passkeyOwner, cosignerAddress], { threshold: 2 });
}

export function smartAccountForPasskey(passkeyOwner: WebauthnPublicKey): SafeAccount {
  return SafeAccount.initializeNewAccount([passkeyOwner]);
}

export interface PasskeySafeDeploymentPlan {
  address: `0x${string}`;
  threshold: 1 | 2;
  cosignerAddress?: `0x${string}`;
  passkeyPublicKey: { x: string; y: string };
  cosignerPolicy?: {
    enabled: boolean;
    allowanceModuleAddress: `0x${string}`;
    allowancePeriodMinutes?: string;
    allowances?: {
      token: `0x${string}`;
      symbol: "EURE" | "USDC";
      amount: string;
    }[];
  };
  recovery?: {
    moduleAddress: `0x${string}`;
    guardianAddress: `0x${string}`;
    threshold: 1;
  };
  /** A recovered Safe: its address is fixed and no longer derives from the
   *  current owner set, so it is addressed rather than computed. */
  recoveredAt?: string;
}

export interface BrowserPasskeyAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export function passkeyAccountAddress(owner: WebauthnPublicKey): `0x${string}` {
  return SafeAccount.createWebAuthnSignerVerifierAddress(owner.x, owner.y) as `0x${string}`;
}

export function safeMessageHash(safeAddress: string, message: string): `0x${string}` {
  const { domain, types, messageValue } = getSafeMessageEip712Data(
    safeAddress as `0x${string}`,
    CANDIDE.chainId,
    message,
  );
  return hashTypedData({
    domain: domain as any,
    types: types as any,
    primaryType: "SafeMessage",
    message: messageValue as any,
  });
}

export async function preparePasskeySafeDeployment(plan: PasskeySafeDeploymentPlan): Promise<{
  safeAddress: `0x${string}`;
  challenge: `0x${string}`;
  userOperation: UserOperationV9;
}> {
  const { account, passkeyOwner } = accountForPlan(plan);
  if (allowSimulation()) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x1234567890123456789012345678901234567890123456789012345678901234",
      userOperation: {} as UserOperationV9,
    };
  }
  // Deployment installs recovery only. The allowance module is deliberately
  // NOT installed: nothing spends from the Safe except UserOperations the
  // user's own passkey signs, so there is no delegate to authorize and no
  // standing spend surface to bound.
  const setup = [...passkeySafeRecoverySetupTransactions(plan)];
  // enableModule on an address with no code "succeeds" and records a recovery
  // that does not exist; refuse before the user signs anything.
  if (setup.length && plan.recovery) await assertRecoveryModuleDeployed(plan.recovery.moduleAddress);
  const deployed = await isDeployed(account.accountAddress);
  if (deployed && !setup.length) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x",
      userOperation: {} as UserOperationV9,
    };
  }
  const noop: MetaTransaction = { to: account.accountAddress, value: 0n, data: "0x" };
  const userOperation = await account.createUserOperation(
    setup.length ? setup : [noop],
    CANDIDE.rpcUrl,
    CANDIDE.bundlerUrl,
    { expectedSigners: plan.cosignerAddress ? [passkeyOwner, plan.cosignerAddress] : [passkeyOwner] },
  );
  const paymaster = new Erc7677Paymaster(CANDIDE.paymasterUrl);
  const sponsored = await paymaster.createPaymasterUserOperation(
    account as any,
    userOperation as any,
    CANDIDE.bundlerUrl,
  );
  const finalOp: UserOperationV9 = ((sponsored as any).userOperation ?? sponsored) as UserOperationV9;
  return {
    safeAddress: account.accountAddress as `0x${string}`,
    challenge: account.getUserOperationEip712Hash(finalOp, CANDIDE.chainId) as `0x${string}`,
    userOperation: finalOp,
  };
}

export function passkeySafeRecoverySetupTransactions(plan: PasskeySafeDeploymentPlan): MetaTransaction[] {
  if (!plan.recovery) return [];
  const recovery = new SocialRecoveryModule(plan.recovery.moduleAddress);
  return [
    recovery.createEnableModuleMetaTransaction(plan.address),
    recovery.createAddGuardianWithThresholdMetaTransaction(
      plan.recovery.guardianAddress,
      BigInt(plan.recovery.threshold),
    ),
  ];
}

/**
 * The meta-transactions of one transfer's user-signed debit: the Safe itself
 * transfers the exact amount to the destination the terms name. No allowance,
 * no delegate — the movement IS the thing signed, so the chain enforces the
 * amount and destination rather than our process checking them.
 *
 * When the account still carries a standing allowance from an older
 * deployment, a deleteAllowance rides along and revokes it. That allowance is
 * spendable by the co-signer key ALONE — exactly the unilateral disposal
 * capability this model rules out — so the first user-signed send is the
 * right moment to close it: the user is present and signing anyway, and
 * afterwards the account has no spend path but this one.
 */
export function transferExecutionTransactions(
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
  opts: {
    /** Set to revoke a standing allowance for (delegate, token). */
    revokeLegacyAllowance?: { delegate: `0x${string}`; moduleAddress?: `0x${string}` };
  } = {},
): MetaTransaction[] {
  if (amount <= 0n) {
    throw new Error(`a Safe execution needs a positive amount, got ${amount}`);
  }
  const txs: MetaTransaction[] = [];
  if (opts.revokeLegacyAllowance) {
    const allowance = new AllowanceModule(
      opts.revokeLegacyAllowance.moduleAddress ?? CANDIDE.allowanceModuleAddress,
    );
    txs.push(allowance.createDeleteAllowanceMetaTransaction(opts.revokeLegacyAllowance.delegate, token));
  }
  txs.push(erc20TransferMetaTransaction(token, to, amount));
  return txs;
}

const ERC20_TRANSFER_ABI = [
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
] as const;

const ERC20_APPROVE_ABI = [
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
] as const;

function erc20TransferMetaTransaction(token: `0x${string}`, to: `0x${string}`, amount: bigint): MetaTransaction {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, amount] }),
  };
}

/**
 * The full cash-rail debit as ONE user-signed batch — Change 2, windows 1-3:
 *
 *   [revoke legacy allowance?] -> fee transfer -> approve venue -> swap call
 *
 * The fee moves to us as its own transfer (a flat service fee, taken openly,
 * not folded into the conversion); the venue approval is for exactly the
 * convertible amount and names the spender the VENUE named; the swap call
 * carries the quoted floor and delivers the output straight to the payout
 * destination. The batch is atomic: if any leg fails — a stale maker quote, a
 * moved pool — the whole operation reverts and nothing has left the Safe.
 * There is no state in which we hold the user's euros.
 */
export function transferSwapBatchTransactions(args: {
  token: `0x${string}`;
  feeTo: `0x${string}`;
  feeAmount: bigint;
  approval: { spender: `0x${string}`; amount: bigint };
  call: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  revokeLegacyAllowance?: { delegate: `0x${string}`; moduleAddress?: `0x${string}` };
}): MetaTransaction[] {
  if (args.approval.amount <= 0n) {
    throw new Error(`a Safe swap batch needs a positive convert amount, got ${args.approval.amount}`);
  }
  if (args.feeAmount < 0n) {
    throw new Error(`a Safe swap batch cannot carry a negative fee, got ${args.feeAmount}`);
  }
  const txs: MetaTransaction[] = [];
  if (args.revokeLegacyAllowance) {
    const allowance = new AllowanceModule(
      args.revokeLegacyAllowance.moduleAddress ?? CANDIDE.allowanceModuleAddress,
    );
    txs.push(allowance.createDeleteAllowanceMetaTransaction(args.revokeLegacyAllowance.delegate, args.token));
  }
  if (args.feeAmount > 0n) {
    txs.push(erc20TransferMetaTransaction(args.token, args.feeTo, args.feeAmount));
  }
  txs.push({
    to: args.token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [args.approval.spender, args.approval.amount],
    }),
  });
  txs.push({ to: args.call.to, value: args.call.value, data: args.call.data });
  return txs;
}

/**
 * The shared core of every send-time user-signed operation: validate the plan,
 * short-circuit under simulation, refuse undeployed Safes, read (from the
 * chain, never the database) whether a legacy standing allowance still needs
 * revoking, then wrap the caller's meta-transactions into a sponsored
 * UserOperation whose hash the passkey will sign.
 */
async function prepareSafeExecutionCore(
  plan: PasskeySafeDeploymentPlan,
  token: `0x${string}`,
  buildSetup: (revokeLegacyAllowance?: { delegate: `0x${string}` }) => MetaTransaction[],
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  const { account, passkeyOwner } = accountForPlan(plan);
  if (allowSimulation()) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x1234567890123456789012345678901234567890123456789012345678901234",
      userOperation: {} as UserOperationV9,
    };
  }
  if (!(await isDeployed(account.accountAddress))) {
    throw new Error("passkey Safe must be deployed before a transfer can be executed from it");
  }
  // Revoke a standing co-signer allowance if one survives on an older Safe.
  // It is spendable by the co-signer key alone, so it rides along on the
  // first user-signed send.
  let revokeLegacyAllowance: { delegate: `0x${string}` } | undefined;
  if (CANDIDE.cosignerAddress) {
    const legacy = await readCosignerTokenAllowance(plan.address, token);
    if (legacy && legacy.amount > 0n) {
      revokeLegacyAllowance = { delegate: CANDIDE.cosignerAddress };
    }
  }
  return sponsoredUserOperation(account, plan, passkeyOwner, buildSetup(revokeLegacyAllowance));
}

/** Wrap meta-transactions into a paymaster-sponsored UserOperation whose
 *  EIP-712 hash the passkey signs. */
async function sponsoredUserOperation(
  account: SafeAccount,
  plan: PasskeySafeDeploymentPlan,
  passkeyOwner: WebauthnPublicKey,
  txs: MetaTransaction[],
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  const userOperation = await account.createUserOperation(
    txs,
    CANDIDE.rpcUrl,
    CANDIDE.bundlerUrl,
    { expectedSigners: plan.cosignerAddress ? [passkeyOwner, plan.cosignerAddress] : [passkeyOwner] },
  );
  const paymaster = new Erc7677Paymaster(CANDIDE.paymasterUrl);
  const sponsored = await paymaster.createPaymasterUserOperation(
    account as any,
    userOperation as any,
    CANDIDE.bundlerUrl,
  );
  const finalOp: UserOperationV9 = ((sponsored as any).userOperation ?? sponsored) as UserOperationV9;
  return {
    safeAddress: account.accountAddress as `0x${string}`,
    challenge: account.getUserOperationEip712Hash(finalOp, CANDIDE.chainId) as `0x${string}`,
    userOperation: finalOp,
  };
}

/**
 * The SafeAccount for a plan. Before recovery the address IS the
 * counterfactual address of the owner set, so it is re-derived and checked;
 * after a recovery the owner changed under a fixed address, so the account is
 * built from the address alone and the derivation would be wrong.
 */
export function accountForPlan(plan: PasskeySafeDeploymentPlan): { account: SafeAccount; passkeyOwner: WebauthnPublicKey } {
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  if (plan.recoveredAt) {
    return { account: new SafeAccount(plan.address), passkeyOwner };
  }
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
  return { account, passkeyOwner };
}

/**
 * A user-signed operation that changes the Safe's own configuration — adding
 * a recovery guardian, cancelling a recovery — rather than moving tokens.
 * Same sponsorship and signing path as a transfer; no allowance read, since
 * nothing here is a spend.
 */
export async function prepareSafeSetupOperation(
  plan: PasskeySafeDeploymentPlan,
  txs: MetaTransaction[],
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  if (!txs.length) throw new Error("a Safe setup operation needs at least one transaction");
  const { account, passkeyOwner } = accountForPlan(plan);
  if (allowSimulation()) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x1234567890123456789012345678901234567890123456789012345678901234",
      userOperation: {} as UserOperationV9,
    };
  }
  if (!(await isDeployed(account.accountAddress))) {
    throw new Error("passkey Safe must be deployed before its configuration can change");
  }
  return sponsoredUserOperation(account, plan, passkeyOwner, txs);
}

/**
 * Build the UserOperation that debits one transfer from the user's Safe. The
 * passkey owner signs its hash at send time (the co-signer counter-signs where
 * it is an owner), so the exact movement — token, amount, destination — is
 * user-approved and chain-enforced. Between sends nothing can move: no owner
 * key is stored server-side and no allowance exists.
 */
export async function prepareTransferExecution(
  plan: PasskeySafeDeploymentPlan,
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  return prepareSafeExecutionCore(plan, token, (revokeLegacyAllowance) =>
    transferExecutionTransactions(token, to, amount, { revokeLegacyAllowance }),
  );
}

/**
 * Build the UserOperation for a full cash-rail send: fee + venue approval +
 * swap, one signature, atomic. See transferSwapBatchTransactions for the
 * batch's shape and why each leg is there.
 */
export async function prepareTransferBatchExecution(
  plan: PasskeySafeDeploymentPlan,
  args: {
    token: `0x${string}`;
    feeTo: `0x${string}`;
    feeAmount: bigint;
    approval: { spender: `0x${string}`; amount: bigint };
    call: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  },
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  return prepareSafeExecutionCore(plan, args.token, (revokeLegacyAllowance) =>
    transferSwapBatchTransactions({ ...args, revokeLegacyAllowance }),
  );
}

/**
 * What the chain says the co-signer may spend from this Safe — as opposed to
 * what the database says deployment intended. Calls to a codeless module
 * address succeed, so a stored policy can describe an allowance that does not
 * exist; only the chain answers. Returns null when the module cannot be read.
 */
export async function readCosignerTokenAllowance(
  safeAddress: `0x${string}`,
  token: `0x${string}`,
): Promise<{ amount: bigint; remaining: bigint } | null> {
  if (!CANDIDE.cosignerAddress) return null;
  try {
    const allowance = new AllowanceModule(CANDIDE.allowanceModuleAddress);
    // Read on the chain the UserOperation will execute on (CANDIDE.rpcUrl),
    // not the app chain: config allows the two to differ, and deciding the
    // revoke from the wrong chain silently skips it.
    const current = await allowance.getTokensAllowance(CANDIDE.rpcUrl, safeAddress, CANDIDE.cosignerAddress, token);
    const nowMin = BigInt(Math.floor(Date.now() / 60_000));
    const spent =
      current.resetTimeMin > 0n && nowMin >= current.lastResetMin + current.resetTimeMin
        ? 0n
        : current.spent;
    return { amount: current.amount, remaining: current.amount > spent ? current.amount - spent : 0n };
  } catch {
    return null;
  }
}

export async function submitPasskeySafeOperation(
  plan: PasskeySafeDeploymentPlan,
  userOperation: UserOperationV9,
  assertion: BrowserPasskeyAssertion,
): Promise<string | null> {
  const { account, passkeyOwner } = accountForPlan(plan);
  if (plan.cosignerAddress && !CANDIDE.cosignerKey) {
    throw new Error("CANDIDE_COSIGNER_KEY is required to co-sign passkey Safe deployment");
  }
  if (allowSimulation()) {
    return "0xmock-user-op-hash";
  }
  const deployed = await isDeployed(account.accountAddress);
  const passkeySigner = fromSafeWebauthn({
    publicKey: passkeyOwner,
    isInit: !deployed,
    accountClass: SafeAccount,
    getAssertion: async () => webauthnSignatureFromAssertion(assertion),
  });
  const signers = [passkeySigner];
  if (plan.cosignerAddress) signers.push(fromPrivateKey(CANDIDE.cosignerKey));
  userOperation.signature = await account.signUserOperationWithSigners(
    userOperation,
    signers,
    CANDIDE.chainId,
  );
  const response = await account.sendUserOperation(userOperation, CANDIDE.bundlerUrl);
  await response.included();
  return response.userOperationHash;
}

export async function signMessageAsPasskeySafe(
  plan: PasskeySafeDeploymentPlan,
  safeAddress: string,
  message: string,
  assertion: BrowserPasskeyAssertion,
): Promise<`0x${string}`> {
  const { account, passkeyOwner } = accountForPlan(plan);
  if (account.accountAddress.toLowerCase() !== safeAddress.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the address being linked");
  }
  const { domain, types, messageValue } = getSafeMessageEip712Data(
    safeAddress as `0x${string}`,
    CANDIDE.chainId,
    message,
  );
  const webauthnAddr = passkeyAccountAddress(passkeyOwner);
  const passkeySignature = SafeAccount.createWebAuthnSignature(webauthnSignatureFromAssertion(assertion));
  const pairs: SignerSignaturePair[] = [
    { signer: webauthnAddr as any, signature: passkeySignature, isContractSignature: true },
  ];
  if (plan.cosignerAddress) {
    if (!CANDIDE.cosignerKey) throw new Error("CANDIDE_COSIGNER_KEY is required to co-sign Safe message");
    const cosigner = privateKeyToAccount(CANDIDE.cosignerKey);
    const cosignerSignature = await cosigner.signTypedData({
      domain: domain as any,
      types: types as any,
      primaryType: "SafeMessage",
      message: messageValue as any,
    });
    pairs.push({ signer: plan.cosignerAddress, signature: cosignerSignature });
  }
  return SafeAccount.buildSignaturesFromSingerSignaturePairs(pairs, { isInit: false }) as `0x${string}`;
}

export async function isDeployed(address: string): Promise<boolean> {
  if (allowSimulation()) return true;
  const res = await fetch(CANDIDE.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const { result } = await res.json();
  return typeof result === "string" && result !== "0x";
}

// ---------------------------------------------------------------------------
// Social recovery module — what the chain says, and the operations that change it

const GRACE_PERIOD_SECONDS: Record<string, number> = {
  [SocialRecoveryModuleGracePeriodSelector.After3Minutes.toLowerCase()]: 3 * 60,
  [SocialRecoveryModuleGracePeriodSelector.After3Days.toLowerCase()]: 3 * 24 * 3600,
  [SocialRecoveryModuleGracePeriodSelector.After7Days.toLowerCase()]: 7 * 24 * 3600,
  [SocialRecoveryModuleGracePeriodSelector.After14Days.toLowerCase()]: 14 * 24 * 3600,
};

/** Grace period of a known SocialRecoveryModule deployment, or null for an
 *  address that is not one of Candide's four variants. */
export function recoveryGracePeriodSeconds(moduleAddress: string): number | null {
  return GRACE_PERIOD_SECONDS[moduleAddress.toLowerCase()] ?? null;
}

const moduleCodeCache = new Map<string, boolean>();

/**
 * Does the recovery module have code on the smart-account chain?
 *
 * Candide's 3-day, 7-day and 14-day modules are deployed on Base mainnet and
 * Gnosis but NOT on Base Sepolia, where only the 3-minute test module exists
 * (verified with eth_getCode). Safe.enableModule on a codeless address does
 * not revert, so without this check a testnet deployment would record
 * recovery as active on a module that cannot recover anything.
 */
export async function recoveryModuleHasCode(moduleAddress: string): Promise<boolean> {
  if (allowSimulation()) return true;
  const key = moduleAddress.toLowerCase();
  const cached = moduleCodeCache.get(key);
  if (cached !== undefined) return cached;
  const has = await isDeployed(moduleAddress);
  if (has) moduleCodeCache.set(key, true);
  return has;
}

export async function assertRecoveryModuleDeployed(moduleAddress: string): Promise<void> {
  if (await recoveryModuleHasCode(moduleAddress)) return;
  throw new Error(
    `recovery module ${moduleAddress} has no code on chain ${CANDIDE.chainId} — on Base Sepolia only the ` +
      `3-minute test module ${SocialRecoveryModuleGracePeriodSelector.After3Minutes} is deployed; set ` +
      `CANDIDE_RECOVERY_MODULE_ADDRESS to a module that exists on this chain`,
  );
}

const SAFE_READ_ABI = [
  { type: "function", name: "getOwners", inputs: [], outputs: [{ type: "address[]" }], stateMutability: "view" },
  { type: "function", name: "getThreshold", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "isModuleEnabled",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

async function ethCall(to: string, data: `0x${string}`): Promise<`0x${string}`> {
  const res = await fetch(CANDIDE.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`eth_call ${to} failed: ${error?.message ?? JSON.stringify(error)}`);
  return result as `0x${string}`;
}

/** The Safe's current owner set, read from the smart-account chain. */
export async function safeOwners(safeAddress: string): Promise<`0x${string}`[]> {
  const raw = await ethCall(safeAddress, encodeFunctionData({ abi: SAFE_READ_ABI, functionName: "getOwners" }));
  return [...(decodeFunctionResult({ abi: SAFE_READ_ABI, functionName: "getOwners", data: raw }) as readonly string[])] as `0x${string}`[];
}

export async function safeThreshold(safeAddress: string): Promise<number> {
  const raw = await ethCall(safeAddress, encodeFunctionData({ abi: SAFE_READ_ABI, functionName: "getThreshold" }));
  return Number(decodeFunctionResult({ abi: SAFE_READ_ABI, functionName: "getThreshold", data: raw }) as bigint);
}

export interface RecoveryModuleState {
  moduleAddress: `0x${string}`;
  moduleEnabled: boolean;
  guardians: `0x${string}`[];
  threshold: number;
  /** An executed-but-not-finalised recovery, if the module holds one. */
  pending: { newOwners: `0x${string}`[]; newThreshold: number; executeAfter: number } | null;
}

/**
 * Read the Safe's recovery configuration FROM THE CHAIN, never from the
 * database. A stored "active" is what deployment intended; only the module
 * knows whether the guardian was really added. Under simulation there is no
 * chain, so the stored plan is the only answer available and is used as such.
 */
export async function readRecoveryState(
  plan: PasskeySafeDeploymentPlan,
  extraGuardians: `0x${string}`[] = [],
): Promise<RecoveryModuleState> {
  const moduleAddress = (plan.recovery?.moduleAddress ?? CANDIDE.recoveryModuleAddress) as `0x${string}`;
  if (allowSimulation()) {
    const guardians = [
      ...(plan.recovery && plan.recovery.guardianAddress ? [plan.recovery.guardianAddress] : []),
      ...extraGuardians,
    ];
    return {
      moduleAddress,
      moduleEnabled: Boolean(plan.recovery) || extraGuardians.length > 0,
      guardians,
      threshold: guardians.length ? 1 : 0,
      pending: null,
    };
  }
  const enabledRaw = await ethCall(
    plan.address,
    encodeFunctionData({ abi: SAFE_READ_ABI, functionName: "isModuleEnabled", args: [moduleAddress] }),
  );
  const moduleEnabled = decodeFunctionResult({ abi: SAFE_READ_ABI, functionName: "isModuleEnabled", data: enabledRaw }) as boolean;
  if (!moduleEnabled) return { moduleAddress, moduleEnabled, guardians: [], threshold: 0, pending: null };
  const srm = new SocialRecoveryModule(moduleAddress);
  const [guardians, threshold, request] = await Promise.all([
    srm.getGuardians(CANDIDE.rpcUrl, plan.address),
    srm.threshold(CANDIDE.rpcUrl, plan.address),
    srm.getRecoveryRequest(CANDIDE.rpcUrl, plan.address),
  ]);
  const executeAfter = Number(request.executeAfter);
  return {
    moduleAddress,
    moduleEnabled,
    guardians: guardians as `0x${string}`[],
    threshold: Number(threshold),
    pending:
      executeAfter > 0
        ? { newOwners: request.newOwners as `0x${string}`[], newThreshold: Number(request.newThreshold), executeAfter }
        : null,
  };
}

/**
 * Add a guardian to the Safe's recovery set: enable the module first when the
 * Safe has never had one. `threshold` is the number of guardian approvals a
 * recovery needs afterwards.
 */
export function recoveryGuardianSetupTransactions(
  safeAddress: `0x${string}`,
  moduleAddress: `0x${string}`,
  guardianAddress: `0x${string}`,
  threshold: number,
  moduleEnabled: boolean,
): MetaTransaction[] {
  const srm = new SocialRecoveryModule(moduleAddress);
  return [
    ...(moduleEnabled ? [] : [srm.createEnableModuleMetaTransaction(safeAddress)]),
    srm.createAddGuardianWithThresholdMetaTransaction(guardianAddress, BigInt(threshold)),
  ];
}

/** The owner's veto: cancels the recovery the module currently holds. Only
 *  meaningful before finalisation, which is the whole point of a grace period. */
export function recoveryCancelTransaction(moduleAddress: `0x${string}`): MetaTransaction {
  return new SocialRecoveryModule(moduleAddress).createCancelRecoveryMetaTransaction();
}

/**
 * Deploy the WebAuthn signer verifier for a passkey, so a recovered Safe's
 * new owner is a contract that can validate signatures. The factory is
 * permissionless, so any funded key may send this — it does not need to be
 * an owner.
 */
export function deployWebAuthnVerifierTransaction(owner: WebauthnPublicKey): MetaTransaction {
  return SafeAccount.createDeployWebAuthnVerifierMetaTransaction(owner.x, owner.y);
}
