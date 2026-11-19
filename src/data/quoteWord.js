/*
  A quotation in the customer's own Word file (the user, 19 Nov: "is there any option to edit on same word, bcz if
  anything changes customer will make problem"). The uploaded template .docx is copied and only its blanks change:
  Ref, date, To, place, subject, contract period, the rows of its price table, the totals and the amount in words.
  Fonts, letterhead, bold, spacing and everything else stay exactly as typed in Word.
*/
import JSZip from 'jszip';
import { layoutTotals, findItemsTable, REF, DATE } from './quoteLayout.js';
import { inWords } from './quoteMake.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XS = 'http://www.w3.org/XML/1998/namespace';
const kids = (el, name) => [...(el?.childNodes ?? [])].filter((n) => n.nodeName === name);
const all = (el, name) => [...el.getElementsByTagName(name)];
const textOf = (el) => all(el, 'w:t').map((t) => t.textContent).join('');
const num = (s) => Number(String(s ?? '').replace(/[^0-9.]/g, '')) || 0;

/** Put a text in the w:t nodes of one paragraph: the first keeps it (and its formatting), the rest are emptied. */
function setPara(doc, p, text) {
  const ts = all(p, 'w:t');
  if (!ts.length) {
    const r = doc.createElementNS(W, 'w:r'); const t = doc.createElementNS(W, 'w:t');
    const ppr = kids(p, 'w:pPr')[0]; const rpr = ppr && kids(ppr, 'w:rPr')[0];
    if (rpr) r.appendChild(rpr.cloneNode(true));
    t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = text; r.appendChild(t); p.appendChild(r);
    return;
  }
  ts.forEach((t, i) => { t.textContent = i === 0 ? text : ''; if (i === 0) t.setAttributeNS(XS, 'xml:space', 'preserve'); });
}

/** A cell's lines, one paragraph each; a cell with more lines than paragraphs repeats the last paragraph's look. */
function setCell(doc, tc, text) {
  const lines = String(text ?? '').split('\n');
  const ps = kids(tc, 'w:p');
  lines.forEach((line, k) => {
    let p = ps[k];
    if (!p) { p = ps[ps.length - 1].cloneNode(true); tc.appendChild(p); ps.push(p); }
    setPara(doc, p, line);
  });
  for (const p of ps.slice(lines.length)) tc.removeChild(p);
}

/** Replace every whole `from` in a paragraph, even when Word split it over several runs. */
function replaceIn(p, from, to) {
  if (!from) return false;
  let changed = false;
  for (let guard = 0; guard < 20; guard++) {
    const ts = all(p, 'w:t'); const full = ts.map((t) => t.textContent).join('');
    const at = full.indexOf(from); if (at < 0) break;
    let pos = 0; let done = false;
    for (const t of ts) {
      const s = t.textContent; const a = pos; const b = pos + s.length; pos = b;
      if (b <= at || a >= at + from.length) continue;
      const lo = Math.max(at, a) - a; const hi = Math.min(at + from.length, b) - a;
      t.textContent = s.slice(0, lo) + (done ? '' : to) + s.slice(hi);
      t.setAttributeNS(XS, 'xml:space', 'preserve');
      done = true;
    }
    changed = true;
    if (to.includes(from)) break;
  }
  return changed;
}

/** How wide a text is in a paragraph's own font, in points (a canvas measure; Word lays out the same font). */
let canvas;
function widthIn(p, text) {
  const r = all(p, 'w:t').find((t) => t.textContent.trim())?.parentNode;
  const rpr = r && kids(r, 'w:rPr')[0];
  const fam = (rpr && kids(rpr, 'w:rFonts')[0]?.getAttribute('w:ascii')) || 'Times New Roman';
  const size = Number((rpr && kids(rpr, 'w:sz')[0]?.getAttribute('w:val')) || 22) / 2;
  canvas ??= document.createElement('canvas');
  const g = canvas.getContext('2d'); g.font = `${size}pt "${fam}", "Times New Roman", serif`;
  return g.measureText(text).width;
}

