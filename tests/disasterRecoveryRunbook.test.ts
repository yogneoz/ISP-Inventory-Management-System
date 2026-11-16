/**
 * BAK-5 — the disaster-recovery runbook is an operator deliverable, so this
 * guard pins the promises an operator (and an audit) relies on: the honest
 * dump-only RPO, the WAL-gated 15-minute target, the measured RTO evidence,
 * exact schedules, both WAL options, restore/PITR steps, post-restore checks,
 * monitoring thresholds and the explicit not-provisioned gaps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RUNBOOK = path.join(ROOT, 'docs', 'disaster-recovery-runbook.md');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('BAK-5 disaster-recovery runbook', () => {
  const doc = fs.readFileSync(RUNBOOK, 'utf8');

  test('states the honest dump-only RPO, the WAL target and the measured RTO evidence', () => {
    assert.match(doc, /dump-only installation has \*\*RPO = 24 h\*\*/);
    assert.match(doc, /\*\*RPO ≤ 15 min only once WAL archiving is live\*\*/);
    assert.match(doc, /\*\*RTO ≤ 2 h\*\*/);
    assert.match(doc, /\*\*22\.5 s\*\*/);
    assert.match(doc, /119\/119 parent tables/);
    assert.match(doc, /GL debit = credit = 400,113\.00/);
  });

  test('names the roles, declaration authority and production restore approval', () => {
    for (const role of ['Incident Commander', 'Database Operator', 'Data Owner', 'Key Custodian', 'Restore Approver']) {
      assert.match(doc, new RegExp(role));
    }
    assert.match(doc, /declares `SEV-1`/i);
    assert.match(doc, /two people/);
    assert.match(doc, /key is never stored beside `BACKUP_DIR`/);
    assert.match(doc, /authorizes a restore over production/i);
  });

  test('contains the exact daily and weekly schedules and log paths', () => {
    for (const required of [
      '17 2 * * *',
      'flock -n',
      '/var/log/isp-backup.log',
      'OnCalendar=*-*-* 02:17',
      'Persistent=true',
      'RandomizedDelaySec=10m',
      'isp-backup.timer',
      'isp-drill.timer',
      'OnCalendar=Sun *-*-* 03:17',
      '/var/log/isp-drill.log',
    ]) {
      assert.ok(doc.includes(required), `runbook is missing ${required}`);
    }
  });

  test('documents both WAL archive options and the archiver alert', () => {
    for (const required of [
      'archive_mode = on',
      'wal_level = replica',
      'archive_command',
      'repo1-retention-full',
      'repo1-cipher-type',
      'WALG_S3_PREFIX',
      'wal-push',
      'wal-fetch',
      'pg_stat_archiver',
      'failed_count',
    ]) {
      assert.ok(doc.includes(required), `runbook is missing ${required}`);
    }
    assert.match(doc, /not provisioned on this deployment/i);
  });

  test('covers logical, scratch and PITR restores without restoring over the failed cluster', () => {
    for (const required of [
      'bash scripts/restore.sh',
      'npm run check:restore-drill',
      'restore_command',
      'recovery_target_time',
      'PGDATA',
      'mv "$PGDATA"',
      'createdb',
      '--safety-dump',
      'Never restore over a running or failed cluster',
    ]) {
      assert.ok(doc.includes(required), `runbook is missing ${required}`);
    }
  });

  test('requires the post-restore ledger, integrity and smoke checks', () => {
    for (const required of [
      'scripts/restore_checks.sql',
      'npm run integrity:check',
      'npm run smoke',
      'debit = credit',
      'net 0.00',
      'Data Owner',
    ]) {
      assert.ok(doc.includes(required), `runbook is missing ${required}`);
    }
    assert.match(doc, /drill is a preflight, not the final production acceptance/);
  });

  test('defines monitoring thresholds and the monthly rehearsal log', () => {
    for (const required of ['26 h', '80%', 'failed_count', 'RTO']) {
      assert.ok(doc.includes(required), `runbook is missing ${required}`);
    }
    assert.match(doc, /monthly restore rehearsal log/i);
    assert.match(doc, /This repository does not\s+provision alert delivery/);
  });

  test('is linked from the operator docs and replaces the ad-hoc update commands', () => {
    assert.ok(fs.existsSync(RUNBOOK));
    assert.match(read('README.md'), /docs\/disaster-recovery-runbook\.md/);
    assert.match(read('docs/README.md'), /disaster-recovery-runbook\.md/);

    const update = read('UPDATEPROCESS.md');
    assert.match(update, /bash scripts\/backup\.sh/);
    assert.match(update, /docs\/disaster-recovery-runbook\.md/);
    assert.doesNotMatch(update, /pg_dump -U inventory_user/);
    assert.doesNotMatch(update, /pre_update_backup\.sql/);
  });
});
