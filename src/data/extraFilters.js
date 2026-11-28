/*
 * Add filters (the user, 28 Nov: "all columns in tm and asset master so that user can choose"): any column of the
 * TM export (meta.raw) or of the asset master becomes a tick list in the Filters drawer. A filter is named by its
 * column heading, so a saved view still finds it after the next upload.
 *
 * filters.extra = { 'tm:<heading>' | 'am:<heading>': Set of values }; a key with an empty Set is a filter added and
 * not yet narrowed.
 */
const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Already in the drawer under their own names, so not offered twice. */
const TM_SKIP = new Set(['pmptid', 'mptid', 'state', 'district', 'facilityname', 'equipmentname', 'jobtype', 'contractcategory']);
const AM_SKIP = new Set(['barcode', 'contractcategory']);
/** More values than this is a list nobody ticks through (ids, dates, free text). */
export const MAX_CHOICES = 1500;
export const BLANK = '(Blank)';

/** Masters shared before 28 Nov kept only these. */
const AM_FALLBACK = [['State', 'state'], ['Facility Name', 'facility'], ['District', 'district'], ['Equipment Name', 'equipment']];

function amColumns(assets) {
  if (!assets?.size) return [];
  if (assets.headings?.length && assets.all) {
    return assets.headings.map((h, k) => ({ label: h, get: (code) => assets.all.get(code)?.[k] ?? '' }));
  }
  return AM_FALLBACK.map(([h, f]) => ({ label: h, get: (code) => assets.detail?.get(code)?.[f] ?? '' }));
}

const barcodeOf = (ds, i) => {
  const id = ds.cols.barcode[i];
  return id == null || id < 0 ? '' : String(ds.dict.barcode[id] ?? '').trim();
};

/** Every column on offer: [{ key, label, group }]. */
export function extraFields(ds, assets) {
  const out = [];
  const seen = new Set();
  for (const h of ds?.meta?.raw?.headings ?? []) {
    const k = loose(h);
    if (!k || TM_SKIP.has(k) || seen.has(`tm${k}`)) continue;
    seen.add(`tm${k}`);
    out.push({ key: `tm:${h}`, label: h, group: 'TM export' });
  }
  for (const c of amColumns(assets)) {
    const k = loose(c.label);
    if (!k || AM_SKIP.has(k) || seen.has(`am${k}`)) continue;
    seen.add(`am${k}`);
    out.push({ key: `am:${c.label}`, label: c.label, group: 'Asset master' });
  }
  return out;
}

/** Row → the value that filter reads, or null when the column is not in this upload. */
export function extraReader(ds, assets, key) {
  const [src, ...rest] = key.split(':');
  const name = loose(rest.join(':'));
  if (src === 'tm') {
    const raw = ds?.meta?.raw;
    const at = (raw?.headings ?? []).findIndex((h) => loose(h) === name);
    if (at < 0) return null;
    return (i) => String(raw.rows[i]?.[at] ?? '').trim();
  }
  if (src === 'am') {
    const col = amColumns(assets).find((c) => loose(c.label) === name);
    if (!col) return null;
    return (i) => { const code = barcodeOf(ds, i); return code ? String(col.get(code) ?? '').trim() : ''; };
  }
  return null;
}

/** The values a filter offers, most common first then by name; null when there are too many to tick. */
export function extraOptions(ds, assets, key) {
  const read = extraReader(ds, assets, key);
  if (!read) return [];
  const n = new Map();
  for (let i = 0; i < ds.rows; i++) {
    const v = read(i) || BLANK;
    n.set(v, (n.get(v) ?? 0) + 1);
    if (n.size > MAX_CHOICES) return null;
  }
  return [...n.keys()].sort((a, b) => (a === BLANK) - (b === BLANK) || a.localeCompare(b, undefined, { numeric: true }));
}

/** 1 where the row passes every added filter that has values ticked; null when none narrows. */
export function extraMask(ds, assets, extra) {
  const active = Object.entries(extra ?? {}).filter(([, s]) => s?.size)
    .map(([k, s]) => [extraReader(ds, assets, k), s]).filter(([r]) => r);
  if (!active.length || !ds) return null;
  const m = new Uint8Array(ds.rows);
  for (let i = 0; i < ds.rows; i++) {
    let ok = 1;
    for (const [read, want] of active) if (!want.has(read(i) || BLANK)) { ok = 0; break; }
    m[i] = ok;
  }
  return m;
}

/** The heading a key names. */
export const extraLabel = (key) => key.split(':').slice(1).join(':');
