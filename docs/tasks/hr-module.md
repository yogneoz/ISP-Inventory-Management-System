# HR module — task note

**Status:** Complete — Phase 3 and Phase 4 are delivered, including recruitment, appraisal cycles/goals/360 feedback and onboarding/offboarding checklists.
**Plan:** [../hr-module-plan.md](../hr-module-plan.md)
**Created:** 2026-11-08

## Goal

A first-class HR module inside the existing single-database app: employee
records, attendance/leave, payroll preparation and ESS, with payroll posting
staying on the Finance ledger.

## Source documents

- Employee Master Sheet — identity, employment, contact, bank, salary fields.
- 2083 salary-calculation sheet — basic + HR allowance, attendance/OT, SSF, TDS,
  incentives, net pay.
- F1 Employee Profile — personal/family/experience/qualification/medical/
  document/reference fields.

Their data is reference for the schema only; no personal rows are committed.

## Phase 0 — employee master

- [x] Read the master, salary and profile documents and map fields.
- [x] Write the HR plan (`docs/hr-module-plan.md`).
- [x] Schema: `employment_type`, joining/DOB/contract-expiry dates,
      designation code, work station, address, personal/emergency contacts,
      internal/personal e-mail, bank name, monthly salary, SSF eligibility.
- [x] API: accept and return the new fields on `GET/POST/PATCH /api/employees`,
      keeping `/api/employees/search` slim.
- [x] Client: People & HR navigation group and Employee Directory screen with
      search, branch filter, add/edit, deactivate and permission gating.
- [x] Screen path `/people/employees`, tab permission, route registration.
- [x] `hr-*` permission namespace (`hr-employee-view`, `hr-employee-manage`; legacy payroll grant still accepted).
- [x] `HR_MANAGER` / `HR_OFFICER` roles and default matrix rows
      (`HR_MANAGER`: view + manage; `HR_OFFICER`: view only).
- [x] `employees.user_id` link for ESS (nullable, one-to-one, validated).
- [x] Org masters: one typed `hr_org_masters` table (`DEPARTMENT`,
      `DESIGNATION`, `WORK_STATION`) instead of three duplicate tables, with a
      manage-gated `/people/org-masters` screen and datalists on the employee
      form.
- [x] Employee document vault: `hr_employee_documents` stores bounded bytes in
      the same database (5 MiB ceiling, 20 per employee); metadata reads with
      `hr-employee-view`, while upload/download/delete require
      `hr-employee-manage` or the legacy payroll grant.
- [x] Import worksheet for the master sheet (branch/work-station mapping,
      HRMS ID → employee code, Active/Inactive → `is_active`): `POST
      /api/hr/employees/import` runs a SELECT-only `DRY_RUN` with per-row
      actions/errors or a `COMMIT` that writes the valid rows plus one
      `IMPORT_EMPLOYEES` audit row in one transaction. Existing codes update in
      place; a code in another branch is skipped rather than moved.
- [x] PII read gate: PAN, SSF, bank, salary, DOB, personal/emergency contact
      and address are masked on list, detail and ledger reads for `hr-employee-view`
      only; `hr-employee-manage` and legacy `gl-payroll-manage` see full data.

## Phase 5 — F1 Employee Profile

- [x] Schema: the F1 scalar answers on `employees` (`father_name`,
      `grandfather_name`, `permanent_address`, `local_address`,
      `emergency_contact_address`, `emergency_contact_relation`, `blood_group`,
      `medical_conditions`, `medical_details`, `accident_details`,
      `case_details`, `declaration_date_ad`, `declaration_name`) plus four
      repeating tables — `hr_employee_family_members`,
      `hr_employee_experience`, `hr_employee_qualifications`,
      `hr_employee_references`. Each cascades with its employee, carries
      `sort_order` assigned by the server, and keeps no branch column: branch
      custody stays on the employee row.
- [x] API: `GET /api/employees/:id/profile` (view grant; masked shape for a
      caller who may not see employee PII) and `PUT /api/employees/:id/profile`
      (manage grant) — one transaction that writes the scalars and replaces all
      four blocks, with one `UPDATE_EMPLOYEE_PROFILE` audit row. Bounded at
      20/20/20/10 rows; ages 0–150; percentages 0–100; experience end on or
      after its start; blood group from the accepted list; dates AD-only.
- [x] Client: the F1 Profile dialog on the Employee Directory row, read-only
      when the role lacks the manage grant or the server masked the payload.
- [x] The document vault still covers the form's submitted-documents section;
      the declaration's signature stays on paper (the date and typed name are
      recorded).

### Verification — slices 1–3

- `npx tsc --noEmit` — clean.
- `tests/financeMicroPermissions.test.ts` — 6 pass (66 operations, HR route gates,
  role defaults and UI/role-validator/whitelist registration).
- `tests/payrollAccounting.api.test.ts` — 12 pass, including masked list/detail/
  ledger reads for `HR_OFFICER`, full detail and write access for `HR_MANAGER`,
  full detail for the legacy `gl-payroll-manage` accountant, and 403s for the
  officer on write and account-options.
- Permission suites (`permissionSeedMigration`, `userPermissions`,
  `permissionOverrides`) + route/nav suites — 87 pass across 16 suites.
- `npm run build` — success; bundle budget entry 19.6/20 kB gz, startup
  309.0/320 kB gz.
- UI sweep — 4 pass.
- The screen was not visually inspected in a browser.

### Verification — slice 4 (org masters)

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 13 pass, including org-master CRUD,
  duplicate name/code 409s, immutable kind, inactive filtering/reactivation and
  a 403 for `HR_OFFICER` writes.
- `tests/financeMicroPermissions.test.ts` — 6 pass (route gates and role
  defaults unchanged by the new endpoints).
- Nav/screen suites — 36 pass; 88 route entries.
- `npm run build` — success; bundle budget entry 19.7/20 kB gz, startup
  309.2/320 kB gz.
- UI sweep and sidebar grouping — rerun after the new screen/group child (see
  the progress log).
- Neither HR screen has been visually inspected in a browser.

### Verification — slice 5 (employee document vault)

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 14 pass, including document upload,
  metadata list, byte download, delete, 400s for a bad type/file name/MIME and
  an empty body, a 413 over 5 MiB, 404 for a missing employee/document, and
  403s for `HR_OFFICER` on download, upload and delete.
- `npm run build` — success; bundle budget entry 19.7/20 kB gz, startup
  309.6/320 kB gz.
- UI sweep and sidebar grouping — 16 pass.
- The documents dialog has not been visually inspected in a browser.

### Verification — slice 6 (employee master-sheet import)

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 15 pass, including a six-row sheet
  with one create, one update and four skips (unknown branch, unknown work
  station, duplicate HRMS ID, bad salary). The dry run leaves the employee
  count, audit count and existing fields unchanged; the commit creates one and
  updates one with one audit row; a re-import reports 0 created / 2 updated / 4
  skipped; `HR_OFFICER` gets 403 on both modes; the legacy `ACCOUNTANT` grant
  can preview; and a branch-scoped manager's out-of-scope row is skipped.
- Full API suite (`tests/*.api.test.ts`) — 196 pass across 29 suites.
- `tests/financeMicroPermissions.test.ts` — 6 pass.
- `npm run build` — success; bundle budget entry 19.7/20 kB gz, startup
  309.7/320 kB gz. The lazy `feature-hr-EmployeeImportDialog` chunk is 9.40 kB
  raw / 2.99 kB gz.
- Sidebar grouping and UI sweep — 16 pass; `git diff --check` clean.
- The import dialog has not been visually inspected in a browser.

### Verification — Phase 2 slice 1 (effective-dated salary structure)

- `npx tsc --noEmit` — clean.
- `tests/hrSalaryStructure.api.test.ts` — 5 pass: a 100,000 gross creates BASIC
  60,000 / HRA 40,000; a 2026-01-01 and a 2026-07-01 revision resolve to 60,000
  and 66,000 basic on either side of the second effective date (and nothing
  before the first); history returns both newest-first; duplicate effective
  dates 409; bad/impossible dates, unknown employees, missing/negative amounts,
  empty or deduction-only components and duplicate component codes 400; a KTM
  manager cannot list, name, read by id, create for or edit another branch's
  employee or structure while an unscoped read stays inside KTM; `HR_OFFICER`
  and `AUDITOR` read but 403 on write; the legacy `ACCOUNTANT` grant creates and
  updates; header edits leave components intact, component replacement
  recalculates gross, and create/update audit rows carry the employee's branch
  while a refused update writes none.
- Full API suite (`tests/*.api.test.ts`) — 204 pass across 30 suites.
- Guard run (`financeMicroPermissions` 6, sidebar grouping 11, app paths 8,
  route registry 2, screen memo 27, screen preload 3) — 57 pass across 10
  suites; 67 operations, 90 route entries and 90 screens.
- `npm run build` — success; bundle budget entry 19.9/20 kB gz, startup
  310.6/320 kB gz.
- UI sweep (`uiUx*`, sidebar resize, voucher screens, screen preload) — 39 pass
  across 23 suites.
- `npm run check:no-inline-sql` clean (32 controllers), `npm run
  check:no-raw-dialogs` clean (230 client files), `git diff --check` clean.
- Applied `scripts/schema.sql` to the live dev DB and confirmed both tables and
  all 23 columns via `information_schema`.
- Live browser check: **People & HR → Payroll & Salary** at `/people/payroll`
  shows the 2026-07-01 revision (basic 66,000, HRA 44,000, gross 1,10,000, OT
  550, TDS 6,000, SSF eligible, 2 components) for a manager with Add Structure
  and Edit, and the same row for the view-only auditor with no Add/Edit and the
  read-only note. The temporary employee/structure rows were removed.

### Verification — Phase 2 slice 3 (generated payroll runs)

- `npx tsc --noEmit` — clean.
- `tests/hrPayrollRun.api.test.ts` — 4 pass: a 100,000 gross with one absent day
  in a 30-day month and 2 OT hours at 500 produces basic 58,000, LOP 3,333.33,
  gross 97,666.67, employee SSF 5,800, employer SSF 11,600, TDS 6,686.67 and net
  85,180; a 50,000 non-SSF employee produces TDS 2,500 and net 47,500; run
  totals are gross 147,666.67, TDS 9,186.67, SSF 5,800 and net 132,680. The test
  also covers missing structure/config 422s, the DRAFT → APPROVED → POSTED → PAID
  sequence, refusals out of order, duplicate drafts, discard-and-recreate,
  immutable snapshots after a rule edit, balanced six-line posting and payment
  journals, per-action audits, HR prepare/Finance post separation, the HR read
  path, and branch isolation for reads, preparation and approval.
- Targeted suites (`hrPayrollRun`, `hrStatutory`, `payrollAccounting`,
  `financeMicroPermissions`, `registerRefreshDomains`, `uiUxSweep20261030`) —
  81 pass across 13 suites.
- Full `npm test` — 2019 tests, 2017 pass, 2 Windows-only skips, exit 0.
- `npm run build` — success; bundle budget entry 19.9/20 kB gz, startup
  310.8/320 kB gz.
- `npm run check:no-inline-sql` clean (33 controllers), `npm run
  check:no-raw-dialogs` clean (230 client files), `git diff --check` clean.
- Applied `scripts/schema.sql` to the live dev DB and confirmed the lifecycle
  statuses, prepared/approved columns, statutory-config link and line snapshot
  columns through `information_schema`.
- Live browser check at `/people/payroll`: the manager created `WEB-PAY-01` in
  the Employee Directory and its 2026-11-09 structure (gross 100,000, basic
  60,000, HRA 40,000, SSF eligible), confirmed taxable 93,400, employee SSF
  6,600, employer SSF 12,000, TDS 1,840 and net 91,560, then generated the
  November DRAFT with Approve/Discard controls. The auditor saw the same run
  and line snapshot with an empty Actions cell and no Generate, Approve,
  Discard, Add Structure or Tax & SSF Rules control. The manager discarded the
  draft; the temporary employee, salary, run and matching audit rows were then
  removed and all leftover counts are zero.

### Verification — Phase 2 slice 4 (payslips and payroll register)

