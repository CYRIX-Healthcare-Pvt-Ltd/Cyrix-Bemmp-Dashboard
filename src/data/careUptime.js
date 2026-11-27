/*
 * Care 360 Uptime % (the user, 27 Nov).
 *
 * The days are the dashboard's From – To, both ends counted (1–27 Nov is 27 days; All time is its own From – To).
 * A barcode is down from the day a Breakdown call is raised until the day it ends; a call still open is down to the
 * last day, and one raised before From is counted from From. Calls on the same barcode that overlap count their days
 * once. Uptime = (days − down days) / days.
 *
 * Every barcode in the asset master counts: one with no call is 100%. The overall figure, and each state's, customer's
 * and contract's, is the plain average over those barcodes.
 */
import { filterRows } from './query.js';
import { careTicketId, ticketContract } from './careReport.js';

const text = (ds, key, i) => {
  const id = ds.cols[key]?.[i];
  return id == null || id < 0 ? '' : String(ds.dict[key]?.[id] ?? '').trim();
};
const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const UNKNOWN = 'Not given';

/**
 * Per barcode and overall. `filters` are the dashboard's; their dates set the days, and the rest narrow the calls and
 * (by name) the asset master's barcodes. Null when there is no asset master to count against.
 */
export function careUptime(ds, filters, assets) {
  if (!ds || !filters || !assets?.size) return null;
  const from = filters.dayFrom; const to = filters.dayTo;
  const days = to - from + 1;
  if (!(days > 0)) return null;

  // Every call matching the filters whatever its date: one raised in September and still open is down in October.
  const rows = filterRows(ds, filters, { dateField: null });
  const bdMemo = new Map();
  const isBreakdown = (i) => {
    const id = ds.cols.lifecycle[i];
    if (!bdMemo.has(id)) bdMemo.set(id, /breakdown/i.test(ds.dict.lifecycle?.[id] ?? ''));
    return bdMemo.get(id);
  };

  const byCode = new Map(); // barcode → { spans: [[a, b)], calls, last row }
  for (const i of rows) {
    if (!isBreakdown(i)) continue;
    const code = text(ds, 'barcode', i);
    if (!code) continue;
    const logged = ds.cols.loggedDay[i];
    if (!(logged >= 0) || logged > to) continue;
    const ended = ds.cols.resolvedDay[i];
    const end = ended >= 0 ? ended : to + 1; // open: down through the last day
    const a = Math.max(logged, from); const b = Math.min(end, to + 1);
    let e = byCode.get(code);
    if (!e) { e = { spans: [], calls: 0, row: i, tickets: [] }; byCode.set(code, e); }
    e.row = i;
    if (b > a) {
      e.spans.push([a, b]); e.calls++;
      // The calls behind the figure, for a press on the barcode (the user, 27 Nov).
      e.tickets.push({ ticket: careTicketId(ds, i), raised: logged, ended: ended >= 0 ? ended : null, status: text(ds, 'status', i), down: b - a });
    }
  }

  // The asset master's barcodes, narrowed by the dashboard's state / district / customer / contract by name.
  const want = (key) => (filters[key]?.size ? new Set([...filters[key]].map((id) => loose(ds.dict[key]?.[id]))) : null);
  const wantState = want('zone'); const wantDistrict = want('district'); const wantFacility = want('facilityName');
  const wantContract = filters.contract ? loose(filters.contract) : null;
  const detail = assets.detail ?? new Map();

  const list = [];
  for (const [code, category] of assets) {
    const d = detail.get(code) ?? {};
    // Mapped after the To date: not counted. Mapped by then: every day of the range (the user, 27 Nov).
    if (d.mapped != null && d.mapped > to) continue;
    const e = byCode.get(code);
    const r = e?.row;
    const state = d.state || (r != null ? text(ds, 'zone', r) : '') || UNKNOWN;
    const customer = d.facility || (r != null ? text(ds, 'facilityName', r) : '') || UNKNOWN;
    const district = d.district || (r != null ? text(ds, 'district', r) : '') || '';
    const contract = (r != null ? ticketContract(ds, r) : '') || category || UNKNOWN;
    if (wantState && !wantState.has(loose(state))) continue;
    if (wantDistrict && !wantDistrict.has(loose(district))) continue;
    if (wantFacility && !wantFacility.has(loose(customer))) continue;
    if (wantContract && loose(contract) !== wantContract) continue;
    let down = 0;
    const spans = e?.spans ?? [];
    if (spans.length) {
      // Overlapping calls count their days once.
      const s = spans.sort((x, y) => x[0] - y[0]);
      let [a, b] = s[0];
      for (let k = 1; k < s.length; k++) {
        if (s[k][0] <= b) b = Math.max(b, s[k][1]);
        else { down += b - a; [a, b] = s[k]; }
      }
      down += b - a;
    }
    list.push({
      barcode: code, state, customer, district, contract,
      equipment: d.equipment || (r != null ? text(ds, 'equipment', r) : ''),
      calls: e?.calls ?? 0, down, uptime: (days - down) / days, tickets: e?.tickets ?? [],
    });
  }
  return { days, from, to, list, ...summaryOf(list) };
}

