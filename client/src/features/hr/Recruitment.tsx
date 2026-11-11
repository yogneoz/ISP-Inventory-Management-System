/**
 * People & HR → Recruitment.
 *
 * One pipeline screen for Phase 4's requisitions, candidates, interviews and
 * offers. Reads are session-scoped by the API; the screen only forwards the
 * shell's selected branch. The hire control appears only for an ACCEPTED offer
 * and the server independently refuses any other conversion, so the UI cannot
 * turn a candidate into an employee ahead of the completed offer.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  CalendarDays,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  HrRecruitmentCandidateRecord,
  HrRecruitmentCandidateStatus,
  HrRecruitmentInterviewMode,
  HrRecruitmentInterviewRecord,
  HrRecruitmentInterviewStatus,
  HrRecruitmentOfferRecord,
  HrRecruitmentOfferStatus,
  HrRecruitmentRequisitionRecord,
  HrRecruitmentRequisitionStatus,
} from '../../services/api';
import type { Branch, User } from '../../types';
import { formatMoney } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';

interface RecruitmentProps {
  currentUser: User | null;
  branches: Branch[];
  selectedBranchId?: string;
}

interface RequisitionForm {
  branchId: string;
  title: string;
  department: string;
  designation: string;
  employmentType: string;
  openings: string;
  status: HrRecruitmentRequisitionStatus;
  openedOnAD: string;
  closesOnAD: string;
  description: string;
}

interface CandidateForm {
  requisitionId: string;
  name: string;
  email: string;
  phone: string;
  source: string;
  currentEmployer: string;
  notes: string;
}

interface InterviewForm {
  roundName: string;
  scheduledOnAD: string;
  interviewer: string;
  mode: HrRecruitmentInterviewMode;
  status: HrRecruitmentInterviewStatus;
  rating: string;
  notes: string;
}

interface OfferForm {
  positionTitle: string;
  monthlySalary: string;
  startDateAD: string;
  offeredOnAD: string;
  status: Extract<HrRecruitmentOfferStatus, 'DRAFT' | 'SENT'>;
  notes: string;
}

const REQUISITION_STATUSES: HrRecruitmentRequisitionStatus[] = [
  'DRAFT',
  'OPEN',
  'ON_HOLD',
  'CLOSED',
];
const CANDIDATE_STATUSES: Exclude<HrRecruitmentCandidateStatus, 'HIRED'>[] = [
  'NEW',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
];
const INTERVIEW_STATUSES: HrRecruitmentInterviewStatus[] = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];
const INTERVIEW_MODES: HrRecruitmentInterviewMode[] = ['IN_PERSON', 'PHONE', 'VIDEO'];

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs text-slate-800 dark:border-slate-700 dark:text-slate-100';
const labelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const primaryButton =
  'flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60';
const secondaryButton =
  'cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
const tableHead =
  'border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800';
const tableRow = 'border-b border-slate-100 last:border-0 dark:border-slate-800';

const statusTone: Record<string, string> = {
  OPEN: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  ON_HOLD: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  CLOSED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  NEW: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  SCREENING: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  INTERVIEW: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  OFFER: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  HIRED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  REJECTED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  WITHDRAWN: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  SCHEDULED: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  CANCELLED: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  SENT: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  ACCEPTED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  DECLINED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

const today = (): string => new Date().toISOString().slice(0, 10);

const label = (value: string): string =>
  value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
      statusTone[status] || statusTone.DRAFT
    }`}
  >
    {label(status)}
  </span>
);

const SummaryCard: React.FC<{
  labelText: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  testId: string;
}> = ({ labelText, value, hint, icon, testId }) => (
  <div className={`${panel} flex items-start justify-between gap-3`}>
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{labelText}</p>
      <p
        data-testid={testId}
        className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100"
      >
        {value}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>
    </div>
    <span className="rounded-xl bg-slate-100 p-2 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
      {icon}
    </span>
  </div>
);

const EmptyRow: React.FC<{ colSpan: number; message: string; testId: string }> = ({
  colSpan,
  message,
  testId,
}) => (
  <tr>
    <td colSpan={colSpan} className="px-1 py-6 text-center text-xs text-slate-400" data-testid={testId}>
      {message}
    </td>
  </tr>
);

const defaultRequisitionForm = (
  branchId: string,
  requisition?: HrRecruitmentRequisitionRecord | null
): RequisitionForm =>
  requisition
    ? {
        branchId: requisition.branchId,
        title: requisition.title,
        department: requisition.department || '',
        designation: requisition.designation || '',
        employmentType: requisition.employmentType || '',
        openings: String(requisition.openings),
        status: requisition.status,
        openedOnAD: requisition.openedOnAD || '',
        closesOnAD: requisition.closesOnAD || '',
        description: requisition.description || '',
      }
    : {
        branchId,
        title: '',
        department: '',
        designation: '',
        employmentType: 'FULL_TIME',
        openings: '1',
        status: 'DRAFT',
        openedOnAD: today(),
        closesOnAD: '',
        description: '',
      };

const emptyCandidateForm = (requisitionId = ''): CandidateForm => ({
  requisitionId,
  name: '',
  email: '',
  phone: '',
  source: '',
  currentEmployer: '',
  notes: '',
});

const emptyInterviewForm = (): InterviewForm => ({
  roundName: 'Screening',
  scheduledOnAD: today(),
  interviewer: '',
  mode: 'VIDEO',
  status: 'SCHEDULED',
  rating: '',
  notes: '',
});

const emptyOfferForm = (
  candidate?: HrRecruitmentCandidateRecord | null,
  offer?: HrRecruitmentOfferRecord | null
): OfferForm =>
  offer
    ? {
        positionTitle: offer.positionTitle,
        monthlySalary: String(offer.monthlySalary),
        startDateAD: offer.startDateAD,
        offeredOnAD: offer.offeredOnAD,
        status: offer.status === 'SENT' ? 'SENT' : 'DRAFT',
        notes: offer.notes || '',
      }
    : {
        positionTitle: candidate?.offerPositionTitle || candidate?.requisitionTitle || '',
        monthlySalary: '',
        startDateAD: today(),
        offeredOnAD: today(),
        status: 'DRAFT',
        notes: '',
      };

export const Recruitment: React.FC<RecruitmentProps> = ({
  currentUser,
  branches,
  selectedBranchId,
}) => {
  const activationKey = useActivationKey('hr-recruitment');
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canView =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canManage =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const branchScope = selectedBranchId && selectedBranchId !== 'ALL' ? selectedBranchId : undefined;
  const concreteBranches = branches.filter((branch) => branch.id !== 'ALL');
  const defaultBranchId =
    branchScope || currentUser?.branchId || concreteBranches[0]?.id || '';

  const [requisitions, setRequisitions] = useState<HrRecruitmentRequisitionRecord[]>([]);
  const [candidates, setCandidates] = useState<HrRecruitmentCandidateRecord[]>([]);
  const [interviews, setInterviews] = useState<HrRecruitmentInterviewRecord[]>([]);
  const [offers, setOffers] = useState<HrRecruitmentOfferRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const [requisitionForm, setRequisitionForm] = useState<RequisitionForm>(() =>
    defaultRequisitionForm(defaultBranchId)
  );
  const [editingRequisition, setEditingRequisition] =
    useState<HrRecruitmentRequisitionRecord | null>(null);
  const [requisitionModalOpen, setRequisitionModalOpen] = useState(false);

  const [candidateForm, setCandidateForm] = useState<CandidateForm>(() => emptyCandidateForm());
  const [candidateModalOpen, setCandidateModalOpen] = useState(false);

  const [interviewForm, setInterviewForm] = useState<InterviewForm>(emptyInterviewForm);
  const [offerForm, setOfferForm] = useState<OfferForm>(() => emptyOfferForm());
  const [employeeCode, setEmployeeCode] = useState('');
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [requisitionRows, candidateRows, interviewRows, offerRows] = await Promise.all([
        api.getHrRecruitmentRequisitions({ branchId: branchScope }),
        api.getHrRecruitmentCandidates({ branchId: branchScope }),
        api.getHrRecruitmentInterviews({ branchId: branchScope }),
        api.getHrRecruitmentOffers({ branchId: branchScope }),
      ]);
      setRequisitions(Array.isArray(requisitionRows) ? requisitionRows : []);
      setCandidates(Array.isArray(candidateRows) ? candidateRows : []);
      setInterviews(Array.isArray(interviewRows) ? interviewRows : []);
      setOffers(Array.isArray(offerRows) ? offerRows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The recruitment pipeline could not be read.');
    } finally {
      setLoading(false);
    }
  }, [branchScope, canView]);

  useEffect(() => {
    void loadAll();
  }, [activationKey, loadAll]);

  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) || null;
  const selectedInterviews = useMemo(
    () => interviews.filter((interview) => interview.candidateId === selectedCandidateId),
    [interviews, selectedCandidateId]
  );
  const selectedOffer = useMemo(
    () => offers.find((offer) => offer.candidateId === selectedCandidateId) || null,
    [offers, selectedCandidateId]
  );

  useEffect(() => {
    setInterviewForm(emptyInterviewForm());
    setOfferForm(emptyOfferForm(selectedCandidate, selectedOffer));
    setEmployeeCode('');
  }, [selectedCandidateId, selectedOffer?.status]);

  const openRequisitions = requisitions.filter((row) => row.status === 'OPEN').length;
  const activeCandidates = candidates.filter(
    (row) => !['HIRED', 'REJECTED', 'WITHDRAWN'].includes(row.status)
  ).length;
  const scheduledInterviews = interviews.filter((row) => row.status === 'SCHEDULED').length;
  const acceptedOffers = offers.filter((row) => row.status === 'ACCEPTED').length;

  const openRequisitionCreate = () => {
    setEditingRequisition(null);
    setRequisitionForm(defaultRequisitionForm(defaultBranchId));
    setRequisitionModalOpen(true);
  };

  const openRequisitionEdit = (requisition: HrRecruitmentRequisitionRecord) => {
    setEditingRequisition(requisition);
    setRequisitionForm(defaultRequisitionForm(defaultBranchId, requisition));
    setRequisitionModalOpen(true);
  };

  const saveRequisition = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!requisitionForm.title.trim()) {
      alertDialog('A requisition title is required.');
      return;
    }
    if (!requisitionForm.branchId) {
      alertDialog('Choose the branch for this requisition.');
      return;
    }
    if (
      requisitionForm.openedOnAD &&
      requisitionForm.closesOnAD &&
      requisitionForm.closesOnAD < requisitionForm.openedOnAD
    ) {
      alertDialog('Closes date must be on or after the opened date.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: requisitionForm.title.trim(),
        department: requisitionForm.department.trim() || null,
        designation: requisitionForm.designation.trim() || null,
        employmentType: requisitionForm.employmentType.trim() || null,
        openings: Number(requisitionForm.openings || 1),
        status: requisitionForm.status,
        openedOnAD: requisitionForm.openedOnAD || null,
        closesOnAD: requisitionForm.closesOnAD || null,
        description: requisitionForm.description.trim() || null,
      };
      if (editingRequisition) {
        await api.updateHrRecruitmentRequisition(editingRequisition.id, payload);
      } else {
        await api.createHrRecruitmentRequisition({
          ...payload,
          branchId: requisitionForm.branchId,
        });
      }
      setRequisitionModalOpen(false);
      setEditingRequisition(null);
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The requisition could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const openCandidateCreate = () => {
    const firstOpen = requisitions.find((row) => row.status === 'OPEN' || row.status === 'ON_HOLD');
    if (!firstOpen) {
      void alertDialog('Open a requisition before adding a candidate.');
      return;
    }
    setCandidateForm(emptyCandidateForm(firstOpen.id));
    setCandidateModalOpen(true);
  };

  const saveCandidate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!candidateForm.requisitionId) {
      await alertDialog('Choose the requisition for this candidate.');
      return;
    }
    if (!candidateForm.name.trim()) {
      await alertDialog('A candidate name is required.');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.createHrRecruitmentCandidate({
        requisitionId: candidateForm.requisitionId,
        name: candidateForm.name.trim(),
        email: candidateForm.email.trim() || null,
        phone: candidateForm.phone.trim() || null,
        source: candidateForm.source.trim() || null,
        currentEmployer: candidateForm.currentEmployer.trim() || null,
        notes: candidateForm.notes.trim() || null,
      });
      setCandidateModalOpen(false);
      setCandidateForm(emptyCandidateForm());
      await loadAll();
      setSelectedCandidateId(saved.id);
    } catch (err: any) {
      await alertDialog(err?.message || 'The candidate could not be added.');
    } finally {
      setSaving(false);
    }
  };

  const changeCandidateStatus = async (
    status: Exclude<HrRecruitmentCandidateStatus, 'HIRED'>
  ) => {
    if (!selectedCandidate) return;
    setSaving(true);
    try {
      await api.updateHrRecruitmentCandidate(selectedCandidate.id, { status });
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The candidate stage could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  const scheduleInterview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCandidate) return;
    if (!interviewForm.roundName.trim() || !interviewForm.scheduledOnAD) {
      await alertDialog('An interview round and date are required.');
      return;
    }
    setSaving(true);
    try {
      await api.createHrRecruitmentInterview({
        candidateId: selectedCandidate.id,
        roundName: interviewForm.roundName.trim(),
        scheduledOnAD: interviewForm.scheduledOnAD,
        interviewer: interviewForm.interviewer.trim() || null,
        mode: interviewForm.mode,
        status: interviewForm.status,
        rating: interviewForm.rating ? Number(interviewForm.rating) : null,
        notes: interviewForm.notes.trim() || null,
      });
      setInterviewForm(emptyInterviewForm());
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The interview could not be scheduled.');
    } finally {
      setSaving(false);
    }
  };

  const createOffer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCandidate) return;
    if (!offerForm.positionTitle.trim()) {
      await alertDialog('An offer position is required.');
      return;
    }
    if (offerForm.monthlySalary === '' || Number(offerForm.monthlySalary) < 0) {
      await alertDialog('Enter a non-negative monthly salary.');
      return;
    }
    setSaving(true);
    try {
      await api.createHrRecruitmentOffer({
        candidateId: selectedCandidate.id,
        positionTitle: offerForm.positionTitle.trim(),
        monthlySalary: Number(offerForm.monthlySalary),
        startDateAD: offerForm.startDateAD,
        offeredOnAD: offerForm.offeredOnAD,
        status: offerForm.status,
        notes: offerForm.notes.trim() || null,
      });
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The offer could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const moveOffer = async (status: HrRecruitmentOfferStatus) => {
    if (!selectedOffer) return;
    const finalMove = status === 'ACCEPTED' || status === 'DECLINED' || status === 'WITHDRAWN';
    if (finalMove) {
      const ok = await confirmDialog(
        `Mark offer ${selectedOffer.offerNo} as ${label(status)}? This decision is final.`,
        { title: `${label(status)} offer`, confirmLabel: label(status) }
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await api.updateHrRecruitmentOffer(selectedOffer.id, { status });
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The offer could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const uploadResume = async (file: File | null) => {
    if (!file || !selectedCandidate) return;
    if (file.size > 5 * 1024 * 1024) {
      await alertDialog('The resume exceeds the 5 MB limit.');
      return;
    }
    setSaving(true);
    try {
      await api.uploadHrRecruitmentResume(selectedCandidate.id, file);
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The resume could not be uploaded.');
    } finally {
      setSaving(false);
    }
  };

  const downloadResume = async () => {
    if (!selectedCandidate) return;
    try {
      await api.downloadHrRecruitmentResume(selectedCandidate);
    } catch (err: any) {
      await alertDialog(err?.message || 'The resume could not be downloaded.');
    }
  };

  const hireCandidate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCandidate || !selectedOffer) return;
    if (selectedOffer.status !== 'ACCEPTED') {
      await alertDialog('The offer must be accepted before the candidate can become an employee.');
      return;
    }
    if (!employeeCode.trim()) {
      await alertDialog('Enter the employee code for the new employee.');
      return;
    }
    const ok = await confirmDialog(
      `Create employee ${employeeCode.trim().toUpperCase()} from candidate ${selectedCandidate.candidateNo}?`,
      { title: 'Convert candidate to employee', confirmLabel: 'Hire candidate' }
    );
    if (!ok) return;
    setSaving(true);
    try {
      const result = await api.hireHrRecruitmentCandidate(selectedCandidate.id, employeeCode.trim());
      await alertDialog(
        `${result.name} was hired as ${result.employeeCode}. Review the Employee Directory for the remaining master data.`
      );
      setEmployeeCode('');
      await loadAll();
    } catch (err: any) {
      await alertDialog(err?.message || 'The candidate could not be hired.');
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
        You do not have permission to view the recruitment pipeline. Ask an HR manager for the
        employee-view grant.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="hr-recruitment-screen">
      <PageHeader
        title="Recruitment"
        description={
          loadError && requisitions.length === 0
            ? 'Recruitment pipeline unavailable — retry below'
            : `${openRequisitions} open requisitions · ${activeCandidates} active candidates · ${scheduledInterviews} scheduled interviews`
        }
        icon={<Briefcase className="h-5 w-5 text-indigo-500" />}
        actions={
          <>
            {canManage && (
              <>
                <button type="button" onClick={openCandidateCreate} className={secondaryButton}>
                  <Users className="h-4 w-4" />
                  Add candidate
                </button>
                <button type="button" onClick={openRequisitionCreate} className={primaryButton}>
                  <Plus className="h-4 w-4" />
                  New requisition
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void loadAll()}
              className={secondaryButton}
              aria-label="Refresh recruitment"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </>
        }
      />

      {loadError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
          <span>{loadError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          labelText="Open requisitions"
          value={openRequisitions}
          hint="Status OPEN"
          icon={<Briefcase className="h-4 w-4" />}
          testId="recruitment-open-requisitions"
        />
        <SummaryCard
          labelText="Active candidates"
          value={activeCandidates}
          hint="New, screening, interview and offer"
          icon={<Users className="h-4 w-4" />}
          testId="recruitment-active-candidates"
        />
        <SummaryCard
          labelText="Scheduled interviews"
          value={scheduledInterviews}
          hint="Status SCHEDULED"
          icon={<CalendarDays className="h-4 w-4" />}
          testId="recruitment-scheduled-interviews"
        />
        <SummaryCard
          labelText="Accepted offers"
          value={acceptedOffers}
          hint="Ready to hire"
          icon={<UserCheck className="h-4 w-4" />}
          testId="recruitment-accepted-offers"
        />
      </div>

      <section className={panel} aria-label="Requisitions">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Requisitions</h3>
          <span className="text-[10px] text-slate-400">{requisitions.length} total</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead>
              <tr className={tableHead}>
                <th className="px-1 py-2 font-semibold">Requisition</th>
                <th className="px-1 py-2 font-semibold">Branch</th>
                <th className="px-1 py-2 font-semibold">Openings</th>
                <th className="px-1 py-2 font-semibold">Pipeline</th>
                <th className="px-1 py-2 font-semibold">Status</th>
                <th className="px-1 py-2 font-semibold">Opened / closes</th>
                <th className="px-1 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {requisitions.length === 0 ? (
                <EmptyRow
                  colSpan={7}
                  message="No requisitions in this branch scope."
                  testId="recruitment-empty-requisitions"
                />
              ) : (
                requisitions.map((row) => (
                  <tr key={row.id} className={tableRow}>
                    <td className="px-1 py-2">
                      <p className="font-medium text-slate-700 dark:text-slate-200">{row.title}</p>
                      <p className="text-[10px] text-slate-400">
                        {row.requisitionNo}
                        {row.department ? ` · ${row.department}` : ''}
                      </p>
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {row.hiredCount}/{row.openings}
                      <span className="ml-1 text-[10px] text-slate-400">hired</span>
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {row.candidateCount} candidates
                    </td>
                    <td className="px-1 py-2">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {row.openedOnAD || '—'}
                      <span className="text-slate-400"> → </span>
                      {row.closesOnAD || 'Open'}
                    </td>
                    <td className="px-1 py-2 text-right">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => openRequisitionEdit(row)}
                          className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          Edit
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={panel} aria-label="Candidate pipeline">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Candidate pipeline
          </h3>
          <span className="text-[10px] text-slate-400">{candidates.length} total</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead>
              <tr className={tableHead}>
                <th className="px-1 py-2 font-semibold">Candidate</th>
                <th className="px-1 py-2 font-semibold">Requisition</th>
                <th className="px-1 py-2 font-semibold">Branch</th>
                <th className="px-1 py-2 font-semibold">Stage</th>
                <th className="px-1 py-2 font-semibold">Interviews</th>
                <th className="px-1 py-2 font-semibold">Offer</th>
                <th className="px-1 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 ? (
                <EmptyRow
                  colSpan={7}
                  message="No candidates in this branch scope."
                  testId="recruitment-empty-candidates"
                />
              ) : (
                candidates.map((row) => (
                  <tr key={row.id} className={tableRow}>
                    <td className="px-1 py-2">
                      <p className="font-medium text-slate-700 dark:text-slate-200">{row.name}</p>
                      <p className="text-[10px] text-slate-400">
                        {row.candidateNo}
                        {row.email ? ` · ${row.email}` : ''}
                      </p>
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {row.requisitionNo}
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
                    <td className="px-1 py-2">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {row.interviewCount}
                    </td>
                    <td className="px-1 py-2">
                      {row.offerStatus ? <StatusPill status={row.offerStatus} /> : '—'}
                    </td>
                    <td className="px-1 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedCandidateId(row.id)}
                        className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className={panel} aria-label="Interviews">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Interviews</h3>
            <span className="text-[10px] text-slate-400">{interviews.length} total</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead>
                <tr className={tableHead}>
                  <th className="px-1 py-2 font-semibold">Candidate</th>
                  <th className="px-1 py-2 font-semibold">Round</th>
                  <th className="px-1 py-2 font-semibold">Date</th>
                  <th className="px-1 py-2 font-semibold">Status</th>
                  <th className="px-1 py-2 font-semibold">Rating</th>
                </tr>
              </thead>
              <tbody>
                {interviews.length === 0 ? (
                  <EmptyRow
                    colSpan={5}
                    message="No interviews scheduled."
                    testId="recruitment-empty-interviews"
                  />
                ) : (
                  interviews.map((row) => (
                    <tr key={row.id} className={tableRow}>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.candidateName}
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.roundName}</td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.scheduledOnAD}
                      </td>
                      <td className="px-1 py-2">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.rating ?? '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={panel} aria-label="Offers">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Offers</h3>
            <span className="text-[10px] text-slate-400">{offers.length} total</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead>
                <tr className={tableHead}>
                  <th className="px-1 py-2 font-semibold">Candidate</th>
                  <th className="px-1 py-2 font-semibold">Position</th>
                  <th className="px-1 py-2 font-semibold">Salary</th>
                  <th className="px-1 py-2 font-semibold">Start</th>
                  <th className="px-1 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {offers.length === 0 ? (
                  <EmptyRow
                    colSpan={5}
                    message="No offers created."
                    testId="recruitment-empty-offers"
                  />
                ) : (
                  offers.map((row) => (
                    <tr key={row.id} className={tableRow}>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.candidateName}
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.positionTitle}
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {formatMoney(row.monthlySalary)}
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.startDateAD}
                      </td>
                      <td className="px-1 py-2">
                        <StatusPill status={row.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {requisitionModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingRequisition ? 'Edit requisition' : 'New requisition'}
            onClose={() => setRequisitionModalOpen(false)}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">
                  {editingRequisition ? 'Edit requisition' : 'New requisition'}
                </h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  A requisition belongs to one branch; candidates inherit that branch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRequisitionModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveRequisition} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Branch *</label>
                  <select
                    value={requisitionForm.branchId}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, branchId: event.target.value })
                    }
                    disabled={Boolean(editingRequisition)}
                    className={inputClass}
                    required
                  >
                    <option value="">Choose a branch</option>
                    {concreteBranches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={requisitionForm.status}
                    onChange={(event) =>
                      setRequisitionForm({
                        ...requisitionForm,
                        status: event.target.value as HrRecruitmentRequisitionStatus,
                      })
                    }
                    className={inputClass}
                  >
                    {REQUISITION_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {label(status)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelClass}>Title *</label>
                <input
                  value={requisitionForm.title}
                  onChange={(event) =>
                    setRequisitionForm({ ...requisitionForm, title: event.target.value })
                  }
                  className={inputClass}
                  maxLength={150}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Department</label>
                  <input
                    value={requisitionForm.department}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, department: event.target.value })
                    }
                    className={inputClass}
                    maxLength={120}
                  />
                </div>
                <div>
                  <label className={labelClass}>Designation</label>
                  <input
                    value={requisitionForm.designation}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, designation: event.target.value })
                    }
                    className={inputClass}
                    maxLength={120}
                  />
                </div>
                <div>
                  <label className={labelClass}>Employment type</label>
                  <input
                    value={requisitionForm.employmentType}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, employmentType: event.target.value })
                    }
                    className={inputClass}
                    maxLength={30}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Openings</label>
                  <input
                    type="number"
                    min="1"
                    max="999"
                    value={requisitionForm.openings}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, openings: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Opened (AD)</label>
                  <input
                    type="date"
                    value={requisitionForm.openedOnAD}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, openedOnAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Closes (AD)</label>
                  <input
                    type="date"
                    value={requisitionForm.closesOnAD}
                    onChange={(event) =>
                      setRequisitionForm({ ...requisitionForm, closesOnAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Description</label>
                <textarea
                  value={requisitionForm.description}
                  onChange={(event) =>
                    setRequisitionForm({ ...requisitionForm, description: event.target.value })
                  }
                  className="min-h-20 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={2000}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setRequisitionModalOpen(false)}
                  className={secondaryButton}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : editingRequisition ? 'Save changes' : 'Create requisition'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {candidateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label="Add candidate"
            onClose={() => setCandidateModalOpen(false)}
            className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Add candidate</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  The candidate inherits the selected requisition's branch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCandidateModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveCandidate} className="space-y-3">
              <div>
                <label className={labelClass}>Requisition *</label>
                <select
                  value={candidateForm.requisitionId}
                  onChange={(event) =>
                    setCandidateForm({ ...candidateForm, requisitionId: event.target.value })
                  }
                  className={inputClass}
                  required
                >
                  <option value="">Choose a requisition</option>
                  {requisitions
                    .filter((row) => row.status === 'OPEN' || row.status === 'ON_HOLD')
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.requisitionNo} — {row.title}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Name *</label>
                <input
                  value={candidateForm.name}
                  onChange={(event) =>
                    setCandidateForm({ ...candidateForm, name: event.target.value })
                  }
                  className={inputClass}
                  maxLength={200}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Email</label>
                  <input
                    type="email"
                    value={candidateForm.email}
                    onChange={(event) =>
                      setCandidateForm({ ...candidateForm, email: event.target.value })
                    }
                    className={inputClass}
                    maxLength={150}
                  />
                </div>
                <div>
                  <label className={labelClass}>Phone</label>
                  <input
                    value={candidateForm.phone}
                    onChange={(event) =>
                      setCandidateForm({ ...candidateForm, phone: event.target.value })
                    }
                    className={inputClass}
                    maxLength={30}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Source</label>
                  <input
                    value={candidateForm.source}
                    onChange={(event) =>
                      setCandidateForm({ ...candidateForm, source: event.target.value })
                    }
                    className={inputClass}
                    maxLength={80}
                  />
                </div>
                <div>
                  <label className={labelClass}>Current employer</label>
                  <input
                    value={candidateForm.currentEmployer}
                    onChange={(event) =>
                      setCandidateForm({ ...candidateForm, currentEmployer: event.target.value })
                    }
                    className={inputClass}
                    maxLength={150}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea
                  value={candidateForm.notes}
                  onChange={(event) =>
                    setCandidateForm({ ...candidateForm, notes: event.target.value })
                  }
                  className="min-h-20 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={1000}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setCandidateModalOpen(false)}
                  className={secondaryButton}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : 'Add candidate'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {selectedCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={`Candidate ${selectedCandidate.name}`}
            onClose={() => setSelectedCandidateId(null)}
            className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">{selectedCandidate.name}</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {selectedCandidate.candidateNo} · {selectedCandidate.requisitionNo} ·{' '}
                  {selectedCandidate.branchName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCandidateId(null)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <section className="space-y-3">
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Candidate stage
                      </p>
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                        {selectedCandidate.email || 'No email'} ·{' '}
                        {selectedCandidate.phone || 'No phone'}
                      </p>
                    </div>
                    {canManage && selectedCandidate.status !== 'HIRED' ? (
                      <select
                        value={selectedCandidate.status}
                        onChange={(event) =>
                          void changeCandidateStatus(
                            event.target.value as Exclude<HrRecruitmentCandidateStatus, 'HIRED'>
                          )
                        }
                        disabled={saving}
                        className="h-9 rounded-lg border border-slate-300 bg-transparent px-2 text-xs dark:border-slate-700"
                        aria-label="Candidate stage"
                      >
                        {CANDIDATE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {label(status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <StatusPill status={selectedCandidate.status} />
                    )}
                  </div>
                  {selectedCandidate.hiredEmployeeCode && (
                    <p className="mt-2 rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                      Hired as employee {selectedCandidate.hiredEmployeeCode}
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">Resume</p>
                    {selectedCandidate.hasResume ? (
                      <button
                        type="button"
                        onClick={() => void downloadResume()}
                        className="cursor-pointer text-[10px] font-semibold text-indigo-600 dark:text-indigo-400"
                      >
                        Download
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                    {selectedCandidate.hasResume
                      ? `${selectedCandidate.resumeFileName} · ${Math.ceil(
                          Number(selectedCandidate.resumeByteSize || 0) / 1024
                        )} KB`
                      : 'No resume on file. PDF, DOC or DOCX up to 5 MB.'}
                  </p>
                  {canManage && (
                    <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-300">
                      <FileText className="h-3.5 w-3.5" />
                      {selectedCandidate.hasResume ? 'Replace resume' : 'Upload resume'}
                      <input
                        type="file"
                        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        className="hidden"
                        onChange={(event) => void uploadResume(event.target.files?.[0] || null)}
                        aria-label="Resume file"
                      />
                    </label>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <p className="text-xs font-semibold">Interviews</p>
                  <div className="mt-2 space-y-1">
                    {selectedInterviews.length === 0 ? (
                      <p className="text-[10px] text-slate-400">No interviews scheduled.</p>
                    ) : (
                      selectedInterviews.map((row) => (
                        <div
                          key={row.id}
                          className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1 text-[10px] dark:bg-slate-800/60"
                        >
                          <span className="font-medium">{row.roundName}</span>
                          <span className="text-slate-500 dark:text-slate-400">
                            {row.scheduledOnAD} · {label(row.mode)}
                          </span>
                          <StatusPill status={row.status} />
                        </div>
                      ))
                    )}
                  </div>
                  {canManage &&
                    !['HIRED', 'REJECTED', 'WITHDRAWN'].includes(selectedCandidate.status) && (
                      <form onSubmit={scheduleInterview} className="mt-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Round *</label>
                            <input
                              value={interviewForm.roundName}
                              onChange={(event) =>
                                setInterviewForm({
                                  ...interviewForm,
                                  roundName: event.target.value,
                                })
                              }
                              className={inputClass}
                              maxLength={60}
                              required
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Date *</label>
                            <input
                              type="date"
                              value={interviewForm.scheduledOnAD}
                              onChange={(event) =>
                                setInterviewForm({
                                  ...interviewForm,
                                  scheduledOnAD: event.target.value,
                                })
                              }
                              className={inputClass}
                              required
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Interviewer</label>
                            <input
                              value={interviewForm.interviewer}
                              onChange={(event) =>
                                setInterviewForm({
                                  ...interviewForm,
                                  interviewer: event.target.value,
                                })
                              }
                              className={inputClass}
                              maxLength={150}
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Mode</label>
                            <select
                              value={interviewForm.mode}
                              onChange={(event) =>
                                setInterviewForm({
                                  ...interviewForm,
                                  mode: event.target.value as HrRecruitmentInterviewMode,
                                })
                              }
                              className={inputClass}
                            >
                              {INTERVIEW_MODES.map((mode) => (
                                <option key={mode} value={mode}>
                                  {label(mode)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Status</label>
                            <select
                              value={interviewForm.status}
                              onChange={(event) =>
                                setInterviewForm({
                                  ...interviewForm,
                                  status: event.target.value as HrRecruitmentInterviewStatus,
                                })
                              }
                              className={inputClass}
                            >
                              {INTERVIEW_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                  {label(status)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={labelClass}>Rating (1–5)</label>
                            <input
                              type="number"
                              min="1"
                              max="5"
                              value={interviewForm.rating}
                              onChange={(event) =>
                                setInterviewForm({ ...interviewForm, rating: event.target.value })
                              }
                              className={inputClass}
                            />
                          </div>
                        </div>
                        <button type="submit" disabled={saving} className={primaryButton}>
                          <CalendarDays className="h-4 w-4" />
                          Schedule interview
                        </button>
                      </form>
                    )}
                </div>
              </section>

              <section className="space-y-3">
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">Offer</p>
                    {selectedOffer ? <StatusPill status={selectedOffer.status} /> : null}
                  </div>

                  {!selectedOffer ? (
                    canManage &&
                    !['HIRED', 'REJECTED', 'WITHDRAWN'].includes(selectedCandidate.status) && (
                      <form onSubmit={createOffer} className="mt-3 space-y-2">
                        <div>
                          <label className={labelClass}>Position *</label>
                          <input
                            value={offerForm.positionTitle}
                            onChange={(event) =>
                              setOfferForm({ ...offerForm, positionTitle: event.target.value })
                            }
                            className={inputClass}
                            maxLength={150}
                            required
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Monthly salary *</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={offerForm.monthlySalary}
                              onChange={(event) =>
                                setOfferForm({ ...offerForm, monthlySalary: event.target.value })
                              }
                              className={inputClass}
                              required
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Start date *</label>
                            <input
                              type="date"
                              value={offerForm.startDateAD}
                              onChange={(event) =>
                                setOfferForm({ ...offerForm, startDateAD: event.target.value })
                              }
                              className={inputClass}
                              required
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Offered on</label>
                            <input
                              type="date"
                              value={offerForm.offeredOnAD}
                              onChange={(event) =>
                                setOfferForm({ ...offerForm, offeredOnAD: event.target.value })
                              }
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Initial status</label>
                            <select
                              value={offerForm.status}
                              onChange={(event) =>
                                setOfferForm({
                                  ...offerForm,
                                  status: event.target.value as 'DRAFT' | 'SENT',
                                })
                              }
                              className={inputClass}
                            >
                              <option value="DRAFT">Draft</option>
                              <option value="SENT">Sent</option>
                            </select>
                          </div>
                        </div>
                        <button type="submit" disabled={saving} className={primaryButton}>
                          <FileText className="h-4 w-4" />
                          Create offer
                        </button>
                      </form>
                    )
                  ) : (
                    <div className="mt-2 space-y-2 text-xs">
                      <p className="font-medium text-slate-700 dark:text-slate-200">
                        {selectedOffer.positionTitle}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400">
                        {formatMoney(selectedOffer.monthlySalary)} · starts{' '}
                        {selectedOffer.startDateAD}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        {selectedOffer.offerNo} · offered {selectedOffer.offeredOnAD}
                        {selectedOffer.respondedOnAD
                          ? ` · responded ${selectedOffer.respondedOnAD}`
                          : ''}
                      </p>
                      {canManage && selectedOffer.status === 'DRAFT' && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void moveOffer('SENT')}
                          className={secondaryButton}
                        >
                          Mark sent
                        </button>
                      )}
                      {canManage && selectedOffer.status === 'SENT' && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void moveOffer('ACCEPTED')}
                            className={primaryButton}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Accept offer
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void moveOffer('DECLINED')}
                            className={secondaryButton}
                          >
                            Decline
                          </button>
                        </div>
                      )}
                      {canManage && selectedOffer.status === 'ACCEPTED' && (
                        <form onSubmit={hireCandidate} className="space-y-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                          <p className="text-[10px] text-slate-500 dark:text-slate-400">
                            The accepted offer is final. Hire creates the employee from its salary and
                            start date.
                          </p>
                          <div>
                            <label className={labelClass}>New employee code *</label>
                            <input
                              value={employeeCode}
                              onChange={(event) => setEmployeeCode(event.target.value)}
                              className={inputClass}
                              maxLength={50}
                              placeholder="e.g. EMP-1042"
                            />
                          </div>
                          <button type="submit" disabled={saving} className={primaryButton}>
                            <UserCheck className="h-4 w-4" />
                            Hire candidate
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Requisition
                  </p>
                  <p className="mt-1 font-medium text-slate-700 dark:text-slate-200">
                    {selectedCandidate.requisitionTitle}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {selectedCandidate.requisitionNo} · {selectedCandidate.branchName}
                  </p>
                </div>
              </section>
            </div>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default Recruitment;
