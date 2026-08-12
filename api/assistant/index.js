import { caller, configured, json, readBody, secret } from '../_lib/server.js';

const ALLOWED_MODELS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']);

/**
 * One chat-completions round trip, with the key held here.
 *
 * A signed-in session is required. Without that check this endpoint is a public
 * OpenAI relay on a guessable URL, billed to the company — the fact that the key
 * is hidden from the browser does not matter if anyone can spend it.
 *
 * The model is pinned to a short list rather than passed through: the request
 * body arrives from the browser, and "whatever model the client asked for" is
 * how a cheap endpoint becomes an expensive one.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
  if (!configured()) { json(res, 503, { error: 'Assistant is not configured.' }); return; }

  const who = await caller(req);
  if (!who) { json(res, 401, { error: 'Sign in to use the assistant.' }); return; }

  const key = await secret('openai_api_key');
  if (!key) { json(res, 503, { error: 'No OpenAI key configured on this deployment.' }); return; }

  const body = readBody(req);
  const model = ALLOWED_MODELS.has(body.model)
    ? body.model
    : (process.env.OPENAI_MODEL || 'gpt-4o-mini');

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model }),
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    // Passed through verbatim on success; on failure OpenAI's own message is
    // the useful one, and it never contains the key.
    res.send(text);
  } catch (e) {
    json(res, 502, { error: `Could not reach OpenAI: ${e.message}` });
  }
}
