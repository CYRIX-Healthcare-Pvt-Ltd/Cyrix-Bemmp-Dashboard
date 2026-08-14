/**
 * Normalisation applied at build time.
 *
 * All of it changes grouping only — every headline total is identical with and
 * without it. Which is exactly why it needs tests: a regression here does not
 * move a single KPI, it quietly splits one facility's calls across two rows in
 * the breakdown that the dashboard exists to draw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Dict, normalizeBarcode, normalizeDistrict, normalizeEquipmentType, splitTicket,
} from '../shared/schema.mjs';

test('barcodes are zero-padded to the contract width', () => {
  // Stored inconsistently: some cells are shared strings that keep the leading
  // zero, others are numeric cells where Excel dropped it. Unpadded, the same
  // asset counts as two — which breaks repeat-call analysis silently.
  assert.equal(normalizeBarcode('0123456', 7), '0123456');
  assert.equal(normalizeBarcode('123456', 7), '0123456', 'Excel dropped the zero');
  assert.equal(normalizeBarcode(123456, 7), '0123456', 'numeric cell');
  assert.equal(normalizeBarcode('12345678', 8), '12345678', 'Andhra is 8 wide');
  assert.equal(normalizeBarcode('1234567', 8), '01234567');

  // Longer than the width is left alone rather than truncated — losing a digit
  // would merge two different assets, which is worse than splitting one.
  assert.equal(normalizeBarcode('123456789', 7), '123456789');
});

test('case-only differences fold together, and nothing else does', () => {
  const d = new Dict(true);
  const a = d.id('Dialysis Machine');
  const b = d.id('Dialysis machine');
  const c = d.id('DIALYSIS MACHINE');

  // One equipment type stored three ways. At one large facility the two
  // spellings each held roughly half the true total.
  assert.equal(a, b);
  assert.equal(b, c);

  // Deliberately case-only. A misspelled manufacturer and its correctly spelled
  // legal name stay separate, as do `Sterlizer` and `Sterilizer` — merging those
  // needs a curated alias table, not a normalisation rule.
  assert.notEqual(d.id('Sterilizer'), d.id('Sterlizer'));
});

test('a folded dictionary displays the most common spelling', () => {
  const d = new Dict(true);
  d.id('ecg machine');
  d.id('ECG Machine');
  d.id('ECG Machine');
  d.id('ECG Machine');

  const values = d.values ?? d.list ?? [];
  assert.equal(values.length, 1, 'one entry, however it was spelled');
  assert.equal(values[0], 'ECG Machine', 'the spelling that appeared most often');
});

test('an exact dictionary keeps case-only differences apart', () => {
  const d = new Dict(false);
  assert.notEqual(d.id('WARRANTY'), d.id('Warranty'));
});

test('the two contracts\' criticality vocabularies collapse to one', () => {
  // Kerala writes CRITICAL/NON CRITICAL, Andhra Critical/Non-Critical. Both
  // collapse because the penalty rule keys off this value — two vocabularies
  // would mean one contract silently getting the wrong SLA window.
  assert.equal(normalizeEquipmentType('CRITICAL'), 'CRITICAL');
  assert.equal(normalizeEquipmentType('Critical'), 'CRITICAL');
  assert.equal(normalizeEquipmentType('NON CRITICAL'), 'NON CRITICAL');
  assert.equal(normalizeEquipmentType('Non-Critical'), 'NON CRITICAL');
  assert.equal(normalizeEquipmentType('non critical'), 'NON CRITICAL');
});

test('the one shouted district is title-cased to match its neighbours', () => {
  assert.equal(normalizeDistrict('KASARGODE'), 'Kasargode');
  assert.equal(normalizeDistrict('Palakkad'), 'Palakkad', 'the rest are left alone');
});

test('a ticket id splits into a prefix and a number', () => {
  // A bare number in Kerala, `AP` plus a number in Andhra, with a few bare
  // numbers mixed into the Andhra export too. Splitting keeps the id exact
  // without a 265k-entry string dictionary.
  assert.deepEqual(splitTicket('285716'), { prefix: '', number: 285716 });
  assert.deepEqual(splitTicket('AP12345'), { prefix: 'AP', number: 12345 });
  assert.deepEqual(splitTicket(' AP12345 '), { prefix: 'AP', number: 12345 }, 'trimmed');

  // Anything that is not letters-then-digits keeps its whole text as the prefix
  // and carries the -1 sentinel, so `ticketLabel` can still render it exactly
  // rather than printing a number that was never in the export.
  assert.deepEqual(splitTicket(''), { prefix: '', number: -1 });
  assert.deepEqual(splitTicket('WO/2026/17'), { prefix: 'WO/2026/17', number: -1 });
});
