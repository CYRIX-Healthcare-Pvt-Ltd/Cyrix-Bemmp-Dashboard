import { useMemo, useState } from 'react';
import { careReport, ftfrByContract, jobTypesOf, monthsOf } from '../data/careReport.js';
import { saveBlob } from '../data/xlsx.js';
import { careReportXlsx } from '../data/careReportXlsx.js';

const d2 = (n) => (n == null ? '–' : n.toFixed(2));
const pctText = (n) => (n == null ? '–' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`);

const p1 = (n) => (n == null ? '–' : `${n.toFixed(1)}%`);

/** Faster than the other month is green, slower red; for FTFR (`up`) growth is green (the user, 26 Nov: growth %). */
function Change({ value, up }) {
  if (value == null) return <td className="num">–</td>;
  const good = up ? value >= 0 : value <= 0;
  return (
    <td className="num">
      <span className={`care-dot ${good ? 'better' : 'worse'}`} aria-hidden="true" />
      {pctText(value)}
    </td>
  );
}

/** Care 360's Report tab: state or facility wise TATs, one month against another, and the Excel of it. */
export default function CareReport({ ds, filters, assets }) {
  const months = useMemo(() => monthsOf(ds), [ds]);
  const jobTypes = useMemo(() => jobTypesOf(ds), [ds]);
  // From the earlier month To the later one (the user, 26 Nov): last month against the month before, Breakdown calls.
  const [monthKey, setMonthKey] = useState(() => (months[1] ?? months[0])?.key);
  const [againstKey, setAgainstKey] = useState(() => (months[2] ?? months[1])?.key);
  const [jobType, setJobType] = useState(() => jobTypes.find((j) => /breakdown/i.test(j.name))?.id ?? null);
  const [by, setBy] = useState('state');

  const month = months.find((m) => m.key === monthKey) ?? months[0];
  const against = months.find((m) => m.key === againstKey) ?? null;
  const contractWise = by === 'contract';
  const report = useMemo(
    () => (month && !contractWise ? careReport(ds, filters, { month, against, jobType, by }) : null),
    [ds, filters, month, against, jobType, by],
  );
  // FTFR by AMC / CAMC, month by month From → To, like their own FTFR sheet (the user, 26 Nov).
  const span = useMemo(() => {
    if (!month) return [];
    const lo = Math.min(month.from, against?.from ?? month.from);
    const hi = Math.max(month.from, against?.from ?? month.from);
    return months.filter((m) => m.from >= lo && m.from <= hi).reverse();
  }, [months, month, against]);
  const ftfr = useMemo(
    () => (assets && span.length ? ftfrByContract(ds, filters, assets, span) : null),
    [ds, filters, assets, span],
  );
  if (!month || (!contractWise && !report)) return <div className="panel"><p className="empty">No calls in this export.</p></div>;

  const A = month.label; const B = against?.label ?? '–';
  const cmp = Boolean(against) && against.key !== month.key;
  const first = by === 'facility' ? 'Facility' : 'State';

  // Laid out like their own workbook: two heading rows, colours, icons (the user, 26 Nov).
  const download = async () => {
    if (contractWise) {
      saveBlob(await careReportXlsx({ ftfr, A, B }), `${ds.meta.name} FTFR Contract Wise ${B} to ${A}.xlsx`);
      return;
    }
    const name = by === 'facility' ? 'Customer Wise Summary' : 'State Wise Summary';
    saveBlob(
      await careReportXlsx({ report, A, B, by, sheetName: name, cmp }),
      cmp ? `${ds.meta.name} ${name} ${B} to ${A}.xlsx` : `${ds.meta.name} ${name} ${A}.xlsx`,
    );
  };

  return (
    <div className="panel care-report">
      <div className="care-report-controls">
        <div className="segmented" role="tablist" aria-label="Report by">
          {[['state', 'State wise'], ['facility', 'Customer wise'], ['contract', 'FTFR · Contract wise']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={by === id} onClick={() => setBy(id)}>{label}</button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="care-against">From</label>
          <select
            id="care-against" value={against?.key ?? ''}
            onChange={(e) => {
              const next = months.find((m) => m.key === e.target.value);
              setAgainstKey(e.target.value);
              if (next && next.from > month.from) setMonthKey(next.key);
            }}
          >
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="care-month">To</label>
          <select id="care-month" value={month.key} onChange={(e) => setMonthKey(e.target.value)}>
            {months.filter((m) => !against || m.from >= against.from).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        {!contractWise && (
        <div className="field care-job">
          <label htmlFor="care-job">Job type</label>
          <select id="care-job" value={jobType ?? ''} onChange={(e) => setJobType(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">All job types</option>
            {jobTypes.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </div>
        )}
        <button
          type="button" className="meeting-export care-download" onClick={download}
          disabled={contractWise && !ftfr}
        >
          Download Excel
        </button>
      </div>

      {!contractWise && (
      <div className="summary-scroll">
        <table className={`summary-grid care-grid${cmp ? '' : ' care-single'}`}>
          {cmp ? (
          <thead>
            <tr>
              <th rowSpan={2}>{first}</th>
              {by === 'facility' && <th rowSpan={2}>State</th>}
              {/* The counts are the To month's, named over them as the TAT groups name theirs (the user, 26 Nov). */}
              <th colSpan={3} className="summary-type band-end">{A}</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Response TAT</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Resolution TAT · closed in month</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Logged &amp; closed same month</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">FTFR</th>
            </tr>
            <tr>
              <th className="num summary-sub">Total Calls</th>
              <th className="num summary-sub">Completed</th>
              <th className="num summary-sub band-end">Pending</th>
              {cmp && <th className="num summary-sub group-start">{B}</th>}
              <th className={`num summary-sub${cmp ? '' : ' group-start'}`}>{A}</th>
              {cmp && <th className="num summary-sub">{A} vs {B}</th>}
              {cmp && <th className="num summary-sub group-start">{B}</th>}
              <th className={`num summary-sub${cmp ? '' : ' group-start'}`}>{A}</th>
              {cmp && <th className="num summary-sub">{A} vs {B}</th>}
              {cmp && <th className="num summary-sub group-start">{B}</th>}
              <th className={`num summary-sub${cmp ? '' : ' group-start'}`}>{A}</th>
              {cmp && <th className="num summary-sub">{A} vs {B}</th>}
              {cmp && <th className="num summary-sub group-start">{B}</th>}
              <th className={`num summary-sub${cmp ? '' : ' group-start'}`}>{A}</th>
              {cmp && <th className="num summary-sub">{A} vs {B}</th>}
            </tr>
          </thead>
          ) : (
            /* One month: one heading row, the month named once above the counts (the user, 26 Nov: "make it look good"). */
            <thead>
              <tr>
                <th>{first}</th>
                {by === 'facility' && <th>State</th>}
                <th className="num">Total calls</th>
                <th className="num">Completed</th>
                <th className="num band-end">Pending</th>
                <th className="num group-start">Response TAT</th>
                <th className="num group-start">Resolution TAT · closed in month</th>
                <th className="num group-start">Logged &amp; closed same month</th>
                <th className="num group-start">FTFR</th>
              </tr>
            </thead>
          )}
          <tbody>
            {report.lines.map((l) => (
              <tr key={l.name}>
                <td><strong>{l.name}</strong></td>
                {by === 'facility' && <td>{l.state}</td>}
                <td className="num">{l.calls.toLocaleString()}</td>
                <td className="num">{l.completed.toLocaleString()}</td>
                <td className="num band-end">{l.pending.toLocaleString()}</td>
                {cmp && <td className="num group-start">{d2(l.responseB)}</td>}
                <td className="num">{d2(l.responseA)}</td>
                {cmp && <Change value={l.responseChange} />}
                {cmp && <td className="num group-start">{d2(l.resolutionB)}</td>}
                <td className="num">{d2(l.resolutionA)}</td>
                {cmp && <Change value={l.resolutionChange} />}
                {cmp && <td className="num group-start">{d2(l.sameB)}</td>}
                <td className="num">{d2(l.sameA)}</td>
                {cmp && <Change value={l.sameChange} />}
                {cmp && <td className="num group-start">{p1(l.ftfrB)}</td>}
                <td className="num">{p1(l.ftfrA)}</td>
                {cmp && <Change value={l.ftfrChange} up />}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Grand Total</strong></td>
              {by === 'facility' && <td />}
              <td className="num strong">{report.total.calls.toLocaleString()}</td>
              <td className="num strong">{report.total.completed.toLocaleString()}</td>
              <td className="num strong band-end">{report.total.pending.toLocaleString()}</td>
              {cmp && <td className="num strong group-start">{d2(report.total.responseB)}</td>}
              <td className="num strong">{d2(report.total.responseA)}</td>
              {cmp && <Change value={report.total.responseChange} />}
              {cmp && <td className="num strong group-start">{d2(report.total.resolutionB)}</td>}
              <td className="num strong">{d2(report.total.resolutionA)}</td>
              {cmp && <Change value={report.total.resolutionChange} />}
              {cmp && <td className="num strong group-start">{d2(report.total.sameB)}</td>}
              <td className="num strong">{d2(report.total.sameA)}</td>
              {cmp && <Change value={report.total.sameChange} />}
              {cmp && <td className="num strong group-start">{p1(report.total.ftfrB)}</td>}
              <td className="num strong">{p1(report.total.ftfrA)}</td>
              {cmp && <Change value={report.total.ftfrChange} up />}
            </tr>
          </tfoot>
        </table>
      </div>
      )}

      {contractWise && !ftfr && <p className="empty">Upload the asset master to see FTFR by contract.</p>}
      {contractWise && ftfr && (
        <>
          <div className="summary-scroll">
            {/* A band per contract type, Total last and tinted; no bars under FTFR % (the user, 26 Nov). */}
            <table className="summary-grid care-grid care-ftfr">
              <colgroup>
                <col className="ftfr-month" />
                {ftfr.types.map((t) => [<col key={`${t}c`} />, <col key={`${t}f`} />, <col key={`${t}p`} className="ftfr-pct-col" />])}
              </colgroup>
              <thead>
                <tr>
                  <th rowSpan={2} className="ftfr-month-head">Month</th>
                  {ftfr.types.map((t) => (
                    <th key={t} colSpan={3} className={`summary-type ftfr-band${t === 'Total' ? ' is-total' : ''}`}>
                      {t === 'Total' ? 'Total · AMC + CAMC' : t}
                    </th>
                  ))}
                </tr>
                <tr>
                  {ftfr.types.map((t) => [
                    <th key={`${t}c`} className={`summary-sub group-start${t === 'Total' ? ' is-total' : ''}`}>Calls received</th>,
                    <th key={`${t}f`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>Completed in 24 hrs</th>,
                    <th key={`${t}p`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>FTFR %</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {[...ftfr.lines, ftfr.total].map((l, k) => {
                  const grand = k === ftfr.lines.length;
                  return (
                    <tr key={l.label} className={grand ? 'ftfr-grand' : ''}>
                      <td><strong>{l.label}</strong></td>
                      {ftfr.types.map((t) => {
                        const v = l[t];
                        const tot = t === 'Total' ? ' is-total' : '';
                        return [
                          <td key={`${t}c`} className={`ftfr-n group-start${tot}`}>{v.calls.toLocaleString()}</td>,
                          <td key={`${t}f`} className={`ftfr-n${tot}`}>{v.fixed.toLocaleString()}</td>,
                          <td key={`${t}p`} className={`ftfr-pct${tot}`}>
                            <b>{p1(v.pct)}</b>
                          </td>,
                        ];
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
