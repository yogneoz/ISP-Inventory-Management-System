# Disaster Recovery Runbook

**Status:** current · **Owner:** Operations Lead · **Last drill:** 2026-11-16

This is the operator procedure for losing or corrupting the Inventory ERP
database. It is written for a person who has never restored this system before:
every command is run from the repository root unless a step says otherwise, and
every placeholder is marked with `<...>`.

## 0. Current provisioning and recovery targets

The repository contains tested backup, restore and drill commands (BAK-1 through
BAK-4). A clean checkout is **not** a provisioned disaster-recovery site. As of
2026-11-16 this deployment has:

| Capability | State on this deployment |
|---|---|
| Verified logical dump — `npm run backup` | **Implemented and tested.** Writes `.dump`/`.dump.gpg`, `.manifest.json`, `.sha256` and `.verified` after `pg_restore --list` succeeds. |
| Guarded restore — `bash scripts/restore.sh` | **Implemented and tested.** Refuses a live target without `--yes`; requires `--force` for a non-empty target; verifies counts and GL after restore. |
| Disposable restore drill — `npm run check:restore-drill` | **Implemented and tested.** Creates and always drops an `inventory_drill_<UTC>` scratch database. |
| Off-host `BACKUP_DIR` | **NOT PROVISIONED.** `BACKUP_DIR` defaults to `./backups`; that is not an off-host copy. |
| Scheduled daily backup | **NOT PROVISIONED.** The cron/systemd examples below must be installed on the host. |
| Weekly drill timer | **NOT PROVISIONED.** The example timer below is not installed. |
| Backup encryption | **OPTIONAL, NOT CONFIGURED.** The code supports GPG recipient, passphrase-file and env-key modes; no key is provisioned here. |
| WAL archiving and PITR | **NOT PROVISIONED.** `archive_mode`/`archive_command` and a pgBackRest or WAL-G repository are not configured on this host. |
| Automated monitoring/alert delivery | **NOT PROVISIONED.** The thresholds and queries below must be wired to the operator's monitoring system. |
| Production restore authorization | **DEFINED BELOW.** The roles and two-person rule are the procedure, not an installed access control. |

### What the RPO and RTO mean here

- A dump-only installation has **RPO = 24 h**: the newest verified dump may be
  up to one day old, and every transaction after it can be lost.
- **RPO ≤ 15 min only once WAL archiving is live** and the archive is
  monitored. Until the WAL section below is provisioned, do not claim a 15-minute
  RPO; the honest current target is **24 h**.
- **RTO ≤ 2 h** is the recovery target for a production incident, measured from
  incident declaration to verified application traffic. It includes restoring
  the cluster, verifying it, and returning the app to service.
- The measured logical restore/drill on 2026-11-16 completed in **22.5 s**
  (119/119 parent tables, GL debit = credit = 400,113.00, net 0.00). That is the
  evidence for the database-restore step, not a claim that the whole 2-hour
  incident procedure has been timed end to end. Record the full RTO in the
  rehearsal log below after each real rehearsal.

## 1. Assets and blast radius

| Asset | Why it matters | If lost |
|---|---|---|
| PostgreSQL `inventory_db` | Ledger, stock, invoices, customer/supplier records, HR and payroll history | Total operational and financial loss from the last recoverable point |
| PostgreSQL roles and credentials | The app cannot connect; ownership affects restore | App outage; a restore may need role recreation |
| `.env` and secret material | `DATABASE_URL`, auth secret, SMTP/API keys, encryption settings | App cannot start or authenticate |
| `BACKUP_DIR` artifacts | The only dump, manifest, checksum and marker set | No logical recovery point |
| Backup encryption key / GPG private key | Decrypts the artifacts; must not live on the database host | Encrypted backups become unreadable |
| WAL archive | Point-in-time recovery between dumps | RPO falls back to the dump interval |
| Application host and reverse proxy | Serves the restored database | Users cannot reach the recovered system |
| Monitoring and logs | Detects the incident and proves the recovery | Silent data loss or an unverified restore |

