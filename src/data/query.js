/**
 * Filtering and aggregation over the columnar dataset.
 *
 * Everything is a linear scan of Int32Arrays — at 265k rows a full filter plus
 * aggregate pass is a couple of milliseconds, so there is no index to maintain
 * and no staleness to reason about.
 *
 * Breakdowns must stay one linear pass each. Anything shaped like "for each asset,
 * scan the rows" is O(assets x rows) and will hang the tab.
 */
import { BUCKET } from './store.js';

/**
 * First Time Fix Rate window, in days.
 *
 * A call logged today and resolved today or tomorrow counts as a first-time fix,
 * so the test is `resolvedDay - loggedDay <= 1`. Mirrored in scripts/build-data.mjs.
 */
export const FTFR_MAX_DAYS = 1;

/**
 * Penalty SLA lookup, as an array indexed by equipmentType dictionary id.
 *
 * The window comes from the state's meta (Kerala 7 days for everything; Andhra
 * 2 days for critical, 7 for non-critical). Rows with no equipment type fall back
 * to the non-critical window.
 */
export function penaltyWindows(ds) {
  const table = ds.meta.penaltyDays || {};
  const fallback = table['NON CRITICAL'] ?? 7;
  const out = new Int32Array(ds.dict.equipmentType.length + 1);
  out[0] = fallback; // slot 0 holds the -1 / unknown case
  ds.dict.equipmentType.forEach((name, i) => {
    out[i + 1] = table[name] ?? fallback;
  });
  return out;
}

/**
 * The newest logged date that can hold a penalty call at all.
 *
 * Penalty needs `age > window`, so the last `window` days before the reference
 * date are structurally empty — not "no breaches yet", but "no breach possible
 * yet". Plotted, that reads as a cliff to zero and gets taken for a collapse in
 * the backlog. The shortest window wins, since a date qualifies as soon as *any*
 * criticality could have breached in it.
 */
export function penaltyEligibleThrough(ds, referenceDay) {
  const windows = penaltyWindows(ds);
  let shortest = windows[0];
  for (let i = 1; i < windows.length; i++) {
    if (windows[i] < shortest) shortest = windows[i];
  }
  return referenceDay - shortest - 1;
}

const SUNDAY = 0;
const MS_PER_DAY_ = 86400000;

/** Day of week for an Excel serial, 0 = Sunday. */
function weekday(serial) {
  return new Date((serial - 25569) * MS_PER_DAY_).getUTCDay();
}

/**
 * The last day a call had to be resolved in to still count as a first-time fix.
 *
 * Normally logged + `FTFR_MAX_DAYS`, but Sunday is not a service day: a call
 * logged on Saturday still has Monday to be fixed on the next working day, and
 * one logged Sunday has Monday too.
 */
export function ftfrWindowEnd(loggedDay) {
  const end = loggedDay + FTFR_MAX_DAYS;
  return weekday(end) === SUNDAY ? end + 1 : end;
}

/**
 * Whether a call was fixed inside its window, honouring the Sunday rule.
 *
 * A plain `resolvedDay - loggedDay <= 1` fails every Saturday: the next day is a
 * Sunday nobody works, so Saturday's calls scored a fix rate of about 30% where
 * the surrounding weekdays sat at 60% — a sawtooth that was an artefact of the
 * service week, not of anyone's performance.
 */
export function isFirstTimeFix(loggedDay, resolvedDay) {
  if (resolvedDay <= 0 || resolvedDay < loggedDay) return false;
  return resolvedDay <= ftfrWindowEnd(loggedDay);
}

const MAX_RESOLVED = new WeakMap();

/**
 * The newest resolved date anywhere in the dataset.
 *
 * Distinct from `dateRange.maxDay`, which is the newest *logged* date, and the
 * one that actually bounds what the fix rate can be measured over: resolutions
 * dated after the export was taken are simply not in it.
 */
