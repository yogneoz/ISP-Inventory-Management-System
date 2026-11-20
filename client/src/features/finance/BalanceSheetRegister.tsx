/**
 * Balance Sheet register — assets, liabilities and equity as of the selected
 * date, posted from the ledger under the `gl-view` gate. The Movement view is
 * an additive opening/period/closing presentation from its own server read;
 * the Closing view keeps the statutory point-in-time contract.
 */
import React, { useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  BalanceSheetMovementResponse,
  BalanceSheetResponse,
  StatementGroupBlock,
} from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { BalanceSheetView } from '../../components/accounting/BalanceSheetView';
import { BalanceSheetMovementView } from '../../components/accounting/BalanceSheetMovementView';
import {
  BalanceSheetViewToggle,
  ComparativeToggle,
  StatementFormatToggle,
} from '../../components/accounting/StatementViewControls';
import type {
  BalanceSheetReportView,
} from '../../components/accounting/StatementViewControls';
import type { StatementFormat } from '../../components/accounting/statementTFormat';
import { priorBalanceSheetDate } from '../../utils/comparativePeriod';
import { StatementGroupDrilldown } from '../../components/accounting/StatementGroupDrilldown';
import { useBootstrapData } from '../../contexts/AppProviders';

export const BalanceSheetRegister: React.FC<AccountingScreenProps> = ({
  dateMode,
  currentUser,
  fiscalYearStartAD,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<BalanceSheetResponse | null>(null);
  const [movement, setMovement] = useState<BalanceSheetMovementResponse | null>(null);
  const [openGroup, setOpenGroup] = useState<StatementGroupBlock | null>(null);
  const [view, setView] = useState<BalanceSheetReportView>('CLOSING');
  const [format, setFormat] = useState<StatementFormat>('NORMAL');
  const [comparative, setComparative] = useState(false);
  const [periodStart, setPeriodStart] = useState(fiscalYearStartAD || '');
  const [prior, setPrior] = useState<BalanceSheetResponse | null>(null);
  const [priorLoading, setPriorLoading] = useState(false);
  const [priorError, setPriorError] = useState('');
  const [loading, setLoading] = useState(false);
  const [movementLoading, setMovementLoading] = useState(false);
  const [error, setError] = useState('');
  const [movementError, setMovementError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-balance-sheet');
  const isVisible = useTabActive('accounting-balance-sheet') && scope.allowed;

  // The fiscal-year start is the natural default opening point for a movement
  // view. Do not overwrite a start the user has explicitly changed or cleared.
  useEffect(() => {
    setPeriodStart((current) => current || fiscalYearStartAD || '');
  }, [fiscalYearStartAD]);

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getBalanceSheet(scope.query)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the balance sheet.');
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, scope.asOfDate, activationKey, reloadKey]);

  useEffect(() => {
    if (!isVisible || view !== 'MOVEMENT') return;
    let live = true;
    setMovementLoading(true);
    setMovementError('');
    setMovement(null);
    void api.getBalanceSheetMovement({
      branchId: scope.query.branchId,
      to: scope.asOfDate,
      ...(periodStart ? { from: periodStart } : {}),
    })
      .then((next) => {
        if (live) setMovement(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setMovement(null);
        setMovementError(err?.message || 'Failed to load the balance-sheet movement.');
      })
      .finally(() => {
        if (live) setMovementLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, view, scope.branchId, scope.asOfDate, periodStart, activationKey, reloadKey]);

  const priorAsOf = data ? priorBalanceSheetDate(fiscalYearStartAD, data.asOf) : null;

  useEffect(() => {
    if (!comparative || !data) {
      setPrior(null);
      setPriorError('');
      setPriorLoading(false);
      return;
    }
    if (!priorAsOf) {
      setPrior(null);
      setPriorError('The prior balance-sheet date could not be derived from this scope.');
      setPriorLoading(false);
      return;
    }
    let live = true;
    setPriorLoading(true);
    setPriorError('');
    setPrior(null);
    void api.getBalanceSheet({ branchId: scope.query.branchId, to: priorAsOf })
      .then((next) => {
        if (live) setPrior(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setPrior(null);
        setPriorError(err?.message || 'The prior balance sheet could not be loaded.');
      })
      .finally(() => {
        if (live) setPriorLoading(false);
      });
    return () => {
      live = false;
    };
  }, [comparative, data, priorAsOf, scope.query.branchId]);

  // A refreshed statement or a new presentation closes the old drill-down so
  // it cannot be compared with figures from a different view.
  useEffect(() => {
    setOpenGroup(null);
  }, [data, format, comparative, view, periodStart]);

  const activeLoading = view === 'MOVEMENT' ? movementLoading : loading;
  const activeError = view === 'MOVEMENT' ? movementError : error;

  return (
    <AccountingRegisterShell
      title="Balance Sheet"
      description={
        view === 'MOVEMENT'
          ? 'Opening, period and closing balances from posted journal lines.'
          : 'Assets, liabilities and equity as of the selected date, from posted journal lines.'
      }
      icon={<Landmark className="h-5 w-5 text-indigo-500" />}
      registerName={view === 'MOVEMENT' ? 'balance-sheet movement' : 'balance sheet'}
      scope={scope}
      dateMode={dateMode}
      periodStart={
        view === 'MOVEMENT' ? { value: periodStart, onChange: setPeriodStart } : undefined
      }
      loading={activeLoading}
      error={activeError}
      headerActions={
        <>
          <BalanceSheetViewToggle view={view} onChange={setView} />
          {view === 'CLOSING' && (
            <>
              <ComparativeToggle enabled={comparative} onChange={setComparative} />
              <StatementFormatToggle format={format} onChange={setFormat} />
            </>
          )}
        </>
      }
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {view === 'MOVEMENT' ? (
        movement ? (
          <BalanceSheetMovementView data={movement} />
        ) : (
          !movementLoading &&
          !movementError && <RegisterEmpty message="No balance-sheet movement has been loaded yet." />
        )
      ) : data ? (
        <>
          <BalanceSheetView
            data={data}
            format={format}
            comparative={comparative}
            prior={prior}
            priorLoading={priorLoading}
            priorError={priorError}
            priorAsOf={priorAsOf}
            onOpenGroup={setOpenGroup}
          />
          {openGroup && (
            <StatementGroupDrilldown
              group={openGroup}
              statement="BALANCE_SHEET"
              branchId={data.branchId}
              from={null}
              to={data.asOf}
              onClose={() => setOpenGroup(null)}
            />
          )}
        </>
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No balance sheet has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default BalanceSheetRegister;
