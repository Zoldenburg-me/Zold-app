# The Oracle host: runbook

The how of `docs/postgres-store-design.md` §7, §7.1 and §7.2: one OCI Ampere
(aarch64, Ubuntu) instance running both deployments' APIs, one Postgres 17
cluster per deployment on unix sockets, and the hub in its own database in
mainnet's cluster. The scripts are in `scripts/oracle-host/`.

**None of this has run on the host.** The scripts and SQL have run only
against a local Postgres 17 and a throwaway cluster (`npm run check:pg`).
Everything marked S7b below needs the owner's host and account.

## Files

| File | What |
|---|---|
| `provision.sh <dep> [--rebuild]` | The whole host half of one deployment, idempotent. `render` writes only the Postgres config files |
| `database.sql`, `check.sql` | The database step (roles, databases, CONNECT grants, limits) and its checks; run by `provision.sh` and after every restore |
| `table-check.sql` | The table check: per table, row count and SHA-256 over `to_jsonb` text sorted `COLLATE "C"`, under fixed session settings |
| `watchdog.sql` | Ends `hub_app` sessions past twice their timeouts |
| `pgops.sh <dep>-<job>` | `alerts` (every minute), `watchdog` (10 s), `dump` (daily), `backup` (daily) |
| `deploy.sh <dep>` | The pull loop on `production` |
| `toolchain-check.sh` | Node 22.23.4 linux-arm64, `npm ci --omit=dev`, every native file aarch64 |
| `host.env.example` | Owner input; filled at `/etc/zold-host/host.env` (root, 600) |
| `systemd/` | `zold-api@`, `zold-hub`, `zold-deploy@` and its timer, `zold-pgops@` and the `zold-pg-*@` timers |

Names (all from `lib.sh`), for `<dep>` = `mainnet` | `testnet`:

| | mainnet | testnet |
|---|---|---|
| cluster OS user and superuser | `pg-mainnet` | `pg-testnet` |
| socket directory, port | `/run/postgresql-mainnet`, 5432 | `/run/postgresql-testnet`, 5433 |
| data directory (own block volume) | `/srv/pg/mainnet/data` | `/srv/pg/testnet/data` |
| dump spool (same volume) | `/srv/pg/mainnet/dump-spool` | `/srv/pg/testnet/dump-spool` |
| API OS user → role | `zold-mainnet` → `zold_app` | `zold-testnet` → `zold_app` |
| deploy OS user → role | `zold-deploy-mainnet` → `zold_owner` | `zold-deploy-testnet` → `zold_owner` |
| hub OS user → role | `zold-hub` → `hub_app` | `zold-hub-testnet`, only with `HUB_TESTNET=1` |
| socket group | `zold-mainnet-db` | `zold-testnet-db` |
| pgBackRest | `/etc/pgbackrest/mainnet.conf`, stanza `zold-mainnet` | `…/testnet.conf`, `zold-testnet` |
| API environment, port | `/etc/zold/mainnet.env`, 3000 | `/etc/zold/testnet.env`, 3001 |
| chain addresses | `/etc/zold/mainnet.deployments.json` | `/etc/zold/testnet.deployments.json` |

## Owner input

Not in the repository, never committed, each with an age-encrypted copy off
the host:

- The OCI account, its region and second region, and the instance (Ampere
  A1, Ubuntu, aarch64) with one block volume per cluster mounted on
  `/srv/pg/<dep>`. The OCI security list opens only SSH.
- Per deployment: the two pgBackRest buckets and an OCI user with a policy
  for those two only (its customer secret key); the repository passphrase;
  the dump bucket in the second region with a 14-day time-bound retention
  rule (unlocked) and a 30-day lifecycle delete, and a key that may create
  and read objects there, not overwrite or delete.
- `OCI_NAMESPACE`, `OWNER_AGE_RECIPIENT` (public key), `ALERT_URL`
  (`https://` only; provision refuses another scheme).
- `/etc/zold/<dep>.env`: the lease's environment, plus `DATABASE_URL`,
  `TRANSF_DB_PATH`, `TRANSF_API_PORT` (`host.env.example` lists them), no
  `export` lines (a systemd `EnvironmentFile`). `host.env` holds assignments
  only: provision and the jobs refuse `export`, `declare`, `readonly`, `set`
  or `eval` in it.
