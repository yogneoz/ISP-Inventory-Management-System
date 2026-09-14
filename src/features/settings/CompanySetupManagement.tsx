import React, { useState, useEffect } from 'react';
import { CompanyProfile, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { processLogoFile } from '../../utils/logoImage';
import {
  Building2,
  Globe,
  Phone,
  Mail,
  FileText,
  CheckCircle2,
  AlertCircle,
  Upload,
  Image as ImageIcon,
  Sparkles,
  RefreshCw,
  Save,
  Printer,
  Receipt,
  ShieldCheck,
  MapPin,
  CreditCard,
  Briefcase,
  HelpCircle,
  QrCode,
  Tag,
  Building,
} from 'lucide-react';

interface CompanySetupManagementProps {
  companyProfile?: CompanyProfile | null;
  initialProfile?: CompanyProfile | null;
  onUpdateCompanyProfile?: (updated: CompanyProfile) => Promise<boolean | void>;
  onSave?: (updated: CompanyProfile) => Promise<boolean | void>;
  currentUser: User | null;
}

const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  id: 'COMP-001',
  name: 'Inventory Management System',
  legalName: 'Inventory Management System (Demo)',
  tagline: 'Multi-Branch Inventory Management',
  address: 'Kathmandu, Nepal',
  city: 'Kathmandu',
  country: 'Nepal',
  phone: '',
  email: '',
  website: '',
  panVatNumber: '',
  registrationNumber: '',
  logoUrl: '',
  logoPreset: 'telecom',
  currencySymbol: 'Rs.',
  defaultTaxRate: 13,
  notes: 'Default company profile — configure real details in Company Setup.',
};

const LOGO_PRESETS = [
  { id: 'telecom', label: 'Telecom & Fiber', icon: Globe, color: 'bg-indigo-600' },
  { id: 'building', label: 'Corporate HQ', icon: Building2, color: 'bg-blue-600' },
  { id: 'network', label: 'Network & Tech', icon: Briefcase, color: 'bg-emerald-600' },
  { id: 'shield', label: 'Security & Enterprise', icon: ShieldCheck, color: 'bg-amber-600' },
];

