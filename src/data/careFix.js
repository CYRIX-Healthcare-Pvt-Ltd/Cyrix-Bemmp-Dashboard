/*
 * Care 360 / Private Service first-time fix (the user, 26 Nov): Job End within 24 hours of Raised, to the minute;
 * a call raised on Saturday has 48 hours (27 Nov; was "until the end of Monday"). Breakdown-only is decided by the callers. The other
 * contracts (KL, AP, UP) keep the shared day rule in shared/schema.mjs.
 */
import { isFirstTimeFix } from '../../shared/schema.mjs';

const CARE = ['c360', 'pvt'];
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

/** "24-01-2026 10:12:58" or an Excel serial → milliseconds (wall clock as UTC); NaN when blank. */
function ms(text) {
  const s = String(text ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return EPOCH + Number(s) * DAY;
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
}

const cache = new WeakMap();

/** 1 = fixed first time, per row, for a care dataset; null for any other contract. */
function fixes(ds) {
  if (!CARE.includes(ds?.meta?.id)) return null;
  let out = cache.get(ds);
  if (out) return out;
  const { cols, dict } = ds;
  const text = (field, i) => { const id = cols[field]?.[i]; return id == null || id < 0 ? '' : dict[field]?.[id] ?? ''; };
  const n = cols.loggedDay.length;
  out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(cols.resolvedDay[i] > 0)) continue;
    const r = ms(text('receivedAt', i)); const e = ms(text('completedAt', i));
    if (!Number.isFinite(r) || !Number.isFinite(e) || e < r) continue;
    const saturday = new Date(r).getUTCDay() === 6;
    out[i] = e - r <= (saturday ? 2 * DAY : DAY) ? 1 : 0;
  }
  cache.set(ds, out);
  return out;
}

/** Whether row i was fixed first time: the care rule above, else the shared day rule. */
export function fixedFirstTime(ds, i, resolvedDay = ds.cols.resolvedDay[i]) {
  const f = fixes(ds);
  return f ? f[i] === 1 : isFirstTimeFix(ds.cols.loggedDay[i], resolvedDay);
}
