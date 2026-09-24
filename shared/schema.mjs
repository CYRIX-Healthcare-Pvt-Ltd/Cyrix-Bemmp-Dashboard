/**
 * The BEMMP ticket schema and the row pipeline, shared by both readers.
 *
 * `scripts/build-data.mjs` runs this over Node streams to produce the prebuilt
 * artifacts; `src/data/workbook.js` runs the same code in a Web Worker over a
 * file the user picked. Keeping the logic here is what guarantees an uploaded
 * workbook and a server-built one give identical figures.
 *
 * Nothing in this file may import from `node:` or touch the DOM.
 */

import { upAreaOf } from './upAreas.mjs';
import { columnLetter, excelDayOfText, htmlTableRows } from './htmlTable.mjs';

const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Reads a state's rows by their headings rather than by position — for a
 * state that says which heading fills which field (`byHeading`): Uttar
 * Pradesh.
 *
 * A file with its columns in another order, one fewer (no Sl No) or one more
 * reads right. One without a heading the tracker needs is refused, naming it.
 * And every row must look like a call — its `rowCheck` — or the file is
 * refused rather than published: on 24 Sep a file whose rows sat a column
 * over from their headings put district names under MptId, and nothing
 * stopped it. A stray line or two, like a total at the foot of the report, is
 * let go.
 *
 * Rows are offered as [column, value] pairs — a letter from a workbook, a
 * position from a web page — heading row included; the heading is the first
 * row, within the first ten, carrying every heading the state needs.
 */
export class HeadingReader {
  constructor(builder) {
    this.builder = builder;
    this.state = builder.state;
    /** column → field, once the heading row is found */
    this.fieldAt = null;
    this.added = 0;
    /** [row number, what is wrong with it] */
    this.bad = [];
    this.offered = 0;
    /** The row that came closest to a heading row, for saying what it lacks. */
    this.closest = { cells: [], found: -1 };
  }

  offer(cells, number) {
    this.offered++;
    if (!this.fieldAt) {
      if (!this.#heading(cells) && this.offered >= 10) this.#refuseHeading();
      return;
    }
    const field = {};
    let any = false;
    for (const [key, value] of cells) {
      const name = this.fieldAt.get(key);
      if (name && value !== '' && value != null) { field[name] = value; any = true; }
    }
    if (!any) return;
    const wrong = this.state.rowCheck?.(field);
    if (wrong) { this.bad.push([number, wrong]); return; }
    this.builder.addRow(field);
    this.added++;
  }

  /** Throws unless the heading row was found and nearly every row read as a call. */
  finish() {
    if (!this.fieldAt) this.#refuseHeading();
    const total = this.added + this.bad.length;
    if (this.bad.length > Math.max(2, total * 0.02)) {
      const [n, why] = this.bad[0];
      throw new Error(
        `This file's rows do not line up with its headings, so it was not loaded: row ${n}: ${why}. `
        + `${this.bad.length.toLocaleString()} of ${total.toLocaleString()} rows are like that. `
        + 'Export it from TM again and upload that file.',
      );
    }
    return this.builder;
  }

  #heading(cells) {
    const want = new Map(Object.entries(this.state.byHeading).map(([h, f]) => [loose(h), f]));
    const at = new Map();
    for (const [key, text] of cells) {
      const f = want.get(loose(text));
      // The first column of a heading wins; a second of the same name is left alone.
      if (f && ![...at.values()].includes(f)) at.set(key, f);
    }
    const found = new Set(at.values());
    const missing = (this.state.required ?? []).filter((h) => !found.has(this.state.byHeading[h]));
    if (at.size > this.closest.found) this.closest = { cells, found: at.size };
    if (missing.length) return false;
    this.fieldAt = at;
    return true;
  }

