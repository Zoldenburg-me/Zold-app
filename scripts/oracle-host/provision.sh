#!/usr/bin/env bash
# Provisions one deployment's half of the Oracle host
# (docs/postgres-store-design.md §7, §7.1, §7.2; runbook docs/oracle-host.md).
# Idempotent: run it again after any change here, after a restore, or on a
# new instance; it changes only what is not already right.
#
#   sudo scripts/oracle-host/provision.sh mainnet            # then testnet
#   sudo scripts/oracle-host/provision.sh mainnet --rebuild  # new host, before the restore
#   scripts/oracle-host/provision.sh render <dep> <dir>      # the Postgres config files only
#
# Run from a checkout of main on the host, as root, Ubuntu on aarch64 (an
# OCI Ampere A1 instance). Needs /etc/zold-host/host.env (host.env.example),
# filled by the owner, and the cluster's block volume mounted on /srv/pg/<dep>.
#
# What it does, in order: PGDG Postgres 17 and pgBackRest; Node 22.23.4
# linux-arm64 and age, both SHA-256 pinned; the OS users and the socket
# group; the cluster (UTF-8, unix socket only, peer authentication); the
# pgBackRest config and stanza; the database step (database.sql) and its
# checks (check.sql); these scripts under /opt/zold-host; the systemd units and
# timers; a firewall rule dropping the Postgres ports; and a check that
# nothing but sshd listens on a public address.
#
# --rebuild (§7.1 steps 1-2): everything up to the cluster and the pgBackRest
# config, then stops: the cluster is left stopped for `pgbackrest restore`, and
# no stanza is created, because a fresh initdb has another system id than the
# repository. After the restore, run it again without --rebuild.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

# --- the Postgres config files ------------------------------------------------
# Written by the cluster setup below, and by the offline test into a throwaway
# cluster (ZH_* override the OS user names there; never on a host).
render() {
  local dir="$1"
  local pg_user="${ZH_PG_USER:-$PG_USER}" api_user="${ZH_API_USER:-$API_USER}"
  local hub_user="${ZH_HUB_USER:-$HUB_USER}"
  local socket="${ZH_PG_SOCKET:-$PG_SOCKET}" clients="${ZH_PG_CLIENTS:-$PG_CLIENTS}"
  mkdir -p "$dir/conf.d"
  cat >"$dir/conf.d/zold.conf" <<EOF
# Written by scripts/oracle-host/provision.sh; edit there.
# No TCP listener: the unix socket is the only way in (§7).
listen_addresses = ''
port = $PG_PORT
unix_socket_directories = '$socket'
# The socket file is the clients' group's; its directory is not theirs to
# write (2750), so no member can replace the socket.
unix_socket_group = '$clients'
unix_socket_permissions = 0770
external_pid_file = '$socket/$PG_MAJOR-$DEP.pid'
ssl = off
password_encryption = scram-sha-256
max_connections = 100
superuser_reserved_connections = 3
# For Zold's roles only (pg_use_reserved_connections, database.sql), so a hub
# flood cannot lock the API out (§7.2).
reserved_connections = 10
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --config=$BACKREST_CONF --stanza=$STANZA archive-push %p'
archive_timeout = 60s
log_connections = on
log_disconnections = on
log_lock_waits = on
log_line_prefix = '%m [%p] %q%u@%d '
EOF
  # First match wins, and a failed peer check or map tries no later line (§7).
  {
    echo "# Written by scripts/oracle-host/provision.sh; edit there."
    echo "local  all          $pg_user                   peer"
    echo "local  $ZOLD_DB         $ZOLD_APP,$ZOLD_OWNER       peer map=zold-$DEP"
    if [[ "$WITH_HUB" == 1 ]]; then
      echo "local  $HUB_DB          $HUB_APP,$HUB_OWNER         peer map=hub"
    fi
    echo "local  all          all                        reject"
    echo "host   all          all          0.0.0.0/0     reject"
    echo "host   all          all          ::/0          reject"
  } >"$dir/pg_hba.conf"
  {
    echo "# Written by scripts/oracle-host/provision.sh; edit there."
    echo "# MAP          OS user              role"
    echo "zold-$DEP     $api_user          $ZOLD_APP"
    echo "zold-$DEP     ${ZH_DEPLOY_USER:-$DEPLOY_USER}   $ZOLD_OWNER"
    if [[ "$WITH_HUB" == 1 ]]; then
      # No OS user maps to hub_owner: Zold's deploy user runs Zold's release
      # code, which must not own the hub. S9 adds the hub's own deploy user.
      echo "hub          $hub_user             $HUB_APP"
    fi
  } >"$dir/pg_ident.conf"
}

