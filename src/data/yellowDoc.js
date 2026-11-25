/*
  Quotation templates marked in yellow (the user, 19 Nov: "whatever user shows in yellow is a field, rest everything should
  keep exactly"; "build it perfectly, yellow reader, font, spacing everything"). Reading finds, in the Word file's own XML:
    - boxes: each yellow bit of text; the same text in several places one box (Ref and Date on every page); a number and
      its word one box ("2" and "Two" for the PM visits); lines one under another each starting in yellow one box of
      lines (the To address, CLIENT, the signer);
    - the price table: the table with a yellow row and TOTAL / GST / GRAND TOTAL under it; the yellow row is one item,
      repeated per item; the figures worked out;
    - the list table (Annexure): a table whose heading row is yellow; its rows typed or from Excel.
  A box is named by the words before the yellow on its line, else by the line above ("TO," then a yellow name: To).
  Filling changes only the text of the yellow (and the worked-out figures and the Annexure rows) and takes the yellow
  away. Where a yellow bit is followed by spaces or tabs that hold something in its place on the line ("Ref- …   Date-",
  "Giri Pushp Hospital ⇥ Cyrix Healthcare"), the gap is rebuilt for the new text, measured in the run's own font at
  Word's tab stops, so what follows stays where it was. Fonts, spacing, letterhead, everything else is the file's own.
*/
import JSZip from 'jszip';
import { fontFor } from './pdfFonts.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XS = 'http://www.w3.org/XML/1998/namespace';
const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;
const kids = (el, name) => [...(el?.childNodes ?? [])].filter((n) => n.nodeName === name);
const all = (el, name) => [...el.getElementsByTagName(name)];
const textOf = (el) => all(el, 'w:t').map((t) => t.textContent).join('');
const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
const up = (el, name) => { for (let a = el.parentNode; a; a = a.parentNode) if (a.nodeName === name) return a; return null; };
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The parts in reading order: headers and footers (Ref, Date) first, then the body. */
const partNames = (zip) => Object.keys(zip.files).filter((n) => PARTS.test(n))
  .sort((a, b) => (a === 'word/document.xml' ? 1 : b === 'word/document.xml' ? -1 : a.localeCompare(b)));

const isYellow = (r) => {
  const rpr = kids(r, 'w:rPr')[0]; if (!rpr) return false;
  const h = kids(rpr, 'w:highlight')[0]; if (h && h.getAttribute('w:val') === 'yellow') return true;
  const sh = kids(rpr, 'w:shd')[0]; return /^ffff00$/i.test(sh?.getAttribute('w:fill') ?? '');
};

/** A paragraph's runs in order, also those inside links, insertions and content controls. */
function runsOf(p) {
  const out = [];
  const walk = (el) => { for (const c of el.childNodes ?? []) { if (c.nodeName === 'w:r') out.push(c); else if (/^w:(hyperlink|ins|smartTag|customXml|sdt|sdtContent|fldSimple)$/.test(c.nodeName)) walk(c); } };
  walk(p);
  return out;
}

/** A paragraph's text with its tabs as tab characters (for names: "CLIENT ⇥ FIRST PARTY"). */
const tabText = (p) => runsOf(p).map((r) => [...r.childNodes].map((c) => (c.nodeName === 'w:t' ? c.textContent : c.nodeName === 'w:tab' ? '\t' : '')).join('')).join('');

