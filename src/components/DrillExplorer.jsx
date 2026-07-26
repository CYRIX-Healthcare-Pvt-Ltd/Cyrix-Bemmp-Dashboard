import { useMemo, useState } from 'react';
import {
  formatDay, label, parseEngineer, ticketLabel, BUCKET_LABEL,
} from '../data/store.js';
import {
  rowsWhere, countBy, topN, analyzeRepeats, ticketsForAsset,
  penaltyWindows, isPenalty,
} from '../data/query.js';
import BarList from './BarList.jsx';

const MAX_ROWS = 400;
const MAX_ASSETS = 100;
const BUCKET_DOT = ['open', 'parked', 'resolved'];

/**
 * Drill order. District first, then facility, equipment, manufacturer — the way a
 * service manager narrows down — with engineer and department available at any level.
 */
export const DIMENSIONS = [
  { key: 'district', label: 'Districts', noun: 'district', color: 'var(--series-1)', top: 30 },
  { key: 'facilityName', label: 'Facilities', noun: 'facility', color: 'var(--series-1)', top: 12 },
  { key: 'equipment', label: 'Equipment', noun: 'equipment', color: 'var(--series-2)', top: 12 },
  { key: 'manufacturer', label: 'Manufacturers', noun: 'manufacturer', color: 'var(--series-3)', top: 10 },
  { key: 'engineer', label: 'Engineers', noun: 'engineer', color: 'var(--series-1)', top: 10 },
  { key: 'department', label: 'Departments', noun: 'department', color: 'var(--series-3)', top: 10 },
  { key: 'facilityType', label: 'Facility types', noun: 'facility type', color: 'var(--series-2)', top: 10 },
];

const DIM_BY_KEY = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

const AGE_BANDS = [
  { label: '0–7 days', min: 0, max: 7 },
  { label: '8–30 days', min: 8, max: 30 },
  { label: '31–90 days', min: 31, max: 90 },
  { label: '91–365 days', min: 91, max: 365 },
  { label: 'Over a year', min: 366, max: Infinity },
];

