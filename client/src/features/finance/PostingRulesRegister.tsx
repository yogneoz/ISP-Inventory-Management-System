/**
 * Posting Rules & Account Control.
 *
 * This is the readable contract between operational documents and the ledger.
 * The debit/credit shape comes from `postingRuleCatalog`; the account beside
 * every role comes from the live posting-defaults endpoint, so a remapped
 * ledger is reflected immediately. The control view explains control accounts
 * and shows the same GL / subledger tie-out the posting service writes.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  GitBranch,
  Layers,
  ShieldCheck,
} from 'lucide-react';
import { KpiStrip, KPI_TONE_TEXT } from '../../components/common/KpiStrip';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import { normalizeChartHealth } from '../../utils/chartHealth';
import type {
  AccountingAccount,
  AccountingSubledger,
  ChartHealth,
  ControlReconciliationResponse,
  PostingDefault,
} from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { StatusPill } from '../../components/accounting/StatementPrimitives';
import { money } from '../../components/accounting/statementFormat';
import {
  POSTING_RULE_GROUPS,
  POSTING_RULES,
  type PostingRule,
  type PostingRuleLine,
} from './postingRuleCatalog';
import { useBootstrapData } from '../../contexts/AppProviders';

interface RulesState {
  defaults: Record<string, PostingDefault>;
  accounts: AccountingAccount[];
  subledgers: AccountingSubledger[];
  reconciliations: ControlReconciliationResponse[];
  reconciliationErrors: Record<string, string>;
  health: ChartHealth | null;
}

const EMPTY_STATE: RulesState = {
  defaults: {},
  accounts: [],
  subledgers: [],
  reconciliations: [],
  reconciliationErrors: {},
  health: null,
};

type RulesTab = 'RULES' | 'CONTROL';

const panel =
  'rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const panelHeader = 'border-b border-slate-200 px-4 py-3 dark:border-slate-800';
const sectionLabel =
  'text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500';
const subtle = 'text-[11px] leading-5 text-slate-500 dark:text-slate-400';
const chip =
  'inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300';

function roleAccounts(
  line: PostingRuleLine,
  defaults: Record<string, PostingDefault>
): Array<{ role: string; account: PostingDefault | undefined }> {
  return line.roles.map((role) => ({ role, account: defaults[role] }));
}

function lineMissing(line: PostingRuleLine, defaults: Record<string, PostingDefault>): boolean {
  if (line.optional) return false;
  const mapped = line.roles.filter((role) => Boolean(defaults[role]));
  return line.oneOf ? mapped.length === 0 : mapped.length !== line.roles.length;
}

function ruleReady(rule: PostingRule, defaults: Record<string, PostingDefault>): boolean {
  return !rule.lines.some((line) => lineMissing(line, defaults));
}

function uniqueRuleRoles(): string[] {
  return Array.from(new Set(POSTING_RULES.flatMap((rule) => rule.lines.flatMap((line) => line.roles))));
}

const SideBadge: React.FC<{ side: PostingRuleLine['side'] }> = ({ side }) => (
  <span
    className={`inline-flex w-12 justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
      side === 'DEBIT'
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
    }`}
  >
    {side === 'DEBIT' ? 'DEBIT' : 'CREDIT'}
  </span>
);

const RuleExplorer: React.FC<{
  state: RulesState;
  selectedId: string;
  onSelect: (id: string) => void;
}> = ({ state, selectedId, onSelect }) => {
  const selected = POSTING_RULES.find((rule) => rule.id === selectedId) || POSTING_RULES[0];
  const selectedMissing = selected.lines.filter((line) => lineMissing(line, state.defaults));
  const ready = selectedMissing.length === 0;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
      <aside className={`${panel} overflow-hidden`}>
        <div className={panelHeader}>
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Posting processes</h3>
          <p className={subtle}>Select a document to see its debit and credit shape.</p>
        </div>
        <div className="max-h-[720px] overflow-y-auto p-2">
          {POSTING_RULE_GROUPS.map((group) => {
            const rules = POSTING_RULES.filter((rule) => rule.group === group.id);
            if (rules.length === 0) return null;
            return (
              <div key={group.id} className="mb-3 last:mb-0">
                <p className={`px-2 pb-1 ${sectionLabel}`}>{group.label}</p>
                {rules.map((rule) => {
                  const selectedRule = rule.id === selected.id;
                  const ruleNeedsMapping = !ruleReady(rule, state.defaults);
                  return (
                    <button
                      key={rule.id}
                      type="button"
                      onClick={() => onSelect(rule.id)}
                      className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold transition ${
                        selectedRule
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span>{rule.name}</span>
                      {ruleNeedsMapping && (
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            selectedRule ? 'bg-amber-300' : 'bg-amber-500'
                          }`}
                          title="One or more roles are not mapped"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </aside>

      <div className={`${panel} overflow-hidden`}>
        <div className={`${panelHeader} flex flex-wrap items-start justify-between gap-2`}>
          <div>
            <p className={sectionLabel}>{selected.source}</p>
            <h3 className="mt-0.5 text-sm font-bold text-slate-900 dark:text-white">{selected.name}</h3>
            <p className={`mt-1 max-w-3xl ${subtle}`}>{selected.description}</p>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${
              ready
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
            }`}
          >
            {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {ready ? 'Ready to post' : 'Needs a mapping'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2">Side</th>
                <th className="px-4 py-2">Rule line</th>
                <th className="px-4 py-2">Posting role</th>
                <th className="px-4 py-2">Live account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {selected.lines.map((line, index) => {
                const missing = lineMissing(line, state.defaults);
                const resolved = roleAccounts(line, state.defaults);
                const mapped = resolved.filter(({ account }) => Boolean(account));
                const shown = line.oneOf && mapped.length > 0 ? mapped : resolved;
                return (
                  <tr key={`${selected.id}-${index}`} className="align-top">
                    <td className="px-4 py-2.5">
                      <SideBadge side={line.side} />
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-slate-800 dark:text-slate-200">{line.label}</p>
                      {line.condition && (
                        <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                          {line.condition}
                        </p>
                      )}
                      {line.optional && (
                        <p className="mt-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                          Conditional line
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {line.roles.map((role) => (
                          <span key={role} className={chip}>
                            {role}
                          </span>
                        ))}
                      </div>
                      {line.oneOf && (
                        <p className="mt-1 text-[10px] text-slate-400">One of these roles</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="space-y-1">
                        {line.oneOf && mapped.length > 0 && (
                          <p className="text-[10px] text-slate-400">One of these roles supplies the account</p>
                        )}
                        {shown.map(({ role, account }) => (
                          <div key={role} className="flex flex-wrap items-baseline gap-1.5">
                            {account ? (
                              <>
                                <span className="font-mono text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                                  {account.accountCode}
                                </span>
                                <span className="font-medium text-slate-700 dark:text-slate-300">
                                  {account.accountName}
                                </span>
                                {account.isControl && (
                                  <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                    CONTROL · {account.subledgerType}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                                {role} is not mapped
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      {missing && (
                        <p className="mt-1 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                          This document will be refused until the role is mapped.
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 border-t border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/20">
          {selected.note && <p className={subtle}>{selected.note}</p>}
          <div className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3 py-2 dark:border-indigo-500/30 dark:bg-indigo-950/20">
            <BookOpenCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
            <p className="text-[11px] leading-5 text-indigo-900 dark:text-indigo-200">
              The posting service reads the active ledger holding each role. If a required role is
              missing, the document is refused with the missing role named — it is never posted with
              a guessed account.
            </p>
          </div>
          <p className="text-[10px] text-slate-400 dark:text-slate-500">
            Change a mapping in <span className="font-semibold">Master Data &amp; Setup → Chart of Accounts</span>{' '}
            by editing the ledger and setting its <span className="font-semibold">Posting role</span>.
            A role belongs to exactly one active ledger.
          </p>
        </div>
      </div>
    </div>
  );
};

const AccountControlView: React.FC<{ state: RulesState; branchId: string }> = ({
  state,
  branchId,
}) => {
  const controls = state.accounts.filter((account) => account.isControl);
  const reconciliationByAccount = new Map(
    state.reconciliations.map((row) => [row.accountId, row])
  );
  const booksByAccount = useMemo(() => {
    const map = new Map<string, AccountingSubledger[]>();
    for (const book of state.subledgers) {
      const list = map.get(book.mainAccountId);
      if (list) list.push(book);
      else map.set(book.mainAccountId, [book]);
    }
    return map;
  }, [state.subledgers]);

  const reconciled = controls.filter((account) => {
    const row = reconciliationByAccount.get(account.id);
    return row && Math.abs(Number(row.difference)) < 0.005;
  }).length;
  const health = state.health;
  const unlinked = health?.unlinkedSubledgerRows.count ?? 0;
  const healthIssues =
    (health?.missingPostingRoles.length ?? 0) +
    (health?.controlAccountsWithoutSubledger.length ?? 0) +
    (health?.inactiveAccountsHoldingRole.length ?? 0) +
    unlinked;

  return (
    <div className="space-y-4">
      <div className={`${panel} overflow-hidden`}>
        <div className={panelHeader}>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            What “account control” means here
          </h3>
          <p className={`mt-1 max-w-4xl ${subtle}`}>
            A control account is a summary ledger. It must equal the sum of its subledger books, so
            the trial balance and the party detail can be checked independently. Automatic postings
            use a control role; manual postings can too, but they must name the party.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
          {[
            {
              icon: ShieldCheck,
              title: '1 · Control ledger',
              body: 'AR_CONTROL, AP_CONTROL, SALARY_PAYABLE and the other control roles are ordinary GL accounts with is_control set and a subledger type. They receive the journal line and hold no party detail themselves.',
            },
            {
              icon: Layers,
              title: '2 · Subledger book',
              body: 'Each control account can have one account-wide book and any number of party books. Customer, supplier and employee books use the shared master id, so the same party is recognised everywhere.',
            },
            {
              icon: GitBranch,
              title: '3 · Tie-out',
              body: 'The control register adds the posted GL lines and the book rows separately. A difference means the two sides disagree; the control is not “complete” just because the trial balance still balances.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/20"
            >
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-white p-1.5 text-indigo-600 shadow-sm dark:bg-slate-900 dark:text-indigo-400">
                  <Icon className="h-4 w-4" />
                </span>
                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">{title}</p>
              </div>
              <p className={`mt-2 ${subtle}`}>{body}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className={sectionLabel}>How a control line finds its book</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            <span className={chip}>Party book</span>
            <ArrowRight className="h-3 w-3 text-slate-400" />
            <span className={chip}>Account-wide book</span>
            <ArrowRight className="h-3 w-3 text-slate-400" />
            <span className={chip}>Only active book</span>
            <ArrowRight className="h-3 w-3 text-slate-400" />
            <span className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-300">
              Otherwise refuse
            </span>
          </div>
          <p className={`mt-2 ${subtle}`}>
            A party line resolves that party’s book first, then the general book, then the only book
            on the account. Two party books without a general book cannot serve an unrelated party:
            the journal is refused and names the missing book.
          </p>
        </div>
      </div>

      <KpiStrip
        items={[
          {
            label: 'CONTROL ACCOUNTS',
            value: String(controls.length),
            tone: KPI_TONE_TEXT.indigo,
            hint: 'Summary ledgers with party or branch detail',
          },
          {
            label: 'CONTROL BOOKS',
            value: String(state.subledgers.length),
            tone: KPI_TONE_TEXT.emerald,
            hint: `${controls.filter((account) => (booksByAccount.get(account.id)?.length ?? 0) > 0).length} of ${controls.length} controls have a book`,
          },
          {
            label: 'RECONCILED',
            value: `${reconciled}/${controls.length}`,
            tone: KPI_TONE_TEXT[controls.length > 0 && reconciled === controls.length ? 'emerald' : 'amber'],
            hint: `Scope: ${branchId === 'ALL' ? 'all branches' : branchId}`,
          },
          {
            label: 'SETUP EXCEPTIONS',
            value: String(healthIssues),
            tone: KPI_TONE_TEXT[healthIssues === 0 ? 'emerald' : 'rose'],
            hint: 'Missing roles, missing books, retired roles and unlinked rows',
          },
        ]}
      />

      <div className={`${panel} overflow-hidden`}>
        <div className={panelHeader}>
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
            Live control coverage
          </h3>
          <p className={subtle}>
            GL balance and subledger total are calculated by the server for the selected branch.
            Differences are shown, not hidden.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2">Control account</th>
                <th className="px-4 py-2">Book type</th>
                <th className="px-4 py-2">Posting role</th>
                <th className="px-4 py-2 text-right">Books</th>
                <th className="px-4 py-2 text-right">GL balance</th>
                <th className="px-4 py-2 text-right">Subledger</th>
                <th className="px-4 py-2 text-right">Difference</th>
                <th className="px-4 py-2 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {controls.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                    No control account is configured. Add one in Chart of Accounts.
                  </td>
                </tr>
              ) : (
                controls.map((account) => {
                  const reconciliation = reconciliationByAccount.get(account.id);
                  const error = state.reconciliationErrors[account.id];
                  const books = booksByAccount.get(account.id) ?? [];
                  const difference = Number(reconciliation?.difference ?? 0);
                  return (
                    <tr key={account.id} className="align-top">
                      <td className="px-4 py-2.5">
                        <p className="font-bold text-slate-800 dark:text-slate-200">
                          <span className="mr-1.5 font-mono text-[10px] text-slate-400">
                            {account.code}
                          </span>
                          {account.name}
                        </p>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">
                        {account.subledgerType}
                      </td>
                      <td className="px-4 py-2.5">
                        {account.postingRole ? (
                          <span className={chip}>{account.postingRole}</span>
                        ) : (
                          <span className="text-[11px] text-slate-400">No role</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-600 dark:text-slate-300">
                        {books.length}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px]">
                        {reconciliation ? money(reconciliation.glBalance) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px]">
                        {reconciliation ? money(reconciliation.subledgerBalance) : '—'}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono text-[11px] ${
                          Math.abs(difference) >= 0.005
                            ? 'font-bold text-rose-600 dark:text-rose-400'
                            : ''
                        }`}
                      >
                        {reconciliation ? money(difference) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {error ? (
                          <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400">
                            FAILED
                          </span>
                        ) : reconciliation ? (
                          <StatusPill
                            ok={reconciliation.status === 'RECONCILED'}
                            okLabel="Reconciled"
                            badLabel="Difference"
                          />
                        ) : (
                          <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400">
                            NOT CHECKED
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={`${panel} overflow-hidden`}>
          <div className={panelHeader}>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Setup health</h3>
            <p className={subtle}>
              These are the conditions that make an otherwise valid posting fail or drift.
            </p>
          </div>
          <div className="divide-y divide-slate-100 p-4 text-xs dark:divide-slate-800/70">
            {state.health?.missingPostingRoles.length ? (
              <div className="pb-3">
                <p className="flex items-center gap-1 font-bold text-rose-700 dark:text-rose-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> Missing posting roles
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  {state.health.missingPostingRoles.join(', ')}
                </p>
              </div>
            ) : null}
            {state.health?.controlAccountsWithoutSubledger.map((account) => (
              <div key={account.accountId} className="py-3">
                <p className="font-bold text-rose-700 dark:text-rose-400">
                  {account.code} {account.name} has no active {account.subledgerType} book
                </p>
                <p className={`mt-1 ${subtle}`}>
                  Create a general or party book in Subledgers before posting to this control.
                </p>
              </div>
            ))}
            {state.health?.inactiveAccountsHoldingRole.map((account) => (
              <div key={account.accountId} className="py-3">
                <p className="font-bold text-rose-700 dark:text-rose-400">
                  {account.code} {account.name} is retired but still holds {account.postingRole}
                </p>
                <p className={`mt-1 ${subtle}`}>
                  Posting cannot use a retired ledger. Clear or move the role.
                </p>
              </div>
            ))}
            {unlinked > 0 && (
              <div className="py-3">
                <p className="font-bold text-amber-700 dark:text-amber-400">
                  {unlinked} posted subledger row{unlinked === 1 ? '' : 's'} without a book
                </p>
                <p className={`mt-1 ${subtle}`}>
                  The control balance can still tie; only book-level attribution is missing. The
                  chart-health panel lists the bounded sample.
                </p>
              </div>
            )}
            {health && healthIssues === 0 && (
              <p className="flex items-center gap-1.5 py-2 font-semibold text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Every required role is mapped, every control has
                a book, and every party row is linked.
              </p>
            )}
            {!health && <p className={subtle}>Health has not been read yet.</p>}
          </div>
        </div>

        <div className={`${panel} overflow-hidden`}>
          <div className={panelHeader}>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
              What is still manual
            </h3>
            <p className={subtle}>These are deliberate controls, not missing automation.</p>
          </div>
          <div className="space-y-3 p-4 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
            <p>
              <span className="font-bold text-slate-800 dark:text-slate-200">Manual journals</span>{' '}
              choose their own accounts. They still balance, belong to one branch and period, and a
              control-account line must name its party.
            </p>
            <p>
              <span className="font-bold text-slate-800 dark:text-slate-200">Bill terms, cost centres and narrations</span>{' '}
              are master data that shape entry and reporting; they do not create a journal by
              themselves.
            </p>
            <p>
              <span className="font-bold text-slate-800 dark:text-slate-200">Role ownership</span>{' '}
              stays with the chart. A role can be held by one active ledger only, and retiring that
              ledger clears the role instead of leaving a dead default behind.
            </p>
            <p className={subtle}>
              A complete control setup therefore means: all required roles mapped, every control has
              its book, and every posted control line carries a subledger row.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export const PostingRulesRegister: React.FC<AccountingScreenProps> = ({
  dateMode,
  currentUser,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const scope = useAccountingScope(branches, currentUser);
  const activationKey = useActivationKey('posting-rules');
  const isVisible = useTabActive('posting-rules') && scope.allowed;
  const [state, setState] = useState<RulesState>(EMPTY_STATE);
  const [tab, setTab] = useState<RulesTab>('RULES');
  const [selectedRuleId, setSelectedRuleId] = useState(POSTING_RULES[0].id);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [defaultsResponse, accounts, health, subledgers] = await Promise.all([
          api.getPostingDefaults(),
          api.getAccountingAccounts(true),
          api.getChartHealth(),
          api.getAccountingSubledgers(true, scope.branchId === 'ALL' ? undefined : scope.branchId),
        ]);
        const controls = accounts.filter((account) => account.isControl);
        const settled = await Promise.allSettled(
          controls.map((account) =>
            api.getControlReconciliation(
              account.id,
              scope.branchId === 'ALL' ? undefined : scope.branchId
            )
          )
        );
        if (!live) return;
        const reconciliations: ControlReconciliationResponse[] = [];
        const reconciliationErrors: Record<string, string> = {};
        settled.forEach((result, index) => {
          if (result.status === 'fulfilled') reconciliations.push(result.value);
          else {
            reconciliationErrors[controls[index].id] =
              result.reason?.message || 'Reconciliation could not be read.';
          }
        });
        setState({
          defaults: defaultsResponse.defaults || {},
          accounts,
          subledgers: Array.isArray(subledgers) ? subledgers : [],
          reconciliations,
          reconciliationErrors,
          health: normalizeChartHealth(health),
        });
        setLoaded(true);
      } catch (err: any) {
        if (!live) return;
        setError(err?.message || 'The posting rules could not be read.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, activationKey, reloadKey]);

  const mappedRoleCount = useMemo(() => {
    const roles = uniqueRuleRoles();
    return roles.filter((role) => Boolean(state.defaults[role])).length;
  }, [state.defaults]);
  const catalogRoles = uniqueRuleRoles().length;
  const readyRules = useMemo(
    () => POSTING_RULES.filter((rule) => ruleReady(rule, state.defaults)).length,
    [state.defaults]
  );
  const controls = state.accounts.filter((account) => account.isControl);
  const reconciled = state.reconciliations.filter(
    (row) => Math.abs(Number(row.difference)) < 0.005
  ).length;

  return (
    <AccountingRegisterShell
      title="Posting Rules & Account Control"
      description="The debit and credit rule behind each automated document, the live ledger selected by every posting role, and the control-account tie-out."
      icon={<GitBranch className="h-5 w-5 text-indigo-500" />}
      registerName="posting rules"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {loaded ? (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 p-5 text-white shadow-lg">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-300">
                  Account control contract
                </p>
                <h2 className="mt-1 text-lg font-bold tracking-tight">
                  One document, one posting rule, one live ledger per role
                </h2>
                <p className="mt-2 text-xs leading-6 text-slate-300">
                  Operational screens do not choose account codes. They ask the posting services for
                  a role, the role resolves to the active ledger in the chart, and every control line
                  writes its party or branch book in the same transaction. This screen makes that
                  chain readable before a document is posted.
                </p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold ${
                  state.health &&
                  state.health.missingPostingRoles.length === 0 &&
                  state.health.controlAccountsWithoutSubledger.length === 0 &&
                  state.health.inactiveAccountsHoldingRole.length === 0
                    ? 'bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30'
                    : 'bg-amber-400/15 text-amber-200 ring-1 ring-amber-300/30'
                }`}
              >
                {state.health &&
                state.health.missingPostingRoles.length === 0 &&
                state.health.controlAccountsWithoutSubledger.length === 0 &&
                state.health.inactiveAccountsHoldingRole.length === 0 ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                {state.health &&
                state.health.missingPostingRoles.length === 0 &&
                state.health.controlAccountsWithoutSubledger.length === 0 &&
                state.health.inactiveAccountsHoldingRole.length === 0
                  ? 'Role control ready'
                  : 'Review setup'}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 text-[11px] text-slate-300 sm:grid-cols-2 xl:grid-cols-4">
              {[
                'Document event selects a posting rule',
                'Rule line names a posting role',
                'Role resolves to one active ledger',
                'Control line writes its subledger book',
              ].map((step, index) => (
                <div
                  key={step}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400/20 text-[10px] font-bold text-indigo-200">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>

          <KpiStrip
            items={[
              {
                label: 'ROLE COVERAGE',
                value: `${mappedRoleCount}/${catalogRoles}`,
                tone: KPI_TONE_TEXT[mappedRoleCount === catalogRoles ? 'emerald' : 'rose'],
                hint: 'Posting roles used by these rules that resolve to an active ledger',
              },
              {
                label: 'RULES READY',
                value: `${readyRules}/${POSTING_RULES.length}`,
                tone: KPI_TONE_TEXT[readyRules === POSTING_RULES.length ? 'emerald' : 'amber'],
                hint: 'Document rules whose required roles are all mapped',
              },
              {
                label: 'CONTROL ACCOUNTS',
                value: String(controls.length),
                tone: KPI_TONE_TEXT.indigo,
                hint: `${reconciled} reconciled in this branch scope`,
              },
              {
                label: 'SUBLEDGER BOOKS',
                value: String(state.subledgers.length),
                tone: KPI_TONE_TEXT.emerald,
                hint: 'General and party books behind the control accounts',
              },
            ]}
          />

          <div
            role="tablist"
            aria-label="Posting rules sections"
            className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900/40"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'RULES'}
              onClick={() => setTab('RULES')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                tab === 'RULES'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <BookOpenCheck className="h-3.5 w-3.5" /> Posting rules
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'CONTROL'}
              onClick={() => setTab('CONTROL')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                tab === 'CONTROL'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Account control
            </button>
          </div>

          {tab === 'RULES' ? (
            <RuleExplorer
              state={state}
              selectedId={selectedRuleId}
              onSelect={setSelectedRuleId}
            />
          ) : (
            <AccountControlView state={state} branchId={scope.branchId} />
          )}
        </div>
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No posting rules have been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default PostingRulesRegister;
