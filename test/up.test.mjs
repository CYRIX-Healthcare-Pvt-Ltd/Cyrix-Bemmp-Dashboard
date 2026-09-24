/**
 * Uttar Pradesh: its web-page export, its districts, and its penalty.
 *
 * The penalty cases are the workbook's own ("UP Penalty - Auto dashboard.xlsx",
 * Calc UP): the same rule was checked there against all 571 calls of 23 Sep's
 * export, every column from Z to AK, before any of this was written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { day } from './fixture.mjs';
import { upPenalty, penaltyBand, PRIO_RANGE, UP_GRACE_DAYS } from '../shared/upPenalty.mjs';
import { htmlTableRows, excelDayOfText, columnLetter, looksLikeHtml } from '../shared/htmlTable.mjs';
import { upAreaOf, UP_AREAS } from '../shared/upAreas.mjs';
import { Builder, addHtmlRows, asExportTime, STATE_BY_ID, detectState, COLUMNS } from '../shared/schema.mjs';
import { BLANK, applyFilters, buildChoices, filterField, upColumns, whenOf } from '../src/data/meeting.js';

const TODAY = day('2026-09-23');

test('the penalty starts eight days after the call is logged', () => {
  assert.equal(UP_GRACE_DAYS, 8);
  const p = upPenalty({ loggedDay: day('2026-09-22'), status: 'Pending', perDayCost: 6.46, prio: 'B' }, TODAY);
  assert.equal(p.startDay, day('2026-09-30'));
  assert.equal(p.downDays, 0);
  assert.equal(p.total, 0);
});

test('A and B penalty, as the workbook works them out', () => {
  // 463020: logged 7 Sep, Pending, per-day cost 62.74, Prio A — nine days on 23 Sep.
  const p = upPenalty({ loggedDay: day('2026-09-07'), status: 'Pending', perDayCost: 62.74, prio: 'A' }, TODAY);
  assert.equal(p.startDay, day('2026-09-15'));
  assert.equal(p.downDays, 9);
  assert.equal(p.prioRange, 4);
  assert.ok(Math.abs(p.aPenalty - 9 * 62.74) < 1e-9);
  assert.ok(Math.abs(p.bPenalty - 9 * 62.74 * 4) < 1e-9);
  assert.ok(Math.abs(p.total - 9 * 62.74 * 5) < 1e-9);
  assert.ok(Math.abs(p.perDay - 62.74 * 5) < 1e-9);
  assert.equal(p.band, '51 to 500');
});

test('no B penalty for a burned, consumable, irrepairable or physically damaged call', () => {
  for (const status of ['Burned Equipment', 'Consumable Item', 'Irrepairable', 'Physically Damaged', 'physically damaged ']) {
    const p = upPenalty({ loggedDay: day('2026-09-01'), status, perDayCost: 100, prio: 'C&D' }, TODAY);
    assert.equal(p.bPenalty, 0, status);
    assert.equal(p.aPenalty, p.downDays * 100, status);
    assert.equal(p.perDay, 100, status);
  }
});

test('the priority sets the multiple: A 4, B 6, C&D 10, nothing else none', () => {
  assert.deepEqual(PRIO_RANGE, { A: 4, B: 6, 'C&D': 10 });
  const at = (prio) => upPenalty({ loggedDay: day('2026-09-01'), status: 'Pending', perDayCost: 10, prio }, TODAY);
  assert.equal(at('C&D').bPenalty, at('C&D').downDays * 10 * 10);
  assert.equal(at('').bPenalty, 0);
});

test('a completed call stops counting on the day it was completed, once that day is past', () => {
  const done = upPenalty({ loggedDay: day('2026-09-01'), completedDay: day('2026-09-12'), status: 'Completed', perDayCost: 10, prio: 'A' }, TODAY);
  assert.equal(done.downDays, 4); // 9, 10, 11 and 12 Sep, both ends counted
  const pending = upPenalty({ loggedDay: day('2026-09-01'), completedDay: day('2026-09-12'), status: 'Pending', perDayCost: 10, prio: 'A' }, TODAY);
  assert.equal(pending.downDays, 15); // still open: to today
  const today = upPenalty({ loggedDay: day('2026-09-01'), completedDay: TODAY, status: 'Completed', perDayCost: 10, prio: 'A' }, TODAY);
  assert.equal(today.downDays, 15); // completed today is not yet past
});

test('an asset missing from Per Day Cost costs nothing', () => {
  const p = upPenalty({ loggedDay: day('2026-09-01'), status: 'Pending' }, TODAY);
  assert.equal(p.downDays, 15);
  assert.equal(p.total, 0);
  assert.equal(p.band, '< 50');
});

test('the per-day cost bands, with nothing falling between them', () => {
  assert.equal(penaltyBand(0), '< 50');
  assert.equal(penaltyBand(50), '< 50');
  assert.equal(penaltyBand(50.01), '51 to 500');
  assert.equal(penaltyBand(500), '51 to 500');
  assert.equal(penaltyBand(500.5), '501 to 1000'); // the sheet's own formula left this in no band
  assert.equal(penaltyBand(1000), '501 to 1000');
  assert.equal(penaltyBand(3000), '1001 to 3000');
  assert.equal(penaltyBand(10000), '3001 to 10000');
  assert.equal(penaltyBand(10000.01), '>10000');
});

test('a web-page export reads as rows of text', () => {
  const html = '<style> td { mso-number-format:\\@;} </style><div><table>'
    + '<tr><th scope="col">Sl No</th><th>MptId</th><th>Hospital</th></tr>'
    + '<tr><td>1</td><td>466259</td><td>District Hospital &amp; Trauma&nbsp;Centre</td></tr>'
    + '<tr>\n<td>2</td>\n<td>463020</td>\n<td> CHC <b>Kairana</b> </td></tr></table></div>';
  assert.ok(looksLikeHtml(html));
  assert.ok(!looksLikeHtml('PK\u0003\u0004'));
  assert.deepEqual(htmlTableRows(html), [
    ['Sl No', 'MptId', 'Hospital'],
    ['1', '466259', 'District Hospital & Trauma Centre'],
    ['2', '463020', 'CHC Kairana'],
  ]);
});

test('column letters and written-out days', () => {
  assert.deepEqual([0, 18, 25, 26, 36].map(columnLetter), ['A', 'S', 'Z', 'AA', 'AK']);
  assert.equal(excelDayOfText('22/09/2026 02:20:26 PM'), day('2026-09-22'));
  assert.equal(excelDayOfText('07/09/2026'), day('2026-09-07'));
  assert.equal(excelDayOfText('2026-09-07'), day('2026-09-07'));
  assert.equal(excelDayOfText(' '), '');
  assert.equal(excelDayOfText('31/13/2026'), '');
});

test('every district has its zone and division, spelt either way', () => {
  assert.equal(UP_AREAS.length, 75);
  assert.deepEqual(upAreaOf('Muzaffarnagar'), { zone: 'Zone1', division: 'Saharanpur' });
  assert.deepEqual(upAreaOf('Balarampur'), upAreaOf('Balrampur'));
  assert.deepEqual(upAreaOf('Raebareli'), upAreaOf('Rai Bareli'));
  assert.deepEqual(upAreaOf('Sant Ravidas Nagar'), { zone: 'Zone4', division: 'Varanasi' });
  assert.equal(upAreaOf('Nowhere'), null);
});

const EXPORT = (rows) => `<table><tr>${['Sl No', 'MptId', 'District', 'Division', 'Zone', 'Hospital Type', 'Hospital', 'Asset No', 'Product',
  'Manufacture', 'Model No', 'Serial No', 'Department', 'Contact No', 'Call Received Date & Time', 'Call Respond Date & Time',
  'Call Attend Date & Time', 'Call Completed Date & Time', 'Status'].map((h) => `<th>${h}</th>`).join('')}</tr>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

test('an Uttar Pradesh export becomes a dataset, zones filled from the district', () => {
  assert.equal(detectState('TM - UP.xls').id, 'up');
  const html = EXPORT([
    ['1', '466259', 'Muzaffarnagar', 'Saharanpur', 'Zone1', 'Dh', 'District Hospital Male', 'MHUP - 031-0471', 'REFRIGERATOR',
      'Electrolux', 'ML150', 'Na', 'Blood Bank', '919000000001', '22/09/2026 02:20:26 PM', '22/09/2026 02:27:12 PM',
      '22/09/2026 03:50:41 PM', '', 'Pending'],
    // No zone or division: the district's, from the master.
    ['2', '463020', 'Raebareli', '', '', 'Chc', 'CHC Salon', 'MHUP - 071-0012', 'CENTRIFUGE',
      'Remi', 'R-8C', '123', 'Lab', '919000000000', '07/09/2026 12:35:57 PM', '', '', '', 'Consumable Item'],
  ]);
  const b = addHtmlRows(new Builder(STATE_BY_ID.up), html);
  const { meta, buffer } = b.finish();
  assert.equal(meta.rows, 2);
  assert.equal(buffer.byteLength, 2 * COLUMNS.length * 4);
  const text = (f, i) => { const id = b.cols[f][i]; return id < 0 ? '' : meta.dictionaries[f][id]; };
  assert.equal(b.cols.ticketNo[0], 466259);
  assert.equal(text('barcode', 0), 'MHUP - 031-0471');
  assert.equal(text('receivedAt', 0), '22/09/2026 02:20:26 PM');
  assert.equal(b.cols.loggedDay[0], day('2026-09-22'));
  assert.equal(b.cols.resolvedDay[0], -1);
  assert.equal(text('zone', 1), 'Zone2');
  assert.equal(text('division', 1), 'Lucknow');
  assert.equal(text('status', 1), 'Consumable Item');
  assert.equal(meta.kpis.open, 2);
});

test('another report saved under the name is refused, not misread', () => {
  const wrong = '<table><tr><th>Sl No</th><th>Ticket</th></tr><tr><td>1</td><td>9</td></tr></table>';
  assert.throws(() => addHtmlRows(new Builder(STATE_BY_ID.up), wrong), /no heading row with "MptId"/);
});

/* ---- the tracker's date columns (the user, 23 Sep: "make it in date format, like filter like in excel") */

