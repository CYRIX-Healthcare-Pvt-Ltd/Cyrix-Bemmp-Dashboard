/**
 * Cyra's after-the-fact corrections, and the query engine behind her.
 *
 * The model returns a small JSON spec and never sees a ticket. Where it reads a
 * convention the common way rather than the way this business does, the spec is
 * corrected here — deterministically, after the model has spoken, rather than by
 * asking it more nicely on every turn. Each correction below fixes a question
 * that came back with a confidently wrong answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPolarity, resolvePenaltyMeasure, explainWhy, neutralFilters, runQuery,
  resolveSummary, describeResult, datasetContext,
} from '../src/data/assistant.js';
import { disambiguateMonthYear } from '../src/data/openai.js';
import { makeDataset, allFilters, day, AP_PENALTY_DAYS } from './fixture.mjs';

/* ------------------------------------------------------------- polarity --- */

test('"worst" resolves against each measure, not to one fixed direction', () => {
  // Which end of a ranking is the bad one depends on the measure. Models read
  // "worst" as one direction, which answered "which district has the worst
  // closure TAT" with the three *fastest* districts.
  assert.equal(applyPolarity({ measure: 'resolution' }, 'worst closure TAT').order, 'desc',
    'the slowest turnaround is the worst');
  assert.equal(applyPolarity({ measure: 'ftfr' }, 'worst first time fix rate').order, 'asc',
    'the lowest fix rate is the worst');
});

test('"best" is the other end of the same axis', () => {
  assert.equal(applyPolarity({ measure: 'ftfr' }, 'best performing district').order, 'desc');
  assert.equal(applyPolarity({ measure: 'resolution' }, 'best turnaround').order, 'asc');
});

test('a question that states its own direction is left alone', () => {
  // It fires only on a quality word. "The highest average resolution time" says
  // which end it wants, and overriding that would be the same bug in reverse.
  const spec = { measure: 'resolution', order: 'desc' };
  assert.equal(applyPolarity(spec, 'the highest average resolution time').order, 'desc');
  assert.equal(applyPolarity({ ...spec, order: 'asc' }, 'lowest average resolution').order, 'asc');
});

/* ------------------------------------------------------- penalty measure --- */

test('"penalty" on its own means money', () => {
  // Three penalty measures exist and the model reaches for the call count,
  // because `penalty` is the shortest name in the list. "Which district has the
  // highest penalty" came back "Thiruvananthapuram, 11" — a number of calls
  // where a figure in rupees was asked for.
  const out = resolvePenaltyMeasure(
    { measure: 'penalty' }, 'which district has the highest penalty', true,
  );
  assert.equal(out.measure, 'perDayPenalty');
});

test('a question that names the count keeps the count', () => {
  for (const q of [
    'how many penalty calls are there',
    'number of penalty calls by district',
  ]) {
    assert.equal(resolvePenaltyMeasure({ measure: 'penalty' }, q, true).measure, 'penalty', q);
  }
});

test('a contract with no rate card keeps the count too', () => {
  // Andhra has none, so swapping there would turn a real answer into
  // "this cannot be calculated".
  const out = resolvePenaltyMeasure(
    { measure: 'penalty' }, 'which district has the highest penalty', false,
  );
  assert.equal(out.measure, 'penalty');
});

test('closure wording reaches the closure measure', () => {
  const out = resolvePenaltyMeasure(
    { measure: 'penalty' }, 'what was the closure penalty last month', true,
  );
  assert.equal(out.measure, 'closurePenalty');
});

/* ------------------------------------------------------------------ why --- */

test('"why" is a query, not a refusal', () => {
  // Asked what was causing a figure, the model would decline rather than break
  // it down. A "why" question with no dimension gets one.
  const out = explainWhy({ measure: 'perDayPenalty', dimension: 'none' },
    'what is causing this much penalty');
  assert.equal(out.dimension, 'equipment');
});

test('a why question that already names a dimension keeps it', () => {
  const out = explainWhy({ measure: 'penalty', dimension: 'district' },
    'why is the penalty so high by district');
  assert.equal(out.dimension, 'district');
});

/* ----------------------------------------------------------- month/year --- */

