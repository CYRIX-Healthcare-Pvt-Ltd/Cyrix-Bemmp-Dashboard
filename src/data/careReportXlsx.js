/*
 * Care 360 → Report as an Excel laid out like the team's own "Ticket Master_Care 360" (the user, 26 Nov): two
 * heading rows, wrapped and centred; borders; 0.00 days; growth as a plain % (no "+") with a red / green circle
 * from Excel's own icon set — TATs green when they fall, FTFR green when it rises. Company colours: black heading,
 * light grey sub-heading and Grand Total; the heading dark grey, not black, so its column lines show (26 Nov).
 */
import { colName, esc, writeStyledBook } from './xlsx.js';

// cellXfs, by index.
const S = { head: 1, sub: 2, text: 3, int: 4, days: 5, pct: 6, ftfr: 7, tText: 8, tInt: 9, tDays: 10, tPct: 11, tFtfr: 12 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0%"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3A3A3A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="medium"><color rgb="FFDA251D"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
</styleSheet>`;

function c(ref, value, style) {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === 'number') return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * `report` from careReport(); A is the To month's label, B the From month's; `by` is 'state' or 'facility'.
 */
export async function careReportXlsx({ report, A, B, by, sheetName, ftfr, cmp = true }) {
  // FTFR contract wise on its own (its Report sub-tab).
  if (!report) return writeStyledBook([{ name: 'FTFR Contract Wise', xml: ftfrSheet(ftfr) }], STYLES);
  const facility = by === 'facility';
  const lead = facility ? [['Facility', 'name', 'text'], ['State', 'state', 'text']] : [['State', 'name', 'text']];
  const counts = [[`Total Calls
${A}`, 'calls'], [`Completed
${A}`, 'completed'], [`Pending
${A}`, 'pending']];
  const groups = [
    ['Response TAT (days)', 'response', 'days', true],
    ['Resolution TAT · closed in month (days)', 'resolution', 'days', true],
    ['Logged & closed same month (days)', 'same', 'days', true],
    ['FTFR', 'ftfr', 'ftfr', false],
  ];
  const cols = [
    ...lead.map(([h, key, kind]) => ({ h, key, kind })),
    ...counts.map(([h, key]) => ({ h, key, kind: 'int' })),
  ];
  const first = cols.length;
  for (const [, key, kind] of groups) {
    if (cmp) cols.push({ key: `${key}B`, kind, sub: B }, { key: `${key}A`, kind, sub: A }, { key: `${key}Change`, kind: 'pct', sub: `${A} vs
${B}` });
    else cols.push({ key: `${key}A`, kind, sub: A });
  }

  // Row 1: single headings span both rows; each group spans its three columns. Row 2: the months.
  const merges = [];
  const r1 = []; const r2 = [];
  cols.slice(0, first).forEach((col, i) => {
    r1.push(c(`${colName(i)}1`, col.h, S.head)); r2.push(c(`${colName(i)}2`, '', S.head));
    merges.push(`${colName(i)}1:${colName(i)}2`);
  });
  const w = cmp ? 3 : 1;
  groups.forEach(([title], g) => {
    const at = first + g * w;
    r1.push(c(`${colName(at)}1`, title, S.head));
    for (let k = 1; k < w; k++) r1.push(c(`${colName(at + k)}1`, '', S.head));
    if (w > 1) merges.push(`${colName(at)}1:${colName(at + w - 1)}1`);
    for (let k = 0; k < w; k++) r2.push(c(`${colName(at + k)}2`, cols[at + k].sub, S.sub));
  });

  const value = (line, col) => {
    const v = line[col.key];
    if (v == null || v === '') return null;
    if (col.kind === 'ftfr') return v / 100;
    if (col.kind === 'days') return Math.round(v * 100) / 100;
    return v;
  };
  const style = (col, total) => ({
    text: total ? S.tText : S.text, int: total ? S.tInt : S.int, days: total ? S.tDays : S.days,
    pct: total ? S.tPct : S.pct, ftfr: total ? S.tFtfr : S.ftfr,
  })[col.kind];
  const lines = [...report.lines, { ...report.total, state: '' }];
  const body = lines.map((line, k) => {
    const n = k + 3; const total = k === lines.length - 1;
    return `<row r="${n}" ht="18" customHeight="1">${cols.map((col, i) => c(`${colName(i)}${n}`, value(line, col), style(col, total))).join('')}</row>`;
  }).join('');
  const last = lines.length + 2;

  // Red / green circles: TATs reversed (a fall is green), FTFR as it is (a rise is green). Zero is amber.
  const cf = !cmp ? '' : groups.map(([, , , lowerIsBetter], g) => {
    const col = colName(first + g * 3 + 2);
    return `<conditionalFormatting sqref="${col}3:${col}${last}"><cfRule type="iconSet" priority="${g + 1}"><iconSet iconSet="3TrafficLights1"${lowerIsBetter ? ' reverse="1"' : ''}><cfvo type="percent" val="0"/><cfvo type="num" val="0"/><cfvo type="num" val="0" gte="0"/></iconSet></cfRule></conditionalFormatting>`;
  }).join('');

  const widths = cols.map((col, i) => {
    const w = col.kind === 'text'
      ? Math.min(48, Math.max(col.h.length, ...lines.map((l) => String(l[col.key] ?? '').length)) + 3)
      : col.kind === 'pct' ? 13 : 11;
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="${lead.length}" ySplit="2" topLeftCell="${colName(lead.length)}3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData><row r="1" ht="34" customHeight="1">${r1.join('')}</row><row r="2" ht="30" customHeight="1">${r2.join('')}</row>${body}</sheetData>
<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
${cf}
</worksheet>`;
  const sheets = [{ name: sheetName, xml }];
  if (ftfr) sheets.push({ name: 'FTFR Summary', xml: ftfrSheet(ftfr) });
  return writeStyledBook(sheets, STYLES);
}

