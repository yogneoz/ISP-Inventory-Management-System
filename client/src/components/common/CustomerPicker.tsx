/**
 * Shared searchable customer picker.
 *
 * A thin wrapper over SearchPicker: the mechanics (debounce, stale-response
 * guard, keyboard navigation, Retry) live in one place, while this file owns
 * the customer-directory request shape and the row layout.
 *
 * The screen supplies the API method (`search={api.searchCustomers}`), so the
 * per-screen surface pins still see the read. Use `portal` inside a scrolling
 * table so the list is not clipped.
 */
import React from 'react';
import { SearchPicker, type SearchPickerValue } from './SearchPicker';
import type { CustomerRecord } from '../../types';

export type CustomerPickerValue = SearchPickerValue;

export interface CustomerPickerProps {
  value: CustomerPickerValue | null;
  /** Called with the picked directory row, or null when the field is cleared. */
  onSelect: (customer: CustomerRecord | null) => void;
  /**
   * Directory search. Must be stable across renders (pass the API method
   * directly), because the debounce effect depends on its identity.
   */
  search: (query: string) => Promise<CustomerRecord[]>;
  inputId?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Root wrapper classes, e.g. the grid span on the form. */
  className?: string;
  /** Extra input classes for the host form's compact sizing. */
  inputClassName?: string;
  minChars?: number;
  debounceMs?: number;
  ariaLabel?: string;
  /** Render the list in a fixed-position portal (use inside scroll containers). */
  portal?: boolean;
}

const displayCustomer = (customer: CustomerRecord): string =>
  customer.customerId ? `${customer.customerName} (${customer.customerId})` : customer.customerName;

export const CustomerPicker: React.FC<CustomerPickerProps> = ({
  value,
  onSelect,
  search,
  inputId,
  placeholder = 'Search customer name, code, phone, or address…',
  disabled = false,
  required = false,
  className = '',
  inputClassName = 'h-9 text-xs font-semibold',
  minChars = 2,
  debounceMs = 200,
  ariaLabel = 'Search customers',
  portal = false,
}) => (
  <SearchPicker<CustomerRecord>
    value={value}
    onSelect={onSelect}
    search={search}
    itemKey={(customer) => customer.id}
    itemLabel={displayCustomer}
    inputId={inputId}
    placeholder={placeholder}
    disabled={disabled}
    required={required}
    className={className}
    inputClassName={inputClassName}
    minChars={minChars}
    debounceMs={debounceMs}
    ariaLabel={ariaLabel}
    clearTitle="Clear customer selection"
    openTitle="Show customer search"
    labels={{
      hint: `Type at least ${minChars} characters to search the customer directory.`,
      loading: 'Searching customers…',
      empty: 'No matching customer in the directory.',
      error: 'Could not search the customer directory.',
    }}
    portal={portal}
    renderOption={(customer) => (
      <div className="min-w-0 pr-2">
        <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
          {customer.customerName}{' '}
          <span className="font-mono text-[10px] text-slate-500">({customer.customerId})</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-slate-500 dark:text-slate-400">
          {customer.contactNumber && <span>{customer.contactNumber}</span>}
          {customer.address && <span>• {customer.address}</span>}
        </div>
      </div>
    )}
  />
);
