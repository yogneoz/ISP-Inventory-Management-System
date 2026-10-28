# WTY-2 — the coverage API, branch scope and the audited correction

Status: `[~]` in progress (scaffold on disk, no gates run) · Started 2026-10-28 · Round 9
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
- `PATCH` validation: both dates required, real AD calendar dates, end ≥ start;
  term 0–120 or null; notes capped; branch ownership checked against the stored
  row; audit entry names the unit and the old → new dates.

## Acceptance checklist

- [ ] Repo builders: every filter combination, status clause, branch-scope
      branch and stable ordering; page/pageSize clamped; the summary ignores the
      status filter but honours search/category/date/branch.
- [ ] HTTP: a branch account reading its own branch succeeds; a forged branchId
      is 403; an account with no scope gets an empty page (never the country);
      super/head-office may use `ALL`.
- [ ] Both routes answer 403 without `warranty-view`; PATCH answers 403 without
      `warranty-edit`.
- [ ] The PATCH accepts a corrected expiry and writes an audit row; rejects a
      reversed range, a missing date, a term outside 0–120 and a row outside the
      caller's branch.
- [ ] The demo mirror answers the same pages and counts as the SQL path for the
      same fixture.
- [ ] `npx tsc --noEmit` clean; `check:no-inline-sql` green.

## Out of scope

Capture at purchase/asset/issue/sale/exchange (WTY-4/5) and the screens
(WTY-6). No bootstrap slice is added.
