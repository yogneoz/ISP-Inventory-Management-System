import { initDatabaseConnection } from '../server/lib/db.ts';
import { runMigrations } from '../server/lib/migrations.ts';

const mode = await initDatabaseConnection();
console.log('DB mode:', mode);
const result = await runMigrations();
console.log(JSON.stringify(result, null, 2));
if (result.skipped) {
  console.log('Migrations skipped (no durable Postgres).');
  process.exit(0);
}
process.exit(0);
