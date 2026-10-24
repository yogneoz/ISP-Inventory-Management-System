/**
 * Bootstrap trim step 5 — PostgreSQL is the only source for the purchase-order,
 * purchase-invoice, shipment and vendor-payment mirrors.
 *
 * Before this change several mutation paths consulted the in-memory mirrors
 * FIRST and only fell back to PostgreSQL when the mirror row was missing:
 *
 *   - put_Id / delete_Id (PO update, delete, linked-invoice check)
 *   - patch_status (PO response body)
 *   - post_purchaseInvoices (linked PO + duplicate bill pre-check)
 *   - post_reversePayments / post_reverse (invoice settlement + payments)
 *   - post_receive / post_cancel / post_cancelReceive (shipment pre-checks)
 *   - misc approval processing (CANCEL_TRANSFER shipment lookup)
 *   - post_assets (purchase-invoice date inherited by the asset)
 *   - GET purchase-orders / purchase-invoices / shipments / vendor-payments
 *     fell back to the mirror whenever the SQL read threw
 *
 * A stale mirror row could therefore answer "not found" for a live row, pick a
 * different invoice/payment set, or serve a deleted row's data. Each site now
 * reads PostgreSQL when connected; the mirror is PG-down demo mode only, and a
 * failed read returns a retryable 500 instead of a stale snapshot.
 *
 * PROVES (source + repo pins, no DB needed):
 *   1. Every converted decision site names a PG repo query and no longer scans
 *      the mirror before it.
 *   2. The shipment receive mirror settlement cannot double-apply after the PG
 *      transaction already credited destination stock.
 *   3. The new single-row SQL constants keep their id/tracking-code shapes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PO_FIND_BY_ID_SQL,
  PI_FIND_BY_ID_SQL,
  PI_EXISTS_FOR_PO_SQL,
  VP_POSTED_BY_INVOICE_SQL,
  VP_FIND_BY_ID_SQL,
} from '../server/src/models/procurement.repo';
import {
  SHIPMENT_FIND_ONE_SQL,
  SHIPMENT_FIND_CANDIDATES_SQL,
} from '../server/src/models/shipments.repo';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

/** Assert the anchor exists and the nearest preceding branch is a PG read. */
const assertPgFirst = (source: string, anchor: string, lookBehind = 400): void => {
  const idx = source.indexOf(anchor);
  assert.ok(idx !== -1, `expected converted PostgreSQL read not found: ${anchor}`);
  const window = source.slice(Math.max(0, idx - lookBehind), idx);
  assert.ok(
    window.includes('getPgConnected()'),
    `expected the PG-connected branch to precede ${anchor}`
  );
};

describe('bootstrap trim step 5 — PO / PI mirrors are PG-only when connected', () => {
  test('procurement mutations read PostgreSQL first', () => {
    const src = read('server/src/controllers/procurement.controller.ts');

    // PO update loads the row from PG (mirror only in the demo branch).
    assertPgFirst(src, 'pgPool.query(PO_FIND_BY_ID_SQL, [id])');
    assert.ok(
      /if \(getPgConnected\(\) && !existingPO\) \{\s*return res\.status\(404\)/.test(src),
      'updating a PO that no longer exists must 404 instead of answering from the mirror'
    );

    // PO delete resolves the row and its linked invoice from PG.
    assertPgFirst(src, 'pgPool.query(PO_FIND_FOR_DELETE_SQL, [id])');
    assertPgFirst(src, 'pgPool.query(PI_EXISTS_FOR_PO_SQL, [po.id, po.poNumber])');

    // Bill create resolves its PO and duplicate number from PG.
    assertPgFirst(src, 'pgPool.query(PO_FIND_BY_REF_SQL, [poReference])');
    assertPgFirst(src, 'pgPool.query(PI_EXISTS_SQL, [newInv.id, newInv.invoiceNumber])');

    // Invoice reversal resolves the bill + its posted payments from PG.
    assertPgFirst(src, 'pgPool.query(VP_POSTED_BY_INVOICE_SQL, [id])', 800);
    assertPgFirst(src, 'pgPool.query(VP_FIND_BY_ID_SQL, [id])', 400);

    // Vendor ledger: a failed read is an error, never a mirror substitute.
    assert.ok(
      src.includes('Could not load the vendor ledger from the database'),
      'vendor ledger read failure must surface a retryable error'
    );
    assert.ok(
      !src.includes('using cache:'),
      'vendor ledger must not fall back to the mirror when PostgreSQL is connected'
    );
  });

  test('registers fail loud instead of serving a stale mirror on a read error', () => {
    const procurement = read('server/src/controllers/procurement.controller.ts');
    for (const message of [
      'Could not load purchase orders from the database',
      'Could not load purchase invoices from the database',
      'Could not load vendor payments from the database',
      'Could not load invoice payments from the database',
    ]) {
      assert.ok(procurement.includes(message), `missing retryable failure: ${message}`);
    }

    const shipments = read('server/src/controllers/shipments.controller.ts');
    assert.ok(
      shipments.includes('Could not load shipments from the database'),
      'shipment register read failure must surface a retryable error'
    );
  });

  test('shipment and asset decisions are PG-first, receive mirror cannot double-apply', () => {
    const shipments = read('server/src/controllers/shipments.controller.ts');
    // Receive, cancel and undo-receive all resolve the shipment before deciding.
    const shipmentLookups = shipments.match(/SHIPMENT_FIND_ONE_SQL/g) || [];
    assert.ok(
      shipmentLookups.length >= 4,
      `expected receive/cancel/undo lookups through SHIPMENT_FIND_ONE_SQL (found ${shipmentLookups.length})`
    );
    assert.ok(
      /if \(!getPgConnected\(\) && sh\.destinationBranchId\) \{/.test(shipments),
      'the demo receive settlement must be gated so PG stock is never credited twice'
    );

    const misc = read('server/src/controllers/misc.controller.ts');
    assertPgFirst(misc, 'client.query(SHIPMENT_FIND_CANDIDATES_SQL', 500);

    const inventory = read('server/src/controllers/inventory.controller.ts');
    assertPgFirst(inventory, 'pgPool.query(PI_FIND_BY_ID_SQL', 500);
  });
});

describe('bootstrap trim step 5 — single-row SQL shapes', () => {
  test('procurement lookups are keyed by id or bill number', () => {
    assert.match(PO_FIND_BY_ID_SQL, /FROM purchase_orders WHERE id = \$1 LIMIT 1$/);
    assert.match(PI_FIND_BY_ID_SQL, /FROM purchase_invoices WHERE id = \$1 LIMIT 1$/);
    assert.match(PI_EXISTS_FOR_PO_SQL, /po_reference_id = \$1 OR po_reference_id = \$2/);
    assert.match(VP_FIND_BY_ID_SQL, /FROM vendor_payments WHERE id = \$1 LIMIT 1$/);
    assert.match(VP_POSTED_BY_INVOICE_SQL, /invoice_id = \$1 AND status = 'POSTED'/);
  });

  test('shipment lookups resolve id and tracking code', () => {
    assert.match(SHIPMENT_FIND_ONE_SQL, /WHERE id = \$1 OR tracking_code = \$1 LIMIT 1$/);
    assert.match(SHIPMENT_FIND_CANDIDATES_SQL, /id = ANY\(\$1::text\[\]\)/);
    assert.match(SHIPMENT_FIND_CANDIDATES_SQL, /UPPER\(tracking_code\) = ANY\(\$2::text\[\]\)/);
  });
});
