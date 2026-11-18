/*
  A Word quotation turned into the app's own (the user, 18 Nov: "need apps own quotation pdf editor like now suhail has,
  for each upload, we need to save that quot letterhead, layouts etc"). The Word file is read once: its letterhead
  (header and footer pictures where Word puts them), its letter, its machine table's columns and totals, its other
  tables, pictures (seal, signature) and terms. What was filled in the sample (hospital, place, date, ref, contract period,
  amounts) becomes a blank the quotation fills: {to} {place} {date} {ref} {subject} {from} {upto} {total} {gst} {grand}
  {words} {rate}. Then makeLayoutPdf draws a quotation in that layout.
*/
import { jsPDF } from 'jspdf';
import { inWords, fmt } from './quoteMake.js';
import { embedFonts, fontFor } from './pdfFonts.js';

const EMU = 36000; // per mm
const TW = 56.6929; // twips per mm
const num = (n) => Number(n) || 0;
const r2 = (n) => Math.round(num(n) * 100) / 100;
const kids = (el, name) => [...(el?.childNodes ?? [])].filter((n) => n.nodeName === name);
const kid = (el, name) => kids(el, name)[0] ?? null;
const attr = (el, a) => el?.getAttribute?.(a) ?? null;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (s) => s.replace(/ /g, ' ').replace(/[ \t]+$/g, '');

/* ------------------------------------------------------------------ reading -- */

