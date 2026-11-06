/**
 * Permission-matrix seed migration.
 *
 * The finance split replaced two broad grants with dedicated operations. A
 * fresh database takes the new defaults, but an existing tenant may have
 * customized the old grants. These mappings preserve those choices when the
 * new operation row is first inserted; `ON CONFLICT DO NOTHING` in dbBoot keeps
 * later edits authoritative.
 *
 * `assets-view` is deliberately not mapped: asset reads were ungated before the
 * split, so it keeps the new read default instead of inheriting `assets-manage`
 * (which would deny AUDITOR the new read-only view).
 */
export const FINANCE_PERMISSION_INHERITANCE: Readonly<Record<string, string>> = {
  'gl-chart-manage': 'gl-manage',
  'gl-subledger-manage': 'gl-manage',
  'gl-dimension-manage': 'gl-manage',
  'gl-bill-terms-manage': 'gl-manage',
  'gl-payroll-manage': 'gl-manage',
  'gl-payroll-post': 'gl-post',
  'gl-cash-close': 'gl-post',
  'gl-opening-post': 'gl-post',
  'fin-depreciation-post': 'fin-statements',
};

export interface PermissionSeedRow {
  operationId: string;
  role: string;
  allowed: boolean;
}

/**
 * Build the rows dbBoot inserts into `permission_matrix`.
 *
 * Every default matrix entry is emitted. When an operation is new and its
 * legacy grant exists in the table, the legacy value wins over the new
 * default; a missing legacy row falls back to the default. Existing rows for
 * the new operation are left to the INSERT's `ON CONFLICT DO NOTHING`, so the
 * migration never rewrites a later customization.
 */
export function buildPermissionSeedEntries(
  matrix: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
  existingRows: readonly PermissionSeedRow[] = []
): Array<[string, string, boolean]> {
  const rowKey = (operationId: string, role: string) => `${operationId}\u0000${role}`;
  const existing = new Map<string, boolean>();
  for (const row of existingRows) {
    existing.set(rowKey(row.operationId, row.role), row.allowed);
  }

  const entries: Array<[string, string, boolean]> = [];
  for (const [operationId, roles] of Object.entries(matrix)) {
    for (const [role, fallback] of Object.entries(roles)) {
      const legacyOperation = FINANCE_PERMISSION_INHERITANCE[operationId];
      const inherited =
        legacyOperation === undefined
          ? undefined
          : existing.get(rowKey(legacyOperation, role));
      entries.push([operationId, role, inherited ?? fallback]);
    }
  }
  return entries;
}
