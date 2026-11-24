import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {GoogleGenAI, ThinkingLevel} from '@google/genai';
import {buildSystemInstruction} from './api/_lib/timeContext.js';

dotenv.config({path: '.env.local'});
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ALLOWED_MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-4-hydrogen']);
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_HISTORY_MESSAGES = 8;

interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey = '';

function getGenAIClient(): GoogleGenAI | null {
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
  }
  return cachedClient;
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
      if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
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

function classifyGeminiError(err: unknown): {
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
  const statusMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
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
        'Your Gemini API key is invalid. Please verify GEMINI_API_KEY in .env.local or Settings > Secrets.',
      retryable: false,
      detail,
    };
  }

  if (upper.includes('PERMISSION_DENIED') || numericStatus === 403) {
    return {
      status: 403,
      code: 'PERMISSION_DENIED',
      message:
        'Permission denied by Gemini API. Please check your GEMINI_API_KEY permissions in Settings > Secrets.',
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

  const cleanDetail = detail.length > 0 && detail.length <= 160 ? ` (${detail})` : '';
  return {
    status: numericStatus >= 400 && numericStatus < 600 ? numericStatus : 500,
    code: 'GEMINI_ERROR',
    message: `Gemini API error${cleanDetail}. Please try again.`,
    retryable: numericStatus >= 500,
    detail,
  };
}

const BASE_SYSTEM_INSTRUCTION =
  'You are Lumen, a fast, friendly AI assistant. Answer directly in 1-5 sentences by default (no intros, filler, "Sure!", or sign-offs); expand only when asked. Reply in the user\'s language (English, Urdu, or Roman Urdu). Give clean fenced code blocks with language tags.';

async function startServer() {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  app.get('/api/health', (_req, res) => {
    const hasKey = Boolean(getGenAIClient());
    res.json({ok: true, configured: hasKey});
  });

  app.get('/api/chat', (_req, res) => {
    const configured = Boolean(getGenAIClient());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ok: true, configured});
  });

  app.post('/api/chat', async (req, res) => {
    const ai = getGenAIClient();
    if (!ai) {
      console.error('[Gemini /api/chat] Missing or placeholder GEMINI_API_KEY');
      res.status(500).json({
        code: 'MISSING_API_KEY',
        error:
          'GEMINI_API_KEY is not configured on the server. Set it in .env.local or Settings > Secrets.',
      });
      return;
    }

    const body = req.body as {messages?: unknown; model?: unknown};
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      res.status(400).json({
        code: 'INVALID_REQUEST',
        error: 'A non-empty messages array is required.',
      });
      return;
    }

    const validMessages: IncomingMessage[] = body.messages
      .filter(
        (m): m is IncomingMessage =>
          Boolean(m) &&
          typeof m === 'object' &&
          ((m as IncomingMessage).role === 'user' || (m as IncomingMessage).role === 'assistant') &&
          typeof (m as IncomingMessage).content === 'string' &&
          (m as IncomingMessage).content.trim().length > 0
      )
      .slice(-MAX_HISTORY_MESSAGES);

    if (validMessages.length === 0) {
      res.status(400).json({
        code: 'INVALID_REQUEST',
        error: 'Messages must contain valid text content.',
      });
      return;
    }

    const requestedModel =
      typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
        ? body.model
        : DEFAULT_MODEL;

    const contents = validMessages.map((m, idx) => {
      const isRecent = idx >= validMessages.length - 2;
      const text = !isRecent && m.content.length > 900 ? `${m.content.slice(0, 900)}...` : m.content;
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{text}],
      };
    });

    // SSE headers for instant word-by-word streaming without proxy buffering
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abortController = new AbortController();
    let clientClosed = false;

    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abortController.abort();
      }
    });

    const writeEvent = (payload: Record<string, unknown>) => {
      if (clientClosed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (!clientClosed && !res.writableEnded) {
      res.write(': open\n\n');
    }

    let totalEmitted = 0;
    const attemptStream = async (modelId: string): Promise<void> => {
      const dynamicSystemInstruction = buildSystemInstruction(BASE_SYSTEM_INSTRUCTION);
      const config =
        modelId === 'gemini-4-hydrogen'
          ? {
              systemInstruction: dynamicSystemInstruction,
              thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
              abortSignal: abortController.signal,
            }
          : {
              systemInstruction: dynamicSystemInstruction,
              maxOutputTokens: 1024,
              abortSignal: abortController.signal,
            };

      const stream = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config,
      });

      for await (const chunk of stream) {
        if (clientClosed) break;
        const text = chunk.text;
        if (text) {
          totalEmitted += text.length;
          writeEvent({text});
        }
      }
    };

    const alternateModel =
      requestedModel === 'gemini-3.1-flash-lite' ? 'gemini-4-hydrogen' : FALLBACK_MODEL;
    const modelsToTry = [requestedModel, alternateModel];

    let lastError: unknown = null;

    for (let i = 0; i < modelsToTry.length; i++) {
      if (clientClosed || abortController.signal.aborted) break;
      const targetModel = modelsToTry[i];

      try {
        await attemptStream(targetModel);
        lastError = null;
        break;
      } catch (err) {
        if (clientClosed || abortController.signal.aborted) {
          if (!res.writableEnded) res.end();
          return;
        }
        lastError = err;
        const classified = classifyGeminiError(err);
        console.error(
          `[Gemini /api/chat attempt ${i + 1}/${modelsToTry.length} failed] model=${targetModel} status=${classified.status} code=${classified.code} detail=${classified.detail}`
        );

        // Do not retry if chunks were already streamed or error is non-retryable
        if (totalEmitted > 0 || !classified.retryable) {
          break;
        }
      }
    }

    if (clientClosed || abortController.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }

    if (lastError) {
      const classified = classifyGeminiError(lastError);
      writeEvent({
        error: classified.message,
        code: classified.code,
        status: classified.status,
      });
      res.end();
      return;
    }

    if (totalEmitted === 0) {
      console.warn('[Gemini /api/chat] Stream completed with 0 emitted characters');
      writeEvent({
        error: 'Gemini returned an empty response. Please try rephrasing or retrying.',
        code: 'EMPTY_RESPONSE',
        status: 502,
      });
      res.end();
      return;
    }

    writeEvent({done: true});
    res.end();
  });

  app.post('/api/title', async (req, res) => {
    const ai = getGenAIClient();
    const body = req.body as {message?: unknown};
    const message = typeof body?.message === 'string' ? body.message.trim() : '';

    if (!message) {
      res.status(400).json({error: 'Message is required.'});
      return;
    }

    if (!ai) {
      res.json({title: ''});
      return;
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Generate a concise 3 to 5 word title for a conversation starting with this user message. Return ONLY the plain text title with no quotes, no markdown, and no trailing punctuation.\n\nMessage: ${message.slice(0, 400)}`,
      });
      const rawTitle = (response.text ?? '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 60);
      res.json({title: rawTitle});
    } catch (err) {
      const classified = classifyGeminiError(err);
      console.warn(`[Gemini /api/title fallback] ${classified.code}: ${classified.detail}`);
      res.json({title: ''});
    }
  });

  if (!IS_PRODUCTION) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lumen Chat server running at http://localhost:${PORT}`);
  });
}

startServer();
