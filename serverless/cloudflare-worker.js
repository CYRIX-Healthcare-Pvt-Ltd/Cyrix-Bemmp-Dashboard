/**
 * Assistant proxy for the static deployment.
 *
 * GitHub Pages serves files and nothing else, so it cannot hold a key. This is the
 * smallest thing that can: a free Cloudflare Worker that holds the key as a secret
 * and forwards requests. The browser sends a question and gets an answer; the key
 * is never in a response, so it cannot be read out of the page.
 *
 * That distinction is the whole point. Storing a key server-side and letting the
 * page *fetch* it would put it in the network tab of every visitor — identical to
 * publishing it. The key has to stay on the server and the request has to travel
 * to it.
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler init bemmp-assistant --no-deploy
 *   # replace src/index.js with this file, then:
 *   wrangler secret put OPENAI_API_KEY
 *   wrangler deploy
 *
 * Then rebuild the site pointing at it:
 *   VITE_ASSISTANT_URL=https://bemmp-assistant.<subdomain>.workers.dev npm run build:static
 */

const CHAT = 'https://api.openai.com/v1/chat/completions';
const SPEECH = 'https://api.openai.com/v1/audio/speech';

const MODEL = 'gpt-4o-mini';
const TTS_MODEL = 'gpt-4o-mini-tts';

/**
 * Only these origins may call the worker. Without this the endpoint is an open
 * relay: anyone who finds the URL could spend the key on their own traffic.
 */
const ALLOWED_ORIGINS = [
  'https://kevi47.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (!ALLOWED_ORIGINS.includes(origin) && origin !== '') {
      return Response.json({ error: 'origin not allowed' }, { status: 403, headers });
    }

    if (url.pathname.endsWith('/health')) {
      if (!env.OPENAI_API_KEY) {
        return Response.json({ error: 'key not configured' }, { status: 503, headers });
      }
      return Response.json({ ok: true, model: MODEL, tts: true }, { headers });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'use POST' }, { status: 405, headers });
    }
    if (!env.OPENAI_API_KEY) {
      return Response.json({ error: 'key not configured' }, { status: 503, headers });
    }

    const speech = url.pathname.endsWith('/speech');
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400, headers });
    }

    // Pin the model so a caller cannot bill an expensive one to this key.
    body.model = speech ? TTS_MODEL : MODEL;

    const upstream = await fetch(speech ? SPEECH : CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (speech && upstream.ok) {
      return new Response(upstream.body, {
        headers: { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
