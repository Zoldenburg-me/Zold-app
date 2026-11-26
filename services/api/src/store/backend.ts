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
import { describeCause } from "../http/log-cause.js";
import type { Db } from "./db.js";
import type { jsonCore } from "../store.js";
import type { Organisation } from "../domain/types.js";
import type { Transfer, User } from "./types.js";

type Core = typeof jsonCore;
type Listener = "onTransferStateChange" | "onPaymentRequestStateChange";
type Special = Listener | Generic | "list" | "holdDailyCap" | "beginTx" | "endTx" | "takeAnnouncements";
/** Generic methods: a mapped type would lose their type parameter. */
type Generic = "patchUserSub" | "patchOrgSub" | "patchTransferSub";
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
  /** Change one sub-object from its stored value (§2 rule 2): `fn` gets the
   *  value on the row and returns the new one; `patch` goes in the same write. */
  patchUserSub<K extends "passkeySafe" | "monerium">(id: string, key: K, fn: (current: User[K]) => User[K], patch?: Partial<User>): Promise<User>;
  patchOrgSub<K extends "invoicing" | "integrations">(id: string, key: K, fn: (current: Organisation[K]) => Organisation[K], patch?: Partial<Organisation>): Promise<Organisation>;
  patchTransferSub<K extends keyof Transfer>(id: string, key: K, fn: (current: Transfer[K]) => Transfer[K], patch?: Partial<Transfer>): Promise<Transfer>;
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

/** The transaction a call is made in, while it lasts, and whose it is, and
 *  what runs once it has committed or once it has been dropped. */
type Scope = { open: boolean; owner: object; t: StoreMethods; hooks: TxHooks; children: Mutex };
/** What a transaction runs when it ends: `committed` after the commit (JSON:
 *  the file write), `dropped` when it failed (Postgres rolled it back; JSON
 *  wrote what the callback had done before it threw). */
export type TxHooks = { committed: (() => void)[]; dropped: (() => void)[] };
export const newTxHooks = (): TxHooks => ({ committed: [], dropped: [] });
const scope = new AsyncLocalStorage<Scope>();

/** The open transaction of the backend `owner` this call runs in, if any. */
export function currentTx(owner: object): StoreMethods | undefined {
  const s = scope.getStore();
  return s?.open && s.owner === owner ? s.t : undefined;
}

/** The open transaction this call runs in, of any backend: an identity only. */
export function openTxToken(): object | undefined {
  const s = scope.getStore();
  return s?.open ? s : undefined;
}

/**
 * Refuse partner and chain I/O inside a `store.tx` (§3): a transaction does
 * not span I/O we do not own. On JSON the mutex would hold every other store
 * call behind a partner's latency; on Postgres the row locks would. `fetch`
 * (which the adapters and viem's HTTP transport use) is guarded below, and
 * `writeAndWait` (chain.ts) calls this itself.
 */
export function refuseInTx(what: string): void {
  if (scope.getStore()?.open) throw new Error(`${what} inside a store.tx: a transaction does not span I/O we do not own`);
}

/** `fetch` refuses inside a transaction. Installed once, when the store loads. */
const FETCH_GUARD = Symbol.for("zold.store.fetch-guard");
function guardFetch() {
  const g = globalThis as typeof globalThis & { [FETCH_GUARD]?: true };
  if (g[FETCH_GUARD] || typeof g.fetch !== "function") return;
  const fetch = g.fetch.bind(g);
  g.fetch = ((...args: Parameters<typeof fetch>) => {
    refuseInTx("fetch");
    return fetch(...args);
  }) as typeof fetch;
  g[FETCH_GUARD] = true;
}
guardFetch();

/**
 * Inside an open transaction, hold `fn` until it has committed, and run
 * `dropped` instead if the transaction fails; true when held. A response sent
 * from a `store.tx` callback goes out after the write is on disk
 * (http/send-after-commit.ts).
 */
export function deferToCommit(fn: () => void, dropped?: () => void): boolean {
  const s = scope.getStore();
  if (!s?.open) return false;
  s.hooks.committed.push(fn);
  if (dropped) s.hooks.dropped.push(dropped);
  return true;
}

/** Inside an open transaction, run `fn` if it fails; true when registered.
 *  Dropped hooks run last first: each undoes what came after the one before. */
export function onTxDropped(fn: () => void): boolean {
  const s = scope.getStore();
  if (!s?.open) return false;
  s.hooks.dropped.push(fn);
  return true;
}

/** Run each of `queue` in order (`reverse`: last first, as undo runs). One
 *  that throws is logged and the rest still run: the transaction has ended
 *  either way, and its caller must not see a failure for a commit that
 *  happened. */
function runEach(queue: (() => void)[], what: string, reverse = false): void {
  const fns = queue.splice(0);
  if (reverse) fns.reverse();
  for (const fn of fns) {
    try {
      fn();
    } catch (err) {
      console.error(`store: ${what} hook failed: ${describeCause(err)}`);
    }
  }
}

