#!/usr/bin/env bash
# The one way to copy the database: age-encrypted, owner-only, into
# .local-backups/ (gitignored). There is no plaintext backup.
#
#   scripts/backup-db.sh                  backs up data/db.json
#   TRANSF_DB_PATH=... scripts/backup-db.sh
set -euo pipefail
source "$(dirname "$0")/_age.sh"
umask 077
require_age; require_recipients

src="${TRANSF_DB_PATH:-$ROOT/data/db.json}"
[[ -f "$src" ]] || { echo "no database at $src" >&2; exit 1; }

out_dir="$ROOT/.local-backups"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
out="$out_dir/$(basename "$src" .json)-$(date -u +%Y%m%dT%H%M%SZ).json.age"

# persist() replaces the file by rename, so this reads one whole version.
"$AGE" -R "$AGE_RECIPIENTS" -o "$out.tmp" "$src"
mv "$out.tmp" "$out"
echo "wrote $out"