/** Assets, those with down days, down days, and the average uptime of a set of barcodes. */
export function summaryOf(list) {
  let sum = 0; let downAssets = 0; let downDays = 0; let calls = 0;
  for (const b of list) { sum += b.uptime; downDays += b.down; calls += b.calls; if (b.down > 0) downAssets++; }
  // Customers counted within their state: one hospital name in two states is two customers.
  const customers = new Set(list.map((b) => `${b.customer}\u0000${b.state}`)).size;
  return { assets: list.length, customers, downAssets, downDays, calls, uptime: list.length ? sum / list.length : null };
}

/** Groups by one key (state, customer, contract), lowest uptime first. */
export function uptimeBy(list, key) {
  const m = new Map();
  for (const b of list) {
    const k = b[key] || UNKNOWN;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return [...m].map(([name, items]) => ({ name, items, ...summaryOf(items) }))
    .sort((a, b) => a.uptime - b.uptime || b.assets - a.assets);
}

/**
 * The Report's Uptime % columns (the user, 27 Nov): each line's uptime in the From and To months, in percent, and the
 * change as the other columns show it, a fraction of the From month's. A month runs to its last day, or to the export's last day for the month still running.
 */
export function withUptime(ds, filters, assets, report, { month, against, by }) {
  if (!report || !assets?.size) return report;
  const last = ds.meta.dateRange?.maxDay ?? Infinity;
  const of = (m) => (m ? careUptime(ds, { ...filters, dayFrom: m.from, dayTo: Math.min(m.to, last) }, assets) : null);
  const uA = of(month);
  const uB = against && against.key !== month.key ? of(against) : null;
  const key = (n, s) => (by === 'facility' ? `${loose(n)}|${loose(s)}` : loose(n));
  const index = (u) => {
    const m = new Map();
    if (!u) return m;
    if (by !== 'facility') {
      for (const g of uptimeBy(u.list, 'state')) m.set(key(g.name), g.uptime);
      return m;
    }
    // A customer is named within its state.
    for (const g of uptimeBy(u.list, 'customer')) {
      for (const s of uptimeBy(g.items, 'state')) m.set(key(g.name, s.name), s.uptime);
    }
    return m;
  };
  const a = index(uA);
  const b = index(uB);
  const pct = (v) => (v == null ? null : v * 100);
  const add = (line, ua, ub) => ({
    ...line, uptimeA: pct(ua), uptimeB: pct(ub), uptimeChange: ua != null && ub ? (ua - ub) / ub : null,
  });
  return {
    ...report,
    hasUptime: true,
    lines: report.lines.map((l) => {
      const k = key(l.name, l.state);
      return add(l, a.get(k) ?? null, b.get(k) ?? null);
    }),
    total: add(report.total, uA?.uptime ?? null, uB?.uptime ?? null),
  };
}

/**
 * FTFR · Contract wise's Uptime % groups (the user, 27 Nov): per month, AMC, CAMC and the two together, as assets,
 * assets down and uptime; Grand Total over the whole span. A month still running ends on the export's last day.
 */
export function uptimeByContract(ds, filters, assets, months, types = ['AMC', 'CAMC']) {
  if (!assets?.size || !months.length) return null;
  const last = ds.meta.dateRange?.maxDay ?? Infinity;
  const TOTAL = 'Total';
  const part = (list) => {
    const s = summaryOf(list);
    return { assets: s.assets, downAssets: s.downAssets, uptime: s.uptime };
  };
  const row = (label, from, to) => {
    const u = careUptime(ds, { ...filters, dayFrom: from, dayTo: Math.min(to, last) }, assets);
    const out = { label };
    const list = u ? u.list : [];
    for (const t of types) out[t] = part(list.filter((b) => b.contract === t));
    out[TOTAL] = part(list.filter((b) => types.includes(b.contract)));
    return out;
  };
  const lines = months.map((m) => row(m.label, m.from, m.to));
  const total = row('Grand Total', Math.min(...months.map((m) => m.from)), Math.max(...months.map((m) => m.to)));
  return { types: [...types, TOTAL], lines, total };
}