  #refuseHeading() {
    const found = new Set(this.closest.cells.map(([, t]) => loose(t)));
    const missing = (this.state.required ?? []).filter((h) => !found.has(loose(h)));
    throw new Error(
      `This is not the ${this.state.name} TM export as the tracker reads it: no heading row with `
      + `${missing.length ? missing.map((h) => `"${h}"`).join(', ') : 'the columns it needs'} was found.`,
    );
  }
}

/**
 * A web-page export — Uttar Pradesh's .xls — into the builder: read by its
 * headings (HeadingReader) for a state that says them, or else checked
 * against the columns this state expects, so a different report is refused
 * rather than read into the wrong columns, then every row after it.
 */
export function addHtmlRows(builder, html) {
  const rows = htmlTableRows(html);
  const { state, fieldOf } = builder;
  if (state.byHeading) {
    const reader = new HeadingReader(builder);
    rows.forEach((cells, i) => reader.offer(cells.map((value, c) => [c, value]), i + 1));
    return reader.finish();
  }
  const heading = rows[0] ?? [];
  for (const [col, want] of Object.entries(state.headings ?? {})) {
    const got = heading.find((_, i) => columnLetter(i) === col) ?? '';
    if (loose(got) !== loose(want)) {
      throw new Error(
        `This is not the ${state.name} TM export as the tracker reads it: column ${col} should be `
        + `"${want}", and it is ${got ? `"${got}"` : 'empty'}.`,
      );
    }
  }
  const field = {};
  for (const cells of rows.slice(1)) {
    for (const k in field) delete field[k];
    let seen = false;
    cells.forEach((value, i) => {
      const name = fieldOf[columnLetter(i)];
      if (name && value !== '') { field[name] = value; seen = true; }
    });
    if (seen) builder.addRow(field);
  }
  return builder;
}

/**
 * A date and time from a real workbook — an Excel serial, 46287.6 — written
 * the way the web-page export writes one, "22/09/2026 02:20:26 PM", so the
 * tracker reads either the same. Anything else is left as it is.
 */
export function asExportTime(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{5}(\.\d+)?$/.test(s)) return value;
  const ms = Math.round((Number(s) - 25569) * 86400000 / 1000) * 1000;
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} `
    + `${two(h % 12 || 12)}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What Uttar Pradesh's export leaves for the pipeline to work out.
 *
 * Its dates are text — "22/09/2026 02:20:26 PM" — and are kept as the export
 * writes them, for the tracker to show; the days the rest of the dashboard
 * counts with come from them here. A call without a zone or a division gets
 * its district's, from the master (the user, 23 Sep: "if it is not there map
 * against the district").
 */
