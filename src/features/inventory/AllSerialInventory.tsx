import React, { useState, useMemo } from 'react';
import { Branch, Product, User } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { formatNPR } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { api } from '../../services/api';
import {
  Search,
  Download,
  Barcode,
  Wifi,
  Package,
  AlertCircle,
  CheckCircle,
  Clock,
  Truck,
  ShoppingCart,
  Edit2,
  X,
  Save,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface SerialDeviceRecord {
  id: string;
  sourceType: 'CUSTOMER_DEVICE' | 'PURCHASE_INVOICE' | 'SHIPMENT' | 'STOCK_OPERATION' | 'FIXED_ASSET';
  sourceId: string;
  deviceSerial: string;
  ponSerial?: string;
  macAddress?: string;
  productName: string;
  productSku: string;
  status: 'IN_STOCK' | 'IN_TRANSIT' | 'CUSTOMER_ASSIGNED' | 'POP_LOCATION_ASSIGNED' | 'DAMAGED';
  branchId?: string;
  branchName?: string;
  customerName?: string;
  dateAD?: string;
  dateBS?: string;
}

interface AllSerialInventoryProps {
  customerDevices: any[];
  purchaseInvoices: any[];
  shipments: any[];
  stockOperations: any[];
  fixedAssets: any[];
  products: Product[];
  branches: Branch[];
  selectedBranchId: string;
  currentUser?: User | null;
}

export const AllSerialInventory: React.FC<AllSerialInventoryProps> = ({
  customerDevices = [],
  purchaseInvoices = [],
  shipments = [],
  stockOperations = [],
  fixedAssets = [],
  products = [],
  branches = [],
  selectedBranchId,
  currentUser,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterBranch, setFilterBranch] = useState<string>('ALL');
  const [editingDevice, setEditingDevice] = useState<SerialDeviceRecord | null>(null);
  const [editForm, setEditForm] = useState({ deviceSerial: '', ponSerial: '', macAddress: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');

  // Aggregate all serial devices from all sources
  const allSerialDevices = useMemo<SerialDeviceRecord[]>(() => {
    const records: SerialDeviceRecord[] = [];
    // Track seen serials by (deviceSerial + branchId) to prevent duplicates
    // across purchase invoices and customer device records
    const seenSerials = new Set<string>();

    // 2. From Customer Device Records (CUSTOMER_ASSIGNED or IN_STOCK via RETURNED, or DAMAGED)
    // Process this FIRST to establish which serials are assigned, so we can exclude them from purchases
    if (customerDevices && customerDevices.length > 0) {
      customerDevices.forEach((device: any) => {
        let status: 'CUSTOMER_ASSIGNED' | 'IN_STOCK' | 'DAMAGED' = 'CUSTOMER_ASSIGNED';
        if (device.status === 'ROUTER_COLLECTED' || device.status === 'DISCONNECTED' || device.status === 'IN_STOCK') {
          status = 'IN_STOCK'; // Returned to warehouse
        } else if (device.status === 'DAMAGED' || device.status === 'DAMAGED_STOCK') {
          status = 'DAMAGED';
        }

        const serialKey = `${device.deviceSerial || ''}:${device.branchId || 'UNKNOWN'}`;
        seenSerials.add(serialKey);

        records.push({
          id: device.id,
          sourceType: 'CUSTOMER_DEVICE',
          sourceId: device.id,
          deviceSerial: device.deviceSerial || '',
          ponSerial: device.ponSerial,
          macAddress: device.macAddress,
          productName: device.productName || 'Unknown',
          productSku: '',
          status,
          branchId: device.branchId,
          branchName: branches.find((b) => b.id === device.branchId)?.name,
          customerName: device.customerName,
          dateAD: device.issuedDateAD,
          dateBS: device.issuedDateBS,
        });
      });
    }

    // 1. From Purchase Invoices (IN_STOCK - UNASSIGNED) - ONLY if not already in customer devices
    if (purchaseInvoices && purchaseInvoices.length > 0) {
      purchaseInvoices.forEach((inv: any) => {
        if (inv.items && Array.isArray(inv.items)) {
          inv.items.forEach((item: any) => {
            if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
              item.deviceSerials.forEach((serial: any) => {
                const serialKey = `${serial.deviceSerial || ''}:${inv.branchId || 'UNKNOWN'}`;
                // Only add if NOT already seen in customer device records
                if (!seenSerials.has(serialKey)) {
                  records.push({
                    id: `pi-${inv.id}-${serial.deviceSerial}`,
                    sourceType: 'PURCHASE_INVOICE',
                    sourceId: inv.id,
                    deviceSerial: serial.deviceSerial || '',
                    ponSerial: serial.ponSerial,
                    macAddress: serial.macAddress,
                    productName: item.productName || inv.productName || item.sku || 'Unknown',
                    productSku: item.sku || '',
                    status: 'IN_STOCK',
                    branchId: inv.branchId,
                    branchName: inv.branchName,
                    dateAD: inv.invoiceDateAD,
                    dateBS: inv.invoiceDateBS,
                  });
                  seenSerials.add(serialKey);
                }
              });
            }
          });
        }
      });
    }

    // 3. From Shipments (IN_TRANSIT or IN_STOCK if delivered)
    if (shipments && shipments.length > 0) {
      shipments.forEach((shipment: any) => {
        if (shipment.items && Array.isArray(shipment.items)) {
          shipment.items.forEach((item: any) => {
            const serials = shipment.status === 'RECEIVED' ? item.receivedSerials : item.deviceSerials;
            if (serials && Array.isArray(serials)) {
              serials.forEach((serial: any) => {
                const isInTransit = shipment.status === 'DISPATCHED' || shipment.status === 'IN_TRANSIT';
                records.push({
                  id: `ship-${shipment.id}-${serial.deviceSerial}`,
                  sourceType: 'SHIPMENT',
                  sourceId: shipment.id,
                  deviceSerial: serial.deviceSerial || '',
                  ponSerial: serial.ponSerial,
                  macAddress: serial.macAddress,
                  productName: item.productName || 'Unknown',
                  productSku: item.sku || '',
                  status: isInTransit ? 'IN_TRANSIT' : 'IN_STOCK',
                  branchId: shipment.destinationBranchId,
                  branchName: branches.find((b) => b.id === shipment.destinationBranchId)?.name,
                  dateAD: shipment.dispatchDateAD,
                  dateBS: shipment.dispatchDateBS,
                });
              });
            }
          });
        }
      });
    }

    // 4. From Stock Operations (IN_STOCK or DAMAGED)
    if (stockOperations && stockOperations.length > 0) {
      stockOperations.forEach((op: any) => {
        if (op.items && Array.isArray(op.items)) {
          op.items.forEach((item: any) => {
            if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
              item.deviceSerials.forEach((serial: any) => {
                const isDamaged = op.type === 'DAMAGE' || op.type === 'DISPOSAL';
                records.push({
                  id: `op-${op.id}-${serial.deviceSerial}`,
                  sourceType: 'STOCK_OPERATION',
                  sourceId: op.id,
                  deviceSerial: serial.deviceSerial || '',
                  ponSerial: serial.ponSerial,
                  macAddress: serial.macAddress,
                  productName: item.productName || op.productName || 'Unknown',
                  productSku: item.sku || '',
                  status: isDamaged ? 'DAMAGED' : 'IN_STOCK',
                  branchId: op.branchId,
                  branchName: op.branchName,
                  dateAD: op.dateAD,
                  dateBS: op.dateBS,
                });
              });
            }
          });
        }
      });
    }

    // 5. From Fixed Assets (POP_LOCATION_ASSIGNED - infrastructure equipment at POP)
    if (fixedAssets && fixedAssets.length > 0) {
      fixedAssets.forEach((asset: any) => {
        // Only include active fixed assets that are serial-tracked products
        if (asset.status === 'ACTIVE') {
          const product = products.find((p) => p.id === asset.productId);
          if (product && (product.requiresSerialTracking || product.trackingType !== 'QUANTITY_ONLY')) {
            records.push({
              id: `fa-${asset.id}`,
              sourceType: 'FIXED_ASSET',
              sourceId: asset.id,
              deviceSerial: asset.tagNumber || '',
              ponSerial: asset.tagNumber, // Use tag_number as identifier
              macAddress: undefined,
              productName: asset.name || 'Unknown Fixed Asset',
              productSku: product?.sku || '',
              status: 'POP_LOCATION_ASSIGNED',
              branchId: asset.branchId,
              branchName: branches.find((b) => b.id === asset.branchId)?.name,
              dateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
              dateBS: asset.placedInServiceDateBS || asset.acquisitionDateBS,
            });
          }
        }
      });
    }

    return records;
  }, [customerDevices, purchaseInvoices, shipments, stockOperations, fixedAssets, products, branches]);

  // Filter logic
  const filteredDevices = useMemo(() => {
    let result = allSerialDevices;

    // Branch filter (no default scope - show all branches)
    if (filterBranch !== 'ALL') {
      result = result.filter((d) => d.branchId === filterBranch);
    }

    // Status filter
    if (filterStatus !== 'ALL') {
      result = result.filter((d) => d.status === filterStatus);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.deviceSerial.toLowerCase().includes(q) ||
          (d.ponSerial?.toLowerCase() || '').includes(q) ||
          (d.macAddress?.toLowerCase() || '').includes(q) ||
          d.productName.toLowerCase().includes(q) ||
          d.productSku.toLowerCase().includes(q) ||
          (d.customerName?.toLowerCase() || '').includes(q) ||
          (d.branchName?.toLowerCase() || '').includes(q)
      );
    }

    return result;
  }, [allSerialDevices, filterBranch, filterStatus, searchQuery]);

  const pagination = useClientPagination(filteredDevices, 20, [searchQuery, filterBranch, filterStatus]);

  const statusCounts = {
    IN_STOCK: allSerialDevices.filter((d) => d.status === 'IN_STOCK').length,
    IN_TRANSIT: allSerialDevices.filter((d) => d.status === 'IN_TRANSIT').length,
    CUSTOMER_ASSIGNED: allSerialDevices.filter((d) => d.status === 'CUSTOMER_ASSIGNED').length,
    POP_LOCATION_ASSIGNED: allSerialDevices.filter((d) => d.status === 'POP_LOCATION_ASSIGNED').length,
    DAMAGED: allSerialDevices.filter((d) => d.status === 'DAMAGED').length,
  };

  const statusBadgeColor = (status: string) => {
    switch (status) {
      case 'IN_STOCK':
        return 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
      case 'IN_TRANSIT':
        return 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800';
      case 'CUSTOMER_ASSIGNED':
        return 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800';
      case 'POP_LOCATION_ASSIGNED':
        return 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800';
      case 'DAMAGED':
        return 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800';
      default:
        return '';
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'IN_STOCK':
        return <CheckCircle className="h-4 w-4" />;
      case 'IN_TRANSIT':
        return <Truck className="h-4 w-4" />;
      case 'CUSTOMER_ASSIGNED':
        return <ShoppingCart className="h-4 w-4" />;
      case 'POP_LOCATION_ASSIGNED':
        return <Wifi className="h-4 w-4" />;
      case 'DAMAGED':
        return <AlertCircle className="h-4 w-4" />;
      default:
        return null;
    }
  };

  const handleExportCSV = () => {
    const columns = [
      { key: 'deviceSerial', label: 'Device Serial' },
      { key: 'ponSerial', label: 'PON Serial' },
      { key: 'macAddress', label: 'MAC Address' },
      { key: 'productName', label: 'Product Name' },
      { key: 'productSku', label: 'Product SKU' },
      { key: 'status', label: 'Status' },
      { key: 'branchName', label: 'Branch' },
      { key: 'customerName', label: 'Customer (if assigned)' },
      { key: 'dateAD', label: 'Date (AD)' },
      { key: 'dateBS', label: 'Date (BS)' },
    ];

    const branchName = filterBranch === 'ALL' ? 'All Branches' : branches.find((b) => b.id === filterBranch)?.name || `Branch ${filterBranch}`;

    exportToCSV({
      filename: 'Complete_Serial_Device_Inventory',
      reportTitle: 'Complete Serial Device Inventory',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredDevices,
      columns,
    });
  };

  const canEditSerials = isOperationAllowed('edit-device-serials', currentUser?.role);

  const handleEditStart = (device: SerialDeviceRecord) => {
    setEditingDevice(device);
    setEditForm({
      deviceSerial: device.deviceSerial,
      ponSerial: device.ponSerial || '',
      macAddress: device.macAddress || '',
    });
    setEditError('');
  };

  const handleEditCancel = () => {
    setEditingDevice(null);
    setEditForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
    setEditError('');
  };

  const handleEditSave = async () => {
    if (!editingDevice) return;

    if (!editForm.deviceSerial.trim() || !editForm.ponSerial.trim()) {
      setEditError('Device Serial and PON Serial are required');
      return;
    }

    setEditLoading(true);
    setEditError('');

    try {
      await api.updateDeviceSerials({
        id: editingDevice.id,
        sourceType: editingDevice.sourceType,
        sourceId: editingDevice.sourceId,
        oldDeviceSerial: editingDevice.deviceSerial,
        oldPonSerial: editingDevice.ponSerial,
        oldMacAddress: editingDevice.macAddress,
        deviceSerial: editForm.deviceSerial.trim().toUpperCase(),
        ponSerial: editForm.ponSerial.trim().toUpperCase(),
        macAddress: editForm.macAddress.trim().toUpperCase() || undefined,
        branchId: editingDevice.branchId,
      });

      setEditingDevice(null);
      setEditForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
    } catch (err: any) {
      setEditError(err.message || err.response?.data?.message || 'Failed to update serial information');
    } finally {
      setEditLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Barcode className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <span>Complete Serial Device Inventory</span>
          </h2>
          <p className={`text-xs mt-1 text-slate-500 dark:text-slate-400`}>
            Unified view of all serial/PON/MAC devices across all branches (warehouse stock, in-transit, customer assignments, POP infrastructure, and damaged items)
          </p>
        </div>
        <button
          onClick={handleExportCSV}
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold border transition-all cursor-pointer shadow-xs bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <Download className="h-4 w-4" />
          <span>Export CSV</span>
        </button>
      </div>

      {/* Stats Cards - 5 consolidated statuses */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {[
          { key: 'IN_STOCK', label: 'In Stock', color: 'emerald' },
          { key: 'IN_TRANSIT', label: 'In Transit', color: 'blue' },
          { key: 'CUSTOMER_ASSIGNED', label: 'Customer', color: 'purple' },
          { key: 'POP_LOCATION_ASSIGNED', label: 'POP Location', color: 'indigo' },
          { key: 'DAMAGED', label: 'Damaged', color: 'rose' },
        ].map((stat) => (
          <div
            key={stat.key}
            className={`rounded-lg p-2.5 border text-center bg-${stat.color}-50/30 border-${stat.color}-200 dark:bg-slate-900/50 dark:border-slate-800`}
          >
            <div className={`text-[10px] font-semibold text-${stat.color}-900 dark:text-${stat.color}-400`}>{stat.label}</div>
            <div className={`text-lg font-mono font-bold mt-0.5 text-${stat.color}-700 dark:text-${stat.color}-300`}>
              {statusCounts[stat.key as keyof typeof statusCounts] || 0}
            </div>
          </div>
        ))}
      </div>

      {/* Filters - Branch + Status + Search (no Source/Reference) */}
      <div className={`p-3 rounded-xl border flex flex-wrap items-center gap-3 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search serial, PON, MAC, product, customer, branch..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-500 dark:placeholder-slate-400"
          />
        </div>

        <select
          value={filterBranch}
          onChange={(e) => setFilterBranch(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
        >
          <option value="ALL">All Branches</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name} ({branch.code})
            </option>
          ))}
        </select>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
        >
          <option value="ALL">All Status</option>
          <option value="IN_STOCK">In Stock</option>
          <option value="IN_TRANSIT">In Transit</option>
          <option value="CUSTOMER_ASSIGNED">Customer Assigned</option>
          <option value="POP_LOCATION_ASSIGNED">POP Location Assigned</option>
          <option value="DAMAGED">Damaged</option>
        </select>
      </div>

      {/* Table - Removed Source and Reference columns */}
      <div className="flex-1 min-h-0 rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
              <tr>
                <th className="px-2.5 py-2">Device Serial</th>
                <th className="px-2.5 py-2">PON Serial</th>
                <th className="px-2.5 py-2">MAC Address</th>
                <th className="px-2.5 py-2">Product</th>
                <th className="px-2.5 py-2 text-center">Status</th>
                <th className="px-2.5 py-2">Branch / Customer</th>
                <th className="px-2.5 py-2">Date</th>
                {canEditSerials && <th className="px-2.5 py-2 text-center">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredDevices.length === 0 ? (
                <tr>
                  <td colSpan={canEditSerials ? 8 : 7} className="p-6 text-center text-slate-500 dark:text-slate-400">
                    No serial devices found matching the filters.
                  </td>
                </tr>
              ) : (
                pagination.pagedItems.map((device) => (
                  <tr key={device.id} className="hover:bg-slate-100 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="px-2.5 py-2 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {device.deviceSerial}
                    </td>
                    <td className="px-2.5 py-2 font-mono text-slate-600 dark:text-slate-400">
                      {device.ponSerial || '-'}
                    </td>
                    <td className="px-2.5 py-2 font-mono text-slate-600 dark:text-slate-400">
                      {device.macAddress || '-'}
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="font-semibold text-slate-900 dark:text-white">{device.productName}</div>
                      {device.productSku && <div className="text-[9px] text-slate-500 dark:text-slate-400">{device.productSku}</div>}
                    </td>
                    <td className="px-2.5 py-2 text-center">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 border text-[10px] font-bold ${statusBadgeColor(device.status)}`}>
                        {statusIcon(device.status)}
                        {device.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="font-semibold text-slate-900 dark:text-white">{device.branchName || '-'}</div>
                      {device.customerName && <div className="text-[9px] text-slate-500 dark:text-slate-400">{device.customerName}</div>}
                    </td>
                    <td className="px-2.5 py-2 text-[10px] text-slate-600 dark:text-slate-400">
                      {device.dateAD ? formatDualDate(device.dateAD, 'AD') : '-'}
                    </td>
                    {canEditSerials && (
                      <td className="px-2.5 py-2 text-center">
                        {editingDevice?.id === device.id ? (
                          <div className="flex items-center gap-1 justify-center">
                            <button
                              onClick={handleEditSave}
                              disabled={editLoading}
                              className="p-1 text-green-600 hover:bg-green-100 rounded dark:hover:bg-green-950"
                              title="Save"
                            >
                              <Save className="h-4 w-4" />
                            </button>
                            <button
                              onClick={handleEditCancel}
                              disabled={editLoading}
                              className="p-1 text-slate-600 hover:bg-slate-100 rounded dark:hover:bg-slate-800"
                              title="Cancel"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleEditStart(device)}
                            className="p-1 text-slate-600 hover:bg-slate-100 rounded dark:hover:bg-slate-800 dark:text-slate-300"
                            title="Edit serials"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Serial Modal */}
      {editingDevice && (
        <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-md w-full border border-slate-300 dark:border-slate-700">
            <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700">
              <h3 className="font-bold text-slate-900 dark:text-white">Edit Serial Information</h3>
              <button
                onClick={handleEditCancel}
                disabled={editLoading}
                className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {editError && <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 p-2 rounded">{editError}</div>}

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Device Serial <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  value={editForm.deviceSerial}
                  onChange={(e) => setEditForm({ ...editForm, deviceSerial: e.target.value })}
                  disabled={editLoading}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  PON Serial <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  value={editForm.ponSerial}
                  onChange={(e) => setEditForm({ ...editForm, ponSerial: e.target.value })}
                  disabled={editLoading}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">MAC Address</label>
                <input
                  type="text"
                  value={editForm.macAddress}
                  onChange={(e) => setEditForm({ ...editForm, macAddress: e.target.value })}
                  disabled={editLoading}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono"
                />
              </div>
            </div>

            <div className="flex gap-2 p-4 border-t border-slate-200 dark:border-slate-700">
              <button
                onClick={handleEditCancel}
                disabled={editLoading}
                className="flex-1 px-4 py-2 text-xs font-bold rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white hover:bg-slate-300 dark:hover:bg-slate-600 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={editLoading}
                className="flex-1 px-4 py-2 text-xs font-bold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-50"
              >
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pagination */}
      {filteredDevices.length > 0 && (
        <TablePagination
          page={pagination.page}
          pageCount={pagination.pageCount}
          totalItems={pagination.totalItems}
          rangeStart={pagination.rangeStart}
          rangeEnd={pagination.rangeEnd}
          pageSize={pagination.pageSize}
          onPageChange={pagination.setPage}
        />
      )}
    </div>
  );
};
