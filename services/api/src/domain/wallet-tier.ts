/**
 * What a wallet feature asks of an account: an on-chain balance in its
 * segment. Not a partner's KYC verdict.
 *
 * Wallet features are operations the user signs from their own Safe (a
 * deposit conversion swaps their USDC into EURe and keeps it there). They are
 * not fiat rails, so Monerium approval is not their gate, and a rejected or
 * pending account keeps the wallet (docs/wallet-tier.md). Fiat routes keep
 * requireKycApproved.
 *
 * A user with no segment predates segmentation and is treated as EU_FULL, as
 * requireCapability does.
 */
import type { User } from "../store/types.js";
import { can } from "./segments.js";

export function walletBlocker(user: Pick<User, "segment">): string | null {
  if (can(user.segment?.value ?? "EU_FULL", "onchain_balance")) return null;
  return "an on-chain balance is not part of your account";
}
