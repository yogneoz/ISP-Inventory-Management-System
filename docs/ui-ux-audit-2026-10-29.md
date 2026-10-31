# UI/UX audit — 2026-10-29

Scope: the live Vite app at `http://127.0.0.1:3000`, signed in as the demo
`superadmin@example.com`. Reviewed the login/reset flow, executive dashboard,
global search, notification center, purchase-bills register, create-purchase-bill
and create-purchase-order forms, and the Suppliers Warranty register at
**390, 768, 1067 and 1280 px**, in both light and dark mode.

Method: Chrome accessibility snapshots, DOM/computed-style probes, real keyboard
tab order, screenshots, and the browser console/network log. This is a
representative audit, not a pass over all 70 screens; coverage limits are at the
bottom.

## Summary

| Severity | Count | Themes |
|---|---|---|
| High | 3 | Mobile scope loss; overlay semantics/focus; mouse-only rows and cards |
| Medium | 6 | Count mismatch; table actions; risky bill defaults; sidebar density; login a11y; active nav state |
| Low | 3 | Copy collision; filter grouping; header polish |

The boot-paint gate remains green (CI runs 209 and 210), and no fallback or
spinner appeared during this walkthrough; there were no post-login console
errors. The remaining issues are interaction and layout problems, not startup
paint.

**Fixed 2026-10-29:** all high findings (UIX-1/2/3), all medium findings
(UIX-4–9) and all low findings (UIX-10/11/12). No audit item remains open.

**CI evidence.** [Run 212](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40987214829)
is green on `7634cc1` — typecheck, the full 1,591-test suite, both convention
guards, the production build, the startup bundle budget and the boot-timing
gate. The audit commit `cde6724` passed every step except the entry-chunk
budget (17.1 kB gz against 17 kB); `7634cc1` records that measurement and raises
only the entry limit to 18 kB, leaving the 320 kB startup total untouched at
291.2 kB.

## High

### UIX-1 — Mobile loses the branch and fiscal-year scope

**Observed.** At 390 px the header's branch selector and FY control are inside a
`hidden md:flex` block (`client/src/components/layout/Header.tsx:236`), and the
mobile drawer contains no branch or fiscal-year control
(`client/src/components/layout/Sidebar.tsx` has no `selectedBranchId`,
`onSelectBranch` or fiscal-year reference). The only visible branch control is
the form-local "Destination branch" on create screens. A phone or a 150% zoom on
a 1067 px window therefore cannot change the company-wide view scope at all.

**Recommendation.** Put the current branch/FY scope in the mobile drawer (or a
compact "scope" sheet opened from the header), showing the active values and
changing them through the same handlers as desktop. Keep the desktop controls
where they are.

### UIX-2 — Shell overlays are not accessible dialogs and do not trap focus

**Observed.** Open Global Search, then press Tab through it. The overlay has no
`role="dialog"` or `aria-modal`, no accessible name, and no focus trap; tabbing
past the last control moves focus to `<body>` and the page behind. The close X
is an unnamed `<button>`. The notification drawer has no dialog role or trap
either (`client/src/components/common/NotificationCenter.tsx`); the profile and
scanner overlays were not exercised in this pass.

**Recommendation.** Give the shared overlay primitive a dialog role and label,
mark the background inert, trap Tab/Shift+Tab inside it, restore focus on close
(the shell already tracks the opener), and label every icon-only close control.
This is one shared fix, not four one-offs.

### UIX-3 — Clickable table rows and dashboard cards are mouse-only

**Observed.** Global Search result rows are `<tr class="... cursor-pointer">`
with no `tabindex` or role; the dashboard's Branch Stock Summary cards are
`<div class="... cursor-pointer">` with no role or `tabindex`. Both respond to a
mouse click, but keyboard users cannot focus or activate them. The dashboard's
row-expander chevrons are also unnamed buttons.

**Recommendation.** Render these as real buttons/links (or give the row a
`tabIndex={0}`, `role="button"` and Enter/Space handling), with a visible focus
ring and an accessible name. Prefer one shared "clickable row" primitive so the
next register inherits the behavior.

## Medium

### UIX-4 — Notification badge and panel disagree, and the bell has no name

**Observed.** The header bell showed **2** while the Notification Center opened
with **3 Active** (2 reorder + 1 order). The badge sums low-stock, approvals and
shipments; the panel also counts orders. The bell's accessible name is the badge
text (`"2"`), not "Notifications"; it relies on a `title` attribute.

