import {
  ArrowUp,
  AudioLines,
  Camera,
  ImagePlus,
  Loader2,
  Mic,
  Square,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {useSpeechRecognition} from '../hooks/useSpeechRecognition';
import type {
  ImageAspectRatio,
  ImageStylePreset,
  PreparedImageAttachment,
} from '../types/chat';
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_STYLE_OPTIONS,
} from '../utils/imageIntent';
import {
  MAX_IMAGES_PER_MESSAGE,
  prepareImageAttachment,
} from '../utils/imageStore';

interface ChatInputProps {
  isStreaming: boolean;
  onSend: (message: string, attachments?: PreparedImageAttachment[]) => void;
  onGenerateImage: (
    prompt: string,
    options: {style: ImageStylePreset; aspectRatio: ImageAspectRatio}
  ) => void;
  onStop: () => void;
  onOpenVoiceMode: () => void;
  onWarmApi?: () => void;
  autoFocusTrigger?: string | null;
}

export const ChatInput = memo(function ChatInput({
  isStreaming,
  onSend,
  onGenerateImage,
  onStop,
  onOpenVoiceMode,
  onWarmApi,
  autoFocusTrigger,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<PreparedImageAttachment[]>([]);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isImageMode, setIsImageMode] = useState(false);
  const [imageStyle, setImageStyle] = useState<ImageStylePreset>('auto');
  const [imageRatio, setImageRatio] = useState<ImageAspectRatio>('1:1');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const appendTranscript = useCallback((spokenText: string) => {
    const cleaned = spokenText.trim();
    if (!cleaned) return;
    setValue((prev) => {
      if (!prev.trim()) return cleaned;
      const needsSpace = !/\s$/.test(prev);
      return `${prev}${needsSpace ? ' ' : ''}${cleaned}`;
    });
  }, []);

  const {
    isListening,
    isTranscribing,
    interimTranscript,
    error: speechError,
    language,
    setLanguage,
    startListening,
    stopListening,
    dismissError: dismissSpeechError,
  } = useSpeechRecognition({onFinalTranscript: appendTranscript});

  // Auto-resize textarea up to 180px
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 180);
    el.style.height = `${Math.max(nextHeight, 40)}px`;
  }, [value]);

  useEffect(() => {
    if (window.innerWidth >= 768) {
      textareaRef.current?.focus();
    }
  }, [autoFocusTrigger]);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      const remainingSlots = MAX_IMAGES_PER_MESSAGE - attachments.length;
      if (remainingSlots <= 0) {
        setMediaError(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
        return;
      }

      setMediaError(null);
      setIsProcessingImage(true);
      const selected = files.slice(0, remainingSlots);
      const prepared: PreparedImageAttachment[] = [];

      try {
        for (const file of selected) {
          const item = await prepareImageAttachment(file);
          prepared.push(item);
        }
        if (prepared.length > 0) {
          setIsImageMode(false);
          setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
        if (files.length > remainingSlots) {
          setMediaError(
            `Only the first ${remainingSlots} image${remainingSlots === 1 ? ' was' : 's were'} attached (max ${MAX_IMAGES_PER_MESSAGE} per message).`
          );
        }
      } catch (err) {
        setMediaError(
          err instanceof Error
            ? err.message
            : 'Unable to attach image. Please use JPG, PNG, or WEBP.'
        );
      } finally {
        setIsProcessingImage(false);
      }
    },
    [attachments.length]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
    setMediaError(null);
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void handleFiles(imageFiles);
      }
    },
    [handleFiles]
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (isImageMode) {
      if (!trimmed || isTranscribing) return;
      if (isListening) {
        stopListening();
      }
      onGenerateImage(trimmed, {
        style: imageStyle,
        aspectRatio: imageRatio,
      });
      setValue('');
      setMediaError(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = '40px';
      }
      return;
    }

    if ((!trimmed && attachments.length === 0) || isStreaming || isProcessingImage) {
      return;
    }
    if (isListening) {
      stopListening();
    }
    const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;
    onSend(trimmed, attachmentsToSend);
    setValue('');
    setAttachments([]);
    setMediaError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = '40px';
    }
  };

  const activeError = mediaError || speechError;
  const canSend = isImageMode
    ? value.trim().length > 0 && !isTranscribing
    : (value.trim().length > 0 || attachments.length > 0) &&
      !isStreaming &&
      !isProcessingImage &&
      !isTranscribing;

  return (
    <div className="w-full max-w-3xl mx-auto px-3 sm:px-6 pb-3 sm:pb-5 pt-2">
      {/* Hidden inputs for file picker & mobile camera */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void handleFiles(e.target.files);
          }
          e.target.value = '';
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void handleFiles(e.target.files);
          }
          e.target.value = '';
        }}
      />

      {activeError && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <span className="leading-snug">{activeError}</span>
          <button
            type="button"
            onClick={() => {
              setMediaError(null);
              dismissSpeechError();
            }}
            aria-label="Dismiss input notice"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-amber-200/60 dark:hover:bg-amber-900/50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex flex-col rounded-2xl bg-slate-50 dark:bg-[#111827] border shadow-sm transition-colors ${
          isDraggingOver
            ? 'border-teal-600 ring-2 ring-teal-600/30 dark:border-teal-400'
            : isImageMode
              ? 'border-teal-500/70 dark:border-teal-500/60 ring-1 ring-teal-500/20'
              : 'border-slate-200 dark:border-slate-800 focus-within:border-teal-600 dark:focus-within:border-teal-500 focus-within:ring-1 focus-within:ring-teal-600/30 dark:focus-within:ring-teal-500/30'
        }`}
      >
        {/* Free AI Image Generation Options Strip */}
        {isImageMode && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5 border-b border-slate-200/80 dark:border-slate-800/90 text-xs">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="inline-flex items-center gap-1.5 font-semibold text-teal-700 dark:text-teal-400 shrink-0">
                <WandSparkles className="h-3.5 w-3.5" />
                <span>Create Image</span>
              </span>

              <label className="inline-flex items-center gap-1.5">
                <span className="text-slate-500 dark:text-slate-400 hidden sm:inline">
                  Style
                </span>
                <select
                  aria-label="Image style preset"
                  value={imageStyle}
                  onChange={(e) => setImageStyle(e.target.value as ImageStylePreset)}
                  className="h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  {IMAGE_STYLE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <div
                role="group"
                aria-label="Image aspect ratio"
                className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5"
              >
                {IMAGE_ASPECT_RATIOS.map((ratio) => (
                  <button
                    key={ratio.id}
                    type="button"
                    onClick={() => setImageRatio(ratio.id)}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      imageRatio === ratio.id
                        ? 'bg-teal-600 text-white'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    {ratio.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsImageMode(false)}
              aria-label="Exit image generation mode"
              title="Back to chat mode"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 dark:hover:text-slate-200 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Image Attachment Previews */}
        {(attachments.length > 0 || isProcessingImage) && (
          <div className="flex flex-wrap items-center gap-2.5 px-3.5 pt-3 pb-1">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="group relative h-16 w-16 sm:h-[72px] sm:w-[72px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shrink-0"
              >
                <img
                  src={att.thumbnailDataUrl}
                  alt={att.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={`Remove ${att.name}`}
                  title="Remove image"
                  className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/80 text-white hover:bg-slate-900 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {isProcessingImage && (
              <div className="flex h-16 w-16 sm:h-[72px] sm:w-[72px] items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin text-teal-600 dark:text-teal-400" />
              </div>
            )}
          </div>
        )}

        {/* Voice Recording / Transcription Status Strip */}
        {(isListening || isTranscribing) && (
          <div className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                  isTranscribing
                    ? 'bg-teal-600 dark:bg-teal-400 animate-pulse'
                    : 'bg-red-500 animate-pulse'
                }`}
              />
              <span className="font-medium text-slate-700 dark:text-slate-200 shrink-0">
                {isTranscribing ? 'Transcribing...' : 'Listening'}
              </span>
              {interimTranscript && (
                <span className="truncate italic text-slate-500 dark:text-slate-400">
                  {interimTranscript}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  setLanguage(language === 'en-US' ? 'ur-PK' : 'en-US')
                }
                disabled={isTranscribing}
                title="Switch speech language (English / Urdu)"
                className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                {language === 'ur-PK' ? 'Urdu' : 'EN / Roman'}
              </button>
              {isListening && (
                <button
                  type="button"
                  onClick={stopListening}
                  className="px-2 py-1 rounded-md bg-red-600 text-white text-[11px] font-semibold hover:bg-red-700 transition-colors"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        )}

        {/* Textarea */}
        <div className="px-3.5 pt-2.5 pb-1">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onFocus={onWarmApi}
            onChange={(e) => {
              onWarmApi?.();
              setValue(e.target.value);
            }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={
              isImageMode
                ? 'Describe the image you want to create (e.g., realistic luxury perfume bottle on marble)...'
                : attachments.length > 0
                  ? 'Ask a question about your image, or send as-is...'
                  : 'Message Lumen or ask to generate an image...'
            }
            aria-label={isImageMode ? 'Image prompt input' : 'Message input'}
            className="w-full min-h-[40px] max-h-[180px] resize-none bg-transparent py-1 text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
          />
        </div>

        {/* Bottom Composer Action Row */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setIsImageMode((prev) => !prev);
                textareaRef.current?.focus();
              }}
              disabled={attachments.length > 0}
              aria-pressed={isImageMode}
              aria-label="Toggle AI image generation mode"
              title="Generate image for free"
              className={`inline-flex h-9 items-center gap-1.5 px-2.5 rounded-xl text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isImageMode
                  ? 'bg-teal-600 text-white hover:bg-teal-500'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <WandSparkles className="h-4 w-4" />
              <span className="hidden sm:inline">Image</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                isStreaming ||
                isProcessingImage ||
                attachments.length >= MAX_IMAGES_PER_MESSAGE
              }
              aria-label="Upload image"
              title="Upload image (JPG, PNG, WEBP)"
              className="inline-flex h-9 w-9 sm:h-9 sm:w-9 items-center justify-center rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-40 disabled:cursor-not-allowed dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ImagePlus className="h-[18px] w-[18px]" />
            </button>

            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={
                isStreaming ||
                isProcessingImage ||
                attachments.length >= MAX_IMAGES_PER_MESSAGE
              }
              aria-label="Take photo with camera"
              title="Take photo"
              className="inline-flex h-9 w-9 sm:h-9 sm:w-9 items-center justify-center rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-40 disabled:cursor-not-allowed dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Camera className="h-[18px] w-[18px]" />
            </button>

            {!isListening && !isTranscribing && (
              <button
                type="button"
                onClick={() =>
                  setLanguage(language === 'en-US' ? 'ur-PK' : 'en-US')
                }
                title="Voice input language (English / Roman Urdu or Urdu)"
                aria-label={`Voice language: ${language === 'ur-PK' ? 'Urdu' : 'English'}`}
                className="hidden sm:inline-flex h-8 items-center px-2 rounded-lg text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                {language === 'ur-PK' ? 'UR' : 'EN'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void startListening()}
              disabled={(isStreaming && !isImageMode) || isTranscribing}
              aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
              title={isListening ? 'Stop voice input' : 'Dictate with microphone'}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
                isListening
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {isTranscribing ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin text-teal-600 dark:text-teal-400" />
              ) : (
                <Mic className="h-[18px] w-[18px]" />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (isListening) stopListening();
                onOpenVoiceMode();
              }}
              disabled={isStreaming}
              aria-label="Open voice conversation mode"
              title="Real-time voice conversation"
              className="inline-flex h-9 items-center gap-1.5 px-2.5 rounded-xl bg-slate-200/80 text-slate-800 hover:bg-slate-300/80 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-xs font-medium"
            >
              <AudioLines className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <span className="hidden sm:inline">Voice</span>
            </button>

            {isStreaming && !isImageMode ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                title="Stop generating"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSend}
                aria-label={isImageMode ? 'Generate image' : 'Send message'}
                title={isImageMode ? 'Generate image' : 'Send message'}
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
                  canSend
                    ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-teal-600 dark:text-white dark:hover:bg-teal-500'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed dark:bg-slate-800 dark:text-slate-600'
                }`}
              >
                {isImageMode ? (
                  <WandSparkles className="h-4 w-4" />
                ) : (
                  <ArrowUp className="h-[18px] w-[18px]" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="mt-1.5 hidden sm:block text-center text-xs text-slate-400 dark:text-slate-500">
        {isImageMode
          ? 'Free AI image generation · Uses public providers with automatic fallback'
          : 'Enter to send · Shift + Enter for new line · Type a prompt or toggle Image to generate'}
      </p>
    </div>
  );
});
