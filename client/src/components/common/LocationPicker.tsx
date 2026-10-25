/**
 * Searchable POP / fiber-network location picker.
 *
 * The activity forms already receive the whole `locations` directory from the
 * bootstrap slice, so this control filters that loaded list instead of issuing
 * a per-keystroke request. It shares SearchPicker's interaction with
 * CustomerPicker: 20-row cap, keyboard navigation, clear/revert, and the same
 * failure/Retry shape if the list ever becomes a server read.
 *
 * By default only POP server rooms, fiber network nodes and untyped rows are
 * offered — the same filter Assign Fixed Asset and Issue Consumables used
 * before, just without rendering every row as an <option>.
 */
import React, { useCallback, useMemo } from 'react';
import { SearchPicker, type SearchPickerValue } from './SearchPicker';
import type { LocationRecord } from '../../types';

/** Location kinds that can receive deployed hardware / field material. */
export const NETWORK_LOCATION_TYPES = ['POP_SERVER_ROOM', 'FIBER_NETWORK_NODE'] as const;

const RESULT_LIMIT = 20;

const typeLabel = (type: string): string => {
  if (type === 'POP_SERVER_ROOM') return 'POP server room';
  if (type === 'FIBER_NETWORK_NODE') return 'Fiber network node';
  return type ? type.replace(/_/g, ' ').toLowerCase() : 'Location';
};

export interface LocationPickerProps {
  value: SearchPickerValue | null;
  /** Called with the picked location, or null when the field is cleared. */
  onSelect: (location: LocationRecord | null) => void;
  /** The loaded location directory (already in App/bootstrap state). */
  locations: LocationRecord[];
  /** Location kinds to offer; defaults to POP rooms + fiber nodes. */
  types?: readonly string[];
  /** Offer rows with no `type` as well (the legacy rows). Default true. */
  includeUntyped?: boolean;
  inputId?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  minChars?: number;
  debounceMs?: number;
  ariaLabel?: string;
  /** Render the list in a fixed-position portal (use inside scroll containers). */
  portal?: boolean;
}

export const LocationPicker: React.FC<LocationPickerProps> = ({
  value,
  onSelect,
  locations,
  types = NETWORK_LOCATION_TYPES,
  includeUntyped = true,
  inputId,
  placeholder = 'Search POP / network location…',
  disabled = false,
  required = false,
  className = '',
  inputClassName = 'h-9 text-[11px]',
  minChars = 1,
  debounceMs = 150,
  ariaLabel = 'Search POP or network locations',
  portal = false,
}) => {
  const candidates = useMemo(() => {
    const allowed = new Set(types);
    return locations.filter((location) =>
      location.type ? allowed.has(location.type) : includeUntyped
    );
  }, [locations, types, includeUntyped]);

  const search = useCallback(
    (raw: string): LocationRecord[] => {
      const q = raw.trim().toLowerCase();
      if (!q) return [];
      return candidates
        .filter(
          (location) =>
            location.name.toLowerCase().includes(q) ||
            (location.address || '').toLowerCase().includes(q) ||
            (location.contactPerson || '').toLowerCase().includes(q) ||
            (location.contactPhone || '').toLowerCase().includes(q)
        )
        .slice(0, RESULT_LIMIT);
    },
    [candidates]
  );

  return (
    <SearchPicker<LocationRecord>
      value={value}
      onSelect={onSelect}
      search={search}
      itemKey={(location) => location.id}
      itemLabel={(location) => location.name}
      inputId={inputId}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      className={className}
      inputClassName={inputClassName}
      minChars={minChars}
      debounceMs={debounceMs}
      ariaLabel={ariaLabel}
      clearTitle="Clear location selection"
      openTitle="Show location search"
      labels={{
        hint: 'Type a location name, address, or contact to search.',
        loading: 'Searching locations…',
        empty: 'No matching POP or network location.',
        error: 'Could not search the locations list.',
      }}
      portal={portal}
      renderOption={(location) => (
        <div className="min-w-0 pr-2">
          <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
            {location.name}{' '}
            <span className="font-mono text-[10px] font-normal text-slate-500">
              ({typeLabel(location.type)})
            </span>
          </div>
          {(location.address || location.contactPerson) && (
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              {location.address && <span className="truncate">• {location.address}</span>}
              {location.contactPerson && <span>{location.contactPerson}</span>}
            </div>
          )}
        </div>
      )}
    />
  );
};
