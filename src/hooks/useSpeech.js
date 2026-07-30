import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice in and out, using the browser's own speech engines.
 *
 * Recognition and synthesis both ship with Chrome and Edge and cost nothing, so
 * neither audio nor transcripts are sent to OpenAI — only the resulting text, and
 * only once the user submits it.
 */

export const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)', name: 'Indian English' },
  { code: 'ml-IN', label: 'മലയാളം', name: 'Malayalam' },
  { code: 'ta-IN', label: 'தமிழ்', name: 'Tamil' },
  { code: 'te-IN', label: 'తెలుగు', name: 'Telugu' },
  { code: 'hi-IN', label: 'हिन्दी', name: 'Hindi' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', name: 'Kannada' },
];

/**
 * English is the default everywhere. The dashboard's own labels are English, so an
 * answer in English matches the tiles beside it; a local language is a deliberate
 * choice the user makes from the picker.
 */
export const DEFAULT_LANGUAGE = 'en-IN';

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export const speechSupported = Boolean(Recognition);

/**
 * Why the microphone is unavailable, or null when it works.
 *
 * Browsers expose SpeechRecognition only in a secure context. `localhost` counts,
 * a LAN address over plain http does not — so the mic silently vanishes on a phone
 * opening `http://192.168.x.x:4173` while working fine on the host machine. Saying
 * so beats hiding the button.
 */
export function micUnavailableReason() {
  if (speechSupported) return null;
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Voice input needs a secure connection. It works on this machine, but a '
      + 'phone on the office address needs the site served over HTTPS.';
  }
  return 'This browser does not support voice input. Chrome or Edge does.';
}
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

/**
 * Whether the browser actually has a voice for this language.
 *
 * Windows ships none for Malayalam, Telugu, Tamil or Kannada. Without this check
 * the engine silently substitutes an English voice, which then reads the script
 * with English phonetics instead of refusing — so the caller must ask first and
 * route to the multilingual model when the answer is no.
 */
export function hasNativeVoice(language) {
  if (!synthesisSupported) return false;
  const base = language.split('-')[0];
  return window.speechSynthesis.getVoices()
    .some((v) => v.lang?.split('-')[0] === base);
}

/** Voice lists populate asynchronously; this resolves once they are there. */
export function whenVoicesReady() {
  return new Promise((resolve) => {
    if (!synthesisSupported) { resolve([]); return; }
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) { resolve(voices); return; }
    const onChange = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', onChange);
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1200);
  });
}

// The clip currently playing, so stopSpeaking can halt either engine.
let currentAudio = null;

/** Plays an audio clip produced by the multilingual model. */
export function playClip(url, { onEnd } = {}) {
  stopSpeaking();
  const audio = new Audio(url);
  currentAudio = audio;
  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    onEnd?.();
  });
  audio.play().catch(() => { onEnd?.(); });
  return audio;
}

/** Reads a sentence with the browser engine, picking a matching voice if present. */
export function speak(text, language, { onEnd } = {}) {
  if (!synthesisSupported || !text) { onEnd?.(); return; }
  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = 0.98;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  const voices = window.speechSynthesis.getVoices();
  const exact = voices.find((v) => v.lang === language);
  const sameLanguage = voices.find((v) => v.lang?.split('-')[0] === language.split('-')[0]);
  if (exact || sameLanguage) utterance.voice = exact || sameLanguage;

  window.speechSynthesis.speak(utterance);
}

/** Halts whichever engine is talking. */
export function stopSpeaking() {
  if (synthesisSupported) window.speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}
