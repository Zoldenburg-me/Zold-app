/**
 * The one shape the Postgres backend talks to: `query` and `tx`.
 *
 * Two things satisfy it: a node-postgres pool (production, and the
 * Postgres 17 suite) and PGlite (the offline suites). PGlite is adapted by
 * shape and never imported here, so production never loads it.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Several statements, no parameters: a migration file. */
  exec(text: string): Promise<unknown>;
}

export interface Database extends Sql {
  /** BEGIN … COMMIT around `fn`, ROLLBACK when it throws. READ COMMITTED. */
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** What PGlite offers, by shape (`@electric-sql/pglite`'s PGlite class). */
export interface PgliteLike extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgliteDatabase(db: PgliteLike): Database {
  return {
    query: (text, params) => db.query(text, params),
    exec: (text) => db.exec(text),
    tx: (fn) => db.transaction((t) => fn(t)),
    close: () => db.close(),
  };
}

export function poolDatabase(pool: pg.Pool): Database {
  return {
    query: async (text, params) => pool.query(text, params as unknown[]) as never,
    exec: (text) => pool.query(text),
    async tx(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        // Named, not inherited: a role or database default of REPEATABLE READ
        // would keep one snapshot for the whole transaction, and a write that
        // waited on a lock would not see what the holder committed (§2).
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const out = await fn({
          query: async (text, params) => client.query(text, params as unknown[]) as never,
          // No parameters: the simple protocol, which takes several statements.
          exec: (text) => client.query(text),
        });
        await client.query("COMMIT");
        return out;
      } catch (err) {
        // A ROLLBACK that fails leaves the connection in an unknown state:
        // released with the error, the pool closes it instead of reusing it.
        await client.query("ROLLBACK").catch((e: Error) => {
          broken = e;
        });
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

const EMPTY_HOST = "empty-host.invalid";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The pool settings for `DATABASE_URL`, or a refusal (§4, §7).
 *
 * A unix socket (a `host=/path` parameter, or a host that is a path) and
 * loopback need no TLS. On a real-money chain any other host must ask for
 * `sslmode=verify-full` and come with `DATABASE_CA`, so the server's
 * certificate is checked against a CA we chose. Refusals never echo the URL:
 * it can carry a password.
 */
export function pgPoolConfig(url: string, opts: { ca?: string; realMoney: boolean }): pg.PoolConfig {
  // `postgresql://role@/db?host=/run/…` (§7) has an empty host, which the
  // WHATWG parser refuses; node-postgres reads it as the default socket or
  // loopback. Parsed with a stand-in host, which never reaches the driver.
  const emptyHost = /^[a-z]+:\/\/(?:[^/@]*@)?\//i;
  let u: URL;
  try {
    u = new URL(url.replace(emptyHost, (m) => `${m.slice(0, -1)}${EMPTY_HOST}/`));
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must be a postgresql:// URL");
  }
  const socketHost = u.searchParams.get("host");
  const host = u.hostname === EMPTY_HOST ? "" : decodeURIComponent(u.hostname);
  const onSocket = (socketHost ?? "").startsWith("/") || (!socketHost && host.startsWith("/"));
  const local = onSocket || (!socketHost && (host === "" || LOOPBACK.has(host)));
  const sslmode = u.searchParams.get("sslmode");
  if (!local && opts.realMoney) {
    if (sslmode !== "verify-full") {
      throw new Error("DATABASE_URL points at another host on a real-money chain: it must set sslmode=verify-full");
    }
    if (!opts.ca) throw new Error("DATABASE_URL points at another host on a real-money chain: DATABASE_CA must name the CA");
  }
  if (opts.ca) {
    // The CA is ours; node-postgres's own sslmode parsing would replace this
    // object, so the parameter is taken off the string it parses.
    u.searchParams.delete("sslmode");
    return {
      connectionString: u.toString().replace(`@${EMPTY_HOST}/`, "@/").replace(`//${EMPTY_HOST}/`, "///"),
      ssl: { ca: readFileSync(opts.ca, "utf8"), rejectUnauthorized: true },
    };
  }
  return { connectionString: url };
}

export function openPool(url: string, opts: { ca?: string; realMoney: boolean }): Database {
  return poolDatabase(new pg.Pool(pgPoolConfig(url, opts)));
}
