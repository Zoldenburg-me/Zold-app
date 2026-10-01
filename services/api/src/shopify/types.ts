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
  /** The last payment session Shopify sent, for the dashboard. */
  lastSessionAt?: string;
  updatedAt: string;
}
