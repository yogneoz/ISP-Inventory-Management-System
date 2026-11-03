/**
 * Server-side PDF documents.
 *
 * One service owns the PDF pipeline: the pdfmake instance, the Noto Sans /
 * Noto Sans Devanagari font registration, the shared company header, the
 * document-number/date block, the table and money formatting, and the document
 * builders used by the print routes.
 *
 * Fonts are not optional. They resolve through the packaged `@fontsource`
 * dependencies (`@fontsource/noto-sans`, `@fontsource/noto-sans-devanagari`)
 * so a clean install reproduces them, and `resolvePdfFonts` throws a named
 * error when a file is missing, empty or unreadable. There is deliberately no
 * fallback to pdfmake's Roboto: a report that silently renders Devanagari as
 * empty boxes is worse than a boot that says exactly which file is missing.
 *
 * Devanagari text is rendered with NotoSansDevanagari and Latin text with
 * NotoSans. `scriptRuns` splits a mixed string into those runs, so a customer
 * name or product description in either script keeps its glyphs inside a
 * table cell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfMakeModule from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { roundMoney } from '../utils/money';

export interface PdfFontFileSet {
  normal: string;
  bold: string;
}

export interface PdfFonts {
  NotoSans: PdfFontFileSet;
  NotoSansDevanagari: PdfFontFileSet;
}

export interface PdfCompany {
  name?: string | null;
  legalName?: string | null;
  tagline?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  panVatNumber?: string | null;
  registrationNumber?: string | null;
}

export interface PdfDocumentMeta {
  title: string;
  documentNumber?: string | null;
  dateAD?: string | null;
  dateBS?: string | null;
  branchName?: string | null;
  status?: string | null;
  rangeLabel?: string | null;
}

const DEFAULT_COMPANY_NAME = 'Inventory Management System';
const INK = '#0f172a';
const MUTED = '#64748b';
const BRAND = '#1e3a8a';
const LINE = '#cbd5e1';
const SOFT = '#f1f5f9';

const FONT_SPECS: ReadonlyArray<{
  key: keyof PdfFonts;
  packageName: string;
  label: string;
  normal: string;
  bold: string;
}> = [
  {
    key: 'NotoSans',
    packageName: '@fontsource/noto-sans',
    label: 'Noto Sans',
    normal: 'noto-sans-latin-400-normal.woff',
    bold: 'noto-sans-latin-700-normal.woff',
  },
  {
    key: 'NotoSansDevanagari',
    packageName: '@fontsource/noto-sans-devanagari',
    label: 'Noto Sans Devanagari',
    normal: 'noto-sans-devanagari-devanagari-400-normal.woff',
    bold: 'noto-sans-devanagari-devanagari-700-normal.woff',
  },
];

/** Resolve one packaged font file and refuse anything that is not a real file. */
function requireFontFile(
  resolve: (request: string) => string,
  packageName: string,
  file: string,
  label: string
): string {
  const request = `${packageName}/files/${file}`;
  let resolved: string;
  try {
    resolved = resolve(request);
  } catch {
    throw new Error(
      `PDF font missing: ${label} (${request}) is not installed. ` +
        'Install the packaged font dependency; PDF documents refuse to render without it.'
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`PDF font missing: ${label} resolves to ${resolved}, which does not exist.`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`PDF font invalid: ${label} at ${resolved} is not a readable font file.`);
  }
  return resolved;
}

/**
 * Resolve the four required font files. The resolver is injectable so the
 * missing-font refusal can be tested without deleting installed dependencies.
 */
export function resolvePdfFonts(
  resolve: (request: string) => string = createRequire(
    path.join(process.cwd(), 'package.json')
  ).resolve
): PdfFonts {
  const fonts = {} as PdfFonts;
  for (const spec of FONT_SPECS) {
    fonts[spec.key] = {
      normal: requireFontFile(resolve, spec.packageName, spec.normal, `${spec.label} normal`),
      bold: requireFontFile(resolve, spec.packageName, spec.bold, `${spec.label} bold`),
    };
  }
  return fonts;
}

/** The registered font files, resolved once at module load (server boot). */
export const PDF_FONTS: PdfFonts = resolvePdfFonts();