test('"June 26" is June of 2026, not the 26th of June', () => {
  // The exact misreading: asked for "June 26", the model used the year digits
  // as the day and returned a single date. Corrected to the whole month.
  const out = disambiguateMonthYear(
    { fromDate: '2026-06-26', toDate: '2026-06-26' }, 'how many calls in June 26',
  );
  assert.equal(out.fromDate, '2026-06-01');
  assert.equal(out.toDate, '2026-06-30', 'an end month means its last day');
});

test('a real day-of-month is left alone', () => {
  // It corrects only when the day digits match the year digits in the question.
  // "5 June" is a date somebody meant, and rewriting it would be the same bug.
  const spec = { fromDate: '2026-06-05', toDate: '2026-06-05' };
  assert.deepEqual(disambiguateMonthYear(spec, 'calls on 5 June'), spec);
});

/* ------------------------------------------------------- the query scope --- */

test('her baseline is the whole contract, not the dashboard filters', () => {
  const ds = makeDataset([
    { loggedDay: day('2026-06-10'), district: 'Palakkad' },
    { loggedDay: day('2026-08-10'), district: 'Kannur' },
  ]);
  const scope = neutralFilters(ds);

  assert.equal(scope.dayFrom, ds.meta.dateRange.minDay);
  assert.equal(scope.dayTo, ds.meta.dateRange.maxDay);
  assert.equal(scope.district.size, 0, 'nothing selected');

  const result = runQuery(ds, scope, day('2026-08-20'), { measure: 'calls', dimension: 'none' });
  assert.equal(result.headline.value, 2, 'both calls, whatever the page is showing');
});

test('a district in the question does not intersect with one left in the panel', () => {
  // The failure this replaced: the panel had Kannur selected, the question asked
  // about Palakkad, and the two intersected to nothing. The answer was zero, and
  // nothing on screen said why.
  const ds = makeDataset([
    { loggedDay: day('2026-06-10'), district: 'Palakkad' },
    { loggedDay: day('2026-06-11'), district: 'Palakkad' },
    { loggedDay: day('2026-08-10'), district: 'Kannur' },
  ]);

  const result = runQuery(ds, neutralFilters(ds), day('2026-08-20'), {
    measure: 'calls', dimension: 'none',
    filterDimension: 'district', filterValue: 'palakkad',
  });

  assert.equal(result.headline.value, 2);
  assert.match(result.appliedFilter.label, /Palakkad/);
});

test('a dictionary entry that folds to nothing cannot win a lookup', () => {
  // `"-  -"` folds to the empty string, and an empty needle matched every
  // engineer — so "which engineer has the highest penalty" resolved to a blank
  // row and answered ₹0. Every real engineer had to be reachable again.
  const ds = makeDataset([
    { loggedDay: day('2026-06-10'), engineer: '-  -' },
    { loggedDay: day('2026-06-11'), engineer: 'KL01 - Aswin Kumar - 9876543210' },
    { loggedDay: day('2026-06-12'), engineer: 'KL01 - Aswin Kumar - 9876543210' },
  ]);

  const result = runQuery(ds, neutralFilters(ds), day('2026-08-20'), {
    measure: 'calls', dimension: 'none',
    filterDimension: 'engineer', filterValue: 'aswin',
  });

  assert.equal(result.headline.value, 2, 'the named engineer, not the blank row');
});

test('an explicit date window overrides the preset', () => {
  const ds = makeDataset([
    { loggedDay: day('2026-06-10') },
    { loggedDay: day('2026-07-10') },
    { loggedDay: day('2026-08-10') },
  ]);

  const result = runQuery(ds, neutralFilters(ds), day('2026-08-20'), {
    measure: 'calls', dimension: 'none',
    range: 'all', fromDate: '2026-07-01', toDate: '2026-07-31',
  });

  assert.equal(result.headline.value, 1, 'named dates win over the range enum');
  assert.equal(result.effective.dayFrom, day('2026-07-01'));
});

