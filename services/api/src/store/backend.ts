/**
 * The store's interface (docs/postgres-store-design.md §3): every method of
 * the JSON store's synchronous core (store.ts) returning a Promise, plus
 * `list`, `tx` and `close`, and the JSON backend behind it.
 *
 * The JSON backend is the core's methods behind one process-wide async
 * mutex, taken by every call, reads included:
 *
 * - A call outside a transaction takes the mutex, runs, persists before it
 *   releases (a write), and returns. It never runs while a `store.tx` holds
 *   the mutex, so it never reads a transaction's half-made changes.
 * - `store.tx` holds the mutex from start to end and writes the file once,
 *   at the end, also when its callback throws (the JSON backend has no
 *   rollback; the Postgres backend rolls back). Nothing else runs meanwhile.
 * - Inside a transaction, every store call made from the callback, through
 *   `t` or through `store`, runs inside it, so a helper that calls `store`
 *   joins the transaction it is called from. A call started from the
 *   callback that is still running once the transaction has ended takes the
 *   mutex like any other.
 *
 * Rows are copies on both backends: what goes in is cloned and what comes
 * out is cloned, so a caller that changes a row it read changes nothing
 * stored. State-change listeners run after the write, outside the mutex.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./db.js";
import type { jsonCore } from "../store.js";

type Core = typeof jsonCore;
type Listener = "onTransferStateChange" | "onPaymentRequestStateChange";
type Special = Listener | "list" | "holdDailyCap" | "beginTx" | "endTx" | "drainAnnouncements";
type MethodName = {
  [K in keyof Core]: Core[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Core];
type AsyncMethod<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

export type Collection = keyof Db;

type HoldResult = { ok: true; holdId: string } | { ok: false; usedEur: number; capEur: number };

export type StoreMethods = {
  [K in Exclude<MethodName, Special>]: AsyncMethod<Core[K]>;
} & Pick<Core, Listener> & {
  list<K extends Collection>(name: K): Promise<Db[K]>;
  /**
   * Hold part of a daily cap (store.ts holdDailyCap). `used` is recomputed
   * inside the same transaction as the hold, so it may read the store.
   */
  holdDailyCap(capKey: string, eur: number, capEur: number, used: () => number | Promise<number>): Promise<HoldResult>;
};

export type StoreBackend = StoreMethods & {
  /**
   * Run `fn` as one transaction. Awaits inside are allowed; partner and
   * chain calls are not (scripts/check.ts refuses them). Nested calls join
   * the transaction they run in.
   */
  tx<T>(fn: (t: StoreMethods) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
};

/** A FIFO mutex: one holder at a time, in the order they asked. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(fn).finally(release);
  }
}

/** The transaction a call is made in, while it lasts, and whose it is. */
type Scope = { open: boolean; owner: object; t: StoreMethods };
const scope = new AsyncLocalStorage<Scope>();

/** The open transaction of the backend `owner` this call runs in, if any. */
export function currentTx(owner: object): StoreMethods | undefined {
  const s = scope.getStore();
  return s?.open && s.owner === owner ? s.t : undefined;
}

/** Run `fn` as `owner`'s transaction `t`: calls made from it join `t`. */
export async function inScope<T>(owner: object, t: StoreMethods, fn: (t: StoreMethods) => Promise<T> | T): Promise<T> {
  const s: Scope = { open: true, owner, t };
  try {
    return await scope.run(s, () => fn(t));
  } finally {
    s.open = false;
  }
}

const copy = <T>(v: T): T => (v === undefined || v === null || typeof v !== "object" ? v : structuredClone(v));
const copyArgs = (args: unknown[]) => args.map((a) => (typeof a === "function" ? a : copy(a)));

/** The JSON backend over the synchronous core of store.ts. */
export function jsonBackend(core: Core): StoreBackend {
  const mutex = new Mutex();
  const owner = {};
  const flush = () => core.drainAnnouncements();

  /** One call, inside the open transaction or under the mutex. */
  const call = <T>(fn: () => T): Promise<T> => {
    if (currentTx(owner)) return Promise.resolve().then(() => copy(fn()));
    return mutex.run(() => copy(fn())).finally(flush);
  };

  const methods: Record<string, unknown> = {
    list: (name: Collection) => call(() => core.list(name)),
    holdDailyCap: (capKey: string, eur: number, capEur: number, used: () => number | Promise<number>) =>
      backend.tx(async () => {
        const usedEur = await used();
        return core.holdDailyCap(capKey, eur, capEur, () => usedEur);
      }),
    onTransferStateChange: core.onTransferStateChange,
    onPaymentRequestStateChange: core.onPaymentRequestStateChange,
  };
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(core))) {
    if (name in methods || typeof d.value !== "function") continue;
    if (name === "beginTx" || name === "endTx" || name === "drainAnnouncements") continue;
    const fn = d.value as (...args: unknown[]) => unknown;
    methods[name] = (...args: unknown[]) => call(() => fn.apply(core, copyArgs(args)));
  }
  const t = methods as StoreMethods;

  const backend: StoreBackend = {
    ...t,
    tx<T>(fn: (t: StoreMethods) => Promise<T> | T): Promise<T> {
      const open = currentTx(owner);
      if (open) return Promise.resolve().then(() => fn(open));
      return mutex
        .run(async () => {
          core.beginTx();
          try {
            return await inScope(owner, t, fn);
          } finally {
            core.endTx();
          }
        })
        .finally(flush);
    },
    close: async () => {},
  };
  return backend;
}