export const CompanySetupManagement: React.FC<CompanySetupManagementProps> = ({
  companyProfile,
  initialProfile,
  onUpdateCompanyProfile,
  onSave,
  currentUser,
}) => {
  const profile = companyProfile || initialProfile || DEFAULT_COMPANY_PROFILE;
  const canManage = isOperationAllowed('admin-branches', currentUser?.role);

  // Form State initialized with safe fallback
  const [name, setName] = useState(profile?.name || DEFAULT_COMPANY_PROFILE.name);
  const [legalName, setLegalName] = useState(profile?.legalName || DEFAULT_COMPANY_PROFILE.legalName || '');
  const [tagline, setTagline] = useState(profile?.tagline || DEFAULT_COMPANY_PROFILE.tagline || '');
  const [address, setAddress] = useState(profile?.address || DEFAULT_COMPANY_PROFILE.address);
  const [city, setCity] = useState(profile?.city || DEFAULT_COMPANY_PROFILE.city || '');
  const [country, setCountry] = useState(profile?.country || DEFAULT_COMPANY_PROFILE.country || 'Nepal');
  const [phone, setPhone] = useState(profile?.phone || DEFAULT_COMPANY_PROFILE.phone || '');
  const [email, setEmail] = useState(profile?.email || DEFAULT_COMPANY_PROFILE.email || '');
  const [website, setWebsite] = useState(profile?.website || DEFAULT_COMPANY_PROFILE.website || '');
  const [panVatNumber, setPanVatNumber] = useState(profile?.panVatNumber || DEFAULT_COMPANY_PROFILE.panVatNumber || '');
  const [registrationNumber, setRegistrationNumber] = useState(
    profile?.registrationNumber || DEFAULT_COMPANY_PROFILE.registrationNumber || ''
  );
  const [logoUrl, setLogoUrl] = useState(profile?.logoUrl || DEFAULT_COMPANY_PROFILE.logoUrl || '');
  const [logoPreset, setLogoPreset] = useState(profile?.logoPreset || DEFAULT_COMPANY_PROFILE.logoPreset || 'telecom');
  const [currencySymbol, setCurrencySymbol] = useState(profile?.currencySymbol || DEFAULT_COMPANY_PROFILE.currencySymbol || 'Rs.');
  const [defaultTaxRate, setDefaultTaxRate] = useState<number>(profile?.defaultTaxRate ?? DEFAULT_COMPANY_PROFILE.defaultTaxRate ?? 13);
  const [notes, setNotes] = useState(profile?.notes || DEFAULT_COMPANY_PROFILE.notes || '');

  // UI state
  const [activeTab, setActiveTab] = useState<'SETUP' | 'PREVIEW'>('SETUP');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Sync state when props update
  useEffect(() => {
    const p = companyProfile || initialProfile;
    if (!p) return;
    if (p.name !== undefined) setName(p.name || '');
    if (p.legalName !== undefined) setLegalName(p.legalName || '');
    if (p.tagline !== undefined) setTagline(p.tagline || '');
    if (p.address !== undefined) setAddress(p.address || '');
    if (p.city !== undefined) setCity(p.city || '');
    if (p.country !== undefined) setCountry(p.country || 'Nepal');
    if (p.phone !== undefined) setPhone(p.phone || '');
    if (p.email !== undefined) setEmail(p.email || '');
    if (p.website !== undefined) setWebsite(p.website || '');
    if (p.panVatNumber !== undefined) setPanVatNumber(p.panVatNumber || '');
    if (p.registrationNumber !== undefined) setRegistrationNumber(p.registrationNumber || '');
    if (p.logoUrl !== undefined) setLogoUrl(p.logoUrl || '');
    if (p.logoPreset !== undefined) setLogoPreset(p.logoPreset || 'telecom');
    if (p.currencySymbol !== undefined) setCurrencySymbol(p.currencySymbol || 'Rs.');
    if (p.defaultTaxRate !== undefined) setDefaultTaxRate(p.defaultTaxRate ?? 13);
    if (p.notes !== undefined) setNotes(p.notes || '');
  }, [companyProfile, initialProfile]);

  // Validation
  const isNameValid = name.trim().length > 0;
  const isAddressValid = address.trim().length > 0;
  const isPanVatValid = panVatNumber.trim().length > 0;
  const isFormValid = isNameValid && isAddressValid && isPanVatValid;

  const handleBlur = (field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        setErrorMessage('');
        setLogoUrl(await processLogoFile(file));
      } catch (err: any) {
        setErrorMessage(err?.message || 'Unable to process the selected logo image.');
      } finally {
        // Allow selecting the same file again after an error or replacement.
        e.target.value = '';
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, address: true, panVatNumber: true });

    if (!isFormValid) {
      setErrorMessage('Please fill in all required fields marked with an asterisk (*).');
      return;
    }

    setErrorMessage('');
    setIsSaving(true);
    setSaveSuccess(false);

    const updatedProfile: CompanyProfile = {
      ...(companyProfile || initialProfile || DEFAULT_COMPANY_PROFILE),
      name: name.trim(),
      legalName: legalName.trim(),
      tagline: tagline.trim(),
      address: address.trim(),
      city: city.trim(),
      country: country.trim(),
      phone: phone.trim(),
      email: email.trim(),
      website: website.trim(),
      panVatNumber: panVatNumber.trim(),
      registrationNumber: registrationNumber.trim(),
      logoUrl: logoUrl.trim(),
      logoPreset,
      currencySymbol: currencySymbol.trim() || 'Rs.',
      defaultTaxRate: Number(defaultTaxRate) || 13,
      notes: notes.trim(),
    };

    try {
      const saveFn = onUpdateCompanyProfile || onSave;
      if (saveFn) {
        const result = await saveFn(updatedProfile);
        if (result === false) {
          setErrorMessage('Failed to save company profile. Please check system permissions.');
        } else {
          setSaveSuccess(true);
          setTimeout(() => setSaveSuccess(false), 4000);
        }
      } else {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 4000);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error saving company profile.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3 pb-6">
      {/* Top Banner & Title */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 px-4 py-3 rounded-2xl text-white shadow-xl border border-indigo-900/50">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/30 text-indigo-300 border border-indigo-400/40 text-[10px] font-bold uppercase tracking-wider">
              System Branding & Profile
            </span>
            <span className="text-xs text-slate-400">Master Enterprise Settings</span>
          </div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2.5">
            <Building2 className="h-5 w-5 text-indigo-400" />
            Company Profile & Identity Setup
          </h1>
          <p className="text-xs text-slate-300 truncate max-w-2xl">
            Configure official corporate details, registered address, tax PAN/VAT IDs, logo graphics,
            and header settings. Updates apply dynamically across all POs, Invoices, Barcode Labels,
            and Reports.
          </p>
        </div>

        {/* Tab Selector */}
        <div className="shrink-0 flex items-center gap-1.5 bg-slate-800/80 p-1.5 rounded-xl border border-slate-700/60 self-start md:self-auto">
          <button
            type="button"
            onClick={() => setActiveTab('SETUP')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'SETUP'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
          >
            <Building className="h-4 w-4" />
            Profile Form
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('PREVIEW')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'PREVIEW'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
          >
            <Printer className="h-4 w-4 text-emerald-400" />
            Live Document Preview
          </button>
        </div>
      </div>

      {/* Required Field Status Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between gap-4 transition-all ${isFormValid ? 'bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800/80 dark:text-emerald-200' : 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800/80 dark:text-amber-200'}`}
      >
        <div className="flex items-center gap-3">
          {isFormValid ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0" />
          )}
          <div>
            <span className="text-xs font-bold uppercase tracking-wider block">
              {isFormValid ? 'Required Profile Fields Completed' : 'Action Required: Fill Required Fields'}
            </span>
            <span className="text-xs opacity-90">
              {isFormValid
                ? 'Company Name, Registered Address, and PAN/VAT Number are properly configured for official billing and reporting.'
                : 'Please complete all required fields (* Company Name, * Address, * PAN/VAT) to enable complete document generation.'}
            </span>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-2 text-xs font-mono font-bold">
          <span className={`px-2 py-0.5 rounded ${isNameValid ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/20 text-rose-600 dark:text-rose-400'}`}>
            Name: {isNameValid ? 'OK' : 'MISSING'}
          </span>
          <span className={`px-2 py-0.5 rounded ${isAddressValid ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/20 text-rose-600 dark:text-rose-400'}`}>
            Address: {isAddressValid ? 'OK' : 'MISSING'}
          </span>
          <span className={`px-2 py-0.5 rounded ${isPanVatValid ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/20 text-rose-600 dark:text-rose-400'}`}>
            PAN/VAT: {isPanVatValid ? 'OK' : 'MISSING'}
          </span>
        </div>
      </div>

      {saveSuccess && (
        <div className="p-4 rounded-xl bg-emerald-600 text-white font-bold text-xs flex items-center gap-2 shadow-lg animate-in fade-in">
          <CheckCircle2 className="h-5 w-5 text-emerald-200" />
          Company Profile updated successfully! Official document headers, invoices, and reports will now reflect these details.
        </div>
      )}

      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-600 text-white font-bold text-xs flex items-center gap-2 shadow-lg animate-in fade-in">
          <AlertCircle className="h-5 w-5 text-rose-200" />
          {errorMessage}
        </div>
      )}

      {activeTab === 'SETUP' ? (
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form Details (2 Columns) */}
          <div className="lg:col-span-2 space-y-6">
            {/* 1. Core Identity & Required Fields */}
            <div
              className={`p-4 rounded-2xl border space-y-4 shadow-sm bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between border-b pb-3 border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-indigo-500" />
                  <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                    1. Primary Company Details (Required *)
                  </h2>
                </div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Legal Credentials
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Company Name (Required) */}
                <div className="md:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Company Name <span className="text-rose-500 font-bold">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => handleBlur('name')}
                    placeholder="e.g. Inventory Digital Network PVT. LTD."
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all ${touched.name && !isNameValid ? 'border-rose-500 ring-2 ring-rose-500/20 bg-rose-50/50 dark:bg-rose-950/30' : 'bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500'}`}
                  />
                  {touched.name && !isNameValid && (
                    <p className="text-[11px] font-bold text-rose-500 mt-1">
                      Company Name is required for all legal documents and invoices.
                    </p>
                  )}
                </div>

                {/* Registered Address (Required) */}
                <div className="md:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Registered Office Address <span className="text-rose-500 font-bold">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    onBlur={() => handleBlur('address')}
                    placeholder="e.g. Example Street, Example City, Nepal"
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all ${touched.address && !isAddressValid ? 'border-rose-500 ring-2 ring-rose-500/20 bg-rose-50/50 dark:bg-rose-950/30' : 'bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500'}`}
                  />
                  {touched.address && !isAddressValid && (
                    <p className="text-[11px] font-bold text-rose-500 mt-1">
                      Registered Address is required for invoice headers and VAT filings.
                    </p>
                  )}
                </div>

                {/* PAN / VAT Number (Required) */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    PAN / VAT Tax ID Number <span className="text-rose-500 font-bold">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={panVatNumber}
                    onChange={(e) => setPanVatNumber(e.target.value)}
                    onBlur={() => handleBlur('panVatNumber')}
                    placeholder="e.g. 000000000"
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-mono font-bold transition-all ${touched.panVatNumber && !isPanVatValid ? 'border-rose-500 ring-2 ring-rose-500/20 bg-rose-50/50 dark:bg-rose-950/30' : 'bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500'}`}
                  />
                  {touched.panVatNumber && !isPanVatValid && (
                    <p className="text-[11px] font-bold text-rose-500 mt-1">
                      PAN/VAT Number is required for tax reporting and bill compliance.
                    </p>
                  )}
                </div>

                {/* Company Registration Number */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Company Registration Number
                  </label>
                  <input
                    type="text"
                    value={registrationNumber}
                    onChange={(e) => setRegistrationNumber(e.target.value)}
                    placeholder="e.g. REG-2075-88412"
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500`}
                  />
                </div>

                {/* Legal Entity / Full Corporate Name */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Full Registered Legal Entity Name
                  </label>
                  <input
                    type="text"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="e.g. Inventory Digital Network Private Limited"
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500`}
                  />
                </div>

                {/* Tagline / Business Motto */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Tagline / Business Motto
                  </label>
                  <input
                    type="text"
                    value={tagline}
                    onChange={(e) => setTagline(e.target.value)}
                    placeholder="e.g. High Speed Fiber & Enterprise Communication"
                    className={`w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all bg-white border-slate-300 text-slate-900 focus:border-indigo-500 dark:bg-slate-950 dark:border-slate-700 dark:text-white dark:focus:border-indigo-500`}
                  />
                </div>
              </div>
            </div>

            {/* 2. Contact Information & Regional Settings */}
            <div
              className={`p-4 rounded-2xl border space-y-4 shadow-sm bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between border-b pb-3 border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Phone className="h-5 w-5 text-indigo-500" />
                  <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                    2. Contact Information & Financial Settings
                  </h2>
                </div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Comms & Currency
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Phone */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Contact Phone Number(s)
                  </label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="e.g. +977-021-540123 / 9800000000"
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-semibold bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Support / Official Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g. info@example.com"
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-semibold bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                {/* Website */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Website Domain
                  </label>
                  <input
                    type="text"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="e.g. https://example.com"
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-semibold bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                {/* City */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    City / Municipality
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="e.g. Example City"
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-semibold bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                {/* Currency Symbol */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Currency Symbol
                  </label>
                  <input
                    type="text"
                    value={currencySymbol}
                    onChange={(e) => setCurrencySymbol(e.target.value)}
                    placeholder="e.g. Rs."
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-bold font-mono bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                {/* Default VAT Tax Rate */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Default Tax Rate (%)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={defaultTaxRate}
                    onChange={(e) => setDefaultTaxRate(Number(e.target.value))}
                    placeholder="13"
                    className={`w-full rounded-xl border px-3 py-1.5 text-xs font-bold bg-white border-slate-300 text-slate-900 dark:bg-slate-950 dark:border-slate-700 dark:text-white`}
                  />
                </div>
              </div>
            </div>

            {/* Save Button */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="submit"
                disabled={isSaving || !canManage}
                className={`px-6 py-3 rounded-xl font-extrabold text-sm text-white shadow-xl transition-all flex items-center gap-2 cursor-pointer ${
                  isSaving || !canManage
                    ? 'bg-slate-400 cursor-not-allowed opacity-60'
                    : 'bg-indigo-600 hover:bg-indigo-700 active:scale-95 shadow-indigo-600/30'
                }`}
              >
                {isSaving ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Saving Changes...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save & Apply Company Setup
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right Column: Logo Setup & Live Identity Card */}
          <div className="space-y-6">
            {/* Logo Setup Card */}
            <div
              className={`p-4 rounded-2xl border space-y-4 shadow-sm bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between border-b pb-3 border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-5 w-5 text-indigo-500" />
                  <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                    Logo & Visual Icon
                  </h2>
                </div>
              </div>

              {/* Logo Preview Display */}
              <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-2xl border-indigo-200 dark:border-slate-700 bg-indigo-50/30 dark:bg-slate-950/40 text-center relative group">
                {logoUrl ? (
                  <div className="relative">
                    <img
                      src={logoUrl}
                      alt="Company Logo Preview"
                      className="max-h-24 max-w-full object-contain rounded-lg shadow-md"
                    />
                    <button
                      type="button"
                      onClick={() => setLogoUrl('')}
                      className="absolute -top-2 -right-2 bg-rose-600 text-white rounded-full p-1 text-[10px] font-bold shadow-md hover:bg-rose-700"
                      title="Remove Logo Image"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-16 w-16 rounded-2xl bg-indigo-600 text-white flex items-center justify-center text-xl font-serif font-black shadow-lg">
                      {name ? name.substring(0, 2).toUpperCase() : 'IN'}
                    </div>
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Preset Emblem: {logoPreset.toUpperCase()}
                    </span>
                  </div>
                )}
              </div>

              {/* Preset Icon Selector */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                  Select System Logo Preset:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {LOGO_PRESETS.map((preset) => {
                    const PresetIcon = preset.icon;
                    const isSelected = logoPreset === preset.id && !logoUrl;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setLogoPreset(preset.id);
                        }}
                        className={`p-2.5 rounded-xl border flex items-center gap-2 text-xs font-bold transition-all cursor-pointer ${
                          isSelected
                            ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500/30'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <div className={`p-1 rounded-md text-white ${preset.color}`}>
                          <PresetIcon className="h-3.5 w-3.5" />
                        </div>
                        <span className="truncate">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Upload Image Option */}
              <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                  Upload Custom Logo File (PNG / JPG):
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border rounded-xl border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-200 cursor-pointer">
                    <Upload className="h-4 w-4 text-indigo-500" />
                    <span>Browse File...</span>
                    <input
                      type="file"
                      accept="image/png, image/jpeg, image/svg+xml"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                  </label>
                </div>
                <span className="text-[10px] text-slate-400 block">
                  The image is automatically cropped to its visible bounds, resized, and compressed while preserving its aspect ratio.
                </span>
              </div>
            </div>

            {/* Live Corporate Identity Card */}
            <div
              className={`p-4 rounded-2xl border space-y-4 shadow-sm bg-gradient-to-br from-white via-indigo-50/20 to-slate-50 border-slate-200 text-slate-900 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/60 dark:border-slate-800 dark:text-white`}
            >
              <div className="flex items-center justify-between border-b pb-3 border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-indigo-500" />
                  <h3 className="text-xs font-extrabold uppercase tracking-wider">
                    Live Corporate Header Badge
                  </h3>
                </div>
                <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                  Realtime Sync
                </span>
              </div>

              <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-white dark:bg-slate-950 shadow-md space-y-3">
                <div className="flex items-start gap-3">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Logo" className="h-10 max-w-[100px] object-contain" />
                  ) : (
                    <div className="h-10 w-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-serif font-black text-sm shadow-md">
                      {name ? name.substring(0, 2).toUpperCase() : 'IN'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="font-extrabold text-sm text-slate-900 dark:text-white truncate">
                      {name || 'COMPANY NAME HERE'}
                    </h4>
                    {tagline && (
                      <p className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 truncate">
                        {tagline}
                      </p>
                    )}
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                      {address || 'Company Address line will appear here'}
                    </p>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div>
                    <span className="text-slate-400 block font-sans text-[9px]">PAN / VAT ID</span>
                    <span className="font-bold text-indigo-600 dark:text-indigo-400">
                      {panVatNumber || 'REQUIRED'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-sans text-[9px]">REG. NUMBER</span>
                    <span className="font-bold text-slate-700 dark:text-slate-300">
                      {registrationNumber || 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </form>
      ) : (
        /* LIVE DOCUMENT PREVIEW TAB */
        <div className="space-y-3">
          <div
            className={`p-4 rounded-2xl border space-y-6 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}
          >
            <div className="flex items-center justify-between border-b pb-4 border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="text-base font-extrabold text-slate-900 dark:text-white">
                  Official Document Header Preview
                </h2>
                <p className="text-xs text-slate-500">
                  This live preview demonstrates how your saved company name, address, tax ID, and logo
                  appear on printed Purchase Orders, Sales Invoices, and Inventory Labels.
                </p>
              </div>
              <span className="px-3 py-1 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-bold">
                Invoice & Label Format
              </span>
            </div>

            {/* 1. Purchase Order / Invoice Header Simulation */}
            <div className="p-6 border-2 border-slate-300 dark:border-slate-700 rounded-2xl bg-white text-slate-900 space-y-6 font-sans shadow-lg">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b-2 border-slate-900 pb-4">
                <div className="flex items-center gap-3">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Logo" className="h-12 object-contain" />
                  ) : (
                    <div className="h-12 w-12 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-serif font-black text-lg">
                      {name ? name.substring(0, 2).toUpperCase() : 'IN'}
                    </div>
                  )}
                  <div>
                    <h1 className="text-lg font-black uppercase tracking-tight text-slate-900">
                      {name || 'YOUR COMPANY NAME PVT. LTD.'}
                    </h1>
                    <p className="text-xs font-bold text-indigo-900">{tagline}</p>
                    <p className="text-xs text-slate-600">{address}</p>
                    <p className="text-[11px] text-slate-500">
                      Phone: {phone || 'N/A'} | Email: {email || 'N/A'} | Web: {website || 'N/A'}
                    </p>
                  </div>
                </div>

                <div className="text-left sm:text-right border-l sm:border-l-0 pl-3 sm:pl-0 border-slate-300">
                  <span className="px-2.5 py-1 rounded bg-slate-900 text-white font-mono font-bold text-xs inline-block mb-1">
                    TAX INVOICE / PO
                  </span>
                  <p className="text-xs font-mono font-bold text-slate-700">
                    PAN / VAT No: <span className="text-indigo-900 font-extrabold">{panVatNumber || '60XXXXXXX'}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">Reg No: {registrationNumber || 'N/A'}</p>
                </div>
              </div>

              {/* Sample Table Rows */}
              <div className="space-y-2">
                <div className="bg-slate-100 p-2 rounded text-xs font-bold grid grid-cols-12 gap-2 text-slate-700">
                  <span className="col-span-1">#</span>
                  <span className="col-span-5">Product Description</span>
                  <span className="col-span-2 text-right">Qty</span>
                  <span className="col-span-2 text-right">Unit Price</span>
                  <span className="col-span-2 text-right">Amount</span>
                </div>
                <div className="p-2 text-xs grid grid-cols-12 gap-2 border-b text-slate-800">
                  <span className="col-span-1 font-bold">1</span>
                  <span className="col-span-5 font-semibold">Gpon OLT Dual Power Module 8-Port</span>
                  <span className="col-span-2 text-right font-mono">2 Pcs</span>
                  <span className="col-span-2 text-right font-mono">{currencySymbol} 45,000</span>
                  <span className="col-span-2 text-right font-mono font-bold">{currencySymbol} 90,000</span>
                </div>
              </div>

              {/* Footer Note */}
              <div className="flex justify-between items-center text-[10px] text-slate-500 pt-2 border-t">
                <span>Computer Generated Document | System Verified</span>
                <span>Official Seal & Signature Placeholder</span>
              </div>
            </div>

            {/* 2. Barcode Label Header Simulation */}
            <div className="p-4 border rounded-xl bg-slate-50 dark:bg-slate-950 space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block">
                Thermal Barcode Sticker Header Simulation
              </span>
              <div className="max-w-xs mx-auto p-3 bg-white text-slate-900 border-2 border-slate-900 rounded-lg text-center space-y-1.5 shadow-md">
                <h4 className="text-xs font-black tracking-tight uppercase border-b border-slate-900 pb-1">
                  {name || 'COMPANY NAME'}
                </h4>
                <p className="text-[9px] font-bold text-slate-600">
                  ONU ROUTER 2.4G DUAL BAND
                </p>
                <div className="py-1 font-mono text-xs font-black tracking-widest bg-slate-100 rounded">
                  * SN: ONU-9988-7766 *
                </div>
                <p className="text-[8px] text-slate-500 font-mono">
                  PAN: {panVatNumber} | {address}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
