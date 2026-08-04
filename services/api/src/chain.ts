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
import { hardhat, polygon, polygonAmoy } from "viem/chains";
import {
  CHAIN_ID,
  KEYS,
  RPC_URL,
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
 * Silent mismatch is the expensive failure: the EIP-712 domain would carry one
 * chain id while the vault computes another from block.chainid, and every
 * device signature would be rejected as "bad authorization" — an error that
 * points at the signing code rather than at the misconfiguration.
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
 * `isDeployed()` in wallet/candide.ts asks CANDIDE_RPC_URL — always — while
 * everything else here talks to TRANSF_RPC_URL. Point those at different chains
 * and a passkey Safe deploys on one while the app looks for it on the other.
 * Nothing throws: both answers are correct, they just describe different
 * chains. The symptom surfaces three screens into onboarding as
 * "passkey Safe must be deployed before Monerium funding provisioning" about a
 * Safe the database quite rightly records as active.
 *
 * A WARNING, not a refusal. `npm run dev` runs chain 31337 against a
 * Candide configured for a public chain, and everything except passkey Safe
 * deployment works fine there — refusing to start would break the common case
 * to prevent an uncommon one. Production is different: assertProductionConfig
 * fails outright, because a mismatch there is never intentional.
 */
export function warnIfSmartAccountChainDiffers(): void {
  const candideChainId = Number(process.env.CANDIDE_CHAIN_ID ?? 11155111);
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

function wallet(key: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain,
    transport: http(RPC_URL),
  });
}

export const deployerWallet = wallet(KEYS.deployer);
export const orchestratorWallet = wallet(KEYS.orchestrator);
export const rampWallet = wallet(KEYS.ramp);
export const orchestratorAddress = orchestratorWallet.account.address;

