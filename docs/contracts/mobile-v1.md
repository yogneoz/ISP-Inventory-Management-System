# Mobile contract — `/api/v1/*` (PulseHR)

This file is the single source of truth for the wire shape the PulseHR app is
coded against. `scripts/check_contract_parity.ts` (`npm run check:contract-parity`)
reads the machine block below, diffs it against the routes registered in
`server/src/routes/mobile.routes.ts`, and checks that every documented field name
still appears in the controller/service that produces it. A route added without
a line here, or a field renamed in code, fails the build.

Editing rule (see `AGENTS.md`): a change to a route, table or field that the app
consumes ships with this file, the fixture in `tests/mobileApi.api.test.ts`, and
a contract test, in the same commit.

## Envelope

Every error the app can receive has one shape:

```json
{ "code": "SHORT_CODE", "message": "human readable", "retryable": false, "details": {} }
```

- `code` is stable and safe to switch on; `message` may be reworded at any time.
- `retryable: true` means the offline queue should retry the same
  `idempotencyKey` later; `false` means the action is refused and must be
  dropped or fixed by the user.
- `details` is optional and route-specific (validation field, conflict reason).

## Authentication

`POST /api/v1/auth/login` is the only unauthenticated route. Everything else
takes `Authorization: Bearer <accessToken>` — the same HMAC token the web client
uses, so the existing branch and permission gates apply unchanged. The employee
is always derived from the token; a body `employeeId` that names someone else is
refused with 403.

Access tokens live 8 hours (`expiresInSeconds`). Refresh tokens are single-use
and rotate on every call: presenting a consumed token fails with 401. They are
stored hashed (`mobile_refresh_tokens`), so a database read cannot be replayed.

## Idempotency

Every write accepts `idempotencyKey` in the body (or `x-idempotency-key`). The
key is scoped per operation, so the same string in a punch and a claim is two
different keys. A repeated key replays the stored response with
`"replayed": true` and status 200 instead of re-running the write.

## Versioning and sync

- `GET /api/v1/sync/pull?updated_since=<seq>&limit=` returns rows ordered by the
  monotonic `mobile_change_log.seq`. Send back the `seq` of the last row you
  stored; an empty `changes` array means you are current.
- Work-order completion carries `baseVersion` (the `row_version` the device
  downloaded). A stale version is refused with 409 and no write.
- The surface is additive-only within `/api/v1`: adding a field is fine, renaming
  or removing one needs a new prefix (the app cannot be force-updated).

## Routes

```contract
POST /api/v1/auth/login | req: email, password, deviceId | res: accessToken, refreshToken, expiresInSeconds, userId, email, role, employeeId, capabilities, workplaceCapabilities, branchScope, employeeName, branchCode
POST /api/v1/auth/refresh | req: refreshToken | res: accessToken, refreshToken, expiresInSeconds, userId, email, role, employeeId, capabilities, workplaceCapabilities, branchScope
POST /api/v1/auth/logout | req: refreshToken | res: loggedOut
POST /api/v1/auth/re-auth | req: password | res: reAuthToken, expiresInSeconds
GET /api/v1/profile | res: employeeCode, name, branchId, branchName, department, designation, employmentType, workStation, joiningDateAD, contractExpiryAD, internalEmail, personalEmail, personalContact, emergencyContactPerson, emergencyContactNumber, address, isActive, profilePhoto
GET /api/v1/hr/me/sensitive | req: x-reauth-token | res: employeeCode, panNumber, ssfNumber, ssfEligible, bankName, bankAccount, monthlySalary, viewedAt
GET /api/v1/documents | req: x-reauth-token | res: @self-service
GET /api/v1/attendance | res: @self-service
GET /api/v1/payslips | req: x-reauth-token | res: @self-service
GET /api/v1/leaves | res: @self-service
POST /api/v1/leaves/requests | req: @self-service | res: @self-service
POST /api/v1/leaves/requests/:id/cancel | req: @self-service | res: @self-service
POST /api/v1/leaves/requests/:id/review | req: @self-service | res: @self-service
GET /api/v1/workplace/bootstrap | res: serverTimeEpochMs, capabilities, workplaceCapabilities, needsAttention, shiftWindow, unreadNotices, pendingApprovals, vanLocation, announcements, geofence, todayAttendance
GET /api/v1/sync/pull | req: updated_since, limit, deviceId | res: serverCursor, revokedDevice, updatedNoticesCount, changes
POST /api/v1/sync/push | req: deviceId, actions | res: receivedCount, acceptedCount, flaggedCount, heldCount, rejectedCount, results, serverTimestampEpochMs
POST /api/v1/workplace/attendance/punch | req: action, attendanceDateAd, punchTime, latitude, longitude, accuracyMeters, wifiBssid, deviceId, deviceTimeEpochMs, idempotencyKey | res: id, attendanceDateAd, action, syncStatus, serverTimestamp, integrityStatus, riskScore, integrityNotes, verdict, heldReason, checkInTime, checkOutTime, geofence, replayed
POST /api/v1/devices/register | req: deviceId, platform, appVersion, idempotencyKey | res: registered, deviceId, boundAt
POST /api/v1/notifications/fcm-token | req: token, topics | res: registered, topics
PUT /api/v1/employees/me/contact | req: phone, emergencyContactName, emergencyContactPhone | res: updated, phone, emergencyContactName, emergencyContactPhone
POST /api/v1/workplace/claims | req: claimId, employeeId, category, amount, currency, ticketCode, description, receiptAttached, idempotencyKey | res: claimId, status, accountingOutboxStatus, submittedAt
GET /api/v1/workplace/claims/:id | res: @claim-row
POST /api/v1/workplace/delegations | req: delegateEmployeeId, startDate, endDate, capabilitiesCsv, idempotencyKey | res: id, delegateEmployeeId, delegateName, startDate, endDate
POST /api/v1/workplace/jobs/:id/complete | req: baseVersion, notes, serialUsed, consumedCableMeters, consumedProductId, idempotencyKey | res: workOrderId, resultStatus, message, baseVersion
POST /api/v1/workplace/jobs/:id/assign | req: technicianId, overrideReason | res: workOrderId, workOrderNo, technicianId, technicianName, scheduledDateAD, status, overridden, overrideRules
GET /api/v1/workplace/jobs/:id/evidence | res: workOrderId, evidence, count
POST /api/v1/workplace/jobs/:id/evidence | req: kind, contentType, dataBase64, caption, capturedAtEpochMs, latitude, longitude, accuracyMeters | res: evidenceId, workOrderId, kind, contentType, byteSize, sha256, capturedAt, inserted, count
POST /api/v1/workplace/location/batch | req: deviceId, points | res: acceptedCount, receivedCount, serverTimestampEpochMs, routeSessionId
GET /api/v1/workplace/jobs | res: jobs, count
GET /api/v1/workplace/stock | res: vanLocation, holdings, count
GET /api/v1/workplace/approvals | res: claims, punches, delegations, counts
POST /api/v1/workplace/approvals/:kind/:id | req: approve, note | res: id, status, accountingOutboxStatus, decidedAt, decidedBy, delegated
```

