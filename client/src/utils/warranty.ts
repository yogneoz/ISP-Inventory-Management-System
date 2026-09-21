export interface WarrantyInfo {
  status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
  label: string;
  daysRemaining: number;
  warrantyEndDateAD: string;
  warrantyEndDateBS: string;
  warrantyMonths: number;
}

/**
 * Calculates warranty details from an issued/commissioned date (AD).
 * Default warranty period is 12 months unless specified otherwise.
 */
export function getWarrantyInfo(issuedDateAD: string, customMonths: number = 12): WarrantyInfo {
  if (!issuedDateAD) {
    return {
      status: 'EXPIRED',
      label: 'No Issue Date',
      daysRemaining: 0,
      warrantyEndDateAD: '-',
      warrantyEndDateBS: '-',
      warrantyMonths: customMonths,
    };
  }

  const issue = new Date(issuedDateAD);
  if (isNaN(issue.getTime())) {
    return {
      status: 'EXPIRED',
      label: 'Invalid Date',
      daysRemaining: 0,
      warrantyEndDateAD: '-',
      warrantyEndDateBS: '-',
      warrantyMonths: customMonths,
    };
  }

  // Calculate end date
  const endDate = new Date(issue);
  endDate.setMonth(endDate.getMonth() + customMonths);

  const today = new Date();
  // Clear time portion for accurate day calculation
  today.setHours(0, 0, 0, 0);
  const endNoTime = new Date(endDate);
  endNoTime.setHours(0, 0, 0, 0);

  const diffMs = endNoTime.getTime() - today.getTime();
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const warrantyEndDateAD = endDate.toISOString().split('T')[0];

  let status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' = 'VALID';
  let label = '';

  if (daysRemaining < 0) {
    status = 'EXPIRED';
    label = `Expired (${Math.abs(daysRemaining)} days ago)`;
  } else if (daysRemaining <= 30) {
    status = 'EXPIRING_SOON';
    label = `Expiring (${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} left)`;
  } else {
    status = 'VALID';
    label = `Valid (${daysRemaining} days left)`;
  }

  return {
    status,
    label,
    daysRemaining,
    warrantyEndDateAD,
    warrantyEndDateBS: `${warrantyEndDateAD} (AD)`,
    warrantyMonths: customMonths,
  };
}
