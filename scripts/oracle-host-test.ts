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
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, input });

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
  check("pg_ident: zold-hub → hub_app, and no OS user → hub_owner", ident.includes("hub zold-hub hub_app") && !ident.some((l) => l.endsWith(" hub_owner")));
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
  const ss = [
    "LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*", "LISTEN 0 128 [::1]:3000 [::]:*", "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*", "LISTEN 0 128 [::]:22 [::]:*",
    "LISTEN 0 128 127.0.0.53%lo:53 0.0.0.0:*", "LISTEN 0 4096 100.109.142.100%tailscale0:37349 0.0.0.0:*", "LISTEN 0 4096 [fd7a:115c:a1e0::8c33:8e65]%tailscale0:41673 [::]:*",
    "LISTEN 0 128 0.0.0.0:5432 0.0.0.0:*", "LISTEN 0 128 10.0.0.5:8080 0.0.0.0:*", "LISTEN 0 128 [::]:443 [::]:*",
  ].join("\n") + "\n";
  const pub = sh("bash", ["-c", `R=; source "$0"; public_listeners`, path.join(DIR, "lib.sh")], {}, ss);
  check("public_listeners: loopback, sshd and tailscale0 pass; 0.0.0.0, a VCN address and [::] do not", pub.stdout.trim().split("\n").join(" ") === "0.0.0.0:5432 10.0.0.5:8080 [::]:443", pub.stdout + pub.stderr);
  check("provision: the public-listener check is public_listeners", provision.includes('public="$(ss -Htln | public_listeners)"'));
  check("provision: the pgBackRest parents are root's 755 before pg-<dep>'s own directories", provision.indexOf("install -d -o root -g root -m 755 /var/spool/pgbackrest /var/log/pgbackrest") > 0 && provision.indexOf("install -d -o root -g root -m 755 /var/spool/pgbackrest") < provision.indexOf('install -d -o "$PG_USER" -g "$PG_USER" -m 750 "/var/spool/pgbackrest/$DEP"'));
  const host = (endpoint: string) => sh("bash", ["-c", `R=; source "$0"; OCI_NAMESPACE=ns; s3_host "$1" eu-frankfurt-1`, path.join(DIR, "lib.sh"), endpoint]);
  check("s3_host: no endpoint is OCI Object Storage in the region", host("").stdout === "ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com");
  check("s3_host: an owner's host name is used as it is (R2)", host("0123abcd.r2.cloudflarestorage.com").stdout === "0123abcd.r2.cloudflarestorage.com");
  for (const bad of ["https://a.r2.cloudflarestorage.com", "a.example/x", "a example", "a\nrepo1-s3-key=x", "-a.example", "A.EXAMPLE"]) {
    const r = host(bad);
    check(`s3_host refuses ${JSON.stringify(bad)}`, r.status !== 0 && r.stdout === "" && /bare host name/.test(r.stderr), r.stdout + r.stderr);
  }
  check("provision: each repository's endpoint through endpoint (the raw value), its own key or the shared one",
    provision.includes('echo "repo$n-s3-endpoint=$(endpoint "REPO${n}_ENDPOINT" "$region")"') && provision.includes('echo "repo$n-s3-key=${key:-$(v S3_KEY)}"') && provision.includes('echo "repo$n-s3-key-secret=${secret:-$(v S3_SECRET)}"'));
  check("provision: endpoints are checked before anything is made, a repository key needs its secret",
    provision.indexOf("endpoint DUMP_ENDPOINT x") < provision.indexOf("mountpoint -q") && provision.includes('need "REPO${n}_S3_KEY"; need "REPO${n}_S3_SECRET"; else shared_key=1; fi'));
  check("provision: OCI_NAMESPACE only while a target is on OCI, the shared key only while a repository uses it",
    provision.includes('if [[ "$shared_key" == 1 ]]; then need S3_KEY; need S3_SECRET; fi') && provision.includes('if [[ "$on_oci" == 1 ]]; then host_vars="OCI_NAMESPACE $host_vars"; fi') && !/for v in REPOS S3_KEY/.test(provision));
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