export const abis = {
  MockToken: loadAbi("MockToken"),
  RemitVault: loadAbi("RemitVault"),
  FxSwapper: loadAbi("FxSwapper"),
  BridgeEscrow: loadAbi("BridgeEscrow"),
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

/** Send a tx as `client` and wait for the receipt; throws on revert. */
export async function writeAndWait(
  client: typeof orchestratorWallet,
  args: { address: `0x${string}`; abi: any[]; functionName: string; args: any[] },
) {
  const { request } = await publicClient.simulateContract({
    account: client.account,
    ...args,
  });
  const hash = await client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${args.functionName}`);
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
 * no longer matches what the user signed, and the vault debit reverts.
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
 * FP4: the EIP-712 payload the user's device signs to authorize one payment.
 * Mirrors RemitVault's PaymentAuthorization struct exactly — if these drift,
 * the digest changes and the contract rejects the signature.
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
      name: "RemitVault",
      version: "1",
      // Must match what RemitVault computed from block.chainid at deploy time.
      chainId: CHAIN_ID,
      verifyingContract: addrs().vault,
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

/** Which key may authorize debits from `account` (zero address if unbound). */
export async function vaultAuthorizerOf(account: `0x${string}`): Promise<`0x${string}`> {
  return (await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "authorizerOf",
    args: [account],
  })) as `0x${string}`;
}

/**
 * Bind an account to its device key. Trust-on-first-use via the ramp role:
 * the contract refuses to let us re-point an account that is already bound,
 * so this can only ever establish the first binding.
 */
export async function setVaultAuthorizer(
  account: `0x${string}`,
  authorizer: `0x${string}`,
): Promise<`0x${string}`> {
  return writeAndWait(rampWallet, {
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "setAuthorizer",
    args: [account, authorizer],
  });
}

/**
 * The EUR->USD rate the swapper will actually execute at.
 *
 * The quote's EUR leg is read from here rather than from a constant so that
 * what we promise and what we can deliver cannot drift apart. `rate` is USDC
 * (6dp) per 1e18 EURe, so 1_080_000 means 1 EURe -> 1.08 USDC. `raw` is what
 * FP5 locks into the quote and re-checks at execution.
 */
export async function swapperRate(): Promise<{ rate: number; raw: bigint }> {
  const raw = (await publicClient.readContract({
    address: addrs().swapper,
    abi: abis.FxSwapper,
    functionName: "rate",
    args: [],
  })) as bigint;
  if (raw <= 0n) throw new Error("swapper rate is zero — cannot quote");
  return { rate: Number(raw) / 1e6, raw };
}

export async function vaultBalance(user: `0x${string}`): Promise<number> {
  const bal = (await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;
  return eur.fromWei(bal);
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
 * Displayed and diagnostic EUR balances.
 *
 * The headline balance remains the vault ledger because that is what the
 * current transfer executor can spend. Safe EURe is exposed separately as
 * custody/reconciliation state, especially on native-Monerium chains where
 * deposits briefly, or after a failed mirror permanently, sit in the Safe.
 */
export async function accountBalances(user: `0x${string}`): Promise<{
  balanceEur: number;
  safeBalanceEur: number;
  vaultBalanceEur: number;
}> {
  const [safeBalanceEur, vaultBalanceEur] = await Promise.all([
    safeEurBalance(user),
    vaultBalance(user),
  ]);
  return {
    balanceEur: vaultBalanceEur,
    safeBalanceEur,
    vaultBalanceEur,
  };
}

/**
 * Move EURe from the orchestrator to a user's Safe so a redeem can burn it.
 *
 * Returns null on a local chain: the vault there holds a mock EURe that
 * Monerium has never heard of, so there is nothing to forward and the
 * simulated payout does not need it.
 *
 * Deliberately a plain ERC-20 transfer rather than anything vault-side. The
 * orchestrator already holds these tokens — debit sent them there — and the
 * amount forwarded is the payout only, so our fee stays behind.
 */
export async function forwardEureForRedeem(
  userSafe: `0x${string}`,
  payoutEur: number,
): Promise<`0x${string}` | null> {
  const { moneriumEure } = await import("./adapters/monerium-tokens.js");
  const { MONERIUM } = await import("./config.js");
  if (!(await moneriumEure(MONERIUM.baseUrl, CHAIN_ID))) return null;

  const amount = eur.toWei(payoutEur);
  const held = (await publicClient.readContract({
    address: addrs().eure,
    abi: abis.MockToken, // ERC-20 surface; the real EURe answers the same calls
    functionName: "balanceOf",
    args: [orchestratorAddress],
  })) as bigint;
  if (held < amount) {
    // Better to say so here than to have Monerium reject an order for reasons
    // that read as a Monerium problem.
    throw new Error(
      `orchestrator holds ${eur.fromWei(held)} EURe but the payout needs ${payoutEur} — ` +
        `the debit did not land where the redeem expects it`,
    );
  }
  return writeAndWait(orchestratorWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "transfer",
    args: [userSafe, amount],
  });
}

/**
 * Return EURe the orchestrator is holding to a user's Safe.
 *
 * This is the refund leg for a Safe-funded transfer: the euros were taken out
 * of the user's own Safe, so that is where they go back. Deliberately NOT
 * gated on the chain issuing native EURe the way forwardEureForRedeem is — a
 * Safe-funded debit can only have happened where the Safe held the token in
 * the first place, so the same move is always available in reverse.
 *
 * Unlike the vault refund path this mints nothing, which is why it works off a
 * local chain: it hands back the very tokens that were moved.
 */
export async function returnEureToSafe(
  userSafe: `0x${string}`,
  amountEur: number,
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
  });
}

/** Has the vault already consumed this transferId? The vault path's replay
 *  guard is `require(!processedTransfer[transferId])` inside RemitVault.debit;
 *  the Safe path cannot write that registry but can still read it, so a
 *  transferId the vault already spent is refused rather than paid twice. */
export async function vaultProcessedTransfer(transferId: `0x${string}`): Promise<boolean> {
  return (await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "processedTransfer",
    args: [transferId],
  })) as boolean;
}

/** The vault's own daily-spend accounting for `user`, in EUR: the configured
 *  cap and what RemitVault.debit has already counted against it today. The
 *  contract keys the day as `block.timestamp / 1 days`, so this is UTC days
 *  since the epoch — the same boundary the API's own counter uses. */
export async function vaultDailySpend(
  user: `0x${string}`,
): Promise<{ capEur: number; debitedEur: number }> {
  const day = BigInt(Math.floor(Date.now() / 86_400_000));
  const [cap, debited] = (await Promise.all([
    publicClient.readContract({
      address: addrs().vault,
      abi: abis.RemitVault,
      functionName: "dailyCap",
    }),
    publicClient.readContract({
      address: addrs().vault,
      abi: abis.RemitVault,
      functionName: "debitedOnDay",
      args: [user, day],
    }),
  ])) as [bigint, bigint];
  return { capEur: eur.fromWei(cap), debitedEur: eur.fromWei(debited) };
}
