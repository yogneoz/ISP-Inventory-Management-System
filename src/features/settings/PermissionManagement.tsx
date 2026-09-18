import React, { useState, useEffect } from 'react';
import { UserRole, User } from '../../types';
import { getPermissionsMatrix, savePermissionsMatrix, DEFAULT_PERMISSIONS_MATRIX } from '../../utils/permissions';
import { useDarkMode } from '../../contexts/DarkModeContext';
import {
  ShieldCheck,
  Check,
  Save,
  RotateCcw,
  ShoppingBag,
  Warehouse,
  ArrowRightLeft,
  Package,
  Building,
  Briefcase,
  Search,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  Sliders,
  Filter,
} from 'lucide-react';

interface PermissionOperation {
  id: string;
  operationName: string;
  description: string;
  permissions: Record<UserRole, boolean>;
}

interface PermissionGroup {
  id: string;
  category: string;
  icon: React.ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
  description: string;
  operations: PermissionOperation[];
}

const DEFAULT_GROUPS: PermissionGroup[] = [
  {
    id: 'procurement',
    category: 'Procurement & Purchasing',
    icon: ShoppingBag,
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-950/30',
    borderColor: 'border-amber-200 dark:border-amber-900',
    description: 'Purchase orders, vendor inbound stock receiving, and procurement permissions control',
    operations: [
      {
        id: 'po-create',
        operationName: 'Create Purchase Orders (PO)',
        description: 'Generate multi-item purchase orders to suppliers and vendors',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-create'],
      },
      {
        id: 'po-receive',
        operationName: 'Receive Inbound PO Stock',
        description: 'Accept stock deliveries from vendors and update branch inventory on hand',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-receive'],
      },
      {
        id: 'branch-procurement-control',
        operationName: 'Branch Procurement Permission Control',
        description: 'Enable or disable procurement and purchasing capabilities per branch',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-procurement-control'],
      },
      {
        id: 'inv-create',
        operationName: 'Record Purchase Tax Invoices',
        description: 'Entry of vendor bills with 13% VAT bill-wise taxation and credit tracking',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-create'],
      },
      {
        id: 'inv-pay',
        operationName: 'Process Vendor Payment Settlements',
        description: 'Record credit settlements, bank transfers, and partial invoice payments',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-pay'],
      },
      {
        id: 'po-delete',
        operationName: 'Delete Purchase Orders (PO)',
        description: 'Delete eligible purchase orders and reverse outstanding incoming quantities',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-delete'],
      },
      {
        id: 'inv-delete',
        operationName: 'Delete Purchase Invoices (PI)',
        description: 'Delete eligible purchase invoices and reverse their inventory entries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-delete'],
      },
    ],
  },
  {
    id: 'warehouse',
    category: 'Warehouse Logistics & Dispatch',
    icon: Warehouse,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
    borderColor: 'border-blue-200 dark:border-blue-900',
    description: 'Central warehouse shipment dispatch, pullout receiving, and transfer tracking',
    operations: [
      {
        id: 'shipment-create',
        operationName: 'Create Warehouse Shipment Dispatch',
        description: 'Dispatch stock shipments from Central HQ Warehouse to regional branches',
        permissions: DEFAULT_PERMISSIONS_MATRIX['shipment-create'],
      },
      {
        id: 'wh-receive-pullouts',
        operationName: 'Receive Branch Stock Pullouts',
        description: 'Receive overstock or damaged stock pullouts sent back from branch stores',
        permissions: DEFAULT_PERMISSIONS_MATRIX['wh-receive-pullouts'],
      },
      {
        id: 'wh-restrict-transfer',
        operationName: 'Warehouse Transfer Restriction Rule',
        description: 'Issue inter-branch transfers from the central warehouse; destinations limited to branches with warehouse-transfer receiving enabled',
        permissions: DEFAULT_PERMISSIONS_MATRIX['wh-restrict-transfer'],
      },
      {
        id: 'shipment-history',
        operationName: 'View Shipment & Dispatch History',
        description: 'Audit shipment transfer codes, tracking logs, and in-transit statuses',
        permissions: DEFAULT_PERMISSIONS_MATRIX['shipment-history'],
      },
    ],
  },
  {
    id: 'branch-ops',
    category: 'Branch Operations & Inter-Branch Transfers',
    icon: ArrowRightLeft,
    color: 'text-indigo-600 dark:text-indigo-400',
    bgColor: 'bg-indigo-50 dark:bg-indigo-950/30',
    borderColor: 'border-indigo-200 dark:border-indigo-900',
    description: 'Inter-store transfers with serial tracking, stock pullouts, damage labeling, and sales',
    operations: [
      {
        id: 'branch-transfer-create',
        operationName: 'Create Inter-Branch Stock Transfer',
        description: 'Initiate stock transfers between store branches with serial tracking intact',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-create'],
      },
      {
        id: 'branch-transfer-receive',
        operationName: 'Receive Inter-Branch Stock Transfer',
        description: 'Acknowledge received stock transfers sent from another branch store',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-receive'],
      },
      {
        id: 'branch-transfer-cancel-receive',
        operationName: 'Cancel Received Branch Transfer',
        description: 'Cancel or rollback an acknowledged inter-branch transfer delivery',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-cancel-receive'],
      },
      {
        id: 'branch-transfer-request-cancel',
        operationName: 'Request Transfer Dispatch Cancellation',
        description: 'Submit cancellation requests for outbound in-transit transfers',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-request-cancel'],
      },
      {
        id: 'branch-pullout-dispatch',
        operationName: 'Dispatch Stock Pullout to HQ',
        description: 'Send overstock or damaged inventory back to Central HQ Warehouse',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-pullout-dispatch'],
      },
      {
        id: 'branch-damage-mark',
        operationName: 'Label & Record Damaged Stock',
        description: 'Flag damaged or broken inventory for inspection or write-off',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-damage-mark'],
      },
      {
        id: 'stock-disposal-writeoff',
        operationName: 'Stock Disposal & Financial Write-Off',
        description: 'Approve and execute permanent inventory scrap disposal, salvage recovery, and balance sheet write-off entries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-disposal-writeoff'],
      },
      {
        id: 'branch-asset-assign',
        operationName: 'Assign Fixed Assets to Branch Staff',
        description: 'Allocate branch equipment, devices, and tools to specific personnel',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-asset-assign'],
      },
      {
        id: 'stock-out',
        operationName: 'Product Sale / Stock Out to Customer',
        description: 'Record customer sales, stock reduction, and counter dispatches',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-out'],
      },
    ],
  },
  {
    id: 'inventory-master',
    category: 'Inventory & Product Master',
    icon: Package,
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-900',
    description: 'Product catalog, SKUs, barcode management, UOM, categories, and stock balances',
    operations: [
      {
        id: 'prod-view',
        operationName: 'View Product Catalog & Branch Balances',
        description: 'Access product SKUs, serial numbers, selling prices, and branch stock on hand',
        permissions: DEFAULT_PERMISSIONS_MATRIX['prod-view'],
      },
      {
        id: 'prod-edit',
        operationName: 'Create & Edit Products & SKUs',
        description: 'Add new inventory items, set cost rates, barcodes, and reorder thresholds',
        permissions: DEFAULT_PERMISSIONS_MATRIX['prod-edit'],
      },
      {
        id: 'uom-manage',
        operationName: 'Manage Units of Measure (UOM)',
        description: 'Define units of measurement and unit conversion factors',
        permissions: DEFAULT_PERMISSIONS_MATRIX['uom-manage'],
      },
      {
        id: 'category-manage',
        operationName: 'Manage Categories & Subcategories',
        description: 'Define product hierarchy, classification trees, and subcategories',
        permissions: DEFAULT_PERMISSIONS_MATRIX['category-manage'],
      },
      {
        id: 'edit-device-serials',
        operationName: 'Edit Device Serial Numbers (Serial/PON/MAC)',
        description: 'Edit serial numbers, PON serials, and MAC addresses for customer devices with cascading updates to all source tables',
        permissions: DEFAULT_PERMISSIONS_MATRIX['edit-device-serials'],
      },
      {
        id: 'stock-import-export',
        operationName: 'Import & Export Inventory Records',
        description: 'Bulk upload stock via CSV/Excel or export inventory valuation reports',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-import-export'],
      },
      {
        id: 'opening-stock-view',
        operationName: 'View Fiscal Year Opening Register',
        description: 'Inspect per-product, per-branch opening stock and per-supplier opening balance posted at fiscal year closing',
        permissions: DEFAULT_PERMISSIONS_MATRIX['opening-stock-view'],
      },
      {
        id: 'opening-stock-edit',
        operationName: 'Adjust Fiscal Year Opening Register',
        description: 'Manually correct opening stock quantity, damaged quantity, unit cost, and vendor opening balances while the fiscal year remains open',
        permissions: DEFAULT_PERMISSIONS_MATRIX['opening-stock-edit'],
      },
    ],
  },
  {
    id: 'financials',
    category: 'Fixed Assets & Financial Accounting',
    icon: Building,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/30',
    borderColor: 'border-purple-200 dark:border-purple-900',
    description: 'Fixed asset registration, depreciation calculations, VAT register, and financial statements',
    operations: [
      {
        id: 'assets-manage',
        operationName: 'Fixed Asset Register & Depreciation',
        description: 'Register capital assets, track depreciation rates, and handle disposals',
        permissions: DEFAULT_PERMISSIONS_MATRIX['assets-manage'],
      },
      {
        id: 'fin-statements',
        operationName: 'Generate Financial Statements',
        description: 'Access Income Statement, Balance Sheet, and Trial Balance summaries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['fin-statements'],
      },
      {
        id: 'vat-register',
        operationName: 'View 13% VAT Tax Register',
        description: 'Audit purchase VAT tax credits, vendor tax invoices, and IRD reporting',
        permissions: DEFAULT_PERMISSIONS_MATRIX['vat-register'],
      },
      {
        id: 'stock-valuation',
        operationName: 'Stock Valuation & Movement Ledger',
        description: 'Inspect FIFO/Weighted Average stock valuations and transaction ledgers',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-valuation'],
      },
    ],
  },
  {
    id: 'contacts',
    category: 'Suppliers & Customers',
    icon: Briefcase,
    color: 'text-rose-600 dark:text-rose-400',
    bgColor: 'bg-rose-50 dark:bg-rose-950/30',
    borderColor: 'border-rose-200 dark:border-rose-900',
    description: 'Vendor master directory, PAN/VAT registrations, and customer profiles',
    operations: [
      {
        id: 'suppliers-manage',
        operationName: 'Manage Vendor Directory & PAN/VAT',
        description: 'Add and edit vendor records, verified tax IDs, and credit terms',
        permissions: DEFAULT_PERMISSIONS_MATRIX['suppliers-manage'],
      },
      {
        id: 'customers-manage',
        operationName: 'Manage Customer Profiles & Limits',
        description: 'Maintain customer contact details, credit limits, and sales history',
        permissions: DEFAULT_PERMISSIONS_MATRIX['customers-manage'],
      },
    ],
  },
  {
    id: 'administration',
    category: 'System Administration & Security',
    icon: ShieldCheck,
    color: 'text-cyan-600 dark:text-cyan-400',
    bgColor: 'bg-cyan-50 dark:bg-cyan-950/30',
    borderColor: 'border-cyan-200 dark:border-cyan-900',
    description: 'User management, branch permissions control, system audit logs, and fiscal year settings',
    operations: [
      {
        id: 'auth-switch-user',
        operationName: 'Switch User Login / Session Profile',
        description: 'Allow switching active user profile and operational identity without full re-authentication',
        permissions: DEFAULT_PERMISSIONS_MATRIX['auth-switch-user'],
      },
      {
        id: 'workflow-approval',
        operationName: 'Process Workflow Approvals (Authorize/Reject)',
        description: 'Review, approve, or reject customer device status transitions and transfer cancellations',
        permissions: DEFAULT_PERMISSIONS_MATRIX['workflow-approval'],
      },
      {
        id: 'workflow-approval-cancel',
        operationName: 'Cancel Workflow Approval Requests',
        description: 'Cancel or withdraw pending workflow approval requests (restricted from Branch Managers & Front Desk)',
        permissions: DEFAULT_PERMISSIONS_MATRIX['workflow-approval-cancel'],
      },
      {
        id: 'admin-users',
        operationName: 'User Management & Role Assignment',
        description: 'Create user accounts, set role permissions, and assign branch affiliations',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-users'],
      },
      {
        id: 'admin-branches',
        operationName: 'Branch Management & Branch Controls',
        description: 'Create new branches, configure HQ status, and set branch permissions',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-branches'],
      },
      {
        id: 'admin-audit',
        operationName: 'View Audit Trail & Transaction Logs',
        description: 'Inspect detailed system transaction logs, user actions, and timestamps',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-audit'],
      },
      {
        id: 'admin-fiscal',
        operationName: 'Nepali Fiscal Year Management',
        description: 'Manage Bikram Sambat (BS) fiscal calendars, year-end closings, and dates',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-fiscal'],
      },
    ],
  },
];

