/**
 * Customer Device Serials — duplicate identity detection (CPE-2).
 *
 * customer_device_records has unique indexes on device_serial, pon_serial and
 * mac_address. Serial/PON collisions were already surfaced as a readable 409,
 * but a duplicate MAC reached uq_customer_device_mac_address and returned a raw
 * 500. These tests pin the single comparison rule shared by the PG probe, the
 * in-memory mirror and the exchange pre-flight: MAC compares by its canonical
 * 12-hex key, so "a4c3f0b1d2e3" and "A4:C3:F0:B1:D2:E3" are the same device.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cdrDuplicateFromRow,
  cdrDuplicateMessage,
  cdrFieldLabel,
  findCdrDuplicate,
} from '../server/src/services/cdrDuplicates';

describe('findCdrDuplicate', () => {
  const existing = {
    id: 'cdr-1',
    deviceSerial: ' SN-ONU-1 ',
    ponSerial: 'PON-1',
    macAddress: 'A4:C3:F0:B1:D2:E3',
  };

  test('a MAC written without separators collides with its canonical form', () => {
    const dup = findCdrDuplicate([existing], {
      id: 'cdr-new',
      deviceSerial: 'SN-NEW',
      ponSerial: 'PON-NEW',
      macAddress: 'a4c3f0b1d2e3',
    });
    assert.deepEqual(dup, {
      field: 'macAddress',
      conflictingId: 'cdr-1',
      conflictingSerial: ' SN-ONU-1 ',
    });
  });

  test('serial and PON compare case/trim-insensitively', () => {
    const serial = findCdrDuplicate([existing], {
      id: 'cdr-new',
      deviceSerial: ' sn-onu-1 ',
      ponSerial: 'PON-NEW',
    });
    assert.equal(serial?.field, 'deviceSerial');

    const pon = findCdrDuplicate([existing], {
      id: 'cdr-new',
      deviceSerial: 'SN-NEW',
      ponSerial: ' pon-1 ',
    });
    assert.equal(pon?.field, 'ponSerial');
  });

  test('empty identity fields never collide', () => {
    const dup = findCdrDuplicate([existing], {
      id: 'cdr-new',
      deviceSerial: '',
      ponSerial: '   ',
      macAddress: '',
    });
    assert.equal(dup, null);
  });

  test('the candidate record itself is excluded from the probe', () => {
    const dup = findCdrDuplicate([existing], { ...existing });
    assert.equal(dup, null);
  });

  test('a genuinely new identity passes', () => {
    const dup = findCdrDuplicate([existing], {
      id: 'cdr-new',
      deviceSerial: 'SN-NEW',
      ponSerial: 'PON-NEW',
      macAddress: '00:11:22:33:44:55',
    });
    assert.equal(dup, null);
  });
});

describe('duplicate 409 copy', () => {
  test('each identity field gets its own readable label and message', () => {
    assert.equal(cdrFieldLabel('deviceSerial'), 'Device serial');
    assert.equal(cdrFieldLabel('ponSerial'), 'PON serial');
    assert.equal(cdrFieldLabel('macAddress'), 'MAC address');

    assert.match(cdrDuplicateMessage('macAddress'), /^That mac address is already registered/);
    assert.match(cdrDuplicateMessage('deviceSerial'), /^That device serial is already registered/);
  });

  test('the PG probe row maps back to the field it matched', () => {
    assert.deepEqual(
      cdrDuplicateFromRow({ field: 'mac_address', deviceSerial: 'SN-OLD' }),
      { field: 'macAddress', conflictingSerial: 'SN-OLD' }
    );
    assert.deepEqual(
      cdrDuplicateFromRow({ field: 'pon_serial', deviceSerial: 'SN-OLD' }),
      { field: 'ponSerial', conflictingSerial: 'SN-OLD' }
    );
    // A malformed row still produces a usable message rather than undefined.
    assert.equal(cdrDuplicateFromRow({}).field, 'deviceSerial');
  });
});
