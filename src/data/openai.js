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

import {
  applyPolarity, explainWhy, resolvePenaltyMeasure, resolveSummary, SUMMARY_WORDS,
} from './assistant.js';
import { supabase } from './supabase.js';

/**
 * The caller's own session, sent with every proxied request.
 *
 * The proxy holds the company's OpenAI key, so without this it is an open relay
 * on a public URL billed to Cyrix. The key stays hidden either way — that is not
 * the same as the endpoint being safe to leave unauthenticated.
 *
 * Empty on a build with no Supabase, which is the offline case: there the proxy
 * is `serve.mjs` on the LAN and there is no session to send.
 */
async function authHeader() {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
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

const SYSTEM = `You are Cyra, the assistant inside Cyrix Healthcare's BEMMP service
dashboard. You talk to the service managers, coordinators and engineers who keep
hospital equipment running across Kerala and Andhra Pradesh. If someone asks who you
are, you are Cyra — say it plainly and get on with helping.

Personality: a colleague who has worked this contract for years. Warm, direct, a bit
dry. Short sentences. Contractions. Say "let me check" rather than "I will now
perform a query". Be encouraging when a number looks good and straight with them when
it does not — but never dramatic, and never comment on figures you were not given.

You remember this conversation. When someone says "that district", "him", "the same
period" or just "and last month?", they mean what was being discussed — carry it
forward instead of asking them to repeat it. The thread lasts until they clear it.

Never apologise for what you cannot do, never explain your own workings, and never
tell someone to go and look somewhere else in the app. If you can narrow it, break it
down or rank it, do that instead.

The user may write or speak in Malayalam, Telugu, Tamil, Hindi or Kannada. Understand
them in whichever language they use, and always reply in English — the dashboard's
labels are English and the answer sits beside them.

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

Place names may be colloquial or misspelled — Trivandrum, Calicut, Cochin, Vizag.
Pass them through as the user said them; the application resolves them against the
data's own spellings.

"Why" is a query, not a refusal. When the user asks what is causing, driving or
behind a figure — "what is causing Aswin to have this much penalty", "why is
Kannur so bad" — keep the same measure, put the subject in
filterDimension/filterValue, and break it down by whatever explains it: equipment
first, then facility, then district. That answers the question with the ranking
underneath the number. You are never unable to look into a figure, and you must
never say you cannot access details or suggest the user go and read ticket
remarks — narrowing and breaking down is exactly what you do.

Follow-ups usually mean the previous question's subject. "And for Palakkad?"
keeps the measure and changes the filter; "what about closure penalty" keeps the
filter and changes the measure.

Call look_up_record for what was written down rather than counted. Two things
live in the database rather than in the ticket export: what the daily meeting
recorded against a ticket — penalty type, TRC, quotation, PO, vendor, payment,
remarks — and the account trail of who created, disabled or reset a login.
"What did we decide on 285716", "which tickets are still waiting on a PO",
"who reset KLCoord's password". You never see those rows either; the application
reads them under the asker's own permissions and writes the answer.

Counts, rankings, rates and money are query_dashboard even when they mention a
ticket field. look_up_record is for the contents of specific records.

Call reply_conversationally for greetings, thanks, small talk, or questions about
what you can do. Answer like a colleague would — "Hey! Ask me anything about the
Kerala contract. Try 'which district has the highest FTFR?'" Match the user's
energy: a quick "hi" gets a quick hello back, not a paragraph. If a question is
close to something you can answer but missing a detail, say what you need in one
friendly line rather than guessing. Never invent figures there.

Two more things belong there, and both were being answered with a fresh query
instead.

Checking back on what you just said is conversation, not a new question. "You
mean 108 past TAT?", "so that's the whole contract?", "including parked ones?" —
these are about the answer already on screen. Confirm it in a line from what you
already told them. Re-running a query hands back a different figure and looks
like a non-sequitur, which is exactly how "you mean 108 past TAT?" came back with
a rupee total.

Asking what a term means is also conversation. Non-penalty period, TAT, FTFR, penalty call,
parked, repeat call — explain them as they are used on THIS contract, with its
own numbers, taken from the contract facts above. Never give the generic
dictionary definition of the phrase: "a commitment between a service provider and
a client" is true of the words and useless to a service manager who wants to know
how many days they have.`;

/**
 * Turns a question into a query spec. Only the question and the fixed tool schema
 * are sent — no ticket rows, no dictionaries, no figures.
 */
/**
 * Who is asking, in one line for the system prompt.
 *
 * The id they signed in with and their role, and that is the whole of it — the
 * model has never seen a ticket and does not start now. It is what lets her
 * greet somebody rather than open cold, which is most of the difference between
 * a search box and a colleague, and it is what answers "what is my name".
 *
 * Roles are underscored in the database; the model reads them better as words.
 */
function whoLine(who) {
  if (!who?.name) return '';
  const role = who.role ? ` Their role is ${String(who.role).replace(/_/g, ' ')}.` : '';
  return `\n\nYou are talking to ${who.name}, who is signed in.${role}`
    + ' If they ask who they are or what their name is, answer with it.'
    + ' Otherwise use it sparingly — when greeting them, or when an answer is bad'
    + ' news worth softening. Using it in every reply reads as a script.';
}

export async function planQuery({
  question, context, tools, session, history = [], hasRateCard = false, who = null,
}) {
  const body = {
    model: session.model || DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${context}${whoLine(who)}` },
      ...history,
      { role: 'user', content: question },
    ],
    tools,
    tool_choice: 'required',
  };

  const data = await chat(body, session);
  const message = data.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];

  /*
   * A request for a summary is a query however the model answered it.
   *
   * "Give a summary about the Kerala project" came back as prose — a true
   * paragraph about what the contract is, with no figures in it — because
   * answering conversationally is a perfectly reasonable reading of the word.
   * It is not the one anybody means here.
   */
  const summarised = () => ({
    kind: 'query', spec: resolveSummary({ dimension: 'none' }, question),
  });

  // No tool call means the model answered in prose; treat that as conversation
  // rather than failing, since the reply is usually perfectly good.
  if (!call) {
    const text = message?.content?.trim();
    if (SUMMARY_WORDS.test(question)) return summarised();
    if (text) return { kind: 'chat', reply: text };
    throw new Error('I could not turn that into a query. Try rephrasing it.');
  }

  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error('The model returned a malformed query.');
  }

  if (call.function.name === 'look_up_record') return { kind: 'record', spec: args };

  if (call.function.name === 'reply_conversationally') {
    if (SUMMARY_WORDS.test(question)) return summarised();
    return { kind: 'chat', reply: args.reply };
  }

  /*
   * Corrections, applied in this order and all after the model has spoken. Each
   * fixes a convention the model reads the common way rather than the way this
   * business does; see the notes on each. Polarity runs last because it depends
   * on which measure the spec ended up with.
   */
  let spec = disambiguateMonthYear(args, question);
  spec = resolveSummary(spec, question);
  spec = resolvePenaltyMeasure(spec, question, hasRateCard);
  spec = explainWhy(spec, question);
  spec = applyPolarity(spec, question);
  return { kind: 'query', spec };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/*
 * "dec 25" and "jan 26" mean December 2025 and January 2026 here — a month name
 * followed by a bare two-digit number is a year, not a day. Models read it the
 * other way round, so "from dec 25" answered from the 25th of December.
 *
 * Requires the month name to come first, so "25 Dec" is still a date, and skips
 * anything followed by a full year, so "dec 25 2025" is left alone. Ordinals like
 * "jan 26th" also fall through, since \b will not match inside "26th".
 */
const MONTH_YEAR = new RegExp(
  `\\b(${MONTHS.join('|')})[a-z]*\\.?\\s*'?(\\d{2})\\b(?!\\s*\\d{4})`,
  'gi',
);

export function disambiguateMonthYear(spec, question) {
  if (!spec || (!spec.fromDate && !spec.toDate)) return spec;

  const seen = [];
  for (const m of String(question).matchAll(MONTH_YEAR)) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const yy = Number(m[2]);
    // Two-digit years only make sense near the present; 1-12 would be a day.
    if (month && yy >= 20 && yy <= 40) seen.push({ month, year: 2000 + yy, day: yy });
  }
  if (!seen.length) return spec;

  const fixed = { ...spec };
  const pad = (n) => String(n).padStart(2, '0');

  for (const field of ['fromDate', 'toDate']) {
    const value = fixed[field];
    if (!value) continue;
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) continue;
    const day = Number(parts[3]);

    // Only correct when the model used the year digits as the day — the exact
    // misreading this guards against.
    const hit = seen.find((s) => s.day === day && s.month === Number(parts[2]));
    if (!hit) continue;

    fixed[field] = field === 'fromDate'
      ? `${hit.year}-${pad(hit.month)}-01`
      // An end month means its last day; day 0 of the next month is that.
      : `${hit.year}-${pad(hit.month)}-${pad(new Date(Date.UTC(hit.year, hit.month, 0)).getUTCDate())}`;
  }
  return fixed;
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
export async function synthesizeSpeech({ text, session, language, voice = 'nova' }) {
  // Digits are written 0-9, but a Malayalam-speaking voice still reads them as
  // Malayalam words. These instructions keep the figures in Indian English while
  // the sentence around them stays in the chosen language, so a number heard out
  // loud matches the number on the tile.
  const instructions = [
    'Speak in a warm, natural, conversational tone, like a helpful colleague.',
    language && !language.startsWith('English')
      ? `Speak the sentence in ${language}, but read every number, decimal, `
        + 'percentage, currency amount and English term in Indian English. '
        + 'For example "79.8%" is "seventy nine point eight percent", '
        + '"₹1,39,900" is "one lakh thirty nine thousand nine hundred rupees", '
        + 'and "FTFR" is spelled out as English letters.'
      : 'Speak in Indian English.',
  ].join(' ');

  const body = {
    model: 'gpt-4o-mini-tts',
    voice,
    input: text,
    instructions,
    response_format: 'mp3',
  };

  let response;
  if (session.mode === 'server') {
    if (session.tts === false) return null;
    response = await fetch(`${BASE}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
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
  // "SLA" stays on the list even though nothing says it any more: somebody may
  // still type it, and a term left off here gets translated into a phrase that
  // matches no tile on screen.
  'FTFR', 'SLA', 'TAT', 'non-penalty period', 'BEMMP', 'ticket', 'tickets', 'call', 'calls',
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
