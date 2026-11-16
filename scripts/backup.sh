#!/usr/bin/env bash
# ============================================================================
# BAK-1 — verified PostgreSQL backups.
#
# A dump is not a backup until it has been read back. This script:
#   1. preflights tools, versions, the database and the destination;
#   2. takes a custom-format dump (`pg_dump -Fc --no-acl --no-owner`);
#   3. proves the archive with `pg_restore --list`;
#   4. optionally encrypts it (GPG recipient, env key, or passphrase file),
#      decrypting a symmetric archive again to prove the key works;
#   5. writes a manifest (parent-only table counts + GL block), SHA-256,
#      and a `.verified` marker — or `.sealed` for recipient-only encryption,
#      which cannot be decrypted on this host;
#   6. prunes complete groups under the 30-daily / 12-monthly retention rule.
#
# Sidecars use one base name:
#   <database>-<YYYYMMDD>T<HHMMSS>Z.dump          (or .dump.gpg)
#   <database>-<YYYYMMDD>T<HHMMSS>Z.manifest.json
#   <database>-<YYYYMMDD>T<HHMMSS>Z.sha256
#   <database>-<YYYYMMDD>T<HHMMSS>Z.verified       (or .sealed)
#
# Usage:
#   bash scripts/backup.sh
#   bash scripts/backup.sh --dry-run
#   BACKUP_DIR=/var/backups/isp BACKUP_RETENTION_DAYS=30 bash scripts/backup.sh
# ============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_FILES=()
LOCK_DIR=""

log()  { printf '[backup] %s\n' "$*"; }
warn() { printf '[backup:warn] %s\n' "$*" >&2; }
fail() { printf '[backup:fail] %s\n' "$*" >&2; exit 1; }