- `/etc/zold/<dep>.deployments.json` (root, 600): the `deployments.json` the
  lease writes from its environment variable. `production` carries none, and
  `/api/health` needs it, so the deploy copies it into every release.
- The Cloudflare tunnel token for `cloudflared service install`.
- For drills: an OCI user with a read-only credential (read and list) on the
  pgBackRest and dump buckets.

## Provisioning (S7b)

On the instance, from a checkout of main:

```bash
sudo install -d -m 700 /etc/zold-host
sudo install -m 600 scripts/oracle-host/host.env.example /etc/zold-host/host.env  # then fill it
sudo scripts/oracle-host/provision.sh mainnet
sudo scripts/oracle-host/provision.sh testnet
scripts/oracle-host/toolchain-check.sh
```

`provision.sh` refuses before it makes anything when a value it needs is
unset, the volume is not mounted, or the host is not aarch64. It checks the
PGDG key by fingerprint and Node and age by SHA-256, makes the cluster with
`--encoding=UTF8 --locale=C.UTF-8 --data-checksums`, writes `pg_hba.conf` (the
cluster's OS user first, then one line per database naming its two roles,
then reject), `pg_ident.conf` and `conf.d/zold.conf` (`listen_addresses = ''`,
`reserved_connections = 10`, archiving to pgBackRest every 60 s), runs
`stanza-create` and `check`, the database step and `check.sql` (fed on
stdin: psql runs as the cluster's OS user, who need not read the checkout),
adds a drop-in to the cluster's unit (`PIDFile=` in the socket directory,
`RequiresMountsFor=` the volume; the PID file path is the first thing to
confirm on the host), installs the
units and timers, drops TCP 5432-5433 in iptables, and fails if anything
other than sshd listens on a public address.

Then `cloudflared service install <token>`, with the tunnel's ingress for
each hostname at `http://127.0.0.1:<API port>`.

A re-run changes only what differs. It never lifts a hub write stop.

