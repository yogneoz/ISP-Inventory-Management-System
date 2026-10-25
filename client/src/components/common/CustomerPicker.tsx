/**
 * Shared searchable customer picker.
 *
 * Extracted from the two inline copies in SalesInvoices and ProductSalePanel,
 * which filtered the full `customers` bootstrap array. This version searches
 * the paged customer directory instead, so the control stays usable when the
 * directory holds ~12k rows.
 *
 * The screen owns the request: pass its API method (`search={api.searchCustomers}`)
 * so the feature-screen surface guards still see the read. The component owns
 * the interaction — debounce, stale-response guard, keyboard navigation,
 * loading, no-matches and a retryable failure state.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { CustomerRecord } from '../../types';
import { inputClass } from './styleConstants';

export interface CustomerPickerValue {
  id: string;
  /** Visible label, usually `Name (CUS-…)`. */
  label: string;
}

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
}) => {
  const selectedLabel = value?.label || '';
  const [query, setQuery] = useState(selectedLabel);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CustomerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [retryToken, setRetryToken] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeq = useRef(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Keep the visible label in step with the canonical value the parent owns,
  // without overwriting text the operator is actively typing.
  useEffect(() => {
    if (!open || !dirty) setQuery(selectedLabel);
  }, [selectedLabel, open, dirty]);

  // Debounced directory search. The seq guard makes a slow earlier response
  // unable to overwrite the rows for the current query.
  useEffect(() => {
    if (!open || !dirty) {
      // The field is not being searched: never leave a spinner or an older
      // query's rows behind for the next focus.
      setResults([]);
      setHasSearched(false);
      setError('');
      setLoading(false);
      setHighlighted(-1);
      return;
    }
    const q = query.trim();
    if (q.length < minChars) {
      setResults([]);
      setHasSearched(false);
      setError('');
      setLoading(false);
      setHighlighted(-1);
      return;
    }

    // Do not present the previous query's rows as matches for this one while
    // the next request is still debouncing.
    setResults([]);
    setHasSearched(false);
    setError('');
    setHighlighted(-1);
    // Show the spinner through the debounce window instead of an empty panel.
    setLoading(true);

    const timer = window.setTimeout(() => {
      const requestId = ++requestSeq.current;
      Promise.resolve()
        .then(() => search(q))
        .then((rows) => {
          if (requestId !== requestSeq.current) return;
          const list = Array.isArray(rows) ? rows : [];
          setResults(list);
          setHasSearched(true);
          setHighlighted(list.length > 0 ? 0 : -1);
        })
        .catch((err: unknown) => {
          if (requestId !== requestSeq.current) return;
          // A failed read is not "no matches": keep the two states distinct
          // and offer a retry (DF-11/DF-17 convention).
          const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
          setResults([]);
          setHasSearched(true);
          setError(`Could not search the customer directory.${detail}`);
        })
        .finally(() => {
          if (requestId === requestSeq.current) setLoading(false);
        });
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      requestSeq.current += 1;
    };
  }, [open, dirty, query, minChars, debounceMs, search, retryToken]);

  // Close on a click outside. Restore the selected label (or clear free text)
  // so the field never looks like it holds a customer that was not picked.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setDirty(false);
        setQuery(selectedLabel);
        setResults([]);
        setHasSearched(false);
        setError('');
        setLoading(false);
        setHighlighted(-1);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, selectedLabel]);

  const pick = (customer: CustomerRecord) => {
    setQuery(displayCustomer(customer));
    setDirty(false);
    setOpen(false);
    setResults([]);
    setError('');
    setHasSearched(false);
    setLoading(false);
    setHighlighted(-1);
    onSelect(customer);
  };

  const clear = () => {
    setQuery('');
    setDirty(false);
    setOpen(true);
    setResults([]);
    setError('');
    setHasSearched(false);
    setLoading(false);
    setHighlighted(-1);
    onSelect(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      if (results.length > 0) {
        setHighlighted((current) => Math.min(results.length - 1, current + 1));
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) {
        setHighlighted((current) => Math.max(0, current - 1));
      }
      return;
    }
    if (event.key === 'Enter') {
      if (open) {
        const candidate = results[highlighted] || (results.length === 1 ? results[0] : null);
        if (candidate) {
          event.preventDefault();
          pick(candidate);
          return;
        }
      }
      // Enter must not submit the form while the visible text is only a query:
      // the parent would post its previous customer under the typed words.
      if (dirty) {
        event.preventDefault();
        setOpen(false);
        setDirty(false);
        setQuery(selectedLabel);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setDirty(false);
      setQuery(selectedLabel);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setDirty(false);
      setQuery(selectedLabel);
    }
  };

  // A focused but untouched field is not a search: show guidance, never the
  // previous query's rows (or a spinner from a request it cancelled).
  const showHint = !dirty || query.trim().length < minChars;

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()}>
      <div className="relative flex w-full items-center">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && highlighted >= 0 ? optionId(highlighted) : undefined}
          aria-autocomplete="list"
          aria-busy={loading}
          autoComplete="off"
          spellCheck={false}
          required={required}
          disabled={disabled}
          value={query}
          placeholder={placeholder}
          onFocus={(event) => {
            setOpen(true);
            // Select the current label so typing replaces it in one go.
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setDirty(true);
            setOpen(true);
            // Keep the parent's value until a row is actually picked (or the
            // field is explicitly cleared). Escape/blur/Tab restore this label,
            // so a half-typed query can never be submitted under the old FK.
          }}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && rootRef.current?.contains(next)) return;
            setOpen(false);
            setDirty(false);
            setQuery(selectedLabel);
            setResults([]);
            setHasSearched(false);
            setError('');
            setLoading(false);
            setHighlighted(-1);
          }}
          className={`${inputClass} pl-9 pr-8 ${inputClassName}`.trim()}
        />
        {query ? (
          <button
            type="button"
            title="Clear customer selection"
            aria-label="Clear customer selection"
            disabled={disabled}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 disabled:opacity-50"
            onClick={clear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            title="Show customer search"
            aria-label="Show customer search"
            disabled={disabled}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-50"
            onClick={() => {
              setOpen((current) => !current);
              inputRef.current?.focus();
            }}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Customer search results"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900"
        >
          {showHint ? (
            <div role="status" className="p-3 text-center text-xs text-slate-500 dark:text-slate-400">
              {!dirty && value
                ? `Selected: ${value.label}. Type to search for a replacement.`
                : `Type at least ${minChars} characters to search the customer directory.`}
            </div>
          ) : loading ? (
            <div role="status" className="flex items-center justify-center gap-2 p-3 text-xs text-slate-500 dark:text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching customers…
            </div>
          ) : error ? (
            <div role="alert" className="space-y-2 p-3 text-center text-xs text-rose-600 dark:text-rose-400">
              <div className="flex items-center justify-center gap-1.5 font-semibold">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setHasSearched(false);
                  setRetryToken((current) => current + 1);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-rose-300 px-2 py-1 text-[11px] font-semibold hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950/40"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          ) : hasSearched && results.length === 0 ? (
            <div role="status" className="p-3 text-center text-xs text-slate-500 dark:text-slate-400">
              No matching customer in the directory.
            </div>
          ) : (
            results.map((customer, index) => {
              const isSelected = value?.id === customer.id;
              return (
                <button
                  key={customer.id}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  // Keep focus in the input so the click selects instead of
                  // blurring first and closing the menu.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(customer)}
                  onMouseEnter={() => setHighlighted(index)}
                  className={`flex w-full cursor-pointer items-center justify-between p-2.5 text-left transition-colors hover:bg-indigo-50 dark:hover:bg-slate-800 ${
                    index === highlighted ? 'bg-indigo-50/70 dark:bg-slate-800' : ''
                  }`}
                >
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
                  {isSelected && (
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-indigo-600 dark:text-indigo-400" />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
