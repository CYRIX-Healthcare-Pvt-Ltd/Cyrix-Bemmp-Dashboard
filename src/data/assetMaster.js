/*
 * Asset master for Care 360 and Private Service (the user, 26 Nov): Barcode → Contract Category (AMC, CAMC, Non
 * Contract, Warranty, In House, Rental), so FTFR and TATs can be read per contract type. The workbook is read here,
 * in the browser; only those pairs are shared, as datasets/<contract>/assets/<version>.json.gz plus a row in
 * `asset_master` (0091). Any sheet with Barcode and Contract Category headings will do — an asset export, or the
 * team's own "Ticket Master" workbook with its Asset Master sheet.
 *
 * Read with patterns over the sheet's XML rather than a DOM: the asset export is 20 MB, and a DOM of it is several
 * times that in memory on a phone.
 */
import JSZip from 'jszip';
import { supabase } from './supabase.js';

const BUCKET = 'datasets';
const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colOf = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** The cells of one <row>, as column index → text. */
function cellsOf(rowXml, shared) {
  const out = new Map();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(rowXml))) {
    const attrs = m[1];
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
    if (!ref || m[2] == null) continue;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
    let v;
    if (type === 'inlineStr') v = [...m[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
    else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(m[2])?.[1] ?? '';
      v = type === 's' ? shared[Number(raw)] ?? '' : raw;
    }
    out.set(colOf(ref), unxml(String(v)).trim());
  }
  return out;
}

/** The asset's own columns kept beside its category, in this order, for Uptime % by state and customer. */
const EXTRA = [['state', 'state'], ['facility', 'facilityname'], ['district', 'district'], ['equipment', 'equipmentname'],
  // When it joined: an asset mapped after the To date is not in that range's Uptime % (the user, 27 Nov).
  ['mapped', 'dateofmapping']];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "08-May-2025", "08-05-2025" or an Excel serial → Excel day serial; null when it is none of those. */
export function assetDay(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.floor(+t);
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,}|\d{1,2})[-/ ](\d{4})/.exec(t);
  if (!m) return null;
  const mo = /^\d+$/.test(m[2]) ? +m[2] - 1 : MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mo < 0) return null;
  return Math.round((Date.UTC(+m[3], mo, +m[1]) - Date.UTC(1899, 11, 30)) / 864e5);
}

/** Barcode → Contract Category from the first sheet that has both headings. */
export async function readAssetFile(file) {
  let z;
  try { z = await JSZip.loadAsync(file); } catch { throw new Error('Choose the asset master Excel file (.xlsx).'); }
  const shared = [];
  const sst = z.file('xl/sharedStrings.xml');
  if (sst) {
    const text = await sst.async('string');
    for (const si of text.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unxml([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
    }
  }
  const sheets = Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  for (const name of sheets) {
    const text = await z.file(name).async('string');
    const rows = text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g);
    let at = null;
    let seen = 0;
    const pairs = [];
    for (const r of rows) {
      const cells = cellsOf(r[1], shared);
      if (!at) {
        if (++seen > 10) break;
        let bc = -1; let cc = -1;
        const more = {};
        for (const [k, v] of cells) {
          if (loose(v) === 'barcode') bc = k;
          if (loose(v) === 'contractcategory') cc = k;
          for (const [f, h] of EXTRA) if (loose(v) === h) more[f] = k;
        }
        // Every heading too, for Add filters (the user, 28 Nov).
        if (bc >= 0 && cc >= 0) at = { bc, cc, more, heads: [...cells].filter(([, v]) => v).sort((a, b) => a[0] - b[0]) };
        continue;
      }
      const barcode = cells.get(at.bc);
      // [barcode, category, state, facility, district, equipment]: new Map() reads the first two, so older readers
      // still work; the rest is for Uptime % (the user, 27 Nov).
      if (barcode) pairs.push([barcode, cells.get(at.cc) || '', ...EXTRA.map(([f]) => cells.get(at.more[f]) || ''), at.heads.map(([k]) => cells.get(k) || '')]);
    }
    if (at) {
      if (!pairs.length) throw new Error('The asset sheet has its headings but no rows.');
      pairs.headings = at.heads.map(([, v]) => v);
      return pairs;
    }
  }
  throw new Error('No sheet in this file has Barcode and Contract Category columns.');
}

const gzip = async (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = async (blob) => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

/** Counts per category, for the Data panel and the record. */
export function categoriesOf(pairs) {
  const out = {};
  for (const [, c] of pairs) out[c || 'Blank'] = (out[c || 'Blank'] ?? 0) + 1;
  return out;
}

/** Shares a read asset master with the team: the file to storage, then the row naming it current. */
export async function publishAssets(state, pairs, filename) {
  if (!supabase) throw new Error('Not connected.');
  const version = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${state}/assets/${version}.json.gz`;
  // { headings, pairs } once every column is kept (28 Nov); a bare list before.
  const body = await gzip(JSON.stringify(pairs.headings ? { headings: pairs.headings, pairs } : pairs));
  const { data: before } = await supabase.from('asset_master').select('version').eq('state', state).maybeSingle();
  const id = (await supabase.auth.getUser()).data.user?.id ?? null;
  const me = id ? (await supabase.from('profile').select('code, full_name').eq('id', id).maybeSingle()).data : null;
  const up = await supabase.storage.from(BUCKET).upload(path, body, { contentType: 'application/octet-stream', cacheControl: '3600', upsert: false });
  if (up.error) throw new Error('Could not save the asset master. Try again.');
  const { error } = await supabase.from('asset_master').upsert({
    state, rows: pairs.length, filename, bytes: body.size, version, categories: categoriesOf(pairs),
    uploaded_by: id, uploaded_by_code: me?.code ?? null, uploaded_by_name: me?.full_name ?? null, uploaded_at: new Date().toISOString(),
  });
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw new Error('Could not save the asset master. Try again.');
  }
  if (before?.version && before.version !== version) await supabase.storage.from(BUCKET).remove([`${state}/assets/${before.version}.json.gz`]);
}

/** state → its asset_master row. */
export async function listAssetMasters() {
  if (!supabase) return {};
  const { data, error } = await supabase.from('asset_master').select('*');
  if (error) return {};
  return Object.fromEntries((data ?? []).map((r) => [r.state, r]));
}

/** Barcode → category for a contract's current asset master. */
export async function fetchAssets(state, version) {
  const { data, error } = await supabase.storage.from(BUCKET).download(`${state}/assets/${version}.json.gz`);
  if (error) throw new Error(`Could not read the asset master: ${error.message}`);
  const parsed = JSON.parse(await gunzip(data));
  const pairs = Array.isArray(parsed) ? parsed : parsed.pairs ?? [];
  const out = new Map(pairs);
  // Every column of the sheet, for Add filters (masters shared from 28 Nov).
  if (!Array.isArray(parsed) && parsed.headings) {
    out.headings = parsed.headings;
    out.all = new Map(pairs.map((p) => [p[0], p[7] ?? []]));
  }
  // Every barcode with what else the sheet said of it (blank for masters shared before 27 Nov).
  out.detail = new Map(pairs.map(([b, c, state, facility, district, equipment, mapped]) => [
    b, { contract: c || '', state: state || '', facility: facility || '', district: district || '', equipment: equipment || '', mapped: assetDay(mapped) },
  ]));
  return out;
}
