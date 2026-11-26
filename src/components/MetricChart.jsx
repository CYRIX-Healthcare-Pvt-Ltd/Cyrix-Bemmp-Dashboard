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
export default function MetricChart(props) {
  if (props.split?.lines) return <LinesChart {...props} />;
  return props.split ? <SplitChart {...props} /> : <SingleChart {...props} />;
}

function SingleChart({ series, metric, height = 300 }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Track the container width so the viewBox matches CSS pixels 1:1 — a fixed
  // viewBox would scale height with width and the chart would grow absurdly tall.
  const [W, setW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    /*
     * Rounded, and only when it actually changed.
     *
     * Opening the rail animates the shell's grid column, so this fires on every
     * frame of it and each call re-runs the whole geometry pass — the scales,
     * the path, and the left-to-right label collision walk. Sub-pixel widths
     * made most of those renders identical work for an identical picture.
     */
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.max(280, Math.round(entry.contentRect.width));
      setW((w) => (w === next ? w : next));
    });
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

/*
 * Care 360 (the user, 26 Nov): Breakdown and PMS in one chart. Counts as stacked bars, Breakdown below and PMS
 * above, with only the total written over each bar, so it is no busier than the single line. FTFR as two lines with
 * no point labels (two rows of labels would collide), only each line's latest value at its end; the rest on hover.
 */
export const SPLIT_COLORS = { breakdown: 'var(--series-1)', pms: 'var(--series-2)' };

