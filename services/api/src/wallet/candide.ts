/**
 * Candide smart wallets (AbstractionKit, Safe-based ERC-4337 accounts).
 *
 * Every user gets a Safe smart account whose address is computed offline and
 * deterministically from their passkey's public key — the same address on
 * every EVM chain. That address is the user's identity and token balance account, and
 * the address Monerium links the IBAN to.
 *
 * For Monerium to verify ownership of a contract wallet it calls EIP-1271 on
 * the address, so the Safe must actually be deployed on the chain Monerium
 * checks (Base by default; CANDIDE_CHAIN_ID follows TRANSF_CHAIN_ID). Deployment goes through Candide's public
 * bundler and is centralized in the passkey Safe deployment route. Who pays the
 * gas is SAFE_GAS_PAYMENT (see gasPaymentFromEnv).
 */
import {
  SafeMultiChainSigAccountV1 as SafeAccount,
  Erc7677Paymaster,
  HttpTransport,
  SocialRecoveryModule,
  SocialRecoveryModuleGracePeriodSelector,
  calculateUserOperationMaxGasCost,
  fromSafeWebauthn,
  getSafeMessageEip712Data,
  webauthnSignatureFromAssertion,
  type MetaTransaction,
  type SignerSignaturePair,
  type UserOperationV9,
  type WebauthnPublicKey,
} from "abstractionkit";
import { decodeFunctionResult, encodeFunctionData, hashTypedData } from "viem";

/**
 * The only shortcuts are the HARNESS ones (config.ts): fake challenges and a
 * fake UserOperation hash on the hardhat chain, where no bundler exists. Don't
 * gate on NODE_ENV alone: it is true on the hosted testnet and would report
 * PAID while no money left the user's Safe. HARNESS.enabled cannot be true on
 * a chain with real money.
 */
import { HARNESS } from "../config.js";
import { partnerTimeout } from "../http.js";
const allowSimulation = () => HARNESS.enabled;

/** The smart-account chain follows the app chain unless told otherwise, and
 *  Candide's public endpoints are addressed by that id (their v3 bundler and
 *  paymaster answer for 8453 — checked with eth_supportedEntryPoints). */
const CANDIDE_CHAIN_ID = process.env.CANDIDE_CHAIN_ID ?? process.env.TRANSF_CHAIN_ID ?? "8453";

/**
 * Who pays a UserOperation's gas.
 *
 * - `sponsored`: Candide's paymaster pays. Their free Starter plan covers 1,000
 *   sponsored mainnet ops inside a 90-day trial, and the keyless public
 *   endpoint may not sponsor mainnet at all — `npm run preflight` asks it.
 * - `native`: the Safe pays in ETH and no paymaster is involved, so nothing
 *   here depends on anyone's quota. The Safe must hold ETH first; for a Safe
 *   that is not deployed yet, send it to the counterfactual address.
 * - `token`: Candide's token paymaster takes an ERC-20 (USDC by default on
 *   Base) from the Safe as gas. It answers without an API key on Base mainnet.
 *   EURe is not on its list (checked with pm_supportedERC20Tokens, Sep 2026),
 *   so the Safe needs a little USDC.
 *
 * Read once at boot; an unknown value refuses to start rather than falling
 * back to a mode the operator did not choose.
 */
export type GasPayment = { mode: "sponsored" } | { mode: "native" } | { mode: "token"; token: `0x${string}` };

/** Circle's USDC, the token-paymaster default. Candide's public paymaster
 *  lists it on 8453; on 84532 it lists only its own test token. */
const DEFAULT_GAS_TOKEN: Record<string, `0x${string}`> = {
  "8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export function gasPaymentFromEnv(env: NodeJS.ProcessEnv, chainId: string): GasPayment {
  const mode = (env.SAFE_GAS_PAYMENT ?? "sponsored").trim().toLowerCase();
  if (mode === "sponsored" || mode === "native") return { mode };
  if (mode === "token") {
    const token = (env.SAFE_GAS_TOKEN ?? DEFAULT_GAS_TOKEN[chainId] ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      throw new Error(
        `SAFE_GAS_PAYMENT=token needs SAFE_GAS_TOKEN on chain ${chainId} (no default token is known there)`,
      );
    }
    return { mode, token: token as `0x${string}` };
  }
  throw new Error(`SAFE_GAS_PAYMENT must be sponsored, native or token, got "${env.SAFE_GAS_PAYMENT}"`);
}

