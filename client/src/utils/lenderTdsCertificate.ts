import type { CompanyProfile } from '../types';
import type { LenderStatement } from '../services/api/lenders';
import { formatNPR } from './nprFormat';
import { getCompanyAddress } from './companyProfile';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dateRangeLabel(from: string | null, to: string | null): string {
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return 'All posted repayments';
}

/** Drop repeated comma-separated address parts (city already inside address). */
function compactAddress(value: string): string {
  const seen = new Set<string>();
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || seen.has(part.toLowerCase())) return false;
      seen.add(part.toLowerCase());
      return true;
    })
    .join(', ');
}

/**
 * A standalone withholding certificate for the posted TDS-bearing repayments
 * in a lender statement. Built as escaped HTML so the browser's print dialog
 * owns the PDF and no certificate data is rendered through raw markup.
 */
export function buildLenderTdsCertificateHtml(
  statement: LenderStatement,
  companyProfile?: CompanyProfile | null
): string {
  const withheld = statement.tdsEntries.filter((row) => row.tdsStatus === 'WITHHELD');
  const companyName =
    companyProfile?.legalName || companyProfile?.name || 'Inventory Management System';
  const companyAddress = compactAddress(getCompanyAddress(companyProfile));
  const companyContact = [
    companyProfile?.phone ? `Tel: ${companyProfile.phone}` : '',
    companyProfile?.email || '',
  ]
    .filter(Boolean)
    .join(' | ');
  const lender = statement.lender;
  const certificateNumber = `TDS/${lender.code}/${statement.from || 'START'}/${
    statement.to || 'END'
  }`;
  const rows = withheld
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.dateAD)}</td>
        <td>${escapeHtml(row.loanNumber)}</td>
        <td>${escapeHtml(row.txnNumber)}</td>
        <td>${escapeHtml(row.journalNo)}</td>
        <td class="num">${escapeHtml(formatNPR(row.interestAmount))}</td>
        <td class="num strong">${escapeHtml(formatNPR(row.tdsAmount))}</td>
        <td class="num">${escapeHtml(formatNPR(row.cashAmount))}</td>
      </tr>`
    )
    .join('');
  const exemptReasons = Array.from(
    new Set(
      statement.tdsEntries
        .filter((row) => row.tdsStatus === 'EXEMPT' && row.exemptionReason)
        .map((row) => row.exemptionReason as string)
    )
  );
  const totals = statement.tdsTotals;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>TDS Withholding Certificate — ${escapeHtml(lender.code)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; font: 11px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .doc { max-width: 190mm; margin: 0 auto; }
  .company { border-bottom: 2px solid #1f2937; padding-bottom: 8px; text-align: center; }
  .company h2 { margin: 0; font: 700 20px/1.2 Georgia, serif; letter-spacing: .2px; }
  .company p { margin: 3px 0 0; color: #4b5563; font-size: 10px; }
  h1 { margin: 14px 0 2px; text-align: center; font: 700 16px/1.25 Georgia, serif; letter-spacing: 1px; }
  .cert-no { text-align: center; color: #4b5563; font-size: 10px; margin-bottom: 14px; }
  .meta { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 12px; }
  .meta div { width: 50%; }
  .label { color: #6b7280; font-size: 9px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
  .value { margin-top: 2px; font-weight: 600; }
  .body-copy { margin: 10px 0 12px; text-align: justify; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: top; }
  th { background: #f3f4f6; font-size: 9px; letter-spacing: .3px; text-transform: uppercase; text-align: left; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.strong { font-weight: 700; }
  tfoot td { background: #f9fafb; font-weight: 700; }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
  .summary div { border: 1px solid #e5e7eb; padding: 7px 8px; }
  .summary .value { font-size: 12px; }
  .note { margin-top: 10px; color: #4b5563; font-size: 9.5px; }
  .sign { display: flex; justify-content: space-between; gap: 24px; margin-top: 20px; }
  .sign div { width: 45%; border-top: 1px solid #9ca3af; padding-top: 5px; color: #4b5563; font-size: 9px; }
  .no-print { margin: 18px 0 0; text-align: center; }
  .no-print button { padding: 8px 14px; border: 1px solid #4f46e5; border-radius: 6px; background: #4f46e5; color: white; font-weight: 700; cursor: pointer; }
  @media print {
    .no-print { display: none; }
    thead { display: table-header-group; }
    tfoot { display: table-row-group; }
    tr, .summary, .note, .sign { break-inside: avoid; }
    .sign { break-before: avoid; }
    .company, .cert-no, .meta { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="doc">
  <div class="company">
    <h2>${escapeHtml(companyName)}</h2>
    ${companyAddress ? `<p>${escapeHtml(companyAddress)}</p>` : ''}
    ${companyContact ? `<p>${escapeHtml(companyContact)}</p>` : ''}
    ${
      companyProfile?.panVatNumber
        ? `<p>PAN / VAT No: ${escapeHtml(companyProfile.panVatNumber)}${
            companyProfile.registrationNumber
              ? ` | Reg No: ${escapeHtml(companyProfile.registrationNumber)}`
              : ''
          }</p>`
        : ''
    }
  </div>

  <h1>TDS WITHHOLDING CERTIFICATE</h1>
  <div class="cert-no">Certificate ${escapeHtml(certificateNumber)} · ${escapeHtml(
    dateRangeLabel(statement.from, statement.to)
  )}</div>

  <div class="meta">
    <div>
      <div class="label">Deductee / lender</div>
      <div class="value">${escapeHtml(lender.name)} (${escapeHtml(lender.code)})</div>
      <div>${escapeHtml(lender.address || '')}</div>
      ${lender.panNumber ? `<div>PAN: ${escapeHtml(lender.panNumber)}</div>` : '<div>PAN: not recorded</div>'}
    </div>
    <div>
      <div class="label">Branch scope</div>
      <div class="value">${escapeHtml(statement.branchId)}</div>
      <div class="label" style="margin-top:8px">Loan payable control</div>
      <div>${escapeHtml(statement.control?.accountCode || '—')} · ${escapeHtml(
        statement.control?.accountName || 'Not configured'
      )}</div>
    </div>
  </div>

  <p class="body-copy">
    We certify that tax at source was deducted from interest paid or credited to the lender named
    above on the borrowings listed below. This certificate covers only posted repayments in the
    stated period and reconciles to the lender repayment ledger.
  </p>

  <table>
    <thead>
      <tr>
        <th>Date (AD)</th>
        <th>Loan</th>
        <th>Repayment</th>
        <th>Journal</th>
        <th class="num">Interest</th>
        <th class="num">TDS withheld</th>
        <th class="num">Net cash</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="7">No TDS-bearing repayments in this period.</td></tr>'}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Total withheld on ${withheld.length} repayment${withheld.length === 1 ? '' : 's'}</td>
        <td class="num">${escapeHtml(formatNPR(totals.withheldInterest))}</td>
        <td class="num">${escapeHtml(formatNPR(totals.withheldTax))}</td>
        <td class="num">${escapeHtml(
          formatNPR(
            withheld.reduce((sum, row) => sum + row.cashAmount, 0)
          )
        )}</td>
      </tr>
    </tfoot>
  </table>

  <div class="summary">
    <div><div class="label">Interest with TDS</div><div class="value">${escapeHtml(
      formatNPR(totals.withheldInterest)
    )}</div></div>
    <div><div class="label">Tax withheld</div><div class="value">${escapeHtml(
      formatNPR(totals.withheldTax)
    )}</div></div>
    <div><div class="label">Interest without withholding</div><div class="value">${escapeHtml(
      formatNPR(totals.exemptInterest)
    )}</div></div>
  </div>

  <p class="note">
    Zero-TDS interest of ${escapeHtml(formatNPR(totals.exemptInterest))} is reported separately in
    the TDS register${exemptReasons.length ? ` (${escapeHtml(exemptReasons.join(', '))})` : ''};
    interest-free principal of ${escapeHtml(formatNPR(totals.noInterestPrincipal))} carries no TDS.
    Register reconciliation: ${totals.reconciled ? 'RECONCILED' : 'DIFFERENCE'}.
  </p>

  <div class="sign">
    <div>Place / date</div>
    <div>Authorised signatory</div>
  </div>

  <div class="no-print">
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
</div>
<script>
  window.addEventListener('load', function () {
    window.setTimeout(function () { window.print(); }, 150);
  });
</script>
</body>
</html>`;
}

/** Opens the certificate in a dedicated document window and starts printing. */
export function printLenderTdsCertificate(
  statement: LenderStatement,
  companyProfile?: CompanyProfile | null
): boolean {
  const printWindow = window.open('', '_blank', 'width=980,height=760');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(buildLenderTdsCertificateHtml(statement, companyProfile));
  printWindow.document.close();
  printWindow.focus();
  return true;
}