// --- deploy.sh and pgops.sh on a fake host layout ----------------------------------
// ZH_ROOT prefixes every host path (lib.sh; refused under a real root). Shims
// stand in for root's tools (runuser logs its user, command and environment;
// systemctl, psql, df, flock, logger), and the deploy user's PATH gets npm (a
// fake migration CLI) and node. git is real, on a local `production` branch.
// The alert endpoint is a dead https:// address, so every alert fails to send.
function fakeHost(opts: { alertOk?: boolean } = {}) {
  const R = mkdtempSync(path.join(tmpdir(), "zold-host-"));
  const shims = path.join(R, "shims");
  const nodeBin = path.join(R, "opt/node-v22.23.4-linux-arm64/bin");
  for (const d of [shims, nodeBin, "srv/zold/mainnet/releases", "srv/zold/testnet/releases", "srv/pg/mainnet", "srv/pg/testnet", "etc/zold", "etc/zold-host", "run", "var/lib/zold-host"]) {
    mkdirSync(path.isAbsolute(d) ? d : path.join(R, d), { recursive: true });
  }
  const realCurl = sh("bash", ["-c", "command -v curl"]).stdout.trim();
  const shim = (dir: string, name: string, body: string) => {
    writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  };
  shim(shims, "id", `[[ "$1" == -u ]] && { echo 0; exit 0; }; exec /usr/bin/id "$@"`);
  shim(shims, "runuser", `n=$(ls "${R}"/runuser.env.* 2>/dev/null | wc -l | tr -d ' ')\nenv >"${R}/runuser.env.$n"\necho "$2 :: \${*:4}" >>"${R}/runuser.log"\nshift 3\nexec "$@"`);
  shim(shims, "systemctl", `echo "$*" >>"${R}/systemctl.log"\ncase "$1" in start) touch "${R}/api-running" ;; stop) rm -f "${R}/api-running" ;; esac`);
  shim(shims, "flock", "exit 0");
  shim(shims, "sleep", "exit 0");
  shim(shims, "logger", `echo "$*" >>"${R}/journal"`);
  shim(shims, "sha256sum", `[[ -x /usr/bin/sha256sum ]] && exec /usr/bin/sha256sum "$@"; exec shasum -a 256 "$@"`);
  shim(shims, "df", `echo Use%; echo " $(cat "${R}/df-used" 2>/dev/null || echo 50)%"`);
  shim(shims, "pgbackrest", "exit 0");
  shim(shims, "pg_dumpall", `echo "-- globals"`);
  shim(shims, "pg_dump", `echo "dump of $*"`);
  mkdirSync(path.join(R, "opt/age"), { recursive: true });
  shim(path.join(R, "opt/age"), "age", `[[ "$1" == -r && "$3" == -o ]] || exit 2\ncat >"$4"`);
  // /api/health answers only on the port the API would bind, and only with
  // the release's deployments.json in place (what the real endpoint needs).
  // An alert to https://alerts.ok/ is "sent" (recorded); any other alert URL
  // goes to the real curl. The dump's object PUT is recorded, never sent.
  shim(shims, "curl", `if [[ "$*" == */api/health* ]]; then
  [[ -f "${R}/api-running" && -f "${R}/srv/zold/mainnet/app/deployments.json" && "$*" == *127.0.0.1:$(cat "${R}/api-port")/* ]]; exit
fi
if [[ "$*" == *objectstorage* || "$*" == *r2.cloudflarestorage.com* ]]; then cat >"${R}/uploaded.cred"; echo "\${@: -1}" >"${R}/uploaded.url"; echo "$*" >"${R}/uploaded.args"; while [[ "$1" != -T ]]; do shift; done; cp "$2" "${R}/uploaded.tar"; exit 0; fi
if [[ "$*" == *--proto* ]]; then
  cfg="$(cat)"
  if [[ "$cfg" == *https://alerts.ok/* ]]; then echo "\${@: -1}" >>"${R}/alerts.sent"; exit 0; fi
  printf '%s\n' "$cfg" | exec ${realCurl} "$@"
fi
exec ${realCurl} "$@"`);
  // With -c: one answer per query. Without: the dump's session on stdin.
  shim(shims, "psql", `while [[ $# -gt 0 && "$1" != -c ]]; do shift; done; sql="\${2:-}"
if [[ $# == 0 ]]; then
  while read -r l; do
    case "$l" in
      *pg_export_snapshot*) echo 00000003-0000001B-1 ;;
      *__end__*) echo "ledger|1|abc"; echo __end__ ;;
      *'\\q'*) exit 0 ;;
    esac
  done
  exit 0
fi
case "$sql" in
  *pg_stat_archiver*) echo 0 ;;
  *pg_ls_archive_statusdir*) echo "0|0" ;;
  *pg_stat_wal*) echo 0 ;;
  *pg_stat_database*) echo "zold|8 MB|10" ;;
  *"CONNECTION LIMIT 0"*) touch "${R}/hub-stopped" ;;
  *pg_terminate_backend*) echo 0 ;;
  *datconnlimit*) if [[ -f "${R}/hub-stopped" ]]; then echo 0; else echo 25; fi ;;
  *pg_database_size*) echo 100 ;;
  *"SELECT 1 FROM pg_database"*) echo 1 ;;
  *) echo "psql shim: unexpected $sql" >&2; exit 1 ;;
esac`);
  symlinkSync(process.execPath, path.join(nodeBin, "node"));
  // GNU mv -T on macOS too.
  shim(nodeBin, "mv", `if [[ "$1" == -T ]]; then exec perl -e 'rename($ARGV[0], $ARGV[1]) or die "mv: $!\\n"' "$2" "$3"; fi\nexec /bin/mv "$@"`);
  shim(nodeBin, "npm", `S="${R}/schema"
case "$*" in
  ci*) exit 0 ;;
  *"db:migrate -- status"*) echo "$(cat "$S" 2>/dev/null || echo 0) 3" ;;
  *"db:migrate -- apply"*) if [[ "$(cat "$S" 2>/dev/null || echo 0)" == 3 ]]; then echo "applied none"; else echo 3 >"$S"; echo "applied 0001 0002 0003"; fi ;;
  *) echo "npm shim: $*" >&2; exit 1 ;;
esac`);
  const origin = path.join(R, "origin");
  const git = (...a: string[]) => {
    const r = sh("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  mkdirSync(origin);
  git("init", "-q", "-b", "production");
  const commit = (n: number) => {
    writeFileSync(path.join(origin, "package.json"), JSON.stringify({ name: "zold", n }));
    git("add", "package.json");
    git("commit", "-q", "-m", `release ${n}`);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(path.join(R, "etc/zold-host/host.env"),
    `ALERT_URL=${opts.alertOk ? "https://alerts.ok/zold-test" : "https://127.0.0.1:9/zold-test"}\nOCI_NAMESPACE=ns\nOWNER_AGE_RECIPIENT=age1test\nMAINNET_DUMP_REGION=eu-frankfurt-1\nMAINNET_DUMP_BUCKET=dumps\nMAINNET_DUMP_KEY=k\nMAINNET_DUMP_SECRET=mainnet-sentinel-dump\nREPO_URL=${origin}\nMAINNET_S3_SECRET=mainnet-sentinel-s3\nMAINNET_CIPHER_PASS=mainnet-sentinel-pass\nTESTNET_S3_SECRET=testnet-sentinel-s3\nTESTNET_DUMP_SECRET=testnet-sentinel-dump\n`);
  writeFileSync(path.join(R, "api-port"), "3001");
  const run = (script: string, arg: string, umask = "022") =>
    sh("bash", ["-c", `umask ${umask} && exec bash "$0" "$1"`, path.join(DIR, script), arg], { ZH_ROOT: R, PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` });
  const read = (f: string) => (existsSync(path.join(R, f)) ? readFileSync(path.join(R, f), "utf8") : "");
  return { R, commit, run, read, origin };
}
{
  const h = fakeHost();
  try {
    const base = path.join(h.R, "srv/zold/mainnet");
    const sha1 = h.commit(1);
    let r = h.run("deploy.sh", "mainnet");
    check("deploy: without the API's env file, nothing is staged", r.status === 0 && !existsSync(path.join(base, "app")) && !existsSync(path.join(base, "releases", sha1)) && h.read("schema") === "", r.stdout + r.stderr);
    writeFileSync(path.join(h.R, "etc/zold/mainnet.env"), `PORT=9999\nTRANSF_API_PORT=3000\nTRANSF_API_PORT="3001"\n`);
    r = h.run("deploy.sh", "mainnet");
    check("deploy: without deployments.json, nothing is built or migrated", r.status === 0 && /deployments\.json is missing/.test(r.stdout) && h.read("schema") === "" && !existsSync(path.join(base, "app")), r.stdout + r.stderr);
    const deployments = JSON.stringify({ 8453: { eure: "0x0000000000000000000000000000000000000001" } });
    writeFileSync(path.join(h.R, "etc/zold/mainnet.deployments.json"), deployments);
    r = h.run("deploy.sh", "mainnet", "077");
    check("deploy: a first deploy on a fresh host migrates, starts the API and passes health (TRANSF_API_PORT, last and unquoted)",
      r.status === 0 && /deployed/.test(r.stdout) && h.read("schema") === "3\n" && existsSync(path.join(h.R, "api-running")), r.stdout + r.stderr + h.read("journal"));
    check("deploy: app links to the release, which holds the owner's deployments.json",
      readlinkSync(path.join(base, "app")) === `releases/${sha1}` && readFileSync(path.join(base, "app/deployments.json"), "utf8") === deployments);
    const dj = statSync(path.join(base, "app/deployments.json"));
    check("deploy: the release's deployments.json is 640 in the deploy group, even under umask 077 (the API reads it as a member)",
      (dj.mode & 0o777) === 0o640 && dj.gid === process.getgid?.(), (dj.mode & 0o777).toString(8));
    check("zold-deploy@.service: UMask=0027 (the API reads the releases through the deploy group)", /^UMask=0027$/m.test(readFileSync(path.join(DIR, "systemd/zold-deploy@.service"), "utf8")));
    const users = new Set(h.read("runuser.log").trim().split("\n").map((l) => l.split(" :: ")[0]));
    check("deploy: every command in /srv/zold runs as the deploy user", users.size === 1 && users.has("zold-deploy-mainnet"), [...users].join(","));
    const src = readFileSync(path.join(DIR, "deploy.sh"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#"));
    const rootWrites = src.filter((l) => /\b(rm -r|ln -s|mv -|cat >|xargs)/.test(l) && !/as_deploy/.test(l));
    check("deploy.sh: no rm, ln, mv or write in the deploy user's tree outside as_deploy", rootWrites.length === 0, rootWrites.join("\n"));

    for (let n = 2; n <= 4; n++) {
      const s = h.commit(n);
      r = h.run("deploy.sh", "mainnet");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(readlinkSync(path.join(base, "app")), `releases/${s}`);
    }
    check("deploy: keeps the running release and the two before it", readdirSync(path.join(base, "releases")).length === 3, readdirSync(path.join(base, "releases")).join(" "));

    // A planted symlink: releases -> a directory root must not touch.
    const victim = path.join(h.R, "victim");
    mkdirSync(path.join(victim, "keep"), { recursive: true });
    renameSync(path.join(base, "releases"), path.join(base, "releases.real"));
    symlinkSync(victim, path.join(base, "releases"));
    h.commit(5);
    r = h.run("deploy.sh", "mainnet");
    check("deploy: refuses a releases symlink and touches nothing behind it", r.status === 1 && existsSync(path.join(victim, "keep")) && readdirSync(victim).length === 1 && /releases is not a directory/.test(h.read("journal")), r.stdout + r.stderr);
    rmSync(path.join(base, "releases"));
    renameSync(path.join(base, "releases.real"), path.join(base, "releases"));
    const app = readlinkSync(path.join(base, "app"));
    rmSync(path.join(base, "app"));
    symlinkSync("../../../victim", path.join(base, "app"));
    r = h.run("deploy.sh", "mainnet");
    check("deploy: refuses an app link that is not releases/<commit>", r.status === 1 && /app points at/.test(h.read("journal")), r.stdout + r.stderr);
    rmSync(path.join(base, "app"));
    symlinkSync(app, path.join(base, "app"));

    // A failed step with no alert of its own still alerts (the send fails here).
    renameSync(h.origin, `${h.origin}.gone`);
    r = h.run("deploy.sh", "mainnet");
    check("deploy: a failed fetch alerts", r.status !== 0 && /deploy failed \(exit/.test(h.read("journal")), h.read("journal"));
  } finally {
    rmSync(h.R, { recursive: true, force: true });
  }
}
{
  const h = fakeHost();
  try {
    writeFileSync(path.join(h.R, "df-used"), "90"); // 10 % free
    const r = h.run("pgops.sh", "mainnet-alerts");
    check("alerts: with the alert endpoint dead, the hub write stop still runs, and the job fails",
      existsSync(path.join(h.R, "hub-stopped")) && r.status === 1 && /alert not sent: mainnet: Postgres volume under 15 % free/.test(r.stderr), r.stdout + r.stderr);
    const envs = () => readdirSync(h.R).filter((f) => f.startsWith("runuser.env.")).map((f) => h.read(f)).join("\n");
    check("alerts: mainnet's runuser commands see no host.env secret", !/sentinel/.test(envs()));
    for (const f of readdirSync(h.R).filter((f) => f.startsWith("runuser."))) rmSync(path.join(h.R, f));
    writeFileSync(path.join(h.R, "df-used"), "50");
    const t = h.run("pgops.sh", "testnet-alerts");
    const tenv = envs();
    check("alerts: testnet jobs (as pg-testnet) never see mainnet's or testnet's secrets", t.status === 0 && tenv.length > 0 && !/sentinel/.test(tenv) && /pg-testnet/.test(h.read("runuser.log")), t.stdout + t.stderr);
    const envFile = path.join(h.R, "etc/zold-host/host.env");
    const clean = readFileSync(envFile, "utf8");
    appendFileSync(envFile, "TESTNET_CIPHER_PASS='x-export-y;set-a'\n");
    check("host.env: a value that only contains export or set passes", h.run("pgops.sh", "testnet-alerts").status === 0);
    for (const line of ["export MAINNET_DUMP_KEY=x", "  declare -x A=1", "readonly -x A=1", "typeset -x A=1", "set -a", "set -o allexport", "A=1; export B=2", "A=1 && export B", "A=$(export B=1)", "eval B=1"]) {
      writeFileSync(envFile, `${clean}${line}\n`);
      const x = h.run("pgops.sh", "testnet-alerts");
      check(`host.env with \`${line.trim()}\` is refused`, x.status !== 0 && /assignments only/.test(x.stderr), x.stderr);
    }
  } finally {
    rmSync(h.R, { recursive: true, force: true });
  }
}
{
  // The dump spool is root's: pg_dump writes only into a pipe the job reads,
  // and a link planted in the spool is never followed.
  const h = fakeHost();
  try {
    const vol = path.join(h.R, "srv/pg/mainnet");
    const spool = path.join(vol, "dump-spool");
    const victim = path.join(h.R, "victim");
    mkdirSync(victim);
    writeFileSync(path.join(victim, "shadow"), "root's file\n");
    // A failed night's leftovers, with links planted in them.
    mkdirSync(path.join(spool, "20260101T000000Z"), { recursive: true });
    symlinkSync(path.join(victim, "shadow"), path.join(spool, "20260101T000000Z/globals.sql.age"));
    symlinkSync(victim, path.join(spool, "20260101T000000Z.tar"));
    let r = h.run("pgops.sh", "mainnet-dump");
    const tar = sh("tar", ["-tf", path.join(h.R, "uploaded.tar")]).stdout.split("\n").map((l) => l.replace(/^\.\//, "")).filter((l) => l && l !== ".").sort();
    check("dump: globals and each database's dump and check, uploaded as one tar", r.status === 0 && tar.join(" ") === "globals.sql.age hub.check.age hub.dump.age zold.check.age zold.dump.age", r.stdout + r.stderr + tar.join(" "));
    check("dump: planted links in the spool are removed, never followed", readFileSync(path.join(victim, "shadow"), "utf8") === "root's file\n" && readdirSync(victim).join() === "shadow" && readdirSync(spool).length === 0, readdirSync(spool).join(" "));
    const ran = h.read("runuser.log").trim().split("\n").map((l) => l.split(" :: ")[1].split(" ")[0]);
    check("dump: as pg-mainnet only pg_dumpall, psql and pg_dump, which write no file", ran.every((c) => ["pg_dumpall", "psql", "pg_dump"].includes(c)) && /^pg-mainnet :: /.test(h.read("runuser.log")), ran.join(" "));
    check("dump: by default to OCI Object Storage in DUMP_REGION", /^https:\/\/ns\.compat\.objectstorage\.eu-frankfurt-1\.oraclecloud\.com\/dumps\/mainnet\/\d{8}T\d{6}Z\.tar$/.test(h.read("uploaded.url").trim()), h.read("uploaded.url"));
    check("dump: signed for DUMP_REGION with the dump key, the key on stdin only", h.read("uploaded.args").includes("--aws-sigv4 aws:amz:eu-frankfurt-1:s3") && h.read("uploaded.cred").trim() === 'user = "k:mainnet-sentinel-dump"' && !h.read("uploaded.args").includes("sentinel"), h.read("uploaded.args"));
    const envFile = path.join(h.R, "etc/zold-host/host.env");
    const base = readFileSync(envFile, "utf8");
    writeFileSync(envFile, base + "MAINNET_DUMP_ENDPOINT=acct.r2.cloudflarestorage.com\nMAINNET_DUMP_REGION=auto\n");
    r = h.run("pgops.sh", "mainnet-dump");
    check("dump: DUMP_ENDPOINT sends it outside OCI (Cloudflare R2)", r.status === 0 && /^https:\/\/acct\.r2\.cloudflarestorage\.com\/dumps\/mainnet\//.test(h.read("uploaded.url").trim()), r.stderr + h.read("uploaded.url"));
    check("dump: on R2 signed for region auto with the same dump key", h.read("uploaded.args").includes("--aws-sigv4 aws:amz:auto:s3") && h.read("uploaded.cred").trim() === 'user = "k:mainnet-sentinel-dump"', h.read("uploaded.args"));
    rmSync(path.join(h.R, "uploaded.url"));
    writeFileSync(envFile, base + "MAINNET_DUMP_ENDPOINT=https://acct.r2.cloudflarestorage.com\n");
    r = h.run("pgops.sh", "mainnet-dump");
    check("dump: an endpoint that is not a bare host name is refused, nothing uploaded", r.status === 1 && !existsSync(path.join(h.R, "uploaded.url")) && /daily dump failed/.test(h.read("journal")), r.stdout + r.stderr);
    writeFileSync(envFile, base + "MAINNET_DUMP_ENDPOINT=$'\\n'\n");
    r = h.run("pgops.sh", "mainnet-dump");
    check("dump: a newline-only endpoint is refused, not taken for OCI", r.status === 1 && !existsSync(path.join(h.R, "uploaded.url")) && /bare host name/.test(r.stderr), r.stdout + r.stderr);
    writeFileSync(envFile, base);
    // The spool itself swapped for a link: refused, nothing written behind it.
    rmSync(spool, { recursive: true });
    symlinkSync(victim, spool);
    r = h.run("pgops.sh", "mainnet-dump");
    check("dump: a spool that is a link is refused and nothing behind it is touched", r.status === 1 && readdirSync(victim).join() === "shadow" && /daily dump refused/.test(h.read("journal")), r.stdout + r.stderr);
    const pgops = readFileSync(path.join(DIR, "pgops.sh"), "utf8");
    const provision = readFileSync(path.join(DIR, "provision.sh"), "utf8");
    check("dump: the spool is not chowned to pg-<dep>, and the volume root and the spool must be root's (-O)", !/-o "\$PG_USER"/.test(pgops) && pgops.includes('-O "$vol"') && pgops.includes('-O "$root"'));
    check("provision: the volume root is root's 755, the spool root's 700, a pg-owned or linked spool removed",
      provision.includes('install -d -o root -g root -m 755 "/srv/pg/$DEP"') && provision.includes('[[ -d "$SPOOL" ]] || mkdir -m 700 "$SPOOL"') && /-L "\$SPOOL" \|\| \( -e "\$SPOOL" && ! -O "\$SPOOL" \)/.test(provision) && provision.indexOf("-m 755 \"/srv/pg/$DEP\"") < provision.indexOf("pg_createcluster \"$PG_MAJOR\""));
  } finally {
    rmSync(h.R, { recursive: true, force: true });
  }
}
{
  // A missing owner file alerts, once per 30 minutes per file.
  const h = fakeHost({ alertOk: true });
  try {
    h.commit(1);
    h.run("deploy.sh", "mainnet");
    const r = h.run("deploy.sh", "mainnet");
    const sent = () => h.read("alerts.sent").trim().split("\n").filter(Boolean);
    check("deploy: a missing env file sends one alert over two runs", r.status === 0 && sent().length === 1 && /deploy waiting: .*mainnet\.env is missing/.test(sent()[0]), sent().join("\n") + r.stderr);
    writeFileSync(path.join(h.R, "etc/zold/mainnet.env"), "TRANSF_API_PORT=3001\n");
    h.run("deploy.sh", "mainnet");
    h.run("deploy.sh", "mainnet");
    check("deploy: then a missing deployments.json sends its own one", sent().length === 2 && /mainnet\.deployments\.json is missing/.test(sent()[1]), sent().join("\n"));
  } finally {
    rmSync(h.R, { recursive: true, force: true });
  }
}
{
  // provision.sh step 5 after a restore: wait for the promotion, or refuse.
  const wait = (answers: string, secs: number) => sh("bash", ["-c", `source "${DIR}/lib.sh"; deployment mainnet
    c="$(mktemp)"; echo 0 >"$c"; runuser() { shift 3; "$@"; }; sleep() { :; }
    # psql runs in a command substitution: the call count lives in a file.
    psql() { local a=(${answers}) n; n="$(cat "$c")"; echo $((n + 1)) >"$c"; echo "\${a[$n]:-\${a[-1]}}"; }
    wait_out_of_recovery ${secs}; echo "after $(cat "$c")"; rm -f "$c"`]);
  let w = wait("t t f", 10);
  check("wait_out_of_recovery: returns once pg_is_in_recovery() is false", w.status === 0 && w.stdout.trim() === "after 3", w.stdout + w.stderr);
  w = wait("t", 5);
  check("wait_out_of_recovery: a cluster still in recovery fails after the timeout, saying so", w.status === 1 && /still in recovery after 5 s .*pg_promote/.test(w.stderr), w.stdout + w.stderr);
  check("provision: waits for the promotion before stanza-create", (() => {
    const p = readFileSync(path.join(DIR, "provision.sh"), "utf8");
    return p.indexOf("wait_out_of_recovery") > p.indexOf("pg_isready -q") && p.indexOf("wait_out_of_recovery") < p.indexOf("stanza-create\n");
  })());
}
{
  // The PGDG key check reads primary keys only, and a second one fails it.
  const dir = mkdtempSync(path.join(tmpdir(), "zold-gpg-"));
  try {
    writeFileSync(path.join(dir, "gpg"), `#!/usr/bin/env bash\ncat "$3"\n`);
    chmodSync(path.join(dir, "gpg"), 0o755);
    const one = "pub:-:4096:1:7FCC7D46ACCC4CF8:::::::scSC::::::23::0:\nfpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:\nuid:-::::::::PostgreSQL Debian Repository::::::::::0:\n";
    const sub = "sub:-:4096:1:1111111111111111:::::::e::::::23:\nfpr:::::::::1111111111111111111111111111111111111111:\n";
    const extra = "pub:-:4096:1:2222222222222222:::::::scSC::::::23::0:\nfpr:::::::::2222222222222222222222222222222222222222:\n";
    const prim = (listing: string) => {
      writeFileSync(path.join(dir, "k"), listing);
      return sh("bash", ["-c", `source "${DIR}/lib.sh"; key_primaries "${dir}/k"`], { PATH: `${dir}:/usr/bin:/bin` }).stdout.trim();
    };
    check("PGDG key: one primary with a subkey passes", prim(one + sub) === "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8");
    check("PGDG key: an appended second key does not", prim(one + sub + extra) !== "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  check("provision: ALERT_URL must be https", readFileSync(path.join(DIR, "provision.sh"), "utf8").includes('[[ "$ALERT_URL" == https://* ]] || die'));
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
    r = can("hub", "hub_owner");
    check("hub_owner does not reach hub: no OS user maps to it", r.status !== 0 && /authentication failed/.test(r.stderr), r.stderr);
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
