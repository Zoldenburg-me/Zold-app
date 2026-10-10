/**
 * Every stored credential, named once: its purpose, the table and field it
 * lives in, and how to list and rewrite it.
 *
 * Routes seal and open through `SECRETS`, and scripts/reencrypt-fields.ts
 * walks `STORED_SECRETS`, so the AAD a value is written with and the AAD the
 * job re-encrypts it with cannot drift apart. A new stored credential gets a
 * site and a registry entry here, with its own purpose.
 *
 * Users' Monerium credentials are bound to the user row. The API secret a
 * user pastes has a purpose of its own; its v1 values, like the tokens',
 * were written under `monerium`.
 */
import { openField, sealField, type EncryptionPurpose } from "./crypto-at-rest.js";
import { dataKeyring, v1Secret } from "./config/data-keys.js";
import { store, type User } from "./store.js";

export interface SecretSite {
  purpose: EncryptionPurpose;
  table: string;
  field: string;
  seal(rowId: string, value: string): string;
  open(rowId: string, stored: string): string;
}

function site(purpose: EncryptionPurpose, table: string, field: string, v1Purpose: EncryptionPurpose = purpose): SecretSite {
  return {
    purpose,
    table,
    field,
    seal: (rowId, value) => sealField(purpose, { table, rowId, field }, value, dataKeyring()),
    open: (rowId, stored) => openField(purpose, { table, rowId, field }, stored, { keyring: dataKeyring(), v1Secret: v1Secret(), v1Purpose }),
  };
}

export const SECRETS = {
  shopifyAccessToken: site("shopify", "shopifyConnections", "accessToken"),
  shopifyOrderLinkSecret: site("shopify-link", "shopifyConnections", "orderLinkSecret"),
  gmiApiKey: site("getmyinvoices", "organisations", "integrations.getmyinvoices.apiKey"),
  moneriumAccessToken: site("monerium", "users", "monerium.accessToken"),
  moneriumRefreshToken: site("monerium", "users", "monerium.refreshToken"),
  moneriumApiSecret: site("monerium-api-secret", "users", "monerium.apiKeys.clientSecret", "monerium"),
} as const;

export interface StoredSecret {
  site: SecretSite;
  /** Every row holding a value for this site. */
  rows(): { rowId: string; stored: string }[];
  /** Replace one row's stored value. */
  write(rowId: string, stored: string): void;
}

/** Rewrite one field of a user's Monerium connection, keeping the rest. */
function writeMonerium(userId: string, patch: (m: NonNullable<User["monerium"]>) => Partial<NonNullable<User["monerium"]>>) {
  const m = store.findUser(userId)?.monerium;
  if (!m) throw new Error(`user ${userId} has no Monerium connection`);
  store.updateUser(userId, { monerium: { ...m, ...patch(m) } });
}

export const STORED_SECRETS: StoredSecret[] = [
  {
    site: SECRETS.moneriumAccessToken,
    rows: () => store.users.flatMap((u) => (u.monerium?.accessTokenEnc ? [{ rowId: u.id, stored: u.monerium.accessTokenEnc }] : [])),
    write: (id, stored) => writeMonerium(id, () => ({ accessTokenEnc: stored })),
  },
  {
    site: SECRETS.moneriumRefreshToken,
    rows: () => store.users.flatMap((u) => (u.monerium?.refreshTokenEnc ? [{ rowId: u.id, stored: u.monerium.refreshTokenEnc }] : [])),
    write: (id, stored) => writeMonerium(id, () => ({ refreshTokenEnc: stored })),
  },
  {
    site: SECRETS.moneriumApiSecret,
    rows: () => store.users.flatMap((u) => (u.monerium?.apiKeys?.clientSecretEnc ? [{ rowId: u.id, stored: u.monerium.apiKeys.clientSecretEnc }] : [])),
    write: (id, stored) => writeMonerium(id, (m) => {
      if (!m.apiKeys) throw new Error(`user ${id} has no Monerium API keys`);
      return { apiKeys: { ...m.apiKeys, clientSecretEnc: stored } };
    }),
  },
  {
    site: SECRETS.shopifyAccessToken,
    rows: () => store.shopifyConnections.filter((c) => c.accessTokenEnc).map((c) => ({ rowId: c.id, stored: c.accessTokenEnc })),
    write: (id, stored) => { store.updateShopifyConnection(id, { accessTokenEnc: stored }); },
  },
  {
    site: SECRETS.shopifyOrderLinkSecret,
    rows: () => store.shopifyConnections.flatMap((c) => (c.orderLinkSecretEnc ? [{ rowId: c.id, stored: c.orderLinkSecretEnc }] : [])),
    write: (id, stored) => { store.updateShopifyConnection(id, { orderLinkSecretEnc: stored }); },
  },
  {
    site: SECRETS.gmiApiKey,
    rows: () => store.organisations.flatMap((o) => {
      const g = o.integrations?.getmyinvoices;
      return g?.apiKeyEnc ? [{ rowId: o.id, stored: g.apiKeyEnc }] : [];
    }),
    write: (id, stored) => {
      const org = store.findOrganisation(id);
      const g = org?.integrations?.getmyinvoices;
      if (!org || !g) throw new Error(`organisation ${id} has no GetMyInvoices connection`);
      store.updateOrganisation(id, { integrations: { ...org.integrations, getmyinvoices: { ...g, apiKeyEnc: stored } } });
    },
  },
];
