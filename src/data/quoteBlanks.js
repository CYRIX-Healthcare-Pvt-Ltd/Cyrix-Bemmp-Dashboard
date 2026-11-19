/*
  A Word template whose blanks are marked in yellow (the user, 19 Nov: "they highlighted yellow colored wherever editing
  is required"; CYRIX- AMC QUOTATION.docx). Each yellow run of text becomes a box on the form, the same name in two places
  one box (<VERTICAL>, <CUSTOMER NAME>); a whole yellow line in the letter a tick (keep it or not); a yellow bit Word's
  comment calls a pick list a choice; the yellow-headed table (Annexure A) rows typed or from Excel. Filling changes
  only the yellow and takes the yellow away. The price table is filled by quoteWord as for any template.
*/
import JSZip from 'jszip';
import { findItemsTable } from './quoteLayout.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XS = 'http://www.w3.org/XML/1998/namespace';
const kids = (el, name) => [...(el?.childNodes ?? [])].filter((n) => n.nodeName === name);
const all = (el, name) => [...el.getElementsByTagName(name)];
const textOf = (el) => all(el, 'w:t').map((t) => t.textContent).join('');
const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;
const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');

const yellow = (r) => {
  const rpr = kids(r, 'w:rPr')[0]; if (!rpr) return false;
  const h = kids(rpr, 'w:highlight')[0]; if (h && h.getAttribute('w:val') === 'yellow') return true;
  const sh = kids(rpr, 'w:shd')[0]; return /^ffff00$/i.test(sh?.getAttribute('w:fill') ?? '');
};
const inside = (el, name) => { for (let a = el.parentNode; a; a = a.parentNode) if (a.nodeName === name) return a; return null; };

/** The yellow groups of one part, in order: runs side by side in one paragraph. */
function groupsOf(doc, skipTables) {
  const out = [];
  for (const p of all(doc, 'w:p')) {
    const tbl = inside(p, 'w:tbl');
    if (tbl && skipTables.has(tbl)) continue;
    let cur = null;
    for (const r of kids(p, 'w:r').concat(kids(p, 'w:hyperlink').flatMap((h) => kids(h, 'w:r')))) {
      if (yellow(r) && all(r, 'w:t').length) { if (!cur) { cur = { p, runs: [], tbl }; out.push(cur); } cur.runs.push(r); }
      else if (all(r, 'w:t').some((t) => t.textContent.length)) cur = null;
    }
  }
  return out.map((g) => ({ ...g, text: g.runs.map(textOf).join('') })).filter((g) => g.text.trim());
}

/** The tables the blanks leave to others: the price table (quoteWord) and the yellow-headed list table (Annexure A). */
function tablesOf(doc) {
  const tbls = all(doc, 'w:tbl');
  const rowsText = tbls.map((t) => kids(t, 'w:tr').map((tr) => kids(tr, 'w:tc').map(textOf)));
  const price = findItemsTable(rowsText);
  const list = tbls.findIndex((t, i) => i !== price && (() => {
    const head = kids(t, 'w:tr')[0]; const cells = head ? kids(head, 'w:tc') : [];
    return cells.length >= 2 && cells.every((c) => all(c, 'w:r').filter((r) => textOf(r).trim()).every(yellow));
  })());
  // No yellow heading: a table headed S.No (Annexure 1 of a quotation sent before; the user, 19 Nov: "only header should
  // have"). Its rows are that customer's, so only the heading row is kept and the rows are typed or come from Excel.
  const serial = list >= 0 ? list : tbls.findIndex((t, i) => i !== price && (() => {
    const head = kids(t, 'w:tr')[0]; const cells = head ? kids(head, 'w:tc') : [];
    return cells.length >= 2 && SERIAL.test(norm(textOf(cells[0])));
  })());
  return { tbls, price, list: serial };
}

const norm = (s) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const SERIAL = /^(s[il]?\.?\s*no|sr\.?\s*no|no)\.?$/i;
const keyOf = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const DATE1 = /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/;
const PERIOD = /\d{1,2}\/\d{1,2}\/\d{2,4}\s*to\s*\d{1,2}\/\d{1,2}\/\d{0,4}/i;

