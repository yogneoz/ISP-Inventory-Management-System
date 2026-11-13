# Phase 0A baseline

Recorded 2026-11-13T00:16:26.395Z against a throwaway PostgreSQL database.

- Customers: **100,000**
- Database size: **93 MB**
- PostgreSQL: 18.6
- Seed time: **13830.97 ms**

## Request/page probes

| Probe | p50 ms | min ms | max ms |
| --- | ---: | ---: | ---: |
| Customer page 1 | 0.93 | 0.81 | 3.88 |
| Customer deep OFFSET | 46.42 | 43.13 | 52.61 |
| Customer search | 109.91 | 106.34 | 134.38 |

## Full operational cache

| Pass | Duration ms |
| --- | ---: |
| First hydration | 597.73 |
| Second hydration (post-write shape) | 466.61 |

Slowest CACHE_LOADS entries (p50 over 3 runs):

| Load | p50 ms | max ms |
| --- | ---: | ---: |
| customer_records | 386.36 | 472.28 |
| branches | 0.36 | 0.7 |
| fixed_assets | 0.35 | 0.48 |
| customer_payments | 0.35 | 0.45 |
| inventory_stock | 0.34 | 0.37 |
| vendor_payments | 0.32 | 0.36 |
| approval_requests | 0.31 | 0.42 |
| purchase_invoices | 0.3 | 0.36 |
| sales_returns | 0.29 | 0.41 |
| products | 0.28 | 0.32 |
| customer_device_records | 0.28 | 0.5 |
| users | 0.27 | 0.34 |

The complete measurements and EXPLAIN (ANALYZE, BUFFERS) plans are in
`phase0a-baseline.json`.
