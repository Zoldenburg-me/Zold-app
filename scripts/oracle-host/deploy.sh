#!/usr/bin/env bash
# The deploy pull loop for one deployment (docs/postgres-store-design.md §7,
# technical-architecture §18.1), run every two minutes by zold-deploy@<dep>.timer
# as root. It replaces the Akash lease's loop. Nothing on GitHub holds a
# credential for this host: the host pulls the public `production` branch,
# which only scripts/build-production-branch.sh writes, from merged main.
#
#   /opt/zold-host/deploy.sh <mainnet|testnet>
#
# On a new production commit: check it out as a release of its own, npm ci,
# stop the API, run the migrations as the owner role (and zold_grant_app),
# switch the `app` link, start the API and wait three minutes for
# /api/health.
#
# Fix forward after a migration. A release whose health check fails is
# rolled back to the previous release only when this deploy applied no
# migration; it is then skipped until production moves on. Once a migration
# has been applied, an older build would refuse to start (assertSchemaCurrent
# refuses a schema ahead of the code), so the deploy alerts and leaves the
# new release in place: the fix is a new commit on main.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
[[ $# -eq 1 ]] || die "usage: deploy.sh <mainnet|testnet>"
[[ "$(id -u)" == 0 ]] || die "run as root"
set -a; source "$HOST_ENV"; set +a
deployment "$1"

exec 9>"/run/zold-deploy-$DEP.lock"
flock -n 9 || exit 0

REPO_URL="${REPO_URL:-https://github.com/Zoldenburg-me/Zold-app.git}"
BASE="/srv/zold/$DEP"
NODE_BIN="/opt/node-v$NODE_VERSION-linux-arm64/bin"
STATE="/var/lib/zold-host/$DEP"
install -d -m 700 "$STATE"
touch "$STATE/deploy-failed"
as_deploy() { runuser -u "$DEPLOY_USER" -- env -i HOME="$BASE" PATH="$NODE_BIN:/usr/bin:/bin" "$@"; }
# The owner role over the socket: peer, mapped from the deploy user (§7).
OWNER_URL="postgresql://$ZOLD_OWNER@/$ZOLD_DB?host=$PG_SOCKET&port=$PG_PORT"
migrate() { # release command
  runuser -u "$DEPLOY_USER" -- env -i HOME="$BASE" PATH="$NODE_BIN:/usr/bin:/bin" \
    DATABASE_URL="$OWNER_URL" APP_ROLE="$ZOLD_APP" bash -c 'cd "$1" && npm run -s db:migrate -- "$2"' _ "$1" "$2"
}

if [[ ! -d "$BASE/repo.git" ]]; then
  as_deploy git clone -q --bare --single-branch --branch production "$REPO_URL" "$BASE/repo.git"
fi
as_deploy git -C "$BASE/repo.git" fetch -q origin +refs/heads/production:refs/heads/production
new="$(as_deploy git -C "$BASE/repo.git" rev-parse production)"
cur=""
[[ -L "$BASE/app" ]] && cur="$(basename "$(readlink "$BASE/app")")"
[[ "$new" == "$cur" ]] && exit 0
grep -qx "$new" "$STATE/deploy-failed" && exit 0
if [[ -n "$cur" ]] && ! as_deploy git -C "$BASE/repo.git" merge-base --is-ancestor "$cur" "$new"; then
  alert "deploy refused: production ${new:0:7} does not descend from the running ${cur:0:7}"
  exit 1
fi

rel="$BASE/releases/$new"
if [[ ! -f "$rel/package.json" ]]; then
  rm -rf "$rel"
  as_deploy git -C "$BASE/repo.git" worktree prune
  as_deploy git -C "$BASE/repo.git" worktree add -q --detach "$rel" "$new"
fi
as_deploy bash -c 'cd "$1" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error' _ "$rel"

before="$(migrate "$rel" status | cut -d' ' -f1)" || { alert "deploy of ${new:0:7}: cannot read the schema version as $ZOLD_OWNER"; exit 1; }
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
      alert "deploy of ${new:0:7} failed in its migrations; nothing applied, ${cur:0:7} restarted"
    else
      alert "deploy of ${new:0:7} failed in its migrations; the schema ($after) is not the running build's, so the API stays stopped. Fix forward"
    fi
  else
    alert "deploy of ${new:0:7}: migrations failed after applying some (schema $before -> $after); API stopped. Fix forward with a new commit"
  fi
  exit 1
fi
migrated=0
[[ "$out" == "applied none" ]] || migrated=1

ln -sfn "releases/$new" "$BASE/app.next"
mv -T "$BASE/app.next" "$BASE/app"

if [[ ! -f "$API_ENV" ]]; then
  echo "$DEP: ${new:0:7} built and migrated ($out); $API_ENV is missing, so the API is not started"
  exit 0
fi
port="$(sed -n 's/^TRANSF_API_PORT=//p; s/^PORT=//p' "$API_ENV" | head -1)"
port="${port:-3000}"
systemctl start "zold-api@$DEP.service"
for _ in $(seq 1 36); do
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/api/health"; then
    echo "$DEP: deployed ${new:0:7} ($out)"
    # Keep the running release and the two before it.
    for old in $(ls -1t "$BASE/releases" | tail -n +4); do
      [[ "$old" == "$new" ]] || rm -rf "${BASE:?}/releases/$old"
    done
    as_deploy git -C "$BASE/repo.git" worktree prune
    exit 0
  fi
  sleep 5
done

if [[ "$migrated" == 1 ]]; then
  alert "deploy of ${new:0:7} applied migrations ($out) and does not answer /api/health. Not rolled back: fix forward with a new commit"
  exit 1
fi
echo "$new" >>"$STATE/deploy-failed"
systemctl stop "zold-api@$DEP.service"
if [[ -n "$cur" ]]; then
  ln -sfn "releases/$cur" "$BASE/app.next"
  mv -T "$BASE/app.next" "$BASE/app"
  systemctl start "zold-api@$DEP.service"
fi
alert "deploy of ${new:0:7} did not answer /api/health within 3 minutes; rolled back to ${cur:0:7} and skipped"
exit 1