const pdfMake = ((pdfMakeModule as any).default ?? pdfMakeModule) as typeof pdfMakeModule;
pdfMake.setFonts(PDF_FONTS as any);
// These documents are text and tables only. Refuse every external URL and
// every local file except the four registered font files, so a malformed
// document cannot turn a print request into an SSRF probe or a local file read.
// pdfmake reads fonts through the same local-access policy, hence the allow-list.
const PDF_FONT_FILES = new Set(
  Object.values(PDF_FONTS).flatMap((font) => [path.resolve(font.normal), path.resolve(font.bold)])
);
(pdfMake as any).setUrlAccessPolicy(() => false);
(pdfMake as any).setLocalAccessPolicy((filePath: string) => PDF_FONT_FILES.has(path.resolve(filePath)));

const numberFormat = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `NPR 1,234.56` for summary totals. */
export function pdfMoney(value: unknown): string {
  return `NPR ${numberFormat.format(roundMoney(Number(value) || 0))}`;
}

/** `1,234.56` for dense statement/table columns. */
export function pdfAmount(value: unknown): string {
  return numberFormat.format(roundMoney(Number(value) || 0));
}

export function pdfQuantity(value: unknown): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(roundMoney(n));
}

export function hasDevanagari(value: unknown): boolean {
  return /[\u0900-\u097F]/.test(String(value ?? ''));
}

/**
 * Split text into Latin and Devanagari runs, each naming its font. Whitespace
 * stays with the surrounding Latin run; Devanagari words only switch fonts.
 */
export function scriptRuns(value: unknown): any[] {
  const text = String(value ?? '');
  if (!text) return [{ text: '', font: 'NotoSans' }];
  return (text.match(/[\u0900-\u097F]+|[^\u0900-\u097F]+/g) || [text]).map((part) => ({
    text: part,
    font: hasDevanagari(part) ? 'NotoSansDevanagari' : 'NotoSans',
  }));
}

/** A pdfmake text node that keeps both scripts in the same cell/paragraph. */
export function pdfText(value: unknown, extra: Record<string, any> = {}): Content {
  return { text: scriptRuns(value), ...extra } as unknown as Content;
}

function emptyText(extra: Record<string, any> = {}): TableCell {
  return { text: '—', color: MUTED, ...extra } as TableCell;
}

function headerCell(value: string, alignment: 'left' | 'right' | 'center' = 'left'): TableCell {
  return {
    text: value,
    bold: true,
    fontSize: 7.5,
    color: '#ffffff',
    fillColor: BRAND,
    alignment,
    margin: [0, 1, 0, 1],
  } as TableCell;
}

function amountCell(value: unknown, extra: Record<string, any> = {}): TableCell {
  return { text: pdfAmount(value), alignment: 'right', ...extra } as TableCell;
}

const tableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  paddingLeft: () => 4,
  paddingRight: () => 4,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

function sectionTitle(label: string): Content {
  return {
    text: label.toUpperCase(),
    bold: true,
    fontSize: 8,
    color: BRAND,
    margin: [0, 12, 0, 4],
    characterSpacing: 0.5,
  } as Content;
}

function companyAddress(company: PdfCompany): string {
  return [
    company.address,
    company.city,
    company.country,
    company.postalCode,
  ]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(', ');
}

function companyIdentity(company: PdfCompany): Content[] {
  const lines: Content[] = [
    pdfText(company.name || DEFAULT_COMPANY_NAME, { bold: true, fontSize: 17, color: INK }),
  ];
  if (company.legalName && company.legalName !== company.name) {
    lines.push(pdfText(company.legalName, { fontSize: 8, color: MUTED, margin: [0, 1, 0, 0] }));
  }
  if (company.tagline) {
    lines.push(pdfText(company.tagline, { fontSize: 8, color: MUTED }));
  }
  const address = companyAddress(company);
  if (address) lines.push(pdfText(address, { fontSize: 8, color: MUTED, margin: [0, 3, 0, 0] }));
  const contact = [company.phone, company.email, company.website]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' · ');
  if (contact) lines.push(pdfText(contact, { fontSize: 8, color: MUTED }));
  if (company.panVatNumber) {
    lines.push(pdfText(`PAN/VAT: ${company.panVatNumber}`, { fontSize: 8, color: MUTED }));
  }
  if (company.registrationNumber) {
    lines.push(pdfText(`Reg. No: ${company.registrationNumber}`, { fontSize: 8, color: MUTED }));
  }
  return lines;
}

