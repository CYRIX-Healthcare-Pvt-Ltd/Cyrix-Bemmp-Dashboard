import { useEffect, useRef, useState } from 'react';
import {
  QUERY_TOOL, datasetContext, runQuery, describeResult, MEASURES,
} from '../data/assistant.js';
import {
  planQuery, translateSentence, probeServer, storedKey, storeKey,
  storedModel, DEFAULT_MODEL,
} from '../data/openai.js';
import useSpeech, {
  LANGUAGES, STATE_LANGUAGE, speak, stopSpeaking, synthesisSupported,
} from '../hooks/useSpeech.js';
import BarList from './BarList.jsx';

const SUGGESTIONS = [
  'Which district has the highest FTFR?',
  'Top 5 equipment by repeat calls',
  'Which engineer has the slowest resolution time?',
  'How many penalty calls are open right now?',
  'Per-day penalty by district',
];

/** One answered question: the spoken/typed prompt plus its rendered result. */
function Answer({ entry, onDrill }) {
  if (entry.error) {
    return <div className="chat-error">{entry.error}</div>;
  }

  const { result, sentence, translated } = entry;
  const colour = result.measure.kind === 'sum'
    ? 'var(--status-critical)'
    : 'var(--series-1)';

  return (
    <div className="chat-answer">
      {result.headline && (
        <div className="answer-headline">
          <div className="answer-figure">{result.headline.display}</div>
          <div className="answer-measure">{result.measure.label}</div>
        </div>
      )}

      <p className="answer-text">{translated || sentence}</p>
      {translated && <p className="answer-original">{sentence}</p>}

      {result.items.length > 0 && (
        <div className="answer-chart">
          <BarList
            items={result.items}
            color={colour}
            onSelect={onDrill ? (item) => onDrill(result, item) : undefined}
          />
        </div>
      )}

      <div className="answer-meta">
        {result.measure.label}
        {result.spec.dimension !== 'none' && ` by ${result.spec.dimension}`}
        {result.appliedFilter && ` · ${result.appliedFilter.label}`}
        {` · ${result.spec.range === 'current' ? 'current filters' : result.spec.range}`}
      </div>
    </div>
  );
}

export default function AssistantPanel({ ds, filters, referenceDay, onClose, onDrill }) {
  const [session, setSession] = useState({ mode: null, apiKey: storedKey(), model: storedModel() });
  const [language, setLanguage] = useState(() => STATE_LANGUAGE[ds.meta.id] || 'en-IN');
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState(storedKey());
  const logRef = useRef(null);

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

  const needsKey = session.mode === 'byok' && !session.apiKey;

  async function ask(text) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setQuestion('');
    setBusy(true);
    stopSpeaking();

    try {
      const spec = await planQuery({
        question: trimmed,
        context: datasetContext(ds, filters),
        tool: QUERY_TOOL,
        session,
      });

      const result = runQuery(ds, filters, referenceDay, spec);
      const sentence = describeResult(ds, result);

      let translated = null;
      if (!language.startsWith('en')) {
        const name = LANGUAGES.find((l) => l.code === language)?.name;
        translated = await translateSentence({ text: sentence, language: name, session });
      }

      setEntries((prev) => [...prev, { question: trimmed, result, sentence, translated }]);
      speak(translated || sentence, language);
    } catch (err) {
      setEntries((prev) => [...prev, { question: trimmed, error: err.message }]);
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
            <select
              className="lang-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Answer language"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <button
              type="button" className="icon-btn"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Assistant settings"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
              </svg>
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>

        {(showSettings || needsKey) && (
          <div className="assistant-settings">
            {session.mode === 'server' ? (
              <p className="caption">
                Using the key configured on the server. Nothing is stored in your browser.
              </p>
            ) : (
              <>
                <label htmlFor="oa-key">Your OpenAI API key</label>
                <div className="key-row">
                  <input
                    id="oa-key" type="password" placeholder="sk-…"
                    value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
                  />
                  <button
                    type="button" className="reset"
                    onClick={() => { storeKey(keyDraft); setSession((s) => ({ ...s, apiKey: keyDraft.trim() })); setShowSettings(false); }}
                  >
                    Save
                  </button>
                </div>
                <p className="caption">
                  Held only in this browser&apos;s local storage and sent straight to OpenAI.
                  This site has no server to hold a shared key. Your question and the query
                  schema are all that leave the page — no ticket data, names or numbers.
                </p>
              </>
            )}
          </div>
        )}

        <div className="assistant-log" ref={logRef}>
          {entries.length === 0 && (
            <div className="assistant-empty">
              <p>
                Ask about {ds.meta.name} in plain language, or tap the mic. Answers are
                computed here from the loaded data — the model only interprets the question.
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
              <Answer entry={entry} onDrill={onDrill} />
            </div>
          ))}

          {busy && <div className="chat-thinking"><span /><span /><span /></div>}
        </div>

        <form
          className="assistant-input"
          onSubmit={(e) => { e.preventDefault(); ask(question); }}
        >
          {speech.supported && (
            <button
              type="button"
              className={`mic${speech.listening ? ' is-listening' : ''}`}
              onClick={onMic}
              aria-label={speech.listening ? 'Stop listening' : 'Ask by voice'}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
              </svg>
            </button>
          )}
          <input
            type="text"
            value={speech.listening ? (speech.interim || 'Listening…') : question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={needsKey ? 'Add an OpenAI key to begin' : 'Ask about this contract…'}
            disabled={busy || speech.listening || needsKey}
          />
          <button type="submit" className="ask" disabled={busy || !question.trim() || needsKey}>
            Ask
          </button>
        </form>

        {speech.error && <div className="assistant-note">{speech.error}</div>}
        {!synthesisSupported && (
          <div className="assistant-note">This browser cannot read answers aloud.</div>
        )}
      </aside>
    </>
  );
}

export { MEASURES };
