/**
 * Assistant proxy, deployed straight from this GitHub repository.
 *
 * Netlify builds the site from the repo and runs this function beside it, so the
 * whole thing is "in GitHub" — except the key, which is set once in the Netlify
 * dashboard and lives only in the function's environment. The browser posts a
 * question here and gets an answer; the key is never in a response, so it cannot
 * be read out of the page and GitHub's secret scanner has nothing to find.
 *
 * Setup, all in a browser, about five minutes:
 *   1. netlify.com → Add new site → Import an existing project → pick this repo
 *   2. Build command `npm run build:static`, publish directory `dist`
 *   3. Site configuration → Environment variables → add OPENAI_API_KEY
 *   4. Deploy
 *
 * No VITE_ASSISTANT_URL is needed: the function sits on the same origin as the
 * site, which is where the app already looks.
 */

const CHAT = 'https://api.openai.com/v1/chat/completions';
const SPEECH = 'https://api.openai.com/v1/audio/speech';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';

export default async (request) => {
  const key = process.env.OPENAI_API_KEY;
  const url = new URL(request.url);

  if (url.pathname.endsWith('/health')) {
    if (!key) {
      return Response.json({ error: 'OPENAI_API_KEY not set' }, { status: 503 });
    }
    return Response.json({ ok: true, model: MODEL, tts: true });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'use POST' }, { status: 405 });
  }
  if (!key) {
    return Response.json({ error: 'OPENAI_API_KEY not set' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Pin the model so a caller cannot bill an expensive one to this key.
  const speech = url.pathname.endsWith('/speech');
  body.model = speech ? TTS_MODEL : MODEL;

  const upstream = await fetch(speech ? SPEECH : CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (speech && upstream.ok) {
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

// Serves the three paths the app calls, on the site's own origin.
export const config = {
  path: ['/api/assistant', '/api/assistant/health', '/api/assistant/speech'],
};
