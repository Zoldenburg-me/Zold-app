/**
 * The store's interface, with every method of today's `store` returning a
 * Promise (docs/postgres-store-design.md §3), and the JSON backend behind it.
 *
 * Nothing in the API uses this yet: callers still call `store` directly and
 * synchronously, and S2 moves them here. It exists so the Postgres backend
 * (store/pg/backend.ts) is held to exactly the methods `store` has, and so
 * one suite runs both (scripts/store-backend-test.ts).
 *
 * The whole-collection getters (`store.users`, …) are `list(name)` here.
 * `batched` has no counterpart until `store.tx` replaces it in S2. The two
 * listener registrations stay synchronous.
 */
import type { Db } from "./db.js";
import type { store as jsonStore } from "../store.js";

type Store = typeof jsonStore;
type Listener = "onTransferStateChange" | "onPaymentRequestStateChange";
type MethodName = {
  [K in keyof Store]: Store[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Store];
type AsyncMethod<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

export type Collection = keyof Db;

export type StoreBackend = {
  [K in Exclude<MethodName, Listener | "batched" | "list">]: AsyncMethod<Store[K]>;
} & Pick<Store, Listener> & {
  list<K extends Collection>(name: K): Promise<Db[K]>;
  close(): Promise<void>;
};

/** Today's store behind the interface: the same calls, resolved. Rows are
 *  the live ones, as from `store`; S2 makes them copies. */
export function jsonBackend(s: Store): StoreBackend {
  const out: Record<string, unknown> = {
    list: async (name: Collection) => s.list(name),
    close: async () => {},
    onTransferStateChange: s.onTransferStateChange,
    onPaymentRequestStateChange: s.onPaymentRequestStateChange,
  };
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(s))) {
    if (name === "batched" || name in out || typeof d.value !== "function") continue;
    const fn = d.value as (...args: unknown[]) => unknown;
    out[name] = async (...args: unknown[]) => fn(...args);
  }
  return out as StoreBackend;
}
