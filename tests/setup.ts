/**
 * Global Vitest setup — force offline-friendly backends so tests never
 * depend on a live Postgres or Redis instance.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'izone-test-'));
process.env.NODE_ENV = 'test';
process.env.DISABLE_PG_MEM = 'true';
process.env.SEED_DUMMY_DATA = 'false';
process.env.DATA_STORE_PATH = path.join(testDir, '.data_store.json');
// Ensure no accidental Redis/PG from developer env
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;
delete process.env.DATABASE_URL;
