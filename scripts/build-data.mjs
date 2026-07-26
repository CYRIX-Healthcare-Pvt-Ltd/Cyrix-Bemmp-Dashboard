/**
 * Converts the BEMMP ticket workbooks into the compact artifacts the dashboard loads.
 *
 * Each state's export has its own schema, so a state is described by a config below
 * (column letters, penalty SLA, id formats) and the rest of the pipeline is shared.
 *
 * Nothing here holds a workbook in memory: zip entries are inflated as streams and
 * rows are consumed as they arrive. Categorical values are interned into dictionaries
 * and every column is emitted as an Int32Array.
 *
 * Usage:  node scripts/build-data.mjs [stateId ...]     (default: all states)
 * Output: public/data/<stateId>/{meta.json,tickets.bin} + public/data/states.json
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'BEMMP DATA');
const OUT_DIR = path.join(ROOT, 'public', 'data');

/* ---------------------------------------------------------------- states ---- */

/**
 * Penalty SLA, in days, keyed by normalised equipment type.
 *
 * A call breaches when `age > window`, where age counts full days after the logged
 * date — a call logged 1 July is on penalty on 9 July (age 8), not 8 July (age 7).
 * The logged date itself is never counted, which is why the test is strict.
 */
export const STATES = [
  {
    id: 'kl',
    name: 'Kerala',
    short: 'KL',
    file: 'TM-KL.xlsx',
    barcodeWidth: 7,
    penaltyDays: { CRITICAL: 7, 'NON CRITICAL': 7 },
    ticket: 'A',
    categorical: {
      B: 'barcode', D: 'zone', E: 'district', F: 'facilityType', G: 'facilityName',
      H: 'model', I: 'department', J: 'deviceGroup', K: 'equipment', L: 'equipmentType',
      N: 'manufacturer', V: 'status', W: 'engineer', X: 'parkedReason', AG: 'lifecycle',
    },
    numeric: { P: 'loggedDay', Q: 'resolvedDay', AI: 'downDays' },
  },
  {
    id: 'ap',
    name: 'Andhra Pradesh',
    short: 'AP',
    file: 'TM-AP.xlsx',
    barcodeWidth: 8,
    penaltyDays: { CRITICAL: 2, 'NON CRITICAL': 7 },
    ticket: 'A',
    categorical: {
      B: 'barcode', D: 'district', E: 'facilityType', F: 'facilityName',
      G: 'model', H: 'department', I: 'deviceGroup', J: 'equipment', AA: 'equipmentType',
      L: 'manufacturer', V: 'status', W: 'engineer', X: 'parkedReason',
    },
    numeric: {
      N: 'loggedDay', P: 'resolvedDay', AB: 'downDays',
      AC: 'penaltyDays', AD: 'penaltyAmount',
    },
  },
];

// Emitted column order, shared by every state. Fields a state does not supply stay
// at the -1 / 0 sentinel so the reader never needs to branch per state.
const COLUMNS = [
  'ticketNo', 'ticketPrefix', 'barcode', 'zone', 'district', 'facilityType',
  'facilityName', 'model', 'department', 'deviceGroup', 'equipment', 'equipmentType',
  'manufacturer', 'status', 'engineer', 'lifecycle', 'parkedReason',
  'loggedDay', 'resolvedDay', 'downDays', 'penaltyDays', 'penaltyAmount', 'bucket',
];

const CATEGORICAL_FIELDS = [
  'ticketPrefix', 'barcode', 'zone', 'district', 'facilityType', 'facilityName',
  'model', 'department', 'deviceGroup', 'equipment', 'equipmentType', 'manufacturer',
  'status', 'engineer', 'lifecycle', 'parkedReason',
];

// Free-text columns where capitalisation varies row to row and carries no meaning.
const FOLD_CASE = new Set([
  'facilityName', 'model', 'department', 'deviceGroup', 'equipment', 'manufacturer',
]);

export const BUCKET = { OPEN: 0, PARKED: 1, RESOLVED: 2 };

/**
 * First Time Fix Rate window, in days: logged today and resolved today or tomorrow.
 * Mirrored in src/data/query.js.
 */
export const FTFR_MAX_DAYS = 1;

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

/* ------------------------------------------------------------------ xml ---- */

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (m, g) =>
    (g[0] === '#' ? String.fromCharCode(+g.slice(1)) : ENTITIES[g]));
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
  const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  for await (const si of chunkedBy(openEntry(file, entries, 'xl/sharedStrings.xml'), '</si>')) {
    // A shared string can be split across several <t> runs when it carries formatting.
    let text = '';
    tRe.lastIndex = 0;
    let m;
    while ((m = tRe.exec(si)) !== null) text += m[1];
    strings.push(decodeXml(text));
  }
  return strings;
}

/* ----------------------------------------------------------------- model --- */

/**
 * Interns strings to dense indices; -1 is reserved for blank.
 *
 * With `foldCase`, entries differing only in capitalisation collapse to one id —
 * the source has "Dialysis Machine" and "Dialysis machine" as separate spellings of
 * one equipment type, which otherwise splits the counts the dashboard exists to
 * report. The label shown is whichever spelling occurs most often.
 */