**Blast radius:** losing the database volume, the backup directory and the
encryption key together is unrecoverable without an off-host copy. Keeping a
copy on the same disk is not disaster recovery; verify the copy is on a
different host, mount or object store before declaring the site protected.

## 2. Roles, declaration and escalation

Use role titles in the incident log; fill the actual names and phone numbers in
the deployment contact record, not in this repository.

| Role | Who fills it | Authority |
|---|---|---|
| Incident Commander (IC) | Operations Lead / on-call lead | Declares `SEV-1` (data loss or production down) or `SEV-2` (degraded/recovery risk); owns the incident timeline and communications. Anyone may report a suspected incident, but the IC declares it. |
| Database Operator | DBA or trained on-call engineer | Runs backup, restore and PITR commands; preserves the failed cluster; records every command and timestamp. |
| Data Owner | Finance Controller / Head of Finance | Confirms the recovered ledger, trial balance and business totals; signs off the restored data. |
| Key Custodian | Security Lead / CTO | Holds the GPG private key or passphrase in an offline secret store; releases it only to the Database Operator under the IC's direction. The key is never stored beside `BACKUP_DIR`. |
| Restore Approver | CTO or Managing Director | Authorizes a restore over production after the IC and Data Owner agree. A destructive restore requires two people: the Approver and the IC. |

**Declaration and escalation order:**

1. Any operator detecting a failed backup, failed drill, corrupt database or
   unexplained data loss opens an incident channel and notifies the IC.
2. The IC declares the severity, starts the incident log, and calls the Database
   Operator and Data Owner.
3. The IC confirms whether the production database is still reachable. If it is
   reachable, preserve evidence and take a fresh verified dump before changing
   anything. If it is not, proceed to the restore decision tree.
4. The Restore Approver authorizes production restore. The Key Custodian
   releases the key. The Database Operator executes; the Data Owner validates.
5. The IC declares recovery only after the post-restore checks in §6 pass and
   the application has served a smoke request.

## 3. Prerequisites and backup inventory

Install these on the host that will run backups and restores:

```bash
sudo apt-get update
sudo apt-get install -y postgresql-client gpg coreutils util-linux
node --version
npm --version
pg_dump --version
pg_restore --version
psql --version
```

The PostgreSQL client major version must be at least the server major version.
Put `pg_dump`/`pg_restore` on `PATH`, or set `BACKUP_PG_DUMP`,
`BACKUP_PG_RESTORE` and `PG_RESTORE` in `.env`.

Set at minimum:

```bash
export BACKUP_DIR=/var/backups/isp
export DATABASE_URL='postgres://inventory_user:REDACTED@localhost:5432/inventory_db'
# Optional when the role cannot CREATE DATABASE for the drill:
export DRILL_ADMIN_URL='postgres://postgres:REDACTED@localhost:5432/postgres'
# Optional encryption (pick one; do not put a passphrase in shell history):
# export BACKUP_PASSPHRASE_FILE=/etc/isp/backup.passphrase
# export BACKUP_ENCRYPTION_KEY=...        # fed on stdin, never argv
```

`BACKUP_DIR` must be writable by the backup account and **outside the
repository**. A useful inventory command is:

```bash
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.gpg' -o -name '*.verified' -o -name '*.manifest.json' -o -name '*.sha256' \) -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort
```

A valid logical backup is a **complete group**: data file, manifest, checksum
and `.verified` marker. A `.sealed` marker is recipient-only and is not
automatically selected by the drill. Do not treat a bare `.dump` as a backup.

## 4. Scheduled backup and weekly drill

Choose **one** scheduler per host. Both examples write the same log path.

### Cron

```cron
# /etc/cron.d/isp-backup — daily verified dump at 02:17
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 2 * * * root cd /opt/isp && mkdir -p /var/lock && flock -n /var/lock/isp-backup.lock bash -lc 'cd /opt/isp && bash scripts/backup.sh' >> /var/log/isp-backup.log 2>&1
```

`flock -n` makes an overlapping run exit without starting a second dump. The
backup script also has its own `mkdir` lock, so either protection is safe.

### systemd timer

