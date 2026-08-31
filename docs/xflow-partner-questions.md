# Xflow — questions for the partner team

Deliverable 4 of the residency/segmentation task: everywhere the public docs
were insufficient, and the exact questions to ask.

Read against `https://docs.xflowpay.com` — the Exports **platform users**
guide, the API reference, the error codes and the OpenAPI spec — in Aug 2026.
Everything not listed here was answered by the docs and is implemented against
them.

Ordered so that a "no" to Q1 makes most of the rest moot.

---

## The email

> **Subject:** Platform eligibility + integration questions — Zold (Zoldenburg UG)
>
> Hello,
>
> We're Zold, a self-custodial business account. Our EU users get a euro IBAN
> and a card through Monerium and Gnosis Pay. Indian residents can't hold EUR
> on-chain, so we want to give them an export-collections experience instead,
> embedded in our app, with Xflow doing the regulated work. We've built against
> your Exports platform guide and have the connected-user flow mapped end to
> end.
>
> Before we go further, seven questions. The first two decide whether we can
> proceed at all.
>
> **1. Eligibility.** Your platform guide says you support "platforms
> incorporated in India or [that] have an Indian entity that we can onboard."
> Zoldenburg UG is German and has no Indian entity today. Is there any path to a
> platform account without incorporating in India — or is that a firm
> prerequisite we should plan around?
>
> **2. Connect-an-existing-account.** Is there a mode where an Indian business
> that is already your direct customer authorises a third-party platform to act
> on their account — an OAuth-style consent grant — rather than us creating
> connected users under our platform account? We already do exactly this with
> Monerium and Gnosis Pay, and if it exists it may suit us better than the
> platform model.
>
> **3. Platform pricing.** Your published plans (Starter/Growth/Scale) are for
> direct customers. What does a platform pay, and is it also priced per invoice?
> We'd want to understand that before setting our own `fee_plans`.
>
> **4. Webhook signatures.** The API reference points at a webhooks guide for
> setup, but we couldn't find the signature scheme — header name, algorithm, and
> how the secret is issued and rotated. Our handler currently fails closed and
> refuses every webhook until this is configured; we'd rather not ship it any
> other way.
>
> **5. Rejections and `input_required`.** When KYB/KYC or a receivable needs
> more information, do you return structured, field-level requirements on the
> account or receivable object that we can render in our own UI? Your error copy
> for `receivable_additional_info_required` tells the user to email
> support@xflowpay.com or check their mail — since our users experience this as
> our product, we'd like to show them exactly what's missing in-app. Relatedly:
> do you email connected users directly, on which events, and can that be
> suppressed or routed to us?
>
> **6. Receivable-first, or standing account?** Can funds land on an
> `xflow_receive` VBAN with no pre-existing receivable and be reconciled
> afterwards, or must every payment be pre-declared with a purpose code? This
> decides whether we present "here are your bank details" or an invoice-first
> flow.
>
> **7. Field-level gaps.** Four small ones we had to guess at or stub:
>
> - Which field carries the **FIRA/eFIRA** document, and is `payout_confirmation`
>   on the payout object that document or something else?
> - The **IFSC** field name on an INR payout address. Your example uses
>   `bank_account.global_wire` with a SWIFT BIC on a USD EEFC account, and the
>   bank_account object doesn't list an IFSC field.
> - For `business_details.type = "individual"`, does the **personal PAN** go in
>   `business_details.ids.tax` (documented as "Business PAN"), or on the person
>   object?
> - Is **GSTIN** optional for individuals? The docs say it's mandatory for
>   partnerships and are silent otherwise.
>
> Happy to share our integration plan if useful. We're building against testmode
> either way, so answers to 4–7 unblock implementation and 1–2 decide the shape.
>
> Thanks,
> Tony Thomas — Zoldenburg UG

---

## What each answer changes in the code

| Q | If yes | If no |
|---|---|---|
| 1 | Platform integration proceeds; `IN_COLLECTIONS` ungates | Segment stays gated indefinitely, or Q2 saves it |
| 2 | **Rebuild as the Gnosis Pay / Monerium pattern** — user connects their own account, no entity needed, much less code | Platform model only |
| 3 | Sets `fee_plans` values and the margin we can show | We cannot price the segment |
| 4 | Implement `verifyXflowSignature()` | Handler stays fail-closed and the webhook route is dead |
| 5 | Render requirements in-app | Error states must point the user at Xflow's support, not ours |
| 6 | "Get paid" is a bank-details screen | "Get paid" is invoice-first |
| 7 | Fill the four stubs | Four TODOs ship |

## Standing TODOs in the code

Each is marked `TODO(xflow)` at its site.

- `verifyXflowSignature()` — fails closed, refuses everything. **Q4.**
- IFSC field on the payout address. **Q7.**
- FIRA document retrieval. **Q7.**
- Individual PAN and GSTIN optionality. **Q7.**
- Purpose codes: `P0104` / `P0105` shipped as a config list; a `/purpose-codes`
  endpoint is referenced in the guide but not specified.
- No payment link or hosted checkout exists in the docs, so none is offered.

## Not a gap, recorded so it is not re-litigated

- **White-label is real.** "The flows are completely white-labelled… no
  redirection outside the app", and connected users get no Xflow dashboard.
- **The API is Stripe Connect-shaped** (`Xflow-Account` header, `fee_plans`,
  `accounts`/`persons`/`files`, `tos_acceptance`). Stripe is an investor. If you
  know Connect, you know this.
- **Xflow is named to the user regardless**: their Connected User ToS must be
  embedded in ours, and the stablecoin capability adds a second named third
  party (Bridge.xyz) via `start_tos`/`accept_tos`.
- **The eFIRA cannot be branded.** It is issued by the AD-1 bank and is the
  artifact the user actually needs for GST.
