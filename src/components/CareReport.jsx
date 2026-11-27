import { useMemo, useState } from 'react';
import { careReport, careTickets, ftfrByContract, jobTypesOf, monthsOf } from '../data/careReport.js';
import { saveBlob } from '../data/xlsx.js';
import { careReportXlsx } from '../data/careReportXlsx.js';
import { NOT_SET, PENDING_ORDER } from '../data/careStatus.js';
import { uptimeByContract, withUptime } from '../data/careUptime.js';
import { careMonthWise, MONTH_MEASURES } from '../data/careMonthWise.js';

const d2 = (n) => (n == null ? '–' : n.toFixed(2));
/** One Month wise cell, as the two-month report writes that measure. */
const mwText = (line, m) => {
  const v = line?.[m.key];
  if (v == null) return '–';
  if (m.kind === 'int') return v.toLocaleString();
  if (m.kind === 'ftfr') return `${v.toFixed(1)}%`;
  if (m.kind === 'uptime') return `${v.toFixed(2)}%`;
  return v.toFixed(2);
};
// Growth to one decimal in every column (the user, 27 Nov); never "-0.0%".
const pctText = (n) => {
  if (n == null) return '–';
  const v = Math.round(n * 1000) / 10;
  return v === 0 ? '0.0%' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
};

const p1 = (n) => (n == null ? '–' : `${n.toFixed(1)}%`);
const p2 = (n) => (n == null ? '–' : `${n.toFixed(2)}%`);

/** Faster than the other month is green, slower red; for FTFR (`up`) growth is green (the user, 26 Nov: growth %). */
function Change({ value, up, fmt = pctText }) {
  if (value == null) return <td className="num">–</td>;
  const good = up ? value >= 0 : value <= 0;
  return (
    <td className="num">
      {/* Dot then a fixed-width figure, so every dot in the column sits on one line (the user, 27 Nov). */}
      <span className="care-chg">
        <span className={`care-dot ${good ? 'better' : 'worse'}`} aria-hidden="true" />
        <span className="care-chg-v">{fmt(value)}</span>
      </span>
    </td>
  );
}

/** Pending's parts: the five always (the user, 27 Nov), Completed and Not set only when some pending call has them. */
function splitsOf(report) {
  if (!report?.total.pendingBy || !Object.keys(report.total.pendingBy).length) return [];
  return [...PENDING_ORDER, ...['Completed', NOT_SET].filter((k) => report.total.pendingBy[k])];
}