test('a window before the contract started is clamped to it', () => {
  const ds = makeDataset([{ loggedDay: day('2026-06-10') }]);

  const result = runQuery(ds, neutralFilters(ds), day('2026-08-20'), {
    measure: 'calls', dimension: 'none', fromDate: '2019-01-01',
  });

  // Reporting the contract's own start is honest; answering for a period the
  // data cannot speak to is not.
  assert.equal(result.effective.dayFrom, ds.meta.dateRange.minDay);
});

test('a money measure on a contract with no rate card refuses rather than inventing', () => {
  const ds = makeDataset([{ loggedDay: day('2026-06-10') }], {
    id: 'ap', name: 'Andhra Pradesh', penaltyRates: null,
  });

  assert.throws(
    () => runQuery(ds, neutralFilters(ds), day('2026-08-20'), { measure: 'perDayPenalty' }),
    /rate card/i,
  );
});

test('the filter object is the engine\'s, so a spec filter reaches filterRows', () => {
  const ds = makeDataset([
    { loggedDay: day('2026-06-10'), equipment: 'ECG Machine' },
    { loggedDay: day('2026-06-11'), equipment: 'Ventilator' },
  ]);
  const scope = neutralFilters(ds);

  // Everything `filterRows` honours must exist on her baseline, or a filter the
  // model sets is silently ignored — the keys are wider than the four the panel
  // offers precisely because she sets them straight from a question.
  const engineKeys = Object.keys(scope).filter((k) => scope[k] instanceof Set);
  assert.ok(engineKeys.includes('equipment'));
  assert.ok(engineKeys.includes('engineer'), 'not offered in the panel, still filterable');

  const result = runQuery(ds, scope, day('2026-08-20'), {
    measure: 'calls', dimension: 'none',
    filterDimension: 'equipment', filterValue: 'ecg',
  });
  assert.equal(result.headline.value, 1);
});

test('unfiltered totals agree with the dashboard summary', () => {
  // The whole point of running the spec locally: the sentence and the tiles are
  // computed from the same arrays, so they cannot disagree.
  const ds = makeDataset([
    { loggedDay: day('2026-06-10') },
    { loggedDay: day('2026-06-11'), parkedReason: 'rber' },
    { loggedDay: day('2026-06-12'), resolvedDay: day('2026-06-13') },
  ]);
  const at = day('2026-08-20');

  assert.equal(runQuery(ds, neutralFilters(ds), at, { measure: 'calls' }).headline.value, 3);
  assert.equal(runQuery(ds, neutralFilters(ds), at, { measure: 'open' }).headline.value, 1);
  assert.equal(runQuery(ds, neutralFilters(ds), at, { measure: 'unresolved' }).headline.value, 1);
});

/* ------------------------------------------------------------- summaries --- */

const MIXED = [
  { loggedDay: day('2026-01-05'), zone: 'South', district: 'Kollam', dayRate: 500 },
  { loggedDay: day('2026-06-02'), zone: 'South', district: 'Kollam', resolvedDay: day('2026-06-02') },
  { loggedDay: day('2026-06-03'), zone: 'South', district: 'Kollam', parkedReason: 'rber' },
  { loggedDay: day('2026-02-04'), zone: 'North', district: 'Kannur', dayRate: 3000 },
  { loggedDay: day('2026-06-05'), zone: 'North', district: 'Kannur', resolvedDay: day('2026-06-06') },
];

test('"summary" reaches the overview measure, not one figure', () => {
  // It answered "Total calls: 2,70,293" and stopped, which is a number rather
  // than an overview. Any of the usual wordings must land on the whole picture.
  for (const q of [
    'give me an overall summary',
    'share the overview',
    'how are things looking',
    'tell me about the Kerala project',
  ]) {
    assert.equal(resolveSummary({ dimension: 'none' }, q).measure, 'overview', q);
  }
});

test('a summary of one measure by a dimension is left alone', () => {
  // "Summary of penalty by district" is a ranking somebody asked for, and
  // replacing it with eight unrelated figures is the same failure reversed.
  const spec = { measure: 'penalty', dimension: 'district' };
  assert.deepEqual(resolveSummary(spec, 'summary of penalty by district'), spec);
});

