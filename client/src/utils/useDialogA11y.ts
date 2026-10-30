import React, { useEffect, useRef } from 'react';

/**
 * Keyboard/focus behaviour shared by every shell overlay.
 *
 * A modal that only looks like a dialog is a keyboard trap in reverse: Tab
 * leaves it and lands on the page behind, which is visually covered and often
 * inert to the mouse. This hook returns the element ref to put on the dialog
 * panel and:
 *
 *   1. moves focus into the panel when it opens (an explicit initial target,
 *      otherwise the first focusable control, otherwise the panel itself),
 *   2. keeps Tab / Shift+Tab cycling inside the panel,
 *   3. pulls focus back in if it escapes by any other route,
 *   4. only acts for the TOPMOST open overlay, so a search dialog opened over
 *      the notification drawer owns the keyboard until it closes.
 *
 * Escape and focus restoration stay with AppShell, which owns the overlay stack
 * and remembers the trigger that opened each surface.
 */
const focusTrapStack: symbol[] = [];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      !element.closest('[aria-hidden="true"]')
  );
}

export interface UseDialogA11yOptions {
  isOpen: boolean;
  /** Control to focus on open; defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export function useDialogA11y<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  initialFocusRef,
}: UseDialogA11yOptions) {
  const dialogRef = useRef<T>(null);
  const tokenRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const token = Symbol('dialog');
    tokenRef.current = token;
    focusTrapStack.push(token);

    const focusTimer = window.setTimeout(() => {
      const target =
        initialFocusRef?.current ?? focusableElements(dialog)[0] ?? (dialog as HTMLElement);
      target.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (focusTrapStack[focusTrapStack.length - 1] !== token) return;

      const focusables = focusableElements(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      const index = focusTrapStack.lastIndexOf(token);
      if (index !== -1) focusTrapStack.splice(index, 1);
      if (tokenRef.current === token) tokenRef.current = null;
    };
  }, [isOpen, initialFocusRef]);

  return dialogRef;
}
