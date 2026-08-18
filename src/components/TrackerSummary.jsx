/**
 * The tracker's Summary, laid out as the workbook lays it out.
 *
 * Two blocks over one backlog, which is why they share a screen rather than a
 * tab each: the district block asks "where is the money", the penalty-type block
 * asks "why". Reading either without the other is how a handful of expensive
 * calls hides behind a crowd of cheap ones — the same reason Penalty calls sits
 * beside Per-day penalty on the Penalty tab.
 *
 * The cross-tab is twenty penalty types wide, so it is built to be read while
 * scrolled: zone and district stay pinned to the left and both header rows stay
 * pinned to the top, because a number in the fortieth column means nothing
 * without the district at the start of its row and the type above it. Everything
 * else here — the zebra, the rule between each Count/Value pair, the heavier one
 * closing the totals band — exists to keep the eye on one row across that width.
 *
 * It is not collapsed to a top-N: which type matters changes district by
 * district, and a cap would make that choice centrally for a table people read
 * across.
 */

import { useLayoutEffect, useRef } from 'react';

const inr = (n) => Math.round(n).toLocaleString('en-IN');

/* Blank, not "0". The sheet writes `IF(COUNTIFS(...)=0,"",...)` for exactly this
   reason: a grid of forty columns where most cells are zero reads as noise, and
   the eye is hunting the few that are not.
   Note the sheet wraps only the *count* that way, and blanking on each cell
   independently is wrong: a type with one call at a zero day-rate then showed
   "1" beside an empty Value, which reads as a figure that failed to load rather
   than as a real zero. The pair is blanked together or not at all. */
const num = (n) => (n ? inr(n) : '');
const pair = (count, value) => (count
  ? [inr(count), inr(value ?? 0)]
  : ['', '']);

