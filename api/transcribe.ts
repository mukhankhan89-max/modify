import {
  classifyGeminiError,
  getGenAIClient,
  MAX_AUDIO_BASE64_CHARS,
  normalizeAudioMimeType,
  transcribeAudioWithGemini,
} from './_lib/gemini.js';

export async function POST(request: Request): Promise<Response> {
  const ai = getGenAIClient();
  if (!ai) {
    console.error('[Gemini /api/transcribe] Missing or placeholder GEMINI_API_KEY');
    return Response.json(
      {
        code: 'MISSING_API_KEY',
        error: 'GEMINI_API_KEY is not configured on the server.',
      },
      {status: 500}
    );
  }

  let body: {audio?: unknown; mimeType?: unknown; language?: unknown};
  try {
    body = (await request.json()) as {
      audio?: unknown;
      mimeType?: unknown;
      language?: unknown;
    };
  } catch {
    return Response.json(
      {code: 'INVALID_REQUEST', error: 'Invalid JSON request body.'},
      {status: 400}
    );
  }

  const normalizedMime = normalizeAudioMimeType(body?.mimeType);
  if (!normalizedMime) {
    return Response.json(
      {
        code: 'UNSUPPORTED_AUDIO_FORMAT',
        error: 'Unsupported audio format for transcription.',
      },
      {status: 400}
    );
  }

  const rawAudio = typeof body?.audio === 'string' ? body.audio.trim() : '';
  const cleanBase64 = rawAudio.includes(',') ? rawAudio.split(',')[1] ?? '' : rawAudio;
  if (!cleanBase64) {
    return Response.json(
      {code: 'EMPTY_AUDIO', error: 'Recorded audio is empty.'},
      {status: 400}
    );
  }

  if (cleanBase64.length > MAX_AUDIO_BASE64_CHARS) {
    return Response.json(
      {code: 'AUDIO_TOO_LARGE', error: 'Audio recording is too long. Please keep clips concise.'},
      {status: 413}
    );
  }

  const language = typeof body?.language === 'string' ? body.language : 'en-US';

  try {
    const text = await transcribeAudioWithGemini(ai, {
      audioBase64: cleanBase64,
      mimeType: normalizedMime,
      language,
    });
    return Response.json({text}, {headers: {'Cache-Control': 'no-store'}});
  } catch (err) {
    const classified = classifyGeminiError(err);
    console.error(
      `[Gemini /api/transcribe failed] status=${classified.status} code=${classified.code} detail=${classified.detail}`
    );
    return Response.json(
      {code: classified.code, error: classified.message},
      {status: classified.status}
    );
  }
}
