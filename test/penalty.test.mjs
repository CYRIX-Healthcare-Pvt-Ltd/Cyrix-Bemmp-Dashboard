/**
 * Penalty: the flag, and the two money figures.
 *
 * A penalty call is an open call past its SLA window, evaluated as of the newest
 * logged date in the export. The test is strictly greater, penalty is a subset
 * of open, and the two money measures are disjoint by construction — each of
 * those has been got wrong, and each is checkable in a few rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarize, penaltyRows, accruingRows, penaltyStartDay, penaltyDaysIn,
  penaltyAmountIn, closurePenalty, penaltyEligibleThrough, filterRows,
} from '../src/data/query.js';
import {
  makeDataset, allRows, allFilters, day, iso, AP_PENALTY_DAYS,
} from './fixture.mjs';

const REF = day('2026-08-20');

test('the SLA test is strictly greater, so the logged date is not counted', () => {
  // A call logged 1 July is on penalty on 9 July (age 8), not 8 July (age 7).
  const logged = day('2026-07-01');
  const ds = makeDataset([{ loggedDay: logged }]);   // open, 7-day window

  const onDay7 = penaltyRows(ds, allRows(ds), logged + 7);
  const onDay8 = penaltyRows(ds, allRows(ds), logged + 8);

  assert.equal(onDay7.length, 0, `age 7 is inside SLA (${iso(logged + 7)})`);
  assert.equal(onDay8.length, 1, `age 8 has breached (${iso(logged + 8)})`);
});

test('penalty is a subset of open — parked and resolved never count', () => {
  const old = day('2026-06-01');   // far past any window
  const ds = makeDataset([
    { loggedDay: old },                              // open, breached
    { loggedDay: old, parkedReason: 'rber' },        // parked
    { loggedDay: old, resolvedDay: day('2026-06-25') }, // resolved, took 24 days
  ]);

  const s = summarize(ds, allRows(ds), REF);

  // A resolved call that took three weeks is emphatically not a penalty call
  // under this definition — the charge is for the backlog, not for slowness.
  assert.equal(s.penalty, 1);
  assert.ok(s.penalty <= s.open, 'penalty can never exceed open');
});

test('each criticality gets its own window where a contract has two', () => {
  const logged = day('2026-07-01');
  const ds = makeDataset(
    [
      { loggedDay: logged, equipmentType: 'CRITICAL' },
      { loggedDay: logged, equipmentType: 'NON CRITICAL' },
    ],
    { id: 'ap', name: 'Andhra Pradesh', penaltyDays: AP_PENALTY_DAYS, penaltyRates: null },
  );

  // Andhra: 2 days critical, 7 non-critical.
  assert.equal(penaltyRows(ds, allRows(ds), logged + 3).length, 1, 'only critical has breached');
  assert.equal(penaltyRows(ds, allRows(ds), logged + 8).length, 2, 'both have breached');
});

test('the chart stops before a date could possibly have breached', () => {
  const ds = makeDataset([{ loggedDay: day('2026-08-01') }]);
  const cutoff = penaltyEligibleThrough(ds, REF);

  // Not "no breaches yet" but "no breach *possible* yet" — plotted, the last
  // window's worth of days drew a cliff to zero that read as the backlog
  // clearing. Shortest window, because a date qualifies as soon as any
  // criticality could have breached in it.
  assert.equal(cutoff, REF - 7 - 1, 'referenceDay - shortestWindow - 1');
});

/* ------------------------------------------------------------------ money -- */

test('penalty starts after the grace window, not on the logged date', () => {
  const logged = day('2026-07-01');
  const ds = makeDataset([{ loggedDay: logged, dayRate: 500 }]);

  // Workbook column AM: penalty start = Logged + 8.
  assert.equal(penaltyStartDay(ds, 0), logged + 8);
});

test('accrued days are inclusive of both ends and floored at zero', () => {
  const logged = day('2026-07-01');
  const ds = makeDataset([{ loggedDay: logged, dayRate: 500 }]);
  const start = penaltyStartDay(ds, 0);

  assert.equal(penaltyDaysIn(ds, 0, 0, start), 1, 'the first penalty day counts as one');
  assert.equal(penaltyDaysIn(ds, 0, 0, start + 9), 10, 'AS = AO - AN + 1');
  assert.equal(penaltyDaysIn(ds, 0, 0, start - 1), 0, 'inside the grace window owes nothing');
  assert.equal(penaltyAmountIn(ds, 0, 0, start + 9), 5000, 'days x rate');
});

