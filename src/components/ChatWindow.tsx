import {
  AlertCircle,
  ArrowDown,
  Menu,
  PanelLeftOpen,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {useSpeechSynthesis} from '../hooks/useSpeechSynthesis';
import type {
  ChatError,
  Conversation,
  GeminiModelId,
  ImageAspectRatio,
  ImageStylePreset,
  PreparedImageAttachment,
} from '../types/chat';
import {ChatInput} from './ChatInput';
import {ChatMessage} from './ChatMessage';
import {NewChatButton} from './NewChatButton';
import {VoiceConversationModal} from './VoiceConversationModal';

interface ChatWindowProps {
  conversation: Conversation | null;
  model: GeminiModelId;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingText: string;
  error: ChatError | null;
  isDesktopSidebarOpen: boolean;
  onOpenDesktopSidebar: () => void;
  onOpenMobileSidebar: () => void;
  onNewChat: () => void;
  onChangeModel: (model: GeminiModelId) => void;
  onSendMessage: (
    content: string,
    attachments?: PreparedImageAttachment[]
  ) => Promise<string | null>;
  onGenerateImage: (
    prompt: string,
    options?: {style?: ImageStylePreset; aspectRatio?: ImageAspectRatio}
  ) => Promise<void>;
  onRegenerateImage: (messageId: string) => Promise<void>;
  onCancelImage: (messageId: string) => void;
  onStopGeneration: () => void;
  onRegenerate: (messageId?: string) => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  onDismissError: () => void;
  onWarmApi?: () => void;
}

const STARTER_PROMPTS = [
  {
    title: 'Explain a technical concept',
    prompt:
      'Explain how Server-Sent Events work compared to WebSockets, with a concise TypeScript example.',
  },
  {
    title: 'Debug or optimize code',
    prompt:
      'Show 3 common React re-render bottlenecks and how to fix each one cleanly.',
  },
  {
    title: 'Draft clear communication',
    prompt:
      'Write a concise project update email summarizing completed milestones, risks, and next steps.',
  },
  {
    title: 'Generate an AI image',
    prompt:
      'Generate a realistic luxury perfume product image on dark marble with warm studio lighting',
  },
  {
    title: 'Brainstorm architecture',
    prompt:
      'Design a clean folder structure and data flow for a local-first web application.',
  },
];

export function ChatWindow({
  conversation,
  model,
  isStreaming,
  streamingMessageId,
  streamingText,
  error,
  isDesktopSidebarOpen,
  onOpenDesktopSidebar,
  onOpenMobileSidebar,
  onNewChat,
  onChangeModel,
  onSendMessage,
  onGenerateImage,
  onRegenerateImage,
  onCancelImage,
  onStopGeneration,
  onRegenerate,
  onEditMessage,
  onDismissError,
  onWarmApi,
}: ChatWindowProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  const {
    speakingMessageId,
    playbackState,
    rate: speechRate,
    error: speechError,
    togglePlayPause,
    stop: stopSpeech,
    setRate: setSpeechRate,
    dismissError: dismissSpeechError,
  } = useSpeechSynthesis();

  const messages = conversation?.messages ?? [];
  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant')?.id;

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 120;
    setShouldAutoScroll(isNearBottom);
    setShowJumpToBottom(distanceFromBottom > 240);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomAnchorRef.current?.scrollIntoView({behavior, block: 'end'});
    setShouldAutoScroll(true);
    setShowJumpToBottom(false);
  }, []);

  // Scroll & stop active message speech when switching conversations
  useEffect(() => {
    stopSpeech();
    setShouldAutoScroll(true);
    setShowJumpToBottom(false);
    bottomAnchorRef.current?.scrollIntoView({behavior: 'auto', block: 'end'});
  }, [conversation?.id, stopSpeech]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!previewImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewImage]);

  // Auto-scroll smoothly during streaming or image status transition if user has not scrolled up
  const lastMsg = messages[messages.length - 1];
  const lastMessageContent =
    streamingText || lastMsg?.content || lastMsg?.generatedImage?.status || '';
  useEffect(() => {
    if (!shouldAutoScroll || messages.length === 0) return;
    if (isStreaming && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    } else {
      bottomAnchorRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      });
    }
  }, [messages.length, lastMessageContent, shouldAutoScroll, isStreaming]);

  const handlePreviewImage = useCallback((src: string, alt: string) => {
    setPreviewImage({src, alt});
  }, []);

  const handleOpenVoiceMode = useCallback(() => {
    stopSpeech();
    setIsVoiceModeOpen(true);
  }, [stopSpeech]);

  const handleVoiceTurn = useCallback(
    (transcript: string) => onSendMessage(transcript),
    [onSendMessage]
  );

  const handleSendFromInput = useCallback(
    (content: string, attachments?: PreparedImageAttachment[]) => {
      void onSendMessage(content, attachments);
    },
    [onSendMessage]
  );

  const handleGenerateImageFromInput = useCallback(
    (
      prompt: string,
      options: {style: ImageStylePreset; aspectRatio: ImageAspectRatio}
    ) => {
      void onGenerateImage(prompt, options);
    },
    [onGenerateImage]
  );

  const handleRegenerateImage = useCallback(
    (messageId: string) => {
      void onRegenerateImage(messageId);
    },
    [onRegenerateImage]
  );

  return (
    <div className="flex flex-1 flex-col min-w-0 h-full bg-white dark:bg-[#0B0F17]">
      {/* Compact top bar */}
      <header className="flex items-center justify-between gap-3 h-14 px-3 sm:px-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            aria-label="Open navigation menu"
            className="inline-flex lg:hidden h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            <Menu className="h-5 w-5" />
          </button>

          {!isDesktopSidebarOpen && (
            <button
              type="button"
              onClick={onOpenDesktopSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="hidden lg:inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}

          <h1 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
            {conversation?.title || 'New chat'}
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Fast Free-Tier Model Switcher */}
          <div
            role="group"
            aria-label="Gemini model speed"
            className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 p-0.5"
          >
            <button
              type="button"
              onClick={() => onChangeModel('gemini-3.1-flash-lite')}
              disabled={isStreaming}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                model === 'gemini-3.1-flash-lite'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Zap className="h-3 w-3 text-teal-600 dark:text-teal-400" />
              <span>Flash Lite</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeModel('gemini-4-hydrogen')}
              disabled={isStreaming}
              className={`inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                model === 'gemini-4-hydrogen'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <span>Hydrogen</span>
            </button>
          </div>

          <div className="lg:hidden">
            <NewChatButton onClick={onNewChat} compact />
          </div>
          {!isDesktopSidebarOpen && (
            <div className="hidden lg:block">
              <NewChatButton onClick={onNewChat} compact />
            </div>
          )}
        </div>
      </header>

      {/* Scrollable conversation area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto overflow-x-hidden"
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 sm:py-16">
            <div className="w-full max-w-2xl space-y-8">
              <div className="text-center space-y-2.5">
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
                  What would you like to explore today?
                </h2>
                <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
                  Ask anything, generate free AI images, upload photos, or talk by voice — chats stay saved locally in your browser.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {STARTER_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => void onSendMessage(item.prompt)}
                    className="group flex flex-col items-start text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 hover:bg-slate-100/90 dark:bg-[#111827] dark:hover:bg-slate-800/80 p-4 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:focus-visible:ring-teal-400"
                  >
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {item.title}
                    </span>
                    <span className="mt-1 text-xs text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
                      {item.prompt}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-3xl mx-auto px-3 sm:px-6 py-6 space-y-7">
            {messages.map((msg) => {
              const isStreamingThis = isStreaming && msg.id === streamingMessageId;
              const effectiveMsg = isStreamingThis
                ? {...msg, content: streamingText}
                : msg;
              return (
                <ChatMessage
                  key={msg.id}
                  message={effectiveMsg}
                  isStreamingThis={isStreamingThis}
                  isAnyStreaming={isStreaming}
                  isLastAssistant={msg.id === lastAssistantId}
                  isSpeakingThis={speakingMessageId === msg.id}
                  speechPlaybackState={
                    speakingMessageId === msg.id ? playbackState : 'idle'
                  }
                  speechRate={speechRate}
                  onEditMessage={onEditMessage}
                  onRegenerate={onRegenerate}
                  onRegenerateImage={handleRegenerateImage}
                  onCancelImage={onCancelImage}
                  onToggleSpeak={togglePlayPause}
                  onStopSpeak={stopSpeech}
                  onChangeSpeechRate={setSpeechRate}
                  onPreviewImage={handlePreviewImage}
                />
              );
            })}
            <div ref={bottomAnchorRef} className="h-2" />
          </div>
        )}
      </div>

      {/* Error banners */}
      {(error || speechError) && (
        <div className="w-full max-w-3xl mx-auto px-3 sm:px-6 pb-2 space-y-2">
          {error && (
            <div
              role="alert"
              className="flex items-start sm:items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-200"
            >
              <div className="flex items-start sm:items-center gap-2.5 min-w-0">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400 mt-0.5 sm:mt-0" />
                <p className="text-xs sm:text-sm leading-snug">{error.message}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {error.retryable && !isStreaming && messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onRegenerate()}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors whitespace-nowrap"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Retry</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label="Dismiss error"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-600 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {speechError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200"
            >
              <span>{speechError}</span>
              <button
                type="button"
                onClick={dismissSpeechError}
                aria-label="Dismiss speech notice"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-amber-200/60 dark:hover:bg-amber-900/50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Floating jump-to-bottom control */}
      {showJumpToBottom && (
        <div className="relative w-full max-w-3xl mx-auto">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="Scroll to latest message"
            className="absolute -top-12 left-1/2 -translate-x-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-600 dark:text-slate-300 shadow-md hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Pinned chat composer */}
      <div className="shrink-0 bg-white dark:bg-[#0B0F17]">
        <ChatInput
          isStreaming={isStreaming}
          onSend={handleSendFromInput}
          onGenerateImage={handleGenerateImageFromInput}
          onStop={onStopGeneration}
          onOpenVoiceMode={handleOpenVoiceMode}
          onWarmApi={onWarmApi}
          autoFocusTrigger={conversation?.id ?? 'empty'}
        />
      </div>

      {/* Real-time Voice Conversation Modal */}
      <VoiceConversationModal
        isOpen={isVoiceModeOpen}
        streamingText={streamingText}
        onSendVoiceTurn={handleVoiceTurn}
        onStopGeneration={onStopGeneration}
        onClose={() => setIsVoiceModeOpen(false)}
      />

      {/* Fullscreen Image Lightbox */}
      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.alt}
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-xs"
        >
          <button
            type="button"
            onClick={() => setPreviewImage(null)}
            aria-label="Close image preview"
            className="absolute top-4 right-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/80 text-white hover:bg-slate-800 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={previewImage.src}
            alt={previewImage.alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[88vh] max-w-[92vw] rounded-2xl object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
