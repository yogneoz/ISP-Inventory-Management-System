export const APP_ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  INVENTORY_MANAGER: 'Inventory Manager',
  BRANCH_MANAGER: 'Branch Manager',
  FRONT_DESK: 'Front Desk',
  ACCOUNTANT: 'Accountant',
  HEAD_OFFICE_ADMIN: 'Head Office Admin',
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
  'branch-asset-assign': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'stock-out': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: false },
  'consumable-issue-reverse': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },

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

  'assets-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'fin-statements': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'vat-register': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'stock-valuation': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },

  'suppliers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
  'customers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: true, FIELD_TECHNICIAN: true, AUDITOR: false },

  'auth-switch-user': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'workflow-approval': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'workflow-approval-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-users': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-branches': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
  'admin-audit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: true },
  'admin-fiscal': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true, HEAD_OFFICE_ADMIN: true, PROCUREMENT_OFFICER: false, FIELD_TECHNICIAN: false, AUDITOR: false },
};
