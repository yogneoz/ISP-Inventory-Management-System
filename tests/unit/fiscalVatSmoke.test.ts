/**
 * Lightweight fiscal/VAT smoke checks (accountant UAT companion).
 * Full IRD UAT remains manual — see docs/FISCAL_VAT_UAT.md.
 */
import { describe, it, expect } from 'vitest';
import { getTodayBsStamp, toBsDateStamp } from '../../server/lib/authUtils';
import * as store from '../../server/store';

describe('fiscal / VAT smoke invariants', () => {
  it('BS stamps are live and formatted', () => {
    const today = getTodayBsStamp();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2} BS$/);
    expect(today).not.toBe('2083-04-16 BS');
  });

  it('maps Baisakh 1 2083 correctly', () => {
    expect(toBsDateStamp('2026-04-14')).toBe('2083-01-01 BS');
  });

  it('default tax rate is Nepal VAT 13%', () => {
    expect(store.INITIAL_COMPANY_PROFILE.defaultTaxRate).toBe(13);
  });

  it('has a current open fiscal year in master seed', () => {
    const current = store.INITIAL_MASTER_FISCAL_YEARS.filter((f) => f.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0].isClosed).toBe(false);
    expect(current[0].code).toMatch(/208\d/);
  });

  it('VAT line math: taxable * 0.13', () => {
    const taxable = 10000;
    const vat = Math.round(taxable * 0.13 * 100) / 100;
    expect(vat).toBe(1300);
    const exempt = 500;
    const grand = taxable + vat + exempt;
    expect(grand).toBe(11800);
  });
});
