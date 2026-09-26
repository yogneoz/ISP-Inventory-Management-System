/**
 * Excel helpers (backlog #3): exceljs-based replacement for the vulnerable
 * xlsx 0.18.5 package (Prototype Pollution + ReDoS advisories, no fixed
 * version). The only consumer was the BS calendar utility, which needs:
 *   - read first sheet of an uploaded .xlsx as an array of row objects
 *   - write a one-sheet template workbook for download
 *
 * exceljs reads workbooks asynchronously and types cells (a numeric cell is
 * a JS number, not a numeric string), so readFirstSheetRows normalizes every
 * cell to string form matching what xlsx's sheet_to_json(defval:'')
 * produced — including the ".split('.')[0]" integer-extraction trick the old
 * parser used on '2086.0'-style values. Consumers therefore parse identically.
 */
import ExcelJS from 'exceljs';

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    // Rich text / formula / hyperlink / date cells → their text form.
    if ('richText' in value && Array.isArray((value as any).richText)) {
      return (value as any).richText.map((rt: any) => String(rt.text ?? '')).join('');
    }
    if ('text' in value) return String((value as any).text ?? '');
    if ('result' in value) return cellToString((value as any).result);
    if ('hyperlink' in value) return String((value as any).hyperlink ?? '');
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (typeof value === 'number') {
    // Full precision, no scientific notation: 2086 → '2086' (not '2086.0'
    // and not '2.086e3'), keeping the old .split('.')[0] parsing intact.
    return String(value);
  }
  return String(value);
}

/**
 * Read the FIRST sheet of a workbook as an array of row objects keyed by the
 * header-row cell values. Empty cells become '' (like xlsx's defval:'');
 * every value is coerced to string with numbers in full precision.
 */
export async function readFirstSheetRows(data: ArrayBuffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  // Header row (row 1) supplies the object keys.
  const headerRow = sheet.getRow(1);
  const keys: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    keys[colNumber] = cellToString(cell.value);
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const obj: Record<string, string> = {};
    let hasValue = false;
    for (let c = 1; c < keys.length; c++) {
      const key = keys[c] ?? '';
      const cell = row.getCell(c);
      const str = cellToString(cell.value);
      obj[key] = str;
      if (str !== '') hasValue = true;
    }
    // Skip fully empty rows (xlsx's sheet_to_json also drops them).
    if (hasValue) rows.push(obj);
  });
  return rows;
}

/**
 * Build a one-sheet workbook from an array-of-arrays (header row first) and
 * return the .xlsx bytes for browser download.
 */
export async function buildTemplateWorkbook(
  sheetName: string,
  rows: (string | number)[][]
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}
