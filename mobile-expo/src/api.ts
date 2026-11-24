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
  } catch (err: any) {
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
}

// The mobile contract names the session token `accessToken` (the web login
// calls it `token`); the app keeps the contract's word.
export const login = (email: string, password: string) =>
  call<LoginResult>('/api/v1/auth/login', { body: { email, password } });

export const profile = (token: string) => call<any>('/api/v1/profile', { token });

export const workplaceBootstrap = (token: string) => call<any>('/api/v1/workplace/bootstrap', { token });

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

export const reAuth = (token: string, password: string) =>
  call<{ reAuthToken: string; expiresInSeconds: number }>('/api/v1/auth/re-auth', {
    token,
    body: { password },
  });

export const payslips = (token: string, reAuthToken: string) =>
  call<any>('/api/v1/payslips', { token, headers: { 'x-reauth-token': reAuthToken } });
