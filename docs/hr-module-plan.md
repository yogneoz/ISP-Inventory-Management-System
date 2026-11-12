# HR module plan — employee master, attendance/leave and payroll

_Status: 2026-11-09. Phase 2 is complete; the effective-dated salary structure,
fiscal-year TDS/SSF configuration, generated payroll-run lifecycle,
incentive/arrears/recovery inputs and the posted payslip, payroll-register,
bank-disbursement and read-only Finance payroll-postings outputs are delivered.
Phase 3 is complete: the read-only employee self-service profile, payslip
history, leave balances/history, recent attendance, the document vault and the
workforce HR reports slice (headcount, leave liability, payroll cost, overtime,
SSF/TDS filing and stored-date attrition/separations) are delivered. Attrition
is computed from `employees.separation_date_ad`, not from status or edit
timestamps. Phase 4 has delivered recruitment, the appraisal cycle/goals/360 feedback slice
and the onboarding/offboarding checklist workspace; the Phase 4 scope is
complete. This plan is grounded in the three reference documents supplied by the business: the
Employee Master Sheet, the approved 2083 salary-calculation sheet, and the F1
Employee Profile form._

## 1. Decisions

1. **One database.** HR lives in the same PostgreSQL database as inventory and
   the ledger. Payroll posting is part of the same transaction as the run; a
   second database would turn that into a distributed write.
2. **One payroll module, two audiences.** Employee records, attendance/leave and
   payroll preparation belong to HR. Journal posting, salary payable, TDS/SSF
   liabilities and the employee ledger belong to Finance. Finance gets a
   read-only payroll-postings register, not a second payroll screen.
3. **Module tables use the `hr_` prefix** (new tables). Existing `employees`,
   `payroll_runs` and `payroll_run_lines` stay where they are so payroll history
   and journal links are untouched.
4. **The attached sheets are the source of truth for fields**, not a design to
   copy blindly. The master's HRMS ID becomes `employees.employee_code`; its
   Active/Inactive becomes `is_active`; its branch/work-station text must be
   mapped to a real `branches` row on import.
5. **No personal data in the repository.** Sample names, phone numbers, PANs and
   bank accounts from the sheets are never committed, seeded or used in tests.

## 2. What the reference documents contain

### Employee Master Sheet

One row per employee with: HRMS ID, full name, employment status, employment
type (`Non-PB`, i.e. non-probation), joining date, date of birth, contract
expiry, designation + designation code, department, work station, address,
personal contact, emergency contact person/number, internal and reference
e-mail, bank name, bank account, PAN, DOR, total working days, salary, blood
group, skill remarks and appraisal/incident remarks.

### Salary calculation sheet (2083, approved)

Per employee: HRMS ID, branch, short code, SSF eligibility, monthly salary,
basic salary (60%), HR allowance (40%), sick/home leave, loss of pay, absent
days, payable attendance, normal OT and H&F OT (hours → amount), bike/fuel/room
allowance, connection and target incentives, package-upgrade and >500
incentives, company bonus, total earnings, company and staff SSF contributions,
SSF total, TDS, ESF, net salary, EFC, working days, contract expiry and
designation/address.

### F1 Employee Profile

Personal details (name, father/grandfather, DOB, permanent/local address,
mobile, e-mail, PAN), family and emergency contact, experience, qualifications,
medical history, accident/case declarations, submitted documents and official
references.

## 3. Target schema

### 3.1 Employee master (extends `employees`)

Already present: `id`, `employee_code`, `name`, `branch_id`, `department`,
`designation`, `pan_number`, `ssf_number`, `bank_account`, `is_active`,
timestamps.

Add (Phase 0):