- `npx tsc --noEmit` — clean.
- `tests/hrPayrollRun.api.test.ts` — 5 pass. The new output test proves a
  posted/paid run exposes two payslips from the immutable snapshots, including
  basic 58,000, allowances 42,000, OT 1,000, LOP 3,333.33, gross 97,666.67,
  employee SSF 5,800, employer SSF 11,600, TDS 6,686.67 and net 85,180 for the
  first employee. The register totals reconcile exactly to all six run totals
  (gross 147,666.67, TDS 9,186.67, SSF 5,800, advances 0, loans 0, net
  132,680); synthetic stale advance or loan totals fail the check. It also
  reconciles to the six-line posting journal (debit/credit 147,666.67) and the
  payment journal (debit/credit 132,680). Draft and approved runs return 409; HR and auditor
  reads work, HR_OFFICER is refused, another branch is refused, the auditor
  receives masked bank details while HR receives them, the PDF print succeeds,
  every payslip/register/bank-file response is `private, no-store`, and
  before/after journal/line counts prove the reads write no ledger rows. Bank
  name/account are snapshotted onto each run line at preparation; clearing or
  changing the employee master after posting leaves the payslip and bank file
  unchanged.
- `tests/payrollOutputs.ui.test.ts` — 1 pass: the modal uses both output
  endpoints, print and clipboard actions, and no 9px labels.
- Targeted API/UI/finance suites — 12 pass across 3 files; feature-screen
  coverage — 44 pass, with 94 total screens (83 in the pin table, 11 pinned
  elsewhere).
- Full `npm test` — 2019 tests, 2017 pass, 2 Windows-only skips, 0 fail,
  exit 0; 465 suites; docs-count gate 3/3 at 2019.
- `npm run build` — success; bundle budget entry 19.9/20 kB gz, startup
  310.9/320 kB gz.
- `git diff --check` clean; docs-count gate 8 pass. No schema change: payslips
  and the register read the existing run and line snapshots only.
- Live browser check at `/people/payroll` on a posted and paid December run:
  gross 100,000, basic 60,000, allowances 40,000, employee SSF 6,600, employer
  SSF 12,000, TDS 1,840 and net 91,560. Register showed the employee's bank
  details, net pay and `Journal MJ-2083-84-10985 · debit 1,00,000.00 · credit
  1,00,000.00` with `Reconciles to run and journal`; Copy reported
  `Register copied.` Payslips showed the same figures, FY 2083-84 and BANK.
  The temporary employee, salary, two journals, run and four audit rows were
  deleted; leftover counts are zero.

### Verification — Phase 2 slice 2 (fiscal-year TDS slabs and SSF)

- `npx tsc --noEmit` — clean.
- `tests/hrStatutory.api.test.ts` — 5 pass: a test FY 2090/91 config computes
  a 70,000 SSF salary at taxable 65,380 and monthly TDS 4,807 (5% below 50,000,
  15% on 15,380), the same gross without SSF at 5,500, and a 300,000 salary at
  taxable 280,200 / TDS 55,050 (including 25% on 180,200 above the top band);
  a later 2091/92 config wins for a later effective date (120,000 salary,
  taxable 111,360, TDS 7,363.20 at 2/12/22 and SSF 12/21); correcting the
  2090/91 table changes the next computation; a missing fiscal year, an as-of
  before the structure and a year without a config are 422s; gapped,
  overlapping, missing-top, open-middle, non-zero-start, duplicate-bound,
  negative-rate and >100%-rate tables, a duplicate year and an unknown year are
  422/404 with no row stored; manager/officer/auditor reads succeed while
  manager, officer, auditor and branch accountant writes are 403 and another
  branch's structure is 403; config create/update audit rows land and a refused
  correction writes none.
- Full API suite (`tests/*.api.test.ts`) — 209 pass across 31 suites.
- Full `npm test` — 2013 tests, 2011 pass, 2 Windows-only skips, exit 0;
  docs-count gate matches 2013.
- Guard run (`financeMicroPermissions` 6, sidebar grouping 11, app paths 8,
  route registry 2, screen memo 27, screen preload 3) — 57 pass across 10
  suites; 67 operations, 90 route entries and 90 screens.
- `npm run build` — success; bundle budget entry 19.9/20 kB gz, startup
  310.7/320 kB gz.
- UI sweep (`uiUx*`, sidebar resize, voucher screens, screen preload) — 39 pass
  across 23 suites.
- `npm run check:no-inline-sql` clean (33 controllers), `npm run
  check:no-raw-dialogs` clean (230 client files), `git diff --check` clean.
- Applied `scripts/schema.sql` to the live dev DB and confirmed
  `hr_statutory_configs` (10 columns) and `hr_tds_slabs` (8 columns) through
  `information_schema`, with FY 2083-84 seeded at employee/employer SSF 11/20
  and five monthly bands (0–83,333.33 @1%, 83,333.33–125,000 @10%,
  125,000–208,333.33 @20%, 208,333.33–333,333.33 @27%, above @29%).
- Live browser check at `/people/payroll` for 2026-11-08: a 2026-07-01
  1,00,000 gross / 60,000 basic SSF structure shows FY 2083-84, taxable 93,400,
  employee SSF 6,600, employer SSF 12,000, monthly TDS 1,840 and annual TDS
  22,080, with all five bands and net 91,560. The manager sees Tax & SSF Rules
  (FY 2083-84 selected, 11/20 and the five bands editable) plus Add Structure
  and Edit; the view-only auditor sees the same numbers with no Tax & SSF Rules,
  Add or Edit. The temporary employee/structure rows were removed and the
  leftover counts are zero.

### Verification — Phase 1 slice 3 (payroll inputs) — Phase 1 complete

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 18 pass (17 existing + the payroll-
  inputs case): an employee with 3 present days (one covered by approved
  leave), 1 half day, 1 absent day, 1 holiday, 1 weekend, 1 attendance LEAVE
  day, 4.5 recorded OT hours, 5 paid leave days (one request clipped by both
  period edges and attendance-covered days excluded) and 2 unpaid leave days
  derives exactly payable 11.5, LOP 3.5 and OT 4.5; pending and rejected
  requests contribute nothing; a second employee with September attendance has
  all zeros for July; missing/reversed/impossible/over-one-year periods and an
  unknown employee are 400/404; a branch-scoped manager is refused another
  branch's roster and named employee while an unscoped read stays inside its
  branch; `HR_OFFICER` and the legacy `ACCOUNTANT` grant read successfully;
  the projection has no POST route (404); reads write no audit row.
- Full API suite (`tests/*.api.test.ts`) — 199 pass across 29 suites.
- Guard run (`financeMicroPermissions` 6, sidebar grouping 11, app paths 8,
  route registry 2, screen memo 27, screen preload) — 57 pass across 10
  suites; 67 operations, 89 route entries and 89 screens (the payroll-inputs
  endpoint is an API read, not a screen or operation).
- `npm run build` — success; bundle budget entry 19.8/20 kB gz, startup
  310.4/320 kB gz.
- UI sweep (uiUx*, sidebar resize, screen preload, voucher screens) — 39 pass
  across 23 suites.
- `npm run check:no-inline-sql` clean (31 controllers), `npm run
  check:no-raw-dialogs` clean (229 client files), `git diff --check` clean.
- No new table or column: the projection reads the existing `hr_attendance`,
  `hr_leave_requests`, `hr_leave_types` and `employees` columns, all confirmed
  through `information_schema`.
- Live browser check (running dev app, `superadmin@example.com` and the
  view-only `auditor@example.com`): **People & HR → Attendance & Leave**
  renders seven tabs; Leave Requests shows a pending and an approved row with
  Approve/Reject/Cancel for the manager and no action buttons for the auditor;
  Leave Balances shows the entitlement/used/remaining row with Edit only for
  the manager; Payroll Inputs shows the derived present/paid-leave/payable/
  LOP/OT figures and no write control for either account. The temporary demo
  rows were removed from the dev database afterwards.

### Verification — Phase 1 slice 2 (leave balances and approvals)

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 17 pass (16 existing + the leave
  case): one balance row per employee + leave type + year with a duplicate 409,
  a year-range 400 and an audited adjustment; request creation with an
  inclusive day count and an `LR-2026-` number; an overlap 409 and five 400s
  (reversed range, cross-year, unknown type, missing employee, impossible
  date); approval recording approver + timestamp and spending the balance,
  with a repeat approval 409; rejection spending nothing; cancelling an
  approved request returning its days and cancelling a pending one; approval
  409s for an insufficient balance and for a missing balance row; a
  branch-scoped manager 403 on another branch's request/balance reads, writes
  and approval while an unscoped read stays inside its branch; `HR_OFFICER`
  200 on both reads and 403 on all six writes/decisions; the legacy
  `ACCOUNTANT` `gl-payroll-manage` grant creating and approving; per-action
  audit counts and no audit row from a refused mutation.
- Full API suite (`tests/*.api.test.ts`) — 198 pass across 29 suites.
- Guard run (`financeMicroPermissions` 6, sidebar grouping 11, app paths 8,
  route registry 2, screen memo 27, screen preload) — 57 pass across 10
  suites; 67 operations, 89 route entries and 89 screens (no new screen or
  operation).
- `npm run build` — success; bundle budget entry 19.8/20 kB gz, startup
  310.3/320 kB gz.
- UI sweep (uiUx*, sidebar resize, screen preload, voucher screens) — 39 pass
  across 23 suites.
- `npm run check:no-inline-sql` clean (30 controllers), `npm run
  check:no-raw-dialogs` clean (229 client files), `git diff --check` clean.
- Schema applied to the live dev database; `hr_leave_balances` and
  `hr_leave_requests` plus their key columns (`status`, `entitlement_days`,
  `adjustment_days`, `balance_year`, `days_count`, `decided_by`, `decided_at`,
  `branch_id`) were confirmed through `information_schema`.
- The new leave tabs have not been visually inspected in a browser.

### Verification — Phase 1 slice 1 (attendance foundation)

- `npx tsc --noEmit` — clean.
- `tests/payrollAccounting.api.test.ts` — 16 pass (15 existing + the attendance
  foundation case): shift/leave-type/holiday create, duplicate 409s and edits;
  manual attendance upsert keyed by employee + AD date (branch derived from the
  employee, one audit row per save); six validation 400s (unknown shift,
  overtime > 24, bad clock, bad status, impossible date, missing employee); an
  eight-row CSV import (1 create, 1 update, 6 skips for unknown employee,
  duplicate row, bad date, bad status, unknown shift, bad clock) with one
  `IMPORT_HR_ATTENDANCE` audit row; re-import (0 created, 2 updated, still one
  row per employee/day); branch-scoped manager 403s on another branch's
  attendance/holiday reads, an employee attendance write and a holiday delete,
  while company-wide shifts stay readable; `HR_OFFICER` 200 on every read and
  403 on all seven writes; the legacy `ACCOUNTANT` `gl-payroll-manage` grant
  still writes; deletes audit and repeat as 404.
- Full API suite (`tests/*.api.test.ts`) — 197 pass across 29 suites.
- Guard run (`financeMicroPermissions` 6, sidebar grouping 11, app paths 8,
  route registry 2, screen memo 27) — 54 pass across 9 suites; 67 operations,
  89 route entries and 89 screens.
- `npm run build` — success; bundle budget entry 19.8/20 kB gz, startup
  310.2/320 kB gz.
- UI sweep (uiUx*, sidebar resize, screen preload, voucher screens) — 39 pass
  across 23 suites.
- `npm run check:no-inline-sql` clean (29 controllers), `npm run
  check:no-raw-dialogs` clean (229 client files), `git diff --check` clean.
- The new screen has not been visually inspected in a browser.

## Phase 6 — self-service profile card, photo and narrow editing

`My Profile` is no longer read-only. The page now carries a profile picture and
an **Edit information** mode that writes only the five fields an employee owns:
personal contact, personal e-mail, address, emergency contact person and
emergency contact number.

- **Server**: `PUT /api/hr/self-service/profile` (`hr-self-service`), the same
grant as the read. The controller refuses every HR-owned column by name
  (`monthlySalary`, `panNumber`, `ssfNumber`, `bankName`, `bankAccount`,
  `designation`, `department`, `employmentType`, `isActive`, …) and every
  unknown key with a 400 instead of ignoring it, validates the phone/e-mail
  formats, and bounds the photo to a 150 KB JPEG/PNG/WebP data URL (413 above
  that). The write is keyed by `employees.user_id` in the SQL itself, so a
  stale id cannot touch another record, and each save writes one
  `UPDATE_SELF_SERVICE_PROFILE` audit row (`AUTH` module).
