import { useMemo, useState } from 'react';
import {
  formatDay, label, parseEngineer, ticketLabel, BUCKET, BUCKET_LABEL,
} from '../data/store.js';
import {
  rowsWhere, countBy, topN, analyzeRepeats, ticketsForAsset,
  penaltyWindows, isPenalty, aggregateBy, closurePenalty,
} from '../data/query.js';
import BarList from './BarList.jsx';

const MAX_ROWS = 400;
const MAX_ASSETS = 100;
const BUCKET_DOT = ['open', 'parked', 'resolved'];

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Drill order. Zone, then district, facility, equipment, manufacturer — the way a
 * service manager narrows down — with engineer and department available at any level.
 */
export const DIMENSIONS = [
  // Two values in Kerala and none at all in Andhra, whose export has no zone
  // column. An empty dictionary drops the panel rather than drawing a heading
  // over nothing, which is why `dimensionsFor` exists.
  { key: 'zone', label: 'Zones', noun: 'zone', color: 'var(--series-4)', all: true },
  // Districts are a closed set — 14 in Kerala, 28 in Andhra — so the whole list
  // renders and the tail is a scroll away. An expander over a list that short
  // is a click asking permission for something it should just do.
  { key: 'district', label: 'Districts', noun: 'district', color: 'var(--series-1)', all: true },
  { key: 'facilityName', label: 'Facilities', noun: 'facility', color: 'var(--series-1)' },
  { key: 'equipment', label: 'Equipment', noun: 'equipment', color: 'var(--series-2)' },
  { key: 'manufacturer', label: 'Manufacturers', noun: 'manufacturer', color: 'var(--series-3)' },
  { key: 'engineer', label: 'Engineers', noun: 'engineer', color: 'var(--series-1)' },
  { key: 'department', label: 'Departments', noun: 'department', color: 'var(--series-3)' },
  { key: 'facilityType', label: 'Facility types', noun: 'facility type', color: 'var(--series-2)' },
];

/** Rows shown before the expander, the same everywhere. A breakdown that stops
 *  at 12 next to one that stops at 10 reads as an oversight, not a decision. */
export const TOP_N = 10;

const DIM_BY_KEY = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

/**
 * The dimensions this contract actually has values for.
 *
 * Every state's export has a different schema, and a column a state does not
 * supply sits at the sentinel for every row — so its dictionary is empty and a
 * breakdown over it would be a titled panel with one "—" bar in it. Andhra's
 * zone is the case that forced this.
 */
export const dimensionsFor = (ds) => DIMENSIONS.filter((d) => ds.dict[d.key]?.length > 0);

/**
 * Two things drill that are not dimensions, so they never get a breakdown panel
 * of their own among `remaining` — but they do need a noun for the breadcrumb.
 * Age is a range rather than a dictionary id; reason is a real column, but one
 * that only makes sense on the unresolved bucket.
 */
const AGE_KEY = '@age';
const REASON_KEY = 'parkedReason';
const EXTRA_NOUN = { [AGE_KEY]: 'age', [REASON_KEY]: 'reason' };

const AGE_BANDS = [
  { label: '0–7 days', min: 0, max: 7 },
  { label: '8–30 days', min: 8, max: 30 },
  { label: '31–90 days', min: 31, max: 90 },
  { label: '91–365 days', min: 91, max: 365 },
  { label: 'Over a year', min: 366, max: Infinity },
];

/** Ordinal bands, so they stay in chronological order rather than sorting by size. */
function ageItems(ds, rows, referenceDay) {
  const counts = AGE_BANDS.map(() => 0);
  for (const i of rows) {
    const age = referenceDay - ds.cols.loggedDay[i];
    const n = AGE_BANDS.findIndex((b) => age >= b.min && age <= b.max);
    if (n >= 0) counts[n]++;
  }
  return AGE_BANDS.map((b, n) => ({ id: b.label, label: b.label, value: counts[n], band: b }));
}

