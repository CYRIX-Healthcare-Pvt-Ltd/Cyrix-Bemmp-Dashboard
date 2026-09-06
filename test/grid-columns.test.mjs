/**
 * Every heading has a cell under it.
 *
 * This is a source test rather than a rendering one, which needs a reason.
 * The bug it exists for shipped: seven columns were added to the heading
 * row and to the record each row is built from, and the body row that
 * writes the cells was left alone. A short body row does not leave a gap
 * at the end of the table — every column after the missing one slides one
 * place left and sits under the wrong heading, so Manufacturer reads under
 * Barcode and the Logged date reads under Model. Nothing looks broken.
 * It looks like bad data.
 *
 * There is no DOM here to count cells in, and adding one to catch a
 * miscount is a lot of machinery for a question the source can answer:
 * the heading row is built from a list, so every key in that list must
 * appear as a cell in the body. The list moved to data/meeting.js so this
 * could read it — Node imports .js and not .jsx.
 *
 * The real fix is for the body to map the same list the heading does. Until
 * it does, this is what stands between the two of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { exportColumns } from '../src/data/meeting.js';

const SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'components', 'MeetingTab.jsx'), 'utf8',
);

/** The body of one data row: from the row element to where the entry cells begin. */
function bodyRow() {
  const start = SOURCE.indexOf('<tr key={r.ticket}>');
  const end = SOURCE.indexOf('{MEETING_FIELDS.map(', start);
  assert.ok(start > 0 && end > start, 'could not find the body row in the source');
  return SOURCE.slice(start, end);
}

test('every export column is written as a cell in the body row', () => {
  const body = bodyRow();
  // [.] rather than an escaped dot on purpose: this file is written by
  // tooling often enough that a lone backslash has been eaten more than
  // once, and a regex that silently matches nothing passes silently too.
  const written = new Set(
    [...body.matchAll(/r[.]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );

  const missing = exportColumns(true)
    .filter((c) => !c.entry)
    .map((c) => c.key)
    // Ticket is the pinned cell and is written by hand as a button, and
    // the two money columns format their own numbers; all three are cells,
    // they just do not read `r.key` plainly.
    .filter((k) => !['ticket', 'rate', 'accrued'].includes(k))
    .filter((k) => !written.has(k));

  assert.deepEqual(missing, [],
    `these columns have a heading and no cell: ${missing.join(', ')}`);
});

test('the body row writes one cell per column', () => {
  const body = bodyRow();
  const cells = (body.match(/<td[\s>]/g) ?? []).length;
  // The editable half is drawn by mapping MEETING_FIELDS and cannot fall out
  // of step with its own headings; the slice above stops before it. What is
  // counted here is the hand-written half, which can and did.
  const expected = exportColumns(true).filter((c) => !c.entry).length;
  assert.equal(cells, expected,
    `${cells} cells for ${expected} headings — a mismatch slides every column after it`);
});

test('Installed sits with the export columns, not the editable ones', () => {
  const col = exportColumns(true).find((c) => c.key === 'installed');
  assert.ok(col, 'the Installed column is missing');
  // It comes off the TM export and is rebuilt every upload, so typing over
  // it would be gone by the next one.
  assert.equal(col.entry, undefined);
  assert.equal(col.label, 'Installed');
});

test('every column carries a width', () => {
  // The layout is fixed and sizes from the first row in the DOM, which with
  // only the visible rows built is whichever row you have scrolled to. A
  // column with no width would change size as you scroll.
  const noWidth = exportColumns(true).filter((c) => !c.w).map((c) => c.key);
  assert.deepEqual(noWidth, []);
});
