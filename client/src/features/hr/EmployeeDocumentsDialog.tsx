/**
 * Employee document vault dialog.
 *
 * Metadata is readable by anyone who can read the employee master; the upload,
 * download and delete controls appear only for a caller with the manage grant,
 * matching the server's gates. The file itself is the upload body, capped at
 * 5 MiB before the request is sent.
 */
import React, { useEffect, useState } from 'react';
import { Download, FileText, Trash2, Upload, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { HR_DOCUMENT_MAX_BYTES, api } from '../../services/api';
import type { EmployeeRecord, HrDocumentType, HrEmployeeDocument } from '../../services/api';

interface EmployeeDocumentsDialogProps {
  employee: EmployeeRecord;
  canManage: boolean;
  onClose: () => void;
}

const DOCUMENT_TYPES: Array<{ value: HrDocumentType; label: string }> = [
  { value: 'CITIZENSHIP', label: 'Citizenship' },
  { value: 'PAN_CARD', label: 'PAN card' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'DRIVING_LICENSE', label: 'Driving licence' },
  { value: 'QUALIFICATION', label: 'Qualification' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'APPOINTMENT_LETTER', label: 'Appointment letter' },
  { value: 'BANK_DETAILS', label: 'Bank details' },
  { value: 'MEDICAL', label: 'Medical' },
  { value: 'OTHER', label: 'Other' },
];

const ACCEPTED_FILES =
  'application/pdf,image/png,image/jpeg,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const typeLabel = (type: string): string =>
  DOCUMENT_TYPES.find((option) => option.value === type)?.label || type;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (value: string | null | undefined): string =>
  value ? String(value).slice(0, 10) : '—';

export const EmployeeDocumentsDialog: React.FC<EmployeeDocumentsDialogProps> = ({
  employee,
  canManage,
  onClose,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [documents, setDocuments] = useState<HrEmployeeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<HrDocumentType>('CITIZENSHIP');
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await api.getEmployeeDocuments(employee.id, employee.branchId);
      setDocuments(Array.isArray(rows) ? rows : []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'The document list could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Reload only when the dialog is reopened for a different employee.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id]);

  const handleUpload = async () => {
    if (!file) {
      alertDialog('Choose a document file to upload.');
      return;
    }
    if (file.size > HR_DOCUMENT_MAX_BYTES) {
      alertDialog('The document exceeds the 5 MB limit.');
      return;
    }
    setSaving(true);
    try {
      await api.uploadEmployeeDocument(
        employee.id,
        file,
        { type: docType, expiresOnAD: expiresOn || null, notes: notes.trim() || null },
        employee.branchId
      );
      setFile(null);
      setExpiresOn('');
      setNotes('');
      setFormKey((key) => key + 1);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to upload the document: ${err?.message || 'Upload error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async (document: HrEmployeeDocument) => {
    setBusyId(document.id);
    try {
      await api.downloadEmployeeDocument(employee.id, document, employee.branchId);
    } catch (err: any) {
      alertDialog(`Failed to download the document: ${err?.message || 'Download error'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (document: HrEmployeeDocument) => {
    if (
      !(await confirmDialog(
        `Delete the ${typeLabel(document.docType)} file "${document.originalName}"? This cannot be undone.`
      ))
    ) {
      return;
    }
    setBusyId(document.id);
    try {
      await api.deleteEmployeeDocument(employee.id, document.id, employee.branchId);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to delete the document: ${err?.message || 'Delete error'}`);
    } finally {
      setBusyId(null);
    }
  };

  const inputClass =
    'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs dark:border-slate-700';
  const labelClass =
    'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label={`Documents for ${employee.name}`}
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold">Employee documents</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {employee.name} · {employee.employeeCode}
              {canManage ? '' : ' · metadata only — content requires HR manage rights'}
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

        {error ? (
          <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <div className="max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Type</th>
                <th className="px-2.5 py-1.5">File</th>
                <th className="px-2.5 py-1.5">Size</th>
                <th className="px-2.5 py-1.5">Expiry</th>
                <th className="px-2.5 py-1.5">Uploaded</th>
                <th className="px-2.5 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-5 text-center text-slate-500">
                    {loading ? 'Loading documents…' : 'No documents uploaded yet.'}
                  </td>
                </tr>
              ) : (
                documents.map((document) => (
                  <tr key={document.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-semibold">{typeLabel(document.docType)}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <FileText className="h-3.5 w-3.5 text-slate-400" />
                        {document.originalName}
                      </span>
                      {document.notes ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">{document.notes}</p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {formatBytes(Number(document.byteSize))}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {formatDate(document.expiresOnAD)}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {formatDate(document.createdAt)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        {canManage ? (
                          <>
                            <button
                              onClick={() => handleDownload(document)}
                              disabled={busyId === document.id}
                              title={`Download ${document.originalName}`}
                              className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(document)}
                              disabled={busyId === document.id}
                              title={`Delete ${document.originalName}`}
                              className="cursor-pointer rounded-lg p-1 text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] text-slate-400">View only</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {canManage ? (
          <section className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Upload a document
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className={labelClass}>File (PDF, PNG, JPEG, WebP or DOCX · max 5 MB)</label>
                <input
                  key={formKey}
                  type="file"
                  accept={ACCEPTED_FILES}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="block w-full cursor-pointer text-xs text-slate-600 file:mr-2 file:cursor-pointer file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
                />
              </div>
              <div>
                <label className={labelClass}>Document type</label>
                <select
                  value={docType}
                  onChange={(event) => setDocType(event.target.value as HrDocumentType)}
                  className={inputClass}
                >
                  {DOCUMENT_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Expiry (AD)</label>
                <input
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOn(event.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Note (optional)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="e.g. front and back"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleUpload}
                disabled={saving || !file}
                className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Upload className="h-3.5 w-3.5" />
                {saving ? 'Uploading…' : 'Upload document'}
              </button>
            </div>
          </section>
        ) : (
          <p className="mt-4 border-t border-slate-100 pt-3 text-[10px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
            You can see which documents exist, but downloading or changing them needs the HR
            manage permission.
          </p>
        )}
      </ModalPanel>
    </div>
  );
};

export default EmployeeDocumentsDialog;
