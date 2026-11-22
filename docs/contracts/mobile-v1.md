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
POST /api/v1/auth/login | req: email, password, deviceId | res: accessToken, refreshToken, expiresInSeconds, userId, email, role, employeeId, capabilities, branchScope, employeeName, branchCode
POST /api/v1/auth/refresh | req: refreshToken | res: accessToken, refreshToken, expiresInSeconds, userId, email, role, employeeId, capabilities, branchScope
POST /api/v1/auth/logout | req: refreshToken | res: loggedOut
GET /api/v1/profile | res: @self-service
GET /api/v1/documents | res: @self-service
GET /api/v1/attendance | res: @self-service
GET /api/v1/payslips | res: @self-service
GET /api/v1/leaves | res: @self-service
POST /api/v1/leaves/requests | req: @self-service | res: @self-service
POST /api/v1/leaves/requests/:id/cancel | req: @self-service | res: @self-service
POST /api/v1/leaves/requests/:id/review | req: @self-service | res: @self-service
GET /api/v1/workplace/bootstrap | res: serverTimeEpochMs, capabilities, shiftWindow, unreadNotices, pendingApprovals, vanLocation, announcements, geofence, todayAttendance
GET /api/v1/sync/pull | req: updated_since, limit | res: revokedDevice, updatedNoticesCount, changes
POST /api/v1/workplace/attendance/punch | req: action, attendanceDateAd, punchTime, latitude, longitude, accuracyMeters, wifiBssid, deviceId, deviceTimeEpochMs, idempotencyKey | res: id, attendanceDateAd, action, syncStatus, serverTimestamp, integrityStatus, riskScore, integrityNotes, checkInTime, checkOutTime, geofence, replayed
POST /api/v1/devices/register | req: deviceId, platform, appVersion, idempotencyKey | res: registered, deviceId, boundAt
POST /api/v1/notifications/fcm-token | req: token, topics | res: registered, topics
PUT /api/v1/employees/me/contact | req: phone, emergencyContactName, emergencyContactPhone | res: updated, phone, emergencyContactName, emergencyContactPhone
POST /api/v1/workplace/claims | req: claimId, employeeId, category, amount, currency, ticketCode, description, receiptAttached, idempotencyKey | res: claimId, status, accountingOutboxStatus, submittedAt
GET /api/v1/workplace/claims/:id | res: @claim-row
POST /api/v1/workplace/delegations | req: delegateEmployeeId, startDate, endDate, capabilitiesCsv, idempotencyKey | res: id, delegateEmployeeId, delegateName, startDate, endDate
POST /api/v1/workplace/jobs/:id/complete | req: baseVersion, notes, serialUsed, consumedCableMeters, consumedProductId, idempotencyKey | res: workOrderId, resultStatus, message, baseVersion
POST /api/v1/workplace/location/batch | req: deviceId, points | res: acceptedCount, receivedCount, serverTimestampEpochMs, routeSessionId
```

`POST /leaves/requests/:id/review` requires an explicit boolean `approve`: the
route is refused with `400 VALIDATION_ERROR` when the flag is missing, so a
stripped offline replay can never decide a leave request by omission.

`@self-service` means the route calls the existing employee self-service handler,
so its request and response are the ones the web ESS page already uses — they are
covered by `tests/hrSelfService*.api.test.ts` (including
`hrSelfServiceLeaveWrite.api.test.ts`) rather than duplicated here. `@claim-row`
is the stored claim record.

The punch is the one route where the client's own measurement is never trusted:
`distanceMeters` is computed on the server from the employee's branch geofence
(`branch_geofences`), and a branch with no fence imposes no distance requirement.
`geofence` in the response echoes that server verdict.
