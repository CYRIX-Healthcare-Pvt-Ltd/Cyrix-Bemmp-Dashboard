import { useEffect, useRef, useState } from 'react';
import {
  QUERY_TOOL, datasetContext, runQuery, describeResult, MEASURES,
} from '../data/assistant.js';
import {
  planQuery, translateSentence, probeServer, storedKey, storeKey,
  storedModel, DEFAULT_MODEL, synthesizeSpeech,
} from '../data/openai.js';
import useSpeech, {
  LANGUAGES, STATE_LANGUAGE, speak, stopSpeaking, synthesisSupported,
  hasNativeVoice, whenVoicesReady, playClip,
} from '../hooks/useSpeech.js';
import BarList from './BarList.jsx';

/**
 * Set VITE_ASSISTANT_REQUIRE_PROXY=1 at build time to drop the key box entirely.
 * Use it when a proxy is meant to be the only route, so a missing proxy shows a
 * configuration message rather than inviting every user to paste a key.
 */
const PROXY_ONLY = String(import.meta.env?.VITE_ASSISTANT_REQUIRE_PROXY || '') === '1';

const SUGGESTIONS = [
  'Which district has the highest FTFR?',
  'Top 5 equipment by repeat calls',
  'Which engineer has the slowest resolution time?',
  'How many penalty calls are open right now?',
  'Per-day penalty by district',
];

/** One answered question: the spoken/typed prompt plus its rendered result. */
function Answer({ entry, onDrill, onReplay }) {
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
        <span>
          {result.measure.label}
          {result.spec.dimension !== 'none' && ` by ${result.spec.dimension}`}
          {result.appliedFilter && ` · ${result.appliedFilter.label}`}
          {` · ${result.spec.range === 'current' ? 'current filters' : result.spec.range}`}
        </span>
        <button
          type="button" className="replay"
          onClick={() => onReplay(translated || sentence)}
          aria-label="Read this answer aloud"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5 6 9H2v6h4l5 4V5Z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          </svg>
          Replay
        </button>
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
  const [speaking, setSpeaking] = useState(false);
  const [voicesReady, setVoicesReady] = useState(false);
  const logRef = useRef(null);

  const speech = useSpeech(language);

  useEffect(() => {
    probeServer().then((r) => setSession((s) => ({
      ...s,
      mode: r.mode,
      tts: r.tts,
      model: r.model || s.model || DEFAULT_MODEL,
    })));
    whenVoicesReady().then(() => setVoicesReady(true));
  }, []);

  // Stop any audio when the panel closes, or it keeps talking to an empty room.
  useEffect(() => () => stopSpeaking(), []);

  /**
   * Prefers the multilingual model, falling back to the browser engine. Without
   * this the browser reads Malayalam or Telugu with an English voice, because it
   * has no voice installed for those languages.
   */
  async function say(text) {
    stopSpeaking();
    setSpeaking(true);
    const done = () => setSpeaking(false);

    const native = hasNativeVoice(language);
    if (!native || !language.startsWith('en')) {
      try {
        const url = await synthesizeSpeech({ text, session });
        if (url) { playClip(url, { onEnd: done }); return; }
      } catch { /* fall through to the browser voice */ }
    }
    speak(text, language, { onEnd: done });
  }

  function halt() {
    stopSpeaking();
    setSpeaking(false);
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, busy]);

  const needsKey = session.mode === 'byok' && !session.apiKey;
  const unavailable = PROXY_ONLY && session.mode === 'byok';

  async function ask(text) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setQuestion('');
    setBusy(true);
    halt();

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
      say(translated || sentence);
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
            ) : PROXY_ONLY ? (
              <p className="caption">
                The assistant is not configured on this deployment. It needs a proxy
                holding the OpenAI key — see DEPLOY.md.
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
              <Answer entry={entry} onDrill={onDrill} onReplay={say} />
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
            placeholder={unavailable
              ? 'Assistant not configured'
              : (needsKey ? 'Add an OpenAI key to begin' : 'Ask about this contract…')}
            disabled={busy || speech.listening || needsKey}
          />
          {speaking ? (
            <button type="button" className="ask stop" onClick={halt}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          ) : (
            <button type="submit" className="ask" disabled={busy || !question.trim() || needsKey}>
              Ask
            </button>
          )}
        </form>

        {speech.error && <div className="assistant-note">{speech.error}</div>}
        {voicesReady && !language.startsWith('en') && !hasNativeVoice(language)
          && session.mode === 'byok' && !session.apiKey && (
          <div className="assistant-note">
            This device has no {LANGUAGES.find((l) => l.code === language)?.name} voice
            installed, so answers would be read with an English accent. Adding a key
            switches to the multilingual voice.
          </div>
        )}
        {!synthesisSupported && (
          <div className="assistant-note">This browser cannot read answers aloud.</div>
        )}
      </aside>
    </>
  );
}

export { MEASURES };