test('closure penalty clamps at zero where the workbook goes negative', () => {
  const logged = day('2026-07-01');
  const ds = makeDataset([
    { loggedDay: logged, resolvedDay: logged + 20, dayRate: 500 },  // well past grace
    { loggedDay: logged, resolvedDay: logged + 2, dayRate: 500 },   // closed inside grace
  ]);

  // AZ = (Resolved - (Logged + 8) + 1) x AU.
  assert.equal(closurePenalty(ds, 0), (20 - 8 + 1) * 500);

  // The workbook does not clamp, so a ticket closed inside its grace window
  // produces a negative figure there. A negative penalty is not a meaningful
  // number to report and those tickets owe nothing.
  assert.equal(closurePenalty(ds, 1), 0);
});

test('the per-day figure counts open tickets only', () => {
  const logged = day('2026-06-01');
  const ds = makeDataset([
    { loggedDay: logged, dayRate: 500 },                              // open, accruing
    { loggedDay: logged, resolvedDay: day('2026-06-20'), dayRate: 500 }, // closed
    { loggedDay: logged, parkedReason: 'rber', dayRate: 500 },        // parked
  ]);

  const rows = accruingRows(ds, allRows(ds), 0, REF);

  // It is a burn rate — what the contract costs today — so a closed ticket
  // contributes nothing however much it accrued before closing; that is the
  // closure penalty's job. Without the bucket test this also picked up every
  // ticket that merely *finished* accruing inside the window, which in Kerala
  // roughly doubled both the count and the daily figure.
  assert.equal(rows.length, 1);
  assert.equal(ds.cols.bucket[rows[0]], 0, 'the one accruing row is the open one');
});

test('the two money measures are disjoint by construction', () => {
  const logged = day('2026-06-01');
  const ds = makeDataset([
    { loggedDay: logged, dayRate: 500 },
    { loggedDay: logged, resolvedDay: day('2026-06-25'), dayRate: 500 },
  ]);

  // An open ticket carries a per-day rate and no closure figure; a closed one
  // the reverse. That is what the two columns in the ticket grid show.
  assert.equal(closurePenalty(ds, 0), 0, 'an open ticket has settled nothing');
  assert.ok(closurePenalty(ds, 1) > 0, 'a closed ticket has');
  assert.deepEqual(accruingRows(ds, allRows(ds), 0, REF), [0]);
});

test('accrual ignores the logged-date window entirely', () => {
  // A call logged in May is still running up penalty in July, which is exactly
  // what the workbook's AN clamp encodes. Filtering accrual by logged date
  // silently understates it.
  const may = day('2026-05-04');
  const ds = makeDataset([
    { loggedDay: may, dayRate: 500 },
    { loggedDay: day('2026-07-15'), dayRate: 500 },
  ]);

  const july = allFilters(ds, { dayFrom: day('2026-07-01'), dayTo: day('2026-07-31') });

  const byLoggedDate = filterRows(ds, july);
  const undated = filterRows(ds, july, { dateField: null });

  assert.equal(byLoggedDate.length, 1, 'a logged-date window drops the May call');
  assert.equal(undated.length, 2, 'accrual must see it — it is still costing money');
});

test('closure penalty is scoped by resolved date, not logged date', () => {
  // A ticket logged in April and closed in June belongs to June. It is the only
  // view in the dashboard that filters on a different date field.
  const ds = makeDataset([
    { loggedDay: day('2026-04-10'), resolvedDay: day('2026-06-15'), dayRate: 500 },
  ]);

  const june = allFilters(ds, { dayFrom: day('2026-06-01'), dayTo: day('2026-06-30') });

  assert.equal(filterRows(ds, june).length, 0, 'by logged date it is not in June');
  assert.equal(filterRows(ds, june, { dateField: 'resolvedDay' }).length, 1,
    'by resolved date it is');
});
