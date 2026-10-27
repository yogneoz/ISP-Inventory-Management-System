/**
 * The fixed-asset depreciation rule lives in shared/depreciation.ts (ASSET-1)
 * so the server's statement/closing aggregates run the same function the
 * registers do. Existing client imports keep this path.
 */
export * from '../../../shared/depreciation';
