import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {AppProviders} from './contexts/AppProviders';
import {ACTIVE_TAB_STORAGE_KEY, preloadScreenModule} from './screenPreload';
import './index.css';

/**
 * A stuck screen must not leave the user staring at the splash forever. The
 * normal path removes it as soon as the workspace's first real screen commits;
 * this is only the failure valve.
 */
const BOOT_SPLASH_MAX_MS = 8000;

function savedTab(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  } catch {
    // Storage blocked (private/embedded contexts): no saved tab to preload.
    return null;
  }
}

/**
 * Start the saved tab's chunk while the static splash is on screen. This is
 * deliberately not awaited: boot must not wait for a network download, and the
 * splash/dismissal below already hides React.lazy's fallback until the screen
 * has committed. A failure simply leaves React.lazy to own the wait.
 */
async function preloadSavedScreen(): Promise<void> {
  try {
    const loading = preloadScreenModule(savedTab());
    if (loading) await loading.catch(() => undefined);
  } catch {
    // Not a boot failure.
  }
}

/**
 * Keep the static splash (outside #root, so React cannot remove it) until the
 * workspace has a real screen. A lazy route commits #tab-loading-fallback
 * first; removing the splash before that would expose "Loading module..." for
 * the screen's render. The shell's own bootstrap spinner is covered the same
 * way. The login screen is real content with neither marker.
 */
function dismissBootSplashWhenReady(): void {
  const splash = document.getElementById('boot-splash');
  const root = document.getElementById('root');
  if (!splash || !root) return;

  let settled = false;
  let timer = 0;

  const finish = () => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    window.clearTimeout(timer);
    splash.remove();
  };

  const check = () => {
    if (settled || root.childElementCount === 0) return;
    if (document.getElementById('app-sync-spinner')) return;
    if (document.getElementById('tab-loading-fallback')) return;
    finish();
  };

  const observer = new MutationObserver(check);
  // Observe before the first render so a synchronous commit cannot slip past.
  observer.observe(document.body, { childList: true, subtree: true });
  timer = window.setTimeout(finish, BOOT_SPLASH_MAX_MS);
  check();
}

function renderApp(): void {
  createRoot(document.getElementById('root')!).render(
   <StrictMode>
   <AppProviders>
   <App />
   </AppProviders>
   </StrictMode>,
  );
}

dismissBootSplashWhenReady();
void preloadSavedScreen();
renderApp();
