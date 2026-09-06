import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPUTED, computeField, isComputed } from '../src/data/meeting.js';

/**
 * The four columns the workbook worked out rather than collected.
 *
 * These were formulas in Power Query and columns people retyped into the
 * sheet. Three of them count from today, so there is no stored answer to
 * check them against and nothing to notice when one goes wrong — which
 * is the whole reason they are worth pinning down here.
 *
 * The reference day is fixed at 6 September 2026 so the expectations are
 * arithmetic rather than a moving target.
 */
const NOW = Date.UTC(2026, 8, 6);

test('PI TAT is how long the PI took, or how long it has waited', () => {
  // Converted: the turnaround is fixed once the PR exists.
  assert.equal(computeField('pi_tat', { pi_date: '2026-08-01', pr_date: '2026-08-09' }, NOW), 8);
  // Not converted yet: still running, counted from today.
  assert.equal(computeField('pi_tat', { pi_date: '2026-08-30' }, NOW), 7);
  // Nothing to count from.
  assert.equal(computeField('pi_tat', {}, NOW), null);
});

test('PI TAT is a number of days, never a verdict', () => {
  // The workbook's formula reads as though it returns "Exceeded TAT" or
  // "Under TAT". It never did once in 8,551 rows — the dates there are
  // text, so the subtraction always errored — and the column people
  // actually read has always been a count. A same-day conversion is 0,
  // not a word.
  for (const note of [
    { pi_date: '2026-08-01', pr_date: '2026-08-01' },
    { pi_date: '2026-08-01', pr_date: '2026-08-02' },
    { pi_date: '2026-08-01', pr_date: '2026-08-20' },
  ]) {
    assert.equal(typeof computeField('pi_tat', note, NOW), 'number');
  }
});

test('PR conversion is PR to PO, and nothing until there is a PO', () => {
  assert.equal(computeField('pr_conversion_days', { pr_date: '2026-08-01', po_date: '2026-08-20' }, NOW), 19);
  assert.equal(computeField('pr_conversion_days', { pr_date: '2026-08-01' }, NOW), null);
});

test('purchase delay and standby count from today', () => {
  assert.equal(computeField('purchase_delay_days', { po_date: '2026-09-01' }, NOW), 5);
  assert.equal(computeField('standby_days', { standby_given_date: '2026-07-28' }, NOW), 40);
  // The same day is nought days, not one and not null.
  assert.equal(computeField('purchase_delay_days', { po_date: '2026-09-06' }, NOW), 0);
});

test('whole calendar days, not elapsed hours', () => {
  // Postgres hands some of these back as timestamps. An 18:30 PO raised
  // "five days ago" is five days, not four and a half rounded down.
  assert.equal(
    computeField('purchase_delay_days', { po_date: '2026-09-01T18:30:00.000Z' }, NOW),
    5,
  );
});

test('a date it cannot read is nothing, not a wrong number', () => {
  // 'PI-4471' is the case that matters: new Date() turned it into a day
  // in the fifth century and a delay of -892,770 days. A PO number in a
  // date column is already in the source sheet.
  for (const bad of ['not a date', '', null, undefined, 'PI-4471', '2026-13-40', '06/09/2026']) {
    assert.equal(computeField('purchase_delay_days', { po_date: bad }, NOW), null);
  }
});

test('only the four are computed; everything else is typed', () => {
  for (const k of ['pi_tat', 'pr_conversion_days', 'purchase_delay_days', 'standby_days']) {
    assert.ok(isComputed(k), `${k} should be computed`);
  }
  for (const k of ['penalty_type', 'current_status', 'pi_no', 'pr_no', 'po_no', 'vendor_name']) {
    assert.ok(!isComputed(k), `${k} should stay editable`);
  }
  assert.equal(Object.keys(COMPUTED).length, 4);
});

test('an unknown column is not silently computed as null', () => {
  // computeField returning null for a typed column would make it look
  // empty on screen rather than showing what somebody entered.
  assert.equal(isComputed('nonsense_column'), false);
});