function documentIdentity(meta: PdfDocumentMeta): Content[] {
  const right: Content[] = [
    { text: meta.title.toUpperCase(), bold: true, fontSize: 14, color: BRAND, alignment: 'right' },
  ];
  if (meta.documentNumber) {
    right.push({
      text: `No. ${meta.documentNumber}`,
      bold: true,
      fontSize: 10,
      alignment: 'right',
      margin: [0, 3, 0, 0],
    });
  }
  if (meta.rangeLabel) {
    right.push({ text: meta.rangeLabel, fontSize: 8, color: MUTED, alignment: 'right' });
  }
  if (meta.dateAD) {
    right.push({
      text: [
        { text: 'मिति: ', font: 'NotoSansDevanagari', bold: true },
        ...scriptRuns(meta.dateAD),
        ...(meta.dateBS ? [...scriptRuns(` (${meta.dateBS} BS)`)] : []),
      ],
      fontSize: 8,
      alignment: 'right',
      color: MUTED,
      margin: [0, 3, 0, 0],
    } as Content);
  }
  if (meta.branchName) {
    right.push(pdfText(`Branch: ${meta.branchName}`, { fontSize: 8, alignment: 'right', color: MUTED }));
  }
  if (meta.status) {
    right.push({
      text: meta.status.toUpperCase(),
      fontSize: 7,
      bold: true,
      alignment: 'right',
      color: meta.status.toUpperCase() === 'CANCELLED' ? '#b91c1c' : '#047857',
      margin: [0, 3, 0, 0],
    });
  }
  return right;
}

function pageHeader(company: PdfCompany, meta: PdfDocumentMeta): Content {
  return {
    columns: [
      { width: '*', stack: companyIdentity(company) },
      { width: 190, stack: documentIdentity(meta) },
    ],
    columnGap: 18,
    margin: [0, 0, 0, 8],
  };
}

function divider(): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: LINE }],
    margin: [0, 2, 0, 8],
  } as Content;
}

function documentDefinition(
  company: PdfCompany,
  meta: PdfDocumentMeta,
  content: Content[]
): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [40, 36, 40, 46],
    defaultStyle: { font: 'NotoSans', fontSize: 9, color: INK },
    info: {
      title: meta.documentNumber ? `${meta.title} ${meta.documentNumber}` : meta.title,
      author: company.name || DEFAULT_COMPANY_NAME,
      creator: 'Inventory Management System',
    },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 8, 40, 0],
      columns: [
        {
          width: '*',
          text: [
            { text: 'मिति: ', font: 'NotoSansDevanagari', bold: true },
            { text: meta.dateAD || new Date().toISOString().split('T')[0], font: 'NotoSans' },
          ],
          fontSize: 7,
          color: MUTED,
        },
        {
          width: '*',
          text: `${meta.title}${meta.documentNumber ? ` · ${meta.documentNumber}` : ''}`,
          alignment: 'center',
          fontSize: 7,
          color: MUTED,
        },
        {
          width: 'auto',
          text: `Page ${currentPage} of ${pageCount}`,
          alignment: 'right',
          fontSize: 7,
          color: MUTED,
        },
      ],
    }),
    content: [pageHeader(company, meta), divider(), ...content],
  };
}

function summaryTable(rows: Array<[string, string, boolean?]>): Content {
  return {
    table: {
      widths: ['*', 130],
      body: rows.map(([label, value, strong]) => [
        {
          text: label,
          alignment: 'right',
          bold: Boolean(strong),
          color: strong ? INK : MUTED,
          fontSize: strong ? 10 : 8.5,
          border: [false, false, false, strong],
        },
        {
          text: value,
          alignment: 'right',
          bold: Boolean(strong),
          fontSize: strong ? 10 : 8.5,
          color: strong ? INK : INK,
          border: [false, false, false, strong],
        },
      ]),
    },
    layout: {
      hLineWidth: (row: number) => (row === 0 ? 0 : 0.4),
      vLineWidth: () => 0,
      hLineColor: () => LINE,
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 2,
      paddingBottom: () => 2,
    },
    margin: [0, 8, 0, 0],
  } as Content;
}

