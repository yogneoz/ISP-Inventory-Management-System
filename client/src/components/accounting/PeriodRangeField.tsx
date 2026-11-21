/**
 * The accounting registers import the shared period field through this path.
 * The control itself now lives in `components/common` so the inventory and
 * sales registers use the same one; re-exported here for the existing imports.
 */
export { PeriodRangeField, usePeriodRangeFilter, default } from '../common/PeriodRangeField';
export type { PeriodRange, PeriodRangeFilter } from '../common/PeriodRangeField';