```ini
# /etc/systemd/system/isp-backup.service
[Unit]
Description=Inventory ERP verified PostgreSQL backup
Wants=network-online.target
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=postgres
WorkingDirectory=/opt/isp
EnvironmentFile=/opt/isp/.env
ExecStart=/usr/bin/flock -n /run/lock/isp-backup.lock /bin/bash /opt/isp/scripts/backup.sh
StandardOutput=append:/var/log/isp-backup.log
StandardError=append:/var/log/isp-backup.log
```

```ini
# /etc/systemd/system/isp-backup.timer
[Unit]
Description=Run the Inventory ERP backup daily at 02:17

[Timer]
OnCalendar=*-*-* 02:17
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now isp-backup.timer
systemctl list-timers isp-backup.timer
```

### Weekly restore drill timer

The drill needs `CREATE DATABASE` (or `DRILL_ADMIN_URL`) and the PostgreSQL
client tools. It drops its scratch database on every normal and signal exit.

```ini
# /etc/systemd/system/isp-drill.service
[Unit]
Description=Inventory ERP disposable restore drill
After=postgresql.service

[Service]
Type=oneshot
User=postgres
WorkingDirectory=/opt/isp
EnvironmentFile=/opt/isp/.env
ExecStart=/usr/bin/node /opt/isp/scripts/check_restore_drill.mjs --json
StandardOutput=append:/var/log/isp-drill.log
StandardError=append:/var/log/isp-drill.log
```

```ini
# /etc/systemd/system/isp-drill.timer
[Unit]
Description=Run the Inventory ERP restore drill weekly

[Timer]
OnCalendar=Sun *-*-* 03:17
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now isp-drill.timer
systemctl list-timers isp-drill.timer
```

A drill exit code of `0` is a pass, `1` is a failed check (for example a table or
ledger mismatch), and `2` is a preflight/setup failure (missing tools, key,
database or permission). Any non-zero drill result is an incident until it is
explained and logged.

## 5. WAL archiving and point-in-time recovery

This section is **not provisioned on this deployment**. Choose one of the two
supported patterns and complete its checklist before claiming **RPO ≤ 15 min**.

### Option A — pgBackRest (reference choice)

PostgreSQL settings:

```conf
# postgresql.conf
archive_mode = on
wal_level = replica
archive_timeout = 60
archive_command = 'pgbackrest --stanza=inventory archive-push %p'
```

```ini
# /etc/pgbackrest/pgbackrest.conf
[inventory]
pg1-path=/var/lib/postgresql/16/main
repo1-path=/mnt/offhost/pgbackrest
repo1-retention-full=30
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<from-the-key-custodian>
```

```bash
# Create the stanza, prove it, and take the first full backup.
sudo -u postgres pgbackrest --stanza=inventory stanza-create
sudo -u postgres pgbackrest --stanza=inventory check
sudo -u postgres pgbackrest --stanza=inventory --type=full backup
# Schedule full weekly and differential daily, then expire old repositories:
sudo -u postgres pgbackrest --stanza=inventory --type=diff backup
sudo -u postgres pgbackrest --stanza=inventory expire
```

`repo1-path` must be on a different host, mount or object store. Keep
`repo1-retention-full` at 30 unless the Data Owner approves a different
retention; the cipher passphrase belongs in the Key Custodian's offline store.

### Option B — WAL-G

```bash
export WALG_S3_PREFIX='s3://<bucket>/inventory'
export AWS_REGION='<region>'
export WALG_COMPRESSION_METHOD=lz4
# Credentials come from the host's instance role or a protected environment;
# never put them in this repository.
```

```conf
# postgresql.conf
archive_mode = on
wal_level = replica
archive_timeout = 60
archive_command = 'wal-g wal-push %p'
restore_command = 'wal-g wal-fetch %f %p'
```

```bash
export PGDATA=/var/lib/postgresql/16/main
wal-g backup-push "$PGDATA"
wal-g delete retain FULL 30 --confirm
```

Keep the bucket versioned/locked and off the database host. The same
`repo1-retention-full` equivalent is the `FULL 30` retention above.

