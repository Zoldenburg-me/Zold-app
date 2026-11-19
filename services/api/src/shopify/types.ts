/**
 * A Shopify store connected to an organisation as a payments app.
 *
 * The access token is the store's offline token for OUR app, obtained by the
 * merchant installing the app. It is encrypted at rest (crypto-at-rest.ts,
 * purpose `shopify`) and never crosses the API, not even as ciphertext.
 */
export interface ShopifyConnection {
  id: string;
  orgId: string;
  /** myshopify.com domain, lower-case. One connection per shop. */
  shop: string;
  /** The Zold account whose payment page receives the money — the org's EUR
   *  account's backing user, or the installer for a personal org. */
  payeeUserId: string;
  accessTokenEnc: string;
  scope: string;
  installedByUserId: string;
  installedAt: string;
  /** How this store was connected — see SHOPIFY_MODE in config.ts. Absent
   *  on rows written before the custom-app path existed: those are
   *  payments-app installs. */
  mode?: "payments-app" | "custom-app";
  /** payments-app: set once paymentsAppConfigure(ready: true) was accepted by
   *  Shopify. custom-app: set once the orders webhook subscription exists.
   *  Until then the store cannot pay through Zold. */
  configuredAt?: string;
  configureError?: string;
  /** custom-app: the Admin API id of our orders/create subscription, so
   *  disconnecting can remove it. */
  webhookSubscriptionId?: string;
  /** custom-app: the key the order-confirmation email signs the order id
   *  with (`hmac_sha256` in the template's Liquid), so the email link proves
   *  the reader got the email. Encrypted at rest, purpose `shopify-link`;
   *  it crosses the API only inside the template shown to the org. */
  orderLinkSecretEnc?: string;
  /** The last payment session Shopify sent, for the dashboard. */
  lastSessionAt?: string;
  updatedAt: string;
}

/**
 * A Shopify webhook delivery we have seen, by Shopify's delivery id
 * (X-Shopify-Webhook-Id), bound to the shop it first arrived under. The app
 * secret is shared and the shop header is unsigned, so this binding is what
 * stops a captured delivery being replayed under another store's name. Kept
 * 72 hours, past Shopify's 48-hour retry window.
 */
export interface ShopifyDelivery {
  id: string;
  shop: string;
  /** ISO time it first arrived. */
  at: string;
  /** Answered without a server error; a redelivery is then acknowledged unprocessed. */
  handled: boolean;
}
