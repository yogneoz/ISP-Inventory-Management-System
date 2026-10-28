# Session notes by year

The chronological decision log, split by year (SN-1, Round 3 close,
2026-10-27). The root [SESSION_NOTES.md](../../SESSION_NOTES.md) keeps only the
current state and this index; the entries live here.

| Year | File | Covers |
|---|---|---|
| 2026 | [2026.md](2026.md) | every entry from the first session through the Round 8 close, newest first |

## Where new entries go

- **2026 (current):** prepend directly below the `---` separator in
  [2026.md](2026.md) — newest first, the same order the old root file used.
- **A new year** starts its own `YYYY.md` with the same header shape.
- Keep the root current-state block in
  [SESSION_NOTES.md](../../SESSION_NOTES.md) true; that block, not an entry, is
  the live summary. Entry numbers and paths were true when written — where an
  entry conflicts with the code, the code wins.

## The count gate

The root file's `Tests: N/N` header is checked by
[scripts/docsTestCounts.ts](../../scripts/docsTestCounts.ts) on every
`npm test`. Entry prose uses the historical "Full `npm test`: N tests" form,
which the gate deliberately leaves alone (`DOCS_FILES` still covers README.md,
handoff.md and the root SESSION_NOTES.md).
