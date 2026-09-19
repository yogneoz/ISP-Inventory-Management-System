import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Info, X } from 'lucide-react';

type DialogKind = 'confirm' | 'alert' | 'prompt';

interface PendingDialog {
  key: number;
  kind: DialogKind;
  title: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  resolve: (value: boolean | string | null) => void;
}

interface DialogContextValue {
  /** Resolves `boolean` — use instead of the native blocking `window.confirm`. */
  confirm: (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>;
  /** Resolves `void` when the user dismisses — use instead of `window.alert`. */
  alert: (message: string, options?: { title?: string; confirmLabel?: string }) => Promise<void>;
  /** Resolves `string | null` (null = cancelled) — use instead of the native `window.prompt`. */
  prompt: (message: string, options?: { title?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; cancelLabel?: string }) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

/**
 * In-app replacement for the browser-native `window.confirm` / `window.alert` /
 * `window.prompt` boxes. Mount once at the root (see main.tsx).
 *
 * The native dialogs are synchronous, so only `window.alert` can be safely
 * patched (its return value is never used). For confirmations and prompts, use
 * the async `useDialog()` hook in components — every call site that currently
 * calls `confirm(...)` / `prompt(...)` and gates logic on the result has been
 * migrated to `await useDialog().confirm(...)` / `await useDialog().prompt(...)`.
 */
export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [inputValue, setInputValue] = useState('');

  const settle = useCallback((value: boolean | string | null) => {
    setDialog((current) => {
      if (current) current.resolve(value);
      return null;
    });
  }, []);

  const confirm = useCallback<DialogContextValue['confirm']>((message, options) => {
    return new Promise<boolean>((resolve) => {
      setDialog({
        key: Date.now(),
        kind: 'confirm',
        title: options?.title || 'Confirm Action',
        message,
        confirmLabel: options?.confirmLabel,
        cancelLabel: options?.cancelLabel,
        resolve: (value) => resolve(Boolean(value)),
      });
    });
  }, []);

  const alert = useCallback<DialogContextValue['alert']>((message, options) => {
    return new Promise<void>((resolve) => {
      setDialog({
        key: Date.now(),
        kind: 'alert',
        title: options?.title || 'Notice',
        message,
        confirmLabel: options?.confirmLabel,
        resolve: () => resolve(),
      });
    });
  }, []);

  const prompt = useCallback<DialogContextValue['prompt']>((message, options) => {
    return new Promise<string | null>((resolve) => {
      setInputValue(options?.defaultValue ?? '');
      setDialog({
        key: Date.now(),
        kind: 'prompt',
        title: options?.title || 'Input Required',
        message,
        defaultValue: options?.defaultValue,
        placeholder: options?.placeholder,
        confirmLabel: options?.confirmLabel,
        cancelLabel: options?.cancelLabel,
        resolve: (value) => resolve(value === null ? null : String(value)),
      });
    });
  }, []);

  // Patch window.alert so every existing `alert(...)` call site shows the
  // in-app modal instead of the native browser box. window.confirm and
  // window.prompt are synchronous and therefore cannot be patched safely —
  // those call sites use the async useDialog() hook instead.
  useEffect(() => {
    const originalAlert = window.alert.bind(window);
    window.alert = ((message?: unknown) => {
      const messageText = typeof message === 'string' ? message : String(message ?? '');
      setDialog({
        key: Date.now(),
        kind: 'alert',
        title: 'Notice',
        message: messageText,
        resolve: () => {
          /* fire-and-forget */
        },
      });
    }) as unknown as typeof window.alert;

    return () => {
      window.alert = originalAlert;
    };
  }, []);

  if (!dialog) {
    return <DialogContext.Provider value={{ confirm, alert, prompt }}>{children}</DialogContext.Provider>;
  }

  const Icon = dialog.kind === 'confirm' ? HelpCircle : dialog.kind === 'prompt' ? Info : AlertTriangle;
  const iconTone = dialog.kind === 'confirm'
    ? 'text-amber-500 bg-amber-500/10'
    : dialog.kind === 'prompt'
      ? 'text-indigo-500 bg-indigo-500/10'
      : 'text-sky-500 bg-sky-500/10';

  const handleConfirm = () => {
    if (dialog.kind === 'prompt') {
      settle(inputValue.length ? inputValue : (dialog.defaultValue ?? ''));
    } else {
      settle(true);
    }
  };
  const handleCancel = () => {
    settle(dialog.kind === 'prompt' ? null : false);
  };

  return (
    <DialogContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-in fade-in duration-200"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') handleCancel();
        }}
      >
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-100">
          <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <div className={`rounded-xl p-2 ${iconTone}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold leading-tight">{dialog.title}</h3>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500 dark:text-slate-400">{dialog.message}</p>
            </div>
            {dialog.kind !== 'alert' && (
              <button
                type="button"
                onClick={handleCancel}
                className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {dialog.kind === 'prompt' && (
            <div className="px-5 py-4">
              <input
                autoFocus
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={dialog.placeholder || ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirm();
                }}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800/60 dark:text-white dark:placeholder-slate-500"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5 dark:border-slate-800">
            {dialog.kind !== 'alert' && (
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700/70"
              >
                {dialog.cancelLabel || 'Cancel'}
              </button>
            )}
            <button
              type="button"
              autoFocus={dialog.kind !== 'prompt'}
              onClick={handleConfirm}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-500"
            >
              {dialog.confirmLabel || (dialog.kind === 'alert' ? 'OK' : 'Confirm')}
            </button>
          </div>
        </div>
      </div>
    </DialogContext.Provider>
  );
};

/**
 * Hook to open an in-app dialog (confirm / alert / prompt) from any component.
 * Returns an async API — `await confirm('...')`, `await alert('...')`,
 * `await prompt('...')`.
 */
export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used within a <DialogProvider>');
  }
  return ctx;
}