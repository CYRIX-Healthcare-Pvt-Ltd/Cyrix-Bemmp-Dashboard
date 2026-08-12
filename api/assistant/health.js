import { configured, json, secret } from '../_lib/server.js';

/**
 * Whether this deployment has a key of its own.
 *
 * The browser asks this on load to decide between talking to the proxy and
 * asking the user for their own key. Deliberately unauthenticated and
 * deliberately thin: it answers yes or no and never the key itself.
 */
export default async function handler(req, res) {
  if (!configured()) {
    json(res, 503, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are not set on this deployment.' });
    return;
  }
  try {
    const key = await secret('openai_api_key');
    if (!key) { json(res, 503, { error: 'No openai_api_key row in app_secret.' }); return; }
    json(res, 200, { ok: true, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', tts: true });
  } catch (e) {
    json(res, 503, { error: e.message });
  }
}
