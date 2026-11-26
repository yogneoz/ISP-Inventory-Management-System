/**
 * Installing a CPE the technician carried, at the customer the visit names.
 *
 * Until this module existed the same act was written three different ways: the
 * front desk deployed straight to a customer (asset, serial, customer-device row
 * and seller coverage in one transaction), the phone's completion moved custody
 * and the serial but created neither the customer-device row nor the warranty,
 * and the web completion moved nothing at all. So a technician's installation
 * left the customer's directory and its warranty empty.
 *
 * This is now the ONE writer of that transition, called from every entry point:
 *
 *   fixed_assets   IN_USE (held by the technician) → ASSIGNED_TO_CUSTOMER,
 *                  customer named by the work order, assignment_date = the
 *                  COMPLETION date (the dispatch deliberately left it null),
 *                  employee custody cleared;
 *   serial_log     IN_CUSTODY (holder) → CUSTOMER_ASSIGNED (+ customer);
 *   customer_device_records  one row per serial (`cdr-asset-<assetId>`);
 *   warranty_coverages       one SELLER period starting at the completion date.
 *
 * The caller owns the transaction: a refused install must roll the completion
 * (or the mobile queue item) back with it, never leave a closed visit whose
 * device never reached the customer.
 */
import {
  CUSTOMER_FOR_CDR_INSERT_SQL,
  FIXED_ASSET_HELD_BY_SERIAL_SQL,
  FIXED_ASSET_INSTALL_AT_CUSTOMER_SQL,
  FIXED_ASSET_LOCK_BY_ID_SQL,
  PRODUCT_INSTALL_TERM_SQL,
} from '../models/inventory.repo';
import { FWO_INSTALL_LOCK_SQL } from '../models/fieldWorkOrders.repo';
import { resolveBsDateForLedgerSync } from '../utils/bsDate';
import { registerCustomerDeviceRow } from './customerDevice.service';
import { releaseCustodySerialsInDb, SerialCustodyRefusal } from './serialCustody.service';
import { buildSellerCoverageCaptures, writeSellerCoveragePlan } from './warranty.service';
import type { Product } from '../../../client/src/types';

/** A refusal the caller can answer with; `status` is the HTTP status to send. */
export class CustodyInstallRefusal extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code:
      | 'ASSET_NOT_FOUND'
      | 'ASSET_NOT_HELD'
      | 'ASSET_NOT_IN_CUSTODY'
      | 'ASSET_WRONG_WORK_ORDER'
      | 'ASSET_NO_SERIAL'
      | 'WORK_ORDER_NOT_FOUND'
      | 'WORK_ORDER_CANCELLED'
      | 'WORK_ORDER_WRONG_BRANCH'
      | 'WORK_ORDER_WRONG_TECHNICIAN'
      | 'CUSTOMER_NOT_FOUND' = 'ASSET_NOT_HELD'
  ) {
    super(message);
    this.name = 'CustodyInstallRefusal';
  }
}

/** The product fields the warranty term is read from. */
export interface InstallProduct {
  id: string;
  name?: string;
  sku?: string;
  costPrice?: number;
  sellerWarrantyMonths?: number;
}

export interface InstallHeldAssetInput {
  client: any;
  assetId: string;
  /** The person whose custody the unit must leave. */
  employeeId: string;
  workOrderId: string;
  /** The completion date — the day the customer received the unit. */
  dateAD: string;
  dateBS?: string;
  actor?: string | null;
  /** Product master rows the caller already holds (optional; read when absent). */
  products?: readonly InstallProduct[];
}

export interface InstallHeldAssetResult {
  assetId: string;
  tagNumber: string;
  deviceSerial: string;
  branchId: string;
  customerId: string;
  customerName: string;
  workOrderId: string;
  workOrderNo: string;
  /** The warranty start: the completion date, never the dispatch date. */
  warrantyStartDateAD: string;
  warrantyWritten: boolean;
  customerDeviceAction: 'INSERTED' | 'REACTIVATED' | 'ALREADY_ACTIVE';
}

interface HeldAssetRow {
  id: string;
  tagNumber: string;
  name?: string;
  productId: string | null;
  branchId: string | null;
  status: string;
  deviceSerial: string | null;
  assignedEmployeeId?: string | null;
  assignedWorkOrderId?: string | null;
  assignmentNotes?: string | null;
  acquisitionCost?: number | null;
}

const dateOnly = (value: unknown): string => String(value || '').slice(0, 10);

