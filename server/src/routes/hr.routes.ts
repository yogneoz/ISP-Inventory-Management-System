/**
 * People & HR routes that are not payroll runs. Reads use the employee-view
 * grant; writes use the employee-manage grant, with the legacy payroll-master
 * grant accepted during the HR permission migration.
 */
import express, { type Express } from 'express';
import { requirePermissionAny, requireRole } from '../middleware';
import {
  get_hrOrgCatalogue,
  get_hrOrgChart,
  get_hrOrgHeadcounts,
  get_hrOrgMasters,
  get_hrOrgUnmatched,
  patch_hrOrgMaster,
  post_hrOrgMaster,
} from '../controllers/hrOrg.controller';
import {
  delete_hrEmployeeDocument,
  get_hrEmployeeDocumentContent,
  get_hrEmployeeDocuments,
  post_hrEmployeeDocument,
} from '../controllers/hrDocuments.controller';
import {
  get_hrEmployeeProfile,
  put_hrEmployeeProfile,
} from '../controllers/hrEmployeeProfile.controller';
import {
  approve_hrBranchTransfer,
  reject_hrBranchTransfer,
} from '../controllers/payroll.controller';
import { HR_DOCUMENT_MAX_BYTES } from '../models/hrDocuments.repo';
import { HR_RECRUITMENT_RESUME_MAX_BYTES } from '../models/hrRecruitment.repo';
import {
  get_hrRecruitmentCandidates,
  get_hrRecruitmentCandidateResume,
  get_hrRecruitmentCandidateResumeContent,
  get_hrRecruitmentInterviews,
  get_hrRecruitmentOffers,
  get_hrRecruitmentRequisitions,
  patch_hrRecruitmentCandidate,
  patch_hrRecruitmentInterview,
  patch_hrRecruitmentOffer,
  patch_hrRecruitmentRequisition,
  post_hrRecruitmentCandidate,
  post_hrRecruitmentCandidateResume,
  post_hrRecruitmentHire,
  post_hrRecruitmentInterview,
  post_hrRecruitmentOffer,
  post_hrRecruitmentRequisition,
} from '../controllers/hrRecruitment.controller';
import {
  get_hrGoals,
  get_hrPerformanceFeedback,
  get_hrReviewCycles,
  patch_hrGoal,
  patch_hrReviewCycle,
  post_hrGoal,
  post_hrPerformanceFeedback,
  post_hrReviewCycle,
  post_hrReviewCycleSignOff,
} from '../controllers/hrPerformance.controller';
import {
  get_hrLifecycleChecklist,
  get_hrLifecycleChecklists,
  patch_hrLifecycleChecklist,
  post_hrLifecycleChecklist,
  post_hrLifecycleComplete,
  post_hrLifecycleItem,
  post_hrLifecycleItemComplete,
} from '../controllers/hrLifecycle.controller';
import { post_hrEmployeeImport } from '../controllers/hrEmployeeImport.controller';
import {
  delete_hrAttendance,
  delete_hrHoliday,
  get_hrAttendance,
  get_hrHolidays,
  get_hrLeaveTypes,
  get_hrShifts,
  patch_hrLeaveType,
  patch_hrShift,
  post_hrAttendance,
  post_hrAttendanceImport,
  post_hrHoliday,
  post_hrLeaveType,
  post_hrShift,
} from '../controllers/hrAttendance.controller';
import {
  get_hrLeaveBalances,
  get_hrLeaveRequests,
  patch_hrLeaveBalance,
  post_hrLeaveBalance,
  post_hrLeaveRequest,
  post_hrLeaveRequestApprove,
  post_hrLeaveRequestCancel,
  post_hrLeaveRequestReject,
} from '../controllers/hrLeave.controller';
import {
  get_hrPayrollInputs,
  put_hrPayrollInput,
} from '../controllers/hrPayrollInputs.controller';
import { get_hrPayrollReport, get_hrWorkforceReport } from '../controllers/hrReports.controller';
import { get_hrEmployeeBranchTransfers } from '../controllers/hrEmployeeBranchTransfers.controller';
import {
  get_hrSelfServiceAttendance,
  get_hrSelfServiceDocuments,
  get_hrSelfServiceLeave,
  get_hrSelfServicePayslips,
  get_hrSelfServiceProfile,
  post_hrSelfServiceLeave,
  post_hrSelfServiceLeaveCancel,
  put_hrSelfServiceProfile,
} from '../controllers/hrSelfService.controller';
import {
  get_hrSalaryStructure,
  get_hrSalaryStructures,
  patch_hrSalaryStructure,
  post_hrSalaryStructure,
} from '../controllers/hrSalary.controller';
import {
  get_hrSalaryStatutory,
  get_hrStatutoryConfig,
  get_hrStatutoryConfigs,
  patch_hrStatutoryConfig,
  post_hrStatutoryConfig,
} from '../controllers/hrStatutory.controller';

