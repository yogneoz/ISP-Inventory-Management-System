/**
 * Customer Device Serials — identity duplicate detection.
 *
 * customer_device_records has unique indexes on device_serial, pon_serial and
 * mac_address. The serial/PON half was already checked before writes, but a
 * duplicate MAC reached the unique index and surfaced as a raw 500. This module
 * is the single comparison rule shared by the PG probe and the demo mirror:
 * serial/PON compare case- and trim-insensitively, MAC compares by its canonical
 * 12-hex key (so "a4c3f0b1d2e3" and "A4:C3:F0:B1:D2:E3" are the same device).
 */
import { macKey } from '../../../shared/macAddress';

export type CdrIdentityField = 'deviceSerial' | 'ponSerial' | 'macAddress';

/** The identity fields needed to detect a collision. */
export interface CdrIdentity {
  id?: unknown;
  deviceSerial?: unknown;
  ponSerial?: unknown;
  macAddress?: unknown;
}

export interface CdrDuplicate {
  field: CdrIdentityField;
  /** The row that already owns the value, when known. */
  conflictingId?: string;
  conflictingSerial?: string;
}

const FIELD_LABELS: Record<CdrIdentityField, string> = {
  deviceSerial: 'Device serial',
  ponSerial: 'PON serial',
  macAddress: 'MAC address',
};

const SQL_FIELD_MAP: Record<string, CdrIdentityField> = {
  device_serial: 'deviceSerial',
  pon_serial: 'ponSerial',
  mac_address: 'macAddress',
};

/** Human label for a duplicate field, used in the 409 message. */
export function cdrFieldLabel(field: CdrIdentityField): string {
  return FIELD_LABELS[field] || 'Device identity';
}

/**
 * Finds the first record that already owns one of the candidate's identity
 * values. The candidate's own id is excluded (an update may keep its values).
 * Empty values never collide.
 */
export function findCdrDuplicate(
  rows: readonly CdrIdentity[],
  candidate: CdrIdentity
): CdrDuplicate | null {
  const selfId = String(candidate.id ?? '');
  const serial = String(candidate.deviceSerial ?? '').trim().toUpperCase();
  const pon = String(candidate.ponSerial ?? '').trim().toUpperCase();
  const mac = macKey(candidate.macAddress);

  for (const row of rows) {
    const rowId = String(row.id ?? '');
    if (selfId && rowId === selfId) continue;

    const rowSerial = String(row.deviceSerial ?? '') || undefined;
    if (serial && String(row.deviceSerial ?? '').trim().toUpperCase() === serial) {
      return { field: 'deviceSerial', conflictingId: rowId, conflictingSerial: rowSerial };
    }
    if (pon && String(row.ponSerial ?? '').trim().toUpperCase() === pon) {
      return { field: 'ponSerial', conflictingId: rowId, conflictingSerial: rowSerial };
    }
    if (mac && macKey(row.macAddress) === mac) {
      return { field: 'macAddress', conflictingId: rowId, conflictingSerial: rowSerial };
    }
  }
  return null;
}

/**
 * Maps the single row returned by CDR_DUPLICATE_CHECK_SQL to the same shape as
 * findCdrDuplicate. The SQL already decided which identity matched, so this is
 * only a field-name translation.
 */
export function cdrDuplicateFromRow(row: {
  field?: string | null;
  deviceSerial?: string | null;
}): CdrDuplicate {
  return {
    field: SQL_FIELD_MAP[String(row?.field ?? '')] || 'deviceSerial',
    conflictingSerial: String(row?.deviceSerial ?? '') || undefined,
  };
}

/** The operator-facing 409 body for a duplicate identity. */
export function cdrDuplicateMessage(field: CdrIdentityField): string {
  const label = cdrFieldLabel(field);
  return `That ${label.toLowerCase()} is already registered to another device. Enter the device's own ${label.toLowerCase()}.`;
}
