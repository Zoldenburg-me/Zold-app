/**
 * Monerium adapter (mock mode).
 *
 * Production shape: Monerium's API issues each user a personal IBAN linked to
 * their wallet; a SEPA transfer to it mints EURe on-chain automatically and
 * fires a webhook. Here we mock both halves: IBAN issuance is local, and the
 * "SEPA arrived" webhook is simulated by an endpoint that mints mock EURe to
 * the RemitVault and credits the user's ledger balance.
 */
import { keccak256, toHex } from "viem";
import { abis, addrs, deployerWallet, eur, rampWallet, writeAndWait } from "../chain.js";

/** Deterministic mock IBAN (Iceland format, like Monerium's). */
export function issueIban(userId: string): string {
  const digits = BigInt(keccak256(toHex(`iban:${userId}`)))
    .toString()
    .replace(/\D/g, "")
    .slice(0, 18)
    .padEnd(18, "0");
  return `IS14 0159 ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12, 16)}`;
}

/**
 * Simulate the SEPA-deposit-arrived webhook: mint EURe to the vault, then
 * credit the user's balance. Returns the tx hashes.
 */
export async function simulateSepaDeposit(
  userAddress: `0x${string}`,
  amountEur: number,
  paymentRef: string,
) {
  const a = addrs();
  const wei = eur.toWei(amountEur);

  // On a chain where Monerium issues the real EURe, we are not the token's
  // owner and cannot mint it — and must not try. The euros already exist, in
  // the user's Safe; they need moving, not creating.
  const { moneriumEure } = await import("./monerium-tokens.js");
  const { MONERIUM } = await import("../config.js");
  const { CHAIN_ID } = await import("../config.js");
  if (await moneriumEure(MONERIUM.baseUrl, CHAIN_ID)) {
    throw new Error(
      `refusing to mint on chain ${CHAIN_ID}: Monerium issues the real EURe there. ` +
        `Use creditDepositFromSafe() — a deposit lands in the user's Safe and is moved, not minted.`,
    );
  }

  // MockToken minting is owner-only (the deployer); the credit itself is the
  // ramp role, mirroring the real split between issuer and ramp adapter.
  const mintHash = await writeAndWait(deployerWallet, {
    address: a.eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [a.vault, wei],
  });

  const creditHash = await writeAndWait(rampWallet, {
    address: a.vault,
    abi: abis.RemitVault,
    functionName: "creditDeposit",
    args: [userAddress, wei, keccak256(toHex(paymentRef))],
  });

  return { mintHash, creditHash };
}

/**
 * Credit a deposit that already exists as real EURe in the user's Safe.
 *
 * This is the native-token counterpart to simulateSepaDeposit. Monerium mints
 * its own EURe straight into the Safe when a SEPA transfer lands, so there is
 * nothing to create — but RemitVault.creditDeposit refuses a credit it cannot
 * cover ("uncovered credit"), so the euros must reach the vault first.
 *
 * Order matters: move first, credit second. Crediting first would fail the
 * coverage check; and if the move succeeds but the credit does not, the money
 * is in the vault uncredited — visible to the reconciler as vault holdings
 * exceeding totalCredited, which is the recoverable direction. The reverse
 * would be a credit backed by nothing.
 */
export async function creditDepositFromSafe(
  user: { address: `0x${string}`; privateKey?: string },
  amountEur: number,
  paymentRef: string,
) {
  const a = addrs();
  const wei = eur.toWei(amountEur);
  if (!user.privateKey) throw new Error("user has no wallet key — cannot move the deposit");

  const { transferTokenFromSafe } = await import("../wallet/candide.js");
  const moveHash = await transferTokenFromSafe({
    ownerKey: user.privateKey as `0x${string}`,
    token: a.eure,
    to: a.vault,
    amount: wei,
  });

  const creditHash = await writeAndWait(rampWallet, {
    address: a.vault,
    abi: abis.RemitVault,
    functionName: "creditDeposit",
    args: [user.address, wei, keccak256(toHex(paymentRef))],
  });

  return { moveHash, creditHash };
}
