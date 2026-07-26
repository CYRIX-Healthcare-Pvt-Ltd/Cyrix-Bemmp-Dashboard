import { useEffect, useRef, useState } from 'react';

const prefersReduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animates a number toward `value` whenever it changes, so KPI tiles re-count
 * as filters are applied rather than snapping.
 */
export default function useCountUp(value, duration = 900) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    if (prefersReduced()) { setDisplay(value); fromRef.current = value; return undefined; }

    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return undefined;

    const started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / duration);
      // easeOutExpo — fast start, long settle, reads as "landing" on the number.
      const eased = t === 1 ? 1 : 1 - 2 ** (-10 * t);
      const current = from + delta * eased;
      setDisplay(current);
      fromRef.current = current;
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return display;
}
