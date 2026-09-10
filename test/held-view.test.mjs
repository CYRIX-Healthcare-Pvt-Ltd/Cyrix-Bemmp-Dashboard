import test from 'node:test';
import assert from 'node:assert/strict';
import { BLANK, applyFilters, holdRows } from '../src/data/meeting.js';

/**
 * A filtered row stays on screen while it is being filled in.
 *
 * The reported case: PO no filtered to blanks, a PO number typed into one
 * row, and the row vanished the moment it saved — so PO date could not be
 * reached, and the save looked as though it had failed. One PO number
 * ended up on three tickets that way.
 *
 * The view decides which rows it holds when the filter is applied; a
 * saved cell changes values, not membership.
 */

const before = [
  { ticket: '288322', pr_no: '102416', po_no: '' },
  { ticket: '288298', pr_no: '102418', po_no: null },
  { ticket: '287977', pr_no: '102419', po_no: '' },
  { ticket: '280001', pr_no: '102001', po_no: 'PO-9' },
];

const blanksOnly = [['po_no', [BLANK]]];

// What the view holds once "PO no: blanks" is applied.
const held = applyFilters(before, blanksOnly).map((r) => r.ticket);

// The PO number is typed into the first row and saved.
const after = before.map((r) => (r.ticket === '288322' ? { ...r, po_no: '102322' } : r));

test('the filter holds the blank rows when it is applied', () => {
  assert.deepEqual(held, ['288322', '288298', '287977']);
});

test('a row whose PO was just entered stays on screen', () => {
  const shown = holdRows(held, after);
  assert.deepEqual(shown.map((r) => r.ticket), ['288322', '288298', '287977']);
});

test('it shows the new value, not the old one', () => {
  const row = holdRows(held, after).find((r) => r.ticket === '288322');
  assert.equal(row.po_no, '102322');
});

test('reapplying the filter is what finally lets it go', () => {
  // "If on next filter, blank only it should change."
  const reapplied = applyFilters(after, blanksOnly).map((r) => r.ticket);
  assert.deepEqual(reapplied, ['288298', '287977']);
});

test('the held order survives an edit to the value it was sorted by', () => {
  const sorted = ['287977', '288298', '288322'];
  const shown = holdRows(sorted, after).map((r) => r.ticket);
  assert.deepEqual(shown, sorted);
});

test('a row that no longer exists is dropped rather than drawn empty', () => {
  // A call that closed between loads.
  const closed = after.filter((r) => r.ticket !== '288298');
  assert.deepEqual(holdRows(held, closed).map((r) => r.ticket), ['288322', '287977']);
});