The volume root `/srv/pg/<dep>` is `root:root 755`: `data/` is
`pg-<dep>`'s, `dump-spool/` is root's at 700. The dump job writes the spool as
root, by path, so `pg-<dep>` owns no directory on the way and cannot plant a
link there; `pg_dump` writes only into a pipe the job reads. The dump refuses
a volume root or spool that is not root's, or a spool that is a link. A
volume provisioned with an older `provision.sh` (root `pg-<dep>`'s) is taken
back by the next run: the root is chowned, and a spool that is a link or not
root's is removed (`rm` removes a link, not its target). Until then the dump
alerts and refuses.

## Deploys

`zold-deploy@<dep>.timer` runs `deploy.sh` every two minutes. While
`/etc/zold/<dep>.env` or `/etc/zold/<dep>.deployments.json` is missing it
stages nothing and alerts, once per 30 minutes per file; the first run after both are in place deploys and starts
the API. On a new commit on the public `production` branch it makes a
release directory, copies in `deployments.json` (640, the deploy group,
which the API user is in; the unit's `UMask=0027`), runs `npm ci --omit=dev`,
stops the API, runs `npm run db:migrate -- apply` as
`zold_owner` (then `zold_grant_app('zold_app')`), points `app` at the
release, starts the API and waits three minutes for `/api/health`. Nothing
on GitHub holds a credential for the host. `production` only moves forward;
a commit that does not descend from the running one is refused.

Every write under `/srv/zold/<dep>` (the release, `deployments.json`, the
`app` link, pruning) runs as the deploy user, never as root, and root
refuses a `releases` that is not a directory or an `app` that is not a link
to `releases/<commit>`. Any failure alerts, including a failed fetch or
`npm ci`. The health probe uses the API env file's last `TRANSF_API_PORT`,
else its last `PORT`, else 3000.

**Fix forward after a migration.** A release that fails its health check is
rolled back, and skipped, only if its deploy applied no migration. Once a
migration has applied, an older build refuses to start
(`assertSchemaCurrent` refuses a schema ahead of the code), so the deploy
alerts and leaves the new release in place: the fix is a new commit on main,
never a redeploy of an older build or a hand-edited schema.

## Cut-over (S8, at the owner's time)

The steps of design §6, testnet first, then mainnet:

1. Preconditions: `check:pg` on the release's commit against a scratch
   Postgres 17 (the host's `pg_hba` rejects its temporary roles and
   databases, by design), `npm run preflight` with the deployment's environment, one restore
   drill passed (below), the S5 report run on a copy of that deployment's
   `db.json` with no blocking finding.
2. Drain (§6 step 2), then stop the API on the lease.
3. Copy `db.json` off the lease with `scripts/backup-db.sh`; keep the lease
   and its volume, stopped, until the owner closes it.
4. On the host, as the deploy user:
   `DATABASE_URL=postgresql://zold_owner@/zold?host=/run/postgresql-<dep>&port=<port> npm run pg-import -- import <db.json>`
   (it verifies counts and hashes both ways before its `COMMIT`). Any
   mismatch: stop, start the lease again on its `db.json`.
5. Set `STORE_BACKEND=postgres` in `/etc/zold/<dep>.env`,
   `systemctl start zold-api@<dep>`, wait for `/api/health`, then point the
   tunnel's hostname at the host's `cloudflared`.
6. Smoke (§6 step 7). No money moves in the smoke.
7. Rollback: design §6, "Rollback" (`zold_app` `NOLOGIN`, export with
   `pg-export`, the lease on that `db.json`).

## Host loss and rebuild

Proposed target, for the owner to accept (design §9): service back within 4
hours of the decision to rebuild, losing at most the last minute of writes
while archiving keeps up. Mainnet first, testnet the same way after.

1. New Ampere A1 instance, same image, same or second EU region; one block
   volume per cluster mounted on `/srv/pg/<dep>`. The old instance, if it
   returns, stays stopped.
2. Restore `/etc/zold-host/host.env` from the owner's copy. If a region is
   gone, set `<DEP>_REPOS` to the reachable repository only.
3. `sudo scripts/oracle-host/provision.sh <dep> --rebuild`: everything up to
   the cluster and the pgBackRest config, then the cluster is left stopped and
   no stanza is created (a fresh `initdb` has another system id).
4. `sudo -u pg-<dep> pgbackrest --config=/etc/pgbackrest/<dep>.conf --stanza=zold-<dep> --delta restore [--repo=<n>] [--type=time --target="<T>" --target-action=promote]`.
   A timed restore without `--target-action=promote` pauses at the target,
   and step 5's `stanza-create` and `check` then fail on a cluster still in
   recovery.
5. `sudo scripts/oracle-host/provision.sh <dep>`: starts the cluster, waits
   until `pg_is_in_recovery()` is false (a restore replays WAL in hot
   standby, which already takes connections; after 30 minutes,
   `PROMOTE_WAIT_S`, it stops and says so), `stanza-create` and `check` (archiving from the new host before it takes
   a write), the database step and `check.sql` (roles, attributes,
   `CONNECT` only to each database's two roles, the hub's limits, the app
   role's grants equal `zold_grant_app`'s). A repository left out in step 2
   is added back with a new stanza in a reachable region and a full backup
   (`pgops.sh <dep>-backup`) before it counts.
6. Restore `/etc/zold/<dep>.env` and `/etc/zold/<dep>.deployments.json`;
   `cloudflared service install <token>`; the deploy timer's next run checks
   out `production` and starts the API. `npm run
   preflight`. Smoke.

**Both repositories lost:** steps 1-3, then start the cluster
(`systemctl start postgresql@17-<dep>`), fetch the latest object from the
dump bucket and decrypt it with the owner's age key, which is never on the
host. As `pg-<dep>`: load `globals.sql` with the `CREATE ROLE "pg-<dep>";`
line filtered out (`grep -vx`) under `ON_ERROR_STOP=1`; for each database in
the dump, `CREATE DATABASE <db> OWNER <owner> CONNECTION LIMIT 0`,
`REVOKE CONNECT ON DATABASE <db> FROM PUBLIC`, `pg_restore --role=<owner> -d <db>`,
then `table-check.sql` on it, compared with that database's `.check` file.
Then step 5 (it re-applies the revokes, grants and limits; a restore without
`--create` carries none) and step 6. Everything after the dump's time is
lost: the reconciler reports the drift, and the owner tells the users the
window.

## Restore drill (S7b, then monthly per cluster)

Onto a new instance, never the running host, with the read-only credential.
`repo1` and `repo2` in alternate months; every third month the latest dump
instead (the both-repositories-lost path, compared with the dump's own check
files).

1. On the live host, per database: open a `REPEATABLE READ` transaction
   whose first statement is `SELECT pg_current_wal_lsn()`, then run
   `table-check.sql` in it. Keep the LSN and the lines.
2. On the drill instance, with a `host.env` whose S3 key is the read-only
   one: rebuild steps 1-4 with `--type=lsn
   --target=<Zold's database's LSN> --archive-mode=off`, and `pgbackrest stop`
   before Postgres starts (no `archive-push`, `backup` or `expire` there).
   Start Postgres; do not start the API (a restored mainnet API would run
   the sweeps against real partners).
3. `table-check.sql` on Zold's database; compare with step 1. On mainnet,
   stop Postgres, restore again with `--delta --type=lsn --target=<hub's LSN>`,
   and compare `hub`.
4. A mismatch gets one re-run at a new LSN: a commit record can precede the
   LSN and not yet be visible to the step-1 snapshot. A second mismatch is a
   finding.
5. Log on the board: repository, LSNs, and the time from "instance
   requested" to "check passed". Delete the instance.

The service part of the target is timed on testnet: once before the
cut-over, then quarterly, testnet is rebuilt for real (its old API stopped
first), the tunnel moved and the smoke run; log "instance requested" to
"smoke passed".

## The hub: write stop and hub-only restore

**Stop.** `zold-pg-alerts@mainnet` sets `ALTER DATABASE hub CONNECTION
LIMIT 0` and ends `hub_app`/`hub_owner` sessions when `hub` passes
`HUB_SIZE_STOP_MB` or the volume drops under 15 % free. Zold keeps writing.
**Lift**, by hand, as `pg-mainnet`, once the cause is fixed:
`ALTER DATABASE hub CONNECTION LIMIT 25` (never `-1`).

**Hub-only restore.** Never a cluster PITR: that rewinds Zold's money state.

1. `systemctl stop zold-hub`.
2. Record the live `hub`'s limit:
   `SELECT datconnlimit FROM pg_database WHERE datname = 'hub'`. If `hub` is
   gone, the recorded value is 0 (fail closed).
3. Get a dump of `hub`: the last daily dump, or a PITR of the cluster to the
   chosen time on a scratch instance (the drill's read-only path) and a
   `pg_dump -Fc -d hub` there, with its table check.
4. As `pg-mainnet`: `ALTER DATABASE hub RENAME TO hub_broken_<date>` (kept
   until the owner drops it), then
   `CREATE DATABASE hub OWNER hub_owner CONNECTION LIMIT 0` and
   `REVOKE CONNECT ON DATABASE hub FROM PUBLIC`, so `hub_app` cannot connect
   to a half-restored database. Superusers are exempt from the limit.
5. `pg_restore --role=hub_owner -d hub <dump>`, then `table-check.sql` on
   `hub` against the dump's check.
6. `HUB_LIMIT=<recorded> scripts/oracle-host/provision.sh mainnet`: the
   database step sets exactly the recorded limit and `check.sql` expects it.
7. `systemctl start zold-hub`. If the recorded limit was 0, the hub stays
   stopped until the owner lifts it as above. Tell the hub's agents which
   window they lost.

## What S7b still has to do on the host

- Provision both clusters; the toolchain check on the host.
- `pgbackrest check` against both repositories; a first full backup to each.
- The one-repository-down test: block `repo2` (an iptables drop to its
  endpoint), write, watch `pg_wal`, `pg_stat_archiver` and the alerts; record
  in design §7 whether a segment in `repo1` only is reported archived.
- Each alert fires once (archiver failure, backlog, disk, `pgbackrest check`,
  hub size and stop) and reaches `ALERT_URL`.
- A dump object: the dump credential is refused an overwrite and a delete.
- The first restore drill and the first testnet rebuild, timed against the
  target.
- The console check for an idle-reclamation notice on the instance.
