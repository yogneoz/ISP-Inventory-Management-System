import React from 'react';
import { CompanyProfile } from '../../types';
import { getCompanyAddress } from '../../utils/companyProfile';

interface DocumentLetterheadProps {
  companyProfile?: CompanyProfile | null;
  /** Optional second title line under the company name (e.g. "VAT REGISTER"). */
  title?: string;
  /** Optional as-of / period date line. */
  subtitle?: string;
  /**
   * When true the company identity block (name / address / PAN) renders on screen.
   * When false (default) it is hidden on screen and shown only in print / export output.
   */
  showOnScreen?: boolean;
}

/**
 * Reusable official document letterhead pulled from the Company Profile setup.
 * Used at the top of every printable report / register so all document headers
 * reflect the configured company identity (name, registered address, PAN/VAT).
 */
export const DocumentLetterhead: React.FC<DocumentLetterheadProps> = ({
  companyProfile,
  title,
  subtitle,
  showOnScreen = false,
}) => {
  const name = companyProfile?.legalName || companyProfile?.name || 'Inventory Management System';
  const addressLine = getCompanyAddress(companyProfile);
  const contactLine = [
    companyProfile?.phone ? `Tel: ${companyProfile.phone}` : '',
    companyProfile?.email ? companyProfile.email : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return (
    <div className="text-center border-b-2 border-slate-300 dark:border-slate-700 pb-3">
      <h2 className={`text-lg sm:text-xl font-serif font-extrabold text-slate-900 dark:text-white tracking-tight ${showOnScreen ? '' : 'hidden print:block'}`}>
        {name}
      </h2>
      {(addressLine || contactLine) && (
        <p className={`text-[11px] text-slate-500 dark:text-slate-400 mt-1 ${showOnScreen ? '' : 'hidden print:block'}`}>
          {addressLine}
          {addressLine && contactLine ? ' | ' : ''}
          {contactLine}
        </p>
      )}
      {companyProfile?.panVatNumber && (
        <p className={`text-[11px] text-slate-500 dark:text-slate-400 ${showOnScreen ? '' : 'hidden print:block'}`}>
          PAN / VAT No: {companyProfile.panVatNumber}
          {companyProfile.registrationNumber ? ` | Reg No: ${companyProfile.registrationNumber}` : ''}
        </p>
      )}
      {title && (
        <h3 className="text-base sm:text-lg font-serif font-bold text-slate-800 dark:text-slate-200 mt-1.5 tracking-wide">
          {title}
        </h3>
      )}
      {subtitle && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
      )}
    </div>
  );
};