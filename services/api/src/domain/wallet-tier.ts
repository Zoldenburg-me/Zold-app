/**
 * What a wallet feature asks of an account's identity: nothing, unless a
 * partner has refused or is still reviewing it.
 *
 * Wallet features are operations the user signs from their own Safe (a
 * deposit conversion swaps their USDC into EURe and keeps it there). They are
 * not fiat rails, so Monerium approval is not their gate; fiat routes keep
 * requireKycApproved. A rejected or manual-review account is refused here
 * until an owner decides otherwise (docs/wallet-tier.md).
 */
import type { User } from "../store/types.js";

export function walletBlocker(user: Pick<User, "kycStatus">): string | null {
  if (user.kycStatus === "rejected") {
    return "your account did not pass verification, so this is not available";
  }
  if (user.kycStatus === "manual_review") {
    return "your account's verification is under review — this opens once the review is finished";
  }
  return null;
}