| Column | Type | Source |
| --- | --- | --- |
| `employment_type` | VARCHAR(30) | Master "Employment Type" (Non-PB, Probation, Contract…) |
| `joining_date_ad` | DATE | Master "Joining Date" |
| `date_of_birth_ad` | DATE | Master "Date of Birth" |
| `contract_expiry_ad` | DATE | Master "Contract Expiry" |
| `designation_code` | VARCHAR(30) | Master "Designation Code" |
| `work_station` | VARCHAR(150) | Master "Work Station" (display; branch stays the FK) |
| `address` | TEXT | Master/Profile address |
| `personal_contact` | VARCHAR(30) | Master "Personal Contact No." |
| `emergency_contact_person` | VARCHAR(150) | Master/Profile ICE |
| `emergency_contact_number` | VARCHAR(30) | Master/Profile ICE |
| `internal_email` | VARCHAR(150) | Master "Internal Mail ID" |
| `personal_email` | VARCHAR(150) | Master "Reference mail ID" |
| `bank_name` | VARCHAR(150) | Master "Bank Name" |
| `monthly_salary` | NUMERIC(12,2) | Master "Salary" (reference only until Phase 2) |
| `ssf_eligible` | BOOLEAN | Salary sheet "SSF Eligible" |
| `separation_date_ad` | DATE | HR exit date (Phase 3; nullable, AD-only) |

Phase 0 added `user_id` (ESS link). Phase 3 added the nullable
`separation_date_ad` used by attrition; an employee is not auto-deactivated when
it is entered, so status stays an explicit separate action. Later phases add
`manager_id`, `department_id`,
`designation_id`, `cost_center_id`, `employment_status` and
the profile-form fields. The F1 Employee Profile is delivered: father and
grandfather names, permanent/local address, the emergency address and relation,
blood group, medical, accident/case, the declaration date and typed name, and
the four repeating tables (family, experience, qualifications, references); the
submitted documents live in the document vault.

### 3.2 New HR tables

| Table | Purpose | Key columns |
| --- | --- | --- |
| `hr_org_masters` | Department/designation/work-station suggestions (`kind`) | kind, code, name, active |
| `hr_employee_documents` | Profile-form document vault: bounded bytes in-database plus expiry | employee_id, doc_type, byte_size, storage_key, expires_on_ad |
| `hr_shifts` / `hr_holidays` | Attendance calendar; holidays reuse BS dates | code, start/end, date_ad/bs |
| `hr_attendance` | Imported or captured attendance | employee_id, date_ad/bs, status, in/out, source |
| `hr_leave_types` / `hr_leave_balances` / `hr_leave_requests` | Leave accrual and approval | employee_id, type, days, status, approver |
| `hr_salary_components` / `hr_employee_salary` | Effective-dated salary structure; **replaces** `employees.monthly_salary` as the payroll source | component, amount, effective_from |
| `hr_payroll_component_lines` | Per-run component breakdown (basic, HR allowance, OT, SSF, TDS, incentives) | run_line_id, component, amount |
| `hr_recruitment_*` | Requisitions, candidates, interviews, offers (Phase 4) | — |
| `hr_review_cycles` / `hr_goals` / `hr_review_feedback` | Appraisal cycles, weighted goals and 360 feedback (Phase 4); sign-off locks the cycle | cycle branch, employee, reviewer, relationship |
| `hr_lifecycle_checklists` / `hr_lifecycle_checklist_items` | Onboarding/offboarding checklists (Phase 4); completion locks the checklist | employee/branch, asset, linked account, action |

### 3.3 Payroll tables (existing, extended in Phase 2)

`payroll_runs` / `payroll_run_lines` already post balanced journals and pay
salary payable. Phase 2 adds a `DRAFT` status, a submit/post split,
effective-dated salary structures and component lines. The run's control totals
must continue to equal the journal lines: gross + employer SSF = debits, and
net + TDS + employee SSF + employer SSF + advance + loan = credits. The employer
SSF share is a company cost the fund is owed, so it is part of the posting even
though it is outside the employee's own gross-to-net identity.

### 3.4 Date policy

