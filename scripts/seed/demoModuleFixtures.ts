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
import { applyDemoWorkplaceFixtures, buildDemoWorkplaceFixtures } from './demoWorkplaceFixtures';
import { applyDemoIntegrationFixtures, buildDemoIntegrationFixtures } from './demoIntegrationFixtures';
import { applyDemoRegisterFixtures, buildDemoRegisterFixtures } from './demoRegisterFixtures';
import { applyDemoSelfServiceFixtures, buildDemoSelfServiceFixtures } from './demoSelfServiceFixtures';
import { applyDemoCoverageFixtures, buildDemoCoverageFixtures } from './demoCoverageFixtures';

export interface DemoModuleFixtures {
  finance: ReturnType<typeof buildDemoFinanceFixtures>;
  operations: ReturnType<typeof buildDemoOperationsFixtures>;
  hr: ReturnType<typeof buildDemoHrFixtures>;
  permissions: ReturnType<typeof buildDemoPermissionFixtures>;
  workplace: ReturnType<typeof buildDemoWorkplaceFixtures>;
  integration: ReturnType<typeof buildDemoIntegrationFixtures>;
  registers: ReturnType<typeof buildDemoRegisterFixtures>;
  selfService: ReturnType<typeof buildDemoSelfServiceFixtures>;
  coverage: ReturnType<typeof buildDemoCoverageFixtures>;
}

export function buildDemoModuleFixtures(dataset: VerificationDataset): DemoModuleFixtures {
  return {
    finance: buildDemoFinanceFixtures(dataset),
    operations: buildDemoOperationsFixtures(dataset),
    hr: buildDemoHrFixtures(dataset),
    permissions: buildDemoPermissionFixtures(),
    workplace: buildDemoWorkplaceFixtures(dataset),
    integration: buildDemoIntegrationFixtures(),
    registers: buildDemoRegisterFixtures(dataset),
    selfService: buildDemoSelfServiceFixtures(dataset),
    coverage: buildDemoCoverageFixtures(dataset),
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
    ...(await applyDemoWorkplaceFixtures(client, dataset)),
    ...(await applyDemoIntegrationFixtures(client)),
    ...(await applyDemoRegisterFixtures(client, dataset)),
    ...(await applyDemoSelfServiceFixtures(client, dataset)),
    ...(await applyDemoCoverageFixtures(client, dataset)),
  };
}
