<!-- Generated: 2026-10-05 | Files scanned: 36 (TypeSafe Jev remittance score >= 2.5) + their callers | Token estimate: ~1000 -->
# Remittance (send money to a recipient)

Two rails, picked per quote: **sepa** (EURe → IBAN via a Monerium redeem; open)
and **cash** (EURe → USDC → Bridge.xyz → Stellar anchor pickup; CLOSED unless
`cashRailOpen()`). What has never run: `docs/status.md`.

## Request path
```
app/send.js, app/phone-send.js          business/send.js → drafts (four eyes)
  │ POST /api/quotes {rail,sendEur}        │ routes/business/drafts.ts:480
  ▼                                        │  createQuote(rail "sepa") + buildTransferFromQuote
routes/transfers.ts  /quotes  ── refuses: cash closed 503 · sepa without Monerium 409 ·
  │                                amount ≤ rail fee · over FX.DAILY_CAP_EUR
  ▼ fx.ts createQuote ── rates.ts (independent mid) + liquidity quote
  │ POST /api/transfers {quoteId, recipientName, recipientIban | recipientPhone, reference}
  ▼
transfers/build.ts buildTransferFromQuote   (the ONE builder)
  - quote OPEN and not expired, recipient validated
  - destinationCommitment(rail): the chain enforces token, amount, destination
  - prepares the Safe userOp = the debit (fee only on sepa; fee+approve+swap batch on cash)
  - sepa: Monerium redeem terms (moneriumRedeem) to sign; cash: may create the Bridge transfer
  - pending execution held in http/pending.ts            → transfer CREATED
  │ POST /api/transfers/:id/authorize {signature, executionAssertion, moneriumRedeem*}
  ▼
routes/transfers.ts authorize: session · state CREATED · auth.deadline · KYC approved ·
  passkey assertion over the pending challenge (signCount) · one-shot claim
  ├─ rail sepa → orchestrator.executeSepaTransfer
  └─ rail cash → orchestrator.executeTransfer
```

## SEPA rail (orchestrator.ts:913)
```
moneriumLiveFor(user)? no → refuse BEFORE the fee debit
debitSafeFundedSepaFee (user-signed userOp)                  → DEBITED
adapters/monerium-sandbox.redeemToIban (Safe signs EIP-1271,
  memo = sepa.ts paymentMemo(id, reference))                 → PAYOUT_SUBMITTED
pollRedeemOrdersOnce (Monerium poll tick): processed → PAID · rejected/failed → FAILED
```
Redeem error: 4xx → failAndCompensate (refund); timeout/5xx → MANUAL_REVIEW.

## Cash rail (orchestrator.ts:687)
```
cashRailOpen()? no → refuse, nothing debited
batch path: quote expiry · assertQuoteRateBinding · debitInputFunds
  → venue delivers USDC, measured as balance delta            → SWAPPED
plain path: debitInputFunds · assertQuoteRateBinding ·
  liquidity.prepareTransferLiquidity / executeTransferLiquidity → SWAPPED
bridge/bridgexyz.createBridgeTransfer + USDC deposit          → BRIDGED
adapters/moneygram.createCashPickupViaAnchor (stellar/anchor.ts, sep9 KYC fields)
  → PAYOUT_DETAILS_PENDING / _FUNDING_PENDING / _FUNDED / _READY
refreshPayout / sweepAnchorPayouts → settlePickup             → PAID
```

## Swap venues (liquidity.ts → liquidity/*)
best.ts (picks over lifi, dex; default `best`) · lifi.ts · uniswap.ts (v3 per chain) ·
cow.ts · rfq.ts (Bebop) · fx-swapper.ts (31337) · contract.ts (types) ·
config/liquidity.ts (venues, allowlists LIFI_CONTRACTS/BEBOP_CONTRACTS).
Every venue quote → assertPriceSane against rates.ts.

## State machine (store/types.ts TransferState)
```
CREATED → DEBITED → SWAPPED → BRIDGED → PAYOUT_* → PAID      (cash)
CREATED → DEBITED → PAYOUT_SUBMITTED → PAID                   (sepa)
any → FAILED → REFUNDED (compensateTransfer) | MANUAL_REVIEW
```
store.updateTransfer refuses to move REFUNDED/PAID backwards.

## Background (server.ts)
sweepStrandedTransfers (boot + 5 min, compensation) · sweepAnchorPayouts ·
Monerium poll (deposits, redeem orders) · reconcile (15 min; reports drift, never repairs).

## After the send
receipt.ts + routes/receipt-shares.ts (/r/:slug) · documents.ts (receipt doc) ·
bookkeeping/statement.ts (sepa_out lines; PAYOUT_SUBMITTED tagged "submitted").

## Tests (scripts/, `npm run check`)
quote-binding · custody · best-execution · exact-output · safe-execution ·
passkey-safe-plan · authorize-claim · refund-guard · final-state · draft-execution ·
draft-batch-failure · sepa-reference · travel-rule · anchor-* · trustline · lifi · dex · fx-rates
