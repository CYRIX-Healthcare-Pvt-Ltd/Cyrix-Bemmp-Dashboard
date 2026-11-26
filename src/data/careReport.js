/*
 * Care 360 (and Private BEMMP): turnaround in fractional days from the export's own date-times, and the month
 * against month report the Care 360 team keep in "Ticket Master_Care 360" (the user, 26 Nov).
 *
 * Response TAT = Job Start Date − Raised Date, over the calls raised in the month (with calls, completed, pending).
 * Resolution TAT = Job End Date − Raised Date, over the calls whose Job End Date is in the month, whenever they were
 * raised (the user, 26 Nov: "oct tat means like that"). A call not yet started is left out, not counted as zero.
 * Their workbook counts Breakdown Support calls only, so the report opens on that job type.
 */
import { filterRows } from './query.js';
import { isFirstTimeFix } from '../../shared/schema.mjs';

export const CARE_IDS = ['c360', 'pvt'];
export const isCare = (ds) => CARE_IDS.includes(ds?.meta?.id);

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

/** "24-01-2026 10:12:58" (or an Excel serial) as milliseconds; NaN when blank. */
export function msOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return EPOCH + Number(s) * DAY;
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

const textOf = (ds, field, i) => {
  const id = ds.cols[field]?.[i];
  return id == null || id < 0 ? '' : ds.dict[field]?.[id] ?? '';
};

/** Raised, job start and job end as milliseconds (NaN where blank), for the ticket list. */
export function careTimes(ds, i) {
  return {
    raised: msOf(textOf(ds, 'receivedAt', i)),
    start: msOf(textOf(ds, 'attendedAt', i)),
    end: msOf(textOf(ds, 'completedAt', i)),
  };
}

/** Days from raised to job start and to job end, or NaN where a time is missing. */
export function tatOf(ds, i) {
  const r = msOf(textOf(ds, 'receivedAt', i));
  const s = msOf(textOf(ds, 'attendedAt', i));
  const e = msOf(textOf(ds, 'completedAt', i));
  return {
    response: s >= r ? (s - r) / DAY : NaN,
    resolution: e >= r ? (e - r) / DAY : NaN,
  };
}

const mean = (ds, rows, key) => {
  let sum = 0; let n = 0;
  for (let k = 0; k < rows.length; k++) {
    const v = tatOf(ds, rows[k])[key];
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : null;
};

/** Rows whose Job End Date falls on Excel days from..to (inclusive). */
export function endedIn(ds, rows, from, to) {
  const lo = EPOCH + from * DAY; const hi = EPOCH + (to + 1) * DAY;
  const out = [];
  for (let k = 0; k < rows.length; k++) {
    const e = msOf(textOf(ds, 'completedAt', rows[k]));
    if (e >= lo && e < hi) out.push(rows[k]);
  }
  return out;
}

/** Every row the dashboard's filters allow, whatever its dates. */
export const allDates = (ds, filters) => filterRows(ds, { ...filters, dayFrom: ds.meta.dateRange.minDay, dayTo: ds.meta.dateRange.maxDay + 400 });

/** The tiles: response over the calls raised in the range, resolution over the calls ended in it. */
export function averageTat(ds, raised, ended) {
  return { response: mean(ds, raised, 'response'), resolution: mean(ds, ended, 'resolution') };
}

const done = (ds, i) => /^(completed|closed)$/i.test(textOf(ds, 'status', i).trim());

/**
 * Breakdown and PMS counts behind the first four tiles (the user, 26 Nov): all, resolved, open, not started.
 */
export function jobSplit(ds, rows) {
  const blank = () => ({ breakdown: 0, pms: 0 });
  const out = { total: blank(), resolved: blank(), open: blank(), notStarted: blank() };
  const kind = new Map();
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k];
    const id = ds.cols.lifecycle[i];
    if (!kind.has(id)) {
      const name = ds.dict.lifecycle?.[id] ?? '';
      kind.set(id, /breakdown/i.test(name) ? 'breakdown' : /pms/i.test(name) ? 'pms' : null);
    }
    const key = kind.get(id);
    if (!key) continue;
    out.total[key]++;
    if (done(ds, i)) out.resolved[key]++;
    else {
      out.open[key]++;
      if (!Number.isFinite(msOf(textOf(ds, 'attendedAt', i)))) out.notStarted[key]++;
    }
  }
  return out;
}

/** The rows split into Breakdown Support and PMS jobs. */
export function byJob(ds, rows) {
  const bd = []; const pms = []; const kind = new Map();
  for (let k = 0; k < rows.length; k++) {
    const id = ds.cols.lifecycle[rows[k]];
    if (!kind.has(id)) { const n = ds.dict.lifecycle?.[id] ?? ''; kind.set(id, /breakdown/i.test(n) ? bd : /pms/i.test(n) ? pms : null); }
    kind.get(id)?.push(rows[k]);
  }
  return { breakdown: Int32Array.from(bd), pms: Int32Array.from(pms) };
}

