/**
 * Ambient page backdrop: drifting brand-tinted orbs, a faint technical grid, and
 * an ECG trace that sweeps like a patient monitor.
 *
 * Purely decorative and pointer-transparent. Every animation here is disabled
 * under `prefers-reduced-motion` by the stylesheet.
 */

// One PQRST beat, 200 units wide, drawn relative to the baseline.
const BEAT = 'h60 l10,-6 l10,6 h20 l6,6 l8,-34 l8,46 l8,-18 h15 l12,-8 l12,8 h31';
const BEATS = 8;
const TRACE = `M0,60 ${Array.from({ length: BEATS }, () => BEAT).join(' ')}`;

export default function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      <div className="grid-overlay" />

      <svg className="ecg" viewBox={`0 0 ${BEATS * 200} 120`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="ecgSweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--brand-red)" stopOpacity="0" />
            <stop offset="45%" stopColor="var(--brand-red)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.9" />
          </linearGradient>
          <filter id="ecgGlow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Static trace, barely there — the sweep below rides over it. */}
        <path className="ecg-base" d={TRACE} />

        {/* pathLength normalises the trace to 1000 units so the dash animation
            loops seamlessly without measuring the real geometry. */}
        <path
          className="ecg-sweep"
          d={TRACE}
          pathLength="1000"
          filter="url(#ecgGlow)"
        />
      </svg>
    </div>
  );
}
