/**
 * Testnet faucet — grant each passkey Safe EURe from the faucet wallet
 * (FAUCET_KEY), so a test account has something to send.
 *
 * The grant is a plain ERC-20 transfer, so the crypto-in scanner records it
 * like any other inbound Safe funding and it shows up in Activity — nothing
 * here writes balances or invents money the chain does not show.
 *
 * Money-safety rules, in order of importance:
 *  - config.ts refuses to start with FAUCET_KEY or TESTNET_FAUCET_EUR on a
 *    chain where EURe is real money or in production; this file re-checks;
 *  - off unless both the key and a positive grant are set;
 *  - one grant per account, claimed synchronously before the first await
 *    (the authorize-race lesson), so two calls cannot pay twice;
 *  - a dry faucet or an RPC failure releases the claim and reports — a faucet
 *    problem must never break onboarding.
 */
import { CHAIN_ID, IS_PRODUCTION, IS_REAL_MONEY_CHAIN, TESTNET_FAUCET } from "./config.js";
import { abis, addrs, eur, faucetWallet, publicClient, writeAndWait } from "./chain.js";
import { store } from "./store.js";

export function faucetEnabled(): boolean {
  return Boolean(faucetWallet) && TESTNET_FAUCET.grantEur > 0 && !IS_PRODUCTION && !IS_REAL_MONEY_CHAIN;
}

export type FaucetResult =
  | { ok: true; grantedEur: number; txHash: string }
  | { ok: false; code: "FAUCET_OFF" | "NO_SAFE" | "ALREADY_GRANTED" | "FAUCET_DRY" | "FAUCET_FAILED"; error: string };

export async function faucetFundSafe(userId: string): Promise<FaucetResult> {
  if (!faucetEnabled() || !faucetWallet) return { ok: false, code: "FAUCET_OFF", error: "no faucet on this deployment" };
  const user = store.findUser(userId);
  if (!user?.wallet?.deployed) return { ok: false, code: "NO_SAFE", error: "deploy your smart wallet first" };
  const to = user.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/.test(to)) {
    return { ok: false, code: "NO_SAFE", error: "deploy your smart wallet first" };
  }
  if (user.faucet) return { ok: false, code: "ALREADY_GRANTED", error: "this account already received its test EURe" };
  // Claim before the first await: nothing yields between the check above and
  // this write, so a concurrent second call sees the claim and returns.
  const grantEur = TESTNET_FAUCET.grantEur;
  store.updateUser(user.id, { faucet: { grantedEur: grantEur, txHash: "", at: new Date().toISOString() } });
  const from = faucetWallet.account.address;
  try {
    const grantWei = eur.toWei(grantEur);
    const have = (await publicClient.readContract({
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [from],
    })) as bigint;
    if (have < grantWei) {
      // Release the claim: nothing was sent, so a top-up plus retry can still
      // fund this account.
      store.updateUser(user.id, { faucet: undefined });
      console.warn(`faucet: ${from} holds ${eur.fromWei(have)} EURe on chain ${CHAIN_ID}, below the ${grantEur} EURe grant — top it up; skipped ${user.id}`);
      return { ok: false, code: "FAUCET_DRY", error: "the test faucet is empty — try again later" };
    }
    const txHash = await writeAndWait(faucetWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "transfer",
      args: [to, grantWei],
    });
    store.updateUser(user.id, { faucet: { grantedEur: grantEur, txHash, at: new Date().toISOString() } });
    console.log(`faucet: ${grantEur} EURe -> ${to} (${user.id}) ${txHash}`);
    return { ok: true, grantedEur: grantEur, txHash };
  } catch (err: any) {
    store.updateUser(user.id, { faucet: undefined });
    console.error(`faucet: funding ${user.id} failed: ${err?.message ?? err}`);
    return { ok: false, code: "FAUCET_FAILED", error: "the test faucet could not send — try again later" };
  }
}
