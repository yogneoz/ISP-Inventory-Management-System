# Round 14 — Module-scoped API keys, governance and administration UI

Status: `[x]` delivered 2026-11-19 as [Round 15 Part C](../2026-11-17-advisory-hardening/README.md#part-c--carried-from-round-14) · Opened 2026-11-16

Source: the 2026-11-16 API-key task in the mandate. Depends on Round 13's
shared state ([SCALE-1](../2026-11-16-enterprise-scale-and-public-exposure/README.md#scale-1--shared-state-and-horizontal-workers))
and public-exposure work
([PUB-3](../2026-11-16-enterprise-scale-and-public-exposure/README.md#pub-3--public-surface-distributed-limits-mfa-setup-lockout)).

Goal: let an administrator issue a scoped, expiring, revocable credential to an
external system (RADIUS/AAA, billing portal, mobile field app, e-invoicing) that
is enforced by the **existing** RBAC, branch-scope and fiscal-year gates — not a
parallel authorization path — and let the administrator see how it is used.

## Why this round exists

External integrations currently have only two options: a human login token or
nothing. A shared human account cannot be scoped to one module, cannot be
limited to a branch or a CIDR, is valid for eight hours, and cannot be revoked
without changing the person's password. On a public domain that is unacceptable
for a machine-to-machine credential.

The design goal is least privilege at the operation level: a `SALES` key that
can read invoices and create payments for branch `WH001` must be denied a
`FINANCE` journal read, denied inventory, and denied branch `WH002` — even
though the key was issued by a Super Admin.

## Current state

| Area | Today | Gap |
|---|---|---|
| API credentials | `api_keys` + `api_key_audit_logs` (migration `0043_api_keys`), `apiKeyAuth`, `/api/admin/api-keys` and the API Creator screen — delivered 2026-11-19 (implementation record below) | Closed |
| Operation vocabulary | kebab-case codes in `DEFAULT_GROUPS` (`client/src/features/settings/permissionGroups.ts`): `po-create`, `sales-invoice-create`, `gl-view`, … | APIK-2 maps module → these codes; the mandate's dotted examples (`sales.invoice.read`) do not exist in this tree |
| Branch IDs | `branches.id VARCHAR(50)`, `users.allowed_branch_ids TEXT[]` | `branch_ids` must be `TEXT[]`, not `int[]` |
| Authorization | `requireAuth` / `requirePermission` / `enforceBranchAccess` / `enforceFiscalYearWriteGate` assume a session user with a role | APIK-3 must add a principal kind without faking `SUPER_ADMIN` |
| Rate limiting | in-process (`authRateLimit.ts`); no Redis | APIK-3 depends on SCALE-1 |
| MFA | none | Resolved without MFA by decision: create/rotate/revoke are gated on the seeded `admin-api-keys` operation (SUPER_ADMIN + HEAD_OFFICE_ADMIN) plus the RBAC/branch/fiscal-year guards; no MFA subsystem was scaffolded |
| Audit | `audit_logs` with a CHECKed module vocabulary (`schema.sql:4123-4132`), `tests/auditModuleVocabulary.guard.test.ts` | Add an API-key audit table and, if reusing `audit_logs`, an `API_KEYS` module entry |
| Migrations | 28 files, latest `0029_gl_account_statutory_reference` | Take the next free number; H6 may claim `0030` first |
| Admin nav | `Administration & Governance` (`Sidebar.tsx`) with Setup and Governance sections | APIK-5 delivered: **API Creator** in the Setup section, `React.lazy`, canonical path `/settings/api-keys`, tab gate `admin-api-keys` |
| Bundle gate | entry 20.125 kB / total 320 kB (current budget comments) | New screen must be `React.lazy`, not in the startup graph |

## Decisions

1. **Opaque high-entropy secret, hashed at rest.** 32 random bytes, encoded
   base64url, prefixed `isp_live_` (production) or `isp_test_`. Stored as
   SHA-256 hex (`CHAR(64)`), never reversible. A 256-bit random secret does not
   need a slow KDF; it does need a constant-time compare.
2. **`key_prefix` is the O(1) discriminator, not the secret.** Store 10 random
   base62 characters in `VARCHAR(12)` and display `isp_live_<prefix>`. The
   unique index on `key_prefix` makes lookup one index probe; the full secret
   is never indexed or logged. The mandate's `isp_live_a1b2` illustration is
   shorter than the column needs to avoid collisions at scale; the stored
   prefix stays within `VARCHAR(12)`.
3. **The module is a closed vocabulary, the operations are the existing
   matrix.** `module_scope` is one of `FINANCE`, `INVENTORY`, `PROCUREMENT`,
   `SALES`, `HR_PAYROLL`, `WARRANTY_RMA`, `ALL_MODULES`. `permissions` is a
   `TEXT[]` of existing operation codes. A creation-time validator rejects an
   operation outside the scope, and a unit test asserts the module→operation
   map covers every operation in `DEFAULT_GROUPS` exactly once (no orphan, no
   duplicate). Do not invent a second permission vocabulary.
4. **Branch IDs are `TEXT[]`.** `NULL` means all branches and is allowed only
   for `ALL_MODULES` keys created by a Super Admin; a scoped key must name at
   least one active branch. The middleware and the SQL scope both enforce the
   list.
5. **A key is a principal, not a user.** `req.auth = { kind: 'apiKey', keyId,
   moduleScope, permissions: Set<string>, branchIds, ... }`. `req.user` gets a
   synthetic, non-privileged view only for audit fields (`email:
   api-key:<name>`, `branchId` = the key's single branch or `ALL`) and **never**
   a real role such as `SUPER_ADMIN`. `requireAuth`, `requirePermission`,
   `enforceBranchAccess` and the fiscal-year gate learn about the principal;
   `sessionStillValid`/`ver` are skipped for keys.
6. **A key can only reach a route that evaluated an operation.** Add
   `req.permissionChecked` in `requirePermission`/`requirePermissionAny` and a
   final API-key guard that rejects (403) when the flag is absent. This closes
   routes guarded only by `enforceOperationalPermissions`' role list, and makes
   `/api/admin/*`, `/api/auth/*`, `/api/permissions*` and `/api/bootstrap*`
   unreachable to keys by construction. Test it.
7. **Rate limit per key, in Redis.** `rate_limit_rpm` (1–60,000, default 60) is
   a sliding window keyed `apikey:rl:<id>`; the response carries
   `X-RateLimit-Limit/Remaining/Reset` and `429` + `Retry-After`. The limiter is
   shared across workers (SCALE-1) and fails closed if Redis is unavailable.
8. **`last_used_at`/`last_used_ip` are debounced.** Write at most once per
   minute per key (Redis `SET NX PX 60000` then a batched update), so a
   high-throughput integration does not turn reads into row updates.
9. **Audit is append-only and bounded.** `api_key_audit_logs` records
   `CREATE`, `ROTATE`, `REVOKE` and `DENIED` always; `USE` is sampled/optional
   (`API_KEY_LOG_USAGE=1`, default off) because per-request rows would grow
   faster than the ledger. A `BEFORE UPDATE OR DELETE` trigger raises. The
   governance screen reads this table with keyset pagination.
10. **Rotation is a grace period, not a rename.** `POST /:id/rotate` creates a
    new row (`rotated_from_id`), returns its secret once, and sets the old key's
    `expires_at` to `now + graceHours` (default 24, max 168) if it had a later
    expiry. Both keys work during the grace window; the old one is not
    silently deleted.
11. **Revocation is immediate on every worker.** Set `is_active = false`,
    `revoked_at`, `revoked_by`, then delete/invalidate the Redis lookup for the
    prefix. The authentication path must not cache a positive key for longer
    than the revocation channel's latency (target < 1 s).
12. **One-time reveal is enforced server-side.** The plaintext appears only in
    the `201` create and `200` rotate responses, with `Cache-Control: no-store`
    and no body logging. The list response has no `key_hash`, no secret, and no
    field that could reconstruct either.
13. **The UI is a governance screen, not a developer console.** Module tabs,
    operation checklists filtered by module, branch scope, expiry, RPM, CIDR,
    one-time secret banner, last-used/expiry badges, rotate/revoke with the
    shared `ModalPanel` confirmation. Lazy-loaded under Administration &
    Governance, gated to `SUPER_ADMIN`/`HEAD_OFFICE_ADMIN` with MFA verified.

## Schema (migration `00NN_api_keys.sql` + `schema.sql` parity)

```sql
CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    -- 10 random base62 chars; the API displays isp_live_<key_prefix>.
    key_prefix VARCHAR(12) NOT NULL UNIQUE,
    key_hash CHAR(64) NOT NULL,
    module_scope VARCHAR(30) NOT NULL CHECK (module_scope IN (
        'FINANCE', 'INVENTORY', 'PROCUREMENT', 'SALES',
        'HR_PAYROLL', 'WARRANTY_RMA', 'ALL_MODULES'
    )),
    permissions TEXT[] NOT NULL DEFAULT '{}',
    branch_ids TEXT[],                       -- NULL = all branches (ALL_MODULES only)
    ip_allowlist CIDR[],                     -- NULL/empty = any source
    rate_limit_rpm INT NOT NULL DEFAULT 60 CHECK (rate_limit_rpm BETWEEN 1 AND 60000),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    last_used_ip INET,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    rotated_from_id VARCHAR(50) REFERENCES api_keys(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    created_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT api_keys_expiry_after_create CHECK (expires_at > created_at),
    CONSTRAINT api_keys_revoked_is_inactive CHECK (revoked_at IS NULL OR is_active = FALSE)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_scope ON api_keys(module_scope, is_active);
CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(expires_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS api_key_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    api_key_id VARCHAR(50) REFERENCES api_keys(id) ON DELETE CASCADE,
    action VARCHAR(12) NOT NULL CHECK (action IN ('CREATE', 'ROTATE', 'REVOKE', 'DENIED', 'USE')),
    actor_user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    actor_email VARCHAR(150),
    ip INET,
    user_agent TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_key
    ON api_key_audit_logs(api_key_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_created
    ON api_key_audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION api_key_audit_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'api_key_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_api_key_audit_append_only ON api_key_audit_logs;
CREATE TRIGGER trg_api_key_audit_append_only
    BEFORE UPDATE OR DELETE ON api_key_audit_logs
    FOR EACH ROW EXECUTE FUNCTION api_key_audit_append_only();
```

Rules that the table cannot express and the service must:

- every `permissions[]` value is an existing operation code and belongs to
  `module_scope` (or the scope is `ALL_MODULES`);
- every `branch_ids[]` value is an existing, active `branches.id`;
- `branch_ids` may be `NULL` only for `ALL_MODULES`; otherwise at least one;
- `expires_at` is mandatory, at most 365 days ahead unless a Super Admin
  explicitly overrides with a written reason (audited);
- `ip_allowlist` is validated as CIDR at the edge and re-checked against the
  trusted client IP, never a raw `X-Forwarded-For`.

## Work slices

### APIK-1 — Schema, migration and parity

Priority: P0 · Status: `[x]` (migration `0043_api_keys`; parity checked below)

- [ ] Add `scripts/migrations/00NN_api_keys.sql` (next free number; coordinate
      with H6's `0030_fk_indexes`) and the identical objects to
      `scripts/schema.sql`, keeping `node scripts/verify_fresh_install.mjs` at
      100% parity.
- [ ] Add `API_KEYS` to the `audit_logs.module` CHECK **only if** the
      implementation reuses `logAuditEvent`; otherwise keep the dedicated table
      and extend `tests/auditModuleVocabulary.guard.test.ts` only for the new
      action vocabulary.
- [ ] Append-only trigger for `api_key_audit_logs`; a test proves UPDATE and
      DELETE are refused.
- [ ] Seed nothing. No demo key may exist: a demo key in a shipped database is
      a backdoor.
- [ ] `tests/apiKeySchema.test.ts`: table shape, unique prefix, FK behaviour,
      the two CHECKs, trigger refusal, and fresh-install parity.

Acceptance: migration applies on an existing database and on a fresh one;
`verify:fresh-install` reports identical tables/columns/indexes/triggers; a
second migration run is a no-op; `record_schema_migrations` records the
checksum.

### APIK-2 — Repository, service, generation, rotation, revocation

Priority: P0 · Status: `[x]`

- [ ] Router → controller → service → repository only; all SQL in
      `server/src/models/apiKeys.repo.ts` so `check:no-inline-sql` passes.
- [ ] `generateApiKey()`: `crypto.randomBytes(32).toString('base64url')`,
      prefix `isp_live_`/`isp_test_`, `key_prefix` = 10 base62 chars,
      `key_hash = sha256(secret)` hex. Return `{ secret, prefix, hash }`; the
      secret never enters a log, an audit row or the repository layer.
- [ ] Creation validates the module→operation map and the branch IDs against
      the live `branches` table; refuses an empty operation set; refuses a
      write operation on an `ALL_MODULES` key without an explicit flag
      (`allowWrite`), so a read-only integration cannot post journals by
      accident.
- [ ] Rotation creates the new row and shortens the old expiry in one
      transaction; the audit row records both ids.
- [ ] Revocation sets `is_active = false`, `revoked_at`, `revoked_by`, and
      publishes the Redis invalidation; idempotent (a second revoke is `200`
      with `alreadyRevoked: true`, not `500`).
- [ ] `last_used` update is a bounded batch (or a Redis debounce) — never one
      `UPDATE` per request.
- [ ] Audit writes are transactional with the state change where the schema
      allows it; a failed audit must fail a create/rotate/revoke, not silently
      succeed.
- [ ] Unit tests for the generator (entropy shape, prefix length, uniqueness),
      the module validator, rotation grace, revocation idempotence and the
      no-secret-in-audit invariant.

Acceptance: 10,000 generated keys have 10,000 distinct prefixes and no
duplicate hash; a create with an out-of-module operation is refused before an
insert; a rotate leaves exactly one active old key with the grace expiry; a
revoke is visible to the auth lookup within 1 s on a second worker.

### APIK-3 — `apiKeyAuth` middleware, principal and scope enforcement

Priority: P0 · Status: `[x]` (read-only refused before RBAC; no Super Admin override) · **Blocked on SCALE-1 (Redis)**

- [ ] `Authorization: Bearer isp_live_…` or `X-API-Key: isp_live_…` only; a key
      in the query string is ignored and logged as `DENIED` (no secrets in
      access logs).
- [ ] Parse the prefix, look up one row, `timingSafeEqual` the SHA-256 of the
      presented secret with `key_hash`; on any failure return `401` with a
      generic body (no "prefix not found" vs "hash mismatch" distinction).
- [ ] Check `is_active`, `expires_at > now()`, the CIDR allowlist against the
      trusted client IP, and the Redis rate limit; each denial writes a
      `DENIED` audit row with the reason code (not the secret).
- [ ] Build `req.auth` and the synthetic `req.user` view; do **not** assign a
      real privileged role. `authenticateUser` short-circuits when
      `req.auth.kind === 'apiKey'`; `requireAuth` accepts the principal;
      `sessionStillValid` is skipped. Set `branchId` to the single allowed
      branch and `allowedBranchIds` to the rest (or `ALL` only for a null-scope
      `ALL_MODULES` key), because the existing branch gates read those fields.
- [ ] `requirePermission` checks the key's `permissions` set (module scope is
      already validated at creation) and sets `req.permissionChecked = true`.
      `requirePermissionAny` does the same for an OR-list.
- [ ] `enforceBranchAccess`: a key's `branch_ids` is the complete scope; a
      request for another branch is `403`, and the SQL scope comes from the same
      list. `NULL` means all branches but only for `ALL_MODULES`.
- [ ] `enforceFiscalYearWriteAccess`: a key never gets the Super Admin override;
      a closed year refuses the write exactly as it does for a branch user.
- [ ] Final API-key guard: `403` when `req.permissionChecked` is false; a
      permanent deny for `/admin/`, `/auth/`, `/permissions`, `/bootstrap`.
- [ ] `last_used_at`/`last_used_ip` debounce (once per minute per key).
- [ ] Tests: the four required scenarios (below) plus CIDR, header-only,
      no-query-string, wrong-module, wrong-branch, revoked/expired, rate limit
      across two workers.

Acceptance: a `SALES` key for `WH001` gets `200` on `GET /api/sales-invoices`,
`403` on a finance and an inventory route, and `403` on another branch; a
revoked key is `401` on the next request even if the row is still in a worker's
prefix cache; a key cannot reach any admin/auth/bootstrap route.

### APIK-4 — Management API

Priority: P0 · Status: `[x]` · MFA gate replaced by `admin-api-keys` (decision above) · **MFA gate blocked on PUB-3**

- [ ] Routes in `server/src/routes/admin.routes.ts` (or a dedicated
      `apiKeys.routes.ts` mounted under `/api/admin`), all behind
      `requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN')` +
      `requireMfaVerified` + `requirePermission('admin-api-keys')` (a new
      operation, added to the matrix and to the role defaults for those two
      roles only; the count moves 68 → 69, so update README's "68 operations"
      claim in the same commit).
- [ ] `enforceOperationalPermissions` hard-codes every `/admin/` path to
      `SUPER_ADMIN` (`server/src/middleware/index.ts:151`); scope that rule so
      `/admin/api-keys` also admits `HEAD_OFFICE_ADMIN`, with a test — otherwise
      the mandated second role is a guaranteed `403`.
- [ ] `GET /api/admin/api-keys?cursor&limit&module&status` — keyset paginated,
      newest first, no hash/secret; each item carries name, prefix, module,
      branch summary, RPM, last used, expiry state and `isActive`.
- [ ] `POST /api/admin/api-keys` — validates and returns
      `201 { key, secret }`; `Cache-Control: no-store`.
- [ ] `POST /api/admin/api-keys/:id/rotate` — body `{ graceHours? }`; returns
      the new key + secret once; old key expiry shortened.
- [ ] `DELETE /api/admin/api-keys/:id` — revoke; returns the revoked key
      metadata (never the secret); idempotent.
- [ ] `GET /api/admin/api-keys/:id/logs?cursor&limit` — keyset paginated audit
      rows; no secret; `404` for an unknown id.
- [ ] Validation errors are `400` with a field path; an unknown module/operation
      is `422`; an operation outside the module is `422`; a branch outside the
      caller's authority is `403`.
- [ ] Audit create/rotate/revoke with actor, IP, user agent and a diff of the
      scope.

Acceptance: the four endpoints work over HTTP with a Super Admin + MFA token;
an unmfa'd admin gets `403`; a branch admin gets `403`; the list never contains
`key_hash`, `secret` or a field from which either can be derived; the create
response's secret is the only place it ever appears (assert by scanning the
response, the audit table and the server log).

### APIK-5 — Administration & Governance UI

Priority: P1 · Status: `[x]`

- [ ] `client/src/features/settings/ApiKeys.tsx`, `React.lazy` + a preload
      entry; register the nav child under **Administration & Governance →
      Governance** (`Sidebar.tsx`), gated to Super Admin/Head Office Admin with
      MFA; add the `NavTab` id, canonical path and route-tree entry.
- [ ] Update the docs screen tally (`SCREEN_SURFACE_PINS`, README/handoff
      totals) for the new screen; `tests/docsCounts.guard.test.ts` fails
      otherwise. The doc-guard update ships with the screen.
- [ ] Module tabs/filter: All, Finance, Inventory, Procurement, Sales, HR,
      Warranty/RMA; the operation checklist is filtered by the selected module
      and offers Read-only / Read-write presets.
- [ ] Create/Rotate modal: name, description, module, operations, branch scope
      (All vs specific multi-select), expiry preset (30/90/365/custom), RPM,
      optional CIDR list. Validation mirrors the server messages.
- [ ] One-time secret banner/modal: `role="dialog"`, copy button, the exact
      warning "Copy this API key now. For your security, it will never be shown
      again.", and no way to reopen it after close; a reload loses it.
- [ ] Governance table: name, `isp_live_…` prefix, module badge, branch count,
      RPM, last used (AD + BS, IP), expiry status badge (Active / Expiring /
      Expired / Revoked), rotate and revoke actions with the shared
      `ModalPanel` confirmation (never `confirm()` — `check:no-raw-dialogs`).
- [ ] Empty/loading/error states; the screen must not enter the startup graph
      (`check:bundle-budget`).
- [ ] Client tests: the screen renders a key list without a secret, the create
      flow shows the secret exactly once, the module selector filters
      operations, and revoke calls the endpoint with the id.

Acceptance: the screen is reachable only by the two roles, is absent from a
non-admin nav, renders the table and both dialogs, and a production build keeps
the screen in a lazy chunk.

### APIK-6 — Integration tests and gates

Priority: P0 · Status: `[x]` (automated suite `tests/apiKeys.api.test.ts`, 7 tests; live HTTP evidence below)

Required matrix (all over real HTTP + PostgreSQL, skipped without a DB like the
other API suites):

1. `SALES` key, branch `WH001`: `GET /api/sales-invoices` → `200`; a `FINANCE`
   route → `403`; an `INVENTORY` route → `403`; `GET /api/sales-invoices` with
   `branchId=WH002` → `403`.
2. Revoked key → `401` immediately; expired key → `401`; a key with
   `expires_at = now() - 1s` and `is_active = true` → `401` (expiry is checked,
   not just the flag).
3. Exceeding `rate_limit_rpm` → `429` with `Retry-After`, and the next window
   admits again; two workers share the same counter.
4. `GET /api/admin/api-keys` → no `key_hash`, no `secret`, no `keyHash`
   (case-insensitive scan of the serialized body).
5. Create returns the secret once; a second GET of the same key does not; the
   audit table does not contain it; the server log does not contain it.
6. Rotate: new key works immediately, old key works during grace, old key
   `401`s after grace (advance the clock by updating `expires_at` in the test).
7. CIDR allowlist: an allowed address passes, another is `403`; a forged
   `X-Forwarded-For` on a direct connection does not pass.
8. A key cannot reach `/api/admin/*`, `/api/auth/*`, `/api/bootstrap*`,
   `/api/permissions*`.
9. `PATCH`/`DELETE` on `api_key_audit_logs` is refused by the trigger.
10. `last_used_at` is updated at most once per minute under a request burst.

Gates:

- `npx tsc --noEmit`
- `node scripts/run_tests.mjs`
- `npm run check:no-inline-sql`
- `npm run check:no-raw-dialogs`
- `npm run build && npm run check:bundle-budget`
- `node scripts/verify_fresh_install.mjs`
- `npm run check:boot-timing` if the nav changes the shell graph

## Endpoint contracts

```text
GET    /api/admin/api-keys?cursor=&limit=&module=&status=
POST   /api/admin/api-keys
POST   /api/admin/api-keys/:id/rotate
DELETE /api/admin/api-keys/:id
GET    /api/admin/api-keys/:id/logs?cursor=&limit=
```

Create body:

```json
{
  "name": "RADIUS Billing Sync",
  "description": "Nightly subscriber and payment sync",
  "moduleScope": "SALES",
  "permissions": ["sales-invoice-create", "inv-pay"],
  "branchIds": ["WH001"],
  "ipAllowlist": ["203.0.113.0/24"],
  "rateLimitRpm": 120,
  "expiresAt": "2027-02-14T00:00:00.000Z"
}
```

Create/rotate response (the only secret reveal):

```json
{
  "key": {
    "id": "ak_01J…",
    "name": "RADIUS Billing Sync",
    "prefix": "isp_live_a1b2c3d4e5",
    "moduleScope": "SALES",
    "permissions": ["sales-invoice-create", "inv-pay"],
    "branchIds": ["WH001"],
    "rateLimitRpm": 120,
    "expiresAt": "2027-02-14T00:00:00.000Z",
    "isActive": true
  },
  "secret": "isp_live_…",
  "warning": "Copy this API key now. It will never be shown again."
}
```

Error bodies follow the existing `ApiError` shape: `{ message, code?, field? }`,
no SQL, no hash, no secret.

## Migration and deployment notes

- The migration number is the next free one. If H6 (`0030_fk_indexes`) lands
  first, this is `0031`; never renumber an applied migration.
- `schema.sql` must contain the same DDL; `verify_fresh_install.mjs` compares
  tables, columns, constraints, indexes and triggers.
- No key material in the repository, a seed, a demo fixture, a log or a
  screenshot. The integration tests generate keys at runtime.
- Production needs `API_KEY_PEPPER`? No — the hash is unkeyed SHA-256 over a
  256-bit random secret; a pepper adds operational risk without meaningful
  benefit. Record the reasoning in the code comment so a future reviewer does
  not "improve" it into an HMAC that cannot be rotated.
- The management UI is not usable before MFA exists (PUB-3). The API can ship
  first behind a Super Admin + MFA-claim check; do not weaken the check to ship
  the screen earlier.

## Risks and open questions

- **The 68-operation matrix has no module field.** The module→operation map is
  a new, hand-maintained file; a test must fail when the matrix gains an
  operation and the map does not. Otherwise a new finance operation is silently
  unavailable to every key (or, worse, assignable under the wrong module).
- **`ALL_MODULES` is a loaded gun.** Restrict it to Super Admin, require
  explicit write opt-in, and consider making it read-only until an integration
  proves it needs cross-module writes.
- **Synthetic principals can bypass gates.** The `req.permissionChecked` guard
  is the safety net; test a route that has no `requirePermission` and confirm
  a key gets `403`, not a role-based pass.
- **Key leakage is permanent.** The secret is shown once and stored hashed; a
  lost key can only be rotated. The UI must say that, and the runbook must
  include a rotation procedure for a compromised integration.
- **Per-request usage rows would dwarf the ledger.** Keep `USE` sampling off by
  default; the rate-limit counters and `last_used_at` answer "is it alive"
  without a row per call.
- **Revocation cache latency.** A positive key cache must be short (≤ 5 s) or
  invalidated by pub/sub; "immediate" means the next request, not the next
  worker restart.
- **MFA dependency.** If PUB-3 slips, the management endpoints cannot be
  exposed publicly; the API-key round is then blocked, not silently downgraded.

## Definition of done

- [x] The migration and `schema.sql` are in parity; the schema snapshot guard passes and the fresh-install comparison is recorded below.
- [x] A key is generated once, stored hashed, scoped by operations/branches/CIDR/RPM/expiry, and revoked immediately.
      branches/CIDR/RPM/expiry, and revoked immediately.
- [x] The four required integration scenarios pass over real HTTP + PostgreSQL,
      plus rotation, CIDR, no-secret-in-list and append-only audit.
- [x] The Administration & Governance screen creates, rotates and revokes a key,
      shows the secret exactly once, and stays in a lazy chunk.
- [x] `tsc`, the relevant suites, `check:no-inline-sql`, `check:no-raw-dialogs` and
      `check:bundle-budget` and `verify:fresh-install` all pass.
- [x] No key, hash or secret exists in the repo, a seed, a log or a fixture.
- [x] Commit hashes are recorded in this note.

## Implementation record — 2026-11-19

All six slices shipped in one change set. The deviations from the plan above are
deliberate and were decided before implementation:

- **No MFA gate.** Key creation, rotation and revocation are gated on the seeded
  `admin-api-keys` operation, held only by SUPER_ADMIN and HEAD_OFFICE_ADMIN (the
  "Sub Super Admin" role), plus the existing RBAC, branch and fiscal-year guards.
  No MFA subsystem was scaffolded.
- **Module is a grouping, not a column.** The creator screen groups the operation
  catalogue; the stored and enforced scope is the operation list
  (`api_keys.operations TEXT[]`) plus `read_only`. Twenty operations in the
  inventory are ungated, so the partner demo uses a genuinely gated route.
- **`read_only` is enforced in `apiKeyAuth`, before RBAC.** Many operation names
  guard both a GET and a POST route, so operation-only scoping would leak writes.
- **The audit trail is a dedicated append-only table**, not `audit_logs`, so the
  shared module vocabulary is untouched.

### What exists

| Layer | File |
|---|---|
| Migration | `scripts/migrations/0043_api_keys.sql` (mirrored in `scripts/schema.sql`) |
| Repository (all SQL) | `server/src/models/apiKeys.repo.ts` |
| Service (generate/hash/scope/rotate/revoke/auth) | `server/src/services/apiKeys.service.ts` |
| Middleware | `server/src/middleware/apiKeyAuth.ts`, mounted after `authenticateUser` in `server/src/app.ts` |
| Guard wiring | `requirePermissionAny` key branch and the `enforceOperationalPermissions` skip in `server/src/middleware/index.ts` |
| Management API | `server/src/controllers/apiKeys.controller.ts` + five routes in `server/src/routes/admin.routes.ts` |
| Screen | `client/src/features/settings/ApiKeys.tsx` (`React.lazy`), sidebar item, canonical path and tab gate |

### Live evidence (development database, app running on :3000)

A key was issued **through the API Creator screen** (Administration & Governance
-> API Creator), scope `gl-view`, read-only, 90-day expiry:

```text
UI secret shown once:   isp_live_XU25o3JH_Br13Z68...  (modal: "Copy this key now")
GET  /api/accounting/statements/trial-balance  X-API-Key: <secret>   -> 200
POST /api/locations                            X-API-Key: <secret>   -> 403 API_KEY_READ_ONLY
DB row: key_prefix=XU25o3JH  secret_hash=64 hex  read_only=t  operations={gl-view}  is_active=t
secret_hash = sha256(secret half)                    -> true
secret_hash = sha256(whole isp_live_... token)       -> false
row_to_json(api_keys) contains the plaintext secret  -> 0 rows
DELETE through the screen (Revoke -> Revoke key) -> GET with the same key returns 401 API_KEY_REVOKED
```

The management-API equivalent in the same run (`scripts/tmp_api_key_demo.mjs`,
deleted after use):

```text
1  login (SUPER_ADMIN)                          200
2  create read-only key                         201  secret returned once
3  GET trial-balance with that key              200
4  POST /api/locations with that key            403 API_KEY_READ_ONLY
5  GET /api/admin/api-keys                      200  containsSecret=false
6  create write key scoped to admin-audit       201
7  same key GET gl-view route                   403 API_KEY_SCOPE
8  expired key (expires_at moved into the past) 401 API_KEY_EXPIRED
9  revoke                                       200
10 revoked key                                  401 API_KEY_REVOKED
11 row stores prefix + 64-hex hash only         hashlen=64
12 columns named secret/token/api_key/plaintext 0
13 audit rows                                   CREATE, CREATE, REVOKE
14 rotate                                       200 new secret; old key 200 in grace, new key 200
```

### Automated regression suite — 2026-11-19 (later same day)

`tests/apiKeys.api.test.ts` now covers the whole path over the real Express app
and PostgreSQL, in the same shape as `tests/adminPerformance.api.test.ts`
(`createApp()` + `registerAllRoutes` on an ephemeral port, `setUsers` +
`setPermissionMatrix`, `ensureReferenceData`, skipped when no database is
reachable). Seven tests:

1. creation returns the plaintext once and the row holds only `sha256(secret)`
   (with the plaintext absent from `row_to_json`), and no list response carries
   the secret or a hash field;
2. a `gl-view` key reads the gated trial balance (200), an `admin-audit` key is
   refused 403 `API_KEY_SCOPE`, and a key minted by a Super Admin still has no
   Super Admin override;
3. a read-only key is refused on a non-GET with 403 `API_KEY_READ_ONLY` while
   the same key still reads;
4. revocation returns 401 `API_KEY_REVOKED` on the next request and the row
   records `revoked_by`;
5. an expired key returns 401 `API_KEY_EXPIRED` even though `is_active` is
   still true;
6. rotation issues a different secret, the old one serves its 24h grace and the
   new one works immediately;
7. list/create/rotate/revoke are refused for an account without
   `admin-api-keys`, and the refused calls change no row.

Proof the suite bites: with the read-only short-circuit and the revocation
check temporarily disabled, the run failed 3/7 (read-only, revoked, expired);
restored, it passes 7/7, three consecutive runs. The suite also caught a real
defect the curl demo could not: `key_prefix` was base64url, so a random prefix
containing the `_` separator made `splitToken` parse the wrong halves and the
key answered 401 (rotation's grace-window assertion exposed it). Prefixes are
now 12 hex characters and the test pins that the prefix is separator-safe.
### Gates

- `npx tsc --noEmit` -> 0.
- `tests/sidebarGrouping`, `financeMicroPermissions`, `permissionSeedMigration`,
  `demoPermissionFixtures`, `docsTruth.guard` -> 32/32 pass (table count 122 ->
  124 updated in the guard and the four README claims).
- `check:bundle-budget` -> OK; the entry gate was recalibrated 22.25 -> 22.375 kB
  on measurement (shell wiring only; `findLazyScreenChunksInStartup` finds no
  screen chunk in the startup graph).
- Migration applied at boot: `Schema migrations at 0043_api_keys`.
- Adding `tests/apiKeys.api.test.ts` moved the pinned suite size 2689 -> 2696 and
  the full `npm test` run then surfaced five stale pins the earlier delivery had
  left behind (they were never exercised because the suite was not re-run):
  `appPaths` screen count 108 -> 109, the missing `settings/ApiKeys.tsx` surface
  pin, the docs screen tallies (118 -> 119 total, 107 -> 108 in the table) and
  `schema.sql` table count 130 -> 132 in the drift and parity guards. All
  reconciled in the same change; the second full run is green.
+- Commit: `bea2c04` (25 files; migration, repository, service, middleware, controller,
  routes, screen, shell wiring, schema mirror, guard pins and these notes).
