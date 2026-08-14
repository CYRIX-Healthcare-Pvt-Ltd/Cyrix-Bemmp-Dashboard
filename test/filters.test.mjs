/**
 * Filtering, and the saved default view.
 *
 * The default is stored as labels rather than dictionary ids for a reason that
 * only shows up on the *next* export: dictionaries are interned in first-seen
 * order while parsing, so every rebuild renumbers them. A saved id would quietly
 * become a different district with nothing on screen to say so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterRows, blankFilters, defaultFiltersFor, saveDefaultFilters,
  clearDefaultFilters, hasDefaultFilters, FILTER_DIMS,
} from '../src/data/query.js';
import { makeDataset, allFilters, day } from './fixture.mjs';

/* `localStorage` does not exist under Node. The production code already guards
   every access in try/catch — that is what lets it run in private-mode Safari —
   so the no-storage path is exercised for free. These tests install a minimal
   stand-in to check the round trip as well. */
function withStorage(fn) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try { return fn(store); } finally { delete globalThis.localStorage; }
}

const ROWS = [
  { loggedDay: day('2026-06-10'), district: 'Palakkad', equipment: 'ECG Machine' },
  { loggedDay: day('2026-07-10'), district: 'Palakkad', equipment: 'Ventilator' },
  { loggedDay: day('2026-08-10'), district: 'Kannur', equipment: 'ECG Machine' },
];

test('an empty Set means "all", not "none"', () => {
  const ds = makeDataset(ROWS);
  assert.equal(filterRows(ds, allFilters(ds)).length, 3);
});

test('dimensions and the date window narrow together', () => {
  const ds = makeDataset(ROWS);
  const palakkad = new Set([ds.dict.district.indexOf('Palakkad')]);

  assert.equal(filterRows(ds, allFilters(ds, { district: palakkad })).length, 2);

  const july = allFilters(ds, {
    district: palakkad,
    dayFrom: day('2026-07-01'),
    dayTo: day('2026-07-31'),
  });
  assert.equal(filterRows(ds, july).length, 1, 'both conditions apply');
});

test('the resting selection is the whole contract', () => {
  const ds = makeDataset(ROWS);
  const blank = blankFilters(ds.meta);

  assert.equal(blank.preset, 'all');
  assert.equal(blank.dayFrom, ds.meta.dateRange.minDay);
  assert.equal(blank.dayTo, ds.meta.dateRange.maxDay);
  for (const k of FILTER_DIMS) assert.equal(blank[k].size, 0, `${k} starts empty`);
  assert.equal(filterRows(ds, blank).length, ds.rows, 'nothing is narrowed');
});

test('with no storage at all the page still opens on the blank selection', () => {
  const ds = makeDataset(ROWS);
  assert.deepEqual(defaultFiltersFor(ds), blankFilters(ds.meta));
  assert.equal(hasDefaultFilters('kl'), false);
});

test('a saved default survives a round trip', () => {
  withStorage(() => {
    const ds = makeDataset(ROWS);
    const chosen = allFilters(ds, {
      preset: 'month',
      dayFrom: day('2026-08-01'),
      dayTo: day('2026-08-31'),
      district: new Set([ds.dict.district.indexOf('Kannur')]),
    });

    saveDefaultFilters(ds, chosen);
    assert.equal(hasDefaultFilters('kl'), true);

    const back = defaultFiltersFor(ds);
    assert.equal(back.preset, 'month');
    assert.equal(back.dayFrom, day('2026-08-01'));
    assert.deepEqual([...back.district], [ds.dict.district.indexOf('Kannur')]);
    assert.equal(filterRows(ds, back).length, 1);
  });
});

test('a saved default follows the label when the next export renumbers the dictionary', () => {
  withStorage(() => {
    const before = makeDataset(ROWS);
    // Kannur is id 1 here, after Palakkad.
    assert.equal(before.dict.district.indexOf('Kannur'), 1);
    saveDefaultFilters(before, allFilters(before, {
      district: new Set([before.dict.district.indexOf('Kannur')]),
    }));

    // The next export happens to see Kannur first, so it interns as id 0. A
    // saved id would now silently mean Palakkad.
    const after = makeDataset([
      { loggedDay: day('2026-09-01'), district: 'Kannur' },
      { loggedDay: day('2026-09-02'), district: 'Palakkad' },
    ]);
    assert.equal(after.dict.district.indexOf('Kannur'), 0);

    const restored = defaultFiltersFor(after);
    assert.deepEqual([...restored.district], [0], 'resolved through the label');
    assert.equal(after.dict.district[[...restored.district][0]], 'Kannur');
  });
});

test('a label that no longer exists is dropped rather than carried', () => {
  withStorage(() => {
    const before = makeDataset(ROWS);
    saveDefaultFilters(before, allFilters(before, {
      district: new Set([before.dict.district.indexOf('Palakkad')]),
    }));

    // Palakkad has left the contract. Dropping the selection is the right
    // answer; keeping a dangling id would filter to nothing and read as a bug.
    const after = makeDataset([{ loggedDay: day('2026-09-01'), district: 'Kannur' }]);
    const restored = defaultFiltersFor(after);

    assert.equal(restored.district.size, 0);
    assert.equal(filterRows(after, restored).length, 1, 'not filtered to nothing');
  });
});

test('a saved date outside the new export is clamped into range', () => {
  withStorage(() => {
    const before = makeDataset(ROWS);
    saveDefaultFilters(before, allFilters(before, {
      dayFrom: day('2026-06-01'),
      dayTo: day('2026-08-31'),
    }));

    // A shorter export. Left unclamped this would open on an empty window with
    // nothing on screen to explain why.
    const after = makeDataset([{ loggedDay: day('2026-09-15'), district: 'Kannur' }]);
    const restored = defaultFiltersFor(after);

    assert.equal(restored.dayFrom, after.meta.dateRange.minDay);
    assert.equal(restored.dayTo, after.meta.dateRange.maxDay);
    assert.equal(filterRows(after, restored).length, 1);
  });
});

test('the default is per contract', () => {
  withStorage(() => {
    const kl = makeDataset(ROWS);
    saveDefaultFilters(kl, allFilters(kl, {
      district: new Set([kl.dict.district.indexOf('Kannur')]),
    }));

    const ap = makeDataset([{ loggedDay: day('2026-09-01'), district: 'Guntur' }], { id: 'ap' });

    assert.equal(hasDefaultFilters('kl'), true);
    assert.equal(hasDefaultFilters('ap'), false, 'a dictionary id means nothing across states');
    assert.deepEqual(defaultFiltersFor(ap), blankFilters(ap.meta));
  });
});

test('clearing the default puts the page back on all time', () => {
  withStorage(() => {
    const ds = makeDataset(ROWS);
    saveDefaultFilters(ds, allFilters(ds, { preset: 'month' }));
    assert.equal(defaultFiltersFor(ds).preset, 'month');

    clearDefaultFilters('kl');
    assert.equal(hasDefaultFilters('kl'), false);
    assert.deepEqual(defaultFiltersFor(ds), blankFilters(ds.meta));
  });
});
