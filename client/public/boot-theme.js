/**
 * Paint-time theme mirror.
 *
 * DarkModeContext owns the authoritative theme (server-side user_preferences)
 * and caches it under `inventory_theme`; this file runs before the React bundle
 * and sets the same `dark` class so the static boot splash matches the theme
 * the user will land in. Keep the key in sync with
 * client/src/contexts/DarkModeContext.tsx.
 *
 * Loaded as a same-origin file rather than inline because production CSP is
 * `script-src 'self'`.
 */
(function () {
  try {
    if (localStorage.getItem('inventory_theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch {
    // Storage can be blocked in private/embedded contexts; the light splash is
    // still correct enough to avoid a blank document.
  }
})();
