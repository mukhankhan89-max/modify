import {ArrowUp, Square} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';

interface ChatInputProps {
  isStreaming: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
  autoFocusTrigger?: string | null;
}

export function ChatInput({
  isStreaming,
  onSend,
  onStop,
  autoFocusTrigger,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea up to 200px
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 200);
    el.style.height = `${Math.max(nextHeight, 44)}px`;
  }, [value]);

  useEffect(() => {
    // Focus input on desktop when switching or creating a chat
    if (window.innerWidth >= 768) {
      textareaRef.current?.focus();
    }
  }, [autoFocusTrigger]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
    }
  };

  const canSend = value.trim().length > 0 && !isStreaming;

  return (
    <div className="w-full max-w-3xl mx-auto px-3 sm:px-6 pb-3 sm:pb-5 pt-2">
      <div className="relative flex items-end gap-2 rounded-2xl bg-slate-50 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 px-3 py-2 shadow-sm focus-within:border-teal-600 dark:focus-within:border-teal-500 focus-within:ring-1 focus-within:ring-teal-600/30 dark:focus-within:ring-teal-500/30 transition-colors">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Message Lumen..."
          aria-label="Message input"
          className="flex-1 min-h-[44px] max-h-[200px] resize-none bg-transparent py-2.5 pl-1.5 text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop generating"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send message"
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
              canSend
                ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-teal-600 dark:text-white dark:hover:bg-teal-500'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed dark:bg-slate-800 dark:text-slate-600'
            }`}
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        )}
      </div>
      <p className="mt-1.5 hidden sm:block text-center text-xs text-slate-400 dark:text-slate-500">
        Press Enter to send · Shift + Enter for a new line
      </p>
    </div>
  );
}
