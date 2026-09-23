/**
 * Every heading has a cell under it.
 *
 * The bug this file exists for shipped: seven columns were added to the
 * heading row and to the record each row is built from, and the body row
 * that wrote the cells by hand was left alone. A short body row does not
 * leave a gap at the end of the table — every column after the missing one
 * slides one place left and sits under the wrong heading, so Manufacturer
 * reads under Barcode and the Logged date reads under Model. Nothing looks
 * broken. It looks like bad data.
 *
 * The fix it asked for is in: the body maps the same list the heading does
 * (`shown` — the columns somebody has chosen to see, which is also what made
 * choosing them possible). What is left to guard is that it stays that way,
 * and that every column in each contract's list is one a row has a value for.
 *
 * Source tests rather than rendering ones: there is no DOM here, and the
 * question is one the source answers. The lists live in data/meeting.js so
 * this can read them — Node imports .js and not .jsx.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { exportColumns, upColumns } from '../src/data/meeting.js';

const SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'components', 'MeetingTab.jsx'), 'utf8',
);

const LISTS = {
  'Kerala': exportColumns(true),
  'Andhra': exportColumns(false),
  'Uttar Pradesh': upColumns(),
};

/** The body of one data row: from the row element to the log cell that ends it. */
function bodyRow() {
  const start = SOURCE.indexOf('<tr key={r.ticket}>');
  const end = SOURCE.indexOf('className="log-cell"', start);
  assert.ok(start > 0 && end > start, 'could not find the body row in the source');
  return SOURCE.slice(start, end);
}

test('the heading row and the body row draw the same list', () => {
  const head = SOURCE.slice(SOURCE.indexOf('<thead>'), SOURCE.indexOf('</thead>'));
  assert.match(head, /\{shown[.]map\(\(c\) =>/, 'the heading row no longer maps `shown`');
  const body = bodyRow();
  assert.match(body, /\{shown[.]map\(\(c\) =>/, 'the body row no longer maps `shown`');
  // One map, one cell each: a second hand-written cell in the row is the
  // start of the old bug again.
  assert.equal((body.match(/\.map\(/g) ?? []).length, 1,
    'the body row draws cells from something other than `shown`');
});

test('the ticket is always shown, whatever is chosen', () => {
  assert.match(SOURCE, /columns[.]filter\(\(c\) => c[.]key === 'ticket' \|\| !hidden[.]has\(c[.]key\)\)/);
  for (const [name, list] of Object.entries(LISTS)) {
    assert.equal(list[0].key, 'ticket', `${name}: the ticket is not the first column`);
  }
});

test('every column a row is not given by an entry field is one the row carries', () => {
  // Each export column's value is set on the row under its own key, in the
  // row builder or in Uttar Pradesh's penalty — `key: value` or a bare
  // shorthand `key,` on a line of its own. Spaces rather than an escaped
  // class, for the reason the dots below were once [.]: a backslash in this
  // file has been eaten by tooling before, and a regex that matches nothing
  // fails every column rather than the missing one.
  for (const [name, list] of Object.entries(LISTS)) {
    const missing = list
      .filter((c) => !c.entry && c.key !== 'ticket')
      .map((c) => c.key)
      .filter((k) => !new RegExp(`^ +${k}(:|,$)`, 'm').test(SOURCE));
    assert.deepEqual(missing, [], `${name}: these columns have a heading and nothing to show: ${missing.join(', ')}`);
  }
});

test('no contract lists a column twice', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    const seen = new Set();
    const twice = list.map((c) => c.key).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual(twice, [], `${name}: ${twice.join(', ')}`);
  }
});

test('Down Days sits after Ticket remark and before Per day penalty', () => {
  const keys = exportColumns(true).map((c) => c.key);
  assert.equal(keys.indexOf('age'), keys.indexOf('remark') + 1);
  assert.equal(keys.indexOf('rate'), keys.indexOf('age') + 1);
});

test('Installed sits with the export columns, not the editable ones', () => {
  const col = exportColumns(true).find((c) => c.key === 'installed');
  assert.ok(col, 'the Installed column is missing');
  // It comes off the TM export and is rebuilt every upload, so typing over
  // it would be gone by the next one.
  assert.equal(col.entry, undefined);
  assert.equal(col.label, 'Installed');
});

test('Uttar Pradesh reads the TM export, then the penalty, then the meeting', () => {
  // The user, 23 Sep: the penalty columns "should come after TM UP columns".
  const groups = upColumns().map((c) => c.group);
  const order = groups.filter((g, i) => g !== groups[i - 1]);
  assert.deepEqual(order, ['tm', 'penalty', 'entry']);
});

test('every column carries a width', () => {
  // The layout is fixed and sizes from the first row in the DOM, which with
  // only the visible rows built is whichever row you have scrolled to. A
  // column with no width would change size as you scroll.
  for (const [name, list] of Object.entries(LISTS)) {
    const noWidth = list.filter((c) => !c.w).map((c) => c.key);
    assert.deepEqual(noWidth, [], name);
  }
});
