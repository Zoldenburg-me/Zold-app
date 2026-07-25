/**
 * Stellar payout account setup — MoneyGram's three steps, checkable.
 *
 * Their guide is: fund the account with XLM, add the asset's trustline, then
 * acquire the asset. Steps 1 and 3 need real funds and are yours; step 2 is
 * code, and this does it.
 *
 * Why it matters: Stellar refuses to deliver an asset an account does not
 * trust. Without the trustline a CCTP mint destroys USDC on the source chain
 * and lands nothing, and an anchor refund has nowhere to go.
 *
 *   npm run stellar:setup          # report only
 *   npm run stellar:setup -- --fix # create a missing trustline
 */
import { Asset } from "@stellar/stellar-sdk";
import { STELLAR, anchorModeEnabled } from "../services/api/src/config.js";
import {
  accountReserves,
  anchorPayoutReadiness,
  baseReserveXlm,
  ensureTrustline,
  getTreasury,
  hasTrustline,
  stellarAssetForAnchor,
} from "../services/api/src/stellar/anchor.js";

const fix = process.argv.includes("--fix");
const domain = STELLAR.anchorDomain;

if (!anchorModeEnabled()) {
  console.log("MG_ANCHOR_DOMAIN is unset — cash payouts are mocked, no Stellar account needed.");
  console.log("Set it (testanchor.stellar.org, or MoneyGram's domain) and re-run.");
  process.exit(0);
}

const treasury = await getTreasury();
const asset = await stellarAssetForAnchor(domain, STELLAR.anchorAsset);
const base = await baseReserveXlm();

console.log(`anchor    : ${domain}`);
console.log(`asset     : ${asset.isNative() ? "native XLM" : `${asset.getCode()} / ${asset.getIssuer()}`}`);
console.log(`treasury  : ${treasury.publicKey()}`);

let reserves;
try {
  reserves = await accountReserves(treasury.publicKey());
} catch {
  console.error(`\nThe treasury account does not exist on this network.`);
  console.error(`Fund ${treasury.publicKey()} with XLM first (testnet: friendbot).`);
  process.exit(1);
}

console.log(
  `balance   : ${reserves.balanceXlm} XLM · ${reserves.minimumXlm} locked as reserve ` +
    `(${reserves.subentries} entr${reserves.subentries === 1 ? "y" : "ies"}) · ` +
    `${reserves.spendableXlm.toFixed(4)} spendable`,
);
console.log(`base reserve: ${base} XLM — every trustline locks this much\n`);

const trusted = await hasTrustline(treasury.publicKey(), asset);
if (trusted) {
  console.log(`✓ trustline for ${asset.isNative() ? "XLM" : asset.getCode()} is in place`);
} else if (fix) {
  console.log(`… no trustline for ${asset.getCode()}; creating one`);
  const r = await ensureTrustline(treasury, asset);
  console.log(`✓ trustline created (tx ${r.hash}) · reserve now ${r.reserves.minimumXlm} XLM`);
} else {
  console.log(`✗ no trustline for ${asset.getCode()} — the account cannot receive it.`);
  console.log(`  Re-run with --fix to create one (locks ${base} XLM).`);
}

const readiness = await anchorPayoutReadiness(domain, STELLAR.anchorAsset, treasury.publicKey());
console.log(`\nreadiness : ${readiness.ready ? "READY" : "NOT READY"}`);
for (const p of readiness.problems) console.log(`  · ${p}`);

if (readiness.ready) {
  console.log(
    `\nThe account can receive ${readiness.asset}. Still yours to do: hold enough of it to\n` +
      `cover a payout — this checks capability, not balance.`,
  );
}
process.exit(readiness.ready ? 0 : 1);
