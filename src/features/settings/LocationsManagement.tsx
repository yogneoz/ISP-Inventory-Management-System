import React, { useState, useEffect } from 'react';
import { Branch, LocationRecord } from '../../types';
import { MapPin, Plus, Search, Building2, Server, Globe, ExternalLink, Check, Copy, Navigation, Trash2, Edit } from 'lucide-react';
import { api } from '../../services/api';

interface LocationsManagementProps {
  branches: Branch[];
  isDarkMode?: boolean;
}

export const LocationsManagement: React.FC<LocationsManagementProps> = ({
  branches,
  isDarkMode = false,
}) => {
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBranchFilter, setSelectedBranchFilter] = useState<string>('ALL');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('ALL');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<Omit<LocationRecord, 'id'>>({
    name: '',
    type: 'POP_SERVER_ROOM',
    branchId: branches[0]?.id || 'BR-KTM',
    address: '',
    coordinates: { latitude: 27.7172, longitude: 85.324 },
    contactPerson: '',
    contactPhone: '',
    notes: '',
    activeAssetsCount: 0,
  });

  const loadLocations = async () => {
    try {
      setLoading(true);
      const data = await api.getLocations(selectedBranchFilter);
      setLocations(data || []);
    } catch (err) {
      console.error('Failed to load locations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLocations();
  }, [selectedBranchFilter]);

  const filteredLocations = locations.filter((loc) => {
    const matchesSearch =
      (loc?.name || '').toLowerCase().includes((searchTerm || '').toLowerCase()) ||
      (loc?.address || '').toLowerCase().includes((searchTerm || '').toLowerCase()) ||
      (loc.contactPerson && (loc?.contactPerson || '').toLowerCase().includes((searchTerm || '').toLowerCase()));
    const matchesBranch = selectedBranchFilter === 'ALL' || loc.branchId === selectedBranchFilter;
    const matchesType = selectedTypeFilter === 'ALL' || loc.type === selectedTypeFilter;
    return matchesSearch && matchesBranch && matchesType;
  });

  const handleCopyCoords = (loc: LocationRecord) => {
    if (!loc.coordinates) return;
    const text = `${loc.coordinates.latitude}, ${loc.coordinates.longitude}`;
    navigator.clipboard.writeText(text);
    setCopiedId(loc.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    try {
      await api.createLocation(formData);
      setIsModalOpen(false);
      setFormData({
        name: '',
        type: 'POP_SERVER_ROOM',
        branchId: branches[0]?.id || 'BR-KTM',
        address: '',
        coordinates: { latitude: 27.7172, longitude: 85.324 },
        contactPerson: '',
        contactPhone: '',
        notes: '',
        activeAssetsCount: 0,
      });
      await loadLocations();
    } catch (err) {
      console.error('Failed to create location:', err);
    }
  };

  const handleDeleteLocation = async (id: string) => {
    if (confirm('Are you sure you want to delete this location site?')) {
      try {
        await api.deleteLocation(id);
        await loadLocations();
      } catch (err) {
        console.error('Failed to delete location:', err);
      }
    }
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'POP_SERVER_ROOM':
        return 'bg-purple-50 dark:bg-purple-950/80 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-800';
      case 'FIBER_NETWORK_NODE':
        return 'bg-sky-50 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800';
      case 'CUSTOMER_SITE':
        return 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800';
      case 'WAREHOUSE':
        return 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800';
      default:
        return 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700';
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      {/* Top Header */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <MapPin className="h-5 w-5 text-indigo-500" />
            <span>Location & POP Management</span>
          </h2>
          <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Track POP server rooms, fiber route junction nodes, customer installation sites, and GPS map coordinates.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-md hover:bg-indigo-500 transition-all cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Add New Location / POP</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-none">
        <div className={`p-3.5 rounded-2xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-xs'
        }`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Total Network Sites</span>
          <div className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400">{locations.length} Sites</div>
        </div>

        <div className={`p-3.5 rounded-2xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-xs'
        }`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">POP Server Rooms</span>
          <div className="text-xl font-bold font-mono text-purple-600 dark:text-purple-400">
            {locations.filter((l) => l.type === 'POP_SERVER_ROOM').length} Rooms
          </div>
        </div>

        <div className={`p-3.5 rounded-2xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-xs'
        }`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Fiber Route Nodes</span>
          <div className="text-xl font-bold font-mono text-sky-600 dark:text-sky-400">
            {locations.filter((l) => l.type === 'FIBER_NETWORK_NODE').length} Nodes
          </div>
        </div>

        <div className={`p-3.5 rounded-2xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-xs'
        }`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Assigned Equipment</span>
          <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
            {locations.reduce((sum, l) => sum + (l.activeAssetsCount || 0), 0)} Units
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-wrap items-center justify-between gap-3 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Search className="h-4 w-4 text-slate-400 ml-1" />
          <input
            type="text"
            placeholder="Search locations, address, contact person..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-transparent text-xs focus:outline-none placeholder:text-slate-400"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedBranchFilter}
            onChange={(e) => setSelectedBranchFilter(e.target.value)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
              isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <option value="ALL">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>

          <select
            value={selectedTypeFilter}
            onChange={(e) => setSelectedTypeFilter(e.target.value)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
              isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <option value="ALL">All Location Types</option>
            <option value="POP_SERVER_ROOM">POP Server Room</option>
            <option value="FIBER_NETWORK_NODE">Fiber Network Node</option>
            <option value="CUSTOMER_SITE">Customer Site</option>
            <option value="WAREHOUSE">Warehouse / Hub</option>
          </select>
        </div>
      </div>

      {/* Grid of Locations */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-4">
          {filteredLocations.map((loc) => {
            const branchObj = branches.find((b) => b.id === loc.branchId);
            return (
              <div
                key={loc.id}
                className={`p-4 rounded-2xl border shadow-sm flex flex-col justify-between space-y-3 transition-all ${
                  isDarkMode ? 'bg-[#0f1218] border-slate-800 hover:border-slate-700' : 'bg-white border-slate-200 hover:border-indigo-200'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-lg border ${getTypeBadge(loc.type)}`}>
                      {loc.type === 'POP_SERVER_ROOM' && <Server className="h-3 w-3" />}
                      {loc.type === 'FIBER_NETWORK_NODE' && <Globe className="h-3 w-3" />}
                      {loc.type === 'CUSTOMER_SITE' && <MapPin className="h-3 w-3" />}
                      {loc.type === 'WAREHOUSE' && <Building2 className="h-3 w-3" />}
                      <span>{loc.type.replace(/_/g, ' ')}</span>
                    </span>

                    <span className="text-[10px] font-mono font-bold text-slate-400">{loc.id}</span>
                  </div>

                  <h3 className={`font-bold text-sm leading-snug ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                    {loc.name}
                  </h3>

                  <p className={`text-xs mt-1 flex items-center gap-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    <MapPin className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                    <span className="line-clamp-1">{loc.address}</span>
                  </p>

                  {loc.notes && (
                    <p className={`text-[11px] mt-2 p-2 rounded-xl border ${
                      isDarkMode ? 'bg-slate-900/60 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-100 text-slate-600'
                    }`}>
                      {loc.notes}
                    </p>
                  )}
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 text-[11px]">Branch:</span>
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                      {branchObj ? `${branchObj.name} (${branchObj.code})` : loc.branchId}
                    </span>
                  </div>

                  {loc.coordinates && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400 text-[11px] flex items-center gap-1">
                        <Navigation className="h-3 w-3 text-sky-500" />
                        <span>GPS Map Coords:</span>
                      </span>

                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-bold text-sky-600 dark:text-sky-400">
                          {loc.coordinates.latitude}, {loc.coordinates.longitude}
                        </span>

                        <button
                          onClick={() => handleCopyCoords(loc)}
                          className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title="Copy GPS Coordinates"
                        >
                          {copiedId === loc.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>

                        <a
                          href={`https://maps.google.com/?q=${loc.coordinates.latitude},${loc.coordinates.longitude}`}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title="View on Google Maps"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-slate-400 text-[11px]">In-Service Equipment:</span>
                    <span className="font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {loc.activeAssetsCount || 0} Units Assigned
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add Location Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
          <div className={`w-full max-w-lg rounded-3xl border shadow-2xl overflow-hidden p-6 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <MapPin className="h-5 w-5 text-indigo-500" />
                <span>Add Network Location / POP</span>
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddLocation} className="space-y-4 mt-4 text-xs">
              <div>
                <label className="block font-bold mb-1">Location Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Biratnagar Main POP Server Room"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className={`w-full rounded-xl border p-2.5 ${
                    isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                  }`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">Type *</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                    className={`w-full rounded-xl border p-2.5 ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                    }`}
                  >
                    <option value="POP_SERVER_ROOM">POP Server Room</option>
                    <option value="FIBER_NETWORK_NODE">Fiber Network Node</option>
                    <option value="CUSTOMER_SITE">Customer Site</option>
                    <option value="WAREHOUSE">Warehouse / Hub</option>
                    <option value="BRANCH_OFFICE">Branch Office</option>
                  </select>
                </div>

                <div>
                  <label className="block font-bold mb-1">Branch *</label>
                  <select
                    value={formData.branchId}
                    onChange={(e) => setFormData({ ...formData, branchId: e.target.value })}
                    className={`w-full rounded-xl border p-2.5 ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-300'
                    }`}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold mb-1">Address / Street Location *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Main Road, Ward 4, Kathmandu"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className={`w-full rounded-xl border p-2.5 ${
                    isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                  }`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">Latitude Coordinate</label>
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="27.7172"
                    value={formData.coordinates?.latitude || ''}
                    onChange={(e) => setFormData({
                      ...formData,
                      coordinates: {
                        latitude: parseFloat(e.target.value) || 0,
                        longitude: formData.coordinates?.longitude || 0,
                      },
                    })}
                    className={`w-full rounded-xl border p-2.5 font-mono ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                    }`}
                  />
                </div>

                <div>
                  <label className="block font-bold mb-1">Longitude Coordinate</label>
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="85.3240"
                    value={formData.coordinates?.longitude || ''}
                    onChange={(e) => setFormData({
                      ...formData,
                      coordinates: {
                        latitude: formData.coordinates?.latitude || 0,
                        longitude: parseFloat(e.target.value) || 0,
                      },
                    })}
                    className={`w-full rounded-xl border p-2.5 font-mono ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                    }`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">Contact Person</label>
                  <input
                    type="text"
                    placeholder="e.g. Site Incharge Name"
                    value={formData.contactPerson}
                    onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                    className={`w-full rounded-xl border p-2.5 ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                    }`}
                  />
                </div>

                <div>
                  <label className="block font-bold mb-1">Contact Phone</label>
                  <input
                    type="text"
                    placeholder="98XXXXX"
                    value={formData.contactPhone}
                    onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })}
                    className={`w-full rounded-xl border p-2.5 ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold mb-1">Technical Notes / Cable Route Details</label>
                <textarea
                  rows={2}
                  placeholder="e.g. Fiber drum cable length, OLT rack details, power backup setup"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className={`w-full rounded-xl border p-2.5 ${
                    isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-300'
                  }`}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Save Location
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
