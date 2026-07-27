/**
 * Ambient page backdrop, built from the language of the equipment this dashboard
 * reports on: a patient monitor's vitals stack, a slow aurora of brand-tinted
 * fluid, rising oxygen bubbles, and a faint technical grid.
 *
 * Three traces rather than one is what makes it read as a monitor instead of a
 * heartbeat gimmick — a real bedside unit shows ECG, respiration and SpO2
 * together, each at its own rate.
 *
 * Everything is decorative and pointer-transparent. Only `transform` and
 * `stroke-dashoffset` are animated, so the whole layer stays on the compositor;
 * nothing here triggers layout. `data-motion="reduced"` freezes it via the
 * stylesheet, leaving the artwork visible but still.
 */

const WIDTH = 1600;

/** One PQRST beat, 200 units wide, drawn relative to the baseline. */
const ECG_BEAT = 'h60 l10,-6 l10,6 h20 l6,6 l8,-34 l8,46 l8,-18 h15 l12,-8 l12,8 h31';
const ECG_BEATS = 8;
const ECG = `M0,50 ${Array.from({ length: ECG_BEATS }, () => ECG_BEAT).join(' ')}`;

/**
 * Respiration: a slow, smooth sine. Sampled as a polyline because a handful of
 * Béziers cannot hold a clean sine over this width.
 */
function respiration(cycles, amplitude, midline) {
  const steps = 160;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * WIDTH;
    const y = midline - Math.sin((i / steps) * cycles * Math.PI * 2) * amplitude;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

/**
 * SpO2 pleth: fast systolic upstroke, dicrotic notch, slow decay. Rounded where
 * the ECG is spiky, which is what separates the two at a glance.
 */
const PLETH_BEAT = 'c6,-30 16,-34 24,-2 c3,12 5,4 8,-6 c4,-13 9,-6 12,10 c4,20 10,28 16,28 h40';
const PLETH_BEATS = 16;
const PLETH = `M0,50 ${Array.from({ length: PLETH_BEATS }, () => PLETH_BEAT).join(' ')}`;

/** Rising bubbles. Fixed, not random, so the drift stays evenly spread. */
const BUBBLES = [
  { left: 6, size: 10, delay: 0, dur: 26, drift: 18 },
  { left: 14, size: 6, delay: 7, dur: 32, drift: -12 },
  { left: 23, size: 14, delay: 3, dur: 22, drift: 24 },
  { left: 31, size: 7, delay: 12, dur: 30, drift: -16 },
  { left: 42, size: 11, delay: 5, dur: 27, drift: 14 },
  { left: 51, size: 5, delay: 16, dur: 35, drift: -20 },
  { left: 59, size: 13, delay: 9, dur: 24, drift: 20 },
  { left: 68, size: 8, delay: 2, dur: 31, drift: -14 },
  { left: 77, size: 12, delay: 14, dur: 25, drift: 16 },
  { left: 85, size: 6, delay: 6, dur: 33, drift: -18 },
  { left: 93, size: 9, delay: 11, dur: 28, drift: 12 },
];

/** One monitor lane: a dim continuous trace with a lit segment sweeping along it. */
function Trace({ name, d, height, top }) {
  return (
    <svg
      className={`vital vital-${name}`}
      style={{ '--top': `${top}%`, '--h': `${height}px` }}
      viewBox={`0 0 ${WIDTH} 100`}
      preserveAspectRatio="none"
    >
      <path className="vital-base" d={d} />
      {/* pathLength normalises the trace to 1000 units so the dash animation
          loops seamlessly without measuring the real geometry. */}
      <path className="vital-sweep" d={d} pathLength="1000" filter="url(#vitalGlow)" />
    </svg>
  );
}

export default function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {/* Five overlapping blobs on different rotation periods. The union of them
          morphs continuously, which reads as fluid without the cost of animating
          an SVG turbulence filter every frame. */}
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      <div className="orb orb-4" />
      <div className="orb orb-5" />

      <div className="grid-overlay" />

      <div className="bubbles">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="bubble"
            style={{
              '--x': `${b.left}%`,
              '--size': `${b.size}px`,
              '--delay': `${-b.delay}s`,
              '--dur': `${b.dur}s`,
              '--drift': `${b.drift}px`,
            }}
          />
        ))}
      </div>

      <svg className="vital-defs" aria-hidden="true">
        <defs>
          <linearGradient id="vitalSweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--brand-red)" stopOpacity="0" />
            <stop offset="45%" stopColor="var(--brand-red)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="vitalSweepCool" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--series-3)" stopOpacity="0" />
            <stop offset="50%" stopColor="var(--series-3)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.7" />
          </linearGradient>
          <filter id="vitalGlow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>

      <Trace name="resp" d={respiration(3, 26, 50)} height={150} top={24} />
      <Trace name="ecg" d={ECG} height={170} top={52} />
      <Trace name="pleth" d={PLETH} height={140} top={76} />
    </div>
  );
}
