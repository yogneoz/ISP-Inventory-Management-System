# Cash-flow print/PDF and forward forecast — task note

**Status:** Done — print/PDF, weekly AR/AP forecast, recurring journals, payroll commitments and manual inputs
**Created:** 2026-11-08
**Updated:** 2026-11-11

## Goal

Print/PDF output for the existing direct cash-flow statement and a forward
3–6 month cash-flow forecast built from AR/AP due dates and recurring items.

## Current state

- `GET /api/accounting/statements/cash-flow` and the Cash Flow register exist
  (direct method, opening/net/closing tied to the cash book).
- Cash-flow print/PDF exists: `GET /api/accounting/statements/cash-flow/print`
  resolves the same window and branch scope, passes the `gl-view` gate, renders
  the same `buildCashFlow()` object as the JSON endpoint, and prints the AD/BS
  period header, section lines with subtotals, and the cash-position summary.
  The register exposes `Print / PDF` beside Refresh and downloads the
  authenticated blob as `cash-flow-<as-of>.pdf`.
- The weekly forecast is delivered by
  `server/src/services/accountingCashFlowForecast.service.ts`, with controller
  handlers in `server/src/controllers/accounting.controller.ts` and routes in
  `server/src/routes/accounting.routes.ts`:
  - `GET /api/accounting/statements/cash-flow/forecast`
  - `GET /api/accounting/statements/cash-flow/forecast/export`

  Both sit behind `requirePermission('gl-view')` and reuse the statement
  window/branch resolution. Opening cash is the posted cash/bank balance on the
  as-of date. AR/AP open items come from `buildAging()`; unapplied credits are
  subtracted in W1 so the forecast ties to the aging controls. Weekly buckets
  start the day after the as-of date, overdue items fall in W1, the horizon
  defaults to 13 weeks (clamped 1–26), and `minCash` defaults to 0.
- Client support is in `client/src/services/api/accounting.ts` and
  `client/src/services/api/index.ts`. The Cash Flow register renders
  `client/src/components/accounting/CashFlowForecastView.tsx` with the weekly
  table, opening/net/closing cards, weeks and minimum-cash controls, warning,
  item detail, refresh and CSV export.
- The CSV includes the summary, weekly buckets, item detail, AR/AP tie-outs and
  beyond-horizon exclusions.
- Recurring templates/journals are read from `gl_recurring_templates` and
  `gl_recurring_template_lines`; unpaid approved/posted payroll runs use
  `net_total`; branch-owned manual adjustments are stored in
  `gl_cash_flow_manual_inputs`. Closed-period items are excluded from the
  buckets, and every source is summarised in the forecast response.

## Scope

1. ~~Cash-flow print/PDF~~ — delivered 2026-11-10 (route, register action,
   section table, cash-position summary and tie-out line).
2. Forecast inputs:
   - Open AR by due date — delivered.
   - Open AP by due date — delivered.
   - Recurring templates/journals — delivered, with closed-period exclusions.
   - Unpaid approved/posted payroll commitments — delivered.
   - Branch-owned manual adjustments — delivered with `gl-view`/`gl-post`
     gated CRUD, audit and closed-period refusal.
3. ~~Weekly buckets with opening cash, inflows, outflows, closing cash and a
   minimum-balance warning~~ — delivered.
4. ~~Screen + CSV export, clearly labelled as a forecast~~ — delivered.

## Out of scope

- Probabilistic/scenario modelling.
- Bank feed integration.

## Acceptance criteria

- Printed statement ties to the on-screen figures and the cash-book closing.
  **Met for print:** the PDF is rendered from the same statement object the
  register displays; the live run showed opening NPR 19,100, net −NPR 9,100 and
  closing NPR 10,000 on both, with the cash-book closing at NPR 10,000.
- Forecast opening cash equals the posted/reconciled cash-book balance at the
  as-of date. **Met:** the live opening was NPR 10,000, equal to the statement
  closing/cash-book balance on 2026-11-10.
