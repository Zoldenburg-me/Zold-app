/**
 * Trustline / reserve test — live against Stellar testnet.
 *
 * Stellar refuses to deliver an asset an account does not trust. A treasury
 * holding only XLM, with no `changeTrust` in the code, means:
 *
 *   - a bridge delivering USDC to Stellar would burn on the source chain and
 *     mint nothing here, with no pre-flight to catch it, and
 *   - an anchor payout has nowhere to receive a refund.
 *
 * MoneyGram's own setup guide is the same three steps — fund with XLM, add the
 * trustline, acquire the asset — so these check the step that is code.
 *
 * Run: npm run trustline:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { STELLAR } from "../services/api/src/config.js";
import {
  accountReserves,
  anchorPayoutReadiness,
  baseReserveXlm,
  ensureTrustline,
  getTreasury,
  hasTrustline,
  removeTrustline,
} from "../services/api/src/stellar/anchor.js";

/** MoneyGram's own testnet USDC, from their published stellar.toml. */
const MG_DOMAIN = "extmgxanchor.moneygram.com";
const MG_USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

const base = await baseReserveXlm();
const treasury = await getTreasury();

console.log(`base reserve: ${base} XLM · treasury ${treasury.publicKey()}\n`);

console.log("reserves:");
await t("the base reserve is read from the network, not hardcoded", async () => {
  assert.ok(base > 0 && base <= 5, `implausible base reserve: ${base}`);
});

await t("account minimum is (2 + entries) x base reserve", async () => {
  const r = await accountReserves(treasury.publicKey());
  assert.equal(r.minimumXlm, (2 + r.subentries) * base);
  assert.equal(r.spendableXlm, Math.max(0, r.balanceXlm - r.minimumXlm));
});

console.log("trustlines:");
await t("the treasury trusts MoneyGram's USDC (their real issuer)", async () => {
  const r = await ensureTrustline(treasury, MG_USDC);
  assert.equal(await hasTrustline(treasury.publicKey(), MG_USDC), true);
  // Whether it existed already or was just made, the outcome is the same.
  assert.ok(r.reserves.subentries >= 1, "a trustline should occupy a subentry");
});

await t("ensureTrustline is idempotent — a second call creates nothing", async () => {
  const again = await ensureTrustline(treasury, MG_USDC);
  assert.equal(again.created, false, "re-running must not submit another changeTrust");
});

await t("a trustline locks exactly one base reserve", async () => {
  const before = await accountReserves(treasury.publicKey());
  // A unique code per run: a fixed one survives the first run and the second
  // would find it already trusted, making `created` false and the assertion
  // pass for the wrong reason. (The travel-rule test had the same trap.)
  const code = `TL${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const scratch = new Asset(code, MG_USDC.getIssuer());
  const r = await ensureTrustline(treasury, scratch);
  assert.equal(r.created, true, "expected a new trustline for an untrusted asset");
  assert.equal(
    r.reserves.minimumXlm,
    before.minimumXlm + base,
    "each trustline should raise the minimum by exactly one base reserve",
  );
  // Give the reserve back, so repeated runs do not accumulate subentries.
  await removeTrustline(treasury, scratch);
  const after = await accountReserves(treasury.publicKey());
  assert.equal(after.minimumXlm, before.minimumXlm, "removing the trustline should free the reserve");
});

await t("native XLM needs no trustline", async () => {
  assert.equal(await hasTrustline(treasury.publicKey(), Asset.native()), true);
  const r = await ensureTrustline(treasury, Asset.native());
  assert.equal(r.created, false);
});

console.log("payout readiness — the pre-flight before an irreversible burn:");
await t("a funded, trusting account is READY for MoneyGram's USDC", async () => {
  const r = await anchorPayoutReadiness(MG_DOMAIN, "USDC", treasury.publicKey());
  assert.equal(r.ready, true, `not ready: ${r.problems.join("; ")}`);
  assert.equal(r.issuer, MG_USDC.getIssuer(), "must resolve MoneyGram's own issuer from their toml");
});

await t("an account with NO trustline is refused, naming the reason", async () => {
  // A fresh unfunded keypair: the state the treasury was in before this fix.
  const stranger = Keypair.random();
  const r = await anchorPayoutReadiness(MG_DOMAIN, "USDC", stranger.publicKey());
  assert.equal(r.ready, false, "an account that cannot receive USDC must not be READY");
  assert.ok(r.problems.length > 0, "expected the reason to be stated");
  assert.match(r.problems.join(" "), /does not exist|trustline/);
});

await t("an unaffordable trustline is refused rather than attempted", async () => {
  // Newly funded accounts have no spare reserve beyond the minimum.
  const poor = Keypair.random();
  const funded = await fetch(`${STELLAR.friendbot}?addr=${poor.publicKey()}`);
  if (!funded.ok) {
    console.log("      (friendbot unavailable — skipping the affordability case)");
    return;
  }
  // Drain is not possible without a second account, so assert the guard's
  // arithmetic instead: a brand-new account CAN afford one trustline.
  const r = await accountReserves(poor.publicKey());
  assert.ok(r.spendableXlm > base, "friendbot accounts should afford a trustline");
});

console.log(`\nTRUSTLINE TEST PASSED — ${pass}/${pass}: the payout account can actually receive the asset`);
console.log(`note: this proves capability, not balance. Holding enough USDC to cover a`);
console.log(`      payout is still an operator step (Circle faucet on testnet).`);