## Offline push

`POST /api/v1/sync/push` takes `{ "actions": [{ "clientId", "kind",
"idempotencyKey", "payload" }] }` — at most 50 items, `kind` one of `PUNCH`,
`CLAIM`, `WORK_ORDER_COMPLETE` — and applies each through the same service the
single-action route uses. The answer is per item:

```json
{
  "clientId": "q-17",
  "kind": "CLAIM",
  "status": "REJECTED",
  "code": "VALIDATION_ERROR",
  "message": "A claim needs a positive amount.",
  "retryable": false,
  "result": null
}
```

`status` is `ACCEPTED`, `FLAGGED` (a punch outside the fence), `HELD` (a punch
whose device clock is far off) or `REJECTED`. A rejected item's **whole payload
is retained on the server**, keyed by `(employee, clientId)`, and counts in the
bootstrap's `needsAttention` — so a photo or reading captured in a basement
survives a refusal and can be fixed and re-sent. One refusal never fails the
batch: the other items still apply.

## Sensitive reads

`POST /api/v1/auth/re-auth` takes the account password and returns
`reAuthToken`, which lives **five minutes**. Send it as `x-reauth-token` on
`GET /api/v1/payslips`, `GET /api/v1/documents` and
`GET /api/v1/hr/me/sensitive`. A missing, expired or wrong-user token is
`401 { "code": "REAUTH_REQUIRED", "retryable": false }` — that is the app's cue
to show its PIN/biometric prompt; it is **not** a dead session.

`GET /api/v1/profile` deliberately carries no PAN, SSF, bank or salary field:
the everyday card is safe to cache and to show on a locked phone. Every open of
a sensitive route writes an audit row (`MOBILE_SENSITIVE_VIEW`) with the user and
branch before the data is sent.

## Capabilities

`login`, `refresh` and `workplace/bootstrap` return `workplaceCapabilities`: the
design's ten stable names (`attendance.punch`, `ess.view`, `claims.submit`,
`jobs.execute`, `stock.van`, `dispatch.assign`, `roster.manage`,
`approve.attendance_ot`, `approve.expense`, `audit.stock`) that the home screen
assembles itself from. They are a **view** of the existing operation set (still
returned as `capabilities`), not a second permission system: the catalogue in
`shared/workplaceCapabilities.ts` maps each name to the operations that imply
it. A capability the caller does not hold is simply absent.

## Approvals

`GET /api/v1/workplace/approvals` lists the caller's branch's submitted expense
claims and its flagged/held punches from the last 14 days. The caller's **own**
rows are excluded in SQL and refused by id with `403` — nobody approves their
own claim or reviews their own punch.

`POST /api/v1/workplace/approvals/EXPENSE_CLAIM/:id` takes `{ "approve": true,
"note"?: string }` and answers the decided claim; a second decision is `409`.
`POST /api/v1/workplace/approvals/PUNCH/:attendanceId` records a supervisor's
review (`reviewedAt`, `reviewedBy`, `verdict` unchanged) so payroll can tell the
punch apart from an unreviewed one.

