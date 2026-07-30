/**
 * Candide smart wallets (AbstractionKit, Safe-based ERC-4337 accounts).
 *
 * Every user gets a Safe smart account whose address is computed offline and
 * deterministically from their owner key — the same address on every EVM
 * chain. That address is the user's identity everywhere: the local RemitVault
 * ledger, and the address Monerium links the IBAN to.
 *
 * For Monerium to verify ownership of a contract wallet it calls EIP-1271 on
 * the address, so the Safe must actually be deployed on the chain Monerium
 * checks (Sepolia in sandbox). Deployment is gasless via Candide's public
 * bundler + paymaster and is centralized in the passkey Safe deployment route.
 */
import {
  SafeMultiChainSigAccountV1 as SafeAccount,
  Erc7677Paymaster,
  SocialRecoveryModule,
  SocialRecoveryModuleGracePeriodSelector,
  fromPrivateKey,
  fromSafeWebauthn,
  getSafeMessageEip712Data,
  webauthnSignatureFromAssertion,
  type MetaTransaction,
  type UserOperationV9,
  type WebauthnPublicKey,
} from "abstractionkit";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData } from "viem";

export const CANDIDE = {
  chainId: BigInt(process.env.CANDIDE_CHAIN_ID ?? 11155111),
  bundlerUrl: process.env.CANDIDE_BUNDLER_URL ?? "https://api.candide.dev/public/v3/11155111",
  paymasterUrl: process.env.CANDIDE_PAYMASTER_URL ?? "https://api.candide.dev/public/v3/11155111",
  rpcUrl: process.env.CANDIDE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  cosignerAddress: (process.env.CANDIDE_COSIGNER_ADDRESS ?? "") as `0x${string}` | "",
  cosignerKey: (process.env.CANDIDE_COSIGNER_KEY ?? "") as `0x${string}` | "",
  recoveryGuardianAddress: (process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS ??
    process.env.CANDIDE_COSIGNER_ADDRESS ??
    "") as `0x${string}` | "",
  recoveryModuleAddress: (process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ??
    SocialRecoveryModuleGracePeriodSelector.After3Days) as `0x${string}`,
};

