# API-key operation inventory (permission matrix → routes)

Generated from `client/src/features/settings/permissionGroups.ts` (the catalogue the
role matrix and per-user editor render) and `server/src/routes/*.ts` (the routes that
actually call `requirePermission(...)`). "Access" is what the code enforces today,
not what the label suggests: **Read** = only `GET` routes use the operation,
**Write** = only mutating verbs, **Read-write** = both, **ungated** = no route uses it
(the screen or action is not wired, or the guard is role-based instead).

The API creator control `admin-api-keys` is granted by default to `SUPER_ADMIN` and `HEAD_OFFICE_ADMIN` (labelled **Sub Super Admin**) only.

Roles in `DEFAULT_PERMISSIONS_MATRIX`: .

## Procurement & Purchasing

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Create Purchase Orders (PO) | `po-create` | GET /api/purchase-orders/:id/print, PATCH /api/purchase-orders/:id/status, POST /api/purchase-orders, PUT /api/purchase-orders/:id | Read-write |
| Receive Inbound PO Stock | `po-receive` | PATCH /api/purchase-orders/:id/status | Write |
| Branch Procurement Permission Control | `branch-procurement-control` | — | ungated |
| Record Purchase Tax Invoices | `inv-create` | GET /api/purchase-invoices/:id/print, POST /api/purchase-invoices | Read-write |
| Process Vendor Payment Settlements | `inv-pay` | GET /api/vendors/:supplierId/ledger, POST /api/purchase-invoices/:id/pay, POST /api/purchase-invoices/:id/reverse-payments, POST /api/vendor-payments, POST /api/vendor-payments/:id/reverse | Read-write |
| Create Purchase Returns | `purchase-return-create` | POST /api/purchase-returns, POST /api/purchase-returns/:id/cancel, POST /api/purchase-returns/:id/post | Write |
| Delete Purchase Orders (PO) | `po-delete` | DELETE /api/purchase-orders/:id | Write |
| Delete Purchase Invoices (PI) | `inv-delete` | — | ungated |

## Warehouse Logistics & Dispatch

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Create Warehouse Shipment Dispatch | `shipment-create` | POST /api/shipments | Write |
| Cancel Outbound Shipment | `shipment-cancel` | POST /api/shipments/:id/cancel | Write |
| Receive Branch Stock Pullouts | `wh-receive-pullouts` | POST /api/shipments/:id/receive, POST /api/stock-operations/:id/receive | Write |
| Warehouse Transfer Restriction Rule | `wh-restrict-transfer` | — | ungated |
| View Shipment & Dispatch History | `shipment-history` | — | ungated |
| View Warehouse Pullout Report | `pullout-report-view` | — | ungated |

## Sales & Branch Operations

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Create Sales Invoices | `sales-invoice-create` | GET /api/sales-invoices/:id/print, POST /api/customer-payments, POST /api/customer-payments/:id/chargeback, POST /api/customer-payments/:id/refund, POST /api/customer-payments/:id/reverse, POST /api/sales-invoices, POST /api/sales-invoices/:id/cancel | Read-write |
| Create Sales Returns | `sales-return-create` | POST /api/sales-returns, POST /api/sales-returns/:id/cancel, POST /api/sales-returns/:id/post | Write |
| Create Inter-Branch Stock Transfer | `branch-transfer-create` | — | ungated |
| Receive Inter-Branch Stock Transfer | `branch-transfer-receive` | POST /api/shipments/:id/receive | Write |
| Cancel Received Branch Transfer | `branch-transfer-cancel-receive` | POST /api/shipments/:id/cancel-receive | Write |
| Request Transfer Dispatch Cancellation | `branch-transfer-request-cancel` | — | ungated |
| Dispatch Stock Pullout to HQ | `branch-pullout-dispatch` | POST /api/stock-operations/:id/reverse-pullout | Write |
| Label & Record Damaged Stock | `branch-damage-mark` | POST /api/stock-operations/:id/reverse | Write |
| Stock Disposal & Financial Write-Off | `stock-disposal-writeoff` | — | ungated |
| Stock Issues & Stock-Out Reversal | `stock-out` | POST /api/stock-operations/:id/reverse-stock-out | Write |
| Reverse Consumable Issue Record | `consumable-issue-reverse` | POST /api/stock-operations/:id/reverse-consumable | Write |
| Deploy Stock & CPE | `stock-deploy` | POST /api/assets (deployment targets), POST /api/employee-stock/audit, POST /api/employee-stock/install, POST /api/employee-stock/issue, POST /api/employee-stock/loss | Write |

