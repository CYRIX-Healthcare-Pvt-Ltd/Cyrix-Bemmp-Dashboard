/*
  The first sheet of an .xlsx as rows of text (the user, 19 Nov: "need excel upload also, bcz i saw 1 quotation with
  100 equipments"). Empty cells come back as ''.
*/
import JSZip from 'jszip';

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const colOf = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export async function readGrid(file) {
  let z;
  try { z = await JSZip.loadAsync(file); } catch { throw new Error('Choose an Excel file (.xlsx).'); }
  const shared = [];
  const sst = z.file('xl/sharedStrings.xml');
  if (sst) for (const si of xml(await sst.async('string')).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  let path = 'xl/worksheets/sheet1.xml';
  try {
    const id = xml(await z.file('xl/workbook.xml').async('string')).getElementsByTagName('sheet')[0]?.getAttribute('r:id');
    for (const r of xml(await z.file('xl/_rels/workbook.xml.rels').async('string')).getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === id) { const t = r.getAttribute('Target'); path = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`; }
    }
  } catch { /* the first sheet by its usual name */ }
  const f = z.file(path);
  if (!f) throw new Error('No sheet found in this file.');
  const rows = [];
  for (const row of xml(await f.async('string')).getElementsByTagName('row')) {
    const out = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t');
      let v;
      if (t === 'inlineStr') v = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else { const raw = c.getElementsByTagName('v')[0]?.textContent ?? ''; v = t === 's' ? shared[Number(raw)] ?? '' : raw; }
      out[colOf(c.getAttribute('r') ?? 'A')] = String(v ?? '').trim();
    }
    rows.push(Array.from(out, (x) => x ?? ''));
  }
  return rows;
}