/** Replace `from` with `to` and add or take away spaces after it, so what follows on the line does not move. */
function keepPlace(p, from, to) {
  const full = textOf(p); const at = full.indexOf(from);
  const gap = /^ */.exec(full.slice(at + from.length))[0].length;
  const space = widthIn(p, ' ') || 1;
  const n = Math.round((widthIn(p, from) - widthIn(p, to)) / space);
  if (n >= 0) replaceIn(p, from, to + ' '.repeat(n));
  else replaceIn(p, from + ' '.repeat(Math.min(gap, -n)), to + (gap + n < 1 && gap > 0 ? ' ' : ''));
}

/** A figure written as the sample wrote it: "1,25,000.00", "1,47,500/-", "Rs. 22,500". */
function asSample(sample, value) {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(sample ?? '');
  const dec = m && /\.\d{2}$/.test(m[0]);
  const v = Number(value || 0).toLocaleString('en-IN', dec ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 });
  return m ? sample.slice(0, m.index) + v + sample.slice(m.index + m[0].length) : v;
}

/** A date written as the sample wrote it: 02/11/2026, 02.11.2026, 02-11-2026. */
function dateLike(sample, iso) {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-');
  const sep = /[./-]/.exec(sample ?? '')?.[0] ?? '.';
  const yy = /\d{1,2}[./-]\d{1,2}[./-](\d{2})$/.test(sample ?? '') ? y.slice(2) : y;
  return [d, mo, yy].join(sep);
}

