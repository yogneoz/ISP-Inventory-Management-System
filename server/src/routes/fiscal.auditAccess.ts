/**
 * Late-bound access to the shared logAuditEvent for route modules that must
 * not import app.ts directly (import-cycle avoidance). app.ts assigns the
 * real logger at composition time, before registerAllRoutes runs.
 */
export type LogAuditEventFn = (
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string,
  client?: any
) => any;

let impl: LogAuditEventFn = () => {
  throw new Error('logAuditEvent not initialized — app.ts must call setLogAuditEvent before routes run.');
};

export function setLogAuditEvent(fn: LogAuditEventFn): void {
  impl = fn;
}

export function logAuditEvent(
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string,
  client?: any
): any {
  return impl(req, action, module, details, overrideBranchId, client);
}
