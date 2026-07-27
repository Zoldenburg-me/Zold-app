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
import { CHAIN_ID, KEYS, RPC_URL, loadAbi, loadDeployments, type Deployments } from "./config.js";
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
 * money actually leaves the system on a fiat leg (SEPA IBAN, UPI VPA, cash
 * pickup phone) the contract can never see. Folding a hash of that target into
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
 *   upi  → "upi|vpa=<vpa>|name=<NAME>"       (vpa trimmed, lower-cased)
 * where <NAME> is trimmed, inner whitespace collapsed, upper-cased.
 * Keep this in lockstep with destinationCommitment() in public/device.js.
 */
export function destinationCommitment(
  rail: PayoutRail,
  target: { phone?: string; iban?: string; vpa?: string; name?: string },
): `0x${string}` {
  const name = (target.name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  let preimage: string;
  if (rail === "sepa") {
    preimage = `sepa|iban=${(target.iban ?? "").replace(/\s/g, "").toUpperCase()}`;
  } else if (rail === "upi") {
    preimage = `upi|vpa=${(target.vpa ?? "").trim().toLowerCase()}`;
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
