/**
 * The outbox worker (docs/postgres-store-design.md §5).
 *
 * A notification is an outbox row written in the same transaction as the
 * change it reports (store.enqueueOutbox, or a state listener's return value),
 * so a crash keeps both or neither. This worker, in the API process, claims
 * due rows (`FOR UPDATE SKIP LOCKED` on Postgres; the store's mutex on
 * db.json), delivers each through the handler of its kind, outside any
 * transaction, and settles it: delivered, due again after a backoff, or dead
 * after the kind's last attempt. A dead row stays in the table with its last
 * error, and is logged.
 *
 * A claim lasts LEASE_MS. A process that dies mid-delivery leaves the row
 * claimed; once the lease runs out it is due again, so a delivery can repeat,
 * but never past the kind's last attempt. A settle names its attempt, so a
 * claim that lapsed cannot settle the one that took the row over.
 * Every receiver dedupes on the row id (the checkout webhook's `webhook-id`)
 * or is idempotent (the PAID hooks).
 *
 * A write that adds a row kicks the worker after its commit; a retry kicks it
 * when its backoff ends; and `startOutboxWorker` (server.ts) runs a tick at
 * start and every SWEEP_MS, for rows left by a previous process and leases
 * that ran out.
 */
import { describeCause } from "./http/log-cause.js";
import { store, type OutboxRow } from "./store.js";

export type OutboxHandler = {
  /** Deliver one row. Throwing (or rejecting) counts as a failed attempt. */
  deliver: (row: OutboxRow) => Promise<void>;
  /** Attempts before the row is dead. */
  maxAttempts: number;
  /** Wait before the second attempt; each later one waits BACKOFF_FACTOR times longer. */
  retryBaseMs: number;
};

/** Rows claimed per tick. */
const BATCH = 20;
/** How long a claim lasts: longer than any handler's own timeout. */
export const LEASE_MS = 60_000;
const BACKOFF_FACTOR = 4;
/** The longest a retry waits. */
const MAX_BACKOFF_MS = 60 * 60_000;
/** The safety-net tick. */
const SWEEP_MS = 30_000;
/** Delivered rows are kept this long, then pruned; dead rows are kept. */
const KEEP_DELIVERED_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

const handlers = new Map<string, OutboxHandler>();

/** What the worker has done since the process started. */
export const outboxMetrics = { delivered: 0, retried: 0, dead: 0 };

/** Deliver rows of `kind` through `handler`. Registering arms the worker:
 *  from then on a committed outbox row kicks it. */
export function registerOutboxKind(kind: string, handler: OutboxHandler): void {
  handlers.set(kind, handler);
  arm();
}

let armed = false;
function arm() {
  if (armed) return;
  armed = true;
  store.onOutboxWritten(kickOutbox);
}

/** Wait before attempt `n + 1`, after attempt `n` failed. */
export function backoffMs(h: Pick<OutboxHandler, "retryBaseMs">, n: number): number {
  return Math.min(h.retryBaseMs * BACKOFF_FACTOR ** (n - 1), MAX_BACKOFF_MS);
}

/** Tries at saving a delivery the receiver acknowledged, a second apart. */
const SAVE_DELIVERED_TRIES = 3;

async function deliverOne(row: OutboxRow, h: OutboxHandler): Promise<void> {
  // The claim counts the attempt before the send, so a claim past the limit
  // means the last attempt's lease ran out unsettled (a crash, or a save that
  // failed): its outcome is unknown, and the row ends there, not sent again.
  if (row.attempts > h.maxAttempts) {
    const reason = `attempt ${row.attempts - 1} was not settled before its lease ran out; outcome unknown`;
    if (await store.settleOutbox(row.id, row.attempts, { ok: false, error: reason, dead: true })) {
      outboxMetrics.dead++;
      console.error(`outbox: ${row.kind} ${row.id} dead: ${reason}`);
    }
    return;
  }
  let reason: string;
  try {
    await h.deliver(row);
  } catch (err) {
    reason = describeCause(err);
    await settleFailed(row, h, reason);
    return;
  }
  // Acknowledged: a failed save is not a failed send. It is tried again; if
  // it never lands, the lease runs out and the row is claimed again (sent
  // again, receivers dedupe on the id), or, past the limit, ends as above.
  for (let i = 1; ; i++) {
    try {
      if (await store.settleOutbox(row.id, row.attempts, { ok: true })) outboxMetrics.delivered++;
      return;
    } catch (err) {
      if (i >= SAVE_DELIVERED_TRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function settleFailed(row: OutboxRow, h: OutboxHandler, reason: string): Promise<void> {
  if (row.attempts >= h.maxAttempts) {
    if (await store.settleOutbox(row.id, row.attempts, { ok: false, error: reason, dead: true })) outboxMetrics.dead++;
    console.error(`outbox: ${row.kind} ${row.id} dead after ${row.attempts} attempts: ${reason}`);
    return;
  }
  const wait = backoffMs(h, row.attempts);
  if (!(await store.settleOutbox(row.id, row.attempts, { ok: false, error: reason, retryInMs: wait }))) return;
  outboxMetrics.retried++;
  console.error(`outbox: ${row.kind} ${row.id} attempt ${row.attempts} failed (${reason}); retrying in ${Math.round(wait / 1000)} s`);
  setTimeout(kickOutbox, wait + 5).unref();
}

let lastPrune = 0;

/** Claim the due rows and deliver them, until none is due. Returns how many
 *  were attempted. Not reentrant: use kickOutbox, or call it in a test that
 *  owns the worker. */
export async function runOutboxOnce(): Promise<number> {
  let attempted = 0;
  for (;;) {
    // Only kinds this process delivers: a row of a kind with no handler (a
    // feature switched off) waits, unclaimed, for a process that has one.
    const rows = await store.claimOutbox(BATCH, LEASE_MS, [...handlers.keys()]);
    attempted += rows.length;
    await Promise.all(rows.map((r) => deliverOne(r, handlers.get(r.kind)!).catch((err) => console.error(`outbox: settling ${r.id} failed: ${describeCause(err)}`))));
    if (rows.length < BATCH) break;
  }
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    const n = await store.pruneOutbox(new Date(Date.now() - KEEP_DELIVERED_MS).toISOString());
    if (n) console.log(`outbox: pruned ${n} delivered rows`);
  }
  return attempted;
}

let running: Promise<void> | undefined;
let again = false;

/**
 * Run the worker now, or once more after the run in progress: a row committed
 * while a tick delivers is not left for the next sweep. Resolves when the
 * worker is idle.
 */
export function kickOutbox(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runOutboxOnce();
      } while (again);
    } catch (err) {
      console.error(`outbox: tick failed: ${describeCause(err)}`);
    } finally {
      running = undefined;
    }
  })();
  return running;
}

/** Deliver what is due until nothing is left that is due now (tests). */
export async function drainOutbox(): Promise<void> {
  await kickOutbox();
  while (running) await running;
}

/** A tick now and every SWEEP_MS (server.ts). */
export function startOutboxWorker(): void {
  arm();
  void kickOutbox();
  setInterval(() => void kickOutbox(), SWEEP_MS).unref();
}