test('a date and time from the export reads as the page writes one', () => {
  const w = whenOf('22/09/2026 02:20:26 PM');
  assert.equal(w.shown, '22 Sep 2026, 02:20 pm');
  assert.equal(w.day, '22 Sep 2026');
  assert.equal(w.at, Date.UTC(2026, 8, 22, 14, 20, 26));
  // Twelve o'clock both ways round, which is where AM and PM go wrong.
  assert.equal(whenOf('01/10/2026 12:05:00 AM').at, Date.UTC(2026, 9, 1, 0, 5, 0));
  assert.equal(whenOf('01/10/2026 12:05:00 PM').at, Date.UTC(2026, 9, 1, 12, 5, 0));
});

test('a blank cell is blank, a bare date has no time, and anything else is left alone', () => {
  assert.deepEqual(whenOf(''), { shown: '', day: '', at: null });
  assert.deepEqual(whenOf(null), { shown: '', day: '', at: null });
  const bare = whenOf('07/09/2026');
  assert.equal(bare.shown, '07 Sep 2026');
  assert.equal(bare.day, '07 Sep 2026');
  assert.deepEqual(whenOf('not recorded'), { shown: 'not recorded', day: 'not recorded', at: null });
});

test('sorted by the moment, 01/10 comes after 22/09', () => {
  assert.ok(whenOf('01/10/2026 09:00:00 AM').at > whenOf('22/09/2026 11:00:00 PM').at);
});