/* Pick lists the comments ask for; the sample is always one of them. */
const PICKS = [
  [/hour/i, ['24 hours', '48 hours', '72 hours']],
  [/preventive/i, ['One (1) Preventive Maintenance visit per year', 'Two (2) Preventive Maintenance visits per year', 'Three (3) Preventive Maintenance visits per year', 'Four (4) Preventive Maintenance visits per year']],
];

/** What the form asks: fields (one per name), ticks (whole lines), and the list table's columns. */
export async function readBlanks(file) {
  const zip = await JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter((n) => PARTS.test(n)).sort((a, b) => (a === 'word/document.xml' ? 1 : b === 'word/document.xml' ? -1 : a.localeCompare(b)));
  const comments = parse(await zip.file('word/comments.xml')?.async('string') ?? '<x/>');
  const said = {}; for (const c of all(comments, 'w:comment')) said[c.getAttribute('w:id')] = textOf(c);
  const fields = []; const ticks = []; let list = null; let n = 0; let period = false;
  for (const name of names) {
    const doc = parse(await zip.file(name).async('string'));
    const t = name === 'word/document.xml' ? tablesOf(doc) : { tbls: [], price: -1, list: -1 };
    const skip = new Set([t.tbls[t.price], t.tbls[t.list]].filter(Boolean));
    if (t.list >= 0) {
      let el = t.tbls[t.list].previousSibling; let title = '';
      for (let k = 0; el && k < 4 && !title; k++, el = el.previousSibling) if (el.nodeName === 'w:p') title = norm(textOf(el));
      list = { cols: kids(kids(t.tbls[t.list], 'w:tr')[0], 'w:tc').map((c) => norm(textOf(c))), title: /annex/i.test(title) ? title : '' };
    }
    if (t.price >= 0 && PERIOD.test(textOf(t.tbls[t.price]))) period = true;
    // A comment's range: which groups it covers.
    const open = new Set(); const cover = new Map();
    const walk = (el) => {
      for (const c of el.childNodes ?? []) {
        if (c.nodeName === 'w:commentRangeStart') open.add(c.getAttribute('w:id'));
        else if (c.nodeName === 'w:commentRangeEnd') open.delete(c.getAttribute('w:id'));
        else if (c.nodeName === 'w:r') { if (open.size) cover.set(c, [...open]); }
        else walk(c);
      }
    };
    walk(doc);
    for (const g of groupsOf(doc, skip)) {
      const id = n++;
      const whole = textOf(g.p).trim() === g.text.trim();
      const pick = g.runs.flatMap((r) => cover.get(r) ?? []).some((c) => /pick/i.test(said[c] ?? ''));
      const opts = PICKS.find(([re]) => re.test(g.text))?.[1];
      // A whole yellow line with no <name> in it, and not a pick list or a date: kept or left out with a tick.
      if (whole && !g.tbl && !/<[^>]+>/.test(g.text) && !(pick && opts) && !DATE1.test(g.text) && !/^\d+$/.test(g.text.trim())) { ticks.push({ id, part: name, text: norm(g.text) }); continue; }
      let kind = 'text'; let label = norm(g.text);
      if (PERIOD.test(g.text)) { kind = 'period'; label = 'Contract period'; }
      else if (DATE1.test(g.text)) { kind = 'date'; label = 'Date'; }
      else if (pick && opts) { kind = 'pick'; label = /hour/i.test(g.text) ? 'Response time' : 'Preventive maintenance'; }
      else if (/^\d+$/.test(g.text.trim()) && /qtn/i.test(textOf(g.p))) { kind = 'qtn'; label = 'QTN number'; }
      const blank = /[<>]/.test(g.text) || bracketed(g);
      const key = kind === 'text' || kind === 'pick' ? keyOf(label) : kind;
      let f = fields.find((x) => x.key === key);
      if (!f) { f = { key, label, kind, sample: norm(g.text), blank, ...(kind === 'pick' ? { options: [...new Set([...opts, norm(g.text)])] } : {}), at: [] }; fields.push(f); }
      f.blank ||= blank;
      f.at.push({ id, part: name, text: g.text, line: textOf(g.p) });
    }
  }
  // A contract period written in the price table (left to quoteWord's table): its dates asked as Contract from / to.
  return { fields, ticks, list, period: period || fields.some((x) => x.kind === 'period') };
}

