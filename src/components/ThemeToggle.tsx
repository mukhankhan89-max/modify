import {Moon, Sun} from 'lucide-react';
import type {ThemeMode} from '../types/chat';

interface ThemeToggleProps {
  theme: ThemeMode;
  onToggle: () => void;
}

export function ThemeToggle({theme, onToggle}: ThemeToggleProps) {
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="inline-flex items-center gap-2.5 w-full min-h-[40px] px-3 py-2 rounded-lg text-sm font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800/80 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:focus-visible:ring-teal-400 whitespace-nowrap"
    >
      {isDark ? (
        <Sun className="h-4 w-4 shrink-0 text-amber-400" />
      ) : (
        <Moon className="h-4 w-4 shrink-0 text-slate-600" />
      )}
      <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
