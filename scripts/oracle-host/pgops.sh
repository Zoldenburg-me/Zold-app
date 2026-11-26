#!/usr/bin/env bash
# One deployment's cluster jobs, run by its systemd timers as root
# (docs/postgres-store-design.md §7, §7.2; docs/oracle-host.md):
#
#   pgops.sh <dep>-alerts     every minute: archiver, disk, database sizes, the
#                             hub's write stop; `pgbackrest check` every 10th
#                             minute (each check forces a WAL switch)
#   pgops.sh <dep>-watchdog   every 10 s: ends hub_app sessions past twice
#                             their statement or idle-in-transaction timeout
#   pgops.sh <dep>-dump       daily: globals plus pg_dump -Fc of each database,
#                             each with its table check from the same snapshot,
#                             age-encrypted to the owner, into the dump bucket
#   pgops.sh <dep>-backup     daily: pgBackRest diff to each repository, full on
#                             Sundays (pgBackRest schedules per repository)
#
# The systemd instance name is "<dep>-<job>" (zold-pgops@mainnet-alerts).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
[[ $# -eq 1 && "$1" == *-* ]] || die "usage: pgops.sh <mainnet|testnet>-<alerts|watchdog|dump|backup>"
[[ -f "$HOST_ENV" ]] || die "$HOST_ENV is missing"
set -a; source "$HOST_ENV"; set +a
deployment "${1%%-*}"
JOB="${1#*-}"
P="$(printf %s "$DEP" | tr a-z A-Z)"
v() { local n="${P}_$1"; printf '%s' "${!n}"; }
q() { psql_su -At -d postgres -c "$1"; }

alerts() {
  # Archiving (§7): a rise in failed_count, or WAL waiting to be archived for
  # over 5 minutes. An idle cluster switches no segment, so an old
  # last_archived_time alone is not a backlog; a .ready file is.
  local state=/var/lib/zold-host/$DEP
  install -d -m 700 "$state"
  local failed prev ready oldest
  failed="$(q "SELECT failed_count FROM pg_stat_archiver")" || { alert "cannot query the cluster" "(pg_stat_archiver)"; return 1; }
  prev="$(cat "$state/archiver-failed" 2>/dev/null || echo "$failed")"
  echo "$failed" >"$state/archiver-failed"
  if (( failed > prev )); then
    alert "WAL archiving failed" "$((failed - prev)) time(s) in the last minute (pg_stat_archiver.failed_count $failed)"
  fi
  read -r ready oldest < <(q "SELECT count(*), coalesce(extract(epoch FROM now() - min(modification))::int, 0) FROM pg_ls_archive_statusdir() WHERE name ~ '\.ready\$'" | tr '|' ' ')
  if (( ready > 0 && oldest > 300 )); then
    alert "WAL archive backlog; RPO is no longer one minute" "($ready segment(s), oldest waiting ${oldest}s)"
  fi

  # Disk: the cluster's own volume, at 30 % and 15 % free.
  local free sizes
  free="$(df --output=pcent "/srv/pg/$DEP" | tail -1 | tr -dc 0-9)"
  free=$((100 - free))
  # Which database is growing: its size and its rows written since the last
  # run, against the cluster's WAL written since then (§7.2).
  local wal prev_wal db size writes before
  sizes=""
  wal="$(q "SELECT wal_bytes FROM pg_stat_wal")"
  prev_wal="$(cat "$state/wal-bytes" 2>/dev/null || echo "$wal")"
  echo "$wal" >"$state/wal-bytes"
  while IFS='|' read -r db size writes; do
    before="$(cat "$state/writes-$db" 2>/dev/null || echo "$writes")"
    echo "$writes" >"$state/writes-$db"
    sizes+="${sizes:+, }$db $size ($((writes - before)) rows written)"
  done < <(q "SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)), s.tup_inserted + s.tup_updated + s.tup_deleted
                FROM pg_database d JOIN pg_stat_database s ON s.datid = d.oid WHERE d.datallowconn ORDER BY pg_database_size(d.datname) DESC")
  sizes+="; WAL $(( (wal - prev_wal) / 1048576 )) MB in the last minute"
  if (( free < 15 )); then
    alert "Postgres volume under 15 % free" "($free %); databases: $sizes"
  elif (( free < 30 )); then
    alert "Postgres volume under 30 % free" "($free %); databases: $sizes"
  fi

  # The hub (§7.2): an extra alert at its size threshold, and a write stop at
  # its hard size or under 15 % free. Zold keeps writing; the owner lifts the
  # stop by hand (ALTER DATABASE hub CONNECTION LIMIT 25, as $PG_USER).
  if [[ "$WITH_HUB" == 1 ]] && [[ -n "$(q "SELECT 1 FROM pg_database WHERE datname = '$HUB_DB'")" ]]; then
    local hub_mb limit
    hub_mb="$(q "SELECT pg_database_size('$HUB_DB') / 1048576")"
    limit="$(q "SELECT datconnlimit FROM pg_database WHERE datname = '$HUB_DB'")"
    if (( hub_mb > ${HUB_SIZE_ALERT_MB:-1024} )); then alert "hub passed ${HUB_SIZE_ALERT_MB:-1024} MB" "(${hub_mb} MB)"; fi
    if [[ "$limit" != 0 ]] && (( hub_mb > ${HUB_SIZE_STOP_MB:-2048} || free < 15 )); then
      hub_stop
      alert "hub STOPPED (CONNECTION LIMIT 0); lift by hand once fixed" "(${hub_mb} MB, volume $free % free)"
    fi
  fi

  # pgBackRest's own check, every 10th minute: it forces a WAL switch.
  if (( 10#$(date -u +%M) % 10 == 0 )); then
    runuser -u "$PG_USER" -- pgbackrest --config="$BACKREST_CONF" --stanza="$STANZA" check >/dev/null 2>&1 \
      || alert "pgbackrest check failed" "(journal and /var/log/pgbackrest/$DEP)"
  fi
}

hub_stop() {
  # New sessions refused before the old ones are ended. Superusers are exempt
  # from datconnlimit, so this job and a restore still connect.
  q "ALTER DATABASE \"$HUB_DB\" CONNECTION LIMIT 0" >/dev/null
  q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$HUB_DB' AND usename IN ('$HUB_APP', '$HUB_OWNER')" >/dev/null
}

watchdog() {
  [[ "$WITH_HUB" == 1 ]] || return 0
  local ended
  ended="$(psql_su -At -d postgres -v hub_app="$HUB_APP" -f "$HERE/watchdog.sql")"
  if (( ended > 0 )); then logger -p user.warning -t zold-host -- "$DEP: watchdog ended $ended hub_app session(s) past their timeout"; fi
}

# PUT one file into the dump bucket over the S3-compatible API. The
# credential may create and read only (§7); it goes to curl on stdin, never
# on the command line.
put_object() { # file name
  local region bucket sha
  region="$(v DUMP_REGION)"; bucket="$(v DUMP_BUCKET)"
  sha="$(sha256sum "$1" | cut -d' ' -f1)"
  printf 'user = "%s:%s"\n' "$(v DUMP_KEY)" "$(v DUMP_SECRET)" | curl -fsS -m 3600 -K - \
    --aws-sigv4 "aws:amz:$region:s3" -H "x-amz-content-sha256: $sha" -T "$1" \
    "https://$OCI_NAMESPACE.compat.objectstorage.$region.oraclecloud.com/$bucket/$2" >/dev/null
}

dump() {
  local stamp spool age=/opt/age/age
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  # On the cluster's volume, not /tmp; only ciphertext is ever written.
  spool="/srv/pg/$DEP/dump-spool/$stamp"
  # A failed night's leftovers (ciphertext only) go first: they share the
  # volume WAL needs.
  rm -rf "/srv/pg/$DEP/dump-spool" /run/zold-dump-"$DEP".*
  install -d -o "$PG_USER" -g "$PG_USER" -m 700 "/srv/pg/$DEP/dump-spool" "$spool"
  enc() { "$age" -r "$OWNER_AGE_RECIPIENT" -o "$1"; }
  runuser -u "$PG_USER" -- pg_dumpall -h "$PG_SOCKET" -p "$PG_PORT" --globals-only | enc "$spool/globals.sql.age"
  local dbs=("$ZOLD_DB")
  if [[ "$WITH_HUB" == 1 ]]; then dbs+=("$HUB_DB"); fi
  for db in "${dbs[@]}"; do
    # One REPEATABLE READ snapshot: the table check runs in it and pg_dump
    # dumps exactly it, so the check file describes the rows in the dump.
    local fifo pid
    fifo="$(mktemp -d "/run/zold-dump-$DEP.XXXXXX")"
    mkfifo -m 600 "$fifo/in" "$fifo/out"
    runuser -u "$PG_USER" -- psql -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -d "$db" <"$fifo/in" >"$fifo/out" &
    pid=$!
    exec 3>"$fifo/in" 4<"$fifo/out"
    local snap line check="" ended=0
    printf 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;\nSELECT pg_export_snapshot();\n' >&3
    read -r snap <&4
    printf '\\i %s\nSELECT %s;\n' "$HERE/table-check.sql" "'__end__'" >&3
    while read -r line <&4; do
      if [[ "$line" == __end__ ]]; then ended=1; break; fi
      check+="$line"$'\n'
    done
    [[ "$ended" == 1 && -n "$snap" ]] || { alert "daily dump failed" "(the table check of $db, $stamp)"; return 1; }
    printf '%s' "$check" | enc "$spool/$db.check.age"
    runuser -u "$PG_USER" -- pg_dump -h "$PG_SOCKET" -p "$PG_PORT" -d "$db" --snapshot="$snap" -Fc | enc "$spool/$db.dump.age"
    printf 'COMMIT;\n\\q\n' >&3
    wait "$pid"
    exec 3>&- 4<&-
    rm -rf "$fifo"
  done
  tar -C "$spool" -cf "$spool.tar" .
  put_object "$spool.tar" "$DEP/$stamp.tar" || { alert "daily dump failed" "(upload, $stamp)"; return 1; }
  rm -rf "/srv/pg/$DEP/dump-spool"
  logger -t zold-host -- "$DEP: dump $stamp uploaded to $(v DUMP_BUCKET)"
}

backup() {
  local type=diff
  if [[ "$(date -u +%u)" == 7 ]]; then type=full; fi
  for n in $(v REPOS); do
    runuser -u "$PG_USER" -- pgbackrest --config="$BACKREST_CONF" --stanza="$STANZA" --repo="$n" --type="$type" backup \
      || alert "pgbackrest backup to repo$n failed" "($type)"
  done
}

# Any job that ends non-zero says so (a dump that stops for weeks is not
# silent), and a background psql of the dump does not outlive it.
on_exit() {
  local rc=$?
  jobs -p | xargs -r kill 2>/dev/null || true
  rm -rf /run/zold-dump-"$DEP".*
  if [[ $rc != 0 && "$ALERT_FAILED" == 0 ]]; then alert "job $JOB failed" "(exit $rc)" || true; fi
  [[ $rc != 0 || "$ALERT_FAILED" == 0 ]] || rc=1
  exit "$rc"
}
trap on_exit EXIT

case "$JOB" in
  alerts) alerts ;;
  watchdog) watchdog ;;
  dump) dump ;;
  backup) backup ;;
  *) die "unknown job: $JOB" ;;
esac