function infoTable(rows: Array<[string, unknown]>): Content {
  return {
    table: {
      widths: [95, '*'],
      body: rows.map(([label, value]) => [
        { text: label, fontSize: 8, color: MUTED, bold: true },
        pdfText(value ?? '—', { fontSize: 8.5 }),
      ]),
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 6,
      paddingTop: () => 1,
      paddingBottom: () => 1,
    },
  } as Content;
}

function itemsOf(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lineNet(item: any): number {
  const gross = (Number(item?.quantity) || 0) * (Number(item?.unitPrice) || 0);
  return roundMoney(Math.max(0, gross - (Number(item?.discount) || 0)));
}

function invoiceItemRows(items: any[]): TableCell[][] {
  if (items.length === 0) {
    return [[{ text: 'No line items.', colSpan: 6, color: MUTED }, {}, {}, {}, {}, {}]];
  }
  return items.map((item, index) => {
    const description: Content[] = [pdfText(item?.productName || item?.name || 'Item', { bold: true })];
    const detail = [item?.sku, item?.unit].filter((part) => typeof part === 'string' && part.trim()).join(' · ');
    if (detail) description.push({ text: detail, fontSize: 7, color: MUTED });
    if (item?.deviceSerials?.length) {
      const serials = item.deviceSerials
        .map((entry: any) => (typeof entry === 'string' ? entry : entry?.deviceSerial))
        .filter(Boolean)
        .join(', ');
      if (serials) description.push({ text: `Serials: ${serials}`, fontSize: 6.5, color: MUTED });
    }
    return [
      { text: String(index + 1), alignment: 'center', color: MUTED, fontSize: 7.5 },
      { stack: description },
      { text: pdfQuantity(item?.quantity), alignment: 'right' },
      { text: pdfAmount(item?.unitPrice), alignment: 'right' },
      { text: pdfAmount(item?.discount), alignment: 'right' },
      { text: pdfAmount(lineNet(item)), alignment: 'right', bold: true },
    ];
  });
}

function invoiceItemsTable(items: any[]): Content {
  return {
    table: {
      headerRows: 1,
      widths: [20, '*', 42, 65, 55, 72],
      body: [
        [
          headerCell('#', 'center'),
          headerCell('Description'),
          headerCell('Qty', 'right'),
          headerCell('Rate', 'right'),
          headerCell('Discount', 'right'),
          headerCell('Amount', 'right'),
        ],
        ...invoiceItemRows(items),
      ],
    },
    layout: tableLayout,
  } as Content;
}

/**
 * Sales invoice / purchase bill. The line amounts are recomputed from the
 * stored line primitives, while the document totals are the stored aggregates
 * so the printed page agrees with the register and the ledger.
 */
export async function buildInvoicePdf(input: {
  kind: 'SALES_INVOICE' | 'PURCHASE_BILL';
  document: any;
  company: PdfCompany;
  branchName: string;
}): Promise<Buffer> {
  const { kind, document, company, branchName } = input;
  const isSale = kind === 'SALES_INVOICE';
  const items = itemsOf(document.items);
  const partyLabel = isSale ? 'Billed to' : 'Supplier';
  const partyName = isSale ? document.customerName : document.supplierName;
  const title = isSale ? 'Sales Invoice' : 'Purchase Bill';
  const number = document.invoiceNumber;
  const meta: PdfDocumentMeta = {
    title,
    documentNumber: number,
    dateAD: document.invoiceDateAD ? String(document.invoiceDateAD).slice(0, 10) : null,
    dateBS: document.invoiceDateBS || null,
    branchName,
    status: document.status || null,
  };

  const partyRows: Array<[string, unknown]> = [[partyLabel, partyName || '—']];
  if (isSale) {
    if (document.customerId) partyRows.push(['Customer ID', document.customerId]);
    if (document.dueDateAD) partyRows.push(['Due date', document.dueDateAD]);
    partyRows.push(['Payment', document.paymentMethod || '—']);
    partyRows.push(['Payment status', document.paymentStatus || '—']);
  } else {
    if (document.vendorBillNumber) partyRows.push(['Vendor bill', document.vendorBillNumber]);
    if (document.poReferenceId) partyRows.push(['PO reference', document.poReferenceId]);
    if (document.dueDateAD) partyRows.push(['Due date', document.dueDateAD]);
    partyRows.push(['Payment', document.paymentMethod || '—']);
    partyRows.push(['Payment status', document.paymentStatus || '—']);
  }

  const discount = roundMoney(
    items.reduce((sum, item) => sum + (Number(item?.discount) || 0), 0)
  );
  const totals: Array<[string, string, boolean?]> = [];
  if (discount > 0) totals.push(['Discount', pdfMoney(discount)]);
  totals.push(['Taxable amount', pdfMoney(document.taxableAmount)]);
  if (Number(document.nonTaxableAmount) > 0) {
    totals.push(['Non-taxable amount', pdfMoney(document.nonTaxableAmount)]);
  }
  totals.push(['VAT', pdfMoney(document.vatAmount)]);
  totals.push([isSale ? 'Invoice total' : 'Bill total', pdfMoney(document.grandTotal), true]);
  if (Number(document.amountPaid) > 0) {
    totals.push(['Paid', pdfMoney(document.amountPaid)]);
    totals.push([
      'Balance due',
      pdfMoney(roundMoney(Number(document.grandTotal) - Number(document.amountPaid))),
      true,
    ]);
  }

  const content: Content[] = [
    {
      columns: [
        { width: '*', stack: [sectionTitle(partyLabel), infoTable(partyRows)] },
        {
          width: 240,
          stack: [
            sectionTitle('Document'),
            infoTable([
              ['Number', number],
              ['Date', document.invoiceDateAD],
              ...(document.dueDateAD ? [['Due', document.dueDateAD] as [string, unknown]] : []),
              ['Branch', branchName],
              ['Status', document.status || 'POSTED'],
            ]),
          ],
        },
      ],
      columnGap: 24,
    },
    sectionTitle('Items'),
    invoiceItemsTable(items),
    {
      columns: [
        { width: '*', stack: [] },
        { width: 250, stack: [summaryTable(totals)] },
      ],
    },
  ];

  if (document.notes) {
    content.push(sectionTitle('Notes'), pdfText(document.notes, { fontSize: 8, color: MUTED }));
  }
  content.push({
    columns: [
      { width: '*', text: '', margin: [0, 26, 0, 0] },
      { width: 180, stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.6, lineColor: LINE }] },
        { text: 'Authorised signature', fontSize: 7, color: MUTED, alignment: 'center', margin: [0, 3, 0, 0] },
      ] },
    ],
  });

  return renderPdf(documentDefinition(company, meta, content));
}

