import { useEffect, useRef, useState } from 'react';
import {
  QUERY_TOOL, CHAT_TOOL, datasetContext, runQuery, describeResult,
} from '../data/assistant.js';
import { formatDay } from '../data/store.js';
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
    return Array.isArray(all[stateId]) ? all[stateId] : [];
  } catch {
    return [];
  }
}

function saveHistory(stateId, entries) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    all[stateId] = entries.slice(-HISTORY_LIMIT);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch { /* storage full or disabled; history is not worth failing over */ }
}

const SUGGESTIONS = [
  'Which district has the highest FTFR?',
  'Top 5 equipment by repeat calls',
  'Which engineer has the slowest resolution time?',
  'How many penalty calls are open right now?',
  'Per-day penalty by district',
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
    // The actual window, not the preset name. A question answered for explicit
    // dates used to still read "current filters" in the footer, contradicting the
    // sentence right above it.
    range: describeRange,
    filterLabel: result.appliedFilter?.label ?? null,
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

  const { view, sentence, translated } = entry;

  return (
    <div className="chat-answer">
      {view.headline && (
        <div className="answer-headline">
          <div className="answer-figure">{view.headline.display}</div>
          <div className="answer-measure">{view.measureLabel}</div>
        </div>
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

export default function AssistantPanel({ ds, filters, referenceDay, onClose }) {
  const [session, setSession] = useState({ mode: null, apiKey: storedKey(), model: storedModel() });
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
    })));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, busy]);

  // No key entry in the UI: the key belongs on the server, so a deployment without
  // one is unconfigured rather than something a user can fix by pasting a secret.
  const unavailable = session.mode === 'byok' && !session.apiKey;
  const needsKey = unavailable;

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
      // Recent turns give the model enough thread to handle "and for Palakkad?"
      // without re-reading the whole conversation.
      const history = entries.slice(-4).flatMap((e) => ([
        { role: 'user', content: e.question },
        { role: 'assistant', content: e.sentence || e.reply || e.error || '' },
      ]));

      const plan = await planQuery({
        question: trimmed,
        context: datasetContext(ds, filters),
        tools: [QUERY_TOOL, CHAT_TOOL],
        session,
        history,
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
      if (plan.kind === 'chat') {
        setEntries((prev) => [...prev, {
          question: trimmed, reply: plan.reply, at: Date.now(),
        }].slice(-HISTORY_LIMIT));
        return;
      }

      const result = runQuery(ds, filters, referenceDay, plan.spec);
      const sentence = `${opener()} ${describeResult(ds, result)}`;
      const movedWindow = result.effective.dayFrom !== filters.dayFrom
        || result.effective.dayTo !== filters.dayTo;
      const rangeLabel = movedWindow
        ? `${formatDay(result.effective.dayFrom)} – ${formatDay(result.effective.dayTo)}`
        : 'current filters';

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
      <aside className="assistant" role="dialog" aria-modal="true" aria-label="Ask the data">
        <header className="assistant-head">
          <div>
            <div className="drawer-eyebrow">Assistant</div>
            <h2>Ask the data</h2>
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
            <p className="caption">
              The assistant is not configured on this deployment. Set{' '}
              <code>OPENAI_API_KEY</code> in <code>.env.local</code> and restart the
              server, or point the build at a proxy — see DEPLOY.md.
            </p>
          </div>
        )}

        <div className="assistant-log" ref={logRef}>
          {entries.length === 0 && (
            <div className="assistant-empty">
              <p>
                Ask about {ds.meta.name} in plain language, or tap the mic and speak —
                Malayalam and the other languages in the picker all work. Answers come
                back in English, computed here from the loaded data.
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
              : (needsKey ? 'Add an OpenAI key to begin' : 'Ask about this contract…')}
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
