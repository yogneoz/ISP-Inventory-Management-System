import React, { useState, useRef, useEffect } from 'react';
import { Branch, User, Product, InventoryStock, ApprovalRequest, PurchaseOrder, Shipment, CompanyProfile, FiscalYear } from '../../types';
import { convertADToBS } from '../../utils/nepaliCalendar';
import { canUserSeeAllBranches, getAllowedBranches, canUserSwitchProfiles, filterFiscalYears } from '../../utils/permissions';
import { NavTab } from './Sidebar';
import { NotificationCenter } from '../common/NotificationCenter';
import { useDarkMode } from '../../contexts/DarkModeContext';
import {
  Building2,
  Calendar,
  LogOut,
  ShieldCheck,
  Search,
  Bell,
  RefreshCw,
  Sun,
  Moon,
  QrCode,
  Menu,
  X,
  ChevronDown,
  User as UserIcon,
  Users,
  Lock,
  ArrowLeft,
  ArrowLeftRight,
  Settings,
  CheckCircle2,
} from 'lucide-react';

interface HeaderProps {
  companyProfile?: CompanyProfile | null;
  currentUser: User | null;
  rootUser?: User | null;
  onSwitchBackToRoot?: () => void;
  users?: User[];
  onSwitchProfile?: (targetUserId: string) => Promise<void>;
  branches: Branch[];
  selectedBranchId: string;
  onSelectBranch: (branchId: string) => void;
  dateMode: 'BS' | 'AD';
  onToggleDateMode: () => void;
  currentFiscalYear: string;
  fiscalYears: FiscalYear[];
  selectedFiscalYearId: string;
  onSelectFiscalYear: (fiscalYearId: string) => void;
  onOpenBarcodeModal?: () => void;
  onOpenSearchModal?: () => void;
  onLogout: () => void;
  onSwitchUser?: (email: string, pass: string) => void;
  onRefreshData: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  lowStockCount: number;
  onToggleTheme: () => void;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;

  products?: Product[];
  stock?: InventoryStock[];
  approvalRequests?: ApprovalRequest[];
  purchaseOrders?: PurchaseOrder[];
  shipments?: Shipment[];
  onSelectTab?: (tab: NavTab) => void;
  onOpenNotification?: () => void;
  onOpenProfileModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  companyProfile,
  currentUser,
  rootUser,
  onSwitchBackToRoot,
  users = [],
  onSwitchProfile,
  branches,
  selectedBranchId,
  onSelectBranch,
  dateMode,
  onToggleDateMode,
  currentFiscalYear,
  fiscalYears,
  selectedFiscalYearId,
  onSelectFiscalYear,
  onOpenBarcodeModal,
  onOpenSearchModal,
  onLogout,
  onSwitchUser,
  onRefreshData,
  searchQuery,
  onSearchChange,
  lowStockCount,
  onToggleTheme,
  onToggleSidebar,
  isSidebarOpen = false,

