/**
 * Loads the meeting workbook's editable columns into Supabase.
 *
 * Only columns S..AO travel: A..R are ticket data, which the dashboard already
 * builds from the TM export and which would go stale here the moment a new
 * export lands. What Supabase holds is the part that exists nowhere else — what
 * people typed in the meeting.
 *
 * Talks to PostgREST over plain fetch rather than a Postgres driver: the direct
 * database host no longer resolves (Supabase retired IPv4 direct connections),
 * and this way the script needs no dependency at all.
 *
 *   node scripts/import-meeting.mjs "path/to/Book1.xlsx" [--state kl] [--dry]
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_KEY from .env.local.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/* ------------------------------------------------------------------ env --- */

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* -------------------------------------------------------------- workbook --- */

/** Central-directory walk, the same approach build-data.mjs uses. */
function openXlsx(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${file} is not a zip — is it a real .xlsx?`);
  const count = buf.readUInt16LE(eocd + 10);
  const entries = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    entries[buf.toString('utf8', p + 46, p + 46 + nameLen)] = {
      lho: buf.readUInt32LE(p + 42), method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20),
    };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return (name) => {
    const e = entries[name];
    if (!e) throw new Error(`missing ${name}`);
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    const raw = buf.subarray(start, start + e.size);
    return e.method === 0 ? raw : zlib.inflateRawSync(raw);
  };
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

/* ----------------------------------------------------------- conversion --- */

/*
 * Most date cells hold a clean Excel serial. A few hold prose, because people
 * recorded revisions by appending to the cell rather than replacing it —
 * "7/11/2026 15-7-26 31-7-26" is one cell, and it is the most informative thing
 * in the row. Those cannot become a `date`, so they are carried across verbatim
 * in `legacy_values` instead of being dropped.
 */
const MIN_SERIAL = 40179; // 2010-01-01
const MAX_SERIAL = 51136; // 2039-12-31

function toDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_SERIAL || n > MAX_SERIAL) return undefined;
  return new Date((n - 25569) * 86400000).toISOString().slice(0, 10);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

const toText = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Columns S..AO of the meeting sheet, in sheet order.
 *
 * W (Standby given date) and AO (Reason for…) are declared but empty in the
 * source — every one of the 7,508 rows leaves them blank. They are mapped
 * anyway so the grid has somewhere to put them from now on.
 */
const FIELDS = [
  ['S', 'penalty_type', toText],
  ['T', 'current_status', toText],
  ['U', 'trc_given_date', toDate],
  ['V', 'trc_spare_received_date', toDate],
  ['W', 'standby_given_date', toDate],
  ['X', 'standby_days', toInt],
  ['Y', 'pi_no', toText],
  ['Z', 'pi_date', toDate],
  ['AA', 'pi_tat', toInt],
  ['AB', 'pr_no', toText],
  ['AC', 'pr_date', toDate],
  ['AD', 'pr_conversion_days', toInt],
  ['AE', 'pr_remark', toText],
  ['AF', 'po_no', toText],
  ['AG', 'po_date', toDate],
  ['AH', 'purchase_delay_days', toInt],
  ['AI', 'vendor_name', toText],
  ['AJ', 'payment_request_date', toDate],
  ['AK', 'payment_date', toDate],
  ['AL', 'spare_edd', toDate],
  ['AM', 'po_remark', toText],
  ['AN', 'payment_issue', toText],
  ['AO', 'not_in_scope_reason', toText],
];

/* -------------------------------------------------------------- reading --- */

function readMeeting(file) {
  const entry = openXlsx(file);

  const shared = [];
  {
    const xml = entry('xl/sharedStrings.xml').toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
      shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    }
  }

  // Resolve the sheet named "meeting" rather than assuming sheet1.xml.
  const book = entry('xl/workbook.xml').toString('utf8');
  const rid = /<sheet[^>]*name="meeting"[^>]*r:id="([^"]+)"/i.exec(book)?.[1];
  const rels = entry('xl/_rels/workbook.xml.rels').toString('utf8');
  const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? 'worksheets/sheet1.xml';
  const sheet = entry(`xl/${target.replace(/^\/?xl\//, '')}`).toString('utf8');

  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c r="([A-Z]+)\d+"([^>]*)>(?:<f[^>]*>[\s\S]*?<\/f>)?(?:<v>([\s\S]*?)<\/v>|<is>([\s\S]*?)<\/is>)?<\/c>/g;
  let r;
  while ((r = rowRe.exec(sheet))) {
    if (+r[1] === 1) continue; // header
    const cells = {};
    let c;
    while ((c = cellRe.exec(r[2]))) {
      const [, col, attrs, v, is] = c;
      const type = /t="([^"]*)"/.exec(attrs)?.[1];
      let value = v ?? '';
      if (type === 's') value = shared[+v] ?? '';
      else if (type === 'str') value = decodeXml(v ?? '');
      else if (is) value = decodeXml([...is.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      if (value !== '') cells[col] = value;
    }
    if (cells.A) rows.push(cells);
  }
  return rows;
}

/* ---------------------------------------------------------------- upload --- */

async function post(pathname, body, headers = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dry = args.includes('--dry');
  const state = (args[args.indexOf('--state') + 1] ?? 'kl').toLowerCase();

  if (!file) {
    console.error('usage: node scripts/import-meeting.mjs <Book1.xlsx> [--state kl] [--dry]');
    process.exit(1);
  }

  const rows = readMeeting(file);
  console.log(`read ${rows.length.toLocaleString()} rows from ${path.basename(file)}`);

  const seen = new Set();
  const notes = [];
  let duplicates = 0;
  let blank = 0;

  for (const cells of rows) {
    const ticket = String(cells.A).trim();
    if (!ticket) continue;
    // A ticket can appear twice in the sheet; the later row wins, matching what
    // someone scrolling to the bottom of the workbook would see.
    if (seen.has(ticket)) duplicates++;
    seen.add(ticket);

    const note = { state, ticket };
    const legacy = {};
    let filled = 0;
    for (const [col, field, cast] of FIELDS) {
      const raw = cells[col];
      if (raw === undefined) { note[field] = null; continue; }
      const value = cast(raw);
      // `undefined` means the cast refused it — keep the original rather than
      // losing what someone actually wrote.
      if (value === undefined) {
        note[field] = null;
        legacy[field] = String(raw).trim();
      } else {
        note[field] = value;
      }
      filled++;
    }
    note.legacy_values = Object.keys(legacy).length ? legacy : null;
    if (filled === 0) { blank++; continue; }
    notes.push(note);
  }

  console.log(`  ${notes.length.toLocaleString()} carry at least one meeting value`);
  console.log(`  ${blank.toLocaleString()} skipped as entirely blank across S..AO`);
  if (duplicates) console.log(`  ${duplicates.toLocaleString()} duplicate tickets collapsed, last row wins`);

  console.log('\nfilled per column:');
  for (const [, field] of FIELDS) {
    const n = notes.filter((x) => x[field] !== null).length;
    const kept = notes.filter((x) => x.legacy_values?.[field]).length;
    if (n || kept) {
      console.log(`  ${field.padEnd(24)} ${String(n).padStart(6)}  ${((n / notes.length) * 100).toFixed(1)}%`
        + (kept ? `   + ${kept} kept verbatim` : ''));
    }
  }

  if (dry) { console.log('\n--dry, nothing written'); return; }
  if (!URL_BASE || !SERVICE_KEY) {
    console.error('\nSUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env.local');
    process.exit(1);
  }

  // Chunked so a failure names the batch it happened in rather than losing the
  // whole run, and so no single request carries 7,000 rows.
  const CHUNK = 500;
  for (let i = 0; i < notes.length; i += CHUNK) {
    const batch = notes.slice(i, i + CHUNK);
    await post('meeting_note?on_conflict=state,ticket', batch, { Prefer: 'resolution=merge-duplicates' });
    console.log(`  upserted ${Math.min(i + CHUNK, notes.length).toLocaleString()} / ${notes.length.toLocaleString()}`);
  }
  console.log('\ndone');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