test('the overview carries every headline figure', () => {
  const ds = makeDataset(MIXED);
  const r = runQuery(ds, neutralFilters(ds), day('2026-08-20'), { measure: 'overview' });

  const keys = r.overview.map((o) => o.key);
  for (const k of ['total', 'open', 'parked', 'resolved', 'penalty', 'ftfr', 'tat', 'repeats']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  assert.equal(r.overview.find((o) => o.key === 'total').display, '5');
  assert.equal(r.headline, null, 'a summary has no single headline');
});

test('a summary narrows to whatever the question named', () => {
  const ds = makeDataset(MIXED);
  const at = day('2026-08-20');

  const whole = runQuery(ds, neutralFilters(ds), at, { measure: 'overview' });
  const south = runQuery(ds, neutralFilters(ds), at, {
    measure: 'overview', filterDimension: 'zone', filterValue: 'south',
  });

  assert.equal(whole.overview.find((o) => o.key === 'total').display, '5');
  assert.equal(south.overview.find((o) => o.key === 'total').display, '3');
  assert.match(describeResult(ds, south), /^South/, 'the sentence names the scope');
});

test('the summary money figure is the sum of the accruing day rates', () => {
  const ds = makeDataset(MIXED);
  const at = day('2026-08-20');

  const whole = runQuery(ds, neutralFilters(ds), at, { measure: 'overview' });
  const south = runQuery(ds, neutralFilters(ds), at, {
    measure: 'overview', filterDimension: 'zone', filterValue: 'south',
  });

  assert.equal(whole.overview.find((o) => o.key === 'perDay').value, 3500, '500 + 3000');
  assert.equal(south.overview.find((o) => o.key === 'perDay').value, 500, 'Kollam only');
});

test('a contract with no rate card gets a summary without the money line', () => {
  const ds = makeDataset(MIXED, { id: 'ap', name: 'Andhra Pradesh', penaltyRates: null });
  const r = runQuery(ds, neutralFilters(ds), day('2026-08-20'), { measure: 'overview' });

  // A confident ₹0 is worse than the figure simply not being there.
  assert.equal(r.overview.find((o) => o.key === 'perDay'), undefined);
  assert.doesNotMatch(describeResult(ds, r), /costing/);
});

test('the sentence counts one breach in the singular', () => {
  const ds = makeDataset(MIXED);
  const south = runQuery(ds, neutralFilters(ds), day('2026-08-20'), {
    measure: 'overview', filterDimension: 'zone', filterValue: 'south',
  });
  assert.match(describeResult(ds, south), /1 call is past its non-penalty period/);
  assert.doesNotMatch(describeResult(ds, south), /1 calls/);
});

/* -------------------------------------------------------- contract facts --- */

test('the SLA window in the context is the contract\'s own number', () => {
  // Asked "what is SLA" she gave the dictionary definition of the phrase — true
  // of the words, useless to a service manager who wants to know how many days
  // they have. The context now carries the number the figures are computed with.
  const kl = makeDataset([{ loggedDay: day('2026-06-01') }]);
  const context = datasetContext(kl);

  assert.match(context, /non-penalty period is 7 days/);
  assert.match(context, /TAT/, 'the business\'s other word for the same window');
  assert.match(context, /grace period/, "still understood when somebody types it");
});

test('a contract with two windows says so, with both numbers', () => {
  const ap = makeDataset([{ loggedDay: day('2026-06-01') }], {
    id: 'ap', name: 'Andhra Pradesh', penaltyDays: AP_PENALTY_DAYS, penaltyRates: null,
  });
  const context = datasetContext(ap);

  assert.match(context, /2 days for critical/);
  assert.match(context, /7 for the rest/);
  assert.doesNotMatch(context, /7 days for every asset/, 'Kerala\'s wording must not leak');
});

test('the context never claims a rate card a contract does not have', () => {
  const ap = makeDataset([{ loggedDay: day('2026-06-01') }], {
    id: 'ap', name: 'Andhra Pradesh', penaltyDays: AP_PENALTY_DAYS, penaltyRates: null,
  });
  assert.match(datasetContext(ap), /NO penalty rate card/);
  assert.match(datasetContext(makeDataset([{ loggedDay: day('2026-06-01') }])),
    /has a penalty rate card/);
});
