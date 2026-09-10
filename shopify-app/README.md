# Zold Shopify app — custom-app mode

This folder is the Shopify side of the custom-app integration: the app config
Shopify's CLI reads, and one checkout UI extension that renders the order's
Zold payment on the **Thank you** and **Order status** pages. There is no
server here. Everything Shopify calls lives in the Zold API
(`services/api/src/routes/shopify.ts`), and the API needs `SHOPIFY_MODE=custom-app`
(the default), `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and a public origin.

## Why this shape

Only an app approved into Shopify's Payments Apps program can add a payment
method to checkout. This app does not need that: the store offers a **manual
payment method** named Zold, Shopify sends `orders/create`, the API opens a
payment request for the order, and when the USDC deposit is attributed the API
presses **Mark as paid** on the order through the Admin API. The extension
makes the buyer's side feel native: after "Place order", the very next screen
shows the USDC amount, address and QR, and updates itself when the payment is
seen. Without the extension the buyer gets the pay link from the order
confirmation email instead (the dashboard prints the Liquid snippet).

The one thing this cannot hide: the order exists before the money does.

## Setup, in order

1. **Partner Dashboard**: create an app (or open the one already created),
   set **Distribution → Custom** and pick the store. Note the client id and
   secret. Add `https://<zold origin>/api/shopify/callback` to the redirect
   URLs. Set scopes `read_orders,write_orders`.
2. **Zold API**: put the key and secret in `.env`, set `TRANSF_PUBLIC_URL` to
   the public origin (a cloudflared tunnel is fine for a dev store), run
   `npm run api`.
3. **Store**: Settings → Payments → Manual payment methods → *Create custom
   payment method*, name it so it contains "Zold". Checkout currency EUR.
4. **Connect** the store from the Zold business dashboard (Shopify view). That
   runs OAuth and subscribes the webhooks.
5. **Extension**: in this folder,
   ```
   npm install
   npx shopify app config link      # attach to the app from step 1
   npx shopify app dev              # or: npx shopify app deploy
   ```
   then in the store's **checkout editor** add the "Zold — pay with crypto"
   block to the Thank you page and the Order status page, and set its
   **Zold API origin** setting to the same origin as step 2.
6. Place a test order with the Zold method and pay the USDC figure. The order
   flips to Paid in the Shopify admin, and `zold.payment` on the order carries
   the transaction.

## Not yet proven

This extension has NOT been built with the Shopify CLI or run in a real
checkout. Things the first `shopify app dev` may correct:

- The `@shopify/ui-extensions*` package versions in `extensions/zold-pay/package.json`
  (they track Shopify's API version; use whatever the CLI scaffolds for
  `2026-07`).
- The exact API names on the two surfaces: `api.orderConfirmation` on the
  thank-you target and `api.order` on the order-status target are the
  documented ones as of the version this was written against.
- `network_access = true` may need enabling for the app in the Partner
  Dashboard before the block can fetch the Zold API.

The API side IS proven against a stub: `npm run shopify:orders:test`.
