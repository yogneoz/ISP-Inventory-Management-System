/**
 * Balance Sheet register — assets, liabilities and equity as of the selected
 * date, posted from the ledger under the `gl-view` gate.
 */
import React, { useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { BalanceSheetResponse, StatementGroupBlock } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { BalanceSheetView } from '../../components/accounting/BalanceSheetView';
import {
  ComparativeToggle,
  StatementFormatToggle,
} from '../../components/accounting/StatementViewControls';
import type { StatementFormat } from '../../components/accounting/statementTFormat';
import { priorBalanceSheetDate } from '../../utils/comparativePeriod';
import { StatementGroupDrilldown } from '../../components/accounting/StatementGroupDrilldown';

export const BalanceSheetRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
  fiscalYearStartAD,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<BalanceSheetResponse | null>(null);
  const [openGroup, setOpenGroup] = useState<StatementGroupBlock | null>(null);
  const [format, setFormat] = useState<StatementFormat>('NORMAL');
  const [comparative, setComparative] = useState(false);
  const [prior, setPrior] = useState<BalanceSheetResponse | null>(null);
  const [priorLoading, setPriorLoading] = useState(false);
  const [priorError, setPriorError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-balance-sheet');
  const isVisible = useTabActive('accounting-balance-sheet') && scope.allowed;

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
  }, [data, format, comparative]);

  return (
    <AccountingRegisterShell
      title="Balance Sheet"
      description="Assets, liabilities and equity as of the selected date, from posted journal lines."
      icon={<Landmark className="h-5 w-5 text-indigo-500" />}
      registerName="balance sheet"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      headerActions={
        <>
          <ComparativeToggle enabled={comparative} onChange={setComparative} />
          <StatementFormatToggle format={format} onChange={setFormat} />
        </>
      }
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
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
