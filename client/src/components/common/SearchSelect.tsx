/**
 * Searchable replacement for a native `<select>` whose options are already in
 * memory (branches, voucher families, currencies, party lists).
 *
 * It delegates the interaction to SearchPicker — the same debounce, keyboard
 * navigation, clear/revert and failure states used by the customer and ledger
 * pickers — so a static list behaves exactly like an async directory: type to
 * filter, Enter to commit, Escape to keep the current value. The filter is
 * local because the caller already holds the list; async directories pass a
 * server search to SearchPicker directly.
 */
import React, { useCallback, useMemo } from 'react';
import { SearchPicker } from './SearchPicker';

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Secondary line inside the result row; never part of the committed label. */
  description?: string;
}

export interface SearchSelectProps {
  value: string;
  options: readonly SearchSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  minChars?: number;
  /** Root id for the search input, when a caller labels it with htmlFor. */
  inputId?: string;
  /** Render the list in a fixed-position portal (use inside a scroll box). */
  portal?: boolean;
  panelMinWidth?: number;
  panelMaxWidth?: number;
  emptyLabel?: string;
  /** Required selects pass false so the committed value cannot be cleared. */
  allowClear?: boolean;
}

export const SearchSelect: React.FC<SearchSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Search…',
  disabled = false,
  className = '',
  inputClassName = 'h-9 text-xs font-semibold',
  ariaLabel = 'Search options',
  minChars = 0,
  inputId,
  portal = false,
  panelMinWidth,
  panelMaxWidth,
  emptyLabel = 'No matching option.',
  allowClear = true,
}) => {
  const search = useCallback(
    (query: string) => {
      const term = query.trim().toLowerCase();
      if (!term) return [...options];
      return options.filter(
        (option) =>
          option.label.toLowerCase().includes(term) ||
          option.value.toLowerCase().includes(term)
      );
    },
    [options]
  );

  const selected = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  );

  return (
    <SearchPicker<SearchSelectOption>
      value={selected ? { id: selected.value, label: selected.label } : null}
      onSelect={(option) => onChange(option?.value || '')}
      search={search}
      itemKey={(option) => option.value}
      itemLabel={(option) => option.label}
      inputId={inputId}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      inputClassName={inputClassName}
      minChars={minChars}
      debounceMs={0}
      ariaLabel={ariaLabel}
      allowClear={allowClear}
      labels={{
        hint: 'Type to filter the list.',
        selectedHint: `Selected: ${selected?.label || ''}. Type to filter or replace it.`,
        loading: 'Filtering…',
        empty: emptyLabel,
        error: 'Could not filter the list.',
      }}
      portal={portal}
      panelMinWidth={panelMinWidth}
      panelMaxWidth={panelMaxWidth}
      renderOption={(option, isSelected) => (
        <div className="min-w-0 pr-2">
          <div className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-white">
            {option.label}
          </div>
          {option.description && (
            <div className="mt-0.5 break-words text-[10px] text-slate-500 dark:text-slate-400">
              {option.description}
            </div>
          )}
          {isSelected && <span className="sr-only">Selected</span>}
        </div>
      )}
    />
  );
};