The attachment dates are AD-only. Master dates (joining, DOB, contract expiry,
separation) therefore stay AD-only: most of them are outside the seeded BS
calendar span, so requiring BS would reject valid history. The finance dual-date
write guard carries a per-column exemption for these employee master dates. Transactional HR dates (attendance,
leave, payroll runs, documents) follow the existing dual AD/BS convention and
use `bsDateOrThrow` / `bsDateOr400`.

## 4. Permissions and roles

Employee-master reads accept `hr-employee-view` (or legacy `gl-payroll-manage`)
and writes accept `hr-employee-manage` (or the legacy grant); payroll-run
approval, posting and payment keep `gl-payroll-post`, while run reads accept
`gl-view` or the HR/payroll grants. Phase 0 introduces the separate namespace:

| Operation | Meaning | Default holders |
| --- | --- | --- |
| `hr-employee-view` | Read the employee master (PII masked in list reads) | SUPER_ADMIN, HEAD_OFFICE_ADMIN, ACCOUNTANT, AUDITOR |
| `hr-employee-manage` | Create/update employee records | SUPER_ADMIN, HEAD_OFFICE_ADMIN |
| `hr-employee-manage` (documents) | Upload/download/remove employee documents; metadata alone reads with `hr-employee-view` | SUPER_ADMIN, HEAD_OFFICE_ADMIN |
| `hr-attendance-manage` | Shifts, leave types, holidays, attendance (manual or CSV), leave balances and leave decisions | SUPER_ADMIN, HEAD_OFFICE_ADMIN, HR_MANAGER (legacy `gl-payroll-manage` also accepted) |
| `hr-employee-manage` / `gl-payroll-manage` (generated run) | Generate or discard a draft payroll run; run reads also accept `gl-view` | SUPER_ADMIN, HEAD_OFFICE_ADMIN, HR_MANAGER (legacy grant also accepted) |
| `gl-payroll-post` (run lifecycle) | Approve, post and pay a generated run | SUPER_ADMIN, HEAD_OFFICE_ADMIN, ACCOUNTANT |
| `gl-view` / HR grants (outputs) | Read posted payslips and the payroll register; drafts are refused | same as run reads |
| `hr-self-service` | ESS: own profile, POSTED/PAID payslips, leave balances/history and recent attendance (delivered read-only); documents follow | every role, including `HR_SELF_SERVICE` (per-user) |

Leave decisions reuse `hr-attendance-manage` rather than a separate
`hr-leave-approve` operation, so a view-only HR officer can read requests
without deciding them. Payroll posting keeps `gl-payroll-post`; the
finance-side postings register is `gl-view`. Routes accept OR-gates during
migration
(`requirePermissionAny('hr-employee-view', 'gl-payroll-manage')`) so existing
custom matrices do not lock anyone out.

`HR_MANAGER` and `HR_OFFICER` are registered in the `users.role` whitelist and
carry a default matrix row for every operation. `HR_MANAGER` holds view + manage;
`HR_OFFICER` holds view only, so employee reads are masked for officers.

`HR_SELF_SERVICE` is the twelfth role and the only one with a single grant: it
is `true` for `hr-self-service` and `false` for every other operation, so an
account on it can read its own ESS surfaces and nothing in the directory,
registers or administration. It exists so an employee can be given a login
without being given HR's register. HR assigns it — and only it — from the
employee record (`POST`/`PATCH /api/employees`, `loginRole`); a Super Admin or
Sub Super Admin (`HEAD_OFFICE_ADMIN`, the stored value) assigns every other
role from **Settings → Users** and writes per-user overrides, with the single
refusal that only a Super Admin may change a Super Admin account. The employee
form's `loginRole` list deliberately excludes both administrator roles, and
`USER_SET_ROLE_SQL` refuses those targets even if a caller gets past the
controller.

## 5. Phases and acceptance criteria

### Phase 0 — Employee master foundation (complete)

- Extend `employees` with the master fields in §3.1; expose them through
  `GET/POST/PATCH /api/employees` with branch scoping unchanged.
- Build the Employee Directory under **People & HR** with search, branch filter,
  add/edit, deactivate, PAN/SSF visibility rules and a read-only state for
  users without manage rights.
