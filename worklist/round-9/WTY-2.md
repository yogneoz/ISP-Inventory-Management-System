# WTY-2 — the coverage API, branch scope and the audited correction

Status: `[x]` done (2026-10-28) · Started 2026-10-28 · Round 9
Order: 2 · Depends on WTY-1 (table + types).

## Why

Both registers need one paged read over the same stored coverage table and one
permission-gated correction path. Rebuilding the old union in the browser is
what produced the misleading "Valid 0" landing state. The API must answer with
the state the SQL computed — never re-derive it in the client — and must refuse
a branch account that forges or omits `branchId`, exactly like the paged device
read.

## Scope

- `server/src/models/warranty.repo.ts` — pure builders, no pool access:
  `buildWarrantyPageQuery`, `buildWarrantyCountQuery`,
  `buildWarrantySummaryQuery` (all-status KPIs), `WARRANTY_INSERT_SQL`,
  `WARRANTY_UPDATE_SQL`, the supersede statements (by type+serial, by source
  document, by device record) and their param builders. One
  `WARRANTY_STATE_SQL` / `WARRANTY_STATE_CASE_SQL` used by filter, count and
  render.
- `server/src/services/warranty.service.ts` — the transaction participant every
  capture path calls: `recordWarrantyCoverage` (supersede current, then insert),
  `defaultCoverageEnd`, `warrantyMonthsFor`, `warrantyDateError`,
  `normalizeTermMonths`, `normalizeWarrantySerial`, edit helpers, and the
  PG-down mirror twins.
- `server/src/controllers/warranty.controller.ts` — `GET /api/warranties/vendor`,
  `GET /api/warranties/seller`, `PATCH /api/warranties/:id`. Default filter is
  **all statuses**; `status`, `query`, `category`, `startFrom/To`, `branchId`,
  `page`, `pageSize` are honoured. Scope resolves from the session for every
  non-super/head-office role (own branch + `allowedBranchIds`), a foreign
  requested branch is 403, an empty scope returns an empty page.
- `server/src/routes/warranty.routes.ts`, registered in `server/src/app.ts`;
  `warranty-view` on reads, `warranty-edit` on the PATCH.
- `client/src/utils/permissionMatrixData.ts` — the two operations' defaults
  (read open to all roles, edit manager/super/head-office) and the
  `PermissionManagement` descriptions of them.
- `server/src/middleware/branchScope.ts` — `warranty_coverages` registered as
  the `/warranties` resource, so `enforceBranchAccess` refuses a correction that
  names another branch's row before the controller runs; `vendor` and `seller`
  are register segments, not record ids. This is also what keeps
  `tests/branchScopeRegistry.test.ts` green for the new table.
- `PATCH` validation: both dates required, real AD calendar dates, end ≥ start;
  term 0–120 or null; notes capped; branch ownership checked against the stored
  row; audit entry names the unit and the old → new dates.

## Acceptance checklist

- [x] Repo builders: every filter combination, status clause, branch-scope
      branch and stable ordering; page/pageSize clamped; the summary ignores the
      status filter but honours search/category/date/branch.
      `tests/warranty.repo.test.ts` — 11 tests, including a refused empty scope
      that binds `FALSE` (not "all branches") and count/summary sharing the
      page's WHERE clause.
- [x] HTTP: a branch account reading its own branch succeeds; a forged branchId
      is 403; an account with no scope gets an empty page (never the country);
      super/head-office may use `ALL`. `tests/warranty.api.test.ts` drives the
      real Express app against PostgreSQL, not handlers in isolation.
- [x] Both routes answer 403 without `warranty-view`; PATCH answers 403 without
      `warranty-edit` (and a view-only account can still read).
- [x] The PATCH accepts a corrected expiry and writes an audit row; rejects a
      reversed range, a missing date, a term outside 0–120 and a row outside the
      caller's branch. Proven end to end: a correction inserts a new current
      period, keeps the prior row as history (`is_current = false`), and the
      audit entry names the unit and old → new dates; a second correction stacks
      another period and still leaves exactly one current row; every rejected
      request leaves the stored row byte-identical and appends no audit row.
- [x] The demo mirror answers the same pages and counts as the SQL path for the
      same fixture.
- [x] `npx tsc --noEmit` clean; `check:no-inline-sql` green; the branch-scope
      registry guard passes with the new table guarded.

## Verified locally (2026-10-28)

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/branchScopeRegistry.test.ts tests/warranty.api.test.ts
  tests/warranty.repo.test.ts` — **29 tests, 29 pass, 0 fail** (registry 6,
  HTTP 12, builders 11).
- `npm run check:no-inline-sql` — clean (17 controller files).
- Full `npm test` on the combined WTY-2 + WTY-3 tree — **1515 tests, 1513
  pass, 0 fail, 2 Windows-only skips**. The run's only non-zero exit was the
  docs-count gate still claiming 1468; that bump lands with WTY-3's docs, which
  is also where the suite grew to 1515.

## Out of scope

Capture at purchase/asset/issue/sale/exchange (WTY-4/5) and the screens
(WTY-6). No bootstrap slice is added.
