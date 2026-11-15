import type { TdsExemptionReason } from '../services/api/lenders';

export const TDS_REASON_LABEL: Record<TdsExemptionReason, string> = {
  RESIDENT_BANK: 'Resident bank lender',
  RESIDENT_FI: 'Resident financial institution',
  INTER_COOP: 'Inter-co-operative lending',
  NO_INTEREST: 'No interest charged',
  TREATY: 'Treaty / non-resident relief',
  EXEMPT_INCOME: 'Exempt income',
  OTHER: 'Other documented exemption',
};

export const TDS_REFERENCE_REQUIRED: Record<TdsExemptionReason, boolean> = {
  RESIDENT_BANK: true,
  RESIDENT_FI: true,
  INTER_COOP: true,
  NO_INTEREST: false,
  TREATY: true,
  EXEMPT_INCOME: true,
  OTHER: true,
};