test('every date column filters by its day, in the tree', () => {
  const cols = upColumns();
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
  for (const k of ['receivedAt', 'respondedAt', 'attendedAt', 'completedAt']) {
    assert.equal(byKey[k].date, true, `${k} is not a date column`);
    assert.equal(filterField(byKey[k]), k.replace(/At$/, 'Day'));
  }
  assert.equal(byKey.bStart.date, true);
  // The other columns filter on what they show.
  assert.equal(filterField(byKey.district), 'district');
});

test('"B" is off the start date and the down days, and only those', () => {
  const labels = Object.fromEntries(upColumns().map((c) => [c.key, c.label]));
  assert.equal(labels.bStart, 'Penalty Start Date');
  assert.equal(labels.bDownDays, 'Penalty Down Days');
  assert.equal(labels.bPenalty, 'B Penalty');
});

test('ticking a day keeps every call of that day, whatever its time', () => {
  const cols = upColumns().filter((c) => c.key === 'ticket' || c.key === 'receivedAt');
  const rows = ['22/09/2026 09:15:00 AM', '22/09/2026 06:40:00 PM', '23/09/2026 10:00:00 AM', '']
    .map((t, i) => { const w = whenOf(t); return { ticket: String(i), receivedAt: w.shown, receivedDay: w.day }; });
  // What the filter offers: days, with how many calls each.
  const choices = buildChoices(rows, cols, []);
  assert.deepEqual(choices.receivedAt, [['22 Sep 2026', 2], ['23 Sep 2026', 1], [BLANK, 1]]);
  // And what a tick keeps. The grid hands the filters over keyed by filterField.
  const kept = applyFilters(rows, [[filterField(cols[1]), ['22 Sep 2026']]]);
  assert.deepEqual(kept.map((r) => r.ticket), ['0', '1']);
});