/** FTFR by AMC / CAMC, a row per month and a Grand Total, as their own FTFR sheet (the user, 26 Nov). */
function ftfrSheet(ftfr) {
  const n = ftfr.types.length;
  const r1 = [c('A1', 'Month', S.head)]; const r2 = [c('A2', '', S.head)];
  const merges = ['A1:A2'];
  ftfr.types.forEach((t, g) => {
    const at = 1 + g * 3;
    r1.push(c(`${colName(at)}1`, t, S.head), c(`${colName(at + 1)}1`, '', S.head), c(`${colName(at + 2)}1`, '', S.head));
    merges.push(`${colName(at)}1:${colName(at + 2)}1`);
    r2.push(c(`${colName(at)}2`, 'Total calls received', S.sub), c(`${colName(at + 1)}2`, 'Completed in 24 hrs', S.sub), c(`${colName(at + 2)}2`, 'FTFR %', S.sub));
  });
  const lines = [...ftfr.lines, ftfr.total];
  const body = lines.map((l, k) => {
    const r = k + 3; const total = k === lines.length - 1;
    const cells = [c(`A${r}`, l.label, total ? S.tText : S.text)];
    ftfr.types.forEach((t, g) => {
      const at = 1 + g * 3; const v = l[t];
      cells.push(
        c(`${colName(at)}${r}`, v.calls, total ? S.tInt : S.int),
        c(`${colName(at + 1)}${r}`, v.fixed, total ? S.tInt : S.int),
        c(`${colName(at + 2)}${r}`, v.pct == null ? null : v.pct / 100, total ? S.tFtfr : S.ftfr),
      );
    });
    return `<row r="${r}" ht="18" customHeight="1">${cells.join('')}</row>`;
  }).join('');
  const widths = `<col min="1" max="1" width="14" customWidth="1"/><col min="2" max="${1 + n * 3}" width="13" customWidth="1"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData><row r="1" ht="22" customHeight="1">${r1.join('')}</row><row r="2" ht="34" customHeight="1">${r2.join('')}</row>${body}</sheetData>
<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
</worksheet>`;
}
