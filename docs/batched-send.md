# One signature per send: batching the corridor into a single userOp

Sketch, not built. Written after the first live CCTP bridge (Aug 2026), which
made the transaction count concrete.

## What is true today

The user signs **once**: an EIP-712 `PaymentAuthorization` from their device
key. The current transitional executor still submits later on-chain legs from a
server key, so today's four transactions cost **gas and latency, not user
friction**.

That changes with FP4. Once the passkey Safe is the authorizer and
`fundingSource === "safe"`, the funds move from the user's Safe, and each Safe
operation needs its own passkey ceremony. That is where "four signatures per
send" becomes real, and it is worth designing away before it ships rather than
after.

## The batch

`createUserOperation` already accepts a `MetaTransaction[]` — see
`passkeySafeRecoverySetupTransactions`, which batches enable-module and
add-guardian into one userOp. Nothing new is needed in `wallet/candide.ts`.

```ts
const calls: MetaTransaction[] = [
  { to: eure,          value: 0n, data: approve(lifiApprovalAddress, amountIn) },
  { to: lifi.tx.to,    value: 0n, data: lifi.tx.data },
  { to: usdc,          value: 0n, data: approve(tokenMessenger, burnAmount) },
  { to: tokenMessenger,value: 0n, data: depositForBurnWithHook(burnAmount, …) },
];

const userOp = await account.createUserOperation(calls, rpcUrl, bundlerUrl, {
  expectedSigners: [passkeyOwner, cosignerAddress],
});
// one passkey ceremony over account.getUserOperationEip712Hash(userOp, chainId)
```

One signature, one atomic transaction, gas sponsored by the existing paymaster.

## Why this is worth more than the signature count

**Atomicity.** Today a failure between legs leaves an approval dangling and
USDC stranded mid-corridor — exactly the state FP3's compensation logic exists
to unwind. Batched, it all lands or none of it does, and there is nothing to
compensate.

## Three things that will bite

**1. LI.FI must be quoted FOR THE SAFE.** Its calldata assumes `msg.sender` is
the funded account. Inside a batch the caller is the Safe, so the quote must be
requested with `fromAddress = safeAddress` and the Safe must hold the EURe. A
quote taken for the orchestrator will revert here, and the revert will not say
why.

**2. The burn amount cannot depend on the swap's output.** A static batch has
no way to say "burn whatever the swap produced" — `amountOut` is not known when
the calldata is built. Options, cheapest first:

- Burn `minOut` (the quoted floor) and leave the surplus as dust in the Safe.
  Simple, and the dust is real user money that needs sweeping or accounting.
- A thin helper contract that reads its own USDC balance and burns all of it.
  One deploy, exact amounts, no dust — but it is another contract in the trust
  path and another thing to audit.
- Two userOps (swap, then burn) — back to two signatures, which is the thing
  being removed.

The dust option interacts with `applySurplus`: positive slippage that today
flows to the user would instead sit in the Safe unaccounted. Decide that
deliberately rather than discovering it as a balance drift.

**3. Bridge settlement is still async.** Batching removes signatures, not the
external funding wait. The userOp can make the swap and local debit atomic, but
Bridge/anchor settlement still has to be reconciled as a separate hosted rail
state before the payout is marked funded.

## Order of work

This lands **with** FP4, not before it: there is no Safe-funded swap to batch
until the Safe holds the funds and the passkey signs. The batching itself is
the cheap part — the `MetaTransaction[]` shape already works.

Permit (EIP-2612) is a separate, smaller win that composes with this: both EURe
(`0x29F37F6a…`) and USDC (`0x036CbD53…`) expose `nonces` and `permit` on Base
Sepolia — verified, not assumed — so each approve can become a signature
carried inside the next call rather than its own transaction. Four calls become
two even before batching.