Authority is either the `hr-attendance-manage` operation **or** an active
`hr_delegations` row for the caller covering `approve.expense` /
`approve.attendance_ot`; a delegated decision returns `"delegated": true` and
its audit row names the delegator. Delegations were previously written and
never read.

## Punch verdicts

A punch is stored and judged, never refused for being suspicious:

| `verdict` | When | What the app does |
| --- | --- | --- |
| `ACCEPTED` | inside the fence, accurate fix, clock within 15 min | nothing |
| `FLAGGED` | outside the fence, or a coarse fix (accuracy > 50 m) | show a review badge; the punch still counts |
| `HELD` | device clock differs from the server by more than 15 min | keep the item in Needs attention; a supervisor confirms the time |

`heldReason` names why (for example `Device clock differs from the server by 180
minute(s)`), and `geofence` still reports the server's own distance so a wrong
location is visible even though the punch was accepted. `integrityStatus` stays
`VERIFIED` / `SUSPECT` / `HELD` for the existing supervisor screens.

## Devices

A successful password login admits the device it names (`approved_at`), and a
device bound to another employee fails with `403`. `POST
/api/admin/mobile-devices/:deviceId/revoke` (Super Admin) takes a lost or shared
phone out of service: the next login is refused with `403` and the next
`sync/pull?deviceId=…` answers `"revokedDevice": true`, which is the app's cue to
wipe its local data.

`POST /leaves/requests/:id/review` requires an explicit boolean `approve`: the
route is refused with `400 VALIDATION_ERROR` when the flag is missing, so a
stripped offline replay can never decide a leave request by omission.

## Proof of work

`POST /api/v1/workplace/jobs/:id/evidence` stores a photo or a signature captured
at the customer's premises. `kind` is `PHOTO` or `SIGNATURE`, `contentType` is
`image/jpeg`, `image/png` or `image/webp`, and `dataBase64` is the image (a
`data:` URL prefix is accepted). The capture is capped at 2 MiB, and
`capturedAtEpochMs` may not be more than 15 minutes ahead of the server — the
same skew tolerance a punch gets. The cap is measured on the decoded bytes: the
evidence routes accept a request body up to 4 MiB (the base64 of a 2 MiB image),
while the rest of the API keeps the 1 MB JSON default. A larger image is a
`400` naming the ceiling, not the generic `request entity too large`.

The bytes are **content-addressed per order**: sending the same capture again
(the queued item retried after a timeout) returns the stored row with
`"inserted": false` and an unchanged `count` instead of a duplicate. A capture
is accepted on an open, assigned or completed job, so an offline technician can
complete the visit and upload the proof when the network returns. `GET` returns
the metadata (`sha256`, `byteSize`, `capturedAt`, `caption`) — never the bytes —
and the job must be assigned to the caller.

## Dispatch

`POST /api/v1/workplace/jobs/:id/assign` dispatches an open or assigned job to a
technician in the caller's branch. Two rules apply:

| rule code | refuses when | remedy |
| --- | --- | --- |
| `NO_ROSTER_SEAT` | the technician has no `employee_shift_roster` seat on the visit's date | roster the technician, or override |
| `DAILY_JOB_CAP` | the technician already holds 8 open/assigned jobs that day | pick another technician, or override |

A refusal is `409 { "code": "DISPATCH_RULE" }` and the message names the rule.
A **supervisor** (Super Admin, Head Office Admin or Branch Manager) may waive
either rule by sending `overrideReason` of at least 15 characters; the response
reports `"overridden": true` with the waived `overrideRules`, and the order
stores who waived what and when. A non-supervisor's override is `403`; a short
reason is `400`. Branch membership and "that technician exists in this branch"
are never overridable.

## Claims and the accounting outbox

`accountingOutboxStatus` is a real queue state, not a placeholder:

| status | meaning |
| --- | --- |
| `PENDING_APPROVAL` | submitted; nothing may post until a supervisor decides |
| `QUEUED` | approved; the posting is owed and the flusher will post it |
| `POSTED` | the journal exists (the register shows its number) |
| `FAILED` | the attempt raised; the reason is recorded and it is retried |
| `CANCELLED` | rejected or withdrawn; nothing is owed |

An approved claim posts Dr salary expense / Cr salary payable with
`source_type = EXPENSE_CLAIM` and the claim id as the source, so one claim can
never post twice. `GET /api/v1/workplace/claims/:id` returns the claim row; the
status is read from the outbox by the approval response.

`@self-service` means the route calls the existing employee self-service handler,
so its request and response are the ones the web ESS page already uses — they are
covered by `tests/hrSelfService*.api.test.ts` (including
`hrSelfServiceLeaveWrite.api.test.ts`) rather than duplicated here. `@claim-row`
is the stored claim record.

The punch is the one route where the client's own measurement is never trusted:
`distanceMeters` is computed on the server from the employee's branch geofence
(`branch_geofences`), and a branch with no fence imposes no distance requirement.
`geofence` in the response echoes that server verdict.
