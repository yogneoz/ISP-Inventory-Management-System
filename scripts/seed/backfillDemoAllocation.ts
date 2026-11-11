/**
 * Apply the demo cost-centre tags and branch allocation profiles to an existing
 * database without wiping or reseeding it. Both operations are idempotent:
 * existing non-null tags are preserved and branches with an allocation profile
 * are skipped. Fresh `npm run seed:verify` databases receive the same data
 * through the seed path.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { backfillDemoCostCenterTags } from './applyVerificationSeed';
import {
  applyDemoAllocationFixtures,
  buildDemoFinanceFixtures,
} from './demoFinanceFixtures';
import { buildVerificationDataset } from './verificationDataset';

dotenv.config({ quiet: true } as any);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const tags = await backfillDemoCostCenterTags(client);
  const fixtures = buildDemoFinanceFixtures(buildVerificationDataset());
  const allocations = await applyDemoAllocationFixtures(client, fixtures);
  await client.query('COMMIT');
  console.log(JSON.stringify({ demoCostCenterTags: tags, ...allocations }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
