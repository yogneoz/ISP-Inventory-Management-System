# Phase 0B baseline — reference-only runtime

Recorded 2026-11-13T01:02:35.538Z against a throwaway PostgreSQL database.

- Customers: **100,000**
- Database size: **93 MB**
- PostgreSQL: 18.6
- Seed time: **15287.9 ms**
- Reference loads: **11** (branches, users, uom, locations, suppliers, fiscalYears, companyProfile, products, categories, product_groups, inventory_stock)
- Transactional loads still present: **none**

## Before / after

| Probe | Phase 0A p50 ms | Phase 0B p50 ms |
| --- | ---: | ---: |
| Customer page 1 | 0.93 | 0.75 |
| Deep page (0A OFFSET → 0B keyset) | 46.42 | 0.65 |
| Customer search (0A name-only probe → 0B API expression) | 109.91 | 6.64 |
| Boot/refresh hydration | 466.61 | 5.5 |

The old deep-OFFSET query is still recorded as a before probe
(48.35 ms p50); it is no longer on the request path. The keyset
query returns 50 rows starting after the 90% anchor. The
name-only search probe (109.21 ms p50) is retained only as the 0A
comparison; the directory now runs the indexed six-column expression above.

## Reference-only hydration

| Pass | Duration ms |
| --- | ---: |
| First hydration | 41.45 |
| Second hydration | 5.5 |

There is no third pass and no write-path refresh: `cacheRefreshHook` and the
full `refreshOperationalCache` runner were removed. The second pass is included
only to show the cost is stable and reference-sized.

| Reference load | p50 ms | max ms |
| --- | ---: | ---: |
| product_groups | 0.72 | 0.78 |
| inventory_stock | 0.57 | 0.65 |
| suppliers | 0.52 | 0.64 |
| fiscalYears | 0.51 | 1.19 |
| categories | 0.49 | 0.61 |
| branches | 0.44 | 0.58 |
| locations | 0.43 | 0.54 |
| users | 0.41 | 0.41 |
| companyProfile | 0.35 | 0.39 |
| products | 0.35 | 0.39 |
| uom | 0.29 | 0.3 |

The complete measurements and EXPLAIN (ANALYZE, BUFFERS) plans are in
`phase0b-baseline.json`.