function deriveUp(field) {
  for (const k of ['receivedAt', 'respondedAt', 'attendedAt', 'completedAt']) field[k] = asExportTime(field[k]);
  field.loggedDay = excelDayOfText(field.receivedAt);
  field.resolvedDay = excelDayOfText(field.completedAt);
  if (!String(field.zone ?? '').trim() || !String(field.division ?? '').trim()) {
    const area = upAreaOf(field.district);
    if (area) {
      if (!String(field.zone ?? '').trim()) field.zone = area.zone;
      if (!String(field.division ?? '').trim()) field.division = area.division;
    }
  }
}

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
    // Rupees per penalty day, by Asset Value band. From "KL Penalty Logic.xlsx"
    // column AT; the first band whose `min` is met wins.
    penaltyRates: [
      { min: 10000000, rate: 10000 },
      { min: 1000000, rate: 3000 },
      { min: 100000, rate: 1000 },
      { min: 10000, rate: 500 },
      { min: 0, rate: 50 },
    ],
    ticket: 'A',
    categorical: {
      B: 'barcode', D: 'zone', E: 'district', F: 'facilityType', G: 'facilityName',
      H: 'model', I: 'department', J: 'deviceGroup', K: 'equipment', L: 'equipmentType',
      N: 'manufacturer', V: 'status', W: 'engineer', X: 'parkedReason',
      Z: 'serviceRequestType', AG: 'lifecycle',
    },
    numeric: {
      P: 'loggedDay', Q: 'resolvedDay', AI: 'downDays',
      S: 'rberDate', AD: 'assetValue',
      // "Installation Date". Read for Kerala only: Andhra's export puts its
      // columns elsewhere entirely and mapping T there on the strength of this
      // one would silently show whatever happens to sit in it.
      T: 'installedDay',
    },
  },
  {
    id: 'ap',
    name: 'Andhra Pradesh',
    short: 'AP',
    file: 'TM-AP.xlsx',
    barcodeWidth: 8,
    penaltyDays: { CRITICAL: 2, 'NON CRITICAL': 7 },
    // No rate card supplied for Andhra. Its export already carries Penalty Down
    // Days and Penalty Amount, so the money figures come from the source columns
    // rather than being recomputed. Add bands here if a rate card arrives.
    penaltyRates: null,
    ticket: 'A',
    categorical: {
      B: 'barcode', D: 'district', E: 'facilityType', F: 'facilityName',
      G: 'model', H: 'department', I: 'deviceGroup', J: 'equipment', AA: 'equipmentType',
      L: 'manufacturer', V: 'status', W: 'engineer', X: 'parkedReason',
    },
    numeric: {
      N: 'loggedDay', P: 'resolvedDay', AB: 'downDays',
      AC: 'srcPenaltyDays', AD: 'srcPenaltyAmount',
      S: 'rberDate', Y: 'assetValue',
    },
  },
  {
    /*
     * Uttar Pradesh (the user, 23 Sep): the ticket tracker only, for now.
     *
     * Its export is a web page saved as .xls — one table, every cell text — so
     * it is read by shared/htmlTable.mjs rather than as a workbook. Nineteen
     * columns, Sl No to Status; each of them is kept, since the tracker shows
     * them all. The penalty is its own: the asset's per-day cost and priority
     * from the Per Day Cost sheet, in the database — see shared/upPenalty.mjs.
     */
    id: 'up',
    name: 'Uttar Pradesh',
    short: 'UP',
    file: 'TM-UP.xls',
    barcodeWidth: 0,
    // The penalty starts on logged + 8, which is a seven-day window.
    penaltyDays: { CRITICAL: 7, 'NON CRITICAL': 7 },
    penaltyRates: null,
    ticket: 'B',
    categorical: {
      C: 'district', D: 'division', E: 'zone', F: 'facilityType', G: 'facilityName',
      H: 'barcode', I: 'equipment', J: 'manufacturer', K: 'model', L: 'serialNo',
      M: 'department', N: 'contactNo', O: 'receivedAt', P: 'respondedAt',
      Q: 'attendedAt', R: 'completedAt', S: 'status',
    },
    numeric: {},
    derive: deriveUp,
    /*
     * Read by heading, not by position (HeadingReader): a file with its
     * columns in another order, or without Sl No, reads right; the letters
     * above are the export's usual layout, for the server build's notes.
     */
    byHeading: {
      MptId: 'ticket', District: 'district', Division: 'division', Zone: 'zone',
      'Hospital Type': 'facilityType', Hospital: 'facilityName', 'Asset No': 'barcode',
      Product: 'equipment', Manufacture: 'manufacturer', 'Model No': 'model', 'Serial No': 'serialNo',
      Department: 'department', 'Contact No': 'contactNo',
      'Call Received Date & Time': 'receivedAt', 'Call Respond Date & Time': 'respondedAt',
      'Call Attend Date & Time': 'attendedAt', 'Call Completed Date & Time': 'completedAt', Status: 'status',
    },
    // Without these there is no reading it at all.
    required: ['MptId', 'District', 'Hospital', 'Asset No', 'Call Received Date & Time', 'Status'],
    // What a row must look like to be one of its calls.
    rowCheck: (field) => {
      const ticket = String(field.ticket ?? '').trim();
      if (!/^\d+$/.test(ticket)) return `MptId is "${ticket || 'blank'}", not a ticket number`;
      if (excelDayOfText(asExportTime(field.receivedAt)) === '') {
        return `Call Received Date & Time is "${String(field.receivedAt ?? '').trim() || 'blank'}", not a date`;
      }
      return null;
    },
  },
];

