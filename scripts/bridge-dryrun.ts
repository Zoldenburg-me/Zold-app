/**
 * Bridge.xyz transfer plan: Base USDC -> Stellar-side USDC funding.
 *
 * Dry-run prints the Bridge-shaped request and deposit instructions without
 * touching funds or requiring partner credentials.
 *
 * Run: npm run bridge:dryrun [amountUsdc]
 */
import { BRIDGE } from "../services/api/src/config.js";
import { createBridgeTransfer } from "../services/api/src/bridge/bridgexyz.js";

const amount = Number(process.argv[2] ?? "10");

console.log(
  `Bridge.xyz ${BRIDGE.live ? "LIVE" : "dry-run"}: ${amount} USDC ${BRIDGE.sourceRail} -> ${BRIDGE.destinationRail}`,
);

const plan = await createBridgeTransfer(
  "script-dryrun",
  amount,
  {
    paymentRail: BRIDGE.destinationRail,
    currency: BRIDGE.destinationCurrency,
    toAddress: BRIDGE.destinationAddress || "bridge-dry-run-stellar-destination",
    ...(BRIDGE.destinationMemo ? { blockchainMemo: BRIDGE.destinationMemo } : {}),
  },
  { sourceAddress: "0x0000000000000000000000000000000000000000" },
);

console.log(`1. create transfer -> ${plan.transferId ?? plan.idempotencyKey} (${plan.state ?? plan.mode})`);
console.log(`2. source rail     -> ${plan.source.payment_rail} ${plan.source.currency}`);
console.log(`3. destination     -> ${plan.destination.payment_rail} ${plan.destination.currency}`);
console.log(`4. destination acct-> ${plan.destination.to_address}`);

if (plan.destination.blockchain_memo) console.log(`5. destination memo-> ${plan.destination.blockchain_memo}`);

if (plan.sourceDepositInstructions) {
  console.log("\nDeposit instructions");
  console.log(JSON.stringify(plan.sourceDepositInstructions, null, 2));
}

if (!BRIDGE.live) {
  console.log(
    "\nDRY RUN ONLY. Set BRIDGE_LIVE=1, BRIDGE_API_KEY, BRIDGE_ON_BEHALF_OF and a Bridge-approved destination to create a live transfer.",
  );
}
