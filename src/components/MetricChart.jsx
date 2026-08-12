import { useEffect, useMemo, useRef, useState } from 'react';

const PAD = { top: 24, right: 18, bottom: 32, left: 56 };

/** Rounds a maximum up to a readable axis top. */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

const compact = (n) => {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
};

/**
 * Width of one character of `.point-label` — 11px Space Grotesk with tabular
 * figures, so every digit is the same width and this estimate is exact enough to
 * place labels without measuring the DOM.
 */
const CHAR_W = 6.4;
const LABEL_GAP = 7;

/**
 * One metric over time. A single series, so the panel heading names it and no
 * legend is needed; every point carries its value.
 */
export default function MetricChart({ series, metric, height = 300 }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Track the container width so the viewBox matches CSS pixels 1:1 — a fixed
  // viewBox would scale height with width and the chart would grow absurdly tall.
  const [W, setW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const fmt = (v) => (metric.percent ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString());

  const geom = useMemo(() => {
    if (!series.length) return null;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const values = series.map((d) => metric.value(d));
    const top = metric.percent ? 100 : niceMax(Math.max(...values, 1));
    const step = series.length > 1 ? plotW / (series.length - 1) : 0;

    const x = (i) => PAD.left + (series.length > 1 ? i * step : plotW / 2);
    const y = (v) => PAD.top + plotH - (v / top) * plotH;

    const line = values
      .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join('');
    const area = `${line}L${x(series.length - 1).toFixed(1)},${PAD.top + plotH}L${x(0).toFixed(1)},${PAD.top + plotH}Z`;

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: top * f, y: y(top * f) }));

    // Thin x labels so they never collide at ~62px apart.
    const every = Math.max(1, Math.ceil(series.length / Math.max(1, plotW / 62)));
    const xLabels = series
      .map((d, i) => ({ i, label: d.label }))
      .filter(({ i }) => i % every === 0 || i === series.length - 1);

    /*
     * A value on every point, dropped only where it would physically land on
     * top of its neighbour. Reading a trend one hover at a time is the thing
     * people complain about, but two labels overlapping is worse than one
     * missing — so they are placed left to right and each has to clear the last.
     *
     * Widths come from the character count rather than a DOM measurement: the
     * label font is tabular, so every digit is the same width and the estimate
     * cannot drift.
     */
    const labels = [];
    let lastRight = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const text = fmt(values[i]);
      const w = text.length * CHAR_W;
      // The ends pull inward so they cannot overhang the plot area.
      const anchor = i === 0 ? 'start' : (i === values.length - 1 ? 'end' : 'middle');
      const cx = x(i);
      const left = anchor === 'start' ? cx : (anchor === 'end' ? cx - w : cx - w / 2);

      if (left >= lastRight + LABEL_GAP) {
        labels.push({ i, text, anchor });
        lastRight = left + w;
      } else if (i === values.length - 1) {
        // The latest figure is the one people look for, so it always earns its
        // place and the label before it gives way.
        labels.pop();
        labels.push({ i, text, anchor });
      }
    }

    return { x, y, line, area, ticks, xLabels, values, plotH, plotW, top, labels };
  }, [series, W, H, metric]);

  const onMove = (e) => {
    if (!geom) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(geom.x(i) - svgX);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    setHover({ i: best, leftPct: (geom.x(best) / W) * 100 });
  };

  if (!geom) {
    return (
      <div className="chart-wrap" ref={wrapRef}>
        <p className="empty">No tickets in the selected range</p>
      </div>
    );
  }

  const point = hover ? series[hover.i] : null;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={metric.label}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`fill-${metric.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={metric.color} stopOpacity="0.20" />
            <stop offset="100%" stopColor={metric.color} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {geom.ticks.map((t) => (
          <g key={t.v}>
            <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} />
            <text className="tick" x={PAD.left - 10} y={t.y + 4} textAnchor="end">
              {metric.percent ? `${Math.round(t.v)}%` : compact(t.v)}
            </text>
          </g>
        ))}

        <path className="trend-area" d={geom.area} fill={`url(#fill-${metric.id})`} />
        {/* pathLength normalises the trace so the draw-on animation works without
            measuring the real geometry. */}
        <path
          className="trend-line draw"
          d={geom.line}
          pathLength="1000"
          stroke={metric.color}
        />

        <line
          className="axis"
          x1={PAD.left} x2={W - PAD.right}
          y1={PAD.top + geom.plotH} y2={PAD.top + geom.plotH}
        />

        {geom.labels.map(({ i, text, anchor }) => {
          const vx = geom.x(i);
          const vy = geom.y(geom.values[i]);
          return (
            <g key={`m${i}`}>
              <circle className="point-dot" cx={vx} cy={vy} r="3" fill={metric.color} />
              <text className="point-label" x={vx} y={vy - 10} textAnchor={anchor}>
                {text}
              </text>
            </g>
          );
        })}

        {geom.xLabels.map(({ i, label }) => (
          <text key={label + i} className="tick" x={geom.x(i)} y={H - 10} textAnchor="middle">
            {label}
          </text>
        ))}

        {hover && (
          <>
            <line
              className="crosshair"
              x1={geom.x(hover.i)} x2={geom.x(hover.i)}
              y1={PAD.top} y2={PAD.top + geom.plotH}
            />
            <circle
              className="trend-marker"
              cx={geom.x(hover.i)} cy={geom.y(geom.values[hover.i])} r="5"
              fill={metric.color}
            />
          </>
        )}
      </svg>

      {point && (
        <div
          className="tooltip"
          style={{
            left: `${hover.leftPct}%`,
            top: 4,
            transform: hover.leftPct > 68 ? 'translateX(-104%)' : 'translateX(12px)',
          }}
        >
          <div className="t-title">{point.label}</div>
          <div className="t-row t-primary">
            <span>{metric.label}</span>
            <span>{fmt(metric.value(point))}</span>
          </div>
          <div className="t-row"><span>Calls logged</span><span>{point.volume.toLocaleString()}</span></div>
          {/* Whatever the metric needs to make its own percentage add up. */}
          {metric.detail?.(point).map(([label, value]) => (
            <div className="t-row" key={label}>
              <span>{label}</span><span>{value.toLocaleString()}</span>
            </div>
          ))}
          {/* "So far": resolutions keep arriving after the export was taken, so
              this is a running total, not the period's final count. */}
          <div className="t-row"><span>Resolved so far</span><span>{point.resolved.toLocaleString()}</span></div>
          <div className="t-row"><span>Open</span><span>{point.open.toLocaleString()}</span></div>
          <div className="t-row"><span>Unresolved</span><span>{point.parked.toLocaleString()}</span></div>
        </div>
      )}
    </div>
  );
}