## Inventory & Product Master

| Operation | id | Enforced on | Access |
|---|---|---|---|
| View Product Catalog & Branch Balances | `prod-view` | — | ungated |
| Create & Edit Products & SKUs | `prod-edit` | DELETE /api/products/:id, PATCH /api/stock/:id/reorder-level, POST /api/products, PUT /api/products/:id | Write |
| Manage Units of Measure (UOM) | `uom-manage` | DELETE /api/uom/:id, POST /api/uom, PUT /api/uom/:id | Write |
| Manage Categories & Subcategories | `category-manage` | DELETE /api/categories/:id, POST /api/categories, PUT /api/categories/:id | Write |
| Manage Product Groups | `product-group-manage` | DELETE /api/product-groups/:id, POST /api/product-groups, PUT /api/product-groups/:id | Write |
| View Suppliers & Sellers Warranty Registers | `warranty-view` | GET /api/warranties/seller, GET /api/warranties/vendor, GET /api/warranty-claims, GET /api/warranty-claims/:id, GET /api/warranty-claims/recovery | Read |
| Correct Warranty Dates | `warranty-edit` | PATCH /api/warranties/:id, PATCH /api/warranty-claims/:id/status, POST /api/warranty-claims | Write |
| Edit Device Serial Numbers (Serial/PON/MAC) | `edit-device-serials` | GET /api/inventory/serials/lookup, PATCH /api/inventory/serials, POST /api/inventory/serials/dual | Read-write |
| Import & Export Inventory Records | `stock-import-export` | — | ungated |
| View Fiscal Year Opening Register | `opening-stock-view` | — | ungated |
| Adjust Fiscal Year Opening Register | `opening-stock-edit` | PATCH /api/stock/:id | Write |

## Finance & Accounting

