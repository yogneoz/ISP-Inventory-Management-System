# Field capture — technician work orders (2026-11-19)

Status: `[x]` delivered 2026-11-19 · Opened 2026-11-19 · Owner: main

**Delivered:** the first slice of field capture — installation, service and
disconnection visits that the office raises against a subscriber, a technician
is assigned to, and the visit is closed out from the field with the connection
and equipment details captured on site.

## What shipped

- **Migration `0044_field_work_orders`** (mirrored in `scripts/schema.sql`):
  `field_work_orders` with the subscriber and branch it belongs to, the visit
  kind (`INSTALL`/`SERVICE`/`DISCONNECT`), a state (`OPEN` → `ASSIGNED` →
  `COMPLETED`, or `CANCELLED`), the technician, the scheduled AD date, the
  captured connection details (ONT/router serial, assigned IP, plan) and the
  completion record. Two constraints make invalid states unwritable:
  `completed_at` exists exactly when the status is `COMPLETED`, and `ASSIGNED`
  requires a technician. A sequence issues `WO-YYYYMM-####` numbers.
- **API** `/api/field-work-orders`: branch-scoped list, detail, create, assign,
  complete and cancel. Writes derive their branch from the caller's session
  scope, refuse a subscriber or technician from another branch (400), and every
  response is `private, no-store`. Completion and assignment carry their state
  rule in the `UPDATE`, so a second completion is a 409 rather than a
  double-write.
- **Authorization:** one new operation `field-work-order`, granted by default to
  SUPER_ADMIN, HEAD_OFFICE_ADMIN, BRANCH_MANAGER, FRONT_DESK and
  FIELD_TECHNICIAN. The operation is in the permission matrix, the in-app
  permission catalogue and the tab-permission table.
- **Screen** **Sales & Customers → Field Work Orders** at `/service/work-orders`:
  summary counts, a status filter, the branch's work orders with subscriber,
  kind, schedule, technician, state and captured connection, a create dialog
  (subscriber, visit type, date, optional technician, notes), assign/reassign and
  a completion dialog (notes, ONT/router serial, IP, plan). The screen loads the
  branch's subscribers for the picker and refreshes after every write.
- **Tests:** `tests/fieldWorkOrders.api.test.ts` (4) covers the full visit
  (create → assign → complete, persisted with its timestamp), the completed-order
  refusals (409 twice), the validation refusals (unknown kind, foreign customer,
  malformed date, no row written) and authorization (no `field-work-order` is
  403 on read and write; another branch's order is 403 to read and complete; the
  list is branch-scoped rather than filtered after the fact).

## Verification

- `npx tsc --noEmit` 0.
- `tests/fieldWorkOrders.api.test.ts` 4/4 against real PostgreSQL.
- `tests/appPaths.test.ts` (route table now 110 screens) and
  `tests/registerRefreshDomains.test.ts` (the screen's server-call surface is
  pinned) — 63/63 together, including the docs screen-count claims.
- Full suite and the docs-count gate are reported in the round's session notes.

## Not in this slice (still open)

- **Offline capture.** The screen is online-only; a technician in a basement
  still cannot record a visit. This is the queued-writes work
  (`worklist/2026-11-17-advisory-hardening/README.md` → deferred), and it is the
  next slice that makes this feature usable in the field.
- **Photo/signature evidence, GPS and time-on-site.** The completion record is
  text and serials; proof-of-work attachments are not captured.
- **Scheduling board and route order.** Assignment is a name on the order, not a
  calendar with capacity or travel order.
- **Automatic follow-ups.** A completed installation does not yet create the
  subscriber's device record or first invoice; those links stay manual.
- **Technician-scoped list.** The list is branch-scoped; a technician sees the
  whole branch's orders rather than only their own queue.
