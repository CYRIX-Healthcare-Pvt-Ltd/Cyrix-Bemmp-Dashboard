/**
 * OpenAI access, in one of two modes.
 *
 * `server`  — a key lives in the server process (OPENAI_API_KEY) and the browser
 *             talks to /api/assistant. The key never reaches the client. This is
 *             the mode to use for a shared company key.
 * `byok`    — no server, so each user supplies their own key, held in their own
 *             localStorage. Needed on a static host like GitHub Pages.
 *
 * There is deliberately no third mode where a key is compiled into the bundle.
 * A static site cannot keep a secret: anything shipped to the browser is readable
 * in the network tab by every visitor, so a shared key published that way is a
 * shared key given away.
 */

const KEY_STORAGE = 'bemmp-openai-key';
const MODEL_STORAGE = 'bemmp-openai-model';
export const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Where the proxy lives.
 *
 * Defaults to this origin, which is right when serve.mjs is hosting. A static
 * deployment has no server of its own, so it is built with VITE_ASSISTANT_URL
 * pointing at a small function elsewhere — see serverless/ — and then nobody has
 * to enter a key either.
 */
const BASE = (import.meta.env?.VITE_ASSISTANT_URL || 'api/assistant').replace(/\/+$/, '');

export function storedKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}
export function storeKey(key) {
  if (key) localStorage.setItem(KEY_STORAGE, key.trim());
  else localStorage.removeItem(KEY_STORAGE);
}
export function storedModel() {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}
export function storeModel(model) {
  localStorage.setItem(MODEL_STORAGE, model || DEFAULT_MODEL);
}

/** Is a server-side key configured? Decides whether the user is asked for one. */
export async function probeServer() {
  try {
    const r = await fetch(`${BASE}/health`, { cache: 'no-store' });
    if (!r.ok) return { mode: 'byok', model: null, tts: false };
    const body = await r.json();
    return { mode: 'server', model: body.model || DEFAULT_MODEL, tts: body.tts !== false };
  } catch {
    return { mode: 'byok', model: null, tts: false };
  }
}

/** One chat-completions round trip, via whichever mode is active. */
async function chat(body, { mode, apiKey }) {
  if (mode === 'server') {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    return r.json();
  }

  if (!apiKey) throw new Error('No OpenAI key set. Add one in the assistant settings.');

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
  return r.json();
}

async function readError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch { /* non-JSON error body */ }

  if (response.status === 401) return 'OpenAI rejected the key (401). Check it is current.';
  if (response.status === 429) return 'OpenAI rate limit or quota exceeded (429).';
  return detail || `OpenAI request failed (${response.status}).`;
}

const SYSTEM = `You translate questions about a biomedical equipment service dashboard
into a single query_dashboard call. You never see the underlying data and must not
guess or state any figures — the application computes them. Choose the measure and
dimension that best answer the question. If the user names a district, facility,
equipment type, manufacturer or engineer, put it in filterDimension/filterValue.
"Best"/"top" for a rate means order desc; for resolution time, lower is better so
"best" means order asc. If the user gives no period, use range "current".`;

/**
 * Turns a question into a query spec. Only the question and the fixed tool schema
 * are sent — no ticket rows, no dictionaries, no figures.
 */
export async function planQuery({ question, context, tool, session, history = [] }) {
  const body = {
    model: session.model || DEFAULT_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${context}` },
      ...history,
      { role: 'user', content: question },
    ],
    tools: [tool],
    tool_choice: { type: 'function', function: { name: tool.function.name } },
  };

  const data = await chat(body, session);
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('I could not turn that into a query. Try rephrasing it.');

  try {
    return JSON.parse(call.function.arguments);
  } catch {
    throw new Error('The model returned a malformed query.');
  }
}

/**
 * Speech from OpenAI rather than the browser.
 *
 * The Web Speech engine can only speak a language it has a voice installed for.
 * Windows ships none for Malayalam, Telugu, Tamil or Kannada, so it falls back to
 * an English voice and reads the script with English phonetics — the "English
 * tone" problem. This model is genuinely multilingual and pronounces the text as
 * the language it is written in.
 *
 * Returns an object URL for an audio clip, or null if speech is unavailable, in
 * which case the caller falls back to the browser engine.
 */
export async function synthesizeSpeech({ text, session, voice = 'nova' }) {
  const body = { model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3' };

  let response;
  if (session.mode === 'server') {
    if (session.tts === false) return null;
    response = await fetch(`${BASE}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    if (!session.apiKey) return null;
    response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  if (!response.ok) return null; // fall back to the browser voice
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Translates one already-computed sentence. Only the sentence travels, so the
 * figures in it are the app's own — translation cannot change them.
 */
export async function translateSentence({ text, language, session }) {
  if (!language || language.startsWith('en')) return text;

  const body = {
    model: session.model || DEFAULT_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Translate the user's sentence into ${language}. Keep all numbers, `
          + 'percentages, currency amounts and proper nouns exactly as written. '
          + 'Reply with the translation only.',
      },
      { role: 'user', content: text },
    ],
  };

  const data = await chat(body, session);
  return data.choices?.[0]?.message?.content?.trim() || text;
}