export function maxResolvedDay(ds) {
  const cached = MAX_RESOLVED.get(ds);
  if (cached !== undefined) return cached;
  const col = ds.cols.resolvedDay;
  let max = 0;
  for (let i = 0; i < col.length; i++) if (col[i] > max) max = col[i];
  MAX_RESOLVED.set(ds, max);
  return max;
}

/**
 * The newest logged date whose fix rate is actually settled.
 *
 * A call logged yesterday can still be resolved today, so yesterday's rate is
 * not final until today is over — plotting it shows a rate computed from a
 * fraction of its eventual denominator, which is why the last point on the chart
 * kept swinging to 0% or 100%.
 *
 * Walks back rather than subtracting a constant, because the Sunday rule makes
 * the gap two days over a weekend and three across Saturday: on a Monday the
 * newest settled date is the Friday before, since Saturday's calls still have
 * that Monday to be fixed on.
 */
export function ftfrSettledThrough(referenceDay, maxResolved = referenceDay) {
  // Bounded by whichever runs out first — the logged dates or the resolved ones.
  // The horizon day itself is excluded because the export is usually taken part
  // way through it: on this dataset the last logged day carries 39 calls against
  // a normal 270, and almost no resolutions at all.
  const horizon = Math.min(referenceDay, maxResolved || referenceDay);
  let day = horizon - 1;
  while (day > 0 && ftfrWindowEnd(day) >= horizon) day--;
  return day;
}

/** Whether one open row has breached its SLA as of `referenceDay`. */
export function isPenalty(ds, windows, referenceDay, row) {
  if (ds.cols.bucket[row] !== BUCKET.OPEN) return false;
  const logged = ds.cols.loggedDay[row];
  if (logged <= 0) return false;
  // Strictly greater: a call logged 1 July breaches on 9 July (age 8), not 8 July.
  return referenceDay - logged > windows[ds.cols.equipmentType[row] + 1];
}

/**
 * Applies the active filters and returns the matching row indices.
 * `filters.district` etc. are Sets of dictionary ids; an empty Set means "all".
 */
export function filterRows(ds, filters, { dateField = 'loggedDay' } = {}) {
  const { cols, rows } = ds;
  const { dayFrom, dayTo, district, facilityType, equipmentType, bucket } = filters;
  // dateField null means "every date" — used by the accrual view, where a ticket
  // logged long before the period is still running up penalty inside it.
  const dateCol = dateField ? cols[dateField] : null;

  const out = new Int32Array(rows);
  let n = 0;

  for (let i = 0; i < rows; i++) {
    if (dateCol) {
      // Unresolved rows carry -1, so a resolvedDay window drops them automatically.
      const day = dateCol[i];
      if (day < 0) continue;
      if (dayFrom != null && day < dayFrom) continue;
      if (dayTo != null && day > dayTo) continue;
    }
    if (district.size && !district.has(cols.district[i])) continue;
    if (facilityType.size && !facilityType.has(cols.facilityType[i])) continue;
    if (equipmentType.size && !equipmentType.has(cols.equipmentType[i])) continue;
    if (bucket.size && !bucket.has(cols.bucket[i])) continue;
    out[n++] = i;
  }
  return out.subarray(0, n);
}