/** Age is a range, not a dictionary id, so it filters by predicate. */
function rowsInBand(ds, idx, band, referenceDay) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const age = referenceDay - ds.cols.loggedDay[idx[k]];
    if (age >= band.min && age <= band.max) out.push(idx[k]);
  }
  return out;
}

/** Engineer values carry code and phone; everything else is shown verbatim. */
function displayValue(key, raw) {
  if (raw == null) return '—';
  if (key !== 'engineer') return raw;
  return parseEngineer(raw)?.name ?? raw;
}

/**
 * A breakdown grid whose bars drill deeper, over any row set.
 *
 * `mode` decides what the bars count and what the table lists:
 *   tickets — every row in scope, listed as individual calls
 *   repeats — only rows on assets with >1 call, listed as offending assets
 */
export default function DrillExplorer({
  ds, rows, mode = 'tickets', referenceDay, onSelectRow,
  intro, showPenaltyColumn = false, showAgeing = false, showParkedReasons = false,
  measure = null, showResolutionColumn = false,
}) {
  const { cols, dict } = ds;
  const [path, setPath] = useState([]);
  const [asset, setAsset] = useState(null);

  // Andhra ships no rate card, so its dayRate is 0 throughout and the money
  // columns would be a wall of dashes. Its own penalty figures live in the
  // srcPenalty* columns instead.
  const hasRateCard = Boolean(ds.meta.penaltyRates);

  // Same reasoning for zone, which only Kerala's export carries.
  const hasZone = ds.dict.zone.length > 0;

  const scoped = useMemo(() => {
    let cur = rows;
    for (const step of path) {
      cur = step.key === AGE_KEY
        ? rowsInBand(ds, cur, step.band, referenceDay)
        : rowsWhere(ds, cur, step.key, step.id);
    }
    return cur;
  }, [ds, rows, path, referenceDay]);

  // In repeats mode the analysis re-runs at every level, so "repeat" keeps meaning
  // ">1 call on the same asset" inside whatever the manager has drilled into.
  const repeats = useMemo(
    () => (mode === 'repeats' ? analyzeRepeats(ds, scoped) : null),
    [ds, scoped, mode],
  );
  const counted = mode === 'repeats' ? repeats.rows : scoped;

  const remaining = useMemo(
    () => dimensionsFor(ds).filter((d) => !path.some((p) => p.key === d.key)),
    [ds, path],
  );

  const breakdowns = useMemo(() => remaining.map((dim) => {
    if (!measure) {
      const counts = countBy(ds, counted, dim.key);
      return {
        dim,
        groupCount: counts.size,
        // The whole ranking, uncapped. BarList shows TOP_N of it and expands on
        // demand — a ceiling here would put the tail permanently out of reach,
        // and the tail is exactly where the quiet outliers sit.
        items: topN(counts, dict[dim.key], Infinity)
          .map((it) => ({ ...it, label: displayValue(dim.key, it.id < 0 ? null : it.label) })),
      };
    }

    // A rate or a mean is `sum / n`. Groups below `minSamples` are dropped rather
    // than ranked: a single resolved call gives a 100% fix rate and would sit at
    // the top of every chart while meaning nothing.
    const reduce = measure.kind === 'sum' ? (g) => g.sum : (g) => g.sum / g.n;
    const groups = [...aggregateBy(ds, counted, dim.key, measure.value).entries()]
      .filter(([, g]) => g.n >= (measure.minSamples ?? 1))
      .map(([id, g]) => ({
        id,
        label: displayValue(dim.key, id < 0 ? null : dict[dim.key][id]),
        value: reduce(g),
        display: measure.format(reduce(g)),
        sub: measure.subtitle(g.n),
      }))
      .filter((g) => measure.kind !== 'sum' || g.value > 0);

    groups.sort((a, b) => (measure.sort === 'asc' ? a.value - b.value : b.value - a.value));
    return { dim, groupCount: groups.length, items: groups };
  }), [ds, counted, remaining, dict, measure]);

  const ageUsed = path.some((p) => p.key === AGE_KEY);
  const reasonUsed = path.some((p) => p.key === REASON_KEY);

  /**
   * Why the unresolved calls in scope are unresolved. Re-runs at every drill
   * level, so it answers "why is this facility's backlog parked" rather than
   * restating the all-time reasons.
   */
  const parkedReasons = useMemo(() => {
    if (!showParkedReasons || reasonUsed) return null;
    return topN(countBy(ds, counted, REASON_KEY), dict[REASON_KEY], Infinity)
      .filter((r) => r.id >= 0);
  }, [ds, counted, dict, showParkedReasons, reasonUsed]);

  const ages = useMemo(
    () => (showAgeing && !ageUsed ? ageItems(ds, counted, referenceDay) : null),
    [ds, counted, referenceDay, showAgeing, ageUsed],
  );

  const windows = useMemo(() => penaltyWindows(ds), [ds]);

  const ticketRows = useMemo(() => {
    const list = Array.from(counted);
    if (measure && measure.kind === 'sum') {
      // Biggest money first. Sorting a rupee view by logged date buries the rows
      // the total is actually made of behind the oldest, often zero-value, tickets.
      list.sort((a, b) => measure.value(b) - measure.value(a));
    } else if (showResolutionColumn) {
      // Slowest fix first — the useful order when looking at fix quality.
      list.sort((a, b) => (cols.resolvedDay[b] - cols.loggedDay[b])
        - (cols.resolvedDay[a] - cols.loggedDay[a]));
    } else {
      list.sort((a, b) => cols.loggedDay[a] - cols.loggedDay[b]);
    }
    return list;
  }, [counted, cols, showResolutionColumn, measure]);

  const assets = useMemo(
    () => (repeats ? repeats.assets.slice(0, MAX_ASSETS) : []),
    [repeats],
  );

  const history = useMemo(
    () => (asset == null ? [] : ticketsForAsset(ds, scoped, asset)),
    [ds, scoped, asset],
  );

  const push = (key, id) => { setPath((p) => [...p, { key, id }]); setAsset(null); };
  const pushAge = (band) => { setPath((p) => [...p, { key: AGE_KEY, band }]); setAsset(null); };
  const popTo = (n) => { setPath((p) => p.slice(0, n)); setAsset(null); };

  const stepNoun = (step) => DIM_BY_KEY[step.key]?.noun ?? EXTRA_NOUN[step.key];
  const stepLabel = (step) => (step.key === AGE_KEY
    ? step.band.label
    : displayValue(step.key, label(dict[step.key], step.id)));

  const total = counted.length;
  const drillable = [
    ...remaining.map((d) => d.noun),
    ...(ages ? ['age'] : []),
    ...(parkedReasons?.length ? ['reason'] : []),
  ];

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="panel" style={{ '--i': 0 }}>
        <nav className="crumbs" aria-label="Drill-down path">
          <button type="button" onClick={() => popTo(0)} disabled={path.length === 0}>
            All
          </button>
          {path.map((step, n) => (
            <span key={`${step.key}-${step.id ?? step.band.label}`} className="crumb-step">
              <span className="crumb-sep" aria-hidden="true">›</span>
              <span className="crumb-dim">{stepNoun(step)}</span>
              {n === path.length - 1 ? (
                <strong>{stepLabel(step)}</strong>
              ) : (
                <button type="button" onClick={() => popTo(n + 1)}>{stepLabel(step)}</button>
              )}
            </span>
          ))}
          {path.length > 0 && (
            <button type="button" className="crumb-clear" onClick={() => popTo(0)}>
              Clear
            </button>
          )}
        </nav>
        <p className="caption drill-intro">{intro(total, repeats)}</p>
        {drillable.length > 0 && total > 0 && (
          <p className="caption drill-hint">
            Select any bar below to drill deeper — {drillable.join(', ')}.
          </p>
        )}
      </div>

      {total === 0 ? (
        <div className="panel"><p className="empty">Nothing matches this drill-down.</p></div>
      ) : (
        <>
          <div className="grid grid-2">
            {ages && (
              <div className="panel" style={{ '--i': 1 }}>
                <div className="panel-head">
                  <div>
                    <h2>Ageing</h2>
                    <p className="caption">
                      How long these calls have been sitting, as of {formatDay(referenceDay)}
                    </p>
                  </div>
                  <span className="drill-badge" aria-hidden="true">drill</span>
                </div>
                <BarList
                  items={ages}
                  color="var(--status-critical)"
                  onSelect={(item) => pushAge(item.band)}
                />
              </div>
            )}

            {parkedReasons && (
              <div className="panel" style={{ '--i': 1 }}>
                <div className="panel-head">
                  <div>
                    <h2>Why calls are unresolved</h2>
                    <p className="caption">
                      Ticket Remark on the calls in this selection — these sit outside the
                      open backlog
                    </p>
                  </div>
                  <span className="drill-badge" aria-hidden="true">drill</span>
                </div>
                <BarList
                  items={parkedReasons}
                  total={total}
                  color="var(--status-warning)"
                  initial={TOP_N}
                  onSelect={(item) => push(REASON_KEY, item.id)}
                  emptyText="No reason recorded on these calls"
                />
              </div>
            )}

            {breakdowns.map(({ dim, items, groupCount }, n) => (
              <div className="panel" key={dim.key} style={{ '--i': n + 2 }}>
                <div className="panel-head">
                  <div>
                    <h2>{dim.label}</h2>
                    <p className="caption">
                      {measure
                        ? `${measure.label} by ${dim.noun} · ${measure.sort === 'asc' ? 'worst' : 'highest'} first`
                        : `${mode === 'repeats' ? 'Repeat calls' : 'Calls'} by ${dim.noun}`}
                      {groupCount > TOP_N
                        ? ` · ${groupCount.toLocaleString()} in this selection${dim.all ? ', scroll for the rest' : ''}`
                        : ''}
                    </p>
                  </div>
                  <span className="drill-badge" aria-hidden="true">drill</span>
                </div>
                <BarList
                  items={items}
                  total={measure ? null : total}
                  color={measure?.color ?? dim.color}
                  initial={dim.all ? null : TOP_N}
                  onSelect={(item) => push(dim.key, item.id)}
                  emptyText={measure
                    ? `No ${dim.noun} to rank for this measure`
                    : 'No data in range'}
                />
              </div>
            ))}
          </div>

          {mode === 'repeats' ? (
            <div className="panel" style={{ '--i': breakdowns.length + 2 }}>
              <h2>Worst offending assets</h2>
              <p className="caption">
                Ranked by call count · showing {assets.length} of{' '}
                {repeats.repeatAssets.toLocaleString()} · select a row for its call history
              </p>
              <div className="table-scroll" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Barcode</th><th className="num">Calls</th><th>Equipment</th>
                      <th>Model</th><th>Facility</th>
                      {hasZone && <th>Zone</th>}
                      <th>District</th><th>Manufacturer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr
                        key={a.barcode}
                        className="clickable"
                        aria-selected={asset === a.barcode}
                        onClick={() => setAsset(asset === a.barcode ? null : a.barcode)}
                      >
                        <td>{label(dict.barcode, a.barcode)}</td>
                        <td className="num"><span className="count-chip">{a.count}</span></td>
                        <td>{label(dict.equipment, cols.equipment[a.row])}</td>
                        <td>{label(dict.model, cols.model[a.row])}</td>
                        <td>{label(dict.facilityName, cols.facilityName[a.row])}</td>
                        {hasZone && <td>{label(dict.zone, cols.zone[a.row])}</td>}
                        <td>{label(dict.district, cols.district[a.row])}</td>
                        <td>{label(dict.manufacturer, cols.manufacturer[a.row])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="panel" style={{ '--i': breakdowns.length + 2 }}>
              <h2>Ticket list</h2>
              <p className="caption">
                {measure && measure.kind === 'sum'
                  ? 'Largest first'
                  : (showResolutionColumn ? 'Slowest fix first' : 'Oldest first')} · showing{' '}
                {Math.min(MAX_ROWS, ticketRows.length)} of{' '}
                {ticketRows.length.toLocaleString()} · select a row for full detail
              </p>
              <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th><th className="num">Age</th><th>Logged</th>
                      <th>Equipment</th><th>Facility</th>
                      {hasZone && <th>Zone</th>}
                      <th>District</th>
                      <th>Engineer</th>
                      {showResolutionColumn && <th className="num">Resolution</th>}
                      {showPenaltyColumn && <th className="num">Over SLA</th>}
                      {hasRateCard && <th className="num">Per-day ₹</th>}
                      {hasRateCard && <th className="num">Closure ₹</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ticketRows.slice(0, MAX_ROWS).map((i) => {
                      const age = referenceDay - cols.loggedDay[i];
                      const over = age - windows[cols.equipmentType[i] + 1];
                      const accruing = cols.bucket[i] === BUCKET.OPEN && cols.dayRate[i] > 0;
                      const closed = cols.resolvedDay[i] > 0;
                      return (
                        <tr key={i} className="clickable" onClick={() => onSelectRow(i)}>
                          <td>{ticketLabel(ds, i)}</td>
                          <td className="num">{age}d</td>
                          <td>{formatDay(cols.loggedDay[i])}</td>
                          <td>{label(dict.equipment, cols.equipment[i])}</td>
                          <td>{label(dict.facilityName, cols.facilityName[i])}</td>
                          {hasZone && <td>{label(dict.zone, cols.zone[i])}</td>}
                          <td>{label(dict.district, cols.district[i])}</td>
                          <td>{parseEngineer(label(dict.engineer, cols.engineer[i]))?.name ?? '—'}</td>
                          {showResolutionColumn && (
                            <td className="num">
                              {cols.resolvedDay[i] > 0
                                ? `${cols.resolvedDay[i] - cols.loggedDay[i]}d`
                                : '—'}
                            </td>
                          )}
                          {showPenaltyColumn && (
                            <td className="num">
                              <span className="over-chip">+{over}d</span>
                            </td>
                          )}
                          {hasRateCard && (
                            <td className="num">
                              {/* Only an open ticket is still burning a daily rate. */}
                              {accruing
                                ? <span className="money-accruing">{inr(cols.dayRate[i])}/d</span>
                                : <span className="money-nil">—</span>}
                            </td>
                          )}
                          {hasRateCard && (
                            <td className="num">
                              {closed && cols.dayRate[i] > 0
                                ? inr(closurePenalty(ds, i))
                                : <span className="money-nil">—</span>}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {asset != null && history.length > 0 && (
            <div className="panel" style={{ '--i': breakdowns.length + 3 }}>
              <h2>Call history · {label(dict.barcode, asset)}</h2>
              <p className="caption">
                {history.length} calls in scope · {label(dict.equipment, cols.equipment[history[0]])} at{' '}
                {label(dict.facilityName, cols.facilityName[history[0]])} · select a call for full detail
              </p>
              <div className="table-scroll" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th><th>Logged</th><th>Resolved</th><th>Status</th>
                      <th>Department</th><th>Engineer</th><th className="num">Down days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((i) => (
                      <tr key={i} className="clickable" onClick={() => onSelectRow(i)}>
                        <td>{ticketLabel(ds, i)}</td>
                        <td>{formatDay(cols.loggedDay[i])}</td>
                        <td>{cols.resolvedDay[i] > 0 ? formatDay(cols.resolvedDay[i]) : '—'}</td>
                        <td>
                          <span className="pill">
                            <span className={`dot ${BUCKET_DOT[cols.bucket[i]]}`} aria-hidden="true" />
                            {BUCKET_LABEL[cols.bucket[i]]}
                          </span>
                        </td>
                        <td>{label(dict.department, cols.department[i])}</td>
                        <td>{parseEngineer(label(dict.engineer, cols.engineer[i]))?.name ?? '—'}</td>
                        <td className="num">{cols.downDays[i]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
