/**
 * Every stored credential, named once: its purpose, the table and field it
 * lives in, and how to list and rewrite it.
 *
 * Routes seal and open through `SECRETS`, and scripts/reencrypt-fields.ts
 * walks `STORED_SECRETS`, so the AAD a value is written with and the AAD the
 * job re-encrypts it with cannot drift apart. A new stored credential gets a
 * site and a registry entry here, with its own purpose.
 *
 * Users' Monerium credentials are bound to the user row; a company org's
 * Monerium API secret to the organisation row, under a purpose of its own. The API secret a
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
  merchantLinkSecret: site("merchant-link", "merchantLinks", "linkSecret"),
  gmiApiKey: site("getmyinvoices", "organisations", "integrations.getmyinvoices.apiKey"),
  moneriumAccessToken: site("monerium", "users", "monerium.accessToken"),
  moneriumRefreshToken: site("monerium", "users", "monerium.refreshToken"),
  moneriumApiSecret: site("monerium-api-secret", "users", "monerium.apiKeys.clientSecret", "monerium"),
  orgMoneriumApiSecret: site("monerium-org-api-secret", "organisations", "monerium.clientSecret"),
} as const;

export interface StoredSecret {
  site: SecretSite;
  /** Every row holding a value for this site. */
  rows(): Promise<{ rowId: string; stored: string }[]>;
  /** Replace one row's stored value. */
  write(rowId: string, stored: string): Promise<void>;
}

/** Rewrite one field of a user's Monerium connection, keeping the rest. */
async function writeMonerium(userId: string, patch: (m: NonNullable<User["monerium"]>) => Partial<NonNullable<User["monerium"]>>) {
  return store.tx(async () => {
    // Held until the write: a token refresh landing in between is not undone.
    const m = (await store.lockUser(userId))?.monerium;
    if (!m) throw new Error(`user ${userId} has no Monerium connection`);
    await store.updateUser(userId, { monerium: { ...m, ...patch(m) } });
  });
}

export const STORED_SECRETS: StoredSecret[] = [
  {
    site: SECRETS.moneriumAccessToken,
    rows: async () => (await store.list("users")).flatMap((u) => (u.monerium?.accessTokenEnc ? [{ rowId: u.id, stored: u.monerium.accessTokenEnc }] : [])),
    write: async (id, stored) => await writeMonerium(id, () => ({ accessTokenEnc: stored })),
  },
  {
    site: SECRETS.moneriumRefreshToken,
    rows: async () => (await store.list("users")).flatMap((u) => (u.monerium?.refreshTokenEnc ? [{ rowId: u.id, stored: u.monerium.refreshTokenEnc }] : [])),
    write: async (id, stored) => await writeMonerium(id, () => ({ refreshTokenEnc: stored })),
  },
  {
    site: SECRETS.moneriumApiSecret,
    rows: async () => (await store.list("users")).flatMap((u) => (u.monerium?.apiKeys?.clientSecretEnc ? [{ rowId: u.id, stored: u.monerium.apiKeys.clientSecretEnc }] : [])),
    write: async (id, stored) => await writeMonerium(id, (m) => {
      if (!m.apiKeys) throw new Error(`user ${id} has no Monerium API keys`);
      return { apiKeys: { ...m.apiKeys, clientSecretEnc: stored } };
    }),
  },
  {
    site: SECRETS.shopifyAccessToken,
    rows: async () => (await store.list("shopifyConnections")).filter((c) => c.accessTokenEnc).map((c) => ({ rowId: c.id, stored: c.accessTokenEnc })),
    write: async (id, stored) => { await store.updateShopifyConnection(id, { accessTokenEnc: stored }); },
  },
  {
    site: SECRETS.shopifyOrderLinkSecret,
    rows: async () => (await store.list("shopifyConnections")).flatMap((c) => (c.orderLinkSecretEnc ? [{ rowId: c.id, stored: c.orderLinkSecretEnc }] : [])),
    write: async (id, stored) => { await store.updateShopifyConnection(id, { orderLinkSecretEnc: stored }); },
  },
  {
    site: SECRETS.merchantLinkSecret,
    rows: async () => (await store.list("merchantLinks")).map((l) => ({ rowId: l.id, stored: l.linkSecretEnc })),
    write: async (id, stored) => { await store.updateMerchantLink(id, { linkSecretEnc: stored }); },
  },
  {
    site: SECRETS.gmiApiKey,
    rows: async () => (await store.list("organisations")).flatMap((o) => {
      const g = o.integrations?.getmyinvoices;
      return g?.apiKeyEnc ? [{ rowId: o.id, stored: g.apiKeyEnc }] : [];
    }),
    write: async (id, stored) => {
      await store.patchOrgSub(id, "integrations", (cur) => {
        const g = cur?.getmyinvoices;
        if (!g) throw new Error(`organisation ${id} has no GetMyInvoices connection`);
        return { ...cur, getmyinvoices: { ...g, apiKeyEnc: stored } };
      });
    },
  },
  {
    site: SECRETS.orgMoneriumApiSecret,
    rows: async () => (await store.list("organisations")).flatMap((o) => (o.monerium?.clientSecretEnc ? [{ rowId: o.id, stored: o.monerium.clientSecretEnc }] : [])),
    write: async (id, stored) => {
      return store.tx(async () => {
        const m = (await store.lockOrganisation(id))?.monerium;
        if (!m) throw new Error(`organisation ${id} has no Monerium API keys`);
        await store.updateOrganisation(id, { monerium: { ...m, clientSecretEnc: stored } });
      });
    },
  },
];