### Archiver health

Run this on the primary after either option is live:

```sql
SELECT archived_count,
       last_archived_wal,
       last_archived_time,
       failed_count,
       last_failed_wal,
       last_failed_time
FROM pg_stat_archiver;
```

Alert on `failed_count > 0`, a rise in `failed_count`, or `last_archived_time`
older than 15 minutes while the primary is accepting writes. A configured but
failing archive is still a 24-hour RPO. The `pg_stat_archiver` row is
cumulative; compare successive samples rather than treating a historical failure
as permanently healthy or permanently fatal.

## 6. Restore decision tree and procedures

### First: preserve the failed cluster

Never restore over a running or failed cluster. Stop it and rename its data
directory so the failed evidence remains available:

```bash
export PGDATA=/var/lib/postgresql/16/main
pg_ctl stop -D "$PGDATA" -m fast
mv "$PGDATA" "${PGDATA}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
```

If the host is still serving, prefer a **fresh verified backup** and a
**safety dump** before any overwrite. If the database is unreachable, use the
newest complete `.verified` group.

### A. Logical restore into a scratch database

Use this to prove a dump on the host without touching production:

```bash
export BACKUP_DIR=/var/backups/isp
DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.gpg' \) -print | sort | tail -1)"
dropdb --if-exists -h localhost -U inventory_user inventory_restore_check
createdb -h localhost -U inventory_user inventory_restore_check
bash scripts/restore.sh "$DUMP" --target inventory_restore_check --yes --force
```

For a non-empty scratch target, `--force` resets its `public` schema; the script
refuses a non-empty target without it. It never creates or drops a database, so
drop the scratch database manually after verification.

The automated version is:

```bash
npm run check:restore-drill
# or: node scripts/check_restore_drill.mjs --backup "$DUMP" --json
```

It creates and drops `inventory_drill_<UTC>`, restores, compares every manifest
table, and checks the ledger. `--keep-scratch` is for debugging only; a CI run
must not leave the scratch database behind.

### B. Full logical restore of production

Only after the IC and Restore Approver authorize it:

```bash
export BACKUP_DIR=/var/backups/isp
DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.gpg' \) -print | sort | tail -1)"
RESTORE_CONFIRM_TARGET=inventory_db \
  bash scripts/restore.sh "$DUMP" --target inventory_db --yes --force --safety-dump
```

The `--yes` flag is required because the target is the configured production
database; `--force` is required because it is non-empty. Without
`RESTORE_CONFIRM_TARGET`, the script prompts on a terminal for the target name.
The command refuses before connecting if the confirmation does not match. It
validates the checksum, `pg_restore --list`, decrypts to a `0600` temp file when
needed, and verifies table counts and GL after the restore.

For an encrypted dump, the Key Custodian supplies either the GPG keyring or:

```bash
export BACKUP_PASSPHRASE_FILE=/etc/isp/backup.passphrase
# or: export BACKUP_ENCRYPTION_KEY=...   # stdin only, never argv
```

### C. Point-in-time recovery (PITR)

PITR requires the WAL repository from §5 and a base backup. The exact
`restore_command` depends on the chosen tool:

```bash
export PGDATA=/var/lib/postgresql/16/main
# The cluster has already been stopped and renamed per "First" above.

# pgBackRest:
pgbackrest --stanza=inventory --delta restore

# OR WAL-G:
# wal-g backup-fetch "$PGDATA" LATEST
```

Choose a recovery point in Nepal time or UTC and record it in the incident log:

```bash
cat >> "$PGDATA/postgresql.auto.conf" <<'EOF'
restore_command = 'pgbackrest --stanza=inventory archive-get %f %p'
recovery_target_time = '2026-11-16 12:00:00+05:45'
recovery_target_action = 'promote'
EOF

# WAL-G alternative:
# restore_command = 'wal-g wal-fetch %f %p'

touch "$PGDATA/recovery.signal"
pg_ctl start -D "$PGDATA"
tail -f "$PGDATA/log/postgresql.log"
```

