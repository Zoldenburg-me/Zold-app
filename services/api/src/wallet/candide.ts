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
import { createWalletClient, encodeFunctionData, hashTypedData, http } from "viem";
import { chain, publicClient } from "../chain.js";
import { RPC_URL } from "../config.js";

const allowSimulation = () =>
  process.env.ALLOW_SIMULATION === "1" ||
  (process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545"));

const allowMockFallback = () =>
  process.env.ALLOW_MOCK_FALLBACK === "1" ||
  process.env.NODE_ENV !== "production" ||
  allowSimulation();

const COSIGNER_ENABLED =
  process.env.CANDIDE_COSIGNER_ENABLED === "1" ||
  (process.env.CANDIDE_COSIGNER_ENABLED !== "0" &&
    Boolean(process.env.CANDIDE_COSIGNER_ADDRESS && process.env.CANDIDE_COSIGNER_KEY));

export const CANDIDE = {
  chainId: BigInt(process.env.CANDIDE_CHAIN_ID ?? 11155111),
  bundlerUrl: process.env.CANDIDE_BUNDLER_URL ?? "https://api.candide.dev/public/v3/11155111",
  paymasterUrl: process.env.CANDIDE_PAYMASTER_URL ?? "https://api.candide.dev/public/v3/11155111",
  rpcUrl: process.env.CANDIDE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  cosignerEnabled: COSIGNER_ENABLED,
  cosignerAddress: (process.env.CANDIDE_COSIGNER_ADDRESS ?? "") as `0x${string}` | "",
  cosignerKey: (process.env.CANDIDE_COSIGNER_KEY ?? "") as `0x${string}` | "",
  recoveryGuardianAddress: (process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS ?? "") as `0x${string}` | "",
  recoveryModuleAddress: (process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ??
    SocialRecoveryModuleGracePeriodSelector.After3Days) as `0x${string}`,
  allowanceModuleAddress: (process.env.CANDIDE_ALLOWANCE_MODULE_ADDRESS ??
    (BigInt(process.env.CANDIDE_CHAIN_ID ?? process.env.TRANSF_CHAIN_ID ?? 11155111) === 84532n
      ? "0xAA46724893dedD72658219405185Fb0Fc91e091C"
      : AllowanceModule.DEFAULT_ALLOWANCE_MODULE_ADDRESS)) as `0x${string}`,
  cosignerAllowancePeriodMinutes: BigInt(process.env.CANDIDE_COSIGNER_ALLOWANCE_PERIOD_MINUTES ?? "0"),
  cosignerEureAllowanceWei: BigInt(
    process.env.CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI ??
      process.env.CANDIDE_COSIGNER_ALLOWANCE_AMOUNT ??
      "0",
  ),
  cosignerUsdcAllowanceUnits: BigInt(
    process.env.CANDIDE_COSIGNER_USDC_ALLOWANCE_UNITS ??
      process.env.CANDIDE_COSIGNER_ALLOWANCE_AMOUNT ??
      "0",
  ),
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
    /** Deprecated display field kept for old clients. */
    allowanceAmount?: string;
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
  const setup = [
    ...passkeySafeRecoverySetupTransactions(plan),
    ...passkeySafeAllowanceSetupTransactions(plan),
  ];
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

export function passkeySafeAllowanceSetupTransactions(
  plan: PasskeySafeDeploymentPlan,
  /** The allowance delegate. Defaults to the co-signer OWNER, but the two are
   *  distinct roles: a single-owner Safe can still delegate spending to the
   *  configured co-signer without making it an owner. */
  delegate: `0x${string}` | "" | undefined = plan.cosignerAddress || CANDIDE.cosignerAddress,
): MetaTransaction[] {
  if (!delegate || !plan.cosignerPolicy?.enabled) return [];
  const allowance = new AllowanceModule(plan.cosignerPolicy.allowanceModuleAddress);
  const txs = [
    allowance.createEnableModuleMetaTransaction(plan.address),
    allowance.createAddDelegateMetaTransaction(delegate),
  ];
  const period = BigInt(plan.cosignerPolicy.allowancePeriodMinutes ?? "0");
  for (const item of plan.cosignerPolicy.allowances ?? []) {
    const amount = BigInt(item.amount);
    if (amount <= 0n) continue;
    txs.push(
      period > 0n
        ? allowance.createRecurringAllowanceMetaTransaction(
            delegate,
            item.token,
            amount,
            period,
            0n,
          )
        : allowance.createOneTimeAllowanceMetaTransaction(
            delegate,
            item.token,
            amount,
            0n,
          ),
    );
  }
  return txs;
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
    const current = await allowance.getTokensAllowance(RPC_URL, safeAddress, CANDIDE.cosignerAddress, token);
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

/** Safe's isModuleEnabled(address) — the batch below must skip enableModule
 *  when it already ran, because the Safe reverts on enabling a module twice. */
export async function safeModuleEnabled(safeAddress: string, module: string): Promise<boolean> {
  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "isModuleEnabled",
        inputs: [{ name: "module", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
      },
    ],
    functionName: "isModuleEnabled",
    args: [module as `0x${string}`],
  });
  const res = await fetch(CANDIDE.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: safeAddress, data }, "latest"] }),
  });
  const { result } = await res.json();
  return typeof result === "string" && BigInt(result) === 1n;
}

/**
 * Build the userOp that installs (or repairs) the co-signer spending allowance
 * on an ALREADY-DEPLOYED passkey Safe.
 *
 * Exists because deployment-time setup can configure nothing while reporting
 * success: Safes deployed against the codeless module address are active, hold
 * money, and cannot debit. The repair runs the same setup transactions through
 * the Safe's normal signing path — the passkey owner approves, the co-signer
 * counter-signs where it is an owner — so the API gains no authority a Safe
 * owner did not grant.
 */
