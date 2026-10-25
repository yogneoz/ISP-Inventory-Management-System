/**
 * Shared searchable-picker mechanics.
 *
 * One control for every directory that is too large for a native <select>:
 * minimum query length, debounce, a stale-response guard, keyboard navigation,
 * an explicit failure state with Retry (never "no matches" on a failed read),
 * clear/revert behaviour, and an optional fixed-position portal so a scroll
 * container cannot clip the list.
 *
 * The caller owns the request and the row rendering; this file owns the
 * interaction. CustomerPicker and LocationPicker are thin wrappers so the
 * behaviour cannot drift between forms.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { inputClass } from './styleConstants';

export interface SearchPickerValue {
  id: string;
  /** Visible label committed to the field. */
  label: string;
}

/** Copy for the dropdown states. Every field is optional. */
export interface SearchPickerLabels {
  /** Shown while the query is shorter than `minChars`. */
  hint?: string;
  /** Shown for an untouched field that already holds a value. */
  selectedHint?: string;
  loading?: string;
  empty?: string;
  /** Prefix for a failed read; the error detail is appended when present. */
  error?: string;
}

export interface SearchPickerProps<T> {
  value: SearchPickerValue | null;
  /** Called with the picked row, or null when the field is cleared. */
  onSelect: (item: T | null) => void;
  /**
   * Directory search. May be synchronous (an already-loaded list) or async.
   * Must be stable across renders (memoize it), because the debounce effect
   * depends on its identity.
   */
  search: (query: string) => Promise<T[]> | T[];
  /** Stable key for a row. */
  itemKey: (item: T) => string;
  /** Visible label committed to the field. */
  itemLabel: (item: T) => string;
  /** Rich row content; the selected check icon is rendered by the picker. */
  renderOption?: (item: T, selected: boolean) => React.ReactNode;
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
  labels?: SearchPickerLabels;
  clearTitle?: string;
  openTitle?: string;
  /**
   * Render the listbox in a fixed-position portal. Required inside a table's
   * horizontal scroll container, which otherwise clips an absolute dropdown.
   */
  portal?: boolean;
  checkClassName?: string;
}

interface ListRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export function SearchPicker<T>({
  value,
  onSelect,
  search,
  itemKey,
  itemLabel,
  renderOption,
  inputId,
  placeholder = 'Search…',
  disabled = false,
  required = false,
  className = '',
  inputClassName = 'h-9 text-xs font-semibold',
  minChars = 2,
  debounceMs = 200,
  ariaLabel = 'Search',
  labels = {},
  clearTitle = 'Clear selection',
  openTitle = 'Show search',
  portal = false,
  checkClassName = 'text-indigo-600 dark:text-indigo-400',
}: SearchPickerProps<T>) {
  const selectedLabel = value?.label || '';
  const [query, setQuery] = useState(selectedLabel);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [retryToken, setRetryToken] = useState(0);
  const [rect, setRect] = useState<ListRect | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeq = useRef(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const resetToSelected = () => {
    setOpen(false);
    setDirty(false);
    setQuery(selectedLabel);
    setResults([]);
    setHasSearched(false);
    setError('');
    setLoading(false);
    setHighlighted(-1);
  };

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
          setError(`${labels.error || 'Could not search.'}${detail}`);
        })
        .finally(() => {
          if (requestId === requestSeq.current) setLoading(false);
        });
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      requestSeq.current += 1;
    };
  }, [open, dirty, query, minChars, debounceMs, search, retryToken, labels.error]);

  // Close on a click outside. The listbox can live in a portal, so it counts
  // as inside too. Restore the selected label (or clear free text) so the
  // field never looks like it holds a record that was not picked.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      resetToSelected();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedLabel]);

  // A portal listbox is anchored to the input. Follow the input while the
  // surrounding modal/table scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!portal || !open) {
      setRect(null);
      return;
    }
    const update = () => {
      const box = inputRef.current?.getBoundingClientRect();
      if (!box) {
        setRect(null);
        return;
      }
      setRect({ top: box.top, bottom: box.bottom, left: box.left, width: box.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [portal, open]);

  const pick = (item: T) => {
    setQuery(itemLabel(item));
    setDirty(false);
    setOpen(false);
    setResults([]);
    setError('');
    setHasSearched(false);
    setLoading(false);
    setHighlighted(-1);
    onSelect(item);
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
      // the parent would post its previous record under the typed words.
      if (dirty) {
        event.preventDefault();
        resetToSelected();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      resetToSelected();
      return;
    }
    if (event.key === 'Tab') {
      resetToSelected();
    }
  };

  // A focused but untouched field is not a search: show guidance, never the
  // previous query's rows (or a spinner from a request it cancelled).
  const showHint = !dirty || query.trim().length < minChars;
  const hint = labels.hint || `Type at least ${minChars} characters to search.`;
  const selectedHint = labels.selectedHint || `Selected: ${value?.label || ''}. Type to search for a replacement.`;

  const listbox = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={`${ariaLabel} results`}
      className={
        portal
          ? 'fixed z-[80] max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900'
          : 'absolute left-0 right-0 top-full z-50 mt-1 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900'
      }
      style={
        portal && rect
          ? {
              position: 'fixed',
              left: rect.left,
              width: rect.width,
              ...(window.innerHeight - rect.bottom < 280 && rect.top > 280
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }
          : undefined
      }
    >
      {showHint ? (
        <div role="status" className="p-3 text-center text-xs text-slate-500 dark:text-slate-400">
          {!dirty && value ? selectedHint : hint}
        </div>
      ) : loading ? (
        <div role="status" className="flex items-center justify-center gap-2 p-3 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {labels.loading || 'Searching…'}
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
          {labels.empty || 'No matching record.'}
        </div>
      ) : (
        results.map((item, index) => {
          const isSelected = value?.id === itemKey(item);
          return (
            <button
              key={itemKey(item)}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={isSelected}
              // Keep focus in the input so the click selects instead of
              // blurring first and closing the menu.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(item)}
              onMouseEnter={() => setHighlighted(index)}
              className={`flex w-full cursor-pointer items-center justify-between p-2.5 text-left transition-colors hover:bg-indigo-50 dark:hover:bg-slate-800 ${
                index === highlighted ? 'bg-indigo-50/70 dark:bg-slate-800' : ''
              }`}
            >
              {renderOption ? (
                renderOption(item, isSelected)
              ) : (
                <div className="min-w-0 pr-2">
                  <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                    {itemLabel(item)}
                  </div>
                </div>
              )}
              {isSelected && <CheckCircle2 className={`h-4 w-4 flex-shrink-0 ${checkClassName}`} />}
            </button>
          );
        })
      )}
    </div>
  );

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
            if (next && (rootRef.current?.contains(next) || listRef.current?.contains(next))) return;
            resetToSelected();
          }}
          className={`${inputClass} pl-9 pr-8 ${inputClassName}`.trim()}
        />
        {query ? (
          <button
            type="button"
            title={clearTitle}
            aria-label={clearTitle}
            disabled={disabled}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 disabled:opacity-50"
            onClick={clear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            title={openTitle}
            aria-label={openTitle}
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

      {open && (portal ? (rect ? createPortal(listbox, document.body) : null) : listbox)}
    </div>
  );
}
