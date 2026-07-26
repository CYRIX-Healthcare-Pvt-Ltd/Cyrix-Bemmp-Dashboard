/**
 * Converts the BEMMP ticket workbooks into the compact artifacts the dashboard loads.
 *
 * The schema, the normalisations and the row pipeline all live in shared/schema.mjs,
 * which `src/data/workbook.js` also uses to parse an uploaded workbook in the browser.
 * Only the Node-specific parts are here: reading the zip and writing the files. Keeping
 * the pipeline in one place is what guarantees the two readers cannot drift apart.
 *
 * Nothing here holds a workbook in memory: zip entries are inflated as streams and rows
 * are consumed as they arrive.
 *
 * Usage:  node scripts/build-data.mjs [stateId ...]     (default: all states)
 * Output: public/data/<stateId>/{meta.json,tickets.bin} + public/data/states.json
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  STATES, Builder, createCellRegex, sharedStringText, FTFR_MAX_DAYS,
} from '../shared/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'BEMMP DATA');
const OUT_DIR = path.join(ROOT, 'public', 'data');

// serve.mjs imports this to report source-vs-artifact freshness.
export { STATES };

/* ------------------------------------------------------------------ zip ---- */

/** Reads the central directory so entries can be inflated by name. */
function readCentralDirectory(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const tailLen = Math.min(size, 66560); // 64 KB comment + 22 byte EOCD
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file: no end-of-central-directory');

  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  fs.closeSync(fd);

  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const fnLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + fnLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

/** Returns a readable stream of one entry's decompressed bytes. */
function openEntry(file, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`missing zip entry: ${name}`);

  // The local header repeats the name/extra fields at their own lengths.
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, e.localOffset);
  fs.closeSync(fd);
  const dataStart = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);

  const raw = fs.createReadStream(file, {
    start: dataStart,
    end: dataStart + e.compressedSize - 1,
    highWaterMark: 1 << 20,
  });
  return e.method === 0 ? raw : raw.pipe(zlib.createInflateRaw({ chunkSize: 1 << 20 }));
}

/** The first worksheet, whatever it is named. */
function sheetEntryName(entries) {
  for (const name of entries.keys()) {
    if (name.startsWith('xl/worksheets/') && name.endsWith('.xml')) return name;
  }
  throw new Error('no worksheet found in workbook');
}

/** Iterates decoded chunks, yielding each complete slice ending in `delim`. */
async function* chunkedBy(stream, delim) {
  let buf = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf(delim)) !== -1) {
      yield buf.slice(0, i);
      buf = buf.slice(i + delim.length);
    }
  }
}

async function loadSharedStrings(file, entries) {
  if (!entries.has('xl/sharedStrings.xml')) return [];
  const strings = [];
  for await (const si of chunkedBy(openEntry(file, entries, 'xl/sharedStrings.xml'), '</si>')) {
    strings.push(sharedStringText(si));
  }
  return strings;
}

/* ------------------------------------------------------------------ main --- */

async function buildState(state) {
  const source = path.join(SOURCE_DIR, state.file);
  if (!fs.existsSync(source)) throw new Error(`source workbook not found: ${source}`);

  const started = Date.now();
  const entries = readCentralDirectory(source);
  const sheet = sheetEntryName(entries);

  process.stdout.write(`[${state.short}] shared strings... `);
  const shared = await loadSharedStrings(source, entries);
  console.log(`${shared.length.toLocaleString()} unique`);

  const builder = new Builder(state);
  const { fieldOf } = builder;
  const cellRe = createCellRegex();
  const field = {};

  process.stdout.write(`[${state.short}] scanning rows... `);
  for await (const row of chunkedBy(openEntry(source, entries, sheet), '</row>')) {
    if (row.indexOf('<row r="1"') !== -1) continue; // header

    for (const k in field) delete field[k];
    let seen = false;
    cellRe.lastIndex = 0;
    let m;
    while ((m = cellRe.exec(row)) !== null) {
      const [, col, type, raw] = m;
      if (raw === undefined) continue;
      const name = fieldOf[col];
      if (!name) continue;
      field[name] = type === 's' ? shared[+raw] : raw;
      seen = true;
    }
    if (!seen) continue;

    builder.addRow(field);
  }
  console.log(`${builder.rows.toLocaleString()} rows`);

  const { buffer, meta } = builder.finish();

  const outDir = path.join(OUT_DIR, state.id);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tickets.bin'), Buffer.from(buffer));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta));

  const iso = (d) => new Date((d - 25569) * 86400000).toISOString().slice(0, 10);
  const sla = Object.entries(state.penaltyDays).map(([k, v]) => `${k} ${v}d`).join(', ');
  const k = meta.kpis;
  console.log(`
  total     ${k.total.toLocaleString()}
  open      ${k.open.toLocaleString()}   (Resolved Date blank AND Ticket Remark blank)
  penalty   ${k.penalty.toLocaleString()}   (open beyond SLA: ${sla})
  parked    ${k.parked.toLocaleString()}
  resolved  ${k.resolved.toLocaleString()}
  FTFR      ${k.ftfrPct.toFixed(1)}%   (${k.firstTimeFixes.toLocaleString()} within ${FTFR_MAX_DAYS} day)
  assets    ${k.uniqueAssets.toLocaleString()} unique, ${k.repeatAssets.toLocaleString()} repeating
  dates     ${iso(meta.dateRange.minDay)} .. ${iso(meta.dateRange.maxDay)}
  written   ${(buffer.byteLength / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s
`);

  return { id: state.id, name: state.name, short: state.short, rows: meta.rows, kpis: k };
}

async function main() {
  const wanted = process.argv.slice(2);
  const targets = wanted.length ? STATES.filter((s) => wanted.includes(s.id)) : STATES;
  if (!targets.length) throw new Error(`unknown state(s): ${wanted.join(', ')}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Keep states already built but not rebuilt this run.
  const indexPath = path.join(OUT_DIR, 'states.json');
  const existing = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    : [];

  const built = [];
  for (const state of targets) built.push(await buildState(state));

  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of built) byId.set(s.id, s);
  const index = STATES.map((s) => byId.get(s.id)).filter(Boolean);

  fs.writeFileSync(indexPath, JSON.stringify(index));
  console.log(`states.json: ${index.map((s) => s.short).join(', ')}`);
}

// Only build when run directly — serve.mjs imports STATES from here to report
// source freshness, and must not trigger a build by importing.
const runDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
