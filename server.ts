import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {ThinkingLevel} from '@google/genai';
import {buildSystemInstruction} from './api/_lib/timeContext.js';
import {
  ALLOWED_MODELS,
  BASE_SYSTEM_INSTRUCTION,
  buildGeminiContents,
  classifyGeminiError,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  generateSpeechWithGemini,
  getGenAIClient,
  MAX_AUDIO_BASE64_CHARS,
  normalizeAudioMimeType,
  sanitizeIncomingMessages,
  transcribeAudioWithGemini,
} from './api/_lib/gemini.js';

dotenv.config({path: '.env.local'});
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({limit: '10mb'}));

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
    const sanitized = sanitizeIncomingMessages(body?.messages);
    if (sanitized.error) {
      res.status(sanitized.error.status).json({
        code: sanitized.error.code,
        error: sanitized.error.message,
      });
      return;
    }

    const requestedModel =
      typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
        ? body.model
        : DEFAULT_MODEL;

    const contents = buildGeminiContents(sanitized.messages);

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

  app.post('/api/transcribe', async (req, res) => {
    const ai = getGenAIClient();
    if (!ai) {
      console.error('[Gemini /api/transcribe] Missing or placeholder GEMINI_API_KEY');
      res.status(500).json({
        code: 'MISSING_API_KEY',
        error: 'GEMINI_API_KEY is not configured on the server.',
      });
      return;
    }

    const body = req.body as {audio?: unknown; mimeType?: unknown; language?: unknown};
    const normalizedMime = normalizeAudioMimeType(body?.mimeType);
    if (!normalizedMime) {
      res.status(400).json({
        code: 'UNSUPPORTED_AUDIO_FORMAT',
        error: 'Unsupported audio format for transcription.',
      });
      return;
    }

    const rawAudio = typeof body?.audio === 'string' ? body.audio.trim() : '';
    const cleanBase64 = rawAudio.includes(',') ? rawAudio.split(',')[1] ?? '' : rawAudio;
    if (!cleanBase64) {
      res.status(400).json({
        code: 'EMPTY_AUDIO',
        error: 'Recorded audio is empty.',
      });
      return;
    }

    if (cleanBase64.length > MAX_AUDIO_BASE64_CHARS) {
      res.status(413).json({
        code: 'AUDIO_TOO_LARGE',
        error: 'Audio recording is too long. Please keep clips concise.',
      });
      return;
    }

    const language = typeof body?.language === 'string' ? body.language : 'en-US';

    try {
      const text = await transcribeAudioWithGemini(ai, {
        audioBase64: cleanBase64,
        mimeType: normalizedMime,
        language,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({text});
    } catch (err) {
      const classified = classifyGeminiError(err);
      console.error(
        `[Gemini /api/transcribe failed] status=${classified.status} code=${classified.code} detail=${classified.detail}`
      );
      res.status(classified.status).json({
        code: classified.code,
        error: classified.message,
      });
    }
  });

  app.post('/api/tts', async (req, res) => {
    const ai = getGenAIClient();
    if (!ai) {
      console.error('[Gemini /api/tts] Missing or placeholder GEMINI_API_KEY');
      res.status(500).json({
        code: 'MISSING_API_KEY',
        error: 'GEMINI_API_KEY is not configured on the server.',
      });
      return;
    }

    const body = req.body as {text?: unknown; voiceName?: unknown};
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) {
      res.status(400).json({
        code: 'INVALID_REQUEST',
        error: 'Text is required for speech synthesis.',
      });
      return;
    }

    const voiceName = typeof body?.voiceName === 'string' ? body.voiceName : undefined;

    try {
      const result = await generateSpeechWithGemini(ai, {text, voiceName});
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      const classified = classifyGeminiError(err);
      console.error(
        `[Gemini /api/tts failed] status=${classified.status} code=${classified.code} detail=${classified.detail}`
      );
      res.status(classified.status).json({
        code: classified.code,
        error: classified.message,
      });
    }
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
