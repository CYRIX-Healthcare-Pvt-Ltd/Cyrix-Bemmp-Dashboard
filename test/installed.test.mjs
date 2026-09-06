/**
 * Installation Date, and what it costs to add a column.
 *
 * Two separate things are checked here, because adding the column touched
 * both. First that the date itself survives the pipeline: Kerala's export
 * carries it in column T, and it is a date like any other, which means the
 * blank case matters more than the filled one — a machine installed before
 * the contract began has no installation date in this system, and most rows
 * are that.
 *
 * Second, and more important, that an artifact built before the column
 * existed is still readable. `datasetFrom` slices by offset, so the rule
 * cannot be "any older version is fine": a layout whose columns moved would
 * read every figure off the wrong column and look entirely plausible doing
 * it. The rule is that the stored list has to be a prefix of the current
 * one, which is exactly the append case and nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Builder, STATE_BY_ID, COLUMNS, FORMAT_VERSION } from '../shared/schema.mjs';
import { datasetFrom, formatDay, MONTHS } from '../src/data/store.js';
import { day } from './fixture.mjs';

/** One row through the real parser, returning its stored installedDay. */
function installedOf(installedDay) {
  const b = new Builder(STATE_BY_ID.kl);
  b.addRow({ ticket: '1', loggedDay: day('2026-07-08'), installedDay });
  return b.cols.installedDay[0];
}

test('an installation date is stored as its Excel serial', () => {
  assert.equal(installedOf(day('2021-03-15')), day('2021-03-15'));
});

test('a blank installation date is -1, not 0', () => {
  // 0 is a real serial in the 1900 system, and `> 0` is what the reader
  // tests. Anything that lands on 0 would print as a date in 1899.
  for (const blank of [undefined, null, '', '   ']) {
    assert.equal(installedOf(blank), -1, `for ${JSON.stringify(blank)}`);
  }
});

test('text in the installation date cell is refused rather than coerced', () => {
  // The column is typed by hand in places. `Number('N/A')` is NaN, which
  // Math.floor turns into NaN and Int32Array stores as 0 — a date in 1899
  // on every row somebody wrote a note in.
  for (const junk of ['N/A', 'not installed', '-']) {
    assert.equal(installedOf(junk), -1, `for ${junk}`);
  }
});

test('a serial of 0 or below is treated as blank', () => {
  assert.equal(installedOf(0), -1);
  assert.equal(installedOf(-5), -1);
});

test('Andhra does not map the column, so it stays blank', () => {
  const b = new Builder(STATE_BY_ID.ap);
  b.addRow({ ticket: 'AP1', loggedDay: day('2026-07-08') });
  assert.equal(b.cols.installedDay[0], -1);
  // And the field is not read from column T there by accident.
  assert.ok(!('T' in STATE_BY_ID.ap.numeric),
    'Andhra must not map column T without its export to check against');
});

/* ------------------------------------------------- reading older data --- */

/** A minimal artifact carrying exactly `columns`, one row of zeros. */
function artifact(columns, formatVersion) {
  const rows = 1;
  const buffer = new ArrayBuffer(rows * columns.length * 4);
  const view = new Int32Array(buffer);
  columns.forEach((_, i) => { view[i] = i + 1; });
  return [{ rows, columns, formatVersion, dictionaries: {} }, buffer];
}

test('an artifact built before the column was added is still readable', () => {
  const older = COLUMNS.slice(0, -1);
  const ds = datasetFrom(...artifact(older, FORMAT_VERSION - 1));
  // Every column it does carry is where it says it is.
  older.forEach((name, i) => assert.equal(ds.cols[name][0], i + 1, name));
  // And the one it does not is simply absent.
  assert.equal(ds.cols.installedDay, undefined);
});

test('a reordered layout is refused, even at the current version', () => {
  const swapped = [...COLUMNS];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.throws(() => datasetFrom(...artifact(swapped, FORMAT_VERSION)),
    /Re-upload the workbook/);
});

test('a layout with a column removed from the middle is refused', () => {
  const gap = COLUMNS.filter((c) => c !== 'district');
  assert.throws(() => datasetFrom(...artifact(gap, FORMAT_VERSION)),
    /Re-upload the workbook/);
});

test('a layout with columns this build has never heard of is refused', () => {
  const future = [...COLUMNS, 'somethingLater'];
  assert.throws(() => datasetFrom(...artifact(future, FORMAT_VERSION + 1)),
    /Re-upload the workbook/);
});

test('the current layout reads back exactly', () => {
  const ds = datasetFrom(...artifact(COLUMNS, FORMAT_VERSION));
  COLUMNS.forEach((name, i) => assert.equal(ds.cols[name][0], i + 1, name));
});

test('installedDay is last in COLUMNS, so older artifacts stay a prefix', () => {
  // Not decoration: if it were inserted anywhere else, every artifact
  // published before it would be refused and every state would have to be
  // re-uploaded before the dashboard drew anything at all.
  assert.equal(COLUMNS[COLUMNS.length - 1], 'installedDay');
});

/* ------------------------------------------------------ the date format --- */

test('a date reads as 06 Sep 2026, in every month', () => {
  // September is the one that matters: `toLocaleDateString` with
  // `month: 'short'` returns "Sept" for it in en-GB and en-IN, so the
  // column that reads "06 Sep 2026" eleven months of the year quietly
  // became "06 Sept 2026" in the twelfth.
  assert.equal(formatDay(day('2026-09-06')), '06 Sep 2026');
  assert.equal(formatDay(day('2026-06-06')), '06 Jun 2026');
  assert.equal(formatDay(day('2026-01-01')), '01 Jan 2026');
  assert.equal(formatDay(day('2026-12-31')), '31 Dec 2026');
});

test('every month name is three letters', () => {
  assert.equal(MONTHS.length, 12);
  for (const m of MONTHS) assert.equal(m.length, 3, m);
});

test('the day is zero-padded, so a column of dates lines up', () => {
  assert.equal(formatDay(day('2026-09-06')), '06 Sep 2026');
  assert.equal(formatDay(day('2026-09-16')), '16 Sep 2026');
});

test('the format holds at a UTC day boundary', () => {
  // formatDay reads UTC parts off a UTC-constructed date. Reading local
  // parts instead would shift the date by one for anybody west of GMT.
  assert.equal(formatDay(day('2026-03-01')), '01 Mar 2026');
  assert.equal(formatDay(day('2026-02-28')), '28 Feb 2026');
});
