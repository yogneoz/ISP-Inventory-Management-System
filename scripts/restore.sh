#!/usr/bin/env bash
# ============================================================================
# BAK-2 — verified, guarded PostgreSQL restore.
#
#   bash scripts/restore.sh <backup.dump[.gpg]> --target <db> [options]
#
# Safety:
#   - the target must be named explicitly; the configured production database
#     requires --yes plus a typed/confirmed target name;
#   - a non-empty target requires --force;
#   - the same mkdir lock as backup.sh prevents backup/restore overlap;
#   - checksum and pg_restore --list run before the target is touched;
#   - encrypted artifacts are decrypted to a 0600 temp file, checked against
#     the manifest's plaintext_sha256, and removed on every exit path;
#   - the restore is transactional unless the archive contains CONCURRENTLY;
#   - table counts and GL totals are checked after restore; success is only
#     printed after verification passes.
#
# Options:
#   --yes             required when --target equals the configured database
#   --force           allow a non-empty target (resets public, then restores)
#   --safety-dump     dump the target into BACKUP_DIR before restoring
#   --list            print the archive TOC and exit without touching a DB
#   --dry-run         print the plan and exit without locking or restoring
# ============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_FILES=()
LOCK_DIR=""

log()  { printf '[restore] %s\n' "$*"; }
warn() { printf '[restore:warn] %s\n' "$*" >&2; }
fail() { printf '[restore:fail] %s\n' "$*" >&2; exit 1; }

load_env_file() {
  [ -f "$1" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    if [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]]; then continue; fi
    if [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      if [ -z "${!key+x}" ]; then export "${key}=${val}"; fi
    fi
  done < "$1"
}
load_env_file "$ROOT_DIR/.env"

env_value() {
  local name="$1" fallback="$2"
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; else printf '%s' "$fallback"; fi
}

BACKUP_DIR="$(env_value 'BACKUP_DIR' "$ROOT_DIR/backups")"
PASSPHRASE_FILE="$(env_value 'BACKUP_PASSPHRASE_FILE' '')"
ENCRYPTION_KEY="$(env_value 'BACKUP_ENCRYPTION_KEY' '')"
PG_RESTORE_CONFIG="$(env_value 'PG_RESTORE' "$(env_value 'BACKUP_PG_RESTORE' 'pg_restore')")"
PG_DUMP_CONFIG="$(env_value 'BACKUP_PG_DUMP' 'pg_dump')"

ARTIFACT=""
TARGET_DB=""
ASSUME_YES=0
FORCE=0
LIST_ONLY=0
DRY_RUN=0
SAFETY_DUMP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET_DB="${2:-}"; shift 2 ;;
    --target=*) TARGET_DB="${1#*=}"; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --safety-dump) SAFETY_DUMP=1; shift ;;
    --help|-h) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) fail "unknown argument: $1" ;;
    *)
      [ -z "$ARTIFACT" ] || fail "only one artifact may be restored"
      ARTIFACT="$1"; shift ;;
  esac
done

[ -n "$ARTIFACT" ] || fail "usage: bash scripts/restore.sh <backup.dump[.gpg]> --target <db> [--yes] [--force] [--list]"
case "$ARTIFACT" in
  *.dump|*.dump.gpg) ;;
  *) fail "artifact must end in .dump or .dump.gpg: $ARTIFACT" ;;
esac
[ -f "$ARTIFACT" ] || fail "artifact does not exist: $ARTIFACT"
ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT")" && pwd)"
ARTIFACT="$ARTIFACT_DIR/$(basename "$ARTIFACT")"
case "$ARTIFACT" in
  *.dump.gpg) BASE="${ARTIFACT%.dump.gpg}" ;;
  *.dump) BASE="${ARTIFACT%.dump}" ;;
esac
MANIFEST="$BASE.manifest.json"
SHA_FILE="$BASE.sha256"
[ -f "$MANIFEST" ] || fail "manifest does not exist: $MANIFEST"
[ -f "$SHA_FILE" ] || fail "checksum sidecar does not exist: $SHA_FILE"

if [ -n "$TARGET_DB" ] && ! [[ "$TARGET_DB" =~ ^[A-Za-z0-9_-]+$ ]]; then
  fail "Invalid --target=$TARGET_DB: expected letters, digits, underscore or hyphen."