/* ---- read by heading, every row checked (the user, 24 Sep: "why it is uploading excel with different columns?") */

const HEADINGS = ['Sl No', 'MptId', 'District', 'Division', 'Zone', 'Hospital Type', 'Hospital', 'Asset No', 'Product',
  'Manufacture', 'Model No', 'Serial No', 'Department', 'Contact No', 'Call Received Date & Time', 'Call Respond Date & Time',
  'Call Attend Date & Time', 'Call Completed Date & Time', 'Status'];
const ROW = ['1', '466259', 'Mainpuri', 'Agra', 'Zone1', 'Dh', 'District Male Hospital', 'MHUP - 261-0098', 'ANESTHESIA WORKSTATION',
  'Mindray', 'WATO EX-35', 'NA', 'OT', '919000000002', '22/09/2026 02:20:26 PM', '', '', '', 'Pending'];
const page = (heads, rows, cell = (c) => `<td>${c}</td>`) => `<table><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr>${
  rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</table>`;
const readUp = (html) => {
  const b = addHtmlRows(new Builder(STATE_BY_ID.up), html);
  const { meta } = b.finish();
  const text = (f, i) => { const id = b.cols[f][i]; return id < 0 ? '' : meta.dictionaries[f][id]; };
  return { b, meta, text };
};

test('a blank cell written <td/>, and one spanning columns, keep every later cell in its column', () => {
  const html = '<table><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr>'
    + '<tr><td/><td class="x" />two<td colspan="1">x</td><td>four</td></tr>'
    + '<tr><td colspan="2">wide</td><td>c</td><td>d</td></tr></table>';
  const rows = htmlTableRows(html);
  assert.deepEqual(rows[1], ['', '', 'x', 'four']);
  assert.deepEqual(rows[2], ['wide', '', 'c', 'd']);
});

test('a file without Sl No, or with its columns in another order, still reads by its headings', () => {
  const noSlNo = readUp(page(HEADINGS.slice(1), [ROW.slice(1)]));
  assert.equal(noSlNo.b.cols.ticketNo[0], 466259);
  assert.equal(noSlNo.text('district', 0), 'Mainpuri');
  assert.equal(noSlNo.text('facilityName', 0), 'District Male Hospital');
  assert.equal(noSlNo.text('barcode', 0), 'MHUP - 261-0098');
  const order = HEADINGS.map((_, i) => i).reverse();
  const reversed = readUp(page(order.map((i) => HEADINGS[i]), [order.map((i) => ROW[i])]));
  assert.equal(reversed.b.cols.ticketNo[0], 466259);
  assert.equal(reversed.text('equipment', 0), 'ANESTHESIA WORKSTATION');
  assert.equal(reversed.b.cols.loggedDay[0], day('2026-09-22'));
});

test('rows that sit a column over from their headings are refused, naming a row, not published', () => {
  // The heading row is right; every data row has lost its Sl No cell — what put districts under MptId.
  const rows = Array.from({ length: 20 }, () => ROW.slice(1));
  assert.throws(() => readUp(page(HEADINGS, rows)), /row 2: MptId is "Mainpuri", not a ticket number\. 20 of 20 rows/);
});

test('a total at the foot of the report is let go', () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => [String(i + 1), String(466000 + i), ...ROW.slice(2)]),
    ['', 'Total: 10', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']];
  const { meta } = readUp(page(HEADINGS, rows));
  assert.equal(meta.rows, 10);
});

test('a file without a heading the tracker needs is refused, naming it', () => {
  const heads = HEADINGS.filter((h) => h !== 'Asset No');
  assert.throws(() => readUp(page(heads, [ROW.filter((_, i) => HEADINGS[i] !== 'Asset No')])), /no heading row with "Asset No"/);
});

test('a date and time from a real workbook reads as the export writes one', () => {
  // 22 Sep 2026, 2:20:26 PM as an Excel serial.
  const serial = String(day('2026-09-22') + (14 * 3600 + 20 * 60 + 26) / 86400);
  assert.equal(asExportTime(serial), '22/09/2026 02:20:26 PM');
  assert.equal(asExportTime('22/09/2026 02:20:26 PM'), '22/09/2026 02:20:26 PM');
  assert.equal(asExportTime(''), '');
});