/** Notes keep the install as an auditable line on the asset, not a lost column. */
export function buildInstallNotes(
  prevNotes: string | null | undefined,
  opts: { dateAD: string; workOrderNo: string; customerName: string }
): string {
  const parts: string[] = [];
  if (prevNotes) parts.push(String(prevNotes));
  parts.push(
    `[INSTALLED ${opts.dateAD}] Work order ${opts.workOrderNo}; issued to ${opts.customerName}.`
  );
  return parts.join(' | ');
}

async function productForInstall(
  client: any,
  input: InstallHeldAssetInput,
  productId: string | null
): Promise<InstallProduct | undefined> {
  if (!productId) return undefined;
  const known = input.products?.find((product) => product.id === productId);
  if (known) return known;
  const row = (await client.query(PRODUCT_INSTALL_TERM_SQL, [productId])).rows[0];
  return row || undefined;
}

/**
 * Installs one held unit at the work order's customer.
 *
 * Every precondition is a refusal with its own code, because each one is a real
 * operator mistake: a unit the caller does not hold, a unit dispatched for a
 * different visit, a cancelled visit, a technician mismatch, or a unit whose
 * serial was never registered (and so cannot be given to a customer).
 */
export async function installHeldAssetAtCustomer(
  input: InstallHeldAssetInput
): Promise<InstallHeldAssetResult> {
  const { client } = input;
  const dateAD = dateOnly(input.dateAD);
  if (!dateAD) throw new CustodyInstallRefusal(400, 'An installation needs its completion date.', 'ASSET_NOT_HELD');

  const asset = (await client.query(FIXED_ASSET_LOCK_BY_ID_SQL, [input.assetId])).rows[0] as
    | HeldAssetRow
    | undefined;
  if (!asset) {
    throw new CustodyInstallRefusal(404, `Fixed asset ${input.assetId} was not found.`, 'ASSET_NOT_FOUND');
  }
  if (String(asset.assignedEmployeeId || '') !== String(input.employeeId)) {
    throw new CustodyInstallRefusal(
      409,
      `Asset ${asset.tagNumber} is not in this employee's custody — only the technician holding a unit can install it.`,
      'ASSET_NOT_HELD'
    );
  }
  if (String(asset.status || '').toUpperCase() !== 'IN_USE') {
    throw new CustodyInstallRefusal(
      409,
      `Asset ${asset.tagNumber} is ${asset.status}, not issued to a technician; nothing was installed.`,
      'ASSET_NOT_IN_CUSTODY'
    );
  }
  if (asset.assignedWorkOrderId && String(asset.assignedWorkOrderId) !== String(input.workOrderId)) {
    throw new CustodyInstallRefusal(
      409,
      `Asset ${asset.tagNumber} was dispatched for another work order; it cannot be installed on this visit.`,
      'ASSET_WRONG_WORK_ORDER'
    );
  }
  const serial = String(asset.deviceSerial || '').trim();
  if (!serial) {
    throw new CustodyInstallRefusal(
      409,
      `Asset ${asset.tagNumber} has no device serial, so its installation cannot be registered against a customer. Record the unit's serial first.`,
      'ASSET_NO_SERIAL'
    );
  }

  const order = (await client.query(FWO_INSTALL_LOCK_SQL, [input.workOrderId])).rows[0];
  if (!order) {
    throw new CustodyInstallRefusal(404, 'That work order was not found.', 'WORK_ORDER_NOT_FOUND');
  }
  if (String(order.status) === 'CANCELLED') {
    throw new CustodyInstallRefusal(409, 'That work order is cancelled; nothing was installed.', 'WORK_ORDER_CANCELLED');
  }
  if (String(order.branch_id) !== String(asset.branchId || '')) {
    throw new CustodyInstallRefusal(
      409,
      'The work order belongs to another branch than the unit being installed.',
      'WORK_ORDER_WRONG_BRANCH'
    );
  }
  if (order.technicianId && String(order.technicianId) !== String(input.employeeId)) {
    throw new CustodyInstallRefusal(
      409,
      `Work order ${order.work_order_no} is assigned to another technician; only its technician can install the unit it delivered.`,
      'WORK_ORDER_WRONG_TECHNICIAN'
    );
  }

  const customerRow = (await client.query(CUSTOMER_FOR_CDR_INSERT_SQL, [String(order.customer_id || '')])).rows[0];
  if (!customerRow) {
    throw new CustodyInstallRefusal(
      409,
      `The customer on work order ${order.work_order_no} no longer exists; nothing was installed.`,
      'CUSTOMER_NOT_FOUND'
    );
  }
  const customerId = String(order.customer_id);
  const customerName = String(customerRow.customer_name || order.customerName || 'Unknown Customer');
  const customerCode = String(customerRow.customer_id || customerId);

  // The serial leaves the holder through the guarded release: it refuses a unit
  // that is not IN_CUSTODY, or one held by somebody else, so the asset row and
  // the register cannot be moved by different people.
  try {
    await releaseCustodySerialsInDb(client, {
      employeeId: input.employeeId,
      productId: String(asset.productId || ''),
      branchId: String(asset.branchId || ''),
      serials: [serial],
      status: 'CUSTOMER_ASSIGNED',
      customerId,
      customerName,
      sourceType: 'WORK_ORDER',
      sourceId: String(order.id),
      dateAD,
      note: `Installed at ${customerName} on work order ${order.work_order_no}`,
    });
  } catch (error) {
    if (error instanceof SerialCustodyRefusal) {
      throw new CustodyInstallRefusal(error.status, error.message, 'ASSET_NOT_IN_CUSTODY');
    }
    throw error;
  }

  const dateBS = input.dateBS || resolveBsDateForLedgerSync(dateAD);
  const installed = await client.query(FIXED_ASSET_INSTALL_AT_CUSTOMER_SQL, [
    asset.id,
    customerId,
    customerName,
    dateAD,
    dateBS,
    buildInstallNotes(asset.assignmentNotes, { dateAD, workOrderNo: order.work_order_no, customerName }),
  ]);
  if (!installed.rows[0]) {
    throw new CustodyInstallRefusal(409, `Asset ${asset.tagNumber} changed before it could be installed.`, 'ASSET_NOT_HELD');
  }

  const product = await productForInstall(client, input, asset.productId);
  const cdrId = `cdr-asset-${asset.id}`;
  const customerDeviceAction = await registerCustomerDeviceRow(client, {
    id: cdrId,
    customerId,
    customerName,
    customerCode,
    contactPhone: String(customerRow.contact_number || ''),
    installationAddress: String(customerRow.address || ''),
    branchId: String(asset.branchId || ''),
    productName: String(asset.name || product?.name || asset.tagNumber),
    deviceSerial: serial,
    // The asset register does not carry a PON identity; the deployment path
    // falls back to the serial in the same situation.
    ponSerial: serial,
    status: 'RENTAL',
    issuedDateAD: dateAD,
    issuedDateBS: dateBS,
    // The tag marker is what the collection reversal finds this row by.
    notes: `[RENTAL CPE ASSET - Tag: ${asset.tagNumber}] Installed on work order ${order.work_order_no}`,
  } as any);

  const plan = buildSellerCoverageCaptures({
    startDateAD: dateAD,
    entries: [
      {
        deviceSerial: serial,
        productId: asset.productId,
        productName: String(asset.name || product?.name || serial),
      },
    ],
    productFor: () => product as Product | undefined,
    partyId: customerId,
    partyName: customerName,
    branchId: String(asset.branchId || ''),
    sourceType: 'CUSTOMER_ASSIGNMENT',
    sourceId: cdrId,
    sourceNumber: asset.tagNumber,
    itemCategory: 'CPE',
    startBasis: 'ISSUE_DATE',
    deviceRecordIdFor: () => cdrId,
  });
  if (plan.error) {
    throw new CustodyInstallRefusal(400, plan.error, 'ASSET_NO_SERIAL');
  }
  await writeSellerCoveragePlan(client, plan.captures);

  return {
    assetId: asset.id,
    tagNumber: asset.tagNumber,
    deviceSerial: serial,
    branchId: String(asset.branchId || ''),
    customerId,
    customerName,
    workOrderId: String(order.id),
    workOrderNo: String(order.work_order_no),
    warrantyStartDateAD: dateAD,
    warrantyWritten: plan.captures.length > 0,
    customerDeviceAction,
  };
}

/**
 * Installs whichever of a phone's serials name a unit held by this technician.
 *
 * The phone also records a serial purely as the visit's ONT tag; a serial that
 * is not an asset in this person's custody is left to the ordinary custody
 * consumption, so the install never claims a unit the technician did not hold.
 */
export async function installHeldSerialsForWorkOrder(
  input: Omit<InstallHeldAssetInput, 'assetId'> & { serials: readonly string[] }
): Promise<{ installed: InstallHeldAssetResult[]; remainingSerials: string[] }> {
  const installed: InstallHeldAssetResult[] = [];
  const remainingSerials: string[] = [];
  for (const serial of input.serials) {
    const row = (
      await input.client.query(FIXED_ASSET_HELD_BY_SERIAL_SQL, [serial, input.employeeId])
    ).rows[0];
    if (!row) {
      remainingSerials.push(serial);
      continue;
    }
    installed.push(
      await installHeldAssetAtCustomer({
        ...input,
        assetId: String(row.id),
        products: input.products,
      })
    );
  }
  return { installed, remainingSerials };
}
