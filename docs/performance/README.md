# Performance records — scaling beyond the demo

The customer directory is designed for millions of rows, not a fixed 100k cap.
The harness takes the row count from `PHASE0B_CUSTOMERS`, so the same probes can
be re-run at any scale:

```bash
npm run bench:phase0b                              # 100,000 (CI-sized record)
PHASE0B_CUSTOMERS=1000000 npm run bench:phase0b    # 1,000,000 scale record
PHASE0B_CUSTOMERS=5000000 npm run bench:phase0b    # 5,000,000 larger scale
```

Each run creates a throwaway database, seeds the requested directory, measures
the first page, the retired deep-OFFSET probe, the keyset anchor page, the
six-column search and reference-only hydration, records `EXPLAIN (ANALYZE,
BUFFERS)` plans, then drops the database. Output is
`phase0b-baseline-<scale>.json/.md` (100k keeps the unsuffixed name).

## Recorded scale points

| Customers | Page 1 p50 | Keyset at 90% p50 | Search p50 | Retired deep OFFSET p50 | Reference hydration p50 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 0.75 ms | 0.65 ms | 6.64 ms | 48.35 ms | 5.50 ms |
| 1,000,000 | 0.90 ms | 0.71 ms | 59.76 ms | 598.69 ms | 3.99 ms |

The Phase 0A record (`phase0a-baseline.*`) was 100k: page 1 0.93 ms, deep OFFSET
46.42 ms, search 109.91 ms and full-cache hydration 466.61 ms. Phase 0B removes
the full refresh entirely and keeps the page/keyset path flat as the directory
grows. Search grows with the candidate set at 1M, but the existing GIN trigram
index keeps it bounded and well below the 0A 100k search time.

## Index evidence

No new index was added: the recorded plans show the existing
`idx_customer_records_name_all` serving both the first page and the keyset
`(customer_name, customer_id) > (…)` anchor, and
`idx_customer_records_search_trgm` serving the six-column search. A covering
candidate was measured during development and the planner did not choose it, so
it was not shipped. The JSON records include the page, keyset, search and old
deep-OFFSET plans; the 0A record is the before baseline.

## Scope

These records cover Phase 0B only. Monthly partitioning, subscription billing,
collections, accounting changes and modularization are not part of this build.
