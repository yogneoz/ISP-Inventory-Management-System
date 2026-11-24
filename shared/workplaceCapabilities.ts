/**
 * MyWorkplace capabilities — the v2 vocabulary the app navigates by.
 *
 * The ERP keeps its 70 matrix operations: they are what gates a route. The app
 * needs a smaller, stable list ("punch", "my van", "dispatch") that a home
 * screen can assemble itself from, and a Branch Lead can hold two named bundles
 * without a new role. This file is the single mapping between the two, so the
 * catalogue cannot drift per screen.
 *
 * A capability is a *view* of operations, never a second permission system: it
 * grants nothing by itself. `workplaceCapabilitiesFor` only reports which of
 * these the caller's already-resolved operations already open.
 */

export interface WorkplaceCapability {
  /** The wire name the app switches on. */
  id: string;
  /** The module it unlocks, in the design's words. */
  module: string;
  /** Existing permission-matrix operations that imply it. */
  operations: string[];
}

export const WORKPLACE_CAPABILITIES: readonly WorkplaceCapability[] = [
  {
    id: 'attendance.punch',
    module: 'Today',
    operations: ['hr-self-service'],
  },
  {
    id: 'ess.view',
    module: 'My HR',
    operations: ['hr-self-service'],
  },
  {
    id: 'claims.submit',
    module: 'Claims and Overtime',
    operations: ['hr-self-service'],
  },
  {
    id: 'jobs.execute',
    module: 'My Work Orders',
    operations: ['field-work-order'],
  },
  {
    id: 'stock.van',
    module: 'My Van',
    operations: ['employee-stock-view', 'stock-out'],
  },
  {
    id: 'dispatch.assign',
    module: 'Dispatch Board',
    operations: ['field-work-order'],
  },
  {
    id: 'roster.manage',
    module: 'Roster',
    operations: ['hr-attendance-manage'],
  },
  {
    id: 'approve.attendance_ot',
    module: 'Approvals',
    operations: ['hr-attendance-manage'],
  },
  {
    id: 'approve.expense',
    module: 'Approvals',
    operations: ['hr-attendance-manage'],
  },
  {
    id: 'audit.stock',
    module: 'Stock Audit',
    operations: ['employee-stock-view'],
  },
] as const;

/** The capability ids the given operations open, in catalogue order. */
export function workplaceCapabilitiesFor(operations: readonly string[]): string[] {
  const held = new Set(operations);
  return WORKPLACE_CAPABILITIES.filter((capability) =>
    capability.operations.some((operation) => held.has(operation))
  ).map((capability) => capability.id);
}

/** The operations a delegation of this capability must cover. */
export function operationsForCapability(capabilityId: string): string[] {
  const found = WORKPLACE_CAPABILITIES.find((capability) => capability.id === capabilityId);
  return found ? [...found.operations] : [];
}
