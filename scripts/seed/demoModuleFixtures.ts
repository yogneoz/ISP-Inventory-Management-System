/**
 * Canonical demo module fixture entry point.
 *
 * `npm run seed:verify` calls this after the verified accounting dataset is in
 * place. Keeping module fixtures separate from applyVerificationSeed means
 * focused tests and setup helpers can seed the core ledger without inheriting
 * demo HR/operations history, while the canonical reset always populates every
 * exposed module.
 */
import type { VerificationDataset } from './verificationDataset';
import { applyDemoFinanceFixtures, buildDemoFinanceFixtures } from './demoFinanceFixtures';
import { applyDemoOperationsFixtures, buildDemoOperationsFixtures } from './demoOperationsFixtures';
import { applyDemoHrFixtures, buildDemoHrFixtures } from './demoHrFixtures';
import { applyDemoPermissionFixtures, buildDemoPermissionFixtures } from './demoPermissionFixtures';

export interface DemoModuleFixtures {
  finance: ReturnType<typeof buildDemoFinanceFixtures>;
  operations: ReturnType<typeof buildDemoOperationsFixtures>;
  hr: ReturnType<typeof buildDemoHrFixtures>;
  permissions: ReturnType<typeof buildDemoPermissionFixtures>;
}

export function buildDemoModuleFixtures(dataset: VerificationDataset): DemoModuleFixtures {
  return {
    finance: buildDemoFinanceFixtures(dataset),
    operations: buildDemoOperationsFixtures(dataset),
    hr: buildDemoHrFixtures(dataset),
    permissions: buildDemoPermissionFixtures(),
  };
}

export async function applyDemoModuleFixtures(
  client: any,
  dataset: VerificationDataset
): Promise<Record<string, number>> {
  return {
    ...(await applyDemoFinanceFixtures(client, dataset)),
    ...(await applyDemoOperationsFixtures(client, dataset)),
    ...(await applyDemoHrFixtures(client, dataset)),
    ...(await applyDemoPermissionFixtures(client)),
  };
}
