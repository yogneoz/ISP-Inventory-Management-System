/**
 * Employee master-sheet CSV import.
 *
 * The manager chooses the sheet, optionally maps branch/work-station labels,
 * runs a dry run, reads the per-row reasons, then commits the same validated
 * rows. The dry run is read-only on the server; the dialog never claims a row
 * was written until the COMMIT response says so.
 */
import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, UploadCloud, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { api } from '../../services/api';
import type { EmployeeImportResult } from '../../services/api';

interface EmployeeImportDialogProps {
  onClose: () => void;
  onImported: () => void | Promise<void>;
}

const MAX_CSV_BYTES = 512 * 1024;

/** Parses "sheet label = system value" lines into the server's map shape. */
function parseMapping(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) map[key] = value;
  }
  return map;
}

const actionClass = (action: string): string => {
  if (action === 'CREATE') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (action === 'UPDATE') {
    return 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300';
  }
  return 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300';
};

export const EmployeeImportDialog: React.FC<EmployeeImportDialogProps> = ({
  onClose,
  onImported,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [branchMapText, setBranchMapText] = useState('');
  const [workStationMapText, setWorkStationMapText] = useState('');
  const [preview, setPreview] = useState<EmployeeImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [fileKey, setFileKey] = useState(0);

  const maps = () => ({
    branchMap: parseMapping(branchMapText),
    workStationMap: parseMapping(workStationMapText),
  });

  const resetPreview = () => {
    setPreview(null);
    setError('');
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      alertDialog('The CSV exceeds 512 KB. Split the sheet and import it in parts.');
      return;
    }
    try {
      const content = await file.text();
      setCsv(content);
      setFileName(file.name);
      resetPreview();
    } catch (err: any) {
      alertDialog(`Could not read the CSV: ${err?.message || 'file read error'}`);
    }
  };

  const runPreview = async () => {
    if (!csv.trim()) {
      alertDialog('Choose a master-sheet CSV first.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api.importEmployees({ mode: 'DRY_RUN', csv, ...maps() });
      setPreview(result);
    } catch (err: any) {
      setError(err?.message || 'The dry run failed.');
    } finally {
      setLoading(false);
    }
  };

  const runCommit = async () => {
    if (!preview || preview.mode === 'COMMIT') return;
    if (preview.validRows === 0) {
      alertDialog('There are no valid rows to import. Fix the reported errors first.');
      return;
    }
    if (
      !(await confirmDialog(
        `Import ${preview.validRows} employee row(s)? ${preview.skipped} row(s) will be skipped.`
      ))
    ) {
      return;
    }
    setCommitting(true);
    setError('');
    try {
      const result = await api.importEmployees({ mode: 'COMMIT', csv, ...maps() });
      setPreview(result);
      setFileKey((key) => key + 1);
      setCsv('');
      setFileName('');
      await onImported();
    } catch (err: any) {
      setError(err?.message || 'The import failed; no rows were committed.');
    } finally {
      setCommitting(false);
    }
  };

  const card = (label: string, value: number, tone: string) => (
    <div className={`rounded-xl border px-3 py-2 ${tone}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="mt-0.5 text-lg font-bold">{value}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label="Import employee master sheet"
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-bold">
              <UploadCloud className="h-4 w-4 text-indigo-500" />
              Import employee master sheet
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              CSV with HRMS ID, Full Name and Branch. A dry run validates every row without
              writing; commit applies only the valid rows.
            </p>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Master-sheet CSV (max 512 KB, 1,000 rows)
            </label>
            <input
              key={fileKey}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="block w-full cursor-pointer text-xs text-slate-600 file:mr-2 file:cursor-pointer file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
            />
            {fileName ? (
              <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                <FileSpreadsheet className="h-3 w-3" />
                {fileName}
              </p>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Branch mapping (optional)
            </label>
            <textarea
              rows={3}
              value={branchMapText}
              onChange={(event) => {
                setBranchMapText(event.target.value);
                resetPreview();
              }}
              placeholder={'Sheet branch = Branch name or code\nKathmandu HO = HO-KTM'}
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-[11px] dark:border-slate-700"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Work-station mapping (optional)
            </label>
            <textarea
              rows={3}
              value={workStationMapText}
              onChange={(event) => {
                setWorkStationMapText(event.target.value);
                resetPreview();
              }}
              placeholder={'Sheet station = Org Master name or code\nKTM = Kathmandu Station'}
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-[11px] dark:border-slate-700"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={runPreview}
            disabled={loading || committing}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {loading ? 'Validating…' : 'Run dry run'}
          </button>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Nothing is written until you confirm the commit.
          </span>
        </div>

        {error ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {preview ? (
          <section className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              {preview.mode === 'COMMIT' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  Import committed
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  Dry-run preview — nothing written
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {card('Total rows', preview.totalRows, 'border-slate-200 dark:border-slate-800')}
              {card(
                preview.mode === 'COMMIT' ? 'Created' : 'Would create',
                preview.created,
                'border-emerald-200 bg-emerald-50/60 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300'
              )}
              {card(
                preview.mode === 'COMMIT' ? 'Updated' : 'Would update',
                preview.updated,
                'border-indigo-200 bg-indigo-50/60 text-indigo-800 dark:border-indigo-900/40 dark:bg-indigo-950/20 dark:text-indigo-300'
              )}
              {card(
                'Skipped',
                preview.skipped,
                'border-rose-200 bg-rose-50/60 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300'
              )}
            </div>

            <div className="max-h-72 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                  <tr>
                    <th className="px-2.5 py-1.5">Row</th>
                    <th className="px-2.5 py-1.5">HRMS ID</th>
                    <th className="px-2.5 py-1.5">Name</th>
                    <th className="px-2.5 py-1.5">Action</th>
                    <th className="px-2.5 py-1.5">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber} className="align-top">
                      <td className="px-2.5 py-1.5 font-mono text-slate-500">{row.rowNumber}</td>
                      <td className="px-2.5 py-1.5 font-mono font-semibold">
                        {row.employeeCode || '—'}
                      </td>
                      <td className="px-2.5 py-1.5">{row.name || '—'}</td>
                      <td className="px-2.5 py-1.5">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${actionClass(
                            row.action
                          )}`}
                        >
                          {row.action}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                        {row.errors.length > 0 ? row.errors.join(' ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.mode === 'DRY_RUN' ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  onClick={onClose}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  onClick={runCommit}
                  disabled={committing || preview.validRows === 0}
                  className="cursor-pointer rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {committing
                    ? 'Importing…'
                    : `Commit ${preview.validRows} valid row${preview.validRows === 1 ? '' : 's'}`}
                </button>
              </div>
            ) : (
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  Done
                </button>
              </div>
            )}
          </section>
        ) : null}
      </ModalPanel>
    </div>
  );
};

export default EmployeeImportDialog;
