#!/usr/bin/env bash
# The aarch64 toolchain check (docs/postgres-store-design.md §7): on the
# Oracle host (or any linux-arm64 machine), Node 22.23.4 linux-arm64 runs, the
# production tree installs with `npm ci --omit=dev`, and no installed package
# ships only an x86-64 binary.
#
#   scripts/oracle-host/toolchain-check.sh [<production checkout>]
#
# Without an argument it clones the public `production` branch into a
# temporary directory. Uses the Node provision.sh installs
# (/opt/node-v22.23.4-linux-arm64), or NODE_DIR.
#
# The production dependencies with native code, as of the lockfile on main:
# esbuild (through tsx, which runs the server) and its per-platform binary
# package, @esbuild/linux-arm64 here. pg is pure JavaScript (pg-native is not
# installed). Anything else that turns up as an ELF file or a .node addon is
# listed and must be aarch64.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

fail=0
bad() { echo "FAIL $*"; fail=1; }
ok() { echo "ok   $*"; }

[[ "$(uname -s)-$(uname -m)" == Linux-aarch64 ]] && ok "linux aarch64" || bad "this is $(uname -s)-$(uname -m), not Linux-aarch64"
NODE_DIR="${NODE_DIR:-/opt/node-v$NODE_VERSION-linux-arm64}"
export PATH="$NODE_DIR/bin:$PATH"
[[ "$(node -v)" == "v$NODE_VERSION" ]] && ok "node $(node -v)" || bad "node is $(node -v 2>&1), want v$NODE_VERSION"
[[ "$(node -p 'process.platform + "-" + process.arch')" == linux-arm64 ]] && ok "node is linux-arm64" || bad "node is $(node -p 'process.platform + "-" + process.arch')"

app="${1:-}"
if [[ -z "$app" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git clone -q --depth 1 --branch production "${REPO_URL:-https://github.com/Zoldenburg-me/Zold-app.git}" "$tmp/app"
  app="$tmp/app"
fi
(cd "$app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) && ok "npm ci --omit=dev --ignore-scripts (as deploy.sh)" || bad "npm ci --omit=dev failed"

# Every native file in the install: ELF executables and libraries, .node addons.
natives="$(cd "$app" && find node_modules -type f \( -name '*.node' -o -perm -u+x \) -print0 | xargs -0 -r file -L 2>/dev/null | grep -E ': +ELF ' || true)"
if [[ -z "$natives" ]]; then
  bad "no native file found (esbuild's binary should be one)"
else
  while IFS= read -r line; do
    if [[ "$line" == *"ARM aarch64"* ]]; then ok "native: ${line%%:*}"; else bad "not aarch64: $line"; fi
  done <<<"$natives"
fi
# A type annotation makes tsx hand the code to esbuild's binary.
(cd "$app" && [[ "$(node_modules/.bin/tsx -e 'const n: number = 1; console.log(n)')" == 1 ]]) \
  && ok "tsx runs esbuild" || bad "tsx (esbuild) does not run"
(cd "$app" && node -e 'process.exit(typeof require("pg").Pool === "function" ? 0 : 1)') && ok "pg loads" || bad "pg does not load"
(cd "$app" && node -e 'process.exit(require("./package.json").scripts["db:migrate"] ? 0 : 1)') \
  && ok "production has db:migrate" || bad "production's package.json has no db:migrate"

for tool in "psql --version" "pgbackrest version" "/opt/age/age --version"; do
  out="$($tool 2>&1)" && ok "$out" || bad "$tool: $out"
done
psql --version | grep -q " $PG_MAJOR\." || bad "psql is not $PG_MAJOR"

exit "$fail"
