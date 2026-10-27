/**
 * ASSET-1: one shared reader for the fixed-asset overview.
 *
 * The dashboard KPI and any other consumer that only needs totals read
 * `/api/fixed-assets/overview` through this hook, so none of them has to hold
 * the whole table. The server applies the session's branch scope and runs the
 * same shared depreciation rule as the registers.
 */
import { useEffect, useRef, useState } from 'react';
import type { FixedAssetOverview } from '../types';
import { api } from './api';
import type { FixedAssetOverviewParams } from './api/inventory';

export interface FixedAssetOverviewState {
  overview: FixedAssetOverview | null;
  loading: boolean;
  error: string;
  retry: () => void;
}

export function useFixedAssetOverview(
  params: FixedAssetOverviewParams,
  refreshToken = 0
): FixedAssetOverviewState {
  const [overview, setOverview] = useState<FixedAssetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const requestSeq = useRef(0);

  const { branchId, query, category, asOf, byBranch, groupBy, categories } = params;

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    api
      .getFixedAssetOverview({ branchId, query, category, asOf, byBranch, groupBy, categories })
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setOverview(result);
        setLoading(false);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setError(err?.message || 'Could not load the fixed-asset totals.');
        setLoading(false);
      });
  }, [branchId, query, category, asOf, byBranch, groupBy, categories, refreshToken, retryToken]);

  return { overview, loading, error, retry: () => setRetryToken((n) => n + 1) };
}
