#!/usr/bin/env bash
# The one way to copy the database: age-encrypted, owner-only, into
# .local-backups/ (gitignored). There is no plaintext backup.
#
#   scripts/backup-db.sh                  backs up data/db.json
#   TRANSF_DB_PATH=... scripts/backup-db.sh
set -euo pipefail
source "$(dirname "$0")/_age.sh"
umask 077
# JSON store only: a deployment on Postgres is backed up by pgBackRest and the
# daily dump (docs/oracle-host.md), and its db.json is stale or absent.
[[ "${STORE_BACKEND:-json}" == json ]] || { echo "STORE_BACKEND=$STORE_BACKEND: this backs up the JSON store only; Postgres is backed up by pgBackRest and the daily dump (docs/oracle-host.md)" >&2; exit 1; }
require_age; require_recipients

src="${TRANSF_DB_PATH:-$ROOT/data/db.json}"
[[ -f "$src" ]] || { echo "no database at $src" >&2; exit 1; }

out_dir="$ROOT/.local-backups"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
out="$out_dir/$(basename "$src" .json)-$(date -u +%Y%m%dT%H%M%SZ).json.age"

# persist() replaces the file by rename, so this reads one whole version. A
# failed or half-written encryption is removed; ln refuses an existing name,
# so a second backup in the same second never replaces the first.
tmp="$out.$$.tmp"
trap 'rm -f "$tmp"' EXIT
"$AGE" -R "$AGE_RECIPIENTS" -o "$tmp" "$src"
if ! err="$(ln "$tmp" "$out" 2>&1)"; then
  if [[ -e "$out" ]]; then echo "refusing: $out exists (a backup made this second); run it again" >&2
  else echo "could not write $out: $err" >&2; fi
  exit 1
fi
echo "wrote $out"
