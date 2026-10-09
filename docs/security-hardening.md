# Security hardening

The plan for taking Zold from a testnet on an Akash lease to something that may
hold real people's data and money. Linked from `AGENTS.md`; the rules agents
follow are under **Rules** at the end. Ordered by priority. Nothing here is
done unless the code says so.

## Threat model

Who we defend against, in the order they are likely:

1. **Whoever runs the host.** The Akash lease runs with a known EU
   provider, and like any host it has root on the machine: it can read the
   container's environment and its disk. A key kept beside the ciphertext
   buys nothing against a host compromise.
2. **A stolen or compromised laptop** holding local secrets or a copy of the
   database.
3. **A web attacker** on the API: injection, broken access control, session
   theft, brute force on codes and slugs.
4. **The supply chain**: npm packages, the container base image, and the
   binaries the container downloads at boot.
5. **A third party's breach**: Monerium, the SMTP provider, Cloudflare,
   GitHub, the domain registrar.
6. **Agents with a shell** in this repo: they can read any file the user can.
7. **The operator**: one static bearer token opens the admin dashboard.

The question to ask of every item: **if this database is dumped, or this
host's disk and environment are read, what does the attacker hold?** The
answer we want: ciphertext, hashes, and no key that opens them.

## What already holds

So nobody rebuilds it:

- Sessions are stored as `tokenHash`, never the token.
- Monerium OAuth tokens, users' own Monerium API secrets, Shopify access
  tokens and GetMyInvoices keys are AES-256-GCM encrypted
  (`crypto-at-rest.ts`), and writing them refuses without a key.
- Production config refuses dev keys off a local RPC (`config/keys.ts`), a
  short operator token, and a JSON store unless `ALLOW_PLAINTEXT_STORE=1`
  acknowledges it.
- The operator token is compared with `timingSafeEqual`; webhooks (Monerium,
  Shopify) are HMAC-checked.
- CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` (`http/policy.ts`);
  rate buckets for auth, documents, partners, operator.
- SMTP refuses a server that cannot do TLS in production (`adapters/mailer.ts`).
- The error log keeps the route pattern, never the URL or body.
- `.env`, `data/`, `.private/` are gitignored; a pre-commit leak check runs.

## Phase 0: local secrets and accounts (days, no new infrastructure)

The open items, with paths, are in `.private/security-gaps.md`, which is
kept out of the public repo. The targets:

- `.env` and `.private/` are encrypted at rest with `age` (binary vendored
  under `.toolchain/`, the same way node is), with the identity in the macOS
  Keychain or on a YubiKey (`age-plugin-yubikey`). `scripts/with-secrets.sh`
  decrypts into a child process's environment only, never to a file.
- Deploy manifests are generated and piped to the deploy command; nothing
  holding secrets is written to disk.
- Database backups and copies exist only `age`-encrypted, made by one
  `scripts/backup-db.sh`; files under `data/` are mode 600.
- Every binary and image fetched at build or boot is pinned and verified
  (version plus SHA-256, or image digest).
- Local `.claude/settings.json` denies Read/Bash on `.env*`, `.private/**`
  and `data/*.json`, and the rule below says the same for every agent.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` in
  production; preload once every subdomain serves HTTPS.
- Hardware-key 2FA on the registrar, the registrant's email account (it can
  reset the registrar), Cloudflare and GitHub; registrar lock and WHOIS
  privacy; the registrant is the company. Whoever controls the domain's DNS
  controls the passkey origin (`RP_ID`), so they can phish real passkey
  signatures.

## Phase 1: secrets inventory and key handling

### 1.1 Inventory

Every secret gets a row in `.private/secrets-inventory.md` (encrypted, names
and metadata only, never values): owner, tier, where it lives, who can read
it, how to rotate it, and when it was last rotated.

| Tier | What | Examples | Target home |
|------|------|----------|-------------|
| 1. Moves money on-chain | private keys | `DEPLOY_*_KEY` / `ORCHESTRATOR_KEY` / `RAMP_KEY`, `FAUCET_KEY`, `CANDIDE_COSIGNER_KEY`, `STELLAR_TREASURY_SECRET`, `CIRCLE_ENTITY_SECRET` | Stored in the self-hosted Bitwarden (1.4). Keys that only an operator uses, such as deployer and contract admin, live on a hardware wallet and are never online. Keys the server signs with automatically (orchestrator, ramp, faucet) still have to be in process memory to sign, so on mainnet they hold small balances and narrow contract roles. A signer that never releases the key (an HSM) is the later step. |
| 2. Opens a partner or our identity | API secrets, signing secrets | `MONERIUM_CLIENT_SECRET`, `MONERIUM_WEBHOOK_SECRET`, `CHECKOUT_WEBHOOK_SECRET`, `SHOPIFY_API_SECRET`, `DOCUMENT_SIGNING_KEY`, `MG_CLIENT_DOMAIN_SIGNING_SECRET`, `KYC_OPERATOR_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, `SMTP_PASS`, `BRIDGE/LIFI/BEBOP/CANDIDE/CIRCLE/GETMYINVOICES` keys | Bitwarden, fetched at start and never written to the host's disk. Rotate every 90 days and on any staff or host change. |
| 3. Decrypts stored data | data-encryption root | `MONERIUM_TOKEN_ENCRYPTION_KEY` | Bitwarden; it wraps the per-purpose data keys (1.2). |

### 1.2 Encryption at rest, version 2

Version 1 (`crypto-at-rest.ts`) has one secret, no key id and no
associated data; its specific weaknesses are in `.private/security-gaps.md`.
Version 2:
- Format `v2.<keyId>.<iv>.<tag>.<ct>`. The v1 reader stays until a
  re-encrypt job has moved every row.
- Per-purpose data keys from HKDF-SHA256 over a root fetched from Bitwarden
  at start (envelope encryption). The root is held in memory only and never
  logged.
- **AAD = `purpose|table|rowId|field`**, so a ciphertext only decrypts in the
  row it was written for.
- Rotation: a new key id for new writes and a background re-encrypt of old
  ones. The old key is retired only when no row still uses it.
- New PII columns use the same scheme: IBAN, legal name, email, phone,
  address. A lookup by email uses a blind index (HMAC-SHA256 under its own
  key), never the plaintext.

### 1.3 Monerium specifically

- Our app credentials (`MONERIUM_CLIENT_ID/SECRET`, webhook secret) are tier 2.
  Keep the sandbox and production apps in separate secret-manager paths, so
  a sandbox `.env` can never hold a production secret.
- Users' tokens and their own API secrets: v2 encryption with AAD bound to
  the user row. Request the narrowest scope that works. On disconnect, clear
  the ciphertext. That is a credential, not a ledger row, so the
  "nothing deletes" invariant does not cover it.
- An API secret a user pastes in is never echoed back, logged, or returned
  by any route. Only its label and client id are shown.
- PKCE on the OAuth flow, and the state parameter bound to the session
  (verify against the real server: `docs/status.md`).
- Alert on Monerium 401/403 bursts. A revoked or rotated credential shows up
  there first.

### 1.4 Self-hosted Bitwarden

Bitwarden, self-hosted, is the one place every secret lives. `.env` on a
laptop then holds only what local dev needs.

- **What it is and is not.** It stores secrets and hands them out. It does
  not sign. A key the server fetches to sign with is in that server's memory,
  which is why tier 1 also limits what each online key can do.
- **Server or Vaultwarden.** The official server is heavy (several
  containers and a database), and its Secrets Manager (machine accounts and
  the `bws` CLI, which a server uses to fetch secrets at start) is a paid
  organisation feature. Vaultwarden is light but implements the password
  vault, not Secrets Manager. Confirm both points before choosing. Without
  Secrets Manager, the server fetches with the `bw` CLI and a dedicated
  read-only account.
- **Access**: no public port. It is reachable only over WireGuard or
  Tailscale. The admin login uses a hardware key. Each deployment (staging,
  production) gets its own machine account, which reads only its own
  collection.
- **Backups**: encrypted nightly to a second location under a different
  account, with a restore tested. An offline emergency kit (master password
  plus recovery code) is kept on paper, in two places.
- **Availability**: the app fetches secrets only at start. If the vault is
  down, a running app keeps running, but a restart waits for the vault.

**Where to host it.** On a small machine of its own at the UG's site in
Sweden (a mini PC with an encrypted SSD), reachable only over WireGuard,
running nothing else.

- **Not on a shared host** such as a node running chain clients as
  containers on one Docker host, with peer-to-peer ports open to the
  internet, whose manager controls every container. A vault there shares
  its fate with the chain clients and with whoever reaches the node's admin
  interface. It is acceptable as a stopgap holding testnet secrets only.
  It must move before a mainnet key goes in.
- **Not on a cheap VPS.** The provider has root on the host, which is
  threat 1 again for the one service that holds every key.

**The hardware: two 2018 Intel MacBook Pros the UG already owns.** The T2
chip encrypts the SSD in hardware; with FileVault on, a stolen machine is
locked. One is the vault, the other the backup target, at a different
location.

- **Install**: erase and reinstall macOS. One local account used for nothing
  else, signed into no personal Apple ID. FileVault on, automatic security
  updates on, firewall in stealth mode.
- **Service**: Vaultwarden (or Bitwarden) is the only service. It listens
  only on the WireGuard or Tailscale interface. Remote Login is off, or
  key-only over the VPN.
- **Network**: wired, through a USB-C to Gigabit Ethernet adapter (the
  machines have no Ethernet port), with Wi-Fi turned off.
- **Power**: no sleep on the charger, `pmset autorestart 1` after a power
  cut, and charging capped near 80%. Laptops of this age left plugged in
  around the clock are known to swell their batteries.
- **Reboots**: after a power cut, FileVault waits for its password at boot,
  so the vault stays down until someone unlocks it. That is the price of a
  locked disk. Planned reboots use `sudo fdesetup authrestart`.
- **Backup machine**: set up the same way, it receives the encrypted nightly
  backup. A restore is tested on it once, then after every Vaultwarden
  upgrade.
- **Lifetime**: macOS Sequoia (15) is the last release for these models.
  When Apple stops shipping its security updates, move to Linux (the t2linux
  project supports T2 Macs) or to a mini PC. A machine without security
  updates holds no mainnet key.

### 1.5 The operator

- Replace the static `KYC_OPERATOR_TOKEN` bearer with an operator passkey
  (WebAuthn, a named operator, each action audited). Put `/api/admin/*` and
  `/admin` behind Cloudflare Access as a second gate.
- Operator actions are written to the append-only audit log with the
  operator's identity.

## Phase 2: a real database

`store/db.ts` rewrites one JSON file on every change: no concurrent writers,
no transactions across a ledger write and a transfer update, no access
control below "can read the file". `store.ts` is the only thing that touches
it, so the swap happens in one place.

**Target: PostgreSQL 16**, in the EU, on a host we have a processing
agreement with.

- **Connection**: TLS `verify-full`. No public IP, or an IP allowlist and
  private networking. Credentials come from the secret manager, short-lived
  where the host supports IAM or dynamic credentials.
- **Roles**: `zold_migrator` owns the schema and runs migrations only.
  `zold_app` has `SELECT/INSERT/UPDATE` and **no `DELETE`** on organisations,
  accounts, invoices, ledger and audit. The "gating is a read-time filter,
  never a write-time delete" invariant then holds in the database, not just
  in `store.ts`. `ledger` and `audit` also refuse `UPDATE` (append-only, by
  trigger). `zold_readonly` exists for reporting and the reconciler.
- **Row-level security** on every org-scoped table, keyed on a per-request
  `app.org_id` setting: a second check under the member+role check, so a
  missing `where org_id =` returns nothing instead of another org's rows.
- **Queries**: parameterised only. A lint rule refuses string-built SQL. A
  query layer (Kysely or plain `pg` with tagged templates) keeps types next
  to SQL.
- **Field encryption**: Phase 1.2 columns stay ciphertext inside Postgres.
  Disk encryption by the host is assumed and is not counted as protection.
- **Money**: a transfer state change and its ledger rows commit in one
  transaction. `store.updateTransfer`'s refusal to move REFUNDED/PAID
  backwards becomes a `CHECK` or trigger too.
- **Backups**: encrypted, point-in-time recovery, kept in a second region
  under a different account. A restore drill runs monthly, and a backup
  never restored counts as no backup.
- **Monitoring**: `pgaudit` on DDL and on role changes. Alert on a new role,
  a GRANT, a connection from an unknown address, or a bulk `SELECT` over a
  PII table.
- **Tests** run on a throwaway Postgres. The connection helper refuses any
  DSN whose host is not local when `NODE_ENV=test`. This is the Postgres form
  of the `TRANSF_DB_PATH` guard that exists because a test run once wiped a
  live Safe owner key.
- **Migration**: a one-time script reads `db.json` and writes Postgres in one
  transaction, then checks row counts per table and ledger sums per account,
  and refuses to cut over on any mismatch. The idempotent migrations in
  `db.ts` become numbered SQL migrations.

### "A third party gets into the database"

What they hold after Phases 1 and 2:

| Data | What they get |
|------|---------------|
| sessions | SHA-256 hashes of random tokens: useless |
| Monerium/Shopify/GMI credentials | v2 ciphertext; the root key is in Bitwarden, not on the DB host |
| IBAN, name, email, phone | ciphertext + blind index |
| transfers, ledger amounts, Safe addresses | **plaintext**: the app needs to sum them, and the Safe addresses are public on-chain anyway |
| passkey public keys | public by design |

They cannot move money: every debit needs the user's passkey signature
(AGENTS.md, "No debit without a user signature"). They cannot impersonate a
user without breaking WebAuthn.

## Phase 3: mail

Today, nodemailer sends verification codes over SMTP with a password from
`.env`.

- **Provider**: a transactional provider with an **API key scoped to sending
  only**, from one verified sender, IP-restricted where offered. It replaces
  a mailbox password.
- **Domain**: send from a subdomain (`mail.zoldhq.com`) so its reputation
  and policy are separate. SPF `-all`; DKIM 2048-bit, rotated yearly; DMARC
  `p=reject` with `rua` reports watched; MTA-STS and TLS-RPT for inbound
  mail to zoldhq.com (security@ and support@ receive there).
- **Transport**: `rejectUnauthorized` stays on, `minVersion: "TLSv1.2"`, and
  `requireTLS` in every non-local environment, not only production.
- **Content**: the code stays out of the subject line. Subjects land in
  provider logs and lock-screen previews; the body is enough. No link in a
  code mail, so there is nothing to phish with a look-alike.
- **Abuse**: per-address and per-IP limits on sends (beyond the auth bucket),
  a cap on attempts per code, and bounce and complaint webhooks that stop
  sending to a bad address.
- **Logs**: never log the code or the full address; log a hash of the
  address.

## Phase 4: hosting

- **The Akash lease** is with a known EU provider. It may hold real users'
  personal data once a GDPR Art. 28 processing agreement with that provider
  is signed, and real-money keys only once secrets come from Bitwarden at
  start rather than from the SDL's environment. Until both hold, it is
  testnet-only. To add: `config/production.ts` refuses chain 8453 while
  `ALLOW_PLAINTEXT_STORE=1` is set.
- **The mainnet host** has a processing agreement, an EU region, a secret
  and Bitwarden reachable over a private network: a managed container
  platform, or a VM we own. A
  confidential VM where offered narrows threat 1.
- **The container** runs as non-root with a read-only root filesystem
  (writable `/data` or none once Postgres is in use), dropped capabilities,
  and no tools installed at boot. The image is built in CI, signed, and
  pulled by digest.
- **The edge**: Cloudflare WAF managed rules, bot protection on auth and
  code routes, and Access in front of admin.

## Staging

A staging deployment exists to try changes on real infrastructure before
`production`. What it needs:

- **Its own everything**: database, Bitwarden collection, Monerium sandbox
  app, chain (Base Sepolia), SMTP sender, Cloudflare tunnel. Staging never
  holds a production secret or a copy of production data.
- **Behind Cloudflare Access**, with `noindex`, so it is not a public
  surface.
- **Deployed from a branch** by the same pinned image build as production.

**Its domain must not be a subdomain of the production passkey domain.** A
passkey made for `RP_ID=zoldhq.com` can be used by any page on any
`*.zoldhq.com`. The server's login check rejects an assertion whose origin
is not listed in `WEBAUTHN_ORIGINS`. The Safe's on-chain WebAuthn verifier,
as far as we read it, checks only the signature over the challenge, not the
origin. So a page on a compromised `staging.zoldhq.com` could ask a user's
production passkey to sign a production UserOperation, and the chain would
accept the signature. Confirm this in the verifier contract before relying
on either reading. Until then:

- Use a separate registrable domain for staging (for example a second
  `.com`), so staging can never use production passkeys.
- If staging must be `staging.zoldhq.com`, give production a narrower
  `RP_ID` instead (for example `app.zoldhq.com`). That only works for
  mainnet, where no passkeys exist yet, because a passkey's RP ID cannot
  change.
- Every subdomain of the production RP ID is inside the passkey trust
  boundary. That includes any subdomain a third party hosts, such as a
  docs site on GitBook. Keep a list and keep it short.

## Phase 5: supply chain and the repo

- `npm ci` from the lockfile only. Dependabot or Renovate opens grouped PRs.
  `npm audit --omit=dev` fails CI on high severity. CI generates an SBOM.
- `gitleaks` in CI as well as the local pre-commit hook. Run `repo-leak-scan`
  over the full history before any repo goes public.
- GitHub: hardware-key 2FA required for the org, branch protection on `main`
  and `production`, signed commits, no long-lived PATs (they are minted per
  session and revoked: AGENTS.md "Environment").

## Phase 6: detect and respond

- Ship the audit log and server logs off the host to an append-only store,
  with alerts on: operator actions, a burst of failed logins or codes,
  decrypt failures (a key mismatch or tampering), webhook signature failures,
  and a new device on an operator account.
- `docs/incident-response.md`, written before mainnet:
  - who decides;
  - the rotation order (tier 1, then 2, then 3, from the inventory);
  - how to revoke each partner credential;
  - the GDPR 72-hour notification to the Bavarian authority (BayLDA);
  - what to tell Monerium.
- An external penetration test before the first real euro. Re-run the
  existing internal test (`.private/pentest/`) after each phase, triage the
  findings, and record them in the inventory, not in the public repo.

## Decisions for the user

1. The Postgres host: managed EU Postgres, a VM we run, or the Akash
   provider once the processing agreement is signed.
2. Bitwarden: the official server with Secrets Manager, or Vaultwarden;
   and the Sweden node versus a VPS (1.4).
3. The staging domain: a separate domain, or a narrower production `RP_ID`.
4. The mail provider for Phase 3.
5. When the domain moves to the UG (after the commercial-register entry).

## Rules

These are the agent-facing rules. AGENTS.md carries the short form.

- **Agents never read secret files.** `.env*`, `.private/**` and
  `data/*.json` are off limits. The one exception is `.private/pentest/`,
  which holds testnet test accounts made by `scripts/pentest-user.ts`. To
  know whether a variable is set, read the code that reads it, or ask the
  user. Never print a value.
- **No secret outside the secret store.** Not in source, commits, PR text,
  logs, error messages, test fixtures (other than hardhat's public dev
  keys), or any file outside `.private/`. A new secret gets an inventory row
  and a tier.
- **Stored credentials are encrypted, one purpose per key.** Use
  `encryptField` with a new `EncryptionPurpose`; never reuse a purpose for a
  different kind of secret, and never add a plaintext fallback. Writing
  refuses when the key is missing.
- **No unencrypted copy of the database.** Backups, previews, exports and
  fixtures taken from real data are encrypted, or they are not made.
- **No real-money secret or real user data on a host without a processing
  agreement**, and no real-money secret in a deployment's environment file.
- **The database refuses what the app must never do.** When a table is
  added, give `zold_app` only the grants it needs, never DELETE on
  money or identity tables, and RLS on anything org-scoped.
- **Anything pulled at build or boot is pinned and verified**: version plus
  checksum or digest.
- **Staging shares nothing with production**: no secret, no data, and no
  page under the production passkey domain.
