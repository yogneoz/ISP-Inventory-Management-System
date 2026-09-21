#!/usr/bin/env bash
# ============================================================================
# Inventory Automated PostgreSQL Installation & Configuration Script
#
# What it does (each step is safe to re-run):
#   1. Detects/installs a PostgreSQL server (apt/yum/apk/brew/Docker).
#   2. Ensures the server is running and reachable.
#   3. Creates the application database + user if missing.
#   4. Applies scripts/schema.sql (idempotent) with ON_ERROR_STOP=1.
#   5. Verifies the schema (table count + v3.0 enterprise columns).
#   6. Hands off to `node scripts/setup_db.js` which seeds master data and
#      the demo dataset (is_demo = TRUE).
#
# Works on Linux (Debian/Ubuntu, RHEL/CentOS, Alpine), macOS (Homebrew),
# Windows (Git Bash) and via a Docker container.
#
# On a truly fresh server (no inventory_db / inventory_user yet) the script
# bootstraps the role + database as a PostgreSQL superuser. Supply the
# superuser password via PG_SUPERUSER_PASSWORD, or the script will prompt for
# it interactively when run from a terminal.
# ============================================================================
set -u

DB_NAME="${POSTGRES_DB:-inventory_db}"
DB_USER="${POSTGRES_USER:-inventory_user}"
DB_PASS="${POSTGRES_PASSWORD:-securepassword}"
DB_PORT="${POSTGRES_PORT:-5432}"
# Superuser credentials are ONLY used to provision a brand-new server
# (role + database). Set PG_SUPERUSER_PASSWORD when the server requires a
# password for the superuser (the default on Windows and remote hosts);
# otherwise the script falls back to the local `postgres` OS account.
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
PG_SUPERUSER_PASSWORD="${PG_SUPERUSER_PASSWORD:-}"
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
    # SQL is passed via -c so it survives the `su` boundary (process
    # substitution /dev/fd paths do NOT survive across sessions). Double
    # quotes (with inner double quotes escaped) keep embedded single quotes in
    # the SQL (e.g. CREATE USER ... PASSWORD '...') intact.
    PGPASSWORD="" su - postgres -c "psql -v ON_ERROR_STOP=1 -d $1 -c \"$2\""
}

# Connects as the PostgreSQL superuser. Precedence of auth methods:
#   1. PG_SUPERUSER_PASSWORD env var (works on any host, incl. Windows)
#   2. the local `postgres` OS account via `su` (Linux/macOS only)
#   3. a passwordless (trust) local connection as PG_SUPERUSER
# The statement must be passed via -c so the su path can carry it.
run_psql_as_superuser() {
    local db="$1" sql="$2"
    if [ -n "${PG_SUPERUSER_PASSWORD}" ]; then
        PGPASSWORD="${PG_SUPERUSER_PASSWORD}" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${PG_SUPERUSER}" -d "${db}" -c "${sql}"
    elif have_postgres_user; then
        run_psql_as_postgres "${db}" "${sql}"
    else
        PGPASSWORD="" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${PG_SUPERUSER}" -d "${db}" -c "${sql}"
    fi
}

# Can we connect to any maintenance database (postgres, else template1) as the
# superuser? Prints the chosen database name.
superuser_maintenance_db() {
    if run_psql_as_superuser postgres "SELECT 1;" >/dev/null 2>&1; then
        printf 'postgres'
    elif run_psql_as_superuser template1 "SELECT 1;" >/dev/null 2>&1; then
        printf 'template1'
    else
        printf ''
    fi
}

