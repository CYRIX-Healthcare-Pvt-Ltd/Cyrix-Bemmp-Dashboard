/**
 * Synthetic datasets, in the exact shape the browser reads.
 *
 * The real artifacts are 27 MB and gitignored, and a test that needs them is a
 * test that cannot run in CI or on a fresh clone. These build the same columnar
 * structure by hand — concatenated Int32Array columns sliced out of one buffer,
 * exactly as `datasetFrom` does — from a handful of rows written as objects.
 *
 * Days are Excel serials. `day('2026-08-13')` converts, so a test can say what
 * it means and the Sunday rule can be checked against real calendar dates rather
 * than against magic numbers.
 */

import { COLUMNS, BUCKET } from '../shared/schema.mjs';

/** An ISO date to an Excel 1900-system serial. */
export function day(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;
}

/** The reverse, for readable failure messages. */
export const iso = (serial) => new Date((serial - 25569) * 86400000)
  .toISOString().slice(0, 10);

/**
 * Kerala's real rate card shape: one window for all equipment, bands by asset
 * value. Andhra passes `penaltyRates: null` to exercise the no-rate-card path.
 */
export const KL_PENALTY_DAYS = { CRITICAL: 7, 'NON CRITICAL': 7 };
export const AP_PENALTY_DAYS = { CRITICAL: 2, 'NON CRITICAL': 7 };

/**
 * Builds a dataset from plain rows.
 *
 * Every column defaults to the `0`/`-1` sentinel a state that does not supply it
 * would carry, so a test writes only the fields it is about. Dictionary values
 * are given as strings and interned here, which is also what makes a test able
 * to assert on labels rather than on ids.
 */
export function makeDataset(rows, options = {}) {
  const {
    id = 'kl',
    name = 'Kerala',
    penaltyDays = KL_PENALTY_DAYS,
    penaltyRates = [{ max: Infinity, rate: 100 }],
    graceDays = 7,
    dictKeys = ['zone', 'district', 'facilityName', 'equipment', 'equipmentType',
      'manufacturer', 'engineer', 'department', 'facilityType', 'model',
      'deviceGroup', 'status', 'lifecycle', 'parkedReason', 'ticketPrefix', 'barcode'],
  } = options;

  const dictionaries = Object.fromEntries(dictKeys.map((k) => [k, []]));
  const intern = (key, value) => {
    if (value == null) return -1;
    const list = dictionaries[key];
    const at = list.indexOf(value);
    if (at >= 0) return at;
    list.push(value);
    return list.length - 1;
  };

  const n = rows.length;
  const buffer = new ArrayBuffer(n * COLUMNS.length * 4);
  const cols = {};
  COLUMNS.forEach((c, i) => { cols[c] = new Int32Array(buffer, i * n * 4, n); });

  // Dictionary-backed columns take a string; the rest take a number.
  const TEXT = new Set(dictKeys);

  rows.forEach((row, i) => {
    for (const c of COLUMNS) {
      const v = row[c];
      if (v === undefined) {
        cols[c][i] = TEXT.has(c) ? -1 : 0;
      } else if (TEXT.has(c)) {
        cols[c][i] = intern(c, v);
      } else {
        cols[c][i] = v;
      }
    }
    // `bucket` is the one derived field, and deriving it here rather than asking
    // each test to state it is the point: the rule under test in bucket.test.mjs
    // is the *parser's*, and this is a deliberately separate implementation of
    // it so the two cannot agree by sharing code.
    if (row.bucket === undefined) {
      const resolved = (row.resolvedDay ?? 0) > 0;
      const remark = (row.parkedReason ?? null) != null;
      cols.bucket[i] = resolved ? BUCKET.RESOLVED : (remark ? BUCKET.PARKED : BUCKET.OPEN);
    }
  });

  const logged = rows.map((r) => r.loggedDay ?? 0).filter((d) => d > 0);
  const meta = {
    id,
    name,
    rows: n,
    columns: COLUMNS,
    dictionaries,
    penaltyDays,
    penaltyRates,
    graceDays,
    dateRange: {
      minDay: logged.length ? Math.min(...logged) : 0,
      maxDay: logged.length ? Math.max(...logged) : 0,
    },
  };

  return { meta, cols, dict: dictionaries, rows: n, source: 'test' };
}

/** Every row index, which is what an unfiltered view passes around. */
export const allRows = (ds) => Array.from({ length: ds.rows }, (_, i) => i);

/** The filter object for "everything", built without importing the UI's default. */
export function allFilters(ds, patch = {}) {
  return {
    preset: 'all',
    dayFrom: ds.meta.dateRange.minDay,
    dayTo: ds.meta.dateRange.maxDay,
    zone: new Set(),
    district: new Set(),
    facilityName: new Set(),
    equipment: new Set(),
    bucket: new Set(),
    ...patch,
  };
}