- **Storage**: `employees.profile_photo TEXT` holds the client-resized square
  JPEG data URL. Nothing else about the employee row changed; salary, statutory
  ids and bank details stay on the HR master and are shown read-only with a
  lock on the page.
- **Photo pipeline** (`client/src/utils/photoCrop.ts` +
  `EmployeeSelfServicePhotoDialog.tsx`): pick a JPEG/PNG/WebP, drag to pan and
  zoom (1–3×), and the dialog draws the square crop onto a canvas at 320×320,
  stepping quality (0.85/0.75/0.65) and then the output square (320/256/224)
  until the data URL fits 150 KB. Panning clamps inside the image, so no blank
  corners; the byte maths is unit-tested without a DOM.
- **Tests**: four API cases on the real route (only the five fields change and
  HR columns are byte-identical; HR-only/unknown/malformed/oversized values are
  refused with nothing written; grant, branch scope and selectors are enforced;
  one audit row per save), three rendered dialog cases for the F1 profile
  (masked read-only, add/remove rows, save payload) and three crop-maths cases.

## Phase 1 — attendance and leave

- [x] `hr_shifts`, `hr_holidays`, `hr_attendance`, `hr_leave_types` foundation:
      company-wide shift/leave-type catalogues, branch-owned holidays and the
      daily register.
- [x] CSV attendance import (idempotent upsert by employee + AD date);
      biometric hardware integration deferred.
- [x] `hr_leave_balances` and `hr_leave_requests` with an approval workflow;
      used days derive from approved requests, so reject/cancel returns them.
- [x] Attendance → payroll inputs (payable days, LOP, OT hours): a read-only
      projection over the register and approved leave, exposed at
      `GET /api/hr/payroll-inputs` and the Payroll Inputs tab.

**Phase 1 complete (2026-11-08).**

## Phase 2 — payroll calculation and run UI

- [x] Effective-dated `hr_employee_salary` + `hr_salary_components`:
      BASIC/HRA (60/40 default), SSF eligibility, OT rate and monthly TDS
      instruction, exposed at `/api/hr/employee-salaries` and the Payroll &
      Salary screen.
- [x] Basic/HR-allowance split and OT rates.
- [x] Incentives, arrears, advance recovery and loan installments: period-scoped
      inputs at `GET/PUT /api/hr/payroll-inputs`, snapshotted onto the run line
      and run totals, with payroll-input, payslip and register display.
- [x] Nepal TDS slabs + SSF 11%/20%, versioned by fiscal year, with
      admin-scoped config endpoints and an as-of statutory computation.
- [x] Draft → approve → post → pay; payroll register and payslips.
- [x] Payroll postings register in Finance (read-only).

## Phase 3 — ESS and reporting

- [x] ESS profile: read-only own record at `/people/profile`, linked through
      `employees.user_id`, gated on `hr-self-service`, with server-side selector
      and branch-scope refusals and no write path.
- [x] ESS payslips: read-only own history at `/people/payslips`, only POSTED/PAID
      run snapshots, gated on `hr-self-service`, with selector and branch-scope
      refusals and no write path.
- [x] ESS leave: read-only own balances and request history at
      `/people/leave`, with used days derived from approved requests, gated on
      `hr-self-service` and no apply/cancel/approval path.
- [x] ESS attendance: read-only own recent records at `/people/attendance`,
      bounded to the rolling 90 days ending today, gated on `hr-self-service`
      and with no clock/edit/approval path.
- [x] ESS documents: read-only own vault metadata and authenticated download at
      `/people/documents`, gated on `hr-self-service`, with selector/branch
      refusals and no upload/replace/delete/approval path.
- [x] Headcount, leave liability, payroll cost by branch/pay period and overtime by branch/department/employee.
- [x] SSF/TDS filing per pay period from stored employee/employer SSF and TDS run-line columns.
- [x] Attrition/separations from the stored `employees.separation_date_ad`, with a period-start-headcount rate and an explicit null-rate reason when the baseline is incomplete.

## Phase 4 — recruitment and performance

- [x] Requisitions, candidates, interviews, offers. Resume bytes are stored
  before any parsing path; every offer is one-per-candidate and the only
  candidate-to-employee conversion requires an ACCEPTED offer.
- [x] Appraisal cycles, goals, 360 feedback. Cycles are branch custody, goals
  carry weights and self/manager/final ratings, feedback is one row per
  reviewer/subject, and sign-off locks every later write.
- [x] Onboarding/offboarding checklists tied to assets and user accounts. The
  checklist inherits the employee's branch; offboarding generates the assigned
  fixed-asset returns and linked-account deactivation, onboarding generates
  account activation, and completion is irreversible once all required items
  are done.

## Decisions

- Single database; HR tables use `hr_` prefix.
- Payroll screens belong to HR; journal/posting remains Finance.
- Master dates are AD-only because the attached dates predate the seeded BS
  calendar; transactional dates keep dual AD/BS.
- `employees.monthly_salary` is a reference value until Phase 2's effective-
  dated structure replaces it as the posting source.
- PII rule: full employee detail requires `hr-employee-manage` OR the legacy
  `gl-payroll-manage`; `hr-employee-view` alone receives masked fields on list,
  detail and employee-ledger reads.
- Org masters are label-only suggestions. Employees keep denormalized
  department/designation/work-station text so historical payroll is never
  rewritten, and nothing is auto-seeded from existing free text.
- Document bytes are stored as `BYTEA` in the same database so the file, its
  metadata and its audit row commit or roll back together. A generated storage
  key carries no employee data, and the 5 MiB ceiling is enforced in the route,
  the controller and a schema CHECK.
- Master-sheet import is one endpoint with two phases over the same validation:
  `DRY_RUN` performs SELECTs only and returns per-row actions/errors; `COMMIT`
  re-validates and writes every valid row plus one audit row in a single
  transaction. Existing codes update in place, the branch is never moved by an
  import, and unknown branch/work-station values are rejected rather than
  auto-created.
- Attendance is unique per employee + AD date, so a manual save and a CSV
  re-import correct the same day instead of duplicating it. Shifts and leave
  types are company-wide catalogues; holidays and attendance rows carry
  `branch_id`, and an attendance row's branch is derived from the employee,
  never from the request body. A sheet imports only its valid rows plus one
  audit row in one transaction; skipped rows are reported by sheet line and
  write nothing.
- `hr-attendance-manage` is a separate write control from the employee master:
  `HR_MANAGER` and `HEAD_OFFICE_ADMIN` hold it, `HR_OFFICER` reads without it,
  and the legacy `gl-payroll-manage` grant still opens attendance writes. Leave
  decisions reuse this operation rather than a separate approval grant.
- Leave usage is **derived**, not stored: `hr_leave_balances` keeps entitlement
  and adjustment, while used days come from approved requests in the same
  query. Rejecting or cancelling therefore returns the days with no counter to
  drift. Approval is the only balance-sufficiency check (creation checks
  overlaps), a request must stay inside one calendar year, and cancellation is
  allowed from `PENDING` or `APPROVED` through the same status-guarded update
  that prevents a double decision.

### Verification — Phase 2 slice 7 (Finance payroll-postings register)

- `npx tsc --noEmit` — clean.
- `tests/hrPayrollRun.api.test.ts` — 7 pass. The new register test proves 401
  without a token; 403 for HR-only, another branch and an `ALL` widening; 400
  for invalid and reversed date windows; exact two-decimal gross, incentive,
  arrears, TDS, SSF, advances, loans, net and journal totals; both journal
  links; employee count; a `POSTED` row before payment and a `PAID` row after;
  and DRAFT and APPROVED runs excluded. The run row and journal count are
  unchanged across the reads.
- `tests/payrollOutputs.ui.test.ts` — 4 pass, including a mounted real-App
  happy path that renders the posted snapshot, journals and two-decimal money,
  and a direct mount proving a Branch Manager without `gl-view` gets the
  refusal without calling the endpoint. The existing static pins cover route,
  preload, columns and the absence of payroll write actions.
- Route/nav/preload/screen/doc guards — 106 pass across 17 suites: 91 route
  entries and 95 feature screens (84 in the coverage table, 11 pinned by the
  dedicated register tests).
- Full `npm test` — 2024 tests, 2022 pass, 2 Windows-only skips, 0 fail,
  465 suites, exit 0; docs-count gate 3/3 at 2024.
- `npm run build` and `npm run check:bundle-budget` — exit 0; entry
  20.0/20 kB gz, startup 311.2/320 kB gz.
- `npm run check:no-inline-sql` clean (33 controllers), `npm run
  check:no-raw-dialogs` clean (232 client files), `git diff --check` clean.
- No schema change: the table count remains 71. The screen was exercised by a
  mounted DOM test, not visually inspected in a browser.

### Verification — Phase 3 slice 1 (employee self-service profile)

- `npx tsc --noEmit` — clean.
- `tests/hrSelfService.api.test.ts` — 2 pass. The first proves 401 without a
  token; 403 when `hr-self-service` is denied; the exact 28-field own-profile
  projection (code, name, branch + `branchName`, employment, contact, PAN/SSF,
  bank and `monthlySalary` `'123456.78'` with two decimals); `private, no-store`;
  a second account getting its own different employee; a branch-B employee
  reading its own branch; and an unlinked admin getting 404 rather than a
  widened read. The second proves `employeeId`, `userId` and `user_id` are 403,
  `branchId=ALL` and another branch are 403, the caller's own branch filter is
  200, an employee linked to an out-of-scope branch is 403, the employee count is
  unchanged across reads, and POST/PATCH/DELETE are 404 (no write path).
- `tests/hrSelfService.ui.test.ts` — 3 pass: route/path/tab/preload/sidebar and
  read-only pins; a mounted real-App happy path at `/people/profile` that renders
  the own profile, formats the salary with two decimals, calls the endpoint once
  and shows no write control; and a direct mount of a `FRONT_DESK` account with
  the permission denied, which shows the refusal and makes zero endpoint calls.
- Route/nav/preload/screen/doc guards — 106 pass across 17 suites: 92 route
  entries, 96 feature screens (85 in the coverage table, 11 pinned elsewhere)
  and 68 permission operations.
- `npm run build` — exit 0. Bundle budget exit 0: entry 20.0 kB gz (20,535 B
  against the deliberately raised 20.125 kB entry budget, documented in
  `scripts/check_bundle_budget.mjs`), startup 311.4/320 kB gz.
- `npm run check:no-inline-sql` clean (34 controllers), `npm run
  check:no-raw-dialogs` clean (233 client files), `git diff --check` clean.
- No schema change: the table count remains 71. Fixture cleanup left zero rows
  for the ESS branches, users and employees. The screen was exercised by a
  mounted DOM test, not visually inspected in a browser.

### Verification — Phase 3 slice 2 (employee self-service payslips)

- `GET /api/hr/self-service/payslips` sits under
  `requirePermissionAny('hr-self-service')` and is read-only. It derives the
  employee from `employees.user_id`, joins immutable `payroll_run_lines`
  snapshots to their runs, filters to POSTED/PAID (DRAFT and APPROVED are
  excluded in SQL), reuses the existing payslip projection, returns newest
  first and sets `Cache-Control: private, no-store`. Employee/user selectors and
  `branchId=ALL` or another branch are explicit 403s.
- **People & HR → My Payslips** at `/people/payslips` is a lazy mounted screen
  with route, nav, preload and permission wiring; it lists the caller's
  payslips, opens the newest by default, shows the exact stored amounts and has
  a no-endpoint refusal state. No write controls exist.
- New API and mounted-UI tests (`tests/hrSelfServicePayslips.api.test.ts`,
  `tests/hrSelfServicePayslips.ui.test.ts`); route, screen, nav and permission
  pins updated. The operation total stays 68 because payslips reuse the
  existing `hr-self-service` grant; per-user overrides still apply.
