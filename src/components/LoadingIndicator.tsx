import {Loader2} from 'lucide-react';

interface LoadingIndicatorProps {
  label?: string;
}

export function LoadingIndicator({label = 'Thinking'}: LoadingIndicatorProps) {
  return (
    <div
      className="inline-flex items-center gap-2.5 text-sm text-slate-500 dark:text-slate-400 py-1"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin text-teal-600 dark:text-teal-400 shrink-0" />
      <span className="font-medium">{label}</span>
    </div>
  );
}