# Load .env without sourcing it. Only simple KEY=VALUE lines are read, CRLF is
# tolerated, and an already-exported value always wins (so cron and tests can
# override the file). This mirrors scripts/setup_postgres.sh.
load_env_file() {
  [ -f "$1" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    if [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      if [ -z "${!key+x}" ]; then
        export "${key}=${val}"
      fi
    fi
  done < "$1"
}
load_env_file "$ROOT_DIR/.env"

env_value() {
  local name="$1" fallback="$2"
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; else printf '%s' "$fallback"; fi
}

BACKUP_DIR="$(env_value 'BACKUP_DIR' "$ROOT_DIR/backups")"
RETENTION_DAYS="$(env_value 'BACKUP_RETENTION_DAYS' '30')"
MONTHLY_KEEP="$(env_value 'BACKUP_MONTHLY_KEEP' '12')"
GPG_RECIPIENT="$(env_value 'BACKUP_GPG_RECIPIENT' '')"
PASSPHRASE_FILE="$(env_value 'BACKUP_PASSPHRASE_FILE' '')"
ENCRYPTION_KEY="$(env_value 'BACKUP_ENCRYPTION_KEY' '')"
PG_DUMP_CONFIG="$(env_value 'BACKUP_PG_DUMP' 'pg_dump')"
PG_RESTORE_CONFIG="$(env_value 'BACKUP_PG_RESTORE' '')"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown argument: $arg (supported: --dry-run, --help)" ;;
  esac
done

positive_int() {
  local name="$1" value="$2" min="$3" max="$4"
  case "$value" in
    ''|*[!0-9]*) fail "Invalid ${name}=${value}: expected an integer between ${min} and ${max}." ;;
  esac
  if [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    fail "Invalid ${name}=${value}: expected an integer between ${min} and ${max}."
  fi
}
positive_int 'BACKUP_RETENTION_DAYS' "$RETENTION_DAYS" 1 3650
positive_int 'BACKUP_MONTHLY_KEEP' "$MONTHLY_KEEP" 1 120

warn_if_repo_path() {
  case "$BACKUP_DIR/" in
    "$ROOT_DIR"/*) warn "BACKUP_DIR resolves inside the repository ($BACKUP_DIR); prefer an off-host or excluded path." ;;
  esac
}
warn_if_repo_path

encryption_mode() {
  if [ -n "$GPG_RECIPIENT" ]; then printf 'gpg-recipient'
  elif [ -n "$ENCRYPTION_KEY" ]; then printf 'gpg-env'
  elif [ -n "$PASSPHRASE_FILE" ]; then printf 'gpg-passphrase'
  else printf 'none'
  fi
}
ENCRYPTION_MODE="$(encryption_mode)"

if [ "$DRY_RUN" -eq 1 ]; then
  PLAN_NAME="$(basename "${POSTGRES_DB:-inventory_db}")-$(date -u +%Y%m%dT%H%M%SZ)"
  PLAN_EXT='.dump'
  [ "$ENCRYPTION_MODE" = 'none' ] || PLAN_EXT='.dump.gpg'
  echo "Backup plan (dry run — no lock, no dump, no files written):"
  echo "  database:   ${POSTGRES_DB:-from DATABASE_URL}"
  echo "  directory:  $BACKUP_DIR"
  echo "  dump:       $BACKUP_DIR/$PLAN_NAME$PLAN_EXT"
  echo "  manifest:   $BACKUP_DIR/$PLAN_NAME.manifest.json"
  echo "  checksum:   $BACKUP_DIR/$PLAN_NAME.sha256"
  echo "  marker:     $BACKUP_DIR/$PLAN_NAME.$([ "$ENCRYPTION_MODE" = 'gpg-recipient' ] && echo sealed || echo verified)"
  echo "  encryption: $ENCRYPTION_MODE"
  echo "  retention:  newest $RETENTION_DAYS daily buckets + newest $MONTHLY_KEEP monthly buckets"
  echo "  pg_dump:    $PG_DUMP_CONFIG"
  echo "  pg_restore: ${PG_RESTORE_CONFIG:-next to pg_dump, or PATH}"
  exit 0
fi

mkdir -p "$BACKUP_DIR" || fail "cannot create BACKUP_DIR=$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
warn_if_repo_path
[ -w "$BACKUP_DIR" ] || fail "BACKUP_DIR is not writable: $BACKUP_DIR"
WRITE_PROBE="$BACKUP_DIR/.write-test.$$"
( : > "$WRITE_PROBE" ) || fail "BACKUP_DIR is not writable: $BACKUP_DIR"
rm -f "$WRITE_PROBE"

LOCK_DIR="$BACKUP_DIR/.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "backup: already running (lock $LOCK_DIR); exiting cleanly."
  exit 0
fi

cleanup() {
  local f
  for f in "${TMP_FILES[@]}"; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null || true
  done
  if [ -n "$LOCK_DIR" ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

require_command() {
  local name="$1" hint="$2" resolved
  resolved="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$resolved" ] || fail "$name not found. $hint"
  printf '%s' "$resolved"
}
PG_DUMP="$(require_command "$PG_DUMP_CONFIG" 'Install PostgreSQL client tools or set BACKUP_PG_DUMP=/path/to/pg_dump.')"
if [ -n "$PG_RESTORE_CONFIG" ]; then
  PG_RESTORE="$(require_command "$PG_RESTORE_CONFIG" 'Set BACKUP_PG_RESTORE to the matching pg_restore binary.')"
else
  PG_RESTORE_CANDIDATE="$(dirname "$PG_DUMP")/pg_restore"
  if [ -x "$PG_RESTORE_CANDIDATE" ]; then
    PG_RESTORE="$PG_RESTORE_CANDIDATE"
  else
    PG_RESTORE="$(require_command pg_restore 'Install PostgreSQL client tools or set BACKUP_PG_RESTORE=/path/to/pg_restore.')"
  fi
fi
PSQL="$(require_command psql 'Install PostgreSQL client tools (psql is needed for preflight and row counts).')"
NODE="$(require_command node 'Install Node.js; backup_manifest.mjs uses the project pg dependency.')"
SHA256="$(require_command sha256sum 'Install coreutils (sha256sum) or use a system with GNU coreutils.')"
if [ "$ENCRYPTION_MODE" != 'none' ]; then
  GPG="$(require_command gpg 'Install GnuPG or unset the BACKUP_* encryption variables.')"
fi

case "$ENCRYPTION_MODE" in
  gpg-passphrase)
    [ -r "$PASSPHRASE_FILE" ] || fail "BACKUP_PASSPHRASE_FILE is set but not readable: $PASSPHRASE_FILE"
    KEY_MODE="$(stat -c %a "$PASSPHRASE_FILE" 2>/dev/null || true)"
    case "$KEY_MODE" in
      400|600) ;;
      *) warn "BACKUP_PASSPHRASE_FILE should be mode 0400 (found ${KEY_MODE:-unknown}); continuing." ;;
    esac
    ;;
  gpg-recipient)
    "$GPG" --batch --list-keys -- "$GPG_RECIPIENT" >/dev/null 2>&1 \
      || fail "BACKUP_GPG_RECIPIENT=$GPG_RECIPIENT has no public key in this keyring."
    ;;
esac

if [ -n "${DATABASE_URL:-}" ]; then
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"
  PSQL_ARGS=(-w -X -A -t -v ON_ERROR_STOP=1 --dbname "$DATABASE_URL")
  DUMP_ARGS=(--dbname "$DATABASE_URL")
else
  export PGHOST="${POSTGRES_HOST:-localhost}"
  export PGPORT="${POSTGRES_PORT:-5432}"
  export PGDATABASE="${POSTGRES_DB:-inventory_db}"
  export PGUSER="${POSTGRES_USER:-inventory_user}"
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"
  PSQL_ARGS=(-w -X -A -t -v ON_ERROR_STOP=1)
  DUMP_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE")
fi

# A full test suite or a burst of workers can briefly consume the server's
# connection budget. Retry the probe before declaring the database down; a
# real authentication/schema failure exhausts the attempts and is reported.
PSQL_ERR=''
DB_CONNECTED=0
for attempt in 1 2 3 4 5; do
  if PSQL_ERR="$("$PSQL" "${PSQL_ARGS[@]}" -c 'SELECT 1' 2>&1)"; then
    DB_CONNECTED=1
    break
  fi
  if [ "$attempt" -lt 5 ]; then sleep 2; fi
done
if [ "$DB_CONNECTED" -ne 1 ]; then
  fail "PostgreSQL is not reachable with the configured DATABASE_URL/POSTGRES_* values (SELECT 1 failed): $(printf '%s' "$PSQL_ERR" | tail -1)"
fi
DB_NAME="$("$PSQL" "${PSQL_ARGS[@]}" -c 'SELECT current_database()')"
DB_NAME="${DB_NAME%$'\r'}"
[ -n "$DB_NAME" ] || fail "could not determine the current database name."
SERVER_VERSION_NUM="$("$PSQL" "${PSQL_ARGS[@]}" -c 'SHOW server_version_num')"
SERVER_VERSION_NUM="${SERVER_VERSION_NUM%$'\r'}"
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
SERVER_VERSION="$("$PSQL" "${PSQL_ARGS[@]}" -c 'SHOW server_version')"
SERVER_VERSION="${SERVER_VERSION%$'\r'}"

DUMP_VERSION_TEXT="$("$PG_DUMP" --version 2>/dev/null | head -1 | tr -d '\r')"
RESTORE_VERSION_TEXT="$("$PG_RESTORE" --version 2>/dev/null | head -1 | tr -d '\r')"
DUMP_VERSION="$(printf '%s' "$DUMP_VERSION_TEXT" | sed -nE 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/p' | head -1)"
RESTORE_VERSION="$(printf '%s' "$RESTORE_VERSION_TEXT" | sed -nE 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/p' | head -1)"
[ -n "$DUMP_VERSION" ] || fail "could not determine pg_dump version."
[ -n "$RESTORE_VERSION" ] || fail "could not determine pg_restore version."
[ "$DUMP_VERSION" -ge "$SERVER_MAJOR" ] \
  || fail "pg_dump major $DUMP_VERSION is older than PostgreSQL major $SERVER_MAJOR; use a pg_dump from PostgreSQL $SERVER_MAJOR or newer."
[ "$RESTORE_VERSION" -ge "$SERVER_MAJOR" ] \
  || fail "pg_restore major $RESTORE_VERSION is older than PostgreSQL major $SERVER_MAJOR; use a pg_restore from PostgreSQL $SERVER_MAJOR or newer."

LAST_DUMP=""
LAST_DUMP_MTIME=0
for candidate in "$BACKUP_DIR"/*.dump "$BACKUP_DIR"/*.dump.gpg; do
  [ -e "$candidate" ] || continue
  candidate_mtime="$(stat -c %Y "$candidate")"
  if [ "$candidate_mtime" -gt "$LAST_DUMP_MTIME" ]; then
    LAST_DUMP="$candidate"
    LAST_DUMP_MTIME="$candidate_mtime"
  fi
done
if [ -n "$LAST_DUMP" ]; then
  LAST_SIZE="$(stat -c %s "$LAST_DUMP")"
  FREE_KB="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
  REQUIRED_KB=$(( (LAST_SIZE + 1023) / 1024 * 2 ))
  if [ "$FREE_KB" -lt "$REQUIRED_KB" ]; then
    fail "not enough free space in $BACKUP_DIR: ${FREE_KB} KiB available, ${REQUIRED_KB} KiB required (2x the last dump)."
  fi
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BASE_NAME="$DB_NAME-$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX")"; TMP_FILES+=("$DUMP_TMP")
if ! "$PG_DUMP" -w -Fc --no-acl --no-owner -f "$DUMP_TMP" "${DUMP_ARGS[@]}"; then
  fail "pg_dump failed; no backup was recorded."
fi
if ! "$PG_RESTORE" --list "$DUMP_TMP" >/dev/null 2>&1; then
  fail "pg_restore --list rejected the new dump; refusing to record an unreadable backup."
fi
log "dump + pg_restore --list OK: $DB_NAME ($(stat -c %s "$DUMP_TMP") bytes plaintext)"
PLAIN_SHA="$("$SHA256" "$DUMP_TMP" | awk '{print $1}')"
[ -n "$PLAIN_SHA" ] || fail "could not compute the plaintext dump SHA-256."

DATA_TMP="$DUMP_TMP"
FINAL_DATA="$BACKUP_DIR/$BASE_NAME.dump"
MARKER_EXT='verified'
if [ "$ENCRYPTION_MODE" != 'none' ]; then
  ENC_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX.gpg")"; TMP_FILES+=("$ENC_TMP")
  case "$ENCRYPTION_MODE" in
    gpg-recipient)
      "$GPG" --batch --yes --no-tty --trust-model always --cipher-algo AES256 \
        --encrypt --recipient "$GPG_RECIPIENT" --output "$ENC_TMP" "$DUMP_TMP" \
        || fail "GPG recipient encryption failed; no backup was recorded."
      MARKER_EXT='sealed'
      ;;
    gpg-env)
      printf '%s' "$ENCRYPTION_KEY" | "$GPG" --batch --yes --no-tty --cipher-algo AES256 \
        --passphrase-fd 0 --symmetric --output "$ENC_TMP" "$DUMP_TMP" \
        || fail "GPG symmetric encryption with BACKUP_ENCRYPTION_KEY failed; no backup was recorded."
      ;;
    gpg-passphrase)
      "$GPG" --batch --yes --no-tty --cipher-algo AES256 \
        --passphrase-file "$PASSPHRASE_FILE" --symmetric --output "$ENC_TMP" "$DUMP_TMP" \
        || fail "GPG symmetric encryption with BACKUP_PASSPHRASE_FILE failed; no backup was recorded."
      ;;
  esac
  if [ "$ENCRYPTION_MODE" != 'gpg-recipient' ]; then
    DEC_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX.dec")"; TMP_FILES+=("$DEC_TMP")
    case "$ENCRYPTION_MODE" in
      gpg-env)
        printf '%s' "$ENCRYPTION_KEY" | "$GPG" --batch --yes --no-tty \
          --passphrase-fd 0 --decrypt --output "$DEC_TMP" "$ENC_TMP" \
          || fail "GPG decryption round-trip failed; the key cannot read the backup."
        ;;
      gpg-passphrase)
        "$GPG" --batch --yes --no-tty --passphrase-file "$PASSPHRASE_FILE" \
          --decrypt --output "$DEC_TMP" "$ENC_TMP" \
          || fail "GPG decryption round-trip failed; BACKUP_PASSPHRASE_FILE cannot read the backup."
        ;;
    esac
    cmp -s "$DUMP_TMP" "$DEC_TMP" \
      || fail "GPG decryption round-trip produced different bytes; refusing to record the backup."
  fi
  DATA_TMP="$ENC_TMP"
  FINAL_DATA="$BACKUP_DIR/$BASE_NAME.dump.gpg"
fi

DATA_BYTES="$(stat -c %s "$DATA_TMP")"
DATA_SHA="$("$SHA256" "$DATA_TMP" | awk '{print $1}')"
[ -n "$DATA_SHA" ] || fail "could not compute the dump SHA-256."
MANIFEST_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX.manifest.json")"; TMP_FILES+=("$MANIFEST_TMP")
MANIFEST_ARGS=(
  --output "$MANIFEST_TMP"
  --database "$DB_NAME"
  --file "$(basename "$FINAL_DATA")"
  --created-at "$CREATED_AT"
  --bytes "$DATA_BYTES"
  --sha256 "$DATA_SHA"
  --plaintext-sha256 "$PLAIN_SHA"
  --encryption-mode "$ENCRYPTION_MODE"
  --server-version "$SERVER_VERSION"
  --pg-dump-version "$DUMP_VERSION_TEXT"
  --pg-restore-version "$RESTORE_VERSION_TEXT"
)
if [ -n "$GPG_RECIPIENT" ] && [ "$ENCRYPTION_MODE" = 'gpg-recipient' ]; then
  MANIFEST_ARGS+=(--recipient "$GPG_RECIPIENT")
fi
"$NODE" "$SCRIPT_DIR/backup_manifest.mjs" "${MANIFEST_ARGS[@]}" \
  || fail "manifest generation failed; no backup was recorded."

SHA_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX.sha256")"; TMP_FILES+=("$SHA_TMP")
printf '%s  %s\n' "$DATA_SHA" "$(basename "$FINAL_DATA")" > "$SHA_TMP"
MARKER_TMP="$(mktemp "$BACKUP_DIR/.backup.XXXXXX.marker")"; TMP_FILES+=("$MARKER_TMP")
printf '%s_at=%s\nsha256=%s\n' "$MARKER_EXT" "$CREATED_AT" "$DATA_SHA" > "$MARKER_TMP"

mv "$DATA_TMP" "$FINAL_DATA" || fail "could not move the dump into place."
mv "$MANIFEST_TMP" "$BACKUP_DIR/$BASE_NAME.manifest.json" || fail "could not move the manifest into place."
mv "$SHA_TMP" "$BACKUP_DIR/$BASE_NAME.sha256" || fail "could not move the checksum into place."
mv "$MARKER_TMP" "$BACKUP_DIR/$BASE_NAME.$MARKER_EXT" || fail "could not move the marker into place."
chmod 600 "$FINAL_DATA" "$BACKUP_DIR/$BASE_NAME.manifest.json" "$BACKUP_DIR/$BASE_NAME.sha256" "$BACKUP_DIR/$BASE_NAME.$MARKER_EXT" 2>/dev/null || true
log "backup recorded: $FINAL_DATA ($DATA_BYTES bytes, sha256 $DATA_SHA)"
log "marker: $BASE_NAME.$MARKER_EXT ($ENCRYPTION_MODE)"

# ---------------------------------------------------------------------------
# Retention: newest N distinct daily buckets, plus the newest dump of each of
# the last M months. A group is a unit: dump, manifest, checksum and marker
# must all exist. Never delete anything unless a newer `.verified` group
# exists, and never delete the newest group.
# ---------------------------------------------------------------------------
prune_backups() {
  local manifests=() bases=() stamps=()
  local m base stamp
  for m in "$BACKUP_DIR"/*.manifest.json; do
    [ -e "$m" ] || continue
    base="${m%.manifest.json}"
    stamp="${base##*-}"
    stamp="${stamp%Z}"
    case "$stamp" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *) continue ;;
    esac
    manifests+=("$m"); bases+=("$base"); stamps+=("$stamp")
  done
  local n=${#bases[@]}
  [ "$n" -gt 1 ] || return 0

  local newest_verified=-1 i
  for ((i=n-1; i>=0; i--)); do
    if [ -f "${bases[$i]}.verified" ]; then newest_verified="$i"; break; fi
  done
  [ "$newest_verified" -ge 0 ] || { warn "retention skipped: no .verified backup exists yet."; return 0; }

  local -A keep=() day_seen=() month_seen=()
  local day_count=0 month_count=0 day month
  for ((i=n-1; i>=0; i--)); do
    stamp="${stamps[$i]}"
    day="${stamp:0:8}"
    month="${stamp:0:6}"
    if [ "$i" -eq $((n-1)) ]; then keep[$i]=1; fi
    if [ -z "${day_seen[$day]:-}" ] && [ "$day_count" -lt "$RETENTION_DAYS" ]; then
      keep[$i]=1; day_seen[$day]=1; day_count=$((day_count+1))
    fi
    if [ -z "${month_seen[$month]:-}" ] && [ "$month_count" -lt "$MONTHLY_KEEP" ]; then
      keep[$i]=1; month_seen[$month]=1; month_count=$((month_count+1))
    fi
  done

  local data marker
  for ((i=0; i<n; i++)); do
    [ -z "${keep[$i]:-}" ] || continue
    [ "$newest_verified" -gt "$i" ] || continue
    base="${bases[$i]}"
    [ -f "$base.manifest.json" ] && [ -f "$base.sha256" ] || continue
    if [ -f "$base.verified" ]; then marker="$base.verified"
    elif [ -f "$base.sealed" ]; then marker="$base.sealed"
    else continue; fi
    if [ -f "$base.dump" ]; then data="$base.dump"
    elif [ -f "$base.dump.gpg" ]; then data="$base.dump.gpg"
    else continue; fi
    rm -f "$data" "$base.manifest.json" "$base.sha256" "$marker"
    log "retention removed ${base##*/}"
  done
}
prune_backups