/** Headline counts for the current selection. */
export function summarize(ds, idx, referenceDay) {
  const { cols } = ds;
  const windows = penaltyWindows(ds);
  const counts = [0, 0, 0];
  let downDaysTotal = 0;
  let resolvedWithDates = 0;
  let resolutionDaysTotal = 0;
  let firstTimeFixes = 0;
  let penalty = 0;

  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    counts[cols.bucket[i]]++;
    downDaysTotal += cols.downDays[i];

    if (cols.bucket[i] === BUCKET.OPEN && isPenalty(ds, windows, referenceDay, i)) penalty++;

    const r = cols.resolvedDay[i];
    if (r > 0) {
      const d = r - cols.loggedDay[i];
      if (d >= 0) {
        resolutionDaysTotal += d;
        resolvedWithDates++;
        if (d <= FTFR_MAX_DAYS) firstTimeFixes++;
      }
    }
  }

  const resolved = counts[BUCKET.RESOLVED];
  return {
    total: idx.length,
    open: counts[BUCKET.OPEN],
    parked: counts[BUCKET.PARKED],
    resolved,
    penalty,
    firstTimeFixes,
    // Denominator is resolved calls only — an open call has no fix to rate.
    ftfrPct: resolved ? (firstTimeFixes / resolved) * 100 : 0,
    avgResolutionDays: resolvedWithDates ? resolutionDaysTotal / resolvedWithDates : 0,
    avgDownDays: idx.length ? downDaysTotal / idx.length : 0,
  };
}

/** Rows in one lifecycle bucket. */
export function rowsInBucket(ds, idx, bucket) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    if (ds.cols.bucket[idx[k]] === bucket) out.push(idx[k]);
  }
  return out;
}

/* --------------------------------------------------------------- penalty --- */

/**
 * Penalty money, following "KL Penalty Logic.xlsx".
 *
 * The workbook is written against `TODAY()` and the first of the current month.
 * Here those become the selected date range, so the same arithmetic answers "what
 * did June cost" as well as "what is accruing now":
 *
 *   start = max(logged + grace + 1, from)      column AN
 *   end   = resolved > 0 ? min(resolved, to) : to    column AO
 *   days  = max(end - start + 1, 0)            column AS
 *   accrued = days * dayRate                   column AT
 *
 * `dayRate` is column AU — the Asset Value band, already zeroed at build time for
 * tickets column AL exempts (RBER date, any ticket remark, or standby).
 */
export function penaltyStartDay(ds, row) {
  return ds.cols.loggedDay[row] + (ds.meta.graceDays ?? 7) + 1;
}

/** Days of penalty a ticket accrues inside [from, to]. */
export function penaltyDaysIn(ds, row, from, to) {
  const { cols } = ds;
  const resolved = cols.resolvedDay[row];
  const start = Math.max(penaltyStartDay(ds, row), from);
  const end = resolved > 0 ? Math.min(resolved, to) : to;
  return Math.max(end - start + 1, 0);
}

/** Rupees a ticket accrues inside [from, to]. */
export function penaltyAmountIn(ds, row, from, to) {
  return penaltyDaysIn(ds, row, from, to) * ds.cols.dayRate[row];
}

/**
 * Closure penalty, column AZ: `(resolved - (logged + grace + 1) + 1) * dayRate`.
 *
 * Clamped at zero. The workbook does not clamp, so a ticket closed inside its
 * grace period yields a negative figure there; a negative penalty is not a
 * meaningful number to report, and those tickets owe nothing.
 */
export function closurePenalty(ds, row) {
  const span = ds.cols.resolvedDay[row] - penaltyStartDay(ds, row) + 1;
  return Math.max(span, 0) * ds.cols.dayRate[row];
}

/**
 * Tickets **closed** inside [from, to], whenever they were logged.
 *
 * Closure penalty is settled on the closing date, so this deliberately filters on
 * Resolved Date rather than Logged Date — the rest of the dashboard filters on
 * when a call came in.
 */
export function closedInRange(ds, from, to) {
  const { cols, rows } = ds;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const r = cols.resolvedDay[i];
    if (r > 0 && r >= from && r <= to) out.push(i);
  }
  return out;
}

/**
 * Rows currently accruing penalty: **open**, past grace, and not exempt.
 *
 * The open test is the point of this function. Per-day penalty is a burn rate —
 * what the contract is costing today — so a ticket that has been closed is not
 * accruing anything, however much it accrued before it closed. Dropping the test
 * pulls in every ticket that merely *finished* accruing inside the window, which
 * roughly doubles both the count and the daily figure; what those tickets owe is
 * the closure penalty, reported separately by `closurePenalty`.
 *
 * Parked rows are already excluded upstream: any Ticket Remark makes a ticket
 * penalty-exempt, which zeroes its `dayRate`.
 */
