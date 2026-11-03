# Per-user permission overrides — design plan and recommendation

Status: **phases 1–2 implemented 2026-11-01** — table, resolver,
`/api/permissions/me`, the Super Admin-only override endpoints (21 tests), and
the `Settings → User Permissions` screen with the client effective-set
integration (14 tests). The reusable permission sets (§10, "Phase 2 — reusable
sets") are still open.
Date: 2026-10-31
Related: [authorization-audit-2026-10-28.md](authorization-audit-2026-10-28.md),
`client/src/utils/permissionMatrixData.ts`, `server/src/middleware/index.ts`,
`client/src/features/settings/PermissionManagement.tsx`

## 1. The request

Some staff need an operation their role does not grant — for example a Branch
Manager who also settles vendor payments, or an Accountant allowed to mark
damage. Today the only way to give that to one person is to change the role for
everyone, or to add a new role. Both are too blunt.

Goal: grant or deny **individual operations to one user**, on a dedicated screen,
without changing what their role means for anyone else.

## 2. What exists today

| Layer | Current behaviour |
| --- | --- |
| Storage | `permission_matrix(operation_id, role, allowed)` — one boolean per operation × role. |
| Server check | `requirePermissionAny(...)` reads the in-memory `permissionMatrix[op][role]`; `SUPER_ADMIN` bypasses. |
| Client check | `isOperationAllowed(opId, role)` reads the same matrix (server copy after bootstrap, compiled defaults before). |
| Navigation | `isTabAccessible` maps tabs to operation ids and calls `isOperationAllowed`. |
| Branch scope | Separate: signed `branchId` + `allowedBranchIds`, enforced by `enforceBranchAccess`. |
| Edits | `PUT /api/permissions` replaces the whole role matrix (Super Admin only tab). |

There is **no** user-level grant anywhere, and the signed auth token deliberately
carries identity, role and branch scope only — not permissions.

## 3. Recommendation (short version)

Add a **user override layer on top of the role matrix**:

```
effective(user, operation) =
  SUPER_ADMIN                          -> allowed (locked)
  explicit override for this user      -> grant / deny
  otherwise                            -> permission_matrix[operation][user.role]
```

- `deny` always wins over any grant from the role matrix (and, later, from a
  permission set).
- No override row means “inherit”, so existing users and the current matrix keep
  working with zero backfill.
- Build the per-user screen now. Build reusable permission **sets** only in a
  second phase, when several users need the same bundle (see §10).

This is the smallest model that satisfies “some users get extra permissions”
without turning roles into per-person copies.

## 4. Options considered

### A. Per-user overrides (recommended)

One table keyed by `(user_id, operation_id)` with an effect. Readable, auditable,
reversible per person. Cost: one more layer in the resolver, one more screen.

### B. Permission sets / groups

Named bundles (`Accounts desk`, `Damage control`) assigned to users, several per
user, unioned with the role base. Scales better when many users share extras,
but adds three tables, set management screens, and a second place to look when
someone asks “why can this person do that?”. It is a superset of A, not a
replacement: expressive denies still belong at the user level.

### C. More roles

Copy a role for every combination. Explodes the matrix and every
`canUserSeeAllBranches` / tab / workflow list that names roles. Not viable.

### D. Store permissions in the signed token

Tempting because every request already verifies a token. Rejected: a token lives
for its TTL, so revoking an override would not take effect until re-login, and
the token would grow with every operation. Resolve on the server from data;
treat the client copy as display state only.

## 5. Data model

```sql
CREATE TABLE user_permission_overrides (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id  TEXT NOT NULL,
  effect        TEXT NOT NULL CHECK (effect IN ('grant', 'deny')),
  reason        TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, operation_id)
);

CREATE INDEX user_permission_overrides_user_idx
  ON user_permission_overrides (user_id);
```

Notes:

- `ON DELETE CASCADE` means deleting a user removes their exceptions; no orphan
  grants.
- An expired row is ignored by the resolver but kept for audit until cleanup.
  This lets an admin say “grant for the audit window” without a follow-up task.
- `operation_id` is validated against the operations catalogue (§7), not against
  `permission_matrix` rows, so a brand-new operation can be granted before the
  matrix has a row for it.
- No branch column. Branch scope stays on the user; an override must never widen
  what rows a user can read (see §8).

Add the table to `scripts/schema.sql` **and** `scripts/setup_db.js`, and add a
boot-time `CREATE TABLE IF NOT EXISTS` path alongside the matrix loader so an
existing installation upgrades without a manual migration.

## 6. Resolution

One function, used by every enforcement point:

```ts
export function effectivePermission(
  user: Pick<User, 'id' | 'role'>,
  operation: string,
  matrix: Record<string, Record<string, boolean>>,
  overrides: Map<string, Map<string, 'grant' | 'deny'>>,
  now = Date.now()
): boolean {
  if (user.role === 'SUPER_ADMIN') return true;          // never lock out the owner
  const override = overrides.get(user.id)?.get(operation);
  if (override === 'grant') return true;
  if (override === 'deny') return false;
  return Boolean(matrix[operation]?.[user.role]);
}
```

Rules, in order:

1. **Super Admin is immutable.** Override rows for a Super Admin are rejected by
   the API and ignored by the resolver. This is the anti-lockout rule.
2. **User deny beats everything** except rule 1.
3. **User grant** allows an operation the role does not have.
4. **No row** inherits the role matrix exactly as today.
5. **Unknown operation ids** are rejected at write time and fail closed at read
   time.

The same function backs `GET /api/permissions/me` and the full bootstrap so the
client and the server cannot disagree about precedence.

## 7. Operations catalogue

The screen needs operation names, descriptions and grouping. Those live today
inside `DEFAULT_GROUPS` in `PermissionManagement.tsx`, while the ids and role
defaults live in `permissionMatrixData.ts`. Before building the screen, extract
the catalogue:

```
client/src/utils/permissionCatalog.ts   // id, group, label, description
client/src/utils/permissionMatrixData.ts // defaults only, imports the catalog ids
```

Both the global matrix screen and the new user screen read the same catalogue.
This also gives the server a single list for write validation — generate
`shared/permissionOperations.ts` (or import the client module in the server the
way `DEFAULT_PERMISSIONS_MATRIX` already is) so an unknown id is a 400.

## 8. Server enforcement

- Add `userPermissionOverrides` to runtime state, loaded at boot after the
  matrix. Keep a `permissionsVersion` counter that increments on every write.
- Replace the role lookup inside `requirePermissionAny` with
  `effectivePermission(user, op, ...)`.
- Any other direct matrix read must move to the resolver. A current grep finds
  three: `shipments.controller.ts` (lane operation check),
  `misc.controller.ts` (workflow-approval-cancel) and
  `bootstrap.controller.ts` (`canReadAuditLogs`). A grep gate
  (`tests/noInlineMatrixRead.guard.test.ts`) should fail on new direct
  `permissionMatrix[...][role]` reads outside the resolver.
- **Branch scope is untouched.** `enforceBranchAccess` continues to run after
  the permission check; an override can open an operation, never a branch.
- `SUPER_ADMIN` bypass stays exactly where it is, including branch bypass.

Cache consistency: the matrix is an in-process cache today, so a write on one
instance is not seen by another until restart. Overrides inherit that property.
Add a 30-second TTL (or reload on version mismatch) for the override map so a
second instance converges without a restart; call that out as an improvement,
not a new guarantee.

## 9. API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/permissions/me` | any signed-in user | `{ operations: string[], version, role }` — the effective set for the current session. |
| GET | `/api/users/:id/permission-overrides` | SUPER_ADMIN | base role matrix, override rows, and resolved effective set for one user. |
| PUT | `/api/users/:id/permission-overrides` | SUPER_ADMIN | Replace this user’s override rows atomically; body `{ overrides: [{ operationId, effect, reason, expiresAt? }] }`. |
| GET | `/api/bootstrap` | any signed-in user | Adds `effectivePermissions` and `permissionsVersion` to the existing payload. |

Put the write behind **SUPER_ADMIN only**, deliberately not behind
`admin-users`: a Head Office Admin who manages staff must not be able to grant
themselves operations. The screen lives in Settings next to the matrix and is
hidden for every other role.

Validation on PUT:

- every `operationId` is in the catalogue;
- `effect` is `grant` or `deny`;
- `reason` is non-empty (audit requirement);
- `expiresAt` is absent or in the future;
- the target user exists and is not a Super Admin;
- unknown body keys are rejected rather than silently ignored.

Response returns the new effective set so the editing screen can update without
a second round trip.

## 10. New screen: `Settings → User Permissions`

A dedicated screen, not another block inside the role matrix:

```
┌ Users ─────────────┬ Permissions for: Sita Sharma  [BRANCH_MANAGER] ────────────┐
│ search…            │ 3 extra grants · 1 denial · 2 expired                          │
│ ● Sita Sharma      │ [x] Show only differences from the role                        │
│   Ram Bahadur      │                                                                │
│   …                │ ▾ Procurement & Purchasing                                     │
│                    │   Create Purchase Orders   Role: allowed   ( Inherit ) Grant  Deny │
│                    │   Record Purchase Invoices Role: denied    ( Inherit ) Grant  Deny │
│                    │        └ Grant · reason: settles vendor bills · no expiry        │
│                    │ ▾ Warehouse Logistics …                                        │
│                    │ …                                                              │
│                    │ [Reset changes]                         [Save 4 overrides]       │
└────────────────────┴────────────────────────────────────────────────────────────────┘
```

Behaviour:

- **User list** with search; role and branch scope shown, so the admin can see
  that a grant does not change either.
- **Tri-state per operation**: Inherit (default), Grant, Deny. The base role
  result is always visible (“Role: allowed”), so “Grant” is never mistaken for
  the source of an already-allowed operation.
- **Differences filter** on by default after the first override; “Show all” for
  review.
- **Reason required for every override**; optional expiry with a date picker
  (AD/BS consistent with `DateField`).
- **Save is atomic** for the user; “Reset changes” restores the server state.
- **Effective preview** line per group (“effective: 4 of 7”) and a top-level
  count of operations the user can perform.
- **Revoke all** with a confirmation that names the user.
- **Read-only banner** for Super Admin target: “Super Admin always has every
  operation; overrides do not apply.”
- **Branch warning**: “Grants widen what this person can do, not which branches
  or rows they can see.”

The existing matrix screen keeps its job: role defaults for everyone. Add a
small cross-link from a matrix cell to “users with an override for this
operation”, so an admin can see exceptions from either direction.

### Phase 2 — reusable sets

> **Shipped 2026-11-01.** The three tables, set-aware resolver, Super-Admin-only
> definition/membership endpoints and the screen tabs are implemented. Resolution
> is SUPER_ADMIN → explicit override → assigned set grants → the role matrix, so
> a deny still wins; sets are grants-only and never touch branch scope. See
> [2026.md](session-notes/2026.md#-reusable-permission-sets--phase-2-named-grant-bundles-2026-11-01).

Only if several users repeat the same bundle:

```sql
permission_sets(id, name, description)
permission_set_grants(set_id, operation_id)
permission_set_members(user_id, set_id)
```

Resolution becomes: role base ∪ grants from all sets, then user overrides
(deny wins). The screen gains a “Sets” tab and the user editor lists assigned
sets plus individual exceptions. Do not build this in the first change: per-user
rows already answer the stated need, and sets can be layered on later without
changing the resolver contract.

## 11. Client integration and invalidation

- `applyEffectivePermissions(set | null)` in `client/src/utils/permissions.ts`,
  mirroring `applyServerMatrix`. `isOperationAllowed` consults it first when it
  is non-null, otherwise falls back to the role matrix (first paint before
  bootstrap).
- `TAB_PERMISSIONS` / `isTabAccessible` need no new mapping — they already go
  through `isOperationAllowed`, so a granted operation reveals its screen.
- On login, bootstrap, and every `PERMISSIONS` SSE event, refetch
  `/api/permissions/me` and bump the existing `permissionsVersion` state in
  `App.tsx` so the sidebar re-renders.
- On logout **and profile switch**, clear the effective set together with the
  branch-scoped caches (`resetBranchStock`, `resetExchangeDevices`,
  `resetAvailableFixedAssets`, `resetProcurementPending`). Leaking the previous
  profile’s grants into a switch session is the same class of bug those resets
  were added for.
- The server remains authoritative for every mutation; the client set is for
  showing/hiding, never for authorising a request.

## 12. Audit, safety and operations

- Every PUT writes one `UPDATE_USER_PERMISSIONS` audit event per changed user
  with `grant op`, `deny op`, `reason`, and the actor; the existing permission
  matrix audit is the precedent.
- `expires_at` is evaluated on read. Add a nightly cleanup (or ignore-on-read
  only) so expired rows do not accumulate; exposing “expired” in the screen is
  enough for the first version.
- Anti-lockout: a user cannot be denied `admin-users` and `admin-fiscal` into a
  state with no Super Admin — Super Admin is immutable, and a non-Super-Admin
  cannot be promoted by an override.
- Deleting a user cascades their overrides. Deleting a branch does not touch
  permissions, but the effective set is branch-independent.
- Multi-instance note: same eventual consistency as the matrix today; TTL as
  described in §8.

## 13. Tests

Server/repo:

1. Resolver: grant wins over a denied role default; deny wins over an allowed
   role default; absent row inherits; unknown operation fails closed; Super
   Admin ignores both; expired grant falls back to role.
2. HTTP: a granted operation opens a route that returned 403 for that role; a
   denied operation closes a route the role normally reaches; a non-Super-Admin
   cannot call the override endpoints; a Super Admin target is rejected; an
   unknown operation id is 400; the audit row is written.
3. Bootstrap/`/me`: the effective set matches the resolver, including after a
   write, and is scoped to the signed-in user (two accounts, two sets).
4. Schema: the table, FK and cascade exist in both schema sources; the no-inline
   matrix-read guard fails on a direct role lookup outside the resolver.

Client/screen:

5. `isOperationAllowed` prefers the effective set and falls back to role when
   it is cleared; clearing on profile switch/logout is asserted at the App level.
6. A granted tab becomes visible in the sidebar for the affected user and not
   for another user of the same role.
7. Screen: tri-state saves only differences; reason required; expiry round-trip;
   Super Admin read-only; effective preview matches the server response.

Docs: update README/handoff/session notes and the test-count gate with the real
suite number, as every round does.

## 14. Rollout

1. Ship the resolver and table with no rows (behaviour identical to today) plus
   the tests; verify the full suite.
2. Ship `/api/permissions/me`, bootstrap payload and client fallback; verify tab
   gating is unchanged for accounts without overrides.
3. Ship the screen behind the Super Admin tab guard.
4. Use it for the first real exception, then review whether a second user needs
   the same bundle; only then decide on Phase 2 sets.

## 15. Estimate and acceptance

Rough effort: Phase 1 is 2–3 developer-days including tests and docs; Phase 2
adds 1–2 days.

Done when:

- an admin can grant one extra operation to one user and that user sees the tab
  and can complete the action after re-login;
- the same role, without the override, still cannot;
- a deny removes a normally-allowed action for that one user;
- every change shows in the audit trail with a reason and survives a refresh;
- no route or screen reads the role matrix directly for authorisation;
- branch visibility is unchanged by any override.