/** Payroll payslip for one employee's line in a posted run. */
export async function buildPayslipPdf(input: {
  run: any;
  line: any;
  employee?: any;
  company: PdfCompany;
  branchName: string;
}): Promise<Buffer> {
  const { run, line, employee, company, branchName } = input;
  const title = 'Payslip';
  const meta: PdfDocumentMeta = {
    title,
    documentNumber: `${run.runNo}/${line.employeeCode}`,
    dateAD: run.runDateAD ? String(run.runDateAD).slice(0, 10) : null,
    branchName,
    status: run.status,
  };
  const employeeRows: Array<[string, unknown]> = [
    ['Employee', line.employeeName || employee?.name || '—'],
    ['Code', line.employeeCode],
    ['Department', employee?.department || '—'],
    ['Designation', employee?.designation || '—'],
    ['PAN', employee?.panNumber || '—'],
    ['SSF', employee?.ssfNumber || '—'],
    ['Bank account', employee?.bankAccount || '—'],
  ];
  const earningsRows: Array<[string, string, boolean?]> = [
    ['Gross salary', pdfMoney(line.gross)],
    ['TDS', `(${pdfMoney(line.tds)})`],
    ['SSF', `(${pdfMoney(line.ssf)})`],
    ['Advance recovery', `(${pdfMoney(line.advance)})`],
    ['Loan recovery', `(${pdfMoney(line.loan)})`],
    ['Net pay', pdfMoney(line.net), true],
  ];
  const content: Content[] = [
    {
      columns: [
        { width: '*', stack: [sectionTitle('Employee'), infoTable(employeeRows)] },
        {
          width: 230,
          stack: [
            sectionTitle('Payroll'),
            infoTable([
              ['Run', run.runNo],
              ['Period', run.periodKey],
              ['Run date', run.runDateAD],
              ['Branch', branchName],
              ['Status', run.status],
              ...(run.paidDateAD ? [['Paid', run.paidDateAD] as [string, unknown]] : []),
              ...(run.paymentMethod ? [['Method', run.paymentMethod] as [string, unknown]] : []),
            ]),
          ],
        },
      ],
      columnGap: 24,
    },
    sectionTitle('Earnings and deductions'),
    {
      table: {
        headerRows: 1,
        widths: ['*', 150],
        body: [
          [headerCell('Component'), headerCell('Amount', 'right')],
          ...earningsRows.map(([label, value, strong]): TableCell[] => [
            { text: label, bold: Boolean(strong) },
            { text: value, alignment: 'right', bold: Boolean(strong) },
          ]),
        ],
      },
      layout: tableLayout,
    },
    {
      text: 'Net pay is the posted run-line amount; TDS and SSF are the deductions recorded in the payroll journal.',
      fontSize: 7.5,
      color: MUTED,
      margin: [0, 10, 0, 0],
    },
  ];
  return renderPdf(documentDefinition(company, meta, content));
}

