import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MEETING_FIELDS } from '../src/data/meeting.js';

/**
 * PR status and PO status: where the meeting asked for them, with the
 * choices it asked for, each coloured by what it means.
 *
 * Position matters as much as the choices: the grid draws its columns in
 * this order, and a status two columns away from what it describes is
 * read against the wrong figure.
 */

const keys = MEETING_FIELDS.map((f) => f.key);
const field = (key) => MEETING_FIELDS.find((f) => f.key === key);
const TONES = new Set(['bad', 'warn', 'info']);
const CSS = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');

test('PR status comes straight after PR purchase remark', () => {
  assert.equal(keys[keys.indexOf('pr_remark') + 1], 'pr_status');
});

test('PO status comes straight after Vendor', () => {
  // Moved here from after Purchase delay days at the meeting's request.
  assert.equal(keys[keys.indexOf('vendor_name') + 1], 'po_status');
});

test('PR status offers Cancelled, Clarification and Hold', () => {
  assert.equal(field('pr_status').kind, 'select');
  assert.deepEqual(field('pr_status').options, ['Cancelled', 'Clarification', 'Hold']);
});

test('PO status offers only Cancelled', () => {
  assert.equal(field('po_status').kind, 'select');
  assert.deepEqual(field('po_status').options, ['Cancelled']);
});

test('penalty type still takes its choices from the lookup table', () => {
  // Carries no list of its own, so the renderer falls back to the table.
  assert.equal(field('penalty_type').options, undefined);
});

test('every status choice has a colour, and only a known one', () => {
  for (const key of ['pr_status', 'po_status']) {
    const f = field(key);
    for (const o of f.options) {
      assert.ok(TONES.has(f.tones?.[o]), `${key}: "${o}" has no known tone`);
    }
  }
});

test('Cancelled is red in both columns', () => {
  assert.equal(field('pr_status').tones.Cancelled, 'bad');
  assert.equal(field('po_status').tones.Cancelled, 'bad');
});

test('Cancelled, Hold and Clarification are three different colours', () => {
  const t = field('pr_status').tones;
  assert.equal(new Set([t.Cancelled, t.Hold, t.Clarification]).size, 3);
});

test('every tone the data names is actually styled, in both themes', () => {
  // A tone with no rule renders uncoloured, and nothing complains.
  for (const t of TONES) assert.ok(CSS.includes(`.tone-${t}`), `.tone-${t} has no style`);
  assert.equal((CSS.match(/--status-info:/g) ?? []).length, 2,
    '--status-info must be set once for light and once for dark');
  assert.equal((CSS.match(/--col-rule:/g) ?? []).length, 2,
    '--col-rule must be set once for light and once for dark');
});
