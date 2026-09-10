import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface DarkModeContextValue {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const DarkModeContext = createContext<DarkModeContextValue | undefined>(undefined);

const STORAGE_KEY = 'izone_theme';

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

 return (
 <DarkModeContext.Provider value={{ isDarkMode, toggleTheme }}>
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
