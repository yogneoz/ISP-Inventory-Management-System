# Organisation, HR and permissions boundary (ACC-5)

This note records the ownership boundary enforced by the accounting worklist's
ACC-5 slice. It is a contract between modules, not a suggestion.

| Concern | System of record | Must not be used as |
| --- | --- | --- |
| Employee identity, employment status, branch posting | HR employee master (`employees`) | A permission grant, or a journal warehouse |
| Branch master and its accounting defaults | Organisation master (`branches`) | A separate chart of accounts or a second set of books |
| Cost-centre master | Finance master (`cost_centers`) | An employee attribute that survives a branch move |
| Permissions and role access | Auth/RBAC (`permissions`, role matrix, overrides) | An HR field on the employee record |
| Custody account ownership | General ledger (`gl_accounts.branch_id`, shared when `NULL`) | Inventory quantity |
| Posted financial value | Posted journals and subledgers (`gl_journals`, `gl_journal_lines`, `gl_subledger_entries`) | An editable HR/payroll record |

## Rules

1. **HR writes identity, not access.** Creating or editing an employee, changing
   their branch, or setting their default cost centre never creates a finance
   permission. Employee login creation is a separate, privileged auth action
   (`hr-employee-manage` plus user administration).
2. **Auth writes access, not the ledger.** A permission or role change changes
   which endpoints a user may call. It cannot rewrite posted journals, payroll
   lines or subledger rows; the ACC-1b immutability trigger refuses posted-ledger
   mutation on every application connection.
3. **Accounting owns posting roles and control accounts.** Employee and branch
   defaults only select analysis dimensions (branch, cost centre). They never
   choose a control account.
4. **Custody is explicit.** A cash, bank or wallet account may be branch-owned
   or shared (`gl_accounts.branch_id IS NULL`); a branch-owned account cannot
   receive another branch's journal line.
5. **Defaults are fallbacks, never overrides.** For payroll and manual vouchers
   the resolution order is: explicit document/line value, then the employee
   default, then the branch default. An explicitly selected cost centre is sent
   unchanged. An inactive or out-of-branch default is refused, not replaced
   silently.

## Where it is enforced

- Branch default: `branches.default_cost_center_id`, validated by
  `BRANCH_DEFAULT_COST_CENTER_SQL` in `admin.controller`; branch UI in
  `BranchesManagement`.
- Employee default: `employees.default_cost_center_id`, validated on create and
  update in `payroll.controller`; employee UI in `EmployeeProfileDialog`.
  A branch transfer clears a default that is no longer valid for the destination.
- Payroll: `payroll.controller` resolves each line, and
  `payrollPosting.service` emits one salary-expense debit per resolved centre.
- Manual vouchers: `VoucherEntries` exposes a per-line centre, prefills only an
  empty line from the selected employee/branch, and clears a stale centre when
  the line's branch changes.
- Tests: `tests/acc5OrganisationBoundary.api.test.ts` drives the defaults,
  explicit-line preservation, invalid-centre refusal, HR write refusal,
  permission grant boundary and posted-ledger immutability over real HTTP and
  PostgreSQL. `tests/acc5OrganisationDefaults.ui.test.ts` and
  `tests/hrEmployeeProfile.ui.test.ts` mount the branch and employee screens.

## Segregation of duties

The permission model separates the operations that already have dedicated
gates: inventory adjustment (`inv-adjust`), payments (`fin-payment-*`), period
close (`gl-close`) and HR identity management (`hr-employee-manage`). ACC-5
proves the routes refuse a caller without the relevant grant. It does not add a
second preparer/approver field to operations the model does not model that way;
that remains a future workflow feature, not an implied permission.
