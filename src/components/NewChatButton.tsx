import {SquarePen} from 'lucide-react';

interface NewChatButtonProps {
  onClick: () => void;
  compact?: boolean;
}

export function NewChatButton({onClick, compact = false}: NewChatButtonProps) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="New chat"
        title="New chat"
        className="inline-flex items-center justify-center h-10 w-10 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:focus-visible:ring-teal-400 shrink-0"
      >
        <SquarePen className="h-5 w-5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center gap-2 w-full min-h-[42px] px-4 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 dark:bg-teal-600 dark:text-white dark:hover:bg-teal-500 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#111827] whitespace-nowrap shrink-0"
    >
      <SquarePen className="h-4 w-4 shrink-0" />
      <span>New chat</span>
    </button>
  );
}
