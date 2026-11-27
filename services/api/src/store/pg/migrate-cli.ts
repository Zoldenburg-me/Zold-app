/**
 * The deploy's migration step (docs/postgres-store-design.md §7; run by
 * scripts/oracle-host/deploy.sh before the API starts). Needs DATABASE_URL
 * and nothing else of a deployment's environment.
 *
 *   DATABASE_URL=postgresql://zold_owner@/zold?host=…&port=… APP_ROLE=zold_app \
 *     npm run db:migrate -- apply      # migrate as the owner role, then zold_grant_app(APP_ROLE)
 *   DATABASE_URL=… npm run db:migrate -- status   # "<applied version> <code version>"
 *   DATABASE_URL=… npm run db:migrate -- check    # exit 1 unless the schema is current
 *
 * `apply` prints the versions it applied, one line: "applied 7 8" or
 * "applied none". The deploy reads it: once a file has been applied, a bad
 * deploy is fixed forward, never by starting an older build
 * (assertSchemaCurrent refuses a schema ahead of the code).
 */
import { describeCause } from "../../http/log-cause.js";
import { assertSchemaCurrent, migrate, readMigrations } from "./migrate.js";
import { openPool } from "./sql.js";

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url || !["apply", "status", "check"].includes(cmd ?? "")) {
  console.error("usage: DATABASE_URL=… [APP_ROLE=…] migrate-cli.ts apply|status|check");
  process.exit(2);
}
const appRole = process.env.APP_ROLE;
if (appRole !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) {
  console.error("APP_ROLE is not a plain role name");
  process.exit(2);
}

// realMoney: true is the strict reading of DATABASE_URL (a socket or
// loopback, or verify-full TLS with DATABASE_CA); the host uses a socket.
const db = openPool(url, { ca: process.env.DATABASE_CA, realMoney: true });
const migrations = readMigrations();
try {
  if (cmd === "apply") {
    const done = await migrate(db, migrations);
    // Every deploy, not only one that migrated: zold_grant_app resets the
    // role's grants to exactly §5's.
    if (appRole) await db.query("SELECT zold_grant_app($1)", [appRole]);
    console.log(`applied ${done.length ? done.join(" ") : "none"}`);
  } else if (cmd === "status") {
    const has = await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
    const at = has.rows[0]?.t
      ? (await db.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations")).rows[0]?.v ?? 0
      : 0;
    console.log(`${at} ${migrations.at(-1)?.version ?? 0}`);
  } else {
    console.log(`schema current at ${await assertSchemaCurrent(db, migrations)}`);
  }
} catch (e) {
  // The message names a migration or a version; describeCause drops any URL.
  console.error(describeCause(e));
  process.exitCode = 1;
} finally {
  await db.close();
}
