export const APP_ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  INVENTORY_MANAGER: 'Inventory Manager',
  BRANCH_MANAGER: 'Branch Manager',
  FRONT_DESK: 'Front Desk',
  ACCOUNTANT: 'Accountant',
  HEAD_OFFICE_ADMIN: 'Sub Super Admin',
  HR_SELF_SERVICE: 'HR Self Service',
  HR_MANAGER: 'HR Manager',
  HR_OFFICER: 'HR Officer',
  PROCUREMENT_OFFICER: 'Procurement Officer',
  FIELD_TECHNICIAN: 'Field Technician',
  AUDITOR: 'Auditor',
};

export const APP_ROLES = [
  'SUPER_ADMIN',
  'INVENTORY_MANAGER',
  'BRANCH_MANAGER',
  'FRONT_DESK',
  'ACCOUNTANT',
  'HEAD_OFFICE_ADMIN',
  'HR_SELF_SERVICE',
  'HR_MANAGER',
  'HR_OFFICER',
  'PROCUREMENT_OFFICER',
  'FIELD_TECHNICIAN',
  'AUDITOR',
] as const;

export const DEFAULT_PERMISSIONS_MATRIX: Record<string, Record<string, boolean>> = {
  'po-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'po-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'branch-procurement-control': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'inv-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'inv-pay': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'po-delete': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'inv-delete': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'purchase-return-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'sales-invoice-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'sales-return-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },

  'shipment-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'wh-receive-pullouts': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'wh-restrict-transfer': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'shipment-history': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: true },

  'branch-transfer-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'branch-transfer-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'branch-transfer-cancel-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Cancel an in-transit dispatch before receipt: creator-parity with
  // shipment-create (the roles that may dispatch may cancel their own),
  // gated server-side on POST /api/shipments/:id/cancel.
  'shipment-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'branch-transfer-request-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'branch-pullout-dispatch': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: false },
  'pullout-report-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: true },
  'branch-damage-mark': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'stock-disposal-writeoff': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'stock-out': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: false },
  'consumable-issue-reverse': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Custody reads: the technician's own van stock and the employee profile's
  // Equipment section both read the same ledger. Moving units in or out stays
  // on the two inventory controls above, so a read grant never implies a write.
  'employee-stock-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: true, AUDITOR: true },
  // Writing a unit off against a person is a manager's decision. The holder
  // reports a loss (`employee-stock-view`); this is what executes the write-off.
  'custody-writeoff': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Deploying stock is its own authority: taking a shelf unit to a technician's
  // custody, a POP, a customer or a write-off. `assets-manage` may still
  // register a ledger asset and `employee-stock-view` may still read custody
  // without either one moving a unit, so this is the one cell the shelf gates
  // consult. Only the dispatch/manager roles the custody flow names hold it:
  // the van is stocked by dispatch, never by the person carrying the unit.
  // ACCOUNTANT is deliberately false — finance owns the register, not the
  // shelf. That is a product decision (do not grant a deploy by guesswork); it
  // is a one-line flip here if finance genuinely needs to deploy.
  'stock-deploy': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },

  'prod-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: true },
  'prod-edit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'uom-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'edit-device-serials': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'category-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'product-group-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // WTY-1: read the two warranty registers, and correct a stored expiry. The
  // read is open to every role; editing a contractual date is manager-only.
  'warranty-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: true },
  'warranty-edit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'stock-import-export': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'opening-stock-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'opening-stock-edit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },

  // Read the asset register separately from capitalising/disposing an asset.
  'assets-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'assets-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'fin-statements': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'fin-depreciation-post': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'vat-register': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'stock-valuation': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  // Accounting ledger: reading is open to finance/audit roles; posting and
  // chart/period maintenance belong to Accountant and Head Office.
  'gl-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'gl-post': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Reversal is a separate accounting control: a role may post journals
  // without being allowed to reverse a posted voucher.
  'gl-reverse': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Finance masters are separate controls: chart maintenance, subledger books,
  // analytical dimensions and bill terms no longer travel as one broad grant.
  'gl-chart-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-subledger-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-dimension-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-bill-terms-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-payroll-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-payroll-post': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-cash-close': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-opening-post': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'gl-close': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },

  // HR master: reading PII and changing the employee record are separate from
  // payroll posting. `gl-payroll-manage` remains accepted as a legacy alias on
  // the employee routes until every payroll manager has the hr-* grants.
  'hr-employee-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'hr-employee-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Attendance is a separate write control from the employee master: a branch
  // HR officer may read the register but not change a shift, holiday or day.
  'hr-attendance-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // Employee self-service is the one HR grant every role holds by default: it
  // reads only the employee linked to the signed-in account. A per-user
  // override can deny it without touching the employee-master grants.
  'hr-self-service': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: true },

  'suppliers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'customers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: false },
  'field-work-order': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: true, AUDITOR: false },

  'auth-switch-user': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'workflow-approval': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'workflow-approval-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-users': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-branches': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-audit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'admin-fiscal': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  // API creator control (Round 14 Part C): issue, rotate and revoke partner API
  // keys. Only the two administrative roles hold it by default; a role, permission
  // set or personal grant can widen it deliberately.
  'admin-api-keys': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
};

// HR roles join an existing catalogue without rewriting every operation row.
// They default to denied everywhere, then receive only the HR-master grants:
// managers can read PII and maintain the master; officers can read the masked
// master. The explicit keys keep the seed, UI columns and API resolver aligned.
for (const permissions of Object.values(DEFAULT_PERMISSIONS_MATRIX)) {
  permissions.HR_MANAGER = false;
  permissions.HR_OFFICER = false;
}
DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].HR_MANAGER = true;
DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].HR_OFFICER = true;
DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'].HR_MANAGER = true;
DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].HR_MANAGER = true;
// Self-service is every role's own-record read, including both HR roles.
DEFAULT_PERMISSIONS_MATRIX['hr-self-service'].HR_MANAGER = true;
DEFAULT_PERMISSIONS_MATRIX['hr-self-service'].HR_OFFICER = true;

// The one role that exists to view its own HR record and nothing else. Every
// operation enumerates every role (the seed migration writes one row per pair),
// so the new role is filled in as `false` everywhere and opened only on the
// self-service operations.
for (const operationRow of Object.values(DEFAULT_PERMISSIONS_MATRIX)) {
  for (const role of APP_ROLES) {
    if (!(role in operationRow)) operationRow[role] = false;
  }
}
for (const [operationId, operationRow] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
  if (operationId === 'hr-self-service' || operationId.startsWith('hr-self-')) {
    operationRow.HR_SELF_SERVICE = true;
  }
}
