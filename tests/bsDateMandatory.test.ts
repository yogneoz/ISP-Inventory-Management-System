/**
 * Mandatory BS-date hardening (2026-10-10) — guards.
 *
 * Every operation's BS date must be persisted once its event happened: no
 * NULL, no empty string, no fictitious fallback date. Three layers are
 * pinned here:
 *
 *  1. CLIENT auto-lookup: ensureBSDayForAD() resolves the BS date from the
 *     synced seeded calendar (bs_day_records mirror); every payload gap that
 *     used to send '' now blocks with the BS-seeding message instead.
 *  2. SERVER derive-or-400: bsDateOr400() derives from bs_day_records for
 *     the operation's own AD date and 400s (bsDateMissing) when unseeded —
 *     receipts, invoices, returns, payments (incl. cheque dates), asset
 *     creates and the FY period all route through it.
 *  3. NO fictitious persistence: BS_DATE_FALLBACK is no longer written by
 *     any repo param builder (they throw instead) and the schema migration
 *     backfills + tightens the suspect columns.
 *
 * PROVES (source pins + pure-function behavior, no DB needed):
 *   - ensureBSDayForAD returns a shaped "YYYY-MM-DD BS" for a covered date
 *     and null for malformed input (callers must block).
 *   - The three former '' payload sites (AssignAssetPanel, FixedAssetRegister,
 *     DamagedStockTracking) and the three procurement forms use the helper.
 *   - Shipments receive derives-or-400 (no more `: null` store).
 *   - Payments/PI/SI/PR/SR create flows call bsDateOr400; repo builders no
 *     longer reference BS_DATE_FALLBACK.
 *   - scripts/schema.sql carries the mandatory-BS migration block.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureBSDayForAD } from '../client/src/utils/nepaliCalendar';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('mandatory BS dates — client auto-lookup helper', () => {
  test('resolves a shaped BS date for a covered AD date', () => {
    const bs = ensureBSDayForAD('2026-10-10');
    assert.ok(bs, 'a date inside the mapped calendar must resolve');
    assert.match(bs as string, /^\d{4}-\d{2}-\d{2} BS$/, 'must be a shaped "YYYY-MM-DD BS" string');
  });

  test('returns null for malformed input so callers block', () => {
    assert.equal(ensureBSDayForAD(''), null);
    assert.equal(ensureBSDayForAD('not-a-date'), null);
    assert.equal(ensureBSDayForAD(null), null);
    assert.equal(ensureBSDayForAD(undefined), null);
  });

  test('every former empty-string payload gap uses the helper and blocks', () => {
    const guarded: Array<[string, string]> = [
      ['client/src/features/inventory/stockops/AssignAssetPanel.tsx', 'ensureBSDayForAD(todayAD)'],
      ['client/src/features/finance/FixedAssetRegister.tsx', 'ensureBSDayForAD(acquisitionDateAD)'],
      ['client/src/features/inventory/DamagedStockTracking.tsx', 'ensureBSDayForAD(disposalDateAD)'],
      ['client/src/features/procurement/CreateShipmentForm.tsx', 'ensureBSDayForAD(todayAD)'],
      ['client/src/features/procurement/PurchaseOrderForm.tsx', 'ensureBSDayForAD(todayAD)'],
      ['client/src/features/procurement/PurchaseInvoiceForm.tsx', 'ensureBSDayForAD(purchaseDateAD)'],
    ];
    for (const [file, anchor] of guarded) {
      const src = read(file);
      assert.ok(src.includes(anchor), `${file} must resolve its BS date via ensureBSDayForAD (${anchor})`);
      assert.ok(src.includes('BS month seeding'), `${file} must block with the BS-seeding message when unseeded`);
    }
    // The specific old patterns must be gone.
    assert.ok(!read('client/src/features/inventory/stockops/AssignAssetPanel.tsx').includes("formattedBSShort || ''"), 'AssignAssetPanel must not send an empty BS date');
    assert.ok(!read('client/src/features/inventory/DamagedStockTracking.tsx').includes("formattedBSShort || ''"), 'DamagedStockTracking must not send an empty BS date');
  });
});

describe('mandatory BS dates — server derive-or-400', () => {
  test('bsDateOr400 exists and is used by every derive-or-400 site', () => {
    const bsDate = read('server/src/utils/bsDate.ts');
    assert.ok(bsDate.includes('export async function bsDateOr400'), 'the mandatory-BS resolver must exist');
    assert.ok(bsDate.includes('bsDateMissing'), 'the 400 must flag bsDateMissing');

    const usedBy: Array<[string, number]> = [
      ['server/src/controllers/shipments.controller.ts', 1],   // receive
      ['server/src/controllers/procurement.controller.ts', 4], // PI, PR, payment, cheque
      ['server/src/controllers/sales.controller.ts', 5],       // SI, cancel, SR, payment, cheque
      ['server/src/controllers/inventory.controller.ts', 3],   // acquisition, assignment, PI-link
    ];
    for (const [file, minUses] of usedBy) {
      const uses = read(file).split('bsDateOr400(').length - 1;
      assert.ok(uses >= minUses, `${file} must call bsDateOr400 at least ${minUses} time(s) (found ${uses})`);
    }
  });

  test('shipments receive never stores a NULL receipt BS date', () => {
    const src = read('server/src/controllers/shipments.controller.ts');
    assert.ok(!src.includes('const receivedDateBS: string | null ='), 'the nullable receipt-BS store must be gone');
    assert.ok(src.includes('await bsDateOr400(res, sh.receivedDateAD)'), 'receipts must derive-or-400 from the receipt AD date');
  });

  test('no persistence path writes the fictitious fallback date', () => {
    for (const file of ['server/src/models/procurement.repo.ts', 'server/src/models/sales.repo.ts']) {
      assert.ok(!read(file).includes('BS_DATE_FALLBACK'), `${file} must not persist the fallback date (throw instead)`);
      assert.ok(read(file).includes('resolved from bs_day_records'), `${file} param builders must fail loudly on a missing BS date`);
    }
    const procurement = read('server/src/controllers/procurement.controller.ts');
    assert.ok(!procurement.includes('linkedInvoice?.invoiceDateBS ||'), 'vendor payments must not reuse the invoice BS date as the payment date');
  });

  test('fiscal-year creation derives the BS period server-side', () => {
    const src = read('server/src/controllers/admin.controller.ts');
    assert.ok(src.includes('resolvedStartBS') && src.includes('resolvedEndBS'), 'FY create must derive its BS period from bs_day_records');
  });
});

describe('mandatory BS dates — schema migration', () => {
  test('schema.sql carries the backfill + constraint-tightening block', () => {
    const schema = read('scripts/schema.sql');
    assert.ok(schema.includes('Mandatory BS-date hardening'), 'the migration block must exist');
    assert.ok(schema.includes("b.bs_date || ' BS'"), 'backfills must derive from bs_day_records');
    assert.ok(schema.includes('shipments_received_bs_required'), 'completed receipts must be constrained to a BS date');
    assert.ok(schema.includes('payment_date_bs SET NOT NULL'), 'payment BS dates must be tightened to NOT NULL where clean');
  });
});