class Dict {
  constructor(foldCase = false) {
    this.fold = foldCase;
    this.index = new Map();
    this.values = [];
    this.variants = [];
  }

  id(v) {
    if (v === undefined || v === null) return -1;
    const s = String(v).trim();
    if (s === '') return -1;

    const key = this.fold ? s.toLowerCase() : s;
    let i = this.index.get(key);

    if (i === undefined) {
      i = this.values.length;
      this.values.push(s);
      this.index.set(key, i);
      if (this.fold) this.variants.push(new Map([[s, 1]]));
      return i;
    }

    if (this.fold) {
      const seen = this.variants[i];
      const count = (seen.get(s) || 0) + 1;
      seen.set(s, count);
      if (count > seen.get(this.values[i])) this.values[i] = s;
    }
    return i;
  }
}

/** Excel drops the leading zero on barcodes stored as numbers. */
function normalizeBarcode(v, width) {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return /^\d+$/.test(s) && s.length < width ? s.padStart(width, '0') : s;
}

/** Only KASARGODE is shouted; the other districts are title case. */
function normalizeDistrict(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s !== s.toUpperCase()) return s;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Kerala writes `CRITICAL`/`NON CRITICAL`, Andhra writes `Critical`/`Non-Critical`.
 * The penalty rule keys off this value, so both collapse to one vocabulary.
 */
