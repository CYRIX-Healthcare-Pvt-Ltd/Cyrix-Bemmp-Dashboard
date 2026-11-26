import { useMemo, useState } from 'react';
import { careReport, jobTypesOf, monthsOf } from '../data/careReport.js';
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
export default function CareReport({ ds, filters }) {
  const months = useMemo(() => monthsOf(ds), [ds]);
  const jobTypes = useMemo(() => jobTypesOf(ds), [ds]);
  // From the earlier month To the later one (the user, 26 Nov): last month against the month before, Breakdown calls.
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

  // Laid out like their own workbook: two heading rows, colours, icons (the user, 26 Nov).
  const download = async () => {
    const name = by === 'facility' ? 'Customer Wise Summary' : 'State Wise Summary';
    saveBlob(
      await careReportXlsx({ report, A, B, by, sheetName: name }),
      `${ds.meta.name} ${name} ${B} to ${A}.xlsx`,
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
          <label htmlFor="care-against">From</label>
          <select id="care-against" value={against?.key ?? ''} onChange={(e) => setAgainstKey(e.target.value)}>
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="care-month">To</label>
          <select id="care-month" value={month.key} onChange={(e) => setMonthKey(e.target.value)}>
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
              <th colSpan={3} className="summary-type">FTFR</th>
            </tr>
            <tr>
              <th className="num summary-sub group-start">{B}</th>
              <th className="num summary-sub">{A}</th>
              <th className="num summary-sub">{A} vs {B}</th>
              <th className="num summary-sub group-start">{B}</th>
              <th className="num summary-sub">{A}</th>
              <th className="num summary-sub">{A} vs {B}</th>
              <th className="num summary-sub group-start">{B}</th>
              <th className="num summary-sub">{A}</th>
              <th className="num summary-sub">{A} vs {B}</th>
              <th className="num summary-sub group-start">{B}</th>
              <th className="num summary-sub">{A}</th>
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
                <td className="num group-start">{d2(l.responseB)}</td>
                <td className="num">{d2(l.responseA)}</td>
                <Change value={l.responseChange} />
                <td className="num group-start">{d2(l.resolutionB)}</td>
                <td className="num">{d2(l.resolutionA)}</td>
                <Change value={l.resolutionChange} />
                <td className="num group-start">{d2(l.sameB)}</td>
                <td className="num">{d2(l.sameA)}</td>
                <Change value={l.sameChange} />
                <td className="num group-start">{p1(l.ftfrB)}</td>
                <td className="num">{p1(l.ftfrA)}</td>
                <Change value={l.ftfrChange} up />
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
              <td className="num strong group-start">{d2(report.total.responseB)}</td>
              <td className="num strong">{d2(report.total.responseA)}</td>
              <Change value={report.total.responseChange} />
              <td className="num strong group-start">{d2(report.total.resolutionB)}</td>
              <td className="num strong">{d2(report.total.resolutionA)}</td>
              <Change value={report.total.resolutionChange} />
              <td className="num strong group-start">{d2(report.total.sameB)}</td>
              <td className="num strong">{d2(report.total.sameA)}</td>
              <Change value={report.total.sameChange} />
              <td className="num strong group-start">{p1(report.total.ftfrB)}</td>
              <td className="num strong">{p1(report.total.ftfrA)}</td>
              <Change value={report.total.ftfrChange} up />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
