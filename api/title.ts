import process from 'node:process';
import {GoogleGenAI} from '@google/genai';

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getGenAIClient();

  let body: {message?: unknown};
  try {
    body = (await request.json()) as {message?: unknown};
  } catch {
    return Response.json({error: 'Invalid JSON request body.'}, {status: 400});
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return Response.json({error: 'Message is required.'}, {status: 400});
  }

  if (!ai) {
    return Response.json({title: ''});
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
    return Response.json({title: rawTitle});
  } catch (err) {
    console.warn('[Gemini /api/title fallback]', err);
    return Response.json({title: ''});
  }
}
