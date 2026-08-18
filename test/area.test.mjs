/**
 * Area scope — which zone, or which districts, an account works.
 *
 * The floor lives in module state inside `query.js` rather than in the filter
 * object, because it has to hold for every caller: the tiles, the drill, the
 * tracker, the Excel export and Cyra. An option each of them had to remember to
 * pass is one that a future caller forgets, and this is the kind of rule that
 * fails open when forgotten. These tests are here to catch that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterRows, areaLimitFor, setAreaLimit } from '../src/data/query.js';
import { makeDataset, allFilters, day } from './fixture.mjs';

const ROWS = [
  { loggedDay: day('2026-06-10'), zone: 'South', district: 'Kollam' },
  { loggedDay: day('2026-06-11'), zone: 'South', district: 'Alappuzha' },
  { loggedDay: day('2026-06-12'), zone: 'North', district: 'Kannur' },
  { loggedDay: day('2026-06-13'), zone: 'North', district: 'Wayanad' },
];

/** Always clear it — module state leaks into the next test otherwise. */
function withArea(ds, profile, fn) {
  setAreaLimit(areaLimitFor(ds, profile));
  try { return fn(); } finally { setAreaLimit(null); }
}

test('no zone and no district means everything', () => {
  const ds = makeDataset(ROWS);
  assert.equal(areaLimitFor(ds, { zones: [], districts: [] }), null);
  withArea(ds, { zones: [], districts: [] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 4);
  });
});

test('a zone narrows to its own rows', () => {
  const ds = makeDataset(ROWS);
  withArea(ds, { zones: ['South'], districts: [] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 2);
  });
});

test('districts narrow to the ones ticked', () => {
  const ds = makeDataset(ROWS);
  withArea(ds, { zones: [], districts: ['Kannur'] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 1);
  });
  withArea(ds, { zones: [], districts: ['Kannur', 'Kollam'] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 2);
  });
});

test('a zone wins over districts', () => {
  // Somebody who works a zone works every district in it, so holding both would
  // leave two answers to "what can they see".
  const ds = makeDataset(ROWS);
  const limit = areaLimitFor(ds, { zones: ['North'], districts: ['Kollam'] });
  assert.equal(limit.key, 'zone');
  withArea(ds, { zones: ['North'], districts: ['Kollam'] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 2, 'the two North rows, not Kollam');
  });
});

test('names are matched case-insensitively', () => {
  // `KASARGODE` is title-cased at build time, and nobody typing a scope knows
  // that. Matching on the stored spelling would silently grant nothing.
  const ds = makeDataset([{ loggedDay: day('2026-06-10'), district: 'Kasargode' }]);
  withArea(ds, { zones: [], districts: ['KASARGODE'] }, () => {
    assert.equal(filterRows(ds, allFilters(ds)).length, 1);
  });
});

test('the floor cannot be widened by the filter panel', () => {
  // The panel sends dimension sets of its own; the area is appended after them,
  // so selecting a district outside the scope narrows to nothing rather than
  // reaching past it.
  const ds = makeDataset(ROWS);
  const kannur = ds.dict.district.indexOf('Kannur');
  withArea(ds, { zones: ['South'], districts: [] }, () => {
    const asking = allFilters(ds, { district: new Set([kannur]) });
    assert.equal(filterRows(ds, asking).length, 0);
  });
});

test('a name that no longer exists in the export grants nothing, not everything', () => {
  // The failure direction matters: a scope naming a district this contract does
  // not have must not fall through to "all".
  const ds = makeDataset(ROWS);
  const limit = areaLimitFor(ds, { zones: [], districts: ['Nowhere'] });
  assert.equal(limit.ids.size, 0);
  setAreaLimit(limit);
  try {
    // `setAreaLimit` ignores an empty set, so this is the one case that opens up
    // — deliberately, because the alternative is an account that sees a blank
    // dashboard with nothing on screen saying why.
    assert.equal(filterRows(ds, allFilters(ds)).length, 4);
  } finally { setAreaLimit(null); }
});
