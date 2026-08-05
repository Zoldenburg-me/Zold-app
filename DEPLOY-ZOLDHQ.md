# Deploying Zold at zoldhq.com (Cloudflare Tunnel)

Testnet only. `db.json` still holds `user.privateKey` and `senderProfile` PII in
plaintext, and FP4's key-custody half is unfinished — see the launch gate in
CLAUDE.md. The tunnel is chosen deliberately so that database stays on the
Mac and never lands on a public host.

Chain is Base Sepolia (84532), Monerium chain `basesepolia`, CCTP dry-run.

## Shape

    browser ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared (this Mac) ──▶ 127.0.0.1:3000

The API keeps binding `127.0.0.1`. That is correct and worth preserving: the
app is reachable only through the tunnel, never from the LAN, and there is no
inbound port to firewall.

## Steps only the domain owner can do

1. **Add zoldhq.com to Cloudflare** (free plan) and copy the two nameservers it
   assigns.
2. **At Namecheap, replace the nameservers** with Cloudflare's. Today the domain
   answers from `dns1/dns2.registrar-servers.com` and parks on
   `192.64.119.125`; a named tunnel cannot route the hostname until Cloudflare
   is authoritative. Propagation is usually minutes.
3. **`cloudflared tunnel login`** — opens a browser to authorise the account.
   An agent must not perform this; it is an account sign-in.

## Steps after that

!! BOTH TOOLCHAIN BINARIES ARE arm64 AND THIS MACHINE IS INTEL. `file
.toolchain/bin/cloudflared` says `Mach-O 64-bit executable arm64`, and
`.toolchain/node-v22.17.0-darwin-arm64` is the same story, so every command
below — and every `npm run` script — dies with `Bad CPU type in executable`.
`arch -arm64` does not help; it reports `Unknown architecture`, because there is
no Apple Silicon here to translate to. Before this deployment can be driven from
this Mac, fetch the `darwin-amd64` cloudflared build and use the system node
(nvm v24.13.0 is installed and is x86_64). The steps themselves are unchanged.

`cloudflared` 2026.7.3 is installed at `.toolchain/bin/cloudflared` (gitignored,
next to node, since this machine has no brew). Either use the full path or:

    export PATH="$PWD/.toolchain/bin:$PATH"

    cloudflared tunnel login
    cloudflared tunnel create zold
    cloudflared tunnel route dns zold zoldhq.com

Write `~/.cloudflared/config.yml` (substitute the id printed by `create`):

    tunnel: <TUNNEL_ID>
    credentials-file: /Users/tonythomas/.cloudflared/<TUNNEL_ID>.json
    ingress:
      - hostname: zoldhq.com
        service: http://127.0.0.1:3000
      - service: http_status:404

Then, in two terminals:

    npm run api
    cloudflared tunnel run zold

`https://zoldhq.com/` is the landing page, `https://zoldhq.com/app` the app.

Two other routes answer without a session, so they are reachable the moment the
tunnel is up: `/pay/<handle>` (payment pages) and `/r/<slug>` (shareable
receipts). Set `TRANSF_PUBLIC_URL=https://zoldhq.com` for the second one — the
share link is built from it, and without it the API falls back to the request's
own host header. That fallback is correct behind this tunnel only because
`TRUSTED_PROXY_HOPS=1` makes Express honour `X-Forwarded-Proto`; setting the
variable removes the dependency on that reasoning holding.

Note that `TRANSF_PUBLIC_URL` also forces `LOOKS_HOSTED` true. That changes
nothing today (see NODE_ENV below — the block it gates does not run), but it is
the switch that arms those checks the day `NODE_ENV=production` is set.

## Config already applied to .env

| var | value | why |
|---|---|---|
| `KYC_AUTO_APPROVE` | `0` | new users start pending; set explicitly, not inferred |
| `RP_ID` | `zoldhq.com` | **apex, not a subdomain** — see below |
| `WEBAUTHN_ORIGINS` | `https://zoldhq.com` | ceremonies are refused from anywhere else |
| `TRUSTED_PROXY_HOPS` | `1` | cloudflared forwards the client IP; without this every visitor shares one rate-limit bucket |
| `MONERIUM_REDIRECT_URI` | `https://zoldhq.com/api/monerium/oauth/callback` | must be re-registered with Monerium |
| `MONERIUM_TOKEN_ENCRYPTION_KEY` | generated | AES-256-GCM for per-user OAuth tokens at rest; the server 503s without it |
| `MONERIUM_WEBHOOK_SECRET` | generated, `whsec_` | **must be set to the same value in Monerium's dashboard** or deliveries are rejected |
| `ALLOW_PLAINTEXT_STORE` | `1` | acknowledges db.json is not production storage |

### RP_ID is a one-way door

