# UI/UX audit — 2026-10-30 (all registered screens)

Scope: the live Vite app at `http://127.0.0.1:3100`, signed in as the demo
`superadmin@example.com`, driving **all 68 registered screen routes** at
**390×844, 1067×800 and 1440×900** — 204 readings in one sweep. This is the
follow-up to [the 2026-10-29 audit](ui-ux-audit-2026-10-29.md), which covered 9
screens and listed "the other ~60 screens" as not covered. That gap is closed.

Method: a temporary headless-Chrome CDP sweep (the dependency-free client
pattern `scripts/check_boot_timing.mjs` uses). It signs in through the real
login API, seeds the session exactly as the app writes it, navigates every tab,
and probes each screen for the defect classes the October pass established:

- document/main horizontal overflow and tables wider than their scroller,
- ellipsized or clipped text (excluding elements inside a horizontal scroller),
- controls rendered outside the viewport,
- `cursor: pointer` rows/cards with no role, tabindex or nested control
  (mouse-only),
- text below 10 px,
- buttons/links under 22 px in either dimension,
- console errors, page exceptions and HTTP failures per screen.

A screenshot is captured for every reading that flags something.

## Summary

| Severity | Findings | Status |
|---|---|---|
| High | 3 | all fixed |
| Medium | 5 | all fixed |
| Low | 3 | all fixed |

The first pass over all 68 screens flagged **19 readings on 8 screens**; the
earlier 39-screen pass had flagged **5 readings on 4 screens**. After the fixes below the
same 204-reading sweep reports **zero** ellipsized or clipped text, zero
horizontal page overflow, zero off-screen controls, zero mouse-only controls,
zero unreadable tables and zero console/page/HTTP errors — every screen reports
`ok` at every width.

Most findings were **three systemic causes**, not 19 one-offs: the shared
`PageHeader`, the shared `StatCard`, and 102 micro-labels at 9 px. Fixing the
components cleared the long tail at once.

