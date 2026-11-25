import {
  Check,
  Copy,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Volume2,
  ZoomIn,
} from 'lucide-react';
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
import type {SpeechPlaybackState} from '../hooks/useSpeechSynthesis';
import type {
  ChatMessage as ChatMessageType,
  ImageAttachmentRef,
  SpeechRate,
} from '../types/chat';
import {formatMessageTime} from '../utils/formatters';
import {getImageRecord} from '../utils/imageStore';
import {LoadingIndicator} from './LoadingIndicator';

interface ChatMessageProps {
  message: ChatMessageType;
  isStreamingThis: boolean;
  isAnyStreaming: boolean;
  isLastAssistant: boolean;
  isSpeakingThis: boolean;
  speechPlaybackState: SpeechPlaybackState;
  speechRate: SpeechRate;
  onEditMessage: (messageId: string, newContent: string) => void;
  onRegenerate: (messageId: string) => void;
  onToggleSpeak: (messageId: string, text: string) => void;
  onStopSpeak: () => void;
  onChangeSpeechRate: (rate: SpeechRate) => void;
  onPreviewImage: (src: string, alt: string) => void;
}

const SPEECH_RATES: SpeechRate[] = [0.75, 1, 1.25, 1.5];

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

function MessageImageThumb({
  attachment,
  onPreview,
}: {
  attachment: ImageAttachmentRef;
  onPreview: (src: string, alt: string) => void;
}) {
  const [fullSrc, setFullSrc] = useState<string>(attachment.thumbnailDataUrl);

  useEffect(() => {
    let active = true;
    void getImageRecord(attachment.id).then((record) => {
      if (active && record?.dataUrl) {
        setFullSrc(record.dataUrl);
      }
    });
    return () => {
      active = false;
    };
  }, [attachment.id]);

  return (
    <button
      type="button"
      onClick={() => onPreview(fullSrc, attachment.name)}
      aria-label={`View image ${attachment.name}`}
      className="group/img relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 max-w-[220px] sm:max-w-[260px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
    >
      <img
        src={fullSrc}
        alt={attachment.name}
        className="max-h-56 w-auto object-cover transition-transform duration-150 group-hover/img:scale-[1.02]"
      />
      <span className="absolute bottom-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-slate-900/65 text-white opacity-0 group-hover/img:opacity-100 transition-opacity">
        <ZoomIn className="h-3.5 w-3.5" />
      </span>
    </button>
  );
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
  isSpeakingThis,
  speechPlaybackState,
  speechRate,
  onEditMessage,
  onRegenerate,
  onToggleSpeak,
  onStopSpeak,
  onChangeSpeechRate,
  onPreviewImage,
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

  const hasAttachments = Boolean(
    message.attachments && message.attachments.length > 0
  );

  const handleSaveEdit = () => {
    const trimmed = draftContent.trim();
    if (!trimmed && !hasAttachments) return;
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
                disabled={(!draftContent.trim() && !hasAttachments) || isAnyStreaming}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-teal-600 dark:hover:bg-teal-500 transition-colors whitespace-nowrap"
              >
                Save &amp; Submit
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-end max-w-[88%] sm:max-w-[78%] min-w-0 gap-2">
            {hasAttachments && (
              <div className="flex flex-wrap justify-end gap-2 max-w-full">
                {message.attachments!.map((att) => (
                  <MessageImageThumb
                    key={att.id}
                    attachment={att}
                    onPreview={onPreviewImage}
                  />
                ))}
              </div>
            )}

            {message.content.trim().length > 0 && (
              <div className="rounded-2xl bg-slate-100 dark:bg-[#1A2234] border border-slate-200/80 dark:border-slate-800 px-4 py-3 text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 whitespace-pre-wrap break-words max-w-full">
                {message.content}
              </div>
            )}

            <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
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
              {message.content.trim().length > 0 && (
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
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  const isActiveVoiceMessage = isSpeakingThis && speechPlaybackState !== 'idle';

  return (
    <div
      className={`group flex items-start gap-3 sm:gap-4 w-full min-w-0 rounded-2xl transition-colors ${
        isActiveVoiceMessage
          ? 'bg-teal-50/70 dark:bg-teal-950/20 ring-1 ring-teal-500/30 p-3 -mx-3'
          : ''
      }`}
    >
      <div
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-bold mt-0.5 transition-colors ${
          isActiveVoiceMessage
            ? 'border-teal-500 bg-teal-600 text-white'
            : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] text-teal-700 dark:text-teal-400'
        }`}
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
            className={`mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs text-slate-400 dark:text-slate-500 transition-opacity ${
              isLastAssistant || isActiveVoiceMessage
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

            <button
              type="button"
              onClick={() => onToggleSpeak(message.id, message.content)}
              aria-label={
                isActiveVoiceMessage
                  ? speechPlaybackState === 'playing'
                    ? 'Pause speech'
                    : speechPlaybackState === 'paused'
                      ? 'Resume speech'
                      : 'Cancel speech loading'
                  : 'Listen to response'
              }
              className={`inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 transition-colors whitespace-nowrap ${
                isActiveVoiceMessage
                  ? 'bg-teal-600/10 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300 font-medium'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {isActiveVoiceMessage && speechPlaybackState === 'loading' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading audio</span>
                </>
              ) : isActiveVoiceMessage && speechPlaybackState === 'playing' ? (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  <span>Pause</span>
                </>
              ) : isActiveVoiceMessage && speechPlaybackState === 'paused' ? (
                <>
                  <Play className="h-3.5 w-3.5" />
                  <span>Resume</span>
                </>
              ) : (
                <>
                  <Volume2 className="h-3.5 w-3.5" />
                  <span>Listen</span>
                </>
              )}
            </button>

            {isActiveVoiceMessage && (
              <>
                <button
                  type="button"
                  onClick={onStopSpeak}
                  aria-label="Stop speech"
                  className="inline-flex items-center gap-1 min-h-[30px] rounded-md px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors whitespace-nowrap"
                >
                  <Square className="h-3 w-3 fill-current" />
                  <span>Stop</span>
                </button>

                <label className="inline-flex items-center">
                  <span className="sr-only">Speech speed</span>
                  <select
                    aria-label="Speech playback speed"
                    value={speechRate}
                    onChange={(e) =>
                      onChangeSpeechRate(Number(e.target.value) as SpeechRate)
                    }
                    className="min-h-[28px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  >
                    {SPEECH_RATES.map((r) => (
                      <option key={r} value={r}>
                        {r}x
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

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
