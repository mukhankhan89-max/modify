import {
  classifyGeminiError,
  generateSpeechWithGemini,
  getGenAIClient,
} from './_lib/gemini.js';

export async function POST(request: Request): Promise<Response> {
  const ai = getGenAIClient();
  if (!ai) {
    console.error('[Gemini /api/tts] Missing or placeholder GEMINI_API_KEY');
    return Response.json(
      {
        code: 'MISSING_API_KEY',
        error: 'GEMINI_API_KEY is not configured on the server.',
      },
      {status: 500}
    );
  }

  let body: {text?: unknown; voiceName?: unknown};
  try {
    body = (await request.json()) as {text?: unknown; voiceName?: unknown};
  } catch {
    return Response.json(
      {code: 'INVALID_REQUEST', error: 'Invalid JSON request body.'},
      {status: 400}
    );
  }

  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return Response.json(
      {code: 'INVALID_REQUEST', error: 'Text is required for speech synthesis.'},
      {status: 400}
    );
  }

  const voiceName = typeof body?.voiceName === 'string' ? body.voiceName : undefined;

  try {
    const result = await generateSpeechWithGemini(ai, {text, voiceName});
    return Response.json(result, {headers: {'Cache-Control': 'no-store'}});
  } catch (err) {
    const classified = classifyGeminiError(err);
    console.error(
      `[Gemini /api/tts failed] status=${classified.status} code=${classified.code} detail=${classified.detail}`
    );
    return Response.json(
      {code: classified.code, error: classified.message},
      {status: classified.status}
    );
  }
}