- Keep `/api/employees/search` slim (no PAN/SSF/bank) for the voucher picker.
- Master-sheet CSV import with a dry-run preview and commit: branch/work-station
  maps, HRMS ID → employee code, Active/Inactive → `is_active`, idempotent
  updates by employee code. **Acceptance:** a dry run writes nothing; commit
  creates/updates and reports per-row skips; re-import does not duplicate.
- Add `hr-*` permissions and optionally the two HR roles.
- **Acceptance:** an existing matrix keeps working; a manager can create an
  employee with the attachment's core fields; validation rejects bad dates,
  negative salary and duplicate codes; list reads never widen branch scope;
  the screen is gated, searchable and survives refresh via `/people/employees`.

### Phase 1 — Attendance and leave

**Delivered (slices 1–3, 2026-11-08) — Phase 1 complete:** `hr_shifts`,
`hr_leave_types`, `hr_holidays`, `hr_attendance`, `hr_leave_balances` and
`hr_leave_requests`; the attendance/shift/holiday/leave-type API plus a
branch-scoped leave balance and approval API, all with `hr-attendance-manage`
(or legacy `gl-payroll-manage`) writes; an idempotent CSV import keyed by
employee + AD date; a read-only payroll-input projection at
`GET /api/hr/payroll-inputs`; and **People & HR → Attendance & Leave** at
`/people/attendance-register` with Leave Requests, Balances and Payroll Inputs tabs.
Used leave days derive from approved requests, so reject/cancel returns them.

**Payroll-input model (derived on read):** for a period and branch scope, the
projection returns one row per active employee with present, half, absent,
attendance-leave, holiday and weekend days, paid/unpaid approved-leave days,
payable days, LOP days and OT hours. Attendance rows inside the period are the
authoritative daily fact; approved leave fills only days with no attendance
row (so a day is never counted twice) and is clipped to the period. Paid leave
types add to payable days, unpaid types to LOP; pending, rejected and cancelled
requests contribute nothing; OT is the sum of recorded hours. Nothing is
materialised, so correcting a day or cancelling a request updates the figures
without a counter to drift.

- Shifts, holidays and leave types; attendance import (CSV exported from the
  biometric device) before any hardware integration.
- Leave requests with an approval inbox; balances derive from approved requests.
- LOP/absent/OT totals become the payroll inputs used by the salary sheet.
- **Acceptance:** a month of attendance imports idempotently; a leave request
  cannot be double-approved; payroll preview shows the same payable days and OT
  hours as the sheet.

### Phase 2 — Payroll calculation and run UI

**Delivered (Phase 2 slices 1–3, 2026-11-09):** effective-dated
`hr_employee_salary` + `hr_salary_components`, resolved by as-of date and
history, with BASIC/HRA (60/40 default), SSF eligibility, OT rate and a monthly
TDS instruction. `GET/POST/PATCH /api/hr/employee-salaries` is branch-scoped
and gated on the employee grants (legacy `gl-payroll-manage` accepted).
`hr_statutory_configs` + `hr_tds_slabs` hold SSF 11/20 and progressive monthly
TDS bands per fiscal year; config reads are HR-readable, writes are global
manager-only, and `GET /api/hr/employee-salaries/:id/statutory` resolves the
as-of fiscal year and returns the full TDS/SSF breakdown. The generated run
path snapshots salary, attendance/OT and the statutory rules into a DRAFT, then
enforces DRAFT → APPROVED → POSTED → PAID with HR preparation and Finance
approval/posting; drafts write no journal and the official `PR-*` number is
issued only on posting. **People & HR → Payroll & Salary** at
`/people/payroll` exposes the breakdown, a manager-only rules editor and the
run workflow. Payslip list/print, the payroll register and the bank disbursement
file are delivered for POSTED/PAID runs. Period-scoped incentives, arrears,
advance recoveries and loan installments are snapshotted into generated runs,
and the read-only Finance payroll-postings register presents POSTED/PAID run
snapshots and their linked journals under `gl-view`. Phase 2 is complete.