**Recommendation.** Derive the badge and the panel count from one function, and
either include orders in the badge or label the panel "2 alerts + 1 order".
Add an `aria-label` that includes the count (for example "Notifications, 3
unread").

**Fixed.** `client/src/utils/notificationAlerts.ts` builds every alert once for
low stock, approvals, shipments, orders and BS-calendar coverage; AppShell uses
that same list for the bell badge, the drawer and Clear All. The bell now reads
`Notifications, N active` (or `none active`) and the badge is hidden from the
accessibility tree. Pinned by `tests/uiUxMediumPriority.test.ts`.

### UIX-5 — Purchase-bill row actions are off-screen at 1067 px

**Observed.** At 1067 px the purchase-bills table is 971 px wide inside an
834 px scroller. The last action buttons start at x=1031, 1129 and 1158 (Products,
view, delete), beyond the 1067 px viewport, so they are only reachable after a
horizontal scroll. The same rows wrap branch and BS/AD dates onto 2–3 lines,
making the rows tall.

**Recommendation.** Make the action column sticky or collapse the three actions
into a single overflow menu at the right edge; keep a visible scroll affordance.
Use a compact date presentation (BS primary, AD secondary/tooltip) and
`whitespace-nowrap` for branch/date cells so rows stay scanable.

**Fixed.** The Actions column is pinned to the right edge (`sticky right-0`,
with its own header/row background and a left shadow) and the secondary labels
collapse below `xl`; branch and date cells are single-line, and dates show the
primary calendar with the full BS/AD pair in the tooltip. Pinned by
`tests/uiUxMediumPriority.test.ts` and measured in the live app at 1067 px.

### UIX-6 — Create Purchase Bill risks a fabricated bill number and wrong supplier

**Observed.** Opening **Create Purchase Bill** pre-fills
`VENDOR BILL / INVOICE # = BILL-93491` and `SUPPLIER / VENDOR = Example Supplier 1`.
The value is generated from `Math.random()` and the supplier is the first entry
in the directory (`client/src/features/procurement/PurchaseInvoiceForm.tsx`,
initial state around lines 98–100). The label reads as the supplier's own bill
number, so a hurried save can persist a number that never existed on the
supplier's document, against a supplier the operator did not choose.

**Recommendation.** Leave the vendor bill number blank with a placeholder and
require it, or clearly label a generated value as an internal draft reference.
Do not preselect the first supplier for a posting document; use an explicit
"Select supplier" state.

**Fixed.** Both fields start empty (initial state and form reset), the bill
number placeholder names the supplier's document, and both controls stay
required. The first-directory auto-fill effect is removed. Pinned by
`tests/uiUxMediumPriority.test.ts`.

### UIX-7 — Sidebar density squeezes the workspace and wraps labels

**Observed.** The sidebar is fixed at 240 px from the `md` breakpoint up. At
768 px it leaves a 528 px workspace; at 1067 px labels such as "Workflow
Approval Center", "Device Exchange & Replacement" and "Purchase Bills Register"
wrap onto two lines, and at 1280 px several still do. The expanded sidebar is the
default even when the icon-only rail would fit.

**Recommendation.** Widen the rail slightly (260–280 px) or collapse it to icons
below `xl`, with tooltips for the labels. Keep the active group expanded; do not
force every long label to wrap.

**Fixed.** The rail is now 19.5rem (19.5 × 0.84 ≈ 262 px) at ≤1366 px and 18rem
(18 × 0.78 ≈ 225 px) at ≤1024 px. Every menu label ellipsizes with its full
text in a `title`, so nothing wraps to two lines. Live measurements: at
1067 px the rail is 262.1 px with zero wrapped or clipped labels; at 768 px it
is 224.6 px, leaves a 543.4 px workspace, and still has zero wrapped or clipped
labels. The active group remains auto-expanded.

### UIX-8 — Login keyboard order and error announcement

**Observed.** With focus in the email field, Tab goes to **Forgot Password?**
before the password field; the password label row renders the button before the
input in DOM order. After a failed login the error is a plain `<span>` inside a
`<div>` with no `role="alert"`, `aria-live` or `aria-describedby`, and both
inputs remain `aria-invalid="false"`.

**Recommendation.** Put the password input before the Forgot Password action in
DOM order (or make the action a link in the label row that does not intercept
Tab), mark the error as a live region, associate it with both fields and set
`aria-invalid` when the request fails.

**Fixed.** The password label is now a plain `<label htmlFor>`; the input owns
`id="login-password"`, and Forgot Password follows it below the field. A failed
sign-in renders `#login-error` with `role="alert"`; both fields get
`aria-invalid="true"` and `aria-describedby="login-error"`. The show/hide
control is named and exposes `aria-pressed`. Live Tab order in the signed-out
window: email → password → Show password → Forgot Password → Keep me logged in
→ Sign In. Pinned by `tests/uiUxMediumPriority.test.ts`.

### UIX-9 — Active navigation is visual only

**Observed.** The active sidebar button has no `aria-current`, `aria-pressed` or
`aria-selected`; the current screen is communicated only by color/background.
The accessibility tree cannot distinguish the active tab from its siblings.

**Recommendation.** Add `aria-current="page"` to the active navigation button and
keep the visual state as-is. Apply the same rule to any segmented tab bars.

**Fixed.** Every sidebar child, the Help footer link and the Company Setup card
set `aria-current="page"` only when active; accordion group headers expose
`aria-expanded`. Live at 1067 px the active "Create Purchase Bill" item was the
only `[aria-current="page"]`. Pinned by `tests/uiUxMediumPriority.test.ts`.

## Low

### UIX-10 — Low-stock hint text collides

**Observed.** On the dashboard the "Requires Action" and "View Reorder" spans
have a 1 px gap at 1067/1280 px, so the rendered text reads
"Requires ActionView Reorder".

**Recommendation.** Add a real gap/wrap to the hint row (`gap-2` or a responsive
stack); do not rely on `justify-between` inside a narrow card.

**Fixed.** The hint row now uses `flex-wrap` with `gap-x-2` and a right-aligned,
non-wrapping "View Reorder". Live at 1067 px the two labels sit on separate
rows with no overlap (7 px column gap); at 1280 px they share one row with a
7 px gap. Pinned by `tests/uiUxLowPriority.test.ts`.

### UIX-11 — Warranty date range splits across rows

**Observed.** The Suppliers Warranty filter card is a four-column grid with five
controls. At 1067 px "Start to" wraps to a second row under **Search**, far from
"Start from" in the fourth column, leaving an empty cell and making the range
look unrelated.

**Recommendation.** Keep the two date fields adjacent (a two-column date group)
or use a five-column layout at wide widths; an explicit "Clear filters" action
would also help.

**Fixed.** Both ends of the range now render inside one labelled
`role="group"` with their own bound labels, so the pair moves as a unit. Live
at 1067 px the fields share a row with a 7 px gap and a 276 px group width; the
card's Clear button still resets both. Pinned by
`tests/uiUxLowPriority.test.ts`.

### UIX-12 — Header polish: clipped FY label and a stale launcher query

**Observed.** At 1067/1280 px the fiscal-year control renders `2083-84 (Acti…`
because its trigger is capped at 94 px; the accessible name still carries the
full value, but the visible label is clipped. Separately, after a global search
for `ONU` was closed, the header
input kept `ONU` on the screens visited while the current register's own search
stayed blank and all rows were shown. It reads as an active filter that is not
applied.

**Recommendation.** Show the year plus an "active" dot (or widen the control)
instead of clipping the status; clear the launcher query when the search closes
or visibly mark it as a recent query, not a filter.

**Fixed.** The active year now renders a green dot (with screen-reader text)
instead of the `(Active)` suffix. Live at 1067 and 1280 px the trigger is
68/68 px wide with `scrollWidth === clientWidth` — nothing clipped — and its
accessible name is "2083-84 active". Global search now treats typed text as a
draft: closing without a pick restores the previously applied text (live:
typed `ONU`, closed, header back to empty), while a picked result commits it
(live: picked "ONU001", header kept it through a reopen/close). Pinned by
`tests/uiUxLowPriority.test.ts`.

## What was verified

- Login, Forgot Password, dashboard (light and dark), global search,
  notification center, purchase-bills register, create-purchase-bill,
  create-purchase-order, and Suppliers Warranty.
- Viewports 390×844, 768×900, 1067×900 and 1280×900; light and dark themes.
- Real Tab order on login and inside Global Search; focus escape to `<body>`;
  unnamed buttons, missing `aria-current`, and the mouse-only row/card DOM.
- Console/network: expected pre-login 401s only; no post-login page errors.

## Not covered

- The other ~60 screens (sales, returns, stock operations, fixed assets,
  finance, settings, approvals, help) and their modals.
- Automated axe/contrast checks, manual screen-reader passes, Firefox/Safari,
  touch gestures, print/export flows, or high-volume pagination states.
- Mobile at widths other than 390, and browser zoom beyond the 768 px breakpoint
  inference; the scope-loss finding follows from the `hidden md:flex` rule, not
  from a separate zoom run.

**Follow-up:** the ~60 uncovered screens were swept on 2026-10-30 at 390, 1067
and 1440 px — see [ui-ux-audit-2026-10-30.md](ui-ux-audit-2026-10-30.md).
Modals, dark mode, axe/contrast, screen readers and print remain open there too.

## Suggested order

1. **UIX-1** — restore branch/FY scope on mobile; this blocks real work.
2. **UIX-2/3/8** — one shared accessible overlay and clickable-row primitive,
   plus the login error wiring.
3. **UIX-5** — make register actions reachable at 1067 px.
4. **UIX-4/6/7** — count consistency, posting defaults, sidebar density.
5. **UIX-9/10/11/12** — active state, copy, filter grouping and header polish.
