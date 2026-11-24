/**
 * Thin client for the portal's documented mobile contract (`docs/contracts/mobile-v1.md`).
 *
 * Every call here is a route the server already serves under `/api/v1` and the
 * contract-parity gate pins — this app invents no endpoint, and it never talks
 * to the database. The base URL is the portal on the LAN; set
 * `EXPO_PUBLIC_API_BASE` (see `.env.example`) to point at it.
 */
const API_BASE = (process.env.EXPO_PUBLIC_API_BASE || 'http://10.10.2.50:3000').replace(/\/+$/, '');

export const apiBase = API_BASE;

/**
 * The device binding the contract names. One Expo Go install is one device for
 * the server (a punch, a login and a revoked-phone pull all key off it), so the
 * value is fixed per build rather than random per request: a random one would
 * register a new device on every cold start.
 */
export const DEVICE_ID = 'expo-workplace-android';

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  Object.assign(headers, options.headers || {});

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(
      `Cannot reach the portal at ${API_BASE}. Same Wi-Fi as the PC, and the server on port 3000?`,
      0,
      'NETWORK'
    );
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new ApiError(
      String(payload?.message || `Request failed (${response.status}).`),
      response.status,
      typeof payload?.code === 'string' ? payload.code : null
    );
  }
  return payload as T;
}

export interface WorkOrder {
  id: string;
  workOrderNo: string;
  kind: string;
  status: string;
  customerId: string;
  customerName: string | null;
  scheduledDateAD: string;
  notes: string | null;
  rowVersion: number;
}

export interface EvidenceRow {
  id?: string;
  evidenceId?: string;
  workOrderId?: string;
  kind: 'PHOTO' | 'SIGNATURE';
  contentType: string;
  byteSize: number;
  sha256: string;
  caption: string | null;
  capturedAt: string;
}

export interface Holding {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  updatedAt: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  userId: string;
  email: string;
  role: string;
  employeeId: string;
  employeeName?: string;
  branchCode?: string;
  branchScope?: string;
  workplaceCapabilities?: string[];
}

export interface AttendanceRecord {
  id: string;
  attendanceDateAD: string;
  attendanceDateBS: string | null;
  shiftName: string | null;
  status: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  overtimeHours: number;
  notes: string | null;
}

export interface AttendancePayload {
  windowStartAD: string;
  windowEndAD: string;
  windowDays: number;
  summary: {
    totalDays: number;
    presentDays: number;
    absentDays: number;
    leaveDays: number;
    halfDays: number;
    overtimeHours: number;
  };
  records: AttendanceRecord[];
}