# Executes a SQL *file* against DB $2 with error output visible to the user.
exec_sql_file() {
    local file="$1" db="$2"
    if run_psql_as_app "${db}" -f "${file}" 2>&1; then
        return 0
    fi
    if [ -n "${PG_SUPERUSER_PASSWORD}" ]; then
        PGPASSWORD="${PG_SUPERUSER_PASSWORD}" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${PG_SUPERUSER}" -d "${db}" -f "${file}" 2>&1
        return $?
    fi
    # Real file path survives the `su` boundary (unlike /dev/fd paths), so we
    # invoke su directly here.
    if have_postgres_user && PGPASSWORD="" su - postgres -c "psql -v ON_ERROR_STOP=1 -d ${db} -f '${file}'" 2>&1; then
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
    if [ -n "${PG_SUPERUSER_PASSWORD}" ]; then
        PGPASSWORD="${PG_SUPERUSER_PASSWORD}" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${PG_SUPERUSER}" -d "${db}" \
            -t -A -c "${sql}" 2>/dev/null
        return $?
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
        if [ "${db_exists}" = "1" ]; then
            log "Database ${DB_NAME} exists."
            return 0
        fi
        # The app user rarely has CREATEDB on a fresh install. Try as the
        # app user first, then fall through to a superuser below.
        if PGPASSWORD="${DB_PASS}" psql -v ON_ERROR_STOP=1 \
            -h "${PSQL_HOST:-localhost}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres \
            -c "CREATE DATABASE ${DB_NAME};" >/dev/null 2>&1; then
            log "Created database ${DB_NAME} (as ${DB_USER})."
            return 0
        fi
        log "App user cannot create the database; checking for a superuser..."
    else
        # Fresh server: there is no app user yet, so the superuser must create
        # both the role and the database.
        log "No app user present; provisioning user + database via a superuser..."
    fi

    # Fresh provision via a PostgreSQL superuser. This works on Windows too
    # (PG_SUPERUSER_PASSWORD) and on Linux/macOS (`su - postgres`).
    #
    # If no superuser password is configured and we are on an interactive
    # terminal (not an OS account + Linux/macOS), ask for it once.
    if [ -z "${PG_SUPERUSER_PASSWORD}" ] && ! have_postgres_user && [ -t 0 ]; then
        read -s -r -p "[setup] PostgreSQL superuser (${PG_SUPERUSER}) password: " PG_SUPERUSER_PASSWORD
        printf '\n'
    fi

    local maint_db role_exists db_exists
    maint_db=$(superuser_maintenance_db)
    if [ -z "${maint_db}" ]; then
        warn "No superuser connection available."
        warn "Set PG_SUPERUSER_PASSWORD to the ${PG_SUPERUSER} superuser's password"
        warn "and re-run (on Linux/macOS a local 'postgres' OS account also works)."
        warn "  PowerShell: \$env:PG_SUPERUSER_PASSWORD='...'; npm run setup:pg"
        warn "  Linux/macOS: PG_SUPERUSER_PASSWORD='...' npm run setup:pg"
        return 1
    fi

    role_exists=$(run_psql_as_superuser "${maint_db}" \
        "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" 2>/dev/null | tr -d '[:space:]')
    if [ "${role_exists}" != "1" ]; then
        if run_psql_as_superuser "${maint_db}" \
            "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" >/dev/null 2>&1; then
            log "Created database role ${DB_USER}."
        else
            warn "Could not create role ${DB_USER} automatically - create it manually and re-run."
            return 1
        fi
    else
        log "Database role ${DB_USER} exists."
        # Keep the stored password in sync with DB_PASS so app auth always works.
        run_psql_as_superuser "${maint_db}" \
            "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" >/dev/null 2>&1 || true
    fi

    # Grant CREATEDB so the app user can re-create its own database on a later
    # bare re-run (e.g. after the DB is dropped) without needing the superuser.
    run_psql_as_superuser "${maint_db}" \
        "ALTER ROLE ${DB_USER} CREATEDB;" >/dev/null 2>&1 || true

    db_exists=$(run_psql_as_superuser "${maint_db}" \
        "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" 2>/dev/null | tr -d '[:space:]')
    if [ "${db_exists}" != "1" ]; then
        if run_psql_as_superuser "${maint_db}" \
            "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" >/dev/null 2>&1; then
            log "Created database ${DB_NAME} (owner ${DB_USER})."
        else
            warn "Could not create database ${DB_NAME} automatically - create it manually and re-run."
            return 1
        fi
    fi

    run_psql_as_superuser "${maint_db}" \
        "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" >/dev/null 2>&1 || true
    log "Database ${DB_NAME} is ready (owner: ${DB_USER})."
    return 0
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

    local serial_log_col
    serial_log_col=$(query_result \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'serial_log';" \
        "${DB_NAME}") || true
    if [ "${serial_log_col}" != "1" ]; then
        fail "Schema verification failed: serial_log table missing. The applied schema may be outdated."
    fi
    log "Serial-log register schema verified (serial_log present)."
}

# ---------------------------------------------------------------------------
# 5. Test the connection
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
# 6. Hand off to the Node seeder (master data + demo dataset + FY backfill)
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
    if (cd "${SCRIPT_DIR}/.." && POSTGRES_HOST="${PSQL_HOST:-localhost}" POSTGRES_PORT="${DB_PORT}" POSTGRES_DB="${DB_NAME}" POSTGRES_USER="${DB_USER}" POSTGRES_PASSWORD="${DB_PASS}" node "${NODE_SETUP_SCRIPT}"); then
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
echo "=========================================================================="

log "Step 1: Detecting/installing PostgreSQL if needed..."
detect_and_install_postgres || true

log "Step 2: Ensuring PostgreSQL is running..."
ensure_postgres_running

log "Step 3: Configuring database and user..."
if ! configure_database; then
    fail "Database configuration failed. See the messages above."
fi

log "Step 4: Applying schema..."
run_schema_migration

log "Step 5: Testing connection..."
test_connection || true

log "Step 6: Running Node seeder (master + demo data)..."
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
echo "   3. Open http://localhost:3000 (or the PORT you configured; default 3000)"
echo ""
echo " Demo data is seeded with is_demo = TRUE and can be removed any time"
echo " from the app (Settings > Clear Demo / Dummy Data). It never touches"
echo " real rows."