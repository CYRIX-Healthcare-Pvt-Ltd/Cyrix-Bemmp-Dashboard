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
        for (const [k, v] of cells) {
          if (loose(v) === 'barcode') bc = k;
          if (loose(v) === 'contractcategory') cc = k;
        }
        if (bc >= 0 && cc >= 0) at = { bc, cc };
        continue;
      }
      const barcode = cells.get(at.bc);
      if (barcode) pairs.push([barcode, cells.get(at.cc) || '']);
    }
    if (at) {
      if (!pairs.length) throw new Error('The asset sheet has its headings but no rows.');
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
  const body = await gzip(JSON.stringify(pairs));
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
  return new Map(JSON.parse(await gunzip(data)));
}
