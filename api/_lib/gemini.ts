import process from 'node:process';
import {GoogleGenAI} from '@google/genai';

export const ALLOWED_MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-4-hydrogen']);
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
export const MAX_HISTORY_MESSAGES = 8;
export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_BASE64_CHARS = 4_000_000;
export const MAX_AUDIO_BASE64_CHARS = 8_000_000;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/flac',
]);

export const ALLOWED_TTS_VOICES = new Set([
  'Kore',
  'Zephyr',
  'Puck',
  'Charon',
  'Fenrir',
]);

export const BASE_SYSTEM_INSTRUCTION =
  'You are Lumen, a fast, friendly AI assistant. Answer directly in 1-5 sentences by default (no intros, filler, "Sure!", or sign-offs); expand only when asked. Reply in the user\'s language (English, Urdu, or Roman Urdu). When images are provided, analyze objects, colors, text/OCR, screenshots, products, and documents accurately. Give clean fenced code blocks with language tags.';

export interface IncomingImagePart {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
}

export interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: IncomingImagePart[];
}

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

let cachedClient: GoogleGenAI | null = null;
let cachedBetaClient: GoogleGenAI | null = null;
let cachedApiKey = '';

export function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedBetaClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function getBetaGenAIClient(): GoogleGenAI | null {
  if (!getGenAIClient()) return null;
  return cachedBetaClient;
}

function extractNestedErrorMessage(raw: string): string {
  let current = raw.trim();
  for (let i = 0; i < 3; i++) {
    if (!current.startsWith('{')) break;
    try {
      const parsed = JSON.parse(current) as {
        error?: {message?: string} | string;
        message?: string;
      };
      if (
        parsed.error &&
        typeof parsed.error === 'object' &&
        typeof parsed.error.message === 'string'
      ) {
        current = parsed.error.message.trim();
      } else if (typeof parsed.message === 'string') {
        current = parsed.message.trim();
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return current;
}

export function classifyGeminiError(err: unknown): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  detail: string;
} {
  const errObj = err as {status?: number; message?: string; code?: string} | null;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof errObj?.message === 'string'
        ? errObj.message
        : typeof err === 'string'
          ? err
          : 'Unknown error';

  const detail = extractNestedErrorMessage(rawMessage);
  const upper = `${rawMessage} ${detail}`.toUpperCase();
  const statusFromErr = typeof errObj?.status === 'number' ? errObj.status : 0;
  const statusMatch = rawMessage.match(/\b(400|401|403|404|413|429|500|502|503|504)\b/);
  const numericStatus = statusFromErr || (statusMatch ? Number(statusMatch[1]) : 500);

  if (
    upper.includes('API_KEY_INVALID') ||
    upper.includes('API KEY NOT VALID') ||
    upper.includes('INVALID API KEY') ||
    numericStatus === 401
  ) {
    return {
      status: 400,
      code: 'API_KEY_INVALID',
      message:
        'Your Gemini API key is invalid. Please verify GEMINI_API_KEY in your environment variables.',
      retryable: false,
      detail,
    };
  }

  if (upper.includes('PERMISSION_DENIED') || numericStatus === 403) {
    return {
      status: 403,
      code: 'PERMISSION_DENIED',
      message:
        'Permission denied by Gemini API. Please check your GEMINI_API_KEY permissions.',
      retryable: false,
      detail,
    };
  }

  if (
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('QUOTA') ||
    upper.includes('RATE LIMIT') ||
    numericStatus === 429
  ) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      message:
        'Gemini free-tier rate limit or quota exceeded (429). Please wait a few seconds and retry.',
      retryable: true,
      detail,
    };
  }

  if (upper.includes('NOT_FOUND') || numericStatus === 404) {
    return {
      status: 404,
      code: 'MODEL_NOT_FOUND',
      message: 'The selected Gemini model was not found (404). Try switching models and retrying.',
      retryable: false,
      detail,
    };
  }

  if (
    upper.includes('UNAVAILABLE') ||
    upper.includes('OVERLOADED') ||
    upper.includes('HIGH DEMAND') ||
    numericStatus === 503
  ) {
    return {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Gemini servers are temporarily busy (503). Please try again in a moment.',
      retryable: true,
      detail,
    };
  }

  if (
    upper.includes('FETCH') ||
    upper.includes('ECONNREFUSED') ||
    upper.includes('ENOTFOUND') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('ECONNRESET') ||
    upper.includes('NETWORK')
  ) {
    return {
      status: 503,
      code: 'NETWORK_ERROR',
      message: 'Network error while connecting to Gemini API. Check your connection and retry.',
      retryable: true,
      detail,
    };
  }

  const cleanDetail =
    detail.length > 0 ? ` (${detail.slice(0, 180)}${detail.length > 180 ? '...' : ''})` : '';
  return {
    status: numericStatus >= 400 && numericStatus < 600 ? numericStatus : 500,
    code: 'GEMINI_ERROR',
    message: `Gemini API error${cleanDetail}. Please try again.`,
    retryable: numericStatus >= 500,
    detail,
  };
}