export default function TrackerSummary({ summary, referenceDay, formatDay }) {
  const { districts, total, types, typeTotal, untyped, typeNames, hasZone } = summary;
  const top = types.reduce((a, t) => (t.value > (a?.value ?? 0) ? t : a), null);

  /*
   * Where the district column has to park, measured rather than assumed.
   *
   * District is pinned `left: <width of zone>`, and a hard-coded number is
   * wrong: `width` on a table cell is a suggestion the auto layout is free to
   * exceed, so the real zone column came out wider than the offset and the two
   * pinned columns drifted apart — a gap with the Unresolved column showing
   * through it. Measuring cannot drift, and it survives a font or zoom change
   * that no constant would.
   */
  const grid = useRef(null);
  useLayoutEffect(() => {
    const table = grid.current;
    if (!table || !hasZone) return undefined;
    const cell = table.querySelector('tbody .col-zone');
    if (!cell) return undefined;
    const set = () => table.style.setProperty('--zone-w', `${cell.getBoundingClientRect().width}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(cell);
    return () => ro.disconnect();
  }, [hasZone, districts.length]);

  return (
    <div className="summary">
      <div className="panel summary-panel">
        <div className="panel-head">
          <div>
            <h3>Summary by district</h3>
            <p className="caption">
              {inr(total.open)} unresolved calls as of {formatDay(referenceDay)}, of which{' '}
              <strong>{inr(total.penaltyCalls)}</strong> are on penalty, costing{' '}
              <strong>{inr(total.perDay)}</strong> a day. Counted the way the meeting’s own
              workbook counts them — the export’s Down Days past the contract window, open
              calls only — so parked calls are in the first column and in none of the
              others. The Penalty tab measures age from the logged date instead and will
              differ by a day’s worth of calls.
            </p>
          </div>
        </div>

        <div className="summary-scroll">
          <table ref={grid} className={`summary-grid${hasZone ? ' has-zone' : ''}`}>
            <thead>
              <tr>
                {hasZone && <th rowSpan={2} className="col-zone">Zone</th>}
                <th rowSpan={2} className="col-district">District</th>
                <th rowSpan={2} className="num band">Unresolved</th>
                <th rowSpan={2} className="num band">Penalty calls</th>
                <th rowSpan={2} className="num band">Penalty</th>
                <th rowSpan={2} className="num band band-end">Per day</th>
                {typeNames.map((name) => (
                  <th key={name} colSpan={2} className="summary-type">{name}</th>
                ))}
              </tr>
              <tr>
                {typeNames.map((name) => [
                  <th key={`${name}-c`} className="num summary-sub group-start">Count</th>,
                  <th key={`${name}-v`} className="num summary-sub">Value</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {districts.map((d) => (
                <tr key={d.district}>
                  {hasZone && (
                    <td className="col-zone">
                      {d.zone || <span className="money-nil">—</span>}
                    </td>
                  )}
                  <td className="col-district"><strong>{d.district}</strong></td>
                  <td className="num band">{inr(d.open)}</td>
                  <td className="num band strong">{num(d.penaltyCalls)}</td>
                  <td className="num band">{num(d.accrued)}</td>
                  <td className="num band band-end strong">{num(d.perDay)}</td>
                  {typeNames.map((name) => {
                    const cell = d.byType.get(name);
                    const [c, v] = pair(cell?.count, cell?.value);
                    return [
                      <td key={`${name}-c`} className="num group-start">{c}</td>,
                      <td key={`${name}-v`} className="num">{v}</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {hasZone && <td className="col-zone" />}
                <td className="col-district"><strong>Total</strong></td>
                <td className="num band">{inr(total.open)}</td>
                <td className="num band">{inr(total.penaltyCalls)}</td>
                <td className="num band">{inr(total.accrued)}</td>
                <td className="num band band-end">{inr(total.perDay)}</td>
                {typeNames.map((name) => {
                  const t = types.find((x) => x.name === name);
                  const [c, v] = pair(t?.count, t?.value);
                  return [
                    <td key={`${name}-c`} className="num group-start">{c}</td>,
                    <td key={`${name}-v`} className="num">{v}</td>,
                  ];
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="panel summary-panel">
        <div className="panel-head">
          <div>
            <h3>Summary by penalty type</h3>
            <p className="caption">
              Contribution is the share of the per-day figure, not of the call count — which
              is the point of having it, since a handful of expensive calls outweighs a
              crowd of cheap ones.
              {top?.value ? (
                <> Today {top.name} is the largest at {(top.share * 100).toFixed(1)}%.</>
              ) : null}
            </p>
          </div>
        </div>

        <div className="summary-scroll">
          <table className="summary-types">
            <thead>
              <tr>
                <th>Penalty type</th>
                <th className="num">Count</th>
                <th className="num">Value</th>
                <th className="num">Cont %</th>
                {/* The bar is the column people actually read; the percentage
                    beside it is for quoting, not for comparing. */}
                <th className="summary-barhead">Share of the daily cost</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.name} className={t.count ? undefined : 'is-empty'}>
                  <td>{t.name}</td>
                  {/* Real zeros here, muted rather than blank. This is a list of
                      twenty the meeting reads to check nothing was missed, so
                      "no calls" and "not calculated" must not look alike. */}
                  <td className="num">{inr(t.count)}</td>
                  <td className="num strong">{inr(t.value)}</td>
                  <td className="num">{`${(t.share * 100).toFixed(1)}%`}</td>
                  <td className="summary-barcell">
                    {t.share > 0 && (
                      <span className="summary-bar" style={{ width: `${t.share * 100}%` }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{inr(typeTotal.count)}</strong></td>
                <td className="num"><strong>{inr(typeTotal.value)}</strong></td>
                <td className="num"><strong>100%</strong></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/*
          The sheet has this gap and does not mention it — its district block and
          its type block report different totals. Left unsaid, two totals on one
          screen that disagree read as a fault in the page.
        */}
        {untyped.count > 0 && (
          <p className="caption summary-gap">
            {inr(untyped.count)} penalty call{untyped.count === 1 ? '' : 's'} carrying{' '}
            {inr(untyped.value)} a day {untyped.count === 1 ? 'has' : 'have'} no penalty
            type recorded yet, which is why this total is short of the{' '}
            {inr(total.penaltyCalls)} above. They are counted in the district block.
          </p>
        )}
      </div>
    </div>
  );
}
