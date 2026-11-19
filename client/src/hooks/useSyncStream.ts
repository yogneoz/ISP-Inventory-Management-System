/**
 * The real-time synchronization engine, lifted out of App.tsx.
 *
 * App.tsx used to carry ~200 lines of SSE lifecycle, domain-to-slice mapping,
 * burst debouncing and stream-gap polling between its bootstrap state and its
 * route table. The behaviour is unchanged; this hook owns it so the root only
 * supplies what the engine needs:
 *
 *   - the scope to fetch with (branch + fiscal year, via a ref so a scope change
 *     does not resubscribe the stream),
 *   - the server data version ref the root also uses for pre-hydration,
 *   - `refreshAllData` for an unknown domain or a reconnect gap,
 *   - `fetchSlice` for a targeted domain refresh,
 *   - the calendar/logout side effects the root owns.
 *
 * It returns `{ registerRefresh }`: monotonically increasing counters for the
 * paged registers, which screens receive as their refresh keys.
 */
import React from 'react';
import type { User } from '../types';
import {
  DOMAIN_REGISTER_KEYS,
  RegisterRefreshKey,
  SseDomainBurst,
  bumpAllRegisterRefresh,
  domainsTouchSerialRegister,
} from '../utils/registerRefreshDomains';
import { getSyncVersion, subscribeToSyncStream } from '../services/api/sync';
import { invalidateSerialRegister } from '../services/serialRegisterCache';
import { invalidateBranchStock } from '../services/branchStockCache';
import { invalidateExchangeDevices } from '../services/exchangeDeviceCache';
import { invalidateAvailableFixedAssets } from '../services/availableAssetsCache';
import { invalidateProcurementPending } from '../services/procurementPendingCache';
import { invalidateShipmentOverview } from '../services/shipmentOverviewCache';

/**
 * Map an SSE domain to the single bootstrap slice it invalidates. A known
 * domain re-fetches ONLY its slice (one small query); anything unrecognised
 * falls back to the full bootstrap, so an unknown server event can never leave
 * the UI stale.
 */
export const DOMAIN_STATE_KEYS: Record<string, string[]> = {
  // financialSummary is computed server-side from every domain below, so each
  // mutation that moves inventory value, AP, VAT, damage or trading totals
  // re-fetches the one aggregate slice (DF-05).
  STOCK: ['stock', 'damageRecords', 'financialSummary'],
  STOCK_OPERATIONS: ['stockOperations', 'stock', 'damageRecords', 'financialSummary'],
  // Serial edits can rewrite customer_device_records.device_serial, so that
  // paged register re-reads via its counter rather than a bootstrap slice.
  SERIALS: [],
  // PROCUREMENT also covers purchase returns.
  PROCUREMENT: ['purchaseOrders', 'purchaseInvoices', 'suppliers', 'purchaseReturns', 'stock', 'financialSummary'],
  SALES: ['salesReturns', 'stock', 'damageRecords', 'financialSummary'],
  SHIPMENTS: ['stock', 'financialSummary'],
  MASTER_DATA: ['branches', 'suppliers', 'locations', 'companyProfile', 'productGroups'],
  CATEGORIES: ['categories'],
  PRODUCTS: ['products', 'stock'],
  FISCAL: ['fiscalYears', 'financialSummary'],
  USERS: ['users'],
  CUSTOMER_DEVICES: ['stock'],
  ASSETS: [],
  APPROVALS: ['approvalRequests'],
  RECALC: ['stock', 'financialSummary'],
  COMPANY_PROFILE: ['companyProfile'],
  AUDIT: ['auditLogs'],
  PERMISSIONS: ['permissionsMatrix'],
  SETTINGS: ['appSettings'],
  BS_CALENDAR: [],
};

export interface SyncStreamOptions {
  branchId: string;
  currentUser: User | null;
  /** Always-fresh scope, read at flush time (never captured by the subscription). */
  scopeRef: React.MutableRefObject<{ branchId: string; fiscalYearId: string | undefined }>;
  /** The root also mirrors the server's dataVersion for pre-hydration. */
  serverDataVersionRef: React.MutableRefObject<number | undefined>;
  refreshAllData: () => void;
  fetchSlice: (key: string, branchId: string, fiscalYearId: string | undefined) => Promise<unknown>;
  onBsCalendarChanged: () => void;
  onLogout: () => void;
}

