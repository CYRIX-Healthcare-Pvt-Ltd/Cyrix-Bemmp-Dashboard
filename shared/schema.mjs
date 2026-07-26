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
];

export const CATEGORICAL_FIELDS = [
  'ticketPrefix', 'barcode', 'zone', 'district', 'facilityType', 'facilityName',
  'model', 'department', 'deviceGroup', 'equipment', 'equipmentType', 'manufacturer',
  'status', 'engineer', 'lifecycle', 'parkedReason', 'serviceRequestType',
];

/**
 * Bumped whenever COLUMNS changes. A cached upload from an older layout would be
 * sliced at the wrong offsets, so the reader discards anything that does not match.
 */
export const FORMAT_VERSION = 2;

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
    cols.penaltyExempt[i] = isPenaltyExempt(field) ? 1 : 0;
    cols.dayRate[i] = cols.penaltyExempt[i] ? 0 : dayRateFor(state, assetValue);
    cols.bucket[i] = bucket;

    // The `>= 0` guard matters: Andhra has a row that resolves before it was
    // logged, and without it a negative duration slips through as a first-time fix.
    const fixDays = resolved && loggedDay > 0 ? resolvedDay - loggedDay : -1;
    if (fixDays >= 0 && fixDays <= FTFR_MAX_DAYS) this.firstTimeFixes++;

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
        ftfrPct: this.bucketTotals[BUCKET.RESOLVED]
          ? (this.firstTimeFixes / this.bucketTotals[BUCKET.RESOLVED]) * 100
          : 0,
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
