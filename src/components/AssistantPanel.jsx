import { useEffect, useMemo, useRef, useState } from 'react';
import {
  QUERY_TOOL, CHAT_TOOL, datasetContext, runQuery, describeResult, neutralFilters,
} from '../data/assistant.js';
import { RECORD_TOOL, runRecordQuery } from '../data/records.js';
import { formatDay } from '../data/store.js';
import { firstName } from '../data/supabase.js';
import {
  planQuery, probeServer, storedKey, storedModel, DEFAULT_MODEL,
} from '../data/openai.js';
import useSpeech, {
  LANGUAGES, micUnavailableReason, detectLanguage, storedLanguage, storeLanguage,
} from '../hooks/useSpeech.js';
import BarList from './BarList.jsx';

/**
 * A short human lead-in before a figure, picked here rather than by the model.
 *
 * Warmth is the point, but the sentence after it states real numbers, so nothing
 * that touches it can be generated — an invented opener risks an invented figure.
 */
const OPENERS = [
  'Here you go —',
  'Had a look —',
  'Right —',
  'Found it —',
  'Sure thing —',
];
const opener = () => OPENERS[Math.floor(Math.random() * OPENERS.length)];

const HISTORY_KEY = 'bemmp-assistant-history';
const HISTORY_LIMIT = 40;

function loadHistory(stateId) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    // Filtered here as well as on the way in, because the browsers that
    // matter already have the stale ones stored. Cleaning only on save
    // would show each of them exactly once more — to the people who have
    // already seen it and told us about it.
    return Array.isArray(all[stateId]) ? all[stateId].filter((e) => !e.error) : [];
  } catch {
    return [];
  }
}

function saveHistory(stateId, entries) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    /*
     * Failed turns are not kept.
     *
     * An error describes a moment — the server was unreachable, the key
     * was not configured — and that moment is over as soon as the next
     * question works. Stored, it came back every time the panel opened:
     * "No OpenAI key set" sat above two perfectly good answers on a
     * deployment that had been fixed hours earlier, reading as the
     * current state of things rather than a record of a past one.
     *
     * The whole turn goes, question included. Keeping the question and
     * dropping the error would leave a dangling half-turn — something
     * asked, nothing under it — which looks like an answer that failed
     * to render rather than one that was never given.
     */
    all[stateId] = entries.filter((e) => !e.error).slice(-HISTORY_LIMIT);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch { /* storage full or disabled; history is not worth failing over */ }
}

const SUGGESTIONS = [
  'Which district has the highest penalty?',
  'Why is Kannur so bad?',
  'Top 5 equipment by repeat calls',
  'Which engineer has the slowest resolution time?',
  'FTFR by zone this month',
];

/**
 * Flattens a query result into something plain enough to store.
 *
 * The result carries the measure definition, which holds functions — those cannot
 * be serialised, so history would break on reload. This keeps only what the answer
 * card actually draws.
 */
function toView(result, describeRange) {
  return {
    headline: result.headline ? { display: result.headline.display } : null,
    items: result.items.map((it) => ({
      id: it.id, label: it.label, value: it.value, display: it.display, sub: it.sub,
    })),
    measureLabel: result.measure.label,
    colour: result.measure.kind === 'sum' ? 'var(--status-critical)' : 'var(--series-1)',
    dimension: result.spec.dimension,
    // The actual window, always. Cyra answers over the whole contract unless the
    // question names a period, so the footer has to say which period it used —
    // the tiles beside it may well be showing a different one.
    range: describeRange,
    filterLabel: result.appliedFilter?.label ?? null,
    overview: result.overview ?? null,
  };
}