// Attendance reads are part of the HR view surface; writes are the separate
// attendance-manage control, with the legacy payroll-master grant accepted so
// existing payroll managers keep working. The controller repeats the branch
// and write checks so a future route edit cannot widen access silently.
const HR_VIEW = ['hr-employee-view', 'hr-attendance-manage', 'gl-payroll-manage'] as const;
const HR_ATTENDANCE_WRITE = ['hr-attendance-manage', 'gl-payroll-manage'] as const;
// Lifecycle reads use the employee directory's grant; attendance-manage is a
// separate write control and must not widen access to lifecycle records.
const HR_LIFECYCLE_READ = ['hr-employee-view', 'gl-payroll-manage'] as const;
// Salary is employee master data, not attendance: managers read and write it
// through the employee grants, and the legacy payroll-master grant still works.
const HR_SALARY_READ = ['hr-employee-view', 'hr-employee-manage', 'gl-payroll-manage'] as const;
const HR_SALARY_WRITE = ['hr-employee-manage', 'gl-payroll-manage'] as const;

export function registerHrRoutes(app: Express) {
  // Phase 3 employee self-service: the signed-in employee's own profile and
  // posted/paid payslips. Neither route has an employee/branch selector or a
  // write path; the controller repeats the permission check, derives the
  // record from the session and refuses draft/approved payroll runs.
  app.get(
    '/api/hr/self-service/profile',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      get_hrSelfServiceProfile(req as any, res as any).catch(next);
    }
  );
  // The one self-service write: the employee's own contact card and photo.
  // Same grant as the read, no employee/branch selector, and the controller
  // refuses every HR-only column by name.
  app.put(
    '/api/hr/self-service/profile',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      put_hrSelfServiceProfile(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/self-service/payslips',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      get_hrSelfServicePayslips(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/self-service/leave',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      get_hrSelfServiceLeave(req as any, res as any).catch(next);
    }
  );
  // The mobile client files and withdraws its own leave here. Same grant as the
  // read; the controller derives the employee from the session and refuses a
  // body that names anyone else. Approval stays on the HR register's routes.
  app.post(
    '/api/hr/self-service/leave',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      post_hrSelfServiceLeave(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/self-service/leave/:id/cancel',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      post_hrSelfServiceLeaveCancel(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/self-service/attendance',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      get_hrSelfServiceAttendance(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/self-service/documents',
    requirePermissionAny('hr-self-service'),
    async (req, res, next) => {
      get_hrSelfServiceDocuments(req as any, res as any).catch(next);
    }
  );

  // Workforce analytics is a read-only aggregate over the employee master and
  // the leave ledger. No employee/user/tenant selector is accepted; the
  // controller derives branch scope from the session and refuses every
  // unrecognised or repeated filter.
  app.get(
    '/api/hr/reports/workforce',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrWorkforceReport(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/reports/payroll',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrPayrollReport(req as any, res as any).catch(next);
    }
  );

  // Directory-wide transfer history. Both filters are optional; the controller
  // derives the branch scope from the session and refuses an out-of-scope branch.
  app.get(
    '/api/hr/branch-transfers',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrEmployeeBranchTransfers(req as any, res as any).catch(next);
    }
  );
  // Deciding a transfer is a manager action and is deliberately separated from
  // creating the request. The controller also refuses self-approval.
  app.post(
    '/api/hr/branch-transfers/:id/approve',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'HR_MANAGER'),
    async (req, res, next) => {
      approve_hrBranchTransfer(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/branch-transfers/:id/reject',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'HR_MANAGER'),
    async (req, res, next) => {
      reject_hrBranchTransfer(req as any, res as any).catch(next);
    }
  );

  app.get(
    '/api/hr/org-masters',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrOrgMasters(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/org-catalogue',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrOrgCatalogue(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/org-chart',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrOrgChart(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/org-masters/unmatched',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrOrgUnmatched(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/org-masters/headcounts',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrOrgHeadcounts(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/org-masters',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      post_hrOrgMaster(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/org-masters/:id',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      patch_hrOrgMaster(req as any, res as any).catch(next);
    }
  );

  // Phase 1 attendance foundation: company-wide shifts/leave types and the
  // branch-owned holiday/attendance registers. A view-only HR officer reaches
  // every GET but none of the writes.
  app.get('/api/hr/shifts', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrShifts(req as any, res as any).catch(next);
  });
  app.post('/api/hr/shifts', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrShift(req as any, res as any).catch(next);
  });
  app.patch('/api/hr/shifts/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    patch_hrShift(req as any, res as any).catch(next);
  });

  app.get('/api/hr/leave-types', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrLeaveTypes(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-types', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveType(req as any, res as any).catch(next);
  });
  app.patch('/api/hr/leave-types/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    patch_hrLeaveType(req as any, res as any).catch(next);
  });

  app.get('/api/hr/holidays', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrHolidays(req as any, res as any).catch(next);
  });
  app.post('/api/hr/holidays', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrHoliday(req as any, res as any).catch(next);
  });
  app.delete('/api/hr/holidays/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    delete_hrHoliday(req as any, res as any).catch(next);
  });

  app.get('/api/hr/attendance', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrAttendance(req as any, res as any).catch(next);
  });
  // CSV import is a write, including its per-row skips: it upserts every valid
  // employee/day and writes one audit row in the same transaction.
  app.post(
    '/api/hr/attendance/import',
    requirePermissionAny(...HR_ATTENDANCE_WRITE),
    async (req, res, next) => {
      post_hrAttendanceImport(req as any, res as any).catch(next);
    }
  );
  app.post('/api/hr/attendance', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrAttendance(req as any, res as any).catch(next);
  });
  app.delete('/api/hr/attendance/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    delete_hrAttendance(req as any, res as any).catch(next);
  });

  // Phase 2 salary structure. Reads need the employee view/manage grant; writes
  // need employee-manage (or the legacy payroll grant). The controller repeats
  // the write check and derives the branch from the employee.
  app.get(
    '/api/hr/employee-salaries',
    requirePermissionAny(...HR_SALARY_READ),
    async (req, res, next) => {
      get_hrSalaryStructures(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/employee-salaries/:id',
    requirePermissionAny(...HR_SALARY_READ),
    async (req, res, next) => {
      get_hrSalaryStructure(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/employee-salaries',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrSalaryStructure(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/employee-salaries/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrSalaryStructure(req as any, res as any).catch(next);
    }
  );

  // Fiscal-year statutory deductions. Configs are company-wide: reads are on
  // the HR read grants, while writes need a manager AND a global account; the
  // controller repeats both checks. The computation route resolves the
  // structure, fiscal year and TDS/SSF in one read.
  app.get(
    '/api/hr/statutory-configs',
    requirePermissionAny(...HR_SALARY_READ),
    async (req, res, next) => {
      get_hrStatutoryConfigs(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/statutory-configs/:id',
    requirePermissionAny(...HR_SALARY_READ),
    async (req, res, next) => {
      get_hrStatutoryConfig(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/statutory-configs',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrStatutoryConfig(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/statutory-configs/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrStatutoryConfig(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/employee-salaries/:id/statutory',
    requirePermissionAny(...HR_SALARY_READ),
    async (req, res, next) => {
      get_hrSalaryStatutory(req as any, res as any).catch(next);
    }
  );

  // Attendance-derived payroll inputs are a read-only projection, while the
  // incentive/arrears/recovery row is period-scoped preparation data. Reads
  // share the HR view surface; writes use the generated-run preparation gate.
  app.get('/api/hr/payroll-inputs', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrPayrollInputs(req as any, res as any).catch(next);
  });
  app.put(
    '/api/hr/payroll-inputs',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      put_hrPayrollInput(req as any, res as any).catch(next);
    }
  );

  // Phase 1 leave: a balance row is one employee + leave type + year, and
  // usage is derived from APPROVED requests. Reads share the attendance view
  // surface; every write (balance, request, decision, cancel) is the same
  // attendance-manage control, with the legacy payroll grant still accepted.
  app.get('/api/hr/leave-balances', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrLeaveBalances(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-balances', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveBalance(req as any, res as any).catch(next);
  });
  app.patch('/api/hr/leave-balances/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    patch_hrLeaveBalance(req as any, res as any).catch(next);
  });

  app.get('/api/hr/leave-requests', requirePermissionAny(...HR_VIEW), async (req, res, next) => {
    get_hrLeaveRequests(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-requests', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveRequest(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-requests/:id/approve', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveRequestApprove(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-requests/:id/reject', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveRequestReject(req as any, res as any).catch(next);
  });
  app.post('/api/hr/leave-requests/:id/cancel', requirePermissionAny(...HR_ATTENDANCE_WRITE), async (req, res, next) => {
    post_hrLeaveRequestCancel(req as any, res as any).catch(next);
  });

  // Master-sheet import: DRY_RUN validates only, COMMIT writes every valid row
  // and one audit row in the same transaction. Both phases share the manage
  // gate; a view-only officer must not reach the import.
  app.post(
    '/api/hr/employees/import',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      post_hrEmployeeImport(req as any, res as any).catch(next);
    }
  );

  // Employee document vault. Metadata needs only the view grant; mutations
  // need the manage grant because a citizenship/PAN scan would otherwise
  // bypass the PII masking applied to the employee master. The content route
  // also admits hr-self-service, with the controller limiting it to documents
  // belonging to the signed-in account's own employee.
  app.get(
    '/api/employees/:id/documents',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrEmployeeDocuments(req as any, res as any).catch(next);
    }
  );
  // The body is the file itself, not multipart: a dedicated raw parser keeps
  // the 5 MiB ceiling off the global JSON limit and needs no extra dependency.
  app.post(
    '/api/employees/:id/documents',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    express.raw({ type: () => true, limit: HR_DOCUMENT_MAX_BYTES }),
    async (req, res, next) => {
      post_hrEmployeeDocument(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/employees/:id/documents/:documentId/content',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage', 'hr-self-service'),
    async (req, res, next) => {
      get_hrEmployeeDocumentContent(req as any, res as any).catch(next);
    }
  );
  app.delete(
    '/api/employees/:id/documents/:documentId',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      delete_hrEmployeeDocument(req as any, res as any).catch(next);
    }
  );

  // F1 Employee Profile. The payload is personal data end to end (father and
  // grandfather names, both addresses, the emergency address/relation, blood
  // group, medical, accident/case and the declaration), so a view-only HR
  // caller receives the masked shape and only the manage grant can write it.
  app.get(
    '/api/employees/:id/profile',
    requirePermissionAny('hr-employee-view', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_hrEmployeeProfile(req as any, res as any).catch(next);
    }
  );
  app.put(
    '/api/employees/:id/profile',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      put_hrEmployeeProfile(req as any, res as any).catch(next);
    }
  );

  // Phase 4 recruitment. A candidate's branch comes from its requisition and
  // an interview/offer from its candidate, so none of these routes accepts a
  // branch selector on write. List reads derive scope from the session.
  app.get(
    '/api/hr/recruitment/requisitions',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrRecruitmentRequisitions(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/requisitions',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrRecruitmentRequisition(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/recruitment/requisitions/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrRecruitmentRequisition(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/recruitment/candidates',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrRecruitmentCandidates(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/candidates',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrRecruitmentCandidate(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/recruitment/candidates/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrRecruitmentCandidate(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/recruitment/candidates/:id/resume',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrRecruitmentCandidateResume(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/candidates/:id/resume',
    requirePermissionAny(...HR_SALARY_WRITE),
    express.raw({ type: () => true, limit: HR_RECRUITMENT_RESUME_MAX_BYTES }),
    async (req, res, next) => {
      post_hrRecruitmentCandidateResume(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/recruitment/candidates/:id/resume/content',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      get_hrRecruitmentCandidateResumeContent(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/recruitment/interviews',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrRecruitmentInterviews(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/interviews',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrRecruitmentInterview(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/recruitment/interviews/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrRecruitmentInterview(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/recruitment/offers',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrRecruitmentOffers(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/offers',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrRecruitmentOffer(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/recruitment/offers/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrRecruitmentOffer(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/recruitment/candidates/:id/hire',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrRecruitmentHire(req as any, res as any).catch(next);
    }
  );

  // Phase 4 performance. A goal or feedback row inherits its branch from its
  // review cycle; the sign-off action is the only path to SIGNED_OFF and locks
  // every later cycle/goal/feedback write for that cycle.
  app.get(
    '/api/hr/performance/cycles',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrReviewCycles(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/performance/cycles',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrReviewCycle(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/performance/cycles/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrReviewCycle(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/performance/cycles/:id/sign-off',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrReviewCycleSignOff(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/performance/goals',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrGoals(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/performance/goals',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrGoal(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/performance/goals/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrGoal(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/performance/feedback',
    requirePermissionAny(...HR_VIEW),
    async (req, res, next) => {
      get_hrPerformanceFeedback(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/performance/feedback',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrPerformanceFeedback(req as any, res as any).catch(next);
    }
  );

  // Phase 4 onboarding/offboarding. The checklist derives custody from its
  // employee; asset and account items reconcile the real fixed-asset and user
  // rows. Completion is a separate irreversible action, so PATCH cannot set it.
  app.get(
    '/api/hr/lifecycle-checklists',
    requirePermissionAny(...HR_LIFECYCLE_READ),
    async (req, res, next) => {
      get_hrLifecycleChecklists(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/lifecycle-checklists',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrLifecycleChecklist(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/hr/lifecycle-checklists/:id',
    requirePermissionAny(...HR_LIFECYCLE_READ),
    async (req, res, next) => {
      get_hrLifecycleChecklist(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/hr/lifecycle-checklists/:id',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      patch_hrLifecycleChecklist(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/lifecycle-checklists/:id/complete',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrLifecycleComplete(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/lifecycle-checklists/:id/items',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrLifecycleItem(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/hr/lifecycle-checklists/:id/items/:itemId/complete',
    requirePermissionAny(...HR_SALARY_WRITE),
    async (req, res, next) => {
      post_hrLifecycleItemComplete(req as any, res as any).catch(next);
    }
  );
}