/** The paragraph's text before and after a group, by its text nodes (the brackets may sit in runs of their own). */
function around(g) {
  const ts = all(g.p, 'w:t'); const mine = new Set(g.runs.flatMap((r) => all(r, 'w:t')));
  let before = ''; let after = ''; let seen = false; let past = false;
  for (const t of ts) {
    if (mine.has(t)) { seen = true; continue; }
    if (!seen) before += t.textContent; else { past = true; after += t.textContent; }
  }
  return { ts, mine, before, after: past ? after : '' };
}
function bracketed(g) {
  const { before, after } = around(g);
  return /<\s*$/.test(before) || (/^\s*>/.test(after) && !/>/.test(g.text));
}
/** Take a white "<" before and ">" after a filled group away. */
function dropBrackets(g) {
  const { ts, mine, before, after } = around(g);
  const out = ts.filter((t) => !mine.has(t));
  if (/<\s*$/.test(before)) {
    const i = before.lastIndexOf('<'); let pos = 0;
    for (const t of out) { const l = t.textContent.length; if (i >= pos && i < pos + l) { const k = i - pos; t.textContent = t.textContent.slice(0, k) + t.textContent.slice(k + 1).replace(/^\s+$/, ''); break; } pos += l; if (pos > before.length) break; }
  }
  if (/^\s*>/.test(after) && !/>/.test(g.text)) {
    const i = after.indexOf('>'); let pos = 0;
    const aft = []; let seen = false;
    for (const t of ts) { if (mine.has(t)) { seen = true; continue; } if (seen) aft.push(t); }
    for (const t of aft) { const l = t.textContent.length; if (i >= pos && i < pos + l) { const k = i - pos; t.textContent = t.textContent.slice(0, k).replace(/^\s+$/, '') + t.textContent.slice(k + 1); break; } pos += l; }
  }
}

/** A paragraph's text changed in one place, the runs' looks kept: the change sits in the run where it starts. */
function rewrite(p, from, to) {
  const ts = all(p, 'w:t'); const full = ts.map((t) => t.textContent).join('');
  const at = full.indexOf(from); if (at < 0) return;
  let pos = 0;
  for (const t of ts) {
    const len = t.textContent.length; const s0 = pos; pos += len;
    if (pos <= at) continue;
    if (s0 <= at) { t.textContent = t.textContent.slice(0, at - s0) + to + full.slice(at + from.length); t.setAttributeNS(XS, 'xml:space', 'preserve'); }
    else t.textContent = '';
  }
}

/** A date as the template writes them: 19/11/2026. */
const ddmm = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** The value written in place of one yellow group: a <name> inside it is replaced, the rest of it kept ("– <VERTICAL>"). */
function valueFor(f, at, v, q) {
  if (f.kind === 'date') return ddmm(q.date);
  if (f.kind === 'period') return `${ddmm(q.from)} to ${ddmm(q.upto)}`;
  if (v == null || v === '') return at.text;
  if (/</.test(at.text)) return at.text.replace(/<[^>]*>?/, v);
  return v;
}

function setRuns(g, text) {
  g.runs.forEach((r, i) => {
    const ts = all(r, 'w:t');
    ts.forEach((t, k) => { t.textContent = i === 0 && k === 0 ? text : ''; if (i === 0 && k === 0) t.setAttributeNS(XS, 'xml:space', 'preserve'); });
  });
}