export function useSyncStream(options: SyncStreamOptions): {
  registerRefresh: Record<RegisterRefreshKey, number>;
  bumpAll: () => void;
} {
  const [registerRefresh, setRegisterRefresh] = React.useState<Record<RegisterRefreshKey, number>>({
    serialLog: 0,
    purchaseOrders: 0,
    purchaseInvoices: 0,
    consumableRegister: 0,
    returnsRegister: 0,
    salesInvoices: 0,
    shipments: 0,
    customerDevices: 0,
    fixedAssets: 0,
    transactionLog: 0,
  });

  // Latest callbacks without resubscribing the stream when a parent re-renders.
  const latest = React.useRef(options);
  React.useEffect(() => {
    latest.current = options;
  }, [options]);

  const { branchId, currentUser } = options;

  React.useEffect(() => {
    let debounceTimer: any = null;
    let versionPollTimer: any = null;
    // Coalesces the burst's domains across the debounce window and resolves it
    // to a targeted or full-bootstrap plan.
    const burst = new SseDomainBurst();
    const handleSyncEvent = (event: any) => {
      const api = latest.current;
      // CONNECTED is the stream's handshake, not a mutation.
      if (event?.type === 'CONNECTED') {
        // Reconnect gap-fill: a newer dataVersion means mutations happened
        // while the stream was down. On the first connect the ref already
        // holds the bootstrap's version, so no redundant refresh fires.
        if (
          typeof event.dataVersion === 'number' &&
          typeof api.serverDataVersionRef.current === 'number' &&
          event.dataVersion > api.serverDataVersionRef.current
        ) {
          api.serverDataVersionRef.current = event.dataVersion;
          api.refreshAllData();
        }
        return;
      }
      if (event && typeof event.dataVersion === 'number') {
        api.serverDataVersionRef.current = event.dataVersion;
      }
      burst.observe(event?.domain);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const plan = burst.flush((d) => Boolean(DOMAIN_STATE_KEYS[d]));
        if (plan.mode === 'targeted') {
          const domains = plan.domains;
          // A calendar seed/repair changes the AD<->BS mapping every screen
          // converts with; RECALC regenerates the server's lookup rows too.
          if (domains.includes('BS_CALENDAR') || domains.includes('RECALC')) {
            api.onBsCalendarChanged();
          }
          // Any serial_log writer makes the shared register stale for every
          // open stock/dispatch gate, and the same domains write inventory_stock.
          if (domainsTouchSerialRegister(domains)) {
            invalidateSerialRegister();
            invalidateBranchStock();
          }
          // CPE flows and asset deployments/restocks change the Device Exchange list.
          if (domains.includes('CUSTOMER_DEVICES') || domains.includes('ASSETS')) {
            invalidateExchangeDevices();
          }
          // Asset creation/deployment and recalculation change the assignable units.
          if (domains.includes('ASSETS') || domains.includes('RECALC')) {
            invalidateAvailableFixedAssets();
          }
          // Procurement and shipment events change the open-PO set and unpaid total.
          if (domains.includes('PROCUREMENT') || domains.includes('SHIPMENTS')) {
            invalidateProcurementPending();
          }
          // Shipments are served by their own bounded reads; approvals move a
          // transfer's status.
          if (domains.includes('SHIPMENTS') || domains.includes('APPROVALS')) {
            invalidateShipmentOverview();
          }
          // Bump any paged registers these domains mutate.
          setRegisterRefresh((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const d of domains) {
              for (const reg of DOMAIN_REGISTER_KEYS[d] || []) {
                next[reg] = prev[reg] + 1;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          // Targeted: re-fetch only the affected bootstrap slice(s).
          const { branchId: scopeBranch, fiscalYearId } = api.scopeRef.current;
          Promise.all(
            domains
              .flatMap((d) => DOMAIN_STATE_KEYS[d])
              .filter((key, idx, all) => all.indexOf(key) === idx)
              .map((key) => api.fetchSlice(key, scopeBranch, fiscalYearId))
          ).catch(() => api.refreshAllData());
        } else {
          // Unknown domain or mixed burst: full bootstrap. refreshAllData
          // bumps every paged-register counter itself.
          api.refreshAllData();
        }
      }, 250);
    };

    // Stream-gap polling: while SSE is down, poll dataVersion every 30 s.
    const startVersionPolling = () => {
      if (versionPollTimer || !currentUser) return;
      versionPollTimer = setInterval(async () => {
        try {
          const serverVersion = await getSyncVersion();
          const api = latest.current;
          if (
            typeof serverVersion === 'number' &&
            typeof api.serverDataVersionRef.current === 'number' &&
            serverVersion > api.serverDataVersionRef.current
          ) {
            api.serverDataVersionRef.current = serverVersion;
            api.refreshAllData();
          }
        } catch (_err) {
          // Server unreachable — the SSE backoff loop keeps trying.
        }
      }, 30000);
    };
    const stopVersionPolling = () => {
      if (versionPollTimer) {
        clearInterval(versionPollTimer);
        versionPollTimer = null;
      }
    };

    // Multi-tab relay: another tab may have received the event first.
    const onRelayedLogout = () => latest.current.onLogout();
    window.addEventListener('inventory_sync_logout', onRelayedLogout);

    const unsubscribe = subscribeToSyncStream(handleSyncEvent, (connected) => {
      if (connected) stopVersionPolling();
      else if (currentUser) startVersionPolling();
    });

    return () => {
      stopVersionPolling();
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('inventory_sync_logout', onRelayedLogout);
      unsubscribe();
    };
  }, [branchId, currentUser]);

  /** A full refresh bumps every paged-register counter (bootstrap slices do not cover them). */
  const bumpAll = () => setRegisterRefresh((prev) => bumpAllRegisterRefresh(prev));

  return { registerRefresh, bumpAll };
}
