/**
 * Read-only smoke test against a real GetMyInvoices account.
 *
 * Reads GETMYINVOICES_API_KEY from the environment, calls GET /account and
 * GET /bankAccounts, and prints what it learned — never the key. Nothing is
 * written. Not part of `npm run check` (it needs the network and a key).
 *
 * Run: GETMYINVOICES_API_KEY=... npm run gmi:smoke
 */
import { GetMyInvoicesClient, gmiUserAgent } from "../services/api/src/adapters/getmyinvoices.js";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env is fine */ }
}
const key = (process.env.GETMYINVOICES_API_KEY ?? "").trim();
if (!key) {
  console.error("GETMYINVOICES_API_KEY is not set");
  process.exit(1);
}
const client = new GetMyInvoicesClient({ apiKey: key, userAgent: gmiUserAgent() });
const account = await client.account();
console.log("account:", { name: account.name, organization: account.organization, email: account.email, apiKeyType: account.apiKeyType, hasBankingAccess: account.hasBankingAccess, currency: account.currency, timezone: account.timezone });
const banks = await client.bankAccounts();
console.log(`bank accounts: ${banks.length}`);
for (const b of banks) console.log("  ", { uid: b.bankAccountUid, type: b.accountType, name: b.name, currency: b.currencyCode, iban: b.iban, status: b.connectionStatus });
console.log("read-only: nothing was uploaded, updated or deleted.");