function normalizeEquipmentType(v) {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return s.toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Ticket ids are `281191` in Kerala and `AP65522` in Andhra, with a few bare
 * numbers mixed in. Splitting the alpha prefix from the number keeps the id exact
 * while storing it as one small dictionary plus an Int32 rather than 265k strings.
 */
function splitTicket(v) {
  const s = String(v ?? '').trim();
  if (s === '') return { prefix: '', number: -1 };
  const m = /^([A-Za-z]*)(\d+)$/.exec(s);
  if (!m) return { prefix: s, number: -1 };
  return { prefix: m[1], number: Number(m[2]) };
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

  // Column letter -> field name, for this state only.
  const fieldOf = { ...state.categorical, ...state.numeric, [state.ticket]: 'ticket' };

  const dicts = {};
  for (const f of CATEGORICAL_FIELDS) dicts[f] = new Dict(FOLD_CASE.has(f));

  const cols = {};
  let capacity = 1 << 18;
  for (const c of COLUMNS) cols[c] = new Int32Array(capacity);
  const grow = () => {
    capacity *= 2;
    for (const c of COLUMNS) {
      const next = new Int32Array(capacity);
      next.set(cols[c]);
      cols[c] = next;
    }
  };

  let rows = 0;
  let minDay = Infinity;
  let maxDay = -Infinity;
  const bucketTotals = [0, 0, 0];
  let firstTimeFixes = 0;

  // Matches both self-closing cells and cells carrying a <v> value.
  const cellRe = /<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:\/>|>(?:<v>([\s\S]*?)<\/v>|<is>[\s\S]*?<\/is>)?<\/c>)/g;

  process.stdout.write(`[${state.short}] scanning rows... `);
  const field = {};
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

    if (rows === capacity) grow();

    // Unresolved rows carry a literal " " in Kerala and an empty cell in Andhra,
    // so blankness is tested before any date parsing.
    const resolvedRaw = String(field.resolvedDay ?? '').trim();
    const resolved = resolvedRaw !== '' && Number.isFinite(+resolvedRaw);
    const parkedId = dicts.parkedReason.id(String(field.parkedReason ?? '').trim().toLowerCase());
    const bucket = resolved ? BUCKET.RESOLVED : (parkedId === -1 ? BUCKET.OPEN : BUCKET.PARKED);

    const loggedRaw = String(field.loggedDay ?? '').trim();
    const loggedDay = Number.isFinite(+loggedRaw) && +loggedRaw > 0 ? Math.floor(+loggedRaw) : -1;
    if (loggedDay > 0) {
      if (loggedDay < minDay) minDay = loggedDay;
      if (loggedDay > maxDay) maxDay = loggedDay;
    }
    const resolvedDay = resolved ? Math.floor(+resolvedRaw) : -1;
    const ticket = splitTicket(field.ticket);

    cols.ticketNo[rows] = ticket.number;
    cols.ticketPrefix[rows] = dicts.ticketPrefix.id(ticket.prefix);
    cols.barcode[rows] = dicts.barcode.id(normalizeBarcode(field.barcode, state.barcodeWidth));
    cols.zone[rows] = dicts.zone.id(field.zone);
    cols.district[rows] = dicts.district.id(normalizeDistrict(field.district));
    cols.facilityType[rows] = dicts.facilityType.id(field.facilityType);
    cols.facilityName[rows] = dicts.facilityName.id(field.facilityName);
    cols.model[rows] = dicts.model.id(field.model);
    cols.department[rows] = dicts.department.id(field.department);
    cols.deviceGroup[rows] = dicts.deviceGroup.id(field.deviceGroup);
    cols.equipment[rows] = dicts.equipment.id(field.equipment);
    cols.equipmentType[rows] = dicts.equipmentType.id(normalizeEquipmentType(field.equipmentType));
    cols.manufacturer[rows] = dicts.manufacturer.id(field.manufacturer);
    cols.status[rows] = dicts.status.id(field.status);
    cols.engineer[rows] = dicts.engineer.id(field.engineer);
    cols.lifecycle[rows] = dicts.lifecycle.id(field.lifecycle);
    cols.parkedReason[rows] = parkedId;
    cols.loggedDay[rows] = loggedDay;
    cols.resolvedDay[rows] = resolvedDay;
    cols.downDays[rows] = Math.floor(+field.downDays) || 0;
    cols.penaltyDays[rows] = Math.floor(+field.penaltyDays) || 0;
    cols.penaltyAmount[rows] = Math.floor(+field.penaltyAmount) || 0;
    cols.bucket[rows] = bucket;

    // Must match summarize() in src/data/query.js exactly, including the `>= 0`
    // guard — Andhra has a row that resolves before it was logged, and without the
    // guard a negative duration slips through as a first-time fix.
    const fixDays = resolved && loggedDay > 0 ? resolvedDay - loggedDay : -1;
    if (fixDays >= 0 && fixDays <= FTFR_MAX_DAYS) firstTimeFixes++;

    bucketTotals[bucket]++;
    rows++;
  }
  console.log(`${rows.toLocaleString()} rows`);

  // Repeat calls are derived: >1 ticket against the same normalised barcode.
  const perAsset = new Int32Array(dicts.barcode.values.length);
  for (let i = 0; i < rows; i++) {
    const b = cols.barcode[i];
    if (b >= 0) perAsset[b]++;
  }
  let repeatAssets = 0;
  let repeatTickets = 0;
  for (let i = 0; i < perAsset.length; i++) {
    if (perAsset[i] > 1) { repeatAssets++; repeatTickets += perAsset[i]; }
  }

  // Penalty is evaluated against the newest logged date in the export, which is the
  // "as of" date for the whole artifact.
  let penalty = 0;
  const windowFor = (typeId) => {
    const t = typeId < 0 ? '' : dicts.equipmentType.values[typeId];
    return state.penaltyDays[t] ?? state.penaltyDays['NON CRITICAL'];
  };
  for (let i = 0; i < rows; i++) {
    if (cols.bucket[i] !== BUCKET.OPEN) continue;
    if (maxDay - cols.loggedDay[i] > windowFor(cols.equipmentType[i])) penalty++;
  }

  const outDir = path.join(OUT_DIR, state.id);
  fs.mkdirSync(outDir, { recursive: true });

  const bin = Buffer.alloc(rows * COLUMNS.length * 4);
  COLUMNS.forEach((c, i) => {
    Buffer.from(cols[c].buffer, 0, rows * 4).copy(bin, i * rows * 4);
  });
  fs.writeFileSync(path.join(outDir, 'tickets.bin'), bin);

  const meta = {
    id: state.id,
    name: state.name,
    short: state.short,
    source: `BEMMP DATA/${state.file}`,
    generatedAt: new Date().toISOString(),
    rows,
    columns: COLUMNS,
    dictionaries: Object.fromEntries(CATEGORICAL_FIELDS.map((f) => [f, dicts[f].values])),
    dateRange: { minDay, maxDay },
    penaltyDays: state.penaltyDays,
    kpis: {
      total: rows,
      open: bucketTotals[BUCKET.OPEN],
      parked: bucketTotals[BUCKET.PARKED],
      resolved: bucketTotals[BUCKET.RESOLVED],
      penalty,
      uniqueAssets: dicts.barcode.values.length,
      repeatAssets,
      repeatTickets,
      firstTimeFixes,
      ftfrPct: bucketTotals[BUCKET.RESOLVED]
        ? (firstTimeFixes / bucketTotals[BUCKET.RESOLVED]) * 100
        : 0,
    },
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta));

  const iso = (d) => new Date((d - 25569) * 86400000).toISOString().slice(0, 10);
  const sla = Object.entries(state.penaltyDays).map(([k, v]) => `${k} ${v}d`).join(', ');
  console.log(`
  total     ${meta.kpis.total.toLocaleString()}
  open      ${meta.kpis.open.toLocaleString()}   (Resolved Date blank AND Ticket Remark blank)
  penalty   ${penalty.toLocaleString()}   (open beyond SLA: ${sla})
  parked    ${meta.kpis.parked.toLocaleString()}
  resolved  ${meta.kpis.resolved.toLocaleString()}
  FTFR      ${meta.kpis.ftfrPct.toFixed(1)}%   (${firstTimeFixes.toLocaleString()} within ${FTFR_MAX_DAYS} day)
  assets    ${meta.kpis.uniqueAssets.toLocaleString()} unique, ${repeatAssets.toLocaleString()} repeating
  dates     ${iso(minDay)} .. ${iso(maxDay)}
  written   ${(bin.length / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s
`);

  return { id: state.id, name: state.name, short: state.short, rows, kpis: meta.kpis };
}

async function main() {
  const wanted = process.argv.slice(2);
  const targets = wanted.length
    ? STATES.filter((s) => wanted.includes(s.id))
    : STATES;
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
