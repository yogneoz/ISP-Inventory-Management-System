import { createContext, useContext } from 'react';

/**
 * A2 — "open this shell overlay" requests from inside the tab tree.
 *
 * The barcode scanner and the global search modal are shell state now (owned by
 * AppShell), but a screen may still need to open them — Help Documentation does.
 * Threading the setters down as props would put shell state back into App's
 * render, which is exactly what A2 removed, so the shell publishes the actions
 * instead. The value is memoised on the (stable) state setters, so a shell state
 * change never re-renders the screens that consume this context.
 *
 * The default is a no-op: a screen rendered outside the shell (a test, a
 * standalone story) must not crash on a missing overlay.
 */
export interface ShellOverlayActions {
  openBarcodeScanner: () => void;
  openGlobalSearch: () => void;
  openNotifications: () => void;
  openProfile: () => void;
}

const noop = () => {};

const ShellOverlayContext = createContext<ShellOverlayActions>({
  openBarcodeScanner: noop,
  openGlobalSearch: noop,
  openNotifications: noop,
  openProfile: noop,
});

export const ShellOverlayProvider = ShellOverlayContext.Provider;

export function useShellOverlays(): ShellOverlayActions {
  return useContext(ShellOverlayContext);
}
