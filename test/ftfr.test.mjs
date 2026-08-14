/**
 * First Time Fix Rate.
 *
 * The figure the business checks the dashboard against, and the one that has
 * been wrong twice. Both times it looked plausible: 59.3% against their 49%,
 * and a Saturday sawtooth that read as a real dip in weekend performance. Every
 * case below is a rule that was got wrong once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FTFR_MAX_DAYS, ftfrWindowEnd, isFirstTimeFix } from '../shared/schema.mjs';
import { summarize, ftfrSettledThrough, maxResolvedDay, buildSeries } from '../src/data/query.js';
import { makeDataset, allRows, day, iso } from './fixture.mjs';

/* 2026 calendar used throughout, so the weekday of each date is explicit:
 *   Fri 2026-08-07, Sat 08, Sun 09, Mon 10, Tue 11, Wed 12, Thu 13 */

test('a call resolved the same day or the next is a first-time fix', () => {
  const mon = day('2026-08-10');
  assert.equal(isFirstTimeFix(mon, mon), true, 'same day');
  assert.equal(isFirstTimeFix(mon, mon + 1), true, 'next day');
  assert.equal(isFirstTimeFix(mon, mon + 2), false, 'two days is outside the window');
});

test('an unresolved call is not a fix, and neither is a negative span', () => {
  const mon = day('2026-08-10');
  assert.equal(isFirstTimeFix(mon, 0), false, 'resolved date blank');
  assert.equal(isFirstTimeFix(mon, mon - 1), false, 'resolved before logged');
  assert.equal(isFirstTimeFix(0, mon), false, 'logged date blank');
});

test('Sunday is not a service day, so the window steps over it', () => {
  const sat = day('2026-08-08');
  const sun = day('2026-08-09');
  const mon = day('2026-08-10');
  const tue = day('2026-08-11');

  // Saturday's window would otherwise end on Sunday, when nobody works. It ends
  // on Monday instead. Without this every Saturday scored about 30% against
  // weekday neighbours at 60% — an artefact of the service week, not of anyone.
  assert.equal(ftfrWindowEnd(sat), mon, `Saturday's window should end ${iso(mon)}`);
  assert.equal(isFirstTimeFix(sat, mon), true, 'Saturday → Monday is a fix');
  assert.equal(isFirstTimeFix(sat, tue), false, 'Saturday → Tuesday is not');

  // Sunday's own window already lands on Monday and needs no adjustment.
  assert.equal(ftfrWindowEnd(sun), mon, 'Sunday + 1 is already Monday');
  assert.equal(isFirstTimeFix(sun, mon), true, 'Sunday → Monday is a fix');

  // The rule is Sunday-specific: Friday gets no extra grace for the weekend.
  const fri = day('2026-08-07');
  assert.equal(isFirstTimeFix(fri, mon), false, 'Friday → Monday is three days');
});

test('the denominator is calls logged, not calls resolved', () => {
  const d = day('2026-08-03'); // Monday, well before any cutoff
  const ds = makeDataset([
    { loggedDay: d, resolvedDay: d },       // fixed
    { loggedDay: d, resolvedDay: d + 1 },   // fixed
    { loggedDay: d, resolvedDay: d + 9 },   // resolved, but slowly
    { loggedDay: d },                       // still open
    { loggedDay: d },                       // still open
  ]);

  const s = summarize(ds, allRows(ds), day('2026-08-20'));

  // Dividing by resolved would give 2/3 = 66.7% and quietly drop the two calls
  // still sitting open — which flatters the figure and moves for reasons that
  // have nothing to do with speed. The business divides by every call it took.
  assert.equal(s.firstTimeFixes, 2);
  assert.equal(s.ftfrLogged, 5, 'every call logged, open ones included');
  assert.equal(s.ftfrPct, 40, '2 of 5, not 2 of 3');
});

test('only settled days count towards the rate', () => {
  // A call logged yesterday still has today to be fixed in. Counting it as a
  // miss is not a low score, it is an unfinished one — and the last days of an
  // export are always the least resolved.
  const older = day('2026-08-03');
  const yesterday = day('2026-08-12');
  const ds = makeDataset([
    { loggedDay: older, resolvedDay: older },
    { loggedDay: yesterday },
    { loggedDay: day('2026-08-11'), resolvedDay: day('2026-08-12') },
    // A resolution on the reference day itself, which is what a real export
    // carries. Without it `maxResolvedDay` becomes the binding constraint and
    // the cutoff moves for that reason instead of this one — see the case
    // below, which measures that rule deliberately. This row is logged past the
    // cutoff, so it never reaches the denominator.
    { loggedDay: day('2026-08-13'), resolvedDay: day('2026-08-13') },
  ]);

  const reference = day('2026-08-13');
  const through = ftfrSettledThrough(reference, maxResolvedDay(ds));
  const s = summarize(ds, allRows(ds), reference, { ftfrThrough: through });

  assert.equal(iso(through), '2026-08-11', 'Thursday settles through Tuesday');
  assert.equal(s.ftfrLogged, 2, 'the unsettled day is excluded from the denominator');
  assert.equal(s.firstTimeFixes, 2);
});

test('the cutoff is bounded by the newest resolution as well as the logged range', () => {
  // The export is usually taken part way through its last day. If resolutions
  // stop earlier than logged dates do, the later logged days have no verdict
  // available at all and must not be scored as misses.
  const ds = makeDataset([
    { loggedDay: day('2026-08-03'), resolvedDay: day('2026-08-04') },
    { loggedDay: day('2026-08-12') },
  ]);

  const through = ftfrSettledThrough(day('2026-08-13'), maxResolvedDay(ds));
  assert.ok(
    through < day('2026-08-04'),
    `resolutions stop 2026-08-04, so the cutoff must precede it; got ${iso(through)}`,
  );
});

test('the settled cutoff walks back over Sundays', () => {
  // Confirmed with the business, worked example by worked example.
  const cases = [
    ['2026-08-13', '2026-08-11', 'Thursday → Tuesday'],
    ['2026-08-10', '2026-08-07', 'Monday → Friday'],
    ['2026-08-11', '2026-08-09', 'Tuesday → Sunday'],
  ];
  for (const [reference, expected, why] of cases) {
    // maxResolvedDay far in the future, so only the logged-side rule applies.
    const got = ftfrSettledThrough(day(reference), day('2027-01-01'));
    assert.equal(iso(got), expected, why);
  }
});

test('the chart divides by calls logged too, so a period settles and stops moving', () => {
  const d = day('2026-08-03');
  const ds = makeDataset([
    { loggedDay: d, resolvedDay: d },
    { loggedDay: d, resolvedDay: d + 1 },
    { loggedDay: d },
    { loggedDay: d },
  ]);

  const [point] = buildSeries(ds, allRows(ds), 'day', day('2026-08-20'));

  // Under a resolved-only denominator this period would read 100% and sink for
  // weeks as the slow resolutions arrived — measured on the real artifact, 21
  // and 22 Jul both read 100.0% against a settled baseline of 55–60%.
  assert.equal(point.volume, 4);
  assert.equal(point.fixes, 2);
  assert.equal(point.ftfrPct, 50);
});

test('FTFR_MAX_DAYS is the one place the window length is written down', () => {
  // If this ever changes, it must change the rule rather than only the label —
  // the tile's note prints it, so a drift here shows as a lie on the page.
  const mon = day('2026-08-10');
  assert.equal(ftfrWindowEnd(mon), mon + FTFR_MAX_DAYS);
});