PostgreSQL promotes at the target and the `recovery.signal` is consumed. Verify
the chosen timestamp, `pg_stat_archiver`, and the application before removing
the old cluster. Never delete `${PGDATA}.failed-*` until the Data Owner signs
off.

## 7. Verification after any restore

The drill is a preflight, not the final production acceptance. Against the
restored database (or the restored copy), run all of these and paste the output
into the incident log:

```bash
# 1. Shared ledger assertions: debit = credit, zero imbalances, net 0.00.
psql "$DATABASE_URL" -f scripts/restore_checks.sql

# 2. Application integrity checks.
npm run integrity:check

# 3. Real application smoke test against the running restored server.
npm run smoke
```

Also read the trial balance through the application and have the Data Owner
compare the control totals and branch balances to the last accepted close.
`npm run check:restore-drill` passing against the backup is necessary but not
sufficient: it proves the artifact restores, not that production is serving the
right data.

Record the wall-clock start and end for each restore in the monthly rehearsal
log. The measured 2026-11-16 drill time (22.5 s) is the baseline for the
database step; the **RTO ≤ 2 h** target covers the full incident.

## 8. Monitoring, alerts and rehearsal log

| Signal | Threshold | Action |
|---|---|---|
| Newest verified backup age | > **26 h** | Page the Database Operator; run `bash scripts/backup.sh`; if it fails, declare a backup incident. |
| Restore drill | Any non-zero exit (`1` check, `2` preflight) | Open an incident; inspect `/var/log/isp-drill.log`; do not mark the site protected until a green drill. |
| WAL archiver | `failed_count` rises or `last_archived_time` older than 15 min | Page the Database Operator; RPO is not ≤ 15 min until fixed. |
| Backup disk | > **80%** used | Free space or move `BACKUP_DIR`; never delete the last complete group. |
| Off-host copy | Missing or not writable | Treat as total-loss risk; restore the mount before the next backup window. |

Useful checks:

```bash
# No output means the newest verified marker is older than 26 hours.
find "$BACKUP_DIR" -maxdepth 1 -name '*.verified' -mmin +1560 -print

# Disk percentage on the backup filesystem.
df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $5, $6}'

# The weekly drill result (last line of the log).
tail -n 5 /var/log/isp-drill.log

# Archive failures; alert on a rising failed_count or a stale timestamp.
psql "$DATABASE_URL" -c "SELECT archived_count, failed_count, last_archived_time, last_failed_time FROM pg_stat_archiver;"
```

Wire these checks to the operator's monitoring system. This repository does not
provision alert delivery, so a green dashboard must not be assumed.

### Monthly restore rehearsal log

Copy this template into the operations log for every rehearsal:

| Field | Value |
|---|---|
| Rehearsal date (UTC) | |
| Backup artifact / manifest | |
| Drill result and elapsed time | |
| Restore target | |
| `restore_checks.sql` result | |
| `npm run integrity:check` result | |
| `npm run smoke` result | |
| Data Owner sign-off | |
| End-to-end RTO | |
| Follow-up actions | |

## 9. Escalation quick reference

1. **Suspected incident:** notify the IC; preserve logs and the failed cluster.
2. **Backup/drill failure:** Database Operator checks `BACKUP_DIR`, tools,
   `BACKUP_VERIFY_MAX_AGE_HOURS`, key availability and disk space.
3. **Data loss:** IC + Data Owner + Restore Approver; choose the newest
   verified dump or PITR point; Key Custodian releases the key.
4. **Production restore:** two-person authorization, `restore.sh --yes --force
   --safety-dump`, then §7 checks and Data Owner sign-off.
5. **Recovery declared:** only after §7 passes, the app smoke test succeeds and
   the incident log records the measured RTO.

## 10. What is deliberately not provisioned

- No off-host backup destination, cron/systemd unit, weekly timer, WAL archive,
  alert route or key store is installed by this repository.
- No production restore is authorized by a green test or a passing drill. The
  role table in §2 is the authority; the scripts enforce only their local
  confirmation flags.
- WAL archiving is documented, not implemented. Until it is live and monitored,
  the honest RPO is **24 h**, not the 15-minute target.
