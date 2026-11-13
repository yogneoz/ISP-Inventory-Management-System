# Phase 0B baseline — reference-only runtime

Recorded 2026-11-13T01:28:05.417Z against a throwaway PostgreSQL database.

- Customers: **1,000,000**
- Database size: **760 MB**
- PostgreSQL: 18.6
- Seed time: **203809.67 ms**
- Reference loads: **11** (branches, users, uom, locations, suppliers, fiscalYears, companyProfile, products, categories, product_groups, inventory_stock)
- Transactional loads still present: **none**

## Before / after

| Probe | Phase 0A p50 ms | Phase 0B p50 ms |
| --- | ---: | ---: |
| Customer page 1 | 0.93 | 0.9 |
| Deep page (0A OFFSET → 0B keyset) | 46.42 | 0.71 |
| Customer search (0A name-only probe → 0B API expression) | 109.91 | 59.76 |
| Boot/refresh hydration | 466.61 | 3.99 |

The old deep-OFFSET query is still recorded as a before probe
(598.69 ms p50); it is no longer on the request path. The keyset
query returns 50 rows starting after the 90% anchor. The
name-only search probe (693.73 ms p50) is retained only as the 0A
comparison; the directory now runs the indexed six-column expression above.

## Reference-only hydration

| Pass | Duration ms |
| --- | ---: |
| First hydration | 44.04 |
| Second hydration | 3.99 |

There is no third pass and no write-path refresh: `cacheRefreshHook` and the
full `refreshOperationalCache` runner were removed. The second pass is included
only to show the cost is stable and reference-sized.

| Reference load | p50 ms | max ms |
| --- | ---: | ---: |
| branches | 0.41 | 0.73 |
| suppliers | 0.4 | 0.48 |
| product_groups | 0.36 | 0.48 |
| products | 0.35 | 0.36 |
| inventory_stock | 0.3 | 0.42 |
| locations | 0.29 | 0.33 |
| fiscalYears | 0.29 | 0.3 |
| users | 0.26 | 0.3 |
| categories | 0.26 | 0.28 |
| companyProfile | 0.23 | 0.28 |
| uom | 0.21 | 0.23 |

The complete measurements and EXPLAIN (ANALYZE, BUFFERS) plans are in
`phase0b-baseline-1m.json`.
