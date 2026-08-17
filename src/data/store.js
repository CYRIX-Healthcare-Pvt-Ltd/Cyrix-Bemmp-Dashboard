/**
 * Loads the artifacts written by scripts/build-data.mjs.
 *
 * tickets.bin is concatenated Int32Array columns in meta.columns order, so each
 * column is a view onto the same ArrayBuffer — no parsing, no per-row objects.
 * Each state lives in its own folder under public/data/.
 */

import { FORMAT_VERSION } from '../../shared/schema.mjs';

export const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01
const MS_PER_DAY = 86400000;

export function serialToDate(serial) {
  return new Date((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY);
}

export function dateToSerial(date) {
  return Math.round(date.getTime() / MS_PER_DAY) + EXCEL_EPOCH_OFFSET;
}

export function serialToISO(serial) {
  return serialToDate(serial).toISOString().slice(0, 10);
}

export function formatDay(serial) {
  return serialToDate(serial).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/*
 * Internally the middle bucket is still "parked" — that is what the pipeline, the
 * column names and the docs call it. Only the label shown to users says
 * "Unresolved", which is the business's own wording for it.
 */
export const BUCKET = { OPEN: 0, PARKED: 1, RESOLVED: 2 };
export const BUCKET_LABEL = ['Open', 'Unresolved', 'Resolved'];

/** First day of the month containing `serial`. */
export function monthStart(serial) {
  const d = serialToDate(serial);
  return serial - (d.getUTCDate() - 1);
}

/**
 * First day of the financial year containing `serial` — 1 April to 31 March.
 *
 * Not January. Both contracts are with Indian state health departments, so the
 * year the penalty accounts close on, and the one every review is written
 * against, starts in April. Deliberately not configurable: a second convention
 * would mean two answers to "this year" and no way to tell from a figure which
 * one produced it.
 */
export function financialYearStart(serial) {
  const d = serialToDate(serial);
  // Months are 0-indexed, so 3 is April. January to March still belong to the
  // year that began the previous April.
  const year = d.getUTCFullYear() - (d.getUTCMonth() >= 3 ? 0 : 1);
  return dateToSerial(new Date(Date.UTC(year, 3, 1)));
}

/** The states that have been built, newest artifact wins. */
export async function loadStates(version = '') {
  const r = await fetch(`data/states.json${version ? `?v=${version}` : ''}`);
  if (!r.ok) throw new Error('data/states.json not found — run `npm run build:data` first');
  return r.json();
}

/**
 * `version` busts the HTTP cache after a refresh so the browser cannot serve the
 * previous artifact from memory alongside a new meta.json.
 */
export async function loadDataset(stateId, version = '') {
  const q = version ? `?v=${version}` : '';
  const [meta, buffer] = await Promise.all([
    fetch(`data/${stateId}/meta.json${q}`).then((r) => {
      if (!r.ok) throw new Error(`data/${stateId}/meta.json not found — run \`npm run build:data\``);
      return r.json();
    }),
    fetch(`data/${stateId}/tickets.bin${q}`).then((r) => {
      if (!r.ok) throw new Error(`data/${stateId}/tickets.bin not found — run \`npm run build:data\``);
      return r.arrayBuffer();
    }),
  ]);

  // A refresh rewrites both files; if one is read mid-write the sizes disagree and
  // every column view would silently be offset. Fail loudly instead.
  const expected = meta.rows * meta.columns.length * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `tickets.bin is ${buffer.byteLength} bytes but meta.json describes ${expected}`
      + ' — the artifact was read mid-rebuild. Reload the page.',
    );
  }

  return datasetFrom(meta, buffer, 'server');
}

/**
 * Slices the concatenated buffer into one typed-array view per column.
 *
 * Shared by both sources — a prebuilt artifact fetched from the server and one
 * parsed in the browser from an uploaded workbook have the identical layout.
 */
export function datasetFrom(meta, buffer, source = 'server') {
  if ((meta.formatVersion ?? 1) !== FORMAT_VERSION) {
    throw new Error(
      `This data was built for artifact format v${meta.formatVersion ?? 1}, `
      + `but the app now reads v${FORMAT_VERSION}. Re-upload the workbook.`,
    );
  }
  const expected = meta.rows * meta.columns.length * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `tickets.bin is ${buffer.byteLength} bytes but meta.json describes ${expected}.`,
    );
  }
  const cols = {};
  meta.columns.forEach((name, i) => {
    cols[name] = new Int32Array(buffer, i * meta.rows * 4, meta.rows);
  });
  return { meta, cols, dict: meta.dictionaries, rows: meta.rows, source };
}

/**
 * Refresh control, backed by `scripts/serve.mjs`.
 *
 * Only present when the app is served by that script — a static host has no way
 * to run the build, so the UI hides the control rather than offering a dead button.
 */
export async function fetchRefreshStatus() {
  try {
    const r = await fetch('api/status', { cache: 'no-store' });
    if (!r.ok) return { refreshAvailable: false };
    const body = await r.json();
    return body && body.refreshAvailable ? body : { refreshAvailable: false };
  } catch {
    return { refreshAvailable: false };
  }
}

export async function triggerRefresh() {
  const r = await fetch('api/refresh', { method: 'POST', cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(body.error || `refresh failed (${r.status})`);
  return body;
}

/** Dictionary lookup that tolerates the -1 blank sentinel. */
export function label(dict, id, blank = '—') {
  return id < 0 ? blank : dict[id];
}

/**
 * Reassembles a ticket id from its stored prefix and number — a bare number in
 * Kerala, an `AP` prefix plus a number in Andhra.
 */
export function ticketLabel(ds, row) {
  const prefix = label(ds.dict.ticketPrefix, ds.cols.ticketPrefix[row], '');
  const n = ds.cols.ticketNo[row];
  return n < 0 ? (prefix || '—') : `${prefix}${n}`;
}

/**
 * Splits the source "Assigned" string into its parts.
 *
 * Two shapes occur: an engineer, `CODE - Engineer Name - phone`, and a district
 * desk, `ABC - District - DI USER ID - phone`.
 */
export function parseEngineer(raw) {
  if (!raw || raw === '—') return null;
  const parts = raw.split(' - ').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { code: raw, name: raw, phone: null, raw };

  const last = parts[parts.length - 1];
  const phone = /^\+?\d[\d\s-]{6,}$/.test(last) ? last : null;
  const code = parts[0];
  const middle = parts.slice(1, phone ? -1 : undefined);
  return { code, name: middle.join(' · ') || code, phone, raw };
}

/** Short engineer name for axis labels and table cells. */
export function engineerName(ds, row) {
  const parsed = parseEngineer(label(ds.dict.engineer, ds.cols.engineer[row]));
  return parsed ? parsed.name : '—';
}
