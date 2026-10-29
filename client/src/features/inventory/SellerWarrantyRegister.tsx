/**
 * WTY-6: Sellers Warranty — the outbound promise side of the coverage ledger.
 *
 * A thin declaration of the shared register's seller configuration, kept as its
 * own screen so the tab, route and permission entry name one register.
 */
import React from 'react';
import type { User } from '../../types';
import { WarrantyRegister } from './warranty/WarrantyRegister';

interface SellerWarrantyRegisterProps {
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
  refreshKey?: number;
}

export const SellerWarrantyRegister: React.FC<SellerWarrantyRegisterProps> = (props) => (
  <WarrantyRegister coverageType="SELLER" {...props} />
);