- A due item appears in exactly one bucket; paid/cancelled documents are
  excluded. **Met:** the live run placed all 84 open AR/AP items in W1, with no
  duplicate bucket; the existing aging filters exclude paid/cancelled documents,
  and the API test asserts the W1 math and AR/AP tie-outs.
- Branch and `ALL` scopes behave like the existing statement. **Met:** the
  forecast reuses the statement branch/window resolution; the API test covers
  branch scope and rejects an invalid `from` parameter.
- A minimum-cash threshold warns when closing cash falls below it. **Met:** with
  NPR 8,000 selected, W1 showed: “Closing cash falls below NPR 8,000 in W1
  (11 Nov – 17 Nov). Lowest closing cash is NPR 5,000.”
- Forecast CSV downloads and includes W1 detail, the warning and the tie-out.
  **Met:** see the export evidence below.

## Verification

- `npx tsc --noEmit` — clean, exit 0 (2026-11-10).
- `NODE_ENV=test npx tsx --test tests/cashFlowForecast.api.test.ts` — 3/3 pass,
  covering manual-input CRUD, formula validation, closed-period refusal, weekly
  source buckets, AR/AP tie-outs, CSV detail and branch/ALL isolation over real
  HTTP + PostgreSQL.
- Schema applied live; `tests/schema.drift.guard.test.ts` 2/2 pass and
  `tests/schemaSource.parity.test.ts` reports the current 95 tables.
- `NODE_ENV=test npm test` — 2,146 tests across 483 suites, 2,144 pass,
  2 Windows-only real-signal skips, 0 fail, exit 0; the docs-count gate matched
  2146.
- `NODE_ENV=test npx tsx --test tests/accountingAging.api.test.ts` — 6/6 pass,
  covering opening tie-out, W1 bucket math, AR/AP control ties, the threshold
  warning, CSV headers/content, permissions, branch scope, `from` rejection and
  negative `minCash`.
- `NODE_ENV=test npx tsx --test tests/accountingWorkspaceRoute.test.ts` — 21/21
  pass, including the mounted forecast UI.
- `NODE_ENV=test npx tsx --test tests/pdfPrint.api.test.ts` — 9/9 pass (41.0s),
  including the cash-flow print route and the cash-flow section-content test.
- Live app on 2026-11-10 (All Branches, as of 2026-11-10):
  - Forecast opening cash NPR 10,000, equal to the cash-flow statement’s closing
    cash; expected in NPR 10,000 after NPR 27,920 of AR credits; expected out
    NPR 15,000; net −NPR 5,000; closing NPR 5,000.
  - All 84 open AR/AP items fell into W1 (11–17 Nov). The AR and AP figures tied
    to their aging control totals.
  - With minimum cash NPR 8,000, the W1 warning fired with lowest closing cash
    NPR 5,000.
  - **Export CSV:** a trusted click on the actual button called
    `/api/accounting/statements/cash-flow/forecast/export?asOf=2026-11-10&weeks=13&minCash=8000`
    and returned `200`, `text/csv`, 12,192 bytes,
    `Content-Disposition: attachment; filename="cash-flow-forecast-2026-11-10.csv"`.
    The downloaded file `cash-flow-forecast-2026-11-10.csv` contained W1 rows,
    `Warning,YES`, AP item detail and the tie-out.
  - **Print / PDF:** a trusted click on the actual button called
    `/api/accounting/statements/cash-flow/print?to=2026-11-10` and returned
    `200`, `application/pdf`, `%PDF-`, 16,121 bytes,
    `Content-Disposition: inline; filename="cash-flow-2026-11-10.pdf"`, and
    downloaded `cash-flow-2026-11-10.pdf`.
  - The two button clicks were made in a fresh headless Chrome session driven by
    CDP because the in-app preview input tool delivered no pointer events. The
    page click trace recorded `isTrusted: true` for both actual buttons, and both
    download-complete events fired.

## Next action

No work remains for this slice. The cash-flow print/PDF, weekly AR/AP forecast,
recurring journals, payroll commitments and manual inputs are delivered and
covered by the API, guard and mounted-UI tests.
