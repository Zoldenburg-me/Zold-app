/**
 * Testnet faucet — seed each newly deployed passkey Safe with EURe from the
 * deployer wallet, so a fresh test account has something to send.
 *
 * The grant is a plain ERC-20 transfer, so the crypto-in scanner records it
 * like any other inbound Safe funding and it shows up in Activity — nothing
 * here writes balances or invents money the chain does not show.
 *
 * Money-safety rules, in order of importance:
 *  - refuses production mode and every chain where EURe is real money,
 *    regardless of configuration — the deployer would be sending real euros;
 *  - disabled unless TESTNET_FAUCET_EUR is set to a positive amount;
 *  - one grant per account, claimed synchronously before the first await,
 *    so a double deployment completion cannot pay twice;
 *  - a dry deployer or an RPC failure logs and skips — a faucet problem must
 *    never break onboarding, which worked before the faucet existed.
 */
import { CHAIN_ID, IS_PRODUCTION, TESTNET_FAUCET } from "./config.js";
import { abis, addrs, deployerWallet, eur, publicClient, writeAndWait } from "./chain.js";
import { store } from "./store.js";

/** Chains where EURe is real money (Monerium production /tokens): ethereum,
 *  gnosis, polygon, base, arbitrum, linea. */
const REAL_MONEY_CHAINS = new Set([1, 100, 137, 8453, 42161, 59144]);

export function faucetEnabled(): boolean {
  return TESTNET_FAUCET.grantEur > 0 && !IS_PRODUCTION && !REAL_MONEY_CHAINS.has(CHAIN_ID);
}

export async function faucetFundSafe(userId: string): Promise<void> {
  if (!faucetEnabled()) return;
  const user = store.findUser(userId);
  if (!user) return;
  if (user.faucet) return; // already granted (or in flight)
  const to = user.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/.test(to)) return;
  // Claim before the first await: nothing yields between the check above and
  // this write, so a concurrent second call sees the claim and returns.
  store.updateUser(user.id, {
    faucet: { grantedEur: TESTNET_FAUCET.grantEur, txHash: "", at: new Date().toISOString() },
  });
  try {
    const grantWei = eur.toWei(TESTNET_FAUCET.grantEur);
    const have = (await publicClient.readContract({
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [deployerWallet.account.address],
    })) as bigint;
    if (have < grantWei) {
      // Release the claim: nothing was sent, and a later top-up plus retry
      // should still be able to fund this account.
      store.updateUser(user.id, { faucet: undefined });
      console.warn(
        `faucet: deployer ${deployerWallet.account.address} holds ${eur.fromWei(have)} EURe, ` +
          `below the ${TESTNET_FAUCET.grantEur} EURe grant — top it up; skipped ${user.id}`,
      );
      return;
    }
    const txHash = await writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "transfer",
      args: [to, grantWei],
    });
    store.updateUser(user.id, {
      faucet: { grantedEur: TESTNET_FAUCET.grantEur, txHash, at: new Date().toISOString() },
    });
    console.log(`faucet: ${TESTNET_FAUCET.grantEur} EURe -> ${to} (${user.id}) ${txHash}`);
  } catch (err: any) {
    store.updateUser(user.id, { faucet: undefined });
    console.error(`faucet: funding ${user.id} failed: ${err?.message ?? err}`);
  }
}
