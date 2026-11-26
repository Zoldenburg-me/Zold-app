/**
 * The Oracle host's repository parts (scripts/oracle-host/, design §7, §7.2).
 *
 *   npm run oracle-host:test     offline, in `npm run check`: every script
 *                                parses (shellcheck too, when installed), the
 *                                rendered pg_hba/pg_ident/postgresql config,
 *                                the units' hardening, the age pin, no secret
 *                                in host.env.example
 *   tsx scripts/oracle-host-test.ts --pg    in `npm run check:pg`, needs a
 *                                Postgres 17 (TEST_DATABASE_URL, default the
 *                                Homebrew socket in /tmp) and its initdb:
 *
 * - on that server, under names unique to the run and dropped at the end:
 *   database.sql applies twice and check.sql passes; the hub roles cannot
 *   CONNECT to Zold's database nor Zold's to the hub's; hub_app starts with
 *   its settings and cannot raise temp_file_limit, and the watchdog ends a
 *   session that raised its statement_timeout; a write stop survives a re-run;
 *   the migration CLI migrates as the owner and grants the app role; check.sql
 *   fails on an extra grant or a PUBLIC CONNECT; the table check prints the
 *   same lines under other session settings;
 * - in a throwaway cluster (initdb in a temp directory, unix socket only)
 *   started with the rendered config: no TCP listener, the whole-cluster
 *   checks, and pg_hba's first-match order with peer and the maps.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import pg from "pg";

const DIR = path.resolve("scripts/oracle-host");
let passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  assert.ok(ok, `${name}${detail ? `\n${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });

// --- offline ---------------------------------------------------------------------
const scripts = readdirSync(DIR).filter((f) => f.endsWith(".sh")).map((f) => path.join(DIR, f));
scripts.push(path.resolve("scripts/_age.sh"));
for (const f of scripts) {
  const r = sh("bash", ["-n", f]);
  check(`${path.basename(f)} parses`, r.status === 0, r.stderr);
}
if (sh("shellcheck", ["--version"]).status === 0) {
  const r = sh("shellcheck", ["-x", "-S", "warning", ...scripts]);
  check("shellcheck: no warning", r.status === 0, r.stdout);
} else {
  console.log("  --  shellcheck is not installed: bash -n only");
}

function render(dep: string, env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const out = mkdtempSync(path.join(tmpdir(), "zold-render-"));
  try {
    const r = sh("bash", [path.join(DIR, "provision.sh"), "render", dep, out], env);
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(["conf.d/zold.conf", "pg_hba.conf", "pg_ident.conf"].map((f) => [f, readFileSync(path.join(out, f), "utf8")]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
const lines = (s: string) => s.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/));
{
  const m = render("mainnet");
  const hba = lines(m["pg_hba.conf"]);
  check("pg_hba: the cluster's OS user comes first, with no map", hba[0].join(" ") === "local all pg-mainnet peer");
  check("pg_hba: each database line names its two roles, never all", hba.slice(1, 3).every((l) => l[0] === "local" && l[2] !== "all" && l[2].split(",").length === 2));
  check("pg_hba: zold and hub lines, then reject", hba[1][1] === "zold" && hba[2][1] === "hub" && hba[3].join(" ") === "local all all reject");
  check("pg_hba: no TCP line accepts", hba.filter((l) => l[0] !== "local").every((l) => l.at(-1) === "reject"));
  const ident = lines(m["pg_ident.conf"]).map((l) => l.join(" "));
  check("pg_ident: API → app role, deploy user → owner role", ident.includes("zold-mainnet zold-mainnet zold_app") && ident.includes("zold-mainnet zold-deploy-mainnet zold_owner"));
  check("pg_ident: zold-hub → hub_app, deploy user → hub_owner", ident.includes("hub zold-hub hub_app") && ident.includes("hub zold-deploy-mainnet hub_owner"));
  const conf = m["conf.d/zold.conf"];
  check("postgresql: no TCP listener", /^listen_addresses = ''$/m.test(conf));
  check("postgresql: the socket file belongs to the clients' group", /^unix_socket_group = 'zold-mainnet-db'$/m.test(conf) && /^unix_socket_permissions = 0770$/m.test(conf));
  check("provision: the socket directory is 2750, not writable by the clients", readFileSync(path.join(DIR, "provision.sh"), "utf8").includes('echo "d $PG_SOCKET 2750 $PG_USER $PG_CLIENTS -"'));
  check("postgresql: its own socket, reserved connections, archiving every 60 s", /^unix_socket_directories = '\/run\/postgresql-mainnet'$/m.test(conf) && /^reserved_connections = 10$/m.test(conf) && /^archive_timeout = 60s$/m.test(conf));
  check("postgresql: archive_command pushes to the deployment's stanza", conf.includes("archive_command = 'pgbackrest --config=/etc/pgbackrest/mainnet.conf --stanza=zold-mainnet archive-push %p'"));
  const t = render("testnet");
  check("testnet: no hub line or map, its own user and socket", !/hub/.test(t["pg_hba.conf"] + t["pg_ident.conf"]) && lines(t["pg_hba.conf"])[0].join(" ") === "local all pg-testnet peer" && t["conf.d/zold.conf"].includes("/run/postgresql-testnet") && /^port = 5433$/m.test(t["conf.d/zold.conf"]));
  check("testnet with HUB_TESTNET=1: a hub mapped from zold-hub-testnet", render("testnet", { HUB_TESTNET: "1" })["pg_ident.conf"].includes("zold-hub-testnet"));
}
{
  const provision = readFileSync(path.join(DIR, "provision.sh"), "utf8");
  check("provision: UTF-8 encoding and locale", provision.includes("--encoding=UTF8 --locale=C.UTF-8"));
  check("provision: drops the Postgres ports, opens none", /--dport 5432:5433 -j DROP/.test(provision) && !/-j ACCEPT/.test(provision));
  check("provision: refuses a public listener but sshd", provision.includes("listening on a public address"));
  check("provision: never sets archive-push-queue-max", !/^\s*echo "archive-push-queue-max/m.test(provision));
  const units = path.join(DIR, "systemd");
  for (const u of ["zold-api@.service", "zold-hub.service"]) {
    const s = readFileSync(path.join(units, u), "utf8");
    for (const k of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "Restart=on-failure", "CapabilityBoundingSet=\n"]) {
      check(`${u}: ${k.trim()}`, s.includes(k));
    }
    check(`${u}: cannot read the env files or pgBackRest configs`, /^InaccessiblePaths=.*\/etc\/zold .*\/etc\/pgbackrest/m.test(s));
  }
  check("zold-hub.service: its own state directory only", /^ReadWritePaths=\/var\/lib\/zold-hub$/m.test(readFileSync(path.join(units, "zold-hub.service"), "utf8")));
  for (const t of ["deploy", "pg-alerts", "pg-watchdog", "pg-dump", "pg-backup"]) {
    check(`the ${t} timer provision.sh enables exists`, existsSync(path.join(units, `zold-${t}@.timer`)));
  }
  const env = readFileSync(path.join(DIR, "host.env.example"), "utf8");
  const secrets = [...env.matchAll(/^([A-Z0-9_]*(KEY|SECRET|PASS|URL|RECIPIENT|NAMESPACE))=(.*)$/gm)];
  check("host.env.example: every credential is CHANGE_ME", secrets.length >= 13 && secrets.every((m) => m[3] === "CHANGE_ME"), secrets.map((m) => m[1]).join(" "));
  const age = sh("bash", ["-c", `uname() { [[ "$1" == -s ]] && echo Linux || echo aarch64; }; source scripts/_age.sh; age_asset`]);
  check("_age.sh pins linux-arm64", age.stdout.trim() === "age-v1.3.2-linux-arm64.tar.gz 6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4", age.stdout + age.stderr);
}

if (!process.argv.includes("--pg")) {
  console.log(`\noracle-host (offline): ${passed} checks passed`);
  process.exit(0);
}

// --- Postgres 17 -------------------------------------------------------------------
function pgBin(): string {
  const candidates = [process.env.PG_BIN, "/usr/local/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"];
  for (const c of candidates) if (c && existsSync(path.join(c, "psql")) && existsSync(path.join(c, "initdb"))) return c;
  const w = sh("bash", ["-c", "dirname \"$(command -v initdb)\""]);
  if (w.status === 0 && w.stdout.trim() !== ".") return w.stdout.trim();
  throw new Error("no Postgres 17 psql and initdb found: set PG_BIN");
}
const BIN = pgBin();
const psql = (url: string, args: string[], env: NodeJS.ProcessEnv = {}) => sh(path.join(BIN, "psql"), ["-X", "-q", url, ...args], env);
const ver = sh(path.join(BIN, "psql"), ["--version"]).stdout;
assert.match(ver, / 17\./, `psql is not 17: ${ver}`);

const adminUrl = process.env.TEST_DATABASE_URL || "postgresql:///postgres?host=/tmp";
const urlFor = (db: string, user?: string) => {
  const [base, query = ""] = adminUrl.split("?");
  const q = new URLSearchParams(query);
  if (user) q.set("user", user);
  return `${base.replace(/\/[^/]*$/, `/${db}`)}?${q.toString()}`;
};
const suffix = `${Math.floor(Date.now() / 1000)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const N = {
  zold_db: `zold_test_oh_${suffix}`,
  zold_owner: `zoh_owner_${suffix}`,
  zold_app: `zoh_app_${suffix}`,
  hub_db: `zold_test_ohhub_${suffix}`,
  hub_owner: `zoh_hubowner_${suffix}`,
  hub_app: `zoh_hubapp_${suffix}`,
};
const vars = (extra: Record<string, string> = {}) =>
  Object.entries({ ...N, with_hub: "1", hub_conn_limit: "25", ...extra }).flatMap(([k, v]) => ["-v", `${k}=${v}`]);
const dbStep = (extra: Record<string, string> = {}) => psql(adminUrl, [...vars({ maintenance_dbs: "0", ...extra }), "-f", path.join(DIR, "database.sql")]);
const checks = (extra: Record<string, string> = {}) => psql(adminUrl, [...vars({ host_cluster: "0", hub_ported: "0", ...extra }), "-f", path.join(DIR, "check.sql")]);
async function asRole(db: string, user: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: urlFor(db, user) });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}
async function refused(db: string, user: string): Promise<string> {
  try {
    await asRole(db, user, async () => {});
    return "";
  } catch (e) {
    return (e as { code?: string; message: string }).code ?? (e as Error).message;
  }
}

const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
admin.on("error", () => {});
try {
  let r = dbStep();
  check("database.sql applies", r.status === 0, r.stderr);
  r = dbStep();
  check("and again, changing nothing (idempotent)", r.status === 0 && r.stderr === "", r.stderr);
  r = checks();
  check("check.sql passes", r.status === 0 && r.stdout.includes("checks passed"), r.stdout + r.stderr);

  check("hub_app cannot CONNECT to Zold's database", (await refused(N.zold_db, N.hub_app)) === "42501");
  check("hub_owner cannot CONNECT to Zold's database", (await refused(N.zold_db, N.hub_owner)) === "42501");
  check("zold_app cannot CONNECT to the hub's database", (await refused(N.hub_db, N.zold_app)) === "42501");
  check("zold_owner cannot CONNECT to the hub's database", (await refused(N.hub_db, N.zold_owner)) === "42501");
  check("zold_app connects to its own", (await refused(N.zold_db, N.zold_app)) === "");

  await asRole(N.hub_db, N.hub_app, async (c) => {
    const show = async (k: string) => (await c.query(`SHOW ${k}`)).rows[0][k];
    check("hub_app logs in with its pinned settings", (await show("statement_timeout")) === "5s" && (await show("lock_timeout")) === "2s" && (await show("idle_in_transaction_session_timeout")) === "10s" && (await show("temp_file_limit")) === "256MB" && (await show("work_mem")) === "4MB");
    const raise = await c.query("SET temp_file_limit = -1").then(() => "", (e: { code: string }) => e.code);
    check("hub_app cannot raise temp_file_limit", raise === "42501");
    // Postgres lets any session SET these; database.sql says so, and the
    // watchdog is the bound. If this ever refuses, the comment is stale.
    await c.query("SET statement_timeout = 0");
    check("statement_timeout is user-settable (the watchdog bounds it)", (await show("statement_timeout")) === "0");
    const long = c.query("SELECT pg_sleep(60)").then(() => "finished", (e: { code?: string }) => e.code ?? "error");
    await new Promise((res) => setTimeout(res, 11_000));
    const w = psql(adminUrl, ["-At", "-v", `hub_app=${N.hub_app}`, "-f", path.join(DIR, "watchdog.sql")]);
    check("the watchdog ends a hub_app statement past 10 s", w.status === 0 && w.stdout.trim() === "1", w.stdout + w.stderr);
    check("and the session sees it end", (await long) === "57P01");
  }).catch((e: { code?: string }) => {
    if (e.code !== "57P01") throw e;
  });

  // The write stop (§7.2): limit 0 refuses hub_app, and a re-run keeps it.
  await admin.query(`ALTER DATABASE ${N.hub_db} CONNECTION LIMIT 0`);
  check("a stopped hub refuses hub_app", (await refused(N.hub_db, N.hub_app)) === "53300");
  r = dbStep();
  const limit = async () => (await admin.query("SELECT datconnlimit FROM pg_database WHERE datname = $1", [N.hub_db])).rows[0].datconnlimit;
  check("a re-run leaves the stop as it is and says so", r.status === 0 && (await limit()) === 0 && r.stdout.includes("hub is stopped"), r.stdout + r.stderr);
  check("check.sql passes on a stopped hub", checks().status === 0);
  check("but not when it expects the restore's recorded 25", checks({ hub_limit: "25" }).status !== 0);
  r = dbStep({ hub_limit: "25" });
  check("hub_limit=25 lifts it (the hub-only restore of an open hub)", r.status === 0 && (await limit()) === 25);
  // A first run cut short leaves a new hub closed and never opened: the next
  // run opens it, where a stop on an opened hub stays.
  await admin.query(`ALTER DATABASE ${N.hub_db} CONNECTION LIMIT 0`);
  await admin.query(`COMMENT ON DATABASE ${N.hub_db} IS NULL`);
  r = dbStep();
  check("a hub never opened (a cut-short first run) is opened by the re-run", r.status === 0 && (await limit()) === 25 && !r.stdout.includes("hub is stopped"), r.stdout + r.stderr);

  // The deploy's migration step: as the owner role, then zold_grant_app.
  const cli = (cmd: string, user: string, appRole?: string) =>
    sh(process.execPath, ["--import", "tsx", "services/api/src/store/pg/migrate-cli.ts", cmd], { DATABASE_URL: urlFor(N.zold_db, user), ...(appRole ? { APP_ROLE: appRole } : {}) });
  const want = readdirSync("services/api/migrations").filter((f) => f.endsWith(".sql")).length;
  check("status before: 0 of the code's", cli("status", N.zold_owner).stdout.trim() === `0 ${want}`);
  check("check refuses an unmigrated schema", cli("check", N.zold_owner).status === 1);
  r = cli("apply", N.zold_owner, N.zold_app);
  check("apply migrates as the owner and grants the app role", r.status === 0 && r.stdout.trim() === `applied ${Array.from({ length: want }, (_, i) => i + 1).join(" ")}`, r.stdout + r.stderr);
  r = cli("apply", N.zold_owner, N.zold_app);
  check("a second apply applies none", r.status === 0 && r.stdout.trim() === "applied none", r.stdout + r.stderr);
  check("status and check after", cli("status", N.zold_owner).stdout.trim() === `${want} ${want}` && cli("check", N.zold_app).status === 0);
  check("APP_ROLE must be a plain name", cli("apply", N.zold_owner, "x; DROP TABLE ledger").status === 2);
  r = checks();
  check("check.sql passes once migrated (the app role has zold_grant_app's grants)", r.status === 0, r.stdout + r.stderr);
  await asRole(N.zold_db, N.zold_owner, (c) => c.query(`GRANT TRUNCATE ON ledger TO ${N.zold_app}`).then(() => {}));
  r = checks();
  check("check.sql fails on an extra grant", r.status !== 0 && r.stderr.includes("are not those of zold_grant_app"), r.stderr);
  await asRole(N.zold_db, N.zold_owner, (c) => c.query(`REVOKE TRUNCATE ON ledger FROM ${N.zold_app}`).then(() => {}));
  await admin.query(`GRANT CONNECT ON DATABASE ${N.zold_db} TO PUBLIC`);
  r = checks();
  check("check.sql fails on a PUBLIC CONNECT", r.status !== 0 && r.stderr.includes("grants CONNECT or TEMPORARY to PUBLIC"), r.stderr);
  r = dbStep();
  const c2 = checks();
  check("the database step takes it back", r.status === 0 && c2.status === 0, r.stderr + c2.stderr);
  await admin.query(`ALTER ROLE ${N.hub_app} SUPERUSER`);
  check("check.sql fails on a superuser hub role", checks().status !== 0);
  r = dbStep();
  const c3 = checks();
  check("and the database step takes it back", r.status === 0 && c3.status === 0, r.stderr + c3.stderr);

  // The table check: the same rows, the same lines, whatever the session says.
  await asRole(N.zold_db, N.zold_owner, async (c) => {
    await c.query("CREATE TABLE zz_check (zold_row int, t timestamptz, d date, f float8, b bytea, i interval, j json, s text)");
    await c.query(`INSERT INTO zz_check VALUES (1, '2026-11-26 10:00:00.123456+01', '2026-11-26', 0.1, '\\x00ff', '1 day 02:03:04', '{"b":1,"a":[2]}', 'Ä'), (2, NULL, NULL, 1e300, NULL, NULL, NULL, 'b')`);
  });
  const tc = (env: NodeJS.ProcessEnv) => psql(urlFor(N.zold_db), ["-At", "-f", path.join(DIR, "table-check.sql")], env);
  const a = tc({});
  const b = tc({ PGTZ: "America/New_York", PGDATESTYLE: "SQL, DMY", PGOPTIONS: "-c extra_float_digits=0 -c IntervalStyle=sql_standard -c bytea_output=escape" });
  check("table check runs over every table", a.status === 0 && a.stdout.includes("public.zz_check 2 ") && a.stdout.includes("public.schema_migrations ") && a.stdout.includes("public.ledger_history "), a.stdout + a.stderr);
  check("and prints the same under other TimeZone, DateStyle, IntervalStyle, float and bytea settings", a.stdout === b.stdout, `${a.stdout}\n---\n${b.stdout}`);
  await asRole(N.zold_db, N.zold_owner, (c) => c.query("UPDATE zz_check SET s = 'c' WHERE s = 'b'").then(() => {}));
  // A column named like the row alias (zold_row, or the old t) must not stand in for the row.
  const changed = tc({}).stdout;
  check("and a changed row changes its line", changed !== a.stdout && changed.split("\n").filter((l, i) => l !== a.stdout.split("\n")[i]).every((l) => l.startsWith("public.zz_check 2 ")), changed);
} finally {
  for (const db of [N.zold_db, N.hub_db]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  for (const role of [N.zold_owner, N.zold_app, N.hub_owner, N.hub_app]) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await admin.end();
}

// --- a throwaway cluster on the rendered config --------------------------------------
{
  const me = userInfo().username;
  const root = mkdtempSync(path.join(tmpdir(), "zold-cluster-"));
  const data = path.join(root, "data");
  const sock = mkdtempSync(path.join(tmpdir(), "zs-")); // a short path: sockets have a ~100-byte limit
  let started = false;
  try {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
    let r = sh(path.join(BIN, "initdb"), ["-D", data, "-U", me, "--encoding=UTF8", `--locale=${locale}`, "-A", "reject"], { LC_ALL: locale });
    check("initdb a throwaway UTF-8 cluster", r.status === 0, r.stderr);
    const out = mkdtempSync(path.join(root, "render-"));
    // The OS users the maps name are all this one user here: the cluster's
    // OS user, the API, the deploy user and the hub.
    const group = sh("id", ["-gn"]).stdout.trim();
    const env = { ZH_PG_USER: me, ZH_API_USER: me, ZH_DEPLOY_USER: me, ZH_HUB_USER: me, ZH_PG_SOCKET: sock, ZH_PG_CLIENTS: group };
    r = sh("bash", [path.join(DIR, "provision.sh"), "render", "mainnet", out], env);
    assert.equal(r.status, 0, r.stderr);
    const conf = readFileSync(path.join(out, "conf.d/zold.conf"), "utf8").replace(/^port = \d+$/m, `port = ${port}`).replace(/^archive_command = .*$/m, "archive_command = 'true'");
    writeFileSync(path.join(data, "zold.conf"), conf);
    appendFileSync(path.join(data, "postgresql.conf"), "\ninclude 'zold.conf'\n");
    writeFileSync(path.join(data, "pg_hba.conf"), readFileSync(path.join(out, "pg_hba.conf")));
    writeFileSync(path.join(data, "pg_ident.conf"), readFileSync(path.join(out, "pg_ident.conf")));
    r = sh(path.join(BIN, "pg_ctl"), ["-D", data, "-l", path.join(root, "log"), "-w", "-t", "30", "start"], { LC_ALL: locale });
    started = r.status === 0;
    check("the cluster starts on the rendered config", started, r.stderr + (existsSync(path.join(root, "log")) ? readFileSync(path.join(root, "log"), "utf8") : ""));
    const url = (db: string, user = me) => `postgresql:///${db}?host=${encodeURIComponent(sock)}&port=${port}&user=${user}`;
    const tcp = await new Promise<string>((res) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), res("connected")));
      s.once("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error"));
    });
    check("nothing listens on TCP", tcp === "ECONNREFUSED" && psql(url("postgres"), ["-Atc", "SHOW listen_addresses"]).stdout === "\n");
    const v = (extra: Record<string, string>) =>
      Object.entries({ zold_db: "zold", zold_owner: "zold_owner", zold_app: "zold_app", with_hub: "1", hub_db: "hub", hub_owner: "hub_owner", hub_app: "hub_app", hub_conn_limit: "25", ...extra }).flatMap(([k, x]) => ["-v", `${k}=${x}`]);
    r = psql(url("postgres"), [...v({ maintenance_dbs: "1" }), "-f", path.join(DIR, "database.sql")]);
    check("the cluster's OS user runs the database step over its own first pg_hba line", r.status === 0, r.stderr);
    r = psql(url("postgres"), [...v({ host_cluster: "1", hub_ported: "0" }), "-f", path.join(DIR, "check.sql")]);
    check("check.sql passes with the whole-cluster checks (no TCP, reserved connections, UTF-8, archiving, one superuser)", r.status === 0, r.stdout + r.stderr);
    const can = (db: string, user: string) => psql(url(db, user), ["-Atc", "SELECT 1"]);
    check("zold_app reaches zold (peer, map zold-mainnet)", can("zold", "zold_app").stdout.trim() === "1");
    check("zold_owner reaches zold", can("zold", "zold_owner").stdout.trim() === "1");
    check("hub_app reaches hub (peer, map hub)", can("hub", "hub_app").stdout.trim() === "1");
    check("hub_owner reaches hub (the deploy user's map entry)", can("hub", "hub_owner").stdout.trim() === "1");
    for (const [db, user] of [["zold", "hub_app"], ["zold", "hub_owner"], ["hub", "zold_app"], ["hub", "zold_owner"], ["postgres", "zold_app"], ["postgres", "hub_app"]]) {
      r = can(db, user);
      check(`pg_hba rejects ${user} on ${db}`, r.status !== 0 && /pg_hba\.conf rejects/.test(r.stderr), r.stderr);
    }
    check("the superuser reaches every database", ["postgres", "zold", "hub"].every((db) => can(db, me).stdout.trim() === "1"));
  } finally {
    if (started) sh(path.join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(root, { recursive: true, force: true });
    rmSync(sock, { recursive: true, force: true });
  }
}

console.log(`\noracle-host: ${passed} checks passed`);