export const CANDIDE = {
  chainId: BigInt(CANDIDE_CHAIN_ID),
  bundlerUrl: process.env.CANDIDE_BUNDLER_URL ?? `https://api.candide.dev/public/v3/${CANDIDE_CHAIN_ID}`,
  paymasterUrl: process.env.CANDIDE_PAYMASTER_URL ?? `https://api.candide.dev/public/v3/${CANDIDE_CHAIN_ID}`,
  rpcUrl: process.env.CANDIDE_RPC_URL ?? process.env.TRANSF_RPC_URL ?? "https://mainnet.base.org",
  gas: gasPaymentFromEnv(process.env, CANDIDE_CHAIN_ID),
  recoveryGuardianAddress: (process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS ?? "") as `0x${string}` | "",
  recoveryModuleAddress: (process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ??
    SocialRecoveryModuleGracePeriodSelector.After3Days) as `0x${string}`,
};

/**
 * Every request abstractionkit makes — bundler, paymaster, and the nonce and
 * gas-price reads — goes through this fetch, so none of them can hang a send.
 * Its own HttpTransport passes no signal of its own unless a caller does; when
 * one does, either signal aborts the request.
 */
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, partnerTimeout()]) : partnerTimeout(),
  });
const transport = (url: string) => new HttpTransport(url, { fetch: timedFetch });
const bundler = () => transport(CANDIDE.bundlerUrl);
const rpc = () => transport(CANDIDE.rpcUrl);
const paymaster = () =>
  new Erc7677Paymaster(transport(CANDIDE.paymasterUrl), {
    chainId: CANDIDE.chainId,
    // Detection only runs on a URL string; with a transport it has to be named,
    // or the Candide-specific stub and token-quote calls are skipped.
    provider: Erc7677Paymaster.detectProvider(CANDIDE.paymasterUrl),
  });

/** How long submit waits for a bundler to include an op, and how often it
 *  asks. The whole HTTP request blocks on this. */
const INCLUSION_TIMEOUT_S = 180;
const INCLUSION_POLL_S = 2;

/**
 * A Safe whose stored plan still lists the retired Zold co-signer as a second
 * owner. Those Safes are abandoned: the co-signer key is no longer configured,
 * so they cannot sign anything, and every operation refuses up front with
 * this rather than failing halfway through a passkey ceremony. The stored plan
 * is kept (gating is a read-time filter, never a delete) so the address and
 * any balance on it stay visible.
 */
export class AbandonedLegacySafeError extends Error {
  readonly status = 409;
  constructor(address: string) {
    super(
      `Safe ${address} is a legacy 2-of-2 with the retired Zold co-signer as an owner. ` +
        `Those Safes are abandoned and can no longer sign; create a new passkey Safe.`,
    );
    this.name = "AbandonedLegacySafeError";
  }
}

/** Is this plan a legacy 2-of-2 Safe that still lists the co-signer? */
export function isAbandonedLegacySafe(plan: { cosignerAddress?: string } | undefined | null): boolean {
  return Boolean(plan?.cosignerAddress);
}

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

export function smartAccountForPasskey(passkeyOwner: WebauthnPublicKey): SafeAccount {
  return SafeAccount.initializeNewAccount([passkeyOwner]);
}

