import test from 'node:test';
import assert from 'node:assert/strict';
import { BLANK, applyFilters, asChoice, buildChoices } from '../src/data/meeting.js';

/**
 * The column filters, and the one rule that is easy to get wrong.
 *
 * Each column's list has to be narrowed by every OTHER column's filter
 * and not by its own — otherwise picking a district leaves the district
 * list showing only that district, and there is no way to add a second
 * one or to see what has been excluded.
 */

const COLUMNS = [
  { key: 'district', type: 'text' },
  { key: 'facility', type: 'text' },
  { key: 'rate', type: 'num' },
  { key: 'pi_no', type: 'text' },
];

const ROWS = [
  { district: 'Ernakulam', facility: 'DH Aluva', rate: 500, pi_no: 'PI-1' },
  { district: 'Ernakulam', facility: 'GH Perumbavoor', rate: 50, pi_no: null },
  { district: 'Thrissur', facility: 'GH Chalakudy', rate: 50, pi_no: '' },
  { district: 'Thrissur', facility: 'DH Thrissur', rate: 1000, pi_no: 'PI-2' },
  { district: 'Kollam', facility: 'THQH Punalur', rate: 50, pi_no: null },
];

const names = (list) => list.map(([v]) => v);

test('with nothing picked, every column offers everything it holds', () => {
  const c = buildChoices(ROWS, COLUMNS, []);
  assert.deepEqual(names(c.district), ['Ernakulam', 'Kollam', 'Thrissur']);
  assert.equal(c.facility.length, 5);
});

test('one column narrows the others', () => {
  const c = buildChoices(ROWS, COLUMNS, [['district', ['Ernakulam']]]);
  // Only Ernakulam's facilities are worth offering.
  assert.deepEqual(names(c.facility), ['DH Aluva', 'GH Perumbavoor']);
  assert.deepEqual(names(c.rate), ['50', '500']);
});

test('a column is NOT narrowed by its own filter', () => {
  // The rule that makes the filter usable: having picked Ernakulam you
  // must still be able to see and add Thrissur.
  const c = buildChoices(ROWS, COLUMNS, [['district', ['Ernakulam']]]);
  assert.deepEqual(names(c.district), ['Ernakulam', 'Kollam', 'Thrissur']);
});

test('two filters narrow a third, and each other, but never themselves', () => {
  const c = buildChoices(ROWS, COLUMNS, [
    ['district', ['Ernakulam', 'Thrissur']],
    ['rate', ['50']],
  ]);
  // Facility sees both filters.
  assert.deepEqual(names(c.facility), ['GH Chalakudy', 'GH Perumbavoor']);
  // Rate sees the district filter but not its own, so 500 and 1000 remain.
  assert.deepEqual(names(c.rate), ['50', '500', '1000']);
  // District sees the rate filter but not its own, so Kollam is still there.
  assert.deepEqual(names(c.district), ['Ernakulam', 'Kollam', 'Thrissur']);
});

test('counts describe the narrowed set, not the whole table', () => {
  const all = buildChoices(ROWS, COLUMNS, []);
  assert.equal(all.rate.find(([v]) => v === '50')[1], 3);
  const inThrissur = buildChoices(ROWS, COLUMNS, [['district', ['Thrissur']]]);
  assert.equal(inThrissur.rate.find(([v]) => v === '50')[1], 1);
});

test('empty and null are one option, and it sorts last', () => {
  const c = buildChoices(ROWS, COLUMNS, []);
  // Three rows have no PI: two null and one empty string.
  assert.equal(c.pi_no.find(([v]) => v === BLANK)[1], 3);
  assert.equal(c.pi_no.at(-1)[0], BLANK, 'blank belongs at the end');
});

test('numbers sort as numbers, not as text', () => {
  const c = buildChoices(ROWS, COLUMNS, []);
  // '1000' before '50' would be the string ordering.
  assert.deepEqual(names(c.rate), ['50', '500', '1000']);
});

test('filtering on blank finds the rows with nothing in them', () => {
  const kept = applyFilters(ROWS, [['pi_no', [BLANK]]]);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((r) => !r.pi_no));
});

test('a value cannot collide with the blank token', () => {
  // A cell reading "(blank)" is itself, not an empty one.
  const rows = [{ district: '(blank)' }, { district: null }];
  const c = buildChoices(rows, [{ key: 'district', type: 'text' }], []);
  assert.equal(c.district.length, 2);
  assert.equal(applyFilters(rows, [['district', ['(blank)']]]).length, 1);
  assert.equal(applyFilters(rows, [['district', [BLANK]]]).length, 1);
});

test('asChoice reads a cell the same way everywhere', () => {
  assert.equal(asChoice(null), BLANK);
  assert.equal(asChoice(undefined), BLANK);
  assert.equal(asChoice(''), BLANK);
  assert.equal(asChoice(0), '0', 'nought is a value, not a blank');
  assert.equal(asChoice(false), 'false');
});

test('no filters leaves the rows alone, by identity', () => {
  assert.equal(applyFilters(ROWS, []), ROWS);
});