- **Numbers:** 2034 tests across 467 suites — 2032 pass, 2 Windows-only skips;
  route table 93, feature screens 97 (86 in the coverage table, 11 pinned
  elsewhere), permission operations 68.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green with the docs-count
  gate at 2034; `npm run build` exit 0; `npm run check:bundle-budget` exit 0;
  `check:no-inline-sql`, `check:no-raw-dialogs` and `git diff --check` clean.
  The temporary `ess-pay-*` API fixture leaves zero rows. The screen was
  exercised by a mounted DOM test, not visually inspected in a browser.

### Verification — Phase 3 slice 3 (employee self-service leave)

- `GET /api/hr/self-service/leave` sits under
  `requirePermissionAny('hr-self-service')` and is read-only. It derives the
  employee from `employees.user_id`, returns only that employee's leave
  balances with used days derived from APPROVED requests in the same year, and
  that employee's pending/approved/rejected/cancelled request history, newest
  first. It sets `Cache-Control: private, no-store`, refuses employee/user
  selectors and `branchId=ALL`/another branch, and has no write path.
- **People & HR → My Leave** at `/people/leave` is a lazy mounted screen with
  route, nav, preload and permission wiring; it shows balance cards and request
  history, has a no-endpoint refusal state and exposes no apply/cancel/approve
  action.
- New API and mounted-UI tests (`tests/hrSelfServiceLeave.api.test.ts`,
  `tests/hrSelfServiceLeave.ui.test.ts`); route, screen, nav, coverage and
  permission pins updated. The operation total stays 68 because leave reuses
  the existing `hr-self-service` grant; per-user overrides still apply.
- **Numbers:** 2039 tests across 468 suites — 2037 pass, 2 Windows-only skips;
  route table 94, feature screens 98 (87 in the coverage table, 11 pinned
  elsewhere), permission operations 68.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green with the docs-count
  gate at 2039; `npm run build` exit 0; `npm run check:bundle-budget` exit 0
  (entry 20,655 B / 20.25 kB after the deliberate budget note; startup
  311.6/320 kB); `check:no-inline-sql`, `check:no-raw-dialogs` and
  `git diff --check` clean.
  The temporary `ess-leave-*` API fixture leaves zero rows. The screen was
  exercised by a mounted DOM test, not visually inspected in a browser.

### Verification — Phase 3 slice 4 (employee self-service attendance)

- `GET /api/hr/self-service/attendance` sits under
  `requirePermissionAny('hr-self-service')` and is read-only. It derives the
  employee from `employees.user_id` and returns only that employee's
  attendance for the rolling 90 calendar days ending today (today plus the
  previous 89 days), newest first, with a summary derived from the same rows.
  It sets `Cache-Control: private, no-store`, refuses employee/user selectors,
  `branchId=ALL`, another branch and a record-id path, and has no clock-in/out,
  edit, delete, submit or approval route.
- **People & HR → My Attendance** at `/people/attendance` is a lazy mounted
  screen with route, nav, preload and permission wiring; it shows the window,
  summary, recent records and a no-endpoint refusal state, and exposes no
  clock/edit/approval action. The pre-existing HR management register moved to
  `/people/attendance-register` to free the canonical ESS URL.
- New API and mounted-UI tests (`tests/hrSelfServiceAttendance.api.test.ts`,
  `tests/hrSelfServiceAttendance.ui.test.ts`); route, screen, nav, coverage and
  permission pins updated. The operation total stays 68 because attendance
  reuses the existing `hr-self-service` grant; per-user overrides still apply.
- **Numbers:** 2044 tests across 469 suites — 2042 pass, 2 Windows-only skips;
  route table 95, feature screens 99 (88 in the coverage table, 11 pinned
  elsewhere), permission operations 68.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green with the docs-count
  gate at 2044; `npm run build`, `npm run check:bundle-budget`,
  `check:no-inline-sql`, `check:no-raw-dialogs` and `git diff --check` clean.
  The bundle gate measured entry 20,723 B / 20.25 kB (13 B headroom) and
  startup 311.7/320 kB, so no budget change was needed. The temporary
  `ess-att-*` API fixture leaves zero rows. The screen was exercised by a
  mounted DOM test, not visually inspected in a browser.

### Verification — Phase 3 slice 5 (employee self-service documents)

- `GET /api/hr/self-service/documents` sits under
  `requirePermissionAny('hr-self-service')` and is read-only. It derives the
  employee from `employees.user_id`, returns only that employee's vault
  metadata with a 30-day expiry state and a summary derived from the same rows,
  and builds a relative content URL. It sets `Cache-Control: private, no-store`,
  refuses employee/user/document-id selectors, `branchId=ALL` and another
  branch, and has no upload, replace, delete, submit or approval route.
- The existing content route now also accepts `hr-self-service`, but only when
  the requested employee is the caller's own linked employee; HR managers keep
  their existing access. Another employee's bytes return 404.
- **People & HR → My Documents** at `/people/documents` is a lazy mounted
  screen with route, nav, preload and permission wiring; it shows the summary,
  newest-first document table, expiry badges, Refresh, download actions and a
  no-endpoint refusal state. It offers no management document action.
- New API and mounted-UI tests (`tests/hrSelfServiceDocuments.api.test.ts`,
  `tests/hrSelfServiceDocuments.ui.test.ts`) cover own-only metadata, the
  derived summary, selector/branch refusals, own bytes, cross-employee 404s,
  empty/error states and the permission refusal. Route, screen, nav, coverage
  and permission pins are updated; the operation total stays 68 because
  documents reuse `hr-self-service`.
- **Numbers:** 2051 tests across 470 suites — 2049 pass, 2 Windows-only skips;
  route table 96, feature screens 100 (89 in the coverage table, 11 pinned
  elsewhere), permission operations 68.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green at 2051 tests /
  470 suites (2049 pass, 2 Windows-only skips, 0 fail) with the docs-count
  gate at 2051; `npm run build` exit 0; `npm run check:bundle-budget` exit 0
  after the deliberate entry-budget move to 20.375 kB (entry 20,748 B, 116 B
  headroom; startup 311.8/320 kB); `check:no-inline-sql` clean (34
  controllers), `check:no-raw-dialogs` clean (237 client files), `git diff
  --check` clean. The temporary `ess-doc-*` fixture cleanup left zero rows.
- **Limitation:** the vault has no issue-date column, so `issuedOnAD` is an
  explicit null and the UI shows `—` rather than fabricating a date from the
  upload timestamp. The screen was exercised by a mounted DOM test, not visually
  inspected in a browser.

### Verification — Phase 3 slice 6 (workforce HR reports)

- `GET /api/hr/reports/workforce` returns session-scoped aggregates for current
  active headcount by branch and department, the selected period and
  current-year leave liability in days. It sets `Cache-Control: private,
  no-store`, refuses `branchId=ALL`, another branch, repeated branch/date
  parameters, unknown filters and employee/user/tenant/document selectors, and
  returns 400 for invalid or reversed dates.
- **Attrition limitation at this slice:** `employees` had `is_active` and a
  mutable `updated_at`, but no separation/termination date. The payload
  returned `available:false` with a reason; no count or rate was inferred from
  status changes or record edits. Slice 8 below replaces this limitation with
  stored separation dates.
- Leave liability is current-calendar-year entitlement + adjustment − APPROVED
  request usage for active employees, matching the leave register's derived
  usage. The screen labels it as days, not money.
- Aggregate SQL lives in `server/src/models/hrReports.repo.ts`; the controller
  contains no inline SQL. **People & HR → HR Reports** at `/people/reports` has
  route, nav, preload and permission wiring, a four-option period selector and
  explicit empty states. It reuses `hr-employee-view`/`gl-payroll-manage`, so
  the operation total remains 68.
- New API and mounted-UI tests (`tests/hrReports.api.test.ts`,
  `tests/hrReports.ui.test.ts`) cover active-only aggregation math, branch and
  department scope, prior-year/pending/rejected exclusion, cross-branch and
  selector refusals, private caching, the period/Refresh refetches, the empty
  state and the no-permission refusal. Route, screen, nav and coverage pins are
  updated to 97 routes / 101 screens (90 table / 11 pinned elsewhere).
- **Numbers:** 2059 tests across 471 suites — 2057 pass, 2 Windows-only skips;
  route table 97, feature screens 101 (90 in the coverage table, 11 pinned
  elsewhere), permission operations 68. The `hr-rpt-*` fixture cleanup leaves
  zero rows.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green at 2059 tests /
  471 suites (2057 pass, 2 Windows-only skips, 0 fail) with the docs-count
  gate at 2059; `npm run build` exit 0; `npm run check:bundle-budget` exit 0
  with the existing 20.375 kB gate (entry 20,817 B, 47 B headroom; startup
  312.1/320 kB); `check:no-inline-sql` clean (35 controllers),
  `check:no-raw-dialogs` clean (238 client files), `git diff --check` clean.

### Verification — Phase 3 slice 7 (payroll, overtime and statutory HR reports)

- `GET /api/hr/reports/payroll` returns session-scoped payroll cost by branch
  and pay period, overtime by employee/branch/department, and SSF/TDS filing
  per pay period. Every figure comes from stored `payroll_run_lines` snapshots;
  only `POSTED`/`PAID` runs are included, so a draft or approved run cannot
  contribute. Payroll cost exposes gross, basic, residual allowances, overtime,
  incentive, arrears, LOP, employee deductions and net; statutory exposes
  employee SSF, employer SSF, total SSF and TDS separately. No amount is
  re-derived from salary structures, and no unsupported metric is invented.
- The endpoint shares the workforce controller's strict filters and
  session-derived branch scope: `branchId=ALL`, another branch, repeated
  parameters, unknown filters and employee/user/tenant/document selectors are
  refused; invalid/reversed dates are 400; responses are `private, no-store`.
  Aggregate SQL remains in `server/src/models/hrReports.repo.ts`.
- The screen now renders Payroll cost, Overtime and SSF & TDS filing sections
  with the existing period presets, period/scope labels, branch/pay-period
  tables, overtime employee detail, explicit empty states and Refresh. Both
  report calls use the same selected period. This slice still showed the
  documented attrition-limitation notice; slice 8 below replaces it.
- **Limitation:** overtime department grouping uses the employee's current
  department because payroll lines snapshot employee name/code, not department.
  Run lines remain the immutable source for hours and paid amount.
- **Tests:** three new API tests assert exact computed cost/overtime/statutory
  values from seeded posted/paid/draft run rows, branch scoping and every
  rejection path; the mounted-screen test now asserts both aggregate calls,
  period/Refresh refetches, the new sections and their empty states. Full
  suite: 2062 tests / 471 suites — 2060 pass, 2 Windows-only skips, 0 fail;
  docs-count gate at 2062. The `hr-rpt-*` fixture cleanup leaves zero rows.
- **Numbers:** route table 97, feature screens 101 (90 table / 11 pinned
  elsewhere), permission operations 68.
- **Checks:** `npx tsc --noEmit` clean; `npm run build` exit 0; bundle gate
  entry 20,815 B against 20.375 kB (49 B headroom), startup 312.1/320 kB;
  `check:no-inline-sql` clean (35 controllers); `check:no-raw-dialogs` clean
  (238 client files); `git diff --check` clean.

### Verification — Phase 3 slice 8 (separations/attrition)

- **Schema:** `scripts/schema.sql` adds nullable `employees.separation_date_ad DATE`
  to the CREATE block and the runtime `ALTER TABLE` path, plus
  `idx_employees_branch_separation`. Applying the file to the local dev database
  succeeded before the report tests; the schema/drift guards confirm the live
  column matches the CREATE block. The field is AD-only, like the other master
  dates, so the finance dual-date write guard adds it to its per-column
  `COLUMN_EXEMPTIONS` rather than fabricating a BS half.
- **Employee API:** `POST/PATCH /api/employees` accept and return
  `separationDateAD`; a date before the effective joining date is a `400`, and
  PATCH can clear the date with `null` (a supplied-field boolean, rather than
  the COALESCE used by other nullable fields). The Employee Directory form,
  edit mapping, row display and client-side date check use the same field.
  Entering a separation date does not change `is_active`; status remains a
  separate explicit action.
- **Report:** `GET /api/hr/reports/workforce` counts employees whose stored
  `separation_date_ad` falls inside the inclusive selected period, grouped by
  current branch. The rate is separations ÷ period-start headcount among
  employees with a recorded joining date; an unknown joining-date count or a
  zero baseline returns `ratePercent:null` with a reason instead of an estimate.
  The endpoint keeps the existing strict filter/branch-scope/refusal contract,
  `private, no-store` caching and repository-only aggregate SQL.