| Operation | id | Enforced on | Access |
|---|---|---|---|
| View Fixed Asset Register | `assets-view` | GET /api/fixed-assets/available, GET /api/fixed-assets/lookup, GET /api/fixed-assets/overview, GET /api/fixed-assets/page | Read |
| Manage Fixed Asset Register & Depreciation | `assets-manage` | GET /api/fixed-assets/available, GET /api/fixed-assets/lookup, PATCH /api/assets/:id/status, POST /api/assets | Read-write |
| Open Finance Dashboard | `fin-statements` | GET /api/reports/financial-summaries, GET /api/reports/financial-summary | Read |
| View VAT Tax Register | `vat-register` | — | ungated |
| Stock Valuation & Movement Ledger | `stock-valuation` | — | ungated |
| View Finance & Accounting Registers | `gl-view` | GET /api/accounting/accounts, GET /api/accounting/aging, GET /api/accounting/bank-position, GET /api/accounting/bank-reconciliation, GET /api/accounting/bill-terms, GET /api/accounting/budgets, GET /api/accounting/budgets/allocation, GET /api/accounting/budgets/export, GET /api/accounting/budgets/history, GET /api/accounting/budgets/history/:versionId, GET /api/accounting/budgets/variance, GET /api/accounting/budgets/variance/alerts, GET /api/accounting/budgets/variance/departments, GET /api/accounting/budgets/variance/lines, GET /api/accounting/budgets/variance/utilisation, GET /api/accounting/cash-book, GET /api/accounting/cash-close, GET /api/accounting/cash-close/consolidated, GET /api/accounting/chart-health, GET /api/accounting/cost-centers, GET /api/accounting/fiscal-years/:id/balances, GET /api/accounting/groups, GET /api/accounting/inventory-reconciliation, GET /api/accounting/journals, GET /api/accounting/journals/:id, GET /api/accounting/lenders, GET /api/accounting/lenders/:id/statement, GET /api/accounting/loans, GET /api/accounting/loans/:id, GET /api/accounting/narrations, GET /api/accounting/party-balances, GET /api/accounting/periods, GET /api/accounting/periods/:id/checklist, GET /api/accounting/posting-defaults, GET /api/accounting/reconciliations, GET /api/accounting/recurring-templates, GET /api/accounting/recurring-templates/:id, GET /api/accounting/recurring-templates/:id/preview, GET /api/accounting/statements/account-lines, GET /api/accounting/statements/balance-sheet, GET /api/accounting/statements/balance-sheet-movement, GET /api/accounting/statements/balance-sheet/print, GET /api/accounting/statements/branch-balance-sheet, GET /api/accounting/statements/branch-profit-and-loss, GET /api/accounting/statements/bs-summary, GET /api/accounting/statements/cash-flow, GET /api/accounting/statements/cash-flow/print, GET /api/accounting/statements/group-lines, GET /api/accounting/statements/profit-and-loss, GET /api/accounting/statements/profit-and-loss/print, GET /api/accounting/statements/trial-balance, GET /api/accounting/statements/trial-balance/print, GET /api/accounting/subledgers, GET /api/accounting/subledgers/:id/entries, GET /api/accounting/wallet-reconciliation, GET /api/employees/:id/ledger, GET /api/employees/search, GET /api/payroll-runs/postings | Read |
| Post Journal & Cash/Bank Vouchers | `gl-post` | DELETE /api/accounting/recurring-templates/:id, GET /api/employees/search, PATCH /api/accounting/recurring-templates/:id, POST /api/accounting/journals, POST /api/accounting/recurring-templates, POST /api/accounting/recurring-templates/:id/run | Read-write |
| Reverse Posted Vouchers | `gl-reverse` | POST /api/accounting/journals/:id/reverse | Write |
| Maintain Chart of Accounts & Posting Defaults | `gl-chart-manage` | DELETE /api/accounting/accounts/:id, DELETE /api/accounting/groups/:id, PATCH /api/accounting/accounts/:id, PATCH /api/accounting/groups/:id, POST /api/accounting/accounts, POST /api/accounting/budgets/copy, POST /api/accounting/budgets/history/:versionId/restore, POST /api/accounting/budgets/import, POST /api/accounting/budgets/lock, POST /api/accounting/chart-defaults, POST /api/accounting/groups, PUT /api/accounting/budgets, PUT /api/accounting/budgets/allocation | Write |
| Close & Reopen Accounting Periods | `gl-close` | PATCH /api/accounting/periods/:id/checklist/:itemId, POST /api/accounting/periods, POST /api/accounting/periods/:id/close, POST /api/accounting/periods/:id/reopen | Write |
| Post Fixed-Asset Depreciation | `fin-depreciation-post` | POST /api/fixed-assets/depreciation | Write |