/** Open calls with no Job Start Date yet (the dashboard's eighth tile, the user, 26 Nov). */
export function notStarted(ds, rows) {
  let n = 0;
  for (let k = 0; k < rows.length; k++) if (!done(ds, rows[k]) && !Number.isFinite(msOf(textOf(ds, 'attendedAt', rows[k])))) n++;
  return n;
}

/** Months that have calls, newest first, as { key: 'YYYY-MM', label: 'Oct 26', from, to } in Excel days. */
export function monthsOf(ds) {
  const { minDay, maxDay } = ds.meta.dateRange;
  const out = [];
  const first = new Date(EPOCH + minDay * DAY);
  const last = new Date(EPOCH + maxDay * DAY);
  for (let y = last.getUTCFullYear(), m = last.getUTCMonth(); y > first.getUTCFullYear() || (y === first.getUTCFullYear() && m >= first.getUTCMonth());) {
    const from = (Date.UTC(y, m, 1) - EPOCH) / DAY;
    const to = (Date.UTC(y, m + 1, 1) - EPOCH) / DAY - 1;
    const label = `${new Date(Date.UTC(y, m, 1)).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })} ${String(y).slice(2)}`;
    out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label, from, to });
    if (--m < 0) { m = 11; y--; }
  }
  return out;
}

/** Job types in the export, for the report's picker. */
export const jobTypesOf = (ds) => (ds.dict.lifecycle ?? []).map((name, id) => ({ id, name })).filter((o) => o.name);

/**
 * One row per state (or facility): calls, completed and pending in the first month, and both TATs in each month.
 * `filters` are the dashboard's (area and dimension filters stay); only the dates are the report's own.
 */
export function careReport(ds, filters, { month, against, jobType, by }) {
  const field = by === 'facility' ? 'facilityName' : 'zone';
  const ofType = (idx) => {
    const out = [];
    for (let k = 0; k < idx.length; k++) if (jobType == null || ds.cols.lifecycle[idx[k]] === jobType) out.push(idx[k]);
    return out;
  };
  const rowsIn = (m) => ofType(filterRows(ds, { ...filters, dayFrom: m.from, dayTo: m.to }));
  const every = ofType(allDates(ds, filters));
  const endedOf = (m) => endedIn(ds, every, m.from, m.to);
  const groups = new Map();
  const at = (i) => {
    const name = textOf(ds, field, i).trim() || '—';
    if (!groups.has(name)) groups.set(name, { name, state: textOf(ds, 'zone', i).trim(), a: [], b: [], ea: [], eb: [] });
    return groups.get(name);
  };
  const a = rowsIn(month); const b = against ? rowsIn(against) : [];
  const ea = endedOf(month); const eb = against ? endedOf(against) : [];
  for (const i of a) at(i).a.push(i);
  for (const i of b) at(i).b.push(i);
  for (const i of ea) at(i).ea.push(i);
  for (const i of eb) at(i).eb.push(i);
  const line = (name, state, g) => {
    const ta = averageTat(ds, g.a, g.ea); const tb = averageTat(ds, g.b, g.eb);
    // FTFR: of the calls raised in the month, the share fixed the same day or the next, as on the FTFR tile.
    const ftfr = (rows) => (rows.length ? (100 * rows.filter((i) => isFirstTimeFix(ds.cols.loggedDay[i], ds.cols.resolvedDay[i])).length) / rows.length : null);
    const fa = ftfr(g.a); const fb = against ? ftfr(g.b) : null;
    // Raised and closed in the same month (the user, 26 Nov).
    const sa = mean(ds, endedIn(ds, g.a, month.from, month.to), 'resolution');
    const sb = against ? mean(ds, endedIn(ds, g.b, against.from, against.to), 'resolution') : null;
    const completed = g.a.filter((i) => done(ds, i)).length;
    return {
      name, state, calls: g.a.length, completed, pending: g.a.length - completed,
      responseA: ta.response, responseB: tb.response, responseChange: change(ta.response, tb.response),
      resolutionA: ta.resolution, resolutionB: tb.resolution, resolutionChange: change(ta.resolution, tb.resolution),
      sameA: sa, sameB: sb, sameChange: change(sa, sb),
      ftfrA: fa, ftfrB: fb, ftfrChange: change(fa, fb),
    };
  };
  const lines = [...groups.values()].map((g) => line(g.name, g.state, g))
    .sort((x, y) => (by === 'facility' ? y.calls - x.calls || x.name.localeCompare(y.name) : x.name.localeCompare(y.name)));
  return { lines, total: line('Grand Total', '', { a, b, ea, eb }) };
}