export function accruingRows(ds, idx, from, to) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (ds.cols.bucket[i] !== BUCKET.OPEN) continue;
    if (ds.cols.dayRate[i] > 0 && penaltyDaysIn(ds, i, from, to) > 0) out.push(i);
  }
  return out;
}

/** Open rows past their SLA window. */
export function penaltyRows(ds, idx, referenceDay) {
  const windows = penaltyWindows(ds);
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    if (isPenalty(ds, windows, referenceDay, idx[k])) out.push(idx[k]);
  }
  return out;
}

/** Narrows an existing selection to rows whose `column` equals `value`. */
export function rowsWhere(ds, idx, column, value) {
  const col = ds.cols[column];
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    if (col[idx[k]] === value) out.push(idx[k]);
  }
  return out;
}

/**
 * Repeat analysis: assets carrying more than one ticket inside the selection.
 *
 * Counts are scoped to the rows handed in, so narrowing the date range or drilling
 * into a district genuinely re-derives which assets are repeat offenders rather
 * than filtering a precomputed all-time list.
 */
export function analyzeRepeats(ds, idx) {
  const { cols, dict } = ds;
  const perAsset = new Int32Array(dict.barcode.length);

  for (let k = 0; k < idx.length; k++) {
    const b = cols.barcode[idx[k]];
    if (b >= 0) perAsset[b]++;
  }

  // Second pass: collect every ticket belonging to a repeat asset.
  const rows = [];
  const latestRow = new Map(); // barcode id -> representative row
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const b = cols.barcode[i];
    if (b < 0 || perAsset[b] < 2) continue;
    rows.push(i);
    // Rows arrive newest-first, so the first one seen is the latest.
    if (!latestRow.has(b)) latestRow.set(b, i);
  }

  const assets = [];
  for (const [barcode, row] of latestRow) {
    assets.push({ barcode, row, count: perAsset[barcode] });
  }
  assets.sort((a, b) => b.count - a.count);

  return {
    perAsset,
    assets,
    rows,
    repeatAssets: assets.length,
    // Every ticket sitting on a repeat asset — the denominator for breakdowns.
    repeatTickets: rows.length,
    // Calls that were themselves a repeat, i.e. the 2nd and later call on an asset.
    followUps: rows.length - assets.length,
  };
}

/** Every ticket for one asset, newest first. */
export function ticketsForAsset(ds, idx, barcodeId) {
  const { cols } = ds;
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (cols.barcode[i] === barcodeId) out.push(i);
  }
  return out;
}

/**
 * Groups by dictionary id and accumulates a per-row quantity.
 *
 * Returns `{ n, sum }` per group, which covers every non-count measure the
 * dashboard needs: a rate is `sum / n` where the quantity is 1 or 0, and a mean is
 * `sum / n` where it is the value itself.
 */
export function aggregateBy(ds, idx, column, valueOf) {
  const col = ds.cols[column];
  const map = new Map();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const key = col[i];
    let g = map.get(key);
    if (!g) { g = { n: 0, sum: 0 }; map.set(key, g); }
    g.n++;
    g.sum += valueOf(i);
  }
  return map;
}

/** Resolved rows only — the denominator for anything about fix quality. */
export function resolvedRows(ds, idx) {
  const { cols } = ds;
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (cols.resolvedDay[i] > 0 && cols.resolvedDay[i] - cols.loggedDay[i] >= 0) out.push(i);
  }
  return out;
}

/** Counts by dictionary id for one column. */
export function countBy(ds, idx, column) {
  const { cols } = ds;
  const col = cols[column];
  const map = new Map();
  for (let k = 0; k < idx.length; k++) {
    const v = col[idx[k]];
    map.set(v, (map.get(v) || 0) + 1);
  }
  return map;
}