export interface LeaveBalance {
  id: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  entitlementDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface LeaveRequest {
  id: string;
  requestNo: string;
  leaveTypeName: string;
  startDateAD: string;
  endDateAD: string;
  daysCount: number;
  reason: string | null;
  status: string;
}

export interface ApprovalsPayload {
  claims: any[];
  punches: any[];
  delegations: any[];
  counts: { claims: number; punches: number };
}

export interface BootstrapPayload {
  serverTimeEpochMs: number;
  workplaceCapabilities: string[];
  punchState: string;
  shiftWindow: string;
  unreadNotices: number;
  pendingApprovals: number;
  vanLocation: string | null;
  needsAttention: number;
  announcements: {
    id: string;
    title: string;
    summary: string;
    category: string;
    publishedAt: string;
    isUrgent: boolean;
  }[];
  geofence: { configured: boolean; latitude: number; longitude: number; radiusMeters: number } | null;
  todayAttendance: { checkInTime: string | null; checkOutTime: string | null; status: string } | null;
}

// The mobile contract names the session token `accessToken` (the web login
// calls it `token`); the app keeps the contract's word.
export const login = (email: string, password: string) =>
  call<LoginResult>('/api/v1/auth/login', { body: { email, password, deviceId: DEVICE_ID } });

export const logout = (token: string, refreshToken: string) =>
  call<{ loggedOut: boolean }>('/api/v1/auth/logout', { token, body: { refreshToken } });

export const registerDevice = (token: string, appVersion: string) =>
  call<{ registered: boolean; deviceId: string; boundAt: string }>('/api/v1/devices/register', {
    token,
    body: { deviceId: DEVICE_ID, platform: 'android', appVersion, idempotencyKey: `device-${DEVICE_ID}` },
  });

export const profile = (token: string) => call<any>('/api/v1/profile', { token });

export const workplaceBootstrap = (token: string) =>
  call<BootstrapPayload>('/api/v1/workplace/bootstrap', { token });

export const jobs = (token: string) => call<{ jobs: WorkOrder[]; count: number }>('/api/v1/workplace/jobs', { token });

export const stock = (token: string) =>
  call<{ vanLocation: string | null; holdings: Holding[]; count: number }>('/api/v1/workplace/stock', { token });

export const evidenceFor = (token: string, jobId: string) =>
  call<{ workOrderId: string; evidence: EvidenceRow[]; count: number }>(
    `/api/v1/workplace/jobs/${encodeURIComponent(jobId)}/evidence`,
    { token }
  );

export const uploadEvidence = (
  token: string,
  jobId: string,
  input: { kind: 'PHOTO' | 'SIGNATURE'; contentType: string; dataBase64: string; caption?: string }
) =>
  call<EvidenceRow & { evidenceId: string; inserted: boolean; count: number }>(
    `/api/v1/workplace/jobs/${encodeURIComponent(jobId)}/evidence`,
    {
      token,
      body: {
        kind: input.kind,
        contentType: input.contentType,
        dataBase64: input.dataBase64,
        caption: input.caption || '',
        capturedAtEpochMs: Date.now(),
      },
    }
  );

/** One visit closes through its `baseVersion`, so a second phone cannot overwrite. */
export const completeJob = (
  token: string,
  jobId: string,
  input: { baseVersion: number; notes: string; serialUsed?: string }
) =>
  call<{ workOrderId: string; resultStatus: string; message: string; baseVersion: number }>(
    `/api/v1/workplace/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      token,
      body: {
        baseVersion: input.baseVersion,
        notes: input.notes,
        serialUsed: input.serialUsed || undefined,
        idempotencyKey: `complete-${jobId}-${input.baseVersion}`,
      },
    }
  );

export const attendance = (token: string) => call<AttendancePayload>('/api/v1/attendance', { token });

export const leaves = (token: string) =>
  call<{ balances: LeaveBalance[]; requests: LeaveRequest[] }>('/api/v1/leaves', { token });

export const requestLeave = (
  token: string,
  input: { leaveTypeId: string; startDateAD: string; endDateAD: string; reason?: string }
) => call<LeaveRequest>('/api/v1/leaves/requests', { token, body: input });

export const cancelLeave = (token: string, id: string) =>
  call<LeaveRequest>(`/api/v1/leaves/requests/${encodeURIComponent(id)}/cancel`, { token, body: {} });

export const reviewLeave = (token: string, id: string, approve: boolean, note?: string) =>
  call<LeaveRequest>(`/api/v1/leaves/requests/${encodeURIComponent(id)}/review`, {
    token,
    body: { approve, note: note || undefined },
  });

export const approvals = (token: string) => call<ApprovalsPayload>('/api/v1/workplace/approvals', { token });

export const decideApproval = (
  token: string,
  kind: 'EXPENSE_CLAIM' | 'PUNCH',
  id: string,
  approve: boolean,
  note?: string
) =>
  call<any>(`/api/v1/workplace/approvals/${kind}/${encodeURIComponent(id)}`, {
    token,
    body: { approve, note: note || undefined },
  });

export const submitClaim = (
  token: string,
  input: { category: string; amount: number; description: string; ticketCode?: string; receiptAttached?: boolean }
) =>
  call<any>('/api/v1/workplace/claims', {
    token,
    body: {
      claimId: `hr-claim-${Date.now()}`,
      category: input.category,
      amount: input.amount,
      currency: 'NPR',
      ticketCode: input.ticketCode || undefined,
      description: input.description,
      receiptAttached: Boolean(input.receiptAttached),
      idempotencyKey: `claim-${DEVICE_ID}-${Date.now()}`,
    },
  });

export const claimById = (token: string, id: string) =>
  call<any>(`/api/v1/workplace/claims/${encodeURIComponent(id)}`, { token });

/** One geofenced punch. The server judges the fence; the app never decides. */
export const punch = (
  token: string,
  input: { action: 'CLOCK_IN' | 'CLOCK_OUT'; attendanceDateAD: string; latitude: number; longitude: number; accuracyMeters?: number }
) =>
  call<any>('/api/v1/workplace/attendance/punch', {
    token,
    body: {
      action: input.action,
      attendanceDateAd: input.attendanceDateAD,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      deviceId: DEVICE_ID,
      deviceTimeEpochMs: Date.now(),
      idempotencyKey: `punch-${DEVICE_ID}-${input.action}-${input.attendanceDateAD}-${Date.now()}`,
    },
  });

export const reAuth = (token: string, password: string) =>
  call<{ reAuthToken: string; expiresInSeconds: number }>('/api/v1/auth/re-auth', {
    token,
    body: { password },
  });

export const payslips = (token: string, reAuthToken: string) =>
  call<{ payslips: any[] }>('/api/v1/payslips', { token, headers: { 'x-reauth-token': reAuthToken } });

export const documents = (token: string, reAuthToken: string) =>
  call<{ summary: any; documents: any[] }>('/api/v1/documents', { token, headers: { 'x-reauth-token': reAuthToken } });

export const sensitiveProfile = (token: string, reAuthToken: string) =>
  call<any>('/api/v1/hr/me/sensitive', { token, headers: { 'x-reauth-token': reAuthToken } });

export const updateContact = (
  token: string,
  input: { phone: string; emergencyContactName: string; emergencyContactPhone: string }
) =>
  call<any>('/api/v1/employees/me/contact', { token, method: 'PUT', body: input });
