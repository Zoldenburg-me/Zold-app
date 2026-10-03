<!-- Generated: 2026-10-03 | Files scanned: 45 | Token estimate: ~800 -->
# Frontend (services/api/public)

Shared: tokens.css (`--z-*`), ui.css + ui.js (`window.Z` components), sw.js
(page JS/CSS network-first), device.js (device key), cookie-notice.js.
Reference designs: design/ui-v2/screens (exported from the design canvas).

## /app — consumer app (app/*.js, classic scripts, one scope)
Load order (index.html): nothing calls forward; app/main.js is last and does
all await-then-render.
```
core → dashboard → transactions → profile → recovery → monerium → onboarding
  → send → signers → phone → phone-home/-activity/-send/-add/-getpaid/-more
  → invoices → business (company mode) → settings → desktop (≥1024px)
  → errors → pwa → main
```
Screens: onboarding into #ob-root; phone screens into #ph-root; desktop fills PH_DESK.

## /business — org console (business/*.js, ES modules)
```
main.js → screens.js (Approvals, Contacts, Members, Invoices, Books)
        → invoice.js (editor + paper) → shell.js boot
core.js   shared state (org, me, view, cap(), api())
shell.js  one delegated click handler, render(), router (?view=)
nav.js    sidebar: VIEWS, PARENT (old ids → nav item), plan banner
views.js  META/RENDER registry + older views (send, get-paid, shopify,
          ledger, coa, export, integrations, documents, settings, plan…)
actions.js data-act handlers · receipts.js payer rule + collection summary · search.js ⌘K over loaded lists
```
Render contract: `META[view]()` → title/sub/actions; `RENDER[view]()` → html
or `{ html, bind(box) }`.

## Other pages
index/landing (website) · pay.html, pay-request.html (payment page) ·
invoice.html (supplier link) · document.html (/v verify) · receipt.html (/r) ·
admin.html · faucet.html · legal, privacy, partner-terms · 404

## Shopify
shopify-app/extensions/zold-pay — thank-you page block pointing at /api/shopify/orders.
