import { useMemo, useState } from 'react';
import { careReport, jobTypesOf, monthsOf } from '../data/careReport.js';
import { saveBlob, writeBook } from '../data/xlsx.js';

const d2 = (n) => (n == null ? '–' : n.toFixed(2));
const pctText = (n) => (n == null ? '–' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`);

/** Faster than the other month is green, slower red. */
function Change({ value }) {
  if (value == null) return <td className="num">–</td>;
  return (
    <td className="num">
      <span className={`care-dot ${value > 0 ? 'worse' : 'better'}`} aria-hidden="true" />
      {pctText(value)}
    </td>
  );
}

/** Care 360's Report tab: state or facility wise TATs, one month against another, and the Excel of it. */
export default function CareReport({ ds, filters }) {
  const months = useMemo(() => monthsOf(ds), [ds]);
  const jobTypes = useMemo(() => jobTypesOf(ds), [ds]);
  // Their workbook: last month against the month before it, Breakdown Support calls.
  const [monthKey, setMonthKey] = useState(() => (months[1] ?? months[0])?.key);
  const [againstKey, setAgainstKey] = useState(() => (months[2] ?? months[1])?.key);
  const [jobType, setJobType] = useState(() => jobTypes.find((j) => /breakdown/i.test(j.name))?.id ?? null);
  const [by, setBy] = useState('state');

  const month = months.find((m) => m.key === monthKey) ?? months[0];
  const against = months.find((m) => m.key === againstKey) ?? null;
  const report = useMemo(
    () => (month ? careReport(ds, filters, { month, against, jobType, by }) : null),
    [ds, filters, month, against, jobType, by],
  );
  if (!report) return <div className="panel"><p className="empty">No calls in this export.</p></div>;

  const A = month.label; const B = against?.label ?? '–';
  const first = by === 'facility' ? 'Facility' : 'State';

  const download = async () => {
    const columns = [
      { header: first, key: 'name' },
      ...(by === 'facility' ? [{ header: 'State', key: 'state' }] : []),
      { header: 'Total Calls', key: 'calls', numeric: true },
      { header: 'Completed', key: 'completed', numeric: true },
      { header: 'Pending', key: 'pending', numeric: true },
      { header: `Response TAT ${A}`, key: 'responseA', numeric: true },
      { header: `Response TAT ${B}`, key: 'responseB', numeric: true },
      { header: `Response ${A} vs ${B}`, key: 'responseChange' },
      { header: `Resolution TAT ${A}`, key: 'resolutionA', numeric: true },
      { header: `Resolution TAT ${B}`, key: 'resolutionB', numeric: true },
      { header: `Resolution ${A} vs ${B}`, key: 'resolutionChange' },
      { header: `Logged & closed same month ${A}`, key: 'sameA', numeric: true },
      { header: `Logged & closed same month ${B}`, key: 'sameB', numeric: true },
      { header: `Logged & closed ${A} vs ${B}`, key: 'sameChange' },
    ];
    const out = (l) => ({
      ...l,
      responseA: l.responseA == null ? '' : +l.responseA.toFixed(2),
      responseB: l.responseB == null ? '' : +l.responseB.toFixed(2),
      resolutionA: l.resolutionA == null ? '' : +l.resolutionA.toFixed(2),
      resolutionB: l.resolutionB == null ? '' : +l.resolutionB.toFixed(2),
      responseChange: l.responseChange == null ? '' : pctText(l.responseChange),
      resolutionChange: l.resolutionChange == null ? '' : pctText(l.resolutionChange),
      sameA: l.sameA == null ? '' : +l.sameA.toFixed(2),
      sameB: l.sameB == null ? '' : +l.sameB.toFixed(2),
      sameChange: l.sameChange == null ? '' : pctText(l.sameChange),
    });
    const name = by === 'facility' ? 'Customer Wise Summary' : 'State Wise Summary';
    saveBlob(
      await writeBook([{ name, columns, rows: [...report.lines, report.total].map(out) }]),
      `${ds.meta.name} ${name} ${A} vs ${B}.xlsx`,
    );
  };

  return (
    <div className="panel care-report">
      <div className="care-report-controls">
        <div className="segmented" role="tablist" aria-label="Report by">
          {[['state', 'State wise'], ['facility', 'Customer wise']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={by === id} onClick={() => setBy(id)}>{label}</button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="care-month">From</label>
          <select id="care-month" value={month.key} onChange={(e) => setMonthKey(e.target.value)}>
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="care-against">To</label>
          <select id="care-against" value={against?.key ?? ''} onChange={(e) => setAgainstKey(e.target.value)}>
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="field care-job">
          <label htmlFor="care-job">Job type</label>
          <select id="care-job" value={jobType ?? ''} onChange={(e) => setJobType(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">All job types</option>
            {jobTypes.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </div>
        <button type="button" className="meeting-export care-download" onClick={download}>Download Excel</button>
      </div>

      <div className="summary-scroll">
        <table className="summary-grid care-grid">
          <thead>
            <tr>
              <th rowSpan={2}>{first}</th>
              {by === 'facility' && <th rowSpan={2}>State</th>}
              <th rowSpan={2} className="num">Total Calls</th>
              <th rowSpan={2} className="num">Completed</th>
              <th rowSpan={2} className="num band-end">Pending</th>
              <th colSpan={3} className="summary-type">Response TAT</th>
              <th colSpan={3} className="summary-type">Resolution TAT · closed in month</th>
              <th colSpan={3} className="summary-type">Logged &amp; closed same month</th>
            </tr>
            <tr>
              <th className="num summary-sub group-start">{A}</th>
              <th className="num summary-sub">{B}</th>
              <th className="num summary-sub">{A} vs {B}</th>
              <th className="num summary-sub group-start">{A}</th>
              <th className="num summary-sub">{B}</th>
              <th className="num summary-sub">{A} vs {B}</th>
              <th className="num summary-sub group-start">{A}</th>
              <th className="num summary-sub">{B}</th>
              <th className="num summary-sub">{A} vs {B}</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((l) => (
              <tr key={l.name}>
                <td><strong>{l.name}</strong></td>
                {by === 'facility' && <td>{l.state}</td>}
                <td className="num">{l.calls.toLocaleString()}</td>
                <td className="num">{l.completed.toLocaleString()}</td>
                <td className="num band-end">{l.pending.toLocaleString()}</td>
                <td className="num group-start">{d2(l.responseA)}</td>
                <td className="num">{d2(l.responseB)}</td>
                <Change value={l.responseChange} />
                <td className="num group-start">{d2(l.resolutionA)}</td>
                <td className="num">{d2(l.resolutionB)}</td>
                <Change value={l.resolutionChange} />
                <td className="num group-start">{d2(l.sameA)}</td>
                <td className="num">{d2(l.sameB)}</td>
                <Change value={l.sameChange} />
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
              <td className="num strong group-start">{d2(report.total.responseA)}</td>
              <td className="num strong">{d2(report.total.responseB)}</td>
              <Change value={report.total.responseChange} />
              <td className="num strong group-start">{d2(report.total.resolutionA)}</td>
              <td className="num strong">{d2(report.total.resolutionB)}</td>
              <Change value={report.total.resolutionChange} />
              <td className="num strong group-start">{d2(report.total.sameA)}</td>
              <td className="num strong">{d2(report.total.sameB)}</td>
              <Change value={report.total.sameChange} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
