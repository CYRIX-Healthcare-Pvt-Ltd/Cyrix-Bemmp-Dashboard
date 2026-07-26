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
 * One metric over time. A single series, so the panel heading names it and no
 * legend is needed; values are labelled selectively rather than on every point.
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

    // Selective direct labels: peak, trough and latest — never one per point.
    const marked = new Set();
    if (series.length <= 10) {
      values.forEach((_, i) => marked.add(i));
    } else {
      let hi = 0; let lo = 0;
      values.forEach((v, i) => {
        if (v > values[hi]) hi = i;
        if (v < values[lo]) lo = i;
      });
      marked.add(hi);
      marked.add(lo);
      marked.add(series.length - 1);
    }

    return { x, y, line, area, ticks, xLabels, values, plotH, plotW, top, marked };
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
  const fmt = (v) => (metric.percent ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString());

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

        {[...geom.marked].map((i) => {
          const vx = geom.x(i);
          const vy = geom.y(geom.values[i]);
          const anchor = i === 0 ? 'start' : (i === series.length - 1 ? 'end' : 'middle');
          return (
            <g key={`m${i}`}>
              <circle className="point-dot" cx={vx} cy={vy} r="3.5" fill={metric.color} />
              <text className="point-label" x={vx} y={vy - 10} textAnchor={anchor}>
                {fmt(geom.values[i])}
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
          <div className="t-row"><span>Resolved</span><span>{point.resolved.toLocaleString()}</span></div>
          <div className="t-row"><span>Open</span><span>{point.open.toLocaleString()}</span></div>
          <div className="t-row"><span>Unresolved</span><span>{point.parked.toLocaleString()}</span></div>
        </div>
      )}
    </div>
  );
}
