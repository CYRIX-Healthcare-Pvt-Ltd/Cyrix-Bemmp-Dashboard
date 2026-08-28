import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

/* One key for every Cyrix module — same origin, one choice. */
const KEY = 'cyrix.theme';

/** Resolves the stored preference, falling back to the OS setting. */
function initialTheme() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private windows throw rather than returning null. Following the
    // machine is the right answer when the choice cannot be remembered.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The switch every Cyrix module has, drawn the same way here.
 *
 * Both icons stay mounted and cross-fade — the outgoing one rotating and
 * shrinking away as the incoming one arrives — so it reads as one control
 * changing state rather than two icons taking turns. This app used to
 * replace the whole SVG on click, which is why it looked like a different
 * control from the one in Spare.
 *
 * Switching is a circular reveal spreading from the button, using the View
 * Transitions API: the browser holds a snapshot of the outgoing theme while
 * the incoming one is clipped in over it, so every colour crosses together
 * instead of each element easing its own. Decoration, never the mechanism —
 * without the API, or with reduced motion asked for, the theme simply
 * changes.
 *
 * The classes are arguments because this control now appears in two
 * shapes: a pill in the masthead on the landing screen, and a row in the
 * side rail once there is a dashboard to put a rail beside. Same
 * behaviour, same icons, same key — only the chrome differs, which is
 * what stops it becoming two toggles that drift apart.
 */
export default function ThemeToggle({
  className = 'theme-toggle',
  labelClassName = 'theme-label',
}) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    // The stylesheet keys off data-theme on the root, and that scope is written
    // to win over the prefers-color-scheme block in both directions.
    document.documentElement.dataset.theme = theme;
    // Spare's Tailwind is darkMode:'class', so write that too.
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem(KEY, theme); } catch { /* unstorable */ }
  }, [theme]);

  // Another module, in another tab, on the same origin.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setTheme(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const dark = theme === 'dark';
  const next = dark ? 'light' : 'dark';

  function toggle(event) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof document.startViewTransition !== 'function') {
      setTheme(next);
      return;
    }

    const x = event.clientX;
    const y = event.clientY;
    // The distance to the furthest corner, so the circle always finishes
    // covering the screen whichever corner the button sits in.
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );
    const root = document.documentElement;
    root.style.setProperty('--theme-x', `${x}px`);
    root.style.setProperty('--theme-y', `${y}px`);
    root.style.setProperty('--theme-r', `${radius}px`);

    // flushSync is required: startViewTransition snapshots the DOM when its
    // callback returns, and a normal React update would not have landed by
    // then — it would snapshot the outgoing theme twice.
    document.startViewTransition(() => { flushSync(() => setTheme(next)); });
  }

  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span className="theme-icon-stack" aria-hidden="true">
        <svg
          className={`theme-swap sun${dark ? ' is-on' : ''}`}
          viewBox="0 0 24 24" width="17" height="17" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
        </svg>
        <svg
          className={`theme-swap moon${dark ? '' : ' is-on'}`}
          viewBox="0 0 24 24" width="17" height="17" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a7 7 0 0 0 11.1 11.1Z" />
        </svg>
      </span>
      <span className={labelClassName}>{dark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
