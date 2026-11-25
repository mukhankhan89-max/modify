import {ThinkingLevel} from '@google/genai';
import {buildSystemInstruction} from './_lib/timeContext.js';
import {
  ALLOWED_MODELS,
  BASE_SYSTEM_INSTRUCTION,
  buildGeminiContents,
  classifyGeminiError,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  getGenAIClient,
  sanitizeIncomingMessages,
} from './_lib/gemini.js';

// Lightweight warmup endpoint so client mount pre-warms this Vercel function before first message
export function GET(): Response {
  const configured = Boolean(getGenAIClient());
  return Response.json(
    {ok: true, configured},
    {headers: {'Cache-Control': 'no-store'}}
  );
}

export async function POST(request: Request): Promise<Response> {
  const ai = getGenAIClient();
  if (!ai) {
    console.error('[Gemini /api/chat] Missing or placeholder GEMINI_API_KEY');
    return Response.json(
      {
        code: 'MISSING_API_KEY',
        error:
          'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Vercel Project Settings > Environment Variables and redeploy.',
      },
      {status: 500}
    );
  }

  let body: {messages?: unknown; model?: unknown};
  try {
    body = (await request.json()) as {messages?: unknown; model?: unknown};
  } catch {
    return Response.json(
      {code: 'INVALID_REQUEST', error: 'Invalid JSON request body.'},
      {status: 400}
    );
  }

  const sanitized = sanitizeIncomingMessages(body?.messages);
  if (sanitized.error) {
    return Response.json(
      {code: sanitized.error.code, error: sanitized.error.message},
      {status: sanitized.error.status}
    );
  }

  const requestedModel =
    typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
      ? body.model
      : DEFAULT_MODEL;

  const contents = buildGeminiContents(sanitized.messages);

  const encoder = new TextEncoder();
  const abortController = new AbortController();

  const onRequestAbort = () => abortController.abort();
  request.signal?.addEventListener('abort', onRequestAbort, {once: true});

  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      // Flush an SSE comment immediately so Vercel/CDN proxies establish the unbuffered stream at once
      controller.enqueue(encoder.encode(': open\n\n'));

      const writeEvent = (payload: Record<string, unknown>) => {
        if (streamClosed || abortController.signal.aborted) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const closeStream = () => {
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
        request.signal?.removeEventListener('abort', onRequestAbort);
      };

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

        const geminiStream = await ai.models.generateContentStream({
          model: modelId,
          contents,
          config,
        });

        for await (const chunk of geminiStream) {
          if (abortController.signal.aborted) break;
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
        if (abortController.signal.aborted) {
          closeStream();
          return;
        }
        const targetModel = modelsToTry[i];

        try {
          await attemptStream(targetModel);
          lastError = null;
          break;
        } catch (err) {
          if (abortController.signal.aborted) {
            closeStream();
            return;
          }
          lastError = err;
          const classified = classifyGeminiError(err);
          console.error(
            `[Gemini /api/chat attempt ${i + 1}/${modelsToTry.length} failed] model=${targetModel} status=${classified.status} code=${classified.code} detail=${classified.detail}`
          );

          if (totalEmitted > 0 || !classified.retryable) {
            break;
          }
        }
      }

      if (abortController.signal.aborted) {
        closeStream();
        return;
      }

      if (lastError) {
        const classified = classifyGeminiError(lastError);
        writeEvent({
          error: classified.message,
          code: classified.code,
          status: classified.status,
        });
        closeStream();
        return;
      }

      if (totalEmitted === 0) {
        console.warn('[Gemini /api/chat] Stream completed with 0 emitted characters');
        writeEvent({
          error: 'Gemini returned an empty response. Please try rephrasing or retrying.',
          code: 'EMPTY_RESPONSE',
          status: 502,
        });
        closeStream();
        return;
      }

      writeEvent({done: true});
      closeStream();
    },
    cancel() {
      abortController.abort();
      request.signal?.removeEventListener('abort', onRequestAbort);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
    },
  });
}
