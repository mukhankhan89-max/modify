import type {
  Conversation,
  GeminiModelId,
  SpeechLanguage,
  SpeechRate,
  ThemeMode,
} from '../types/chat';

const CONVERSATIONS_KEY = 'lumen_conversations_v1';
const ACTIVE_CHAT_KEY = 'lumen_active_chat_id_v1';
const THEME_KEY = 'lumen_theme_v1';
const MODEL_KEY = 'lumen_model_v1';
const SPEECH_LANG_KEY = 'lumen_speech_lang_v1';
const SPEECH_RATE_KEY = 'lumen_speech_rate_v1';

function isValidAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const att = value as Record<string, unknown>;
  return (
    typeof att.id === 'string' &&
    typeof att.name === 'string' &&
    (att.mimeType === 'image/jpeg' ||
      att.mimeType === 'image/png' ||
      att.mimeType === 'image/webp') &&
    typeof att.size === 'number' &&
    typeof att.width === 'number' &&
    typeof att.height === 'number' &&
    typeof att.thumbnailDataUrl === 'string'
  );
}

function isValidGeneratedImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const img = value as Record<string, unknown>;
  return (
    typeof img.id === 'string' &&
    typeof img.prompt === 'string' &&
    typeof img.style === 'string' &&
    typeof img.aspectRatio === 'string' &&
    typeof img.width === 'number' &&
    typeof img.height === 'number' &&
    (img.status === 'generating' || img.status === 'ready' || img.status === 'error') &&
    typeof img.createdAt === 'number'
  );
}

function isValidMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  const attachmentsValid =
    msg.attachments === undefined ||
    (Array.isArray(msg.attachments) && msg.attachments.every(isValidAttachment));
  const generatedImageValid =
    msg.generatedImage === undefined || isValidGeneratedImage(msg.generatedImage);

  return (
    typeof msg.id === 'string' &&
    (msg.role === 'user' || msg.role === 'assistant') &&
    typeof msg.content === 'string' &&
    typeof msg.createdAt === 'number' &&
    attachmentsValid &&
    generatedImageValid
  );
}

function isValidConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const conv = value as Record<string, unknown>;
  return (
    typeof conv.id === 'string' &&
    typeof conv.title === 'string' &&
    typeof conv.createdAt === 'number' &&
    typeof conv.updatedAt === 'number' &&
    Array.isArray(conv.messages) &&
    conv.messages.every(isValidMessage)
  );
}

export function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidConversation)
      .map((conv) => ({
        ...conv,
        messages: conv.messages.map((m) =>
          m.generatedImage && m.generatedImage.status === 'generating'
            ? {
                ...m,
                generatedImage: {
                  ...m.generatedImage,
                  status: 'error' as const,
                  error: 'Image generation was interrupted. Click Regenerate to try again.',
                },
              }
            : m
        ),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch (err) {
    console.warn('Failed to persist conversations to Local Storage:', err);
  }
}

export function loadActiveChatId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_CHAT_KEY);
  } catch {
    return null;
  }
}

export function saveActiveChatId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_CHAT_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_CHAT_KEY);
    }
  } catch {
    // Ignore storage quota or restricted context errors
  }
}

export function loadTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function saveTheme(theme: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

export function loadModel(): GeminiModelId {
  if (typeof window === 'undefined') return 'gemini-3.1-flash-lite';
  try {
    const saved = window.localStorage.getItem(MODEL_KEY);
    if (saved === 'gemini-3.1-flash-lite' || saved === 'gemini-4-hydrogen') {
      return saved;
    }
    return 'gemini-3.1-flash-lite';
  } catch {
    return 'gemini-3.1-flash-lite';
  }
}

export function saveModel(model: GeminiModelId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODEL_KEY, model);
  } catch {
    // Ignore storage errors
  }
}

export function loadSpeechLanguage(): SpeechLanguage {
  if (typeof window === 'undefined') return 'en-US';
  try {
    const saved = window.localStorage.getItem(SPEECH_LANG_KEY);
    if (saved === 'en-US' || saved === 'ur-PK') return saved;
    return 'en-US';
  } catch {
    return 'en-US';
  }
}

export function saveSpeechLanguage(lang: SpeechLanguage): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPEECH_LANG_KEY, lang);
  } catch {
    // Ignore storage errors
  }
}

export function loadSpeechRate(): SpeechRate {
  if (typeof window === 'undefined') return 1;
  try {
    const saved = Number(window.localStorage.getItem(SPEECH_RATE_KEY));
    if (saved === 0.75 || saved === 1 || saved === 1.25 || saved === 1.5) {
      return saved;
    }
    return 1;
  } catch {
    return 1;
  }
}

export function saveSpeechRate(rate: SpeechRate): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPEECH_RATE_KEY, String(rate));
  } catch {
    // Ignore storage errors
  }
}
