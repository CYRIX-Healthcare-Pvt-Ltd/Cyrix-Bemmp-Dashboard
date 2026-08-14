/**
 * The three buckets, and the blankness test underneath them.
 *
 * The single most important business rule in the project: a ticket is open only
 * when Resolved Date is blank AND Ticket Remark is blank. Resolved Date blank
 * alone overstates open by roughly ten times in Kerala.
 *
 * Driven through the real `Builder` rather than a helper lifted out for the
 * test, because the rule lives inside `addRow` alongside the date parsing it has
 * to happen *before* — and that ordering is half of what is being checked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUCKET, Builder, STATE_BY_ID } from '../shared/schema.mjs';
import { summarize, rowsInBucket } from '../src/data/query.js';
import { makeDataset, allRows, day } from './fixture.mjs';

/** One row through the parser, returning the bucket it landed in. */
function bucketOf({ resolvedDay, parkedReason, loggedDay = 46235 }) {
  const b = new Builder(STATE_BY_ID.kl);
  b.addRow({ ticket: '1', loggedDay, resolvedDay, parkedReason });
  return b.cols.bucket[0];
}

test('an unresolved Resolved Date is blank however the export spells it', () => {
  // Kerala writes a literal single space and never a missing cell; Andhra leaves
  // the cell absent. Both coerce to 0 — the epoch — if they reach a date parser,
  // which would read as "resolved in 1900" and close every open call in the
  // contract. Blankness is therefore tested before any parsing happens.
  for (const [spelling, label] of [
    [undefined, 'absent cell (Andhra)'],
    [null, 'null'],
    ['', 'empty string'],
    [' ', 'a literal single space (Kerala)'],
    ['   ', 'several spaces'],
  ]) {
    assert.equal(bucketOf({ resolvedDay: spelling }), BUCKET.OPEN, label);
  }

  assert.equal(bucketOf({ resolvedDay: '46240' }), BUCKET.RESOLVED, 'a real serial closes it');
});

test('open requires the resolved date AND the remark to both be blank', () => {
  assert.equal(bucketOf({ resolvedDay: ' ', parkedReason: ' ' }), BUCKET.OPEN);
  assert.equal(bucketOf({ resolvedDay: ' ', parkedReason: 'rber' }), BUCKET.PARKED,
    'a remark parks it, however blank the resolved date is');

  // A resolved date wins even with a remark present: the call was fixed.
  assert.equal(bucketOf({ resolvedDay: '46240', parkedReason: 'rber' }), BUCKET.RESOLVED);
});

test('every real ticket remark parks the call', () => {
  // The reasons that actually appear in the Kerala export. Each is a call that
  // is unresolved but outside the service scope, and none of them is open.
  for (const reason of ['rber', 'warranty', 'physical damage', 'not under scope',
    'power fluctuation', 'rodent damage']) {
    assert.equal(bucketOf({ resolvedDay: ' ', parkedReason: reason }), BUCKET.PARKED, reason);
  }
});

test('parked is reported separately and never folded into open', () => {
  const d = day('2026-08-03');
  const ds = makeDataset([
    { loggedDay: d },
    { loggedDay: d },
    { loggedDay: d, parkedReason: 'rber' },
    { loggedDay: d, parkedReason: 'warranty' },
    { loggedDay: d, parkedReason: 'physical damage' },
    { loggedDay: d, resolvedDay: d + 2 },
  ]);

  const s = summarize(ds, allRows(ds), day('2026-08-20'));

  assert.equal(s.open, 2);
  assert.equal(s.parked, 3, 'unresolved but out of service scope');
  assert.equal(s.resolved, 1);
  assert.equal(s.open + s.parked + s.resolved, s.total, 'the three buckets partition the rows');

  // "Everything without a resolved date" is the mistake the rule exists to
  // prevent: here it would report 5 open calls where there are 2.
  const noResolvedDate = allRows(ds).filter((i) => ds.cols.resolvedDay[i] === 0);
  assert.equal(noResolvedDate.length, 5);
  assert.notEqual(noResolvedDate.length, s.open);
});

test('rowsInBucket returns exactly the rows the summary counted', () => {
  const d = day('2026-08-03');
  const ds = makeDataset([
    { loggedDay: d },
    { loggedDay: d, parkedReason: 'not under scope' },
    { loggedDay: d, resolvedDay: d },
  ]);
  const idx = allRows(ds);
  const s = summarize(ds, idx, day('2026-08-20'));

  assert.equal(rowsInBucket(ds, idx, BUCKET.OPEN).length, s.open);
  assert.equal(rowsInBucket(ds, idx, BUCKET.PARKED).length, s.parked);
  assert.equal(rowsInBucket(ds, idx, BUCKET.RESOLVED).length, s.resolved);
});
