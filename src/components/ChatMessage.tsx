import {Check, Copy, Pencil, RotateCcw} from 'lucide-react';
import {
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type {ChatMessage as ChatMessageType} from '../types/chat';
import {formatMessageTime} from '../utils/formatters';
import {LoadingIndicator} from './LoadingIndicator';

interface ChatMessageProps {
  message: ChatMessageType;
  isStreamingThis: boolean;
  isAnyStreaming: boolean;
  isLastAssistant: boolean;
  onEditMessage: (messageId: string, newContent: string) => void;
  onRegenerate: (messageId: string) => void;
}

function extractTextFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromNode).join('');
  }
  if (isValidElement<{children?: ReactNode}>(node)) {
    return extractTextFromNode(node.props.children);
  }
  return '';
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const langMatch = /language-([a-zA-Z0-9_-]+)/.exec(className || '');
  const language = langMatch ? langMatch[1] : 'code';
  const rawCode = extractTextFromNode(children).replace(/\n$/, '');

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(rawCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API fallback ignored
    }
  };

  return (
    <div className="my-3.5 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D131F] max-w-full">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#111827]">
        <span className="font-mono text-xs font-medium text-slate-600 dark:text-slate-400">
          {language}
        </span>
        <button
          type="button"
          onClick={handleCopyCode}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="overflow-x-auto p-3.5 text-[13.5px] leading-relaxed font-mono text-slate-800 dark:text-slate-200">
        <pre className="m-0 bg-transparent p-0">
          <code className={className}>{children}</code>
        </pre>
      </div>
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreamingThis,
  isAnyStreaming,
  isLastAssistant,
  onEditMessage,
  onRegenerate,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isEditing && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.style.height = 'auto';
      editTextareaRef.current.style.height = `${Math.min(
        editTextareaRef.current.scrollHeight,
        240
      )}px`;
    }
  }, [isEditing, draftContent]);

  const handleCopy = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard permission failures
    }
  };

  const handleSaveEdit = () => {
    const trimmed = draftContent.trim();
    if (!trimmed) return;
    setIsEditing(false);
    if (trimmed !== message.content) {
      onEditMessage(message.id, trimmed);
    }
  };

  const handleCancelEdit = () => {
    setDraftContent(message.content);
    setIsEditing(false);
  };

  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end w-full">
        {isEditing ? (
          <div className="w-full max-w-2xl rounded-2xl border border-teal-600 dark:border-teal-500 bg-slate-50 dark:bg-[#111827] p-3.5">
            <textarea
              ref={editTextareaRef}
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelEdit();
                }
              }}
              aria-label="Edit message"
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 focus:outline-none"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelEdit}
                className="min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!draftContent.trim() || isAnyStreaming}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-teal-600 dark:hover:bg-teal-500 transition-colors whitespace-nowrap"
              >
                Save &amp; Submit
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-end max-w-[88%] sm:max-w-[78%] min-w-0">
            <div className="rounded-2xl bg-slate-100 dark:bg-[#1A2234] border border-slate-200/80 dark:border-slate-800 px-4 py-3 text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 whitespace-pre-wrap break-words max-w-full">
              {message.content}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
              <span className="tabular-nums">{formatMessageTime(message.createdAt)}</span>
              {!isAnyStreaming && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftContent(message.content);
                    setIsEditing(true);
                  }}
                  aria-label="Edit message"
                  title="Edit message"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span>Edit</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy message"
                title="Copy message"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 sm:gap-4 w-full min-w-0">
      <div
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] text-xs font-bold text-teal-700 dark:text-teal-400 mt-0.5"
      >
        L
      </div>

      <div className="flex-1 min-w-0">
        {isStreamingThis && !message.content ? (
          <LoadingIndicator label="Generating response" />
        ) : (
          <div className="markdown-body text-slate-800 dark:text-slate-200 min-w-0">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={isStreamingThis ? [] : [rehypeHighlight]}
              components={{
                pre({children}) {
                  return <>{children}</>;
                },
                code({className, children, ...props}) {
                  const isBlock =
                    Boolean(className) ||
                    extractTextFromNode(children).includes('\n');
                  if (isBlock) {
                    return <CodeBlock className={className}>{children}</CodeBlock>;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                a({href, children, ...props}) {
                  return (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      {...props}
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {message.content}
            </Markdown>
            {isStreamingThis && (
              <span
                aria-hidden="true"
                className="inline-block w-2 h-4 ml-1 align-middle bg-teal-600 dark:bg-teal-400 animate-pulse rounded-[1px]"
              />
            )}
          </div>
        )}

        {!isStreamingThis && message.content && (
          <div
            className={`mt-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 transition-opacity ${
              isLastAssistant
                ? 'opacity-100'
                : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
            }`}
          >
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy response"
              className="inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>

            {!isAnyStreaming && (
              <button
                type="button"
                onClick={() => onRegenerate(message.id)}
                aria-label="Regenerate response"
                className="inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Regenerate</span>
              </button>
            )}

            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatMessageTime(message.createdAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
});
