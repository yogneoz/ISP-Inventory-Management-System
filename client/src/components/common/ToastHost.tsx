import React, { useEffect, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { API_TOAST_EVENT, type ApiToastIntent } from '../../services/api/http';

/**
 * Global floating toast host — the ONE place API failures become visible.
 *
 * `fetchJson` (services/api/http.ts) attaches a toast intent to every failed
 * request and broadcasts it for mutations; this host listens and renders it.
 * That makes error surfacing a property of the request pipeline instead of
 * every call site: a server rejection (insufficient stock, unregistered
 * serial, unseeded BS day, closed fiscal year, 403 forbidden…) can no longer
 * die as an unhandled promise rejection and leave the form silently doing
 * nothing — which is exactly what the damage-tagging walkthrough found.
 *
 * Deliberate behavior:
 *   - ONE toast at a time (the newest replaces the previous) so a burst of
 *     failures never stacks into a wall of cards.
 *   - Auto-dismisses, with an explicit close button and polite aria-live so
 *     screen readers announce it without stealing focus.
 *   - Failures it renders are only the ones http.ts broadcasts: 401s belong
 *     to the expired-session flow, GET failures are background refreshes.
 */
export function ToastHost() {
  const [toast, setToast] = useState<ApiToastIntent | null>(null);

  useEffect(() => {
    const onApiToast = (event: Event) => {
      const intent = (event as CustomEvent<ApiToastIntent>).detail;
      if (intent?.message) setToast(intent);
    };
    window.addEventListener(API_TOAST_EVENT, onApiToast);
    return () => window.removeEventListener(API_TOAST_EVENT, onApiToast);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[100] max-w-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-4 py-3 rounded-2xl shadow-2xl border border-rose-500/60 dark:border-rose-400/60 text-xs font-semibold flex items-start justify-between gap-3 animate-in fade-in slide-in-from-bottom-5"
    >
      <span className="flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-rose-400 dark:text-rose-500" />
        <span>{toast.message}</span>
      </span>
      <button
        onClick={() => setToast(null)}
        aria-label="Dismiss notification"
        className="p-1 hover:bg-slate-800 dark:hover:bg-slate-200 rounded-lg cursor-pointer flex-shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