/** Read a .docx into a layout. Pictures come back as { key, blob } to be stored; the layout names them by key. */
export async function readLayout(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const xml = async (p) => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const relsOf = async (part) => {
    const d = await xml(part.replace(/([^/]+)$/, '_rels/$1.rels'));
    const m = {};
    for (const r of d?.getElementsByTagName('Relationship') ?? []) m[attr(r, 'Id')] = attr(r, 'Target');
    return m;
  };
  const doc = await xml('word/document.xml');
  if (!doc) throw new Error('This Word file could not be read.');
  const body = doc.getElementsByTagName('w:body')[0];
  const docRels = await relsOf('word/document.xml');

  // Page size and margins from the first section.
  const sect = doc.getElementsByTagName('w:sectPr')[0];
  const sz = sect?.getElementsByTagName('w:pgSz')[0]; const mar = sect?.getElementsByTagName('w:pgMar')[0];
  const tw = (el, a, d) => (attr(el, a) != null ? num(attr(el, a)) / TW : d);
  const page = { w: r2(tw(sz, 'w:w', 210)), h: r2(tw(sz, 'w:h', 297)), ml: r2(tw(mar, 'w:left', 20)), mr: r2(tw(mar, 'w:right', 15)),
    mt: r2(tw(mar, 'w:top', 25)), mb: r2(tw(mar, 'w:bottom', 20)), hd: r2(tw(mar, 'w:header', 12.7)), fd: r2(tw(mar, 'w:footer', 12.7)) };

  // Word's own defaults: font size, space after a paragraph, line spacing.
  const styles = await xml('word/styles.xml');
  const dd = styles?.getElementsByTagName('w:docDefaults')[0];
  const dsp = dd?.getElementsByTagName('w:spacing')[0];
  const lineOf = (sp) => (attr(sp, 'w:line') && (attr(sp, 'w:lineRule') ?? 'auto') === 'auto' ? r2(num(attr(sp, 'w:line')) / 240) : null);
  const dflt = { s: num(attr(dd?.getElementsByTagName('w:sz')[0], 'w:val')) / 2 || 11, a: dsp && attr(dsp, 'w:after') ? r2(num(attr(dsp, 'w:after')) / TW) : 0, lm: lineOf(dsp) ?? 1 };

  // Fonts as Word picks them: the run's own, its character style, its paragraph's style, then the document's default;
  // a theme font ("minorHAnsi") named from the theme.
  const theme = await xml('word/theme/theme1.xml');
  const themeFont = { major: null, minor: null };
  for (const k of ['major', 'minor']) themeFont[k] = attr(theme?.getElementsByTagName(`a:${k}Font`)[0]?.getElementsByTagName('a:latin')[0], 'typeface');
  const fontIn = (rpr) => {
    const rf = kid(rpr, 'w:rFonts'); if (!rf) return null;
    const th = attr(rf, 'w:asciiTheme') ?? attr(rf, 'w:hAnsiTheme');
    return attr(rf, 'w:ascii') ?? attr(rf, 'w:hAnsi') ?? (th ? themeFont[th.startsWith('major') ? 'major' : 'minor'] : null);
  };
  const styleOf = {};
  for (const st of styles?.getElementsByTagName('w:style') ?? []) styleOf[attr(st, 'w:styleId')] = st;
  const styleFont = (id, depth = 0) => {
    const st = styleOf[id]; if (!st || depth > 8) return null;
    return fontIn(kid(st, 'w:rPr')) ?? styleFont(attr(kid(st, 'w:basedOn'), 'w:val'), depth + 1);
  };
  const normal = Object.values(styleOf).find((st) => attr(st, 'w:type') === 'paragraph' && attr(st, 'w:default') === '1');
  const docFont = (normal && styleFont(attr(normal, 'w:styleId'))) ?? fontIn(dd?.getElementsByTagName('w:rPrDefault')[0]?.getElementsByTagName('w:rPr')[0]) ?? themeFont.minor ?? 'Calibri';
  const fontUse = {};

  // Numbering: a bullet or a counting number for each list.
  const numDoc = await xml('word/numbering.xml');
  const absFmt = {}; const numAbs = {};
  for (const a of numDoc?.getElementsByTagName('w:abstractNum') ?? []) {
    const lv = [...a.getElementsByTagName('w:lvl')].find((l) => attr(l, 'w:ilvl') === '0');
    absFmt[attr(a, 'w:abstractNumId')] = attr(lv?.getElementsByTagName('w:numFmt')[0], 'w:val') ?? 'decimal';
  }
  for (const n of numDoc?.getElementsByTagName('w:num') ?? []) numAbs[attr(n, 'w:numId')] = attr(n.getElementsByTagName('w:abstractNumId')[0], 'w:val');
  const counters = {};

  const files = []; const seen = {};
  const picture = async (rels, base, rid) => {
    const target = rels[rid]; if (!target) return null;
    const path = target.startsWith('/') ? target.slice(1) : `${base}${target}`.replace(/[^/]+\/\.\.\//g, '');
    if (seen[path]) return seen[path];
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (!['png', 'jpg', 'jpeg'].includes(ext)) return null;
    const f = zip.file(path); if (!f) return null;
    const blob = new Blob([await f.async('uint8array')], { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
    const key = `art-${files.length + 1}.${ext === 'png' ? 'png' : 'jpg'}`;
    files.push({ key, blob });
    seen[path] = { key, fmt: ext === 'png' ? 'PNG' : 'JPEG', blob };
    return seen[path];
  };
  const drawingInfo = (d) => {
    const anchor = d.getElementsByTagName('wp:anchor')[0]; const inline = d.getElementsByTagName('wp:inline')[0];
    const box = anchor ?? inline; if (!box) return null;
    const ext = box.getElementsByTagName('wp:extent')[0];
    const ph = anchor?.getElementsByTagName('wp:positionH')[0]; const pv = anchor?.getElementsByTagName('wp:positionV')[0];
    const off = (p) => num(p?.getElementsByTagName('wp:posOffset')[0]?.textContent) / EMU;
    return {
      float: !!anchor, w: r2(num(attr(ext, 'cx')) / EMU), h: r2(num(attr(ext, 'cy')) / EMU),
      hRel: attr(ph, 'relativeFrom') ?? 'column', vRel: attr(pv, 'relativeFrom') ?? 'paragraph', x: r2(off(ph)), y: r2(off(pv)),
      hAlign: ph?.getElementsByTagName('wp:align')[0]?.textContent ?? null,
      rid: attr(d.getElementsByTagName('a:blip')[0], 'r:embed'),
      fill: attr(d.getElementsByTagName('a:srgbClr')[0], 'val'),
    };
  };

  // The letterhead: pictures in the header and footer, placed on the page as Word does.
  const art = [];
  const hf = async (kind) => {
    const ref = sect?.getElementsByTagName(`w:${kind}Reference`); const pick = [...(ref ?? [])].find((r) => attr(r, 'w:type') === 'default') ?? ref?.[0];
    const part = pick ? docRels[attr(pick, 'r:id')] : null; if (!part) return;
    const d = await xml(`word/${part}`); if (!d) return;
    const rels = await relsOf(`word/${part}`);
    for (const dr of d.getElementsByTagName('w:drawing')) {
      let fb = false; for (let a = dr.parentNode; a; a = a.parentNode) if (a.nodeName === 'mc:Fallback') { fb = true; break; }
      if (fb) continue;
      const g = drawingInfo(dr); if (!g?.rid) continue;
      const p = await picture(rels, 'word/', g.rid); if (!p) continue;
      let x = g.hRel === 'page' ? g.x : page.ml + g.x;
      if (g.hAlign === 'right') x = page.w - page.mr - g.w; else if (g.hAlign === 'center') x = (page.w - g.w) / 2;
      let y;
      if (kind === 'header') y = g.vRel === 'page' ? g.y : page.hd + g.y;
      else y = g.vRel === 'page' ? g.y : page.h - page.fd - 4.5 + g.y;
      x = Math.max(0, Math.min(x, page.w - Math.min(g.w, page.w)));
      y = Math.max(0, Math.min(y, page.h - g.h));
      art.push({ ...p, x: r2(x), y: r2(y), w: g.w, h: g.h, at: kind });
    }
  };
  await hf('header'); await hf('footer');

  // The body, block by block.
  const blocks = [];
  const sects = [...doc.getElementsByTagName('w:sectPr')];
  let breakNext = false;
  const runText = (p) => {
    let t = ''; let bold = 0; let all = 0; let size = null; let pageBreak = false; const fonts = {};
    const pStyle = attr(kid(kid(p, 'w:pPr'), 'w:pStyle'), 'w:val');
    const walk = (n) => {
      for (const c of n.childNodes ?? []) {
        const nm = c.nodeName;
        if (nm === 'mc:Fallback' || nm === 'w:instrText' || nm === 'w:drawing' || nm === 'w:pict' || nm === 'w:delText') continue;
        if (nm === 'w:t') {
          t += c.textContent; all += c.textContent.length;
          const rpr = kid(c.parentNode, 'w:rPr'); const b = kid(rpr, 'w:b');
          if (b && attr(b, 'w:val') !== '0' && attr(b, 'w:val') !== 'false') bold += c.textContent.length;
          const s = attr(kid(rpr, 'w:sz'), 'w:val'); if (s && size == null && c.textContent.trim()) size = num(s) / 2;
          const fam = fontIn(rpr) ?? styleFont(attr(kid(rpr, 'w:rStyle'), 'w:val')) ?? styleFont(pStyle) ?? docFont;
          const n = c.textContent.trim().length; fonts[fam] = (fonts[fam] ?? 0) + n; fontUse[fam] = (fontUse[fam] ?? 0) + n;
        } else if (nm === 'w:tab') t += '\t';
        else if (nm === 'w:br') { if (attr(c, 'w:type') === 'page') pageBreak = true; else t += '\n'; }
        else walk(c);
      }
    };
    walk(p);
    const f = Object.entries(fonts).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return { t: clean(t), bold: all > 0 && bold / all > 0.6, size, pageBreak, f };
  };
  const pBlock = (p) => {
    const ppr = kid(p, 'w:pPr');
    const r = runText(p);
    const jc = attr(kid(ppr, 'w:jc'), 'w:val');
    const ind = kid(ppr, 'w:ind');
    const sp = kid(ppr, 'w:spacing');
    const numPr = kid(ppr, 'w:numPr');
    let n = null;
    if (numPr && r.t.trim()) {
      const id = attr(kid(numPr, 'w:numId'), 'w:val'); const lvl = num(attr(kid(numPr, 'w:ilvl'), 'w:val'));
      const f = absFmt[numAbs[id]] ?? 'decimal';
      if (id && id !== '0') {
        if (f === 'bullet' || lvl > 0) n = '•';
        else { const c = numAbs[id] ?? id; counters[c] = (counters[c] ?? 0) + 1; n = f === 'lowerLetter' ? `${String.fromCharCode(96 + counters[c])})` : `${counters[c]}.`; }
      }
    }
    const b = { k: 'p', t: r.t, ...(r.f ? { f: r.f } : {}), ...(r.bold ? { b: 1 } : {}), ...(r.size && r.size !== dflt.s ? { s: Math.max(7, Math.min(r.size, 18)) } : {}),
      ...(jc === 'center' || jc === 'right' ? { al: jc } : {}), ...(n ? { n } : {}),
      ...(ind && num(attr(ind, 'w:left')) > 200 ? { i: r2(Math.min(num(attr(ind, 'w:left')) / TW, 30)) } : {}),
      ...(sp && attr(sp, 'w:after') != null ? { a: r2(Math.min(num(attr(sp, 'w:after')) / TW, 8)) } : {}),
      ...(sp && num(attr(sp, 'w:before')) ? { bf: r2(Math.min(num(attr(sp, 'w:before')) / TW, 8)) } : {}),
      ...(lineOf(sp) != null ? { lm: lineOf(sp) } : {}) };
    if (r.pageBreak || kid(ppr, 'w:pageBreakBefore') || breakNext) { b.br = 1; breakNext = false; }
    // A section ends here: a new page unless the next section runs on ("continuous").
    const sp2 = kid(ppr, 'w:sectPr');
    if (sp2) { const nx = sects[sects.indexOf(sp2) + 1]; breakNext = attr(nx?.getElementsByTagName('w:type')[0], 'w:val') !== 'continuous'; }
    return b;
  };
  const table = (tbl) => {
    const grid = kids(kid(tbl, 'w:tblGrid'), 'w:gridCol').map((g) => num(attr(g, 'w:w')));
    const rows = kids(tbl, 'w:tr').map((tr) => kids(tr, 'w:tc').map((tc) => {
      const span = num(attr(tc.getElementsByTagName('w:gridSpan')[0], 'w:val')) || 1;
      const ps = kids(tc, 'w:p').map((p) => runText(p));
      return { t: ps.map((x) => x.t.trim()).filter(Boolean).join('\n'), b: ps.some((x) => x.bold && x.t.trim()) ? 1 : 0, span,
        ...(ps.find((x) => x.t.trim() && x.f)?.f ? { f: ps.find((x) => x.t.trim() && x.f).f } : {}) };
    }));
    const bd = tbl.getElementsByTagName('w:tblBorders')[0];
    const line = (e) => e && !['nil', 'none'].includes(attr(e, 'w:val'));
    const border = bd ? ['w:top', 'w:insideH', 'w:insideV', 'w:left'].some((n) => line(bd.getElementsByTagName(n)[0]))
      : [...tbl.getElementsByTagName('w:tcBorders')].some((b) => [...b.childNodes].some((c) => line(c)));
    const total = grid.reduce((s, w) => s + w, 0) || 1;
    return { rows, cw: grid.map((w) => r2(w / total)), wd: r2(total / TW), border };
  };
  const drawings = async (el) => {
    const out = [];
    for (const dr of el.getElementsByTagName('w:drawing')) {
      let skip = false; for (let a = dr.parentNode; a; a = a.parentNode) if (a.nodeName === 'mc:Fallback') { skip = true; break; }
      if (skip) continue;
      const g = drawingInfo(dr); if (!g) continue;
      const tb = dr.getElementsByTagName('w:txbxContent')[0];
      if (tb) { for (const p of kids(tb, 'w:p')) { const b = pBlock(p); if (b.t.trim()) out.push({ ...b, br: undefined }); } continue; }
      if (g.rid) {
        const p = await picture(docRels, 'word/', g.rid); if (!p) continue;
        out.push({ k: 'img', ...p, w: g.w, h: g.h, float: g.float ? 1 : 0, x: r2(g.hRel === 'page' ? g.x - page.ml : g.x), dy: r2(g.float && g.vRel === 'paragraph' ? g.y : 0) });
      }
    }
    return out;
  };
  for (const el of [...body.childNodes]) {
    if (el.nodeName === 'w:p') {
      const b = pBlock(el);
      const pics = await drawings(el);
      blocks.push(b, ...pics);
    } else if (el.nodeName === 'w:tbl') {
      const g = table(el);
      if (g.rows.some((r) => r.some((c) => c.t.trim()))) blocks.push({ k: 'grid', ...g }); // an empty table is left out
    }
  }

  // The machine table, read out of the blocks (findItems).
  const found0 = findItems(blocks);
  blocks.splice(0, blocks.length, ...found0.blocks);
  const items = found0.items;

  // What was filled in the sample becomes a blank. Ref and date from their lines; the address after "To,".
  const texts = () => blocks.flatMap((b) => (b.k === 'p' ? [b] : b.k === 'grid' ? b.rows.flat() : []));
  const all = texts().map((x) => x.t).join('\n');
  const found = {};
  found.ref = REF.exec(all)?.[1]?.trim();
  found.date = DATE.exec(all)?.[1];
  const per = /(?:period\s+of\s+contract|contract\s+period)[^0-9]*(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*(?:-|–|to)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i.exec(all);
  if (per) { found.from = per[1]; found.upto = per[2]; }
  const ti = blocks.findIndex((b) => b.k === 'p' && /^\s*to\s*,?\s*$/i.test(b.t));
  let subjectAt = -1;
  if (ti >= 0) {
    const after = []; for (let i = ti + 1; i < blocks.length && after.length < 3; i++) if (blocks[i].k === 'p' && blocks[i].t.trim()) after.push(i);
    const isSubj = (t) => /^\s*(sub(ject)?\s*[:.-])/i.test(t) || /(contract|proposal|quotation|offer)/i.test(t);
    const addr = after.filter((i, n) => n < 2 && !isSubj(blocks[i].t) && !/^(dear|greetings|sir)/i.test(blocks[i].t.trim()));
    if (addr[0] != null) { found.to = blocks[addr[0]].t.trim(); blocks[addr[0]].t = '{to}'; }
    if (addr[1] != null && blocks[addr[1]].t.trim().length < 40) { found.place = blocks[addr[1]].t.trim(); blocks[addr[1]].t = '{place}'; }
    subjectAt = after.find((i) => !addr.includes(i) && isSubj(blocks[i].t)) ?? -1;
  }
  let subject = '';
  if (subjectAt >= 0) {
    const b = blocks[subjectAt];
    const m = /^(\s*sub(?:ject)?\s*[:.-]\s*)(.*)$/is.exec(b.t);
    subject = (m ? m[2] : b.t).trim(); b.t = m ? `${m[1]}{subject}` : '{subject}';
  }
  const swap = (s) => {
    let t = s;
    const rep = (v, tok, flags = 'g') => { if (v) t = t.replace(new RegExp(`(?<![0-9A-Za-z])${esc(v)}(?![0-9A-Za-z])`, flags), tok); };
    rep(found.ref, '{ref}'); rep(found.from, '{from}'); rep(found.upto, '{upto}'); rep(found.date, '{date}');
    rep(found.to, '{to}', 'gi'); rep(found.place, '{place}', 'gi');
    if (items) { rep(items.old.grand, '{grand}'); rep(items.old.total, '{total}'); rep(items.old.gst, '{gst}'); }
    return t;
  };
  for (const x of texts()) if (!/^\{(to|place)\}$/.test(x.t)) x.t = swap(x.t);

  // Empty paragraphs: at most two in a row.
  const out = []; let gap = 0;
  for (const b of blocks) { if (b.k === 'p' && !b.t.trim() && !b.br) { if (++gap > 2) continue; } else gap = 0; out.push(b); }

  // The letter's own font: the one most of its words are in. A paragraph or cell keeps its font only where it differs.
  const font = Object.entries(fontUse).sort((x, y) => y[1] - x[1])[0]?.[0] ?? docFont;
  const drop = (x) => { if (x.f === font) delete x.f; };
  for (const b of out) { if (b.k === 'p') drop(b); else if (b.k === 'grid') b.rows.flat().forEach(drop); }

  return {
    layout: { v: 1, page, dflt: { ...dflt, f: font }, art, blocks: out, items, period: !!per, subject, sample: { ...found, subject } },
    files,
  };
}

/**
  The table of things quoted: the first with an amount column (amount, price, rate, value, cost) and something named
  in it (model, description, contract type…), else any with an amount column and a row of figures. Its columns: the
  serial number, the columns typed in, the amount, then columns the app works out (GST %, GST amount, total), as in
  Sandhya K Nair's Sub AMC (SI NO. · CONTRACT TYPE · RATE · GST % · GST RATE · TOTAL; the user, 18 Nov: "where is
  amount field?"). Its total rows and full-width rows (a contract period) are kept.
*/
const TAXCOL = /gst|tax/i;
export function findItems(blocks) {
  const money = (h) => /amount|price|rate|value|cost/i.test(h) && !TAXCOL.test(h);
  const isHead = (row) => row.length >= 3 && row.some((c) => money(c.t) || /total/i.test(c.t));
  let mi = blocks.findIndex((b) => b.k === 'grid' && b.rows.length > 1 && isHead(b.rows[0])
    && b.rows[0].some((c) => /model|description|item|equipment|make|contract|particular|service|type/i.test(c.t)));
  if (mi < 0) mi = blocks.findIndex((b) => b.k === 'grid' && b.rows.length > 1 && isHead(b.rows[0])
    && b.rows.slice(1).some((r) => r.length === b.rows[0].length && r.some((c) => /\d/.test(c.t))));
  if (mi < 0) return { blocks, items: null };
  const g = blocks[mi];
  const head = g.rows[0].map((c) => c.t.replace(/\s+/g, ' ').trim());
  const idx = /^(s[il]\.?\s*no|sr\.?\s*no|s\s*\/?\s*n|no)\.?$/i.test(head[0] ?? '');
  let pi = head.findIndex((h, i) => i >= (idx ? 1 : 0) && money(h));
  if (pi < 0) pi = head.length - 1;
  const cols = head.slice(idx ? 1 : 0, pi);
  const calc = head.slice(pi + 1).map((h) => ({ label: h,
    kind: TAXCOL.test(h) && /%/.test(h) ? 'rate' : TAXCOL.test(h) ? 'tax' : /total|amount|value/i.test(h) ? 'with' : 'blank' }));
  const cw = g.cw.length === head.length ? g.cw : head.map(() => 1 / head.length);
  const isTot = (r) => (r.length < head.length && r.some((c) => /total|gst/i.test(c.t)))
    || (r.length >= head.length && r.some((c) => /^\s*(grand\s+)?total\b|gst\s*@/i.test(c.t)));
  const data = g.rows.slice(1).filter((r) => r.length >= head.length && !isTot(r));
  const tots = g.rows.slice(1).filter((r) => isTot(r));
  const extra = g.rows.slice(1).filter((r) => r.length < head.length && !isTot(r) && r.some((c) => c.t.trim())).map((r) => r.map((c) => c.t).join(' ').trim());
  const totals = tots.map((r) => {
    const label = r.map((c) => c.t).find((t) => /total|gst/i.test(t)).replace(/\s+/g, ' ').trim();
    return { label, v: r.map((c) => c.t).reverse().find((t) => /\d/.test(t) && t !== label) ?? '' };
  });
  const kindOf = (x, i) => (TAXCOL.test(x.label) && !/with|total amount/i.test(x.label) ? 'gst' : i === totals.length - 1 && totals.length > 1 ? 'grand' : 'total');
  const rateText = [...totals.map((x) => x.label), ...data.flatMap((r) => calc.map((c, k) => (c.kind === 'rate' ? `gst ${r[pi + 1 + k]?.t}` : '')))].join(' ');
  const rate = num(/gst\s*@?\s*(\d+(?:\.\d+)?)\s*%/i.exec(rateText)?.[1]) || 18;
  const items = {
    idx, cols, price: head[pi], calc, extra, cw, wd: g.wd, border: true,
    totals: totals.map((x, i) => ({ label: x.label.replace(/(gst\s*@?\s*)\d+(?:\.\d+)?\s*%/i, '$1{rate}%'), kind: kindOf(x, i) })),
    gst: rate,
    sample: data.map((r) => ({ cells: cols.map((c, k) => r[(idx ? 1 : 0) + k]?.t ?? ''), price: num(String(r[pi]?.t).replace(/[^0-9.]/g, '')) })),
    old: Object.fromEntries(totals.map((x, i) => [kindOf(x, i), String(x.v).replace(/[^0-9.]/g, '')]).filter(([, v]) => v)),
  };
  return { blocks: blocks.map((b, i) => (i === mi ? { k: 'items' } : b)), items };
}

/** "Ref: …", "Ref – …", "Ref. No …" and "Date: …", "Date- …" (Sub AMC writes them with a dash). */
const REF = /\b(?:Our\s+)?Ref(?:\.?\s*No)?\s*[:.\-\u2013]\s*([^\t\n{]+?)(?:\s{2,}|\t|\n|$)/i;
const DATE = /\bDate\s*[:.\-\u2013]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i;

/**
  A layout kept before the reader knew a table like Sub AMC's or a "Ref –" line (18 Nov): its table and its ref and date
  blanks found again, on the template or on a quotation's own wording.
*/
export function upgradeLayout(lay) {
  if (!lay) return lay;
  let out = lay;
  if (!out.items) { const { blocks, items } = findItems(out.blocks); if (items) out = { ...out, blocks, items }; }
  const paras = out.blocks.filter((b) => b.k === 'p').map((b) => b.t).join('\n');
  const ref = !out.sample?.ref && !/\{ref\}/.test(paras) ? REF.exec(paras)?.[1]?.trim() : null;
  const date = !out.sample?.date && !/\{date\}/.test(paras) ? DATE.exec(paras)?.[1] : null;
  if (ref || date) {
    const swap = (t) => { let x = t; if (ref) x = x.split(ref).join('{ref}'); if (date) x = x.split(date).join('{date}'); return x; };
    out = { ...out, sample: { ...out.sample, ...(ref ? { ref } : {}), ...(date ? { date } : {}) },
      blocks: out.blocks.map((b) => (b.k === 'p' ? { ...b, t: swap(b.t) } : b.k === 'grid' ? { ...b, rows: b.rows.map((r) => r.map((c) => ({ ...c, t: swap(c.t) }))) } : b)) };
  }
  return out;
}

/* ------------------------------------------------------------------ drawing -- */

const dots = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

/** Each line's amount (price × qty when there is a Qty column) and the totals at the quotation's GST. */
export const qtyCol = (layout) => (layout?.items?.cols ?? []).findIndex((c) => /^\s*(qty|quantity)/i.test(c));
export function layoutTotals(items, layout, gst) {
  const qi = qtyCol(layout);
  const lines = (items ?? []).map((it) => r2(num(it.price) * (qi >= 0 ? (num(String(it.cells?.[qi] ?? '').replace(/[^0-9.]/g, '')) || 1) : 1)));
  const total = r2(lines.reduce((s, x) => s + x, 0));
  const tax = Math.round((total * num(gst)) / 100); // to the rupee, as their Word quotations
  return { lines, total, tax, with: r2(total + tax) };
}

/**
  A quotation in a template's layout. q: { qtn_no, date, to, place, subject, from, upto, gst, items: [{ cells, price }],
  blocks? (this quotation's own wording) }. img(art) gives a picture as a data URL.
*/
export async function makeLayoutPdf(q, layout, img) {
  const P = layout.page;
  const pdf = new jsPDF({ unit: 'mm', format: [P.w, P.h], orientation: P.w > P.h ? 'l' : 'p', compress: true });
  const pics = {};
  const pic = async (a) => { if (!pics[a.key]) pics[a.key] = await img(a); return pics[a.key]; };
  for (const a of layout.art) await pic(a).catch(() => null);
  const L = P.ml; const CW = P.w - P.ml - P.mr;
  const heads = layout.art.filter((a) => a.at === 'header' && a.h < P.h / 2);
  const feet = layout.art.filter((a) => a.at === 'footer');
  const TOP = Math.max(P.mt, ...heads.map((a) => a.y + a.h + 3), 12);
  const BOTTOM = Math.min(P.h - Math.max(P.mb, 8), ...feet.map((a) => a.y - 3));
  const frame = () => { for (const a of layout.art) if (pics[a.key]) pdf.addImage(pics[a.key], a.fmt, a.x, a.y, a.w, a.h, a.key, 'FAST'); };
  const D = layout.dflt ?? { s: 11, a: 0, lm: 1 };
  // Every font the letter uses, regular and bold, embedded; a layout read before fonts were kept is in Word's Calibri.
  const fams = new Set([fontFor(D.f ?? 'Calibri')]);
  for (const b of [...(q.blocks ?? layout.blocks), ...layout.blocks]) {
    if (b.f) fams.add(fontFor(b.f));
    if (b.k === 'grid') for (const c of b.rows.flat()) if (c.f) fams.add(fontFor(c.f));
  }
  const setFam = await embedFonts(pdf, fams);
  const font = (bold, size = 11, f = null) => { setFam(fontFor(f ?? D.f ?? 'Calibri'), bold); pdf.setFontSize(size); pdf.setTextColor(17, 17, 17); };
  const LH = (s, lm = 1) => s * 0.3528 * 1.17 * lm;
  let y = TOP; let paraTop = TOP;
  const newPage = () => { pdf.addPage(); frame(); y = TOP; };
  frame();

  const t = layoutTotals(q.items, layout, q.gst);
  const fill = (s) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => ({
    to: q.to, place: q.place, date: dots(q.date), ref: q.qtn_no ?? '', subject: q.subject ?? '', from: dots(q.from), upto: dots(q.upto),
    total: fmt(t.total), gst: fmt(t.tax), grand: fmt(t.with), words: inWords(t.with), rate: String(num(q.gst)),
  }[k] ?? m));

  const para = (b) => {
    const s = b.s ?? D.s; const lm = b.lm ?? D.lm; const after = b.a ?? D.a; font(b.b, s, b.f);
    y += b.bf ?? 0;
    const x0 = L + (b.i ?? 0) + (b.n ? 6 : 0); const w = CW - (b.i ?? 0) - (b.n ? 6 : 0);
    const raw = fill(b.t);
    if (!raw.trim()) { y += LH(s, lm) + after; return; }
    // "Date: …            Ref: …" on one line: the left part left, the right part right.
    const split = /^(.*?\S)(?:\t+|\s{4,})(\S.*)$/.exec(raw);
    if (split && !raw.includes('\n') && pdf.getTextWidth(raw.replace(/\s+/g, ' ')) < w - 10) {
      if (y + LH(s) > BOTTOM) newPage();
      pdf.text(split[1].trim(), x0, y + LH(s) * 0.8); pdf.text(split[2].trim(), L + CW, y + LH(s) * 0.8, { align: 'right' });
      y += LH(s, lm) + after; return;
    }
    const lines = raw.replace(/\t/g, '  ').split('\n').flatMap((ln) => pdf.splitTextToSize(ln.replace(/ {3,}/g, '  '), w));
    lines.forEach((ln, k) => {
      if (y + LH(s) > BOTTOM) newPage();
      if (k === 0 && b.n) pdf.text(b.n, L + (b.i ?? 0), y + LH(s) * 0.8);
      const xa = b.al === 'center' ? L + CW / 2 : b.al === 'right' ? L + CW : x0;
      pdf.text(ln, xa, y + LH(s) * 0.8, b.al ? { align: b.al } : undefined);
      y += LH(s, lm);
    });
    y += after;
  };

  // A table: column widths as in Word, cells wrapped, lines if Word had them. Rows move whole to the next page.
  const grid = (rows, cw, wd, border, opts = {}) => {
    const tw = Math.min(wd || CW, CW + 6); const xs = cw.reduce((a, w) => [...a, a[a.length - 1] + w * tw], [L]);
    pdf.setDrawColor(0, 0, 0); pdf.setLineWidth(0.25);
    const drawRow = (cells, bold) => {
      const PAD = 1.4; const s = opts.size ?? 9.5;
      let ci = 0;
      const placed = cells.map((c) => { const from = ci; ci += c.span ?? 1; return { ...c, x: xs[from], w: xs[Math.min(ci, xs.length - 1)] - xs[from] }; });
      font(false, s);
      const wrapped = placed.map((c) => { font(bold || c.b, s, c.f); return pdf.splitTextToSize(fill(c.t), Math.max(c.w - PAD * 2, 4)); });
      const h = Math.max(...wrapped.map((l) => l.length), 1) * LH(s) * 1.15 + 3;
      if (y + h > BOTTOM) { newPage(); if (opts.head) drawRow(opts.head, true); }
      placed.forEach((c, i) => {
        font(bold || c.b, s, c.f);
        const al = c.al ?? opts.align?.(i, c) ?? 'left';
        wrapped[i].forEach((ln, k) => pdf.text(ln, al === 'center' ? c.x + c.w / 2 : al === 'right' ? c.x + c.w - PAD : c.x + PAD, y + 2 + LH(s) * 0.85 + k * LH(s) * 1.15, al === 'left' ? undefined : { align: al }));
        if (border) pdf.rect(c.x, y, c.w, h);
      });
      y += h;
    };
    rows.forEach((r, i) => drawRow(r, opts.head && i === 0));
    y += 3;
  };

  const items = () => {
    const it = layout.items; if (!it) return;
    const calc = it.calc ?? [];
    const head = [...(it.idx ? [{ t: 'No.' }] : []), ...it.cols.map((c) => ({ t: c })), { t: it.price }, ...calc.map((c) => ({ t: c.label }))].map((c) => ({ ...c, b: 1, al: 'center' }));
    const rows = [head];
    const rate = num(q.gst);
    const worked = (c, line, tax) => ({ t: c.kind === 'rate' ? `${fmt(rate)}%` : c.kind === 'tax' ? fmt(tax) : c.kind === 'with' ? fmt(line + tax) : '', al: c.kind === 'rate' ? 'center' : 'right' });
    (q.items ?? []).forEach((x, n) => {
      const line = t.lines[n]; const tax = Math.round((line * rate) / 100);
      rows.push([...(it.idx ? [{ t: String(n + 1), al: 'center' }] : []), ...it.cols.map((c, k) => ({ t: String(x.cells?.[k] ?? ''), al: 'center' })), { t: fmt(line), al: 'right' }, ...calc.map((c) => worked(c, line, tax))]);
    });
    const span = it.cols.length + (it.idx ? 1 : 0);
    // A table with worked-out columns and no total rows gets one Total row when there is more than one line.
    const totals = it.totals.length ? it.totals : calc.length && (q.items ?? []).length > 1 ? [{ label: 'Total', kind: 'sum' }] : [];
    for (const tr of totals) {
      if (tr.kind === 'sum') {
        rows.push([{ t: tr.label, span, b: 1, al: 'right' }, { t: fmt(t.total), b: 1, al: 'right' },
          ...calc.map((c) => ({ t: c.kind === 'tax' ? fmt(t.tax) : c.kind === 'with' ? fmt(t.with) : '', b: 1, al: 'right' }))]);
        continue;
      }
      const v = tr.kind === 'gst' ? t.tax : tr.kind === 'grand' ? t.with : (it.totals.some((z) => z.kind === 'grand') ? t.total : t.with);
      rows.push([{ t: tr.label, span, b: 1, al: 'right' }, { t: `${fmt(v)}${tr.kind === 'grand' ? '/-' : ''}`, b: 1, al: 'right' }, ...calc.map(() => ({ t: '' }))]);
    }
    for (const e of it.extra ?? []) rows.push([{ t: e, span: head.length, b: 1 }]);
    grid(rows, it.cw, it.wd, true, { head });
  };

  for (const b of q.blocks ?? layout.blocks) {
    if (b.br && y > TOP + 1) newPage();
    if (b.k === 'p') { paraTop = y; para(b); }
    else if (b.k === 'items') items();
    else if (b.k === 'grid') grid(b.rows, b.cw, b.wd, b.border);
    else if (b.k === 'img') {
      const d = await pic(b).catch(() => null); if (!d) continue;
      if (b.float) { pdf.addImage(d, b.fmt, Math.max(0, L + b.x), Math.max(TOP - 6, paraTop + b.dy), b.w, b.h, b.key, 'FAST'); }
      else { if (y + b.h > BOTTOM) newPage(); pdf.addImage(d, b.fmt, L + Math.max(0, b.x), y, b.w, b.h, b.key, 'FAST'); y += b.h + 2; }
    }
  }
  return pdf.output('blob');
}