/** Turns a count map into a sorted, labelled list. */
export function topN(map, dictionary, n = 10, blank = '—') {
  return [...map.entries()]
    .map(([id, value]) => ({ id, label: id < 0 ? blank : dictionary[id], value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

const MS_PER_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Serial -> the serial that starts its bucket, so periods sort numerically. */
function periodStart(serial, granularity) {
  if (granularity === 'day') return serial;
  const d = new Date((serial - 25569) * MS_PER_DAY);
  if (granularity === 'week') {
    // ISO weeks start Monday; getUTCDay() is 0 for Sunday.
    return serial - ((d.getUTCDay() + 6) % 7);
  }
  return serial - (d.getUTCDate() - 1); // month
}

function periodLabel(serial, granularity) {
  const d = new Date((serial - 25569) * MS_PER_DAY);
  const mon = MONTHS[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(2);
  if (granularity === 'month') return `${mon} ${yy}`;
  return `${String(d.getUTCDate()).padStart(2, '0')} ${mon} ${yy}`;
}

/** A sensible default granularity for the span currently selected. */
export function defaultGranularity(dayFrom, dayTo) {
  const span = dayTo - dayFrom;
  if (span > 240) return 'month';
  if (span > 60) return 'week';
  return 'day';
}

/**
 * Every charted metric, bucketed by period in a single pass.
 *
 * All four charts read from one result so switching between them costs nothing
 * and their periods always line up.
 *
 *   volume    calls logged in the period
 *   ftfrPct   share of the period's *logged* calls fixed inside their window
 *   repeats   calls that were not the first on their asset
 *   penalties calls currently open past SLA, placed in the period they were logged
 *
 * The fix rate here divides by calls **logged**, not by calls resolved — the one
 * place in the dashboard where it does, and deliberately. Over a whole date range
 * the two agree closely, but per period the resolved-only denominator is broken:
 * it only contains the calls that have been resolved *so far*, and the fast ones
 * land first. The most recent periods therefore start at 100% and sink for weeks
 * as the slow resolutions arrive. Dividing by calls logged settles two days after
 * the period and never moves again, which is what a trend line needs.
 */
export function buildSeries(ds, idx, granularity, referenceDay) {
  const { cols, dict } = ds;

  // A call is a repeat if the same asset was logged earlier in this selection, so
  // the flag needs chronological order rather than the file's newest-first order.
  const chronological = Array.from(idx);
  chronological.sort((a, b) => cols.loggedDay[a] - cols.loggedDay[b]);
  const firstSeen = new Uint8Array(dict.barcode.length);
  const isRepeat = new Set();
  for (const i of chronological) {
    const b = cols.barcode[i];
    if (b < 0) continue;
    if (firstSeen[b]) isRepeat.add(i);
    else firstSeen[b] = 1;
  }

  const windows = penaltyWindows(ds);
  const periods = new Map();

  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const day = cols.loggedDay[i];
    if (day < 0) continue;

    const start = periodStart(day, granularity);
    let p = periods.get(start);
    if (!p) {
      p = {
        key: start,
        label: periodLabel(start, granularity),
        volume: 0, open: 0, parked: 0, resolved: 0,
        fixes: 0, repeats: 0, penalties: 0,
      };
      periods.set(start, p);
    }

    p.volume++;
    const bucket = cols.bucket[i];
    if (bucket === BUCKET.OPEN) p.open++;
    else if (bucket === BUCKET.PARKED) p.parked++;
    else p.resolved++;

    if (isFirstTimeFix(day, cols.resolvedDay[i])) p.fixes++;

    if (isRepeat.has(i)) p.repeats++;
    if (isPenalty(ds, windows, referenceDay, i)) p.penalties++;
  }

  const out = [...periods.values()].sort((a, b) => a.key - b.key);
  for (const p of out) p.ftfrPct = p.volume ? (p.fixes / p.volume) * 100 : 0;
  return out;
}