fi
if [ "$LIST_ONLY" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ -z "$TARGET_DB" ]; then
  fail "--target is required for a restore (use --list to inspect an archive)."
fi

node_path() {
  if command -v cygpath >/dev/null 2>&1 && [[ "$1" = /* ]]; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
MANIFEST_FOR_NODE="$(node_path "$MANIFEST")"
MODE="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m?.encryption?.mode || "none")' "$MANIFEST_FOR_NODE")"
PLAIN_SHA="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m?.plaintext_sha256 || "")' "$MANIFEST_FOR_NODE")"
MANIFEST_SHA="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m?.sha256 || "")' "$MANIFEST_FOR_NODE")"
case "$ARTIFACT" in
  *.gpg)
    case "$MODE" in gpg-recipient|gpg-env|gpg-passphrase) ;; *)
      fail "artifact is encrypted but the manifest mode is '$MODE'." ;;
    esac ;;
  *)
    [ "$MODE" = "none" ] || fail "plaintext artifact has manifest encryption mode '$MODE'." ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Restore plan (dry run — no lock, no database connection, no files written):"
  echo "  artifact:   $ARTIFACT"
  echo "  manifest:   $MANIFEST"
  echo "  checksum:   $SHA_FILE"
  echo "  target:     ${TARGET_DB:-<required unless --list>}"
  echo "  encryption: $MODE"
  echo "  lock:       $BACKUP_DIR/.lock"
  echo "  restore:    $PG_RESTORE_CONFIG --exit-on-error --no-owner --no-privileges --dbname <target>"
  exit 0
fi

mkdir -p "$BACKUP_DIR" 2>/dev/null || fail "BACKUP_DIR is not usable: $BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
[ -w "$BACKUP_DIR" ] || fail "BACKUP_DIR is not writable: $BACKUP_DIR"
LOCK_DIR="$BACKUP_DIR/.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "restore: already running (lock $LOCK_DIR); exiting cleanly."
  exit 0
fi
cleanup() {
  local f
  for f in "${TMP_FILES[@]}"; do [ -n "$f" ] && rm -f "$f" 2>/dev/null || true; done
  [ -n "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

require_command() {
  local name="$1" hint="$2" resolved
  resolved="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$resolved" ] || fail "$name not found. $hint"
  printf '%s' "$resolved"
}
PG_RESTORE="$(require_command "$PG_RESTORE_CONFIG" 'Install PostgreSQL client tools or set PG_RESTORE=/path/to/pg_restore.')"
PSQL="$(require_command psql 'Install PostgreSQL client tools (psql is required).')"
NODE="$(require_command node 'Install Node.js; restore verification uses it.')"
SHA256="$(require_command sha256sum 'Install coreutils (sha256sum).')"
if [ "$MODE" != "none" ]; then
  GPG="$(require_command gpg 'Install GnuPG to restore an encrypted backup.')"
fi
if [ "$SAFETY_DUMP" -eq 1 ]; then
  PG_DUMP="$(require_command "$PG_DUMP_CONFIG" 'Install pg_dump or set BACKUP_PG_DUMP=/path/to/pg_dump for --safety-dump.')"
fi
if [ "$MODE" = "gpg-passphrase" ]; then
  [ -n "$PASSPHRASE_FILE" ] || fail "encrypted backup requires BACKUP_PASSPHRASE_FILE (or BACKUP_ENCRYPTION_KEY)."
  [ -r "$PASSPHRASE_FILE" ] || fail "BACKUP_PASSPHRASE_FILE is not readable: $PASSPHRASE_FILE"
fi
if [ "$MODE" = "gpg-env" ]; then
  [ -n "$ENCRYPTION_KEY" ] || fail "encrypted backup requires BACKUP_ENCRYPTION_KEY or BACKUP_PASSPHRASE_FILE."
fi
if [ "$MODE" = "gpg-recipient" ] && [ -n "$PASSPHRASE_FILE" ]; then
  warn "gpg-recipient backup uses the GPG keyring; BACKUP_PASSPHRASE_FILE is ignored."
fi

ARTIFACT_SHA="$("$SHA256" "$ARTIFACT" | awk '{print $1}')"
RECORDED_SHA="$(awk 'NR==1 {print $1}' "$SHA_FILE")"
[ -n "$RECORDED_SHA" ] || fail "checksum sidecar is empty: $SHA_FILE"
[ "$ARTIFACT_SHA" = "$RECORDED_SHA" ] \
  || fail "artifact checksum mismatch: expected $RECORDED_SHA, got $ARTIFACT_SHA (truncated or changed artifact)."
[ -n "$MANIFEST_SHA" ] && [ "$MANIFEST_SHA" = "$ARTIFACT_SHA" ] \
  || fail "manifest SHA-256 does not match the artifact: manifest=${MANIFEST_SHA:-missing} artifact=$ARTIFACT_SHA."

# Build the target URL without putting the password into a printed command.
if [ -n "${DATABASE_URL:-}" ]; then
  if ! TARGET_URL="$(DATABASE_URL="$DATABASE_URL" TARGET_DB="$TARGET_DB" "$NODE" -e '
    const u = new URL(process.env.DATABASE_URL);
    u.pathname = "/" + process.env.TARGET_DB;
    process.stdout.write(u.toString());
  ')"; then
    fail "DATABASE_URL is not a valid PostgreSQL URL."
  fi
  PSQL_TARGET=(--dbname "$TARGET_URL")
  RESTORE_TARGET=(--dbname "$TARGET_URL")
else
  PGHOST="${POSTGRES_HOST:-localhost}"
  PGPORT="${POSTGRES_PORT:-5432}"
  PGUSER="${POSTGRES_USER:-inventory_user}"
  case "$PGPORT" in ''|*[!0-9]*) fail "POSTGRES_PORT must be an integer, got: $PGPORT" ;; esac
  [ -n "$PGUSER" ] || fail "POSTGRES_USER must not be empty."
  export PGHOST PGPORT PGUSER
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
  export PGDATABASE="$TARGET_DB"
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"
  PSQL_TARGET=(-d "$TARGET_DB")
  RESTORE_TARGET=(-d "$TARGET_DB")
fi
LIVE_DB="$(
  if [ -n "${DATABASE_URL:-}" ]; then
    DATABASE_URL="$DATABASE_URL" "$NODE" -e '
      try { const u = new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.pathname.slice(1))); }
      catch { process.stdout.write(process.env.POSTGRES_DB || "inventory_db"); }
    '
  else
    printf '%s' "${POSTGRES_DB:-inventory_db}"
  fi
)"

if [ "$LIST_ONLY" -eq 0 ]; then
  if [ "$TARGET_DB" = "$LIVE_DB" ]; then
    [ "$ASSUME_YES" -eq 1 ] \
      || fail "refusing to restore into the configured database '$TARGET_DB' without --yes."
    if [ -n "${RESTORE_CONFIRM_TARGET:-}" ]; then
      CONFIRM="$RESTORE_CONFIRM_TARGET"
    elif [ -t 0 ]; then
      printf 'Type the target database name (%s) to overwrite the live database: ' "$TARGET_DB"
      read -r CONFIRM
    else
      fail "refusing to overwrite live database '$TARGET_DB' non-interactively; set RESTORE_CONFIRM_TARGET=$TARGET_DB and pass --yes."
    fi
    [ "$CONFIRM" = "$TARGET_DB" ] \
      || fail "target confirmation did not match '$TARGET_DB'; restore aborted before connecting."
  fi

  if ! TARGET_ERR="$("$PSQL" "${PSQL_TARGET[@]}" -w -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT 1' 2>&1)"; then
    fail "target database '$TARGET_DB' is not reachable or does not exist (restore never creates databases): $(printf '%s' "$TARGET_ERR" | tail -1)"
  fi
  TARGET_TABLES="$("$PSQL" "${PSQL_TARGET[@]}" -w -X -A -t -v ON_ERROR_STOP=1 -c "
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
  ")"
  TARGET_TABLES="${TARGET_TABLES%$'\r'}"
  if [ "$TARGET_TABLES" != "0" ] && [ "$FORCE" -ne 1 ]; then
    fail "target database '$TARGET_DB' is non-empty ($TARGET_TABLES public tables); pass --force after taking a safety dump."
  fi
fi

# Decrypt only after checksum validation. The plaintext is 0600 and is removed
# by the trap on every path.
ARCHIVE="$ARTIFACT"
if [ "$MODE" != "none" ]; then
  TMP_ARCHIVE="$(mktemp "$BACKUP_DIR/.restore.XXXXXX")"; TMP_FILES+=("$TMP_ARCHIVE")
  chmod 600 "$TMP_ARCHIVE" 2>/dev/null || true
  case "$MODE" in
    gpg-env)
      printf '%s' "$ENCRYPTION_KEY" | "$GPG" --batch --yes --no-tty --passphrase-fd 0 \
        --decrypt --output "$TMP_ARCHIVE" "$ARTIFACT" \
        || fail "GPG decryption failed with BACKUP_ENCRYPTION_KEY; no restore was attempted."
      ;;
    gpg-passphrase)
      "$GPG" --batch --yes --no-tty --passphrase-file "$PASSPHRASE_FILE" \
        --decrypt --output "$TMP_ARCHIVE" "$ARTIFACT" \
        || fail "GPG decryption failed with BACKUP_PASSPHRASE_FILE; no restore was attempted."
      ;;
    gpg-recipient)
      "$GPG" --batch --yes --no-tty --decrypt --output "$TMP_ARCHIVE" "$ARTIFACT" \
        || fail "recipient-only backup cannot be decrypted with this GPG keyring; provide its private key. No restore was attempted."
      ;;
    *) fail "unsupported encryption mode: $MODE" ;;
  esac
  [ -n "$PLAIN_SHA" ] \
    || fail "manifest has no plaintext_sha256; cannot prove the decrypted archive (regenerate with backup.sh)."
  DEC_SHA="$("$SHA256" "$TMP_ARCHIVE" | awk '{print $1}')"
  [ "$DEC_SHA" = "$PLAIN_SHA" ] \
    || fail "decrypted archive checksum mismatch: expected $PLAIN_SHA, got $DEC_SHA."
  ARCHIVE="$TMP_ARCHIVE"
fi

TOC_TMP="$(mktemp "$BACKUP_DIR/.restore.XXXXXX.toc")"; TMP_FILES+=("$TOC_TMP")
if ! "$PG_RESTORE" --list "$ARCHIVE" > "$TOC_TMP"; then
  fail "pg_restore --list rejected the archive; refusing to touch the target."
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  cat "$TOC_TMP"
  exit 0
fi

START_EPOCH="$(date +%s)"
if [ "$SAFETY_DUMP" -eq 1 ]; then
  SAFETY_FILE="$BACKUP_DIR/$TARGET_DB-safety-$(date -u +%Y%m%dT%H%M%SZ).dump"
  "$PG_DUMP" -w -Fc --no-acl --no-owner -f "$SAFETY_FILE" "${RESTORE_TARGET[@]}" \
    || fail "pre-restore safety dump failed; restore aborted before touching the target."
  "$SHA256" "$SAFETY_FILE" > "$SAFETY_FILE.sha256"
  log "safety dump: $SAFETY_FILE"
fi

CONCURRENT=0
if grep -qi 'CREATE INDEX CONCURRENTLY' "$TOC_TMP"; then
  CONCURRENT=1
  warn "archive contains CREATE INDEX CONCURRENTLY; using a non-transactional restore."
fi
if [ "$FORCE" -eq 1 ]; then
  # pg_restore --clean cannot drop constraints inherited by partitioned
  # children in the right order. Reset the public schema explicitly instead;
  # the dump recreates its extensions and every object. --force is already an
  # explicit destructive request.
  if ! "$PSQL" "${PSQL_TARGET[@]}" -w -X -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' >/dev/null; then
    fail "could not reset the target's public schema for --force; restore aborted."
  fi
fi
RESTORE_ARGS=(--exit-on-error --no-owner --no-privileges "${RESTORE_TARGET[@]}")
[ "$CONCURRENT" -eq 1 ] || RESTORE_ARGS+=(--single-transaction)
RESTORE_ARGS+=("$ARCHIVE")

if ! "$PG_RESTORE" "${RESTORE_ARGS[@]}"; then
  fail "pg_restore failed; the target was not reported as restored successfully."
fi

if [ -n "${TARGET_URL:-}" ]; then export RESTORE_TARGET_URL="$TARGET_URL"; else export PGDATABASE="$TARGET_DB"; fi
if ! "$NODE" "$SCRIPT_DIR/restore_verify.mjs" --manifest "$MANIFEST_FOR_NODE" --database "$TARGET_DB"; then
  fail "restore finished but post-restore verification failed; not reporting success."
fi
END_EPOCH="$(date +%s)"
log "restored '$TARGET_DB' from $(basename "$ARTIFACT") and verified table counts + GL in $((END_EPOCH - START_EPOCH))s"
