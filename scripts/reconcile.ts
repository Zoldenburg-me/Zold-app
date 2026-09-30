/**
 * Reconcile the local Monerium receipt state against Monerium's own orders.
 * Reports drift; never repairs it.
 *
 * Needs neither the chain nor the API. It compares against Monerium when app
 * credentials are in .env or any account uses its own API keys; with neither
 * there is nothing to compare and it reports ok.
 *
 * Run: npm run reconcile
 */
import { initStore } from "../services/api/src/store.js";
import { formatReport, reconcile } from "../services/api/src/reconcile.js";

initStore();
const report = await reconcile();
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
