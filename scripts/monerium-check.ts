/**
 * Validates Monerium sandbox credentials and shows what the integration can
 * see: auth context, profiles, linked addresses, IBANs, and recent orders.
 * Run after filling in .env:  npm run monerium:check
 */
import { MONERIUM, moneriumSandboxEnabled } from "../services/api/src/config.js";
import { MoneriumClient } from "../services/api/src/adapters/monerium-client.js";

if (!moneriumSandboxEnabled()) {
  console.error(
    "No credentials. Copy .env.example to .env and set MONERIUM_CLIENT_ID / MONERIUM_CLIENT_SECRET\n" +
      "(create a sandbox app at https://monerium.dev).",
  );
  process.exit(1);
}

const api = new MoneriumClient({
  baseUrl: MONERIUM.baseUrl,
  clientId: MONERIUM.clientId,
  clientSecret: MONERIUM.clientSecret,
});

console.log(`checking ${MONERIUM.baseUrl} (chain: ${MONERIUM.chain})…\n`);

try {
  const ctx = await api.authContext();
  console.log("auth ok:", JSON.stringify(ctx, null, 2));
} catch (err: any) {
  console.error(`AUTH FAILED: ${err.message}`);
  process.exit(1);
}

// Counts and masked identifiers only: with production credentials these
// lists are real customers, and a terminal or CI log is not where they belong.
const mask = (v: unknown) => {
  const s = String(v ?? "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "…";
};
const rows = (res: any): any[] => (Array.isArray(res) ? res : res?.ibans ?? res?.addresses ?? res?.profiles ?? res?.orders ?? []);
for (const [label, fn, show] of [
  ["profiles", () => api.profiles(), (p: any) => `${mask(p.id)} ${p.state ?? ""}`],
  ["addresses", () => api.addresses(), (a: any) => `${mask(a.address)} ${a.chain ?? ""}`],
  ["ibans", () => api.ibans(), (i: any) => `${mask(i.iban)} → ${mask(i.address)}`],
  ["orders", () => api.orders(), (o: any) => `${o.kind ?? ""} ${o.amount ?? ""} ${o.currency ?? ""} ${o.meta?.state ?? o.state ?? ""}`],
] as const) {
  try {
    const list = rows(await fn());
    console.log(`\n${label}: ${list.length}`);
    for (const r of list.slice(0, 5)) console.log(`  ${show(r)}`);
    if (list.length > 5) console.log(`  … ${list.length - 5} more`);
  } catch (err: any) {
    console.log(`\n${label}: unavailable (${err.message.split("\n")[0]})`);
  }
}

console.log(
  "\nAll good. Start the stack and create a user in the UI. In the sandbox, fund\n" +
    "it with a simulated SEPA transfer from the Monerium sandbox portal; in\n" +
    "production a real SEPA transfer to the IBAN mints EURe into the Safe, and\n" +
    "the API reports the Safe balance as the account balance.",
);