  products = [],
  stock = [],
  approvalRequests = [],
  purchaseOrders = [],
  shipments = [],
  onSelectTab = (_tab: string) => {},
  onOpenNotification = () => {},
  onOpenProfileModal = () => {},
}) => {
  const { isDarkMode } = useDarkMode();
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [isSwitchingId, setIsSwitchingId] = useState<string | null>(null);

  const profileDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileDropdownRef.current && !profileDropdownRef.current.contains(e.target as Node)) {
        setIsProfileDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const todayAD = new Date().toISOString().split('T')[0];
  const bsInfo = convertADToBS(todayAD);

  // Total actionable notifications badge
  const pendingApprovalsCount = approvalRequests.filter(
    (r) => r.status === 'PENDING' && (selectedBranchId === 'ALL' || r.branchId === selectedBranchId)
  ).length;

  const userBranchContext =
    selectedBranchId && selectedBranchId !== 'ALL'
      ? selectedBranchId
      : currentUser?.branchId && currentUser.branchId !== 'ALL'
      ? currentUser.branchId
      : 'ALL';

  const inTransitShipmentsCount = shipments.filter(
    (s) =>
      (s.status === 'IN_TRANSIT' || s.status === 'DISPATCHED') &&
      (userBranchContext === 'ALL' ||
        s.destinationBranchId === userBranchContext ||
        s.sourceBranchId === userBranchContext)
  ).length;

  const totalNotificationBadge = lowStockCount + pendingApprovalsCount + inTransitShipmentsCount;

  // True while the server session is impersonating another profile (rootUser is the real account)
  const isSwitchedSession = !!(rootUser && currentUser && rootUser.id !== currentUser.id);

  return (
    <header
      className={`sticky top-0 z-30 w-full backdrop-blur-md shadow-sm transition-colors duration-200 bg-gradient-to-r from-[#1a237e] via-[#151c65] to-[#0d47a1] text-white border-b border-indigo-900 dark:border-b dark:border-slate-800 dark:bg-[#0a0c10]/95 dark:text-slate-300`}
    >
      {/* Main header row */}
      <div className="flex h-13 w-full items-center justify-between px-3">
      {/* Left: Brand logo & Branch Switcher */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        {/* Mobile Hamburger Menu Toggle Button (hidden on non-mobile screens) */}
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title={isSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
            className="flex md:hidden items-center justify-center p-1.5 rounded-lg text-white hover:bg-white/10 active:bg-white/20 transition-all cursor-pointer"
            aria-label="Toggle navigation menu"
          >
            {isSidebarOpen ? (
              <X className="h-5 w-5 text-amber-300" />
            ) : (
              <Menu className="h-5 w-5 text-white" />
            )}
          </button>
        )}

        <button
          type="button"
          onClick={() => onSelectTab && onSelectTab('dashboard')}
          title={`${companyProfile?.name || 'EXAMPLE NETWORKS PVT. LTD.'} - Open Executive Dashboard`}
          className="flex items-center gap-2 rounded-lg px-1.5 py-1 -ml-1 hover:bg-white/10 dark:hover:bg-slate-800/60 transition-all cursor-pointer group text-left"
        >
          {companyProfile?.logoUrl ? (
            <img
              src={companyProfile.logoUrl}
              alt={companyProfile.name || 'Company Logo'}
              referrerPolicy="no-referrer"
              className={`h-10 max-h-10 w-auto max-w-[160px] rounded-none object-contain p-0.5 group-hover:scale-105 transition-transform bg-white dark:bg-slate-800`}
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          ) : (
              <div className={`flex h-10 w-10 items-center justify-center rounded-none font-serif font-bold text-base tracking-tight group-hover:scale-105 transition-transform bg-white text-indigo-700 dark:bg-slate-800 dark:text-indigo-300`}>
              {companyProfile?.name
                ? companyProfile.name
                    .split(' ')
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0].toUpperCase())
                    .join('') || 'iZ'
                : 'iZ'}
            </div>
          )}

          {/* Company name shown only below md (the sidebar carries the full brand on desktop) */}
          <div className="hidden sm:block md:hidden">
            <h1 className="font-serif font-bold text-white text-sm leading-none tracking-tight group-hover:text-amber-200 transition-colors truncate max-w-[150px]">
              {companyProfile?.name || 'IZone Inventory'}
            </h1>
          </div>
        </button>

        <div className="hidden md:flex items-center gap-1.5 border-l border-white/20 pl-3 ml-1">
          <Building2 className="h-3.5 w-3.5 text-indigo-200" />
          <label htmlFor="branch-select" className="sr-only">
            Select Branch
          </label>
          {(() => {
            const canSeeAll = canUserSeeAllBranches(currentUser);
            const allowed = getAllowedBranches(currentUser, branches);

            if (!canSeeAll && allowed.length === 1) {
              return (
                <div className="flex items-center gap-1 rounded-md border border-amber-300/40 bg-amber-950/60 px-2 py-1 font-bold text-[11px] text-amber-200">
                  <span>📍 {allowed[0]?.name || 'Assigned Branch'}</span>
                  <span className="text-[9px] bg-amber-800/80 text-amber-100 px-1 py-0.2 rounded font-normal uppercase">
                    Assigned
                  </span>
                </div>
              );
            }

            return (
              <select
                id="branch-select"
                value={selectedBranchId}
                onChange={(e) => onSelectBranch(e.target.value)}
                className={`rounded-md px-2.5 py-1 font-medium text-[11px] focus:outline-none transition-all cursor-pointer border border-white/30 bg-white/10 text-white focus:bg-white/20 backdrop-blur-xs dark:border dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300 dark:focus:border-indigo-500`}
              >
                {canSeeAll ? (
                  <option value="ALL" className="bg-slate-900 text-white">
                    🏢 All Branches (Consolidated)
                  </option>
                ) : (
                  <option value="ALL" className="bg-slate-900 text-white">
                    🏢 My Assigned Branches ({allowed.length})
                  </option>
                )}
                {allowed.map((b) => (
                  <option key={b.id} value={b.id} className="bg-slate-900 text-white">
                    {b.isHeadquarters ? '⭐ ' : '📍 '}
                    {b.name} ({b.code})
                  </option>
                ))}
              </select>
            );
          })()}

          {/* Fiscal-year scope (grouped with branch as view-scope controls, loaded from PostgreSQL) */}
          <div
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium border-white/30 bg-white/10 text-white backdrop-blur-xs dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300`}
            title="Fiscal-year view"
          >
            <span className={`text-[9px] font-bold text-indigo-200 dark:text-slate-400`}>FY</span>
            <select
              value={selectedFiscalYearId}
              onChange={(e) => onSelectFiscalYear(e.target.value)}
              aria-label="Select fiscal-year view"
              className={`max-w-28 font-medium outline-none cursor-pointer rounded px-1 py-0.5 bg-white/20 text-white dark:bg-slate-800 dark:text-slate-200`}
            >
              {[...filterFiscalYears(fiscalYears)].sort((a, b) => String(b.startDateAD).localeCompare(String(a.startDateAD))).map((fiscalYear) => (
                <option key={fiscalYear.id} value={fiscalYear.id} className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">
                  {fiscalYear.code}
                  {fiscalYear.isCurrent ? ' (Active)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Middle: Search input (Desktop) */}
      <div className="hidden lg:flex items-center max-w-sm flex-1 mx-4">
        <div
          className="relative w-full cursor-pointer flex items-center"
          onClick={() => {
            if (onOpenSearchModal) onOpenSearchModal();
          }}
        >
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-indigo-200/70" />
          <input
            type="text"
            value={searchQuery}
            onFocus={() => {
              if (onOpenSearchModal) onOpenSearchModal();
            }}
            onChange={(e) => {
              onSearchChange(e.target.value);
              if (onOpenSearchModal) onOpenSearchModal();
            }}
            placeholder="Scan Barcode or Search Product Name / SKU:"
            className={`w-full rounded-full pl-8 pr-16 py-1 text-[11px] focus:outline-none transition-all cursor-pointer border border-white/30 bg-white/10 text-white placeholder-indigo-200/60 focus:bg-white/20 dark:border dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-200 dark:placeholder-slate-500 dark:focus:bg-slate-900 dark:focus:border-indigo-500`}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {onOpenBarcodeModal && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenBarcodeModal();
                }}
                title="Scan Barcode with Camera"
                className="p-1 rounded bg-white/10 hover:bg-white/20 text-indigo-200 hover:text-white transition-colors cursor-pointer"
              >
                <QrCode className="h-3 w-3" />
              </button>
            )}
            <kbd className="hidden xl:inline-block px-1 py-0.2 text-[9px] font-mono text-indigo-200 bg-white/10 rounded border border-white/20 pointer-events-none">
              ⌘K
            </kbd>
          </div>
        </div>
      </div>

      {/* Right: Theme Toggle, Date Toggle, Fiscal Year, Logout */}
      <div className="flex items-center gap-2">
        {/* Mobile Search Icon Button */}
        {onOpenSearchModal && (
          <button
            onClick={onOpenSearchModal}
            title="Global Quick Search (Ctrl+K)"
            className={`lg:hidden p-1.5 rounded-lg transition-colors cursor-pointer text-white/90 hover:bg-white/20 dark:text-slate-300 dark:hover:bg-slate-800 dark:text-indigo-300`}
          >
            <Search className="h-4 w-4" />
          </button>
        )}
        {/* Theme Toggle Button */}
        <button
          onClick={onToggleTheme}
          title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all cursor-pointer border border-white/30 bg-white/10 text-white hover:bg-white/20 dark:border dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300 dark:hover:bg-slate-800/60`}
        >
          {isDarkMode ? (
            <>
              <Sun className="h-3 w-3 text-amber-400 fill-amber-400" />
              <span className="hidden sm:inline">Light</span>
            </>
          ) : (
            <>
              <Moon className="h-3 w-3 text-indigo-100 fill-indigo-100" />
              <span className="hidden sm:inline">Dark</span>
            </>
          )}
        </button>

        {/* Date Display Pill & Toggle */}
        <button
          onClick={onToggleDateMode}
          title="Click to toggle between Bikram Sambat (BS) and Anno Domini (AD)"
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors border border-white/30 bg-white/10 hover:bg-white/20 text-white dark:border dark:border-slate-800 dark:bg-[#0f1218] dark:hover:bg-slate-800/60 dark:text-slate-300`}
        >
          <Calendar className="h-3.5 w-3.5 text-indigo-200" />
          <span className="font-mono">
            {dateMode === 'BS' ? (bsInfo.formattedBSShort ? bsInfo.formattedBSShort.replace(' BS', '') : `${bsInfo.yearBS}-${String(bsInfo.monthBS).padStart(2, '0')}-${String(bsInfo.dayBS).padStart(2, '0')}`) : todayAD}
          </span>
          <span className="ml-0.5 rounded bg-indigo-950/80 px-1 py-0.2 font-bold text-[9px] text-indigo-300 border border-indigo-400/20 uppercase">
            {dateMode}
          </span>
        </button>

        {/* Refresh button */}
        <button
          onClick={onRefreshData}
          title="Refresh realtime stock and logs"
          className={`p-1.5 rounded-lg transition-colors cursor-pointer text-white/80 hover:text-white hover:bg-white/20 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800/60`}
        >
          <RefreshCw className="h-4 w-4" />
        </button>

        {/* Notifications badge */}
        <div className="relative">
          <button
            onClick={onOpenNotification}
            title="Notifications & Reorder Alerts"
            className={`p-1.5 rounded-lg transition-colors relative cursor-pointer text-white/80 hover:text-white hover:bg-white/20 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-slate-800/60`}
          >
            <Bell className="h-4 w-4" />
            {totalNotificationBadge > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
                {totalNotificationBadge}
              </span>
            )}
          </button>
        </div>

        {/* Profile Chip & Switcher Dropdown Container */}
        {currentUser && (
          <div className="relative ml-1" ref={profileDropdownRef}>
            <button
              onClick={() => setIsProfileDropdownOpen((prev) => !prev)}
              title="Click to expand switch user menu & profile options"
              className={`flex items-center gap-2 rounded-xl px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer border bg-white/20 text-white border-white/30 hover:bg-white/30 backdrop-blur-xs dark:bg-slate-800/90 dark:text-white dark:border-slate-700 dark:hover:bg-slate-700 dark:hover:border-slate-600`}
            >
              <div className="relative flex-shrink-0">
                <div className="h-6 w-6 rounded-lg bg-indigo-500/90 flex items-center justify-center font-extrabold text-[10px] text-white shadow-xs border border-white/20">
                  {currentUser.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                </div>
                {isSwitchedSession && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400 border border-[#151c65] dark:border-slate-950"
                    title="Switched session active - see the banner below the header"
                  />
                )}
              </div>
              <div className="hidden lg:flex flex-col text-left">
                <span className="text-[11px] font-bold leading-tight truncate max-w-[110px]">{currentUser.name}</span>
                <span className="text-[9px] text-indigo-200/90 font-normal leading-none uppercase tracking-wider">
                  {currentUser.role.replace('_', ' ')}
                </span>
              </div>
              <ChevronDown className={`h-3.5 w-3.5 text-white/70 transition-transform ${isProfileDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Expand-Down Dropdown Menu */}
            {isProfileDropdownOpen && (
              <div className="absolute right-0 mt-2 w-80 sm:w-88 rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 p-3 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                {/* Active User Header */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center font-extrabold text-xs text-white flex-shrink-0 shadow-xs">
                      {currentUser.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-xs text-slate-900 dark:text-white truncate">{currentUser.name}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">{currentUser.email}</div>
                    </div>
                  </div>
                  <span className="text-[9px] font-bold px-2 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 uppercase flex-shrink-0">
                    {currentUser.role.replace('_', ' ')}
                  </span>
                </div>

                {/* Switched Session Banner & Switch Back Button */}
                {rootUser && currentUser && rootUser.id !== currentUser.id && (
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 p-2.5 border border-amber-300 dark:border-amber-800/80 mb-3 space-y-2">
                    <div className="text-[11px] text-amber-900 dark:text-amber-200">
                      <p className="font-bold">🔄 Switched Session Active</p>
                      <p className="text-[10px] text-amber-800 dark:text-amber-300">
                        Root Account: <strong>{rootUser.name}</strong>
                      </p>
                    </div>
                    {onSwitchBackToRoot && (
                      <button
                        type="button"
                        onClick={() => {
                          onSwitchBackToRoot();
                          setIsProfileDropdownOpen(false);
                        }}
                        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold py-1.5 px-3 text-[11px] transition-colors cursor-pointer"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        <span>Switch Back to {rootUser.name.split(' ')[0]}</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Quick User Switcher Section */}
                <div className="mb-3">
                  <div className="flex items-center justify-between px-1 mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
                      <Users className="h-3.5 w-3.5 text-indigo-500" />
                      <span>Switch User Account</span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-normal">Fast 1-click</span>
                  </div>

                  {!canUserSwitchProfiles(currentUser, rootUser) ? (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 text-center">
                      <Lock className="h-4 w-4 text-slate-400 mx-auto mb-1" />
                      <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Switching Restricted</p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                        User switching is restricted to authorized employees.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Search User Input */}
                      {users.length > 3 && (
                        <div className="relative mb-2">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                          <input
                            type="text"
                            value={userSearch}
                            onChange={(e) => setUserSearch(e.target.value)}
                            placeholder="Search team profiles..."
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 pl-8 pr-2.5 py-1 text-[11px] text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                          />
                        </div>
                      )}

                      {/* Quick Scrollable User List */}
                      <div className="space-y-1 max-h-48 overflow-y-auto pr-0.5">
                        {users
                          .filter(
                            (u) =>
                              (u?.name || '').toLowerCase().includes((userSearch || '').toLowerCase()) ||
                              (u?.role || '').toLowerCase().includes((userSearch || '').toLowerCase()) ||
                              (u?.email || '').toLowerCase().includes((userSearch || '').toLowerCase())
                          )
                          .map((u) => {
                            const isCurrent = u.id === currentUser.id;
                            const isSwitching = isSwitchingId === u.id;
                            const bName =
                              branches.find((b) => b.id === u.branchId)?.name || 'HQ';

                            return (
                              <button
                                key={u.id}
                                disabled={isCurrent || isSwitching}
                                onClick={async () => {
                                  if (onSwitchProfile) {
                                    setIsSwitchingId(u.id);
                                    try {
                                      await onSwitchProfile(u.id);
                                      setIsProfileDropdownOpen(false);
                                    } catch (_e) {
                                      // Error is already surfaced by the handler (alert);
                                      // keep the dropdown open so the user can retry.
                                    } finally {
                                      setIsSwitchingId(null);
                                    }
                                  }
                                }}
                                className={`w-full flex items-center justify-between p-2 rounded-xl text-left transition-colors cursor-pointer ${
                                  isCurrent
                                    ? 'bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 font-semibold'
                                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="h-7 w-7 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center font-bold text-[10px] text-slate-700 dark:text-slate-200 flex-shrink-0">
                                    {u.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-bold truncate leading-tight">{u.name}</div>
                                    <div className="text-[9px] text-slate-500 dark:text-slate-400 truncate font-mono">
                                      {u.role.replace('_', ' ')} • {bName}
                                    </div>
                                  </div>
                                </div>

                                {isCurrent ? (
                                  <span className="text-[9px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-950 px-2 py-0.5 rounded-md">
                                    Active
                                  </span>
                                ) : isSwitching ? (
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                                ) : (
                                  <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline">
                                    Switch
                                  </span>
                                )}
                              </button>
                            );
                          })}
                      </div>
                    </>
                  )}
                </div>

                {/* Footer Actions: Modal & Sign Out */}
                <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsProfileDropdownOpen(false);
                      onOpenProfileModal();
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-bold py-1.5 px-2.5 text-[11px] transition-colors cursor-pointer"
                  >
                    <Settings className="h-3.5 w-3.5 text-slate-500" />
                    <span>Account Settings</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsProfileDropdownOpen(false);
                      onLogout();
                    }}
                    className="flex items-center justify-center gap-1 rounded-xl bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/60 font-bold py-1.5 px-2.5 text-[11px] transition-colors cursor-pointer"
                    title="Sign Out"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>Exit</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Logged-out indicator (the login modal covers the app when unauthenticated) */}
        {!currentUser && (
          <div className="flex items-center gap-1 text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 px-2 py-0.5 rounded-md">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Out</span>
          </div>
        )}
      </div>
      </div>

      {/* Switched-session strip: persistent recovery path while impersonating another profile */}
      {isSwitchedSession && (
        <div
          className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-3 py-1.5 border-amber-200/60 bg-amber-300/20 text-amber-50 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200`}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold">
            <ArrowLeftRight className="h-3.5 w-3.5 flex-shrink-0 text-amber-400 dark:text-amber-300" />
            <span className="truncate">
              Viewing as <span className="font-bold">{currentUser?.name}</span>
              <span className="opacity-75"> ({currentUser?.role.replace('_', ' ')})</span>
              {' - switched from '}
              <span className="font-bold">{rootUser?.name}</span>
            </span>
          </span>
          {onSwitchBackToRoot && (
            <button
              type="button"
              onClick={onSwitchBackToRoot}
              title={`Switch back to root account (${rootUser?.name})`}
              className="flex-shrink-0 rounded-md bg-amber-400 px-2.5 py-0.5 text-[10px] font-bold text-slate-950 transition-colors cursor-pointer hover:bg-amber-300"
            >
              Switch Back to {rootUser?.name.split(' ')[0]}
            </button>
          )}
        </div>
      )}
    </header>
  );
};