- **Tests:** the API fixture stores one separation per branch and joining dates
  for every employee, asserting exact 2 separations, an 8-person baseline and
  25% overall/per-branch. A new API case proves inclusive period ends, an
  out-of-period zero, an unknown joining date producing a null rate and reason,
  and a pre-joining period producing the zero-baseline reason. Employee API
  tests prove create/update/clear and the before-joining `400`. The mounted UI
  proves the stored-date section, 25% rate, 2 separations, 8 baseline and
  branch rows, plus the empty-scope and zero-separation states.
- **Numbers:** full suite 2063 tests / 471 suites — 2061 pass, 2 Windows-only
  skips, 0 fail; docs-count gate at 2063. Route table 97, feature screens 101
  (90 table / 11 pinned elsewhere), permission operations 68; the report
  reuses `hr-employee-view`/`gl-payroll-manage`, so no operation changed.
- **Checks:** `npx tsc --noEmit` clean; `npm run build` exit 0; bundle budget
  exit 0 (entry 20,817 B / 20.3 kB gz against the 20.375 kB gate; startup
  312.1/320 kB); `check:no-inline-sql` and `check:no-raw-dialogs` clean;
  `git diff --check` clean. The `hr-rpt-*` fixture cleanup leaves zero rows. The
  screen was exercised by mounted DOM tests, not visually inspected in a browser.

### Verification — Phase 4 slice 3 (onboarding/offboarding checklists)

- **Schema:** `scripts/schema.sql` adds `hr_lifecycle_checklists` and
  `hr_lifecycle_checklist_items` (80 tables total) and the employee-custody
  columns/index on `fixed_assets`. The header owns a concrete `branch_id`
  derived from the employee; items carry no branch column. Statuses, types,
  categories and actions are CHECK-constrained, an active checklist is unique
  per employee/type, each asset appears once per checklist, and account actions
  are unique per checklist. Both tables carry `is_demo`; the demo cleanup lists
  items before the header and
  clears the lifecycle rows before `fixed_assets`.
- **API:** `/api/hr/lifecycle-checklists` serves list/detail/create/edit,
  complete, add-item and item-complete. Lists use session branch scope and
  refuse `ALL`, another branch, repeated/unknown filters and employee selectors;
  invalid dates are `400`; responses set `Cache-Control: private, no-store`.
  Create derives the branch from the employee and refuses a browser branch
  claim. Offboarding creation generates a return item for each assigned asset
  and a deactivation item for a linked account; onboarding generates an
  activation item. Item completion issues/returns the real fixed asset or
  activates/deactivates the linked account in the same transaction, with
  Super-Admin/self-deactivation refusals. Reads use `hr-employee-view` or
  `gl-payroll-manage`; every write is manage-gated and audited. `PATCH` cannot
  set `COMPLETED`; only the complete action does, after
  all required items are done, and every later write returns `409`.
- **Tests:** `tests/hrLifecycle.api.test.ts` drives real HTTP/PostgreSQL
  onboarding and offboarding flows, asset/account reconciliation, required-item
  gating, completion locks, branch refusals, cross-branch asset refusal,
  duplicate active checklists, strict filters and audit rows.
  `tests/hrLifecycle.ui.test.ts` mounts the screen with the dialog provider and
  proves summaries, generated asset/account items, item-completion confirmation,
  the create dialog, empty states, Refresh and the no-permission refusal without
  a read. Route/sidebar/refresh/preload/schema/branch-scope/demo-data/screen-count
  guards were updated.
- **Numbers:** full suite 2084 tests / 474 suites — 2082 pass, 2 Windows-only
  skips, 0 fail; docs-count gate at 2084. Route table 100, feature screens 104
  (93 table / 11 pinned elsewhere), permission operations 68; lifecycle reuses
  `hr-employee-view`/`hr-employee-manage`/`gl-payroll-manage`, so no operation
  changed.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green at 2084 tests /
  474 suites (2082 pass, 2 Windows-only skips, 0 fail; docs-count gate 2084);
  `npm run build` exit 0; bundle gate entry 20,914 B gzip (78 B headroom under
  the unchanged 20.5 kB gate) and startup 313.2 kB (320 kB gate); inline-SQL
  and raw-dialog guards clean; `git diff --check` clean. The `hr-life-*`
  fixture cleanup leaves zero rows. The screen was exercised by mounted DOM
  tests, not visually inspected in a browser.

### Verification — Phase 4 slice 2 (performance)

- **Schema:** `scripts/schema.sql` adds `hr_review_cycles`, `hr_goals` and
  `hr_review_feedback` (78 tables total). A cycle owns a concrete `branch_id`;
  goals and feedback carry a branch for scoped reads, but the API derives it
  from the cycle. Statuses and ratings are CHECK-constrained, goal weights are
  bounded to `(0, 100]`, feedback is unique per cycle/employee/reviewer, and
  the relationship CHECK requires SELF to name the subject and every other
  relationship to name a different employee. All three tables carry `is_demo`
  and are in the demo list child-first (`hr_review_feedback`, `hr_goals`,
  `hr_review_cycles`).
- **API:** `/api/hr/performance` serves cycle list/create/edit/sign-off, goal
  list/create/edit and feedback list/create. Lists use session branch scope and
  refuse `ALL`, another branch, repeated/unknown filters and employee/user/tenant
  selectors; invalid or reversed dates are `400`; responses set `Cache-Control:
  private, no-store`. Cycle edits cannot set `SIGNED_OFF`; only the sign-off
  action moves an `OPEN` cycle, and after that cycle edits, goal creates/edits
  and feedback creates all return `409`. Feedback is accepted only while the
  cycle is `OPEN` and is immutable afterwards. Goal/feedback branches come from
  the cycle, and the subject/reviewer must both belong to that branch. The
  controller audits every mutation and re-checks the manage grant.
- **Tests:** `tests/hrPerformance.api.test.ts` drives the real HTTP flow through
  cycle creation, goals, peer feedback, sign-off and every locked write, then
  proves branch refusals, strict filters, date reversal, draft-cycle feedback
  refusal, duplicate goal titles and self-feedback identity.
  `tests/hrPerformance.ui.test.ts` mounts the screen with the dialog provider
  and proves the summary/tables, weighted score, empty states, Refresh and the
  no-permission refusal without a read. The route registry, sidebar, refresh
  domain, preload, schema, branch-scope and demo-data guards were updated for
  the new screen and three tables.
- **Numbers:** full suite 2077 tests / 473 suites — 2075 pass, 2 Windows-only
  skips, 0 fail; docs-count gate at 2077. Route table 99, feature screens 103
  (92 table / 11 pinned elsewhere), permission operations 68; performance
  reuses `hr-employee-view`/`hr-employee-manage`/`gl-payroll-manage`, so no
  operation changed.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green at 2077 tests /
  473 suites (2075 pass, 2 Windows-only skips, 0 fail; docs-count gate 2077);
  `npm run build` exit 0; bundle budget exit 0 with entry 20.5 kB gz against the
  existing 20.5 kB gate and startup 313.1/320 kB; `check:no-inline-sql` and
  `check:no-raw-dialogs` clean; `git diff --check` clean. The `hr-perf-*`
  fixture cleanup leaves zero rows. The screen was exercised by mounted DOM
  tests, not visually inspected in a browser.

### Verification — Phase 4 slice 1 (recruitment)

- **Schema:** `scripts/schema.sql` adds `hr_recruitment_requisitions`,
  `hr_recruitment_candidates`, `hr_recruitment_interviews` and
  `hr_recruitment_offers`. Requisitions own a concrete `branch_id`; candidates
  and their child rows carry a branch for scoped reads, but the API derives it
  from the requisition/candidate rather than accepting a browser claim. The
  schema enforces one offer per candidate, one hired employee per candidate, a
  5 MiB resume ceiling and all-or-nothing resume metadata/content. Statuses are
  CHECK-constrained, and the tables are in the demo-data list in child-first
  order.
- **API:** `/api/hr/recruitment` serves requisition, candidate, interview and
  offer CRUD plus resume metadata/content and `POST
  /candidates/:id/hire`. Lists use session branch scope and refuse `ALL`, a
  cross-branch id, repeated/unknown filters and employee/user/tenant selectors;
  invalid or reversed dates are `400`; responses set `Cache-Control: private,
  no-store`. A closed or draft requisition cannot take candidates; a candidate
  cannot be moved between requisitions; a resume must exist before the upload
  metadata path returns it; final offer states are immutable. Hire locks the
  candidate and its offer, refuses unless the offer is `ACCEPTED`, and creates
  the employee from the offer's salary/start date plus the requisition's
  department/designation in one transaction. A second hire is refused.
- **Tests:** `tests/hrRecruitment.api.test.ts` exercises the real HTTP flow,
  branch refusals, offer-gated conversion and the resume round-trip;
  `tests/hrRecruitment.ui.test.ts` mounts the screen with the dialog provider
  and proves the summary/tables, explicit empty states, resume and hire states.
  The route registry, sidebar, refresh-domain, screen-preload, schema and
  branch-scope guards were updated for the new screen and four tables.
- **Numbers:** full suite 2070 tests / 472 suites — 2068 pass, 2 Windows-only
  skips, 0 fail; docs-count gate at 2070. Route table 98, feature screens 102
  (91 table / 11 pinned elsewhere), permission operations 68; recruitment
  reuses `hr-employee-view`/`hr-employee-manage`/`gl-payroll-manage`, so no
  operation changed.
- **Checks:** `npx tsc --noEmit` clean; full `npm test` green at 2070 tests /
  472 suites (2068 pass, 2 Windows-only skips, 0 fail; docs-count gate 2070);
  `npm run build` exit 0; bundle budget exit 0 with entry 20,886 B / 20.4 kB
  gz against the raised 20.5 kB gate and startup 312.6/320 kB;
  `check:no-inline-sql` and `check:no-raw-dialogs` clean; `git diff --check`
  clean. The `hr-rec-*` fixture cleanup leaves zero rows. The screen was
  exercised by mounted DOM tests, not visually inspected in a browser.

## Next action

Phase 4 is complete: requisitions, candidates, interviews, offers, stored
resumes, offer-gated hire, appraisal cycles, weighted goals/KPIs, 360 feedback
with sign-off locking, and onboarding/offboarding checklists tied to fixed
assets and linked user accounts. No Phase 4 work remains.

## Progress log

- **2026-11-10 — payroll bank-detail snapshot hardening.** Added nullable
  `bank_name`/`bank_account` to `payroll_run_lines`, with a one-time backfill
  for existing databases. Generated drafts and manual runs snapshot the
  employee's bank details at preparation, and posted payslips, the register and
  the bank CSV read that snapshot instead of the live employee master. Generic
  run-line payloads still omit bank fields. `tests/hrPayrollRun.api.test.ts`
  clears the employee's bank account after posting and proves the bank file and
  payslip remain unchanged. The migration was applied to the dev database; the
  focused payroll output test and schema guard are part of the final gates.
