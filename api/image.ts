import {
  generateFreeImage,
  ImageGenerationError,
  normalizeImageRequest,
} from './_lib/imageGen.js';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {code: 'INVALID_REQUEST', error: 'Invalid JSON request body.'},
      {status: 400}
    );
  }

  const normalized = normalizeImageRequest(body);
  if (normalized.error || !normalized.req) {
    return Response.json(
      {
        code: 'INVALID_REQUEST',
        error: normalized.error || 'Invalid image prompt.',
      },
      {status: 400}
    );
  }

  try {
    const result = await generateFreeImage(normalized.req, request.signal);
    return Response.json(result, {
      headers: {'Cache-Control': 'no-store'},
    });
  } catch (err) {
    if (err instanceof ImageGenerationError) {
      return Response.json(
        {
          code: err.code,
          error: err.message,
          ...(err.fallbackClientUrl
            ? {fallbackClientUrl: err.fallbackClientUrl}
            : {}),
        },
        {status: err.status, headers: {'Cache-Control': 'no-store'}}
      );
    }
    console.error('[Gemini /api/image unexpected error]', err);
    return Response.json(
      {
        code: 'IMAGE_GENERATION_FAILED',
        error: 'Unable to generate image right now. Please try again.',
      },
      {status: 500}
    );
  }
}