const ROLES: { key: UserRole; title: string; badgeColor: string }[] = [
  { key: 'SUPER_ADMIN', title: 'Super Admin', badgeColor: 'bg-blue-600 text-white dark:bg-blue-500' },
  { key: 'INVENTORY_MANAGER', title: 'Inventory Manager', badgeColor: 'bg-purple-600 text-white dark:bg-purple-500' },
  { key: 'BRANCH_MANAGER', title: 'Branch Manager', badgeColor: 'bg-indigo-600 text-white dark:bg-indigo-500' },
  { key: 'FRONT_DESK', title: 'Front Desk', badgeColor: 'bg-teal-600 text-white dark:bg-teal-500' },
  { key: 'ACCOUNTANT', title: 'Accountant', badgeColor: 'bg-amber-600 text-white dark:bg-amber-500' },
];

interface PermissionManagementProps {
  currentUser?: User | null;
}

export const PermissionManagement: React.FC<PermissionManagementProps> = ({ currentUser }) => {
  const { isDarkMode } = useDarkMode();
  const [groups, setGroups] = useState<PermissionGroup[]>(() => {
    const savedMatrix = getPermissionsMatrix();
    return DEFAULT_GROUPS.map((group) => ({
      ...group,
      operations: group.operations.map((op) => ({
        ...op,
        permissions: savedMatrix[op.id] || op.permissions,
      })),
    }));
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('ALL');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [savedNotification, setSavedNotification] = useState(false);

  // Toggle individual operation permission
  const togglePermission = (groupId: string, opId: string, role: UserRole) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id === groupId) {
          return {
            ...group,
            operations: group.operations.map((op) => {
              if (op.id === opId) {
                return {
                  ...op,
                  permissions: {
                    ...op.permissions,
                    [role]: !op.permissions[role],
                  },
                };
              }
              return op;
            }),
          };
        }
        return group;
      })
    );
  };

  // Toggle all operations in a group for a specific role
  const toggleGroupRolePermissions = (groupId: string, role: UserRole) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id === groupId) {
          const allChecked = group.operations.every((op) => op.permissions[role]);
          return {
            ...group,
            operations: group.operations.map((op) => ({
              ...op,
              permissions: {
                ...op.permissions,
                [role]: !allChecked,
              },
            })),
          };
        }
        return group;
      })
    );
  };

  // Toggle collapse/expand for a group
  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const handleSave = () => {
    const matrix: Record<string, Record<UserRole, boolean>> = { ...getPermissionsMatrix() };
    groups.forEach((g) => {
      g.operations.forEach((op) => {
        matrix[op.id] = op.permissions;
      });
    });
    savePermissionsMatrix(matrix);
    setSavedNotification(true);
    setTimeout(() => setSavedNotification(false), 3000);
  };

  const handleReset = () => {
    savePermissionsMatrix(DEFAULT_PERMISSIONS_MATRIX);
    setGroups(DEFAULT_GROUPS.map((g) => ({
      ...g,
      operations: g.operations.map((op) => ({
        ...op,
        permissions: { ...DEFAULT_PERMISSIONS_MATRIX[op.id] },
      })),
    })));
    setSavedNotification(true);
    setTimeout(() => setSavedNotification(false), 3000);
  };

  // Filter groups and operations based on search & filter
  const filteredGroups = groups
    .filter((group) => selectedGroupFilter === 'ALL' || group.id === selectedGroupFilter)
    .map((group) => {
      const filteredOps = group.operations.filter(
        (op) =>
          (op?.operationName || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
          (op?.description || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
          (group?.category || '').toLowerCase().includes((searchQuery || '').toLowerCase())
      );
      return {
        ...group,
        operations: filteredOps,
      };
    })
    .filter((group) => group.operations.length > 0);

  const totalOpsCount = groups.reduce((acc, g) => acc + g.operations.length, 0);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <span>Group-Wise Operations & Role Permission Control</span>
          </h2>
          <p className="truncate text-slate-500 dark:text-slate-400 text-xs mt-1">
            Configure system privileges and operations enable/disable matrix grouped logically by department. Total operations: {totalOpsCount}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2.5">
          <button
            onClick={handleReset}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs cursor-pointer transition-colors border-slate-300 bg-white hover:bg-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset Defaults</span>
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 px-4 py-1.5 text-xs font-bold text-white shadow-md shadow-blue-600/20 cursor-pointer transition-colors"
          >
            <Save className="h-4 w-4" />
            <span>Save Permissions Matrix</span>
          </button>
        </div>
      </div>

      {savedNotification && (
        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-xs font-semibold flex items-center gap-2.5 shadow-xs">
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <span>Role permissions updated successfully across all {groups.length} operation groups and {totalOpsCount} functional modules!</span>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-col md:flex-row items-center justify-start gap-3 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search operation name or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
          <Filter className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">Filter Group:</span>
          <button
            onClick={() => setSelectedGroupFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              selectedGroupFilter === 'ALL'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            All Groups ({groups.length})
          </button>
          {groups.map((group) => (
            <button
              key={group.id}
              onClick={() => setSelectedGroupFilter(group.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                selectedGroupFilter === group.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {group.category}
            </button>
          ))}
        </div>
      </div>

      {/* Role Summary Badges Header */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {ROLES.map((role) => {
          let enabledCount = 0;
          groups.forEach((g) => {
            g.operations.forEach((op) => {
              if (op.permissions[role.key]) enabledCount++;
            });
          });
          const percentage = Math.round((enabledCount / totalOpsCount) * 100);

          return (
            <div
              key={role.key}
              className={`p-3.5 rounded-xl border shadow-xs flex items-center justify-between bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}
            >
              <div>
                <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${role.badgeColor}`}>
                  {role.title}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-medium">
                  {enabledCount} of {totalOpsCount} Operations Allowed
                </p>
              </div>
              <div className="text-right">
                <span className="text-base font-bold text-slate-900 dark:text-slate-100">{percentage}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Group-Wise Permission Cards */}
      <div className="space-y-3">
        {filteredGroups.length === 0 ? (
          <div className={`p-8 text-center rounded-2xl border text-xs bg-white border-slate-200 text-slate-500 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`}>
            No operations found matching your search filter "{searchQuery}".
          </div>
        ) : (
          filteredGroups.map((group) => {
            const GroupIcon = group.icon;
            const isCollapsed = collapsedGroups[group.id];

            return (
              <div
                key={group.id}
                className={`rounded-2xl border shadow-xs overflow-hidden transition-all ${group.borderColor} bg-white dark:bg-slate-900`}
              >
                {/* Group Header */}
                <div
                  className={`p-4 ${group.bgColor} border-b ${group.borderColor} flex flex-col md:flex-row md:items-center justify-between gap-3`}
                >
                  <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleGroupCollapse(group.id)}>
                    <div className={`p-2.5 rounded-xl shadow-xs ${group.color} bg-white dark:bg-slate-800`}>
                      <GroupIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                        <span>{group.category}</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {group.operations.length} Operations
                        </span>
                      </h3>
                      <p className="text-slate-600 dark:text-slate-400 text-xs mt-0.5">{group.description}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between md:justify-end gap-3 pt-2 md:pt-0 border-t md:border-t-0 border-slate-200/60 dark:border-slate-800">
                    <button
                      onClick={() => toggleGroupCollapse(group.id)}
                      className="flex items-center gap-1 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 cursor-pointer"
                    >
                      {isCollapsed ? (
                        <>
                          <span>Expand</span>
                          <ChevronDown className="h-4 w-4" />
                        </>
                      ) : (
                        <>
                          <span>Collapse</span>
                          <ChevronUp className="h-4 w-4" />
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Operations Table under Group */}
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-100/90 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 font-bold text-[10px] tracking-wider border-b border-slate-200 dark:border-slate-700">
                        <tr>
                          <th className="px-2.5 py-1.5 w-1/3">Operation & Description</th>
                          {ROLES.map((role) => {
                            const allChecked = group.operations.every((op) => op.permissions[role.key]);
                            return (
                              <th key={role.key} className="px-2.5 py-1.5 text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-extrabold ${role.badgeColor}`}>
                                    {role.title}
                                  </span>
                                  <button
                                    onClick={() => toggleGroupRolePermissions(group.id, role.key)}
                                    title={`Toggle all ${group.category} operations for ${role.title}`}
                                    className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 font-medium cursor-pointer"
                                  >
                                    {allChecked ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                                    <span>{allChecked ? 'Disable All' : 'Enable All'}</span>
                                  </button>
                                </div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {group.operations.map((op) => (
                          <tr
                            key={op.id}
                            className="hover:bg-slate-100/80 dark:hover:bg-slate-800/40 transition-colors"
                          >
                            <td className="p-2.5">
                              <div className="font-bold text-slate-900 dark:text-slate-100 text-xs">
                                {op.operationName}
                              </div>
                              <div className="text-slate-500 dark:text-slate-400 text-[11px] mt-0.5">
                                {op.description}
                              </div>
                            </td>
                            {ROLES.map((role) => {
                              const isChecked = op.permissions[role.key];
                              return (
                                <td key={role.key} className="p-2.5 text-center align-middle">
                                  <label className="inline-flex items-center justify-center cursor-pointer p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => togglePermission(group.id, op.id, role.key)}
                                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    />
                                  </label>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
