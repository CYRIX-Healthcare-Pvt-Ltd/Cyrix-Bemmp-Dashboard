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
const QTY_HEAD = /\bqty\b|quantity|\bnos?\b|units?/i;

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
      const heads = kids(rows[0], 'w:tc').map((c) => norm(textOf(c)));
      return kids(rows[yrow], 'w:tc').some((tc, k) => PRICE_HEAD.test(heads[k] ?? '') && !/%/.test(heads[k] ?? '')
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
      price = { t, rows, item: yrow, extra }; continue;
    }
    const head = rows[0];
    const cells = head ? kids(head, 'w:tc') : [];
    const runs = head ? all(head, 'w:r').filter((r) => textOf(r).trim()) : [];
    if (!list && cells.length >= 2 && runs.length && runs.every(isYellow)) list = { t, rows };
  }
  return { price, list };
}

/** What the price table holds: its columns, the item row's yellow, which column is the price and which the quantity. */
function priceOf(pt) {
  const head = kids(pt.rows[0], 'w:tc').map((c) => norm(textOf(c)));
  const cells = kids(pt.rows[pt.item], 'w:tc').map((tc, k) => ({ k, head: head[k] ?? '', groups: all(tc, 'w:p').flatMap(groupsIn).map((g, j) => ({ j, text: g.text })) }));
  const numeric = (c) => c.groups.length === 1 && /^[\s₹]*(rs\.?|inr)?\s*[\d,]+(\.\d+)?\s*(\/-)?\s*$/i.test(c.groups[0].text);
  let pk = cells.filter((c) => numeric(c) && PRICE_HEAD.test(c.head)).map((c) => c.k)[0];
  if (pk == null) pk = cells.filter(numeric).map((c) => c.k).pop();
  const qk = cells.find((c) => c.k !== pk && c.groups.length && QTY_HEAD.test(c.head) && !SERIAL.test(c.head))?.k ?? null; // "SI No" is not a Qty
  const fields = [];
  for (const c of cells) {
    if (c.k === pk || !c.groups.length) continue;
    // A whole table marked yellow (Carmel, the user, 19 Nov): its serial number and the columns worked out from the
    // price (Total Price, GST %, Tax Amount, Total with Taxes) are not boxes to type.
    if (SERIAL.test(c.head) || colKind(head, c.k, pk)) continue;
    c.groups.forEach((g, j) => fields.push({
      key: `c${c.k}g${j}`, label: c.groups.length > 1 ? `${c.head || 'Item'} · line ${j + 1}` : c.head || 'Item', sample: norm(g.text), qty: c.k === qk,
    }));
  }
  // The template's own figures: GST % from "GST 18%", and whether its price was for the whole row (76 Nos, 1,25,000 total).
  // GST from the item row's own GST % cell (Carmel's 5%), else from a "GST 18%" row under it.
  const rateCell = cells.find((c) => /%/.test(c.head) && c.k > (pk ?? 99));
  const rc = rateCell ? kids(pt.rows[pt.item], 'w:tc')[rateCell.k] : null;
  const rowRate = rc ? /(\d+(\.\d+)?)\s*%/.exec(textOf(rc)) : null;
  let gst = rowRate ? Number(rowRate[1]) : 18; let total = null;
  for (const tr of pt.rows.slice(pt.item + 1)) {
    const tcs = kids(tr, 'w:tc'); const label = norm(textOf(tcs[0] ?? tr));
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
  return { cols: head, price: pk ?? null, priceHead: head[pk] ?? 'Amount', samplePrice: pk != null ? cells[pk].groups[0].text : '', qty: qk, fields, gst,
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
const labelBefore = (before) => (chunks(before).pop() ?? '').split(' ').slice(-4).join(' ').replace(/^[^a-z0-9]+/i, '');
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
    if (list && tbl === list.t) return true;
    // The price table's headings, item row and totals are its own: yellow there (Carmel, all yellow) makes no box. Other
    // rows of it keep their boxes (Giri Pushp's "Contract Period: 03/11/2026 to 02/11/2027").
    if (price && tbl === price.t) {
      const tr = up(p, 'w:tr');
      if (tr === price.rows[0] || tr === price.rows[price.item] || price.extra.includes(tr)) return true;
      if (/total|gst|tax/i.test(textOf(kids(tr, 'w:tc')[0] ?? tr))) return true;
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

/** Read a template: its boxes, the price table and the list table. Nothing yellow: `fields` empty. */
export async function readYellow(file) {
  const zip = await JSZip.loadAsync(file);
  const fields = []; let price = null; let list = null; const plain = [];
  const byKey = new Map();
  for (const name of partNames(zip)) {
    const doc = parse(await zip.file(name).async('string'));
    // The plain text, with no yellow, for Gemini to spot what changes but was not coloured (quoteAi.js).
    if (/document\.xml$/.test(name)) for (const p of all(doc, 'w:p')) { const t = norm(textOf(p)); if (t && !groupsIn(p).length) plain.push(t); }
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
        const signer = /regards|yours|sincerely|faithfully|truly/i.test(b.heading);
        const lines = b.slots.map((p) => norm(groupsIn(p)[0]?.text));
        const f = { key, kind: signer ? 'signer' : 'lines', label: signer ? 'Signed by' : nameOf(b.heading) || 'Address', sample: lines.join('\n'), lines: lines.length, places: 1 };
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
      if (!label && it.heading && !/^\s*(signature|seal|sign)\b/i.test(it.heading)) label = nameOf(it.heading);
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
  rolesOf(fields);
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

export function rolesOf(fields) {
  for (const f of fields) delete f.role;
  const ref = fields.find((f) => f.kind === 'text' && (/\b(ref|qtn|quotation\s*no)/i.test(f.label) || /^qtn/i.test(f.sample)));
  if (ref) ref.role = 'ref';
  const date = fields.find((f) => f.kind === 'date' && /date/i.test(f.label)) ?? fields.find((f) => f.kind === 'date');
  if (date) date.role = 'date';
  // The customer's address: named To or Address, or a whole yellow block starting "TO," (SUB AMC, the user, 19 Nov).
  const to = fields.find((f) => (f.kind === 'lines' || f.kind === 'text') && /^to\b/i.test(f.label))
    ?? fields.find((f) => f.kind === 'lines' && (/^address\b/i.test(f.label) || TO_LINE.test(f.sample.split('\n')[0])));
  if (to) to.role = 'to';
  const client = fields.find((f) => (f.kind === 'lines' || f.kind === 'text') && f !== to && /client|customer|second party|hospital/i.test(f.label));
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
  if (f.role === 'client') return ctx.hospital ? clientFrom(ctx.hospital) : '';
  if (f.kind === 'signer') return ctx.signer ?? '';
  if (f.kind === 'period') return { from: '', upto: '' };
  // Not a box (Gemini, quoteAi.js): the template's own text stays.
  if (f.kind === 'fixed') return f.sample;
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
  const list = (items ?? []).length ? items : [{}];
  return list.map((it) => (qf && n && !String(it[qf.key] ?? '').trim() ? { ...it, [qf.key]: `${n}${/\s*nos?\.?\s*$/i.exec(qf.sample)?.[0] ?? ''}` } : it));
}

/*
  A worked-out column of the price table by its heading: 'rate' (GST %), 'tax' (GST amount), 'line' (the row before tax)
  or 'with' (with tax). A Total or Amount column with a tax column after it is before tax (Carmel: Total Price · GST % ·
  Tax Amount · Total with Taxes); one with none after it is with tax (Sub AMC: RATE · GST % · GST RATE · TOTAL).
*/
function colKind(cols, k, price) {
  if (price == null || k <= price) return null;
  const h = cols[k] ?? '';
  if (/%/.test(h)) return 'rate';
  if (/with|incl|gross|grand/i.test(h)) return 'with';
  if (/gst|tax/i.test(h)) return 'tax';
  if (/total|amount|value/i.test(h)) return cols.slice(k + 1).some((c) => /gst|tax/i.test(c) && !/%/.test(c) && !/with|incl/i.test(c)) ? 'line' : 'with';
  return null;
}

/** The figures of the price table: per item, the total, the GST and the grand total. */
export function totalsOf(Y, items, gst, lump) {
  const pr = Y.price; if (!pr) return { lines: [], total: 0, tax: 0, with: 0 };
  const qkey = pr.fields.find((f) => f.qty)?.key;
  const lines = (items ?? []).map((it) => { const p = numIn(it.price); return lump || !qkey ? p : p * (numIn(it[qkey]) || 1); });
  const total = Math.round(lines.reduce((a, b) => a + b, 0) * 100) / 100;
  const tax = Math.round(total * Number(gst || 0)) / 100;
  return { lines, total, tax, with: Math.round((total + tax) * 100) / 100 };
}

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
export async function fillYellow(file, Y, v) {
  const zip = await JSZip.loadAsync(file);
  const L = await looksOf(zip);
  const byKey = new Map(Y.fields.map((f) => [f.key, f]));
  const rows = (v.rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
  const items = itemsOf(Y, v.items, rows);
  const tot = totalsOf(Y, items, v.gst, v.lump);
  const value = (key) => v.f?.[key];
  for (const name of partNames(zip)) {
    const doc = parse(await zip.file(name).async('string'));
    const s = scan(doc);

    // The price table: the yellow row once per item, its figures worked out, the totals under it.
    if (s.price && Y.price) {
      const pt = s.price; const model = pt.rows[pt.item]; const pr = Y.price;
      items.forEach((it, i) => {
        const tr = model.cloneNode(true);
        kids(tr, 'w:tc').forEach((tc, k) => {
          const gs = all(tc, 'w:p').flatMap(groupsIn);
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
          if (SERIAL.test(h) && /^\d+\.?$/.test(t)) { setPara(doc, ps.find((x) => textOf(x).trim()) ?? ps[0], String(i + 1) + (t.endsWith('.') ? '.' : '')); return; }
          // Worked-out cells of a row (GST %, GST amount, row total) where the template has figures in them.
          const line = tot.lines[i] ?? 0; const tax = Math.round(line * Number(v.gst || 0)) / 100;
          const fig = ps.find((x) => /\d/.test(textOf(x)));
          if (!fig) return;
          const kind = colKind(pr.cols, k, pr.price);
          if (kind === 'rate' && /%/.test(t)) setPara(doc, fig, `${Number(v.gst || 0)}%`);
          else if (kind) setPara(doc, fig, moneyLike(textOf(fig).trim(), kind === 'tax' ? tax : kind === 'with' ? line + tax : line));
        });
        // No Annexure rows: the line pointing to it goes (the user, 19 Nov).
        if (!rows.length && Y.list) for (const p of all(tr, 'w:p')) if (/annex/i.test(textOf(p)) && kids(p.parentNode, 'w:p').length > 1) p.parentNode.removeChild(p);
        pt.t.insertBefore(tr, model);
      });
      pt.t.removeChild(model);
      for (const tr of pt.extra) if (tr.parentNode === pt.t) pt.t.removeChild(tr);
      // Totals rows: the figure in each worked out; "GST 18%" says the GST chosen.
      for (const tr of kids(pt.t, 'w:tr')) {
        const tcs = kids(tr, 'w:tc'); if (tcs.length < 2) continue;
        const label = norm(textOf(tcs[0])); const t = textOf(tr);
        if (/^\d+\.?$/.test(label) || !/total|gst|tax/i.test(t)) continue;
        const kind = /grand/i.test(t) ? 'with' : /gst|tax|igst|cgst|sgst/i.test(label) ? 'tax' : /total/i.test(label) ? 'total' : null;
        if (!kind) continue;
        // A totals row with a figure under each worked-out column (Carmel's GRAND TOTAL · 16,800 · 840 · 17,640): each its own.
        const at = []; let col = 0;
        for (const tc of tcs) { at.push(col); col += Number(all(tc, 'w:gridSpan')[0]?.getAttribute('w:val')) || 1; }
        const figs = tcs.map((tc, i) => ({ tc, k: at[i] })).slice(1).filter((x) => /\d/.test(textOf(x.tc)) && colKind(pr.cols, x.k, pr.price));
        if (figs.length > 1 && col === pr.cols.length) {
          for (const x of figs) {
            const ck = colKind(pr.cols, x.k, pr.price); const ps = all(x.tc, 'w:p').filter((q) => /\d/.test(textOf(q)));
            if (ps[0] && ck !== 'rate') setPara(doc, ps[0], moneyLike(textOf(ps[0]).trim(), ck === 'tax' ? tot.tax : ck === 'with' ? tot.with : tot.total));
          }
          continue;
        }
        const vc = [...tcs].slice(1).reverse().find((c) => /\d/.test(textOf(c)));
        if (vc) { const ps = all(vc, 'w:p').filter((p) => /\d/.test(textOf(p))); if (ps[0]) setPara(doc, ps[0], moneyLike(textOf(ps[0]).trim(), tot[kind])); }
        if (kind === 'tax') for (const x of all(tcs[0], 'w:t')) x.textContent = x.textContent.replace(/\d+(\.\d+)?\s*%/, `${Number(v.gst || 0)}%`);
      }
    }

    // The list table (Annexure): its heading row and one row per row typed; none: the table and its title go.
    if (s.list && Y.list) {
      const lt = s.list; const trs = lt.rows; const model = trs[1] ?? null;
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
          lt.t.appendChild(tr);
        });
        for (const tr of trs.slice(1)) lt.t.removeChild(tr);
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
        lt.t.parentNode.removeChild(lt.t);
      }
    }

    // The boxes: where what follows on the line must stay, measured first; then the text; then the gaps rebuilt.
    const jobs = [];
    for (const it of s.items) {
      if (it.type === 'block') {
        const b = it.block; const f = byKey.get(blockKey(b)); if (!f) continue;
        const lines = String(value(f.key) ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
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
      if (f.kind === 'fixed') text = g.text.trim();
      else if (kind === 'num') text = writeNum(g.text, val);
      else if (kind === 'date') { const t = g.text.trim(); const ld = leadOf(t); text = ld + dateLike(t.slice(ld.length).trim(), val); }
      else if (kind === 'period') { const t = norm(g.text); const ld = leadOf(t); const m = PERIOD.exec(t.slice(ld.length)); text = `${ld}${dateLike(m[1], val?.from)} ${m[2]} ${dateLike(m[3], val?.upto)}`; }
      else if (kind === 'words') text = wordsLike(g.text, tot.with);
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
