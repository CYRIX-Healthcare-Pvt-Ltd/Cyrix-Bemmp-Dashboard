import { caller, configured, json, readBody, secret } from '../_lib/server.js';

/**
 * Text to speech, returning audio bytes.
 *
 * This exists because Windows ships no voice for Malayalam, Telugu, Tamil or
 * Kannada, and `speechSynthesis` answers that by silently substituting an
 * English voice that reads the script with English phonetics — which sounds like
 * nonsense rather than like a failure. `hasNativeVoice()` in the browser is what
 * routes here instead.
 *
 * Only the already-composed sentence is sent. The figures in it were computed
 * from the typed arrays before anything left the page.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
  if (!configured()) { json(res, 503, { error: 'Assistant is not configured.' }); return; }

  const who = await caller(req);
  if (!who) { json(res, 401, { error: 'Sign in to use the assistant.' }); return; }

  const key = await secret('openai_api_key');
  if (!key) { json(res, 503, { error: 'No OpenAI key configured on this deployment.' }); return; }

  const body = readBody(req);
  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // Model pinned here rather than taken from the body, for the same reason
      // as the chat endpoint: this is the company's key being spent.
      body: JSON.stringify({ ...body, model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts' }),
    });

    if (!upstream.ok) {
      res.status(upstream.status).setHeader('Content-Type', 'application/json');
      res.send(await upstream.text());
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(audio);
  } catch (e) {
    json(res, 502, { error: `Could not reach OpenAI: ${e.message}` });
  }
}
