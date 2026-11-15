/**
 * Party ledger books for the operational masters.
 *
 * Creating a customer or supplier does not create a new GL account: the chart
 * keeps one AR/AP control account per family, and each party gets a subledger
 * book underneath it. This service owns that one assignment so the customer
 * master, supplier master and the posting path all resolve the same control.
 */
import { ApiError } from '../errors/ApiError';
import {
  PARTY_CONTROL_ACCOUNT_BY_ROLE_SQL,
  SUBLEDGER_BY_ACCOUNT_PARTY_SQL,
  SUBLEDGER_BY_CODE_SQL,
  SUBLEDGER_BY_ID_SQL,
  SUBLEDGER_PARTY_BOOK_ENSURE_SQL,
} from '../models/accounting.repo';

export type PartyBookType = 'CUSTOMER' | 'SUPPLIER';

export interface PartyBookClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PartyLedgerBookAssignment {
  bookId: string;
  code: string;
  name: string;
  created: boolean;
  mainAccountId: string;
  controlAccountCode: string;
  controlAccountName: string;
  groupCode: string | null;
  groupName: string | null;
  parentGroupCode: string | null;
  parentGroupName: string | null;
}

export interface PartyLedgerBookResult {
  book: PartyLedgerBookAssignment | null;
  warning: string | null;
}

interface ControlAccountRow {
  id: string;
  code: string;
  name: string;
  postingRole: string;
  subledgerType: string;
  groupCode: string | null;
  groupName: string | null;
  parentGroupCode: string | null;
  parentGroupName: string | null;
}

function partyBookCode(type: PartyBookType, source: string, attempt = 1): string {
  const prefix = type === 'CUSTOMER' ? 'CUS' : 'SUP';
  const raw = String(source || 'PARTY')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stem = raw
    .replace(new RegExp(`^${prefix}-`), '')
    .slice(0, 26);
  const base = `${prefix}-${stem || 'PARTY'}`.slice(0, 27);
  return attempt === 1 ? base : `${base}-${attempt}`.slice(0, 30);
}

function assignment(
  control: ControlAccountRow,
  book: { id: string; code: string; name: string },
  created: boolean
): PartyLedgerBookAssignment {
  return {
    bookId: book.id,
    code: book.code,
    name: book.name,
    created,
    mainAccountId: control.id,
    controlAccountCode: control.code,
    controlAccountName: control.name,
    groupCode: control.groupCode,
    groupName: control.groupName,
    parentGroupCode: control.parentGroupCode,
    parentGroupName: control.parentGroupName,
  };
}

/**
 * Ensure one party book exists under the chart's active AR/AP control.
 *
 * A missing control account is returned as a warning, not thrown: saving the
 * customer/supplier master must not fail because the chart is incomplete. The
 * caller can show the warning, and the Chart health panel already reports the
 * missing role.
 */
export async function ensurePartySubledgerBook(
  client: PartyBookClient,
  input: {
    type: PartyBookType;
    partyId: string;
    partyName: string;
    partyCode?: string | null;
  }
): Promise<PartyLedgerBookResult> {
  const partyId = String(input.partyId || '').trim();
  if (!partyId) throw new ApiError(400, 'A party id is required to create its ledger book.');

  const role = input.type === 'CUSTOMER' ? 'AR_CONTROL' : 'AP_CONTROL';
  const control = (await client.query(PARTY_CONTROL_ACCOUNT_BY_ROLE_SQL, [role])).rows[0] as
    | ControlAccountRow
    | undefined;
  const family = input.type === 'CUSTOMER' ? 'Accounts Receivable' : 'Accounts Payable';
  if (!control) {
    return {
      book: null,
      warning: `No active ${family} control account is configured, so ${input.partyName} was saved without a ledger book. Set the ${role} control in Finance → Chart of Accounts.`,
    };
  }

  const existing = (await client.query(SUBLEDGER_BY_ACCOUNT_PARTY_SQL, [control.id, partyId])).rows[0];
  if (existing) {
    const book = (await client.query(SUBLEDGER_BY_ID_SQL, [existing.id])).rows[0];
    if (book) return { book: assignment(control, book, false), warning: null };
  }

  let code = partyBookCode(input.type, input.partyCode || partyId);
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if (!(await client.query(SUBLEDGER_BY_CODE_SQL, [code])).rows[0]) break;
    code = partyBookCode(input.type, input.partyCode || partyId, attempt);
    if (attempt === 100) {
      throw new ApiError(409, `Could not allocate a unique ledger book code for ${input.partyName}.`);
    }
  }

  const id = `gls-${crypto.randomUUID()}`;
  await client.query(SUBLEDGER_PARTY_BOOK_ENSURE_SQL, [
    id,
    code,
    String(input.partyName || '').trim().slice(0, 150) || code,
    input.type,
    control.id,
    partyId,
    `Party ledger created automatically from the ${input.type.toLowerCase()} master.`,
  ]);

  // ON CONFLICT DO NOTHING can lose a concurrent race; read back the winner.
  const saved = (await client.query(SUBLEDGER_BY_ACCOUNT_PARTY_SQL, [control.id, partyId])).rows[0];
  if (!saved) throw new ApiError(500, `The ledger book for ${input.partyName} could not be saved.`);
  const book = (await client.query(SUBLEDGER_BY_ID_SQL, [saved.id])).rows[0];
  return {
    book: assignment(control, book, id === saved.id),
    warning: null,
  };
}