export async function preparePasskeySafeAllowanceSetup(plan: PasskeySafeDeploymentPlan): Promise<{
  safeAddress: `0x${string}`;
  challenge: `0x${string}`;
  userOperation: UserOperationV9;
}> {
  if (!CANDIDE.cosignerAddress) {
    throw new Error("CANDIDE_COSIGNER_ADDRESS is required to configure a spending allowance");
  }
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = plan.cosignerAddress
    ? smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress)
    : smartAccountForPasskey(passkeyOwner);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
  if (!(await isDeployed(account.accountAddress))) {
    throw new Error("passkey Safe must be deployed before its spending allowance can be configured");
  }
  // The delegate is always the CURRENT co-signer: on a single-owner Safe it is
  // not an owner at all, and plan.cosignerAddress (the owner set, immutable
  // after deployment) must not be confused with it.
  let setup = passkeySafeAllowanceSetupTransactions(plan, CANDIDE.cosignerAddress);
  if (setup.filter((t) => BigInt(t.to) !== BigInt(plan.address)).length < 2) {
    // enableModule targets the Safe; everything else targets the module. Less
    // than delegate+one allowance means the policy would grant nothing.
    throw new Error(
      "no spendable allowance is configured — set CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI (and/or USDC) first",
    );
  }
  if (await safeModuleEnabled(plan.address, plan.cosignerPolicy!.allowanceModuleAddress)) {
    setup = setup.filter((t) => BigInt(t.to) !== BigInt(plan.address));
  }
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

export async function submitPasskeySafeDeployment(
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

/**
 * Move an ERC-20 out of a passkey Safe through the production co-signer
 * allowance set up during Safe deployment.
 *
 * This cannot act unless the user's Safe explicitly installed the configured
 * co-signer as an allowance delegate for the token, and the on-chain remaining
 * allowance covers this exact spend. The delegate transaction is sent by the
 * configured co-signer key, so no user Safe owner key exists in the API
 * database.
 */
export async function transferTokenFromSafeAllowance(params: {
  safeAddress: `0x${string}`;
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
}): Promise<string> {
  if (!CANDIDE.cosignerAddress || !CANDIDE.cosignerKey) {
    throw new Error("CANDIDE_COSIGNER_ADDRESS and CANDIDE_COSIGNER_KEY are required for passkey Safe allowance debit");
  }
  if (allowSimulation()) {
    return "0xmock-allowance-debit-hash";
  }
  if (!(await isDeployed(params.safeAddress))) {
    if (allowMockFallback()) {
      console.warn(`Safe ${params.safeAddress} is not deployed — falling back to mock fee debit for dev/testnet`);
      return "0xmock-allowance-debit-hash";
    }
    throw new Error(`Safe ${params.safeAddress} is not deployed — cannot move tokens from it`);
  }
  if (!(await safeModuleEnabled(params.safeAddress, CANDIDE.allowanceModuleAddress))) {
    if (allowMockFallback()) {
      console.warn(
        `Passkey Safe allowance module is not enabled on-chain for ${params.safeAddress} — falling back to mock fee debit for dev/testnet`,
      );
      return "0xmock-allowance-debit-hash";
    }
    throw new Error(
      `Passkey Safe co-signer allowance module (${CANDIDE.allowanceModuleAddress}) is not enabled on-chain for Safe ${params.safeAddress}. ` +
        `Please click "Set Up Allowance" in your account dashboard.`,
    );
  }

  const allowance = new AllowanceModule(CANDIDE.allowanceModuleAddress);
  let current: any;
  try {
    current = await allowance.getTokensAllowance(
      RPC_URL,
      params.safeAddress,
      CANDIDE.cosignerAddress,
      params.token,
    );
  } catch (err: any) {
    if (allowMockFallback()) {
      console.warn(`Failed to read tokens allowance for ${params.safeAddress} (${err?.message ?? err}) — falling back to mock fee debit for dev/testnet`);
      return "0xmock-allowance-debit-hash";
    }
    throw err;
  }
  const nowMin = BigInt(Math.floor(Date.now() / 60_000));
  const spent =
    current.resetTimeMin > 0n && nowMin >= current.lastResetMin + current.resetTimeMin
      ? 0n
      : current.spent;
  const remaining = current.amount > spent ? current.amount - spent : 0n;
  if (remaining < params.amount) {
    if (allowMockFallback()) {
      console.warn(
        `passkey Safe co-signer allowance is ${remaining} units for ${params.token}, ` +
          `but this debit needs ${params.amount} — falling back to mock fee debit for dev/testnet Safe ${params.safeAddress}`,
      );
      return "0xmock-allowance-debit-hash";
    }
    throw new Error(
      `passkey Safe co-signer allowance is ${remaining} units for ${params.token}, ` +
        `but this debit needs ${params.amount}`,
    );
  }

  const tx = allowance.createAllowanceTransferMetaTransaction(
    params.safeAddress,
    params.token,
    params.to,
    params.amount,
    CANDIDE.cosignerAddress,
  );
  const account = privateKeyToAccount(CANDIDE.cosignerKey);
  if (account.address.toLowerCase() !== CANDIDE.cosignerAddress.toLowerCase()) {
    throw new Error("CANDIDE_COSIGNER_KEY does not match CANDIDE_COSIGNER_ADDRESS");
  }
  const wallet = createWalletClient({ account, chain: chain as any, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({
    to: tx.to as `0x${string}`,
    value: tx.value,
    data: tx.data as `0x${string}`,
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("passkey Safe allowance debit reverted");
  return hash;
}
