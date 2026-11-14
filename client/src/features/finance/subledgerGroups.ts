import type { AccountingSubledger } from '../../services/api/accounting';

/** Stable bucket for a book whose server payload omits its subledger type. */
export const UNSPECIFIED_SUBLEDGER_GROUP = 'UNSPECIFIED';

const GROUP_ORDER = [
  'CUSTOMER',
  'SUPPLIER',
  'EMPLOYEE',
  'INVENTORY',
  'FIXED_ASSET',
  'BANK',
  'CASH',
  'WALLET',
  'TAX',
  'INTER_BRANCH',
  UNSPECIFIED_SUBLEDGER_GROUP,
];

export interface SubledgerGroup {
  key: string;
  label: string;
  books: AccountingSubledger[];
  bookCount: number;
  /** Sum of posted rows, or null when any book omitted the field. */
  entryCount: number | null;
  /** Sum of branch book balances, or null when any book omitted the field. */
  bookBalance: number | null;
}

const finiteNumber = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const groupKey = (book: AccountingSubledger): string => {
  const type = typeof book.subledgerType === 'string' ? book.subledgerType.trim().toUpperCase() : '';
  return type || UNSPECIFIED_SUBLEDGER_GROUP;
};

const groupRank = (key: string): number => {
  const index = GROUP_ORDER.indexOf(key);
  return index === -1 ? GROUP_ORDER.length : index;
};

const sumOrNull = (
  books: AccountingSubledger[],
  read: (book: AccountingSubledger) => unknown
): number | null => {
  let total = 0;
  for (const book of books) {
    const value = finiteNumber(read(book));
    if (value === null) return null;
    total += value;
  }
  return total;
};

/**
 * Group books by the type the server reports, keeping a stable order and an
 * explicit Unspecified bucket. Sorting here means a refresh cannot reshuffle
 * rows under the operator, which also keeps a collapsed group identifiable.
 */
export function buildSubledgerGroups(books: AccountingSubledger[]): SubledgerGroup[] {
  const grouped = new Map<string, AccountingSubledger[]>();
  for (const book of books) {
    const key = groupKey(book);
    const list = grouped.get(key);
    if (list) list.push(book);
    else grouped.set(key, [book]);
  }
  return [...grouped.entries()]
    .map(([key, groupBooks]) => {
      const sorted = [...groupBooks].sort(
        (left, right) =>
          left.code.localeCompare(right.code) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id)
      );
      return {
        key,
        label: key,
        books: sorted,
        bookCount: sorted.length,
        entryCount: sumOrNull(sorted, (book) => book.entryCount),
        bookBalance: sumOrNull(sorted, (book) => book.bookBalance),
      };
    })
    .sort(
      (left, right) =>
        groupRank(left.key) - groupRank(right.key) || left.key.localeCompare(right.key)
    );
}
