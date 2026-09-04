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
import { encodeFunctionData, hashTypedData } from "viem";

/**
 * The only shortcuts left are the HARNESS ones (config.ts): fake challenges
 * and a fake UserOperation hash on the hardhat chain, where no bundler
 * exists. They used to key on ALLOW_SIMULATION or "looks local" — once on
 * NODE_ENV alone, which was TRUE on the hosted testnet, so transfers reported
 * PAID while no money had left the user's Safe. HARNESS.enabled cannot be true
 * on any chain where money is real.
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
  /** Kept ONLY to read and revoke legacy standing allowances left on Safes
   *  deployed under the removed co-signer-delegate model. Nothing installs an
   *  allowance any more — debits are user-signed UserOperations. */
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
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
  if (allowSimulation()) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x1234567890123456789012345678901234567890123456789012345678901234",
      userOperation: {} as UserOperationV9,
    };
  }
  // Deployment installs recovery only. The allowance module is deliberately
  // NOT installed any more: nothing spends from the Safe except UserOperations
  // the user's own passkey signs, so there is no delegate to authorize and no
  // standing spend surface to bound.
  const setup = [...passkeySafeRecoverySetupTransactions(plan)];
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
 * When the account still carries a legacy standing allowance from the old
 * co-signer-delegate model, a deleteAllowance rides along and revokes it.
 * That allowance is spendable by the co-signer key ALONE — exactly the
 * unilateral disposal capability this model removes — so the first user-signed
 * send is the right moment to close it: the user is present and signing
 * anyway, and afterwards the account has no spend path but this one.
 */
export function transferExecutionTransactions(
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
  opts: {
    /** Set to revoke a legacy standing allowance for (delegate, token). */
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
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
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
  // Legacy cleanup: revoke a standing co-signer allowance if one survives from
  // the old delegate model. That allowance is spendable by the co-signer key
  // alone — the exact capability this model removes — so it rides along on the
  // first user-signed send.
  let revokeLegacyAllowance: { delegate: `0x${string}` } | undefined;
  if (CANDIDE.cosignerAddress) {
    const legacy = await readCosignerTokenAllowance(plan.address, token);
    if (legacy && legacy.amount > 0n) {
      revokeLegacyAllowance = { delegate: CANDIDE.cosignerAddress };
    }
  }
  const setup = buildSetup(revokeLegacyAllowance);
  const userOperation = await account.createUserOperation(
    setup,
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
 * what the database says deployment intended. The two have disagreed: setup
 * batches once pointed at an allowance module address with no code, and calls
 * to a codeless address succeed, so "deployed with policy" recorded a policy
 * that does not exist. Debits read the chain, so this must too.
 * Returns null when the module cannot be read (which a debit would also fail).
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
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
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
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
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
