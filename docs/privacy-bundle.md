# Premium Privacy Bundle

## Decision

Sell Kokio eSIM and Mysterium VPN as a capped monthly add-on named `Privacy Bundle`, not as unlimited privacy. The first release should be a controlled commercial wrapper around partner provisioning, with no automatic live fulfillment until wholesale costs, regions, refund rules, and support ownership are signed.

## Why Bundle

The product fits users who already trust Zoll for cross-border money movement: travel, public Wi-Fi, roaming, and financial privacy are adjacent needs. The bundle is easiest to understand when positioned as "private connection while you travel", not as a technical crypto/network product.

Kokio provides the eSIM side. Public materials describe a blockchain-powered eSIM project and SDK/smart-contract suite for eSIM wallet interactions. Mysterium provides the decentralized VPN side, with developer APIs/SDKs and a residential-IP network marketed across many countries. Both should be treated as partner services, not core wallet infrastructure.

## Pricing

Keep usage capped so the margin cannot be destroyed by heavy travelers or VPN abuse.

| Plan | Price | Included eSIM | Included VPN | Margin Guard |
| --- | ---: | ---: | ---: | --- |
| Travel Shield | EUR 9.99/mo | 3 GB regional | 25 GB, 3 devices | estimated vendor cost must stay <= EUR 6.49 |
| Global Shield | EUR 19.99/mo | 10 GB global | 100 GB, 5 devices | estimated vendor cost must stay <= EUR 12.99 |
| Nomad Shield | EUR 34.99/mo | 25 GB global | 250 GB, 10 devices | estimated vendor cost must stay <= EUR 22.74 |

Default config uses a 35% gross-margin floor. If actual partner cost makes a plan fall below that floor, the API refuses new subscriptions for that plan instead of selling at a loss.

## Fulfillment Model

Phase 1:

- Add plan catalog and user subscription state.
- Show eSIM/VPN fulfillment as pending unless `KOKIO_LIVE=1` and `MYSTERIUM_LIVE=1`.
- Track included allowance and usage counters per billing period.
- Cancel by marking the bundle canceled; do not delete the record.

Phase 2:

- Kokio: call partner provisioning to allocate an eSIM package after payment capture.
- Mysterium: issue or link VPN entitlement after payment capture.
- Add webhook/reconciliation jobs for failed provisioning, refunds, renewal failure, and allowance reset.

Phase 3:

- Add top-ups at higher margin than the base bundle.
- Add fraud/risk rules for high VPN usage, chargebacks, and suspicious roaming patterns.

## Copy

Use restrained product copy:

`Privacy Bundle`

`Kokio eSIM data plus Mysterium VPN, capped so usage stays profitable.`

Avoid:

- "Unlimited"
- "Anonymous banking"
- "No logs" unless the partner contract and privacy policy support that exact claim
- "Works everywhere" unless region availability is confirmed in real time

## Council Check

- Tier: full
- Decision class: paid product launch and partner dependency
- Dissent considered: unlimited plans are simpler to sell, but expose the company to bandwidth and roaming losses
- Approval boundary: live provisioning requires signed wholesale terms, refund policy, privacy copy review, and payment capture
- Reversibility: reversible before launch; partially reversible after users buy because refunds/support obligations remain
- Protocol status: approved for demo and gated implementation, not approved for live auto-fulfillment
