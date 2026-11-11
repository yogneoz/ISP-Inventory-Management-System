import { bsLabel } from './verificationDataset';

export type Row = Record<string, any>;

/** Insert fixed-id fixture rows without ever duplicating an existing row. */
export async function insertRows(
  client: any,
  table: string,
  columns: string[],
  rows: Row[]
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  for (const row of rows) {
    await client.query(sql, columns.map((column) => row[column] ?? null));
  }
}

/** AD date -> the stored BS label the rest of the app expects. */
export function bsOn(adDate: string): string {
  const label = bsLabel(adDate);
  if (!label) throw new Error(`BS calendar has no label for ${adDate}`);
  return label;
}