- Effective-dated salary structure (basic 60% / HR allowance 40% defaults),
  SSF eligibility and 11% staff / 20% company contributions, Nepal TDS slabs
  versioned per fiscal year, OT rates, incentives, arrears and loans.
- `DRAFT → APPROVED → POSTED → PAID`; HR prepares, Finance approves/posts.
- Payslip list/print, payroll register, bank disbursement file and the
  read-only Finance payroll-postings register are delivered.
- **Acceptance:** for every employee in a fixture run, basic + allowance + OT +
  incentives − leave/LOP − SSF − TDS − advances equals net, matches the approved
  sheet to the rupee, and the posted journal balances. Tax tables are approved
  by an accountant before real posting.

### Phase 3 — ESS and HR reporting

**Delivered (Phase 3 slice 1, 2026-11-09):** the read-only ESS **My Profile** at
`/people/profile`, gated on the new `hr-self-service` operation rather than a
Finance grant. `GET /api/hr/self-service/profile` resolves the employee from the
authenticated account's `employees.user_id`, returns only that employee's own
profile projection (with `branchName`), refuses `employeeId`/`userId` selectors
and `branchId=ALL` or another branch, re-checks the session's branch scope, and
has no write path. **Judgment call:** the phase lists profile, payslips, leave,
attendance and documents; this slice deliberately shipped only the profile.

**Delivered (Phase 3 slice 2, 2026-11-09):** **My Payslips** at
`/people/payslips`, reusing `hr-self-service` rather than inventing a second ESS
grant. `GET /api/hr/self-service/payslips` joins immutable `payroll_run_lines`
snapshots through `employees.user_id`, returns only the caller's POSTED/PAID
payslips (DRAFT/APPROVED runs are excluded in SQL), and reuses the existing
payslip projection so the amounts match the run UI. It refuses employee/user
selectors and `branchId=ALL`/another branch, re-applies the session's branch
scope, sets `Cache-Control: private, no-store`, and has no write path. The
screen is read-only and exposes no payroll action.

