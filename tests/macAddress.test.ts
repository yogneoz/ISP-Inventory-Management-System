import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMacAddress, macKey, normalizeMacAddress } from '../shared/macAddress';

test('canonicalises a 12-hex barcode with no separators', () => {
  assert.equal(normalizeMacAddress('a4c3f0b1d2e3'), 'A4:C3:F0:B1:D2:E3');
});

test('canonicalises hyphen, dot, space and colon forms', () => {
  const canonical = 'A4:C3:F0:B1:D2:E3';
  for (const input of [
    'A4-C3-F0-B1-D2-E3',
    'a4c3.f0b1.d2e3',
    'a4 c3 f0 b1 d2 e3',
    ' A4:C3:F0:B1:D2:E3 ',
  ]) {
    assert.equal(normalizeMacAddress(input), canonical, input);
  }
});

test('is idempotent', () => {
  const once = normalizeMacAddress('a4c3f0b1d2e3');
  assert.equal(normalizeMacAddress(once), once);
});

test('leaves non-MAC values untouched (never mangles a serial)', () => {
  assert.equal(normalizeMacAddress('HWTC-90A812C4'), 'HWTC-90A812C4');
  assert.equal(normalizeMacAddress('SN-ONU24G-881923'), 'SN-ONU24G-881923');
  assert.equal(normalizeMacAddress('A4:C3:F0:B1:D2'), 'A4:C3:F0:B1:D2');
  assert.equal(normalizeMacAddress('A4:C3:F0:B1:D2:E3:F4'), 'A4:C3:F0:B1:D2:E3:F4');
});

test('handles empty values', () => {
  assert.equal(normalizeMacAddress(''), '');
  assert.equal(normalizeMacAddress('   '), '');
  assert.equal(normalizeMacAddress(null), '');
  assert.equal(normalizeMacAddress(undefined), '');
});

test('macKey collapses separator/case variants to the same key', () => {
  assert.equal(macKey('a4c3f0b1d2e3'), 'A4C3F0B1D2E3');
  assert.equal(macKey('A4:C3:F0:B1:D2:E3'), 'A4C3F0B1D2E3');
  assert.equal(macKey('A4-C3-F0-B1-D2-E3'), macKey('a4c3.f0b1.d2e3'));
  assert.equal(macKey('HWTC-90A812C4'), 'HWTC-90A812C4');
});

test('isMacAddress recognises only 12-hex-digit values', () => {
  assert.equal(isMacAddress('a4c3f0b1d2e3'), true);
  assert.equal(isMacAddress('A4:C3:F0:B1:D2:E3'), true);
  assert.equal(isMacAddress('HWTC-90A812C4'), false);
  assert.equal(isMacAddress(''), false);
});