/**
  q: the quotation (as LayoutMaker keeps it). Returns the filled .docx as a Blob.
*/
export async function fillWord(file, layout, q) {
  const zip = await JSZip.loadAsync(file);
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  const S = { ...(layout.sample ?? {}) };
  // Ref and date as the file has them, wherever they are (Sub AMC keeps them in the header).
  if (!S.ref || !S.date) {
    for (const name of parts) {
      const d = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
      for (const p of all(d, 'w:p')) {
        const s = textOf(p);
        if (!S.ref) S.ref = REF.exec(s)?.[1]?.trim();
        if (!S.date) S.date = DATE.exec(s)?.[1];
      }
    }
  }
  const it = layout.items;
  const t = layoutTotals(q.items, layout, q.gst, q.lump);
  const swaps = [
    [S.ref, q.qtn_no ?? ''], [S.date, dateLike(S.date, q.date)], [S.from, dateLike(S.from, q.from)], [S.upto, dateLike(S.upto, q.upto)],
    [S.to, q.to], [S.place, q.place], [S.subject, q.subject],
  ].filter(([a, b]) => a && b != null && b !== '' && a !== b)
    // The address typed as lines replaces the lines under "TO," (below), so To and place are not swapped one by one.
    .filter(([a]) => !q.address || (a !== S.to && a !== S.place));

  for (const name of parts) {
    const doc = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
    // The price table: its rows become the quotation's rows, its totals the new totals.
    if (name === 'word/document.xml' && it) {
      const tbl = findItemsTable([...doc.getElementsByTagName('w:tbl')].map((x) => kids(x, 'w:tr').map((tr) => kids(tr, 'w:tc').map((tc) => textOf(tc)))));
      const el = tbl >= 0 ? doc.getElementsByTagName('w:tbl')[tbl] : null;
      if (el) {
        const trs = kids(el, 'w:tr'); const width = kids(trs[0], 'w:tc').length;
        const isTot = (tr) => /^\s*(grand\s+)?total\b|gst/i.test(kids(tr, 'w:tc').map(textOf).join(' ')) || kids(tr, 'w:tc').length < width;
        const data = trs.slice(1).filter((tr) => kids(tr, 'w:tc').length >= width && !isTot(tr));
        const model = data[0];
        if (model) {
          const c0 = it.idx ? 1 : 0; const pi = c0 + it.cols.length; const rate = Number(q.gst) || 0;
          const priceSample = textOf(kids(model, 'w:tc')[pi]);
          (q.items ?? []).forEach((x, n) => {
            const tr = model.cloneNode(true); const tcs = kids(tr, 'w:tc');
            if (it.idx) setCell(doc, tcs[0], String(n + 1));
            it.cols.forEach((_, k) => setCell(doc, tcs[c0 + k], x.cells?.[k] ?? ''));
            const line = t.lines[n]; const tax = Math.round((line * rate) / 100);
            if (tcs[pi]) setCell(doc, tcs[pi], asSample(priceSample, line));
            (it.calc ?? []).forEach((c, k) => {
              const tc = tcs[pi + 1 + k]; if (!tc) return;
              const s = textOf(tc);
              setCell(doc, tc, c.kind === 'rate' ? `${rate}%` : c.kind === 'tax' ? asSample(s, tax) : c.kind === 'with' ? asSample(s, line + tax) : s);
            });
            el.insertBefore(tr, model);
          });
          for (const tr of data) el.removeChild(tr);
          // Totals rows: the figure in the last cell holding one; "GST 18%" follows the quotation's rate.
          const tots = kids(el, 'w:tr').filter((tr) => kids(tr, 'w:tc').length < width && /total|gst/i.test(kids(tr, 'w:tc').map(textOf).join(' ')));
          const hasGrand = (it.totals ?? []).some((z) => z.kind === 'grand');
          tots.forEach((tr, i) => {
            const kind = it.totals?.[i]?.kind ?? 'total';
            const v = kind === 'gst' ? t.tax : kind === 'grand' ? t.with : hasGrand ? t.total : t.with;
            const tcs = kids(tr, 'w:tc'); const cell = [...tcs].reverse().find((tc) => /\d/.test(textOf(tc)) && !/total|gst/i.test(textOf(tc)));
            if (cell) for (const p of kids(cell, 'w:p')) { const s = textOf(p); if (/\d/.test(s)) { setPara(doc, p, asSample(s, v)); break; } }
            for (const p of all(tr, 'w:p')) { const s = textOf(p); const m = /gst\s*@?\s*(\d+(?:\.\d+)?)\s*%/i.exec(s); if (m && Number(m[1]) !== rate) replaceIn(p, `${m[1]}%`, `${rate}%`); }
          });
        }
      }
    }
    // "TO," and the lines under it up to the subject: the quotation's address, one line each, as many as typed
    // (the user, 19 Nov: "in some quotation dr name or customer name is there").
    if (name === 'word/document.xml' && q.address) {
      const ps = all(doc, 'w:p'); const ti = ps.findIndex((p) => /^\s*to\s*,?\s*$/i.test(textOf(p)));
      if (ti >= 0) {
        const old = [];
        for (let i = ti + 1; i < ps.length && old.length < 8; i++) {
          const t = textOf(ps[i]).trim();
          if (!t || /^\s*sub(ject)?\b/i.test(t) || /^(dear|respected|sir)/i.test(t)) break;
          old.push(ps[i]);
        }
        const lines = q.address.split('\n').map((x) => x.trim()).filter(Boolean);
        if (old.length && lines.length) {
          lines.forEach((line, k) => {
            let p = old[k];
            if (!p) { p = old[old.length - 1].cloneNode(true); old[old.length - 1].parentNode.insertBefore(p, old[old.length - 1].nextSibling); old.push(p); }
            setPara(doc, p, line);
          });
          for (const p of old.slice(lines.length)) p.parentNode.removeChild(p);
        }
      }
    }
    for (const p of all(doc, 'w:p')) {
      // The Ref first, with the spaces after it made up so "Date-" stays where it was (the user, 19 Nov: "Date positioning").
      if (S.ref && q.qtn_no && S.ref !== q.qtn_no && textOf(p).includes(S.ref)) keepPlace(p, S.ref, q.qtn_no);
      for (const [a, b] of swaps) if (a !== S.ref) replaceIn(p, a, b);
      const s = textOf(p); const w = /Rupees\s[A-Za-z\s-]+?Only/i.exec(s);
      if (w) replaceIn(p, w[0], inWords(t.with));
    }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