export function sanitizeIncomingMessages(rawMessages: unknown): {
  messages: IncomingMessage[];
  error?: {status: number; code: string; message: string};
} {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return {
      messages: [],
      error: {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'A non-empty messages array is required.',
      },
    };
  }

  const sanitized: IncomingMessage[] = [];

  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (raw.role !== 'user' && raw.role !== 'assistant') continue;

    const content = typeof raw.content === 'string' ? raw.content : '';
    let validImages: IncomingImagePart[] | undefined;

    if (Array.isArray(raw.images) && raw.images.length > 0) {
      if (raw.images.length > MAX_IMAGES_PER_MESSAGE) {
        return {
          messages: [],
          error: {
            status: 400,
            code: 'TOO_MANY_IMAGES',
            message: `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`,
          },
        };
      }

      const collected: IncomingImagePart[] = [];
      for (const img of raw.images) {
        if (!img || typeof img !== 'object') continue;
        const imgObj = img as Record<string, unknown>;
        const rawMime =
          typeof imgObj.mimeType === 'string'
            ? imgObj.mimeType.toLowerCase().trim()
            : '';
        const normalizedMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
        if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
          return {
            messages: [],
            error: {
              status: 400,
              code: 'UNSUPPORTED_IMAGE_FORMAT',
              message: 'Unsupported image format. Please upload JPG, JPEG, PNG, or WEBP.',
            },
          };
        }

        const rawData = typeof imgObj.data === 'string' ? imgObj.data.trim() : '';
        const cleanBase64 = rawData.includes(',') ? rawData.split(',')[1] ?? '' : rawData;
        if (!cleanBase64) continue;
        if (cleanBase64.length > MAX_IMAGE_BASE64_CHARS) {
          return {
            messages: [],
            error: {
              status: 413,
              code: 'IMAGE_TOO_LARGE',
              message: 'An attached image is too large to process. Please use a smaller image.',
            },
          };
        }

        collected.push({
          mimeType: normalizedMime as 'image/jpeg' | 'image/png' | 'image/webp',
          data: cleanBase64,
        });
      }

      if (collected.length > 0) {
        validImages = collected;
      }
    }

    if (content.trim().length > 0 || (validImages && validImages.length > 0)) {
      sanitized.push({
        role: raw.role,
        content,
        images: validImages,
      });
    }
  }

  const sliced = sanitized.slice(-MAX_HISTORY_MESSAGES);
  if (sliced.length === 0) {
    return {
      messages: [],
      error: {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Messages must contain valid text or image content.',
      },
    };
  }

  return {messages: sliced};
}

export function buildGeminiContents(validMessages: IncomingMessage[]): GeminiContent[] {
  return validMessages.map((m, idx) => {
    const isRecent = idx >= validMessages.length - 2;
    const text =
      !isRecent && m.content.length > 900
        ? `${m.content.slice(0, 900)}...`
        : m.content;

    const parts: GeminiPart[] = [];
    // Include images only on recent turns to keep request latency & payload low
    if (m.images && m.images.length > 0 && (isRecent || idx === validMessages.length - 3)) {
      for (const img of m.images) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.data,
          },
        });
      }
      parts.push({
        text: text.trim()
          ? text
          : 'Analyze this image and clearly describe or explain what is shown.',
      });
    } else {
      parts.push({text});
    }

    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    };
  });
}

export function normalizeAudioMimeType(rawMime: unknown): string | null {
  if (typeof rawMime !== 'string') return null;
  const base = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_AUDIO_MIME_TYPES.has(base)) return null;
  return base === 'audio/mp3' ? 'audio/mpeg' : base;
}

export async function transcribeAudioWithGemini(
  ai: GoogleGenAI,
  params: {
    audioBase64: string;
    mimeType: string;
    language?: string;
  }
): Promise<string> {
  const langPrompt =
    params.language === 'ur-PK'
      ? 'Transcribe the spoken audio accurately. The speaker may speak Urdu, Roman Urdu, or English. Output ONLY the spoken words with punctuation, and nothing else. If there is no intelligible speech, output an empty string.'
      : 'Transcribe the spoken audio accurately in its original language (English, Roman Urdu, or Urdu). Output ONLY the spoken words with punctuation, and nothing else. If there is no intelligible speech, output an empty string.';

  const contents = {
    parts: [
      {
        inlineData: {
          mimeType: params.mimeType,
          data: params.audioBase64,
        },
      },
      {text: langPrompt},
    ],
  };

  const betaClient = getBetaGenAIClient() ?? ai;

  try {
    const response = await betaClient.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents,
    });
    return (response.text ?? '').trim();
  } catch (err) {
    const classified = classifyGeminiError(err);
    if (classified.status !== 404) {
      throw err;
    }
    const fallbackResponse = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents,
    });
    return (fallbackResponse.text ?? '').trim();
  }
}

export function prepareTextForTts(rawText: string): string {
  return rawText
    .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1400);
}

export async function generateSpeechWithGemini(
  ai: GoogleGenAI,
  params: {
    text: string;
    voiceName?: string;
  }
): Promise<{audio: string; mimeType: 'audio/wav'}> {
  const cleanText = prepareTextForTts(params.text);
  if (!cleanText) {
    throw Object.assign(new Error('No speakable text was provided.'), {status: 400});
  }

  const voice =
    params.voiceName && ALLOWED_TTS_VOICES.has(params.voiceName)
      ? params.voiceName
      : 'Kore';

  const betaClient = getBetaGenAIClient() ?? ai;

  let response;
  try {
    response = await betaClient.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{text: cleanText}],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('speechConfig')) {
      throw err;
    }
    response = await betaClient.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{text: cleanText}],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
      },
    });
  }

  const base64Audio =
    response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Audio) {
    throw Object.assign(
      new Error('Gemini TTS returned empty audio output.'),
      {status: 502}
    );
  }

  return {
    audio: base64Audio,
    mimeType: 'audio/wav',
  };
}