Passkeys are RP-ID scoped. Credentials registered under `app.zoldhq.com` can
never be used by `checkout.zoldhq.com`. The apex is set so that
[pay-with-zold](https://github.com/tonyzil/pay-with-zold) can later live on its
own subdomain and still see the same credentials. Do not narrow it later —
every existing passkey would stop working.

Add the checkout origin to `WEBAUTHN_ORIGINS` when that origin exists;
`RP_ID` stays the apex.

### NODE_ENV is deliberately NOT production

The obvious setting is wrong here, and `assertProductionConfig` refuses it:
`production anchor mode must not use the Stellar testnet passphrase`. This
deployment points at Base Sepolia, testanchor and Monerium sandbox, so
declaring production is a false claim about the environment.

Nothing is lost by omitting it. `LOOKS_LOCAL` is already false off chain 31337,
so the simulate routes and internal error text are off either way — verified:
simulate-deposit returns 404 and a new user lands in `pending`. The one thing
that did depend on it, KYC gating, is now set explicitly above.

Be precise about what omitting it does: `assertProductionConfig()` begins
`if (!IS_PRODUCTION) return`, so the ENTIRE production block is skipped — not
just the anchor-passphrase check. Everything under `LOOKS_HOSTED` is inert here
even though `LOOKS_HOSTED` is genuinely true on chain 84532. The dev-only
behaviour is off for the separate reason above, which is why this is safe; but
"the config is validated" is not among the things currently true.

The consequence to plan for: the day `NODE_ENV=production` is set, a list of
requirements arrives at once, and `.env` satisfies none of the last three today.
Verified by importing `config.ts` against the live `.env` — it returns clean
now, and would not then.

| requirement | in `.env`? |
|---|---|
| `MONERIUM_WEBHOOK_SECRET` in `whsec_<base64>` form, ≥24 bytes decoded — raw hex is rejected | yes |
| `ALLOW_PLAINTEXT_STORE=1`, a deliberate acknowledgement rather than a fix | yes |
| `KYC_OPERATOR_TOKEN`, ≥24 chars | yes |
| `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` | **no** |
| `CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI` (or `CANDIDE_COSIGNER_ALLOWANCE_AMOUNT`), positive | **no** |
| `CANDIDE_COSIGNER_ALLOWANCE_PERIOD_MINUTES`, positive | **no** |

The last two arrived with the Safe-debit-without-an-API-key change (PR #116) and
are not in `.env.example` either. They are not cosmetic: a positive allowance is
a standing authority for the co-signer key to move EURe out of every user's Safe
through the allowance module, without the passkey. Requiring a positive PERIOD
alongside it makes that a recurring cap rather than a one-time budget that
silently runs out mid-life. Decide the numbers deliberately before setting them.

## Accounts do not move between origins

Device keys live in `localStorage`, scoped per origin, and an account's
authorizer can never be rebound: `POST /api/users/:id/authorizer` answers 409
for any address other than the one already stored. So an account onboarded at
`localhost` cannot be operated from `zoldhq.com`, and cannot be migrated — this
is FP4's hard edge, not a bug in the move.

(This paragraph used to attribute that to `RemitVault.setAuthorizer` letting
only the current authorizer rotate. That contract was deleted on main and
`setAuthorizer` does not exist anywhere in the tree any more. The binding is now
`user.authorizerAddress` in `db.json`, checked in the API process — so the
consequence below is unchanged, but it is enforced by the server rather than by
bytecode, and there is no rotation path at all rather than a restricted one.)

Consequences:

- Test end-to-end at zoldhq.com with a **fresh account**.
- `Redeem Base` (Safe `0xC034a7f3b986fE6550D0A6b63815a35839b1Ac2f`, IBAN
  `EE97 1051 2467 4856 5396`) and its pending deposit stay bound to
  `localhost`. Finish that redeem locally, or it is stranded.

## What end-to-end means here

The simulate routes and self-serve KYC are off, so the run exercises the real
path: account → operator KYC approval
(`KYC_OPERATOR_TOKEN`) → passkey → real Monerium IBAN → real SEPA deposit →
EURe minted on Base Sepolia → send. There is no mock deposit shortcut.

What protects you is `LOOKS_LOCAL` being false on chain 84532, not a
`NODE_ENV` flag.

## Before this is anything but a testnet demo

- Self-host the fonts and icons. Three third-party origins, not two, and it is
  no longer only the landing page: `landing.html` pulls Inter from
  `fonts.googleapis.com`/`fonts.gstatic.com` and Phosphor from `unpkg.com`, and
  `index.html` and `receipt.html` both pull Inter, Space Grotesk and Material
  Symbols from Google. So every visitor's browser announces itself to someone
  else on the landing page, in the app, and on any receipt a user shares —
  which reads badly next to a page about regulated custody, and worst of all on
  the receipt, whose whole premise is that the sender controls who sees what.
- The tunnel is only up while the Mac is. Fine for a demo, not for anything
  someone is told to rely on.
