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
    const r = await fetch('api/assistant/health', { cache: 'no-store' });
    if (!r.ok) return { mode: 'byok', model: null };
    const body = await r.json();
    return { mode: 'server', model: body.model || DEFAULT_MODEL };
  } catch {
    return { mode: 'byok', model: null };
  }
}

/** One chat-completions round trip, via whichever mode is active. */
async function chat(body, { mode, apiKey }) {
  if (mode === 'server') {
    const r = await fetch('api/assistant', {
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
