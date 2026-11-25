import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Volume2,
  WandSparkles,
  X,
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
  GeneratedImageData,
  ImageAspectRatio,
  ImageAttachmentRef,
  SpeechRate,
} from '../types/chat';
import {formatMessageTime} from '../utils/formatters';
import {IMAGE_STYLE_OPTIONS} from '../utils/imageIntent';
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
  onRegenerateImage: (messageId: string) => void;
  onCancelImage: (messageId: string) => void;
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

function getAspectClass(ratio: ImageAspectRatio): string {
  switch (ratio) {
    case '16:9':
      return 'aspect-video max-w-lg';
    case '9:16':
      return 'aspect-[9/16] max-w-[260px]';
    case '4:3':
      return 'aspect-[4/3] max-w-md';
    default:
      return 'aspect-square max-w-sm';
  }
}

function GeneratedImageCard({
  messageId,
  generatedImage,
  onRegenerate,
  onCancel,
  onPreview,
}: {
  messageId: string;
  generatedImage: GeneratedImageData;
  onRegenerate: (messageId: string) => void;
  onCancel: (messageId: string) => void;
  onPreview: (src: string, alt: string) => void;
}) {
  const [imgSrc, setImgSrc] = useState<string | null>(
    generatedImage.remoteUrl ?? null
  );
  const [imgMime, setImgMime] = useState<string>('image/jpeg');
  const [isLoadingLocal, setIsLoadingLocal] = useState<boolean>(
    generatedImage.status === 'ready' && Boolean(generatedImage.imageId)
  );
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (generatedImage.status !== 'generating') {
      setElapsedSec(0);
      return;
    }
    const updateElapsed = () => {
      setElapsedSec(
        Math.max(0, Math.floor((Date.now() - generatedImage.createdAt) / 1000))
      );
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [generatedImage.status, generatedImage.createdAt]);

  useEffect(() => {
    let active = true;
    if (generatedImage.status !== 'ready') {
      setImgSrc(null);
      setIsLoadingLocal(false);
      return;
    }

    if (!generatedImage.imageId) {
      setImgSrc(generatedImage.remoteUrl ?? null);
      setIsLoadingLocal(false);
      return;
    }

    setIsLoadingLocal(true);
    void getImageRecord(generatedImage.imageId).then((record) => {
      if (!active) return;
      if (record?.dataUrl) {
        setImgSrc(record.dataUrl);
        setImgMime(record.mimeType);
      } else if (generatedImage.remoteUrl) {
        setImgSrc(generatedImage.remoteUrl);
      } else {
        setImgSrc(null);
      }
      setIsLoadingLocal(false);
    });

    return () => {
      active = false;
    };
  }, [generatedImage.status, generatedImage.imageId, generatedImage.remoteUrl]);

  const styleLabel =
    IMAGE_STYLE_OPTIONS.find((s) => s.id === generatedImage.style)?.label ??
    'Auto';
  const aspectClass = getAspectClass(generatedImage.aspectRatio);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(generatedImage.prompt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleDownload = async () => {
    if (!imgSrc || isDownloading) return;
    setIsDownloading(true);
    const ext = imgMime.includes('png')
      ? 'png'
      : imgMime.includes('webp')
        ? 'webp'
        : 'jpg';
    const filename = `lumen-image-${generatedImage.id.slice(0, 6)}.${ext}`;

    try {
      if (imgSrc.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = imgSrc;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        const res = await fetch(imgSrc);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      }
    } catch {
      // Download error ignored gracefully
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Prompt & Metadata Header */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5 font-medium text-teal-700 dark:text-teal-400">
          <WandSparkles className="h-3.5 w-3.5" />
          <span>Generated image</span>
        </span>
        {generatedImage.style !== 'auto' && (
          <>
            <span aria-hidden="true">·</span>
            <span>{styleLabel}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{generatedImage.aspectRatio}</span>
      </div>

      {/* Main Image Frame */}
      {generatedImage.status === 'generating' && (
        <div
          className={`w-full ${aspectClass} rounded-2xl border border-slate-200 dark:border-slate-800 bg-gradient-to-br from-slate-100 via-slate-50 to-teal-50/50 dark:from-[#111827] dark:via-[#141D2F] dark:to-teal-950/30 flex flex-col items-center justify-center gap-3 p-6 text-center`}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 shadow-xs">
            <Loader2 className="h-5 w-5 animate-spin text-teal-600 dark:text-teal-400" />
          </div>
          <div className="space-y-1 max-w-xs">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Creating image{elapsedSec > 0 ? ` · ${elapsedSec}s` : '...'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
              {generatedImage.prompt}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onCancel(messageId)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            <span>Cancel</span>
          </button>
        </div>
      )}

      {generatedImage.status === 'error' && (
        <div className="max-w-lg rounded-2xl border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 p-4 space-y-3">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-medium text-red-900 dark:text-red-200">
                Image generation unavailable
              </p>
              <p className="text-xs text-red-800/90 dark:text-red-300 leading-relaxed">
                {generatedImage.error ||
                  'Free image providers are temporarily busy. Please try again.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRegenerate(messageId)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Regenerate</span>
            </button>
            <button
              type="button"
              onClick={handleCopyPrompt}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {copiedPrompt ? (
                <>
                  <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  <span>Copied prompt</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy prompt</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {generatedImage.status === 'ready' && (
        <>
          {isLoadingLocal ? (
            <div
              className={`w-full ${aspectClass} rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#111827] flex items-center justify-center`}
            >
              <Loader2 className="h-5 w-5 animate-spin text-teal-600 dark:text-teal-400" />
            </div>
          ) : imgSrc ? (
            <button
              type="button"
              onClick={() => onPreview(imgSrc, generatedImage.prompt)}
              aria-label={`Preview generated image: ${generatedImage.prompt}`}
              className={`group/gen relative block w-full ${aspectClass} overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#111827] shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600`}
            >
              <img
                src={imgSrc}
                alt={generatedImage.prompt}
                className="h-full w-full object-cover transition-transform duration-200 group-hover/gen:scale-[1.015]"
              />
              <span className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 rounded-lg bg-slate-950/70 px-2 py-1 text-[11px] font-medium text-white opacity-0 group-hover/gen:opacity-100 transition-opacity">
                <ZoomIn className="h-3.5 w-3.5" />
                <span>Zoom</span>
              </span>
            </button>
          ) : (
            <div className="max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] p-4 space-y-2">
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Local browser image cache was cleared. Click Regenerate to create this image again.
              </p>
              <button
                type="button"
                onClick={() => onRegenerate(messageId)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 transition-opacity"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Regenerate</span>
              </button>
            </div>
          )}

          {/* Action Bar */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs text-slate-400 dark:text-slate-500">
            {imgSrc && (
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={isDownloading}
                className="inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{isDownloading ? 'Saving...' : 'Download'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onRegenerate(messageId)}
              className="inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Regenerate</span>
            </button>

            <button
              type="button"
              onClick={handleCopyPrompt}
              className="inline-flex items-center gap-1.5 min-h-[30px] rounded-md px-2 py-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              {copiedPrompt ? (
                <>
                  <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy prompt</span>
                </>
              )}
            </button>

            {generatedImage.model && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {generatedImage.model}
                  {typeof generatedImage.durationMs === 'number'
                    ? ` (${(generatedImage.durationMs / 1000).toFixed(1)}s)`
                    : ''}
                </span>
              </>
            )}

            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {formatMessageTime(generatedImage.createdAt)}
            </span>
          </div>
        </>
      )}
    </div>
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
  onRegenerateImage,
  onCancelImage,
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
        {message.generatedImage ? (
          <GeneratedImageCard
            messageId={message.id}
            generatedImage={message.generatedImage}
            onRegenerate={onRegenerateImage}
            onCancel={onCancelImage}
            onPreview={onPreviewImage}
          />
        ) : isStreamingThis && !message.content ? (
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