/**
 * Statement section table for the printable profit and loss / balance sheet.
 * Groups recurse, and every group row carries its own subtotal — the same
 * figures the JSON endpoint returns — so a printed statement cannot flatten
 * away the chart hierarchy. Exported for the PDF content test.
 */
export function statementSectionsContent(sections: any[]): Content {
  const body: TableCell[][] = [];
  const addGroup = (group: any, depth: number) => {
    body.push([
      pdfText(`${'  '.repeat(depth)}${group.groupCode} · ${group.groupName}`, {
        bold: true,
        fontSize: 7.5,
        color: MUTED,
      }),
      { text: '', fontSize: 7 },
      { text: pdfAmount(group.amount), alignment: 'right', bold: true, fontSize: 7.5 },
    ]);
    for (const account of group.accounts || []) {
      body.push([
        pdfText(`${'  '.repeat(depth + 1)}${account.code}  ${account.name}`, { fontSize: 7.5 }),
        pdfText(account.groupName, { fontSize: 7, color: MUTED }),
        { text: pdfAmount(account.amount), alignment: 'right', fontSize: 7.5 },
      ]);
    }
    for (const child of group.children || []) addGroup(child, depth + 1);
  };

  for (const section of sections) {
    body.push([
      { text: section.label, bold: true, fillColor: SOFT, fontSize: 8, colSpan: 3 },
      {},
      {},
    ]);
    for (const group of section.groups || []) addGroup(group, 0);
    body.push([
      { text: `Total ${section.label}`, bold: true, alignment: 'right', colSpan: 2, fontSize: 8 },
      {},
      { text: pdfAmount(section.amount), bold: true, alignment: 'right', fontSize: 8 },
    ]);
  }
  if (body.length === 0) {
    return { text: 'No posted balances in this statement.', fontSize: 8, color: MUTED } as Content;
  }
  return {
    table: { widths: ['*', 140, 85], body },
    layout: tableLayout,
  } as Content;
}

/**
 * Trial balance, profit and loss, and balance sheet. The service consumes the
 * statement objects built from posted journal lines, so the printed figures are
 * the same values the JSON endpoint returns.
 */
