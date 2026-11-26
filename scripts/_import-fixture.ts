/**
 * A realistic db.json for the importer's tests (pg-import-test.ts,
 * store-pg-test.ts): written by the store's own code, the JSON backend
 * running the store suites, then a row added to each collection the suites
 * leave empty, so the round trip covers every shape.
 *
 *   npx tsx scripts/_import-fixture.ts <out/db.json>
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";

const out = process.argv[2];
if (!out) throw new Error("usage: _import-fixture.ts <out/db.json>");
process.env.TRANSF_DB_PATH = out;
const { initStore, store } = await import("../services/api/src/store.js");
const { conditionalWriteSuite, outboxSuite, storeSuite } = await import("./_store-suite.js");
await initStore();
// The suites narrate; the fixture's caller does not need it.
const log = console.log;
const error = console.error;
console.log = console.error = () => {};
try {
  await storeSuite(store);
  await conditionalWriteSuite(store);
  await outboxSuite(store);
} finally {
  console.log = log;
  console.error = error;
}
// The collections the suites leave empty.
const now = new Date().toISOString();
await store.addShopifyConnection({ id: "sh_fx", orgId: "org_b", shop: "fx.myshopify.com", payeeUserId: "u_a", accessTokenEnc: "enc", scope: "", installedByUserId: "u_a", installedAt: now, updatedAt: now });
await store.addContact({ id: "ct_fx", orgId: "org_b", name: "Lindner Holzbau GmbH", wallets: [], bankAccounts: [], createdAt: now, updatedAt: now });
await store.addImportedWallet({
  id: "iw_fx",
  orgId: "org_b",
  address: `0x${"7a".repeat(20)}`,
  chainId: 84532,
  label: "Treasury",
  kind: "eoa",
  custody: "external",
  sync: { status: "synced", lastSyncedAt: now, cursor: "123456" },
  createdAt: now,
  updatedAt: now,
} as never);
// A suite transfer carries no amount; the report blocks that (cap-amount).
for (const t of await store.list("transfers")) if (typeof t.sendEur !== "number") await store.updateTransfer(t.id, { sendEur: 12.5 });
// Loaded once more, so the load-time migrations have run on every row (a
// user the suites added without a membership gets a personal organisation
// with random ids): the file is then the snapshot itself, and stable.
await initStore();