/** One answered question: the spoken or typed prompt, plus its rendered result. */
function Answer({ entry }) {
  if (entry.error) {
    return <div className="chat-error">{entry.error}</div>;
  }

  // A greeting or a capability question: prose, no figures, no chart.
  if (entry.reply) {
    return (
      <div className="chat-answer chat-reply">
        <p className="answer-text">{entry.translated || entry.reply}</p>
      </div>
    );
  }

  /*
   * A record lookup — what the meeting wrote down, or the account trail.
   *
   * Deliberately never `entry.translated`: these rows carry free text somebody
   * typed into a purchasing field, and translation is the one path that would
   * put it in front of the model. The English is what was written; it is shown
   * as written.
   */
  if (entry.record) {
    return (
      <div className="chat-answer">
        <p className="answer-text">{entry.sentence}</p>
        {entry.record.length > 0 && (
          <dl className="answer-record">
            {entry.record.map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="answer-meta">
          <span>From the meeting record · visible to you only</span>
        </div>
      </div>
    );
  }

  const { view, sentence, translated } = entry;

  return (
    <div className="chat-answer">
      {view.headline && (
        <div className="answer-headline">
          <div className="answer-figure">{view.headline.display}</div>
          <div className="answer-measure">{view.measureLabel}</div>
        </div>
      )}

      {/* A summary's figures lead, because that is the whole of the answer —
          the sentence below is the reading of them, not the other way round. */}
      {view.overview && (
        <dl className="answer-overview">
          {view.overview.map((o) => (
            <div key={o.key}>
              <dt>{o.label}</dt>
              <dd>{o.display}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="answer-text">{translated || sentence}</p>

      {view.items.length > 0 && (
        <div className="answer-chart">
          <BarList items={view.items} color={view.colour} />
        </div>
      )}

      <div className="answer-meta">
        <span>
          {view.measureLabel}
          {view.dimension !== 'none' && ` by ${view.dimension}`}
          {view.filterLabel && ` · ${view.filterLabel}`}
          {view.range && ` · ${view.range}`}
        </span>
      </div>
    </div>
  );
}

export default function AssistantPanel({ ds, referenceDay, profile, onClose }) {
  /*
   * The whole contract, not the dashboard's filter bar.
   *
   * She used to answer inside whatever was selected on the page, so the same
   * question gave different figures depending on state nobody was thinking about
   * while typing — and a district left in the panel silently intersected with
   * the district in the question. She narrows from everything now, using only
   * what the question actually says.
   */
  const scope = useMemo(() => neutralFilters(ds), [ds]);

  const [session, setSession] = useState({
    mode: null, apiKey: storedKey(), model: storedModel(), reason: null,
  });
  const [language, setLanguage] = useState(storedLanguage);
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState(() => loadHistory(ds.meta.id));
  const [busy, setBusy] = useState(false);
  const [micNote, setMicNote] = useState(null);
  const micReason = micUnavailableReason();
  const logRef = useRef(null);

  // History is per contract: the figures in an answer only mean anything against
  // the dataset they were computed from.
  useEffect(() => { saveHistory(ds.meta.id, entries); }, [ds.meta.id, entries]);

  const speech = useSpeech(language);

  useEffect(() => {
    probeServer().then((r) => setSession((s) => ({
      ...s,
      mode: r.mode,
      model: r.model || s.model || DEFAULT_MODEL,
      // Why it is off, in the server's own words. Kept so the panel can
      // say which of several setups is incomplete rather than naming one
      // at random.
      reason: r.reason ?? null,
    })));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, busy]);

  // No key entry in the UI: the key belongs on the server, so a deployment without
  // one is unconfigured rather than something a user can fix by pasting a secret.
  const unavailable = session.mode === 'byok' && !session.apiKey;
  const needsKey = unavailable;
  const reason = session.reason;

  async function ask(text) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    /*
     * A question typed in Malayalam sets the panel to Malayalam, without anyone
     * touching the picker.
     *
     * This is the half of "detect the language automatically" that can be done
     * for free and for certain: each of these languages owns its Unicode block,
     * so the script *is* the answer. Speech is the other half and cannot work
     * this way — the Web Speech API is told which language to listen for before
     * it hears anything, so the picker still has to be right before the mic is
     * pressed. Detecting from the transcript is what makes it right for the
     * next question rather than this one.
     */
    const detected = detectLanguage(trimmed);
    if (detected && detected !== language) {
      setLanguage(detected);
      storeLanguage(detected);
    }

    setQuestion('');
    setBusy(true);

    try {
      /*
       * The whole conversation, not the last two exchanges.
       *
       * Four messages was enough for "and for Palakkad?" and nothing more — ask
       * about a district, discuss it for a few turns, then say "compare that to
       * last month" and the district was already forgotten. The thread is what
       * makes it feel like talking to someone, so it lasts until the bin button
       * clears it.
       *
       * It costs little: these are one-line sentences, and `HISTORY_LIMIT` caps
       * the stored conversation at forty turns regardless.
       */
      const history = entries.flatMap((e) => ([
        { role: 'user', content: e.question },
        { role: 'assistant', content: e.sentence || e.reply || e.error || '' },
      ])).filter((m) => m.content);

      const plan = await planQuery({
        question: trimmed,
        context: datasetContext(ds),
        tools: [QUERY_TOOL, CHAT_TOOL, RECORD_TOOL],
        session,
        history,
        /*
         * Who she is talking to: a first name and a role.
         *
         * First name only — "Kevin", not "Kevin R" and not the whole seat. An
         * assistant that says the full name every time sounds like a form letter,
         * and being addressed by an employee code sounds like one too.
         *
         * The account's own name where there is one, falling back to the id they
         * signed in with, which is always there. Nothing else goes: the model has
         * never seen a ticket and does not start now.
         */
        who: profile ? { name: firstName(profile), role: profile.role } : null,
        // Andhra has no rate card, so "penalty" has to stay the call count there
        // — there is no rupee figure to give instead.
        hasRateCard: Boolean(ds.meta.penaltyRates),
      });

      /*
       * Answers are always written in English, whatever language the question was
       * asked in. The dashboard's own labels are English, so an English answer
       * matches the tiles beside it — and the figures never pass through a
       * translation step that could reformat them.
       */
      /*
       * A record lookup. The rows are fetched under this user's own session, so
       * row-level security decides what comes back — and nothing fetched is sent
       * to the model. `sensitive` rides along so the answer can never be handed
       * to the translator, which is the one path that would put free-text
       * purchasing remarks in front of it.
       */
      if (plan.kind === 'record') {
        const found = await runRecordQuery(ds, plan.spec, profile);
        setEntries((prev) => [...prev, {
          question: trimmed,
          sentence: found.sentence,
          record: found.rows,
          sensitive: found.sensitive,
          at: Date.now(),
        }].slice(-HISTORY_LIMIT));
        return;
      }

      if (plan.kind === 'chat') {
        setEntries((prev) => [...prev, {
          question: trimmed, reply: plan.reply, at: Date.now(),
        }].slice(-HISTORY_LIMIT));
        return;
      }

      const result = runQuery(ds, scope, referenceDay, plan.spec);
      const sentence = `${opener()} ${describeResult(ds, result)}`;
      /* Always the real dates. There is no "current filters" to defer to any
         more, and naming the window is what lets somebody check the figure
         against the tiles — which may well be on a different range. */
      const rangeLabel = `${formatDay(result.effective.dayFrom)} – ${formatDay(result.effective.dayTo)}`;

      setEntries((prev) => [...prev, {
        question: trimmed, view: toView(result, rangeLabel), sentence, at: Date.now(),
      }].slice(-HISTORY_LIMIT));
    } catch (err) {
      setEntries((prev) => [...prev, {
        question: trimmed, error: err.message, at: Date.now(),
      }].slice(-HISTORY_LIMIT));
    } finally {
      setBusy(false);
    }
  }

  async function onMic() {
    if (speech.listening) { speech.stop(); return; }
    const heard = await speech.listen();
    if (heard) ask(heard);
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} role="presentation" />
      <aside className="assistant" role="dialog" aria-modal="true" aria-label="Cyra, the dashboard assistant">
        <header className="assistant-head">
          <div className="assistant-id">
            {/* A mark rather than a stock chat bubble. Two arcs, like a signal
                being read — and it takes the page's own blue, so Cyra belongs to
                the dashboard rather than sitting on top of it. */}
            <span className="cyra-mark" aria-hidden="true">
              <svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round">
                <path d="M19.5 8.2a7.5 7.5 0 1 0 0 11.6" />
                <path d="M23 11.5v5" opacity="0.55" />
              </svg>
            </span>
            <div>
              <h2>Cyra</h2>
              <div className="assistant-sub">{ds.meta.name}</div>
            </div>
          </div>
          <div className="drawer-head-right">
            {/* Sets the speech-recognition language only — the engine has to be
                told before it listens, so this cannot be inferred for voice the
                way it is for a typed question. Answers are always written in
                English, to match the dashboard's own labels. */}
            <select
              className="lang-select"
              title="Language you speak in. A typed question sets this by itself. Answers are always in English."
              aria-label="Voice input language"
              value={language}
              onChange={(e) => { setLanguage(e.target.value); storeLanguage(e.target.value); }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            {entries.length > 0 && (
              <button
                type="button" className="icon-btn"
                onClick={() => setEntries([])}
                aria-label="Clear chat history"
                title="Clear chat history"
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                </svg>
              </button>
            )}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>

        {unavailable && (
          <div className="assistant-settings">
            {/*
              Two different setups fail into this same panel, and the old
              wording only described one of them: "set OPENAI_API_KEY in
              .env.local" is true on a laptop and simply false on a
              deployment, where .env.local is gitignored, never uploaded,
              and the key is read from the app_secret table instead. So it
              sent whoever read it to edit a file that could not have
              helped — which is exactly what happened.

              The health endpoint already knows which failure it is and
              says so in its error. Showing that is better than guessing
              on the reader's behalf.
            */}
            <p className="caption">
              The assistant is not switched on here.{' '}
              {reason
                ? <>The server said: <code>{reason}</code></>
                : <>The server did not answer <code>/api/assistant/health</code>.</>}
            </p>
            <p className="caption">
              On a deployment the key lives in the <code>app_secret</code> table, not
              in a file — <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_KEY</code>{' '}
              have to be set on the deployment for it to be read. Running locally, use{' '}
              <code>npm run serve</code> rather than <code>npm run dev</code>: plain Vite
              serves no <code>/api</code> routes, so the assistant cannot work under it
              whatever the key says. See DEPLOY.md.
            </p>
          </div>
        )}

        <div className="assistant-log" ref={logRef}>
          {entries.length === 0 && (
            <div className="assistant-empty">
              <p className="assistant-hello">Hi — I&rsquo;m Cyra.</p>
              <p>
                Ask me anything about {ds.meta.name} in plain language, or tap the mic
                and speak — Malayalam, Tamil, Telugu, Hindi and Kannada all work. I keep
                track of what we&rsquo;ve been discussing, so you can just say
                &ldquo;and last month?&rdquo; and I&rsquo;ll follow.
              </p>
              <p className="caption">
                Every figure is computed here from the loaded data, so nothing I quote
                can disagree with the dashboard behind me.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="suggestion" onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {entries.map((entry, i) => (
            <div className="chat-turn" key={i}>
              <div className="chat-question">{entry.question}</div>
              <Answer entry={entry} />
            </div>
          ))}

          {busy && <div className="chat-thinking"><span /><span /><span /></div>}
        </div>

        <form
          className="assistant-input"
          onSubmit={(e) => { e.preventDefault(); ask(question); }}
        >
          {/* Shown even when unavailable: a missing button reads as a broken build,
              where a disabled one that explains itself does not. */}
          <button
            type="button"
            className={`mic${speech.listening ? ' is-listening' : ''}${micReason ? ' is-blocked' : ''}`}
            onClick={micReason ? () => setMicNote(micReason) : onMic}
            aria-label={speech.listening ? 'Stop listening' : 'Ask by voice'}
            title={micReason ?? 'Ask by voice'}
            disabled={busy}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
              {micReason && <path d="M3 3l18 18" />}
            </svg>
          </button>
          <input
            type="text"
            value={speech.listening ? (speech.interim || 'Listening…') : question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={unavailable
              ? 'Assistant not configured'
              : (needsKey ? 'Add an OpenAI key to begin' : 'Ask Cyra about this contract…')}
            disabled={busy || speech.listening || needsKey}
          />
          <button type="submit" className="ask" disabled={busy || !question.trim() || needsKey}>
            Ask
          </button>
        </form>

        {micNote && <div className="assistant-note">{micNote}</div>}
        {speech.error && <div className="assistant-note">{speech.error}</div>}
      </aside>
    </>
  );
}
