import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice in and out, using the browser's own speech engines.
 *
 * Recognition and synthesis both ship with Chrome and Edge and cost nothing, so
 * neither audio nor transcripts are sent to OpenAI — only the resulting text, and
 * only once the user submits it.
 */

export const LANGUAGES = [
  { code: 'en-IN', label: 'English', name: 'English' },
  { code: 'ml-IN', label: 'മലയാളം', name: 'Malayalam' },
  { code: 'ta-IN', label: 'தமிழ்', name: 'Tamil' },
  { code: 'te-IN', label: 'తెలుగు', name: 'Telugu' },
  { code: 'hi-IN', label: 'हिन्दी', name: 'Hindi' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', name: 'Kannada' },
];

/** The language a contract's staff are most likely to speak. */
export const STATE_LANGUAGE = { kl: 'ml-IN', ap: 'te-IN' };

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export const speechSupported = Boolean(Recognition);
export const synthesisSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

export default function useSpeech(language) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const resolveRef = useRef(null);

  // Recreate on language change: the engine reads `lang` when it starts.
  useEffect(() => {
    if (!Recognition) return undefined;

    const rec = new Recognition();
    rec.lang = language;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let finalText = '';
      let partial = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else partial += r[0].transcript;
      }
      setInterim(partial);
      if (finalText) {
        setInterim('');
        resolveRef.current?.(finalText.trim());
        resolveRef.current = null;
      }
    };

    rec.onerror = (event) => {
      // "aborted" is what stop() produces; it is not a failure worth surfacing.
      if (event.error !== 'aborted') {
        setError(event.error === 'not-allowed'
          ? 'Microphone permission denied.'
          : `Speech recognition failed: ${event.error}`);
      }
      resolveRef.current?.(null);
      resolveRef.current = null;
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
      setInterim('');
      resolveRef.current?.(null);
      resolveRef.current = null;
    };

    recognitionRef.current = rec;
    return () => {
      rec.onresult = null; rec.onerror = null; rec.onend = null;
      try { rec.abort(); } catch { /* already stopped */ }
    };
  }, [language]);

  const listen = useCallback(() => new Promise((resolve) => {
    const rec = recognitionRef.current;
    if (!rec) { resolve(null); return; }
    setError(null);
    resolveRef.current = resolve;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if already running; treat as a no-op.
      resolve(null);
    }
  }), []);

  const stop = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* not running */ }
    setListening(false);
  }, []);

  return { listen, stop, listening, interim, error, supported: speechSupported };
}

/** Reads a sentence aloud, picking a voice that matches the language if present. */
export function speak(text, language) {
  if (!synthesisSupported || !text) return;
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = 0.98;

  const voices = window.speechSynthesis.getVoices();
  const exact = voices.find((v) => v.lang === language);
  const sameLanguage = voices.find((v) => v.lang?.split('-')[0] === language.split('-')[0]);
  if (exact || sameLanguage) utterance.voice = exact || sameLanguage;

  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (synthesisSupported) window.speechSynthesis.cancel();
}
