/**
 * Monerium adapter (mock mode).
 *
 * Production shape: Monerium's API issues each user a personal IBAN linked to
 * their wallet; a SEPA transfer to it mints EURe on-chain automatically and
 * fires a webhook. Here we mock both halves: IBAN issuance is local, and the
 * "SEPA arrived" webhook is simulated by an endpoint that mints mock EURe to
 * the user's Safe. The Safe is the account of record.
 */
import { keccak256, toHex } from "viem";
import { abis, addrs, deployerWallet, eur, writeAndWait } from "../chain.js";

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
 * Simulate the SEPA-deposit-arrived webhook: mint EURe to the user's Safe.
 * Returns the tx hash.
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
        `A deposit lands in the user's Safe directly; do not mint a mock token there.`,
    );
  }

  const mintHash = await writeAndWait(deployerWallet, {
    address: a.eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [userAddress, wei],
  });

  return { mintHash, depositRef: keccak256(toHex(paymentRef)) };
}

/**
 * A real Monerium deposit already exists as EURe in the user's Safe. The order
 * id is marked processed by the caller after this confirms the target user
 * exists.
 */
export async function creditDepositFromSafe(
  user: { address: `0x${string}` },
  amountEur: number,
  paymentRef: string,
) {
  return { safeAddress: user.address, amountEur, depositRef: keccak256(toHex(paymentRef)) };
}
