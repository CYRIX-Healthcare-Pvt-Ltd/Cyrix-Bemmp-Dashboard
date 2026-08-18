/**
 * The tracker's Summary, laid out as the workbook lays it out.
 *
 * Two blocks over one backlog, which is why they share a screen rather than a
 * tab each: the district block asks "where is the money", the penalty-type block
 * asks "why". Reading either without the other is how a handful of expensive
 * calls hides behind a crowd of cheap ones — the same reason Penalty calls sits
 * beside Per-day penalty on the Penalty tab.
 *
 * The cross-tab is twenty penalty types wide and scrolls inside itself. It is
 * not collapsed to a top-N: which type is worth looking at changes district by
 * district, and a cap would decide that centrally for a table people read across.
 */

const inr = (n) => Math.round(n).toLocaleString('en-IN');

/* Blank, not "0". The sheet writes `IF(COUNTIFS(...)=0,"",...)` for exactly this
   reason: a grid of twenty columns where most cells are zero reads as noise, and
   the eye is looking for the few that are not. */
const num = (n) => (n ? inr(n) : '');

export default function TrackerSummary({ summary, referenceDay, formatDay }) {
  const { districts, total, types, typeTotal, untyped, typeNames, hasZone } = summary;
  const span = (hasZone ? 2 : 1) + 4;

  return (
    <div className="summary">
      <div className="panel summary-panel">
        <h3>By district</h3>
        <p className="caption">
          {inr(total.open)} unresolved calls as of {formatDay(referenceDay)}, of which{' '}
          {inr(total.penaltyCalls)} are on penalty. Counted the way the meeting’s own
          workbook counts them — the export’s own Down Days past the contract window,
          open calls only — so parked calls are in the first column and in none of the
          others. The Penalty tab measures age from the logged date instead and will
          differ by a day’s worth of calls.
        </p>

        <div className="summary-scroll">
          <table className="summary-grid">
            <thead>
              <tr>
                {hasZone && <th rowSpan={2}>Zone</th>}
                <th rowSpan={2}>District</th>
                <th rowSpan={2} className="num">Total open calls</th>
                <th rowSpan={2} className="num">Penalty calls</th>
                <th rowSpan={2} className="num">Penalty</th>
                <th rowSpan={2} className="num">Per day</th>
                {typeNames.map((name) => (
                  <th key={name} colSpan={2} className="summary-type">{name}</th>
                ))}
              </tr>
              <tr>
                {typeNames.map((name) => [
                  <th key={`${name}-c`} className="num summary-sub">Count</th>,
                  <th key={`${name}-v`} className="num summary-sub">Value</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {districts.map((d) => (
                <tr key={d.district}>
                  {hasZone && <td>{d.zone || <span className="money-nil">—</span>}</td>}
                  <td><strong>{d.district}</strong></td>
                  <td className="num">{inr(d.open)}</td>
                  <td className="num">{num(d.penaltyCalls)}</td>
                  <td className="num">{num(d.accrued)}</td>
                  <td className="num">{num(d.perDay)}</td>
                  {typeNames.map((name) => {
                    const cell = d.byType.get(name);
                    return [
                      <td key={`${name}-c`} className="num">{num(cell?.count)}</td>,
                      <td key={`${name}-v`} className="num">{num(cell?.value)}</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {hasZone && <td />}
                <td><strong>Total</strong></td>
                <td className="num"><strong>{inr(total.open)}</strong></td>
                <td className="num"><strong>{inr(total.penaltyCalls)}</strong></td>
                <td className="num"><strong>{inr(total.accrued)}</strong></td>
                <td className="num"><strong>{inr(total.perDay)}</strong></td>
                {typeNames.map((name) => {
                  const t = types.find((x) => x.name === name);
                  return [
                    <td key={`${name}-c`} className="num">{num(t?.count)}</td>,
                    <td key={`${name}-v`} className="num">{num(t?.value)}</td>,
                  ];
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="panel summary-panel">
        <h3>By penalty type</h3>
        <p className="caption">
          Contribution is the share of the per-day figure, not of the call count — which
          is the point of having it: {inr(typeTotal.count)} calls do not cost
          {' '}{inr(typeTotal.count)} equal amounts.
        </p>

        <div className="summary-scroll">
          <table className="summary-types">
            <thead>
              <tr>
                <th>Penalty type</th>
                <th className="num">Count</th>
                <th className="num">Value</th>
                <th className="num">Cont %</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.name} className={t.count ? undefined : 'is-empty'}>
                  <td>{t.name}</td>
                  <td className="num">{num(t.count)}</td>
                  <td className="num">{num(t.value)}</td>
                  <td className="num">{t.share ? `${(t.share * 100).toFixed(1)}%` : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{inr(typeTotal.count)}</strong></td>
                <td className="num"><strong>{inr(typeTotal.value)}</strong></td>
                <td className="num"><strong>100%</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/*
          The sheet has this gap and does not mention it — its district block
          totals 385 penalty calls against the type block's 376. Left unsaid, two
          totals on one screen that disagree read as a fault in the page.
        */}
        {untyped.count > 0 && (
          <p className="caption summary-gap">
            {inr(untyped.count)} penalty call{untyped.count === 1 ? '' : 's'} carrying{' '}
            {inr(untyped.value)} a day {untyped.count === 1 ? 'has' : 'have'} no penalty
            type recorded yet, which is why this total is short of the{' '}
            {inr(total.penaltyCalls)} above. They are in the district block.
          </p>
        )}
      </div>
    </div>
  );
}