export const STATE_BY_ID = Object.fromEntries(STATES.map((s) => [s.id, s]));

// Emitted column order, shared by every state. Fields a state does not supply stay
// at the -1 / 0 sentinel so the reader never needs to branch per state.
export const COLUMNS = [
  'ticketNo', 'ticketPrefix', 'barcode', 'zone', 'district', 'facilityType',
  'facilityName', 'model', 'department', 'deviceGroup', 'equipment', 'equipmentType',
  'manufacturer', 'status', 'engineer', 'lifecycle', 'parkedReason',
  'loggedDay', 'resolvedDay', 'downDays', 'srcPenaltyDays', 'srcPenaltyAmount',
  'assetValue', 'dayRate', 'penaltyExempt', 'bucket',
  'installedDay',
  // Uttar Pradesh's, appended — see datasetFrom for why the end is the only
  // safe place. Blank for Kerala and Andhra, whose exports do not have them.
  'division', 'serialNo', 'contactNo', 'receivedAt', 'respondedAt', 'attendedAt', 'completedAt',
];

/** Uttar Pradesh's text columns, blank in every other state's artifact. */
export const UP_TEXT_FIELDS = ['division', 'serialNo', 'contactNo', 'receivedAt', 'respondedAt', 'attendedAt', 'completedAt'];

export const CATEGORICAL_FIELDS = [
  'ticketPrefix', 'barcode', 'zone', 'district', 'facilityType', 'facilityName',
  'model', 'department', 'deviceGroup', 'equipment', 'equipmentType', 'manufacturer',
  'status', 'engineer', 'lifecycle', 'parkedReason', 'serviceRequestType',
  ...UP_TEXT_FIELDS,
];

/**
 * Bumped whenever COLUMNS changes.
 *
 * A reordered or shortened layout must be rejected outright: the reader slices
 * by offset, and data written under one order read under another is not wrong
 * in a way anybody would notice, which is the worst kind of wrong.
 *
 * A column appended to the end is the exception, and `datasetFrom` accepts it.
 * Offsets are computed from the artifact's own `meta.columns`, so every column
 * an older artifact carries is exactly where it says it is; the only difference
 * is that the new one is absent, which reads as a blank cell. Without that,
 * adding a column would take the dashboard down for everybody until each state
 * was re-uploaded — a real cost, paid every time, for a layout that is provably
 * still readable.
 */
export const FORMAT_VERSION = 3;

// Free-text columns where capitalisation varies row to row and carries no meaning.
export const FOLD_CASE = new Set([
  'facilityName', 'model', 'department', 'deviceGroup', 'equipment', 'manufacturer',
]);

export const BUCKET = { OPEN: 0, PARKED: 1, RESOLVED: 2 };

/**
 * First Time Fix Rate window, in days: logged today and resolved today or tomorrow.
 * Mirrored in src/data/query.js.
 */
export const FTFR_MAX_DAYS = 1;

const SUNDAY = 0;

/** Day of week for an Excel serial, 0 = Sunday. */
function weekday(serial) {
  return new Date((serial - 25569) * 86400000).getUTCDay();
}

/**
 * The last day a call had to be resolved in to still count as a first-time fix.
 *
 * Normally logged + `FTFR_MAX_DAYS`, but Sunday is not a service day: a call
 * logged on Saturday still has Monday to be fixed on the next working day, and
 * one logged on Sunday has Monday too.
 */
export function ftfrWindowEnd(loggedDay) {
  const end = loggedDay + FTFR_MAX_DAYS;
  return weekday(end) === SUNDAY ? end + 1 : end;
}

