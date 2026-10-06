import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { base, baseSepolia, hardhat, polygon, polygonAmoy } from "viem/chains";
import {
  CHAIN_ID,
  KEYS,
  RPC_URL,
  TESTNET_FAUCET,
  loadAbi,
  loadDeployments,
  type Deployments,
} from "./config.js";
import type { PayoutRail } from "./store.js";

/**
 * The viem chain we talk to, resolved from TRANSF_CHAIN_ID.
 *
 * Known ids use viem's own definitions so fee/explorer metadata is right;
 * anything else is synthesised from the id and RPC rather than refused, so a
 * new testnet needs an env var rather than a code change.
 */
export const chain = (() => {
  switch (CHAIN_ID) {
    case base.id: return base;
    case baseSepolia.id: return baseSepolia;
    case hardhat.id: return hardhat;
    case polygonAmoy.id: return polygonAmoy;
    case polygon.id: return polygon;
    default:
      return defineChain({
        id: CHAIN_ID,
        name: `chain-${CHAIN_ID}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [RPC_URL] } },
      });
  }
})();

/**
 * Refuse to run against an RPC that is not the chain we were told to expect.
 *
 * Silent mismatch is the expensive failure: Safe deployment and token balances
 * would be checked on different chains, and user operations would fail in ways
 * that look like wallet bugs rather than configuration mistakes.
 */
export async function assertChainMatches(): Promise<void> {
  const actual = await publicClient.getChainId();
  if (actual !== CHAIN_ID) {
    throw new Error(
      `RPC at ${RPC_URL} reports chain ${actual}, but TRANSF_CHAIN_ID is ${CHAIN_ID}. ` +
        `Signatures would be built for the wrong chain and every debit would revert.`,
    );
  }
}

/**
 * Warn when the app chain and the smart-account chain disagree.
 *
 * `isDeployed()` in wallet/candide.ts always asks CANDIDE_RPC_URL, while
 * everything else here uses TRANSF_RPC_URL. If they point at different chains,
 * a passkey Safe deploys on one and the app looks for it on the other, with no
 * error. The symptom appears three screens into onboarding as "passkey Safe
 * must be deployed before Monerium funding provisioning" about a Safe the
 * database correctly records as active.
 *
 * Only a warning: `npm run dev` runs chain 31337 against a Candide configured
 * for a public chain, and everything except passkey Safe deployment works
 * there. In production assertProductionConfig fails outright.
 */
export function warnIfSmartAccountChainDiffers(): void {
  const candideChainId = Number(process.env.CANDIDE_CHAIN_ID ?? CHAIN_ID);
  if (candideChainId === CHAIN_ID) return;
  console.warn(
    `WARNING: app chain is ${CHAIN_ID} but CANDIDE_CHAIN_ID is ${candideChainId}. ` +
      `Passkey Safes will deploy on ${candideChainId} and isDeployed() will check ${candideChainId}, ` +
      `while balances and contracts come from ${CHAIN_ID}. Safe-dependent onboarding will refuse ` +
      `with a message about deployment that looks unrelated. Run both on the same chain ` +
      `(npm run api) unless you know why they differ.`,
  );
}

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

/** A client that SENDS transactions. Its transport never retries: viem throws
 *  only the last attempt's error, so a first attempt the node accepted could
 *  surface as a refusal on the retry (insufficient funds, spent by attempt
 *  one), and writeDefinitelyRefused would call it not-sent. */
function wallet(key: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain,
    transport: http(RPC_URL, { retryCount: 0 }),
  });
}

export const deployerWallet = wallet(KEYS.deployer);
/** The testnet faucet's own wallet; unset means no faucet (faucet.ts). */
export const faucetWallet = TESTNET_FAUCET.key ? wallet(TESTNET_FAUCET.key) : undefined;
export const orchestratorWallet = wallet(KEYS.orchestrator);
export const orchestratorAddress = orchestratorWallet.account.address;

/**
 * The FxSwapper is a LOCAL venue: our own inventory at an owner-set rate, the
 * only option on hardhat. Real chains carry no deployment of it, so asking
 * for its address there is a configuration error, named as one.
 */
export function swapperAddress(): `0x${string}` {
  const a = addrs().swapper;
  if (!a) {
    throw new Error(
      `no FxSwapper is deployed on chain ${CHAIN_ID} — LIQUIDITY_PROVIDER=fx-swapper is a local venue; use best/lifi/dex`,
    );
  }
  return a;
}

export const abis = {
  MockToken: loadAbi("MockToken"),
  FxSwapper: loadAbi("FxSwapper"),
};

let deployments: Deployments | null = null;
export function addrs(): Deployments {
  if (!deployments) deployments = loadDeployments();
  return deployments;
}

export function transferIdHash(id: string): `0x${string}` {
  return keccak256(toHex(id));
}

export const eur = {
  toWei: (amount: number) => parseUnits(amount.toFixed(6), 18),
  fromWei: (wei: bigint) => Number(formatUnits(wei, 18)),
};
export const usd = {
  toUnits: (amount: number) => parseUnits(amount.toFixed(6), 6),
  fromUnits: (units: bigint) => Number(formatUnits(units, 6)),
};

/**
 * Hooks around one chain write, for a caller that records an outbound intent.
 * `beforeSend` runs after the simulation passes and before the transaction is
 * sent: a failure before it means nothing went out. `onNotSent` and
 * `onReverted` fire only on a DEFINITE outcome; an RPC error, a timeout, a
 * transport error, an unknown error or anything after a hash exists fires
 * neither, because the transaction may still land.
 */
export interface WriteHooks {
  beforeSend?: () => void;
  /** The write threw before any hash existed with an error that proves the node refused it. */
  onNotSent?: () => void;
  /** The transaction was mined and reverted: nothing it carried moved. */
  onReverted?: (hash: `0x${string}`) => void;
}

/**
 * viem error classes that prove the transaction never entered the mempool: the
 * node refused it on validation, or it failed locally before any request
 * (account, chain, signing, serialisation). Nothing else proves it: a bare
 * RPC error (-32603, -1, LimitExceeded) may come after the node took the
 * transaction. The list holds only because the write clients send with
 * `retryCount: 0` (wallet()): with retries, viem throws the last attempt's
 * error, and a refusal on a retry can follow a first attempt that was accepted.
 */
const REFUSED_BEFORE_ACCEPTANCE = new Set([
  "InsufficientFundsError",
  "ExecutionRevertedError",
  "IntrinsicGasTooLowError",
  "IntrinsicGasTooHighError",
  "FeeCapTooLowError",
  "FeeCapTooHighError",
  "TipAboveFeeCapError",
  "NonceTooHighError",
  "NonceMaxValueError",
  "TransactionTypeNotSupportedError",
  "FeeConflictError",
  "AccountNotFoundError",
  "AccountTypeNotSupportedError",
  "ChainMismatchError",
  "ChainNotFoundError",
  "ClientChainNotConfiguredError",
  "InvalidChainIdError",
  "InvalidAddressError",
  "InvalidSerializableTransactionError",
  "InvalidLegacyVError",
  "InvalidYParityError",
  "InvalidStorageKeySizeError",
]);
/** Anywhere in the chain, these mean this transaction (or its twin) may be on
 *  the node, whatever else the error says. */
const MAYBE_DELIVERED_NAMES = new Set([
  "NonceTooLowError",
  "TimeoutError",
  "HttpRequestError",
  "WebSocketRequestError",
  "SocketClosedError",
  "AbortError",
]);
const MAYBE_DELIVERED = /already known|known transaction|already imported|nonce too low|replacement transaction|timed? ?out|socket|network|ECONNRESET/i;

/** Whether a write that threw without a hash was definitely refused before the
 *  node accepted it. Unknown or ambiguous errors answer false. It relies on
 *  the write clients' `retryCount: 0` (wallet() above): the error it reads is
 *  then the only attempt's, never a retry's. */
export function writeDefinitelyRefused(err: unknown): boolean {
  let refused = false;
  for (let e: any = err, depth = 0; e && depth < 10; e = e.cause, depth++) {
    const name = String(e.name);
    if (MAYBE_DELIVERED_NAMES.has(name)) return false;
    if (MAYBE_DELIVERED.test(String(e.shortMessage ?? e.message ?? "")) || MAYBE_DELIVERED.test(String(e.details ?? ""))) return false;
    if (REFUSED_BEFORE_ACCEPTANCE.has(name)) refused = true;
  }
  return refused;
}

/** Send a tx as `client` and wait for the receipt; throws on revert. */
export async function writeAndWait(
  client: typeof orchestratorWallet,
  args: { address: `0x${string}`; abi: any[]; functionName: string; args: any[] },
  opts: WriteHooks = {},
) {
  const { request } = await publicClient.simulateContract({
    account: client.account,
    ...args,
  });
  opts.beforeSend?.();
  let hash: `0x${string}`;
  try {
    hash = await client.writeContract(request);
  } catch (err) {
    if (writeDefinitelyRefused(err)) opts.onNotSent?.();
    throw err;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    opts.onReverted?.(hash);
    throw new Error(`tx reverted: ${args.functionName}`);
  }
  return hash;
}

/**
 * The keccak256 commitment to a payout destination that the device signs.
 *
 * The device authorization fixes the amount and the on-chain `to`, but the
 * money actually leaves the system on a fiat leg (SEPA IBAN, cash pickup
 * phone) the contract can never see. Folding a hash of that target into
 * the signed struct means the signature attests to *who* is paid: a server
 * that later swaps the recipient produces a payout whose recomputed commitment
 * no longer matches what the user signed, and the relayed spend is refused.
 *
 * The recipient NAME is part of it, not just the account identifier. On the cash
 * rail the name is the payout identity — it is what the anchor is told and what
 * the person presents with ID at the counter — so a commitment over the phone
 * number alone left the one field that decides who collects the money outside
 * what the device signed.
 *
 * The preimage is canonical per rail so the browser, the API, and the
 * orchestrator all derive the identical value from the same recipient:
 *   cash → "cash|phone=<phone>|name=<NAME>"  (phone trimmed)
 *   sepa → "sepa|iban=<IBAN>|name=<NAME>"    (whitespace-stripped, upper-cased)
 * where <NAME> is trimmed, inner whitespace collapsed, upper-cased.
 * Keep this in lockstep with destinationCommitment() in public/device.js.
 */
export function destinationCommitment(
  rail: PayoutRail,
  target: { phone?: string; iban?: string; name?: string },
): `0x${string}` {
  const name = (target.name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  let preimage: string;
  if (rail === "sepa") {
    preimage = `sepa|iban=${(target.iban ?? "").replace(/\s/g, "").toUpperCase()}`;
  } else {
    preimage = `cash|phone=${(target.phone ?? "").trim()}`;
  }
  return keccak256(toHex(`${preimage}|name=${name}`));
}

/**
 * The EIP-712 payload the user's device signs to authorize one payment.
 * Safe-native transfer authorization. The API verifies it before relaying Safe
 * operations.
 */
export function paymentAuthorizationTypedData(args: {
  account: `0x${string}`;
  amountWei: bigint;
  to: `0x${string}`;
  transferId: `0x${string}`;
  destination: `0x${string}`;
  deadline: number;
}) {
  return {
    domain: {
      name: "TransF Safe Transfer",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: args.account,
    },
    types: {
      PaymentAuthorization: [
        { name: "account", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "to", type: "address" },
        { name: "transferId", type: "bytes32" },
        { name: "destination", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PaymentAuthorization" as const,
    message: {
      account: args.account,
      amount: args.amountWei.toString(),
      to: args.to,
      transferId: args.transferId,
      destination: args.destination,
      deadline: args.deadline,
    },
  };
}

/**
 * The EUR->USD rate the swapper will actually execute at.
 *
 * The quote's EUR leg is read from here rather than from a constant so that
 * what we promise and what we can deliver cannot drift apart. `rate` is USDC
 * (6dp) per 1e18 EURe, so 1_080_000 means 1 EURe -> 1.08 USDC. `raw` is what
 * the quote binding locks into the quote and re-checks at execution.
 */
export async function swapperRate(): Promise<{ rate: number; raw: bigint }> {
  const raw = (await publicClient.readContract({
    address: swapperAddress(),
    abi: abis.FxSwapper,
    functionName: "rate",
    args: [],
  })) as bigint;
  if (raw <= 0n) throw new Error("swapper rate is zero — cannot quote");
  return { rate: Number(raw) / 1e6, raw };
}

export async function safeEurBalance(user: `0x${string}`): Promise<number> {
  const bal = (await publicClient.readContract({
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;
  return eur.fromWei(bal);
}

/**
 * Displayed and diagnostic EUR balances. The Safe is the account of record.
 */
export async function accountBalances(user: `0x${string}`): Promise<{
  balanceEur: number;
  safeBalanceEur: number;
}> {
  const safeBalanceEur = await safeEurBalance(user);
  return {
    balanceEur: safeBalanceEur,
    safeBalanceEur,
  };
}

/**
 * Return EURe the orchestrator is holding to a user's Safe.
 *
 * The refund leg for a Safe-funded transfer: the euros were taken out of the
 * user's own Safe, so that is where they go back. A Safe-funded debit can only
 * have happened where the Safe held the token, so the reverse move is always
 * available. Nothing is minted, which is why it works off a local chain: it
 * hands back the very tokens that were moved.
 */
export async function returnEureToSafe(
  userSafe: `0x${string}`,
  amountEur: number,
  hooks: WriteHooks = {},
): Promise<`0x${string}`> {
  const amount = eur.toWei(amountEur);
  const held = (await publicClient.readContract({
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "balanceOf",
    args: [orchestratorAddress],
  })) as bigint;
  if (held < amount) {
    throw new Error(
      `orchestrator holds ${eur.fromWei(held)} EURe but the refund needs ${amountEur} — ` +
        `refusing a partial refund rather than guessing which transfer it belongs to`,
    );
  }
  return writeAndWait(orchestratorWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "transfer",
    args: [userSafe, amount],
  }, hooks);
}
