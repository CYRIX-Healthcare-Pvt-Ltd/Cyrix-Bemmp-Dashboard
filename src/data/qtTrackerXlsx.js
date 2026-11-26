/*
 * Quotation tracker → Excel laid out like the team's own "quotation Tracker.xlsx" (the user, 26 Nov), with our QR
 * number before the QTN number. Company colours: dark grey heading with a red line under it, light grey borders.
 */
import { colName, esc, writeStyledBook } from './xlsx.js';

export const TRACKER_COLS = [
  ['sl', 'SL NO', 6, 'int'], ['qr', 'QR NO', 9, 'text'], ['qtn', 'QTN NO', 28, 'text'], ['month', 'MONTH', 11, 'text'],
  ['by', 'DONE BY', 18, 'text'], ['req', 'REQUESTED DATE', 13, 'date'], ['qdate', 'QUOTATION DATE', 13, 'date'], ['age', 'AGE', 6, 'int'],
  ['customer', 'CUSTOMER', 32, 'text'], ['dist', 'DIST', 14, 'text'], ['loc', 'LOC', 14, 'text'],
  ['equipment', 'EQUIPMENT (MODEL/SPARE PART)', 40, 'text'], ['qty', 'QTY', 6, 'int'], ['cost', 'COST TAX EXCL', 14, 'money'],
  ['tax', 'Tax %', 7, 'pct'], ['status', 'STATUS', 24, 'text'], ['remarks', 'REMARKS', 28, 'text'],
];

// cellXfs: 0 default, 1 heading, 2 text, 3 whole number, 4 date, 5 money, 6 percent.
const S = { head: 1, text: 2, int: 3, date: 4, money: 5, pct: 6 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd-mm-yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3A3A3A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="medium"><color rgb="FFDA251D"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
</styleSheet>`;

/** "2026-04-01" → Excel's day number. */
const serial = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
};

function cell(ref, value, style) {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === 'number') return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

export function trackerXlsx(rows) {
  const head = TRACKER_COLS.map(([, h], i) => cell(`${colName(i)}1`, h, S.head)).join('');
  const body = rows.map((x, k) => {
    const n = k + 2;
    return `<row r="${n}">${TRACKER_COLS.map(([key, , , kind], i) => {
      const ref = `${colName(i)}${n}`;
      if (key === 'sl') return cell(ref, k + 1, S.int);
      if (kind === 'date') return cell(ref, serial(x[key]), S.date);
      if (kind === 'pct') return cell(ref, x[key] == null || x[key] === '' ? null : Number(x[key]) / 100, S.pct);
      if (kind === 'int' || kind === 'money') return cell(ref, x[key] == null || x[key] === '' ? null : Number(x[key]), S[kind]);
      return cell(ref, x[key] ?? '', S.text);
    }).join('')}</row>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${TRACKER_COLS.map(([, , w], i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData><row r="1" ht="32" customHeight="1">${head}</row>${body}</sheetData>
</worksheet>`;
  return writeStyledBook([{ name: 'Sheet1', xml }], STYLES);
}
