/**
 * Medtronic — a project inside BEMMP that is not a contract export.
 *
 * The contracts are columnar datasets built from a TM export; Medtronic is a
 * list of work orders somebody works through. The manager uploads the ticket
 * master, assigns the work orders to his own team, and each engineer closes
 * theirs with whether the CSAT was taken. It lives in its own tables
 * (supabase/migrations/0012_medtronic.sql), so nothing here touches the
 * dataset pipeline.
 */
import { supabase } from './supabase.js';

/** The project as the switcher lists it, beside the contracts. */
export const MEDTRONIC = { id: 'mt', short: 'MT', name: 'Medtronic' };

/**
 * What this person does in the project. A manager uploads and assigns; a
 * viewer (the manager's own manager, or a BEMMP admin) only looks; an engineer
 * closes the calls given to them.
 */
export function roleOf(me) {
  if (!me) return null;
  if (me.manager) return 'manager';
  if (me.viewer || me.admin) return 'viewer';
  if (me.engineer) return 'engineer';
  return null;
}

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const loadMtMe = () => (supabase ? rpc('mt_me') : Promise.resolve(null));
export const loadMtData = () => rpc('mt_data');
export const uploadTm = (rows, fileName) => rpc('mt_upload', { p_rows: rows, p_file: fileName });
export const assignTickets = (ids, engineerId) => rpc('mt_assign', { p_ids: ids, p_engineer: engineerId });

/** The proof goes up first, into the work order's own folder; the close then names it. */
export async function closeCall(ticketId, csat, file, note) {
  let path = null;
  if (csat && file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    path = `${ticketId}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('mt-proof')
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error(error.message);
  }
  await rpc('mt_close', { p_id: ticketId, p_csat: csat, p_proof: path, p_note: note || null });
}

export async function proofUrl(path) {
  const { data, error } = await supabase.storage.from('mt-proof').createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/* ------------------------------------------------------------ reading TM -- */

/*
 * The TM's headings, matched loosely: lower case, letters and digits only. The
 * created date's heading carries Salesforce's sort note ("Created DateSorted
 * Descending"), so it is matched on its start.
 */
const HEADINGS = [
  ['workordernumber', 'wo'],
  ['sapserviceorderno', 'sap_order'],
  ['sapnotificationnumber', 'sap_notification'],
  ['purposeofvisit', 'purpose'],
  ['account', 'account'],
  ['site', 'site'],
  ['product', 'product'],
  ['createddate', 'created_on', true],
  ['preferredstarttime', 'preferred_start'],
  ['pmplanneddate', 'pm_planned'],
  ['orderstatus', 'order_status'],
  ['city', 'city'],
  ['accountcountry', 'country'],
  ['scheduleddatetime', 'scheduled'],
  ['technician', 'technician'],
  // Added by the manager at the end: an engineer's E-code, to assign it on upload (the user, 31 Oct).
  ['assignto', 'assign_to', true],
];
const DATES = new Set(['created_on', 'pm_planned', 'scheduled']);

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fieldFor(heading) {
  const h = squash(heading);
  const hit = HEADINGS.find(([key, , prefix]) => (prefix ? h.startsWith(key) : h === key));
  return hit?.[1] ?? null;
}

/** An Excel day number, read as the wall-clock time it shows in India. */
function fromSerial(n) {
  const d = new Date(Math.round((n - 25569) * 86400000));
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+05:30`;
}

/** "10/10/2026, 10:30 am" (day first, as the TM writes it) → an ISO time in India. */
function fromText(s) {
  const m = String(s).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?/i);
  if (!m) return null;
  const [, d, mo, y, hh = '0', mm = '00', ap] = m;
  let h = Number(hh);
  if (ap) h = (h % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  const pad = (v) => String(v).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mm}:00+05:30`;
}

const shortWhen = (iso) => new Date(iso).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
});

async function unzipEntries(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66560); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('This is not an Excel file. Choose the TM .xlsx.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    entries.set(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)), { method, size, local });
    p += 46 + nameLen + extra + comment;
  }
  return async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
    const raw = new Blob([buf.subarray(start, start + e.size)]);
    const stream = e.method === 0 ? raw.stream() : raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

/**
 * The TM's rows, keyed by field. Refuses a file without a Work Order Number
 * heading rather than guessing which column holds it.
 */
export async function readTm(file) {
  const open = await unzipEntries(file);
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');

  const shared = [];
  const sst = await open('xl/sharedStrings.xml');
  if (sst) {
    for (const si of parse(sst).getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }
  const sheetXml = await open('xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('No sheet found in this file.');

  const colOf = (ref) => {
    let n = 0;
    for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const grid = [];
  for (const row of parse(sheetXml).getElementsByTagName('row')) {
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent;
      let value;
      if (t === 's') value = shared[Number(v)];
      else if (t === 'inlineStr') value = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (v != null && v !== '' && t !== 'str' && t !== 'b' && t !== 'e') value = Number(v);
      else value = v;
      cells[colOf(c.getAttribute('r') || '')] = value;
    }
    grid.push(cells);
  }

  const headAt = grid.findIndex((r) => r.some((v) => fieldFor(v) === 'wo'));
  if (headAt === -1) throw new Error('This file has no Work Order Number column. Choose the TM export.');
  const fields = grid[headAt].map(fieldFor);

  const rows = [];
  for (const cells of grid.slice(headAt + 1)) {
    const r = {};
    fields.forEach((f, i) => {
      if (!f) return;
      let v = cells[i];
      if (v == null || v === '') return;
      if (DATES.has(f)) {
        const iso = typeof v === 'number' ? fromSerial(v) : fromText(v);
        v = f === 'created_on' ? iso : (iso ? shortWhen(iso) : String(v));
      } else {
        v = String(v).trim();
        if (f === 'assign_to') v = v.toUpperCase();
      }
      if (v) r[f] = v;
    });
    if (r.wo) rows.push(r);
  }
  if (!rows.length) throw new Error('This file has no work orders.');
  return rows;
}

/* ------------------------------------------------------------- figures -- */

/** Today in India, as YYYY-MM-DD — the server's "today" too. */
export const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

/** Whole days between a work order's creation and its close, or today while it is open. */
export function ageDays(t, today = todayIst()) {
  if (!t.created_on) return null;
  const from = new Date(new Date(t.created_on).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const to = t.status === 'closed' && t.closed_on ? t.closed_on : today;
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));
}

export const AGE_BANDS = [
  { id: '0-7', label: '0–7 days', max: 7 },
  { id: '8-15', label: '8–15 days', max: 15 },
  { id: '16-30', label: '16–30 days', max: 30 },
  { id: '31-60', label: '31–60 days', max: 60 },
  { id: '60+', label: 'Over 60 days', max: Infinity },
];
