/**
 * One API process per deployment (docs/postgres-store-design.md §2), held
 * on Postgres before the process serves anything.
 *
 * `pg_try_advisory_lock(hashtext('api:' || current_database()))` on a
 * connection of its own, outside the pool. Each deployment has its own
 * database, so the database names the deployment. A second process finds the
 * lock held and refuses to start. The lock lives as long as that connection:
 * a crashed process releases it, and so does a database restart or a dropped
 * connection while the process lives on, which the pool would reconnect
 * from without it. So the connection is watched (its `error` and `end`
 * events, and a `SELECT 1` every 5 s) and on losing it the process exits
 * non-zero at once, before another request or sweep tick runs; systemd
 * starts it again, and the new process takes the lock or refuses to start.
 * A connection that dies without an event is found by the next `SELECT 1`:
 * that is the up-to-5-s window in which a second process can hold the lock
 * next to this one (single-flight.ts says what holds then).
 *
 * Not called by the API yet: config/env.ts refuses STORE_BACKEND=postgres
 * until the cut-over (§8 S8), which takes this lock before `listen`.
 */
import pg from "pg";

export const START_LOCK_PING_MS = 5_000;

export type StartLock = { release(): Promise<void> };

/** Exit at once, non-zero: the lock is gone and another process may hold it. */
const exitOnLoss = (why: string) => {
  console.error(`FATAL the API lost its start lock (${why}) — exiting before anything else runs`);
  process.exit(1);
};

/**
 * Take the start lock on a connection of its own, or throw if another process
 * holds it. `onLost` runs once if the connection is lost afterwards (default:
 * exit 1).
 */
export async function takeStartLock(
  config: pg.ClientConfig,
  opts: { onLost?: (why: string) => void; pingMs?: number } = {},
): Promise<StartLock> {
  const onLost = opts.onLost ?? exitOnLoss;
  const client = new pg.Client(config);
  let released = false;
  let lost = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const lose = (why: string) => {
    if (released || lost) return;
    lost = true;
    clearInterval(ping);
    onLost(why);
  };
  // Registered before connect: an error with no listener would crash the
  // process with an unhandled 'error' event instead of a deliberate exit.
  client.on("error", (err: Error & { code?: string }) => lose(`connection error${err.code ? ` ${err.code}` : ""}`));
  client.on("end", () => lose("connection ended"));
  try {
    await client.connect();
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext('api:' || current_database())) AS ok");
    if (!r.rows[0]?.ok) throw new Error("another API process holds this deployment's start lock; refusing to start");
  } catch (err) {
    released = true;
    await client.end().catch(() => {});
    throw err;
  }
  ping = setInterval(() => {
    client.query("SELECT 1").catch(() => lose("ping failed"));
  }, opts.pingMs ?? START_LOCK_PING_MS);
  ping.unref();
  return {
    async release() {
      released = true;
      clearInterval(ping);
      await client.end().catch(() => {});
    },
  };
}
