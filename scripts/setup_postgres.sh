#!/usr/bin/env bash
# ============================================================================
# IZone Automated PostgreSQL Installation & Configuration Script
#
# What it does (each step is safe to re-run):
#   1. Detects/installs a PostgreSQL server (apt/yum/apk/brew/Docker).
#   2. Ensures the server is running and reachable.
#   3. Creates the application database + user if missing.
#   4. Applies scripts/schema.sql (idempotent) with ON_ERROR_STOP=1.
#   5. Clears ALL existing data EXCEPT the Nepali BS calendar reference
#      tables (bs_calendar_years, bs_day_records) so branches/users are
#      seeded fresh every time. Set KEEP_DATA=1 to skip this.
#   6. Verifies the schema (table count + v3.0 enterprise columns).
#   7. Hands off to `node scripts/setup_db.js` which seeds master data and
#      the demo dataset (is_demo = TRUE).
#
# Works on Linux (Debian/Ubuntu, RHEL/CentOS, Alpine), macOS (Homebrew) and
# via a Docker container.
# ============================================================================
set -u

DB_NAME="${POSTGRES_DB:-inventory_db}"
DB_USER="${POSTGRES_USER:-inventory_user}"
DB_PASS="${POSTGRES_PASSWORD:-securepassword}"
DB_PORT="${POSTGRES_PORT:-5432}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"
NODE_SETUP_SCRIPT="${SCRIPT_DIR}/setup_db.js"

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup:warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[setup:fail]\033[0m %s\n' "$*"; exit 1; }

# ---------------------------------------------------------------------------
# psql execution helper.
#
# Prefers a direct connection as the application user (password auth), which
# works identically across local installs, Docker, and remote hosts. Only
# falls back to the local `postgres` superuser (peer/su) when a direct
# connection is impossible AND we are on the database host. This removes the
# old fragile "assume su - postgres works" behaviour.
# ---------------------------------------------------------------------------
have_postgres_user() {
    id postgres >/dev/null 2>&1
}

run_psql_as_app() {
    PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
        -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d "$1"
}

run_psql_as_app_maintain() {
    PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
        -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres
}

run_psql_as_postgres() {
    su - postgres -c "psql -v ON_ERROR_STOP=1 -d $1"
}

# Executes $1 (SQL file or -c command already assembled) against DB $2 using
# the best available authentication path.
exec_sql() {
    local sql="$1" db="$2"
    if run_psql_as_app "${db}" <(printf '%s' "${sql}") >/dev/null 2>&1; then
        return 0
    fi
    if have_postgres_user && run_psql_as_postgres "${db}" <(printf '%s' "${sql}") >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

# Executes a SQL *file* against DB $2 with error output visible to the user.
exec_sql_file() {
    local file="$1" db="$2"
    if run_psql_as_app "${db}" -f "${file}" 2>&1; then
        return 0
    fi
    if have_postgres_user && run_psql_as_postgres "${db}" -f "${file}" 2>&1; then
        return 0
    fi
    return 1
}

# Runs a single -c style query and prints the result; used for verification.
query_result() {
    local sql="$1" db="$2"
    if PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
        -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d "${db}" \
        -t -A -c "${sql}" 2>/dev/null; then
        return 0
    fi
    if have_postgres_user; then
        su - postgres -c "psql -v ON_ERROR_STOP=1 -d ${db} -t -A -c \"${sql}\"" 2>/dev/null && return 0
    fi
    return 1
}

# Can we reach *any* postgres server as the app user?
app_user_can_connect() {
    PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
        -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres \
        -c 'SELECT 1;' >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 1. Detect / install a PostgreSQL server
# ---------------------------------------------------------------------------
detect_and_install_postgres() {
    if command -v psql >/dev/null 2>&1; then
        log "PostgreSQL client (psql) already installed."
        return 0
    fi
    if docker ps 2>/dev/null | grep -q inventory_postgres; then
        log "Docker PostgreSQL container 'inventory_postgres' is running."
        return 0
    fi

    warn "PostgreSQL not detected. Attempting automatic installation..."
    if [ -f /etc/debian_version ]; then
        export DEBIAN_FRONTEND=noninteractive
        (apt-get update -qq && apt-get install -y -qq postgresql postgresql-contrib libpq-dev) \
            || sudo apt-get install -y -qq postgresql postgresql-contrib libpq-dev
    elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || command -v dnf >/dev/null 2>&1; then
        (command -v dnf >/dev/null 2>&1 && dnf install -y postgresql-server postgresql) \
            || yum install -y postgresql-server postgresql \
            || sudo yum install -y postgresql-server postgresql
        postgresql-setup initdb 2>/dev/null || true
    elif [ -f /etc/alpine-release ]; then
        apk add --no-cache postgresql postgresql-contrib
        mkdir -p /run/postgresql && chown -R postgres:postgres /run/postgresql
        if [ ! -d /var/lib/postgresql/data/PG_VERSION ]; then
            su - postgres -c "initdb -D /var/lib/postgresql/data" || true
        fi
    elif command -v brew >/dev/null 2>&1; then
        brew install postgresql
        brew services start postgresql || true
    elif command -v docker >/dev/null 2>&1; then
        log "Starting PostgreSQL via Docker container..."
        docker stop inventory_postgres 2>/dev/null || true
        docker rm inventory_postgres 2>/dev/null || true
        docker run --name inventory_postgres \
            -e POSTGRES_DB="${DB_NAME}" \
            -e POSTGRES_USER="${DB_USER}" \
            -e POSTGRES_PASSWORD="${DB_PASS}" \
            -p "${DB_PORT}:5432" \
            -d postgres:16-alpine
        sleep 10
        return 0
    else
        warn "No supported package manager found; assuming PostgreSQL is reachable."
        return 1
    fi
}

# ---------------------------------------------------------------------------
# 2. Ensure the service is running
# ---------------------------------------------------------------------------
ensure_postgres_running() {
    if app_user_can_connect; then
        log "PostgreSQL is already reachable as ${DB_USER}."
        return 0
    fi
    log "Checking PostgreSQL service status..."
    if command -v systemctl >/dev/null 2>&1 && systemctl list-units 2>/dev/null | grep -q postgresql; then
        systemctl start postgresql 2>/dev/null || sudo systemctl start postgresql 2>/dev/null || true
    elif command -v service >/dev/null 2>&1; then
        service postgresql start 2>/dev/null || sudo service postgresql start 2>/dev/null || true
    elif [ -f /etc/alpine-release ]; then
        su - postgres -c "pg_ctl -D /var/lib/postgresql/data start" 2>/dev/null || true
    elif command -v brew >/dev/null 2>&1; then
        brew services start postgresql 2>/dev/null || true
    fi
    sleep 2
}

# ---------------------------------------------------------------------------
# 3. Create database + user (idempotent)
# ---------------------------------------------------------------------------
configure_database() {
    if app_user_can_connect; then
        # App user already works; just make sure the database exists.
        local db_exists
        db_exists=$(PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres \
            -t -A -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" 2>/dev/null || echo "0")
        if [ "${db_exists}" != "1" ]; then
            PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
                -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres \
                -c "CREATE DATABASE ${DB_NAME};" >/dev/null 2>&1 \
                && log "Created database ${DB_NAME}." \
                || warn "Could not create database ${DB_NAME} as ${DB_USER} (it may already exist or the user lacks privileges)."
        else
            log "Database ${DB_NAME} exists."
        fi
        return 0
    fi

    log "Provisioning database user + database..."
    exec_sql "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" postgres || \
        warn "App user creation reported an error (it may already exist)."
    exec_sql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" postgres || \
        warn "Database creation reported an error (it may already exist)."
    exec_sql "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" postgres || true
}

# ---------------------------------------------------------------------------
# 4. Apply the schema (idempotent, ON_ERROR_STOP=1, verified afterwards)
# ---------------------------------------------------------------------------
run_schema_migration() {
    if [ ! -f "${SCHEMA_FILE}" ]; then
        fail "Schema file not found: ${SCHEMA_FILE}"
    fi

    log "Applying schema (v3.0, idempotent) to ${DB_NAME}..."
    if ! exec_sql_file "${SCHEMA_FILE}" "${DB_NAME}"; then
        fail "Schema application reported errors. See messages above; fix and re-run."
    fi

    local table_count
    table_count=$(query_result \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
        "${DB_NAME}") || fail "Could not verify tables after schema application."
    log "Tables present: ${table_count:-?}"

    local demo_col
    demo_col=$(query_result \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_demo';" \
        "${DB_NAME}") || true
    if [ "${demo_col}" != "1" ]; then
        fail "Schema verification failed: products.is_demo missing. The applied schema may be outdated."
    fi
    log "Enterprise schema verified (is_demo tracking present)."

    local special_col
    special_col=$(query_result \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'is_special_tracked';" \
        "${DB_NAME}") || true
    if [ "${special_col}" != "1" ]; then
        fail "Schema verification failed: categories.is_special_tracked missing. The applied schema may be outdated."
    fi
    log "Special hardware tracking schema verified (categories.is_special_tracked present)."
}

# ---------------------------------------------------------------------------
# 5. Clear existing data before seeding (fresh-start behaviour)
#
#   * TRUNCATEs every table EXCEPT the Nepali BS calendar reference tables
#     (bs_calendar_years, bs_day_records) so seeding always starts from a
#     clean slate and branches/users are re-created fresh.
#   * fiscal_years is NOT truncated (a FK from bs_day_records would wipe the
#     Nepali calendar via CASCADE); it is cleared with DELETE, which honours
#     ON DELETE SET NULL and only nulls bs_day_records.fiscal_year_id.
#   * Set KEEP_DATA=1 to skip the wipe (e.g. when the database already holds
#     real data that must not be touched).
# ---------------------------------------------------------------------------
clear_existing_data() {
    if [ "${KEEP_DATA:-0}" = "1" ]; then
        log "KEEP_DATA=1 set - skipping data wipe (preserving existing rows)."
        return 0
    fi
    log "Clearing all data (preserving bs_calendar_years + bs_day_records)..."

    local db_table_list
    db_table_list=$(query_result \
        "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN ('bs_calendar_years', 'bs_day_records', 'fiscal_years');" \
        "${DB_NAME}") || fail "Could not enumerate tables to clear."
    if [ -n "${db_table_list}" ]; then
        # TRUNCATE with CASCADE handles FK ordering for us.
        local truncate_sql
        truncate_sql="TRUNCATE TABLE ${db_table_list} RESTART IDENTITY CASCADE;"
        if run_psql_as_app "${DB_NAME}" -c "${truncate_sql}" 2>&1; then
            log "Data cleared."
        elif have_postgres_user && run_psql_as_postgres "${DB_NAME}" -c "${truncate_sql}" 2>&1; then
            log "Data cleared (as postgres)."
        else
            warn "Could not clear data automatically - continuing to seed (existing rows may conflict)."
        fi
    fi

    # fiscal_years: DELETE (not TRUNCATE) so bs_day_records.fiscal_year_id is
    # SET NULL via the FK action instead of the calendar being wiped.
    local fy_sql="DELETE FROM fiscal_years;"
    if run_psql_as_app "${DB_NAME}" -c "${fy_sql}" 2>&1 || (have_postgres_user && run_psql_as_postgres "${DB_NAME}" -c "${fy_sql}" 2>&1); then
        log "Fiscal years cleared (Nepali calendar preserved)."
    else
        warn "Could not clear fiscal years."
    fi
}

# ---------------------------------------------------------------------------
# 6. Test the connection
# ---------------------------------------------------------------------------
test_connection() {
    if query_result "SELECT 1;" "${DB_NAME}" >/dev/null 2>&1; then
        log "Connection test: OK."
        return 0
    fi
    warn "Connection test failed. The server may still be starting; the Node seeder will retry."
    return 1
}

# ---------------------------------------------------------------------------
# 7. Hand off to the Node seeder (master data + demo dataset + FY backfill)
# ---------------------------------------------------------------------------
run_node_seeder() {
    if ! command -v node >/dev/null 2>&1; then
        warn "Node.js not found on PATH - skipping automated seeding."
        warn "Run 'npm install && npm run setup:pg' once Node is available."
        return 0
    fi
    if [ ! -f "${NODE_SETUP_SCRIPT}" ]; then
        warn "Seeder script not found: ${NODE_SETUP_SCRIPT}"
        return 0
    fi
    log "Running Node seeder (scripts/setup_db.js): schema re-check, master data, demo dataset, fiscal-year backfill..."
    # --keep-data: setup_postgres.sh already cleared tables in step 5; let
    # the Node seeder skip its own wipe to avoid redundant TRUNCATEs.
    local seeder_flags="--keep-data"
    if (cd "${SCRIPT_DIR}/.." && POSTGRES_HOST="${PSQL_HOST:-localhost}" POSTGRES_PORT="${DB_PORT}" POSTGRES_DB="${DB_NAME}" POSTGRES_USER="${DB_USER}" POSTGRES_PASSWORD="${DB_PASS}" node "${NODE_SETUP_SCRIPT}" ${seeder_flags}); then
        log "Node seeder completed."
    else
        warn "Node seeder reported a problem; re-run 'npm run setup:pg' for details."
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "=========================================================================="
echo " Inventory Management System: Automated PostgreSQL Installer & Configurator"
echo " Schema v3.0 (enterprise: is_demo tracking, audit columns, fiscal-year FKs)"
echo " Resets all data except the Nepali BS calendar on every run"
echo "=========================================================================="

log "Step 1: Detecting/installing PostgreSQL if needed..."
detect_and_install_postgres || true

log "Step 2: Ensuring PostgreSQL is running..."
ensure_postgres_running

log "Step 3: Configuring database and user..."
configure_database

log "Step 4: Applying schema..."
run_schema_migration

log "Step 5: Clearing existing data (keeps Nepali BS calendar)..."
clear_existing_data

log "Step 6: Testing connection..."
test_connection || true

log "Step 7: Running Node seeder (master + demo data)..."
run_node_seeder

echo ""
echo "=========================================================================="
echo " PostgreSQL setup completed."
echo "   Host:     ${PSQL_HOST:-localhost}"
echo "   Port:     ${DB_PORT}"
echo "   Database: ${DB_NAME}"
echo "   User:     ${DB_USER}"
echo "=========================================================================="
echo ""
echo " Next steps:"
echo "   1. npm install        (if dependencies are not installed yet)"
echo "   2. npm run dev        (or: npm run build && npm start)"
echo "   3. Open http://localhost:5000 (or the PORT you configured)"
echo ""
echo " Demo data is seeded with is_demo = TRUE and can be removed any time"
echo " from the app (Settings > Clear Demo / Dummy Data). It never touches"
echo " real rows."