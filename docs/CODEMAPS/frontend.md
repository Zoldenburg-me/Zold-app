<!-- Generated: 2026-10-04 | Files scanned: 41 | Token estimate: ~900 -->
# Frontend (services/api/public)

Shared: tokens.css (`--z-*`), ui.css + ui.js (`window.Z` components), sw.js
(page JS/CSS network-first), device.js (device key), cookie-notice.js.
Reference designs: design/ui-v2/screens (exported from the design canvas).

## /app — the person's own account (app/*.js, classic scripts, one scope)
Companies are not here: a company login opening /app goes to /business
(except sign-in, recovery, Monerium and receipt-share screens).
Load order (index.html): nothing calls forward; app/main.js is last and does
all await-then-render.
```
core → dashboard → transactions → profile → recovery → monerium → onboarding
  → send → signers → phone → phone-home/-activity/-send/-add/-getpaid/-more
  → settings → desktop (≥1024px)
  → errors → pwa → main
```
Screens: onboarding into #ob-root; phone screens into #ph-root; desktop fills PH_DESK.

## /business — Zold Business (business/*.js, ES modules; works at phone width)
```
main.js → screens.js (Approvals, Contacts, Members, Invoices, Books)
        → invoice.js (editor + paper) → shell.js boot
home.js   Home (needs-you, in/out, accounts, latest statement lines)
send.js · getpaid.js · apps.js (Shopify) · books-overview.js (in/out, by category)
settings.js  grouped menu; access.js + access-model.js = Settings → Access
          (signers and recovery of the company login's Safe, read from chain)
core.js   shared state (org, me, view, cap(), api())
shell.js  one delegated click handler, render(), router (?view=)
nav.js    sidebar: VIEWS, PARENT (old ids → nav item), plan banner
views.js  META/RENDER registry + older views (send, get-paid, shopify,
          ledger, wallets with ownership proof, assets (holdings and lots),
          gains (realised per month), coa, export, integrations, documents, settings, plan…)
actions.js data-act handlers · receipts.js payer rule + collection summary · search.js ⌘K over loaded lists
access.js Settings → Access (company login only) · access-model.js its reads and
          recoveryStatus, no imports, also behind core.js readRecovery and the banner
```
Render contract: `META[view]()` → title/sub/actions; `RENDER[view]()` → html
or `{ html, bind(box) }`.

## Other pages
index/landing (website) · imprint.html · pay.html, pay-request.html (payment page) ·
invoice.html (supplier link) · document.html (/v verify) · receipt.html (/r) ·
admin.html · faucet.html · legal, privacy, partner-terms · 404 ·
guardian.html + guardian/*.js (ES modules, own CSP, loads vendor/turnkey.js; says "Not available" until `TURNKEY_GUARDIANS=1`)

## Shopify
shopify-app/extensions/zold-pay — thank-you page block pointing at /api/shopify/orders.
