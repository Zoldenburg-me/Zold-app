#!/usr/bin/env bash
# Local secrets at rest, encrypted with age (docs/running-locally.md, "Secrets").
#
#   scripts/secrets.sh init                     make an identity, keep it in the Keychain
#   scripts/secrets.sh encrypt .env             write .env.age (the plaintext stays until you delete it)
#   scripts/secrets.sh run -- npm run api       run a command with .env.age decrypted into its environment only
#   scripts/secrets.sh set NAME                 add NAME to .env.age; the value is read hidden (or from a pipe)
#   scripts/secrets.sh set NAME --random [--prefix k1:]   ... with 32 random bytes as base64 instead
#   scripts/secrets.sh set NAME --replace       overwrite a NAME that is already set
#   scripts/secrets.sh seal .private            write .private.tar.age
#   scripts/secrets.sh unseal .private.tar.age DEST
#
# Nothing here writes a decrypted secret to disk except `unseal`, which you
# ask for by name and which refuses an existing destination.
#
# SECRETS_ENV_FILE points `run` and `set` at another file than .env.age.
set -euo pipefail
source "$(dirname "$0")/_age.sh"
umask 077
ENV_AGE="${SECRETS_ENV_FILE:-$ROOT/.env.age}"

cmd="${1:-}"
shift || true

case "$cmd" in
  init)
    require_age
    if security find-generic-password -s "$AGE_KEYCHAIN_SERVICE" -a "$USER" >/dev/null 2>&1; then
      echo "an identity is already in the Keychain under $AGE_KEYCHAIN_SERVICE; not replacing it" >&2
      exit 1
    fi
    secret="$("$AGE_KEYGEN" 2>/dev/null | grep '^AGE-SECRET-KEY-')" || { echo "age-keygen failed" >&2; exit 1; }
    # The key goes only through pipes from the printf builtin: never in a
    # process's argv, and never through a here-string, which bash 3.2 (the
    # macOS bash) writes to a temp file.
    printf 'add-generic-password -s %s -a %s -w %s\n' "$AGE_KEYCHAIN_SERVICE" "$USER" "$secret" | security -i
    printf '%s\n' "$secret" | "$AGE_KEYGEN" -y >>"$AGE_RECIPIENTS"
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
    enc="$ENV_AGE"
    [[ -f "$enc" ]] || { echo "no $enc: run 'secrets.sh encrypt .env' first" >&2; exit 1; }
    if [[ -f "${enc%.age}" ]]; then
      echo "warning: plaintext ${enc%.age} still exists; delete it once $enc works" >&2
    fi
    # Decrypt in full first: age streams 64 KiB chunks, so a damaged file can
    # print its first chunks before failing. Only a clean exit is handed on,
    # through a pipe (a here-string would be a temp file in bash 3.2).
    plaintext="$("$AGE" -d -i <(age_identity) "$enc")" || { echo "could not decrypt $enc; not starting the command" >&2; exit 1; }
    exec node "$ROOT/scripts/with-env-fd.mjs" "$@" 3< <(printf '%s\n' "$plaintext")
    ;;

  set)
    require_age; require_recipients
    name="${1:?usage: secrets.sh set NAME [--replace] [--random [--prefix STR]]}"
    shift
    enc="$ENV_AGE"
    [[ -f "$enc" ]] || { echo "no $enc: run 'secrets.sh encrypt .env' first" >&2; exit 1; }
    plaintext="$("$AGE" -d -i <(age_identity) "$enc")" || { echo "could not decrypt $enc; nothing changed" >&2; exit 1; }
    value=""
    if [[ " $* " != *" --random "* ]]; then
      if [[ -t 0 ]]; then
        IFS= read -rs -p "value for $name (hidden): " value </dev/tty
        echo >&2
      else
        value="$(cat)"
      fi
    fi
    # The new file is written beside the old and replaces it only once it
    # decrypts and holds NAME. Plaintext moves through pipes from the printf
    # builtin only (see init); env-set.mjs refuses anything that would change
    # another value.
    tmp="${enc%.age}.tmp.age"
    trap 'rm -f "$tmp"' EXIT
    node "$ROOT/scripts/env-set.mjs" "$name" "$@" 3< <(printf '%s\n' "$plaintext") 4< <(printf '%s' "$value") \
      | "$AGE" -R "$AGE_RECIPIENTS" -o "$tmp"
    unset plaintext value
    "$AGE" -d -i <(age_identity) "$tmp" \
      | node -e 'const t = require("node:fs").readFileSync(0, "utf8"); process.exit(Object.hasOwn(require("node:util").parseEnv(t), process.argv[1]) ? 0 : 1)' "$name" \
      || { echo "the re-encrypted file does not read back with $name; $enc is unchanged" >&2; exit 1; }
    mv "$enc" "${enc%.age}.prev.age"
    mv "$tmp" "$enc"
    echo "set $name in $enc, encrypted to $AGE_RECIPIENTS; the previous file is ${enc%.age}.prev.age"
    ;;

  seal)
    require_age; require_recipients
    dir="${1:?usage: secrets.sh seal DIR}"
    dir="${dir%/}"
    tar -C "$(dirname "$dir")" -czf - "$(basename "$dir")" | "$AGE" -R "$AGE_RECIPIENTS" -o "$dir.tar.age.tmp"
    mv "$dir.tar.age.tmp" "$dir.tar.age"
    echo "wrote $dir.tar.age. Check it with 'secrets.sh unseal $dir.tar.age \"\$(mktemp -d)/check\"', then delete that and $dir."
    ;;

  unseal)
    require_age
    src="${1:?usage: secrets.sh unseal FILE.tar.age DEST}"
    dest="${2:?usage: secrets.sh unseal FILE.tar.age DEST}"
    [[ -e "$dest" ]] && { echo "refusing: $dest exists" >&2; exit 1; }
    # Unpack beside the destination and move it into place only on success,
    # so a failed decrypt leaves nothing that blocks the retry.
    mkdir -p "$(dirname "$dest")"
    staging="$(mktemp -d "$(dirname "$dest")/.unseal.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    "$AGE" -d -i <(age_identity) "$src" | tar -C "$staging" -xzf -
    mv "$staging" "$dest"
    echo "unsealed into $dest"
    ;;

  *)
    sed -n '2,17p' "$0" >&2
    exit 1
    ;;
esac
