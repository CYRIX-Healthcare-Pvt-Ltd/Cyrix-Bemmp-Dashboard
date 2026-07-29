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

const SYSTEM = `You are the assistant inside a biomedical equipment service dashboard,
talking to service managers at Cyrix Healthcare. You are warm and brief.

Every turn you call exactly one tool.

Call query_dashboard when the user wants a figure from the data. You never see the
underlying data and must not guess or state any figures — the application computes
them. Choose the measure and dimension that best answer the question. If the user
names a district, facility, equipment type, manufacturer or engineer, put it in
filterDimension/filterValue. "Best"/"top" for a rate means order desc; for resolution
time, lower is better so "best" means order asc. If the user gives no period, use
range "current". Even when the question asks for a single winner ("which district has
the highest…"), return limit 5 or more so the answer shows the ranking around it.
Only use a small limit if the user explicitly asks for one result.

Call reply_conversationally for greetings, thanks, small talk, or questions about
what you can do. Answer like a colleague would — "Hello! Ask me anything about the
Kerala contract, for example which district has the highest FTFR." Never invent
figures there.`;

/**
 * Turns a question into a query spec. Only the question and the fixed tool schema
 * are sent — no ticket rows, no dictionaries, no figures.
 */
export async function planQuery({ question, context, tools, session, history = [] }) {
  const body = {
    model: session.model || DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${context}` },
      ...history,
      { role: 'user', content: question },
    ],
    tools,
    tool_choice: 'required',
  };

  const data = await chat(body, session);
  const message = data.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];

  // No tool call means the model answered in prose; treat that as conversation
  // rather than failing, since the reply is usually perfectly good.
  if (!call) {
    const text = message?.content?.trim();
    if (text) return { kind: 'chat', reply: text };
    throw new Error('I could not turn that into a query. Try rephrasing it.');
  }

  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error('The model returned a malformed query.');
  }

  return call.function.name === 'reply_conversationally'
    ? { kind: 'chat', reply: args.reply }
    : { kind: 'query', spec: args };
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
 * Terms that stay in English inside a translated sentence.
 *
 * These are what the dashboard's own labels say, and what staff use on the phone.
 * Translating "penalty call" into Malayalam produces a phrase nobody uses and that
 * matches no tile on screen, so the sentence stops agreeing with the UI beside it.
 */
const GLOSSARY = [
  'FTFR', 'SLA', 'BEMMP', 'ticket', 'tickets', 'call', 'calls',
  'open call', 'open calls', 'unresolved call', 'unresolved calls',
  'repeat call', 'repeat calls', 'repeated call', 'repeated calls',
  'penalty', 'penalty call', 'penalty calls',
  'per-day penalty', 'closure penalty', 'resolution time',
  'district', 'facility', 'equipment', 'manufacturer', 'engineer', 'department',
];

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
        content: `Translate the user's sentence into ${language}.\n\n`
          + 'Rules, in order of importance:\n'
          + '1. Every digit stays a Western Arabic numeral (0-9). Never write numbers '
          + 'as words and never convert them to Malayalam, Telugu, Tamil, Kannada or '
          + 'Devanagari digits. "79.8" stays "79.8", "1,39,900" stays "1,39,900".\n'
          + '2. Keep the symbols % and ₹ and the letter "d" for days exactly as they '
          + 'appear, attached to their number.\n'
          + '3. Do NOT translate these terms. Copy them verbatim in English, keeping '
          + `their exact capitalisation: ${GLOSSARY.join(', ')}.\n`
          + '4. Do NOT translate proper nouns — district, facility, equipment, '
          + 'manufacturer and engineer names stay in Latin script exactly as written.\n'
          + '5. Translate only the connecting words between them.\n\n'
          + 'Example for Malayalam — input: "Pathanamthitta has the highest FTFR at '
          + '79.8%. Top 5 of 14 districts." Output: "Pathanamthitta-യ്ക്കാണ് ഏറ്റവും '
          + 'ഉയർന്ന FTFR, 79.8%. 14 districts-ൽ ആദ്യ 5."\n\n'
          + 'Reply with the translation only.',
      },
      { role: 'user', content: text },
    ],
  };

  const data = await chat(body, session);
  return normalizeDigits(data.choices?.[0]?.message?.content?.trim() || text);
}

/**
 * Forces every digit back to 0-9.
 *
 * The prompt asks for this, but a prompt is a request and figures are the point of
 * the answer — a Malayalam ൭൯.൮% beside a chart reading 79.8% is a defect. Each
 * Indic script keeps its ten digits in one contiguous block starting at its own
 * base, so the mapping is arithmetic.
 */
const DIGIT_BASES = [
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
];

export function normalizeDigits(text) {
  if (!text) return text;
  return text.replace(/[०-९০-৯௦-௯౦-౯೦-೯൦-൯]/g,
    (ch) => {
      const code = ch.codePointAt(0);
      const base = DIGIT_BASES.find((b) => code >= b && code <= b + 9);
      return base ? String(code - base) : ch;
    });
}
