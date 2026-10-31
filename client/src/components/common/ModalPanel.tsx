import React, { useEffect, useRef } from 'react';
import { useDialogA11y } from '../../utils/useDialogA11y';

export interface ModalPanelProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role' | 'aria-modal' | 'aria-label'> {
  /** Accessible name. Use the dialog's visible title. */
  label: string;
  /** Enables Escape-to-close while focus is inside this panel. */
  onClose?: () => void;
  /** Optional control to focus on open; defaults to the first focusable. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

/**
 * The shared semantic/focus half of a modal: the panel a record dialog renders
 * its content in.
 *
 * The 2026-10-31 overlay sweep found twelve record and payment dialogs that
 * looked like dialogs but were plain divs — no `role="dialog"`, no
 * `aria-modal`, no accessible name — and Tab walked out of them onto the page
 * behind. Wrapping the panel in this component gives every one the same
 * behaviour as the shell overlays:
 *
 *   - `role="dialog"`, `aria-modal="true"` and the visible title as its name;
 *   - focus enters the panel on open and cycles with Tab / Shift+Tab;
 *   - the topmost panel owns the keyboard (the shared `DialogProvider` joins
 *     the same stack, so a confirm opened over a record dialog takes over);
 *   - Escape closes only while focus is inside this panel, so an inner dialog
 *     is not dismissed by the same keypress as its parent;
 *   - focus returns to the control that opened the dialog when it unmounts.
 *
 * The backdrop, sizing and scroll behaviour stay with the call site: this
 * component replaces the panel `<div>`, not the whole overlay.
 */
export const ModalPanel: React.FC<ModalPanelProps> = ({
  label,
  onClose,
  initialFocusRef,
  className,
  children,
  ...rest
}) => {
  const dialogRef = useDialogA11y<HTMLDivElement>({
    isOpen: true,
    initialFocusRef,
  });
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember the opener before the trap moves focus, and hand focus back on
  // unmount. AppShell does this for shell overlays; record dialogs are mounted
  // by their screens, so the panel owns it.
  useEffect(() => {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
    return () => {
      const target = restoreRef.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const panel = dialogRef.current;
      if (!panel || !panel.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, dialogRef]);

  return (
    <div
      {...rest}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={className}
    >
      {children}
    </div>
  );
};
