import {useCallback, useEffect, useState} from 'react';
import type {ThemeMode} from '../types/chat';
import {loadTheme, saveTheme} from '../utils/storage';

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return {theme, setTheme, toggleTheme};
}