/*
  What changes but nobody coloured (the user, 25 Nov: "that ref id should be editable"): SUB AMC's "Ref- QTN1021/…" and
  "Date- 02/11/2026" sit plain in the page header. The Ref and Date after their words are found by rule; Gemini's
  finds (quoteAi.js) are added. Each is made yellow in a copy of the file — a run split where the text starts and ends —
  so reading, the form and filling treat it as if the person had coloured it. The original file is never changed.
*/
const REF_DATE = [/\bRef(?:erence)?\.?\s*(?:No\.?)?\s*[-:.]\s*([A-Z]{2,}[\w/.-]*\d[\w/.-]*)/i, /\bDate[d]?\s*[-:.]\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i];
export async function markYellow(file, texts = []) {
  const zip = await JSZip.loadAsync(file);
  const added = [];
  for (const name of partNames(zip)) {
    const doc = parse(await zip.file(name).async('string'));
    let changed = false;
    for (const p of all(doc, 'w:p')) {
      const runs = runsOf(p).filter((r) => kids(r, 'w:t').length);
      const whole = runs.map(textOf).join('');
      if (!whole.trim()) continue;
      const wants = [];
      for (const re of REF_DATE) { const m = re.exec(whole); if (m) wants.push(m[1]); }
      for (const t of texts) if (t && whole.includes(t)) wants.push(t);
      for (const want of [...new Set(wants)]) {
        const cur = runsOf(p).filter((r) => kids(r, 'w:t').length);
        const s = cur.map(textOf).join('').indexOf(want); if (s < 0) continue;
        if (paintRange(doc, cur, s, s + want.length)) { changed = true; added.push(want); }
      }
    }
    if (changed) zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  if (!added.length) return { file, added };
  const blob = await zip.generateAsync({ type: 'blob', mimeType: DOCX });
  return { file: new File([blob], file.name, { type: DOCX }), added };
}
/** Yellow on [s, e) of these runs' joined text: runs split at the edges; false when it is already yellow or a run is not plain text. */
function paintRange(doc, runs, s, e) {
  let at = 0; const hit = [];
  for (const r of runs) {
    const t = textOf(r); const a = at; const b = at + t.length; at = b;
    if (b <= s || a >= e) continue;
    if (isYellow(r)) return false;
    if ([...r.childNodes].some((c) => c.nodeName !== 'w:rPr' && c.nodeName !== 'w:t')) { if (a < s || b > e) return false; hit.push(r); continue; }
    const cut = [Math.max(s, a) - a, Math.min(e, b) - a];
    const parts = [t.slice(0, cut[0]), t.slice(cut[0], cut[1]), t.slice(cut[1])];
    const make = (text, yellowOn) => {
      const n = r.cloneNode(true);
      for (const x of kids(n, 'w:t')) n.removeChild(x);
      const wt = doc.createElementNS(W, 'w:t'); wt.setAttributeNS(XS, 'xml:space', 'preserve'); wt.textContent = text; n.appendChild(wt);
      if (yellowOn) hit.push(n);
      return n;
    };
    const fresh = parts.map((x, i) => (x ? make(x, i === 1) : null)).filter(Boolean);
    for (const n of fresh) r.parentNode.insertBefore(n, r);
    r.parentNode.removeChild(r);
  }
  for (const r of hit) {
    let rpr = kids(r, 'w:rPr')[0];
    if (!rpr) { rpr = doc.createElementNS(W, 'w:rPr'); r.insertBefore(rpr, r.firstChild); }
    for (const h of kids(rpr, 'w:highlight')) rpr.removeChild(h);
    // Word's order inside w:rPr: highlight comes before underline, effects, shading, language and the rest.
    const h = doc.createElementNS(W, 'w:highlight'); h.setAttributeNS(W, 'w:val', 'yellow');
    const after = [...rpr.childNodes].find((c) => /^w:(u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath|rPrChange)$/.test(c.nodeName));
    rpr.insertBefore(h, after ?? null);
  }
  return hit.length > 0;
}

/* ---------- A file with no yellow: coloured by the company's own patterns ---------- */

/*
  Learnt from the company's quotations (the user, 25 Nov: "understand the pattern, study, learn and save in rules"): the
  16 sent that day — Shri Balaji calibration, Mahally and Jeeva AMC, Nahas CAMC agreement, Dhee, AV Mult, Aswini, Tata,
  St Rita's, Sports Med, Orchid, Giri Pushp and the CT / MRI / Cathlab templates. A Word file with no yellow is coloured
  in a copy where these say, then read as if the person had coloured it; the Boxes list shows the result to check.
  No AI here; a file the person coloured is read as they coloured it.
    - the quotation number and the date after Ref / Quotation No / No / Date (page header or letter), and that date again
      in the letter ("entered on 10.11.2026");
    - the lines under "To," (or in the box under it, AV Mult); nothing under it: three sample lines (blank templates);
      the hospital's name again anywhere, its other lines where they stand alone or start a line (CLIENT ⇥ FIRST PARTY);
    - the lines under a "CUSTOMER NAME AND ADDRESS" heading (Mahally);
    - a contract period (two dates), and the dates of a sentence about the contract's start and end (Nahas);
    - the price table's first item row, but not its number, a cell pointing to the Annexure or the figures worked out from
      the price; amounts in the letter equal to a figure of that table (Nahas "Rs. 220000/-");
    - an Annexure list's heading row (equipment, make, model…; never a table of prices or of contacts);
    - the signer under With Regards / Yours truly / Prepared By / For Cyrix… and the contact under "please contact": the
      name and designation lines, of a phone line the number only; in a table beside "For Cyrix…", the values after
      NAME / DESIGNATION / MOBILE (Mahally, Jeeva).
*/
/** One run per piece (text, tab, break…), each in the run's own look, so a range can be coloured exactly. */
function splitRuns(doc, p) {
  for (const r of runsOf(p)) {
    const parts = [...r.childNodes].filter((c) => c.nodeName !== 'w:rPr');
    if (parts.length <= 1) continue;
    const rpr = kids(r, 'w:rPr')[0];
    for (const c of parts) { const n = doc.createElementNS(W, 'w:r'); if (rpr) n.appendChild(rpr.cloneNode(true)); n.appendChild(c.cloneNode(true)); r.parentNode.insertBefore(n, r); }
    r.parentNode.removeChild(r);
  }
}
/** A paragraph's text with its tabs and breaks, and where each character sits in its plain text (-1: a tab or break). */
function lineOf(p) {
  let s = ''; const at = []; let n = 0;
  for (const r of runsOf(p)) {
    for (const c of [...r.childNodes]) {
      if (c.nodeName === 'w:t') { const x = c.textContent; for (let i = 0; i < x.length; i++) { s += x[i]; at.push(n++); } } else if (c.nodeName === 'w:tab') { s += '\t'; at.push(-1); } else if (c.nodeName === 'w:br' || c.nodeName === 'w:cr') { s += '\n'; at.push(-1); }
    }
  }
  return { s, at };
}
const textRuns = (p) => runsOf(p).filter((r) => kids(r, 'w:t').length);
/** The runs holding [s, e) of a paragraph's plain text, split at the edges. */
function cutRange(doc, p, s, e) {
  splitRuns(doc, p);
  let at = 0; const hit = [];
  for (const r of textRuns(p)) {
    const t = textOf(r); const a = at; const b = at + t.length; at = b;
    if (b <= s || a >= e) continue;
    const c = [Math.max(s, a) - a, Math.min(e, b) - a];
    [t.slice(0, c[0]), t.slice(c[0], c[1]), t.slice(c[1])].forEach((x, i) => {
      if (!x) return;
      const n = r.cloneNode(true); for (const y of kids(n, 'w:t')) n.removeChild(y);
      const wt = doc.createElementNS(W, 'w:t'); wt.setAttributeNS(XS, 'xml:space', 'preserve'); wt.textContent = x; n.appendChild(wt);
      r.parentNode.insertBefore(n, r); if (i === 1) hit.push(n);
    });
    r.parentNode.removeChild(r);
  }
  return hit;
}
/** Yellow on [a, b) of the paragraph's text as lineOf gives it. */
function paintAt(doc, p, a, b) {
  const pos = lineOf(p).at.slice(a, b).filter((x) => x >= 0);
  if (!pos.length) return false;
  splitRuns(doc, p);
  return paintRange(doc, textRuns(p), pos[0], pos[pos.length - 1] + 1);
}
/** Yellow on a whole line, the spaces at its ends left out. */
function paintLine(doc, p) {
  const { s } = lineOf(p); const a = s.length - s.trimStart().length; const b = s.trimEnd().length;
  return b > a ? paintAt(doc, p, a, b) : false;
}
/** A line made two at its line break (AV Mult: name ↵ designation), each a paragraph of the same look. */
function splitAtBreak(doc, p) {
  splitRuns(doc, p);
  const runs = runsOf(p); const k = runs.findIndex((r) => kids(r, 'w:br').length || kids(r, 'w:cr').length);
  if (k < 0) return null;
  const q = p.cloneNode(false); const ppr = kids(p, 'w:pPr')[0]; if (ppr) q.appendChild(ppr.cloneNode(true));
  for (const r of runs.slice(k + 1)) q.appendChild(r);
  runs[k].parentNode.removeChild(runs[k]);
  p.parentNode.insertBefore(q, p.nextSibling);
  return q;
}
/** A new run at the end of a paragraph, in the look of its last text run (or of its paragraph mark). */
function newRun(doc, p, text) {
  const last = textRuns(p).pop(); const r = doc.createElementNS(W, 'w:r');
  const rpr = last ? kids(last, 'w:rPr')[0] : kids(kids(p, 'w:pPr')[0], 'w:rPr')[0];
  if (rpr) { const c = rpr.cloneNode(true); for (const x of [...c.childNodes]) if (/^w:(ins|del|rPrChange|moveFrom|moveTo|highlight)$/.test(x.nodeName)) c.removeChild(x); r.appendChild(c); }
  const t = doc.createElementNS(W, 'w:t'); t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = text; r.appendChild(t);
  return r;
}
/** A new line under a paragraph in its look, yellow (a sample under an empty "To,"). */
function sampleLine(doc, p, after, text) {
  const q = p.cloneNode(true); for (const x of [...q.childNodes]) if (x.nodeName !== 'w:pPr') q.removeChild(x);
  const r = newRun(doc, p, text); q.appendChild(r);
  after.parentNode.insertBefore(q, after.nextSibling);
  paintRange(doc, [r], 0, text.length);
  return q;
}
/** A yellow sample after a label with nothing after it ("Ref:", "Date:" of a blank template). */
function sampleAfter(doc, p, text) {
  if (!/\s$/.test(lineOf(p).s)) p.appendChild(newRun(doc, p, ' '));
  const r = newRun(doc, p, text); p.appendChild(r);
  paintRange(doc, [r], 0, text.length);
}
/** A sample in an empty cell, yellow or plain. */
function sampleCell(doc, tc, text, yellow) {
  const p = kids(tc, 'w:p')[0]; if (!p) return;
  for (const x of runsOf(p)) x.parentNode.removeChild(x);
  const r = newRun(doc, p, text); p.appendChild(r);
  if (yellow) paintRange(doc, [r], 0, text.length);
}
/**
  One item written over several rows (St Rita's: a bed, its features one to a row, the figures beside one of them) made
  one row: the description's lines in one cell, the figures beside them. False when the rows are not of that shape.
*/
function joinItem(doc, rows, a, f) {
  const n = kids(rows[a], 'w:tc').length;
  const tx = (i) => kids(rows[i], 'w:tc').map((c) => norm(textOf(c)));
  // The description's column: the one with words in the rows above the figures.
  const counts = new Array(n).fill(0);
  for (let i = a; i < f; i++) { const r = tx(i); if (r.length !== n) return false; r.forEach((x, k) => { if (k > 0 && x) counts[k] += 1; }); }
  const d = counts.indexOf(Math.max(...counts)); if (d <= 0 || !counts[d]) return false;
  const only = (i) => { const r = tx(i); return r.length === n && r.every((x, k) => k === d || k === 0 || !x); };
  const line = (i) => only(i) && !!tx(i)[d];
  if (!only(a)) return false;
  for (let i = a + 1; i < f; i++) if (!line(i)) return false;
  let e = f;
  while (e + 1 < rows.length && line(e + 1) && !/\btotal\b/i.test(rowLabel(rows[e + 1]))) e += 1;
  const keep = kids(rows[a], 'w:tc'); const fig = kids(rows[f], 'w:tc');
  for (let i = a + 1; i <= e; i++) for (const p of kids(kids(rows[i], 'w:tc')[d], 'w:p')) keep[d].appendChild(p.cloneNode(true));
  keep.forEach((tc, c) => {
    if (c === d || c === 0) return;
    for (const p of kids(tc, 'w:p')) tc.removeChild(p);
    for (const p of kids(fig[c], 'w:p')) tc.appendChild(p.cloneNode(true));
    // The figures in the middle of the taller cell; Word wants vAlign before hideMark and the change marks.
    const pr = kids(tc, 'w:tcPr')[0];
    if (pr && !kids(pr, 'w:vAlign').length) {
      const v = doc.createElementNS(W, 'w:vAlign'); v.setAttributeNS(W, 'w:val', 'center');
      pr.insertBefore(v, [...pr.childNodes].find((x) => /^w:(hideMark|headers|cellIns|cellDel|cellMerge|tcPrChange)$/.test(x.nodeName)) ?? null);
    }
  });
  for (let i = a + 1; i <= e; i++) rows[i].parentNode.removeChild(rows[i]);
  return true;
}
const innerPs = (doc) => all(doc, 'w:p').filter((p) => !all(p, 'w:p').length);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

export async function autoYellow(file) {
  const zip = await JSZip.loadAsync(file);
  const added = []; const dates = new Set();
  const REF_RE = /\b(?:ref(?:erence)?\.?(?:\s*no\.?)?|quotation\s*no\.?|qtn\.?\s*no\.?)\s*[:\-–.]+\s*([^\t\n]+?)(?=\t| {3,}|\s+date\b|$)/gi;
  const NO_RE = /^(\s*no\.?\s*[:\-–]+\s*)([^\t\n]+?)(?=\t| {3,}|\s+date\b|$)/i;
  const DATE_RE = /\bdated?(?:\s*[:\-–.]+\s*|\s+)(\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{4})(?!\d)/gi;
  const REF_EMPTY = /^\s*(?:our\s+)?(?:ref(?:erence)?\.?(?:\s*no\.?)?|quotation\s*no\.?|qtn\.?\s*no\.?)\s*[:\-–.]+\s*$/i;
  const DATE_EMPTY = /^\s*dated?\s*[:\-–.]+\s*$/i;
  // A code (QTN001/2026-27, AMC FFLM 049/2026-27), never "Your enquiry dated …".
  const refLike = (v) => /\d/.test(v) && /[/-]/.test(v) && v.length <= 40 && v.split(/\s+/).length <= 4
    && !/\b(dated?|your|our|letter|e-?mail|mail|enquiry|inquiry|discussion|telecon|visit|request|order)\b/i.test(v);
  const docs = {};
  for (const name of partNames(zip)) docs[name] = parse(await zip.file(name).async('string'));
  // Cyrix's own GSTIN in yellow (Shri Balaji, its one yellow) is the company's, never a box.
  const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/;
  for (const d of Object.values(docs)) {
    for (const p of innerPs(d)) {
      if (!/cyrix/i.test(textOf(p))) continue;
      for (const g of groupsIn(p)) {
        if (!GSTIN.test(g.text)) continue;
        for (const r of g.runs) { const rpr = kids(r, 'w:rPr')[0]; for (const x of kids(rpr, 'w:highlight')) rpr.removeChild(x); }
        added.push(`GSTIN kept as written: ${g.text.trim()}`);
      }
    }
  }
  const toAt = innerPs(docs['word/document.xml'] ?? parse('<x/>')).findIndex((p) => TO_LINE.test(lineOf(p).s));
  let refSeen = false; let dateSeen = false; let refEmpty = null; let dateEmpty = null;
  // The number and the date, in the page header or the letter.
  for (const [name, doc] of Object.entries(docs)) {
    const ps = innerPs(doc);
    for (const [i, p] of ps.entries()) {
      const { s } = lineOf(p); if (!s.trim()) continue;
      // Above the address (a blank template's "Ref:" and "Date:"), not a signing's "Date:".
      const top = name !== 'word/document.xml' || i < (toAt >= 0 ? toAt : 20);
      if (top && !refEmpty && REF_EMPTY.test(s)) refEmpty = [doc, p];
      if (top && !dateEmpty && DATE_EMPTY.test(s)) dateEmpty = [doc, p];
      const want = [];
      for (const m of s.matchAll(REF_RE)) if (refLike(m[1].trim())) want.push([m.index + m[0].length - m[1].length, m[1].trim()]);
      const no = NO_RE.exec(s); if (no && refLike(no[2].trim()) && /[a-z]/i.test(no[2]) && /\//.test(no[2])) want.push([no[1].length, no[2].trim()]);
      for (const m of s.matchAll(DATE_RE)) want.push([m.index + m[0].length - m[1].length, m[1], true]);
      // From the end of the line back, so a date written right does not move what comes after it.
      want.sort((x, y) => y[0] - x[0]);
      for (const [a, v, isDate] of want) {
        if (isDate) dateSeen = true; else refSeen = true;
        const clean = isDate ? v.replace(/\s+/g, '') : v;
        // A slip in the sample's date ("16-06- 2026", Dhee) written right in the copy, so it reads as a date.
        if (clean !== v) {
          const pos = lineOf(p).at.slice(a, a + v.length).filter((x) => x >= 0);
          const hit = cutRange(doc, p, pos[0], pos[pos.length - 1] + 1);
          hit.forEach((r, i) => { kids(r, 'w:t')[0].textContent = i === 0 ? clean : ''; });
          for (const r of hit.slice(1)) r.parentNode.removeChild(r);
          if (hit[0]) paintRange(doc, [hit[0]], 0, clean.length);
          added.push(clean);
        } else if (paintAt(doc, p, a, a + v.length)) added.push(v);
        if (isDate) dates.add(clean);
      }
    }
  }
  // A blank template (the CT / MRI templates): "Ref:" and "Date:" with nothing after them get a sample to overwrite.
  const now = new Date();
  if (!refSeen && refEmpty) {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const v = `QTN001/${y}-${String((y + 1) % 100).padStart(2, '0')}`; sampleAfter(refEmpty[0], refEmpty[1], v); added.push(v);
  }
  if (!dateSeen && dateEmpty) { const v = dmy(now); sampleAfter(dateEmpty[0], dateEmpty[1], v); added.push(v); dates.add(v); }
  const doc = docs['word/document.xml'];
  if (doc) {
    const ps = innerPs(doc);
    const plain = (p) => lineOf(p).s.trim();
    // The address under "To,".
    const to = []; const toPs = new Set();
    for (const p of ps) {
      if (!TO_LINE.test(lineOf(p).s)) continue;
      const got = []; let gap = 0;
      for (let el = p.nextSibling; el && got.length < 5; el = el.nextSibling) {
        if (el.nodeName === 'w:tbl') { if (!got.length && kids(el, 'w:tr').length <= 2) { const tc = all(el, 'w:tc')[0]; for (const q of tc ? kids(tc, 'w:p') : []) if (plain(q)) got.push(q); } break; }
        if (el.nodeName !== 'w:p') continue;
        const t = plain(el);
        if (!t) { if (got.length || ++gap > 1) break; continue; }
        if (/^(sub(ject)?\b|dear\b|kind\s*(attn|attention)|respected|ref\b|date\b|greetings)/i.test(t)) break;
        got.push(el);
      }
      if (got.length) { for (const q of got) if (paintLine(doc, q)) { to.push(plain(q)); toPs.add(q); } } else {
        let at = p; for (const x of ['Hospital name', 'Address', 'Place']) at = sampleLine(doc, p, at, x);
        added.push('To (sample lines)');
      }
      break;
    }
    if (to.length) added.push(`To: ${to.join(' / ')}`);
    // The customer again: the hospital's name anywhere; its other lines alone on a line or starting one. Not a person or
    // a post ("The Managing Director,") — the hospital is the line that sounds like one, else the first other line.
    const DESIG = /^(the\s+)?(managing\s+|medical\s+|chief\s+|general\s+|purchase\s+|biomedical\s+)?(director|manager|superintendent|administrator|officer|engineer|head|in-?charge|secretary|chairman|chairperson|ceo|cfo|coo|hod|dean|principal|purchase|procurement)\b/i;
    const ORG = /hospital|medical|medicare|clinic|centre|center|institute|health|diagnostic|lab|scan|college|trust|foundation|nursing|\bcare\b|speciality|specialty|pvt|ltd|limited|llp|society|mission|sciences/i;
    const cust = to.filter((l) => !PERSON.test(l) && !DESIG.test(l));
    const hosp = cust.find((l) => ORG.test(l)) ?? cust[0];
    if (hosp) {
      const names = [hosp.replace(/[\s,;:–—-]+$/, ''), hosp.split(',')[0].trim()].filter((x, i, a) => x.split(/\s+/).length >= 2 && a.indexOf(x) === i);
      const others = cust.filter((l) => l !== hosp).map((l) => l.replace(/[\s,;:–—-]+$/, '').toLowerCase());
      for (const q of innerPs(doc)) {
        if (toPs.has(q)) continue;
        for (const nm of names) {
          const re = new RegExp(`(^|[^A-Za-z0-9])(${escRe(nm)})(?![A-Za-z0-9])`, 'gi');
          for (const m of [...lineOf(q).s.matchAll(re)]) { const a = m.index + m[1].length; if (paintAt(doc, q, a, a + m[2].length)) added.push(m[2]); }
        }
        const { s } = lineOf(q); const t = s.trim().replace(/[\s,;:–—-]+$/, '').toLowerCase();
        if (others.includes(t)) { if (paintLine(doc, q)) added.push(s.trim()); continue; }
        const m = /^(\s*)([^\t]+?)(?=\t| {3,})/.exec(s);
        if (m && others.includes(m[2].trim().replace(/[\s,;:–—-]+$/, '').toLowerCase())) { if (paintAt(doc, q, m[1].length, m[1].length + m[2].trim().length)) added.push(m[2].trim()); }
      }
    }
    // The lines under a customer heading (Mahally's "CUSTOMER NAME AND ADDRESS:").
    for (const p of innerPs(doc)) {
      const t = plain(p);
      if (!/^(customer|client)('?s)?\b/i.test(t) || !/name|address/i.test(t) || t.length > 45) continue;
      let gap = 0; let n = 0;
      for (let el = p.nextSibling; el && n < 4; el = el.nextSibling) {
        if (el.nodeName !== 'w:p') continue;
        if (!plain(el)) { if (n || ++gap > 1) break; continue; }
        if (paintLine(doc, el)) added.push(plain(el)); n++;
      }
    }
    // Contract periods, and the dates of a sentence about the contract's start and end.
    const PAIR = /(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\s*(?:to|-|–|till)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/gi;
    for (const p of innerPs(doc)) {
      const { s } = lineOf(p);
      const pairs = [...s.matchAll(PAIR)];
      for (const m of pairs) if (paintAt(doc, p, m.index, m.index + m[0].length)) added.push(m[0]);
      const about = /contract|agreement/i.test(s) && /start|commenc|ending|end\s+on|expir|valid\s+(from|till|up)/i.test(s);
      for (const m of s.matchAll(/(?<![\d/.-])(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})(?![\d/.-])/g)) {
        if (pairs.some((x) => m.index >= x.index && m.index < x.index + x[0].length)) continue;
        if ((about || dates.has(m[1])) && paintAt(doc, p, m.index, m.index + m[1].length)) added.push(m[1]);
      }
    }
    // The price table's first item row.
    const NUM = /^[\s₹]*(rs\.?|inr)?\s*[\d,]+(\.\d+)?\s*(\/-)?\s*$/i;
    // "59,000+18% Tax" (St Rita's): the figure before the plus is the price.
    const LEADNUM = /^(\s*(?:₹|rs\.?|inr)?\s*)([\d,]{3,}(?:\.\d+)?)\s*(?:\/-)?\s*\+/i;
    const tbls = all(doc, 'w:tbl').filter((t) => !up(t, 'w:tbl'));
    let priced = null; const amounts = new Set();
    for (const t of tbls) {
      let rows = kids(t, 'w:tr');
      for (let h = 0; h < Math.min(2, rows.length - 1) && !priced; h++) {
        const heads = kids(rows[h], 'w:tc').map((c) => norm(textOf(c)));
        if (heads.length < 3 || !heads.some((x) => PRICE_HEAD.test(x) || YEAR_HEAD.test(x))) continue;
        const priceAt = (tr) => {
          const tx = kids(tr, 'w:tc').map((c) => norm(textOf(c)));
          return tx.length !== heads.length ? -1 : heads.findIndex((x, k) => (PRICE_HEAD.test(x) || YEAR_HEAD.test(x)) && !/%|gst|tax/i.test(x) && tx[k] && (NUM.test(tx[k]) || LEADNUM.test(tx[k])));
        };
        // The figures may sit some rows down, the item's description running over the rows around them (St Rita's).
        let f = -1;
        for (let i = h + 1; i < Math.min(rows.length, h + 25) && f < 0; i++) { if (i > h + 1 && /\btotal\b/i.test(rowLabel(rows[i]))) break; if (priceAt(rows[i]) >= 0) f = i; }
        if (f < 0 || (f > h + 1 && !joinItem(doc, rows, h + 1, f))) continue;
        rows = kids(t, 'w:tr');
        const cells = kids(rows[h + 1], 'w:tc');
        const txt = cells.map((c) => norm(textOf(c)));
        const pk = priceAt(rows[h + 1]);
        for (let k = 0; k < cells.length; k++) {
          if (!txt[k] || (k === 0 && /^\d+\.?$/.test(txt[k])) || (SERIAL.test(heads[k]) && /^\d+\.?$/.test(txt[k]))) continue;
          if (colKind(heads, k, pk) || /annex/i.test(txt[k])) continue;
          if (k === pk && !NUM.test(txt[k])) {
            for (const q of kids(cells[k], 'w:p')) { const m = LEADNUM.exec(lineOf(q).s); if (m) paintAt(doc, q, m[1].length, m[1].length + m[2].length); }
            continue;
          }
          for (const q of kids(cells[k], 'w:p')) paintLine(doc, q);
        }
        added.push(`Item row: ${txt.filter(Boolean).join(' | ').slice(0, 80)}`);
        priced = t;
        for (const tr of rows.slice(h + 1)) for (const c of kids(tr, 'w:tc')) { const x = norm(textOf(c)); if (NUM.test(x) && /\d{3}/.test(x)) amounts.add(numIn(x)); }
      }
      if (priced) break;
    }
    // A blank template's empty item row (CT / MRI templates): a sample in each cell, yellow where it is typed; the
    // figures worked out from the price written plain, as the filler works them out.
    for (const t of priced ? [] : tbls) {
      const rows = kids(t, 'w:tr');
      for (let h = 0; h < Math.min(2, rows.length - 1) && !priced; h++) {
        const heads = kids(rows[h], 'w:tc').map((c) => norm(textOf(c)));
        const cells = kids(rows[h + 1], 'w:tc');
        if (heads.length < 3 || cells.length !== heads.length) continue;
        if (cells.some((c, k) => { const x = norm(textOf(c)); return x && !(k === 0 && /^\d+\.?$/.test(x)); })) continue;
        // A price by year (SMRI, Cathlab): the years are the price, one sample each.
        const yearCols = heads.map((x, k) => (YEAR_HEAD.test(x) ? k : -1)).filter((k) => k >= 0);
        const pk = yearCols.length >= 2 ? yearCols[0] : heads.findIndex((x) => PRICE_HEAD.test(x) && !/%|gst|tax|total|grand|with|incl/i.test(x));
        if (pk < 0) continue;
        const rate = Number((/(\d+(?:\.\d+)?)\s*%/.exec(heads.join(' ')) ?? [0, 18])[1]);
        const P = 100000; const base = P * Math.max(1, yearCols.length >= 2 ? yearCols.length : 1); const tax = Math.round(base * rate) / 100;
        const from = new Date(now.getFullYear(), now.getMonth() + 1, 1); const till = new Date(from.getFullYear() + 1, from.getMonth(), 0);
        heads.forEach((hd, k) => {
          const kind = colKind(heads, k, pk);
          let v = hd.slice(0, 30); let yellow = true;
          if (k === 0 || SERIAL.test(hd)) { v = norm(textOf(cells[k])) || '1'; yellow = false; } else if (k === pk || (yearCols.length >= 2 && yearCols.includes(k))) v = moneyLike('1,00,000', P);
          // "Tax 18 %" holds the tax; "GST %" the rate.
          else if (kind) { yellow = false; v = kind === 'rate' && !/\d\s*%/.test(hd) ? `${rate}%` : moneyLike('1,00,000', kind === 'tax' || kind === 'rate' ? tax : kind === 'with' ? base + tax : base); }
          else if (QTY_HEAD.test(hd) && !NOT_QTY.test(hd)) v = '1';
          else if (/start|from|commenc/i.test(hd)) v = dmy(from);
          else if (/\bend|till|until|expir|\bto\b/i.test(hd)) v = dmy(till);
          else if (/period|duration/i.test(hd)) v = `${dmy(from)} to ${dmy(till)}`;
          else if (PRICE_HEAD.test(hd)) v = moneyLike('1,00,000', P);
          else if (/serial/i.test(hd)) v = 'SN0001';
          sampleCell(doc, cells[k], v, yellow);
        });
        added.push(`Item row (samples): ${heads.join(' | ').slice(0, 80)}`);
        priced = t;
      }
      if (priced) break;
    }
    // Amounts in the letter that are figures of the price table (Nahas: "Rs. 220000/-", "Rs.39600/-").
    if (amounts.size) {
      const AMT = /(?:rs\.?|₹|inr)\s*([\d,]{3,}(?:\.\d{1,2})?(?:\s*\/-)?)|([\d,]{4,}(?:\.\d{1,2})?\s*\/-)/gi;
      for (const p of innerPs(doc)) {
        if (up(p, 'w:tbl') === priced) continue;
        for (const m of [...lineOf(p).s.matchAll(AMT)]) {
          const v = (m[1] ?? m[2]).trim(); const a = m.index + m[0].length - (m[1] ?? m[2]).length;
          if (amounts.has(numIn(v)) && paintAt(doc, p, a, a + v.length)) added.push(v);
        }
      }
    }
    // The amount in words ("Rupees … Only"), worked out from the grand total when filled; a blank template's bare
    // "Amount in words: Rupees" (Cathlab) gets a sample to stand for it.
    if (priced) {
      for (const p of innerPs(doc)) {
        const { s } = lineOf(p);
        // Only the quotation's own amount: not the SMRI template's "Cold Head … (Rupees Eighteen Lakhs Only)".
        const m = /\bamount\s+in\s+words\b|\b(grand\s+)?total\b|contract\s+value/i.test(s) && s.length < 200 ? /\brupees\b.*?\bonly\b/i.exec(s) : null;
        if (m) { if (paintAt(doc, p, m.index, m.index + m[0].length)) added.push(m[0]); continue; }
        const e = /\bamount\s+in\s+words\b\s*[:\-–]?\s*(rupees)?\s*$/i.exec(s);
        if (!e) continue;
        const sample = e[1] ? 'One Lakh Only' : 'Rupees One Lakh Only';
        if (!/\s$/.test(s)) p.appendChild(newRun(doc, p, ' '));
        p.appendChild(newRun(doc, p, sample));
        const t = lineOf(p).s; const a = e[1] ? t.toLowerCase().lastIndexOf('rupees') : t.length - sample.length;
        if (paintAt(doc, p, a, t.trimEnd().length)) added.push('Amount in words (sample)');
      }
    }
    // An Annexure list's heading row (equipment, make, model…), never a table of prices or of contacts.
    for (const t of tbls) {
      if (t === priced) continue;
      const rows = kids(t, 'w:tr'); if (rows.length < 2) continue;
      const h = rows.length > 2 && kids(rows[0], 'w:tc').filter((c) => textOf(c).trim()).length <= 1 ? 1 : 0;
      const heads = kids(rows[h], 'w:tc').map((c) => norm(textOf(c))); const named = heads.filter(Boolean);
      if (named.length < 3 || named.some((x) => x.length > 40)) continue;
      if (!heads.some((x) => /equipment|item|asset|model|make|serial|device|machine/i.test(x)) || heads.some((x) => /rate|price|tax|gst/i.test(x))) continue;
      let el = t.previousSibling; let title = '';
      for (let k = 0; el && k < 5 && !title; k++, el = el.previousSibling) if (el.nodeName === 'w:p') title = norm(textOf(el));
      if (!/annex/i.test(title) && !/annex/i.test(textOf(rows[0]))) continue;
      for (const q of all(rows[h], 'w:p')) paintLine(doc, q);
      added.push(`Annexure: ${named.join(' | ')}`);
      break;
    }
    // The signer, and the contact under "please contact".
    const SIGN_LEAD = /^\s*(with\s+(best\s+|warm\s+|kind\s+)?regards|(best|warm|kind)\s+regards|yours\s+(truly|faithfully|sincerely)|thanking\s+you|prepared\s+by|submitted\s+by|for\s*,?\s*(m\/s\.?\s*)?cyrix\b.*|.*\b(please\s+contact|contact\s+person)\b.*)[\s,.:;]*$/i;
    const SIGN_STOP = /^\s*(for\s*,?\s*)?(m\/s\.?\s*)?cyrix\b|authori[sz]ed\s+signatory|^\s*(signature|seal|stamp|date|name|designation|place)\s*[:\-]?\s*$/i;
    const PHONE = /^(\s*(?:tel|ph|phone|mob(?:ile)?|cell|contact)\b[^:\n]*?[:\-–]+\s*)(\+?\d[\d\s-]{6,}\d)\s*$/i;
    const EMAIL = /^(\s*e-?mail\s*(?:id)?\s*[:\-–]+\s*)(\S+@\S+?)[\s.]*$/i;
    const VALUE = /^(\s*(?:name|designation|mobile\s*no\.?|mob(?:ile)?|phone|tel(?:\.?\s*no\.?)?|contact\s*no\.?|e-?mail(?:\s*id)?)\s*[:\-–]+\s*)(\S.*?)\s*$/i;
    for (const p of innerPs(doc)) {
      const lead = plain(p);
      if (lead.length > 45 || !SIGN_LEAD.test(lead)) continue;
      if (up(p, 'w:tc') && /^\s*for\b.*cyrix/i.test(lead)) {
        for (let el = p.nextSibling; el; el = el.nextSibling) {
          if (el.nodeName !== 'w:p') continue;
          const m = VALUE.exec(lineOf(el).s);
          if (m && paintAt(doc, el, m[1].length, m[1].length + m[2].length)) added.push(m[2]);
        }
        continue;
      }
      let n = 0; let gaps = 0;
      for (let el = p.nextSibling; el && n < 5; el = el.nextSibling) {
        if (el.nodeName === 'w:tbl') break;
        if (el.nodeName !== 'w:p') continue;
        const t = plain(el);
        if (!t) { if (n || ++gaps > 8) break; continue; }
        // An agreement's signing form ("Name: ⇥ Syed Nazre Imam ⇥ Designation: Service Delivery Head", the CT / MRI
        // templates) stays as written: the company's fixed signatory.
        if (SIGN_STOP.test(t) || (t.length <= 45 && SIGN_LEAD.test(t)) || /^(name|designation)\s*[:\-–]/i.test(t)) break;
        if (/\n/.test(lineOf(el).s.trim())) splitAtBreak(doc, el);
        // Of "Mob: 98…" or "Email: …@…" the number or the address only.
        const m = PHONE.exec(lineOf(el).s) ?? EMAIL.exec(lineOf(el).s);
        if (m) { if (paintAt(doc, el, m[1].length, m[1].length + m[2].length)) added.push(m[2]); } else if (paintLine(doc, el)) added.push(plain(el));
        n++;
      }
    }
  }
  if (!added.length) return { file, added };
  for (const [name, d] of Object.entries(docs)) zip.file(name, new XMLSerializer().serializeToString(d));
  const blob = await zip.generateAsync({ type: 'blob', mimeType: DOCX });
  return { file: new File([blob], file.name, { type: DOCX }), added };
}

/** The yellow groups of a paragraph: yellow runs side by side (spaces between them kept in). */
function groupsIn(p) {
  const out = []; let cur = null; let gap = [];
  for (const r of runsOf(p)) {
    const t = textOf(r);
    if (isYellow(r) && all(r, 'w:t').some((x) => x.textContent.length)) { if (!cur) { cur = { p, runs: [] }; out.push(cur); } else cur.runs.push(...gap); gap = []; cur.runs.push(r); }
    else if (!t.trim() && !all(r, 'w:tab').length) { if (cur) gap.push(r); }
    else { cur = null; gap = []; }
  }
  return out.map((g) => ({ ...g, text: g.runs.map(textOf).join('') })).filter((g) => g.text.trim());
}

/** The text of a paragraph before and after a group. */
function around(g) {
  const mine = new Set(g.runs);
  let before = ''; let after = ''; let seen = false;
  for (const r of runsOf(g.p)) {
    if (mine.has(r)) { seen = true; continue; }
    const t = [...r.childNodes].map((c) => (c.nodeName === 'w:t' ? c.textContent : c.nodeName === 'w:tab' ? '\t' : '')).join('');
    if (!seen) before += t; else after += t;
  }
  return { before, after };
}

/** One group's text replaced: all of it in its first text, the rest emptied, every run's look untouched. */
function setGroup(g, text) {
  let first = true;
  for (const r of g.runs) for (const t of all(r, 'w:t')) {
    t.textContent = first ? text : ''; if (first) t.setAttributeNS(XS, 'xml:space', 'preserve'); first = false;
  }
}

/** A whole paragraph's text set, keeping the first text's look. */
function setPara(doc, p, text) {
  const ts = all(p, 'w:t');
  if (ts.length) { ts.forEach((t, i) => { t.textContent = i === 0 ? text : ''; }); ts[0].setAttributeNS(XS, 'xml:space', 'preserve'); return; }
  const r = doc.createElementNS(W, 'w:r'); const t = doc.createElementNS(W, 'w:t');
  t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = text; r.appendChild(t); p.appendChild(r);
}

/* ---------- Terms and conditions ---------- */

/*
  The template's TERMS AND CONDITIONS, read whether yellow or not (the user, 24 Nov: "earlier we had terms and conditions
  also, which was editable"): the numbered lines under that heading, up to the first line that is not one of them. Word's
  own numbering, or a number typed at the start ("1.", "2)"), kept as the template has it.
*/
const TERMS_HEAD = /^(terms\s*(and|&)\s*conditions?|terms)\s*[:.]?$/i;
const MANUAL_NO = /^\s*\(?(\d{1,2})([.)])\s*/;
const wordNumbered = (p) => { const ppr = kids(p, 'w:pPr')[0]; const n = ppr && kids(ppr, 'w:numPr')[0]; return !!n && kids(n, 'w:numId')[0]?.getAttribute('w:val') !== '0'; };
function termsIn(doc) {
  const ps = all(doc, 'w:p');
  const h = ps.findIndex((x) => TERMS_HEAD.test(norm(textOf(x))));
  if (h < 0) return null;
  const out = [];
  for (let i = h + 1; i < ps.length; i++) {
    const x = ps[i];
    if (up(x, 'w:tbl') !== up(ps[h], 'w:tbl')) break;
    const t = norm(tabText(x));
    if (!t) continue;
    if (wordNumbered(x) || MANUAL_NO.test(t)) { out.push(x); continue; }
    break;
  }
  // A plain list only: one numbering at one level. An AMC contract's clauses (headings, sub-clauses, a list of
  // exceptions) stay as uploaded.
  const lv = (x) => { const n = kids(kids(x, 'w:pPr')[0] ?? x, 'w:numPr')[0]; return n ? `${kids(n, 'w:numId')[0]?.getAttribute('w:val')}/${kids(n, 'w:ilvl')[0]?.getAttribute('w:val') ?? '0'}` : 'typed'; };
  if (new Set(out.map(lv)).size > 1) return null;
  return out.length ? out : null;
}
const termOf = (x) => { const t = norm(tabText(x)); return wordNumbered(x) ? t : t.replace(MANUAL_NO, ''); };

/** The terms as the template has them (null: no TERMS AND CONDITIONS list in it). */
export async function readTerms(file) {
  const zip = await JSZip.loadAsync(file);
  const f = zip.file('word/document.xml'); if (!f) return null;
  const ps = termsIn(parse(await f.async('string')));
  return ps ? ps.map(termOf) : null;
}

/** A term's line written: Word's numbering untouched; a typed number counted again, its look and the gap after it kept. */
function setTerm(doc, x, n, text) {
  if (wordNumbered(x)) { for (const tab of all(x, 'w:tab')) tab.parentNode.removeChild(tab); setPara(doc, x, text); return; }
  const m = MANUAL_NO.exec(textOf(x));
  if (!m) { setPara(doc, x, text); return; }
  let left = m[0].replace(/\s+$/, '').length; let done = false; let first = true;
  for (const t of all(x, 'w:t')) {
    if (done) { t.textContent = ''; continue; }
    const s0 = t.textContent;
    if (left >= s0.length) { left -= s0.length; if (first && s0.trim()) { t.textContent = s0.replace(/\d{1,2}/, String(n)); first = false; } continue; }
    const head = s0.slice(0, left); const gap = /^\s*/.exec(s0.slice(left))[0];
    t.textContent = (first && head.trim() ? head.replace(/\d{1,2}/, String(n)) : head) + gap + text;
    t.setAttributeNS(XS, 'xml:space', 'preserve'); left = 0; done = true; first = false;
  }
  if (!done) { const r = doc.createElementNS(W, 'w:r'); const t = doc.createElementNS(W, 'w:t'); t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = text; r.appendChild(t); x.appendChild(r); }
}

/** The terms as written in the form: a changed one rewritten, one taken out removed, a new one under the last. */
function fillTerms(doc, terms, orig) {
  const ps = termsIn(doc); if (!ps) return;
  const list = terms.map((t) => norm(t)).filter(Boolean);
  ps.forEach((x, i) => {
    if (i >= list.length) { if (ps.length > 1 || list.length === 0) x.parentNode.removeChild(x); return; }
    if (list[i] !== norm(orig?.[i]) || (!wordNumbered(x) && list.length !== ps.length)) setTerm(doc, x, i + 1, list[i]);
  });
  let last = ps[Math.min(list.length, ps.length) - 1];
  for (const [k, t] of list.slice(ps.length).entries()) {
    const c = last.cloneNode(true); last.parentNode.insertBefore(c, last.nextSibling); setTerm(doc, c, ps.length + k + 1, t); last = c;
  }
}

/*
  Terms in sections (the user, 25 Nov: "terms and conditions are editable, each heading collapsible"): when the terms are
  not one plain list (SUB AMC: Scope of services, Payment terms, Additional terms, then a contract with its own clauses),
  every plain-text paragraph after the last yellow part (the price table, Contract Period) up to the signature or the
  Annexure is read, grouped under the headings: a short line in capitals or all bold, without a full stop at the end.
*/
const STOP = /^(client\b|signature|with\s+regards|yours\s+(faithfully|sincerely|truly)|annex)/i;
const paraYellow = (p) => all(p, 'w:r').some(isYellow);
const allBold = (p) => { const rs = all(p, 'w:r').filter((r) => all(r, 'w:t').some((t) => t.textContent.trim())); return rs.length > 0 && rs.every((r) => { const b = kids(kids(r, 'w:rPr')[0] ?? r, 'w:b')[0]; return b && !/^(0|false)$/.test(b.getAttribute('w:val') ?? ''); }); };
function isHead(p, t) {
  if (t.length > 60 || /[.;,]$/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && (letters === letters.toUpperCase() || allBold(p));
}
function sectionsIn(doc) {
  const body = kids(all(doc, 'w:body')[0] ?? doc, 'w:p');
  // The stretch between the last yellow part and a signature line that has headings in it ("With Regards" under the
  // letter has none; the CLIENT signature under the terms has).
  let start = -1; let end = -1;
  const stops = body.map((p, i) => (STOP.test(norm(textOf(p))) ? i : -1)).filter((i) => i >= 0).concat(body.length);
  // After the price table (the letter above it is not terms), from the last yellow line there to the first signature
  // line after it ("CLIENT", "SIGNATURE") — the stretch must have headings.
  const tbls = kids(all(doc, 'w:body')[0] ?? doc, 'w:tbl').filter((t) => all(t, 'w:r').some(isYellow));
  const after = (p) => !tbls.length || (tbls[0].compareDocumentPosition(p) & 4);
  for (const s of stops) {
    let y = -1; for (let i = 0; i < s; i++) if (after(body[i]) && paraYellow(body[i])) y = i;
    if (y < 0) { const f = body.findIndex(after); if (f < 0 || f >= s) continue; y = f - 1; }
    if (body.slice(y + 1, s).filter((p) => { const t = norm(tabText(p)); return t && isHead(p, t); }).length >= 1) { start = y; end = s; break; }
  }
  if (start < 0) return null;
  const out = []; let cur = null;
  for (let i = start + 1; i < end; i++) {
    const p = body[i]; const t = norm(tabText(p));
    if (!t) continue;
    if (paraYellow(p)) break;
    if (isHead(p, t)) { cur = { head: p, items: [] }; out.push(cur); continue; }
    if (!cur) { cur = { head: null, items: [] }; out.push(cur); }
    cur.items.push(p);
  }
  const keep = out.filter((s) => s.items.length);
  return keep.length ? keep : null;
}
const headText = (p) => norm(textOf(p)).replace(/^\d{1,2}\s*[.)]\s*/, '').replace(/\s*:$/, '');

/** The terms in sections as the template has them: [{ head, items }] (null: none after the yellow parts). */
export async function readTermSections(file) {
  const zip = await JSZip.loadAsync(file);
  const f = zip.file('word/document.xml'); if (!f) return null;
  const s = sectionsIn(parse(await f.async('string')));
  return s ? s.map((x) => ({ head: x.head ? headText(x.head) : 'Terms', items: x.items.map((p) => norm(tabText(p))) })) : null;
}

/** A line rewritten keeping the look of what did not change: the bold "Service Scope:" lead, a typed "1." number. */
function setKeep(doc, p, text) {
  const ts = all(p, 'w:t');
  const oldText = ts.map((t) => t.textContent).join('');
  let k = 0; while (k < oldText.length && k < text.length && oldText[k] === text[k]) k++;
  // Back to a word's start, so a changed word is written whole in one look.
  while (k > 0 && /\S/.test(text[k - 1]) && /\S/.test(text[k] ?? '')) k--;
  let left = k; let put = false;
  ts.forEach((t, i) => {
    if (put) { t.textContent = ''; return; }
    const s0 = t.textContent;
    if (left > s0.length || (left === s0.length && i < ts.length - 1)) { left -= s0.length; return; }
    t.textContent = s0.slice(0, left) + text.slice(k); t.setAttributeNS(XS, 'xml:space', 'preserve'); put = true;
  });
  if (!put) setPara(doc, p, text);
}

/** The sections as written in the form: changed lines rewritten, lines taken out removed, new ones under the last. */
function fillSections(doc, secs, orig) {
  const ps = sectionsIn(doc); if (!ps) return;
  ps.forEach((s, si) => {
    const want = (secs?.[si]?.items ?? s.items.map((p) => norm(tabText(p)))).map(norm).filter(Boolean);
    const was = s.items.map((p) => norm(tabText(p)));
    const before = orig?.[si]?.items ?? was;
    s.items.forEach((p, i) => {
      if (i >= want.length) { p.parentNode.removeChild(p); return; }
      if (want[i] !== norm(before[i] ?? '')) setKeep(doc, p, want[i]);
    });
    if (!want.length) { if (s.head) s.head.parentNode.removeChild(s.head); return; }
    let last = s.items[Math.min(want.length, s.items.length) - 1];
    const typed = MANUAL_NO.exec(norm(textOf(last)));
    for (const [k, t] of want.slice(s.items.length).entries()) {
      const c = last.cloneNode(true); last.parentNode.insertBefore(c, last.nextSibling);
      for (const b of all(c, 'w:b')) b.parentNode.removeChild(b);
      const n = s.items.length + k + 1;
      setPara(doc, c, typed && !MANUAL_NO.test(t) ? `${n}${typed[2]}  ${t}` : t);
      last = c;
    }
  });
}

/* ---------- Numbers, dates, amounts ---------- */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function numOf(text) {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) return { n: Number(t), form: 'digit' };
  const w = WORDS.indexOf(t.toLowerCase()); if (w > 0) return { n: w, form: 'word', cap: t };
  const m = /^([a-z]+)\s*\((\d{1,2})\)$/i.exec(t);
  if (m && WORDS.indexOf(m[1].toLowerCase()) === Number(m[2])) return { n: Number(m[2]), form: 'both', cap: m[1] };
  return null;
}
const wordLike = (n, cap) => {
  const w = WORDS[n] ?? String(n);
  if (!cap) return w;
  if (cap.length > 1 && cap === cap.toUpperCase()) return w.toUpperCase();
  if (cap[0] === cap[0].toUpperCase()) return w[0].toUpperCase() + w.slice(1);
  return w;
};
function writeNum(sample, v) {
  const s = numOf(sample); const n = Number(v);
  if (!s || v === '' || v == null || !Number.isFinite(n)) return String(v ?? '');
  if (s.form === 'digit') return String(n);
  if (s.form === 'word') return wordLike(n, s.cap);
  return `${wordLike(n, s.cap)} (${n})`;
}

const DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/;
const PERIOD = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\s*(to|-|–|till)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})$/i;
/**
 * Words written before the date inside the same yellow ("Contract Period: - 03/11/2026 to …"), or only its colon
 * (QTN046 Manima: ": 03/11/2026", the user, 23 Nov): kept as they are, so the rest is still a date.
 */
const LEAD = /^([^\d]*[a-z][^\d]*?[:\-–]\s*|[\s:\-–]+)(?=\d)/i;
const leadOf = (t) => LEAD.exec(t)?.[1] ?? '';
/** "Ref- " in front of a yellow number (SUB AMC's header, all of it yellow): kept when the number is filled in. */
const REF_LEAD = /^\s*Ref(?:erence)?\.?\s*(?:No\.?)?\s*[-:.–]\s*/i;
/** A line that is only "TO," (or "To:"). */
const TO_LINE = /^\s*to\s*[,:.-]?\s*$/i;
const WORDS_AMOUNT = /^\s*(rupees|rs\.?|inr)\b.*\bonly\b/i;
/** A date written as the sample wrote it: 02/11/2026, 02.11.2026 or 02-11-2026. */
const dateLike = (sample, iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); const sep = /[.-]/.exec(sample)?.[0] ?? '/'; return [d, m, y].join(sep); };
export const isoFrom = (s) => { const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

/** An amount written as the sample wrote it: 1,25,000.00 (Indian groups), decimals and ₹ / Rs. / "/-" as it had them. */
export function moneyLike(sample, n) {
  const s = String(sample ?? '');
  const dec = /\.\d{2}(?!\d)/.test(s) ? 2 : 0;
  const v = Math.round(Number(n || 0) * 100) / 100;
  const [i, f] = v.toFixed(dec).split('.');
  const g = i.length > 3 ? `${i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${i.slice(-3)}` : i;
  const pre = /^\s*(₹|rs\.?|inr)\s*/i.exec(s)?.[0] ?? '';
  const post = /\s*\/-\s*$/.exec(s)?.[0] ?? '';
  // Without commas only where the sample was a long figure written without them; "840" is too short to tell ("1,208").
  const plain = !s.includes(',') && (/\d{4,}/.exec(s) != null);
  return `${pre}${plain ? i : g}${f ? `.${f}` : ''}${post}`;
}
const numIn = (s) => Number(String(s ?? '').replace(/[^0-9.]/g, '')) || 0;

/** An amount in words, Indian style: "Rupees One Lakh Forty Seven Thousand Five Hundred Only". */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
function indianWords(n) {
  let v = Math.floor(n); if (!v) return 'Zero';
  const parts = [];
  for (const [d, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) { const q = Math.floor(v / d); if (q) { parts.push(`${q >= 100 ? indianWords(q) : two(q)} ${name}`); v %= d; } }
  if (v) parts.push(three(v));
  return parts.join(' ');
}
function wordsLike(sample, n) {
  const paise = Math.round((Number(n || 0) % 1) * 100);
  let t = `Rupees ${indianWords(n)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
  const s = sample.trim();
  if (s === s.toUpperCase()) t = t.toUpperCase();
  return t;
}

/* ---------- Tables ---------- */

const SERIAL = /^(s[il]?\.?\s*no\.?|sr\.?\s*no\.?|no\.?|#)$/i;
const PRICE_HEAD = /charge|rate|price|amount|cost|value|₹|\brs\b|fee/i;
// "Nos" is a count; "No. of PMS" (Nahas) and "Product Serial No." (CT template) are not (25 Nov).
// A price split by year (SMRI, Cathlab templates: First Year · Second Year · Third Year, the user, 25 Nov).
const YEAR_HEAD = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s*year\b|\byear\s*-?\s*[1-5]\b/i;
const QTY_HEAD = /\bqty\b|quantity|\bnos\b|\bunits?\b|\bpcs\b/i;
const NOT_QTY = /serial|s\/n|part|model|code|\bno\.?\s*of\b/i;
/** The headings row over a price table's item row: the nearest row above it with as many cells (Dhee: a "QUOTATION" title row on top). */
const headRow = (rows, at) => { const n = kids(rows[at], 'w:tc').length; for (let i = at - 1; i >= 0; i--) if (kids(rows[i], 'w:tc').length === n) return i; return 0; };
/** A row's name: its first cell with words in it (Jeeva's totals sit after an empty cell). */
const rowLabel = (tr) => norm(kids(tr, 'w:tc').map(textOf).find((x) => /[a-z]/i.test(x)) ?? '');

/** The tables of a part: the price table (a yellow row, totals under it) and the list table (a yellow heading row). */
function tablesOf(doc) {
  const tbls = all(doc, 'w:tbl').filter((t) => !up(t, 'w:tbl'));
  let price = null; let list = null;
  for (const t of tbls) {
    const rows = kids(t, 'w:tr');
    const yrow = rows.findIndex((tr, i) => i > 0 && all(tr, 'w:p').some((p) => groupsIn(p).length));
    // Cell by cell: a row's text runs its cells together ("GRAND TOTAL16,800", Carmel).
    const tot = rows.findIndex((tr, i) => i > yrow && kids(tr, 'w:tc').some((tc) => /\btotal\b/i.test(textOf(tc))));
    // No total row under it (Sub AMC: SI NO. · CONTRACT TYPE · RATE · GST % · GST RATE · TOTAL, the user, 19 Nov): a
    // price heading over a yellow figure in the item row is enough.
    const priced = () => {
      const heads = kids(rows[headRow(rows, yrow)], 'w:tc').map((c) => norm(textOf(c)));
      return kids(rows[yrow], 'w:tc').some((tc, k) => (PRICE_HEAD.test(heads[k] ?? '') || YEAR_HEAD.test(heads[k] ?? '')) && !/%/.test(heads[k] ?? '')
        && all(tc, 'w:p').flatMap(groupsIn).some((g) => /^[\s₹]*(rs\.?|inr)?\s*[\d,]+(\.\d+)?\s*(\/-)?\s*$/i.test(g.text)));
    };
    if (!price && yrow > 0 && (tot > yrow || priced())) {
      // More sample item rows under the first (QTN046 Manima: two power adapters, the user, 23 Nov): rows shaped like it,
      // numbered or wholly yellow, before the totals. Not boxes; they go when the quotation is filled.
      const n = kids(rows[yrow], 'w:tc').length;
      const extra = rows.slice(yrow + 1, tot > yrow ? tot : rows.length).filter((tr) => {
        const tcs = kids(tr, 'w:tc'); if (tcs.length !== n) return false;
        if (/total|gst|tax/i.test(textOf(tcs[0]))) return false;
        const runs = all(tr, 'w:r').filter((x) => textOf(x).trim());
        return /^\s*\d+\.?\s*$/.test(textOf(tcs[0])) || (runs.length > 0 && runs.every(isYellow));
      });
      price = { t, rows, item: yrow, head: headRow(rows, yrow), extra }; continue;
    }
    // The yellow heading row may sit under a title row ("Asset list - Orchid Medical Centre", SUB CAMC 25 Nov).
    for (let h = 0; h < 2 && !list; h++) {
      const head = rows[h];
      const cells = head ? kids(head, 'w:tc') : [];
      const runs = head ? all(head, 'w:r').filter((r) => textOf(r).trim()) : [];
      // Headings, two or more and short: not an address in a box (AV Mult's To in a one-row table, 25 Nov).
      const named = cells.map((c) => norm(textOf(c))).filter(Boolean);
      if (cells.length >= 2 && runs.length && runs.every(isYellow) && named.length >= 2 && named.every((x) => x.length <= 40)) {
        // Its rows end where the shape changes: SUB CAMC's summary under the list (TOTAL ASSET VALUE | ₹ …) is not a row;
        // nor is a total in the same shape (Aswini's TOTAL QTY, added up when filled).
        let end = h + 1;
        while (end < rows.length && kids(rows[end], 'w:tc').length === cells.length && !kids(rows[end], 'w:tc').some((c) => /^\s*total\b/i.test(textOf(c)))) end++;
        list = { t, rows: rows.slice(h, end), tail: end < rows.length, cells: cells.length };
      }
      if (h === 0 && cells.length > 2) break; // a full first row that is not yellow: not a list
    }
  }
  return { price, list };
}

/** What the price table holds: its columns, the item row's yellow, which column is the price and which the quantity. */
function priceOf(pt) {
  const head = kids(pt.rows[pt.head ?? 0], 'w:tc').map((c) => norm(textOf(c)));
  const cells = kids(pt.rows[pt.item], 'w:tc').map((tc, k) => ({ k, head: head[k] ?? '', groups: all(tc, 'w:p').flatMap(groupsIn).map((g, j) => ({ j, text: g.text })) }));
  const numeric = (c) => c.groups.length === 1 && /^[\s₹]*(rs\.?|inr)?\s*[\d,]+(\.\d+)?\s*(\/-)?\s*$/i.test(c.groups[0].text);
  // Of two prices in yellow (Dhee: Unit Price · Special discounted Price, 25 Nov) the discounted one is charged.
  const cands = cells.filter((c) => numeric(c) && PRICE_HEAD.test(c.head));
  let pk = (cands.find((c) => /discount|special|offer/i.test(c.head)) ?? cands[0])?.k;
  if (pk == null) pk = cells.filter(numeric).map((c) => c.k).pop();
  // Two or more years side by side: one price per year, the first year's column standing as the price's.
  const years = cells.filter((c) => numeric(c) && YEAR_HEAD.test(c.head)).map((c) => c.k);
  if (years.length >= 2) pk = years[0];
  const qk = cells.find((c) => c.k !== pk && c.groups.length && QTY_HEAD.test(c.head) && !SERIAL.test(c.head) && !NOT_QTY.test(c.head))?.k ?? null; // "SI No" is not a Qty
  const fields = [];
  for (const c of cells) {
    if (c.k === pk || !c.groups.length || (years.length >= 2 && years.includes(c.k))) continue;
    // A whole table marked yellow (Carmel, the user, 19 Nov): its serial number and the columns worked out from the
    // price (Total Price, GST %, Tax Amount, Total with Taxes) are not boxes to type.
    if (SERIAL.test(c.head) || colKind(head, c.k, pk)) continue;
    c.groups.forEach((g, j) => fields.push({
      key: `c${c.k}g${j}`, label: c.groups.length > 1 ? `${c.head || 'Item'} · line ${j + 1}` : c.head || 'Item', sample: norm(g.text), qty: c.k === qk,
    }));
  }
  // The template's own figures: GST % from "GST 18%", and whether its price was for the whole row (76 Nos, 1,25,000 total).
  // GST from the item row's own GST % cell (Carmel's 5%), else from a "GST 18%" row under it.
  // The rate from the item row's GST cell ("18%", AV Mult's GST column), else from its heading ("GST @5%" over 667, Tata).
  const itemTc = kids(pt.rows[pt.item], 'w:tc');
  const rateCell = cells.find((c) => c.k > (pk ?? 99) && (/%/.test(c.head) || /^\s*\d+(\.\d+)?\s*%\s*$/.test(textOf(itemTc[c.k]))));
  const rc = rateCell ? itemTc[rateCell.k] : null;
  const rowRate = rc ? (/(\d+(\.\d+)?)\s*%/.exec(textOf(rc)) ?? /(\d+(\.\d+)?)\s*%/.exec(rateCell.head)) : null;
  let gst = rowRate ? Number(rowRate[1]) : 18; let total = null;
  for (const tr of pt.rows.slice(pt.item + 1)) {
    const tcs = kids(tr, 'w:tc'); const label = rowLabel(tr);
    const m = /(gst|tax)\D*?(\d+(\.\d+)?)\s*%/i.exec(textOf(tr)); if (m) gst = Number(m[2]);
    if (/total/i.test(label) && !/grand/i.test(label) && total == null) total = numIn([...tcs].reverse().map(textOf).find((x) => /\d/.test(x)));
  }
  const price = pk != null ? numIn(cells[pk].groups[0].text) : 0;
  const qty = qk != null ? numIn(cells[qk].groups[0]?.text) : 0;
  const lump = qk == null ? true : total != null && qty > 1 ? Math.abs(total - price) < Math.abs(total - price * qty) : false;
  // Asked at upload only when the template does not say (the user, 19 Nov): "Unit Price", "Rate", "Per…", "Each" or a
  // row-total column after the price (Carmel's Total Price) is one piece × Qty.
  const perUnit = qk != null && pk != null && (/unit|\bper\b|each|\brate\b/i.test(head[pk] ?? '')
    || head.some((h, k) => k > pk && /total|amount/i.test(h) && colKind(head, k, pk) === 'line'));
  // The template's TOTAL row settles it too (the user, 19 Nov): 1,25,000 for 76 Nos with TOTAL 1,25,000 is the whole row;
  // TOTAL = price × Qty is one piece. No Qty column: nothing to multiply.
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const totalSays = qk == null || (total != null && qty > 1 && price > 0 && (near(total, price) || near(total, price * qty)));
  return { cols: head, price: pk ?? null, ...(years.length >= 2 ? { years, yearHeads: years.map((k) => head[k]) } : {}), priceHead: head[pk] ?? 'Amount', samplePrice: pk != null ? cells[pk].groups[0].text : '', qty: qk, fields, gst,
    lump: perUnit ? false : lump, ...(perUnit || totalSays ? { lumpSure: true } : {}) };
}

/* ---------- Lines ---------- */

/** The list of paragraphs lines run in: the paragraph's own parent, or one column of a table down its rows. */
function containerOf(p) {
  const tc = up(p, 'w:tc');
  if (!tc) return { list: kids(p.parentNode, 'w:p'), table: false };
  const tr = tc.parentNode; const tbl = tr.parentNode; const col = kids(tr, 'w:tc').indexOf(tc);
  return { list: kids(tbl, 'w:tr').flatMap((r) => { const c = kids(r, 'w:tc')[col]; return c ? kids(c, 'w:p') : []; }), table: true };
}

/** The first words of a line, up to a tab or a wide gap ("CLIENT ⇥ FIRST PARTY": CLIENT). */
const firstChunk = (s) => norm(String(s).split(/\t| {3,}/).find((x) => x.trim()) ?? '');
const nameOf = (s) => {
  const t = firstChunk(s).replace(/[\s,:;–—-]+$/, '');
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : '';
};
const chunks = (s) => String(s).split(/\t| {3,}/).map((x) => norm(x).replace(/^[\s:;,.–—-]+|[\s:;,–—-]+$/g, '')).filter((x) => /[a-z0-9]/i.test(x));
const labelBefore = (before) => {
  const cs = chunks(before); let last = cs.pop() ?? '';
  // "Period of Contract   from: " (Mahally): the words before the joining word.
  if (/^(from|on|of|dated|for|is|w\.?e\.?f\.?)$/i.test(last) && cs.length) last = cs.pop();
  const w = last.split(' ');
  // A sentence ending "…365 Days starting from" or "…and ending on" (Nahas): its last two words.
  if (w.length > 2 && /^(from|on|dated|till|until)$/i.test(w[w.length - 1]) && /^[a-z]+$/i.test(w[w.length - 2])) return w.slice(-2).join(' ');
  return w.slice(-4).join(' ').replace(/^[^a-z0-9]+/i, '');
};
const labelAfter = (after) => (chunks(after)[0] ?? '').split(' ').slice(0, 4).join(' ').replace(/[^a-z0-9)]+$/i, '');
const PERSON = /^(dr|mr|mrs|ms|miss|prof)\b\.?/i;

/** What a yellow bit is: what makes two of them one box. */
function keyOf(text) {
  const t = norm(text);
  if (WORDS_AMOUNT.test(t)) return { key: 'words', kind: 'words' };
  const n = numOf(t); if (n) return { key: `num:${n.n}`, kind: 'num' };
  const d = t.slice(leadOf(t).length);
  if (PERIOD.test(d)) return { key: `period:${t}`, kind: 'period' };
  if (DATE.test(d)) return { key: `date:${t}`, kind: 'date' };
  return { key: `text:${t.toLowerCase()}`, kind: 'text' };
}

/** The boxes of one part, in reading order. */
function scan(doc) {
  const { price, list } = tablesOf(doc);
  const skip = (p) => {
    const tbl = up(p, 'w:tbl');
    if (list && tbl === list.t && list.rows.includes(up(p, 'w:tr'))) return true;
    // The price table's headings, item row and totals are its own: yellow there (Carmel, all yellow) makes no box. Other
    // rows of it keep their boxes (Giri Pushp's "Contract Period: 03/11/2026 to 02/11/2027").
    if (price && tbl === price.t) {
      const tr = up(p, 'w:tr'); const at = price.rows.indexOf(tr);
      // Its title, headings and item row (everything down to the item), the sample items and the totals.
      if ((at >= 0 && at <= price.item) || price.extra.includes(tr)) return true;
      if (/total|gst|tax/i.test(rowLabel(tr))) return true;
    }
    return false;
  };
  const groupsByP = new Map();
  const starts = new Set(); // lines starting with their yellow ("Giri Pushp Hospital ⇥ Cyrix…", or the whole line)
  for (const p of all(doc, 'w:p')) {
    if (skip(p)) continue;
    const gs = groupsIn(p); if (!gs.length) continue;
    groupsByP.set(p, gs);
    if (!around(gs[0]).before.trim()) starts.add(p);
  }
  // A box of lines: two or more such lines one under another in one place (empty lines between allowed).
  const inBlock = new Map(); const blocks = []; const seen = new Set();
  const prevLine = (list2, at) => { for (let i = at - 1; i >= 0; i--) { const t = tabText(list2[i]); if (t.trim()) return t; } return ''; };
  for (const p of starts) {
    if (seen.has(p)) continue;
    const c = containerOf(p); const at = c.list.indexOf(p);
    const slots = [];
    for (let i = at; i < c.list.length; i++) {
      const q = c.list[i];
      if (starts.has(q)) { slots.push(q); seen.add(q); continue; }
      if (!tabText(q).trim()) continue;
      break;
    }
    const heading = prevLine(c.list, at);
    if (slots.length >= 2) { const b = { slots, heading, table: c.table }; blocks.push(b); for (const s of slots) inBlock.set(s, b); }
  }
  const items = [];
  for (const [p, gs] of groupsByP) {
    if (inBlock.has(p)) {
      const b = inBlock.get(p);
      if (b.slots[0] === p) items.push({ type: 'block', block: b });
      for (const g of gs.slice(1)) items.push({ type: 'inline', g }); // yellow later on a line of the box (rare)
      continue;
    }
    gs.forEach((g, i) => {
      const c = i === 0 && starts.has(p) && !around(g).before.trim() ? containerOf(p) : null;
      items.push({ type: 'inline', g, heading: c ? prevLine(c.list, c.list.indexOf(p)) : '' });
    });
  }
  return { price, list, items };
}

const blockKey = (b) => `block:${(nameOf(b.heading) || 'address').toLowerCase()}`;
/** The line over the signer's name: With Regards, Yours truly, Prepared By, For Cyrix Healthcare… */
const SIGNER_HEAD = /regards|yours|sincerely|faithfully|truly|thanking|prepared\s+by|submitted\s+by|^\s*for\b.*\b(cyrix|healthcare)\b/i;
/** A block's lines as written (to find the box of a signer written in two places). */
const blockLines = (b) => b.slots.map((p) => norm(groupsIn(p)[0]?.text)).join('\n');
/** A box the person types: not worked out, not kept as written, not following To. */
export const typedBox = (x) => x.kind !== 'words' && x.kind !== 'fixed' && !x.worked && !(x.wlines && x.wlines.every(Boolean)) && x.role !== 'toline';

/** Read a template: its boxes, the price table and the list table. Nothing yellow: `fields` empty. */
export async function readYellow(file) {
  const zip = await JSZip.loadAsync(file);
  const fields = []; let price = null; let list = null; const plain = [];
  const byKey = new Map();
  for (const name of partNames(zip)) {
    const doc = parse(await zip.file(name).async('string'));
    // The plain text, with no yellow, for Gemini to spot what changes but was not coloured (quoteAi.js).
    for (const p of all(doc, 'w:p')) { const t = norm(textOf(p)); if (t && !groupsIn(p).length) plain.push(t); }
    const s = scan(doc);
    if (s.price && !price) price = priceOf(s.price);
    if (s.list && !list) {
      const cols = kids(s.list.rows[0], 'w:tc').map((c) => norm(textOf(c)));
      let el = s.list.t.previousSibling; let title = '';
      for (let k = 0; el && k < 4 && !title; k++, el = el.previousSibling) if (el.nodeName === 'w:p') title = norm(textOf(el));
      list = { cols, title: /annex/i.test(title) ? title : '' };
    }
    for (const it of s.items) {
      if (it.type === 'block') {
        const b = it.block; const key = blockKey(b);
        if (byKey.has(key)) { byKey.get(key).places++; continue; }
        const signer = SIGNER_HEAD.test(b.heading);
        const lines = b.slots.map((p) => norm(groupsIn(p)[0]?.text));
        // The same signer under another heading (Shri Balaji: "Prepared By" on page 1, "For Cyrix…" at the end): one box.
        const same = signer && fields.find((x) => x.kind === 'signer' && x.sample === lines.join('\n'));
        if (same) { same.places++; byKey.set(key, same); continue; }
        const f = { key, kind: signer ? 'signer' : 'lines', label: signer ? 'Signed by' : nameOf(b.heading) || 'Address', sample: lines.join('\n'), lines: lines.length, places: 1 };
        // Each line's label in the cell before it, when the lines sit in a table (SUB CAMC: TOTAL ASSET VALUE | ₹ …).
        const rl = b.slots.map((p) => { const tc = up(p, 'w:tc'); const tr = tc && up(tc, 'w:tr'); const first = tr && kids(tr, 'w:tc')[0]; return first && first !== tc ? norm(textOf(first)) : ''; });
        if (rl.some(Boolean)) f.rowLabels = rl;
        byKey.set(key, f); fields.push(f);
        continue;
      }
      const { g } = it; const { key, kind } = keyOf(g.text);
      if (byKey.has(key)) { byKey.get(key).places++; continue; }
      const { before, after } = around(g);
      let label = kind === 'num' ? labelAfter(after) || labelBefore(before) : labelBefore(before);
      // Its own name inside the yellow ("Contract Period: - 03/11/2026 to …": Contract period).
      const own = !label && /^\s*([a-z][a-z .&/()]{1,40}?)\s*[:：]/i.exec(g.text);
      if (own) label = nameOf(own[1]);
      // Alone on its line: named by the line above ("TO," then a yellow name: To).
      // Not a signing line, though: SUB AMC's yellow "Annexture- 1" under "SIGNATURE … SIGNATURE" is its own name (25 Nov).
      // A sentence above is no name (Nahas: "2.2.1 Maintenance Services in respect of…" over the machine's name).
      if (!label && it.heading && norm(it.heading).length <= 40 && !/^\s*(signature|seal|sign)\b/i.test(it.heading)) label = nameOf(it.heading);
      if (kind === 'words') label = 'Amount in words';
      if (!label) label = norm(g.text).slice(0, 30);
      // The second date of a pair ("from … to …"): named after the first.
      const prev = fields[fields.length - 1];
      if (kind === 'date' && /^(to|till|until)$/i.test(label) && prev?.kind === 'date') label = `${prev.label} to`;
      // The words around it, for Gemini to name it (quoteAi.js).
      const f = { key, kind, label, sample: norm(g.text), places: 1, around: norm(`${it.heading ? it.heading + " / " : ""}${before}[${g.text}]${after}`).slice(0, 300) };
      byKey.set(key, f); fields.push(f);
    }
  }
  // A number written in the price row and in the letter is one box (the PM visits: "2" there and "Two" in the terms).
  if (price) {
    for (const pf of price.fields) {
      const n = !pf.qty && numOf(pf.sample);
      if (n) {
        pf.link = `num:${n.n}`;
        if (!byKey.has(pf.link)) { const f = { key: pf.link, kind: 'num', label: pf.label, sample: pf.sample, places: 0 }; byKey.set(pf.link, f); fields.push(f); }
        byKey.get(pf.link).places++;
      }
    }
    // A cell's lines named by its heading alone when only one of them is asked per item.
    const own = price.fields.filter((x) => !x.link);
    for (const x of own) { const col = x.key.replace(/g\d+$/, ''); if (own.filter((y) => y.key.startsWith(`${col}g`)).length === 1) x.label = x.label.replace(/ · line \d+$/, ''); }
  }
  rolesOf(fields, list);
  return { v: 2, fields, price: oneBoxPerCell(price), list, plain: plain.join('\n').slice(0, 12000) };
}

/** Which box is the quotation number, the date, the address, CLIENT. Worked out again whenever a form opens, so a
    template saved before a rule changed follows the new rule without being uploaded again. */
/** One box per cell of the price row (the user, 19 Nov: "something inside a box is single field"): a cell's yellow
    lines become one box with a line each (parts: which yellow pieces they are); a piece linked to a box in the letter
    (PM visits) stays linked. Run again on opening, so a template saved with a box per line follows. */
export function oneBoxPerCell(price) {
  if (!price?.fields) return price;
  const out = []; const done = new Set();
  for (const f of price.fields) {
    const m = /^c(\d+)g(\d+)$/.exec(f.key);
    if (!m || f.link || f.qty) { if (!done.has(f.key)) out.push(f); continue; }
    const col = m[1]; if (done.has(`c${col}`)) continue;
    const same = price.fields.filter((x) => !x.link && !x.qty && new RegExp(`^c${col}g\\d+$`).test(x.key));
    if (same.length < 2) { out.push(f); continue; }
    done.add(`c${col}`);
    out.push({ key: `c${col}`, label: f.label.replace(/ · line \d+$/, ''), sample: same.map((x) => x.sample).join('\n'),
      lines: same.length, parts: same.map((x) => Number(/g(\d+)$/.exec(x.key)[1])), qty: false });
  }
  return { ...price, fields: out };
}

/*
  Amounts worked out, never typed (the user, 25 Nov: "what gst amount I need to type"): a yellow figure equal to the
  template's own total, GST or grand total (from its price row and GST %) follows the price table. A box of several
  figures (SUB CAMC's summary: asset value, CAMC, GST, total) keeps only the others to type.
*/
const MONEY = /^\s*(₹|rs\.?|inr)?\s*\d{1,3}(,\d{2,3})*(\.\d{1,2})?\s*(\/-)?\s*$/i;
// A long figure written without commas ("Rs. 220000/-", Nahas 25 Nov).
const MONEY_PLAIN = /^\s*(₹|rs\.?|inr)?\s*\d{4,}(\.\d{1,2})?\s*(\/-)?\s*$/i;
export function markWorked(Y) {
  const pr = Y?.price; const base = pr && numIn(pr.samplePrice);
  if (!base) return Y;
  const tax = Math.round(base * Number(pr.gst || 0)) / 100;
  const sums = [['total', base], ['tax', tax], ['with', Math.round((base + tax) * 100) / 100]];
  const which = (s) => { if (!((MONEY.test(s) && /[,.]/.test(s)) || MONEY_PLAIN.test(s))) return null; const n = numIn(s); return sums.find(([, v]) => v && Math.abs(n - v) <= 1)?.[0] ?? null; };
  const fields = Y.fields.map((f) => {
    const g = { ...f }; delete g.worked; delete g.wlines;
    if ((f.kind === 'text' || f.kind === 'num') && !f.role) {
      const w = which(f.sample);
      if (w) { g.worked = w; if (!/[a-z]{3}/i.test(f.label) || MONEY.test(f.label)) g.label = { total: 'Total', tax: 'GST amount', with: 'Grand total' }[w]; }
    }
    if (f.kind === 'lines' && !f.role) { const ws = f.sample.split('\n').map((l) => which(l)); if (ws.some(Boolean)) g.wlines = ws; }
    return g;
  });
  // The lines left to type named by the labels beside them (SUB CAMC: "TOTAL ASSET VALUE" in the box next to the figures).
  for (const g of fields) {
    if (!g.wlines) continue;
    const tags = fields.find((x) => x !== g && x.sample.split('\n').length === g.wlines.length && !x.sample.split('\n').some((l) => /\d{3}/.test(l)));
    const names = g.rowLabels ? g.rowLabels.filter((l, i) => l && !g.wlines[i]).map((l) => l.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()))
      : tags ? tags.sample.split('\n').filter((_, i) => !g.wlines[i]).map((l) => l.trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())) : [];
    if (names.length) g.label = names.join(' · ');
  }
  return { ...Y, fields };
}

export function rolesOf(fields, list) {
  for (const f of fields) delete f.role;
  // The Annexure's yellow heading is the Annexure section's own title, never a box of its own (SUB AMC, 25 Nov).
  if (list) for (const f of fields) if (f.kind === 'text' && /^annex/i.test(f.sample.trim())) f.kind = 'fixed';
  const ref = fields.find((f) => f.kind === 'text' && (/\b(ref|qtn|quotation\s*(no|num))/i.test(f.label) || /^qtn/i.test(f.sample) || REF_LEAD.test(f.sample)
    // "No: AMC FFLM 049/2026-27" (Mahally, 25 Nov): a number with a slash in it.
    || (/^(no|number)\.?$/i.test(f.label.trim()) && /\d/.test(f.sample) && /\//.test(f.sample))));
  // A label that is the number itself ("Ref – QTN015/…", SUB CAMC 25 Nov) is no name: Ref number.
  const looksRef = (l) => REF_LEAD.test(l) || /qtn|\d{2,}\/|\/\d{2,}/i.test(l);
  if (ref) { ref.role = 'ref'; if (!/[a-z]{2}/i.test(ref.label) || looksRef(ref.label)) ref.label = 'Ref number'; }
  const date = fields.find((f) => f.kind === 'date' && /date/i.test(f.label)) ?? fields.find((f) => f.kind === 'date');
  if (date) { date.role = 'date'; if (looksRef(date.label)) date.label = 'Date'; }
  // The customer's address: named To or Address, or a whole yellow block starting "TO," (SUB AMC, the user, 19 Nov).
  const to = fields.find((f) => (f.kind === 'lines' || f.kind === 'text') && /^to\b/i.test(f.label))
    ?? fields.find((f) => f.kind === 'lines' && (/^address\b/i.test(f.label) || TO_LINE.test(f.sample.split('\n')[0])));
  if (to) to.role = 'to';
  // The customer written again in the letter, the same words as a line of To ("For, NAHAS HOSPITAL ⏎ MALAPPURAM" at the
  // signing, Nahas 25 Nov): filled from To, not asked. The last line follows To's last line (the place).
  if (to) {
    const tl = to.sample.split('\n').map((l) => norm(l).toLowerCase()).filter((l) => l && !TO_LINE.test(l));
    for (const f of fields) {
      if (f === to || f.role || f.kind !== 'text') continue;
      const i = tl.indexOf(norm(f.sample).toLowerCase());
      if (i >= 0) { f.role = 'toline'; f.line = i > 0 && i === tl.length - 1 ? -1 : i; }
    }
  }
  const client = fields.find((f) => (f.kind === 'lines' || f.kind === 'text') && f !== to && !f.role && /client|customer|second party|hospital/i.test(f.label));
  if (client) client.role = 'client';
  return fields;
}

/**
 * A box's starting value (the user, 19 Nov): customer details empty, or today, the request's hospital, the signed-in
 * person; the usual terms as uploaded.
 */
export function startValue(f, ctx = {}) {
  // Nothing of the uploaded file's own customer shows when making one (the user, 19 Nov: "when we are creating, why
  // uploaded data showing"): every box starts empty but today, the signed-in person and what a request knows.
  if (f.role === 'date') return ctx.today ?? '';
  if (f.role === 'to') return ctx.hospital ?? '';
  // CLIENT on one line of the letter takes the hospital's first line only.
  if (f.role === 'client') { const c = ctx.hospital ? clientFrom(ctx.hospital) : ''; return f.kind === 'text' ? c.split('\n')[0] : c; }
  if (f.kind === 'signer') return ctx.signer ?? '';
  if (f.kind === 'period') return { from: '', upto: '' };
  // Not a box (Gemini, quoteAi.js): the template's own text stays.
  if (f.kind === 'fixed') return f.sample;
  // Standard terms, the same for every customer (Gemini: PM visits, response times; the user, 25 Nov): start as written.
  if (f.common && !f.role && f.kind === 'text') return f.sample;
  return '';
}

/*
  What a request already knows, put into the boxes this template has, and only those (the user, 19 Nov: "every template
  changes and is unique"). To: the hospital, its district on the next line. Price table: the spare in the item column and
  its quantity in the Qty column; the charge stays the Coordinator's (the request's rate is our cost, not the price).
  Annexure: one row of the equipment, make, model and serial under the columns named so. A box the template lacks is
  left out; nothing is added to the Word file.
*/
export function fromRequest(Y, r) {
  const s = (v) => String(v ?? '').trim();
  const hosp = s(r?.hospital); const dist = s(r?.district);
  const to = hosp && dist && !hosp.toLowerCase().includes(dist.toLowerCase()) ? `${hosp}\n${dist}` : hosp;
  const item = {};
  const fields = (Y.price?.fields ?? []).filter((f) => !f.link);
  // Only a price table quoting a spare (a Spare, Part, Item, Description… column): an AMC letter's "Equipment Name ·
  // AMC CONTRACT" and its Qty (the Annexure's count) stay as the template has them.
  const qf = fields.find((f) => f.qty);
  const qty = s(r?.approved_qty ?? r?.qty);
  const spare = s(r?.spare);
  const nf = fields.find((f) => !f.qty && /part\s*(no|number|code)|item\s*code/i.test(f.label));
  const sf = fields.find((f) => !f.qty && f !== nf && /spare|part|item|description|particular|product|material/i.test(f.label));
  if (sf && spare) {
    item[sf.key] = spare;
    if (qf && qty) item[qf.key] = `${qty}${/\s*nos?\.?\s*$/i.exec(qf.sample)?.[0] ?? ''}`;
    if (nf && s(r?.part_no)) item[nf.key] = s(r.part_no);
  }
  let row = null;
  if (Y.list?.cols?.length) {
    const make = s(r?.make); const model = s(r?.model);
    const cell = (h) => {
      if (SERIAL.test(h)) return '';
      if (/make.*model|model.*make/i.test(h)) return [make, model].filter(Boolean).join(' / ');
      if (/serial|sr\.?\s*no\b|s\/n/i.test(h)) return s(r?.serial);
      if (/make|brand|manufacturer|oem/i.test(h)) return make;
      if (/model/i.test(h)) return model;
      if (/asset|barcode|tag/i.test(h)) return s(r?.barcode);
      if (/equipment|device|machine|description|item|name/i.test(h)) return s(r?.equipment);
      return '';
    };
    const cells = Y.list.cols.map(cell);
    if (cells.some(Boolean)) row = cells;
  }
  return { to, item, row };
}

/** CLIENT from To: the person's line (always first when there is one) left out (the user, 19 Nov). */
export const clientFrom = (to) => { const l = String(to ?? '').split('\n').map((x) => x.trim()).filter(Boolean); return (l.length > 1 && PERSON.test(l[0]) ? l.slice(1) : l).join('\n'); };

/** The items as written: a Qty left empty beside Annexure rows is their count, as the sample wrote it ("3 Nos"). */
export function itemsOf(Y, items, rows) {
  const n = (rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim())).length;
  const qf = Y.price?.fields.find((f) => f.qty && !f.link);
  const list = ((items ?? []).length ? items : [{}]).map((it) => (Y.price?.years && Array.isArray(it.years) ? { ...it, price: yearSum(it.years) } : it));
  return list.map((it) => (qf && n && !String(it[qf.key] ?? '').trim() ? { ...it, [qf.key]: `${n}${/\s*nos?\.?\s*$/i.exec(qf.sample)?.[0] ?? ''}` } : it));
}

/*
  A worked-out column of the price table by its heading: 'rate' (GST %), 'tax' (GST amount), 'line' (the row before tax)
  or 'with' (with tax). A Total or Amount column with a tax column after it is before tax (Carmel: Total Price · GST % ·
  Tax Amount · Total with Taxes); one with none after it is with tax (Sub AMC: RATE · GST % · GST RATE · TOTAL).
*/
export function colKind(cols, k, price) {
  if (price == null || k <= price) return null;
  const h = cols[k] ?? '';
  if (/%/.test(h)) return 'rate';
  if (/with|incl|gross|grand/i.test(h)) return 'with';
  if (/gst|tax/i.test(h)) return 'tax';
  // A Total, Amount or Rate column after the price (Shri Balaji: UNIT RATE · RATE, 25 Nov): before tax when a tax column
  // follows it or the table has none (its GST is in the rows under it); with tax when a tax column comes before it.
  if (/total|amount|value|\brate\b/i.test(h)) {
    if (cols.slice(k + 1).some((c) => /gst|tax/i.test(c) && !/%/.test(c) && !/with|incl/i.test(c))) return 'line';
    return cols.slice(price + 1, k).some((c) => /gst|tax|%/i.test(c)) ? 'with' : 'line';
  }
  return null;
}

/** The figures of the price table: per item, the total, the GST and the grand total. */
export function totalsOf(Y, items, gst, lump) {
  const pr = Y.price; if (!pr) return { lines: [], total: 0, tax: 0, with: 0 };
  const qkey = pr.fields.find((f) => f.qty)?.key;
  const lines = (items ?? []).map((it) => { const p = numIn(it.price); return lump || !qkey ? p : p * (numIn(it[qkey]) || 1); });
  const total = Math.round(lines.reduce((a, b) => a + b, 0) * 100) / 100;
  const tax = Math.round(total * Number(gst || 0)) / 100;
  // A price by year: each year's own total, GST and total with it (the GST and Total Contract Value rows, by year).
  const byYear = (pr.years ?? []).map((_, j) => {
    const t = Math.round((items ?? []).reduce((a, it) => { const p = numIn(it.years?.[j]); return a + (lump || !qkey ? p : p * (numIn(it[qkey]) || 1)); }, 0) * 100) / 100;
    const x = Math.round(t * Number(gst || 0)) / 100;
    return { total: t, tax: x, with: Math.round((t + x) * 100) / 100 };
  });
  return { lines, total, tax, with: Math.round((total + tax) * 100) / 100, byYear };
}
/** An item's price as the sum of its years (a price by year), else as typed. */
export const yearSum = (years) => String(Math.round((years ?? []).reduce((a, v) => a + numIn(v), 0) * 100) / 100);

/* ---------- Measuring: keep what follows a yellow bit where it was on its line ---------- */

const FONT_BASE = `${String(import.meta.env?.BASE_URL || '/').replace(/\/+$/, '')}/fonts/`;
const faces = {};
function face(fam, bold) {
  const id = `yd-${fam}-${bold ? 'b' : 'r'}`;
  faces[id] ??= (async () => {
    const f = new FontFace(id, `url(${FONT_BASE}${fam}-${bold ? 'Bold' : 'Regular'}.ttf)`);
    await f.load(); document.fonts.add(f); return id;
  })().catch(() => null);
  return faces[id];
}

/** The Word file's styles, theme fonts, default tab stop and page width: what a run's look comes from. */
async function looksOf(zip) {
  const read = async (n) => parse(await zip.file(n)?.async('string') ?? '<x/>');
  const [styles, theme, settings, body] = await Promise.all([read('word/styles.xml'), read('word/theme/theme1.xml'), read('word/settings.xml'), read('word/document.xml')]);
  const font = (tag) => theme.getElementsByTagName(tag)[0]?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface');
  const st = new Map(); let normal = null;
  for (const s of all(styles, 'w:style')) { st.set(s.getAttribute('w:styleId'), s); if (s.getAttribute('w:type') === 'paragraph' && s.getAttribute('w:default') === '1') normal = s.getAttribute('w:styleId'); }
  const dr = all(styles, 'w:rPrDefault')[0]; const dp = all(styles, 'w:pPrDefault')[0];
  const sect = all(body, 'w:sectPr').pop();
  const pg = sect && kids(sect, 'w:pgSz')[0]; const mar = sect && kids(sect, 'w:pgMar')[0];
  const width = pg && mar ? (Number(pg.getAttribute('w:w')) - Number(mar.getAttribute('w:left') ?? 1440) - Number(mar.getAttribute('w:right') ?? 1440)) / 20 : 468;
  return {
    st, normal, minor: font('a:minorFont') || 'Calibri', major: font('a:majorFont') || 'Calibri Light',
    dflt: dr ? kids(dr, 'w:rPr')[0] : null, dfltP: dp ? kids(dp, 'w:pPr')[0] : null,
    tab: Number(all(settings, 'w:defaultTabStop')[0]?.getAttribute('w:val') || 720) / 20, width,
  };
}
function chain(L, id) { const out = []; let s = id && L.st.get(id); for (let n = 0; s && n < 12; n++) { out.push(s); const b = kids(s, 'w:basedOn')[0]?.getAttribute('w:val'); s = b ? L.st.get(b) : null; } return out; }
const pStyleOf = (L, p) => { const ppr = kids(p, 'w:pPr')[0]; return (ppr && kids(ppr, 'w:pStyle')[0]?.getAttribute('w:val')) || L.normal; };
const onOff = (el) => { if (!el) return null; const v = el.getAttribute('w:val'); return !(v === '0' || v === 'false' || v === 'off'); };

/** A run's font, size, bold and capitals: the run, its character style, the paragraph's style, the defaults. */
function lookOf(L, r, p) {
  const rprs = [];
  const rpr = kids(r, 'w:rPr')[0]; if (rpr) rprs.push(rpr);
  for (const s of chain(L, rpr && kids(rpr, 'w:rStyle')[0]?.getAttribute('w:val'))) { const x = kids(s, 'w:rPr')[0]; if (x) rprs.push(x); }
  for (const s of chain(L, pStyleOf(L, p))) { const x = kids(s, 'w:rPr')[0]; if (x) rprs.push(x); }
  if (L.dflt) rprs.push(L.dflt);
  const pick = (fn) => { for (const x of rprs) { const v = fn(x); if (v != null) return v; } return null; };
  const fam = pick((x) => {
    const f = kids(x, 'w:rFonts')[0]; if (!f) return null;
    const th = f.getAttribute('w:asciiTheme') || f.getAttribute('w:hAnsiTheme');
    if (th) return /major/i.test(th) ? L.major : L.minor;
    return f.getAttribute('w:ascii') || f.getAttribute('w:hAnsi') || null;
  }) || 'Times New Roman';
  return {
    fam, size: Number(pick((x) => kids(x, 'w:sz')[0]?.getAttribute('w:val') ?? null) || 22) / 2,
    bold: pick((x) => onOff(kids(x, 'w:b')[0])) || false, caps: pick((x) => onOff(kids(x, 'w:caps')[0])) || false,
  };
}
let canvas;
async function widthOf(look, text) {
  const id = await face(fontFor(look.fam), look.bold);
  canvas ??= document.createElement('canvas');
  const g = canvas.getContext('2d');
  g.font = `${look.size}px ${id ? `"${id}"` : `${look.bold ? 'bold ' : ''}"Times New Roman", serif`}`;
  if ('fontKerning' in g) g.fontKerning = 'none';
  return g.measureText(look.caps ? text.toUpperCase() : text).width; // points: the size was given in px as points
}

/** A paragraph's pPr values, the paragraph's own first, then its style's. */
function pprOf(L, p) {
  const out = []; const own = kids(p, 'w:pPr')[0]; if (own) out.push(own);
  for (const s of chain(L, pStyleOf(L, p))) { const x = kids(s, 'w:pPr')[0]; if (x) out.push(x); }
  if (L.dfltP) out.push(L.dfltP);
  return out;
}
function stopsOf(L, p) {
  const list = pprOf(L, p).reverse(); const stops = new Map();
  for (const ppr of list) for (const t of kids(kids(ppr, 'w:tabs')[0], 'w:tab')) {
    const pos = Number(t.getAttribute('w:pos')) / 20; const val = t.getAttribute('w:val');
    if (val === 'clear') stops.delete(pos); else stops.set(pos, val);
  }
  return [...stops.entries()].map(([pos, val]) => ({ pos, val })).sort((a, b) => a.pos - b.pos);
}
function indentOf(L, p) {
  const ind = pprOf(L, p).map((x) => kids(x, 'w:ind')[0]).find(Boolean);
  const n = (a) => Number(ind?.getAttribute(a) ?? 0) / 20;
  return { left: n('w:left') || n('w:start'), first: n('w:firstLine') - n('w:hanging'), hanging: n('w:hanging') };
}
const alignOf = (L, p) => pprOf(L, p).map((x) => kids(x, 'w:jc')[0]?.getAttribute('w:val')).find(Boolean) ?? 'left';

/** Where a tab from x lands: the next stop after x (Word drops default stops left of a set one). */
function nextStop(L, stops, ind, x) {
  if (ind.hanging && x < ind.left - 0.01) return { pos: ind.left, val: 'left' };
  const s = stops.find((t) => t.pos > x + 0.01 && t.val !== 'bar');
  if (s) return s;
  const last = stops.length ? stops[stops.length - 1].pos : 0;
  let pos = (Math.floor(x / L.tab) + 1) * L.tab;
  while (pos <= last) pos += L.tab;
  return { pos, val: 'left' };
}

/** The line laid out: each text and tab with where it starts and ends. Null where it cannot be followed. */
async function layout(L, p, stopAt) {
  const stops = stopsOf(L, p); const ind = indentOf(L, p);
  let x = ind.left + ind.first; const items = [];
  for (const r of runsOf(p)) {
    const look = lookOf(L, r, p);
    for (const c of r.childNodes) {
      if (c.nodeName === 'w:t') { const w = await widthOf(look, c.textContent); items.push({ node: c, run: r, look, x0: x, x1: x + w, text: c.textContent }); x += w; }
      else if (c.nodeName === 'w:tab') { const s = nextStop(L, stops, ind, x); items.push({ node: c, run: r, look, x0: x, x1: s.pos, tab: s.val }); x = s.pos; }
      else if (c.nodeName === 'w:br' || c.nodeName === 'w:cr') return { items, x, broken: true };
      else if (c.nodeName === 'w:drawing' && all(c, 'wp:inline').length) { const e = all(c, 'wp:extent')[0]; x += Number(e?.getAttribute('cx') ?? 0) / 12700; }
      if (stopAt && c === stopAt) return { items, x, stops, ind };
    }
  }
  return { items, x, stops, ind };
}

/**
 * Before a yellow bit changes: where the text after its gap starts. After: the gap rebuilt to start it there again —
 * tabs to the stops before it, then spaces. Only for a line laid out left to right without a break before it.
 */
async function holdPlace(L, g) {
  const p = g.p;
  if (!/^(left|start|both|)$/.test(alignOf(L, p))) return null;
  const lastT = all(g.runs[g.runs.length - 1], 'w:t').pop(); if (!lastT) return null;
  const line = await layout(L, p);
  if (line.broken && !line.items.some((it) => it.node === lastT)) return null;
  const at = line.items.findIndex((it) => it.node === lastT); if (at < 0) return null;
  const gap = []; let anchor = null;
  for (const it of line.items.slice(at + 1)) {
    if (it.tab) { if (it.tab !== 'left') return null; gap.push(it); continue; }
    if (!it.text.trim()) { gap.push(it); continue; }
    anchor = it; break;
  }
  if (!anchor || !gap.length) {
    // Spaces inside the anchor's own text ("…2027      Date-").
    if (!anchor || !/^ {2,}/.test(anchor.text)) return null;
  }
  const lead = /^ */.exec(anchor.text)[0];
  const tabs = gap.some((it) => it.tab);
  if (!tabs && gap.reduce((n, it) => n + it.text.length, 0) + lead.length < 2) return null; // an ordinary space
  const A = anchor.x0 + (lead ? await widthOf(anchor.look, lead) : 0);
  if (A > L.width + 1) return null;
  return { p, lastT, gap, anchor, lead, A, tabs };
}
async function rebuildPlace(L, doc, h) {
  const line = await layout(L, h.p, h.lastT);
  const x0 = line.x;
  const space = await widthOf((h.gap[0] ?? h.anchor).look, ' ') || 2.5;
  const seq = [];
  let x = x0;
  if (x0 >= h.A - 0.5) seq.push(h.tabs ? 'tab' : ' ');
  else {
    if (h.tabs) for (let k = 0; k < 40; k++) { const s = nextStop(L, line.stops, line.ind, x); if (s.pos > h.A + 0.5) break; seq.push('tab'); x = s.pos; }
    const n = Math.round((h.A - x) / space);
    if (n > 0) seq.push(' '.repeat(n));
    if (!seq.length) seq.push(' ');
  }
  // The new gap goes where the old one began (its first space or tab, else just before the anchor's text), in that
  // run's own look; then the old gap goes.
  const ref = h.gap[0]?.node ?? h.anchor.node;
  for (const s of seq) {
    let n;
    if (s === 'tab') n = doc.createElementNS(W, 'w:tab');
    else { n = doc.createElementNS(W, 'w:t'); n.setAttributeNS(XS, 'xml:space', 'preserve'); n.textContent = s; }
    ref.parentNode.insertBefore(n, ref);
  }
  for (const it of h.gap) { if (it.tab) it.node.parentNode?.removeChild(it.node); else it.node.textContent = ''; }
  if (h.lead) h.anchor.node.textContent = h.anchor.node.textContent.replace(/^ +/, '');
}

/* ---------- Filling ---------- */

/**
 * Fill a template: v = { f: {key: value}, items: [{[fieldKey]: text, price}], rows: [[cells]], gst, lump }.
 * Returns the filled .docx with the yellow and Word's comments taken away.
 */
export async function fillYellow(file, Y0, v) {
  const Y = markWorked(Y0);
  const zip = await JSZip.loadAsync(file);
  const L = await looksOf(zip);
  const byKey = new Map(Y.fields.map((f) => [f.key, f]));
  const rows = (v.rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
  const items = itemsOf(Y, v.items, rows);
  const tot = totalsOf(Y, items, v.gst, v.lump);
  // The template's GST % written in its yellow ("18% GST", "GST @ 18%") follows the Tax % chosen (the user, 25 Nov).
  const was = Y.price?.gst; const now = Number(v.gst);
  const gstText = (s) => (was == null || !Number.isFinite(now) || now === Number(was) ? s : String(s)
    .replace(new RegExp(`\\b${was}(\\s*%\\s*)(?=(i|c|s)?gst\\b|tax\\b)`, 'gi'), `${now}$1`)
    // "GST @ 18%", "GST@18%", "Tax 18 %", "Tax (18%)" (the CT template's heading, 25 Nov).
    .replace(new RegExp(`(\\b(?:[ics]?gst|tax)\\s*[@:-]?\\s*\\(?\\s*)${was}(\\s*%)`, 'gi'), `$1${now}$2`));
  const value = (key) => v.f?.[key];
  for (const name of partNames(zip)) {
    const doc = parse(await zip.file(name).async('string'));
    // Terms in sections first, while the yellow still marks where they start (only plain text is touched).
    if (name === 'word/document.xml' && !Array.isArray(v.terms) && Array.isArray(v.tsec)) fillSections(doc, v.tsec, v.tsecOrig);
    const s = scan(doc);

    // The price table: the yellow row once per item, its figures worked out, the totals under it.
    if (s.price && Y.price) {
      const pt = s.price; const model = pt.rows[pt.item]; const pr = Y.price; const made = new Set();
      items.forEach((it, i) => {
        const tr = model.cloneNode(true); made.add(tr);
        kids(tr, 'w:tc').forEach((tc, k) => {
          const gs = all(tc, 'w:p').flatMap(groupsIn);
          const yr = (pr.years ?? []).indexOf(k);
          if (yr >= 0) { if (gs[0]) setGroup(gs[0], moneyLike(pr.samplePrice, it.years?.[yr])); gs.slice(1).forEach((g) => setGroup(g, '')); return; }
          if (k === pr.price) { if (gs[0]) setGroup(gs[0], moneyLike(pr.samplePrice, it.price)); gs.slice(1).forEach((g) => setGroup(g, '')); return; }
          // Serial number and worked-out columns are worked out even when yellow (a whole table marked, Carmel).
          const worked = SERIAL.test(pr.cols[k] ?? '') || colKind(pr.cols, k, pr.price);
          if (gs.length && !worked) {
            // One box for the cell's lines: line j into yellow piece j, in its own look; more lines go under the last
            // piece as copies of its paragraph, fewer leave the extra pieces' paragraphs out.
            const box = pr.fields.find((x) => x.key === `c${k}`);
            if (box?.parts) {
              const lines = String(it[box.key] ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
              const mine = box.parts.map((j) => gs[j]).filter(Boolean);
              const paraOf = (g) => { let n = g.runs[0]; while (n && n.nodeName !== 'w:p') n = n.parentNode; return n; };
              mine.forEach((g, j) => {
                if (j < lines.length) { setGroup(g, `${/^\s*/.exec(g.text)[0]}${lines[j]}${/\s*$/.exec(g.text)[0]}`); return; }
                const pa = paraOf(g);
                if (pa && norm(textOf(pa)) === norm(g.text) && all(pa.parentNode, 'w:p').length > 1) pa.parentNode.removeChild(pa); else setGroup(g, '');
              });
              let last = mine.length ? paraOf(mine[mine.length - 1]) : null;
              for (const line of lines.slice(mine.length)) {
                if (!last) break;
                const c = last.cloneNode(true); last.parentNode.insertBefore(c, last.nextSibling); setPara(doc, c, line); last = c;
              }
              gs.forEach((g, j) => {
                if (box.parts.includes(j)) return;
                const fd = pr.fields.find((x) => x.key === `c${k}g${j}`);
                if (fd?.link) setGroup(g, writeNum(g.text, value(fd.link)));
              });
              return;
            }
            gs.forEach((g, j) => {
              const fd = pr.fields.find((x) => x.key === `c${k}g${j}`);
              let val = fd?.link ? writeNum(g.text, value(fd.link)) : it[`c${k}g${j}`];
              // Qty left empty with an Annexure: its count, written as the sample was ("76 Nos").
              if (fd?.qty && !String(val ?? '').trim() && rows.length) val = `${rows.length}${/\s*nos?\.?\s*$/i.exec(fd.sample)?.[0] ?? ''}`;
              setGroup(g, `${/^\s*/.exec(g.text)[0]}${val ?? ''}${/\s*$/.exec(g.text)[0]}`);
            });
            return;
          }
          const h = pr.cols[k] ?? ''; const ps = all(tc, 'w:p'); const t = norm(textOf(tc));
          // The serial number, also under a heading that does not say so (Nahas: "S/N" over 1).
          if ((SERIAL.test(h) || k === 0) && /^\d+\.?$/.test(t)) { setPara(doc, ps.find((x) => textOf(x).trim()) ?? ps[0], String(i + 1) + (t.endsWith('.') ? '.' : '')); return; }
          // Worked-out cells of a row (GST %, GST amount, row total) where the template has figures in them.
          const line = tot.lines[i] ?? 0; const tax = Math.round(line * Number(v.gst || 0)) / 100;
          const fig = ps.find((x) => /\d/.test(textOf(x)));
          if (!fig) return;
          // A cell holding "18%" is the rate (AV Mult's GST column); a "%" column holding an amount is the GST (Tata's
          // "GST @5%" over 667, 25 Nov).
          const kind0 = colKind(pr.cols, k, pr.price);
          const kind = kind0 && /%/.test(t) ? 'rate' : kind0 === 'rate' ? 'tax' : kind0;
          if (kind === 'rate') setPara(doc, fig, `${Number(v.gst || 0)}%`);
          else if (kind) setPara(doc, fig, moneyLike(textOf(fig).trim(), kind === 'tax' ? tax : kind === 'with' ? line + tax : line));
        });
        // No Annexure rows: the line pointing to it goes (the user, 19 Nov).
        if (!rows.length && Y.list) for (const p of all(tr, 'w:p')) if (/annex/i.test(textOf(p)) && kids(p.parentNode, 'w:p').length > 1) p.parentNode.removeChild(p);
        pt.t.insertBefore(tr, model);
      });
      pt.t.removeChild(model);
      for (const tr of pt.extra) if (tr.parentNode === pt.t) pt.t.removeChild(tr);
      // The headings say the GST chosen ("GST @5%" over Tata's GST column, "Tax 18 %").
      for (const p of all(pt.rows[pt.head ?? 0], 'w:p')) { const s0 = textOf(p); const s1 = gstText(s0); if (s1 !== s0) setKeep(doc, p, s1); }
      // Totals rows: the figure in each worked out; "GST 18%" says the GST chosen. A row is named by its first cell with
      // words (Jeeva's TOTAL after an empty cell); what it holds by its name (GRAND TOTAL, Total with GST, GST @18%), else
      // by the column its figure stands under (AV Mult's TOTAL VALUE under TOTAL AMOUNT), else a total after the GST row
      // is the total with it (Jeeva's TOTAL AMOUNT, 25 Nov).
      const above = new Set(pt.rows.slice(0, pt.item)); let taxSeen = false;
      for (const tr of kids(pt.t, 'w:tr')) {
        if (above.has(tr) || made.has(tr)) continue;
        const tcs = kids(tr, 'w:tc'); if (tcs.length < 2) continue;
        const label = rowLabel(tr); const t = textOf(tr);
        if (!label || /^\d+\.?$/.test(label) || !/total|gst|tax/i.test(t)) continue;
        const at = []; let col = 0;
        for (const tc of tcs) { at.push(col); col += Number(all(tc, 'w:gridSpan')[0]?.getAttribute('w:val')) || 1; }
        const vi = tcs.map((_, i) => i).slice(1).reverse().find((i) => /\d/.test(textOf(tcs[i])));
        const under = vi != null ? colKind(pr.cols, at[vi], pr.price) : null;
        const kind = /grand|with|incl/i.test(label) ? 'with' : /gst|tax/i.test(label) ? 'tax'
          : /total|value|amount/i.test(label) ? (taxSeen || under === 'with' ? 'with' : 'total') : null;
        if (!kind) continue;
        if (kind === 'tax') taxSeen = true;
        // A price by year: under each year its own figure, under the total column the whole; written even where the
        // template left the cell empty (the Cathlab template's GST 18% and Total Contract Value rows).
        if (pr.years) {
          tcs.forEach((tc, i) => {
            if (i === 0) return;
            const j = pr.years.indexOf(at[i]);
            if (j < 0 && !colKind(pr.cols, at[i], pr.price)) return;
            const fig = j >= 0 ? tot.byYear?.[j]?.[kind] : tot[kind];
            const ps = all(tc, 'w:p'); const p0 = ps.find((q) => /\d/.test(textOf(q))) ?? ps[0];
            if (!p0 || fig == null) return;
            const text = moneyLike(textOf(p0).trim() || pr.samplePrice, fig);
            if (all(p0, 'w:t').length) setPara(doc, p0, text); else p0.appendChild(newRun(doc, p0, text));
          });
          const lc = tcs.find((c) => /[a-z]/i.test(textOf(c)));
          if (kind === 'tax' && lc) for (const x of all(lc, 'w:t')) x.textContent = x.textContent.replace(/\d+(\.\d+)?\s*%/, `${Number(v.gst || 0)}%`);
          continue;
        }
        // A totals row with a figure under each worked-out column (Carmel's GRAND TOTAL · 16,800 · 840 · 17,640): each its own.
        const figs = tcs.map((tc, i) => ({ tc, k: at[i] })).slice(1).filter((x) => /\d/.test(textOf(x.tc)) && colKind(pr.cols, x.k, pr.price));
        if (figs.length > 1 && col === pr.cols.length) {
          for (const x of figs) {
            const ck0 = colKind(pr.cols, x.k, pr.price); const ck = ck0 === 'rate' && !/%/.test(textOf(x.tc)) ? 'tax' : ck0;
            const ps = all(x.tc, 'w:p').filter((q) => /\d/.test(textOf(q)));
            if (ps[0] && ck !== 'rate') setPara(doc, ps[0], moneyLike(textOf(ps[0]).trim(), ck === 'tax' ? tot.tax : ck === 'with' ? tot.with : tot.total));
          }
          continue;
        }
        const vc = vi != null ? tcs[vi] : null;
        if (vc) { const ps = all(vc, 'w:p').filter((p) => /\d/.test(textOf(p))); if (ps[0]) setPara(doc, ps[0], moneyLike(textOf(ps[0]).trim(), tot[kind])); }
        const lc = tcs.find((c) => /[a-z]/i.test(textOf(c)));
        if (kind === 'tax' && lc) for (const x of all(lc, 'w:t')) x.textContent = x.textContent.replace(/\d+(\.\d+)?\s*%/, `${Number(v.gst || 0)}%`);
      }
    }

    // The list table (Annexure): its heading row and one row per row typed; none: the table and its title go.
    if (s.list && Y.list) {
      const lt = s.list; const trs = lt.rows; const model = trs[1] ?? null; const after = trs[trs.length - 1].nextSibling;
      const numbered = SERIAL.test(Y.list.cols[0] ?? '');
      if (rows.length) {
        const base = model ?? trs[0];
        rows.forEach((row, i) => {
          const tr = base.cloneNode(true);
          // A heading row copied (no sample row in the template): it does not repeat as a heading on the next page.
          if (!model) for (const x of all(tr, 'w:tblHeader')) x.parentNode.removeChild(x);
          kids(tr, 'w:tc').forEach((tc, k) => {
            const [p, ...more] = kids(tc, 'w:p'); for (const x of more) tc.removeChild(x);
            for (const br of all(p, 'w:br')) br.parentNode.removeChild(br);
            if (!model) for (const b of [...all(p, 'w:b'), ...all(p, 'w:bCs')]) b.parentNode.removeChild(b);
            setPara(doc, p, numbered && k === 0 ? String(i + 1) : String(row[k] ?? ''));
          });
          lt.t.insertBefore(tr, after);
        });
        for (const tr of trs.slice(1)) lt.t.removeChild(tr);
        // A total under the rows (Aswini's TOTAL QTY 54, 25 Nov): its column added up from the rows written.
        for (let tr = after; tr; tr = tr.nextSibling) {
          if (tr.nodeName !== 'w:tr' || !kids(tr, 'w:tc').some((c) => /^\s*total\b/i.test(textOf(c)))) continue;
          let col = 0;
          for (const tc of kids(tr, 'w:tc')) {
            const k = col; col += Number(all(tc, 'w:gridSpan')[0]?.getAttribute('w:val')) || 1;
            const fig = kids(tc, 'w:p').find((p) => textOf(p).trim() && /^\s*[\d,]+(\.\d+)?\s*$/.test(textOf(p)));
            const nums = rows.map((r) => String(r[k] ?? '').replace(/,/g, '').trim()).filter((x) => /^\d+(\.\d+)?$/.test(x));
            if (fig && nums.length) setPara(doc, fig, String(nums.reduce((a, x) => a + Number(x), 0)));
          }
        }
      } else {
        // The title above it ("Annexure- 1") and a page break before that go with it.
        let el = lt.t.previousSibling;
        for (let k = 0; el && k < 4; k++) {
          const prev = el.previousSibling;
          if (el.nodeName === 'w:p') {
            const t = norm(textOf(el));
            const brk = all(el, 'w:br').some((b) => b.getAttribute('w:type') === 'page') || all(el, 'w:pageBreakBefore').length > 0;
            if (/annex/i.test(t) || (!t && brk)) { el.parentNode.removeChild(el); if (brk) break; } else if (t) break;
          }
          el = prev;
        }
        // A summary under the list keeps the table (SUB CAMC's TOTAL ASSET VALUE); only the list's rows go. A list with
        // nothing under it but its own total (Aswini's TOTAL QTY) goes whole.
        const rest = []; for (let tr = after; tr; tr = tr.nextSibling) if (tr.nodeName === 'w:tr') rest.push(tr);
        const sumOnly = rest.every((tr) => kids(tr, 'w:tc').length === lt.cells && kids(tr, 'w:tc').some((c) => /^\s*total\b/i.test(textOf(c))));
        if (lt.tail && !sumOnly) for (const tr of trs) lt.t.removeChild(tr); else lt.t.parentNode.removeChild(lt.t);
      }
    }

    // The boxes: where what follows on the line must stay, measured first; then the text; then the gaps rebuilt.
    const jobs = [];
    for (const it of s.items) {
      if (it.type === 'block') {
        // A signer written twice under different headings is one box (Shri Balaji): found by its lines.
        const b = it.block; const f = byKey.get(blockKey(b)) ?? Y.fields.find((x) => x.kind === 'signer' && x.sample === blockLines(b)); if (!f) continue;
        let lines = String(value(f.key) ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        // Figures worked out in their own lines, the typed ones in the others, in the template's order.
        if (f.kind === 'fixed') lines = lines.map(gstText);
        // The label cell beside each worked-out figure ("18% GST") says the GST chosen, yellow or not.
        if (f.wlines) for (const p of b.slots) { const tc = up(p, 'w:tc'); const tr = tc && up(tc, 'w:tr'); const first = tr && kids(tr, 'w:tc')[0]; if (first && first !== tc) for (const q of kids(first, 'w:p')) { const s0 = textOf(q); const s1 = gstText(s0); if (s1 !== s0) setKeep(doc, q, s1); } }
        if (f.wlines) { const typed = [...lines]; const ss = f.sample.split('\n'); lines = f.wlines.map((w, i) => (w ? moneyLike(ss[i].trim(), tot[w]) : typed.shift() ?? '')); }
        // The address box no longer holds the template's own "TO," line: put back above the customer.
        const lead = f.sample.split('\n')[0];
        if (f.role === 'to' && TO_LINE.test(lead) && !TO_LINE.test(lines[0] ?? '')) lines.unshift(lead.trim());
        const whole = b.slots.every((p) => norm(textOf(p)) === norm(groupsIn(p)[0]?.text));
        if (whole) {
          b.slots.forEach((p, i) => {
            if (i < lines.length) setPara(doc, p, lines[i]);
            else if (b.table) setPara(doc, p, '');
            else p.parentNode.removeChild(p);
          });
          let last = b.slots[Math.min(lines.length, b.slots.length) - 1] ?? b.slots[0];
          for (const line of lines.slice(b.slots.length)) { const p = last.cloneNode(true); last.parentNode.insertBefore(p, last.nextSibling); setPara(doc, p, line); last = p; }
        } else {
          // Lines sharing the line with something else (CLIENT ⇥ FIRST PARTY): only the yellow part changes; more lines
          // than places go on the last one.
          const fit = lines.length > b.slots.length ? [...lines.slice(0, b.slots.length - 1), lines.slice(b.slots.length - 1).join(', ')] : lines;
          for (const [i, p] of b.slots.entries()) {
            const g = groupsIn(p)[0]; if (!g) continue;
            jobs.push({ g, text: fit[i] ?? '' });
          }
        }
        continue;
      }
      const { g } = it; const { key, kind } = keyOf(g.text); const f = byKey.get(key); if (!f) continue;
      const val = value(key);
      let text;
      if (f.kind === 'fixed') text = gstText(g.text.trim());
      else if (kind === 'num') text = writeNum(g.text, val);
      else if (kind === 'date') { const t = g.text.trim(); const ld = leadOf(t); text = ld + dateLike(t.slice(ld.length).trim(), val); }
      else if (kind === 'period') { const t = norm(g.text); const ld = leadOf(t); const m = PERIOD.exec(t.slice(ld.length)); text = `${ld}${dateLike(m[1], val?.from)} ${m[2]} ${dateLike(m[3], val?.upto)}`; }
      else if (kind === 'words') text = wordsLike(g.text, tot.with);
      else if (f.role === 'toline') {
        // The customer again at the signing (Nahas): To's line, in capitals where the template wrote it so.
        const to = Y.fields.find((x) => x.role === 'to');
        const ls = clientFrom(String(value(to?.key) ?? '')).split('\n').map((x) => x.trim()).filter((x) => x && !TO_LINE.test(x));
        const one = f.line === -1 ? (ls.length > 1 ? ls[ls.length - 1] : '') : (ls[f.line] ?? '');
        const s0 = g.text.trim();
        text = /[A-Z]/.test(s0) && s0 === s0.toUpperCase() ? one.toUpperCase() : one;
      }
      else if (f.worked) text = moneyLike(g.text.trim(), tot[f.worked]);
      else if (REF_LEAD.test(g.text) && !REF_LEAD.test(String(val ?? ''))) text = REF_LEAD.exec(g.text.trim())[0] + String(val ?? '');
      else text = String(val ?? '');
      jobs.push({ g, text: `${/^\s*/.exec(g.text)[0]}${text}${/\s*$/.exec(g.text)[0]}` });
    }
    const holds = [];
    for (const j of jobs) holds.push(await holdPlace(L, j.g).catch(() => null));
    jobs.forEach((j) => setGroup(j.g, j.text));
    for (const h of holds) if (h) await rebuildPlace(L, doc, h).catch(() => {});
    if (name === 'word/document.xml' && Array.isArray(v.terms)) fillTerms(doc, v.terms, v.termsOrig);
    // The yellow and Word's comments taken away.
    for (const h of all(doc, 'w:highlight')) if (h.getAttribute('w:val') === 'yellow') h.parentNode.removeChild(h);
    for (const x of all(doc, 'w:shd')) if (/^ffff00$/i.test(x.getAttribute('w:fill') ?? '') && x.parentNode.nodeName === 'w:rPr') x.parentNode.removeChild(x);
    for (const tag of ['w:commentRangeStart', 'w:commentRangeEnd']) for (const c of all(doc, tag)) c.parentNode.removeChild(c);
    for (const c of all(doc, 'w:commentReference')) { const r = c.parentNode; r.parentNode?.removeChild(r); }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  return zip.generateAsync({ type: 'blob', mimeType: DOCX, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