- **2026-11-09 — Phase 4 slice 3: onboarding/offboarding checklists.**
  - Added the two branch-custody lifecycle tables, employee custody on
    `fixed_assets`, repository SQL/projections, strict branch-scoped routes,
    generated asset/account items, transactional issue/return and account
    activation/deactivation, required-item completion gates and the irreversible
    `COMPLETED` lock.
  - Added **People & HR → Onboarding** at `/people/lifecycle` with summary
    cards, checklist and item tables, create/edit and item dialogs, item
    completion confirmation, explicit empty states and Refresh.
  - Extended route/sidebar/refresh/preload/schema/branch-scope/demo-data/screen
    coverage and added real HTTP/PostgreSQL and mounted UI tests. Full suite:
    2084 tests / 474 suites (2082 pass, 2 Windows-only skips); docs-count gate
    at 2084.
  - The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 4 slice 2: performance.**
  - Added the three branch-custody tables, repository SQL/projections, strict
    branch-scoped routes, goal/feedback validation and the irreversible
    sign-off lock. Child rows inherit the cycle branch; feedback is immutable
    and unique per reviewer/subject.
  - Added **People & HR → Performance** at `/people/performance` with summary
    cards, cycle/goal/feedback tables, weighted score, create/edit and feedback
    dialogs, sign-off confirmation, explicit empty states and Refresh.
  - Extended route/sidebar/refresh/preload/schema/branch-scope coverage and
    added real HTTP and mounted UI tests. Full suite: 2077 tests / 473 suites
    (2075 pass, 2 Windows-only skips); docs-count gate at 2077.
  - The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 4 slice 1: recruitment.**
  - Added the four branch-custody tables, repository SQL/projections, strict
    branch-scoped routes, resume upload/download and the transactional
    offer-gated hire path. Candidate/interview/offer branches are inherited,
    not client-supplied; offers are one-per-candidate and final states are
    immutable.
  - Added **People & HR → Recruitment** at `/people/recruitment` with summary
    cards, requisition/pipeline/interview/offer tables, create/edit and candidate
    dialogs, resume upload/download, interview scheduling, offer lifecycle and
    hire, plus explicit empty states and Refresh.
  - Extended route/sidebar/refresh/preload/schema/branch-scope coverage and
    added real HTTP and mounted UI tests. Full suite: 2070 tests / 472 suites
    (2068 pass, 2 Windows-only skips); docs-count gate at 2070.
  - The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 8: employee separations and attrition.**
  - Added `employees.separation_date_ad` through the schema source of truth,
    exposed it on employee create/update/read (including clear-on-PATCH), and
    added the field to the Employee Directory with the before-joining check and
    row display. Entry is independent of `is_active`.
  - The workforce report now counts stored separation dates in the inclusive
    period, groups by current branch, reports period-start headcount and returns
    a null rate with a reason when joining dates are incomplete or the baseline
    is zero. The screen renders the count/rate/baseline, branch table and
    explicit empty states; the existing strict filters, branch scope, private
    caching and repository-only SQL are unchanged.
  - Extended the API fixture/assertions and added edge-case coverage for period
    boundaries, unknown joining dates and zero baseline; extended the employee
    API tests for create/update/clear/validation and the mounted UI for the
    stored-date and zero-separation states. Full suite: 2063 tests / 471 suites
    (2061 pass, 2 Windows-only skips); docs-count gate at 2063. Build, bundle,
    guards and diff checks are recorded in the verification section above.
  - The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 7: payroll, overtime and SSF/TDS HR reports.**
  - Added `GET /api/hr/reports/payroll` under the existing
    `hr-employee-view`/`gl-payroll-manage` reads. It returns payroll cost by
    branch/period, overtime by employee/branch/department and SSF/TDS filing by
    period from POSTED/PAID `payroll_run_lines` snapshots. Draft/approved runs
    are excluded; allowance residuals, employee deductions and employer SSF
    are kept distinct. The controller reuses the workforce strict filters,
    session branch scope, invalid-date handling and private caching; aggregate
    SQL is in `server/src/models/hrReports.repo.ts`.
  - Extended **People & HR → HR Reports** at `/people/reports` with all three
    sections, payroll summary cards, grouping tables, explicit empty states and
    the existing period/scope/Refresh/permission behavior. Both report calls
    share the selected period; the screen surface pin and mounted tests were
    updated.
  - Added three API tests and extended the mounted-UI test for both aggregates.
    Final counts: 97 routes, 101 screens (90/11), 68 operations, 2062 tests /
    471 suites (2060 pass, 2 Windows-only skips). Build exit 0; bundle gate
    unchanged at 20.375 kB (entry 20,815 B, 49 B headroom; startup 312.1/320
    kB); both source guards and `git diff --check` clean. The `hr-rpt-*`
    fixture cleanup leaves zero rows. The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 6: read-only workforce HR reports.**
  - Added `GET /api/hr/reports/workforce`, gated on the existing
    `hr-employee-view`/`gl-payroll-manage` reads. It returns session-scoped
    current active headcount by branch/department, the selected period and
    current-year leave liability in days. At this slice attrition was explicitly
    unavailable because `employees` had no separation/termination date; no
    number was inferred from `is_active` or `updated_at`. The endpoint refuses
    `branchId=ALL`, another branch, repeated branch/date parameters, unknown
    filters and employee/user/tenant/document selectors, validates dates, sets
    `Cache-Control: private, no-store`, and keeps every aggregate in
    `server/src/models/hrReports.repo.ts`.
  - Added **People & HR → HR Reports** at `/people/reports`, a lazy read-only
    screen with period presets, branch/department tables, leave totals, explicit
    empty states, the then-current attrition limitation and Refresh; route, nav, preload,
    permission and coverage wiring updated. Cost, overtime and SSF/TDS sections
    are deliberately not stubbed.
  - Added `tests/hrReports.api.test.ts` (4 tests) and
    `tests/hrReports.ui.test.ts` (4 tests). Final counts: 97 routes, 101 screens
    (90/11), 68 operations, 2059 tests / 471 suites (2057 pass, 2 Windows-only
    skips). Build exit 0; bundle gate unchanged at 20.375 kB (entry 20,817 B,
    47 B headroom; startup 312.1/320 kB); both source guards and
    `git diff --check` clean. The `hr-rpt-*` fixture cleanup leaves zero rows.
    The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 5: read-only employee self-service documents.**
  - Added `GET /api/hr/self-service/documents` under the existing
    `hr-self-service` operation. It resolves `employees.user_id`, returns only
    the caller's vault metadata with a 30-day expiry state and a summary
    derived from those rows, and builds a relative content URL. It sets
    `Cache-Control: private, no-store`, refuses employee/user/document-id
    selectors, `branchId=ALL` and another branch, and has no write path. The
    existing content route now admits ESS only for the caller's own linked
    employee. No schema change.
  - Added **People & HR → My Documents** at `/people/documents`, a lazy
    read-only summary/table screen with Refresh, download, empty/error states
    and a no-endpoint refusal state; route, nav, preload, permission and
    coverage wiring updated.
  - Added `tests/hrSelfServiceDocuments.api.test.ts` (3 tests) and
    `tests/hrSelfServiceDocuments.ui.test.ts` (4 tests), and updated route,
    screen, nav and permission pins. Final counts: 96 routes, 100 screens
    (89/11), 68 operations, 2051 tests / 470 suites (2049 pass, 2 Windows-only
    skips). The full suite is green with the docs gate at 2051; build, bundle
    budget (entry 20,748 B / 20.375 kB after the deliberate move, startup
    311.8/320 kB), both guards and `git diff --check` are clean. The `ess-doc-*`
    fixture cleanup leaves zero rows. The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 4: read-only employee self-service attendance.**
  - Added `GET /api/hr/self-service/attendance` under the existing
    `hr-self-service` operation. It resolves `employees.user_id`, returns only
    the caller's attendance for the rolling 90 days ending today (today plus
    the previous 89 days), newest first, and derives its summary from those
    rows. It sets `Cache-Control: private, no-store`, refuses employee/user
    selectors, `branchId=ALL`, another branch and a record-id path, and has no
    clock/edit/approval path. No schema change.
  - Added **People & HR → My Attendance** at `/people/attendance`, a lazy
    read-only window/summary/records screen with a no-endpoint refusal state;
    route, nav, preload, permission and coverage wiring updated. Moved the HR
    management register to `/people/attendance-register`.
  - Added `tests/hrSelfServiceAttendance.api.test.ts` (2 tests) and
    `tests/hrSelfServiceAttendance.ui.test.ts` (3 tests), and updated route,
    screen, nav and permission pins. Final counts: 95 routes, 99 screens
    (88/11), 68 operations, 2044 tests / 469 suites (2042 pass, 2 Windows-only
    skips). `npx tsc --noEmit`, full `npm test`, `npm run build`,
    `npm run check:bundle-budget`, `check:no-inline-sql`,
    `check:no-raw-dialogs` and `git diff --check` are clean; the `ess-att-*`
    fixture cleanup leaves zero rows. The tree remains uncommitted on `main`.

- **2026-11-09 — Phase 3 slice 3: read-only employee self-service leave.**
  - Added `GET /api/hr/self-service/leave` under the existing
    `hr-self-service` operation. It resolves `employees.user_id`, returns only
    the caller's balances with used days derived from APPROVED requests in the
    same year, plus pending/approved/rejected/cancelled request history. It
    sets `Cache-Control: private, no-store`, refuses employee/user selectors
    and `branchId=ALL`/another branch, and has no apply/cancel/approval path.
    No schema change.
  - Added **People & HR → My Leave** at `/people/leave`, a lazy read-only
    balance/history screen with a no-endpoint refusal state; route, nav,
    preload, permission and coverage wiring updated.
  - Added `tests/hrSelfServiceLeave.api.test.ts` (2 tests) and
    `tests/hrSelfServiceLeave.ui.test.ts` (3 tests), and updated route, screen,
    nav and permission pins. Final counts: 94 routes, 98 screens (87/11), 68
    operations, 2039 tests / 468 suites (2037 pass, 2 Windows-only skips).
    `npx tsc --noEmit`, full `npm test`, `npm run build`,
    `npm run check:bundle-budget`, `check:no-inline-sql`,
    `check:no-raw-dialogs` and `git diff --check` are clean; the `ess-leave-*`
    fixture cleanup leaves zero rows. The tree remains uncommitted on `main`.
- **2026-11-09 — Phase 3 slice 2: read-only employee self-service payslips.**
  - Added `GET /api/hr/self-service/payslips` under the existing
    `hr-self-service` operation. It resolves `employees.user_id`, joins
    immutable `payroll_run_lines` snapshots to their runs, filters to
    POSTED/PAID, reuses the existing payslip projection, returns newest first,
    sets `Cache-Control: private, no-store` and refuses employee/user selectors
    plus `branchId=ALL` or another branch. No schema change.
  - Added **People & HR → My Payslips** at `/people/payslips`, a lazy read-only
    list and detail screen with a default newest payslip and a no-endpoint
    refusal state; route, nav, preload and permission wiring updated.
  - Added `tests/hrSelfServicePayslips.api.test.ts` (2 tests) and
    `tests/hrSelfServicePayslips.ui.test.ts` (3 tests), and updated route,
    screen, nav and permission pins. Final counts: 93 routes, 97 screens
    (86/11), 68 operations, 2034 tests / 467 suites (2032 pass, 2 Windows-only
    skips). `npx tsc --noEmit`, full `npm test`, `npm run build`,
    `npm run check:bundle-budget`, `check:no-inline-sql`,
    `check:no-raw-dialogs` and `git diff --check` are clean; the `ess-pay-*`
    fixture cleanup leaves zero rows. The tree remains uncommitted on `main`.
- **2026-11-09 — Phase 3 slice 1: read-only employee self-service profile.**
  - Added `GET /api/hr/self-service/profile` under the new `hr-self-service`
    operation (not `gl-view`). The dedicated projection resolves
    `employees.user_id` from the authenticated account, returns only that
    employee's own master/contact/statutory/bank/salary fields plus
    `branchName`, sets `Cache-Control: private, no-store`, and has no write
    path. `employeeId`, `userId`/`user_id` and `branchId=ALL` or another branch
    are explicit 403s; the controller repeats the permission check and
    re-applies `allowedBranchScope` to the linked employee's branch.
  - Added **People & HR → My Profile** at `/people/profile`, a lazy read-only
    screen gated on `hr-self-service`, with its own sidebar item so an account
    without the employee-master grants still reaches it. No employee picker, no
    branch picker and no save/upload control.
  - Added the operation to the default matrix for every role (both HR roles
    included) and to Permission Management's People & HR group; a per-user
    override can deny it without touching the employee-master grants.
  - **Judgment call:** the Phase 3 note lists profile, payslips, leave,
    attendance and documents. This slice ships only the read-only profile; the
    others remain explicitly open rather than being partially invented.
  - Verified: `npx tsc --noEmit` clean; ESS API 2/2 and UI 3/3; targeted guards
    106/106 across 17 suites; full `npm test` 2029 tests, 2027 pass, 2
    Windows-only skips, 0 fail, 466 suites, exit 0; docs-count gate 3/3 at
    2029; build and bundle budget exit 0; inline-SQL (34 controllers),
    raw-dialog (233 files) and `git diff --check` clean; ESS fixture rows zero.

