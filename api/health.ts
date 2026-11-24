import process from 'node:process';

export function GET(): Response {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const configured = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
  return Response.json({ok: true, configured});
}
