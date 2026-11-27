/*
 * Care 360 Report · Month wise (the user, 27 Nov: "apr to oct month wise, state wise ftfr uptime% resp tat etc").
 * Every month From → To, one line per state (or customer), each measure counted the way the two-month report counts
 * it: calls logged in the month, calls resolved (closed) in it whenever logged, Response TAT on calls started in it, Resolution TAT on calls ended in it, FTFR of the
 * calls raised in it, Uptime % over the month's days (to the export's last day for the month still running).
 */
import { careReport, contractOf } from './careReport.js';
import { withUptime } from './careUptime.js';

export const MONTH_MEASURES = [
  { key: 'calls', label: 'Calls logged', kind: 'int' },
  { key: 'sameCount', label: 'Logged & closed same month', short: 'Closed same month', kind: 'int' },
  { key: 'resolvedIn', label: 'Calls resolved', kind: 'int' },
  { key: 'responseA', label: 'Response TAT', kind: 'days' },
  { key: 'resolutionA', label: 'Resolution TAT · closed in month', short: 'Resolution TAT', kind: 'days' },
  { key: 'sameA', label: 'Logged & closed same month TAT', short: 'Same month TAT', kind: 'days' },
  { key: 'ftfrA', label: 'FTFR', kind: 'ftfr' },
  { key: 'uptimeA', label: 'Uptime %', kind: 'uptime' },
];

const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** { months: [{key,label}], lines: [{name, state, by: {monthKey: line}}], total: {monthKey: line}, hasUptime } */
export function careMonthWise(ds, filters, assets, span, { jobType, by, status = null, contracts = null }) {
  if (!span?.length) return null;
  const lines = new Map();
  const total = {};
  let hasUptime = false;
  for (const m of span) {
    // Contract rows: AMC, CAMC … as the ticket (else the asset master) gives them.
    const groupOf = by === 'contract' && contracts ? (i) => contractOf(ds, contracts, i) : null;
    const r = withUptime(ds, filters, assets, careReport(ds, filters, { month: m, against: null, jobType, by, status, groupOf }), { month: m, against: null, by });
    hasUptime = hasUptime || Boolean(r.hasUptime);
    total[m.key] = r.total;
    const keyOf = (name, state) => (by === 'facility' ? `${loose(name)}|${loose(state)}` : loose(name));
    for (const l of r.lines) {
      const k = keyOf(l.name, l.state);
      if (!lines.has(k)) lines.set(k, { name: l.name, state: l.state, by: {} });
      lines.get(k).by[m.key] = l;
    }
    // No calls in the month still has an uptime (100% when nothing was down that month).
    for (const g of r.uptimeGroups ?? []) {
      const k = keyOf(g.name, g.state);
      // Customers: only those with calls get a row; a state or contract always does.
      if (!lines.has(k)) {
        if (by === 'facility') continue;
        lines.set(k, { name: g.name, state: g.state, by: {} });
      }
      const line = lines.get(k);
      if (!line.by[m.key]) line.by[m.key] = { calls: 0, sameCount: 0, resolvedIn: 0, uptimeA: g.uptime };
    }
  }
  const out = [...lines.values()];
  // States by name; customers by their calls over the months, most first.
  const calls = (l) => Object.values(l.by).reduce((n, x) => n + x.calls, 0);
  out.sort((x, y) => (by === 'facility' ? calls(y) - calls(x) || x.name.localeCompare(y.name) : x.name.localeCompare(y.name)));
  return { months: span.map((m) => ({ key: m.key, label: m.label })), lines: out, total, hasUptime };
}