if [[ "${1:-}" == render ]]; then
  [[ $# -eq 3 ]] || die "usage: provision.sh render <mainnet|testnet> <dir>"
  if [[ -f "$HOST_ENV" ]]; then load_host_env; fi
  deployment "$2"
  render "$3"
  exit 0
fi

[[ $# -ge 1 && $# -le 2 ]] || die "usage: provision.sh <mainnet|testnet> [--rebuild] | render <mainnet|testnet> <dir>"
REBUILD=0
[[ "${2:-}" == "" || "${2:-}" == --rebuild ]] || die "unknown option: $2"
[[ "${2:-}" == --rebuild ]] && REBUILD=1
[[ "$(id -u)" == 0 ]] || die "run as root"
[[ "$(uname -m)" == aarch64 ]] || die "this host is $(uname -m); the Oracle host is aarch64"
[[ -f "$HOST_ENV" ]] || die "$HOST_ENV is missing: copy host.env.example, fill it, chmod 600"
[[ "$(stat -c %a "$HOST_ENV")" == 600 && "$(stat -c %U "$HOST_ENV")" == root ]] || die "$HOST_ENV must be root-owned, mode 600"
load_host_env
deployment "$1"

# Owner input, per deployment: refuse before anything is made (§7). The
# variable names are the deployment's, upper-cased: MAINNET_REPO1_BUCKET, …
P="$(printf %s "$DEP" | tr a-z A-Z)"
need() { local v="${P}_$1"; [[ -n "${!v:-}" && "${!v}" != *CHANGE_ME* ]] || die "$HOST_ENV: ${v} is not set"; }
for v in REPOS CIPHER_PASS DUMP_REGION DUMP_BUCKET DUMP_KEY DUMP_SECRET; do need "$v"; done
# OCI_NAMESPACE only while a target is on OCI, the shared key only while a
# repository has none of its own: an R2-only rebuild (REPOS=2) needs neither.
on_oci=0 shared_key=0
REPOS_VAR="${P}_REPOS"
for n in ${!REPOS_VAR}; do
  [[ "$n" == 1 || "$n" == 2 ]] || die "${P}_REPOS: only 1 and 2"
  need "REPO${n}_REGION"; need "REPO${n}_BUCKET"
  # Optional, per repository: its own S3 host and key (R2 for the second copy).
  endpoint "REPO${n}_ENDPOINT" x >/dev/null
  [[ -n "$(opt "REPO${n}_ENDPOINT")" ]] || on_oci=1
  if [[ -n "$(opt "REPO${n}_S3_KEY")$(opt "REPO${n}_S3_SECRET")" ]]; then need "REPO${n}_S3_KEY"; need "REPO${n}_S3_SECRET"; else shared_key=1; fi
done
endpoint DUMP_ENDPOINT x >/dev/null
[[ -n "$(opt DUMP_ENDPOINT)" ]] || on_oci=1
if [[ "$shared_key" == 1 ]]; then need S3_KEY; need S3_SECRET; fi
host_vars="OWNER_AGE_RECIPIENT ALERT_URL"
if [[ "$on_oci" == 1 ]]; then host_vars="OCI_NAMESPACE $host_vars"; fi
for v in $host_vars; do
  [[ -n "${!v:-}" && "${!v}" != *CHANGE_ME* ]] || die "$HOST_ENV: $v is not set"
done
# The alert URL can be a credential (an ntfy topic): never in clear.
[[ "$ALERT_URL" == https://* ]] || die "$HOST_ENV: ALERT_URL must be https://"
mountpoint -q "/srv/pg/$DEP" || die "/srv/pg/$DEP is not a mount point: mount the cluster's own volume, a block volume or a loop-mounted image (§7)"

# --- packages -----------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
# PGDG's signing key, by fingerprint (https://www.postgresql.org/download/linux/ubuntu/).
PGDG_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
PGDG_KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg xz-utils git postgresql-common
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o "$PGDG_KEY.tmp" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  # Exactly one primary key, and it is PGDG's: signed-by= trusts every key
  # in the file, so an appended second key must not pass.
  got="$(key_primaries "$PGDG_KEY.tmp")"
  [[ "$got" == "$PGDG_FPR" ]] || { rm -f "$PGDG_KEY.tmp"; die "PGDG key file holds $(printf %s "$got" | tr '\n' ' '), expected only $PGDG_FPR"; }
  mv "$PGDG_KEY.tmp" "$PGDG_KEY"
  . /etc/os-release
  echo "deb [signed-by=$PGDG_KEY] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" >/etc/apt/sources.list.d/pgdg.list
  apt-get update -q
fi
# Debian's default cluster (17/main) is not wanted: one cluster per deployment.
install -d /etc/postgresql-common/createcluster.d
echo "create_main_cluster = false" >/etc/postgresql-common/createcluster.d/00-zold.conf
apt-get install -y -q "postgresql-$PG_MAJOR" "postgresql-client-$PG_MAJOR" pgbackrest iptables-persistent

fetch_pinned() { # url sha256 out
  [[ -f "$3" ]] && echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null && return 0
  curl -fsSL -o "$3.tmp" "$1"
  echo "$2  $3.tmp" | sha256sum -c --quiet - || { rm -f "$3.tmp"; die "$1: SHA-256 mismatch"; }
  mv "$3.tmp" "$3"
}
# Node, linux-arm64 (nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt).
NODE_SHA=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
NODE_DIR="/opt/node-v$NODE_VERSION-linux-arm64"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  fetch_pinned "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" "$NODE_SHA" "/var/cache/node-v$NODE_VERSION-linux-arm64.tar.xz"
  tar -C /opt -xJf "/var/cache/node-v$NODE_VERSION-linux-arm64.tar.xz"
fi
"$NODE_DIR/bin/node" -v | grep -qx "v$NODE_VERSION" || die "node in $NODE_DIR is not v$NODE_VERSION"
# age, for the daily dump: the same pin as scripts/_age.sh.
# shellcheck source=../_age.sh
source "$HERE/../_age.sh"
read -r AGE_FILE AGE_SHA < <(age_asset)
if [[ ! -x /opt/age/age ]]; then
  fetch_pinned "https://github.com/FiloSottile/age/releases/download/$AGE_VERSION/$AGE_FILE" "$AGE_SHA" "/var/cache/$AGE_FILE"
  tar -C /opt -xzf "/var/cache/$AGE_FILE"
fi

# --- OS users -----------------------------------------------------------------
# Only $PG_CLIENTS may enter the socket directory: the API, the deploy user
# and (mainnet) the hub. Another deployment's users are not in it (§7).
getent group "$PG_CLIENTS" >/dev/null || groupadd --system "$PG_CLIENTS"
mkuser() { # name home
  id -u "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --create-home --shell /usr/sbin/nologin --user-group "$1"
}
install -d -m 755 /srv/zold
mkuser "$PG_USER" "/var/lib/$PG_USER"
mkuser "$API_USER" "/var/lib/$API_USER"
mkuser "$DEPLOY_USER" "/srv/zold/$DEP"
usermod -aG "$PG_CLIENTS" "$PG_USER"
usermod -aG "$PG_CLIENTS" "$API_USER"
usermod -aG "$PG_CLIENTS" "$DEPLOY_USER"
if [[ "$WITH_HUB" == 1 ]]; then
  mkuser "$HUB_USER" "/var/lib/$HUB_USER"
  usermod -aG "$PG_CLIENTS" "$HUB_USER"
fi
# The API reads the code its deploy user checks out, and writes nothing there.
usermod -aG "$DEPLOY_USER" "$API_USER"
chmod 750 "/srv/zold/$DEP"

# --- the cluster --------------------------------------------------------------
echo "d $PG_SOCKET 2750 $PG_USER $PG_CLIENTS -" >"/etc/tmpfiles.d/postgresql-$DEP.conf"
systemd-tmpfiles --create "/etc/tmpfiles.d/postgresql-$DEP.conf"
# The volume root is root's, 755: the data directory is pg-<dep>'s, the dump
# spool root's (pgops.sh dump writes there as root, by path, so pg-<dep> must
# not own a directory on the way). A host provisioned with a pg-<dep>-owned
# volume root is taken back here: root's chown first, then a spool that is a
# link or not root's is removed (rm removes a link, not its target), and the
# data directory must be a directory, not a link.
install -d -o root -g root -m 755 "/srv/pg/$DEP"
[[ ! -L "$PG_DATA" ]] || die "$PG_DATA is a link: inspect the volume by hand"
SPOOL="/srv/pg/$DEP/dump-spool"
if [[ -L "$SPOOL" || ( -e "$SPOOL" && ! -O "$SPOOL" ) ]]; then rm -rf --one-file-system "$SPOOL"; fi
[[ -d "$SPOOL" ]] || mkdir -m 700 "$SPOOL"
chmod 700 "$SPOOL"
if ! pg_lsclusters -h | awk '{print $1"/"$2}' | grep -qx "$PG_MAJOR/$DEP"; then
  # UTF-8 encoding and locale: the email key's \u escapes and lower() depend
  # on them (migrations/0003).
  pg_createcluster "$PG_MAJOR" "$DEP" -u "$PG_USER" -g "$PG_USER" -d "$PG_DATA" -s "$PG_SOCKET" -p "$PG_PORT" \
    --encoding=UTF8 --locale=C.UTF-8 --start-conf=auto -- --data-checksums
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
render "$stage"
changed=0
for f in conf.d/zold.conf pg_hba.conf pg_ident.conf; do
  if ! cmp -s "$stage/$f" "$PG_CONF/$f"; then
    install -D -o "$PG_USER" -g "$PG_USER" -m 640 "$stage/$f" "$PG_CONF/$f"
    changed=1
  fi
done

# --- pgBackRest (§7): repo1 in the host's region, repo2 in the second -------
# (or outside OCI: REPO2_ENDPOINT, with its own REPO2_S3_KEY/_SECRET)
# The passphrase sits only here, 0600, owned by the cluster's OS user, who
# runs archive_command. The owner holds the off-host copy.
install -d -o "$PG_USER" -g "$PG_USER" -m 750 "/var/spool/pgbackrest/$DEP" "/var/log/pgbackrest/$DEP"
v() { local n="${P}_$1"; printf '%s' "${!n}"; }
{
  echo "# Written by scripts/oracle-host/provision.sh from $HOST_ENV; edit there."
  echo "[global]"
  echo "archive-async=y"
  echo "spool-path=/var/spool/pgbackrest/$DEP"
  echo "lock-path=/var/spool/pgbackrest/$DEP/lock"
  echo "log-path=/var/log/pgbackrest/$DEP"
  echo "log-level-file=detail"
  echo "process-max=2"
  echo "compress-type=zst"
  echo "start-fast=y"
  for n in $(v REPOS); do
    region="$(v "REPO${n}_REGION")"
    echo "repo$n-type=s3"
    echo "repo$n-s3-endpoint=$(endpoint "REPO${n}_ENDPOINT" "$region")"
    echo "repo$n-s3-region=$region"
    echo "repo$n-s3-bucket=$(v "REPO${n}_BUCKET")"
    echo "repo$n-s3-uri-style=path"
    key="$(opt "REPO${n}_S3_KEY")"; secret="$(opt "REPO${n}_S3_SECRET")"
    echo "repo$n-s3-key=${key:-$(v S3_KEY)}"
    echo "repo$n-s3-key-secret=${secret:-$(v S3_SECRET)}"
    echo "repo$n-path=/$DEP"
    echo "repo$n-cipher-type=aes-256-cbc"
    echo "repo$n-cipher-pass=$(v CIPHER_PASS)"
    echo "repo$n-retention-full-type=time"
    echo "repo$n-retention-full=14"
  done
  echo
  echo "[$STANZA]"
  echo "pg1-path=$PG_DATA"
  echo "pg1-socket-path=$PG_SOCKET"
  echo "pg1-port=$PG_PORT"
  echo "pg1-user=$PG_USER"
} >"$stage/pgbackrest.conf"
# archive-push-queue-max is deliberately not set (§7): at the limit it drops WAL.
install -d -m 755 /etc/pgbackrest
if ! cmp -s "$stage/pgbackrest.conf" "$BACKREST_CONF"; then
  install -o "$PG_USER" -g "$PG_USER" -m 600 "$stage/pgbackrest.conf" "$BACKREST_CONF"
fi

unit="postgresql@$PG_MAJOR-$DEP"
# Debian's unit expects the pid file in /run/postgresql, which $PG_USER may
# not write; it lives in the cluster's own socket directory instead. And the
# cluster waits for its block volume.
install -d "/etc/systemd/system/$unit.service.d"
printf '[Unit]\nRequiresMountsFor=/srv/pg/%s\n\n[Service]\nPIDFile=%s\n' "$DEP" "$PG_SOCKET/$PG_MAJOR-$DEP.pid" \
  >"/etc/systemd/system/$unit.service.d/zold.conf"
systemctl daemon-reload
if [[ "$REBUILD" == 1 ]]; then
  systemctl stop "$unit" 2>/dev/null || true
  echo "rebuild: cluster $PG_MAJOR/$DEP made and stopped. Next (docs/oracle-host.md, host loss):"
  echo "  runuser -u $PG_USER -- pgbackrest --config=$BACKREST_CONF --stanza=$STANZA --delta restore [--repo=N] [--type=time --target=…]"
  echo "  then: $0 $DEP"
  exit 0
fi
systemctl enable "$unit" >/dev/null
if [[ "$changed" == 1 ]] && systemctl is-active -q "$unit"; then
  systemctl restart "$unit" # listen_addresses and reserved_connections need a restart
else
  systemctl start "$unit"
fi
pg_isready -q -h "$PG_SOCKET" -p "$PG_PORT" -t 30 || die "cluster $DEP did not start"
# After a restore the cluster accepts connections in hot standby while it
# replays WAL; stanza-create and check need it promoted.
wait_out_of_recovery "${PROMOTE_WAIT_S:-1800}"

# The stanza: idempotent, and refuses a repository made by another cluster.
runuser -u "$PG_USER" -- pgbackrest --config="$BACKREST_CONF" --stanza="$STANZA" stanza-create
runuser -u "$PG_USER" -- pgbackrest --config="$BACKREST_CONF" --stanza="$STANZA" check

# --- the database step and its checks (§7.1 step 3, §7.2) ---------------------
DBVARS=(-v zold_db="$ZOLD_DB" -v zold_owner="$ZOLD_OWNER" -v zold_app="$ZOLD_APP" -v with_hub="$WITH_HUB"
  -v hub_db="$HUB_DB" -v hub_owner="$HUB_OWNER" -v hub_app="$HUB_APP" -v hub_conn_limit="$HUB_CONN_LIMIT")
[[ -n "${HUB_LIMIT:-}" ]] && DBVARS+=(-v hub_limit="$HUB_LIMIT") # the hub-only restore's recorded limit
# On stdin: psql runs as $PG_USER, who may not read the checkout.
psql_su -d postgres "${DBVARS[@]}" -v maintenance_dbs=1 <"$HERE/database.sql"
psql_su -d postgres "${DBVARS[@]}" -v host_cluster=1 -v hub_ported="${HUB_PORTED:-0}" <"$HERE/check.sql"

# --- these scripts, the units and timers --------------------------------------
# /opt/zold-host is root's: the deploy timer runs it as root, so nothing a
# deploy pulls can change it.
install -d -m 755 "$HOST_DIR" "$HOST_DIR/systemd"
install -m 755 "$HERE"/*.sh "$HOST_DIR/"
install -m 644 "$HERE"/*.sql "$HOST_DIR/"
install -m 644 "$HERE"/systemd/* "$HOST_DIR/systemd/"
install -m 644 "$HERE/../_age.sh" "$HOST_DIR/_age.sh"
install -m 644 "$HERE"/systemd/* /etc/systemd/system/
install -d -m 750 /etc/zold
for f in "$API_ENV" "$DEPLOYMENTS_JSON"; do
  [[ -f "$f" ]] || echo "note: $f is missing; the deploy timer stages no release and zold-api@$DEP does not start until the owner puts it in place (§7.1 step 5)"
done
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 "/srv/zold/$DEP/releases"
systemctl daemon-reload
systemctl enable "zold-api@$DEP.service" >/dev/null
for t in deploy pg-alerts pg-watchdog pg-dump pg-backup; do
  systemctl enable --now "zold-$t@$DEP.timer" >/dev/null
done
if [[ "$WITH_HUB" == 1 && "$DEP" == mainnet ]]; then
  # Installed and enabled; it starts once S9 has put the hub's code in place
  # (ConditionPathExists in the unit).
  systemctl enable zold-hub.service >/dev/null
fi

# --- network: no database port, nothing public but sshd -----------------------
for proto in iptables ip6tables; do
  "$proto" -C INPUT -p tcp --dport 5432:5433 -j DROP 2>/dev/null || "$proto" -I INPUT 1 -p tcp --dport 5432:5433 -j DROP
done
netfilter-persistent save >/dev/null
public="$(ss -Htln | awk '{print $4}' | grep -vE '^(127\.[0-9.]+(%[a-z0-9]+)?|\[::1\]|\[::ffff:127\.[0-9.]+\]):[0-9]+$' | grep -vE ':22$' || true)"
[[ -z "$public" ]] || die "listening on a public address: $public"

echo "provisioned $DEP: cluster $PG_MAJOR/$DEP on $PG_SOCKET, checks passed"
