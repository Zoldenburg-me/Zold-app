#!/usr/bin/env bash
# The deploy pull loop for one deployment (docs/postgres-store-design.md §7,
# technical-architecture §18.1), run every two minutes by zold-deploy@<dep>.timer
# as root. It replaces the Akash lease's loop. Nothing on GitHub holds a
# credential for this host: the host pulls the public `production` branch,
# which only scripts/build-production-branch.sh writes, from merged main.
#
#   /opt/zold-host/deploy.sh <mainnet|testnet>
#
# On a new production commit: check it out as a release of its own, copy in
# the owner's deployments.json, npm ci, stop the API, run the migrations as
# the owner role (and zold_grant_app), switch the `app` link, start the API
# and wait three minutes for /api/health. Nothing is staged while the API's
# env file or deployments.json is missing, so the first run after the owner
# restores them deploys and starts the API.
#
# /srv/zold/<dep> is the deploy user's, and that user runs the code it pulls
# (npm ci, db:migrate). So every write there (worktree, deployments.json,
# links, pruning) runs as the deploy user, never as root: a planted symlink
# can then reach only what the deploy user could anyway. Root refuses a
# `releases` or `app` that is not what this script made.
#
# Fix forward after a migration. A release whose health check fails is
# rolled back to the previous release only when this deploy applied no
# migration; it is then skipped until production moves on. Once a migration
# has been applied, an older build would refuse to start (assertSchemaCurrent
# refuses a schema ahead of the code), so the deploy alerts and leaves the
# new release in place: the fix is a new commit on main.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
[[ $# -eq 1 ]] || die "usage: deploy.sh <mainnet|testnet>"
[[ "$(id -u)" == 0 ]] || die "run as root"
load_host_env
deployment "$1"

exec 9>"$R/run/zold-deploy-$DEP.lock"
flock -n 9 || exit 0

# Any failure that sent no alert of its own (fetch, worktree, npm ci) still
# reaches the owner: the timer would retry every two minutes, silently.
ALERTED=0
on_exit() {
  local rc=$?
  if [[ $rc != 0 && "$ALERTED" == 0 ]]; then alert "deploy failed" "(exit $rc at line ${FAIL_LINE:-?}; journal: zold-deploy@$DEP)"; fi
}
trap 'FAIL_LINE=$LINENO' ERR
trap on_exit EXIT
fail() { alert "$1"; ALERTED=1; exit 1; }

REPO_URL="${REPO_URL:-https://github.com/Zoldenburg-me/Zold-app.git}"
BASE="$R/srv/zold/$DEP"
NODE_BIN="$R/opt/node-v$NODE_VERSION-linux-arm64/bin"
STATE="$R/var/lib/zold-host/$DEP"
install -d -m 700 "$STATE"
touch "$STATE/deploy-failed"
as_deploy() { runuser -u "$DEPLOY_USER" -- env -i HOME="$BASE" PATH="$NODE_BIN:/usr/bin:/bin" "$@"; }
# The owner role over the socket: peer, mapped from the deploy user (§7).
OWNER_URL="postgresql://$ZOLD_OWNER@/$ZOLD_DB?host=$PG_SOCKET&port=$PG_PORT"
migrate() { # release command
  runuser -u "$DEPLOY_USER" -- env -i HOME="$BASE" PATH="$NODE_BIN:/usr/bin:/bin" \
    DATABASE_URL="$OWNER_URL" APP_ROLE="$ZOLD_APP" bash -c 'cd "$1" && npm run -s db:migrate -- "$2"' _ "$1" "$2"
}
# The link switch, as the deploy user: app -> releases/<sha>.
switch_to() { as_deploy bash -c 'ln -sfn "releases/$2" "$1/app.next" && mv -T "$1/app.next" "$1/app"' _ "$BASE" "$1"; }
sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
# A systemd EnvironmentFile value: the last assignment wins, quotes stripped.
env_value() { sed -n "s/^$1=//p" "$API_ENV" | tail -1 | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"; }

# provision.sh made releases a directory and app is a link this script made.
[[ -d "$BASE/releases" && ! -L "$BASE/releases" ]] || fail "deploy refused: $BASE/releases is not a directory (a link?)"
[[ ! -e "$BASE/app" || -L "$BASE/app" ]] || fail "deploy refused: $BASE/app is not a link"

if [[ ! -d "$BASE/repo.git" ]]; then
  as_deploy git clone -q --bare --single-branch --branch production "$REPO_URL" "$BASE/repo.git"
fi
as_deploy git -C "$BASE/repo.git" fetch -q origin +refs/heads/production:refs/heads/production
new="$(as_deploy git -C "$BASE/repo.git" rev-parse production)"
sha "$new" || fail "deploy refused: production resolves to '$new', not a commit id"
cur=""
if [[ -L "$BASE/app" ]]; then
  cur="$(readlink "$BASE/app")"
  [[ "$cur" == releases/* ]] && sha "${cur#releases/}" || fail "deploy refused: $BASE/app points at '$cur'"
  cur="${cur#releases/}"
fi
[[ "$new" == "$cur" ]] && exit 0
grep -qx "$new" "$STATE/deploy-failed" && exit 0
if [[ -n "$cur" ]] && ! as_deploy git -C "$BASE/repo.git" merge-base --is-ancestor "$cur" "$new"; then
  fail "deploy refused: production ${new:0:7} does not descend from the running ${cur:0:7}"
fi
# Owner input first: nothing is built, migrated or switched without it.
for f in "$API_ENV" "$DEPLOYMENTS_JSON"; do
  if [[ ! -f "$f" ]]; then
    echo "$DEP: ${new:0:7} not deployed: $f is missing (owner input, docs/oracle-host.md)"
    # Once per 30 minutes (alert's own dedupe), so a forgotten file after a
    # rebuild reaches the owner and the timer's two-minute runs do not flood.
    alert "deploy waiting: $f is missing (owner input)" "(${new:0:7} not deployed)"
    exit 0
  fi
done
"$NODE_BIN/node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$DEPLOYMENTS_JSON" \
  || fail "deploy refused: $DEPLOYMENTS_JSON is not JSON"
port="$(env_value TRANSF_API_PORT)"
[[ -n "$port" ]] || port="$(env_value PORT)"
port="${port:-3000}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] || fail "deploy refused: the API port in $API_ENV is '$port'"

rel="$BASE/releases/$new"
if [[ ! -f "$rel/package.json" ]]; then
  as_deploy rm -rf "$rel"
  as_deploy git -C "$BASE/repo.git" worktree prune
  as_deploy git -C "$BASE/repo.git" worktree add -q --detach "$rel" "$new"
fi
# Root reads the owner's file; the deploy user writes it into its release,
# 640 in its own group, which the API user is in (provision.sh), whatever
# the umask.
as_deploy bash -c 'cat >"$1.tmp" && chgrp "$2" "$1.tmp" && chmod 640 "$1.tmp" && mv -f "$1.tmp" "$1"' _ "$rel/deployments.json" "$DEPLOY_GROUP" <"$DEPLOYMENTS_JSON"
as_deploy bash -c 'cd "$1" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error' _ "$rel"

before="$(migrate "$rel" status | cut -d' ' -f1)" || fail "deploy of ${new:0:7}: cannot read the schema version as $ZOLD_OWNER"
systemctl stop "zold-api@$DEP.service"
# The running release again, only if the schema is still the one it was
# built for (a retry after a partial migration is not).
restart_old() {
  [[ -n "$cur" ]] || return 1
  local now old_code
  now="$(migrate "$BASE/releases/$cur" status)" || return 1
  read -r now old_code <<<"$now"
  [[ "$now" == "$old_code" ]] || return 1
  systemctl start "zold-api@$DEP.service"
}
if ! out="$(migrate "$rel" apply)"; then
  after="$(migrate "$rel" status | cut -d' ' -f1)" || after="unknown"
  if [[ "$after" == "$before" ]]; then
    echo "$new" >>"$STATE/deploy-failed"
    if restart_old; then
      fail "deploy of ${new:0:7} failed in its migrations; nothing applied, ${cur:0:7} restarted"
    else
      fail "deploy of ${new:0:7} failed in its migrations; the schema ($after) is not the running build's, so the API stays stopped. Fix forward"
    fi
  fi
  fail "deploy of ${new:0:7}: migrations failed after applying some (schema $before -> $after); API stopped. Fix forward with a new commit"
fi
migrated=0
[[ "$out" == "applied none" ]] || migrated=1

switch_to "$new"
systemctl start "zold-api@$DEP.service"
for _ in $(seq 1 36); do
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/api/health"; then
    echo "$DEP: deployed ${new:0:7} ($out)"
    # Keep the running release and the two before it.
    as_deploy bash -c 'cd "$1/releases" && ls -1t | tail -n +4 | { grep -vx "$2" || true; } | xargs -r rm -rf --' _ "$BASE" "$new"
    as_deploy git -C "$BASE/repo.git" worktree prune
    exit 0
  fi
  sleep 5
done

if [[ "$migrated" == 1 ]]; then
  fail "deploy of ${new:0:7} applied migrations ($out) and does not answer /api/health. Not rolled back: fix forward with a new commit"
fi
echo "$new" >>"$STATE/deploy-failed"
systemctl stop "zold-api@$DEP.service"
if [[ -n "$cur" ]]; then
  switch_to "$cur"
  systemctl start "zold-api@$DEP.service"
fi
fail "deploy of ${new:0:7} did not answer /api/health within 3 minutes; rolled back to ${cur:0:7} and skipped"