/**
 * Whether a call was fixed inside its window, honouring the Sunday rule.
 *
 * Lives here rather than in query.js because the offline build and the browser
 * both have to produce the same headline figure — the whole point of this module
 * is that neither can drift from the other.
 *
 * The `resolvedDay < loggedDay` guard matters: Andhra has a row that resolves
 * before it was logged, and without it a negative duration slips through as a
 * first-time fix.
 */
export function isFirstTimeFix(loggedDay, resolvedDay) {
  if (resolvedDay <= 0 || loggedDay <= 0 || resolvedDay < loggedDay) return false;
  return resolvedDay <= ftfrWindowEnd(loggedDay);
}

/**
 * Rupees per penalty day for one ticket, from its Asset Value band.
 *
 * Mirrors column AT of "KL Penalty Logic.xlsx". States with no rate card return 0
 * and fall back to the penalty figures their own export carries.
 */
export function dayRateFor(state, assetValue) {
  if (!state.penaltyRates) return 0;
  const v = Number(assetValue) || 0;
  for (const band of state.penaltyRates) if (v >= band.min) return band.rate;
  return 0;
}

/**
 * Whether a ticket is outside the penalty scope, mirroring column AL:
 * an RBER date, any Ticket Remark, or a standby service request all exempt it.
 */
export function isPenaltyExempt(field) {
  const rber = Number(String(field.rberDate ?? '').trim());
  if (Number.isFinite(rber) && rber > 0) return true;
  if (String(field.parkedReason ?? '').trim() !== '') return true;
  return String(field.serviceRequestType ?? '').trim().toLowerCase() === 'standby';
}

/* ------------------------------------------------------------------ xml ---- */

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

export function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (m, g) =>
    (g[0] === '#' ? String.fromCharCode(+g.slice(1)) : ENTITIES[g]));
}

/** A shared string can be split across several <t> runs when it carries formatting. */
export function sharedStringText(si) {
  let text = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(si)) !== null) text += m[1];
  return decodeXml(text);
}

