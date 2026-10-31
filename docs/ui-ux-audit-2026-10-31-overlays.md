# UI/UX audit — 2026-10-31 (modals and drawers)

Scope: the live Vite app at `http://127.0.0.1:3000`, signed in as the demo
`superadmin@example.com`, opening **32 overlay surfaces** (shell dialogs, record
dialogs, payment dialogs, the warranty editor, six data-gated dialogs seeded
for the follow-up pass and eight feature dialogs) at **390×844, 1067×800 and
1440×900** — 96 readings. This closes the modal/drawer gap that
[the 2026-10-30 all-screen sweep](ui-ux-audit-2026-10-30.md#not-covered) left
open; that pass measured the routed screen behind an overlay, never the overlay.

Method: a temporary headless-Chrome CDP sweep in the same dependency-free
pattern as `scripts/check_boot_timing.mjs`. Each overlay is opened through its
real trigger (header control, row action, or Add button), probed at all three
widths, then the page is reloaded for the next one. The probe measures the same
defect classes as the screen sweep — clipped/ellipsized text, horizontal
overflow, off-viewport controls, mouse-only clickable rows, tables wider than
their scroller, sub-10 px text, sub-22 px targets, console/page/HTTP errors —
plus two overlay-specific ones:

- **reachability:** the panel is taller or wider than the viewport and no
  ancestor scrolls, so the dialog's own actions cannot be reached;
- **semantics:** whether the panel exposes `role="dialog"`, `aria-modal="true"`
  and an accessible name (recorded, not part of the pass/fail flag — matching
  how the shell fix was scoped in UIX-2).

## Summary

| Severity | Findings | Status |
|---|---|---|
| Content loss | 2 | fixed |
| Dialog semantics | 3 | fixed (12 flagged dialogs plus siblings; 33 panels total) |

After the fixes, all **96 readings are clean**: zero ellipsized or clipped text,
zero overflow, zero off-viewport or unreachable controls, zero mouse-only rows,
zero tables wider than their scroller, zero console/page/HTTP errors — and zero
sub-22 px targets, so the 24 px floor holds inside overlays too.

The semantic gaps are fixed too: all **96 readings** now expose
`role="dialog"`, `aria-modal="true"` and an accessible name, and the focus trap
is shared rather than per-dialog (UIX-25, UIX-26, UIX-27).

## Medium

### UIX-24 — The profile picker ellipsizes every user's identity line

**Observed.** The switcher's `email • branch` line carried `truncate`
(`ProfileSwitchModal`). At 1067 px it cut **12 px**; at 390 px it cut between
5 and **102 px**, hiding the branch on six of the seven rows:

- `superadmin@example.com • Branch 1 (Head Office)` → cut at 88 px
- `auth-guard-test@example.com • Branch 1 (Head Office)` → cut at 102 px
- `branch1@example.com • Branch 1 (Head Office)` → cut at 54 px

**Why it mattered.** This is the control an operator uses to change identity.
Two people can share a display name; the branch is what distinguishes them, and
the row had no tooltip. The same class as UIX-19 (In-App Help) and UIX-13
(headers): an ellipsis on identity, not on a table cell.

**Fixed.** The line wraps (`flex flex-wrap`, gap-x/gap-y, `break-all` on the
email) and the user name dropped its `truncate`. Pinned by
`tests/uiUxOverlaySweep20261031.test.ts` (full email and branch present, no
truncation class, wrapping class on the line). Re-measured at 1067 and 390:
0 ellipsized nodes.

### UIX-25 — Record dialogs are not dialogs

**Observed.** Twelve overlays render as plain `fixed inset-0` divs with no
`role="dialog"`, no `aria-modal`, and no accessible name: create product,
category, product group, UoM, location, user, branch, supplier, customer, fixed
asset, record customer payment and record vendor payment. The sales payment
dialog has no heading element at all — its title is a `<div>` — so it has no
name even if a role were added. Keyboard focus is not trapped in any of them:
Tab walks out of the panel and onto the page behind.

**Not a layout finding.** All twelve pass the content checks at all three
widths. This is the same defect UIX-2 fixed for the shell overlays; the shell
now uses `useDialogA11y`, the record dialogs have no equivalent.

**Fixed.** [`ModalPanel.tsx`](../../client/src/components/common/ModalPanel.tsx)
wraps the panel with `role="dialog"`, `aria-modal="true"` and the visible title,
and supplies the shell's behaviour: focus enters on open, Tab / Shift+Tab cycle
inside, the topmost panel owns the keyboard, Escape closes only while focus is
inside this panel, and focus returns to the opener on unmount. `DialogProvider`
joins the same trap stack, so a confirm opened over a record dialog takes the
keyboard instead of fighting the panel underneath. The twelve dialogs are
adopted, along with the sibling dialogs in the same screens (asset detail,
customer delete, payment breakdown, barcode print, user reset). Pinned by
`tests/modalPanel.test.ts` (4 tests: adoption, semantics + trap + Escape, stacked
confirm, focus restore). Re-swept: 54/54 readings report dialog + modal + a name,
with no content change. The six data-gated dialogs joined in the follow-up pass
(UIX-26) and nine feature dialogs in the last pass (UIX-27), bringing the total
to 33 panels across 18 files.

### UIX-26 — The data-gated dialogs were not dialogs either

**Observed.** The three surfaces UIX-25 could not reach — the approval details /
approve / reject / cancel dialogs, receive-stock verification and opening-stock
"Add Row" — were rendered as the same plain `fixed inset-0` divs: no
`role="dialog"`, no `aria-modal`, no accessible name and no focus trap. They
were outside the first pass only because the dummy dataset had no approval
request, no receivable shipment and no opening-stock row to open them from.

**Fixture.** Against the local dummy database, the follow-up seeded one pending
approval request (APR-2083-001), one `SUPPLIER_INBOUND` shipment in transit
(AUDIT-RCV-001, destined for the head office) and opening-stock rows for the
current fiscal year (2083-84) plus the two following open years. That is enough
for every trigger to render; no production data was touched.

**Fixed.** All six panels render inside `ModalPanel`: the four approval dialogs,
`ReceiveVerificationModal` (shared by the Shipment Register and the transfer
receive panel) and the opening-stock Add Row dialog. Pinned by the same
`tests/modalPanel.test.ts` adoption guard, which now lists all 15 files.

**Re-measured.** 6 surfaces × 3 widths: every reading reports dialog + modal + a
name, with zero content findings. The 390 px readings report the app's known
`text-xs` residual (9.36 px at the 78% density tier); no overlay introduces a
smaller source size.

### UIX-27 — The last feature dialogs had no semantics, and three hid content

**Observed.** The three remaining feature areas still rendered their overlays as
plain divs: damage tracking (adjust count, dispose/write-off, reverse entry),
physical stock audit (submit, approve & reconcile, reject, consolidated matrix)
and serial-log correction. That is nine panels with no `role="dialog"`, no
`aria-modal`, no accessible name and no focus trap, and none had been measured.

Once opened, three of them also lost content: the damage reference ellipsized at
1067 and 390 px (7 px and 66 px cut); the audit-submit table hid 16 px of a
product name at every width and clipped 162 px of its six-column table at 390;
the consolidated matrix ellipsized **eight** product names by up to 85 px even
at 1440; and the variance-reason cell cut 4-5 px.

**Fixed.** All nine panels render inside `ModalPanel`; the direct-reconcile
panel is included even though it has no live trigger (see below). Identity cells
now wrap (`break-words` / `break-all`) instead of truncating, and both audit
discrepancy tables scroll horizontally (`overflow-x-auto`) instead of clipping at
390 px. Pinned by `tests/modalPanel.test.ts` (18 files) and the three static
checks in `tests/uiUxOverlaySweep20261031.test.ts`.

**Re-measured.** 8 reachable surfaces × 3 widths: every reading reports dialog +
modal + a name and zero clipped/ellipsized/overflow/off-viewport/mouse-only/
small-target/error findings. The full 32-surface sweep reports the same across
all 96 readings.

**Unreachable panel.** The "Direct Stock Reconcile (Admin Direct Override)"
overlay's `showDirectReconcileModal` state is only ever set to `false`; no
control sets it to `true`. It could therefore not be measured through a real
trigger. It is converted for consistency, but the dead panel should either get
its trigger back or be deleted.

## What was verified

| Surface | Trigger | 1440 | 1067 | 390 |
|---|---|---|---|---|
| Global search | header search | ok | ok | ok |
| Notification center | header bell | ok | ok | ok |
| Barcode & QR scanner | header scanner | ok | ok | ok |
| Profile / account settings | profile chip → Account Settings | ok | ok | ok |
| Shared confirm dialog | Delete Category | ok | ok | ok |
| Create product SKU | Add New Product SKU | ok | ok | ok |
| Create category | Add Category | ok | ok | ok |
| Create product group | Add Product Group | ok | ok | ok |
| Create UoM | Add New UoM | ok | ok | ok |
| Add network location / POP | Add New Location / POP | ok | ok | ok |
| Add system user | Add New User | ok | ok | ok |
| Add branch | Add New Branch | ok | ok | ok |
| Register supplier | Add New Supplier | ok | ok | ok |
| Add customer record | Add Customer Record | ok | ok | ok |
| Register fixed asset | Register Fixed Asset | ok | ok | ok |
| Record customer payment | row "Record payment" | ok | ok | ok |
| Record vendor payment | row "Record Payment" | ok | ok | ok |
| Correct warranty coverage | row "Correct warranty dates" | ok | ok | ok |
| Approval details trace | row "Details" | ok | ok | ok |
| Authorize approval | row "Approve" | ok | ok | ok |
| Reject approval | row "Reject" | ok | ok | ok |
| Cancel approval request | row "Cancel" | ok | ok | ok |
| Receive stock verification | row "Receive Stock" | ok | ok | ok |
| Opening-stock Add Row | "Add Row" | ok | ok | ok |
| Adjust damaged stock | row "Adjust local damaged stock" | ok | ok | ok |
| Dispose / write off damaged stock | row "Dispose & Write-Off" | ok | ok | ok |
| Reverse wrong damage entry | row "Reverse a wrong damage entry" | ok | ok | ok |
| Submit stock audit | count edit → "Submit for Approval Report" | ok | ok | ok |
| Approve & reconcile audit | "Approve & Reconcile Stock" (review mode) | ok | ok | ok |
| Reject stock audit | "Reject Audit" (review mode) | ok | ok | ok |
| Consolidated audit matrix | "Consolidated Matrix" | ok | ok | ok |
| Correct serial numbers | row "Correct serial numbers" | ok | ok | ok |

- Every measured overlay exposes `role="dialog"`, `aria-modal="true"` and a
  name — the four shell overlays, the shared confirm dialog, all thirteen
  record/payment/warranty dialogs, the six data-gated dialogs and the eight
  reachable feature dialogs.
- Tall panels (product 740 px at 844 viewport, purchase payment 596 px at 390)
  stay reachable: either the overlay or the panel scrolls. No panel was cut off
  with its buttons outside the viewport.
- Console, page exceptions and HTTP per overlay: none caused by opening or
  using the overlay. The only messages filtered were the dev server's HMR
  socket and the cold-boot 401s that race session hydration (the same expected
  reads the screen sweep documented).
- Screenshots retained locally for every pre-fix finding
  (`.tmp-audit/overlay-*.png`; not committed).

## Data-gated surfaces (follow-up pass)

The original pass recorded three surfaces as unmeasured because the dummy
dataset could not open them. They are now measured against seeded dummy
fixtures:

| Surface | Fixture | Result |
|---|---|---|
| Approval details / approve / reject / cancel | One pending `CUSTOMER_DEVICE_STATUS` request (APR-2083-001) | dialog + modal + name at 390/1067/1440; zero content findings |
| Receive stock verification | One `SUPPLIER_INBOUND` shipment in transit (AUDIT-RCV-001) | dialog + modal + name at all widths; zero content findings |
| Opening stock "Add Row" | One row in the open current fiscal year (2083-84) | dialog + modal + name at all widths; zero content findings |
| Stock-audit review dialogs | One pending `STOCK_AUDIT_RECONCILIATION` request for WH001, cancelled after measuring | approve/reject: dialog + modal + name; zero content findings |
| Stock-audit submit dialog | One live count edit on the unlocked table | dialog + modal + name; zero content findings |

All six data-gated dialogs were plain divs before the follow-up (UIX-26); the
feature dialogs were the same until UIX-27.

The Fiscal Year Closing wizard has no overlay of its own — its confirmations go
through the shared `DialogProvider`, which is covered above.

## Residual measurements

- **Sub-22 px targets: 0 in all 96 readings.** The 24 px `button` floor and the
  `linkButton`/`iconButton` tokens apply inside overlays as well as screens.
- **Effective type below 10 px: only at 390, and only 9.36 px** — `text-xs`
  (12 px) under the app's 0.78 phone tier, the same residual the screen sweep
  measured. No overlay introduces a smaller source size.

## Not covered

- Dark mode inside overlays; the direct-reconcile panel has no trigger to
  measure; native select popups (browser UI); axe/contrast, screen readers,
  Firefox/Safari, touch gestures, print/PDF.
- Browser zoom other than the app's own responsive tiers.

## Detector notes

- The overlay is the last visible `position: fixed` element covering the
  viewport with `z-index ≥ 50`; the panel is its `role="dialog"` descendant (or
  last child). The 390 px pass resizes the still-open overlay rather than
  reopening it, so the same DOM is measured at every width.
- Reachability walks ancestors for a vertical or horizontal scroller; a panel
  that fits, or that scrolls, is reachable even when its content is taller than
  the viewport.
- The dev server's Vite HMR socket throws on close; that message is filtered so
  a product error cannot hide behind it. Cold-boot 401s are excluded by starting
  the error window after the page has loaded.
