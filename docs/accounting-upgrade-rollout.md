# Accounting upgrade and rollout

This is the operator guide for taking an existing inventory install from the
pre-custody accounting schema to the current chart, custody, settlement and
reconciliation model. It covers what runs automatically, what is deliberately
not rewritten, and how to verify the result before opening the new screens.

## What the boot does

On startup the server runs `runSchemaMigrations` before seeding or serving:

1. Every numbered file in `scripts/migrations/` is applied once, in order,
   inside a transaction. Applied files are checksummed; changing an already
   applied migration is a startup error. Replaying the same release applies
   nothing and leaves the data unchanged.
2. `ensureDefaultChart` adds any missing default chart groups, ledgers, wallet
   clearing accounts and posting defaults. Existing ledgers are matched by code;
   an operator's renamed or relocated account is not recreated or overwritten.
3. `ensureDefaultSubledgers` adds the missing general book for each control
   account. Party books are attributed at read time and are never required for a
   posted row.

Migration `0016_existing_install_backfill` adds the pieces a populated install
needs but an empty schema cannot create:

- one deterministic party book per distinct `(control account, party)` that
  already has posted `gl_subledger_entries`;
- the current required close checklist on every existing `gl_periods` row,
  including `INVENTORY_RECONCILE` and `PSP_RECONCILE`;
- the missing `customer_payments_fee_amount_check` constraint that migration
  `0011` did not add to older installs.

The migration never updates a journal, journal line, subledger entry or
operational document. Correction of a posted balance is still a reversal or an
explicit reclassification journal through the normal posting path.

## Chart and custody end state

- `1110 Trade Receivables` sits under `1000 Current Assets`; `2110 Trade
  Payables` sits under `2000 Current Liabilities`.
- Migration `0014` moves the seeded `1100`/`2100` ledgers into those groups
  **only if they are still in their original root group**. A chart that an
  operator already reorganised is left alone.
- Boot adds the wallet clearing ledgers `1030 eSewa Clearing`, `1040 Khalti
  Clearing` and `1050 Nepal Pay Clearing` when they are missing. They are
  `WALLET` custody accounts, not posting defaults.
- Existing bank ledgers stay where they are. Add real branch-owned tills or
  additional banks from **Finance → Chart & Defaults → Ledgers**; a ledger with
  `account_kind = CASH` or `BANK` and a branch becomes that branch's custody
  account. Only one ledger may hold each posting role.

## Historical online receipts — known limitation

Online receipts posted before the provider columns existed have no provider code
and no provider transaction id. There is no reliable way to decide whether a
historical receipt belongs to eSewa, Khalti or Nepal Pay, or whether it was
already deposited. The upgrade therefore **keeps those receipts and their
journals exactly where they are** and does not invent wallet-clearing entries.

Consequences to disclose to the finance team:

- pre-upgrade online receipts remain in the bank/cash ledger they were posted to;
- provider reconciliation starts from receipts created after the upgrade;
- if a historical receipt must be moved, a user with posting rights posts an
  explicit reclassification journal and records the reason — the migration will
  not do it silently.

New online receipts use the provider path: gross amount to wallet clearing, then
a settlement debits bank, debits the provider fee and credits the clearing
ledger.

## Demo seed

`npm run seed:verify` writes a deterministic demo with the full governance
surface:

- four banks (`1020`–`1023`), three wallet clearings (`1030`–`1050`) and one till
  for each of the four branches (`1011`–`1014`);
- party books for the demo customers and suppliers, built from the same
  read-time attribution used by the application;
- one deliberately unlinked subledger row and one balanced employee-advance
  control difference so chart health and the control tie-out have a real
  example;
- one eSewa settlement row with a provider fee (gross 2,525, fee 25, net 2,500);
- every demo period pre-populated with the full seven-task close checklist.

The seed keeps its published ledger targets (AR 10,000 / AP 15,000 / inventory
20,000 / cash and bank 10,000 / equity 50,000). The demonstration difference is
posted against non-target accounts, so it does not move those figures. A repeat
run is a no-op by id.

## Rollout checklist

1. Back up the database and confirm the release contains every migration file up
   to `0016`.
2. Run `npx tsc --noEmit`, `npm run check:no-inline-sql`,
   `npm run check:no-raw-dialogs` and the full `npm test`.
3. Restore the backup into a staging database, start the current release there,
   and confirm the migration log reports `0016` once and no checksum failure.
4. In staging, open **Chart & Defaults** and confirm the five tabs load, trade
   groups sit under their roots, and no operator-created group was moved.
5. Open **Reconciliation Health**, review unlinked subledger rows and control
   differences, and confirm each unlinked row belongs to pre-upgrade history.
6. Open an existing period's close checklist: the inventory and provider
   reconciliation tasks must be present and required.
7. Re-run migrations once (restart the server) and confirm no migration is
   applied the second time and the period/checklist/book counts do not change.
8. Only then repeat the start against production. Tell the finance team about
   the historical-online-receipt limitation above before provider
   reconciliation is used for pre-upgrade periods.

The automated evidence for this guide is
`tests/acc7Upgrade.api.test.ts` (schema from the commit before the ACC-2 slice,
upgrade, boot seed, replay, fresh-install schema parity) and
`tests/acc7DemoSeed.api.test.ts` (expanded deterministic demo, repeated seed).
