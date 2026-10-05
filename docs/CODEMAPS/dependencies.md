<!-- Generated: 2026-10-04 | Files scanned: package.json, adapters/, config/ | Token estimate: ~600 -->
# Dependencies

## npm (runtime)
express 4 · viem 2 (chain) · abstractionkit (Safe/ERC-4337, Candide) ·
safe-recovery-service-sdk (Candide guardian recovery) · @stellar/stellar-sdk ·
nodemailer (mail, flag-gated) · lz-string
Dev: hardhat, tsx, typescript. contracts/src: MockToken (31337 only) ·
ZoldUSD (zUSD, test chains, `deploy:zusd`) · OffchainResolver (L1 ENS, `deploy:ens-resolver`).

## External services (adapters/, liquidity/, bridge/, stellar/)
| Service | Used for | Code |
|---|---|---|
| Monerium | IBAN, EURe issue/redeem, OAuth or API keys, webhooks | adapters/monerium-*, routes/monerium*.ts, sepa.ts |
| Candide | bundler/paymaster for passkey Safe; forwarding addresses; guardian recovery | wallet/candide.ts, adapters/candide-forwarder.ts, recovery/ |
| LI.FI, Uniswap v3 (per-chain addresses), CoW, RFQ (Bebop) | swaps, allowlisted calldata | liquidity/* |
| ENS (L1 OffchainResolver) | `<handle>.zoldhq.com` names via CCIP-Read; name lookup | ens.ts, routes/ens.ts, config/ens.ts |
| Bridge.xyz | USD rail (not live) | bridge/bridgexyz.ts |
| Stellar anchors (SEP) | cash rail (CLOSED unless cashRailOpen) | stellar/ |
| MoneyGram | cash rail partner | adapters/moneygram.ts |
| Gnosis Pay | card account read (SIWE) | adapters/gnosis-pay.ts |
| GetMyInvoices | push Belege (Beta) | adapters/getmyinvoices.ts |
| Shopify | payments app / custom-app checkout | routes/shopify.ts, shopify/ |
| VIES | EU VAT ID check | adapters/vies.ts |
| SMTP | email codes (off unless EMAIL_VERIFICATION=1) | adapters/mailer.ts |
| Rates source | independent mid for price sanity | rates.ts |

Config lives in config/* (env, keys, deployments by chain id, partners,
liquidity, payments, wallet-sync, ens, security, production checks).