- **2026-11-09 — Phase 2 complete: Finance payroll-postings register.**
  - Added read-only `GET /api/payroll-runs/postings` for Finance. It is
    `gl-view` only, branch-scoped, accepts an AD run-date window and a bounded
    run/period/branch query, and returns POSTED/PAID runs only. DRAFT and
    APPROVED runs are excluded rather than shown with a badge.
  - Each row carries the immutable run snapshot: gross, incentive, arrears,
    TDS, SSF, advances, loans and net, plus the employee count and both linked
    posting/payment journals. No line detail or employee PII is read; the
    existing per-run register remains the line-level view.
  - Added **Finance & Accounting → Payroll Postings** at
    `/finance/payroll-postings` with branch, AD date-range and search filters,
    client-side paging, exact two-decimal money formatting and the same
    permission refusal used by the Finance registers.
  - **Judgment call:** the note did not specify a route path or whether
    unposted runs should appear. The narrower reading was used: a dedicated
    `gl-view` route and posted-only rows, with no new write or approval path;
    line-level detail stays on the existing run register.
  - API coverage proves the snapshot amounts, journal links, POSTED and PAID
    rows, DRAFT/APPROVED exclusion, `gl-view`-only refusal, cross-branch
    refusal, `ALL` refusal, invalid date windows and zero run/journal mutation.
    UI coverage mounts the real route and a direct refusal, and pins the route,
    preload, snapshot columns, formatting and absence of payroll write actions.
  - Verified: full `npm test` — 2024 tests, 2022 pass, 2 Windows-only skips,
    0 fail, 465 suites, exit 0; docs-count gate 3/3 at 2024. Targeted checks,
    build/budget and guard results are in “Verification — Phase 2 slice 7” above.

- **2026-11-09 — Phase 2 slice 6 landed (incentives, arrears and recoveries).**
  - Added `hr_payroll_adjustments`, one period-scoped row per employee for
    incentive, arrears, advance and loan amounts. `PUT /api/hr/payroll-inputs`
    is HR-manage/legacy-payroll gated, derives branch scope from the employee,
    validates non-negative two-decimal amounts and upserts with an audit row.
    `GET /api/hr/payroll-inputs` exposes the row beside the derived attendance
    inputs when the selected range is one calendar month.
  - The generated draft adds incentives and arrears after LOP-prorated salary
    and OT, includes them in taxable gross/TDS, then subtracts SSF/TDS/advance/
    loan for net. The line and run header snapshot the new amounts; later input
    edits cannot rewrite a generated run. Payslips, register, PDF, payroll
    register/show detail and the Payroll Inputs tab display/edit them.
  - API coverage includes the happy path, upsert, list/scoping, officer and
    auditor refusals, cross-branch refusal, negative/bad-period 400s, audit
    count, balanced posted journal with recoveries, and snapshot immutability.
  - Verified: full `npm test` — 2021 tests, 2019 pass, 2 Windows-only skips,
    0 fail, 465 suites; docs-count gate 3/3 at 2021; `npx tsc --noEmit` clean;
    build exit 0; bundle budget entry 19.9/20 kB gz and startup 311.0/320 kB gz;
    inline-SQL 33 controllers, raw-dialog 231 files and `git diff --check`
    clean.
- **2026-11-09 — Phase 2 slice 4 landed (payslips and payroll register).**
  - Added posted-only `GET /api/payroll-runs/:id/payslips`,
    `GET /api/payroll-runs/:id/payslips/:employeeId` and
    `GET /api/payroll-runs/:id/register`. All three derive from
    `payroll_run_lines`, repeat the run-read gate and branch scope, and refuse
    DRAFT/APPROVED runs with a 409. Bank, PAN and SSF fields follow the same
    manage-grant masking as employee reads.
  - The register returns gross, TDS, employee/employer SSF, advances, loans,
    net pay and run-level totals, the linked posting/payment journal amounts and
    explicit reconciliation flags. Payslips add basic, allowances, OT, LOP,
    deductions, employer cost and the fiscal-year code.
  - **Payroll & Salary** now exposes Register and Payslips from a POSTED/PAID
    run detail, with printable documents and clipboard export; the existing
    PDF payslip endpoint uses the same posted-only loader and masked employee
    projection.
  - Verified: `npx tsc --noEmit` (0), full `npm test` (2019 tests: 2017 pass,
    2 Windows-only skips, 0 fail, exit 0; docs-count gate 3/3), posted-output
    API/UI/finance targeted suites (12 pass), feature-screen coverage (44 pass;
    94 total / 83 table / 11 pinned elsewhere), inline-SQL (33 controllers) and
    raw-dialog (231 files) guards clean, build (0), bundle budget (entry
    19.9/20 kB gz, startup 310.9/320 kB gz), `git diff --check` clean. Browser
    check on a paid run
    reconciled the register to the posting and payment journals and exposed
    both payslip views; fixture rows were removed with zero leftovers.
- **2026-11-09 — Phase 2 slice 5 landed (bank disbursement file).**
  - Added manage-only `GET /api/payroll-runs/:id/bank-file`. It reuses the
    posted-only output loader, refuses masked callers and missing bank details
    with a 403/409, and streams a bank CSV with employee code, beneficiary,
    bank, account, net pay and narration. The Payroll outputs modal exposes
    Bank file only to manage roles and reports the downloaded filename.
  - Live paid-run check returned `payroll-bank-file-PR-KTM-202612310002.csv`
    with one beneficiary, account `WEB-ACC-9101`, net 91,560.00, `text/csv`,
    `no-store` and the correct attachment name; the modal reported the
    download. The fixture was deleted with zero leftover employee, salary, run,
    line, journal and audit rows.
  - Verified: target payroll/UI/finance/screen suites 56 pass / 8 suites; full
    `npm test` 2019 tests, 2017 pass, 2 Windows-only skips, 0 fail, 465 suites,
    exit 0; build 0; bundle 19.9/20 kB gz entry and 311.0/320 kB gz startup;
    inline-SQL 33 controllers, raw-dialog 231 files, docs-count 3/3 at 2019 and
    `git diff --check` all clean.
- **2026-11-09 — Phase 2 slice 3 landed (generated payroll runs).**
  - Added the generated-draft path over the existing payroll tables: statuses
    `DRAFT`/`APPROVED`/`POSTED`/`PAID` (plus the existing `CANCELLED`),
    prepared/approved metadata, the statutory-config link and immutable line
    snapshots (salary id, basic, payable/LOP days, LOP deduction, OT hours and
    amount, employee/employer SSF). The manual direct-post endpoint is unchanged.
  - `POST /api/payroll-runs/draft` computes the month from active employees,
    their effective salary structure, attendance/OT and the fiscal-year TDS/SSF
    config. Basic is prorated by payable days; LOP is gross × LOP days ÷ month
    days; gross is earnings − LOP + OT; employee SSF reduces taxable gross; TDS
    uses progressive monthly slabs. The temporary `DRAFT-*` number becomes
    `PR-*` only when posted, and a draft writes no journal.
  - `POST /api/payroll-runs/:id/approve`, `/post` and `/pay` enforce
    DRAFT → APPROVED → POSTED → PAID; only an unapproved DRAFT can be discarded
    with `DELETE /api/payroll-runs/:id`. HR prepares/discards; Finance
    approves/posts/pays. Run reads accept `gl-view` or the HR/payroll grants so
    HR can follow the draft it prepared, while payment still requires `POSTED`.
  - **Payroll & Salary** gained a run list, status actions, branch/month
    controls and a line-snapshot detail table. Run reads are hidden from roles
    without a read grant, and the panel follows the same permission split.
  - Live browser check at `/people/payroll`: a temporary employee
    (`WEB-PAY-01`) and its 2026-11-09 structure (gross 100,000, basic 60,000,
    HRA 40,000, SSF eligible) produced taxable 93,400, employee SSF 6,600,
    employer SSF 12,000, TDS 1,840 and net 91,560. The manager generated a
    November DRAFT (gross 100,000, TDS 1,840, SSF 6,600, net 91,560) with
    Approve/Discard controls; the auditor saw the same run and line snapshot
    with an empty Actions cell and no Generate/Approve/Discard, Add Structure or
    Tax & SSF Rules control. The manager discarded the draft, then the fixture
    employee, salary structure, run and matching audit rows were deleted;
    leftover counts are zero.
  - Verified: `npx tsc --noEmit` (0), generated-run API (4 pass), targeted
    lifecycle/statutory/manual-payroll/finance/UI suites (81 pass / 13 suites),
    full `npm test` (2019 tests: 2017 pass, 2 Windows-only skips, exit 0), build
    (0), bundle budget (entry 19.9/20 kB gz, startup 310.8/320 kB gz), inline-SQL
    (33 controllers) and raw-dialog (230 files) guards clean, `git diff --check`
    clean. Schema applied and confirmed live; temporary fixture rows removed.
- **2026-11-08 — Phase 2 slice 2 landed (fiscal-year TDS/SSF).**
  - Added `hr_statutory_configs` (one row per fiscal year, employee/employer
    SSF rates) and `hr_tds_slabs` (progressive monthly lower/upper/rate bands)
    with CHECKs, a unique fiscal-year key, ordered-slab uniqueness, indexes and
    an idempotent FY 2083-84 seed. Reads follow the HR view grants; creates and
    corrections require `hr-employee-manage` or legacy `gl-payroll-manage` AND
    a global account, rechecked in the controller, with audits in the same
    transaction.
  - `GET/POST/PATCH /api/hr/statutory-configs` version rules by fiscal year and
    validate a complete progressive table (starts at 0, contiguous, exactly one
    open-ended top, no duplicate bounds, rates 0–100) as 422s. A duplicate
    fiscal-year config is a 422, never an overwrite.
  - `GET /api/hr/employee-salaries/:id/statutory?asOf=` resolves the effective
    structure, fiscal year and config, then returns gross, basic,
    employee/employer SSF, taxable gross, applied bands, monthly and annual TDS,
    net and line items. Employee SSF reduces taxable gross; employer SSF is
    company cost. A missing fiscal year, missing config and a pre-effective
    date are 422s.
  - **Payroll & Salary** shows the breakdown for the selected structure and
    as-of date, and global managers get a **Tax & SSF Rules** editor; view-only
    roles get numbers only.
  - Verified: `npx tsc --noEmit` (0), statutory API (5 pass), full API suite
    (209 pass / 31 suites), full `npm test` (2013 tests: 2011 pass, 2
    Windows-only skips, exit 0), guards (57 pass / 10 suites), build (0), bundle
    budget (entry 19.9/20 kB gz, startup 310.7/320 kB gz), UI sweep (39 pass /
    23 suites), inline-SQL (33 controllers) and raw-dialog (230 files) guards
    clean, `git diff --check` clean. Schema applied and confirmed live; the
    screen was inspected as a manager and as a view-only auditor; fixture rows
    were removed and leftover counts are zero.
- **2026-11-08 — Phase 2 slice 1 landed (effective-dated salary structure).**
  - Added `hr_employee_salary` (employee, branch, effective date, SSF
    eligibility, OT rate, monthly TDS) and `hr_salary_components` (component
    code/name/kind/amount, taxable and SSF flags, order). One structure per
    employee + effective date; a newer row supersedes an older one from its
    date, and history is retained.
  - `GET /api/hr/employee-salaries` resolves the newest structure on or before
    `asOf` (history without it), with branch-intersected lists and by-id
    reads. `POST` creates (monthly gross defaults to BASIC 60% / HRA 40%, or
    explicit components) and `PATCH` edits the header or replaces components.
    Reads are `hr-employee-view`/`hr-employee-manage`/legacy
    `gl-payroll-manage`; writes are `hr-employee-manage`/legacy, repeated in
    the controller. The branch is derived from the employee, and the by-id
    route is in the branch-scope registry.
  - **People & HR → Payroll & Salary** at `/people/payroll` is a new lazy screen
    with an as-of date, history toggle, totals, manager-only Add/Edit and a
    read-only note for view roles. Route registry, sidebar, tab permission,
    screen preload and the 90-screen guards are updated.
  - Verified: `npx tsc --noEmit` (0), salary API (5 pass), full API suite (204
    pass / 30 suites), guards (57 pass / 10 suites), build (0), bundle budget
    (entry 19.9/20 kB gz, startup 310.6/320 kB gz), UI sweep (39 pass / 23
    suites), inline-SQL (32 controllers) and raw-dialog (230 files) guards
    clean, `git diff --check` clean. Schema applied and confirmed live; the
    screen was inspected as a manager and as a view-only auditor, and fixture
    rows were removed.
