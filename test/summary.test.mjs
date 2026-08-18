/**
 * The ticket tracker's Summary, against the rules the business's workbook uses.
 *
 * These are deliberately not the dashboard's penalty rules, and that is the
 * thing most at risk of being "corrected" later by someone who notices the two
 * disagree. The tracker is reconciled against `KL Ticket Wise - Tracker.xlsx` in
 * the daily meeting; the dashboard is not. Each of the cases below is one where
 * following the dashboard instead would change a figure on screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUCKET } from '../shared/schema.mjs';
import { trackerSummary } from '../src/data/summary.js';
import { makeDataset, day } from './fixture.mjs';

/* grace 7 and a 7-day window, which is Kerala's. */
const ROWS = [
  // Open, well past the window. 30 - 7 = 23 days at 100 = 2,300.
  {
    district: 'Kannur', zone: 'North', bucket: BUCKET.OPEN,
    loggedDay: day('2026-07-01'), downDays: 30, dayRate: 100,
  },
  // Open, past the window, a different type.
  {
    district: 'Kannur', zone: 'North', bucket: BUCKET.OPEN,
    loggedDay: day('2026-07-10'), downDays: 10, dayRate: 50,
  },
  // Open but exactly ON the window — 7 is not "> 7", so not a penalty call.
  {
    district: 'Kannur', zone: 'North', bucket: BUCKET.OPEN,
    loggedDay: day('2026-07-20'), downDays: 7, dayRate: 900,
  },
  // Parked, and old enough to breach. Counted as an unresolved call and in no
  // penalty figure at all.
  {
    district: 'Kollam', zone: 'South', bucket: BUCKET.PARKED,
    loggedDay: day('2026-01-01'), downDays: 200, dayRate: 5000,
  },
  // Open, past the window, but nobody has recorded a penalty type.
  {
    district: 'Kollam', zone: 'South', bucket: BUCKET.OPEN,
    loggedDay: day('2026-07-05'), downDays: 20, dayRate: 400,
  },
];

const TYPES = ['Rber', 'TRC'];
/* Row 0 is Rber, row 1 is TRC, row 4 is left uncategorised. */
const typeOf = (row) => ({ 0: 'Rber', 1: 'TRC' })[row] ?? null;

const build = () => trackerSummary(
  makeDataset(ROWS), [0, 1, 2, 3, 4], typeOf, TYPES,
);

test('total open counts parked calls; penalty counts only open ones', () => {
  const s = build();
  assert.equal(s.total.open, 5, 'every unresolved row, parked included');
  assert.equal(s.total.penaltyCalls, 3, 'rows 0, 1 and 4 — not the parked one, not the one on 7');

  const kollam = s.districts.find((d) => d.district === 'Kollam');
  assert.equal(kollam.open, 2, 'the parked call is in this column');
  assert.equal(kollam.penaltyCalls, 1, 'and in none of the others');
  assert.equal(kollam.perDay, 400, 'the parked call\'s 5,000/day never appears');
});

test('the window is strictly greater, so a call on exactly 7 days is not one', () => {
  const s = build();
  const kannur = s.districts.find((d) => d.district === 'Kannur');
  assert.equal(kannur.penaltyCalls, 2);
  assert.equal(kannur.perDay, 150, '100 + 50; the 900/day row is still inside its window');
});

test('accrued is (down days - grace) x rate, floored at zero', () => {
  const s = build();
  const kannur = s.districts.find((d) => d.district === 'Kannur');
  // (30-7)*100 + (10-7)*50 = 2300 + 150
  assert.equal(kannur.accrued, 2450);
  assert.equal(s.total.accrued, 2450 + (20 - 7) * 400);
});

test('a call inside its grace window owes nothing rather than a negative amount', () => {
  // Down days below the grace period would make the workbook's own subtraction
  // negative; here it clamps, exactly as closurePenalty does.
  const ds = makeDataset([
    { district: 'Kannur', bucket: BUCKET.OPEN, downDays: 9, dayRate: 100 },
  ], { penaltyDays: { CRITICAL: 2, 'NON CRITICAL': 2 }, graceDays: 30 });
  const s = trackerSummary(ds, [0], () => null, []);
  assert.equal(s.total.penaltyCalls, 1, 'past the 2-day window');
  assert.equal(s.total.accrued, 0, 'but inside the 30-day grace, so it owes nothing');
});

test('contribution is the share of the per-day figure, not of the call count', () => {
  const s = build();
  const rber = s.types.find((t) => t.name === 'Rber');
  const trc = s.types.find((t) => t.name === 'TRC');

  assert.equal(rber.count, 1);
  assert.equal(trc.count, 1, 'one call each');
  // 100 and 50 of a 150 total — two thirds and one third, not half and half.
  assert.equal(rber.value, 100);
  assert.equal(trc.value, 50);
  assert.ok(Math.abs(rber.share - 2 / 3) < 1e-9);
  assert.ok(Math.abs(trc.share - 1 / 3) < 1e-9);
});

test('an uncategorised penalty call is reported rather than silently dropped', () => {
  const s = build();
  // The workbook's two blocks disagree for exactly this reason and say nothing
  // about it — 385 calls against 376.
  assert.equal(s.total.penaltyCalls, 3);
  assert.equal(s.typeTotal.count, 2, 'the type block is short');
  assert.equal(s.untyped.count, 1);
  assert.equal(s.untyped.value, 400, 'and the gap is worth naming in money too');

  // It is still in its district's figures.
  const kollam = s.districts.find((d) => d.district === 'Kollam');
  assert.equal(kollam.penaltyCalls, 1);
  assert.equal(kollam.byType.size, 0, 'but against no type');
});

test('a type nobody has used keeps its row', () => {
  const s = trackerSummary(makeDataset(ROWS), [0, 1, 2, 3, 4], () => null, ['Rber', 'Warranty']);
  assert.deepEqual(s.types.map((t) => t.name), ['Rber', 'Warranty'], 'the vocabulary decides the rows');
  assert.equal(s.types[1].count, 0);
  assert.equal(s.types[1].share, 0, 'no division by zero when nothing is categorised');
});

test('districts come back in alphabetical order, as the sheet lists them', () => {
  const s = build();
  assert.deepEqual(s.districts.map((d) => d.district), ['Kannur', 'Kollam']);
  assert.equal(s.districts[0].zone, 'North', 'zone rides along as a label on the district');
});