One measured class remains outside that pass/fail set — the phone tier's
effective type size; see [Residual measurements](#residual-measurements).

## High

### UIX-13 — Screen titles and descriptions end in an ellipsis

**Observed.** `PageHeader` truncated its title and description. At 1080p the
action row can claim almost the whole width, so the title was squeezed to
~200 px:

- **Damaged Stock Matrix & Branch Loss Tracking** → `Damaged Stock Matri…`
  (1440 px)
- **Per-Branch Reorder Level Matrix & Sync** → `Per-Branch Reorder Level Ma…`
  (1067 px)
- Physical Stock Count, Company Profile, In-App Help and the StatCard showcase
  all clipped their first heading.

Descriptions were worse: a sentence explaining the screen ended mid-word
("Supplier × branch opening payables (Accounts Payable) rolled forward f…").
The pattern also appeared in screens that hand-roll their own banner instead of
using the shared header: Vendor Opening Balances, Fiscal Year Opening Register,
BS Calendar's import hint, Receive Inbound Stock and Company Setup.

**Why it mattered.** An ellipsis is fine for a table cell with a tooltip; a page
title has no tooltip and is the only thing that says where you are. The same is
true of the description that tells an operator what the register is for.

**Fixed.** `PageHeader` no longer truncates anything: titles and descriptions
wrap, and below `xl` the header stacks so the title gets the full column width
instead of sharing a row with the action buttons. The five hand-rolled banners
and the BS Calendar hint now wrap too. Pinned by
`tests/uiUxSweep20261030.test.ts` (the rendered title/description carry no
`truncate` class and keep their full text). The same file pins the shared
24 px target floor described under [Residual measurements](#residual-measurements).

### UIX-14 — KPI cards cut the metric's name and its hint

**Observed.** `StatCard` truncated both its uppercase label and its hint:

- `TOTAL INVENTORY COST VALUE` → `TOTAL INVENTORY …` at 1067 px,
- hints such as the average-margin line ended in `…`.

A four-up card row at 1067 px gives each card ~190 px; the label was the first
thing to go, so the number below it had no name.

**Fixed.** Labels and hints wrap with `leading-tight`/`leading-snug` and
`break-words`; the grid already stretches cards to a common height, so the row
stays aligned. Pinned by the same test file.

### UIX-15 — Fiscal Year Closing wizard step names are clipped

**Observed.** The six step titles in `FiscalYearClosingWizard` were
`truncate`d inside a narrow rail; at 1440 px the wizard's own navigation read
`Openi…`, `Stock & Se…`, etc. The steps are the only way to know what the
wizard will do next.

**Fixed.** Step titles wrap (`leading-snug break-words`); the rail grows and the
step numbers stay aligned.

## Medium

### UIX-16 — Consumable Issue's three-column grid clips inputs at 390 px

**Observed.** `grid grid-cols-3` at phone width gives each field ~108 px, so the
Source Store Branch / destination / quantity inputs clipped their own
placeholders. Touch users saw a field with no readable label value.

**Fixed.** One column below `sm`, three above.

### UIX-17 — Approvals had no page heading and mouse-only filter cards

**Observed.** The Workflow Approval & Authorization Center rendered its title as
an `<h3>` with no `<h2>` anywhere on the screen, so the accessibility tree had a
heading-level skip and the sweep's first-heading probe read blank. Its five KPI
cards (Pending / Approved / Rejected / Cancelled / Total) were `<div
onClick>` filters with no role, tabindex or keyboard path — the only way to
filter the register by status with a keyboard was the type tabs.

**Fixed.** The title is an `<h2>`; each KPI card is a real `<button
type="button">` with `aria-pressed`, preserving the selected ring.

### UIX-18 — Permission-matrix group headers are mouse-only, controls undersized

**Observed.** Each permission group's icon + title block collapses the group on
click but had no role or tabindex. The `Collapse`/`Expand` and the six per-role
`Enable All` / `Disable All` toggles rendered 13–15 px tall — half the 24 px
minimum target.

**Fixed.** The group heading is a `role="button"` with `tabIndex={0}`,
`aria-expanded`, and Enter/Space handling; the collapse and enable-all controls
get vertical padding.

### UIX-19 — In-App Help navigation truncates every guide and chapter

**Observed.** At 1440 the guide list cut "Purchasing End-to-End (PO → Invoice →
Payment)" at 190 px; at 1067 the chapter list cut **eight** entries at 109 px
("Purchasing End-to-End (PO → Inv…"). Help is the one screen where the label is
the content — a user looking for the purchasing walkthrough cannot tell it from
the selling one.

**Fixed.** Both nav lists wrap their labels to multiple lines with the chevron
pinned right.

### UIX-20 — Company Setup preset chips and letterhead preview clip at 1067

**Observed.** The four logo-preset chips are ~59 px wide at 1067 and truncated
"Security & Enterprise" to `Security &…`; the profile-preview card cut the
company name ("Inventory Management System" → `Inventory Management Sy…`) and
its address.

**Fixed.** Preset labels and the preview's name/tagline/address wrap; the banner
description wraps as well.

## Low

### UIX-21 — Dashboard branch cards and recent-activity names clip

**Observed.** Branch selector cards hid the branch name ("Branch 1 (Head
Office)" was 13 px too wide at 1440, 58 px at 1067), and recent stock movements
cut long product names at a hard 140 px (`ONU ROUTER DUAL BAND 2.4G/5G GPON` →
`ONU ROUTER DUAL BAND…`). The branch card has a `title` tooltip, the activity
row has none.

**Fixed.** Both wrap (`min-w-0 break-words`), with the branch code badge pinned
`shrink-0`.

### UIX-22 — 102 labels render below the 10 px type floor

**Observed.** `text-[9px]` appeared 102 times across 34 files — branch codes,
"PENDING PULLOUTS" counters, role badges, timestamps. At the ≤1366 px zoom tier
(88%) those labels paint at ~7.9 physical px. The codebase already uses
`text-[10px]` 628 times, so 9 px was drift, not a deliberate scale step.

**Fixed.** All 102 are now `text-[10px]`, and a source guard keeps the floor.

### UIX-23 — Inline action links are 12–15 px tall

**Observed.** Dashboard "Full Matrix View" and "View Full Ledger →", and the
permissions "Collapse"/"Enable All" controls, were text-height click targets.

**Fixed.** They keep their link appearance but gain `py-1`, raising the hit area
without changing the row's visual weight.

## What was verified

- All 68 registered routes from `App.tsx`'s `screenRoute` map, including the
  ones absent from the sidebar (`opening-stock`, `dev-statcard`,
  `clear-demo-data`, `help-documentation`, `damaged-stock`).
- 204 readings (68 screens × 3 widths) with zero content-loss, overflow,
  mouse-only or console/HTTP findings after the fixes, and zero sub-22 px
  click targets after the target-size follow-up.
- Console, page exceptions and HTTP per screen: no post-login page errors; the
  only HTTP failures were the expected signed-out 401s during the setup boot
  and one transient `/api/sync/stream` 401 while the dev server restarted
  (re-ran clean).
- Screenshots retained locally for every pre-fix finding
  (`.tmp-audit/*.png`; not committed).

## Residual measurements

The probe records target size and effective type on every screen even though
they are not part of the pass/fail flag (a pass would otherwise be impossible
without redesigning the responsive zoom). Their final state:

- **Sub-22 px click targets: 26 at 1440, 45 at 1067, 60 at 390 when first
  measured — now 0 at every width.** The floor is enforced on `button` in
  `client/src/index.css` as `min-height: 24px; min-width: 24px` in **px**, not
  rem: the density tiers shrink the root font-size, so a rem floor would
  render 18.7 px at the 78% tier. The text-link actions that were the bulk of
  the 26 (stock-ledger quick ranges, "Go to …" diagnostics, "Set Active", the
  dashboard links) use the shared `linkButton` token, and the two 12×23 close
  `✕` controls use `iconButton` (24×24 plus an accessible name), both from
  `styleConstants.ts`. Re-measured: 0/0/0.
- **Effective type below 10 px at 390 only: 392 nodes, all exactly 9.36 px.**
  That is `text-xs` (12 px) under the app's 0.78 phone zoom tier, not a stray
  small font — the same 392 nodes compute at 12 px at 1067 and 1440. The source
  floor is now 10 px (UIX-22); whether the phone tier should zoom type is a
  separate design decision and remains open.

## Not covered

- **Modals and drawers.** Covered by the
  [2026-10-31 overlay sweep](ui-ux-audit-2026-10-31-overlays.md): 32 surfaces ×
  390/1067/1440 px, including the six approval, receive-verification and
  opening-stock dialogs that were data-gated in the first pass (UIX-26) and the
  damage, audit and serial-log feature dialogs (UIX-27). Every panel shares a
  labelled, focus-trapped modal panel.
- **Dark mode.** The 2026-10-29 pass checked it on its 9 screens; this sweep ran
  light mode only.
- Keyboard traversal beyond the components changed here; no axe/contrast
  engine, screen-reader pass, Firefox/Safari, touch gestures, print/PDF or
  high-volume pagination states.
- Browser zoom other than the app's own responsive tiers.

## Detector notes

- A text `<input>` whose value is wider than the field reports
  `scrollWidth > clientWidth`; that is normal internal scrolling, not clipping.
  The probe now treats inputs/selects/textareas as focusable and stops counting
  them (the one remaining Company Setup "clip" at 1067 was a 4 px input value).
- `cursor: pointer` is inherited, so only the outermost pointer element of a
  clickable subtree is reported; a card's inner text is not a separate finding.
- Tables inside `overflow-x: auto` wrappers are scrollable by design and are not
  counted as clipped.
- The console's `ok` line covers the content-loss/interaction classes listed at
  the top. `tinyTargets` and `smallText` are captured in `report.json` but are
  not part of that flag; the measured totals are in
  [Residual measurements](#residual-measurements).
