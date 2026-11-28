/**
 * One-off: cut the Monerium data stored on user rows down to what
 * adapters/monerium-minimise.ts keeps, on whichever store backend is passed.
 *
 * Rows written before the filter hold every profile, IBAN and linked address
 * of the user's Monerium login. This rewrites only `monerium.profiles`,
 * `monerium.ibans` and `monerium.addresses`, and drops `monerium.context`.
 * Nothing else on the row changes (tokens, keys, connectedAt stay), and no row
 * is deleted. No money, ledger or audit row holds these lists, so none is
 * touched. Running it twice changes nothing the second time.
 */
import type { StoreBackend } from "../store/backend.js";
import type { User } from "../store.js";
import { keptAddresses, keptIbans, keptProfiles, ownerOf } from "../adapters/monerium-minimise.js";

type Monerium = NonNullable<User["monerium"]> & { context?: unknown };

/** The row's `monerium` as the filter keeps it; lists absent stay absent. */
export function minimisedMonerium(u: Pick<User, "address" | "funding"> & { monerium: Monerium }): NonNullable<User["monerium"]> {
  const { context: _context, ...m } = u.monerium;
  const owner = ownerOf(u);
  return {
    ...m,
    ...(m.profiles !== undefined ? { profiles: keptProfiles(owner, m.profiles) } : {}),
    ...(m.ibans !== undefined ? { ibans: keptIbans(owner, m.ibans) } : {}),
    ...(m.addresses !== undefined ? { addresses: keptAddresses(owner, m.addresses) } : {}),
  };
}

export async function minimiseStoredMonerium(s: StoreBackend): Promise<{ checked: number; changed: number }> {
  let checked = 0;
  let changed = 0;
  for (const u of await s.list("users")) {
    if (!u.monerium) continue;
    checked++;
    if (JSON.stringify(minimisedMonerium({ ...u, monerium: u.monerium })) === JSON.stringify(u.monerium)) continue;
    // Recomputed on the locked row, so a connect landing meanwhile is not undone.
    await s.patchUserSub(u.id, "monerium", (m) => (m ? minimisedMonerium({ ...u, monerium: m }) : m));
    changed++;
  }
  return { checked, changed };
}
