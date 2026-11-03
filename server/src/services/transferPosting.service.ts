/**
 * Ledger postings for inter-branch stock movements.
 *
 * A transfer is two branch-side value movements, never one company-side one:
 * the dispatching branch gives up inventory and carries a receivable from head
 * office; the receiving branch takes on inventory and carries a payable to head
 * office. Posting both legs in their own branch dimension is what lets each
 * branch's balance sheet close on its own, while the company roll-up nets the
 * two custody accounts to zero.
 *
 * The value is the dispatching row's moving weighted average, read under the
 * same lock that deducts the stock. The issue cost is stamped onto the shipment
 * line so the receive leg posts the *same* value — a destination's own average
 * is irrelevant to goods it did not buy. Legacy shipments that predate the
 * stamp are valued from their TRANSFER_OUT movement row; if neither records a
 * cost the document is refused rather than valued at zero.
 *
 * Callers own the transaction. No function here opens one.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  INTER_BRANCH_ACCOUNTS_SQL,
} from '../models/accounting.repo';
import {
  postJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';
import { reverseSourceJournal } from './invoicePosting.service';
import { SHIPMENT_ISSUE_COST_SQL } from '../models/shipments.repo';

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  postingRole: string | null;
}

export interface TransferValueLine {
  productId: string;
  quantity: number;
  unitCost: number;
}

export interface TransferJournalInput {
  shipmentId: string;
  dateAD: string;
  sourceBranchId: string;
  sourceBranchName?: string | null;
  destinationBranchId: string;
  destinationBranchName?: string | null;
  actor?: string | null;
  lines: readonly TransferValueLine[];
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

/**
 * Picks the custody account for one side. An operator-assigned posting role
 * wins; otherwise the seeded default code is used, and a chart carrying exactly
 * one custody account of the needed type is unambiguous. Anything else refuses
 * instead of picking an arbitrary account.
 */
function pickSide(
  rows: readonly PostingAccount[],
  role: string,
  code: string,
  accountType: 'ASSET' | 'LIABILITY',
  label: string
): PostingAccount {
  const byRole = rows.find((row) => row.postingRole === role);
  if (byRole) return byRole;
  const byCode = rows.find((row) => row.code === code && row.accountType === accountType);
  if (byCode) return byCode;
  const ofType = rows.filter((row) => row.accountType === accountType);
  if (ofType.length === 1) return ofType[0];
  throw new ApiError(
    400,
    `Accounting is not configured for inter-branch transfers: ${ofType.length === 0 ? 'no' : 'more than one'} active ` +
      `${accountType} account carries the INTER_BRANCH subledger. Map the ${label} posting default, then post the transfer again.`
  );
}

async function loadTransferAccounts(client: AccountingClient): Promise<{
  inventory: PostingAccount;
  dueFrom: PostingAccount;
  dueTo: PostingAccount;
}> {
  const inventoryRows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['INVENTORY']])).rows as PostingAccount[];
  const inventory = inventoryRows.find((row) => row.postingRole === 'INVENTORY');
  if (!inventory) {
    throw new ApiError(
      400,
      'Accounting is not configured for inter-branch transfers: no active account has the INVENTORY posting default. Map it, then post the transfer again.'
    );
  }
  const custody = (await client.query(INTER_BRANCH_ACCOUNTS_SQL)).rows as PostingAccount[];
  return {
    inventory,
    dueFrom: pickSide(custody, 'DUE_FROM_HO', '1610', 'ASSET', 'DUE_FROM_HO (due from head office)'),
    dueTo: pickSide(custody, 'DUE_TO_HO', '2310', 'LIABILITY', 'DUE_TO_HO (due to head office)'),
  };
}

/**
 * The cost a transfer movement must be valued at: the issue cost stamped onto
 * the shipment line by the dispatch, or — for a shipment created before that
 * stamp existed — the value its TRANSFER_OUT movement row recorded. A shipment
 * with neither is refused: valuing it at the destination's average (or at
 * zero) would silently diverge from what the source relieved.
 */
