import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface DarkModeContextValue {
  isDarkMode: boolean;
  toggleTheme: () => void;
  /**
   * Applies the theme the SERVER holds for this user (user_preferences). It
   * only sets state — persisting happens in App.tsx, which owns the
   * hydration gate so a start-up default can never overwrite the saved value.
   */
  applyServerTheme: (dark: boolean) => void;
}

const DarkModeContext = createContext<DarkModeContextValue | undefined>(undefined);

const STORAGE_KEY = 'inventory_theme';

// PAINT-TIME MIRROR ONLY: the authoritative theme is the server-side
// user_preferences row, hydrated by App.tsx via applyServerTheme(). This
// cached copy just stops the page flashing light→dark on reload, and is
// irrelevant if the user clears browser storage.
function getInitialDarkMode(): boolean {
 try {
 return localStorage.getItem(STORAGE_KEY) === 'dark';
 } catch {
 return false;
 }
}

function applyDarkClass(dark:boolean) {
 if (dark) {
 document.documentElement.classList.add('dark');
 } else {
 document.documentElement.classList.remove('dark');
 }
}

export const DarkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
 const [isDarkMode, setIsDarkMode] = useState<boolean>(getInitialDarkMode);

 // Apply the `dark` class on the <html> element whenever the state changes
 useEffect(() => {
 applyDarkClass(isDarkMode);
 try {
 localStorage.setItem(STORAGE_KEY, isDarkMode ? 'dark' : 'light');
 } catch { /* ignore */ }
 }, [isDarkMode]);

 // Apply on initial mount (for SSR or cases where React hydrates after paint)
 useEffect(() => {
 applyDarkClass(isDarkMode);
 }, []);

 const toggleTheme = useCallback(() => {
 setIsDarkMode((prev) => !prev);
 }, []);

 const applyServerTheme = useCallback((dark: boolean) => {
 setIsDarkMode(dark);
 }, []);

 return (
 <DarkModeContext.Provider value={{ isDarkMode, toggleTheme, applyServerTheme }}>
 {children}
 </DarkModeContext.Provider>
 );
};

/**
 * Hook to access dark mode state and toggle function.
 * Use this instead of the `isDarkMode` prop in any component.
 */
export function useDarkMode(): DarkModeContextValue {
 const ctx = useContext(DarkModeContext);
 if (!ctx) {
 throw new Error('useDarkMode must be used within a <DarkModeProvider>');
 }
 return ctx;
}