**Delivered (Phase 3 slice 3, 2026-11-09):** **My Leave** at `/people/leave`,
reusing `hr-self-service`. `GET /api/hr/self-service/leave` returns only the
caller's own leave balances and request history; used days are derived from
APPROVED requests in the same year, and pending/rejected/cancelled history
stays visible. It refuses employee/user selectors and `branchId=ALL`/another
branch, re-applies the session's branch scope, sets `Cache-Control: private,
no-store`, and has no apply, cancel or approval path. The screen is read-only.

**Delivered (Phase 3 slice 4, 2026-11-09):** **My Attendance** at
`/people/attendance`, reusing `hr-self-service`.
`GET /api/hr/self-service/attendance` returns only the caller's own attendance for
the rolling 90 calendar days ending today (today plus the previous 89 days),
newest first, with a summary derived from the same returned rows. The endpoint
refuses employee/user selectors, `branchId=ALL`, another branch and a
record-id path, re-applies the session's branch scope, sets `Cache-Control:
private, no-store`, and has no clock-in/out, edit, delete or approval path.
The pre-existing HR management register moved from `/people/attendance` to
`/people/attendance-register`.

**Delivered (Phase 3 slice 5, 2026-11-09):** **My Documents** at
`/people/documents`, reusing `hr-self-service`.
`GET /api/hr/self-service/documents` returns only the caller's own vault
metadata with a 30-day expiry state and a summary derived from those rows. It
refuses employee/user/document-id selectors, `branchId=ALL` and another
branch, re-applies the session's branch scope, and sets `Cache-Control:
private, no-store`. Downloads stay on the existing authenticated content route,
which now admits ESS only for the caller's own linked employee. Self-service has
no upload, replace, delete or approval path. The vault has no issue-date
column, so `issuedOnAD` is an explicit null rather than a fabricated date.

**Delivered (Phase 3 slice 6, 2026-11-09):** **HR Reports** at
`/people/reports`, gated on the existing `hr-employee-view`/
`gl-payroll-manage` reads. `GET /api/hr/reports/workforce` returns session-scoped
current active headcount by branch/department, the selected period and
current-year leave liability in days (entitlement + adjustment − APPROVED
requests for active employees). It refuses `branchId=ALL`, another branch,
repeated branch/date parameters, unknown filters and employee/user/tenant/
document selectors, validates dates, and sets `Cache-Control: private,
no-store`. The later payroll slice added payroll-cost, overtime and SSF/TDS
filing reports; slice 8 below adds stored-date attrition/separations.

**Delivered (Phase 3 slice 7, 2026-11-09):** `GET /api/hr/reports/payroll`
adds payroll cost by branch/pay period (gross, basic, residual allowances,
overtime, incentive, arrears, LOP, employee deductions and net), overtime hours
and paid amount by employee/branch/department, and SSF/TDS filing per pay period
with employee SSF, employer SSF, total SSF and TDS withheld. Every figure comes
from stored POSTED/PAID `payroll_run_lines` snapshots; DRAFT/APPROVED runs are
excluded and nothing is re-derived from current salary structures. The endpoint
reuses the workforce filter/scope/refusal contract and private caching, and the
screen renders all three sections with period presets, grouping tables, empty
states and Refresh. Overtime department labels use the employee's current
department because run lines snapshot name/code, not department; that is stated
on screen and in the task note.

**Delivered (Phase 3 slice 8, 2026-11-09):** separation/termination storage is
`employees.separation_date_ad` (nullable AD date, added through
`scripts/schema.sql`). `POST/PATCH /api/employees` accepts and returns it,
rejects a date before the joining date with `400`, and PATCH can clear it with
`null`; entering it does not change `is_active`. The Employee Directory form
and row show the stored date. `GET /api/hr/reports/workforce` now counts
employees whose stored separation date falls inside the selected inclusive
period and groups them by the employee's current branch. The rate is
separations divided by the period-start headcount among employees with a
recorded joining date. If any in-scope employee lacks a joining date, or that
baseline is zero, `ratePercent` is null with a reason rather than estimated.
The screen shows separation count, rate, period-start baseline, branch rows and
explicit empty states. The master has no separation-branch history, so a transfer
after exit is grouped under the current branch; this limitation is stated on
screen and in the task note.

- Link `employees.user_id` to `users`; employee self-service for profile,
  payslips, leave, attendance and documents (all five delivered).
- Reports: workforce headcount, leave liability, stored-date
  separations/attrition, payroll cost, overtime and SSF/TDS filing delivered.
- **Acceptance:** an employee sees only their own records; two accounts cannot
  read each other's payslips; HR sees branch-wide data within scope.

### Phase 4 — Recruitment, performance and lifecycle

- Requisitions, candidates, interviews and offers; resume upload before parsing.
  **Delivered 2026-11-09:** a candidate inherits its requisition's branch and
  all child rows inherit the candidate's branch; resume bytes are stored before
  parsing and capped at 5 MiB; the only candidate-to-employee path locks the
  candidate, requires an ACCEPTED offer and writes the employee in the same
  transaction. The screen, branch-scoped API, schema and tests are in place.
- Appraisal cycles, goals/KPIs and 360 feedback. **Delivered 2026-11-09:**
  `hr_review_cycles`, `hr_goals` and `hr_review_feedback` are branch custody
  from the cycle down; goals and feedback inherit its branch. Weighted goals
  carry self/manager/final ratings, and 360 feedback is one row per reviewer
  and subject with SELF/MANAGER/PEER/REPORT identity checks. The sign-off
  action moves `OPEN → SIGNED_OFF`; every later cycle, goal and feedback write
  is refused.
- Onboarding/offboarding checklists tied to fixed assets and user accounts.
  **Delivered 2026-11-09:** `hr_lifecycle_checklists` owns branch custody from
  its employee; items inherit the header and carry no branch claim. Offboarding
  generates a return item for every fixed asset assigned to the employee and a
  deactivation item for the linked user account; onboarding generates account
  activation and can issue an active, unassigned branch asset. Completing an
  asset/account item reconciles the real `fixed_assets`/`users` row in the same
  transaction. `DRAFT → OPEN → COMPLETED` is explicit, every required item must
  be done before completion, and every later write returns `409`.
- **Acceptance:** a candidate cannot become an employee without a completed
  offer; an appraisal cycle locks after sign-off; a lifecycle checklist cannot
  complete while a required asset or account clearance is pending, and locks
  after completion.

## 6. Integration checklist (every HR screen)

- Sidebar group **People & HR**; stable paths under `/people/...`; tab
  permission in `TAB_PERMISSIONS`; route declared once in `App.tsx`.
- Branch scope through `allowedBranchScope`, never a client-supplied id alone.
- Audit every master mutation with `logAuditEvent`.
- BS dates via the existing helpers; AD-only only where justified above.
- Demo seed/clear: add HR tables to `DEMO_DATA_TABLES` once they carry `is_demo`.
- Tests: route-level API tests, permission/branch-scope cases, a screen or
  source pin, and `tsc` + production build.

## 7. Risks and open decisions

1. **Data import:** the master's branch names and work stations do not match
   this app's branch rows. The Phase 0 import accepts an explicit mapping and
   rejects unknown labels rather than auto-creating branches.
2. **Salary source:** until Phase 2, `employees.monthly_salary` is a reference
   value copied from the master. Payroll must not post from it; the effective-
   dated structure is the only posting source.
3. **Tax rules:** TDS slabs and SSF rates change; keep them in versioned tables
   with fiscal-year keys, never in code branches.
4. **PII:** PAN, bank account and salary need a read gate and masked list views;
   `hr-employee-view` without manage rights should not return full bank details.
5. **Approval model:** the existing `approval_requests` table is stock/customer
   specific. Leave gets its own request table with a shared inbox projection
   rather than overloading the stock approval type.

## 8. Progress tracking

The work is tracked in `docs/tasks/`:

- `hr-module.md` — this plan's execution checklist.
- `budgets.md`, `bank-reconciliation.md`,
  `recurring-journals-and-close.md`, `cash-flow-forecast.md`,
  `warranty-claims.md` — the other five initiatives.

## 9. Screens (verified walkthrough, 2026-11-11)

Captured on a running build with the demo seed, signed in as a Super Admin; the
images live in `docs/screenshots/`.

**Role Permission Defaults** — one card per role, twelve in all. Sub Super Admin
reads 68 of 68 operations (100%) and HR Self Service 1 of 68 (1%), which is the
entire point of that role: the self-service screens and nothing else.

![Role Permission Defaults: twelve role cards with per-role operation counts](screenshots/hr-role-permission-defaults.png)

**User Access & Role Administration** — every account card carries its role
badge and its effective access count, so a personal grant, denial or assigned
set is visible without opening the account.

![User Access & Role Administration with per-account role badges and effective access](screenshots/hr-user-access.png)

**Add System User** — the role picker lists every assignable role, both new
labels included. "Head Office Admin" is never shown: the stored
`HEAD_OFFICE_ADMIN` value displays as Sub Super Admin.

![Add System User dialog with the User Role picker](screenshots/hr-user-form.png)

**Login role inside the employee record** — the LOGIN ROLE control sits in the
Employee Record section, between the linked account and Department, and offers
the operational roles plus HR Self Service only. It is prefilled from the linked
account and saves with the rest of the employee.

![Employee record with the login-role picker for a linked Front Desk account](screenshots/hr-employee-login-role.png)

**An administrator link stays read-only** — when the linked account is a Super
Admin or Sub Super Admin, the record explains why the role cannot be changed
there instead of offering a picker that could never save.

![Employee record showing the read-only note for an administrator link](screenshots/hr-employee-admin-link.png)
