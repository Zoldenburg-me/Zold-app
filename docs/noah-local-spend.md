# Noah Local Spend Integration

Noah is the planned expansion layer for local spend after the current SEPA and
MoneyGram paths. The integration should not hardcode a coverage table. Noah's
Business API exposes sell-side channel discovery:

- `GET /channels/sell/countries` for supported payout countries and currencies.
- `GET /channels/sell` for available channels for a country/currency/amount.
- Channel responses include `PaymentMethodCategory`, `PaymentMethodType`,
  limits, processing time, pricing and a JSON form schema.
- `GET /channels/:ChannelID/form` can be used when a fresh form schema is
  needed after channel selection.

Product framing:

- Use "local spend" for the user-facing promise.
- Use examples such as PIX, UPI, SPEI, bank transfer, mobile money, digital
  wallets and cash pickup.
- Treat channel IDs, limits, fees and required fields as runtime data.
- Do not claim a country or rail is live until Noah returns it for the user's
  jurisdiction and amount, and compliance approval covers that corridor.

Production gates:

- Noah account approval and API credentials.
- Reliance Model approval for sharing user KYC/KYB, or Hosted Onboarding.
- Dynamic form rendering before transaction submission.
- Corridor-specific legal, sanctions, source-of-funds and partner review.
- Receipt copy that distinguishes Monerium euro account activity from Noah
  local payout execution.