/** Care 360's Report tab: state or facility wise TATs, one month against another, and the Excel of it. */
export default function CareReport({ ds, filters, assets, uptimeAssets = null, ticketStatus = null }) {
  const months = useMemo(() => monthsOf(ds), [ds]);
  const jobTypes = useMemo(() => jobTypesOf(ds), [ds]);
  // From the earlier month To the later one (the user, 26 Nov): last month against the month before, Breakdown calls.
  const [monthKey, setMonthKey] = useState(() => (months[1] ?? months[0])?.key);
  const [againstKey, setAgainstKey] = useState(() => (months[2] ?? months[1])?.key);
  // Pending's status columns open from its heading (the user, 27 Nov); shut at first.
  const [pendOpen, setPendOpen] = useState(false);
  const [jobType, setJobType] = useState(() => jobTypes.find((j) => /breakdown/i.test(j.name))?.id ?? null);
  // The Report's sub-tab survives a reload (the user, 26 Nov).
  const [by, setByState] = useState(() => {
    try { return localStorage.getItem('bemmp-care-report-by') || 'state'; } catch { return 'state'; }
  });
  const setBy = (v) => {
    setByState(v);
    try { localStorage.setItem('bemmp-care-report-by', v); } catch { /* site data blocked */ }
  };

  const month = months.find((m) => m.key === monthKey) ?? months[0];
  const against = months.find((m) => m.key === againstKey) ?? null;
  const contractWise = by === 'contract';
  // Month wise (the user, 27 Nov): every month From → To, rows State or Customer, one measure at a time on screen.
  const monthWise = by === 'month';
  const [mwRows, setMwRows] = useState('state');
  const [mwMeasure, setMwMeasure] = useState('ftfrA');
  const report = useMemo(
    () => (month && !contractWise && !monthWise
      ? withUptime(ds, filters, uptimeAssets, careReport(ds, filters, { month, against, jobType, by, status: ticketStatus }), { month, against, by })
      : null),
    [ds, filters, month, against, jobType, by, ticketStatus, uptimeAssets, monthWise],
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
  // Uptime % beside FTFR, AMC / CAMC / both (the user, 27 Nov).
  const upC = useMemo(
    () => (contractWise && span.length ? uptimeByContract(ds, filters, uptimeAssets, span) : null),
    [ds, filters, uptimeAssets, span, contractWise],
  );
  const mw = useMemo(
    () => (monthWise && span.length ? careMonthWise(ds, filters, uptimeAssets, span, { jobType, by: mwRows, contracts: assets }) : null),
    [ds, filters, uptimeAssets, span, jobType, mwRows, monthWise, assets],
  );
  const measures = MONTH_MEASURES.filter((m) => m.key !== 'uptimeA' || mw?.hasUptime);
  const measure = measures.find((m) => m.key === mwMeasure) ?? measures[0];
  if (!month || (!contractWise && !monthWise && !report)) return <div className="panel"><p className="empty">No calls in this export.</p></div>;

  const A = month.label; const B = against?.label ?? '–';
  const cmp = Boolean(against) && against.key !== month.key;
  const first = by === 'facility' ? 'Facility' : 'State';
  const splits = report ? splitsOf(report) : [];
  const shown = pendOpen ? splits : [];
  const up = Boolean(report?.hasUptime);
  const pendHead = splits.length ? (
    <button type="button" className="care-pend-toggle" aria-expanded={pendOpen} onClick={() => setPendOpen((o) => !o)}>
      Pending <span className="care-pend-chev" aria-hidden="true">{pendOpen ? '▾' : '▸'}</span>
    </button>
  ) : 'Pending';
  const pend = (l, k) => (l.pendingBy?.[k] ? l.pendingBy[k].toLocaleString() : '');

  // Laid out like their own workbook: two heading rows, colours, icons (the user, 26 Nov).
  // One workbook whichever sub-tab is open: State wise, Customer wise, FTFR contract wise, Ticket wise (the user, 27 Nov).
  const download = async () => {
    const summaries = ['state', 'facility'].map((k) => ({
      by: k,
      report: withUptime(ds, filters, uptimeAssets, careReport(ds, filters, { month, against, jobType, by: k, status: ticketStatus }), { month, against, by: k }),
    }));
    const lo = Math.min(month.from, against?.from ?? month.from);
    const hi = Math.max(month.to, against?.to ?? month.to);
    const tickets = careTickets(ds, filters, { from: lo, to: hi, jobType, assets });
    saveBlob(
      await careReportXlsx({
        summaries, ftfr, upC: uptimeByContract(ds, filters, uptimeAssets, span),
        monthWise: ['state', 'facility', ...(assets ? ['contract'] : [])].map((k) => ({ by: k, mw: careMonthWise(ds, filters, uptimeAssets, span, { jobType, by: k, contracts: assets }) })),
        tickets, ds, A, B, cmp, splits: splitsOf(summaries[0].report), status: ticketStatus }),
      cmp ? `${ds.meta.name} Report ${B} to ${A}.xlsx` : `${ds.meta.name} Report ${A}.xlsx`,
    );
  };

  return (
    <div className="panel care-report">
      <div className="care-report-controls">
        <div className="segmented" role="tablist" aria-label="Report by">
          {[['state', 'State wise'], ['facility', 'Customer wise'], ['contract', 'FTFR & Uptime · Contract wise'], ['month', 'Month wise']].map(([id, label]) => (
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
        >
          Excel
        </button>
      </div>

      {!contractWise && !monthWise && (
      <div className="summary-scroll">
        <table className={`summary-grid care-grid${cmp ? '' : ' care-single'}`}>
          {cmp ? (
          <thead>
            <tr>
              <th rowSpan={2}>{first}</th>
              {by === 'facility' && <th rowSpan={2}>State</th>}
              {/* The counts are the To month's, named over them as the TAT groups name theirs (the user, 26 Nov). */}
              <th colSpan={3 + shown.length} className="summary-type band-end">{A}</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Response TAT</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Resolution TAT · closed in month</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">Logged &amp; closed same month</th>
              <th colSpan={cmp ? 3 : 1} className="summary-type">FTFR</th>
              {up && <th colSpan={cmp ? 3 : 1} className="summary-type">Uptime %</th>}
            </tr>
            <tr>
              <th className="num summary-sub">Total Calls</th>
              <th className="num summary-sub">Completed</th>
              <th className={`num summary-sub${shown.length ? '' : ' band-end'}`}>{pendHead}</th>
              {shown.map((k, n) => <th key={k} className={`num summary-sub care-split${n === shown.length - 1 ? ' band-end' : ''}`}>{k}</th>)}
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
              {up && cmp && <th className="num summary-sub group-start">{B}</th>}
              {up && <th className={`num summary-sub${cmp ? '' : ' group-start'}`}>{A}</th>}
              {up && cmp && <th className="num summary-sub">{A} vs {B}</th>}
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
                <th className={`num${shown.length ? '' : ' band-end'}`}>{pendHead}</th>
                {shown.map((k, n) => <th key={k} className={`num care-split${n === shown.length - 1 ? ' band-end' : ''}`}>{k}</th>)}
                <th className="num group-start">Response TAT</th>
                <th className="num group-start">Resolution TAT · closed in month</th>
                <th className="num group-start">Logged &amp; closed same month</th>
                <th className="num group-start">FTFR</th>
                {up && <th className="num group-start">Uptime %</th>}
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
                <td className={`num${shown.length ? '' : ' band-end'}`}>{l.pending.toLocaleString()}</td>
                {shown.map((k, n) => <td key={k} className={`num care-split${n === shown.length - 1 ? ' band-end' : ''}`}>{pend(l, k)}</td>)}
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
                {up && cmp && <td className="num group-start">{p2(l.uptimeB)}</td>}
                {up && <td className={`num${cmp ? '' : ' group-start'}`}>{p2(l.uptimeA)}</td>}
                {up && cmp && <Change value={l.uptimeChange} up />}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Grand Total</strong></td>
              {by === 'facility' && <td />}
              <td className="num strong">{report.total.calls.toLocaleString()}</td>
              <td className="num strong">{report.total.completed.toLocaleString()}</td>
              <td className={`num strong${shown.length ? '' : ' band-end'}`}>{report.total.pending.toLocaleString()}</td>
              {shown.map((k, n) => <td key={k} className={`num strong care-split${n === shown.length - 1 ? ' band-end' : ''}`}>{pend(report.total, k)}</td>)}
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
              {up && cmp && <td className="num strong group-start">{p2(report.total.uptimeB)}</td>}
              {up && <td className={`num strong${cmp ? '' : ' group-start'}`}>{p2(report.total.uptimeA)}</td>}
              {up && cmp && <Change value={report.total.uptimeChange} up />}
            </tr>
          </tfoot>
        </table>
      </div>
      )}

      {monthWise && mw && (
        <>
          <div className="care-mw-controls">
            <div className="segmented care-mw-rows" role="tablist" aria-label="Rows">
              {[['state', 'State'], ['facility', 'Customer'], ...(assets ? [['contract', 'Contract']] : [])].map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={mwRows === id} onClick={() => setMwRows(id)}>{label}</button>
              ))}
            </div>
            <div className="segmented care-mw-measure" role="tablist" aria-label="Measure">
              {measures.map((m) => (
                <button key={m.key} type="button" role="tab" aria-selected={measure.key === m.key} onClick={() => setMwMeasure(m.key)}>{m.short ?? m.label}</button>
              ))}
            </div>
          </div>
          <div className="summary-scroll">
            <table className="summary-grid care-grid care-mw">
              <thead>
                <tr>
                  <th>{{ facility: 'Customer', contract: 'Contract' }[mwRows] ?? 'State'}</th>
                  {mwRows === 'facility' && <th>State</th>}
                  {mw.months.map((m) => <th key={m.key} className="num">{m.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {mw.lines.map((l) => (
                  <tr key={l.name + l.state}>
                    <td><strong>{l.name}</strong></td>
                    {mwRows === 'facility' && <td>{l.state}</td>}
                    {mw.months.map((m) => <td key={m.key} className="num">{mwText(l.by[m.key], measure)}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Grand Total</strong></td>
                  {mwRows === 'facility' && <td />}
                  {mw.months.map((m) => <td key={m.key} className="num strong">{mwText(mw.total[m.key], measure)}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {contractWise && !ftfr && <p className="empty">Upload the asset master to see FTFR by contract.</p>}
      {contractWise && ftfr && (
        <>
          <div className="summary-scroll">
            {/* A band per contract type, Total last and tinted; no bars under FTFR % (the user, 26 Nov). */}
            <table className={`summary-grid care-grid care-ftfr${upC ? ' has-uptime' : ''}`}>
              <colgroup>
                <col className="ftfr-month" />
                {ftfr.types.map((t) => [<col key={`${t}c`} />, <col key={`${t}f`} />, <col key={`${t}p`} className="ftfr-pct-col" />])}
                {upC?.types.map((t) => [<col key={`u${t}a`} />, <col key={`u${t}d`} />, <col key={`u${t}p`} className="ftfr-pct-col" />])}
              </colgroup>
              <thead>
                <tr>
                  <th rowSpan={2} className="ftfr-month-head">Month</th>
                  {ftfr.types.map((t) => (
                    <th key={t} colSpan={3} className={`summary-type ftfr-band${t === 'Total' ? ' is-total' : ''}`}>
                      {t === 'Total' ? 'Total · AMC + CAMC' : t}
                    </th>
                  ))}
                  {upC?.types.map((t) => (
                    <th key={`u${t}`} colSpan={3} className={`summary-type ftfr-band${t === 'Total' ? ' is-total' : ''}`}>
                      {t === 'Total' ? 'Uptime · AMC + CAMC' : `Uptime · ${t}`}
                    </th>
                  ))}
                </tr>
                <tr>
                  {ftfr.types.map((t) => [
                    <th key={`${t}c`} className={`summary-sub group-start${t === 'Total' ? ' is-total' : ''}`}>Calls received</th>,
                    <th key={`${t}f`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>Completed in 24 hrs</th>,
                    <th key={`${t}p`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>FTFR %</th>,
                  ])}
                  {upC?.types.map((t) => [
                    <th key={`u${t}a`} className={`summary-sub group-start${t === 'Total' ? ' is-total' : ''}`}>Assets</th>,
                    <th key={`u${t}d`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>Assets down</th>,
                    <th key={`u${t}p`} className={`summary-sub${t === 'Total' ? ' is-total' : ''}`}>Uptime %</th>,
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
                      {upC?.types.map((t) => {
                        const u = (grand ? upC.total : upC.lines[k])?.[t];
                        const tot = t === 'Total' ? ' is-total' : '';
                        return [
                          <td key={`u${t}a`} className={`ftfr-n group-start${tot}`}>{u ? u.assets.toLocaleString() : '–'}</td>,
                          <td key={`u${t}d`} className={`ftfr-n${tot}`}>{u ? u.downAssets.toLocaleString() : '–'}</td>,
                          <td key={`u${t}p`} className={`ftfr-pct${tot}`}><b>{p2(u?.uptime == null ? null : u.uptime * 100)}</b></td>,
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
