# Subscription billing domain (2026-11-20)

Status: `[ ]` not started · Opened 2026-11-20 · Owner: main

Source: §5–§7 and Phases 1–4 of the external subscription/scaling recommendation.
This file maps that design onto the mechanisms this repository already has. Where
it disagrees with the code, the code wins and this file is corrected.

**Nothing here is built.** There is no subscription table, route or screen today;
every `subscription` in the tree is an SSE/React store subscription. The domain
was already recorded as deferred scope — `docs/performance/README.md` §Scope
("Monthly partitioning, subscription billing, collections, accounting changes and
modularization are not part of this build") and the 2026-11-13 Phase 1 note in
[SESSION_NOTES.md](../../SESSION_NOTES.md) — so this round executes a scope the
project already named rather than opening a new direction.

## Why it is a separate domain

`sales_invoices` is inventory-centric: it is **partitioned** by `invoice_date_ad`,
its primary key is `(id, invoice_date_ad)`, its lines are JSONB items tied to
stock/serial/warranty posting, and its three inbound foreign keys point at
`document_identity_registry`. It cannot carry recurring service periods,
proration, deferred revenue or dunning. Service billing posts into the **same
global ledger** through the same `postJournal` path, but its documents are its
own tables.

## Hard constraints inherited from the existing system

1. **One global ledger, fiscal year as a dimension.** No per-year copies, no
   balance copying. Subscription tables therefore do **not** carry
   `fiscal_year_id`; `invoice_date_ad` / `service_from_ad` / `gl_periods` decide
   the period. (This is deliberate: the schema already has 105 `fiscal_year_id`
   references and this domain adds none.)
2. **Partition-ready from day one** for tables that grow per subscriber-month:
   `subscription_invoices`, `billing_charges`, `subscription_payment_allocations`,
   `deferred_revenue_schedules`. A partitioned unique constraint must contain the
   partition key, so global business keys move to `document_identity_registry`
   **before** conversion, not after (the `0035` → `0036` → `0039` lesson).
3. **All SQL in repository modules** (`check:no-inline-sql`), and every mutation
   on a partitioned table needs a `branch_id` predicate or a single-row key
   (`check:branch-predicates`).
4. **Migrations are immutable once recorded.** Next number is `0047`. Every table
   is mirrored in `scripts/schema.sql`; `verify:fresh-install` must stay identical
   (currently 137 tables declared, including the eight default partitions).
5. **No guard weakened.** Counts move together: schema drift + parity (135
   tables), `docsTruth` (127 docs), micro-permissions (71 operations),
   `registerRefreshDomains` (121 screens), docs-counts (2,724 tests).

## Mapping: recommendation → existing mechanism

| Recommendation | Becomes, here |
|---|---|
| Plan versions, never edit history | New tables; immutable-once-referenced guard; effective-dated like `bill_terms` |
| Service accounts / subscriptions | New tables anchored on `customer_records` (the subscriber master) and `branches` |
| Lifecycle events, append-only | New `subscription_events`; UPDATE/DELETE refused by a trigger using the ledger's append-only pattern |
| Billing runs idempotent, background | New tables + a leader-elected scheduler (`state/sharedLock.ts`, `withStartupLeadership`) with a CLI twin, following `journalPartitionKeeper` + `scripts/read_models.ts` |
| Subscription invoices, own numbering | New partitioned tables + `document_identity_registry` (below) + `document_number_configs` / `document_sequence_daily` / `serverDocNumber.ts` |
| Posting AR / deferred / VAT | `postJournal` (inside the caller's transaction), `reverseSourceJournal` for reversal, `PostingRole` `AR_CONTROL` / `TAX_OUTPUT` + new roles (below) |
| Payment allocations | New subscription allocation table shaped like `customer_payment_allocations`, with its invoice FK anchored on the registry |
| AR aging → dunning | `accountingAging.service.ts` `buildAging` (AR) over posted subledger entries; no second receivables ledger |
| Pre-aggregated reporting | The `branch_stock_balances` pattern: same-transaction projection, `read_model_outbox` on failure, `rebuild_*()` + `--verify`, `read-models:pending/flush` |
| Monthly partitions + boot provisioning | `partitionWindow` + `ensure_*_month_partition()` + a boot provisioner + `check:partitions` + the CI alarm |
| Deep lists | `server/src/utils/keysetCursor.ts` signed cursors, `SCOPE_REQUIRED` for unbounded reads |

## Data model (owned by this round)

Master data — small, never partitioned:

- `service_plans(id, code UNIQUE, name, category, is_active, …)`
- `service_plan_versions(id, plan_id, version_no, effective_from_ad, effective_to_ad,
  price, currency, billing_frequency, billing_timing ADVANCE|ARREARS, proration_policy,
  tax_rate/tax_code, revenue_account_id, deferred_revenue_account_id,
  speed_down_kbps, speed_up_kbps)` — `UNIQUE (plan_id, version_no)`; **a version
  referenced by any subscription is immutable** (editing it is a `409`, not an
  update).
- `service_accounts(id, customer_id, branch_id, service_address, status,
  activated_at_ad)` — the site/connection; a customer may have several.
- `subscriptions(id, service_account_id, plan_version_id, billing_account_id,
  branch_id, start_ad, end_ad, billing_anchor_day, status, billing_timing snapshot)`
- `subscription_events(id, subscription_id, event_type
  ACTIVATE|PLAN_CHANGE|SUSPEND|RESUME|TERMINATE|TRANSFER, effective_ad,
  from_plan_version_id, to_plan_version_id, reason_code, created_by, created_at)`
  — append-only.
- `billing_accounts(id, customer_id, payer_name, currency, tax_registered, pan,
  payment_terms_days, autopay, branch_id)`

Transactional — partition-ready:

- `billing_runs(id, run_key UNIQUE, branch_id NULL = all, period_from_ad,
  period_to_ad, mode DRY_RUN|COMMIT, status QUEUED|RUNNING|COMPLETED|FAILED|PARTIAL,
  charge_count, invoice_count, subtotal, tax_total, total, started_at, finished_at,
  error_summary)`
- `billing_charges(id, billing_run_id, subscription_id, plan_version_id,
  service_from_ad, service_to_ad, fraction, amount, discount_amount, tax_amount,
  status DRAFT|INVOICED|VOID)` — **idempotency is two constraints**: the
  recommendation's `UNIQUE (billing_run_id, subscription_id, service_from_ad)`
  *and* a partial `UNIQUE (subscription_id, service_from_ad, service_to_ad)
  WHERE status <> 'VOID'`, so a second run with a *different* run id still cannot
  double-bill the same service period.
- `subscription_invoices` / `subscription_invoice_lines` — monthly
  `RANGE (invoice_date_ad)`, `PRIMARY KEY (id, invoice_date_ad)`, journal link,
  `status DRAFT|POSTED|VOID|REVERSED`.
- `subscription_payment_allocations` — invoice FK through the registry anchor.
- `subscription_credit_notes`, `subscription_write_offs`
- `dunning_cases`, `dunning_actions`, `promise_to_pay`
- `deferred_revenue_schedules(invoice_line_id, service_from_ad, service_to_ad,
  amount, recognized_amount, status, recognized_journal_id)`

## Numbering: reuse `document_identity_registry`

The registry is not just for partitioned tables — it is the immutability
protocol. Subscription documents use it from the first commit, which is what makes
later month-partitioning a conversion of storage rather than a change of identity:

- `document_type = 'SUBSCRIPTION_INVOICE'`, `key_role = 'PRIMARY'`, with the
  trigger spec `'PRIMARY:invoice_number:fixed:refuse'` exactly as
  `trg_sales_invoices_identity` declares it. `fixed` → a renumber is refused;
  `refuse` → a reused number raises `23505`, which the controller maps to `409`.
- `document_type = 'SUBSCRIPTION_CREDIT_NOTE'` for credit notes; write-offs are
  journals, not documents.
- Series come from the existing machinery: a `document_number_configs` row
  (`SUB`, `SCN`), issued per branch/day through `document_sequence_daily` by
  `generateNextDocNumberForServer` / `resolveDocumentNumber`, with
  `retireDocumentNumber` and the retirement registry unchanged. `docNumber.ts`
  gains the two `DOC_TYPE_PREFIX` entries.
- Allocations reference an invoice by `(document_type, key_role, id)`, the same
  composite-FK shape `customer_payment_allocations` already uses, so the FK
  survives the invoice table being partitioned.

## Accounting

Plan versions decide accounts; the engine hard-codes none. Advance (default):

```
Invoice:      Dr AR_CONTROL            total
                  Cr Deferred Revenue        net
                  Cr TAX_OUTPUT              vat
Recognition:  Dr Deferred Revenue      net
                  Cr Service Revenue         net
Payment:      Dr CASH/BANK             total
                  Cr AR_CONTROL              total
```

Arrears posts revenue directly and writes no deferred schedule. Reversal uses
`reverseSourceJournal`, never an edit. Deposits are a liability account, not
revenue.

Two `PostingRole` additions are needed in `server/src/models/accounting.repo.ts`
(`DEFERRED_REVENUE`, `SERVICE_REVENUE`), with entries in the default/NFRs chart
normal-balance map — the plan-version `account_id`s override them, but a fresh
install must have a sane default the way `AR_CONTROL` and `TAX_OUTPUT` do today.

## Read models this domain needs

Each follows the `0041` contract: maintained in the writing transaction, queued in
`read_model_outbox` when the apply fails, rebuildable, and byte-comparable to the
direct query.

| Model | Grain | Serves |
|---|---|---|
| `gl_period_balances` | account × branch × period (opening/debit/credit/closing) | trial balance, balance sheet, P&L without scanning `gl_journal_lines` |
| `gl_party_period_balances` | control account × party × period | AR aging and dunning without a second receivables ledger |
| `deferred_revenue_rollforward` | period × plan version × account (opening/additions/recognized/closing) | the deferred-revenue rollforward |
| `subscription_mrr_facts` | month × subscription × branch (mrr, movement NEW/EXPANSION/CONTRACTION/CHURNED) | MRR, logo/revenue churn, cohorts, ARPU |

`gl_period_balances` and `gl_party_period_balances` are **not subscription
tables** — they are general accounting rollups this domain forces into existence,
and they are useful before it (see the open gap in Round 15's deferred list).

## Slices

**SUB-1 — Plan catalogue and versions.** Tables above, admin API, catalogue
screen. *Acceptance:* a price change creates a new version; editing a referenced
version is refused `409`; an effective-date overlap is refused; the catalogue
lists only current versions by default.

**SUB-2 — Service accounts, subscriptions, lifecycle events.** Create/activate/
suspend/resume/terminate/change-plan endpoints; branch-scoped; events append-only.
*Acceptance:* events cannot be updated or deleted (DB refusal asserted); a plan
change writes an effective-dated event and a new billing snapshot; a terminated
subscription cannot be billed; `check:branch-predicates` clean.

**SUB-3 — Billing accounts and tax profile.** Payer, terms, autopay, PAN/VAT
registration. *Acceptance:* one customer with two billing accounts gets two
invoices, not one; missing tax profile blocks a VAT-bearing plan with a named
error.

**SUB-4 — Billing runs, charges, idempotency, job lane.** `run_key` unique;
chunked execution with persisted progress; dry-run mode; exception queue; CLI
twin. *Acceptance:* 100k subscriptions run and **re-run** with zero duplicate
charges (fixture DB name must contain `_scale`, per `seed_scale_fixture.mjs`);
a killed run resumes without re-charging completed chunks; two schedulers under
`withStartupLeadership` produce one run, not two.

**SUB-5 — Subscription invoices and posting.** Invoice generation from charges,
consolidated per billing account; registry numbering; advance and arrears posting
in one transaction with the charge's status flip. *Acceptance:* AR control total
equals the invoice population; a duplicate invoice number is `409`; a renumber is
refused; a service period crossing a fiscal-year boundary produces lines in the
correct `gl_periods`; the invoice posts or nothing does.

**SUB-6 — Deferred revenue and recognition.** Schedule rows at invoice time;
monthly recognition run posting one journal per period. *Acceptance:* rollforward
foots (opening + additions − recognized = closing); recognizing twice is
idempotent; an early termination releases the remaining deferred balance with a
named reason.

**SUB-7 — Collections and dunning.** Stages off `buildAging` AR buckets,
promise-to-pay, suspension as a `subscription_events` row, write-off as a journal,
deposits as a liability. *Acceptance:* aging ties to `gl_party_period_balances`;
a promise-to-pay suppresses a stage until its date; suspension writes the event
and publishes nothing to any network adapter (outbox row only).

**SUB-8 — Read models and analytics.** The four models above, their rebuild
commands and `--verify`; MRR/churn endpoints. *Acceptance:* each rebuild is
byte-identical to its direct query on the demo database; `gl_period_balances`
matches `ACCOUNT_BALANCE_ROWS_SQL` for a closed and an open period; churn
movements reconcile to charges and events.

## Out of scope (deliberate)

RADIUS/BNG/OLT provisioning and throttling; usage/CDR telemetry in this database;
customer self-service portal; ticketing/CRM; a tax engine beyond `TAX_OUTPUT`;
multi-currency conversion rates; reusing or extending `sales_invoices` for
service billing; microservice extraction; invoicing in a request thread.

## Open decisions (each blocks a slice)

1. **The recommendation's five schema decisions** were cut off in the source
   ("Five decisions that materially affect the design:") — they must be supplied
   before SUB-4.
2. Proration policy default and rounding rule for VAT-inclusive prices (SUB-4).
3. Billing anchor rules for mid-month activations, plan changes and suspensions
   (SUB-4).
4. Whether a subscription invoice shares the sales-invoice series or keeps its own
   `SUB` prefix — the plan assumes its own (SUB-5).
5. Dunning stage definitions, grace days, and **who may approve a write-off**
   (SUB-7).
6. Whether suspension requires approval, mirroring the parked `CUST-LOSS`
   question (SUB-7).
7. Whether security deposits live in this module or in the existing cash/bank
   custody work (SUB-7).
8. Whether `gl_period_balances` / `gl_party_period_balances` land before SUB-8 as
   their own slice — they are useful independently and Round 15 left them open.

## Verification and gates

Per slice: `npx tsc --noEmit`; the slice's real-HTTP + PostgreSQL tests;
`check:no-inline-sql`, `check:no-raw-dialogs`, `check:branch-predicates`;
`check:partitions` once a table is partitioned; `check:bundle-budget` once screens
land (lazy screens, ceilings 23.375 kB entry / 330 kB startup — not raised).
At close: full suite, docs-count gate, schema drift/parity, fresh-install parity,
read-model rebuild verification, and the permission/screen count pins moved
together.

## Order

SUB-1 → SUB-2 → SUB-3 → SUB-4 → SUB-5 → SUB-6 → SUB-7 → SUB-8, with the two
general accounting rollups allowed to land early (open decision 8). Partition the
four growing tables only after their identity and FK shape have settled — the
`document_identity_registry` anchor in SUB-5 exists so that conversion is storage
only.
