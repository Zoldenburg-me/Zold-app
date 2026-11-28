/**
 * Run the one-off Monerium minimisation (minimise-monerium.ts) on the store
 * the deployment uses, with its environment (TRANSF_DB_PATH, or
 * STORE_BACKEND=postgres and DATABASE_URL):
 *
 *   npm run monerium:minimise
 *
 * Prints counts only, never a row. Take a backup first (scripts/backup-db.sh
 * or the host's dump): what it removes is not kept anywhere.
 */
import { initStore, store } from "../store.js";
import { minimiseStoredMonerium } from "./minimise-monerium.js";

await initStore();
const { checked, changed } = await minimiseStoredMonerium(store);
console.log(`monerium:minimise: ${checked} rows with a Monerium connection, ${changed} rewritten`);
process.exit(0);