/** Change of this month against the other, as a fraction (−0.6 = 60% faster); null when either is missing. */
function change(now, before) {
  if (now == null || before == null || before === 0) return null;
  return (now - before) / before;
}

/*
 * Contract type (AMC, CAMC, …) from the asset master, by the call's barcode (the user, 26 Nov: "amc camc we need a
 * clear picture"). A barcode not in the asset master is "Not in asset master", so nothing silently drops out.
 */
export const NOT_IN_ASSETS = 'Not in asset master';
export const CONTRACT_ORDER = ['AMC', 'CAMC', 'Non Contract', 'Warranty', 'In House', 'Rental'];

export function contractOf(ds, assets, i) {
  const id = ds.cols.barcode[i];
  const code = id == null || id < 0 ? '' : String(ds.dict.barcode[id] ?? '').trim();
  return (code && assets.get(code)) || NOT_IN_ASSETS;
}

const isBreakdown = (ds) => {
  const memo = new Map();
  return (i) => {
    const id = ds.cols.lifecycle[i];
    if (!memo.has(id)) memo.set(id, /breakdown/i.test(ds.dict.lifecycle?.[id] ?? ''));
    return memo.get(id);
  };
};

/** First-time fixes over Breakdown calls: { calls, fixed, pct }. */
export function ftfrOf(ds, rows) {
  const bd = isBreakdown(ds);
  let calls = 0; let fixed = 0;
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k];
    if (!bd(i)) continue;
    calls++;
    if (isFirstTimeFix(ds.cols.loggedDay[i], ds.cols.resolvedDay[i])) fixed++;
  }
  return { calls, fixed, pct: calls ? (100 * fixed) / calls : null };
}

/**
 * The dashboard's contract table: per contract type, calls raised in range, open, not started, FTFR (Breakdown
 * calls whose window has closed), response (raised in range) and resolution (closed in range).
 */
export function contractTable(ds, assets, { raised, ended, ftfrRows }) {
  const groups = new Map();
  const at = (name) => {
    if (!groups.has(name)) groups.set(name, { name, raised: [], ended: [], ftfr: [] });
    return groups.get(name);
  };
  for (const i of raised) at(contractOf(ds, assets, i)).raised.push(i);
  for (const i of ended) at(contractOf(ds, assets, i)).ended.push(i);
  for (const i of ftfrRows) at(contractOf(ds, assets, i)).ftfr.push(i);
  const rank = (n) => (n === NOT_IN_ASSETS ? 99 : CONTRACT_ORDER.indexOf(n) < 0 ? 50 : CONTRACT_ORDER.indexOf(n));
  return [...groups.values()]
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((g) => {
      const open = g.raised.filter((i) => !done(ds, i));
      return {
        name: g.name,
        calls: g.raised.length,
        open: open.length,
        notStarted: notStarted(ds, open),
        ftfr: ftfrOf(ds, g.ftfr),
        response: mean(ds, g.raised, 'response'),
        resolution: mean(ds, g.ended, 'resolution'),
      };
    })
    .filter((g) => g.calls || g.resolution != null);
}

/**
 * Their "FTFR Summary": per month from From to To, for each contract type, Breakdown calls received, fixed the same
 * day or the next, and the share. Totals over the months at the foot.
 */
export function ftfrByContract(ds, filters, assets, months, types = ['AMC', 'CAMC']) {
  const lines = months.map((m) => {
    const idx = filterRows(ds, { ...filters, dayFrom: m.from, dayTo: m.to });
    const by = Object.fromEntries(types.map((t) => [t, []]));
    for (let k = 0; k < idx.length; k++) {
      const c = contractOf(ds, assets, idx[k]);
      if (by[c]) by[c].push(idx[k]);
    }
    return { label: m.label, ...Object.fromEntries(types.map((t) => [t, ftfrOf(ds, by[t])])) };
  });
  // AMC and CAMC together as a Total group (the user, 26 Nov: "add total ftfr also").
  const TOTAL = 'Total';
  const sum = (parts) => {
    const calls = parts.reduce((x, p) => x + p.calls, 0);
    const fixed = parts.reduce((x, p) => x + p.fixed, 0);
    return { calls, fixed, pct: calls ? (100 * fixed) / calls : null };
  };
  for (const l of lines) l[TOTAL] = sum(types.map((t) => l[t]));
  const total = { label: 'Grand Total' };
  for (const t of [...types, TOTAL]) total[t] = sum(lines.map((l) => l[t]));
  return { types: [...types, TOTAL], lines, total };
}
