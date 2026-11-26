/**
 * Sweeps are single-flight (docs/postgres-store-design.md §2): a tick that
 * finds the last tick of the same job still running returns at once. A tick
 * can outlast its interval: the Zoldenburg sweep runs every 60 s and waits up
 * to 90 s for a receipt.
 *
 * The flag is in memory, per job, on both backends, and not a Postgres
 * advisory lock: one API process per deployment is enforced at start
 * (store/pg/start-lock.ts), so a second process sweeping the same rows is
 * already refused. The one window is the start lock's own loss: the process
 * exits at once on its connection's `error` or `end`, but a connection that
 * dies silently is found by the `SELECT 1` every 5 s, so for up to 5 s a
 * second process that took the freed lock can sweep next to this one. The
 * sweeps' writes are conditional (rule 3) and their partner calls are behind
 * reserves (rule 5), which is what holds in that window.
 */
const running = new Set<string>();

/** `fn` as job `name`: a call while the last one runs does nothing and
 *  resolves to undefined. */
export function singleFlight<A extends unknown[], T>(name: string, fn: (...args: A) => Promise<T>): (...args: A) => Promise<T | undefined> {
  return async (...args: A) => {
    if (running.has(name)) return undefined;
    running.add(name);
    try {
      return await fn(...args);
    } finally {
      running.delete(name);
    }
  };
}