export async function buildStatementPdf(input: {
  kind: 'TRIAL_BALANCE' | 'PROFIT_AND_LOSS' | 'BALANCE_SHEET';
  statement: any;
  company: PdfCompany;
  branchName: string;
}): Promise<Buffer> {
  const { kind, statement, company, branchName } = input;
  const isTrial = kind === 'TRIAL_BALANCE';
  const isBalanceSheet = kind === 'BALANCE_SHEET';
  const title = isTrial ? 'Trial Balance' : isBalanceSheet ? 'Balance Sheet' : 'Profit and Loss';
  const dateAD = isTrial
    ? statement.to
    : isBalanceSheet
      ? statement.asOf
      : statement.to;
  const meta: PdfDocumentMeta = {
    title,
    documentNumber: `${isTrial ? 'TB' : isBalanceSheet ? 'BS' : 'PL'}-${dateAD}`,
    dateAD,
    branchName,
    rangeLabel: isBalanceSheet
      ? `As of ${statement.asOf}`
      : `${statement.from || 'Inception'} → ${statement.to}`,
  };

  const content: Content[] = [];
  if (isTrial) {
    const accounts = statement.accounts || [];
    const amountCells = (row: any, bold = false): TableCell[] => [
      { text: pdfAmount(row.openingDebit), alignment: 'right', fontSize: 7, bold },
      { text: pdfAmount(row.openingCredit), alignment: 'right', fontSize: 7, bold },
      { text: pdfAmount(row.periodDebit), alignment: 'right', fontSize: 7, bold },
      { text: pdfAmount(row.periodCredit), alignment: 'right', fontSize: 7, bold },
      { text: pdfAmount(row.closingDebit), alignment: 'right', fontSize: 7, bold },
      { text: pdfAmount(row.closingCredit), alignment: 'right', fontSize: 7, bold },
    ];
    const accountRow = (account: any, depth: number): TableCell[] => [
      pdfText(`${'  '.repeat(depth)}${account.code}  ${account.name}`, { fontSize: 7 }),
      pdfText(account.groupName, { fontSize: 6.5, color: MUTED }),
      ...amountCells(account),
    ];
    const hierarchyBody: TableCell[][] = [];
    const addGroup = (group: any, depth: number) => {
      hierarchyBody.push([
        {
          text: `${'  '.repeat(depth)}${group.code} · ${group.name}`,
          bold: true,
          colSpan: 2,
          fontSize: 7,
        },
        {},
        ...amountCells(group, true),
      ]);
      for (const account of group.accounts || []) hierarchyBody.push(accountRow(account, depth + 1));
      for (const child of group.children || []) addGroup(child, depth + 1);
    };
    for (const group of statement.groups || []) addGroup(group, 0);

    const body: TableCell[][] = hierarchyBody.length
      ? hierarchyBody
      : accounts.length
        ? accounts.map((account: any) => accountRow(account, 0))
        : [[{ text: 'No posted balances in this window.', colSpan: 8, color: MUTED }, {}, {}, {}, {}, {}, {}, {}]];
    body.push([
      { text: 'Totals', bold: true, alignment: 'right', colSpan: 2 },
      {},
      { text: pdfAmount(statement.totals.openingDebit), bold: true, alignment: 'right', fontSize: 7 },
      { text: pdfAmount(statement.totals.openingCredit), bold: true, alignment: 'right', fontSize: 7 },
      { text: pdfAmount(statement.totals.periodDebit), bold: true, alignment: 'right', fontSize: 7 },
      { text: pdfAmount(statement.totals.periodCredit), bold: true, alignment: 'right', fontSize: 7 },
      { text: pdfAmount(statement.totals.closingDebit), bold: true, alignment: 'right', fontSize: 7 },
      { text: pdfAmount(statement.totals.closingCredit), bold: true, alignment: 'right', fontSize: 7 },
    ]);
    content.push(
      sectionTitle('Accounts'),
      {
        table: {
          headerRows: 1,
          widths: ['*', 78, 45, 45, 45, 45, 45, 45],
          body: [
            [
              headerCell('Account'),
              headerCell('Group'),
              headerCell('Opening Dr', 'right'),
              headerCell('Opening Cr', 'right'),
              headerCell('Period Dr', 'right'),
              headerCell('Period Cr', 'right'),
              headerCell('Closing Dr', 'right'),
              headerCell('Closing Cr', 'right'),
            ],
            ...body,
          ],
        },
        layout: tableLayout,
        fontSize: 7,
      } as Content,
      {
        text: statement.balanced ? 'Debits equal credits in every column.' : 'THE TRIAL BALANCE DOES NOT BALANCE.',
        bold: !statement.balanced,
        color: statement.balanced ? '#047857' : '#b91c1c',
        fontSize: 8,
        margin: [0, 8, 0, 0],
      },
      sectionTitle('Control account agreement'),
      {
        table: {
          headerRows: 1,
          widths: ['*', 80, 80, 70, 65],
          body: [
            [
              headerCell('Control account'),
              headerCell('GL balance', 'right'),
              headerCell('Subledger', 'right'),
              headerCell('Difference', 'right'),
              headerCell('Status', 'center'),
            ],
            ...(statement.controls || []).map((control: any) => [
              pdfText(`${control.code}  ${control.name}`, { fontSize: 7.5 }),
              { text: pdfAmount(control.glBalance), alignment: 'right', fontSize: 7.5 },
              { text: pdfAmount(control.subledgerBalance), alignment: 'right', fontSize: 7.5 },
              { text: pdfAmount(control.difference), alignment: 'right', fontSize: 7.5 },
              { text: control.status, alignment: 'center', fontSize: 7, color: control.status === 'RECONCILED' ? '#047857' : '#b91c1c' },
            ]),
          ],
        },
        layout: tableLayout,
      } as Content
    );
  } else if (isBalanceSheet) {
    content.push(
      sectionTitle('Assets'),
      statementSectionsContent(statement.assets?.sections || []),
      { text: `Total assets: ${pdfMoney(statement.totalAssets)}`, bold: true, alignment: 'right', margin: [0, 6, 0, 0] },
      sectionTitle('Liabilities'),
      statementSectionsContent(statement.liabilities?.sections || []),
      { text: `Total liabilities: ${pdfMoney(statement.totalLiabilities)}`, bold: true, alignment: 'right', margin: [0, 6, 0, 0] },
      sectionTitle('Equity'),
      statementSectionsContent(statement.equity?.sections || []),
      {
        table: { widths: ['*', 130], body: [
          [{ text: 'Current earnings', alignment: 'right', color: MUTED }, { text: pdfMoney(statement.equity?.currentEarnings), alignment: 'right' }],
          [{ text: 'Total equity', alignment: 'right', bold: true }, { text: pdfMoney(statement.totalEquity), alignment: 'right', bold: true }],
        ] },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
        margin: [0, 4, 0, 0],
      } as Content,
      sectionTitle('Position'),
      summaryTable([
        ['Cash and bank', pdfMoney(statement.cashAndBank)],
        ['Total assets', pdfMoney(statement.totalAssets)],
        ['Total liabilities and equity', pdfMoney(statement.totalLiabilitiesAndEquity)],
        ['Difference', pdfMoney(statement.difference), true],
      ]),
      {
        text: statement.balanced ? 'Assets equal liabilities plus equity.' : 'THE BALANCE SHEET DOES NOT BALANCE.',
        bold: !statement.balanced,
        color: statement.balanced ? '#047857' : '#b91c1c',
        fontSize: 8,
        margin: [0, 8, 0, 0],
      }
    );
  } else {
    content.push(
      sectionTitle('Statement of profit or loss'),
      statementSectionsContent(statement.sections || []),
      sectionTitle('Summary'),
      summaryTable([
        ['Revenue', pdfMoney(statement.revenue)],
        ['Other income', pdfMoney(statement.otherIncome)],
        ['Total income', pdfMoney(statement.totalIncome)],
        ['Cost of sales', pdfMoney(statement.costOfSales)],
        ['Gross profit', pdfMoney(statement.grossProfit)],
        ['Operating expenses', pdfMoney(statement.operatingExpense)],
        ['Other expenses', pdfMoney(statement.otherExpense)],
        ['Net profit', pdfMoney(statement.netProfit), true],
      ])
    );
  }
  return renderPdf(documentDefinition(company, meta, content));
}

/** Render a document definition and refuse a non-PDF result. */
export async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  const buffer = await pdfMake.createPdf(definition).getBuffer();
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    throw new Error('PDF renderer produced no output.');
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('PDF renderer produced a non-PDF buffer.');
  }
  return buffer;
}