/** Matches both self-closing cells and cells carrying a <v> value. */
export function createCellRegex() {
  return /<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:\/>|>(?:<v>([\s\S]*?)<\/v>|<is>[\s\S]*?<\/is>)?<\/c>)/g;
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
export class Dict {
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
export function normalizeBarcode(v, width) {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return /^\d+$/.test(s) && s.length < width ? s.padStart(width, '0') : s;
}

/** Only KASARGODE is shouted; the other districts are title case. */
export function normalizeDistrict(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s !== s.toUpperCase()) return s;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Kerala writes `CRITICAL`/`NON CRITICAL`, Andhra writes `Critical`/`Non-Critical`.
 * The penalty rule keys off this value, so both collapse to one vocabulary.
 */
export function normalizeEquipmentType(v) {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return s.toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Ticket ids are a bare number in Kerala and an `AP` prefix plus a number in
 * Andhra, with a few bare numbers mixed into the Andhra export too. Splitting
 * the alpha prefix from the number keeps the id exact
 * while storing it as one small dictionary plus an Int32 rather than 265k strings.
 */
export function splitTicket(v) {
  const s = String(v ?? '').trim();
  if (s === '') return { prefix: '', number: -1 };
  const m = /^([A-Za-z]*)(\d+)$/.exec(s);
  if (!m) return { prefix: s, number: -1 };
  return { prefix: m[1], number: Number(m[2]) };
}

/* --------------------------------------------------------------- builder --- */

/**
 * Accumulates parsed rows into the columnar artifact.
 *
 * Feed it the raw field map for each data row, then call `finish()` to get the
 * binary buffer and the meta object the dashboard reads.
 */
export class Builder {
  constructor(state) {
    this.state = state;
    this.fieldOf = { ...state.categorical, ...state.numeric, [state.ticket]: 'ticket' };

    this.dicts = {};
    for (const f of CATEGORICAL_FIELDS) this.dicts[f] = new Dict(FOLD_CASE.has(f));

    this.capacity = 1 << 18;
    this.cols = {};
    for (const c of COLUMNS) this.cols[c] = new Int32Array(this.capacity);

    this.rows = 0;
    this.minDay = Infinity;
    this.maxDay = -Infinity;
    this.bucketTotals = [0, 0, 0];
    this.firstTimeFixes = 0;
  }

  #grow() {
    this.capacity *= 2;
    for (const c of COLUMNS) {
      const next = new Int32Array(this.capacity);
      next.set(this.cols[c]);
      this.cols[c] = next;
    }
  }

  addRow(field) {
    if (this.rows === this.capacity) this.#grow();
    const { cols, dicts, state } = this;
    const i = this.rows;

    // What a state's export leaves to be worked out — Uttar Pradesh's text dates
    // and missing zones — before anything below reads the row.
    state.derive?.(field);

    // Unresolved rows carry a literal " " in Kerala and an empty cell in Andhra,
    // so blankness is tested before any date parsing.
    const resolvedRaw = String(field.resolvedDay ?? '').trim();
    const resolved = resolvedRaw !== '' && Number.isFinite(+resolvedRaw);
    const parkedId = dicts.parkedReason.id(String(field.parkedReason ?? '').trim().toLowerCase());
    const bucket = resolved ? BUCKET.RESOLVED : (parkedId === -1 ? BUCKET.OPEN : BUCKET.PARKED);

    const loggedRaw = String(field.loggedDay ?? '').trim();
    const loggedDay = Number.isFinite(+loggedRaw) && +loggedRaw > 0 ? Math.floor(+loggedRaw) : -1;
    if (loggedDay > 0) {
      if (loggedDay < this.minDay) this.minDay = loggedDay;
      if (loggedDay > this.maxDay) this.maxDay = loggedDay;
    }
    const resolvedDay = resolved ? Math.floor(+resolvedRaw) : -1;
    const ticket = splitTicket(field.ticket);

    cols.ticketNo[i] = ticket.number;
    cols.ticketPrefix[i] = dicts.ticketPrefix.id(ticket.prefix);
    cols.barcode[i] = dicts.barcode.id(normalizeBarcode(field.barcode, state.barcodeWidth));
    cols.zone[i] = dicts.zone.id(field.zone);
    cols.district[i] = dicts.district.id(normalizeDistrict(field.district));
    cols.facilityType[i] = dicts.facilityType.id(field.facilityType);
    cols.facilityName[i] = dicts.facilityName.id(field.facilityName);
    cols.model[i] = dicts.model.id(field.model);
    cols.department[i] = dicts.department.id(field.department);
    cols.deviceGroup[i] = dicts.deviceGroup.id(field.deviceGroup);
    cols.equipment[i] = dicts.equipment.id(field.equipment);
    cols.equipmentType[i] = dicts.equipmentType.id(normalizeEquipmentType(field.equipmentType));
    cols.manufacturer[i] = dicts.manufacturer.id(field.manufacturer);
    cols.status[i] = dicts.status.id(field.status);
    cols.engineer[i] = dicts.engineer.id(field.engineer);
    cols.lifecycle[i] = dicts.lifecycle.id(field.lifecycle);
    cols.parkedReason[i] = parkedId;
    cols.loggedDay[i] = loggedDay;
    cols.resolvedDay[i] = resolvedDay;
    cols.downDays[i] = Math.floor(+field.downDays) || 0;
    cols.srcPenaltyDays[i] = Math.floor(+field.srcPenaltyDays) || 0;
    cols.srcPenaltyAmount[i] = Math.floor(+field.srcPenaltyAmount) || 0;

    const assetValue = Math.floor(+field.assetValue) || 0;
    cols.assetValue[i] = assetValue;

    // Same parse as loggedDay: an Excel serial, or -1 when the cell is blank —
    // which it often is, since a machine installed before the contract began
    // has no installation date in this system.
    const installedRaw = String(field.installedDay ?? '').trim();
    cols.installedDay[i] = Number.isFinite(+installedRaw) && +installedRaw > 0
      ? Math.floor(+installedRaw) : -1;
    // Uttar Pradesh's own columns, as the export writes them; nobody else's
    // export has them, so they stay blank there.
    for (const f of UP_TEXT_FIELDS) cols[f][i] = dicts[f].id(String(field[f] ?? '').trim());
    cols.penaltyExempt[i] = isPenaltyExempt(field) ? 1 : 0;
    cols.dayRate[i] = cols.penaltyExempt[i] ? 0 : dayRateFor(state, assetValue);
    cols.bucket[i] = bucket;

    if (resolved && isFirstTimeFix(loggedDay, resolvedDay)) this.firstTimeFixes++;

    this.bucketTotals[bucket]++;
    this.rows++;
  }

  finish() {
    const { cols, dicts, state, rows } = this;

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

    // Penalty is evaluated against the newest logged date in the export, which is
    // the "as of" date for the whole artifact.
    let penalty = 0;
    const fallback = state.penaltyDays['NON CRITICAL'];
    for (let i = 0; i < rows; i++) {
      if (cols.bucket[i] !== BUCKET.OPEN) continue;
      const typeId = cols.equipmentType[i];
      const name = typeId < 0 ? '' : dicts.equipmentType.values[typeId];
      const window = state.penaltyDays[name] ?? fallback;
      if (this.maxDay - cols.loggedDay[i] > window) penalty++;
    }

    const buffer = new ArrayBuffer(rows * COLUMNS.length * 4);
    const view = new Int32Array(buffer);
    COLUMNS.forEach((c, n) => view.set(cols[c].subarray(0, rows), n * rows));

    const meta = {
      id: state.id,
      name: state.name,
      short: state.short,
      source: `BEMMP DATA/${state.file}`,
      generatedAt: new Date().toISOString(),
      rows,
      formatVersion: FORMAT_VERSION,
      columns: COLUMNS,
      dictionaries: Object.fromEntries(CATEGORICAL_FIELDS.map((f) => [f, dicts[f].values])),
      dateRange: { minDay: this.minDay, maxDay: this.maxDay },
      penaltyDays: state.penaltyDays,
      penaltyRates: state.penaltyRates,
      // Grace is expressed as "penalty starts on logged + graceDays + 1", which is
      // the AM column's `P + 8` when the window is 7 days.
      graceDays: state.penaltyDays['NON CRITICAL'],
      kpis: {
        total: rows,
        open: this.bucketTotals[BUCKET.OPEN],
        parked: this.bucketTotals[BUCKET.PARKED],
        resolved: this.bucketTotals[BUCKET.RESOLVED],
        penalty,
        uniqueAssets: dicts.barcode.values.length,
        repeatAssets,
        repeatTickets,
        firstTimeFixes: this.firstTimeFixes,
        /*
         * Divided by calls **logged**, not by calls resolved.
         *
         * The resolved-only denominator answers "of the ones we closed, how many
         * were quick", which flatters the figure by leaving out everything still
         * open — on the Kerala month it read 59.3% against 45.5% measured this
         * way. The business counts every call it took, and the chart already
         * did; this is the tile catching up with both.
         */
        ftfrPct: rows ? (this.firstTimeFixes / rows) * 100 : 0,
      },
    };

    return { buffer, meta };
  }
}

/**
 * Guesses which state config a workbook belongs to from its filename.
 * `TM-KL.xlsx`, `tm kl (1).xlsx` and `TM-AP-July.xlsx` all resolve.
 */
export function detectState(filename) {
  const name = String(filename || '').toUpperCase();
  for (const s of STATES) {
    if (new RegExp(`(^|[^A-Z])${s.short}([^A-Z]|$)`).test(name)) return s;
  }
  return null;
}
