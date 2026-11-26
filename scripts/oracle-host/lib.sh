# shellcheck shell=bash disable=SC2034 # sourced: its names are used by the scripts that source it
# The Oracle host's names, shared by provision.sh, pgops.sh and deploy.sh
# (docs/postgres-store-design.md §7, §7.2). Source it; do not run it.
#
# One Postgres cluster per deployment. Every name a script uses comes from
# here, so the provisioning, the alerts, the dump and the deploy cannot
# disagree about a socket, a role or a user.

# ZH_ROOT prefixes every host path, for oracle-host-test's fake host layout
# only: refused for a process that really is root.
if [[ -n "${ZH_ROOT:-}" && "$EUID" == 0 ]]; then echo "ZH_ROOT is for the test, never on a host" >&2; exit 1; fi
R="${ZH_ROOT:-}"
HOST_DIR=/opt/zold-host             # these scripts, installed by provision.sh
HOST_ENV="$R/etc/zold-host/host.env" # owner input (host.env.example); root 0600
PG_MAJOR=17
NODE_VERSION=22.23.4

# deployment <mainnet|testnet>: sets the variables below or refuses.
deployment() {
  DEP="$1"
  case "$DEP" in
    mainnet) PG_PORT=5432 ;;
    testnet) PG_PORT=5433 ;;
    *) echo "unknown deployment: ${DEP:-none} (mainnet or testnet)" >&2; return 2 ;;
  esac
  PG_USER="pg-$DEP"                    # the cluster's OS user and bootstrap superuser
  PG_SOCKET="/run/postgresql-$DEP"     # unix socket only, listen_addresses = ''
  PG_DATA="/srv/pg/$DEP/data"          # on the cluster's own block volume (/srv/pg/$DEP)
  PG_CONF="/etc/postgresql/$PG_MAJOR/$DEP"
  PG_CLIENTS="zold-$DEP-db"            # the only group that may enter $PG_SOCKET
  API_USER="zold-$DEP"                 # runs the API
  DEPLOY_USER="zold-deploy-$DEP"       # owns the code checkout, runs the migrations
  APP_DIR="/srv/zold/$DEP/app"         # link to the running release (deploy.sh)
  API_ENV="$R/etc/zold/$DEP.env"       # the API's environment, owner input
  # The chain addresses, owner input: production carries no deployments.json
  # (build-production-branch.sh); deploy.sh copies this into each release.
  DEPLOYMENTS_JSON="$R/etc/zold/$DEP.deployments.json"
  ZOLD_DB=zold
  ZOLD_OWNER=zold_owner
  ZOLD_APP=zold_app
  STANZA="zold-$DEP"
  BACKREST_CONF="/etc/pgbackrest/$DEP.conf"
  if [[ "$DEP" == mainnet ]]; then HUB_USER=zold-hub; else HUB_USER=zold-hub-testnet; fi
  HUB_DB=hub
  HUB_OWNER=hub_owner
  HUB_APP=hub_app
  HUB_CONN_LIMIT=25
  # Mainnet always has the hub database; testnet only if the owner runs a
  # testnet hub (HUB_TESTNET=1 in host.env, §7.2).
  if [[ "$DEP" == mainnet || "${HUB_TESTNET:-0}" == 1 ]]; then WITH_HUB=1; else WITH_HUB=0; fi
}

# load_host_env: host.env as shell variables, NOT exported. Every runuser
# keeps root's environment, so an exported MAINNET_S3_SECRET would sit in the
# environment of every pg-testnet process, and the reverse (§7).
load_host_env() {
  [[ -f "$HOST_ENV" ]] || die "$HOST_ENV is missing"
  if grep -qE '^[[:space:]]*(export|declare|typeset)[[:space:]]' "$HOST_ENV"; then die "$HOST_ENV: no export lines (its values stay unexported)"; fi
  # shellcheck source=/dev/null
  source "$HOST_ENV"
}

# psql as the cluster's OS user over its socket: the first pg_hba line.
psql_su() {
  runuser -u "$PG_USER" -- psql -X -q -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" "$@"
}

die() { echo "$*" >&2; exit 1; }

# The primary key fingerprints in a key file, one per line; subkeys are not
# listed (provision.sh, the PGDG key).
key_primaries() {
  gpg --show-keys --with-colons "$1" | awk -F: '$1=="pub"{want=1; next} $1=="fpr" && want {print $10; want=0} $1=="sub"{want=0}'
}

# alert <what> [detail]: to the journal at priority err, and to the owner's
# phone through ALERT_URL (host.env; an HTTPS endpoint that takes the text as
# its POST body, e.g. an ntfy topic). One <what> is sent at most once per 30
# minutes, whatever its detail. It always returns 0, so under set -e no failed
# send can end a job before its next step (the hub's write stop): a failed
# send sets ALERT_FAILED, and the job exits non-zero at the end.
ALERT_FAILED=0
alert() {
  local msg="$DEP: $1${2:+ $2}" key state="$R/var/lib/zold-host/alerts"
  logger -p user.err -t zold-host -- "$msg"
  install -d -m 700 "$state"
  key="$state/$(printf '%s' "$DEP: $1" | sha256sum | cut -c1-16)"
  [[ -f "$key" && -n "$(find "$key" -mmin -30)" ]] && return 0
  # The URL can be a credential (an ntfy topic): on stdin, not the command line.
  # HTTPS only: never the URL in clear.
  if [[ "${ALERT_URL:-}" == https://* ]] && printf 'url = "%s"\n' "$ALERT_URL" | curl -fsS -m 20 --proto =https -K - --data-binary "$msg" >/dev/null; then
    touch "$key"
    return 0
  fi
  echo "alert not sent: $msg" >&2
  ALERT_FAILED=1
  return 0
}