- **2026-11-08 — Phase 1 slice 3 landed (payroll inputs); Phase 1 complete.**
  - Added a read-only `GET /api/hr/payroll-inputs?from=&to=&branchId=&employeeId=`
    under the HR read grants. It returns one row per active employee in the
    caller's branch scope with present/half/absent/attendance-leave/holiday/
    weekend days, paid and unpaid approved-leave days, payable days, LOP days
    and OT hours.
  - The model is derived on read, with no materialised counter: attendance
    rows inside the period are authoritative; approved leave fills only days
    without an attendance row; leave is clipped to the period; paid types add
    to payable and unpaid types to LOP; pending/rejected/cancelled requests
    contribute nothing; OT is the sum of recorded hours. A corrected attendance
    day or a cancelled request therefore changes the figures immediately.
  - **People & HR → Attendance & Leave** gained a Payroll Inputs tab using the
    same From/To period filter; it renders read-only for every role that can
    read the screen, with no write controls.
  - Verified: `npx tsc --noEmit` (0), payroll API (18 pass), full API suite
    (199 pass / 29 suites), guard suites (57 pass / 10 suites: finance micro 6
    with 67 operations, sidebar grouping, app paths/route/screen counts stay at
    89), `npm run build` (0), bundle budget (entry 19.8/20 kB gz, startup
    310.4/320 kB gz), UI sweep (39 pass / 23 suites), inline-SQL (31
    controllers) and raw-dialog (229 files) guards clean, `git diff --check`
    clean. No schema change was needed; the existing columns were confirmed in
    the live database. The leave and payroll tabs were inspected in the running
    app as a manager and as a view-only auditor, and the temporary demo rows
    were removed afterwards.
- **2026-11-08 — Phase 1 slice 2 landed (leave balances and approvals).**
  - Added `hr_leave_balances` (one row per employee + leave type + year,
    entitlement/adjustment with CHECKs and a unique key) and
    `hr_leave_requests` (request number, inclusive AD/BS dates, day count,
    `PENDING`/`APPROVED`/`REJECTED`/`CANCELLED` status CHECK, decider and
    timestamp). Both carry the employee-derived `branch_id`.
  - Added `GET/POST/PATCH /api/hr/leave-balances` and `GET/POST
    /api/hr/leave-requests` plus `POST /api/hr/leave-requests/:id/approve`,
    `/reject` and `/cancel`. Reads accept `hr-employee-view`,
    `hr-attendance-manage` or `gl-payroll-manage`; writes require
    `hr-attendance-manage` or the legacy grant, and the controller repeats the
    check so a bypassed route guard still 403s. Lists and by-id reads
    intersect the caller's branches; another branch's balance or request
    answers 403/404.
  - Used days derive from approved requests, so approval spends the balance and
    reject/cancel returns it without a stored counter. Creation validates the
    range, the one-calendar-year span and overlap (excluding
    rejected/cancelled rows); approval alone checks sufficiency; a per-employee
    advisory lock serializes creation, and status-guarded updates prevent a
    double decision. Every mutation writes its audit row in the same
    transaction.
  - **People & HR → Attendance & Leave** gained Leave Requests and Balances
    tabs with a status filter and year selector; approve/reject/create/edit
    controls render only for attendance managers.
  - Verified: `npx tsc --noEmit` (0), payroll API (17 pass), full API suite
    (198 pass / 29 suites), guard suites (57 pass / 10 suites: finance micro 6
    with 67 operations, sidebar grouping, app paths/route/screen counts stay at
    89), `npm run build` (0), bundle budget (entry 19.8/20 kB gz, startup
    310.3/320 kB gz), UI sweep (39 pass / 23 suites), inline-SQL (30
    controllers) and raw-dialog (229 files) guards clean, `git diff --check`
    clean. The schema was applied to the dev database and both tables/columns
    confirmed present. The tabs were not visually inspected in a browser.
- **2026-11-08 — Phase 1 slice 1 landed (attendance foundation).**
  - Added `hr_shifts` and `hr_leave_types` (company-wide catalogues) plus
    `hr_holidays` and `hr_attendance` (branch custody, unique per branch+date
    and employee+date). Attendance stores the AD date and its BS display, shift,
    status (`PRESENT`/`ABSENT`/`LEAVE`/`HALF_DAY`/`HOLIDAY`/`WEEKEND`), in/out
    times, OT hours, note, source and recorder.
  - Added `GET/POST/PATCH /api/hr/shifts` and `/api/hr/leave-types`,
    `GET/POST/DELETE /api/hr/holidays`, and `GET/POST/DELETE
    /api/hr/attendance` plus `POST /api/hr/attendance/import`. Reads accept
    `hr-employee-view`, `hr-attendance-manage` or `gl-payroll-manage`; writes
    require `hr-attendance-manage` or the legacy grant. Every mutation and its
    audit row share one transaction.
  - A manual attendance save derives the branch from the employee; the CSV
    importer resolves HRMS ID → employee, shift code, AD/BS date and status,
    upserts every valid row and reports the skipped rows by sheet line.
  - New **People & HR → Attendance & Leave** at `/people/attendance` (now
    `/people/attendance-register`) with Daily Attendance, Shifts, Holidays and
    Leave Types tabs; add/edit/import controls
    render only for attendance managers, and the sidebar entry sits behind the
    same read grants.
  - Verified: `npx tsc --noEmit` (0), payroll API (16 pass), full API suite
    (197 pass / 29 suites), guard suites (54 pass / 9 suites: finance micro 6
    with 67 operations, sidebar grouping, app paths and route/screen counts at
    89 routes), `npm run build` (0), bundle budget (entry 19.8/20 kB gz, startup
    310.2/320 kB gz), UI sweep (39 pass / 23 suites), inline-SQL and raw-dialog
    guards clean, `git diff --check` clean. The screen was not visually
    inspected in a browser.
- **2026-11-08 — Phase 0 slice 1 landed.**
  - `employees` extended with the master fields: employment type, joining/DOB/
    contract dates, designation code, work station, address, personal/emergency
    contacts, internal/personal e-mail, bank name, monthly salary reference and
    SSF eligibility.
  - `GET/POST/PATCH /api/employees` read and validate the new fields; the slim
    picker is unchanged.
  - New **People & HR → Employee Directory** at `/people/employees`, with branch
    filter, search, add/edit, activate/deactivate and PII only for managers.
  - Verified: `npx tsc --noEmit` (0), nav/paths/route tests (36 pass), payroll
    API suite (10 pass, including new master fields), `npm run build` (0),
    bundle budget (entry 19.6/20 kB gz, startup 308.6/320 kB gz), UI sweep
    (4 pass). The screen was not visually inspected in a browser.
- **2026-11-08 — Phase 0 slice 2 landed.**
  - Added `hr-employee-view` and `hr-employee-manage` defaults and a **People &
    HR** permission group; employee reads/writes accept these or the legacy
    `gl-payroll-manage`, so existing matrices keep working.
  - Added nullable unique `employees.user_id` (FK to `users`, `ON DELETE SET
    NULL`), one-employee-per-account validation, a bounded active-account
    options endpoint, and a link picker in the Employee Directory.
  - Verified: `npx tsc --noEmit` (0), finance micro-permissions (6 pass),
    payroll API (11 pass), permission suites (51 pass), `npm run build` (0),
    bundle budget (entry 19.6/20 kB gz, startup 308.9/320 kB gz).
- **2026-11-08 — Phase 0 slice 3 landed.**
  - Registered `HR_MANAGER` (view + manage) and `HR_OFFICER` (view only) in the
    role whitelist, server role validator, matrix defaults, user role picker and
    both permission screens; existing tenants get the expanded `users.role`
    constraint from the schema migration.
  - Added one PII policy for employee reads: list, detail and employee-ledger
    responses null PAN, SSF, bank, salary, DOB, address, personal/emergency
    contacts and personal e-mail for `hr-employee-view`-only callers. The manage
    grant and the legacy `gl-payroll-manage` grant receive full detail. The new
    account-options endpoint remains manage-only.
  - Verified: `npx tsc --noEmit` (0), finance micro-permissions (6 pass),
    payroll API (12 pass), permission/nav suites (87 pass), `npm run build` (0),
    bundle budget (entry 19.6/20 kB gz, startup 309.0/320 kB gz), UI sweep
    (4 pass). The screen was not visually inspected in a browser.
- **2026-11-08 — Phase 0 slice 4 landed.**
  - Added `hr_org_masters` (`kind`, `code`, `name`, `is_active`, audit
    timestamps) with unique per-kind code/name indexes rather than three
    near-identical tables. Kind is immutable after creation.
  - `GET /api/hr/org-masters` (read, `activeOnly` filter), `POST` and `PATCH`
    (manage) under the `hr-employee-view` / `hr-employee-manage` gates, with the
    legacy payroll grant still accepted and every mutation audited.
  - New **People & HR → Org Masters** screen at `/people/org-masters` with one
    tab per kind; add, rename/recoded, deactivate and reactivate behind manage
    rights. Employee Directory department/designation/work-station inputs now
    offer the active entries as datalists but still save free text.
  - Verified: `npx tsc --noEmit` (0), payroll API (13 pass), finance
    micro-permissions (6 pass), nav/route/screen suites (36 pass, 88 routes),
    `npm run build` (0),    bundle budget (entry 19.7/20 kB gz, startup 309.2/320 kB gz), UI sweep
    (4 pass), sidebar grouping (pass). Neither HR
    screen was visually inspected in a browser.
- **2026-11-08 — Phase 0 slice 5 landed.**
  - Added `hr_employee_documents`: employee FK with `ON DELETE CASCADE`, a typed
    document kind, original name/MIME/size, generated storage key, optional
    expiry and note, `BYTEA` content, uploader and timestamp. The schema CHECK
    caps a document at 5 MiB and the handler caps an employee at 20 files.
  - `GET /api/employees/:id/documents` returns metadata under the view grant;
    `POST` (raw body, metadata in the query), `GET .../content` and `DELETE`
    require the manage grant or the legacy payroll grant. Writes are audited in
    the same transaction, and a document outside the caller's branches answers
    404 rather than confirming it exists.
  - The Employee Directory gained a per-row **Documents** action opening a
    dialog: everyone with view rights sees the metadata list, managers get
    upload (PDF/PNG/JPEG/WebP/DOCX, 5 MB), download and delete.
  - Verified: `npx tsc --noEmit` (0), payroll API (14 pass), `npm run build`
    (0), bundle budget (entry 19.7/20 kB gz, startup 309.6/320 kB gz), UI
    sweep and sidebar grouping (16 pass). The dialog was not visually inspected
    in a browser.
- **2026-11-08 — Phase 0 slice 6 landed.**
  - Added `POST /api/hr/employees/import` with `{ mode, csv, branchMap?,
    workStationMap? }`, gated on `hr-employee-manage` or the legacy
    `gl-payroll-manage` grant. `DRY_RUN` validates and reports; `COMMIT` writes
    every valid row and one `IMPORT_EMPLOYEES` audit row in one transaction.
  - The parser maps the master sheet's headers (HRMS ID, Full Name, Branch,
    employment fields, dates, contacts, bank/PAN/SSF, salary, status) and
    accepts optional sheet-label → branch/work-station maps. Unknown labels,
    duplicate rows, a code owned by another branch and validation errors skip
    only that row, with its sheet row number and reason.
  - The Employee Directory gained a manager-only **Import Master Sheet**
    action: file picker, optional maps, dry-run counts and a per-row table, then
    a confirmed commit. View-only roles never see the button.
  - Verified: `npx tsc --noEmit` (0), payroll API (15 pass), full API suite
    (196 pass / 29 suites), finance micro-permissions (6 pass), `npm run build`
    (0), bundle budget (entry 19.7/20 kB gz, startup 309.7/320 kB gz), UI sweep
    and sidebar grouping (16 pass), `git diff --check` clean. The dialog was not
    visually inspected in a browser.
