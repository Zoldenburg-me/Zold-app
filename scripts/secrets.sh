#!/usr/bin/env bash
# Local secrets at rest, encrypted with age (docs/running-locally.md, "Secrets").
#
#   scripts/secrets.sh init                     make an identity, keep it in the Keychain
#   scripts/secrets.sh encrypt .env             write .env.age (the plaintext stays until you delete it)
#   scripts/secrets.sh run -- npm run api       run a command with .env.age decrypted into its environment only
#   scripts/secrets.sh seal .private            write .private.tar.age
#   scripts/secrets.sh unseal .private.tar.age DEST
#
# Nothing here writes a decrypted secret to disk except `unseal`, which you
# ask for by name and which refuses an existing destination.
set -euo pipefail
source "$(dirname "$0")/_age.sh"
umask 077

cmd="${1:-}"
shift || true

case "$cmd" in
  init)
    require_age
    if security find-generic-password -s "$AGE_KEYCHAIN_SERVICE" -a "$USER" >/dev/null 2>&1; then
      echo "an identity is already in the Keychain under $AGE_KEYCHAIN_SERVICE; not replacing it" >&2
      exit 1
    fi
    secret="$("$AGE_KEYGEN" 2>/dev/null | grep '^AGE-SECRET-KEY-')"
    # Through `security -i` on stdin, so the key is never in a process's argv.
    printf 'add-generic-password -s %s -a %s -w %s\n' "$AGE_KEYCHAIN_SERVICE" "$USER" "$secret" | security -i
    "$AGE_KEYGEN" -y <<<"$secret" >>"$AGE_RECIPIENTS"
    unset secret
    echo "identity stored in the Keychain; public key appended to $AGE_RECIPIENTS"
    ;;

  encrypt)
    require_age; require_recipients
    src="${1:?usage: secrets.sh encrypt FILE}"
    "$AGE" -R "$AGE_RECIPIENTS" -o "$src.age.tmp" "$src"
    mv "$src.age.tmp" "$src.age"
    echo "wrote $src.age. Check it with 'secrets.sh run -- true', then delete $src."
    ;;

  run)
    require_age
    [[ "${1:-}" == "--" ]] && shift
    [[ $# -gt 0 ]] || { echo "usage: secrets.sh run -- COMMAND..." >&2; exit 1; }
    enc="$ROOT/.env.age"
    [[ -f "$enc" ]] || { echo "no $enc: run 'secrets.sh encrypt .env' first" >&2; exit 1; }
    if [[ -f "$ROOT/.env" ]]; then
      echo "warning: plaintext $ROOT/.env still exists; delete it once .env.age works" >&2
    fi
    exec node "$ROOT/scripts/with-env-fd.mjs" "$@" 3< <("$AGE" -d -i <(age_identity) "$enc")
    ;;

  seal)
    require_age; require_recipients
    dir="${1:?usage: secrets.sh seal DIR}"
    dir="${dir%/}"
    tar -C "$(dirname "$dir")" -czf - "$(basename "$dir")" | "$AGE" -R "$AGE_RECIPIENTS" -o "$dir.tar.age.tmp"
    mv "$dir.tar.age.tmp" "$dir.tar.age"
    echo "wrote $dir.tar.age. Check it with 'secrets.sh unseal $dir.tar.age /tmp/check', then delete $dir."
    ;;

  unseal)
    require_age
    src="${1:?usage: secrets.sh unseal FILE.tar.age DEST}"
    dest="${2:?usage: secrets.sh unseal FILE.tar.age DEST}"
    [[ -e "$dest" ]] && { echo "refusing: $dest exists" >&2; exit 1; }
    mkdir -p "$dest"
    "$AGE" -d -i <(age_identity) "$src" | tar -C "$dest" -xzf -
    echo "unsealed into $dest"
    ;;

  *)
    sed -n '2,12p' "$0" >&2
    exit 1
    ;;
esac