/** Settle a transaction's hooks on its outcome, and pass the outcome on. */
export function endTx<T>(p: Promise<T>, hooks: TxHooks): Promise<T> {
  return p.then(
    (out) => {
      hooks.dropped.length = 0;
      runEach(hooks.committed, "after-commit");
      return out;
    },
    (err) => {
      hooks.committed.length = 0;
      runEach(hooks.dropped, "dropped-transaction", true);
      throw err;
    },
  );
}

/** Run `fn` as `owner`'s transaction `t`: calls made from it join `t`. */
export async function inScope<T>(owner: object, t: StoreMethods, fn: (t: StoreMethods) => Promise<T> | T, hooks: TxHooks = newTxHooks()): Promise<T> {
  const s: Scope = { open: true, owner, t, hooks, children: new Mutex() };
  try {
    return await scope.run(s, () => fn(t));
  } finally {
    s.open = false;
  }
}

/**
 * A `store.tx` called inside `owner`'s open transaction, or undefined when
 * there is none. It joins the transaction, as one unit of it: the nested
 * transactions of one parent run one after another, each inside `savepoint`
 * (Postgres: a SAVEPOINT, so a failure the caller catches undoes only the
 * nested part and the transaction goes on; JSON: none, it has no rollback).
 * What it held for the commit goes on to the parent's commit if it succeeds,
 * and is dropped if it fails.
 */
export function nestedTx<T>(
  owner: object,
  fn: (t: StoreMethods) => Promise<T> | T,
  savepoint: <R>(fn: () => Promise<R>) => Promise<R> = (f) => f(),
): Promise<T> | undefined {
  const parent = scope.getStore();
  if (!parent?.open || parent.owner !== owner) return undefined;
  return parent.children.run(async () => {
    const hooks = newTxHooks();
    const child: Scope = { open: true, owner, t: parent.t, hooks, children: new Mutex() };
    try {
      const out = await savepoint(() => scope.run(child, async () => await fn(parent.t)));
      parent.hooks.committed.push(...hooks.committed);
      parent.hooks.dropped.push(...hooks.dropped);
      return out;
    } catch (err) {
      hooks.committed.length = 0;
      runEach(hooks.dropped, "dropped-transaction", true);
      throw err;
    } finally {
      child.open = false;
    }
  });
}

/** The lock methods (lockUser, lockOrganisation, lockKey): a lock is held until
 *  its transaction ends, so outside one it would hold nothing. */
export const isLock = (name: string) => /^lock[A-Z]/.test(name);
export const lockOutsideTx = (name: string) => new Error(`${name} outside a store.tx holds nothing`);

const copy = <T>(v: T): T => (v === undefined || v === null || typeof v !== "object" ? v : structuredClone(v));
const copyArgs = (args: unknown[]) => args.map((a) => (typeof a === "function" ? a : copy(a)));

/** The JSON backend over the synchronous core of store.ts. */
export function jsonBackend(core: Core): StoreBackend {
  const mutex = new Mutex();
  const owner = {};
  /**
   * Run `fn` holding the mutex, then the announcements of what it wrote.
   * They are taken before the mutex is released, so a holder that comes
   * after (and has not persisted yet) never has its announcements fired by
   * this one.
   */
  const held = <T>(fn: () => Promise<T> | T): Promise<T> => {
    let taken: (() => void)[] = [];
    return mutex
      .run(async () => {
        try {
          return await fn();
        } finally {
          taken = core.takeAnnouncements();
        }
      })
      .finally(() => {
        for (const run of taken) run();
      });
  };

  /** One call, inside the open transaction or under the mutex. */
  const call = <T>(fn: () => T): Promise<T> => {
    if (currentTx(owner)) return Promise.resolve().then(() => copy(fn()));
    return held(() => copy(fn()));
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
    if (name === "beginTx" || name === "endTx" || name === "takeAnnouncements") continue;
    const fn = d.value as (...args: unknown[]) => unknown;
    methods[name] = (...args: unknown[]) => {
      if (isLock(name) && !currentTx(owner)) return Promise.reject(lockOutsideTx(name));
      return call(() => fn.apply(core, copyArgs(args)));
    };
  }
  const t = methods as StoreMethods;

  const backend: StoreBackend = {
    ...t,
    tx<T>(fn: (t: StoreMethods) => Promise<T> | T): Promise<T> {
      const nested = nestedTx(owner, fn);
      if (nested) return nested;
      const hooks = newTxHooks();
      return endTx(
        held(async () => {
          core.beginTx();
          try {
            return await inScope(owner, t, fn, hooks);
          } finally {
            core.endTx();
          }
        }),
        hooks,
      );
    },
    close: async () => {},
  };
  return backend;
}