function SplitChart({ series, metric, split, height = 300 }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.max(280, Math.round(entry.contentRect.width));
      setW((w) => (w === next ? w : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const percent = Boolean(metric.percent);
  const fmt = (v) => {
    if (v == null) return '–';
    return percent ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString();
  };

  const geom = useMemo(() => {
    if (!series.length) return null;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const part = (map, d) => {
      const p = map.get(d.key);
      if (!p) return percent ? null : 0;
      if (percent) return p.volume ? metric.value(p) : null;
      return metric.value(p);
    };
    const bd = series.map((d) => part(split.bd, d));
    // FTFR is Breakdown only (the user, 26 Nov: "ftfr pms not needed").
    const pm = series.map((d) => (percent ? null : part(split.pm, d)));
    const totals = series.map((_, i) => (bd[i] ?? 0) + (pm[i] ?? 0));
    const top = percent ? 100 : niceMax(Math.max(...totals, 1));
    const n = series.length;
    const step = plotW / n;
    // Bars sit in the middle of their slot; lines use the same x so a hover lands on the same period.
    const x = (i) => PAD.left + step * (i + 0.5);
    const y = (v) => PAD.top + plotH - (v / top) * plotH;
    const barW = Math.max(3, Math.min(30, step * 0.62));

    const path = (vals) => {
      let d = '';
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: top * f, y: y(top * f) }));
    const every = Math.max(1, Math.ceil(n / Math.max(1, plotW / 62)));
    const xLabels = series.map((d, i) => ({ i, label: d.label })).filter(({ i }) => i % every === 0 || i === n - 1);

    // Totals over the bars, placed left to right so none lands on the last; the latest always shows.
    const labels = [];
    if (!percent) {
      let lastRight = -Infinity;
      for (let i = 0; i < n; i++) {
        const text = Math.round(totals[i]).toLocaleString();
        const w = text.length * CHAR_W;
        const left = x(i) - w / 2;
        if (left >= lastRight + 4) {
          labels.push({ i, text });
          lastRight = left + w;
        } else if (i === n - 1) {
          labels.pop();
          labels.push({ i, text });
        }
      }
    }

    // FTFR: each line's latest value at its end, kept apart if the two meet.
    const ends = [];
    if (percent) {
      for (const [vals, key] of [[bd, 'breakdown'], [pm, 'pms']]) {
        for (let i = n - 1; i >= 0; i--) {
          if (vals[i] != null) { ends.push({ key, i, v: vals[i], ty: y(vals[i]) - 9 }); break; }
        }
      }
      if (ends.length === 2 && Math.abs(ends[0].ty - ends[1].ty) < 13) {
        const [hi, lo] = ends[0].ty < ends[1].ty ? ends : [ends[1], ends[0]];
        hi.ty = lo.ty - 13;
      }
    }

    return { x, y, ticks, xLabels, plotH, bd, pm, totals, barW, labels, ends, bdPath: path(bd), pmPath: path(pm) };
  }, [series, split, W, H, metric, percent]);

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
    return <div className="chart-wrap" ref={wrapRef}><p className="empty">No tickets in the selected range</p></div>;
  }
  const base = PAD.top + geom.plotH;
  const h = hover?.i;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${metric.label}, Breakdown and PMS`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onMove}
      >
        {geom.ticks.map((t) => (
          <g key={t.v}>
            <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} />
            <text className="tick" x={PAD.left - 10} y={t.y + 4} textAnchor="end">{percent ? `${Math.round(t.v)}%` : compact(t.v)}</text>
          </g>
        ))}

        {!percent && series.map((d, i) => {
          const b = geom.bd[i] ?? 0;
          const p = geom.pm[i] ?? 0;
          const x0 = geom.x(i) - geom.barW / 2;
          const yb = geom.y(b);
          const yt = geom.y(b + p);
          return (
            <g key={d.key} className={h != null && h !== i ? 'split-dim' : ''}>
              <rect x={x0} y={yb} width={geom.barW} height={Math.max(0, base - yb)} fill={SPLIT_COLORS.breakdown} rx="1.5" />
              <rect x={x0} y={yt} width={geom.barW} height={Math.max(0, yb - yt)} fill={SPLIT_COLORS.pms} rx="1.5" />
            </g>
          );
        })}
        {!percent && geom.labels.map(({ i, text }) => (
          <text key={`t${i}`} className="point-label" x={geom.x(i)} y={geom.y(geom.totals[i]) - 6} textAnchor="middle">{text}</text>
        ))}

        {percent && (
          <>
            <path className="trend-line draw" d={geom.bdPath} pathLength="1000" stroke={SPLIT_COLORS.breakdown} />
            <path className="trend-line draw" d={geom.pmPath} pathLength="1000" stroke={SPLIT_COLORS.pms} />
            {geom.ends.map((e) => (
              <g key={e.key}>
                <circle className="point-dot" cx={geom.x(e.i)} cy={geom.y(e.v)} r="3" fill={SPLIT_COLORS[e.key]} />
                <text className="point-label" x={geom.x(e.i)} y={e.ty} textAnchor="end" style={{ fill: SPLIT_COLORS[e.key] }}>{fmt(e.v)}</text>
              </g>
            ))}
          </>
        )}

        <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} />
        {geom.xLabels.map(({ i, label }) => (
          <text key={label + i} className="tick" x={geom.x(i)} y={H - 10} textAnchor="middle">{label}</text>
        ))}

        {hover && (
          <>
            <line className="crosshair" x1={geom.x(h)} x2={geom.x(h)} y1={PAD.top} y2={base} />
            {percent && geom.bd[h] != null && <circle className="trend-marker" cx={geom.x(h)} cy={geom.y(geom.bd[h])} r="5" fill={SPLIT_COLORS.breakdown} />}
            {percent && geom.pm[h] != null && <circle className="trend-marker" cx={geom.x(h)} cy={geom.y(geom.pm[h])} r="5" fill={SPLIT_COLORS.pms} />}
          </>
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{ left: `${hover.leftPct}%`, top: 4, transform: hover.leftPct > 68 ? 'translateX(-104%)' : 'translateX(12px)' }}
        >
          <div className="t-title">{series[h].label}</div>
          <div className="t-row"><span><i className="split-key" style={{ background: SPLIT_COLORS.breakdown }} />Breakdown</span><span>{fmt(geom.bd[h])}</span></div>
          {!percent && <div className="t-row"><span><i className="split-key" style={{ background: SPLIT_COLORS.pms }} />PMS</span><span>{fmt(geom.pm[h])}</span></div>}
          {!percent && <div className="t-row t-primary"><span>Total</span><span>{fmt(geom.totals[h])}</span></div>}
        </div>
      )}
    </div>
  );
}

/*
 * Care 360 FTFR as one line per contract type, AMC and CAMC (the user, 26 Nov: "ftfr need amc and camc line only
 * need beautiful graphs"). Smooth lines over a soft fill, a dot per period, each line's latest value at its end, and
 * the scale starting near the lowest value so a few points of change can be seen.
 */
function smooth(pts, minY = -Infinity, maxY = Infinity) {
  const cl = (v) => Math.min(maxY, Math.max(minY, v));
  // Monotone-ish cubic through the points (Catmull-Rom, tension 0.5), never overshooting a 0–100 scale badly.
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = cl(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = cl(p2[1] - (p3[1] - p1[1]) / 6);
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function LinesChart({ series, metric, split, height = 300 }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.max(280, Math.round(entry.contentRect.width));
      setW((w) => (w === next ? w : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const fmt = (v) => (v == null ? '–' : `${v.toFixed(1)}%`);

  const geom = useMemo(() => {
    if (!series.length) return null;
    const plotW = W - PAD.left - PAD.right - 44;
    const plotH = H - PAD.top - PAD.bottom;
    const n = series.length;
    const lines = split.lines.map((l) => ({
      ...l,
      vals: series.map((d) => { const p = l.map.get(d.key); return p?.volume ? metric.value(p) : null; }),
      calls: series.map((d) => l.map.get(d.key)?.volume ?? 0),
    })).filter((l) => l.vals.some((v) => v != null));
    const all = lines.flatMap((l) => l.vals.filter((v) => v != null));
    if (!all.length) return null;
    const lo = Math.max(0, Math.min(80, Math.floor((Math.min(...all) - 5) / 10) * 10));
    const top = 100;
    const step = n > 1 ? plotW / (n - 1) : 0;
    const x = (i) => PAD.left + (n > 1 ? step * i : plotW / 2);
    const y = (v) => PAD.top + plotH - ((v - lo) / (top - lo)) * plotH;
    const base = PAD.top + plotH;
    for (const l of lines) {
      // A month with no calls is skipped and the line carries on, so the fill stays one shape.
      const r = [];
      l.vals.forEach((v, i) => { if (v != null) r.push([x(i), y(v)]); });
      const line = smooth(r, y(top), base);
      l.path = line;
      l.area = r.length > 1 ? `${line}L${r[r.length - 1][0].toFixed(1)},${base}L${r[0][0].toFixed(1)},${base}Z` : '';
      for (let i = n - 1; i >= 0; i--) {
        if (l.vals[i] != null) { l.end = { i, v: l.vals[i], ty: y(l.vals[i]) + 4 }; break; }
      }
    }
    // Keep the end labels apart.
    const ends = lines.map((l) => l.end).filter(Boolean).sort((a, b) => a.ty - b.ty);
    for (let k = 1; k < ends.length; k++) if (ends[k].ty - ends[k - 1].ty < 15) ends[k].ty = ends[k - 1].ty + 15;
    // Round steps: every 10 points, or 20 when the scale runs from low down.
    const gap = top - lo > 50 ? 20 : 10;
    const ticks = [];
    for (let v = lo; v <= top; v += gap) ticks.push({ v, y: y(v) });
    const every = Math.max(1, Math.ceil(n / Math.max(1, plotW / 62)));
    // The last label always shows; one that would sit on it is dropped.
    const xLabels = series.map((d, i) => ({ i, label: d.label }))
      .filter(({ i }) => i === n - 1 || (i % every === 0 && n - 1 - i >= every));
    /*
     * A small value at every point (the user, 26 Nov: "show labels, may be in small font"): at each period the higher
     * line's label sits above its dot and the lower one's below, so two lines never share a spot. Thinned when the
     * periods get too close for the text; the latest point is labelled at the end of its line instead.
     */
    const pointLabels = [];
    const room = n > 1 ? step : plotW;
    const stride = Math.max(1, Math.ceil(36 / Math.max(1, room)));
    for (let i = 0; i < n - 1; i++) {
      if (i % stride) continue;
      const here = lines.filter((l) => l.vals[i] != null).sort((a, b) => b.vals[i] - a.vals[i]);
      here.forEach((l, k) => {
        const below = here.length > 1 && k === here.length - 1;
        const yy = y(l.vals[i]) + (below ? 14 : -8);
        pointLabels.push({ key: `${l.key}${i}`, x: x(i), y: Math.min(base - 3, Math.max(PAD.top - 4, yy)), color: l.color, v: l.vals[i] });
      });
    }
    return { x, y, base, lines, ticks, xLabels, dots: n <= 40, pointLabels };
  }, [series, split, W, H, metric]);

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
    return <div className="chart-wrap" ref={wrapRef}><p className="empty">No tickets in the selected range</p></div>;
  }
  const h = hover?.i;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
        aria-label={`${metric.label}, ${geom.lines.map((l) => l.label).join(' and ')}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onMove}
      >
        <defs>
          {geom.lines.map((l) => (
            <linearGradient key={l.key} id={`fill-${l.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={l.color} stopOpacity="0.13" />
              <stop offset="100%" stopColor={l.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {geom.ticks.map((t) => (
          <g key={t.v}>
            <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} />
            <text className="tick" x={PAD.left - 10} y={t.y + 4} textAnchor="end">{`${Math.round(t.v)}%`}</text>
          </g>
        ))}
        {geom.lines.map((l) => <path key={`a${l.key}`} d={l.area} fill={`url(#fill-${l.key})`} stroke="none" />)}
        {geom.lines.map((l) => (
          <path key={`l${l.key}`} className="trend-line draw" d={l.path} pathLength="1000" stroke={l.color} style={{ strokeWidth: 2.5 }} />
        ))}
        {geom.dots && geom.lines.map((l) => l.vals.map((v, i) => (v == null ? null : (
          <circle key={`${l.key}${i}`} cx={geom.x(i)} cy={geom.y(v)} r="3" fill="var(--surface, #fff)" stroke={l.color} strokeWidth="2" />
        ))))}
        {geom.pointLabels.map((p) => (
          <text key={`p${p.key}`} x={p.x} y={p.y} textAnchor="middle" className="line-point-label" style={{ fill: p.color }}>
            {p.v.toFixed(1)}
          </text>
        ))}
        {geom.lines.map((l) => l.end && (
          <text
            key={`e${l.key}`} className="point-label" x={geom.x(l.end.i) + 8} y={l.end.ty} textAnchor="start"
            style={{ fill: l.color, fontWeight: 650 }}
          >
            {fmt(l.end.v)}
          </text>
        ))}

        <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={geom.base} y2={geom.base} />
        {geom.xLabels.map(({ i, label }) => (
          <text key={label + i} className="tick" x={geom.x(i)} y={H - 10} textAnchor="middle">{label}</text>
        ))}

        {hover && (
          <>
            <line className="crosshair" x1={geom.x(h)} x2={geom.x(h)} y1={PAD.top} y2={geom.base} />
            {geom.lines.map((l) => l.vals[h] != null && (
              <circle key={`h${l.key}`} className="trend-marker" cx={geom.x(h)} cy={geom.y(l.vals[h])} r="5.5" fill={l.color} />
            ))}
          </>
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{ left: `${hover.leftPct}%`, top: 4, transform: hover.leftPct > 68 ? 'translateX(-104%)' : 'translateX(12px)' }}
        >
          <div className="t-title">{series[h].label}</div>
          {geom.lines.map((l) => (
            <div key={l.key} className="t-row">
              <span><i className="split-key" style={{ background: l.color }} />{l.label}</span>
              <span>{fmt(l.vals[h])}{l.calls[h] ? ` · ${l.calls[h].toLocaleString()} calls` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
