/**
 * People & HR → My Documents (employee self-service).
 *
 * Read-only view of the document metadata HR has uploaded for the signed-in
 * employee. The server derives the employee from `employees.user_id`, returns
 * only their documents and exposes no upload, replace, delete or approval
 * path. Downloads use the content URL returned by the API, which resolves to
 * the existing authenticated document route and repeats the own-record check.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Download, FileText, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  HrDocumentType,
  HrSelfDocument,
  HrSelfDocumentsResponse,
  HrSelfDocumentSummary,
} from '../../services/api';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';

interface EmployeeDocumentsProps {
  currentUser?: User | null;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';

const EMPTY_SUMMARY: HrSelfDocumentSummary = {
  totalDocuments: 0,
  expiringSoon: 0,
  expiredDocuments: 0,
};

const DOCUMENT_LABELS: Record<HrDocumentType, string> = {
  CITIZENSHIP: 'Citizenship',
  PAN_CARD: 'PAN card',
  PASSPORT: 'Passport',
  DRIVING_LICENSE: 'Driving licence',
  QUALIFICATION: 'Qualification',
  CONTRACT: 'Contract',
  APPOINTMENT_LETTER: 'Appointment letter',
  BANK_DETAILS: 'Bank details',
  MEDICAL: 'Medical',
  OTHER: 'Other',
};

const show = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : String(value).slice(0, 10);

const docTypeLabel = (type: HrDocumentType): string => DOCUMENT_LABELS[type] || type;

const expiryLabel = (status: HrSelfDocument['expiryStatus']): string => {
  if (status === 'EXPIRED') return 'Expired';
  if (status === 'EXPIRING') return 'Expiring soon';
  if (status === 'NO_EXPIRY') return 'No expiry';
  return 'Valid';
};

const expiryBadge = (status: HrSelfDocument['expiryStatus']): string => {
  if (status === 'EXPIRED') {
    return 'inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300';
  }
  if (status === 'EXPIRING') {
    return 'inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
  }
  if (status === 'VALID') {
    return 'inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  return 'inline-flex items-center rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300';
};

const SummaryCard: React.FC<{ label: string; value: number; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
    <p className={labelClass}>{label}</p>
    <p className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
      {value.toLocaleString('en-US')}
    </p>
    {hint && <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>}
  </div>
);

export const EmployeeDocuments: React.FC<EmployeeDocumentsProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-documents');

  const [documents, setDocuments] = useState<HrSelfDocument[]>([]);
  const [summary, setSummary] = useState<HrSelfDocumentSummary>(EMPTY_SUMMARY);
  const [expirySoonDays, setExpirySoonDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!allowed) {
      setDocuments([]);
      setSummary(EMPTY_SUMMARY);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setDownloadError('');
    try {
      const next: HrSelfDocumentsResponse = await api.getMyHrDocuments();
      setDocuments(next?.documents || []);
      setSummary(next?.summary || EMPTY_SUMMARY);
      setExpirySoonDays(Number(next?.expirySoonDays) || 30);
    } catch (err: any) {
      setError(err?.message || 'Your documents could not be loaded.');
      setDocuments([]);
      setSummary(EMPTY_SUMMARY);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, load, activationKey]);

  const handleDownload = async (document: HrSelfDocument) => {
    setBusyId(document.id);
    setDownloadError('');
    try {
      await api.downloadMyHrDocument(document);
    } catch (err: any) {
      setDownloadError(err?.message || 'The document could not be downloaded.');
    } finally {
      setBusyId(null);
    }
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="My Documents"
          description="Documents HR has uploaded for you."
          icon={<FileText className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view your documents.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="My Documents"
        description="Documents HR has uploaded for your employee record, read-only."
        icon={<FileText className="h-5 w-5 text-emerald-500" />}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh documents"
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {downloadError && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{downloadError}</span>
        </div>
      )}

      {loading && !documents.length ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading your documents…</p>
        </section>
      ) : (
        <>
          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Document summary
              </h3>
              <span className="text-[10px] text-slate-400">
                {summary.totalDocuments} document{summary.totalDocuments === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <SummaryCard label="Total documents" value={summary.totalDocuments} />
              <SummaryCard
                label="Expiring soon"
                value={summary.expiringSoon}
                hint={`Within ${expirySoonDays} days`}
              />
              <SummaryCard label="Expired" value={summary.expiredDocuments} />
            </div>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Your documents
              </h3>
              <span className="text-[10px] text-slate-400">
                {documents.length} document{documents.length === 1 ? '' : 's'}, newest first
              </span>
            </div>
            {documents.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[840px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                      <th className="px-1 py-2 font-semibold">Type</th>
                      <th className="px-1 py-2 font-semibold">Document</th>
                      <th className="px-1 py-2 font-semibold">Issued</th>
                      <th className="px-1 py-2 font-semibold">Expires</th>
                      <th className="px-1 py-2 font-semibold">Status</th>
                      <th className="px-1 py-2 font-semibold">Uploaded</th>
                      <th className="px-1 py-2 text-right font-semibold">File</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((document) => (
                      <tr
                        key={document.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                      >
                        <td className="px-1 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                          {docTypeLabel(document.docType)}
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          <div className="flex items-center gap-1.5 font-medium">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            {document.title}
                          </div>
                          {document.notes ? (
                            <p className="mt-0.5 text-[10px] text-slate-400">{document.notes}</p>
                          ) : null}
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(document.issuedOnAD)}
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(document.expiresOnAD)}
                        </td>
                        <td className="px-1 py-2.5">
                          <span className={expiryBadge(document.expiryStatus)}>
                            {expiryLabel(document.expiryStatus)}
                          </span>
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(document.uploadedAt)}
                        </td>
                        <td className="px-1 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => void handleDownload(document)}
                            disabled={busyId === document.id}
                            aria-label={`Download ${document.title}`}
                            className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No documents have been uploaded for your employee record yet.
              </p>
            )}
          </section>

          <p className="text-[10px] text-slate-400">
            Only documents for the employee linked to your login are returned. The vault does not
            store a separate issue date, so Issued shows “—” and the upload date is shown
            separately. Self-service cannot upload, replace or delete a document.
          </p>
        </>
      )}
    </div>
  );
};

export default EmployeeDocuments;