/** Fill the yellow of a template: q.fields {key: value}, q.ticks {id: false to leave a line out}, q.rows [[cells]]. */
export async function fillBlanks(file, blanks, q) {
  const zip = await JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter((n) => PARTS.test(n)).sort((a, b) => (a === 'word/document.xml' ? 1 : b === 'word/document.xml' ? -1 : a.localeCompare(b)));
  const byId = new Map();
  for (const f of blanks.fields) for (const at of f.at) byId.set(at.id, { f, at });
  const tick = new Map(blanks.ticks.map((t) => [t.id, t]));
  let n = 0;
  for (const name of names) {
    const doc = parse(await zip.file(name).async('string'));
    const t = name === 'word/document.xml' ? tablesOf(doc) : { tbls: [], price: -1, list: -1 };
    const skip = new Set([t.tbls[t.price], t.tbls[t.list]].filter(Boolean));
    const gone = [];
    for (const g of groupsOf(doc, skip)) {
      const id = n++;
      if (tick.has(id)) { if (q.ticks?.[id] === false) gone.push(g.p); continue; }
      const hit = byId.get(id); if (!hit) continue;
      const text = valueFor(hit.f, hit.at, q.fields?.[hit.f.key], q);
      setRuns(g, text);
      if (q.fields?.[hit.f.key] != null && q.fields[hit.f.key] !== '') dropBrackets(g);
      // A period cut short in yellow ("…31/12/202" then "6"): the rest of the old year goes.
      if (hit.f.kind === 'period') {
        const after = g.runs[g.runs.length - 1].nextSibling;
        for (let r = after; r && r.nodeName === 'w:r'; r = r.nextSibling) {
          const ts = all(r, 'w:t'); if (!ts.length) continue;
          const m = /^\d*/.exec(ts[0].textContent)[0]; if (m) ts[0].textContent = ts[0].textContent.slice(m.length);
          break;
        }
      }
    }
    for (const p of gone) p.parentNode?.removeChild(p);
    if (t.price >= 0 && q.from && q.upto) {
      for (const p of all(t.tbls[t.price], 'w:p')) {
        const m = PERIOD.exec(textOf(p));
        if (m) rewrite(p, m[0] + (/^\d*/.exec(textOf(p).slice(m.index + m[0].length))?.[0] ?? ''), `${ddmm(q.from)} to ${ddmm(q.upto)}`);
      }
    }
    // The list table (Annexure A): its empty row once per row typed; Sl No counted.
    if (t.list >= 0 && blanks.list) {
      const el = t.tbls[t.list]; const trs = kids(el, 'w:tr'); const model = trs[1];
      if (model) {
        const rows = (q.rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
        const numbered = SERIAL.test(blanks.list.cols[0] ?? '');
        rows.forEach((row, i) => {
          const tr = model.cloneNode(true);
          kids(tr, 'w:tc').forEach((tc, k) => {
            const v = numbered && k === 0 ? String(i + 1) : String(row[k] ?? '');
            const [p, ...more] = kids(tc, 'w:p');
            for (const x of more) tc.removeChild(x);
            for (const br of all(p, 'w:br')) br.parentNode.removeChild(br);
            const ts = all(p, 'w:t');
            if (ts.length) ts.forEach((x, j) => { x.textContent = j === 0 ? v : ''; });
            else { const r = doc.createElementNS(W, 'w:r'); const tx = doc.createElementNS(W, 'w:t'); tx.setAttributeNS(XS, 'xml:space', 'preserve'); tx.textContent = v; r.appendChild(tx); p.appendChild(r); }
          });
          el.insertBefore(tr, model);
        });
        for (const tr of trs.slice(1)) el.removeChild(tr);
      }
    }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** The yellow taken off everything, and Word's comments with it, so the customer's copy is clean. */
export async function cleanYellow(file) {
  const zip = await JSZip.loadAsync(file);
  for (const name of Object.keys(zip.files).filter((n) => PARTS.test(n))) {
    const doc = parse(await zip.file(name).async('string'));
    for (const h of all(doc, 'w:highlight')) if (h.getAttribute('w:val') === 'yellow') h.parentNode.removeChild(h);
    for (const s of all(doc, 'w:shd')) if (/^ffff00$/i.test(s.getAttribute('w:fill') ?? '') && s.parentNode.nodeName === 'w:rPr') s.parentNode.removeChild(s);
    for (const tag of ['w:commentRangeStart', 'w:commentRangeEnd']) for (const c of all(doc, tag)) c.parentNode.removeChild(c);
    for (const c of all(doc, 'w:commentReference')) { const r = c.parentNode; r.parentNode?.removeChild(r); }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