export async function resolveTransferUnitCost(
  client: AccountingClient,
  shipment: { id: string; trackingCode?: string },
  item: any,
  sourceBranchId: string
): Promise<number> {
  const stamped = Number(item?.unitCost);
  if (item?.unitCost !== undefined && item?.unitCost !== null && Number.isFinite(stamped)) {
    return Math.max(0, stamped);
  }
  if (sourceBranchId) {
    const rows = (
      await client.query(SHIPMENT_ISSUE_COST_SQL, [shipment.id, sourceBranchId, [String(item?.productId || '')]])
    ).rows;
    const quantity = Number(rows[0]?.quantity);
    const value = Number(rows[0]?.value);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(value)) {
      return Math.max(0, value / quantity);
    }
  }
  throw new ApiError(
    400,
    `Transfer ${shipment.trackingCode || shipment.id} records no dispatch cost for ${item?.productName || item?.productId}. ` +
      'The movement cannot be valued — nothing was posted.'
  );
}

/** Signed value of one leg, ignoring lines with no quantity. */
export function transferJournalValue(lines: readonly TransferValueLine[]): number {
  return roundMoney(
    lines.reduce((sum, line) => sum + Math.abs(Number(line.quantity) || 0) * money(line.unitCost), 0)
  );
}

/**
 * Dispatch leg: inventory leaves the source and becomes due from head office.
 * Zero-value movements (stock with no cost yet) post nothing — the receipt leg
 * will likewise post nothing, so neither branch carries a phantom journal.
 */
export async function postTransferDispatchJournal(
  client: AccountingClient,
  input: TransferJournalInput
) {
  const value = transferJournalValue(input.lines);
  if (value < 0.005) return null;

  const accounts = await loadTransferAccounts(client);
  const memo = `Inter-branch transfer ${input.shipmentId} dispatched to ${input.destinationBranchName || input.destinationBranchId}`;
  const lines: JournalLineInput[] = [
    {
      accountId: accounts.dueFrom.id,
      debit: value,
      credit: 0,
      memo: `${memo} — due from head office`,
      subledgerType: 'INTER_BRANCH',
      partyId: input.destinationBranchId,
      partyName: input.destinationBranchName || input.destinationBranchId,
    },
    { accountId: accounts.inventory.id, debit: 0, credit: value, memo: `${memo} — inventory released` },
  ];

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.sourceBranchId,
    memo,
    sourceType: 'TRANSFER_OUT',
    sourceId: input.shipmentId,
    actor: input.actor || null,
    lines,
  });
}

/**
 * Receipt leg: the destination takes on the inventory value the source issued,
 * against a payable to head office. `unitCost` comes from the shipment line, not
 * the destination's own average.
 */
export async function postTransferReceiptJournal(
  client: AccountingClient,
  input: TransferJournalInput
) {
  const value = transferJournalValue(input.lines);
  if (value < 0.005) return null;

  const accounts = await loadTransferAccounts(client);
  const memo = `Inter-branch transfer ${input.shipmentId} received from ${input.sourceBranchName || input.sourceBranchId}`;
  const lines: JournalLineInput[] = [
    { accountId: accounts.inventory.id, debit: value, credit: 0, memo: `${memo} — inventory received` },
    {
      accountId: accounts.dueTo.id,
      debit: 0,
      credit: value,
      memo: `${memo} — due to head office`,
      subledgerType: 'INTER_BRANCH',
      partyId: input.sourceBranchId,
      partyName: input.sourceBranchName || input.sourceBranchId,
    },
  ];

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.destinationBranchId,
    memo,
    sourceType: 'TRANSFER_IN',
    sourceId: input.shipmentId,
    actor: input.actor || null,
    lines,
  });
}

/**
 * Contra journal for a cancelled dispatch or an undone receipt. A legacy leg
 * that predates ledger posting has no journal, so there is nothing to reverse.
 */
export async function reverseTransferJournal(
  client: AccountingClient,
  input: {
    leg: 'OUT' | 'IN';
    shipmentId: string;
    dateAD: string;
    reason: string;
    actor?: string | null;
  }
) {
  return reverseSourceJournal(client, {
    sourceType: input.leg === 'OUT' ? 'TRANSFER_OUT' : 'TRANSFER_IN',
    reversalSourceType: input.leg === 'OUT' ? 'TRANSFER_OUT_REVERSAL' : 'TRANSFER_IN_REVERSAL',
    sourceId: input.shipmentId,
    dateAD: input.dateAD,
    reason: input.reason,
    actor: input.actor || null,
  });
}
