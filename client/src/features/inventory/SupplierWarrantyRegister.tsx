/**
 * WTY-6: Suppliers Warranty — the inbound side of the coverage ledger.
 *
 * A thin declaration of the shared register's supplier configuration, kept as
 * its own screen so the tab, route and permission entry name one register.
 */
import React from 'react';
import type { User } from '../../types';
import { WarrantyRegister } from './warranty/WarrantyRegister';

interface SupplierWarrantyRegisterProps {
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
  refreshKey?: number;
}

export const SupplierWarrantyRegister: React.FC<SupplierWarrantyRegisterProps> = (props) => (
  <WarrantyRegister coverageType="VENDOR" {...props} />
);