## Finance Controls & Period-End

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Maintain Subledger Books | `gl-subledger-manage` | DELETE /api/accounting/lenders/:id, DELETE /api/accounting/subledgers/:id, PATCH /api/accounting/lenders/:id, PATCH /api/accounting/loans/:id, PATCH /api/accounting/subledgers/:id, POST /api/accounting/lenders, POST /api/accounting/loans, POST /api/accounting/subledgers, POST /api/accounting/subledgers/generate | Write |
| Maintain Cost Centres & Narrations | `gl-dimension-manage` | DELETE /api/accounting/cost-centers/:id, DELETE /api/accounting/narrations/:id, PATCH /api/accounting/cost-centers/:id, PATCH /api/accounting/narrations/:id, POST /api/accounting/cost-centers, POST /api/accounting/narrations | Write |
| Maintain Bill Terms | `gl-bill-terms-manage` | DELETE /api/accounting/bill-terms/:id, PATCH /api/accounting/bill-terms/:id, POST /api/accounting/bill-terms | Write |
| Maintain Employee Master (Legacy Gate) | `gl-payroll-manage` | GET /api/employees, GET /api/employees/:id, GET /api/employees/user-options, PATCH /api/employees/:id, POST /api/employees, POST /api/employees/:id/transfer | Read-write |
| Post & Pay Payroll Runs | `gl-payroll-post` | POST /api/payroll-runs, POST /api/payroll-runs/:id/approve, POST /api/payroll-runs/:id/pay, POST /api/payroll-runs/:id/post | Write |
| Close & Reopen Daily Cash Position | `gl-cash-close` | POST /api/accounting/bank-reconciliation/import, POST /api/accounting/bank-reconciliation/lines/:id/match, POST /api/accounting/bank-reconciliation/lines/:id/unmatch, POST /api/accounting/bank-reconciliation/sessions, POST /api/accounting/bank-reconciliation/sessions/:id/lock, POST /api/accounting/bank-reconciliation/sessions/:id/reopen, POST /api/accounting/cash-close, POST /api/accounting/cash-close/:id/reopen, POST /api/accounting/wallet-reconciliation/import, POST /api/accounting/wallet-reconciliation/lines/:id/match, POST /api/accounting/wallet-settlements | Write |
| Post Opening Balances | `gl-opening-post` | POST /api/accounting/opening-balances | Write |

## People & HR

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Read Employee Master & PII | `hr-employee-view` | GET /api/employees, GET /api/employees/:id | Read |
| Maintain Employee Master & Account Link | `hr-employee-manage` | GET /api/employees/user-options, PATCH /api/employees/:id, POST /api/employees, POST /api/employees/:id/transfer | Read-write |
| Maintain Attendance, Shifts, Holidays & Leave Types | `hr-attendance-manage` | — | ungated |
| Use Employee Self-Service | `hr-self-service` | — | ungated |

## Suppliers & Customers

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Manage Vendor Directory & PAN/VAT | `suppliers-manage` | — | ungated |
| Manage Customer Profiles & Limits | `customers-manage` | DELETE /api/customers/:id, DELETE /api/sales/agents/:id, DELETE /api/sales/areas/:id, GET /api/sales/agents, GET /api/sales/areas, PATCH /api/sales/agents/:id, PATCH /api/sales/areas/:id, POST /api/customer-devices, POST /api/customers, POST /api/sales/agents, POST /api/sales/areas, PUT /api/customers/:id | Read-write |

## System Administration & Security

| Operation | id | Enforced on | Access |
|---|---|---|---|
| Switch User Login / Session Profile | `auth-switch-user` | — | ungated |
| Process Workflow Approvals (Authorize/Reject) | `workflow-approval` | — | ungated |
| Cancel Workflow Approval Requests | `workflow-approval-cancel` | — | ungated |
| User Management & Role Assignment | `admin-users` | DELETE /api/users/:id, GET /api/auth/rate-limit, POST /api/auth/rate-limit/release, POST /api/users, POST /api/users/:id/reset-password, PUT /api/users/:id | Read-write |
| Branch Management & Branch Controls | `admin-branches` | DELETE /api/branches/:id, POST /api/branches, PUT /api/branches/:id | Write |
| View Audit Trail & Transaction Logs | `admin-audit` | GET /api/admin/performance, GET /api/audit-trail | Read |
| Nepali Fiscal Year Management | `admin-fiscal` | DELETE /api/fiscal-years/:id, GET /api/document-number-configs, PATCH /api/document-number-configs/:id, POST /api/document-number-configs, POST /api/document-number-configs/generate-next, POST /api/document-number-configs/reset-counter, POST /api/fiscal-years, PUT /api/document-number-configs | Read-write |
| API Key Management (Partner Integrations) | `admin-api-keys` | — (creator screen not built yet; added in this pass) | ungated |

## Totals

| Access | Operations |
|---|---|
| Read | 7 |
| Write | 30 |
| Read-write | 12 |
| ungated | 20 |
| **all** | **69** |