export interface PasskeySafeDeploymentPlan {
  address: `0x${string}`;
  threshold: 1 | 2;
  /** LEGACY: set on Safes deployed as 2-of-2 before the co-signer was retired.
   *  Such a Safe is abandoned (AbandonedLegacySafeError); nothing reads it but
   *  that check. */
  cosignerAddress?: `0x${string}`;
  passkeyPublicKey: { x: string; y: string };
  recovery?: {
    moduleAddress: `0x${string}`;
    guardianAddress: `0x${string}`;
    threshold: 1;
  };
  /** A recovered Safe: its address is fixed and no longer derives from the
   *  current owner set, so it is addressed rather than computed. */
  recoveredAt?: string;
  /** The legacy co-signer was removed from the owner set. Like recoveredAt,
   *  the address no longer derives from the owners. */
  cosignerRemovedAt?: string;
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
  return paidUserOperation(account, passkeyOwner, setup.length ? setup : [noop]);
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
 * The meta-transactions of one transfer's user-signed debit: the Safe
 * transfers the exact amount to the destination the terms name. No allowance
 * or delegate; the transfer itself is signed, so the chain enforces amount and
 * destination.
 */
export function transferExecutionTransactions(
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): MetaTransaction[] {
  if (amount <= 0n) {
    throw new Error(`a Safe execution needs a positive amount, got ${amount}`);
  }
  return [erc20TransferMetaTransaction(token, to, amount)];
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
 * The full cash-rail debit as one user-signed batch (Change 2, windows 1-3):
 *
 *   fee transfer -> approve venue -> swap call
 *
 * The flat service fee moves to us as its own transfer, separate from the
 * conversion. The venue approval is for exactly the convertible amount, to the
 * spender the venue named. The swap call carries the quoted floor and delivers
 * straight to the payout destination. The batch is atomic: if any leg fails
 * (stale maker quote, moved pool) it all reverts and nothing leaves the Safe,
 * so we never hold the user's euros.
 */
export function transferSwapBatchTransactions(args: {
  token: `0x${string}`;
  feeTo: `0x${string}`;
  feeAmount: bigint;
  approval: { spender: `0x${string}`; amount: bigint };
  call: { to: `0x${string}`; data: `0x${string}`; value: bigint };
}): MetaTransaction[] {
  if (args.approval.amount <= 0n) {
    throw new Error(`a Safe swap batch needs a positive convert amount, got ${args.approval.amount}`);
  }
  if (args.feeAmount < 0n) {
    throw new Error(`a Safe swap batch cannot carry a negative fee, got ${args.feeAmount}`);
  }
  const txs: MetaTransaction[] = [];
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
 * short-circuit under simulation, refuse undeployed Safes, then wrap the
 * caller's meta-transactions into a UserOperation whose hash the passkey will
 * sign.
 */
async function prepareSafeExecutionCore(
  plan: PasskeySafeDeploymentPlan,
  txs: MetaTransaction[],
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
  return paidUserOperation(account, passkeyOwner, txs);
}

/**
 * Wrap meta-transactions into a UserOperation whose gas is paid the way
 * CANDIDE.gas says, and return the EIP-712 hash the passkey signs.
 *
 * The passkey signs the op AFTER gas is settled, so a token-paymaster approve
 * prepended to the calldata is part of what the user approves.
 */
async function paidUserOperation(
  account: SafeAccount,
  passkeyOwner: WebauthnPublicKey,
  txs: MetaTransaction[],
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  const userOperation = await account.createUserOperation(txs, rpc(), bundler(), {
    expectedSigners: [passkeyOwner],
  });
  const finalOp = await payGas(account, userOperation);
  return {
    safeAddress: account.accountAddress as `0x${string}`,
    challenge: account.getUserOperationEip712Hash(finalOp, CANDIDE.chainId) as `0x${string}`,
    userOperation: finalOp,
  };
}

async function payGas(account: SafeAccount, userOperation: UserOperationV9): Promise<UserOperationV9> {
  const gas = CANDIDE.gas;
  if (gas.mode === "native") {
    // No paymaster: the EntryPoint takes the prefund from the Safe's ETH.
    // Refuse here, before the passkey ceremony, rather than let the bundler
    // reject a signed op with AA21.
    const need = calculateUserOperationMaxGasCost(userOperation);
    const have = await ethBalance(account.accountAddress);
    if (have < need) {
      throw new SafeGasError(
        `the Safe needs up to ${formatEth(need)} ETH for gas and holds ${formatEth(have)} — ` +
          `send ETH to ${account.accountAddress} on chain ${CANDIDE.chainId}`,
      );
    }
    return userOperation;
  }
  const context = gas.mode === "token" ? { token: gas.token } : {};
  let result: Awaited<ReturnType<Erc7677Paymaster["createPaymasterUserOperation"]>>;
  try {
    result = await paymaster().createPaymasterUserOperation(account as any, userOperation as any, bundler(), context);
  } catch (err) {
    throw paymasterRefusal(err, account.accountAddress) ?? err;
  }
  // abstractionkit falls back to SPONSORSHIP when it cannot get a token quote.
  // An operator who chose token payment did not choose that; refuse instead.
  if (gas.mode === "token" && !result.tokenQuote) {
    throw new SafeGasError(`the paymaster at ${CANDIDE.paymasterUrl} gave no quote for gas token ${gas.token}`);
  }
  return result.userOperation as UserOperationV9;
}

/**
 * The two refusals a paymaster gives that the user or operator can act on,
 * as Candide words them (seen on Base mainnet, Sep 2026). Anything else stays
 * the paymaster's own error.
 */
function paymasterRefusal(err: unknown, safeAddress: string): SafeGasError | null {
  const text = `${(err as any)?.message ?? ""} ${(err as any)?.cause?.message ?? ""}`;
  if (/does not qualify for any publicly available gas policy/i.test(text)) {
    return new SafeGasError(
      `the paymaster at ${CANDIDE.paymasterUrl} will not sponsor this operation on chain ${CANDIDE.chainId} ` +
        `(no public gas policy covers it) — set SAFE_GAS_PAYMENT=native or =token, or use an API key with a funded policy`,
    );
  }
  const short = /token balance lower than the required `?(0x[0-9a-f]+)`? allowance/i.exec(text);
  if (short && CANDIDE.gas.mode === "token") {
    return new SafeGasError(
      `the Safe needs at least ${BigInt(short[1])} base units of gas token ${CANDIDE.gas.token} — ` +
        `send some to ${safeAddress} on chain ${CANDIDE.chainId}`,
    );
  }
  return null;
}

/** The gas could not be arranged: the Safe is short, or the paymaster would
 *  not quote. A 409 — the user (or operator) has something to fix — rather
 *  than an opaque 500. */
export class SafeGasError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "SafeGasError";
  }
}

function formatEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

export async function ethBalance(address: string): Promise<bigint> {
  const res = await fetch(CANDIDE.rpcUrl, {
    signal: partnerTimeout(),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || typeof body.result !== "string") {
    throw new Error(`eth_getBalance failed (${res.status}): ${JSON.stringify(body?.error ?? body ?? "").slice(0, 160)}`);
  }
  return BigInt(body.result);
}

/**
 * The SafeAccount for a plan. Before recovery the address IS the
 * counterfactual address of the owner set, so it is re-derived and checked;
 * after a recovery the owner changed under a fixed address, so the account is
 * built from the address alone and the derivation would be wrong.
 */
export function accountForPlan(plan: PasskeySafeDeploymentPlan): { account: SafeAccount; passkeyOwner: WebauthnPublicKey } {
  if (isAbandonedLegacySafe(plan)) throw new AbandonedLegacySafeError(plan.address);
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  if (plan.recoveredAt || plan.cosignerRemovedAt) {
    return { account: new SafeAccount(plan.address), passkeyOwner };
  }
  const account = smartAccountForPasskey(passkeyOwner);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
  return { account, passkeyOwner };
}

/**
 * A user-signed operation that changes the Safe's own configuration — adding
 * a recovery guardian, cancelling a recovery — rather than moving tokens.
 * Same gas and signing path as a transfer.
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
  return paidUserOperation(account, passkeyOwner, txs);
}

/**
 * Build the UserOperation that debits one transfer from the user's Safe. The
 * passkey owner signs its hash at send time, so the exact movement — token, amount, destination — is
 * user-approved and chain-enforced. Between sends nothing can move: no owner
 * key is stored server-side and no allowance exists.
 */
export async function prepareTransferExecution(
  plan: PasskeySafeDeploymentPlan,
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<{ safeAddress: `0x${string}`; challenge: `0x${string}`; userOperation: UserOperationV9 }> {
  return prepareSafeExecutionCore(plan, transferExecutionTransactions(token, to, amount));
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
  return prepareSafeExecutionCore(plan, transferSwapBatchTransactions(args));
}

export async function submitPasskeySafeOperation(
  plan: PasskeySafeDeploymentPlan,
  userOperation: UserOperationV9,
  assertion: BrowserPasskeyAssertion,
): Promise<string | null> {
  const { account, passkeyOwner } = accountForPlan(plan);
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
  userOperation.signature = await account.signUserOperationWithSigners(
    userOperation,
    [passkeySigner],
    CANDIDE.chainId,
  );
  const response = await account.sendUserOperation(userOperation, bundler());
  await response.included(INCLUSION_TIMEOUT_S, INCLUSION_POLL_S);
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
  const webauthnAddr = passkeyAccountAddress(passkeyOwner);
  const passkeySignature = SafeAccount.createWebAuthnSignature(webauthnSignatureFromAssertion(assertion));
  const pairs: SignerSignaturePair[] = [
    { signer: webauthnAddr as any, signature: passkeySignature, isContractSignature: true },
  ];
  return SafeAccount.buildSignaturesFromSingerSignaturePairs(pairs, { isInit: false }) as `0x${string}`;
}

export async function isDeployed(address: string): Promise<boolean> {
  if (allowSimulation()) return true;
  const res = await fetch(CANDIDE.rpcUrl, {
    signal: partnerTimeout(),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const body = await res.json().catch(() => null);
  // An RPC failure must not read as "not deployed": that flips a deployed
  // Safe's operation to init mode and blames the user for the refusal.
  if (!res.ok || !body || body.error) {
    throw new Error(`eth_getCode failed (${res.status}): ${JSON.stringify(body?.error ?? body ?? "").slice(0, 160)}`);
  }
  const { result } = body;
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
    signal: partnerTimeout(),
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

/** The Safe's current signature threshold, read from the smart-account chain. */
export async function safeThreshold(safeAddress: string): Promise<number> {
  const raw = await ethCall(safeAddress, encodeFunctionData({ abi: SAFE_READ_ABI, functionName: "getThreshold" }));
  return Number(decodeFunctionResult({ abi: SAFE_READ_ABI, functionName: "getThreshold", data: raw }));
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
    srm.getGuardians(rpc(), plan.address),
    srm.threshold(rpc(), plan.address),
    srm.getRecoveryRequest(rpc(), plan.address),
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