/** Ordinal bands, so they stay in chronological order rather than sorting by size. */
function AgeBands({ ds, rows, referenceDay }) {
  const items = useMemo(() => {
    const counts = AGE_BANDS.map(() => 0);
    for (const i of rows) {
      const age = referenceDay - ds.cols.loggedDay[i];
      const n = AGE_BANDS.findIndex((b) => age >= b.min && age <= b.max);
      if (n >= 0) counts[n]++;
    }
    return AGE_BANDS.map((b, n) => ({ id: b.label, label: b.label, value: counts[n] }));
  }, [ds, rows, referenceDay]);

  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="bars">
      {items.map((item) => (
        <div className="bar-row" key={item.id}>
          <div>
            <div className="b-label">{item.label}</div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.max(2, (item.value / max) * 100)}%`,
                  background: 'var(--status-critical)',
                }}
              />
            </div>
          </div>
          <div className="b-value">{item.value.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
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
  intro, showPenaltyColumn = false, showAgeing = false,
}) {
  const { cols, dict } = ds;
  const [path, setPath] = useState([]);
  const [asset, setAsset] = useState(null);

  const scoped = useMemo(() => {
    let cur = rows;
    for (const step of path) cur = rowsWhere(ds, cur, step.key, step.id);
    return cur;
  }, [ds, rows, path]);

  // In repeats mode the analysis re-runs at every level, so "repeat" keeps meaning
  // ">1 call on the same asset" inside whatever the manager has drilled into.
  const repeats = useMemo(
    () => (mode === 'repeats' ? analyzeRepeats(ds, scoped) : null),
    [ds, scoped, mode],
  );
  const counted = mode === 'repeats' ? repeats.rows : scoped;

  const remaining = useMemo(
    () => DIMENSIONS.filter((d) => !path.some((p) => p.key === d.key)),
    [path],
  );

  const breakdowns = useMemo(() => remaining.map((dim) => ({
    dim,
    items: topN(countBy(ds, counted, dim.key), dict[dim.key], dim.top)
      .map((it) => ({ ...it, label: displayValue(dim.key, it.id < 0 ? null : it.label) })),
  })), [ds, counted, remaining, dict]);

  const windows = useMemo(() => penaltyWindows(ds), [ds]);

  const ticketRows = useMemo(() => {
    const list = Array.from(counted);
    list.sort((a, b) => cols.loggedDay[a] - cols.loggedDay[b]);
    return list;
  }, [counted, cols]);

  const assets = useMemo(
    () => (repeats ? repeats.assets.slice(0, MAX_ASSETS) : []),
    [repeats],
  );

  const history = useMemo(
    () => (asset == null ? [] : ticketsForAsset(ds, scoped, asset)),
    [ds, scoped, asset],
  );

  const push = (key, id) => { setPath((p) => [...p, { key, id }]); setAsset(null); };
  const popTo = (n) => { setPath((p) => p.slice(0, n)); setAsset(null); };

  const total = counted.length;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="panel" style={{ '--i': 0 }}>
        <nav className="crumbs" aria-label="Drill-down path">
          <button type="button" onClick={() => popTo(0)} disabled={path.length === 0}>
            All
          </button>
          {path.map((step, n) => (
            <span key={`${step.key}-${step.id}`} className="crumb-step">
              <span className="crumb-sep" aria-hidden="true">›</span>
              <span className="crumb-dim">{DIM_BY_KEY[step.key].noun}</span>
              {n === path.length - 1 ? (
                <strong>{displayValue(step.key, label(dict[step.key], step.id))}</strong>
              ) : (
                <button type="button" onClick={() => popTo(n + 1)}>
                  {displayValue(step.key, label(dict[step.key], step.id))}
                </button>
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
        {remaining.length > 0 && total > 0 && (
          <p className="caption drill-hint">
            Select any bar below to drill deeper — {remaining.map((d) => d.noun).join(', ')}.
          </p>
        )}
      </div>

      {total === 0 ? (
        <div className="panel"><p className="empty">Nothing matches this drill-down.</p></div>
      ) : (
        <>
          <div className="grid grid-2">
            {showAgeing && (
              <div className="panel" style={{ '--i': 1 }}>
                <h2>Ageing</h2>
                <p className="caption">How long these calls have been sitting, as of {formatDay(referenceDay)}</p>
                <AgeBands ds={ds} rows={counted} referenceDay={referenceDay} />
              </div>
            )}
            {breakdowns.map(({ dim, items }, n) => (
              <div className="panel" key={dim.key} style={{ '--i': n + 2 }}>
                <div className="panel-head">
                  <div>
                    <h2>{dim.label}</h2>
                    <p className="caption">
                      {mode === 'repeats' ? 'Repeat calls' : 'Calls'} by {dim.noun}
                      {items.length >= dim.top ? ` · top ${dim.top}` : ''}
                    </p>
                  </div>
                  <span className="drill-badge" aria-hidden="true">drill</span>
                </div>
                <BarList
                  items={items}
                  total={total}
                  color={dim.color}
                  onSelect={(item) => push(dim.key, item.id)}
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
                      <th>Model</th><th>Facility</th><th>District</th><th>Manufacturer</th>
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
                Oldest first · showing {Math.min(MAX_ROWS, ticketRows.length)} of{' '}
                {ticketRows.length.toLocaleString()} · select a row for full detail
              </p>
              <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th><th className="num">Age</th><th>Logged</th>
                      <th>Equipment</th><th>Facility</th><th>District</th>
                      <th>Engineer</th>
                      {showPenaltyColumn && <th className="num">Over SLA</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ticketRows.slice(0, MAX_ROWS).map((i) => {
                      const age = referenceDay - cols.loggedDay[i];
                      const over = age - windows[cols.equipmentType[i] + 1];
                      return (
                        <tr key={i} className="clickable" onClick={() => onSelectRow(i)}>
                          <td>{ticketLabel(ds, i)}</td>
                          <td className="num">{age}d</td>
                          <td>{formatDay(cols.loggedDay[i])}</td>
                          <td>{label(dict.equipment, cols.equipment[i])}</td>
                          <td>{label(dict.facilityName, cols.facilityName[i])}</td>
                          <td>{label(dict.district, cols.district[i])}</td>
                          <td>{parseEngineer(label(dict.engineer, cols.engineer[i]))?.name ?? '—'}</td>
                          {showPenaltyColumn && (
                            <td className="num">
                              <span className="over-chip">+{over}d</span>
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
