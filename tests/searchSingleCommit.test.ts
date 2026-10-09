/**
 * Single-commit search typing — guard for the keystroke coalescing fix.
 *
 * Typing in a register search box used to fire TWO commits per keystroke:
 * the search state update, then a passive-effect sync in one of the two
 * hook bridges:
 *   - FilterCard's `setDraft(searchValue)` effect (controlled/uncontrolled
 *     draft buffer), and
 *   - useClientPagination's `setPageState(1)` reset effect — which re-rendered
 *     even when the page was already 1 (an equal-value setState coming from a
 *     passive effect does not bail out).
 *
 * Both syncs were moved to React's "adjusting state when a prop changes"
 * pattern (adjust DURING RENDER so the correction lands in the SAME commit
 * as the value that triggered it). PROVES (source pins, no DB needed):
 *   1. FilterCard adjusts prevSearchValue during render and no longer runs
 *      the effect-based setDraft sync.
 *   2. useClientPagination adjusts prevResetKeys during render (with the
 *      `page !== 1` guard) and no longer runs the effect-based page reset.
 *   3. The draft sync was MOVED, not deleted — FilterCard still re-syncs the
 *      draft when the applied search value changes from outside (Clear
 *      button / the register's own header search box).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FILTER_CARD = 'client/src/components/common/FilterCard.tsx';
const TABLE_PAGINATION = 'client/src/components/common/TablePagination.tsx';

describe('keystroke coalescing (one commit per search keystroke)', () => {
  test('FilterCard syncs the applied search value during render, not in an effect', () => {
    const src = read(FILTER_CARD);
    assert.match(
      src,
      /const \[prevSearchValue, setPrevSearchValue\] = useState\(searchValue\);/,
      'FilterCard must track the previous applied value for render-time adjustment'
    );
    assert.match(
      src,
      /if \(!Object\.is\(searchValue, prevSearchValue\)\) \{/,
      'FilterCard must detect applied-value changes during render'
    );
    assert.doesNotMatch(
      src,
      /useEffect\(\(\) => \{\s*\n\s*setDraft\(searchValue\);/,
      'the effect-based setDraft sync causes a second commit per keystroke — it must stay moved to render-time adjustment'
    );
  });

  test('useClientPagination resets the page during render, not in an effect', () => {
    const src = read(TABLE_PAGINATION);
    assert.match(
      src,
      /const \[prevResetKeys, setPrevResetKeys\] = useState<unknown\[\]>\(resetKeys\);/,
      'the pagination hook must track the previous reset keys for render-time adjustment'
    );
    assert.match(
      src,
      /if \(page !== 1\) setPageState\(1\);/,
      'the page reset must be guarded so an already-reset page does not dispatch'
    );
    assert.doesNotMatch(
      src,
      /\}, resetKeys\);/,
      'the effect-based page reset causes a second commit per keystroke — it must stay moved to render-time adjustment'
    );
  });

  test('the draft sync was moved, not deleted — external searchValue changes still reach the draft', () => {
    const src = read(FILTER_CARD);
    assert.match(
      src,
      /if \(!Object\.is\(draft, searchValue\)\) setDraft\(searchValue\);/,
      'FilterCard must still re-sync the draft when the applied value changes from outside (Clear button / header search box)'
    );
  });
});
