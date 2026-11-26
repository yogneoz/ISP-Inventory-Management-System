/**
 * The customer-device register (CDR) write, in one place.
 *
 * `customer_device_records` holds at most ONE row per serial
 * (`uq_customer_device_device_serial`), so every deployment has exactly two
 * cases: no row (insert) or a closed row that has to be re-activated. This
 * module owns that decision so the front-desk deploy and the technician's
 * installation from the van cannot write the directory differently.
 */
import type { CustomerDeviceRecord } from '../../../client/src/types';
import {
  CDR_EXCHANGE_INSERT_SQL,
  CDR_REDEPLOY_BY_SERIAL_SQL,
  CDR_SERIAL_ROW_SQL,
  cdrRedeployParams,
  customerDeviceInsertParams,
} from '../models/inventory.repo';
import { isActiveCdrStatus } from './cdrSerialSync';

export type CustomerDeviceWriteResult = 'INSERTED' | 'REACTIVATED' | 'ALREADY_ACTIVE';

export async function registerCustomerDeviceRow(
  client: any,
  row: CustomerDeviceRecord
): Promise<CustomerDeviceWriteResult> {
  const existing = await client.query(CDR_SERIAL_ROW_SQL, [String(row.deviceSerial)]);
  if (!existing.rowCount) {
    await client.query(CDR_EXCHANGE_INSERT_SQL, customerDeviceInsertParams(row));
    return 'INSERTED';
  }
  if (isActiveCdrStatus(existing.rows[0]?.status)) return 'ALREADY_ACTIVE';
  await client.query(CDR_REDEPLOY_BY_SERIAL_SQL, cdrRedeployParams(row));
  return 'REACTIVATED';
}