/** Deterministic Safe address for an owner — offline, no network. */
export function smartAccountFor(ownerAddress: string): SafeAccount {
  return SafeAccount.initializeNewAccount([ownerAddress]);
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

export function smartAccountForPasskeyCosigner(
  passkeyOwner: WebauthnPublicKey,
  cosignerAddress: `0x${string}`,
): SafeAccount {
  return SafeAccount.initializeNewAccount([passkeyOwner, cosignerAddress], { threshold: 2 });
}

export interface PasskeySafeDeploymentPlan {
  address: `0x${string}`;
  cosignerAddress: `0x${string}`;
  passkeyPublicKey: { x: string; y: string };
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

export async function preparePasskeySafeDeployment(plan: PasskeySafeDeploymentPlan): Promise<{
  safeAddress: `0x${string}`;
  challenge: `0x${string}`;
  userOperation: UserOperationV9;
}> {
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress);
  if (account.accountAddress.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error("passkey Safe plan does not match the deterministic account address");
  }
  const recoverySetup = passkeySafeRecoverySetupTransactions(plan);
  const deployed = await isDeployed(account.accountAddress);
  if (deployed && !recoverySetup.length) {
    return {
      safeAddress: account.accountAddress as `0x${string}`,
      challenge: "0x",
      userOperation: {} as UserOperationV9,
    };
  }
  const noop: MetaTransaction = { to: account.accountAddress, value: 0n, data: "0x" };
  const userOperation = await account.createUserOperation(
    recoverySetup.length ? recoverySetup : [noop],
    CANDIDE.rpcUrl,
    CANDIDE.bundlerUrl,
    { expectedSigners: [passkeyOwner, plan.cosignerAddress] },
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

export async function submitPasskeySafeDeployment(
  plan: PasskeySafeDeploymentPlan,
  userOperation: UserOperationV9,
  assertion: BrowserPasskeyAssertion,
): Promise<string | null> {
  const passkeyOwner = webauthnOwnerFromStore(plan.passkeyPublicKey);
  const account = smartAccountForPasskeyCosigner(passkeyOwner, plan.cosignerAddress);
  if (!CANDIDE.cosignerKey) throw new Error("CANDIDE_COSIGNER_KEY is required to co-sign passkey Safe deployment");
  const deployed = await isDeployed(account.accountAddress);
  const passkeySigner = fromSafeWebauthn({
    publicKey: passkeyOwner,
    isInit: !deployed,
    accountClass: SafeAccount,
    getAssertion: async () => webauthnSignatureFromAssertion(assertion),
  });
  const cosigner = fromPrivateKey(CANDIDE.cosignerKey);
  userOperation.signature = await account.signUserOperationWithSigners(
    userOperation,
    [passkeySigner, cosigner],
    CANDIDE.chainId,
  );
  const response = await account.sendUserOperation(userOperation, CANDIDE.bundlerUrl);
  await response.included();
  return response.userOperationHash;
}

export async function isDeployed(address: string): Promise<boolean> {
  const res = await fetch(CANDIDE.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const { result } = await res.json();
  return typeof result === "string" && result !== "0x";
}

/**
 * Move an ERC-20 out of the user's Safe, gaslessly.
 *
 * Needed once the vault holds Monerium's real EURe rather than a token we mint
 * ourselves: a deposit lands in the user's Safe, and RemitVault.creditDeposit
 * refuses unless the vault actually holds the tokens backing the credit
 * ("uncovered credit"), so the euros have to be moved before they can be
 * credited.
 *
 * This is a server-signed action today — the same custody gap FP4's second
 * half exists to close. It is not a new hole, but it is a bigger one: the key
 * that can do this can now move real euros, not mock ones.
 */
export async function transferTokenFromSafe(params: {
  ownerKey: `0x${string}`;
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
}): Promise<string> {
  const owner = privateKeyToAccount(params.ownerKey);
  const account = smartAccountFor(owner.address);
  if (!(await isDeployed(account.accountAddress))) {
    throw new Error(`Safe ${account.accountAddress} is not deployed — cannot move tokens from it`);
  }
  // transfer(address,uint256)
  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "transfer",
    args: [params.to, params.amount],
  });

  const call: MetaTransaction = { to: params.token, value: 0n, data };
  const userOperation = await account.createUserOperation(
    [call],
    CANDIDE.rpcUrl,
    CANDIDE.bundlerUrl,
  );
  const paymaster = new Erc7677Paymaster(CANDIDE.paymasterUrl);
  const sponsored = await paymaster.createPaymasterUserOperation(
    account as any,
    userOperation as any,
    CANDIDE.bundlerUrl,
  );
  const finalOp: any = (sponsored as any).userOperation ?? sponsored;
  finalOp.signature = account.signUserOperation(finalOp, [params.ownerKey], CANDIDE.chainId);
  const response = await account.sendUserOperation(finalOp, CANDIDE.bundlerUrl);
  await response.included();
  return response.userOperationHash;
}

/**
 * Sign a message the Safe way: the owner signs the EIP-712 SafeMessage
 * envelope over the EIP-191 hash of `message`. A deployed Safe validates
 * this via EIP-1271 (isValidSignature) — which is how Monerium verifies
 * contract-wallet ownership.
 */
export async function signMessageAsSafe(
  ownerKey: `0x${string}`,
  safeAddress: string,
  message: string,
): Promise<`0x${string}`> {
  const owner = privateKeyToAccount(ownerKey);
  const { domain, types, messageValue } = getSafeMessageEip712Data(
    safeAddress as `0x${string}`,
    CANDIDE.chainId,
    message,
  );
  return owner.signTypedData({
    domain: domain as any,
    types: types as any,
    primaryType: "SafeMessage",
    message: messageValue as any,
  });
}
